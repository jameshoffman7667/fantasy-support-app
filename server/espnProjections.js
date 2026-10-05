import { cacheGet, cacheSet } from "./db.js";
import { normalizeName } from "./matching.js";

/**
 * v2.3: FALLBACK projection source, used only for players Sleeper's own
 * projections feed (sleeperProjections.js) has nothing for. Was the only
 * source in v2.2.
 *
 * Why: FantasyPros' free API and its logged-out projection pages both stop at
 * ~10 players per position, and the old ESPN fallback hit
 * sports.core.api.espn.com/.../athletes/{id}/projections, which turned out to
 * return season-total real NFL stats — not weekly fantasy projections — so it
 * yielded nothing. Net effect: almost everyone outside the top 10 had no
 * projection.
 *
 * Source now: ESPN's fantasy "league defaults" player feed — the same data
 * behind ESPN's own player pages. One request per (season, week) covers the
 * whole player pool (QB/RB/WR/TE/K/D/ST), needs no login, and is cached.
 *
 *   https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}
 *     /segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId={week}
 *   header X-Fantasy-Filter: {"players":{"limit":3000, ...}}   (default is 50)
 *
 * The weekly projection for a player is the entry in player.stats with
 * statSourceId 1 (projected), statSplitTypeId 1 (single week),
 * seasonId = season, scoringPeriodId = week; `appliedTotal` is the points.
 *
 * CONFIRMED while building: the endpoint answers without auth and returns
 * players[].player.{fullName, defaultPositionId, proTeamId, stats[]} with
 * seasonId/scoringPeriodId/statSourceId/statSplitTypeId/appliedTotal fields
 * (fetched a small sample directly).
 * FROM A THIRD-PARTY REPORT, NOT VERIFIED HERE: leaguedefaults/3 is ESPN's PPR
 * default (recomputing at 1 pt/reception lands within 0.1 of appliedTotal).
 * FROM ESPN-API COMMUNITY STAT MAPS, NOT VERIFIED HERE: raw stat "53" =
 * receptions, "4" = passing TDs. Used only for the scoring adjustment below,
 * and the first player parsed is logged so the shape can be checked in the
 * server logs.
 */
const SEASON_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // v3.3 (R23): 6-hour baseline; the scheduler force-refreshes 3 hours and 60 minutes before each kickoff slot
const STAT_RECEPTIONS = "53";
const STAT_PASS_TD = "4";
const ESPN_DEFAULT_PASS_TD = 4;

// ESPN defaultPositionId -> Sleeper position code.
const POSITION = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

// ESPN proTeamId -> team abbreviation (Sleeper-style). Used to match team
// defenses, whose "player" on ESPN is "Bills D/ST" etc.
const PRO_TEAM = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};
// Spelling differences between Sleeper and ESPN team codes.
const TEAM_ALIASES = { WSH: "WAS", JAC: "JAX", LA: "LAR" };
export function normalizeTeam(abbr) {
  if (!abbr) return null;
  const up = String(abbr).toUpperCase();
  return TEAM_ALIASES[up] || up;
}

let _loggedSample = false;

async function fetchPlayerPool(season, week) {
  const url = `${SEASON_BASE}/${season}/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`;
  const filter = {
    players: {
      limit: 3000,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Fantasy-Filter": JSON.stringify(filter) },
  });
  if (!res.ok) throw new Error(`ESPN fantasy API error ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.players) ? json.players : [];
}

function weeklyProjection(player, season, week) {
  return (player?.stats || []).find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && Number(s.seasonId) === Number(season) && Number(s.scoringPeriodId) === Number(week)
  );
}

/**
 * Fetches (or reads from cache) every ESPN player's projection for one week,
 * compacted to what the app needs:
 *   { byId: { espnId: rec }, byName: { "name|POS": rec }, byTeamDef: { TEAM: rec }, count, withProjection }
 * where rec = { pts, rec, passTd, pos, team, name } (pts = ESPN PPR total).
 * Throws on a network/API failure — the caller decides how to degrade.
 */
export async function getWeekProjections(season, week, { force = false } = {}) {
  const cacheKey = `espn:proj-pool:${season}:${week}`;
  // force: the pre-kickoff refresh (scheduler.js) skips the hourly cache.
  const cached = force ? null : cacheGet(cacheKey);
  if (cached !== null) return cached;

  const pool = await fetchPlayerPool(season, week);
  const byId = {};
  const byName = {};
  const byTeamDef = {};
  let withProjection = 0;
  for (const entry of pool) {
    const p = entry.player || entry;
    const pos = POSITION[p.defaultPositionId];
    if (!pos) continue;
    const proj = weeklyProjection(p, season, week);
    if (!proj || proj.appliedTotal == null) continue;
    const stats = proj.stats || {};
    const rec = {
      name: p.fullName,
      pos,
      team: PRO_TEAM[p.proTeamId] || null,
      pts: Number(proj.appliedTotal),
      rec: stats[STAT_RECEPTIONS] != null ? Number(stats[STAT_RECEPTIONS]) : null,
      passTd: stats[STAT_PASS_TD] != null ? Number(stats[STAT_PASS_TD]) : null,
    };
    if (Number.isNaN(rec.pts)) continue;
    withProjection++;
    byId[String(p.id ?? entry.id)] = rec;
    if (pos === "DEF") {
      if (rec.team) byTeamDef[rec.team] = rec;
    } else if (p.fullName) {
      byName[`${normalizeName(p.fullName)}|${pos}`] = rec;
    }
    if (!_loggedSample && pos !== "DEF") {
      console.log(`[espnProjections] Sample week ${week} projection:`, { ...rec, rawStatKeys: Object.keys(stats).slice(0, 25) });
      _loggedSample = true;
    }
  }
  const data = { byId, byName, byTeamDef, count: pool.length, withProjection };
  console.log(`[espnProjections] ${season} week ${week}: ${pool.length} players from ESPN, ${withProjection} with a weekly projection.`);
  cacheSet(cacheKey, data, CACHE_TTL_MS);
  return data;
}

/**
 * Adjusts ESPN's PPR total to the league's own scoring for the settings that
 * most commonly differ: points per reception (incl. TE premium) and points per
 * passing TD. Everything else uses ESPN's default scoring as-is.
 */
export function adjustForScoring(rec, scoringSettings = {}) {
  let pts = rec.pts;
  if (rec.rec != null) {
    const ppr = Number(scoringSettings.rec ?? 0);
    const tePremium = rec.pos === "TE" ? Number(scoringSettings.bonus_rec_te ?? 0) : 0;
    pts += (ppr + tePremium - 1) * rec.rec;
  }
  if (rec.passTd != null && scoringSettings.pass_td != null) {
    pts += (Number(scoringSettings.pass_td) - ESPN_DEFAULT_PASS_TD) * rec.passTd;
  }
  return Math.round(pts * 100) / 100;
}

/**
 * Finds a Sleeper player's ESPN projection: by the ffb_ids crosswalk's ESPN id
 * first (a real ID join), then by name + position (Sleeper's name, then the
 * crosswalk's spelling), and for team defenses by team.
 */
export function lookupProjection(pool, { espnId, names = [], pos, team }) {
  if (!pool) return null;
  if (pos === "DEF") return pool.byTeamDef[normalizeTeam(team)] || null;
  if (espnId && pool.byId[String(espnId)]) return pool.byId[String(espnId)];
  for (const n of names) {
    if (!n) continue;
    const hit = pool.byName[`${normalizeName(n)}|${pos}`];
    if (hit) return hit;
  }
  return null;
}
