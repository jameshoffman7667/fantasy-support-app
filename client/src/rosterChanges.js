// v3.0 — the merged Roster page's "Proposed changes" and "Update roster" tabs.
// Pure (no React, no network) so it can be unit-tested.
//
// A proposed change is one recommended edit to the roster Sleeper holds:
//   lineup  put player X in starting slot i (replacing Y)         → roster_update_starters (+ matchup leg)
//   ir      move bench player X to an open injured-reserve slot   → roster_update_reserve (unverified)
// Changes that can't be pushed (the better player is a free agent, or sits on
// IR/taxi and needs a roster move first) are listed as `blocked` with the reason
// and can't be ticked.

import { isLocked } from "./lineup.js";

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
  if (lineup.length) {
    starters = (league.starterIds || []).map(String);
    for (const c of lineup) {
      if (c.slotIndex >= starters.length) {
        errors.push(`Slot ${c.slot} isn't in the roster Sleeper returned — rebuild and try again.`);
        continue;
      }
      starters[c.slotIndex] = c.toId;
      summary.push(`${c.slot}: ${c.fromName ?? "(empty)"} → ${c.toName}${c.delta ? ` (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} pts)` : ""}`);
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
