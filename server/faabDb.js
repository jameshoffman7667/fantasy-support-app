import db, { getUserState } from "./db.js";
import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";

/**
 * v3.7 — the app's own FAAB bid database, the opponent bid report and the waiver simulator.
 *
 * WHAT IS STORED: every FAAB waiver claim that carries a bid, WON (status "complete") and LOST (status "failed"),
 * from (1) the leagues you track — every week of the season — and (2) when the opponent report is on, the other
 * leagues of your opponents that are the same type as yours (dynasty vs redraft/keeper; never best ball), for the
 * current and previous week. Sleeper's public transactions endpoint lists failed claims with their bid (checked
 * against a real league 2026-10-05); a failed claim can also mean "roster full" or "player already claimed by your
 * own earlier claim", so "lost" is not always "outbid" (Sleeper's note, when it gives one, is kept).
 *
 * WHEN: the opponent collection runs for each tracked league 2 hours before that league's waivers process (and on
 * "Collect now"); your own league's claims are read again 30 minutes after waivers process. Waiver time comes
 * from the league settings — waiver_day_of_week (0 = Monday, so the default 2 = Wednesday) and daily_waivers_hour
 * in Pacific time — which is UNVERIFIED, so the app shows it and lets you set it per league.
 *
 * COST: one user-leagues call per opponent (cached a week), then for each same-type league one league + rosters
 * call (cached a week) and two transaction pages (cached 6 h / forever once settled). Capped at MAX_OPP_LEAGUES
 * leagues per collection, three at a time.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS faab_claims (
    league_id TEXT NOT NULL, tx_id TEXT NOT NULL, player_id TEXT NOT NULL,
    league_name TEXT, season INTEGER, week INTEGER, roster_id INTEGER, owner_id TEXT,
    bid INTEGER, budget INTEGER, pct REAL, status TEXT, note TEXT, at INTEGER,
    league_type TEXT, best_ball INTEGER, teams INTEGER, pos TEXT, source TEXT, collected_at INTEGER,
    PRIMARY KEY (league_id, tx_id, player_id)
  );
  CREATE INDEX IF NOT EXISTS faab_by_owner ON faab_claims (owner_id, at);
  CREATE INDEX IF NOT EXISTS faab_by_player ON faab_claims (player_id, season, week);
  CREATE INDEX IF NOT EXISTS faab_by_league ON faab_claims (league_id, season, week);
`);

export const MAX_OPP_LEAGUES = 100;
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const COLLECT_LEAD_MS = 2 * HOUR;
export const POST_WAIVER_MS = 30 * MIN;

export const leagueTypeOf = (league) => (Number(league?.settings?.type) === 2 ? "dynasty" : "redraft"); // keeper counts as redraft
export const isBestBall = (league) => Number(league?.settings?.best_ball) === 1;
export const isFaab = (league) => Number(league?.settings?.waiver_budget) > 0 && (league?.settings?.waiver_type == null || Number(league.settings.waiver_type) === 2);

/* ---------------- settings (per user) ---------------- */
const SETTINGS_KEY = (u) => `faab:settings:${u}`;
export function getSettings(username) {
  const s = store.getState(SETTINGS_KEY(username), null) || {};
  return { reportEnabled: s.reportEnabled !== false, waiverTimes: s.waiverTimes && typeof s.waiverTimes === "object" ? s.waiverTimes : {} };
}
export function saveSettings(username, patch = {}) {
  const cur = getSettings(username);
  const next = { ...cur };
  if (typeof patch.reportEnabled === "boolean") next.reportEnabled = patch.reportEnabled;
  if (patch.waiverTime && patch.waiverTime.leagueId) {
    const { leagueId, day, hour, clear } = patch.waiverTime;
    const wt = { ...cur.waiverTimes };
    if (clear) delete wt[String(leagueId)];
    else if (Number.isInteger(Number(day)) && Number(day) >= 0 && Number(day) <= 6 && Number.isInteger(Number(hour)) && Number(hour) >= 0 && Number(hour) <= 23) wt[String(leagueId)] = { day: Number(day), hour: Number(hour) };
    next.waiverTimes = wt;
  }
  store.setState(SETTINGS_KEY(username), next);
  return next;
}

/* ---------------- parsing (pure) ---------------- */
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Sleeper transactions → FAAB claim rows (won and lost). Only waiver claims with a bid; one row per added player.
 * ctx: { leagueId, leagueName, season, week, budget, ownerByRoster: Map, leagueType, bestBall, teams, posOf(id), source, now }
 */
export function claimsFromTransactions(raw, ctx) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const t of raw) {
    if (!t || t.type !== "waiver") continue;
    const status = t.status === "complete" ? "won" : t.status === "failed" ? "lost" : null;
    if (!status) continue;
    const bid = num(t.settings?.waiver_bid);
    if (bid == null) continue;
    const adds = t.adds && typeof t.adds === "object" ? Object.entries(t.adds) : [];
    for (const [playerId, rosterIdRaw] of adds) {
      const rosterId = num(rosterIdRaw) ?? num(t.roster_ids?.[0]);
      out.push({
        league_id: String(ctx.leagueId),
        tx_id: String(t.transaction_id ?? `${t.created}-${playerId}`),
        player_id: String(playerId),
        league_name: ctx.leagueName ?? null,
        season: Number(ctx.season) || null,
        week: num(t.leg) ?? num(ctx.week),
        roster_id: rosterId,
        owner_id: rosterId != null ? ctx.ownerByRoster?.get(rosterId) ?? null : null,
        bid,
        budget: num(ctx.budget),
        pct: ctx.budget ? Math.round((bid / ctx.budget) * 1000) / 10 : null,
        status,
        note: t.metadata?.notes ? String(t.metadata.notes).slice(0, 200) : null,
        at: num(t.status_updated) ?? num(t.created),
        league_type: ctx.leagueType ?? null,
        best_ball: ctx.bestBall ? 1 : 0,
        teams: num(ctx.teams),
        pos: ctx.posOf ? ctx.posOf(playerId) : null,
        source: ctx.source ?? null,
        collected_at: ctx.now ?? Date.now(),
      });
    }
  }
  return out;
}

const insertStmt = db.prepare(`INSERT OR REPLACE INTO faab_claims (league_id, tx_id, player_id, league_name, season, week, roster_id, owner_id, bid, budget, pct, status, note, at, league_type, best_ball, teams, pos, source, collected_at)
  VALUES (@league_id, @tx_id, @player_id, @league_name, @season, @week, @roster_id, @owner_id, @bid, @budget, @pct, @status, @note, @at, @league_type, @best_ball, @teams, @pos, @source, @collected_at)`);
export function saveClaims(rows) {
  if (!rows.length) return 0;
  const tx = db.transaction((list) => {
    for (const r of list) insertStmt.run(r);
  });
  tx(rows);
  return rows.length;
}

/* ---------------- waiver processing time ---------------- */
const partsIn = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
const LA = partsIn("America/Los_Angeles");
const ET = partsIn("America/New_York");
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const tzParts = (fmt, t) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { dow: DOW[p.weekday], hour: Number(p.hour) % 24, minute: Number(p.minute) };
};
/** Next instant strictly after `from` that is weekday `dow` (0 = Sunday, or null = any day) at hour:00 in `fmt`'s zone. */
function nextAt(fmt, dow, hour, from) {
  let t = Math.floor(from / (15 * MIN)) * 15 * MIN + 15 * MIN;
  for (let i = 0; i < 8 * 24 * 4; i++, t += 15 * MIN) {
    const p = tzParts(fmt, t);
    if ((dow == null || p.dow === dow) && p.hour === hour && p.minute === 0) return t;
  }
  return from + 7 * DAY;
}

/**
 * When this league's waivers next process, and the run before that.
 * override (user's own setting): { day: 0-6 (0 = Sunday), hour: 0-23 } in US Eastern time.
 * Default from Sleeper: daily waivers → every day at daily_waivers_hour (Pacific); else weekly on
 * waiver_day_of_week (0 = Monday … 6 = Sunday, default 2 = Wednesday) at daily_waivers_hour (default 0 = midnight) Pacific.
 */
export function waiverSchedule(league, override, now = Date.now()) {
  const s = league?.settings || {};
  if (override && Number.isInteger(override.day) && Number.isInteger(override.hour)) {
    const next = nextAt(ET, override.day, override.hour, now);
    return { next, prev: next - 7 * DAY, daily: false, source: "your setting", day: override.day, hourET: override.hour };
  }
  const hour = Number.isInteger(Number(s.daily_waivers_hour)) ? Number(s.daily_waivers_hour) : 0;
  if (Number(s.daily_waivers) === 1) {
    const next = nextAt(LA, null, hour, now);
    return { next, prev: next - DAY, daily: true, source: "league settings (estimated)", day: null, hourET: tzParts(ET, next).hour };
  }
  const sleeperDay = Number.isInteger(Number(s.waiver_day_of_week)) ? Number(s.waiver_day_of_week) : 2;
  const dow = (sleeperDay + 1) % 7; // Sleeper 0 = Monday → JS 1
  const next = nextAt(LA, dow, hour, now);
  const et = tzParts(ET, next);
  return { next, prev: next - 7 * DAY, daily: false, source: "league settings (estimated)", day: et.dow, hourET: et.hour };
}

/* ---------------- collection ---------------- */
async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}

/** Reads one league's transactions for `weeks` and stores its FAAB claims. Returns the number of claim rows. */
export async function ingestLeague(league, weeks, { source, now = Date.now(), players = null, deps = {} } = {}) {
  if (!league || !isFaab(league)) return 0;
  const getRosters = deps.getRosters || ((id) => sleeper.getRosters(id, { ttl: sleeper.TTL.week }));
  const getTransactions = deps.getTransactions || ((id, w) => sleeper.getTransactions(id, w));
  const rosters = await getRosters(league.league_id).catch(() => []);
  const ownerByRoster = new Map((Array.isArray(rosters) ? rosters : []).map((r) => [Number(r.roster_id), r.owner_id != null ? String(r.owner_id) : null]));
  const pl = players || (await sleeper.getPlayers().catch(() => ({})));
  const posOf = (id) => pl?.[id]?.position || (/^[A-Z]{2,3}$/.test(String(id)) ? "DEF" : null);
  let n = 0;
  for (const w of weeks) {
    let raw;
    try {
      raw = await getTransactions(league.league_id, w);
    } catch {
      continue;
    }
    n += saveClaims(
      claimsFromTransactions(raw, {
        leagueId: league.league_id, leagueName: league.name || null, season: league.season, week: w,
        budget: Number(league.settings?.waiver_budget) || null, ownerByRoster, leagueType: leagueTypeOf(league),
        bestBall: isBestBall(league), teams: league.total_rosters ?? (Array.isArray(rosters) ? rosters.length : null), posOf, source, now,
      })
    );
  }
  return n;
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

/**
 * Collect for one tracked league: its own claims (all weeks so far) and, when the report is on, the same-type,
 * non-best-ball FAAB leagues of every opponent (current and previous week).
 */
export async function collect(username, leagueId, { reason = "manual", now = Date.now(), deps = {} } = {}) {
  const st = deps.state || (await sleeper.getState());
  const season = String(st.season);
  const week = Math.max(1, Number(st.week) || 1);
  const getLeague = deps.getLeague || ((id) => sleeper.getLeague(id));
  const getUserLeagues = deps.getUserLeagues || ((uid) => sleeper.getUserLeagues(uid, season, { ttl: sleeper.TTL.week }));
  const getRosters = deps.getRosters || ((id) => sleeper.getRosters(id, { ttl: sleeper.TTL.week }));
  const league = await getLeague(leagueId);
  const players = deps.players || (await sleeper.getPlayers().catch(() => ({})));
  const own = await ingestLeague(league, range(1, week), { source: "tracked", now, players, deps });
  const out = { at: now, week, reason, own, opp: { leagues: 0, claims: 0, capped: false, opponents: 0 }, enabled: getSettings(username).reportEnabled };
  if (out.enabled) {
    const me = deps.myUserId ?? (await sleeper.getUser(username).catch(() => null))?.user_id ?? null;
    const rosters = await getRosters(leagueId).catch(() => []);
    const opponents = [...new Set((rosters || []).map((r) => (r.owner_id != null ? String(r.owner_id) : null)).filter((id) => id && id !== String(me)))];
    out.opp.opponents = opponents.length;
    const type = leagueTypeOf(league);
    const byId = new Map();
    await mapLimit(opponents, 3, async (uid) => {
      const list = await getUserLeagues(uid).catch(() => []);
      for (const l of Array.isArray(list) ? list : []) {
        if (!l?.league_id || String(l.league_id) === String(leagueId)) continue;
        if (leagueTypeOf(l) !== type || isBestBall(l) || !isFaab(l)) continue;
        byId.set(String(l.league_id), l);
      }
    });
    const all = [...byId.values()].sort((a, b) => String(a.league_id).localeCompare(String(b.league_id)));
    out.opp.capped = all.length > MAX_OPP_LEAGUES;
    const chosen = all.slice(0, MAX_OPP_LEAGUES);
    const weeks = [...new Set([Math.max(1, week - 1), week])];
    await mapLimit(chosen, 3, async (l) => {
      const n = await ingestLeague(l, weeks, { source: "opponent", now, players, deps }).catch(() => 0);
      out.opp.leagues += 1;
      out.opp.claims += n;
    });
  }
  store.setState(`faab:collected:${leagueId}`, out);
  return out;
}

/* ---------------- reading ---------------- */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function claimsFor({ ownerId = null, leagueType = null, season = null, playerId = null, leagueId = null, since = null, limit = 2000 } = {}) {
  const where = [];
  const args = [];
  if (ownerId) where.push("owner_id = ?"), args.push(String(ownerId));
  if (leagueType) where.push("league_type = ?"), args.push(leagueType);
  if (season) where.push("season = ?"), args.push(Number(season));
  if (playerId) where.push("player_id = ?"), args.push(String(playerId));
  if (leagueId) where.push("league_id = ?"), args.push(String(leagueId));
  if (since) where.push("at >= ?"), args.push(Number(since));
  return db.prepare(`SELECT * FROM faab_claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`).all(...args, limit);
}

/** Bidding habits from claim rows (pure): counts, won/lost, bid % of budget, positions. */
export function habits(rows) {
  const pcts = rows.map((r) => r.pct).filter((x) => x != null);
  const byPos = {};
  for (const r of rows) if (r.pos) byPos[r.pos] = (byPos[r.pos] || 0) + 1;
  const weeks = new Set(rows.map((r) => `${r.league_id}:${r.week}`));
  return {
    claims: rows.length,
    won: rows.filter((r) => r.status === "won").length,
    lost: rows.filter((r) => r.status === "lost").length,
    medianPct: r1(median(pcts)),
    p75Pct: r1(quantile(pcts, 0.75)),
    maxPct: pcts.length ? r1(Math.max(...pcts)) : null,
    zeroBids: rows.filter((r) => r.bid === 0).length,
    byPos,
    leagueWeeks: weeks.size,
    lastAt: rows.length ? Math.max(...rows.map((r) => r.at || 0)) : null,
  };
}

/** Aggressiveness label from an owner's median bid % vs the pool's. */
export function aggression(ownerMedian, poolMedian) {
  if (ownerMedian == null || poolMedian == null || poolMedian <= 0) return null;
  const ratio = Math.round((ownerMedian / poolMedian) * 100) / 100;
  return { ratio, label: ratio >= 1.5 ? "Aggressive" : ratio >= 1.15 ? "Above average" : ratio <= 0.6 ? "Conservative" : ratio <= 0.85 ? "Below average" : "Typical" };
}

/**
 * The Opponents report for one tracked league.
 * ctx: { league, rosters, users, myUserId, players, season, week } — "available" = on no roster in this league.
 */
export function buildReport(username, ctx, { now = Date.now() } = {}) {
  const { league, rosters = [], users = [], myUserId, players = {}, season, week } = ctx;
  const rosteredIds = new Set(rosters.flatMap((r) => (r.players || []).map(String)));
  const type = leagueTypeOf(league);
  const settings = getSettings(username);
  const sched = waiverSchedule(league, settings.waiverTimes[String(league.league_id)], now);
  const collected = store.getState(`faab:collected:${league.league_id}`, null);
  const budget = Number(league.settings?.waiver_budget) || 0;
  const userById = new Map(users.map((u) => [String(u.user_id), u]));
  const pool = claimsFor({ leagueType: type, season }).filter((r) => !r.best_ball);
  const poolMedian = median(pool.map((r) => r.pct).filter((x) => x != null));
  const nameOf = (id) => {
    const p = players?.[id];
    return p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() || String(id) : /^[A-Z]{2,3}$/.test(String(id)) ? `${id} D/ST` : `Player ${id}`;
  };
  const opponents = rosters
    .filter((r) => r.owner_id != null && String(r.owner_id) !== String(myUserId))
    .map((r) => {
      const uid = String(r.owner_id);
      const u = userById.get(uid);
      const rows = pool.filter((x) => x.owner_id === uid);
      const h = habits(rows);
      const used = Number(r.settings?.waiver_budget_used) || 0;
      return {
        ownerId: uid,
        rosterId: r.roster_id,
        name: u?.display_name || `Roster #${r.roster_id}`,
        team: u?.metadata?.team_name || u?.display_name || `Roster #${r.roster_id}`,
        avatar: u?.avatar || null,
        budgetLeft: budget ? Math.max(0, budget - used) : null,
        budgetLeftPct: budget ? Math.round(((budget - used) / budget) * 1000) / 10 : null,
        waiverPosition: r.settings?.waiver_position ?? null,
        ...h,
        aggression: aggression(h.medianPct, poolMedian),
        thisLeague: habits(rows.filter((x) => String(x.league_id) === String(league.league_id))),
      };
    })
    .sort((a, b) => (b.medianPct ?? -1) - (a.medianPct ?? -1));
  // This week's bids by these opponents in their OTHER leagues on players free in this league.
  const oppIds = new Set(opponents.map((o) => o.ownerId));
  const weekRows = pool.filter((r) => oppIds.has(r.owner_id) && String(r.league_id) !== String(league.league_id) && Number(r.week) >= Number(week) - 1);
  const byPlayer = new Map();
  for (const r of weekRows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  const oppName = new Map(opponents.map((o) => [o.ownerId, o.team]));
  const hot = [...byPlayer.entries()]
    .map(([pid, rows]) => ({
      playerId: pid,
      name: nameOf(pid),
      pos: players?.[pid]?.position || rows[0].pos || null,
      team: players?.[pid]?.team || null,
      available: !rosteredIds.has(String(pid)),
      maxPct: Math.max(...rows.map((x) => x.pct ?? 0)),
      bids: rows
        .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
        .map((x) => ({ ownerId: x.owner_id, team: oppName.get(x.owner_id) || "Opponent", bid: x.bid, budget: x.budget, pct: x.pct, status: x.status, leagueName: x.league_name, week: x.week, at: x.at })),
    }))
    .sort((a, b) => Number(b.available) - Number(a.available) || b.maxPct - a.maxPct)
    .slice(0, 40);
  return {
    leagueType: type,
    settings: { reportEnabled: settings.reportEnabled },
    waiver: { next: sched.next, prev: sched.prev, daily: sched.daily, source: sched.source, day: sched.day, hourET: sched.hourET, collectAt: sched.next - COLLECT_LEAD_MS },
    collected,
    pool: { claims: pool.length, medianPct: r1(poolMedian), leagues: new Set(pool.map((r) => r.league_id)).size },
    budget,
    opponents,
    hot,
  };
}

/** One manager's actual claims (newest first), any league in the database. */
export function ownerClaims(ownerId, { players = {}, limit = 150 } = {}) {
  return claimsFor({ ownerId, limit }).map((r) => {
    const p = players?.[r.player_id];
    return {
      playerId: r.player_id,
      name: p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : /^[A-Z]{2,3}$/.test(r.player_id) ? `${r.player_id} D/ST` : `Player ${r.player_id}`,
      pos: p?.position || r.pos || null,
      team: p?.team || null,
      bid: r.bid, budget: r.budget, pct: r.pct, status: r.status, note: r.note,
      leagueId: r.league_id, leagueName: r.league_name, leagueType: r.league_type, week: r.week, at: r.at, source: r.source,
    };
  });
}

/* ---------------- waiver simulator ---------------- */
/**
 * Monte Carlo of YOUR claims (in processing order) against likely opposing bids.
 * For each player: P(someone else bids) and the size of the top opposing bid (as % of budget) are taken from the
 * database — that player's winning bids in other same-type leagues this week when there are at least 3, otherwise
 * winning bids at his position this season — scaled by how this league bids compared with the pool, and capped at
 * the most FAAB any opponent has left. Your own budget, roster spots and drops are then applied exactly like the
 * Claims page does. Ties are a coin flip (Sleeper breaks them by waiver priority, which isn't modelled).
 *
 * input: { claims: [{ key, addId, bid, dropId }], budget, remaining, openSpots, opponentsLeft: [dollars], leagueFactor,
 *          refFor(playerId) → { pcts: [..], contested: 0..1, basis } , trials, rng }
 */
export function simulateClaims({ claims = [], budget = 100, remaining = 100, openSpots = 0, opponentsLeft = [], refFor, trials = 2000, rng = Math.random, leagueFactor = 1 }) {
  const maxLeft = opponentsLeft.length ? Math.max(...opponentsLeft) : budget;
  const refs = new Map();
  for (const c of claims) if (!refs.has(c.addId)) refs.set(c.addId, refFor(c.addId));
  const stats = new Map(claims.map((c) => [c.key, { attempted: 0, won: 0, lostBid: 0, failed: 0 }]));
  const topSamples = new Map([...refs.keys()].map((id) => [id, []]));
  let spentTotal = 0;
  let winsTotal = 0;
  for (let t = 0; t < trials; t++) {
    const top = new Map();
    for (const [id, ref] of refs) {
      let m = -1; // -1 = nobody else bids
      if (ref.pcts.length && rng() < ref.contested) {
        const pct = ref.pcts[Math.floor(rng() * ref.pcts.length)] * leagueFactor;
        m = Math.min(maxLeft, Math.round((pct / 100) * budget));
      } else if (!ref.pcts.length && rng() < ref.contested) {
        m = Math.min(maxLeft, Math.round(rng() * 0.1 * budget)); // no data: a small token bid
      }
      top.set(id, m);
      if (m >= 0) topSamples.get(id).push(m);
    }
    let rem = remaining;
    let open = openSpots;
    const dropped = new Set();
    const won = new Set();
    const gone = new Set();
    for (const c of claims) {
      const s = stats.get(c.key);
      if (won.has(c.addId) || gone.has(c.addId)) continue;
      if (c.dropId && dropped.has(c.dropId)) continue;
      if (!c.dropId && open <= 0) continue;
      if (c.bid > rem) continue;
      s.attempted++;
      const m = top.get(c.addId);
      const win = c.bid > m || (c.bid === m && rng() < 0.5);
      if (!win) {
        s.lostBid++;
        gone.add(c.addId); // the player goes to the other team; later claims for him can't succeed
        continue;
      }
      s.won++;
      won.add(c.addId);
      if (c.dropId) dropped.add(c.dropId);
      else open -= 1;
      rem -= c.bid;
      spentTotal += c.bid;
      winsTotal++;
    }
  }
  const results = claims.map((c) => {
    const s = stats.get(c.key);
    const tops = topSamples.get(c.addId) || [];
    const ref = refs.get(c.addId);
    return {
      key: c.key,
      winPct: Math.round((s.won / trials) * 1000) / 10,
      attemptedPct: Math.round((s.attempted / trials) * 1000) / 10,
      winIfAttemptedPct: s.attempted ? Math.round((s.won / s.attempted) * 1000) / 10 : null,
      contestedPct: Math.round(ref.contested * 1000) / 10,
      top: tops.length ? { p50: quantile(tops, 0.5), p75: quantile(tops, 0.75), p90: quantile(tops, 0.9) } : null,
      basis: ref.basis,
      sample: ref.pcts.length,
    };
  });
  return { trials, results, expectedSpend: Math.round(spentTotal / trials), expectedWins: Math.round((winsTotal / trials) * 10) / 10 };
}

/**
 * Reference for one player (server side, from the database): this week's winning bids on him in other same-type
 * leagues (≥ 3 needed), else winning bids at his position this season (last 6 weeks). P(contested) from how many
 * other leagues bid on him this week and how hot he is on Sleeper's trending list.
 */
export function playerReference({ playerId, pos, leagueType, season, week, trendCount = 0, excludeLeagueId = null }) {
  const own = claimsFor({ playerId, leagueType, season }).filter((r) => !r.best_ball && String(r.league_id) !== String(excludeLeagueId) && Number(r.week) >= Number(week) - 1);
  const ownWins = own.filter((r) => r.status === "won" && r.pct != null).map((r) => r.pct);
  const leaguesBidding = new Set(own.map((r) => r.league_id)).size;
  let pcts;
  let basis;
  if (ownWins.length >= 3) {
    pcts = ownWins;
    basis = `${ownWins.length} winning bids on him in other leagues this week`;
  } else {
    const posRows = claimsFor({ leagueType, season }).filter((r) => !r.best_ball && r.status === "won" && r.pct != null && r.pos === pos && Number(r.week) >= Number(week) - 6);
    pcts = [...ownWins, ...posRows.map((r) => r.pct)];
    basis = `${posRows.length} winning ${pos || ""} bids this season${ownWins.length ? ` + ${ownWins.length} on him` : ""}`;
  }
  const contested = leaguesBidding >= 2 || trendCount >= 5000 ? 0.9 : leaguesBidding === 1 || trendCount >= 1000 ? 0.65 : 0.35;
  return { pcts, contested, basis, leaguesBidding };
}

/** How this league bids compared with the pool (median bid % ratio, clamped 0.5–2; 1 when either is thin). */
export function leagueFactor({ leagueId, leagueType, season }) {
  const all = claimsFor({ leagueType, season }).filter((r) => !r.best_ball && r.status === "won" && r.pct != null);
  const mine = all.filter((r) => String(r.league_id) === String(leagueId));
  if (mine.length < 8 || all.length < 30) return { factor: 1, basis: "not enough history in this league yet" };
  const f = median(mine.map((r) => r.pct)) / median(all.map((r) => r.pct));
  const factor = Math.min(2, Math.max(0.5, Math.round(f * 100) / 100));
  return { factor, basis: `this league's winning bids run ${factor}× the pool's` };
}

/* ---------------- scheduler hook ---------------- */
/**
 * Every few minutes: for each active user's tracked league, collect 2 h before its waivers process, and re-read
 * its own claims 30 min after. Each run happens once per waiver time.
 */
export async function tick({ users, now = Date.now() } = {}) {
  for (const username of users || []) {
    const state = getUserState(username);
    const ids = state?.leagueIds || [];
    const settings = getSettings(username);
    for (const leagueId of ids) {
      let league;
      try {
        league = await sleeper.getLeague(leagueId);
      } catch {
        continue;
      }
      if (!isFaab(league)) continue;
      const sched = waiverSchedule(league, settings.waiverTimes[String(leagueId)], now);
      const pre = sched.next - COLLECT_LEAD_MS;
      const preKey = `faab:run:pre:${leagueId}:${sched.next}`;
      if (now >= pre && now < sched.next && store.getState(preKey, null) == null) {
        store.setState(preKey, now);
        await collect(username, leagueId, { reason: "2 hours before waivers", now }).catch((err) => console.warn(`[faab] collection failed for ${leagueId}: ${err.message}`));
      }
      const postKey = `faab:run:post:${leagueId}:${sched.prev}`;
      if (now >= sched.prev + POST_WAIVER_MS && now < sched.prev + 6 * HOUR && store.getState(postKey, null) == null) {
        store.setState(postKey, now);
        const st = await sleeper.getState().catch(() => null);
        const week = Math.max(1, Number(st?.week) || 1);
        await ingestLeague(league, [...new Set([Math.max(1, week - 1), week])], { source: "tracked", now }).catch(() => 0);
      }
    }
  }
}
