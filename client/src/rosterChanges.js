// v3.0 — the merged Roster page's proposed changes; v3.6 — its "Current lineup" / "Proposed lineup" tabs.
// Pure (no React, no network) so it can be unit-tested.
//
// A proposed change is one recommended edit to the roster Sleeper holds:
//   lineup  put player X in starting slot i (replacing Y)         → roster_update_starters (+ matchup leg)
//   swap    v3.6: flex timing — swap a flex starter with a starter at his own position whose game is later,
//           so the flex holds the later game                     → roster_update_starters
//   ir      move bench player X to an open injured-reserve slot   → roster_update_reserve (unverified)
//   custom  v4.4: a hand-made swap on the Proposed lineup — put player X in starting slot i; when X already starts in
//           slot j he and slot i's player trade places (otherSlot)  → roster_update_starters
//   taxi    v4.4: move a taxi-squad player to the bench              → roster_update_taxi (unverified)
//   add     v4.4.1: the better player is a free agent / on waivers — add him (claim, with a drop and a FAAB bid chosen in
//           a pop-up: `plan`), then the server makes the lineup move once he is on the roster
// Changes that can't be pushed (the better player sits on IR/taxi and needs a
// roster move first) are listed as `blocked` with the reason and can't be ticked.

import { isLocked, flexTimingPairs, slotEligible } from "./lineup.js";
import { planLineupMoves, addCrossConflicts } from "./movePlanner.js";

/**
 * v4.11: the lineup moves come from movePlanner.js (a sequence, points = whole-roster impact, sub moves, no-drop first).
 * `rejected` = pairs he unticked; the plan is re-run without them and the new moves are added next to the old ones
 * (the unticked ones stay in the list so he can tick them again).
 */
export function proposeChanges(league, { rejected = null } = {}) {
  const base = buildPlan(league, new Set());
  if (!rejected || !rejected.size) return addCrossConflicts(base);
  const alt = buildPlan(league, rejected);
  const have = new Set(base.map((c) => c.key));
  return addCrossConflicts([...base, ...alt.filter((c) => !have.has(c.key))]);
}

function buildPlan(league, rejected) {
  const out = planLineupMoves(league, { rejected });
  const rows = league?.lineup?.rows || [];
  // a better player sitting on IR / taxi can't be started until a roster move is made — listed, but not tickable
  rows.forEach((r, i) => {
    if (!r || !r.changed || r.locked || !r.optimal) return;
    if (r.optimal.group !== "ir" && r.optimal.group !== "taxi") return;
    const toId = r.optimal.id != null ? String(r.optimal.id) : null;
    out.push({
      key: `L:${i}:${toId}`,
      type: "lineup",
      slotIndex: i,
      slot: r.slot,
      fromId: r.current?.id != null ? String(r.current.id) : null,
      fromName: r.current?.name ?? null,
      toId,
      toName: r.optimal.name,
      delta: r.delta ?? 0,
      blocked: `${r.optimal.name} is on your ${r.optimal.group === "ir" ? "IR" : "taxi squad"} — needs a roster move before he can start.`,
    });
  });
  // v3.6: flex-timing swaps, only between slots no lineup change touches. A flex starter whose game kicks off
  // BEFORE a starter at his own position in a positional slot: swap them, so the flex keeps the later game
  // (more options if someone is ruled out late). Neither player may be locked. The latest such game is chosen.
  const touched = new Set(out.filter((c) => !c.blocked).flatMap((c) => touchedSlots(c))); // a blocked suggestion can't be pushed anyway
  const starters = league?.starters || [];
  // v4.5.1: pairs come from lineup.flexTimingPairs (all flex slots at once — the same pairs the "Flex lock order" variance flags)
  for (const { flexIdx: i, posIdx: best } of flexTimingPairs(league, touched)) {
    const fp = starters[i].player;
    const sp = starters[best].player;
    if (fp.id == null || sp.id == null) continue;
    touched.add(i);
    touched.add(best);
    out.push({
      key: `S:${i}:${best}`,
      type: "swap",
      slotA: i,
      slotB: best,
      slot: starters[i].slot,
      slotB_label: starters[best].slot,
      idA: String(fp.id),
      nameA: fp.name,
      kickA: fp.kickoffLabel || null,
      idB: String(sp.id),
      nameB: sp.name,
      kickB: sp.kickoffLabel || null,
      delta: 0,
      blocked: null,
    });
  }
  // IR moves: only as many as there are open IR slots.
  const open = Number.isFinite(league?.irSlots) ? league.irSlots - (league.ir || []).length : 0;
  if (open > 0) {
    let n = 0;
    for (const p of league.bench || []) {
      if (p && p.irEligible && n < open && !isLocked(p, league)) { // v3.4: a locked player can't be moved
        n += 1;
        out.push({ key: `R:${p.id}`, type: "ir", id: String(p.id), name: p.name, blocked: null });
      }
    }
  }
  // v4.8: proposals are worked through in the same order as Auto mode: IR, Roster (adds), Lineup, Flex (swaps).
  // IR / taxi moves first, then the lineup moves in the order they are worked through, flex-timing swaps last
  const rank = (c) => (c.type === "ir" || c.type === "taxi" ? 0 : c.type === "swap" && !c.why ? 2 : 1);
  return out.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}
export const CHANGE_ORDER = { ir: 0, taxi: 0, add: 1, lineup: 2, custom: 2, swap: 3 };

/**
 * v4.11: ticking a move also ticks every move it `requires` (earlier moves its result builds on) and unticks the moves it
 * `conflicts` with (an add replaces the no-drop move for the same slot; two moves can't bring in / take out the same
 * player). Unticking a move also unticks every move that requires it.
 */
export function toggle(changes, checked, key, on) {
  const next = new Set(checked);
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const target = byKey.get(key);
  if (!target || target.blocked) return next;
  const untick = (k) => {
    const stack = [k];
    while (stack.length) {
      const x = stack.pop();
      if (!next.delete(x)) continue;
      for (const o of changes) if (next.has(o.key) && (o.requires || []).includes(x)) stack.push(o.key);
    }
  };
  if (on) {
    const stack = [target];
    while (stack.length) {
      const c = stack.pop();
      if (c.blocked || next.has(c.key)) continue;
      for (const k of c.conflicts || []) untick(k);
      for (const o of changes) if ((o.conflicts || []).includes(c.key)) untick(o.key);
      next.add(c.key);
      for (const k of c.requires || []) { const r = byKey.get(k); if (r) stack.push(r); }
    }
  } else {
    untick(key);
  }
  return next;
}

/**
 * What to send for the ticked changes. `starters` (full slot-order array, "0" =
 * empty) and/or `reserve` (full injured-reserve array), plus plain-English
 * summary lines and any problem that stops the push.
 */
export function buildPush(league, changes, checked) {
  const picked = changes.filter((c) => checked.has(c.key) && !c.blocked);
  const summary = [];
  const errors = [];
  let starters = null;
  let reserve = null;
  let taxi = null;
  const lineup = picked.filter((c) => c.type === "lineup");
  const swaps = picked.filter((c) => c.type === "swap");
  const customs = picked.filter((c) => c.type === "custom");
  if (lineup.length || swaps.length || customs.length) {
    starters = (league.starterIds || []).map(String);
    // v4.11: in the order of the list — a later move builds on the roster the earlier ones leave
    for (const c of picked.filter((x) => x.type === "lineup" || x.type === "swap")) {
      if (c.type === "lineup") {
        if (c.slotIndex >= starters.length) {
          errors.push(`Slot ${c.slot} isn't in the roster Sleeper returned — rebuild and try again.`);
          continue;
        }
        starters[c.slotIndex] = c.toId;
        summary.push(`${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName}${c.delta ? ` (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} pts)` : ""}`);
        continue;
      }
      if (Math.max(c.slotA, c.slotB) >= starters.length || starters[c.slotA] !== c.idA || starters[c.slotB] !== c.idB) {
        errors.push(`The ${c.slot} / ${c.slotB_label} swap no longer matches your roster — rebuild and try again.`);
        continue;
      }
      starters[c.slotA] = c.idB;
      starters[c.slotB] = c.idA;
      summary.push(c.why === "slots" ? `${c.slot} ↔ ${c.slotB_label}: ${c.nameB} to ${c.slot}, ${c.nameA} to ${c.slotB_label} (both stay in the lineup)` : `${c.slot} ↔ ${c.slotB_label}: ${c.nameB} to ${c.slot} (${c.kickB || "later game"}), ${c.nameA} to ${c.slotB_label} (${c.kickA || "earlier game"})`);
    }
    // v4.4: hand-made swaps, applied on top of the ticked suggestions in the order they were made
    for (const c of customs) {
      const at = (i) => String(starters[i] ?? "0");
      if (c.slotIndex >= starters.length || at(c.slotIndex) !== c.fromId || (c.otherSlot != null && (c.otherSlot >= starters.length || at(c.otherSlot) !== c.toId))) {
        errors.push(`The custom change at ${c.slot} no longer matches your roster — undo the custom changes or rebuild and try again.`);
        continue;
      }
      starters[c.slotIndex] = c.toId;
      if (c.otherSlot != null) starters[c.otherSlot] = c.fromId;
      summary.push(c.otherSlot != null ? `${c.slot} ↔ ${c.otherSlotLabel}: ${c.toName} to ${c.slot}, ${c.fromName ?? "(empty)"} to ${c.otherSlotLabel} (custom)` : `${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName} (custom${c.delta ? `, ${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} pts` : ""})`);
    }
    const real = starters.filter((x) => x && x !== "0");
    if (new Set(real).size !== real.length) errors.push("These changes would start the same player twice — tick the matching swap too.");
  }
  // v4.4.1: free agent / waiver adds — the claim is sent now, the lineup move follows when he is on the roster
  const adds = [];
  for (const c of picked.filter((x) => x.type === "add")) {
    if (!c.plan) { errors.push(`Choose how to add ${c.toName} — untick and tick the suggestion again.`); continue; }
    const pl = c.plan;
    adds.push({ key: c.key, addId: c.toId, addName: c.toName, dropId: pl.dropId || null, dropName: pl.dropName || null, bid: pl.kind === "waiver" ? Number(pl.bid) || 0 : 0, kind: pl.kind, change: { slotIndex: c.slotIndex, slot: c.slot, fromId: c.fromId, fromName: c.fromName } });
    summary.push(`Add ${c.toName} (${pl.kind === "waiver" ? `waiver claim${pl.bid != null && pl.isFaab ? ` · $${Number(pl.bid) || 0}` : ""}` : "free agent"})${pl.dropName ? `, drop ${pl.dropName}` : ""} — then ${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName} once he is on your roster${c.delta ? ` (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} pts)` : ""}`);
  }
  const ir = picked.filter((c) => c.type === "ir");
  if (ir.length) {
    reserve = [...new Set([...(league.reserveIds || []).map(String), ...ir.map((c) => c.id)])];
    for (const c of ir) summary.push(`Move ${c.name} to injured reserve`);
    const startingNow = new Set((starters || league.starterIds || []).map(String));
    for (const c of ir) if (startingNow.has(c.id)) errors.push(`${c.name} is moving to injured reserve but is also in a starting slot — untick one of them.`);
  }
  const toBench = picked.filter((c) => c.type === "taxi");
  if (toBench.length) {
    const gone = new Set(toBench.map((c) => c.id));
    taxi = (league.taxi || []).filter(Boolean).map((p) => String(p.id)).filter((id) => !gone.has(id));
    for (const c of toBench) summary.push(`Move ${c.name} from the taxi squad to the bench`);
  }
  return { starters, reserve, taxi, adds, summary, errors };
}

/**
 * v3.6: the lineup after the accepted changes, for the "Proposed lineup" tab.
 * Returns { starters: [{ slot, player, was, changed }], bench: [{ player, change }], ir: [{ player, change }],
 *           taxi: [{ player }], totals: { current, proposed, delta }, count }.
 * `change` is "benched" (was starting), "to IR" (moved there) or null.
 */
export function arrangement(league, changes = [], checked = new Set()) {
  const picked = changes.filter((c) => checked.has(c.key) && !c.blocked);
  const byId = new Map();
  const add = (p) => p && p.id != null && !byId.has(String(p.id)) && byId.set(String(p.id), p);
  (league?.starters || []).forEach((s) => add(s.player));
  (league?.bench || []).forEach(add);
  (league?.ir || []).forEach(add);
  (league?.taxi || []).forEach(add);
  const orig = (league?.starters || []).map((s) => s.player || null);
  const starters = (league?.starters || []).map((s) => ({ slot: s.slot, player: s.player || null, was: null, changed: false, swapFrom: null }));
  const put = (i, id, fallbackName, swapFrom = null) => {
    if (i == null || i >= starters.length) return;
    const p = id == null || String(id) === "0" ? null : byId.get(String(id)) || { id: String(id), name: fallbackName || "Player", pos: "?", team: "" };
    starters[i] = { ...starters[i], player: p, was: orig[i], changed: String(orig[i]?.id ?? "") !== String(p?.id ?? ""), swapFrom };
  };
  for (const c of picked) {
    if (c.type === "lineup") put(c.slotIndex, c.toId, c.toName);
    else if (c.type === "add") {
      if (c.toPlayer) byId.set(String(c.toId), c.toPlayer);
      put(c.slotIndex, c.toId, c.toName);
      starters[c.slotIndex] = { ...starters[c.slotIndex], adding: true };
    } else if (c.type === "swap") {
      put(c.slotA, c.idB, c.nameB, c.slotB_label);
      put(c.slotB, c.idA, c.nameA, c.slot);
    } else if (c.type === "custom") {
      put(c.slotIndex, c.toId, c.toName, c.otherSlot != null ? c.otherSlotLabel : null);
      if (c.otherSlot != null) put(c.otherSlot, c.fromId, c.fromName, c.slot);
      starters[c.slotIndex] = { ...starters[c.slotIndex], custom: true };
      if (c.otherSlot != null) starters[c.otherSlot] = { ...starters[c.otherSlot], custom: true };
    }
  }
  const startingIds = new Set(starters.map((s) => s.player?.id).filter((x) => x != null).map(String));
  const toIr = new Set(picked.filter((c) => c.type === "ir").map((c) => String(c.id)));
  const bench = [];
  for (const p of league?.bench || []) if (p && !startingIds.has(String(p.id)) && !toIr.has(String(p.id))) bench.push({ player: p, change: null });
  for (const p of orig) if (p && !startingIds.has(String(p.id)) && !toIr.has(String(p.id))) bench.push({ player: p, change: "benched" });
  const ir = [...(league?.ir || []).filter(Boolean).map((p) => ({ player: p, change: null })), ...[...toIr].map((id) => ({ player: byId.get(id) || { id, name: "Player" }, change: "to IR" }))];
  const toBench = new Set(picked.filter((c) => c.type === "taxi").map((c) => String(c.id)));
  const taxi = (league?.taxi || []).filter(Boolean).filter((p) => !toBench.has(String(p.id))).map((p) => ({ player: p }));
  for (const p of league?.taxi || []) if (p && toBench.has(String(p.id))) bench.push({ player: p, change: "from taxi" });
  const pts = (list) => Math.round(list.reduce((s, p) => s + (Number(p?.proj) || 0), 0) * 10) / 10;
  const current = pts(orig);
  const proposed = pts(starters.map((s) => s.player));
  return { starters, bench, ir, taxi, totals: { current, proposed, delta: Math.round((proposed - current) * 10) / 10 }, count: picked.length };
}

/**
 * v4.4: who can trade places with a position on the Proposed lineup, from anywhere on the roster, best projection
 * first. `target` = { kind: "starter", index } | { kind: "bench", id } | { kind: "taxi", id }, read against the
 * proposed arrangement `arr`. Returns { title, locked, options: [{ player, group, otherSlot, enabled, reason }] }.
 * Rules: a locked player can't move (and isn't listed); a taxi player can only be moved to the bench (never into a starting slot);
 * an IR player needs a roster move first; a starter can only swap with a starter who fits his slot both ways.
 */
export function swapOptions(league, arr, target) {
  const byProj = (a, b) => (b.player.proj ?? -1) - (a.player.proj ?? -1) || String(a.player.name).localeCompare(String(b.player.name));
  const lockedP = (p) => isLocked(p, league);
  if (target.kind === "taxi") {
    const p = (arr.taxi || []).map((t) => t.player).find((x) => String(x.id) === String(target.id));
    return { title: p?.name || "Taxi player", locked: false, options: p ? [{ player: p, group: "taxi", toBench: true, enabled: true }] : [] };
  }
  const options = [];
  if (target.kind === "starter") {
    const me = arr.starters[target.index];
    const P = me?.player || null;
    if (P && lockedP(P)) return { title: `${me.slot}: ${P.name}`, locked: true, options: [] };
    arr.starters.forEach((s, j) => {
      const Q = s.player;
      if (j === target.index || !Q) return;
      if (lockedP(Q)) return; // a locked player can't move: left out of the list
      const fitsHere = slotEligible(me.slot, Q.pos);
      const fitsThere = !P || slotEligible(s.slot, P.pos);
      if (!fitsHere) return;
      options.push({ player: Q, group: "starter", otherSlot: j, enabled: fitsThere, reason: fitsThere ? null : `${P.name} can't play ${s.slot}` });
    });
    for (const b of arr.bench || []) {
      const Q = b.player;
      if (!Q || !slotEligible(me.slot, Q.pos)) continue;
      if (!lockedP(Q)) options.push({ player: Q, group: "bench", enabled: true });
    }
    for (const b of arr.ir || []) if (b.player && slotEligible(me.slot, b.player.pos)) options.push({ player: b.player, group: "ir", enabled: false, reason: "On injured reserve — needs a roster move first" });
    for (const b of arr.taxi || []) if (b.player && slotEligible(me.slot, b.player.pos)) options.push({ player: b.player, group: "taxi", enabled: false, reason: "Taxi players can only be moved to the bench" });
    return { title: `${me.slot}${P ? `: ${P.name}` : " (empty)"}`, locked: false, options: [...options.filter((o) => o.enabled).sort(byProj), ...options.filter((o) => !o.enabled).sort(byProj)] };
  }
  // a bench player: the starters he could replace
  const B = (arr.bench || []).map((b) => b.player).find((x) => String(x.id) === String(target.id));
  if (!B) return { title: "Bench player", locked: false, options: [] };
  if (lockedP(B)) return { title: B.name, locked: true, options: [] };
  arr.starters.forEach((s, j) => {
    if (!slotEligible(s.slot, B.pos)) return;
    const P = s.player;
    if (P && lockedP(P)) return;
    options.push({ player: P || { id: null, name: "(empty slot)", pos: s.slot, proj: null }, group: "starter", slotIndex: j, slotLabel: s.slot, enabled: true });
  });
  return { title: B.name, locked: false, forBench: true, options: [...options.filter((o) => o.enabled).sort(byProj), ...options.filter((o) => !o.enabled).sort(byProj)] };
}

/** v4.4: the custom change for a picked option (null when it isn't allowed), read against the proposed arrangement. */
export function customChange(arr, target, opt) {
  if (!opt?.enabled) return null;
  if (opt.toBench) return { key: `T:${opt.player.id}`, type: "taxi", id: String(opt.player.id), name: opt.player.name, blocked: null };
  let slotIndex;
  let toP;
  let otherSlot = null;
  if (target.kind === "starter") {
    slotIndex = target.index;
    toP = opt.player;
    if (opt.otherSlot != null) otherSlot = opt.otherSlot;
  } else {
    slotIndex = opt.slotIndex;
    toP = (arr.bench || []).map((b) => b.player).find((x) => String(x.id) === String(target.id));
  }
  const here = arr.starters[slotIndex];
  if (!toP || !here) return null;
  const from = here.player;
  return {
    key: `C:${slotIndex}:${toP.id}:${otherSlot ?? "b"}`,
    type: "custom",
    slotIndex,
    slot: here.slot,
    otherSlot,
    otherSlotLabel: otherSlot != null ? arr.starters[otherSlot].slot : null,
    fromId: from?.id != null ? String(from.id) : "0",
    fromName: from?.name ?? null,
    toId: String(toP.id),
    toName: toP.name,
    delta: otherSlot != null ? 0 : (Number(toP.proj) || 0) - (Number(from?.proj) || 0),
    blocked: null,
  };
}

/* ---------------- v4.4.1: free agent / waiver adds ---------------- */

/** Empty bench spots left after the other adds already planned (an add whose drop is chosen takes none). */
export function openSpotsForAdd(league, plans = {}, exceptKey = null) {
  const slots = Number(league?.benchSlots);
  if (!Number.isFinite(slots)) return null; // unknown roster size: the pop-up offers a drop but doesn't insist
  const used = Object.entries(plans).filter(([k, p]) => k !== exceptKey && p && !p.dropId).length;
  const empty = (league?.starters || []).some((s) => !s.player) ? 1 : 0; // an empty starting slot is also room
  return slots - (league?.bench || []).filter(Boolean).length - used + empty;
}

/** Players who can be dropped for an add: bench, IR and taxi players (not locked), plus the starter being replaced. Weakest first. */
export function dropOptions(league, change, plans = {}, exceptKey = null) {
  const taken = new Set(Object.entries(plans).filter(([k, p]) => k !== exceptKey && p?.dropId).map(([, p]) => String(p.dropId)));
  const out = [];
  const add = (p, where) => {
    if (!p || p.id == null || taken.has(String(p.id))) return;
    out.push({ id: String(p.id), name: p.name, pos: p.pos, team: p.team, proj: p.proj ?? null, where, locked: isLocked(p, league) });
  };
  (league?.bench || []).forEach((p) => add(p, "Bench"));
  (league?.ir || []).forEach((p) => add(p, "IR"));
  (league?.taxi || []).forEach((p) => add(p, "Taxi"));
  const st = (league?.starters || [])[change?.slotIndex]?.player;
  if (st) add(st, `Starting at ${change.slot} (being replaced)`);
  return out.filter((o) => !o.locked).sort((a, b) => (Number(a.proj) || 0) - (Number(b.proj) || 0));
}

/* ---------------- v4.5: a note for every player involved in a suggested move ---------------- */

const pts = (d) => (d > 0 ? ` (+${d.toFixed(1)} pts)` : "");

/**
 * playerId -> [note text] for every roster player touched by a suggested change: the player coming out, the bench
 * player or starter moving in (or to another slot), the starter a free agent / waiver player would replace, the two
 * players in a timing swap, and a player moving to IR. Free agents have no roster card, so they get none.
 */
export function changeNotes(league, changes = []) {
  const out = new Map();
  const put = (id, text) => {
    if (id == null || !text) return;
    const k = String(id);
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).includes(text)) out.get(k).push(text);
  };
  const starting = new Map();
  (league?.starters || []).forEach((s) => s.player?.id != null && starting.set(String(s.player.id), s.slot));
  const lineupTo = new Map(); // player id -> the slot a suggestion moves him to
  for (const c of changes) if (c.type === "lineup" && !c.blocked && c.toId) lineupTo.set(String(c.toId), c.slot);
  for (const c of changes) {
    if (c.type === "lineup") {
      const was = starting.get(String(c.toId));
      const alt = c.alt ? " — bench option, no add needed" : "";
      put(c.toId, was ? `Suggested: move from ${was} to ${c.slot}${c.fromName ? `, in for ${c.fromName}` : ""}${pts(c.delta)}` : `Suggested: start at ${c.slot}${c.fromName ? `, in for ${c.fromName}` : ""}${pts(c.delta)}${alt}`);
      if (c.fromId && c.fromId !== "0") put(c.fromId, lineupTo.has(String(c.fromId)) ? null : `Suggested: replaced at ${c.slot} by ${c.toName}${pts(c.delta)}`);
    } else if (c.type === "add") {
      const fromProj = Number((league?.starters || [])[c.slotIndex]?.player?.proj);
      const toProj = Number(c.toPlayer?.proj);
      const beats = fromProj > 0 && toProj > fromProj;
      if (c.fromId && c.fromId !== "0") put(c.fromId, beats ? `${c.toName} (free agent / waivers) is projected ${toProj.toFixed(1)} vs ${fromProj.toFixed(1)} — suggested add for ${c.slot}${pts(c.delta)}` : `Suggested: replaced at ${c.slot} by ${c.toName} (free agent / waivers)${pts(c.delta)}`);
    } else if (c.type === "swap" && c.why === "slots") {
      put(c.idA, `Suggested: swap with ${c.nameB} — move to ${c.slotB_label} (both stay in the lineup)`);
      put(c.idB, `Suggested: swap with ${c.nameA} — move to ${c.slot} (both stay in the lineup)`);
    } else if (c.type === "swap") {
      put(c.idA, `Suggested: swap with ${c.nameB} — move to ${c.slotB_label}; he plays earlier${c.kickA ? ` (${c.kickA})` : ""}, so the ${c.slot} slot keeps the later game`);
      put(c.idB, `Suggested: swap with ${c.nameA} — move to ${c.slot}${c.kickB ? `; his game is later (${c.kickB})` : ""}`);
    } else if (c.type === "ir") {
      put(c.id, "Suggested: move to injured reserve");
    }
  }
  return out;
}

/* ---------------- v4.9: layered (dependent) suggestions ---------------- */

const MAX_LAYERS = 4;

/** The starting-slot indexes a change uses. */
export function touchedSlots(c) {
  if (c.type === "swap") return [c.slotA, c.slotB];
  if (c.type === "lineup" || c.type === "add" || c.type === "custom") return [c.slotIndex, ...(c.otherSlot != null ? [c.otherSlot] : [])];
  return [];
}

/**
 * v4.9: the league as it would stand after the ticked changes — starters, bench, IR and taxi taken from arrangement().
 * `remaining` = starting slots an UNticked lineup / add suggestion still wants (they keep counting as "changing" when
 * the roster rules are re-run on the result). Pure; used for the Proposed lineup's variance notes.
 */
export function leagueAfter(league, arr, remaining = new Set()) {
  const starters = (league?.starters || []).map((s, i) => ({ ...s, slot: arr.starters[i].slot, player: arr.starters[i].player, adding: Boolean(arr.starters[i].adding) }));
  return {
    ...league,
    starters,
    bench: arr.bench.map((b) => b.player),
    ir: arr.ir.map((b) => b.player),
    taxi: arr.taxi.map((b) => b.player),
    lineup: { ...(league?.lineup || {}), rows: starters.map((_, i) => ({ changed: remaining.has(i), locked: false })) },
  };
}

/** New suggestions that only exist because of ticked ones: the flex-timing rule re-run on the roster after them. */
function dependents(league, all, ticked) {
  const arr = arrangement(league, all, ticked);
  const lg = leagueAfter(league, arr);
  const skip = new Set();
  for (const c of all) if (!c.blocked && !ticked.has(c.key) && c.type !== "custom") touchedSlots(c).forEach((s) => skip.add(s)); // an unticked suggestion still uses those slots
  arr.starters.forEach((s, i) => s.adding && skip.add(i)); // an add isn't on the roster yet — nothing can be swapped with him now
  const out = [];
  for (const { flexIdx: i, posIdx: j } of flexTimingPairs(lg, skip)) {
    const fp = lg.starters[i].player;
    const sp = lg.starters[j].player;
    if (fp?.id == null || sp?.id == null) continue;
    const parent = [...all].reverse().find((c) => ticked.has(c.key) && !c.blocked && c.type !== "custom" && touchedSlots(c).some((s) => s === i || s === j));
    if (!parent) continue; // no ticked move behind it: it would be a plain (layer 0) suggestion, and isn't one
    out.push({
      key: `D:${parent.key}>S:${i}:${j}:${fp.id}:${sp.id}`,
      type: "swap",
      slotA: i,
      slotB: j,
      slot: lg.starters[i].slot,
      slotB_label: lg.starters[j].slot,
      idA: String(fp.id),
      nameA: fp.name,
      kickA: fp.kickoffLabel || null,
      idB: String(sp.id),
      nameB: sp.name,
      kickB: sp.kickoffLabel || null,
      delta: 0,
      blocked: null,
      parent: parent.key,
      depth: (parent.depth || 0) + 1,
    });
  }
  return out;
}

/**
 * v4.9: the suggestion list "multiple layers deep". Starts from the layer-0 suggestions (`base`) and the ticked keys;
 * the roster after the ticked moves is re-checked, and any new problem (today: the flex-timing rule) becomes a
 * dependent suggestion hung under the ticked move that caused it (`parent`, `depth`), then again for those, up to
 * MAX_LAYERS. A dependent exists only while its parent is ticked. `tickChildren` ticks every dependent found (used for
 * the default). Returns { changes, checked } — `checked` has anything stale (a dependent whose parent was unticked) removed.
 */
export function layerChanges(league, base, checked, { tickChildren = false } = {}) {
  const all = [...base];
  const keys = new Set(all.map((c) => c.key));
  const ticked = new Set(checked);
  for (let d = 0; d < MAX_LAYERS; d += 1) {
    const kids = dependents(league, all, ticked).filter((k) => !keys.has(k.key));
    if (!kids.length) break;
    for (const k of kids) {
      all.push(k);
      keys.add(k.key);
      if (tickChildren) ticked.add(k.key);
    }
  }
  const valid = new Set(all.filter((c) => !c.blocked).map((c) => c.key));
  return { changes: all, checked: closeTicks(all, new Set([...ticked].filter((k) => valid.has(k)))) };
}

/** v4.11: the ticks that stand when a ticked set is missing a move's requirement (or a conflicting pair is both ticked). */
function closeTicks(changes, set) {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  let again = true;
  while (again) {
    again = false;
    for (const c of changes) if (set.has(c.key) && (c.requires || []).some((k) => byKey.has(k) && !set.has(k))) { set.delete(c.key); again = true; }
  }
  return set;
}

/**
 * v4.11: what is ticked until he changes anything — every move that needs no free agent / waiver add (the best lineup
 * reachable with no drop), plus the sub moves it needs. Adds start unticked.
 */
export function defaultChecked(changes) {
  return closeTicks(changes, new Set(changes.filter((c) => !c.blocked && c.type !== "add").map((c) => c.key)));
}

/** Accept all: everything usable; an add replaces the no-drop move it conflicts with. */
export function acceptAllKeys(changes) {
  const set = new Set(changes.filter((c) => !c.blocked).map((c) => c.key));
  for (const c of changes) if (c.type === "add" && set.has(c.key)) for (const k of c.conflicts || []) set.delete(k);
  return closeTicks(changes, set);
}

/** Slots an unticked lineup / add suggestion still uses (passed to the roster rules as "changing"). */
export function remainingSlots(changes, checked) {
  const s = new Set();
  for (const c of changes) if (!c.blocked && !checked.has(c.key) && (c.type === "lineup" || c.type === "add")) touchedSlots(c).forEach((i) => s.add(i));
  return s;
}

/** v4.10: does this suggested move involve one of these players (by id)? Used to drop moves that clash with roster-validity moves. */
export function changeTouchesPlayers(c, ids) {
  if (!ids || !ids.size) return false;
  return [c.fromId, c.toId, c.id, c.idA, c.idB].some((x) => x != null && ids.has(String(x)));
}
