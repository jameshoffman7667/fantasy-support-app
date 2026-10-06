// v3.0 — the merged Roster page's proposed changes; v3.6 — its "Current lineup" / "Proposed lineup" tabs.
// Pure (no React, no network) so it can be unit-tested.
//
// A proposed change is one recommended edit to the roster Sleeper holds:
//   lineup  put player X in starting slot i (replacing Y)         → roster_update_starters (+ matchup leg)
//   swap    v3.6: flex timing — swap a flex starter with a starter at his own position whose game is later,
//           so the flex holds the later game                     → roster_update_starters
//   ir      move bench player X to an open injured-reserve slot   → roster_update_reserve (unverified)
// Changes that can't be pushed (the better player is a free agent, or sits on
// IR/taxi and needs a roster move first) are listed as `blocked` with the reason
// and can't be ticked.

import { isLocked, FLEX_ELIGIBLE } from "./lineup.js";

export function proposeChanges(league) {
  const out = [];
  const rows = league?.lineup?.rows || [];
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
  const lineup = picked.filter((c) => c.type === "lineup");
  const swaps = picked.filter((c) => c.type === "swap");
  if (lineup.length || swaps.length) {
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
    const real = starters.filter((x) => x && x !== "0");
    if (new Set(real).size !== real.length) errors.push("These changes would start the same player twice — tick the matching swap too.");
  }
  const ir = picked.filter((c) => c.type === "ir");
  if (ir.length) {
    reserve = [...new Set([...(league.reserveIds || []).map(String), ...ir.map((c) => c.id)])];
    for (const c of ir) summary.push(`Move ${c.name} to injured reserve`);
  }
  return { starters, reserve, summary, errors };
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
    const p = byId.get(String(id)) || { id: String(id), name: fallbackName || "Player", pos: "?", team: "" };
    starters[i] = { ...starters[i], player: p, was: orig[i], changed: String(orig[i]?.id ?? "") !== String(p.id), swapFrom };
  };
  for (const c of picked) {
    if (c.type === "lineup") put(c.slotIndex, c.toId, c.toName);
    else if (c.type === "swap") {
      put(c.slotA, c.idB, c.nameB, c.slotB_label);
      put(c.slotB, c.idA, c.nameA, c.slot);
    }
  }
  const startingIds = new Set(starters.map((s) => s.player?.id).filter((x) => x != null).map(String));
  const toIr = new Set(picked.filter((c) => c.type === "ir").map((c) => String(c.id)));
  const bench = [];
  for (const p of league?.bench || []) if (p && !startingIds.has(String(p.id)) && !toIr.has(String(p.id))) bench.push({ player: p, change: null });
  for (const p of orig) if (p && !startingIds.has(String(p.id)) && !toIr.has(String(p.id))) bench.push({ player: p, change: "benched" });
  const ir = [...(league?.ir || []).filter(Boolean).map((p) => ({ player: p, change: null })), ...[...toIr].map((id) => ({ player: byId.get(id) || { id, name: "Player" }, change: "to IR" }))];
  const taxi = (league?.taxi || []).filter(Boolean).map((p) => ({ player: p }));
  const pts = (list) => Math.round(list.reduce((s, p) => s + (Number(p?.proj) || 0), 0) * 10) / 10;
  const current = pts(orig);
  const proposed = pts(starters.map((s) => s.player));
  return { starters, bench, ir, taxi, totals: { current, proposed, delta: Math.round((proposed - current) * 10) / 10 }, count: picked.length };
}
