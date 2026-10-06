import { cacheGet, cacheSet } from "./db.js";

/**
 * v2.3: Sleeper's own weekly projections — the PRIMARY projection source.
 *
 * This is the feed the Sleeper app itself shows (the `company` field on each
 * row says the numbers come from Rotowire). Why it beats the alternatives:
 *  - Rows are keyed by Sleeper player_id — the same IDs on every roster — so
 *    there's no name or cross-site ID matching to miss on.
 *  - It carries raw projected stats (pass_yd, rec, rush_td, fgm_40_49,
 *    sack, pts_allow, ...) using the SAME keys as a Sleeper league's
 *    scoring_settings, so a league's points are just stats × settings —
 *    exact for that league's rules, custom scoring included.
 *  - One request per week covers QB/RB/WR/TE/K/DEF. No key, no quota.
 *
 * Unofficial and undocumented. What's known from building this and from other
 * projects using it:
 *  - api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=…
 *    returns an ARRAY of { player_id, stats, player, company, ... }.
 *    (Sample rows for QB, WR, K and DEF were fetched while building this.)
 *  - The older api.sleeper.app/v1/projections path now returns empty objects
 *    — not used. api.sleeper.app/projections (no /v1) is tried as a backup.
 *  - api.sleeper.com reportedly 403s without a browser-like User-Agent.
 *  - Some rows carry 999/1000 placeholder values (seen on adp_* fields and
 *    on players with no real projection) — filtered out below.
 *  - The precomputed pts_ppr / pts_half_ppr / pts_std assume preset scoring,
 *    so they're only used as a last resort when no stat key overlaps the
 *    league's settings.
 */
const URLS = [
  "https://api.sleeper.com/projections/nfl",
  "https://api.sleeper.app/projections/nfl",
];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // v3.3 (R23): 6-hour baseline; the scheduler force-refreshes 3 hours and 60 minutes before each kickoff slot
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const PLACEHOLDER = 999; // values at/above this are placeholders, not projections

// Points-allowed / yards-allowed tiers as Sleeper names them in scoring_settings.
const PTS_ALLOW_TIERS = [
  ["pts_allow_0", 0, 0],
  ["pts_allow_1_6", 1, 6],
  ["pts_allow_7_13", 7, 13],
  ["pts_allow_14_20", 14, 20],
  ["pts_allow_21_27", 21, 27],
  ["pts_allow_28_34", 28, 34],
  ["pts_allow_35p", 35, Infinity],
];
const YDS_ALLOW_TIERS = [
  ["yds_allow_0_100", 0, 99],
  ["yds_allow_100_199", 100, 199],
  ["yds_allow_200_299", 200, 299],
  ["yds_allow_300_349", 300, 349],
  ["yds_allow_350_399", 350, 399],
  ["yds_allow_400_449", 400, 449],
  ["yds_allow_450_499", 450, 499],
  ["yds_allow_500_549", 500, 549],
  ["yds_allow_550p", 550, Infinity],
];
const REC_BONUS_BY_POS = { RB: "bonus_rec_rb", WR: "bonus_rec_wr", TE: "bonus_rec_te" };

let _loggedSample = false;

async function fetchWeek(season, week) {
  const params = new URLSearchParams({ season_type: "regular" });
  for (const p of POSITIONS) params.append("position[]", p);
  let lastErr;
  for (const base of URLS) {
    try {
      const res = await fetch(`${base}/${season}/${week}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
      const json = await res.json();
      // Array is the documented-by-usage shape; tolerate an object keyed by player_id too.
      const rows = Array.isArray(json)
        ? json
        : json && typeof json === "object"
        ? Object.entries(json).map(([player_id, v]) => ({ player_id, ...(v || {}) }))
        : [];
      if (rows.length === 0) throw new Error(`empty response from ${base}`);
      return rows;
    } catch (err) {
      lastErr = err;
      console.warn(`[sleeperProjections] ${err.message} — trying next source`);
    }
  }
  throw lastErr || new Error("Sleeper projections unavailable");
}

function cleanStats(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.startsWith("adp_") || k.startsWith("pos_adp_") || k.includes("rank")) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) >= PLACEHOLDER) continue;
    out[k] = n;
  }
  return out;
}

/**
 * Every player's projected stats for one week, cached for an hour:
 *   { byId: { sleeperPlayerId: { pos, stats } }, count, withProjection }
 * Throws if Sleeper can't be reached — the caller falls back to ESPN.
 */
export async function getWeekProjections(season, week, { force = false, ttlMs = null } = {}) {
  const cacheKey = `sleeper:proj:${season}:${week}`;
  // force: the pre-kickoff refresh (scheduler.js) skips the hourly cache.
  const cached = force ? null : cacheGet(cacheKey);
  if (cached !== null) return cached;

  const rows = await fetchWeek(season, week);
  const byId = {};
  let withProjection = 0;
  for (const row of rows) {
    const id = row.player_id != null ? String(row.player_id) : null;
    if (!id) continue;
    const stats = cleanStats(row.stats);
    // A row whose only content is gp / pts_* placeholders isn't a projection.
    const meaningful = Object.keys(stats).some((k) => k !== "gp" && !k.startsWith("pts_") && stats[k] !== 0);
    if (!meaningful) continue;
    byId[id] = { pos: row.player?.position || null, stats };
    withProjection++;
    if (!_loggedSample && row.player?.position && row.player.position !== "DEF") {
      console.log(`[sleeperProjections] Sample week ${week} row:`, { player_id: id, pos: row.player.position, company: row.company, stats });
      _loggedSample = true;
    }
  }
  const data = { byId, count: rows.length, withProjection };
  console.log(`[sleeperProjections] ${season} week ${week}: ${rows.length} rows from Sleeper, ${withProjection} with a usable projection.`);
  cacheSet(cacheKey, data, ttlMs || CACHE_TTL_MS); // v3.5: future weeks (rest of season) are kept a day
  return data;
}

function tierPoints(tiers, value, settings, stats) {
  if (value == null) return 0;
  // If the feed already flagged a tier (e.g. pts_allow_14_20: 1), the dot
  // product counted it — don't add it twice.
  if (tiers.some(([key]) => stats[key] != null)) return 0;
  const v = Math.round(value);
  const hit = tiers.find(([, lo, hi]) => v >= lo && v <= hi);
  return hit && settings[hit[0]] != null ? Number(settings[hit[0]]) : 0;
}

/**
 * League points for one player's projected stats: Σ stat × scoring_settings[stat],
 * plus the pieces Sleeper scores that a stat line doesn't spell out directly
 * (position reception bonuses, points/yards-allowed tiers). Returns null when
 * nothing in the stat line matches the league's scoring keys.
 */
export function scoreStats(entry, settings = {}) {
  if (!entry?.stats) return null;
  const { stats, pos } = entry;
  let pts = 0;
  let overlap = 0;
  for (const [k, v] of Object.entries(stats)) {
    if (k === "gp" || (k.startsWith("pts_") && !k.startsWith("pts_allow"))) continue;
    const w = settings[k];
    if (w == null) continue;
    pts += v * Number(w);
    overlap++;
  }
  const bonusKey = REC_BONUS_BY_POS[pos];
  if (bonusKey && stats.rec != null && stats[bonusKey] == null && settings[bonusKey] != null) {
    pts += stats.rec * Number(settings[bonusKey]);
  }
  if (pos === "DEF") {
    pts += tierPoints(PTS_ALLOW_TIERS, stats.pts_allow, settings, stats);
    pts += tierPoints(YDS_ALLOW_TIERS, stats.yds_allow, settings, stats);
  }
  if (overlap === 0) {
    // Nothing to score against — fall back to Sleeper's preset totals.
    const rec = Number(settings.rec ?? 0);
    const preset = rec >= 1 ? stats.pts_ppr : rec > 0 ? stats.pts_half_ppr : stats.pts_std;
    return preset != null ? Math.round(preset * 100) / 100 : null;
  }
  return Math.round(pts * 100) / 100;
}

export function lookupProjection(pool, sleeperId) {
  if (!pool || sleeperId == null) return null;
  return pool.byId[String(sleeperId)] || null;
}
