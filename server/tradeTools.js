/**
 * v3.5 — pure helpers for team strength and trade ideas (no network; unit-tested).
 *
 * Team strength at a position = the sum of the `valueOf` numbers of that roster's best k players there, where k
 * is how many lineup spots the position can fill (its own slots plus every flex slot it is eligible for). Higher
 * is better. Teams are then ranked 1..N at each position. `valueOf` is:
 *   dynasty leagues          → Roster Audit dynasty values
 *   redraft / keeper leagues → rest-of-season projected points
 */
export const TRADE_POSITIONS = ["QB", "RB", "WR", "TE"];
const FLEX_SLOTS = {
  FLEX: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SFLX: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
};

/** How many players at each position count toward strength, from the league's roster_positions. */
export function depthByPosition(rosterPositions = []) {
  const k = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const slot of rosterPositions) {
    if (k[slot] != null) k[slot] += 1;
    for (const pos of FLEX_SLOTS[slot] || []) k[pos] += 1;
  }
  for (const pos of TRADE_POSITIONS) if (k[pos] === 0) k[pos] = 1;
  return k;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * rosters: [{ rosterId, players: [ids] }], posOf(id) → 'QB'|..., valueOf(id) → number|null.
 * Returns Map(rosterId → { [pos]: { score, rank, of, players } }).
 */
export function positionStrength({ rosters, posOf, valueOf, depth }) {
  const scores = new Map();
  for (const r of rosters) {
    const byPos = {};
    for (const id of r.players || []) {
      const pos = posOf(id);
      if (!TRADE_POSITIONS.includes(pos)) continue;
      const v = valueOf(id);
      if (v == null) continue;
      (byPos[pos] ||= []).push(v);
    }
    const row = {};
    for (const pos of TRADE_POSITIONS) {
      const list = (byPos[pos] || []).sort((a, b) => b - a).slice(0, depth[pos] || 1);
      row[pos] = { score: Math.round(list.reduce((a, b) => a + b, 0) * 10) / 10, players: list.length };
    }
    scores.set(r.rosterId, row);
  }
  const n = rosters.length;
  for (const pos of TRADE_POSITIONS) {
    const ranked = [...scores.entries()].sort((a, b) => b[1][pos].score - a[1][pos].score);
    ranked.forEach(([, row], i) => {
      row[pos].rank = i + 1;
      row[pos].of = n;
    });
  }
  return scores;
}

/** Strong = top third of the league at a position, weak = bottom third (at most two each, best/worst first). */
export function strengthsAndWeaknesses(row, n) {
  const third = Math.max(1, Math.ceil(n / 3));
  const entries = TRADE_POSITIONS.map((pos) => ({ pos, ...row[pos] })).filter((e) => e.rank != null);
  const strengths = entries.filter((e) => e.rank <= third).sort((a, b) => a.rank - b.rank).slice(0, 2);
  const weaknesses = entries.filter((e) => e.rank > n - third).sort((a, b) => b.rank - a.rank).slice(0, 2);
  const label = (e) => ({ pos: e.pos, rank: e.rank, of: n, label: `${ordinal(e.rank)} of ${n}` });
  return { strengths: strengths.map(label), weaknesses: weaknesses.map(label) };
}

/**
 * Mutual trade ideas against one rival: a position where you're weak and they're strong, paired with a position
 * where you're strong and they're weak. severity 'major' (a big gap, shown yellow) when they rank at least half
 * the league above you at your weak position.
 */
export function radarIdeas(me, them, n) {
  const ideas = [];
  const myWeak = me.weaknesses.map((w) => w.pos);
  const myStrong = me.strengths.map((s) => s.pos);
  const theirStrong = them.strengths.map((s) => s.pos);
  const theirWeak = them.weaknesses.map((w) => w.pos);
  for (const w of myWeak) {
    if (!theirStrong.includes(w)) continue;
    const give = myStrong.find((s) => theirWeak.includes(s));
    if (!give) continue;
    const myRank = me.row[w].rank;
    const theirRank = them.row[w].rank;
    const gap = myRank - theirRank;
    if (gap <= 0) continue;
    ideas.push({
      severity: gap >= n / 2 ? "major" : "minor",
      give: `A ${give}`,
      get: `A ${w}`,
      note: `You're ${ordinal(myRank)} of ${n} at ${w}; they're ${ordinal(theirRank)}. You're ${ordinal(me.row[give].rank)} at ${give}, where they're ${ordinal(them.row[give].rank)} — a swap that helps both sides.`,
    });
  }
  return ideas.slice(0, 2);
}

/**
 * Projected draft slot for each roster's own future picks: the weakest third of the league (by total value)
 * pick early, the middle third mid, the strongest third late.
 */
export function pickSlots(strength) {
  const totals = [...strength.entries()].map(([rid, row]) => [rid, TRADE_POSITIONS.reduce((s, p) => s + (row[p]?.score || 0), 0)]);
  totals.sort((a, b) => a[1] - b[1]); // weakest first
  const n = totals.length;
  const out = {};
  totals.forEach(([rid], i) => {
    out[rid] = i < n / 3 ? "early" : i < (2 * n) / 3 ? "mid" : "late";
  });
  return out;
}

/** True when two trade values are within `tolerance` (fraction of the larger) of each other. */
export function closeInValue(a, b, tolerance = 0.1) {
  if (a == null || b == null) return false;
  const top = Math.max(Math.abs(a), Math.abs(b));
  if (top === 0) return true;
  return Math.abs(a - b) <= tolerance * top;
}
