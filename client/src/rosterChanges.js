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
// Changes that can't be pushed (the better player is a free agent, or sits on
// IR/taxi and needs a roster move first) are listed as `blocked` with the reason
// and can't be ticked.

import { isLocked, FLEX_ELIGIBLE, slotEligible } from "./lineup.js";

export function proposeChanges(league) {
  const out = [];
  const rows = league?.lineup?.rows || [];
  const usedAlt = new Set();
  rows.forEach((r, i) => {
    if (!r.changed || r.locked) return;
    const toId = r.optimal?.id != null ? String(r.optimal.id) : null;
    const fromId = r.current?.id != null ? String(r.current.id) : null;
    if (!r.optimal) return; // nothing better to put there
    const c = {
      key: `L:${i}:${toId}`,
      type: "lineup",
      slotIndex: i,
      slot: r.slot,
      fromId,
      fromName: r.current?.name ?? null,
      toId,
      toName: r.optimal.name,
      delta: r.delta ?? 0,
      blocked: null,
    };
    if (r.optimal.origin === "waiver") c.blocked = `${r.optimal.name} is a free agent — add him on Waivers first.`;
    else if (r.optimal.group === "ir" || r.optimal.group === "taxi") c.blocked = `${r.optimal.name} is on your ${r.optimal.group === "ir" ? "IR" : "taxi squad"} — needs a roster move before he can start.`;
    else if (!toId) c.blocked = "No player id for this suggestion.";
    out.push(c);
    // v4.4: when the better player is a free agent, always offer the best bench player who still beats the current one
    if (r.optimal.origin === "waiver") {
      const alt = benchAlternative(league, r, i, usedAlt, out);
      if (alt) {
        usedAlt.add(alt.toId);
        out.push({ ...alt, key: `L:${i}:${alt.toId}`, type: "lineup", slotIndex: i, slot: r.slot, fromId, fromName: r.current?.name ?? null, alt: true, altNote: `Bench option — ${r.optimal.name} has to be added from Waivers first`, blocked: null });
      }
    }
  });
  // v3.6: flex-timing swaps, only between slots no lineup change touches. A flex starter whose game kicks off
  // BEFORE a starter at his own position in a positional slot: swap them, so the flex keeps the later game
  // (more options if someone is ruled out late). Neither player may be locked. The latest such game is chosen.
  const touched = new Set(out.filter((c) => !c.blocked).map((c) => c.slotIndex)); // a blocked suggestion can't be pushed anyway
  const starters = league?.starters || [];
  starters.forEach(({ slot, player: fp }, i) => {
    if (!FLEX_ELIGIBLE[slot] || !fp || fp.kickoff == null || touched.has(i) || isLocked(fp, league) || fp.id == null) return;
    let best = -1;
    starters.forEach((s, j) => {
      const sp = s.player;
      if (j === i || touched.has(j) || s.slot !== fp.pos || !sp || sp.kickoff == null || sp.id == null) return;
      if (sp.kickoff <= fp.kickoff || isLocked(sp, league)) return;
      if (best < 0 || sp.kickoff > starters[best].player.kickoff) best = j;
    });
    if (best < 0) return;
    const sp = starters[best].player;
    touched.add(i);
    touched.add(best);
    out.push({
      key: `S:${i}:${best}`,
      type: "swap",
      slotA: i,
      slotB: best,
      slot,
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
  });
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
  return out;
}

/**
 * v4.4: the best bench player for a lineup slot whose suggested player is a free agent — eligible for the slot, not
 * locked, projected for MORE points than the player in the slot, and not already used by another suggestion.
 */
function benchAlternative(league, row, i, usedAlt, out) {
  const cur = Number(row.current?.proj) || 0;
  const taken = new Set(out.filter((c) => !c.blocked && c.toId).map((c) => c.toId));
  const pick = (league?.bench || [])
    .filter((p) => p && p.id != null && p.proj != null && Number(p.proj) > cur && slotEligible(row.slot, p.pos) && !isLocked(p, league) && !taken.has(String(p.id)) && !usedAlt.has(String(p.id)))
    .sort((a, b) => Number(b.proj) - Number(a.proj))[0];
  if (!pick) return null;
  return { toId: String(pick.id), toName: pick.name, delta: Number(pick.proj) - cur };
}

/** change A needs change B when A puts a player into a slot he is still starting in elsewhere (B moves him out). */
function needs(changes, a) {
  if (a.type !== "lineup" || !a.toId) return [];
  return changes.filter((b) => b.type === "lineup" && b !== a && b.fromId === a.toId);
}

/** Ticking a change also ticks what it needs; unticking one also unticks whatever needed it. */
export function toggle(changes, checked, key, on) {
  const next = new Set(checked);
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const target = byKey.get(key);
  if (!target || target.blocked) return next;
  if (on) {
    // v4.4: two suggestions for the same slot (the waiver add and its bench option) are alternatives — ticking one unticks the other
    if (target.type === "lineup") for (const o of changes) if (o !== target && o.type === "lineup" && o.slotIndex === target.slotIndex) next.delete(o.key);
    const stack = [target];
    while (stack.length) {
      const c = stack.pop();
      if (c.blocked) continue;
      if (next.has(c.key)) continue;
      next.add(c.key);
      stack.push(...needs(changes, c));
    }
  } else {
    const stack = [target];
    while (stack.length) {
      const c = stack.pop();
      if (!next.delete(c.key)) continue;
      for (const o of changes) if (next.has(o.key) && needs(changes, o).includes(c)) stack.push(o);
    }
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
    for (const c of lineup) {
      if (c.slotIndex >= starters.length) {
        errors.push(`Slot ${c.slot} isn't in the roster Sleeper returned — rebuild and try again.`);
        continue;
      }
      starters[c.slotIndex] = c.toId;
      summary.push(`${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName}${c.delta ? ` (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} pts)` : ""}`);
    }
    for (const c of swaps) {
      if (Math.max(c.slotA, c.slotB) >= starters.length || starters[c.slotA] !== c.idA || starters[c.slotB] !== c.idB) {
        errors.push(`The ${c.slot} / ${c.slotB_label} swap no longer matches your roster — rebuild and try again.`);
        continue;
      }
      starters[c.slotA] = c.idB;
      starters[c.slotB] = c.idA;
      summary.push(`${c.slot} ↔ ${c.slotB_label}: ${c.nameB} to ${c.slot} (${c.kickB || "later game"}), ${c.nameA} to ${c.slotB_label} (${c.kickA || "earlier game"})`);
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
  return { starters, reserve, taxi, summary, errors };
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
    else if (c.type === "swap") {
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
