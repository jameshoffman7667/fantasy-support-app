// v4.5 — the best possible starting lineup, worked out from ZERO: every eligible player is considered for every
// slot at once (an assignment problem, solved exactly with the Hungarian method), so a player can move between
// slots when that scores more — e.g. the QB in a SUPERFLEX goes to the QB slot when the QB-slot player is out,
// and the best bench player takes the SUPERFLEX. The current slots only break ties (fewest moves), never the choice.
// Identical copies live in client/src/ and server/ (separate Docker contexts) — a test keeps them in step.

export const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"],
  SFLX: ["QB", "RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
};
export const slotAccepts = (slot, pos) => (FLEX_ELIGIBLE[slot] ? FLEX_ELIGIBLE[slot].includes(pos) : pos === slot);

const BIG = 1e6;
// tie-break bonuses, far below one projected point so they never change who is best
const STAY_SLOT = 0.0004;
const ON_ROSTER = 0.0003;
const STARTING_NOW = 0.0002;

/** Hungarian method (min cost), n rows <= m columns. Returns for each row the column it is assigned. */
function hungarian(cost, n, m) {
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/**
 * @param slots           slot labels, in lineup order
 * @param candidates      [{ pos, proj, ... }] anyone who could start (the caller drops players whose game has started)
 * @param lockedByIndex   per slot: the pinned player (already played / game started) or null; he stays and leaves the pool
 * @param opts.keyOf      identity of a candidate (default key, then name)
 * @param opts.currentKeyBySlot  per slot: key of the player in it today (tie-break: fewest moves)
 * @param opts.onRoster   (candidate) => true for players already on the roster (a tie never prefers an add)
 * @returns one entry per slot — the candidate, the locked player, or null (nobody eligible)
 */
export function solveLineup(slots, candidates, lockedByIndex = [], opts = {}) {
  const keyOf = opts.keyOf || ((c) => c.key ?? c.name);
  const currentKeyBySlot = opts.currentKeyBySlot || [];
  const onRoster = opts.onRoster || ((c) => c.origin !== "waiver");
  const results = new Array(slots.length).fill(null);
  const lockedKeys = new Set();
  slots.forEach((_, i) => {
    if (lockedByIndex[i]) { results[i] = lockedByIndex[i]; lockedKeys.add(keyOf(lockedByIndex[i])); }
  });
  const free = slots.map((s, i) => i).filter((i) => !results[i]);
  if (!free.length) return results;
  const startingNow = new Set(currentKeyBySlot.filter((k) => k != null));
  let pool = (candidates || []).filter((c) => c && !lockedKeys.has(keyOf(c)));
  // a position can fill at most `free.length` slots: keep only its best that many (keeps the matrix small)
  const byPos = new Map();
  for (const c of pool) { if (!byPos.has(c.pos)) byPos.set(c.pos, []); byPos.get(c.pos).push(c); }
  pool = [];
  for (const list of byPos.values()) {
    list.sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));
    pool.push(...list.slice(0, free.length + 1));
  }
  const n = free.length;
  const m = pool.length + n; // one "nobody" column per slot so a slot nobody fits stays empty
  const cost = free.map((si) => {
    const row = new Array(m).fill(0);
    pool.forEach((c, j) => {
      if (!slotAccepts(slots[si], c.pos)) { row[j] = BIG; return; }
      const k = keyOf(c);
      const value = 0.01 + (Number(c.proj) || 0) + (onRoster(c) ? ON_ROSTER : 0) + (startingNow.has(k) ? STARTING_NOW : 0) + (currentKeyBySlot[si] != null && currentKeyBySlot[si] === k ? STAY_SLOT : 0);
      row[j] = -value;
    });
    return row; // the "nobody" columns cost 0
  });
  const assign = hungarian(cost, n, m);
  free.forEach((si, r) => {
    const j = assign[r];
    if (j >= 0 && j < pool.length && cost[r][j] < BIG / 2) results[si] = pool[j];
  });
  return results;
}
