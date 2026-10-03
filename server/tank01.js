import { cacheGet, cacheSet } from "./db.js";
import { normalizeName } from "./matching.js";

/**
 * v2.4: Tank01 NFL API (RapidAPI) — Vegas player props and Tank01's own
 * weekly projections. Optional: everything here is skipped unless
 * TANK01_API_KEY (or RAPIDAPI_KEY) is set.
 *
 * Methodology: project doc claude/tank01-props-handoff.md. API facts from
 * that doc (tested in a separate session against the live API):
 *  - Odds must be queried per gameID (e.g. 20261004_NE@BUF) with
 *    playerProps=true, impliedTotals=true, itemFormat=list — querying by
 *    gameDate returns nothing.
 *  - Prop keys: passyds, passtd, intsthrown, passatt, comp, rushyds,
 *    longrush, recyds, recs, rushrec, anytd, firsttd, lasttd, kickpts.
 *    No fumble props.
 *  - getNFLProjections with week=N returns ~455 players in one call.
 *
 * NOT VERIFIED FROM THIS CODEBASE (no live call possible while building):
 * the exact nesting of props inside the odds response, the projections
 * response's field names, and whether getNFLPlayerList carries
 * sleeperBotID. The parsers below are written defensively, log one raw
 * sample of each response type on first use, and return nothing (never a
 * guess) when a shape doesn't match — the app then falls back to
 * Sleeper/ESPN for that player.
 *
 * QUOTA: the free tier is 1,000 calls/month, shared with anything else on
 * the key. Calls here are bounded by freshness rules, not by how often
 * leagues are rebuilt:
 *  - schedule: once a day          - player list (ID map): once a week
 *  - projections: once a day, plus one forced pull ~60 min before each kickoff slot
 *  - odds: one call per game per day, Wed–Sun (Eastern), plus one forced
 *    pull per game ~60 min before its kickoff; never after kickoff
 * ≈ 450–500 calls/month. A per-month counter stops all calls at
 * TANK01_MONTHLY_LIMIT − TANK01_RESERVE (default 1000 − 50), and calls are
 * paced to avoid the burst limit.
 */
const HOST = "tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com";
const DAY = 24 * 60 * 60 * 1000;
const PACE_MS = 1500;
const FORCE_MIN_AGE_MS = 15 * 60 * 1000; // a forced pull is skipped if the data is already this fresh
const KEEP_MS = 10 * DAY; // how long fetched data is kept for reuse (freshness is tracked separately)

// Anytime-TD vig factor from the handoff: implied probability is divided by
// this before converting to expected TDs. Calibrated there so props-implied
// rush+rec TDs matched Tank01's own projected TDs across 207 players.
export const TD_VIG = 1.18;

function apiKey() {
  return process.env.TANK01_API_KEY || process.env.RAPIDAPI_KEY || "";
}
export function isConfigured() {
  return Boolean(apiKey());
}
function monthlyLimit() {
  return Number(process.env.TANK01_MONTHLY_LIMIT || 1000);
}
function reserve() {
  return Number(process.env.TANK01_RESERVE || 50);
}

/* ---------------- quota + pacing ---------------- */
function monthKey(now = new Date()) {
  return `tank01:calls:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function callsThisMonth() {
  return Number(cacheGet(monthKey()) || 0);
}
function countCall() {
  cacheSet(monthKey(), callsThisMonth() + 1, 40 * DAY);
}
function budgetLeft() {
  return monthlyLimit() - reserve() - callsThisMonth();
}

let lastCallAt = 0;
let rateLimitedUntil = 0;
const _loggedShape = new Set();

async function tankFetch(path, params) {
  if (!isConfigured()) throw new Error("TANK01_API_KEY not set");
  if (budgetLeft() <= 0) throw new Error(`monthly Tank01 budget reached (${callsThisMonth()} calls this month)`);
  if (Date.now() < rateLimitedUntil) throw new Error("Tank01 rate-limited — backing off");
  const wait = lastCallAt + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  countCall(); // failed calls may still count against the quota, so count every attempt
  const url = `https://${HOST}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "x-rapidapi-key": apiKey(), "x-rapidapi-host": HOST, Accept: "application/json" } });
  if (res.status === 429) {
    rateLimitedUntil = Date.now() + 10 * 60 * 1000;
    throw new Error("Tank01 429 too many requests — pausing Tank01 calls for 10 minutes");
  }
  if (!res.ok) throw new Error(`Tank01 ${path} HTTP ${res.status}`);
  const json = await res.json();
  if (json && typeof json.error === "string") throw new Error(`Tank01 ${path}: ${json.error}`);
  if (!_loggedShape.has(path)) {
    _loggedShape.add(path);
    console.log(`[tank01] First ${path} response sample:`, JSON.stringify(json).slice(0, 1500));
  }
  return json?.body ?? json;
}

/* ---------------- small helpers ---------------- */
const TEAM_ALIASES = { WSH: "WAS", JAC: "JAX", LA: "LAR" };
export function normTeam(t) {
  if (!t) return null;
  const up = String(t).toUpperCase();
  return TEAM_ALIASES[up] || up;
}
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** American odds -> implied probability. */
export function impliedProb(odds) {
  const o = num(odds);
  if (o == null || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}
/** Anytime-TD American odds -> expected TDs, per the handoff (p / 1.18, then -ln(1 - p)). */
export function expectedTDs(odds) {
  const p = impliedProb(odds);
  if (p == null) return null;
  const adj = Math.min(p / TD_VIG, 0.99);
  return -Math.log(1 - adj);
}
function ageMs(entry) {
  return entry?.fetchedAt ? Date.now() - entry.fetchedAt : Infinity;
}
function easternWeekday(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
}

/* ---------------- parsers (defensive) ---------------- */
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") return Object.values(body);
  return [];
}

function parseSchedule(body) {
  return asArray(body)
    .filter((g) => g && g.gameID)
    .map((g) => {
      const epoch = num(g.gameTime_epoch);
      const [, matchup = ""] = String(g.gameID).split("_");
      const [away, home] = matchup.split("@");
      return { gameID: g.gameID, away: normTeam(g.away || away), home: normTeam(g.home || home), kickoff: epoch ? epoch * 1000 : null };
    });
}

// A prop value may be a plain number/string line, or an object holding the
// line/odds under one of several keys. Returns { line, odds }.
function readProp(v) {
  if (v == null) return { line: null, odds: null };
  if (typeof v !== "object") return { line: num(v), odds: num(v) };
  const pick = (...keys) => {
    for (const k of keys) if (v[k] != null && v[k] !== "") return v[k];
    return null;
  };
  const line = num(pick("line", "total", "overUnder", "value", "points", "yards"));
  const odds = num(pick("odds", "americanOdds", "price", "yes", "over"));
  return { line: line ?? odds, odds: odds ?? line };
}

const PROP_KEYS = ["passyds", "passtd", "intsthrown", "passatt", "comp", "rushyds", "longrush", "recyds", "recs", "rushrec", "anytd", "kickpts"];

/** Odds response -> { [tank01PlayerID]: { passyds: {line, odds}, ... } } */
export function parsePlayerProps(body) {
  const out = {};
  const games = asArray(body);
  for (const game of games) {
    if (!game || typeof game !== "object") continue;
    const propsField = Object.keys(game).find((k) => /playerprops/i.test(k));
    const list = propsField ? game[propsField] : null;
    const entries = Array.isArray(list) ? list : list && typeof list === "object" ? Object.entries(list).map(([playerID, v]) => ({ playerID, ...(v || {}) })) : [];
    for (const e of entries) {
      const id = e.playerID || e.playerId || e.id;
      if (!id) continue;
      const bag = e.propBets || e.props || e.playerProps || e;
      const props = out[id] || {};
      for (const key of PROP_KEYS) {
        if (bag[key] == null) continue;
        const parsed = readProp(bag[key]);
        if (parsed.line != null || parsed.odds != null) props[key] = parsed;
      }
      if (Object.keys(props).length) out[id] = props;
    }
  }
  return out;
}

const STAT_MAP = {
  Passing: { passYds: "pass_yd", passTD: "pass_td", int: "pass_int", passInt: "pass_int" },
  Rushing: { rushYds: "rush_yd", rushTD: "rush_td" },
  Receiving: { receptions: "rec", recYds: "rec_yd", recTD: "rec_td" },
};

/** Projections response -> { players: { [tank01ID]: rec }, defenses: { [TEAM]: rec } } */
export function parseProjections(body) {
  const players = {};
  const defenses = {};
  const pp = body?.playerProjections || {};
  for (const [id, p] of Object.entries(pp)) {
    if (!p || typeof p !== "object") continue;
    const stats = {};
    for (const [group, map] of Object.entries(STAT_MAP)) {
      for (const [src, dst] of Object.entries(map)) {
        const v = num(p[group]?.[src]);
        if (v != null) stats[dst] = v;
      }
    }
    const fl = num(p.fumblesLost ?? p.Rushing?.fumblesLost);
    if (fl != null) stats.fum_lost = fl;
    const d = p.fantasyPointsDefault || {};
    players[String(p.playerID || id)] = {
      name: p.longName || null,
      team: normTeam(p.team),
      pos: p.pos || null,
      stats,
      preset: { std: num(d.standard), half: num(d.halfPPR), ppr: num(d.PPR) },
    };
  }
  const tdp = body?.teamDefenseProjections || {};
  for (const [id, t] of Object.entries(tdp)) {
    const team = normTeam(t?.teamAbv || id);
    if (!team) continue;
    const d = t.fantasyPointsDefault;
    const val = typeof d === "object" && d ? num(d.standard ?? d.PPR ?? d.halfPPR) : num(d ?? t.fantasyPoints);
    if (val != null) defenses[team] = { preset: { std: val, half: val, ppr: val } };
  }
  return { players, defenses };
}

/** Player list -> { bySleeperId: {sleeperId: tank01ID}, byNameTeam: {"name|POS|TEAM": tank01ID} } */
function parsePlayerList(body) {
  const bySleeperId = {};
  const byNameTeam = {};
  for (const p of asArray(body)) {
    if (!p?.playerID) continue;
    const sid = p.sleeperBotID || p.sleeperBotId || p.sleeperID;
    if (sid) bySleeperId[String(sid)] = String(p.playerID);
    if (p.longName && p.pos) byNameTeam[`${normalizeName(p.longName)}|${p.pos}|${normTeam(p.team) || ""}`] = String(p.playerID);
  }
  return { bySleeperId, byNameTeam, withSleeperIds: Object.keys(bySleeperId).length };
}

/* ---------------- week data with freshness rules ---------------- */
const inflight = new Map();

/**
 * Brings the week's Tank01 data up to date within the quota rules and
 * returns it. `force.projections` / `force.gameIDs` (pre-kickoff pulls)
 * bypass the once-a-day rule. Never throws — failures are logged and the
 * previous data (if any) is returned.
 */
export async function getWeekData(season, week, force = {}) {
  if (!isConfigured()) return null;
  const key = `${season}:${week}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = refresh(season, week, force).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function refresh(season, week, force) {
  const dataKey = `tank01:week:${key(season, week)}`;
  const data = cacheGet(dataKey) || { schedule: null, projections: null, odds: {} };
  let changed = false;
  const save = () => cacheSet(dataKey, data, KEEP_MS);

  try {
    if (ageMs(data.schedule) > DAY) {
      const body = await tankFetch("getNFLGamesForWeek", { week: String(week), seasonType: "reg", season: String(season) });
      data.schedule = { fetchedAt: Date.now(), games: parseSchedule(body) };
      changed = true;
    }
  } catch (err) {
    console.warn(`[tank01] schedule: ${err.message}`);
  }

  try {
    if ((force.projections && ageMs(data.projections) > FORCE_MIN_AGE_MS) || ageMs(data.projections) > DAY) {
      const body = await tankFetch("getNFLProjections", { week: String(week) });
      const parsed = parseProjections(body);
      data.projections = { fetchedAt: Date.now(), ...parsed };
      changed = true;
      console.log(`[tank01] week ${week} projections: ${Object.keys(parsed.players).length} players, ${Object.keys(parsed.defenses).length} defenses.`);
    }
  } catch (err) {
    console.warn(`[tank01] projections: ${err.message}`);
  }

  const now = Date.now();
  const dailyDay = ["Wed", "Thu", "Fri", "Sat", "Sun"].includes(easternWeekday());
  const forced = new Set(force.gameIDs || []);
  let oddsCalls = 0;
  for (const g of data.schedule?.games || []) {
    if (g.kickoff != null && g.kickoff <= now) continue; // props are pulled once a game starts — never fetch after kickoff
    if (g.kickoff != null && g.kickoff - now > 7 * DAY) continue;
    const cached = data.odds[g.gameID];
    const due = (forced.has(g.gameID) && ageMs(cached) > FORCE_MIN_AGE_MS) || (dailyDay && ageMs(cached) > DAY - 30 * 60 * 1000);
    if (!due) continue;
    try {
      const body = await tankFetch("getNFLBettingOdds", { gameID: g.gameID, playerProps: "true", impliedTotals: "true", itemFormat: "list" });
      data.odds[g.gameID] = { fetchedAt: Date.now(), props: parsePlayerProps(body) };
      changed = true;
      oddsCalls++;
      save(); // save per game so a mid-pass failure keeps what was fetched
    } catch (err) {
      console.warn(`[tank01] odds ${g.gameID}: ${err.message}`);
      if (/budget|rate-limited|429/.test(err.message)) break;
    }
  }
  if (oddsCalls) console.log(`[tank01] Refreshed props for ${oddsCalls} game(s). Tank01 calls this month: ${callsThisMonth()}.`);
  if (changed) save();
  return data;
}
function key(season, week) {
  return `${season}:${week}`;
}

/** Sleeper ID -> Tank01 ID map, refreshed weekly (one call). */
export async function getIdMap() {
  if (!isConfigured()) return null;
  const cached = cacheGet("tank01:idmap");
  if (cached && ageMs(cached) < 7 * DAY) return cached;
  try {
    const body = await tankFetch("getNFLPlayerList", {});
    const map = { fetchedAt: Date.now(), ...parsePlayerList(body) };
    console.log(`[tank01] Player list: ${map.withSleeperIds} players carry a Sleeper ID.`);
    cacheSet("tank01:idmap", map, 30 * DAY);
    return map;
  } catch (err) {
    console.warn(`[tank01] player list: ${err.message}`);
    return cached || null;
  }
}

/** Finds a Sleeper player's Tank01 ID: Sleeper ID join first, then name + position + team. */
export function tankIdFor(idMap, sleeperId, { name, pos, team }) {
  if (!idMap) return null;
  if (idMap.bySleeperId?.[String(sleeperId)]) return idMap.bySleeperId[String(sleeperId)];
  if (!name || !pos) return null;
  return idMap.byNameTeam?.[`${normalizeName(name)}|${pos}|${normTeam(team) || ""}`] || null;
}

/* ---------------- props -> projected stat line ---------------- */
const TD_SPLIT_DEFAULT = { RB: 0.8, WR: 0.05, TE: 0 }; // share of a player's TDs that are rushing

/**
 * Builds a projected stat line from Vegas props, or returns null if the
 * player doesn't have a "full" set for their position:
 *   QB: passyds, passtd, intsthrown, rushyds, anytd
 *   RB: rushyds (or rushrec − recyds), recyds, recs, anytd
 *   WR/TE: recyds, recs, anytd
 *   K: kickpts (used as points directly)
 * Lines are used as the expected stat. Fumbles are 0 (no props exist).
 */
export function propsStatLine(props, pos, tankProj) {
  if (!props) return null;
  const line = (k) => props[k]?.line ?? null;
  if (pos === "K") {
    const pts = line("kickpts");
    return pts != null ? { points: pts } : null;
  }
  const td = props.anytd ? expectedTDs(props.anytd.odds ?? props.anytd.line) : null;
  if (pos === "QB") {
    const s = { pass_yd: line("passyds"), pass_td: line("passtd"), pass_int: line("intsthrown"), rush_yd: line("rushyds"), rush_td: td };
    return Object.values(s).every((v) => v != null) ? { stats: s } : null;
  }
  if (!["RB", "WR", "TE"].includes(pos)) return null;
  let rushYd = line("rushyds");
  const recYd = line("recyds");
  if (rushYd == null && line("rushrec") != null && recYd != null) rushYd = Math.max(0, line("rushrec") - recYd);
  const rec = line("recs");
  if (recYd == null || rec == null || td == null) return null;
  if (pos === "RB" && rushYd == null) return null;
  const tRush = tankProj?.stats?.rush_td;
  const tRec = tankProj?.stats?.rec_td;
  const rushShare = tRush != null && tRec != null && tRush + tRec > 0 ? tRush / (tRush + tRec) : TD_SPLIT_DEFAULT[pos];
  return { stats: { rush_yd: rushYd ?? 0, rec_yd: recYd, rec, rush_td: td * rushShare, rec_td: td * (1 - rushShare) } };
}

/** Collects one Tank01 player's props across every fetched game this week. */
export function propsFor(weekData, tankId) {
  if (!weekData || !tankId) return null;
  for (const g of Object.values(weekData.odds || {})) {
    if (g?.props?.[tankId]) return g.props[tankId];
  }
  return null;
}

/** Preset Tank01 points for the league's reception setting (used when no stat line can be scored). */
export function presetPoints(rec, scoringSettings = {}) {
  const ppr = Number(scoringSettings.rec ?? 0);
  const p = rec?.preset || {};
  return ppr >= 1 ? p.ppr : ppr > 0 ? p.half : p.std;
}
