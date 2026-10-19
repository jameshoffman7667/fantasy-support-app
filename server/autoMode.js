import * as store from "./projectionStore.js";
import { FLEX_ELIGIBLE, solveLineup } from "./lineupSolve.js";

/**
 * v4.8: Auto mode is four packages, each on/off per league: IR (players into / out of injured reserve, plus taxi moves),
 * Roster (bench pickups), Lineup (bench ↔ starters for the most projected points) and Flex (later games into the flex
 * spots). They run in that order at 6 am Toronto time every day, one hour before each kickoff that matters to the
 * league, and one hour before its waivers process. A league that had the old single check box starts with all four on.
 *
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
export const MAX_CLAIMS = 12; // v4.8: a safety cap per league per run (the old cap of 5 is gone: open spots + 2)
export const EXTRA_CLAIMS = 2; // v4.8: always two more claims than empty bench spots, in case the first is unsuccessful
const LOG_MAX = 60;
const NO_CLAIM = new Set(["Out", "IR", "PUP", "Suspended", "Doubtful", "Sus", "NA", "DNR", "COV"]);
const CLAIM_POS = new Set(["QB", "RB", "WR", "TE"]);

export const PACKAGES = ["ir", "roster", "lineup", "flex"]; // also the order they run in
export const PACKAGE_LABEL = { ir: "Auto IR", roster: "Auto roster", lineup: "Auto lineup", flex: "Auto flex" };
// Auto roster's ranking criteria: the Waivers → Available views that are ranked lists of free agents.
export const RANKINGS = ["all", "trending", "hype", "spot", "ros", "stash", "handcuff"];
const ALL_ON = { ir: true, roster: true, lineup: true, flex: true };
const ALL_OFF = { ir: false, roster: false, lineup: false, flex: false };

export function getSettings(username) {
  const s = store.getState(KEY(username), null) || {};
  return { paused: Boolean(s.paused), leagues: s.leagues && typeof s.leagues === "object" ? s.leagues : {}, packages: s.packages && typeof s.packages === "object" ? s.packages : {} };
}
/** The four switches (and the roster ranking) for one league. The old single check box counts as all four on. */
export function packagesFor(s, leagueId) {
  const id = String(leagueId);
  const own = s.packages?.[id];
  const base = own ? { ...ALL_OFF, ...own } : s.leagues?.[id] === true ? { ...ALL_ON } : { ...ALL_OFF };
  const ranking = RANKINGS.includes(own?.ranking) ? own.ranking : "all";
  return { ir: Boolean(base.ir), roster: Boolean(base.roster), lineup: Boolean(base.lineup), flex: Boolean(base.flex), ranking };
}
function save(username, s) {
  // `leagues` stays as "any package on", for anything still reading the old shape
  for (const id of new Set([...Object.keys(s.leagues), ...Object.keys(s.packages)])) {
    const p = packagesFor(s, id);
    s.leagues[id] = PACKAGES.some((k) => p[k]);
  }
  store.setState(KEY(username), s);
  return s;
}
function ensurePackages(s, leagueId) {
  const id = String(leagueId);
  const cur = packagesFor(s, id);
  s.packages[id] = { ir: cur.ir, roster: cur.roster, lineup: cur.lineup, flex: cur.flex, ranking: cur.ranking };
  return s.packages[id];
}
/** Turns all four packages on or off (the old check box). */
export function setLeague(username, leagueId, on) {
  const s = getSettings(username);
  const p = ensurePackages(s, leagueId);
  for (const k of PACKAGES) p[k] = Boolean(on);
  return save(username, s);
}
export function setPackage(username, leagueId, pkg, on) {
  if (!PACKAGES.includes(pkg)) throw new Error(`Unknown Auto package "${pkg}".`);
  const s = getSettings(username);
  ensurePackages(s, leagueId)[pkg] = Boolean(on);
  return save(username, s);
}
export function setRanking(username, leagueId, ranking) {
  if (!RANKINGS.includes(ranking)) throw new Error(`Unknown ranking "${ranking}".`);
  const s = getSettings(username);
  ensurePackages(s, leagueId).ranking = ranking;
  return save(username, s);
}
export function setPaused(username, paused) {
  const s = getSettings(username);
  s.paused = Boolean(paused);
  return save(username, s);
}
/** Any package on (and not paused). */
export const isOn = (username, leagueId) => {
  const s = getSettings(username);
  if (s.paused) return false;
  const p = packagesFor(s, leagueId);
  return PACKAGES.some((k) => p[k]);
};
export const isPkgOn = (username, leagueId, pkg) => {
  const s = getSettings(username);
  return !s.paused && packagesFor(s, leagueId)[pkg] === true;
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

const hasStarted = (p, now) => Boolean(p && (p.played || p.started || (p.kickoff != null && p.kickoff <= now)));
const isLockedP = (p, built, now) => hasStarted(p, now) && !built.weekOver;

/**
 * Moves around injured reserve and the taxi squad. Pure.
 *   irOut — players in an IR slot who are no longer IR-eligible go back to the bench (only while the bench has room)
 *   ir    — bench players who are IR-eligible fill the empty IR spots (counting the ones just freed)
 *   taxi  — bench players the league's taxi rules allow fill the empty taxi spots
 * → { ir: [{id,name}], irOut: [{id,name}], taxi: [{id,name}] }
 */
export function planMoves(built, now = Date.now()) {
  const out = { ir: [], irOut: [], taxi: [] };
  if (!eligibleLeague(built)) return out;
  const benchAll = (built.bench || []).filter((p) => p && p.id != null);
  const bench = benchAll.filter((p) => !lockedNow(p, built, now));
  const irNow = (built.ir || []).filter(Boolean);
  const slots = Number(built.irSlots) || 0;
  const benchSlots = Number.isFinite(Number(built.benchSlots)) ? Number(built.benchSlots) : benchAll.length;
  let outs = irNow.filter((p) => p.irEligible === false && !isLockedP(p, built, now));
  let ins = [];
  // moving someone out of IR puts him on the bench: only as many as the bench has room for once the IR-ins have left it
  for (let guard = 0; guard < 4; guard++) {
    const open = Math.max(0, slots - irNow.length + outs.length);
    ins = bench.filter((p) => p.irEligible).sort(byValue).slice(0, open);
    const room = Math.max(0, benchSlots - (benchAll.length - ins.length));
    if (outs.length <= room) break;
    outs = outs.slice(0, room);
  }
  out.irOut = outs.map((p) => ({ id: String(p.id), name: p.name }));
  out.ir = ins.map((p) => ({ id: String(p.id), name: p.name }));
  const used = new Set(out.ir.map((x) => x.id));
  const openTaxi = Math.max(0, (Number(built.taxiSlots) || 0) - (built.taxi || []).filter(Boolean).length);
  const taxiPick = bench.filter((p) => !used.has(String(p.id)) && taxiEligible(p, built.taxiRules)).sort(byValue).slice(0, openTaxi);
  out.taxi = taxiPick.map((p) => ({ id: String(p.id), name: p.name }));
  return out;
}

const claimable = (p, pending, built, now) => p && p.id != null && CLAIM_POS.has(p.pos) && !pending.has(String(p.id)) && !NO_CLAIM.has(p.status) && !p.started && !(p.kickoff != null && p.kickoff <= now && !built.weekOver);
/**
 * $0 claims for the open bench spots. The pool is the chosen ranking (a Waivers → Available view): "all" = the earlier
 * order (top trending free agents first, then trade value), otherwise that view's list in its order (built.waiverCategories);
 * a view with no list right now falls back to "all". Always two more claims than there are empty bench spots.
 * `pendingAdds` = player ids already claimed (they fill spots too); `moved` = net bench players leaving the bench this run
 * (IR/taxi ins minus IR-outs). Pure.
 */
export function planClaims(built, { pendingAdds = [], moved = 0, now = Date.now(), ranking = "all" } = {}) {
  if (!claimsApply(built)) return [];
  const bench = (built.bench || []).filter(Boolean).length;
  const open = Math.max(0, (Number(built.benchSlots) || 0) - Math.max(0, bench - moved) - pendingAdds.length);
  if (!open) return [];
  const pending = new Set(pendingAdds.map(String));
  let pool = null;
  const list = ranking !== "all" ? built.waiverCategories?.lists?.[ranking] : null;
  if (Array.isArray(list) && list.length) {
    const cards = built.waiverCategories.cards || {};
    pool = list.map((e) => cards[e.id]).filter((p) => claimable(p, pending, built, now));
  }
  if (!pool || !pool.length) {
    pool = (built.freeAgents || []).filter((p) => claimable(p, pending, built, now));
    pool.sort((a, b) => Number(Boolean(b.trending)) - Number(Boolean(a.trending)) || (Number(b.trendCount) || 0) - (Number(a.trendCount) || 0) || byValue(a, b));
  }
  return pool.slice(0, Math.min(open + EXTRA_CLAIMS, MAX_CLAIMS)).map((p) => ({ addId: String(p.id), name: p.name, pos: p.pos, bid: 0 }));
}

/**
 * Auto lineup: the best starting lineup from the players already on the roster (starters + bench; IR, taxi and free agents
 * are never used), with started players pinned. → { starters: [ids in slot order], changes: [{slot, fromId, fromName, toId,
 * toName, delta}], gain } — changes is empty when nothing beats today's lineup by more than a rounding error. Pure.
 */
export function planLineup(built, now = Date.now()) {
  const rows = built.starters || [];
  const out = { starters: (built.starterIds || rows.map((r) => r.player?.id ?? "0")).map((x) => String(x ?? "0")), changes: [], gain: 0 };
  if (!eligibleLeague(built) || !rows.length) return out;
  const slots = rows.map((r) => r.slot);
  const pool = [...rows.map((r) => r.player), ...(built.bench || [])].filter((p) => p && p.id != null && !hasStarted(p, now));
  const locked = rows.map((r) => (r.player && hasStarted(r.player, now) ? r.player : null));
  const key = (p) => String(p?.id);
  const picks = solveLineup(slots, pool.map((p) => ({ ...p, origin: "roster" })), locked, { keyOf: key, currentKeyBySlot: rows.map((r) => (r.player ? key(r.player) : null)) });
  const projOf = (p) => Number(p?.proj) || 0;
  let before = 0;
  let after = 0;
  const next = [...out.starters];
  picks.forEach((pick, i) => {
    const cur = rows[i].player;
    before += projOf(cur);
    after += projOf(pick);
    if (!pick || locked[i] || key(pick) === (cur ? key(cur) : null)) return;
    next[i] = key(pick);
    out.changes.push({ slot: slots[i], fromId: cur ? key(cur) : null, fromName: cur?.name ?? null, toId: key(pick), toName: pick.name, delta: projOf(pick) - projOf(cur) });
  });
  out.gain = Math.max(0, after - before);
  if (out.gain <= 0.05) return { starters: out.starters, changes: [], gain: 0 };
  out.starters = next;
  return out;
}

/**
 * Auto flex: a flex-type starter whose game kicks off BEFORE a starter at his own position in a positional slot swaps with
 * the latest-kicking such starter, so the flex spot holds the later game. Nobody locked moves. `startersIds` = the lineup
 * to start from (after Auto lineup's changes). → { starters, swaps: [{slotA, slotB, ...names}] }. Pure.
 */
export function planFlex(built, now = Date.now(), startersIds = null) {
  const rows = built.starters || [];
  const ids = (startersIds || built.starterIds || rows.map((r) => r.player?.id ?? "0")).map((x) => String(x ?? "0"));
  const out = { starters: [...ids], swaps: [] };
  if (!eligibleLeague(built) || !rows.length) return out;
  const byId = new Map([...rows.map((r) => r.player), ...(built.bench || [])].filter((p) => p && p.id != null).map((p) => [String(p.id), p]));
  const at = (i) => byId.get(out.starters[i]) || null;
  const flex = rows
    .map((r, i) => ({ i, p: at(i), slot: r.slot }))
    .filter((x) => FLEX_ELIGIBLE[x.slot] && x.p && x.p.kickoff != null && !isLockedP(x.p, built, now))
    .sort((a, b) => a.p.kickoff - b.p.kickoff);
  const used = new Set();
  for (const { i, p: fp } of flex) {
    let best = -1;
    rows.forEach((r, j) => {
      const sp = at(j);
      if (j === i || used.has(j) || r.slot !== fp.pos || !sp || sp.kickoff == null || sp.kickoff <= fp.kickoff || isLockedP(sp, built, now)) return;
      if (best < 0 || sp.kickoff > at(best).kickoff) best = j;
    });
    if (best >= 0) {
      used.add(best);
      used.add(i);
      const sp = at(best);
      out.swaps.push({ slotA: i, slotB: best, slot: rows[i].slot, slotB_label: rows[best].slot, nameA: fp.name, nameB: sp.name });
      out.starters[i] = String(sp.id);
      out.starters[best] = String(fp.id);
    }
  }
  return out;
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
const GROUP_NAME = { roster: "Roster changes", claims: "Waiver claims" };

/** One guarded Sleeper write: skips when the same thing failed in the last day or the switch is off; logs and notifies. */
async function attempt(username, built, deps, now, { kind, list, group, run, describe }) {
  if (!list.length) return null;
  const ids = list.map((x) => x.id);
  const fk = failKey(username, built.id, kind, ids);
  const failedAt = store.getState(fk, null);
  if (failedAt && now - failedAt < DAY) return null; // the same move failed in the last day: don't hammer Sleeper
  const names = list.map((x) => x.name);
  const log = (ok, detail) => { for (const n of names) addLog(username, { leagueId: built.id, leagueName: built.name, kind, player: n, ok, detail: detail || "" }, now); };
  if (!perms(deps, username)[group]) {
    const sk = `${fk}:skip`;
    if (!store.getState(sk, null) || now - store.getState(sk) > DAY) {
      store.setState(sk, now);
      addLog(username, { leagueId: built.id, leagueName: built.name, kind, player: names.join(", "), ok: false, detail: `Skipped — "${GROUP_NAME[group]}" is switched off in Account → Sleeper access.` }, now);
    }
    return null;
  }
  try {
    const r = await run(ids);
    if (!r?.ok) store.setState(fk, now);
    log(Boolean(r?.ok), r?.detail || "");
    if (r?.ok) deps.notify?.(username, `${built.name}: auto mode`, describe(list));
    return r?.ok ? list : null;
  } catch (e) {
    store.setState(fk, now);
    log(false, e.message);
    return null;
  }
}

/** Auto IR (+ taxi): IR-outs first, then the IR-ins (after a short pause), then taxi. Returns what it moved. */
export async function runMoves(username, built, deps, now = Date.now()) {
  const done = [];
  if (!isPkgOn(username, built?.id, "ir") || !eligibleLeague(built)) return done;
  const plan = planMoves(built, now);
  const reserve0 = (built.reserveIds || []).map(String);
  const outIds = new Set(plan.irOut.map((x) => x.id));
  const afterOut = reserve0.filter((id) => !outIds.has(id));
  const upd = (reserve) => deps.priv.updateReserve(username, { leagueId: built.id, rosterId: built.myRosterId, reserve, confirm: true });
  const outDone = await attempt(username, built, deps, now, { kind: "ir-out", list: plan.irOut, group: "roster", run: () => upd(afterOut), describe: (l) => `${l.map((x) => x.name).join(", ")} → back to the bench.` });
  if (outDone) done.push(...outDone.map((x) => ({ kind: "ir-out", ...x })));
  if (outDone && plan.ir.length) await (deps.pause ? deps.pause(10000) : new Promise((r) => setTimeout(r, 10000)));
  const base = outDone ? afterOut : reserve0;
  const inDone = await attempt(username, built, deps, now, { kind: "ir", list: plan.ir, group: "roster", run: (ids) => upd([...new Set([...base, ...ids])]), describe: (l) => `${l.map((x) => x.name).join(", ")} → injured reserve.` });
  if (inDone) done.push(...inDone.map((x) => ({ kind: "ir", ...x })));
  const taxiDone = await attempt(username, built, deps, now, { kind: "taxi", list: plan.taxi, group: "roster", run: (ids) => deps.priv.updateTaxi(username, { leagueId: built.id, rosterId: built.myRosterId, taxi: [...new Set([...(built.taxiIds || []).map(String), ...ids])], confirm: true }), describe: (l) => `${l.map((x) => x.name).join(", ")} → taxi squad.` });
  if (taxiDone) done.push(...taxiDone.map((x) => ({ kind: "taxi", ...x })));
  return done;
}

/** $0 claims for the open bench spots (Auto roster; each run, idempotent: pending claims fill the spots). */
export async function runClaims(username, built, deps, { moved = 0, now = Date.now() } = {}) {
  const sent = [];
  if (!isPkgOn(username, built?.id, "roster") || !claimsApply(built)) return sent;
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
  const ranking = packagesFor(getSettings(username), built.id).ranking;
  for (const c of planClaims(built, { pendingAdds, moved, now, ranking })) {
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

const pushStarters = (username, built, deps, starters) => deps.priv.updateStarters(username, { leagueId: built.id, rosterId: built.myRosterId, round: Number(built.week), starters, confirm: true });

/** Auto lineup: bench ↔ lineup for the most projected points. Returns { changes, starters } (starters = the lineup now). */
export async function runLineup(username, built, deps, now = Date.now()) {
  const none = { changes: [], starters: null };
  if (!isPkgOn(username, built?.id, "lineup") || !eligibleLeague(built)) return none;
  const plan = planLineup(built, now);
  if (!plan.changes.length) return none;
  const list = plan.changes.map((c) => ({ id: `${c.slot}:${c.toId}`, name: `${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName}` }));
  const r = await attempt(username, built, deps, now, { kind: "lineup", list, group: "roster", run: () => pushStarters(username, built, deps, plan.starters), describe: (l) => `Lineup: ${l.map((x) => x.name).join("; ")}.` });
  return r ? { changes: plan.changes, starters: plan.starters } : none;
}

/** Auto flex: later games into the flex spots (starting from the lineup Auto lineup just set, if it changed anything). */
export async function runFlex(username, built, deps, { now = Date.now(), startersIds = null } = {}) {
  if (!isPkgOn(username, built?.id, "flex") || !eligibleLeague(built)) return [];
  const plan = planFlex(built, now, startersIds);
  if (!plan.swaps.length) return [];
  const list = plan.swaps.map((w) => ({ id: `${w.slotA}:${w.slotB}:${plan.starters[w.slotA]}`, name: `${w.slot} ↔ ${w.slotB_label}: ${w.nameB} to ${w.slot}, ${w.nameA} to ${w.slotB_label}` }));
  const r = await attempt(username, built, deps, now, { kind: "flex", list, group: "roster", run: () => pushStarters(username, built, deps, plan.starters), describe: (l) => `Flex: ${l.map((x) => x.name).join("; ")}.` });
  return r ? plan.swaps : [];
}

/** All four packages in their order: IR, Roster, Lineup, Flex. */
export async function runAll(username, built, deps, now = Date.now()) {
  const res = { moves: [], claims: [], lineup: [], flex: [] };
  if (!eligibleLeague(built) || !isOn(username, built?.id)) return res;
  res.moves = await runMoves(username, built, deps, now);
  const net = res.moves.filter((m) => m.kind === "ir" || m.kind === "taxi").length - res.moves.filter((m) => m.kind === "ir-out").length;
  res.claims = await runClaims(username, built, deps, { moved: net, now });
  const lu = await runLineup(username, built, deps, now);
  res.lineup = lu.changes;
  res.flex = await runFlex(username, built, deps, { now, startersIds: lu.starters });
  return res;
}

const fmtAt = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) + " Toronto";

/**
 * What Auto mode would do in this league right now, as text lines plus the claims it would place (a dry run — nothing is
 * sent). Uses the same planners as the real run. → { on, paused, packages, ranking, eligible, claimsApply, lines, moves,
 * claims, lineup, flex, claimsAt, counts }
 */
export function preview(username, built, { perms = {}, waiverAt = null, leadMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const s = getSettings(username);
  const pk = packagesFor(s, built?.id);
  const on = PACKAGES.some((k) => pk[k]);
  const eligible = eligibleLeague(built);
  const out = { on, paused: s.paused, packages: { ir: pk.ir, roster: pk.roster, lineup: pk.lineup, flex: pk.flex }, ranking: pk.ranking, eligible, claimsApply: claimsApply(built), lines: [], moves: { ir: [], irOut: [], taxi: [] }, claims: [], lineup: [], flex: [], claimsAt: null, counts: {} };
  if (!eligible) {
    out.lines.push("Auto mode isn't available for best ball leagues.");
    return out;
  }
  if (!on) out.lines.push("Auto mode is off for this league — this is what it would do if the packages were on.");
  else if (s.paused) out.lines.push("Auto mode is paused in every league — nothing will run until you un-pause it. This is what it would do.");
  const tag = (k) => (pk[k] ? "" : ` (${PACKAGE_LABEL[k]} is off)`);
  // 1. IR
  const plan = planMoves(built, now);
  out.moves = plan;
  const openIr = Math.max(0, (Number(built.irSlots) || 0) - (built.ir || []).filter(Boolean).length);
  const openTaxi = Math.max(0, (Number(built.taxiSlots) || 0) - (built.taxi || []).filter(Boolean).length);
  const bench = (built.bench || []).filter(Boolean).length;
  const pendingAdds = (built.privateInfo?.claims?.pending || []).flatMap((c) => c.adds || []);
  const openBench = Math.max(0, (Number(built.benchSlots) || 0) - bench - pendingAdds.length);
  out.counts = { openIr, openTaxi, openBench, pendingClaims: pendingAdds.length };
  for (const x of plan.irOut) out.lines.push(`IR: move ${x.name} out of injured reserve (no longer eligible).${tag("ir")}`);
  for (const x of plan.ir) out.lines.push(`IR: move ${x.name} from the bench to injured reserve.${tag("ir")}`);
  for (const x of plan.taxi) out.lines.push(`IR: move ${x.name} from the bench to the taxi squad.${tag("ir")}`);
  if (!plan.ir.length && !plan.irOut.length && !plan.taxi.length) {
    out.lines.push(openIr || openTaxi ? `IR: no moves — ${[openIr ? `${openIr} open IR spot${openIr === 1 ? "" : "s"}` : null, openTaxi ? `${openTaxi} open taxi spot${openTaxi === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ")}, but nobody on the bench is eligible.` : "IR: no moves — those spots are full (or the league has none).");
  } else if (!perms.roster) {
    out.lines.push('These IR moves would be skipped: "Roster changes" is switched off in Account → Sleeper access.');
  }
  // 2. Roster
  const moved = plan.ir.length + plan.taxi.length - plan.irOut.length;
  if (!out.claimsApply) {
    out.lines.push("Roster: no claims — this isn't a FAAB league (Auto mode never claims in waiver-priority leagues).");
  } else {
    const claims = planClaims(built, { pendingAdds, moved, now, ranking: pk.ranking });
    const byId = new Map([...(built.freeAgents || []), ...Object.values(built.waiverCategories?.cards || {})].map((p) => [String(p.id), p]));
    out.claims = claims.map((c) => {
      const p = byId.get(c.addId) || {};
      return { ...c, team: p.team || null, trendCount: p.trendCount ?? null, value: p.value ?? null };
    });
    if (claims.length) out.lines.push(`Roster: place ${claims.length} $0 claim${claims.length === 1 ? "" : "s"} with no drop (${claims.length - Math.min(EXTRA_CLAIMS, claims.length)} for the empty spots, plus ${Math.min(EXTRA_CLAIMS, claims.length)} spare), from the ${pk.ranking === "all" ? "default order (trending, then value)" : `"${pk.ranking}" list`}: ${claims.map((c) => c.name).join(", ")}.${tag("roster")}`);
    else out.lines.push(Math.max(0, (Number(built.benchSlots) || 0) - Math.max(0, bench - moved) - pendingAdds.length) ? "Roster: no claims — no free agent passes the filters (QB/RB/WR/TE, healthy, game not started)." : "Roster: no claims — no open bench spots" + (pendingAdds.length ? " (your pending claims already fill them)." : "."));
    if (claims.length && !perms.claims) out.lines.push('These claims would be skipped: "Waiver claims" is switched off in Account → Sleeper access.');
  }
  // 3. Lineup, 4. Flex
  const lu = planLineup(built, now);
  out.lineup = lu.changes;
  for (const c of lu.changes) out.lines.push(`Lineup: ${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName} (${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(1)} pts).${tag("lineup")}`);
  if (!lu.changes.length) out.lines.push("Lineup: no change — your starters are already the best projected lineup from your roster.");
  const fx = planFlex(built, now, lu.changes.length ? lu.starters : null);
  out.flex = fx.swaps;
  for (const w of fx.swaps) out.lines.push(`Flex: ${w.slot} ↔ ${w.slotB_label} — ${w.nameB} to ${w.slot}, ${w.nameA} to ${w.slotB_label} (later game in the flex).${tag("flex")}`);
  if (!fx.swaps.length) out.lines.push("Flex: no change — the flex spots already hold the latest games.");
  if (waiverAt) {
    out.claimsAt = waiverAt - leadMs;
    out.lines.push(`The packages run at 6 am Toronto time every day, an hour before kickoffs, and an hour before waivers process (${fmtAt(waiverAt)}, so around ${fmtAt(waiverAt - leadMs)}); the plan is worked out again each time.`);
  }
  return out;
}
