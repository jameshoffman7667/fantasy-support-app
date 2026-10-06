import * as sleeper from "./sleeper.js";
import { cacheGet, cacheSet } from "./db.js";

/**
 * Trade Radar helper: for MY players in one league, how many of that
 * league's opponents ALSO roster them in their OTHER Sleeper leagues.
 * v3.5: counted with and without best ball leagues, and as a percentage of
 * each opponent's own (checked) leagues, so managers in many leagues don't
 * dominate.
 * (A player many opponents hold elsewhere is one they are likely to value
 * highly / be reluctant to sell; it is a hint, not a verdict.)
 *
 * COST: one getUserLeagues per opponent (~11 in a 12-team league) plus one
 * getRosters per distinct other league (opponents usually share few
 * leagues, so this can reach dozens). Both are cached 6h per user /
 * league; roster fetches are hard-capped per call (MAX_LEAGUE_FETCHES,
 * counting cache hits too -- conservative) and the user-leagues calls are
 * not capped (bounded by the number of opponents). Use getOrStart() so a
 * page build never waits on this.
 *
 * UNVERIFIED (no access to api.sleeper.app from the sandbox): response
 * shapes are taken from the public docs; roster `owner_id` is assumed to be
 * the user_id (co-owners in `co_owners` are ignored); Sleeper rate limits
 * are documented only as "stay under ~1000 calls/minute", which this stays
 * far below. Users whose other leagues are private still appear, since
 * these endpoints take no auth.
 */

export const SIX_HOURS = 6 * 3600e3;
export const MAX_LEAGUE_FETCHES = 60;
export const MIN_OPPONENTS = 2;
export const MIN_PCT = 0.25;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function computeOwnership({
  leagueId, myPlayerIds = [], opponentOwnerIds = [], season,
  sleeperPlayers = null, // accepted for API symmetry; not needed (ids are compared directly)
  concurrency = 4, maxLeagueFetches = MAX_LEAGUE_FETCHES, deps = {},
} = {}) {
  const getUserLeagues = deps.getUserLeagues || ((id, season) => sleeper.getUserLeagues(id, season, { ttl: sleeper.TTL.week }));
  const getRosters = deps.getRosters || ((id) => sleeper.getRosters(id, { ttl: sleeper.TTL.week }));
  const mine = new Set((myPlayerIds || []).map(String));
  const owners = [...new Set((opponentOwnerIds || []).map(String))];
  let errors = 0;

  // 1) each opponent's other leagues (cached per user+season) — v3.5 also notes which are best ball
  const pairs = []; // {ownerId, lid, bb}
  await mapLimit(owners, concurrency, async (ownerId) => {
    const key = `xown:leagues2:${ownerId}:${season}`;
    let list = cacheGet(key);
    if (list === null) {
      try {
        const lg = await getUserLeagues(ownerId, season);
        list = (Array.isArray(lg) ? lg : []).filter((l) => l && l.league_id).map((l) => ({ id: String(l.league_id), bb: Number(l.settings?.best_ball) === 1 }));
        cacheSet(key, list, SIX_HOURS);
      } catch {
        errors++;
        return;
      }
    }
    for (const l of list) if (l.id !== String(leagueId)) pairs.push({ ownerId, lid: l.id, bb: Boolean(l.bb) });
  });

  // 2) cap distinct league roster fetches (deterministic order)
  const allLeagues = [...new Set(pairs.map((p) => p.lid))].sort();
  const capped = allLeagues.length > maxLeagueFetches;
  const leagues = allLeagues.slice(0, maxLeagueFetches);
  const rosterByLeague = new Map(); // lid -> [{owner_id, players}]
  await mapLimit(leagues, concurrency, async (lid) => {
    const key = `xown:rosters:${lid}`;
    let slim = cacheGet(key);
    if (slim === null) {
      try {
        const rs = await getRosters(lid);
        slim = (Array.isArray(rs) ? rs : []).map((r) => ({ owner_id: r.owner_id != null ? String(r.owner_id) : null, players: (r.players || []).map(String) }));
        cacheSet(key, slim, SIX_HOURS);
      } catch {
        errors++;
        return;
      }
    }
    rosterByLeague.set(lid, slim);
  });

  // 3) tally: playerId -> ownerId -> { all, noBB } leagues holding him; per owner the leagues actually checked
  const totals = new Map(); // ownerId -> { all, noBB }
  const tally = new Map([...mine].map((id) => [id, new Map()]));
  for (const { ownerId, lid, bb } of pairs) {
    const rosters = rosterByLeague.get(lid);
    if (!rosters) continue;
    const roster = rosters.find((r) => r.owner_id === ownerId);
    if (!roster) continue;
    const t = totals.get(ownerId) || { all: 0, noBB: 0 };
    t.all += 1;
    if (!bb) t.noBB += 1;
    totals.set(ownerId, t);
    for (const pid of roster.players) {
      const m = tally.get(pid);
      if (!m) continue;
      const c = m.get(ownerId) || { all: 0, noBB: 0 };
      c.all += 1;
      if (!bb) c.noBB += 1;
      m.set(ownerId, c);
    }
  }
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const players = {};
  for (const [pid, m] of tally) {
    const opponents = [...m].map(([ownerId, c]) => {
      const t = totals.get(ownerId) || { all: 0, noBB: 0 };
      return { ownerId, leagues: c.all, total: t.all, pct: pct(c.all, t.all), leaguesNoBB: c.noBB, totalNoBB: t.noBB, pctNoBB: pct(c.noBB, t.noBB) };
    });
    players[pid] = {
      opponents,
      opponentCount: opponents.filter((o) => o.leagues > 0).length,
      opponentCountNoBB: opponents.filter((o) => o.leaguesNoBB > 0).length,
      leagueCount: opponents.reduce((s, o) => s + o.leagues, 0),
      leagueCountNoBB: opponents.reduce((s, o) => s + o.leaguesNoBB, 0),
    };
  }
  const ownerTotals = Object.fromEntries([...totals].map(([k, v]) => [k, v]));
  return { at: Date.now(), opponents: owners.length, leaguesChecked: rosterByLeague.size, bestBallLeagues: [...new Set(pairs.filter((p) => p.bb && rosterByLeague.has(p.lid)).map((p) => p.lid))].length, errors, capped, players, ownerTotals };
}

/** Player ids held elsewhere by >= minOpponents opponents AND >= minPct of all opponents (v3.5: best ball counted or not). */
export function highOwnership(result, { minOpponents = MIN_OPPONENTS, minPct = MIN_PCT, opponentsTotal, includeBestBall = false } = {}) {
  const total = opponentsTotal ?? result?.opponents ?? 0;
  if (!total) return [];
  const count = (p) => (includeBestBall ? p.opponentCount : p.opponentCountNoBB ?? p.opponentCount);
  return Object.entries(result?.players || {})
    .filter(([, p]) => count(p) >= minOpponents && count(p) / total >= minPct)
    .map(([id]) => id);
}

/**
 * Stale-while-revalidate helper. Returns the stored value immediately (or
 * null) and, if it's missing/older than ttlMs, starts AT MOST ONE
 * background compute() per key. The record {value, at} persists via
 * cacheSet (kept 7 days so a stale value can still be served while
 * refreshing). A failed compute keeps the old value and is not retried for
 * 60s so a broken API can't cause a retry storm.
 */
const running = new Map(); // key -> Promise
const failedAt = new Map(); // key -> ms
const lastErrors = new Map(); // key -> message
const STALE_KEEP_MS = 7 * 24 * 3600e3;
const RETRY_AFTER_FAIL_MS = 60 * 1000;

export function getOrStart({ key, compute, ttlMs = SIX_HOURS }) {
  const rec = cacheGet(`swr:${key}`);
  const fresh = rec && Date.now() - rec.at < ttlMs;
  if (!fresh && !running.has(key) && Date.now() - (failedAt.get(key) || 0) > RETRY_AFTER_FAIL_MS) {
    const p = (async () => {
      try {
        const value = await compute();
        cacheSet(`swr:${key}`, { value, at: Date.now() }, STALE_KEEP_MS);
        failedAt.delete(key);
        lastErrors.delete(key);
      } catch (e) {
        failedAt.set(key, Date.now());
        lastErrors.set(key, e?.message || String(e));
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, p);
  }
  return rec ? rec.value : null;
}
export const isRunning = (key) => running.has(key);
/** Promise of the in-flight compute for key (resolves when done), or null. Mainly for tests. */
export const whenIdle = (key) => running.get(key) || null;
export const lastError = (key) => lastErrors.get(key) || null;
getOrStart.isRunning = isRunning;
