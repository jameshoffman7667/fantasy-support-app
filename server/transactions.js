import * as sleeper from "./sleeper.js";
import { cacheGet, cacheSet } from "./db.js";

/**
 * Sleeper transaction feed -> normalised rows, recent drops, winning bids.
 *
 * WHAT IS (AND ISN'T) VERIFIED: everything about the payload shape comes
 * from Sleeper's public docs (docs.sleeper.com) -- GET
 * /v1/league/<id>/transactions/<round> returns an array of
 * { transaction_id, type, status, status_updated, created, leg,
 *   roster_ids, adds, drops, draft_picks, waiver_budget, settings, ... }.
 * This sandbox cannot reach api.sleeper.app, so none of it has been
 * confirmed against a live response. Every field is read defensively;
 * a missing/odd field degrades to null/empty rather than throwing.
 *
 * Time semantics (unverified): `created` is when the transaction was
 * submitted, `status_updated` when it last changed state. For a FAAB
 * waiver claim the claim is *created* when the manager bids but only
 * *takes effect* when the waiver run processes it, so we treat
 * status_updated (falling back to created) as "when it happened" for
 * drops/bids. Rows keep both timestamps.
 *
 * "Round" == week: Sleeper's `round` path segment is the league week
 * (docs call it "round"; rows carry the same number in `leg`). In the
 * offseason Sleeper may use round 0 or 1 for everything; we never request
 * a round below 1, so offseason activity filed under round 0 (if that
 * exists) would be missed. Unverified either way.
 */

const FIVE_MIN = 5 * 60 * 1000;
const DROP_TYPES = new Set(["waiver", "free_agent", "commissioner"]);
export const DEFAULT_DROP_WINDOW_MS = 3 * 24 * 3600e3;

function entries(obj) {
  // adds/drops are {playerId: rosterId} or null.
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([playerId, rosterId]) => ({ playerId: String(playerId), rosterId: rosterId ?? null }));
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Effective time of a row: when it was processed, else when created. */
function rowAt(r) {
  return r.updatedAt ?? r.createdAt ?? null;
}

/**
 * Raw Sleeper array -> normalised rows. `playersById` is accepted for API
 * symmetry with decorate() but is not used here: names/positions are added
 * later by decorate() so cached rows stay small and don't go stale.
 */
export function parseTransactions(raw, { leagueId = null, playersById = null } = {}) { // eslint-disable-line no-unused-vars
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const bid = numOrNull(t.settings?.waiver_bid ?? t.settings?.waiverBid);
    out.push({
      id: t.transaction_id != null ? String(t.transaction_id) : null,
      leagueId,
      type: t.type || null,
      status: t.status || null,
      createdAt: numOrNull(t.created),
      updatedAt: numOrNull(t.status_updated),
      week: numOrNull(t.leg),
      adds: entries(t.adds),
      drops: entries(t.drops),
      bid,
      rosterIds: Array.isArray(t.roster_ids) ? t.roster_ids : [],
    });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch + parse several weeks of one league. Per-week failures are
 * swallowed (we return whatever worked). Result cached 5 min per
 * league+weeks; a result with failed weeks is only cached 60s so a blip
 * doesn't pin a partial answer for five minutes.
 * opts.getTransactions is injectable for tests.
 */
export async function fetchLeagueTransactions(leagueId, weeks, opts = {}) {
  const get = opts.getTransactions || sleeper.getTransactions;
  const wk = [...new Set((weeks || []).map(Number).filter((w) => Number.isInteger(w) && w >= 1))].sort((a, b) => a - b);
  if (!wk.length) return [];
  const key = `txn:${leagueId}:${wk.join(",")}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  let failed = 0;
  const per = await mapLimit(wk, 3, async (w) => {
    try {
      return parseTransactions(await get(leagueId, w), { leagueId });
    } catch {
      failed++;
      return [];
    }
  });
  const rows = per.flat();
  if (failed < wk.length) cacheSet(key, rows, failed ? 60 * 1000 : FIVE_MIN);
  return rows;
}

/**
 * Players dropped (waiver / free_agent / commissioner, complete -- never
 * trades, where a "drop" is just the other side of a swap) inside the
 * window, newest first. `readded: true` if the same player was added by
 * any complete transaction (trades included) after the drop, in-window.
 */
export function recentDrops(rows, { now = Date.now(), windowMs = DEFAULT_DROP_WINDOW_MS } = {}) {
  const since = now - windowMs;
  const inWindow = (at) => at != null && at >= since && at <= now;
  const adds = [];
  for (const r of rows || []) {
    if (r.status !== "complete") continue;
    const at = rowAt(r);
    if (!inWindow(at)) continue;
    for (const a of r.adds || []) adds.push({ playerId: a.playerId, at });
  }
  const drops = [];
  for (const r of rows || []) {
    if (r.status !== "complete" || !DROP_TYPES.has(r.type)) continue;
    const at = rowAt(r);
    if (!inWindow(at)) continue;
    for (const d of r.drops || []) {
      drops.push({
        leagueId: r.leagueId ?? null,
        playerId: d.playerId,
        rosterId: d.rosterId,
        at,
        type: r.type,
        readded: adds.some((a) => a.playerId === d.playerId && a.at > at),
      });
    }
  }
  return drops.sort((a, b) => b.at - a.at);
}

/** Complete waiver claims that carry a bid -> one entry per added player. */
export function winningBids(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.type !== "waiver" || r.status !== "complete" || r.bid == null) continue;
    for (const a of r.adds || []) {
      out.push({ leagueId: r.leagueId ?? null, playerId: a.playerId, bid: r.bid, at: rowAt(r), week: r.week, rosterId: a.rosterId });
    }
  }
  return out;
}

/**
 * Activity for a league around `week`: weeks [week-1, week] plus week+1
 * when week < 18 (waivers/trades filed under the next round just after a
 * rollover; unverified whether Sleeper does this). Weeks are clamped to >= 1.
 */
export async function getLeagueActivity(leagueId, { week, now = Date.now(), windowMs, getTransactions } = {}) {
  const w = Math.max(1, Number(week) || 1);
  const weeks = [Math.max(1, w - 1), w];
  if (w < 18) weeks.push(w + 1);
  const rows = await fetchLeagueTransactions(leagueId, weeks, { getTransactions });
  return { drops: recentDrops(rows, { now, windowMs }), bids: winningBids(rows), rows };
}

function playerLabel(id, p) {
  if (p) {
    const nm = `${p.first_name || ""} ${p.last_name || ""}`.trim();
    if (nm) return nm;
  }
  return /^[A-Z]{2,3}$/.test(String(id)) ? `${id} D/ST` : `Player ${id}`;
}

/** Add name/pos/team/teamLabel to drops or bids. Team label: team_name || display_name || "Roster #n". */
export function decorate(items, { sleeperPlayers = {}, rosters = [], leagueUsers = [] } = {}) {
  const userById = new Map((leagueUsers || []).map((u) => [String(u.user_id), u]));
  const ownerByRoster = new Map((rosters || []).map((r) => [r.roster_id, r.owner_id]));
  return (items || []).map((it) => {
    const p = sleeperPlayers?.[it.playerId];
    const isDef = !p && /^[A-Z]{2,3}$/.test(String(it.playerId));
    const u = userById.get(String(ownerByRoster.get(it.rosterId)));
    return {
      ...it,
      name: playerLabel(it.playerId, p),
      pos: p?.position || (isDef ? "DEF" : null),
      team: p?.team || (isDef ? it.playerId : null),
      teamLabel: u?.metadata?.team_name || u?.display_name || `Roster #${it.rosterId}`,
    };
  });
}
