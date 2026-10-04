// v2.9 waiver planning maths — pure (no React, no network) so it can be
// unit-tested. The Waivers page lets you put a bid on any available player and
// rank the bench players you'd drop; this turns that into the list of claims to
// enter in Sleeper, in the order Sleeper should process them, and predicts what
// would actually happen to your FAAB budget.
//
// What is and isn't known about Sleeper's waiver processing (be honest):
//  - Claims for the same add player with different drops are accepted by
//    Sleeper (confirmed by the owner), the first one that works wins.
//  - We process claims highest bid first and, within equal bids, in the order
//    shown on the Claims page. That is how the owner described it working;
//    Sleeper's exact tie-break between equal bids from DIFFERENT teams, and
//    how it orders one team's claims, are not documented — so the "after"
//    budget is a prediction of YOUR claims only (we can't see other teams'
//    bids) and assumes you win every claim that's possible.

export const claimKey = (addId, dropId) => `${addId}|${dropId || "-"}`;

/**
 * Generated claims. Bid players are ranked by bid (highest first, ties keep
 * the order they were entered). `drops` is the bench ranking, most willing
 * first; only `willing` ones are used. `openSpots` = empty bench spots.
 *
 * The k-th player (1-based) needs a spare roster spot even if every earlier
 * claim succeeded, so it gets claims for: "no drop" first (only if there are
 * open spots — it works while one is still free), then the first
 * max(0, k - openSpots) willing drops in rank order. With no open spots that
 * is exactly: A/drop 1; B/drop 1, B/drop 2; C/drop 1, C/drop 2, C/drop 3.
 */
export function generateClaims({ bids = [], drops = [], openSpots = 0 }) {
  const willing = drops.filter((d) => d.willing);
  const sorted = bids.map((b, i) => ({ ...b, _i: i })).sort((a, b) => b.bid - a.bid || a._i - b._i);
  const claims = [];
  const warnings = [];
  sorted.forEach((b, i) => {
    const k = i + 1;
    if (openSpots > 0) claims.push({ key: claimKey(b.id), addId: b.id, addName: b.name, pos: b.pos, bid: b.bid, dropId: null, dropName: null, source: "plan", dropPriority: -1 });
    const need = Math.max(0, k - openSpots);
    const n = Math.min(willing.length, need);
    for (let j = 0; j < n; j++) {
      claims.push({ key: claimKey(b.id, willing[j].id), addId: b.id, addName: b.name, pos: b.pos, bid: b.bid, dropId: willing[j].id, dropName: willing[j].name, source: "plan", dropPriority: j });
    }
    if (need > willing.length) {
      warnings.push(`${b.name} (bid #${k}) needs ${need} willing drop(s) to be covered if every earlier claim wins, but only ${willing.length} ${willing.length === 1 ? "is" : "are"} marked willing.`);
    }
  });
  return { claims, warnings };
}

/** Generated claims with the user's edits, deletions and custom claims applied. */
export function effectiveClaims(plan, { openSpots = 0 } = {}) {
  const { claims: generated, warnings } = generateClaims({ bids: plan.bids || [], drops: plan.drops || [], openSpots });
  const removed = new Set(plan.removed || []);
  const edits = plan.edits || {};
  const list = generated
    .filter((c) => !removed.has(c.key))
    .map((c) => {
      const e = edits[c.key];
      if (!e) return c;
      const out = { ...c, edited: true };
      if (e.bid != null) out.bid = e.bid;
      if ("dropId" in e) {
        out.dropId = e.dropId;
        out.dropName = e.dropName;
      }
      return out;
    });
  for (const c of plan.custom || []) {
    list.push({ key: c.key, addId: c.addId, addName: c.addName, pos: c.pos, bid: c.bid, dropId: c.dropId, dropName: c.dropName, source: "custom", dropPriority: 1000 });
  }
  return { claims: list, warnings };
}

/**
 * Claims grouped by bid (highest first). Inside a group: the user's saved
 * order (`order`, from the drag handle) first; anything not in it — new
 * claims — goes to the bottom, ordered by the dropped player's priority.
 */
export function groupClaims(claims, order = []) {
  const idx = new Map(order.map((k, i) => [k, i]));
  const groups = new Map();
  claims.forEach((c, gi) => {
    if (!groups.has(c.bid)) groups.set(c.bid, []);
    groups.get(c.bid).push({ c, gi });
  });
  return [...groups.keys()]
    .sort((a, b) => b - a)
    .map((bid) => ({
      bid,
      claims: groups
        .get(bid)
        .sort((x, y) => {
          const ix = idx.has(x.c.key) ? idx.get(x.c.key) : Infinity;
          const iy = idx.has(y.c.key) ? idx.get(y.c.key) : Infinity;
          if (ix !== iy) return ix === Infinity ? 1 : iy === Infinity ? -1 : ix - iy;
          return x.c.dropPriority - y.c.dropPriority || x.gi - y.gi;
        })
        .map((x) => x.c),
    }));
}

/** The processing order: every group, highest bid first. */
export const flatten = (groups) => groups.flatMap((g) => g.claims);

/**
 * Move a claim within its own bid group (never across groups). Returns the new
 * saved `order` (a flat list of claim keys in display order).
 */
export function moveWithinGroup(groups, bid, fromIdx, toIdx) {
  const next = groups.map((g) => ({ ...g, claims: [...g.claims] }));
  const g = next.find((x) => x.bid === bid);
  if (!g || fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= g.claims.length || toIdx >= g.claims.length) return flatten(groups).map((c) => c.key);
  const [moved] = g.claims.splice(fromIdx, 1);
  g.claims.splice(toIdx, 0, moved);
  return flatten(next).map((c) => c.key);
}

/**
 * Predicts the outcome for YOUR claims in processing order.
 *  - a claim for a player you already won earlier is skipped;
 *  - a claim dropping a player an earlier winning claim already dropped fails;
 *  - a claim with no drop only works while an open roster spot remains;
 *  - a claim that would exceed the remaining FAAB fails.
 * Returns per-claim results plus the budget before/after (dollars and % of the
 * league's total budget).
 */
export function simulate(ordered, { budget = 0, used = 0, openSpots = 0 } = {}) {
  let remaining = Math.max(0, budget - used);
  let open = openSpots;
  let spent = 0;
  const dropped = new Set();
  const won = new Set();
  const results = ordered.map((c) => {
    if (won.has(c.addId)) return { key: c.key, ok: false, reason: "already won with an earlier claim" };
    if (c.dropId && dropped.has(c.dropId)) return { key: c.key, ok: false, reason: "that player is already dropped by an earlier claim" };
    if (!c.dropId && open <= 0) return { key: c.key, ok: false, reason: "no open roster spot left" };
    if (c.bid > remaining) return { key: c.key, ok: false, reason: "not enough FAAB left" };
    if (c.dropId) dropped.add(c.dropId);
    else open -= 1;
    won.add(c.addId);
    remaining -= c.bid;
    spent += c.bid;
    return { key: c.key, ok: true, reason: null };
  });
  const pct = (x) => (budget > 0 ? Math.round((x / budget) * 1000) / 10 : null);
  const current = Math.max(0, budget - used);
  return { results, spent, wins: won.size, current, currentPct: pct(current), after: remaining, afterPct: pct(remaining) };
}

/* ---------------- bid entry (dollars or % of budget) ---------------- */
/** What was typed -> whole dollars (null when empty / not a number). */
export function toDollars(text, mode, budget) {
  const t = String(text ?? "").trim().replace(/[$%\s]/g, "");
  if (t === "" || !/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return mode === "percent" ? Math.round((n / 100) * budget) : Math.round(n);
}
/** Dollars -> what to show in the box for the current mode. */
export function fromDollars(dollars, mode, budget) {
  if (dollars == null) return "";
  if (mode === "percent") return budget > 0 ? String(Math.round((dollars / budget) * 1000) / 10) : "";
  return String(dollars);
}

/** Add / change / remove (empty text) one bid; a bid of 0 is a real bid. Keeps entry order. */
export function setBid(bids, player, dollars) {
  const rest = bids.filter((b) => b.id !== player.id);
  if (dollars == null) return rest;
  const existing = bids.find((b) => b.id === player.id);
  const entry = { id: player.id, name: player.name, pos: player.pos, bid: dollars };
  return existing ? bids.map((b) => (b.id === player.id ? entry : b)) : [...rest, entry];
}

/**
 * Keeps the saved drop ranking in step with the current bench: existing
 * players keep their rank and willing flag, new bench players go to the
 * bottom (not willing), players who have left the bench disappear.
 */
export function syncDrops(saved = [], bench = []) {
  const byId = new Map(bench.filter(Boolean).map((p) => [String(p.id), p]));
  const kept = saved.filter((d) => byId.has(String(d.id))).map((d) => ({ ...d, name: byId.get(String(d.id)).name, pos: byId.get(String(d.id)).pos }));
  const have = new Set(kept.map((d) => String(d.id)));
  const added = [...byId.values()].filter((p) => !have.has(String(p.id))).map((p) => ({ id: String(p.id), name: p.name, pos: p.pos, willing: false }));
  return [...kept, ...added];
}

/** One line per claim, for the "claims to enter" checklist. */
export function describeClaim(c) {
  return `Bid $${c.bid} for ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`;
}

/** Empties every manual change to the generated claims (bids and drop ranking stay). */
export function resetClaims(plan) {
  return { ...plan, edits: {}, removed: [], custom: [], order: [] };
}
