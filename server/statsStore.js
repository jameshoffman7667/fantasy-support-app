import db from "./db.js";
import * as sleeper from "./sleeper.js";
import * as slp from "./sleeperProjections.js";
import * as nv from "./nflverseStats.js";

/**
 * v4.2: the app's own statistics table. One row per player per week, for actual stats ("stat") and Sleeper's
 * projections ("proj"), so the Waivers "All" tab and Analytics → Scouting can sum, average and sort many weeks and
 * seasons without re-reading the source files on every request.
 *
 *  stat lines  Sleeper's weekly stats (its own stat names, incl. team defenses), with nflverse's weekly player
 *              stats filling any gap and adding what Sleeper doesn't carry (EPA, air yards, YAC, snaps → `nv_*`).
 *              A season Sleeper has nothing for comes from nflverse alone (renamed to Sleeper's stat names).
 *  proj lines  Sleeper's weekly projections (2025 on; earlier seasons simply have none).
 *
 * A week is loaded the first time someone asks for it. Finished weeks of past seasons are kept for good; this
 * season's recent weeks are refreshed after 12 hours (stat corrections), the current week's projections after 6.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS stat_lines (
    kind TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    pos TEXT, team TEXT, stats_json TEXT NOT NULL,
    PRIMARY KEY (kind, season, week, player_id)
  );
  CREATE TABLE IF NOT EXISTS stat_line_weeks (
    kind TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, at INTEGER NOT NULL, rows INTEGER NOT NULL, source TEXT,
    PRIMARY KEY (kind, season, week)
  );
`);

const HOUR = 3600e3;
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
export const FIRST_STAT_SEASON = 1999;
export const FIRST_PROJ_SEASON = 2025;

// nflverse weekly column → Sleeper stat name
const NV_TO_SLEEPER = {
  completions: "pass_cmp", attempts: "pass_att", passing_yards: "pass_yd", passing_tds: "pass_td", passing_interceptions: "pass_int",
  passing_2pt_conversions: "pass_2pt", carries: "rush_att", rushing_yards: "rush_yd", rushing_tds: "rush_td", rushing_2pt_conversions: "rush_2pt",
  receptions: "rec", targets: "rec_tgt", receiving_yards: "rec_yd", receiving_tds: "rec_td", receiving_2pt_conversions: "rec_2pt",
  fg_made: "fgm", fg_att: "fga", pat_made: "xpm", pat_att: "xpa", special_teams_tds: "st_td",
};
// nflverse-only extras kept as nv_*
const NV_EXTRA = {
  sacks_suffered: "nv_sacks", passing_air_yards: "nv_pass_air_yd", passing_epa: "nv_pass_epa", rushing_epa: "nv_rush_epa",
  receiving_yards_after_catch: "nv_rec_yac", receiving_air_yards: "nv_rec_air_yd", receiving_epa: "nv_rec_epa",
};

/** nflverse weekly row → stat line (Sleeper names + nv_* extras). Pure. */
export function lineFromNflverse(r) {
  const out = {};
  for (const [k, s] of Object.entries(NV_TO_SLEEPER)) if (r[k] != null && Number.isFinite(Number(r[k]))) out[s] = Number(r[k]);
  for (const [k, s] of Object.entries(NV_EXTRA)) if (r[k] != null && Number.isFinite(Number(r[k]))) out[s] = Math.round(Number(r[k]) * 100) / 100;
  const fl = ["rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"].reduce((s, k) => s + (Number(r[k]) || 0), 0);
  if (fl || r.rushing_fumbles_lost != null || r.receiving_fumbles_lost != null) out.fum_lost = fl;
  return out;
}

/** Sleeper's line wins; nflverse fills keys Sleeper lacks and adds its nv_* extras. Pure. */
export function mergeLines(sleeperLine, nvLine) {
  const out = { ...(nvLine || {}) };
  for (const [k, v] of Object.entries(sleeperLine || {})) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

let idMapMemo = null;
/** nflverse gsis id → Sleeper id, and pfr id → gsis (memoized 6 hours). */
async function idMaps() {
  if (idMapMemo && Date.now() - idMapMemo.at < 6 * HOUR) return idMapMemo;
  const [players, dir] = await Promise.all([sleeper.getPlayers(), nv.players().catch(() => ({ byGsis: new Map(), byEspn: new Map() }))]);
  const gsisToSleeper = new Map();
  for (const [id, m] of Object.entries(players || {})) {
    const g = String(m?.gsis_id || "").trim();
    if (g) gsisToSleeper.set(g, String(id));
  }
  for (const [id, m] of Object.entries(players || {})) {
    if (!m?.espn_id) continue;
    const g = dir.byEspn.get(String(m.espn_id))?.gsis_id;
    if (g && !gsisToSleeper.has(g)) gsisToSleeper.set(g, String(id));
  }
  const pfrToGsis = new Map();
  for (const [g, r] of dir.byGsis) if (r.pfr_id) pfrToGsis.set(r.pfr_id, g);
  idMapMemo = { at: Date.now(), players, gsisToSleeper, pfrToGsis };
  return idMapMemo;
}
export const _resetForTests = () => (idMapMemo = null);

function weekState(kind, season, week) {
  return db.prepare("SELECT at, rows, source FROM stat_line_weeks WHERE kind = ? AND season = ? AND week = ?").get(kind, season, week) || null;
}

/** Whether a stored week should be read again. Pure apart from the clock. */
export function isStale(kind, season, week, st, cur, now = Date.now()) {
  if (!st) return true;
  const s = Number(season);
  if (s < Number(cur.season)) return false; // past seasons are final
  if (kind === "proj") return Number(week) >= Number(cur.week) && now - st.at > 6 * HOUR;
  if (Number(week) > Number(cur.week)) return now - st.at > 6 * HOUR; // not played yet
  return Number(week) >= Number(cur.week) - 2 && now - st.at > (Number(week) === Number(cur.week) ? HOUR : 12 * HOUR);
}

const write = db.prepare("INSERT OR REPLACE INTO stat_lines (kind, season, week, player_id, pos, team, stats_json) VALUES (?,?,?,?,?,?,?)");
const clear = db.prepare("DELETE FROM stat_lines WHERE kind = ? AND season = ? AND week = ?");
const mark = db.prepare("INSERT OR REPLACE INTO stat_line_weeks (kind, season, week, at, rows, source) VALUES (?,?,?,?,?,?)");

async function loadStatWeek(season, week, cur) {
  const maps = await idMaps();
  const players = maps.players || {};
  const [sl, weekly, snaps] = await Promise.all([
    sleeper.getWeekStats(season, week).catch(() => null),
    nv.weekly(season, cur.season).catch(() => []),
    nv.snaps(season, cur.season).catch(() => []),
  ]);
  const lines = new Map(); // sleeperId -> { pos, team, nv, sl, snaps }
  const get = (id) => lines.get(id) || lines.set(id, {}).get(id);
  for (const r of weekly) {
    if (r.week !== Number(week)) continue;
    const sid = maps.gsisToSleeper.get(r.player_id);
    if (!sid) continue;
    const e = get(sid);
    e.nv = lineFromNflverse(r);
    e.pos = r.position;
    e.team = r.team;
  }
  for (const s of snaps) {
    if (s.week !== Number(week)) continue;
    const g = maps.pfrToGsis.get(s.pfr_player_id);
    const sid = g ? maps.gsisToSleeper.get(g) : null;
    if (!sid) continue;
    const e = get(sid);
    e.snaps = { nv_snaps: s.offense_snaps ?? 0, nv_snap_pct: s.offense_pct ?? null };
    e.team ||= s.team;
  }
  let sleeperRows = 0;
  for (const [id, stats] of Object.entries(sl || {})) {
    if (!stats || id.startsWith("TEAM_")) continue;
    const m = players[id];
    const pos = m?.position;
    if (!FANTASY_POS.has(pos)) continue;
    const e = get(String(id));
    e.sl = stats;
    e.pos ||= pos;
    e.team ||= m?.team || (pos === "DEF" ? id : null);
    sleeperRows++;
  }
  let n = 0;
  db.transaction(() => {
    clear.run("stat", season, week);
    for (const [id, e] of lines) {
      const pos = e.pos || players[id]?.position;
      if (!FANTASY_POS.has(pos)) continue;
      const line = { ...mergeLines(e.sl, e.nv), ...(e.snaps || {}) };
      // Sleeper lists every rostered player each week; skip lines with nothing in them.
      if (!Object.entries(line).some(([k, v]) => k !== "gp" && k !== "gms_active" && Number(v) !== 0)) continue;
      write.run("stat", season, week, id, pos, e.team || null, JSON.stringify(line));
      n++;
    }
    mark.run("stat", season, week, Date.now(), n, sleeperRows ? "sleeper+nflverse" : "nflverse");
  })();
  return n;
}

async function loadProjWeek(season, week, cur) {
  const past = Number(season) < Number(cur.season) || Number(week) < Number(cur.week);
  const pool = await slp.getWeekProjections(season, week, past ? { ttlMs: 30 * 24 * HOUR } : {});
  const players = (await idMaps()).players || {};
  let n = 0;
  db.transaction(() => {
    clear.run("proj", season, week);
    for (const [id, e] of Object.entries(pool?.byId || {})) {
      const pos = e.pos || players[id]?.position;
      if (!FANTASY_POS.has(pos)) continue;
      write.run("proj", season, week, id, pos, players[id]?.team || (pos === "DEF" ? id : null), JSON.stringify(e.stats || {}));
      n++;
    }
    mark.run("proj", season, week, Date.now(), n, "sleeper");
  })();
  return n;
}

const inflight = new Map();
/** Makes sure one week is in the table (loading or refreshing it when needed). Never throws. */
export async function ensureWeek(kind, season, week, cur) {
  season = Number(season);
  week = Number(week);
  if (kind === "proj" && season < FIRST_PROJ_SEASON) return { ok: false, reason: "no projections before 2025" };
  if (kind === "stat" && (season < FIRST_STAT_SEASON || season > Number(cur.season) || (season === Number(cur.season) && week > Number(cur.week)))) return { ok: false, reason: "not played yet" };
  const st = weekState(kind, season, week);
  if (!isStale(kind, season, week, st, cur)) return { ok: true, rows: st.rows };
  const key = `${kind}:${season}:${week}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (kind === "stat" ? loadStatWeek(season, week, cur) : loadProjWeek(season, week, cur))
    .then((rows) => ({ ok: true, rows }))
    .catch((err) => {
      console.warn(`[statsStore] ${key}: ${err.message}`);
      return { ok: Boolean(st), rows: st?.rows || 0, error: err.message };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Loads many weeks, a few at a time. */
export async function ensureWeeks(kind, pairs, cur, concurrency = 4) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, pairs.length) }, async () => {
    while (i < pairs.length) {
      const [s, w] = pairs[i++];
      out.push({ season: s, week: w, ...(await ensureWeek(kind, s, w, cur)) });
    }
  });
  await Promise.all(workers);
  return out;
}

/** Every stored line for these weeks: [{ season, week, id, pos, team, stats }]. */
export function linesFor(kind, pairs) {
  if (!pairs.length) return [];
  const out = [];
  const q = db.prepare("SELECT season, week, player_id AS id, pos, team, stats_json FROM stat_lines WHERE kind = ? AND season = ? AND week = ?");
  for (const [s, w] of pairs) for (const r of q.all(kind, Number(s), Number(w))) out.push({ season: r.season, week: r.week, id: r.id, pos: r.pos, team: r.team, stats: JSON.parse(r.stats_json) });
  return out;
}

export function summary() {
  return db.prepare("SELECT kind, season, COUNT(*) AS weeks, SUM(rows) AS rows, MAX(at) AS at FROM stat_line_weeks GROUP BY kind, season ORDER BY kind, season").all();
}
