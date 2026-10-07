const SLEEPER_BASE = "https://api.sleeper.app/v1";
import { cacheGet, cacheSet } from "./db.js";

// v3.3: ONE place decides how long each Sleeper answer is reused (API-call reductions R1–R21).
// Everything is cached through db.js, so it survives a restart. `fresh: true` on a call skips the cache.
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const TTL = { rosters: 5 * MIN, matchups: 5 * MIN, trending: HOUR, transactionsLive: 6 * HOUR, week: 7 * DAY, season: 30 * DAY, user: 30 * DAY, playersInSeason: DAY, playersOff: 7 * DAY };
const FOREVER = 3650 * DAY;

let bootFresh = true; // /state/nfl is pulled once per server start, then only at its scheduled times
let nowFn = () => Date.now();
export function _setNowForTests(fn) { nowFn = fn || (() => Date.now()); bootFresh = true; }

// Kickoff awareness for rosters/matchups: skip the 5-minute cache within 15 minutes of any kickoff and for 15 minutes after a push.
let kickoffs = [];
const NEAR_MS = 15 * MIN;
const wroteAt = new Map();
export function setKickoffs(list) { kickoffs = (list || []).filter((k) => Number.isFinite(k)); }
export function noteWrite(leagueId) { wroteAt.set(String(leagueId), nowFn()); }
function liveWindow(leagueId) {
  const now = nowFn();
  if (kickoffs.some((k) => Math.abs(k - now) <= NEAR_MS)) return true;
  const w = wroteAt.get(String(leagueId));
  return w != null && now - w <= NEAR_MS;
}

async function cached(key, ttl, fetcher, { fresh = false } = {}) {
  if (!fresh) {
    const hit = cacheGet(key);
    if (hit !== null) return hit;
  }
  const v = await fetcher();
  if (v !== undefined && v !== null) cacheSet(key, v, typeof ttl === "function" ? ttl(v) : ttl);
  return v;
}

// Next Tue/Wed/Thu 05:00 America/Toronto strictly after `from` (R15).
const torontoParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
export function torontoNow(t = nowFn()) {
  const p = Object.fromEntries(torontoParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour), date: new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) };
}
export function nextStatePull(from) {
  let t = Math.floor(from / (5 * MIN)) * 5 * MIN + 5 * MIN;
  for (let i = 0; i < 8 * 24 * 60 / 5; i++, t += 5 * MIN) {
    const p = Object.fromEntries(torontoParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (["Tue", "Wed", "Thu"].includes(p.weekday) && Number(p.hour) === 5 && Number(p.minute) < 5) return t;
  }
  return from + DAY;
}



async function sleeperFetch(path) {
  const res = await fetch(`${SLEEPER_BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} on ${path}`);
  return res.json();
}

export function getUser(username, opts = {}) {
  // R14: the Sleeper user id never changes — look it up at login/reconnect only.
  return cached(`sl:user:${String(username).toLowerCase()}`, TTL.user, () => sleeperFetch(`/user/${encodeURIComponent(username)}`), opts);
}
/**
 * v3.9: the app moves to the next week on Tuesday at 10:00 Toronto time, without waiting for Sleeper's own week
 * change (which comes later in the week). Week N counts as finished at the first Tuesday 10:00 that is at least a
 * day after the app first saw Sleeper report week N (remembered in SQLite, so restarts don't reset it); from then
 * on `week` is N + 1 until Sleeper itself moves on. Regular season only, never past week 18. `sleeperWeek` keeps
 * Sleeper's own number (waiver claims and trades are filed under it).
 */
export function nextTuesday10(from) {
  let t = Math.floor(from / (5 * MIN)) * 5 * MIN + 5 * MIN;
  for (let i = 0; i < 8 * 24 * 12; i++, t += 5 * MIN) {
    const p = Object.fromEntries(torontoParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (p.weekday === "Tue" && Number(p.hour) === 10 && Number(p.minute) < 5) return t;
  }
  return from + 7 * DAY;
}
export function advanceWeek(state, firstSeen, now) {
  if (!state || state.season_type !== "regular") return state ? { ...state, sleeperWeek: state.week } : state;
  const w = Number(state.week) || 0;
  const done = w >= 1 && firstSeen != null && now >= nextTuesday10(firstSeen + DAY);
  return { ...state, sleeperWeek: state.week, week: done ? Math.min(18, w + 1) : state.week, weekAdvanced: done && w < 18 };
}
export async function getState(opts = {}) {
  const fresh = opts.fresh || bootFresh;
  bootFresh = false;
  const now = nowFn();
  const st = await cached("sl:state", () => Math.max(MIN, nextStatePull(now) - now), () => sleeperFetch(`/state/nfl`), { fresh });
  if (!st || !st.week) return st;
  const seenKey = `sl:weekseen:${st.season}:${st.week}`;
  let seen = cacheGet(seenKey);
  if (seen == null) {
    seen = now;
    cacheSet(seenKey, seen, 60 * DAY);
  }
  return advanceWeek(st, Number(seen), now);
}
export function getUserLeagues(userId, season, opts = {}) {
  // R16: the league list changes once a season (opts.ttl lets cross-ownership use a weekly lifetime instead).
  return cached(`sl:uleagues:${userId}:${season}`, opts.ttl || TTL.season, () => sleeperFetch(`/user/${userId}/leagues/nfl/${season}`), opts);
}
export function getLeague(leagueId, opts = {}) {
  return cached(`sl:league:${leagueId}`, TTL.week, () => sleeperFetch(`/league/${leagueId}`), opts); // R17 weekly
}
export function getRosters(leagueId, opts = {}) {
  const ttl = opts.ttl || TTL.rosters; // R1 (5 min); R20 passes a weekly ttl for other managers' leagues
  const fresh = opts.fresh || (!opts.ttl && liveWindow(leagueId));
  return cached(`sl:rosters:${leagueId}`, ttl, () => sleeperFetch(`/league/${leagueId}/rosters`), { fresh });
}
export function getLeagueUsers(leagueId, opts = {}) {
  return cached(`sl:lusers:${leagueId}`, TTL.week, () => sleeperFetch(`/league/${leagueId}/users`), opts); // R18 weekly
}
// v2.9: the waiver page wants the top 5 trending PER POSITION, so ask for more
// than the old 60 (the feed is ordered by add count; the cap Sleeper applies to
// `limit` is not documented — if it silently caps lower, positions fill up
// less, nothing breaks).
export function getTrendingAdds(limit = 200, lookbackHours = 24, opts = {}) {
  return cached(`sl:trend:${limit}:${lookbackHours}`, TTL.trending, () => sleeperFetch(`/players/nfl/trending/add?lookback_hours=${lookbackHours}&limit=${limit}`), opts); // R3 1h
}
// R19: the current week is re-read every 6 hours; weeks that are over are stored permanently.
// "Over" = at least two weeks behind the current one, because Sleeper can still book waiver
// results into the week that just ended (not confirmed either way, so this errs on re-reading).
export async function getTransactions(leagueId, round, opts = {}) {
  let cur = null;
  try { cur = Number((await getState())?.week); } catch { /* unknown week: use the short lifetime */ }
  const settled = Number.isFinite(cur) && Number(round) <= cur - 2;
  return cached(`sl:tx:${leagueId}:${round}`, settled ? FOREVER : TTL.transactionsLive, () => sleeperFetch(`/league/${leagueId}/transactions/${round}`), opts);
}
// Sleeper's own docs only show a per-team `points` total in this
// response, but the real payload is widely reported (community wrappers,
// not confirmed by a live fetch of my own) to also include
// `players_points` (player_id -> points) and `starters_points` (parallel
// to `starters`) once stats start coming in for a game. Used for "lock
// in actual score once played" — see buildLeague.js, which checks for
// this field's actual presence rather than assuming it's there.
export function getMatchups(leagueId, week, opts = {}) {
  const fresh = opts.fresh || liveWindow(leagueId);
  return cached(`sl:matchups:${leagueId}:${week}`, TTL.matchups, () => sleeperFetch(`/league/${leagueId}/matchups/${week}`), { fresh });
}

// v3.8: one week's matchups for best ball leaderboards — finished weeks are kept 30 days, the current one 10 minutes.
export function getMatchupsWeek(leagueId, week, { settled = false } = {}) {
  return cached(`sl:bbm:${leagueId}:${week}`, settled ? TTL.season : 10 * MIN, () => sleeperFetch(`/league/${leagueId}/matchups/${week}`));
}

// R5: Game Day looks at the scoreboard while games are live. One shared in-memory answer per league
// (max `maxAgeMs` old, concurrent callers share one request), so ten viewers cost the same as one.
const liveMatchups = new Map();
export function getMatchupsLive(leagueId, week, maxAgeMs = 45 * 1000) {
  const k = `${leagueId}:${week}`;
  const hit = liveMatchups.get(k);
  if (hit && nowFn() - hit.at < maxAgeMs) return hit.p;
  const p = sleeperFetch(`/league/${leagueId}/matchups/${week}`);
  liveMatchups.set(k, { at: nowFn(), p });
  p.catch(() => liveMatchups.delete(k));
  return p;
}

// v3.5: a draft's picks (player card history). A finished draft never changes, so it is kept a season.
export function getDraftPicks(draftId, opts = {}) {
  return cached(`sl:draftpicks:${draftId}`, TTL.season, () => sleeperFetch(`/draft/${draftId}/picks`), opts);
}

// ~5MB dictionary of every NFL player. Sleeper's own docs ask integrators
// not to poll this more than once a day. R21: daily in season, weekly in the offseason.
export async function getPlayers() {
  const cachedPlayers = cacheGet("sleeper:players");
  if (cachedPlayers !== null) return cachedPlayers;
  let inSeason = true;
  try {
    const st = cacheGet("sl:state");
    if (st && st.season_type) inSeason = st.season_type === "regular" || st.season_type === "post";
  } catch { /* default to the daily lifetime */ }
  const data = await sleeperFetch(`/players/nfl`);
  cacheSet("sleeper:players", data, inSeason ? TTL.playersInSeason : TTL.playersOff);
  return data;
}

// v2.5: actual per-player stat lines for a finished week (unofficial but
// widely used; keyed by Sleeper player_id, plus TEAM_xxx team totals).
// Used to score projection accuracy. Raw stats use the same keys as league
// scoring_settings, so each scoring profile can be applied to them.
export function getWeekStats(season, week) {
  return sleeperFetch(`/stats/nfl/regular/${season}/${week}`);
}

// v3.6: the same stats while games are on, for actual stat lines on roster cards. One shared in-memory copy
// (at most `maxAgeMs` old; concurrent callers share one request), so every league build in a refresh costs one call.
const liveStats = new Map();
export function getWeekStatsLive(season, week, maxAgeMs = 90 * 1000) {
  const k = `${season}:${week}`;
  const hit = liveStats.get(k);
  if (hit && nowFn() - hit.at < maxAgeMs) return hit.p;
  const p = sleeperFetch(`/stats/nfl/regular/${season}/${week}`);
  liveStats.set(k, { at: nowFn(), p });
  p.catch(() => liveStats.delete(k));
  return p;
}
