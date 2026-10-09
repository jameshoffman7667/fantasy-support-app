import * as store from "./projectionStore.js";

/**
 * v4.4: Auto mode — per league (every league type except best ball), switched on with a check box on the Waivers page.
 *
 *   Roster checks (the hourly background refresh):
 *     • an empty IR spot is filled by a bench player who is IR-eligible (roster_update_reserve, unverified);
 *     • an empty taxi spot is filled by a bench player the league's taxi rules allow — rookies, or anyone when the
 *       league allows veterans (roster_update_taxi, unverified; the taxi rule itself is read from league settings
 *       taxi_years / taxi_allow_vets, which is also unverified: with no rule found nobody is moved).
 *   One hour before the league's waivers process (once per waiver run), FAAB leagues only:
 *     • every empty bench spot gets a $0 claim with no drop, for the top trending free agents first, then by trade
 *       value. Waiver-priority leagues never get claims.
 *
 * Claims go only to the bench: taxi and IR spots are filled by MOVING players already on the roster, never by a
 * claim. Nothing is ever dropped. It uses the Sleeper token and the "Roster changes" and "Waiver claims" switches in
 * Account → Sleeper access — with a switch off, that part is skipped and logged. Every action is logged here and sent
 * as a push notification. The planning functions are pure; the runners take their Sleeper calls as `deps`.
 */
const KEY = (u) => `automode:${u}`;
const LOG_KEY = (u) => `automode:log:${u}`;
export const MAX_CLAIMS = 5; // a safety cap per league per waiver run
const LOG_MAX = 60;
const NO_CLAIM = new Set(["Out", "IR", "PUP", "Suspended", "Doubtful", "Sus", "NA", "DNR", "COV"]);
const CLAIM_POS = new Set(["QB", "RB", "WR", "TE"]);

export function getSettings(username) {
  const s = store.getState(KEY(username), null) || {};
  return { paused: Boolean(s.paused), leagues: s.leagues && typeof s.leagues === "object" ? s.leagues : {} };
}
export function setLeague(username, leagueId, on) {
  const s = getSettings(username);
  s.leagues[String(leagueId)] = Boolean(on);
  store.setState(KEY(username), s);
  return s;
}
export function setPaused(username, paused) {
  const s = getSettings(username);
  s.paused = Boolean(paused);
  store.setState(KEY(username), s);
  return s;
}
export const isOn = (username, leagueId) => {
  const s = getSettings(username);
  return !s.paused && s.leagues[String(leagueId)] === true;
};
export const getLog = (username, leagueId = null) => (store.getState(LOG_KEY(username), null) || []).filter((e) => leagueId == null || String(e.leagueId) === String(leagueId));
export function addLog(username, entry, now = Date.now()) {
  const list = store.getState(LOG_KEY(username), null) || [];
  list.unshift({ at: now, ...entry });
  store.setState(LOG_KEY(username), list.slice(0, LOG_MAX));
}

/** Auto mode applies to every built league except best ball. */
export const eligibleLeague = (built) => Boolean(built && !built.error && !built.bestBall);
/** Claims only in FAAB leagues (never waiver-priority leagues). */
export const claimsApply = (built) => eligibleLeague(built) && Boolean(built.waiverInfo?.faab) && (built.waiverInfo.type == null || Number(built.waiverInfo.type) === 2);

const lockedNow = (p, built, now) => Boolean(p && !built.weekOver && (p.started || p.played || (p.kickoff != null && p.kickoff <= now)));
const byValue = (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0) || (Number(b.proj) || 0) - (Number(a.proj) || 0);
/** Taxi rule from the league settings: rookies up to `years` years of experience, or anyone with `allowVets`. */
export function taxiEligible(p, rules) {
  if (!rules) return false;
  if (rules.allowVets) return true;
  return rules.years != null && Number.isFinite(Number(p?.yearsExp)) && Number(p.yearsExp) < Number(rules.years);
}

/** Bench players to move into empty IR and taxi spots. Pure. → { ir: [{id,name}], taxi: [{id,name}] } */
export function planMoves(built, now = Date.now()) {
  const out = { ir: [], taxi: [] };
  if (!eligibleLeague(built)) return out;
  const bench = (built.bench || []).filter((p) => p && p.id != null && !lockedNow(p, built, now));
  const openIr = Math.max(0, (Number(built.irSlots) || 0) - (built.ir || []).filter(Boolean).length);
  const irPick = bench.filter((p) => p.irEligible).sort(byValue).slice(0, openIr);
  out.ir = irPick.map((p) => ({ id: String(p.id), name: p.name }));
  const used = new Set(out.ir.map((x) => x.id));
  const openTaxi = Math.max(0, (Number(built.taxiSlots) || 0) - (built.taxi || []).filter(Boolean).length);
  const taxiPick = bench.filter((p) => !used.has(String(p.id)) && taxiEligible(p, built.taxiRules)).sort(byValue).slice(0, openTaxi);
  out.taxi = taxiPick.map((p) => ({ id: String(p.id), name: p.name }));
  return out;
}

/**
 * $0 claims for the open bench spots: top trending free agents first, then trade value. `pendingAdds` = player ids already
 * claimed (they fill spots too); `moved` = how many bench players this run moved to IR / taxi. Pure.
 */
export function planClaims(built, { pendingAdds = [], moved = 0, now = Date.now() } = {}) {
  if (!claimsApply(built)) return [];
  const bench = (built.bench || []).filter(Boolean).length;
  const open = Math.max(0, (Number(built.benchSlots) || 0) - Math.max(0, bench - moved) - pendingAdds.length);
  if (!open) return [];
  const pending = new Set(pendingAdds.map(String));
  const pool = (built.freeAgents || []).filter((p) => p && p.id != null && CLAIM_POS.has(p.pos) && !pending.has(String(p.id)) && !NO_CLAIM.has(p.status) && !p.started && !(p.kickoff != null && p.kickoff <= now && !built.weekOver));
  pool.sort((a, b) => Number(Boolean(b.trending)) - Number(Boolean(a.trending)) || (Number(b.trendCount) || 0) - (Number(a.trendCount) || 0) || byValue(a, b));
  return pool.slice(0, Math.min(open, MAX_CLAIMS)).map((p) => ({ addId: String(p.id), name: p.name, pos: p.pos, bid: 0 }));
}

const failKey = (u, l, what, ids) => `automode:fail:${u}:${l}:${what}:${[...ids].sort().join(",")}`;
const DAY = 24 * 3600e3;
function perms(deps, username) {
  try {
    return deps.priv.status(username).perms || {};
  } catch {
    return {};
  }
}

/** Moves now (called after each roster check). Returns what it did. */
export async function runMoves(username, built, deps, now = Date.now()) {
  const done = [];
  if (!isOn(username, built?.id) || !eligibleLeague(built)) return done;
  const plan = planMoves(built, now);
  const note = (kind, list, r) => {
    for (const x of list) addLog(username, { leagueId: built.id, leagueName: built.name, kind, player: x.name, ok: Boolean(r?.ok), detail: r?.detail || "" }, now);
    if (r?.ok) {
      done.push(...list.map((x) => ({ kind, ...x })));
      deps.notify?.(username, `${built.name}: auto mode`, `${list.map((x) => x.name).join(", ")} → ${kind === "ir" ? "injured reserve" : "taxi squad"}.`);
    }
  };
  const attempt = async (kind, list, group, run) => {
    if (!list.length) return;
    const ids = list.map((x) => x.id);
    const fk = failKey(username, built.id, kind, ids);
    const failedAt = store.getState(fk, null);
    if (failedAt && now - failedAt < DAY) return; // the same move failed in the last day: don't hammer Sleeper
    if (!perms(deps, username)[group]) {
      if (!store.getState(`${fk}:skip`, null) || now - store.getState(`${fk}:skip`) > DAY) {
        store.setState(`${fk}:skip`, now);
        addLog(username, { leagueId: built.id, leagueName: built.name, kind, player: list.map((x) => x.name).join(", "), ok: false, detail: `Skipped — "${group === "roster" ? "Roster changes" : "Waiver claims"}" is switched off in Account → Sleeper access.` }, now);
      }
      return;
    }
    try {
      const r = await run(ids);
      if (!r?.ok) store.setState(fk, now);
      note(kind, list, r);
    } catch (e) {
      store.setState(fk, now);
      note(kind, list, { ok: false, detail: e.message });
    }
  };
  await attempt("ir", plan.ir, "roster", (ids) => deps.priv.updateReserve(username, { leagueId: built.id, rosterId: built.myRosterId, reserve: [...new Set([...(built.reserveIds || []).map(String), ...ids])], confirm: true }));
  await attempt("taxi", plan.taxi, "roster", (ids) => deps.priv.updateTaxi(username, { leagueId: built.id, rosterId: built.myRosterId, taxi: [...new Set([...(built.taxiIds || []).map(String), ...ids])], confirm: true }));
  return done;
}

/** $0 claims for the open bench spots (called once per waiver run, an hour before processing). */
export async function runClaims(username, built, deps, { moved = 0, now = Date.now() } = {}) {
  const sent = [];
  if (!isOn(username, built?.id) || !claimsApply(built)) return sent;
  if (!perms(deps, username).claims) {
    addLog(username, { leagueId: built.id, leagueName: built.name, kind: "claim", player: "", ok: false, detail: 'Skipped — "Waiver claims" is switched off in Account → Sleeper access.' }, now);
    return sent;
  }
  const leg = await deps.getLeg(built);
  const legs = [leg, leg + 1, Number(built.week)];
  let pendingAdds = [];
  try {
    const r = await deps.priv.getPendingClaims(username, built.id, legs, built.myRosterId);
    pendingAdds = (r.claims || []).flatMap((c) => Object.keys(c.adds || {}));
  } catch (e) {
    addLog(username, { leagueId: built.id, leagueName: built.name, kind: "claim", player: "", ok: false, detail: `Skipped — couldn't read your pending claims first (${e.message}).` }, now);
    return sent;
  }
  for (const c of planClaims(built, { pendingAdds, moved, now })) {
    try {
      const r = await deps.priv.submitClaim(username, { leagueId: built.id, rosterId: built.myRosterId, leg, legs, addId: c.addId, dropId: null, bid: 0, confirm: true });
      addLog(username, { leagueId: built.id, leagueName: built.name, kind: "claim", player: c.name, ok: Boolean(r?.ok), detail: r?.verified === false ? `${r.detail || "sent"} (not verified)` : r?.detail || "" }, now);
      if (r?.ok) sent.push(c);
    } catch (e) {
      addLog(username, { leagueId: built.id, leagueName: built.name, kind: "claim", player: c.name, ok: false, detail: e.message }, now);
    }
  }
  if (sent.length) deps.notify?.(username, `${built.name}: auto mode`, `$0 claim${sent.length === 1 ? "" : "s"} placed for ${sent.map((x) => x.name).join(", ")}.`);
  return sent;
}
