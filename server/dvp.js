import db from "./db.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";
import * as slp from "./sleeperProjections.js";

/**
 * v2.8 matchup difficulty: defense-vs-position (DvP) and offense-by-position
 * rankings, built in-app from Sleeper's weekly stats feed.
 *
 * Source: api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular&position[]=…
 * (same style as the projections feed; api.sleeper.app as backup). Every row
 * carries the player's team AND opponent for that game, so no separate
 * schedule is needed. Verified live while building v2.8 for 2026 weeks 1–3
 * (WR, DEF) and 2025 week 10 (DEF, 32 rows). Unofficial and undocumented.
 *
 * Per game, per scoring profile: the fantasy points each offense's QBs / RBs
 * / WRs / TEs / Ks scored (in that league's scoring) — that's points
 * ALLOWED by the defense they faced. For DEF the same thing runs the other
 * way: the D/ST points scored against an offense are "allowed" by that
 * offense, so the DEF column ranks offenses as matchups for your defense.
 *
 * Modes:
 *   current  — this season's games only
 *   blended  — this season + last season, last season's games together
 *              weighted like PREV_WEIGHT_GAMES games, fading to 0 as this
 *              season's sample grows (see prevWeightTotal)
 *   last4    — each team's 4 most recent games (reaching into last season if needed)
 * Schedule-adjusted (SRS-style, additive): a defense's adjusted figure is
 * the average of (points allowed − how far that opponent's offense runs
 * above or below league average at the position), iterated together with
 * the offensive ratings until they settle. So giving up a lot to an offense
 * that does that to everyone counts less, and vice versa.
 *
 * Ranks are 1–32. Defense rank 1 = allows the fewest (toughest matchup).
 * Offense rank 1 = scores the most. `tier` is 0–4 from the point of view of
 * the player using the matchup: 0 = red (worst) … 4 = dark green (best),
 * about 6–7 teams per tier.
 */
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const URLS = ["https://api.sleeper.com/stats/nfl", "https://api.sleeper.app/stats/nfl"];
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REG_WEEKS = 18;
export const PREV_WEIGHT_GAMES = 3;
const CURRENT_WEEK_REFRESH_MS = 55 * 60 * 1000;
const CORRECTION_WINDOW_MS = 9 * 24 * 3600 * 1000; // stat corrections: re-pull finished weeks daily for ~9 days
const MODES = ["blended", "current", "last4"];

db.exec(`
  CREATE TABLE IF NOT EXISTS dvp_stats (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    pos TEXT, team TEXT, opp TEXT, game_id TEXT, stats_json TEXT,
    PRIMARY KEY (season, week, player_id)
  );
  CREATE TABLE IF NOT EXISTS dvp_weeks (
    season INTEGER NOT NULL, week INTEGER NOT NULL,
    rows INTEGER, games INTEGER, partial INTEGER DEFAULT 0,
    first_loaded_at INTEGER, loaded_at INTEGER,
    PRIMARY KEY (season, week)
  );
`);

export function normTeam(t) {
  if (!t) return null;
  const n = schedule.normalizeTeam(String(t));
  return n === "LA" ? "LAR" : n;
}

/* ---------------- loading ---------------- */
async function fetchStatsWeek(season, week) {
  const params = new URLSearchParams({ season_type: "regular" });
  for (const p of POSITIONS) params.append("position[]", p);
  let lastErr;
  for (const base of URLS) {
    try {
      const res = await fetch(`${base}/${season}/${week}?${params}`, { headers: { Accept: "application/json", "User-Agent": BROWSER_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
      const json = await res.json();
      const rows = Array.isArray(json) ? json : json && typeof json === "object" ? Object.entries(json).map(([player_id, v]) => ({ player_id, ...(v || {}) })) : [];
      return rows;
    } catch (err) {
      lastErr = err;
      console.warn(`[dvp] stats ${season} wk${week}: ${err.message} — trying next source`);
    }
  }
  throw lastErr || new Error("Sleeper stats unavailable");
}

const PLAYED_KEYS = ["pass_att", "rush_att", "rec_tgt", "rec", "fga", "xpa", "off_snp", "pass_yd", "rush_yd", "rec_yd"];
function cleanStats(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.includes("rank") || k.startsWith("fan_pts") || (k.startsWith("pts_") && !k.startsWith("pts_allow"))) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) >= 999) continue;
    out[k] = n;
  }
  return out;
}
/** Sleeper stat rows -> rows we keep (players who actually played, with team + opponent). */
export function parseStatRows(rows, { onlyTeams = null } = {}) {
  const out = [];
  for (const r of rows || []) {
    const pos = r?.player?.position || r?.position || null;
    if (!POSITIONS.includes(pos)) continue;
    const team = normTeam(r.team || r.player?.team);
    const opp = normTeam(r.opponent);
    if (!team || !opp) continue;
    if (onlyTeams && !onlyTeams.has(team)) continue;
    const stats = cleanStats(r.stats);
    const gp = r.stats?.gp;
    const played = gp != null ? Number(gp) > 0 : PLAYED_KEYS.some((k) => Number(stats[k]) > 0);
    if (!played) continue;
    out.push({ player_id: String(r.player_id), pos, team, opp, game_id: r.game_id ? String(r.game_id) : null, stats });
  }
  return out;
}

const insertRow = db.prepare("INSERT OR REPLACE INTO dvp_stats (season, week, player_id, pos, team, opp, game_id, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const saveWeek = db.transaction((season, week, rows, partial) => {
  db.prepare("DELETE FROM dvp_stats WHERE season = ? AND week = ?").run(season, week);
  for (const r of rows) insertRow.run(season, week, r.player_id, r.pos, r.team, r.opp, r.game_id, JSON.stringify(r.stats));
  const games = new Set(rows.map((r) => [r.team, r.opp].sort().join("-"))).size;
  const now = Date.now();
  db.prepare(
    "INSERT INTO dvp_weeks (season, week, rows, games, partial, first_loaded_at, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(season, week) DO UPDATE SET rows = excluded.rows, games = excluded.games, partial = excluded.partial, loaded_at = excluded.loaded_at"
  ).run(season, week, rows.length, games, partial ? 1 : 0, now, now);
});

let dataVersion = 0;
export async function loadWeek(season, week, { finishedOnly = false } = {}) {
  let onlyTeams = null;
  if (finishedOnly) {
    // In-progress week: only games ESPN shows as final.
    const sched = await schedule.getWeekSchedule(season, week, { live: true }).catch(() => null);
    onlyTeams = new Set(Object.entries(sched?.byTeam || {}).filter(([, g]) => g.state === "post").map(([t]) => t));
  }
  const raw = await fetchStatsWeek(season, week);
  const rows = parseStatRows(raw, { onlyTeams });
  saveWeek(Number(season), Number(week), rows, finishedOnly);
  dataVersion++;
  return rows.length;
}

export function weekRecord(season, week) {
  return db.prepare("SELECT * FROM dvp_weeks WHERE season = ? AND week = ?").get(Number(season), Number(week)) || null;
}
export function loadedWeeks() {
  return db.prepare("SELECT season, week, rows, games, partial, loaded_at FROM dvp_weeks ORDER BY season, week").all();
}

/** Which weeks need (re)loading now. Pure, for testing. */
export function weeksToLoad({ season, week, seasonType = "regular", now = Date.now(), rec = weekRecord }) {
  const todo = [];
  const prev = season - 1;
  for (let w = 1; w <= REG_WEEKS; w++) {
    const r = rec(prev, w);
    if (!r || r.partial) todo.push({ season: prev, week: w, finishedOnly: false });
  }
  if (seasonType === "pre" || !(week >= 1)) return todo;
  const cur = Math.min(week, REG_WEEKS + 1);
  for (let w = 1; w < cur && w <= REG_WEEKS; w++) {
    const r = rec(season, w);
    const correction = r && now - r.first_loaded_at < CORRECTION_WINDOW_MS && now - r.loaded_at > 24 * 3600 * 1000;
    if (!r || r.partial || correction) todo.push({ season, week: w, finishedOnly: false });
  }
  if (week <= REG_WEEKS && seasonType !== "post") {
    const r = rec(season, week);
    if (!r || now - r.loaded_at > CURRENT_WEEK_REFRESH_MS) todo.push({ season, week, finishedOnly: true });
  }
  return todo;
}

let running = null;
/** Loads whatever is missing or stale. Safe to call often; one run at a time. */
export function ensureLoaded({ pauseMs = 300 } = {}) {
  if (running) return running;
  running = (async () => {
    const nfl = await sleeper.getState();
    const season = Number(nfl.season);
    const week = Number(nfl.week ?? nfl.display_week ?? 0);
    const todo = weeksToLoad({ season, week, seasonType: nfl.season_type || "regular" });
    let loaded = 0;
    for (const t of todo) {
      try {
        const n = await loadWeek(t.season, t.week, { finishedOnly: t.finishedOnly });
        loaded++;
        if (!t.finishedOnly) console.log(`[dvp] loaded ${t.season} wk${t.week}: ${n} player rows`);
      } catch (err) {
        console.warn(`[dvp] couldn't load ${t.season} wk${t.week}: ${err.message}`);
      }
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    if (loaded) clearComputed();
    return { season, week, loaded, pending: todo.length };
  })().finally(() => {
    running = null;
  });
  return running;
}

/* ---------------- per-game points per profile ---------------- */
const gamesCache = new Map(); // `${profile}|${version}` -> games
const computedCache = new Map();
function clearComputed() {
  gamesCache.clear();
  computedCache.clear();
}

/**
 * Team-game totals for one scoring profile:
 * [{ season, week, team, opp, pos, pts }] — `team` is the side that scored
 * the points (the offense; for DEF, the defense), `opp` the side that
 * allowed them. A position with nobody scoring counts as 0.
 */
export function teamGames(profileKey, settings, rows = null) {
  const key = `${profileKey}|${dataVersion}`;
  if (!rows && gamesCache.has(key)) return gamesCache.get(key);
  const src = rows || db.prepare("SELECT season, week, pos, team, opp, stats_json FROM dvp_stats").all();
  const map = new Map();
  const gameTeams = new Map(); // `${season}|${week}|${team}` -> opp
  for (const r of src) {
    const stats = r.stats || JSON.parse(r.stats_json || "{}");
    const pts = slp.scoreStats({ pos: r.pos, stats }, settings) ?? 0;
    const k = `${r.season}|${r.week}|${r.team}|${r.pos}`;
    if (!map.has(k)) map.set(k, { season: Number(r.season), week: Number(r.week), team: r.team, opp: r.opp, pos: r.pos, pts: 0 });
    map.get(k).pts += pts;
    gameTeams.set(`${r.season}|${r.week}|${r.team}`, r.opp);
    gameTeams.set(`${r.season}|${r.week}|${r.opp}`, r.team);
  }
  for (const [gk, opp] of gameTeams) {
    const [season, week, team] = gk.split("|");
    for (const pos of POSITIONS) {
      const k = `${season}|${week}|${team}|${pos}`;
      if (!map.has(k)) map.set(k, { season: Number(season), week: Number(week), team, opp, pos, pts: 0 });
    }
  }
  const out = [...map.values()].map((g) => ({ ...g, pts: Math.round(g.pts * 100) / 100 }));
  if (!rows) gamesCache.set(key, out);
  return out;
}

/* ---------------- rankings ---------------- */
/** Last season's total weight (in "games") for a team with n games this season. */
export function prevWeightTotal(nCurrent) {
  return PREV_WEIGHT_GAMES * Math.min(1, Math.max(0, (14 - nCurrent) / 10));
}

/**
 * Weighted sample per team for one side. side "def": games the team faced
 * (g.opp === team); side "off": games the team scored in (g.team === team).
 */
function samples(games, side, mode, season) {
  const byTeam = new Map();
  for (const g of games) {
    const t = side === "def" ? g.opp : g.team;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(g);
  }
  const out = new Map();
  for (const [t, list] of byTeam) {
    const cur = list.filter((g) => g.season === season);
    const prev = list.filter((g) => g.season === season - 1);
    let s = [];
    if (mode === "current") s = cur.map((g) => ({ g, w: 1 }));
    else if (mode === "last4") s = [...list].sort((a, b) => b.season - a.season || b.week - a.week).slice(0, 4).map((g) => ({ g, w: 1 }));
    else {
      const total = prevWeightTotal(cur.length);
      s = [...cur.map((g) => ({ g, w: 1 })), ...(prev.length && total > 0 ? prev.map((g) => ({ g, w: total / prev.length })) : [])];
    }
    if (s.length) out.set(t, s);
  }
  return out;
}
const wavg = (list, f) => {
  let num = 0, den = 0;
  for (const x of list) {
    num += x.w * f(x);
    den += x.w;
  }
  return den > 0 ? num / den : null;
};
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
export function tierFor(rank, n, side) {
  const band = Math.min(4, Math.floor(((rank - 1) * 5) / Math.max(1, n)));
  return side === "def" ? band : 4 - band;
}

/**
 * games (from teamGames) -> { leagueAvg, defense: {pos: [...]}, offense: {pos: [...]}, ratings }
 */
export function computeRankings(games, { season, mode = "blended", adjusted = false, iterations = 12 }) {
  const result = { leagueAvg: {}, defense: {}, offense: {}, ratings: {} };
  for (const pos of POSITIONS) {
    const gp = games.filter((g) => g.pos === pos && (mode === "current" ? g.season === season : g.season >= season - 1));
    const def = samples(gp, "def", mode, season);
    const off = samples(gp, "off", mode, season);
    const defRaw = new Map([...def].map(([t, s]) => [t, wavg(s, (x) => x.g.pts)]));
    const offRaw = new Map([...off].map(([t, s]) => [t, wavg(s, (x) => x.g.pts)]));
    const vals = [...defRaw.values()];
    const L = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    let defAdj = new Map(defRaw);
    let offAdj = new Map(offRaw);
    if (adjusted) {
      for (let i = 0; i < iterations; i++) {
        const nd = new Map([...def].map(([t, s]) => [t, wavg(s, (x) => x.g.pts - ((offAdj.get(x.g.team) ?? L) - L))]));
        const no = new Map([...off].map(([t, s]) => [t, wavg(s, (x) => x.g.pts - ((defAdj.get(x.g.opp) ?? L) - L))]));
        // Keep both centred on the league average.
        const recentre = (m) => {
          const v = [...m.values()];
          const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : L;
          for (const [k, x] of m) m.set(k, x - mean + L);
          return m;
        };
        defAdj = recentre(nd);
        offAdj = recentre(no);
      }
    }
    const rank = (m, raw, side, samp) => {
      const list = [...m].map(([team, value]) => ({ team, value: r2(value), raw: r2(raw.get(team)), games: samp.get(team)?.length || 0, weight: r2(samp.get(team)?.reduce((a, x) => a + x.w, 0) || 0) }));
      list.sort((a, b) => (side === "def" ? a.value - b.value : b.value - a.value) || a.team.localeCompare(b.team));
      list.forEach((x, i) => {
        x.rank = i + 1;
        x.tier = tierFor(i + 1, list.length, side);
      });
      return list;
    };
    result.leagueAvg[pos] = r2(L);
    result.defense[pos] = rank(defAdj, defRaw, "def", def);
    result.offense[pos] = rank(offAdj, offRaw, "off", off);
    result.ratings[pos] = { defAdj, offAdj, defRaw, offRaw, def, off, L };
  }
  return result;
}

/* ---------------- settings ---------------- */
export const DEFAULT_SETTINGS = { mode: "blended", adjusted: false };
export function getSettings(username) {
  const s = store.getState(`dvp_settings:${username}`, {}) || {};
  return { mode: MODES.includes(s.mode) ? s.mode : DEFAULT_SETTINGS.mode, adjusted: Boolean(s.adjusted) };
}
export function saveSettings(username, input = {}) {
  const cur = getSettings(username);
  const next = { mode: MODES.includes(input.mode) ? input.mode : cur.mode, adjusted: input.adjusted != null ? Boolean(input.adjusted) : cur.adjusted };
  store.setState(`dvp_settings:${username}`, next);
  return next;
}

/* ---------------- API ---------------- */
async function currentSeason() {
  const nfl = await sleeper.getState().catch(() => null);
  return Number(nfl?.season) || new Date().getFullYear();
}
function profileFor(key) {
  const profiles = store.listProfiles();
  const prof = profiles.find((p) => p.profile === key) || profiles[0] || null;
  return { prof, profiles };
}
function computed(prof, season, mode, adjusted) {
  const ck = `${prof.profile}|${season}|${mode}|${adjusted}|${dataVersion}`;
  if (computedCache.has(ck)) return computedCache.get(ck);
  const games = teamGames(prof.profile, prof.settings);
  const res = computeRankings(games, { season, mode, adjusted });
  computedCache.set(ck, res);
  return res;
}

/** Rankings table for one scoring profile with the user's (or given) mode/adjusted. */
export async function getTable(username, { profile, mode, adjusted } = {}) {
  const settings = getSettings(username);
  const m = MODES.includes(mode) ? mode : settings.mode;
  const adj = adjusted != null ? adjusted === true || adjusted === "1" || adjusted === "true" : settings.adjusted;
  const season = await currentSeason();
  const { prof, profiles } = profileFor(profile);
  const base = { season, mode: m, adjusted: adj, settings, profiles: profiles.map((p) => ({ profile: p.profile, label: p.label })), loaded: loadedWeeks().filter((w) => w.season >= season - 1) };
  if (!prof) return { ...base, profile: null, note: "No scoring profiles yet — open your leagues once so the app knows your scoring." };
  const res = computed(prof, season, m, adj);
  return { ...base, profile: prof.profile, profileLabel: prof.label, leagueAvg: res.leagueAvg, defense: res.defense, offense: res.offense, updatedAt: Date.now() };
}

/** The sample behind one team's number: which games, opponents, points, opponent strength and adjustment. */
export async function getDetail(username, { profile, side = "def", team, pos, mode, adjusted } = {}) {
  const settings = getSettings(username);
  const m = MODES.includes(mode) ? mode : settings.mode;
  const adj = adjusted != null ? adjusted === true || adjusted === "1" || adjusted === "true" : settings.adjusted;
  const season = await currentSeason();
  const { prof } = profileFor(profile);
  if (!prof) throw new Error("No scoring profiles yet.");
  if (!POSITIONS.includes(pos)) throw new Error("Unknown position.");
  const t = normTeam(team);
  const res = computed(prof, season, m, adj);
  const R = res.ratings[pos];
  const sample = (side === "off" ? R.off : R.def).get(t) || [];
  // Opponent strength: for a defense's games, how the offense it faced scores
  // at this position; for an offense's games, what the defense it faced allows.
  const oppRating = (g) => (side === "off" ? (adj ? R.defAdj : R.defRaw).get(g.opp) : (adj ? R.offAdj : R.offRaw).get(g.team));
  const games = sample
    .map(({ g, w }) => {
      const opp = side === "off" ? g.opp : g.team;
      const oa = oppRating(g);
      return { season: g.season, week: g.week, opp, pts: g.pts, weight: r2(w), oppAvg: r2(oa), adjPts: r2(g.pts - ((oa ?? R.L) - R.L)) };
    })
    .sort((a, b) => b.season - a.season || b.week - a.week);
  const list = side === "off" ? res.offense[pos] : res.defense[pos];
  const row = list.find((x) => x.team === t) || null;
  return { profile: prof.profile, profileLabel: prof.label, side, team: t, pos, mode: m, adjusted: adj, season, leagueAvg: res.leagueAvg[pos], row, of: list.length, games };
}
