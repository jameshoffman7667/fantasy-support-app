// v4.11 — the Roster page's lineup moves, planned as a sequence.
// Pure (no React, no network).
//
// How it works (all decisions from James, 2026-10-22):
//  1. Best lineup from the players already on the roster (starters + bench; Hungarian solver). That is the lineup the
//     default ticks reach with no drop.
//  2. The players coming in are paired with the players going out, BIGGEST POINT GAIN FIRST (in − out), preferring a
//     pair where the incoming player fits the outgoing player's slot. A pair that doesn't fit gets a slot-swap sub move
//     first (both players stay in the lineup, 0 pts), then the replacement itself.
//  3. Every move's `delta` is its effect on the WHOLE starting lineup's projected total (in − out), never a slot change.
//     Swapping two starters is 0.
//  4. Each move lists what it `requires` (earlier moves whose result it builds on); ticking a move ticks them, unticking
//     one unticks whatever requires it. `parent` is the last requirement, for the indented ↳ layout.
//  5. Free-agent / waiver improvements are offered on top: an `add` that REPLACES the no-drop move filling that slot
//     (`conflicts` = that move) and only when the add scores more. They start unticked.
//  6. `rejected` = pairs (`inId>outId`) he unticked: the plan is re-run without them, so the next best move appears.

import { isLocked } from "./lineup.js";
import { solveLineup, slotAccepts } from "./lineupSolve.js";

const idOf = (p) => (p && p.id != null ? String(p.id) : null);
const proj = (p) => Number(p?.proj) || 0;
const r1 = (x) => Math.round(x * 10) / 10;

export function planLineupMoves(league, { rejected = new Set() } = {}) {
  const sl = league?.starters || [];
  const slots = sl.map((s) => s.slot);
  if (!slots.length) return [];
  const cur = sl.map((s) => s.player || null);
  const lockedAt = cur.map((p) => (p && isLocked(p, league) ? p : null));
  const seen = new Set();
  const pool = [];
  for (const p of [...cur, ...(league.bench || [])]) {
    if (!p || p.id == null || seen.has(idOf(p)) || isLocked(p, league)) continue;
    seen.add(idOf(p));
    pool.push(p);
  }
  const T0 = solveLineup(slots, pool, lockedAt, { keyOf: idOf, currentKeyBySlot: cur.map(idOf) });
  const target = new Set(T0.filter(Boolean).map(idOf));
  const curIds = new Set(cur.filter(Boolean).map(idOf));
  const ins = T0.filter((p, i) => p && !lockedAt[i] && !curIds.has(idOf(p)));
  const outs = [];
  cur.forEach((p, i) => {
    if (lockedAt[i]) return;
    if (!p) { if (T0[i]) outs.push({ p: null, slot0: i }); return; }
    if (!target.has(idOf(p))) outs.push({ p, slot0: i });
  });

  const state = cur.slice();
  const moves = [];
  const lastTouch = {};
  const info = new Map(); // key -> { fromP, toP } for the add layer
  const emit = (m, touched) => {
    const req = [...new Set(touched.map((s) => lastTouch[s]).filter(Boolean))];
    const order = (k) => moves.findIndex((x) => x.key === k);
    req.sort((a, b) => order(a) - order(b));
    m.requires = req;
    m.parent = req.length ? req[req.length - 1] : undefined;
    const par = m.parent ? moves.find((x) => x.key === m.parent) : null;
    m.depth = par ? (par.depth || 0) + 1 : 0;
    moves.push(m);
    touched.forEach((s) => { lastTouch[s] = m.key; });
  };
  const slotOf = (o) => (o.p ? state.findIndex((x) => idOf(x) === idOf(o.p)) : o.slot0);
  const replace = (si, inP, outP, pair) => {
    const m = {
      key: `M:${si}:${idOf(outP) ?? "0"}>${idOf(inP)}`,
      type: "lineup",
      slotIndex: si,
      slot: slots[si],
      fromId: idOf(outP),
      fromName: outP?.name ?? null,
      toId: idOf(inP),
      toName: inP.name,
      delta: r1(proj(inP) - proj(outP)),
      pair,
      blocked: null,
    };
    info.set(m.key, { fromP: outP, toP: inP });
    emit(m, [si]);
    state[si] = inP;
    return m;
  };
  const shuffle = (a, b, pair) => {
    const P = state[a];
    const Q = state[b];
    const m = {
      key: `W:${a}:${b}:${idOf(P)}:${idOf(Q)}`,
      type: "swap",
      why: "slots",
      slotA: a,
      slotB: b,
      slot: slots[a],
      slotB_label: slots[b],
      idA: idOf(P),
      nameA: P.name,
      kickA: null,
      idB: idOf(Q),
      nameB: Q.name,
      kickB: null,
      delta: 0,
      pair,
      blocked: null,
    };
    emit(m, [a, b]);
    state[a] = Q;
    state[b] = P;
    return m;
  };

  for (let guard = 0; guard < 24 && ins.length && outs.length; guard += 1) {
    let best = null;
    for (const i of ins) {
      for (const o of outs) {
        const pk = `${idOf(i)}>${idOf(o.p) ?? "0"}`;
        if (rejected.has(pk)) continue;
        const si = slotOf(o);
        if (si < 0) continue;
        const eligible = slotAccepts(slots[si], i.pos);
        if (!o.p && !eligible) continue; // an empty slot is only filled directly
        const diff = proj(i) - proj(o.p);
        if (!best || (eligible ? 1 : 0) > (best.eligible ? 1 : 0) || ((eligible ? 1 : 0) === (best.eligible ? 1 : 0) && diff > best.diff)) best = { i, o, si, eligible, diff, pk };
      }
    }
    if (!best) break;
    const { i, o, si, eligible, pk } = best;
    ins.splice(ins.indexOf(i), 1);
    outs.splice(outs.indexOf(o), 1);
    if (eligible) { replace(si, i, o.p, pk); continue; }
    // the incoming player doesn't fit the outgoing player's slot: swap two starters first, so the outgoing player sits in a slot he does fit
    let j = -1;
    for (let k = 0; k < slots.length; k += 1) {
      if (k === si || lockedAt[k] || !state[k] || !slotAccepts(slots[k], i.pos)) continue;
      if (slotAccepts(slots[si], state[k].pos) && slotAccepts(slots[k], o.p.pos)) { j = k; break; }
    }
    if (j >= 0) { shuffle(si, j, pk); replace(j, i, o.p, pk); continue; }
    // otherwise a two-step: he takes the place of a starter who can drop into the outgoing player's slot
    let z = -1;
    for (let k = 0; k < slots.length; k += 1) {
      if (k === si || lockedAt[k] || !state[k] || !slotAccepts(slots[k], i.pos) || !slotAccepts(slots[si], state[k].pos)) continue;
      z = k; break;
    }
    if (z >= 0) { const Z = state[z]; replace(z, i, Z, pk); replace(si, Z, o.p, pk); }
  }

  // free agent / waiver improvements on top of the no-drop lineup
  const rows = league?.lineup?.rows || [];
  const out = [...moves];
  rows.forEach((r, s) => {
    if (!r || r.locked || lockedAt[s] || !r.optimal || r.optimal.origin !== "waiver") return;
    const X = r.optimal;
    const Xid = X.id != null ? String(X.id) : null;
    const Z = state[s];
    const sib = lastTouch[s] ? moves.find((m) => m.key === lastTouch[s]) : null;
    let from = Z;
    let requires = sib ? [sib.key] : [];
    const conflicts = [];
    if (sib && sib.type === "lineup" && sib.slotIndex === s) {
      from = info.get(sib.key)?.fromP ?? null;
      requires = sib.requires || [];
      conflicts.push(sib.key);
    }
    if (Z && proj(X) <= proj(Z)) return; // only when he scores more than what the no-drop lineup already has there
    if (from && proj(X) <= proj(from)) return;
    const delta = r1(proj(X) - proj(from));
    const par = requires.length ? requires[requires.length - 1] : undefined;
    const parM = par ? moves.find((m) => m.key === par) : null;
    const c = {
      key: `A:${s}:${idOf(from) ?? "0"}>${Xid}`,
      type: "add",
      toPlayer: X,
      slotIndex: s,
      slot: slots[s],
      fromId: idOf(from),
      fromName: from?.name ?? null,
      toId: Xid,
      toName: X.name,
      delta,
      requires,
      conflicts,
      parent: par,
      depth: parM ? (parM.depth || 0) + 1 : 0,
      blocked: Xid ? null : "No player id for this suggestion.",
    };
    const at = sib ? out.findIndex((m) => m.key === sib.key) : -1;
    if (at >= 0) out.splice(at + 1, 0, c); else out.push(c);
  });
  return out;
}

/** Two lineup-type moves that put in the same player, or take out the same player, can't both be ticked. */
export function addCrossConflicts(list) {
  const lin = list.filter((c) => c.type === "lineup" || c.type === "add");
  for (const a of lin) {
    for (const b of lin) {
      if (a === b) continue;
      if (a.toId === b.toId || (a.fromId != null && a.fromId === b.fromId)) {
        a.conflicts = [...new Set([...(a.conflicts || []), b.key])];
      }
    }
  }
  return list;
}
