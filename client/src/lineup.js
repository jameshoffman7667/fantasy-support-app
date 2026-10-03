// Pure lineup/ranking logic for the Lineup tab and its Player Rankings view
// (v2.1). Deliberately free of React so it can be unit-tested on its own.
//
// Vocabulary:
//  - entry:  { key, player, group } — one ranked player. `group` is where the
//            player sits on the roster today: starter | bench | ir | taxi | fa
//            (fa = free agent, not on the user's roster).
//  - order:  entries in priority order, best first. The user's drag-ordered
//            ranking, or the default (highest projection first).
//  - lineup: the starting slots filled from an order — strict positions first,
//            then flex slots, each slot taking the first eligible player left in
//            the order. So rank order IS priority: dragging a player up makes
//            them win ties for the slots they're eligible for.

// Slot labels as the server sends them (SUPER_FLEX is relabelled "SFLX").
export const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"],
  SFLX: ["QB", "RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
};

export const GROUP_LABEL = { starter: "Starter", bench: "Bench", ir: "IR", taxi: "Taxi", fa: "Free agent" };

// Below this many points a "better lineup" isn't worth flagging — it's rounding noise.
const BETTER_EPSILON = 0.05;

/**
 * v2.6: a player whose game has kicked off can't be swapped in or out any
 * more — starters stay locked in their slot and everyone else (bench, IR,
 * taxi, free agents) drops out of every recommendation.
 */
export function hasStarted(player, now = Date.now()) {
  return Boolean(player && (player.played || player.started || (player.kickoff != null && player.kickoff <= now)));
}

export function playerKey(player) {
  return `${player.name}|${player.pos}`;
}

function isEligible(slot, pos) {
  return FLEX_ELIGIBLE[slot] ? FLEX_ELIGIBLE[slot].includes(pos) : pos === slot;
}

/** A projection of exactly 0 (not missing, and not a finished game's actual score) — the "red" case. */
export function isZeroProjection(player) {
  return player != null && player.proj === 0 && player.projSource !== "actual";
}

function projValue(player) {
  return player.proj ?? -1; // missing projections sort last
}

/** Every player on the user's roster, tagged with where they sit today. */
export function rosterEntries(league) {
  const entries = [];
  const add = (player, group, slot) => {
    if (!player) return;
    entries.push({ key: playerKey(player), player, group, slot: slot ?? null });
  };
  (league.starters || []).forEach((s) => add(s.player, "starter", s.slot));
  (league.bench || []).forEach((p) => add(p, "bench"));
  (league.ir || []).forEach((p) => add(p, "ir"));
  (league.taxi || []).forEach((p) => add(p, "taxi"));
  return entries;
}

export function freeAgentEntries(league) {
  return (league.freeAgents || []).map((p) => ({ key: playerKey(p), player: p, group: "fa", slot: null }));
}

/** Highest projection first; missing projections last; ties by name so the order is stable. */
export function defaultOrder(entries) {
  return [...entries].sort((a, b) => projValue(b.player) - projValue(a.player) || a.player.name.localeCompare(b.player.name));
}

/**
 * Applies the user's saved order to the current entries. Players no longer on
 * the roster drop out; players that arrived since the order was saved (a
 * waiver add, a trade) slot in by projection rather than piling up at the
 * bottom or top.
 */
export function applySavedOrder(entries, savedKeys) {
  const sorted = defaultOrder(entries);
  if (!Array.isArray(savedKeys) || savedKeys.length === 0) return sorted;

  const byKey = new Map(entries.map((e) => [e.key, e]));
  const result = [];
  const seen = new Set();
  for (const key of savedKeys) {
    const entry = byKey.get(key);
    if (entry && !seen.has(key)) {
      result.push(entry);
      seen.add(key);
    }
  }
  for (const entry of sorted) {
    if (seen.has(entry.key)) continue;
    const at = result.findIndex((e) => projValue(e.player) < projValue(entry.player));
    result.splice(at < 0 ? result.length : at, 0, entry);
  }
  return result;
}

/**
 * Fills the starting slots from an ordered list. `lockedByIndex[i]` (a
 * played-already starter) pins that slot to its real result and takes the
 * player out of the pool, same as the server's optimizer.
 */
export function fillSlots(slots, ordered, lockedByIndex = []) {
  const results = new Array(slots.length).fill(null);
  const used = new Set();
  slots.forEach((_, i) => {
    if (lockedByIndex[i]) {
      results[i] = lockedByIndex[i];
      used.add(lockedByIndex[i].key);
    }
  });
  const pass = (wantFlex) => {
    slots.forEach((slot, i) => {
      if (results[i] || Boolean(FLEX_ELIGIBLE[slot]) !== wantFlex) return;
      const pick = ordered.find((e) => !used.has(e.key) && isEligible(slot, e.player.pos));
      if (pick) {
        results[i] = pick;
        used.add(pick.key);
      }
    });
  };
  pass(false); // strict positions first, so a flex-eligible player isn't wasted at FLEX
  pass(true);
  return results;
}

function totalOf(picks) {
  return picks.reduce((sum, e) => sum + (e?.player.proj ?? 0), 0);
}

/**
 * Everything the Lineup tab and Rankings view need, in one place.
 *
 *  rosterOrder  the roster in the order the lineup is being built from
 *  rankedPicks  the lineup that order produces (one entry per slot, or null)
 *  bestPicks    the best possible lineup by projection — starters + bench +
 *               free agents (IR/taxi players can't start without a roster move)
 *  rows         per-slot current-vs-suggested rows. With no custom ranking
 *               these are the server's own lineupComparison rows; with one,
 *               the "suggested" side is the ranking's lineup instead.
 *  betterDelta  points the best possible lineup beats the suggested one by —
 *               what drives the yellow "a better lineup exists" highlight
 *  yellow       key -> note, for players involved in an improving swap
 */
export function effectiveLineup(league, orderKeysOverride) {
  const slots = (league.starters || []).map((s) => s.slot);
  const roster = rosterEntries(league);
  const freeAgents = freeAgentEntries(league);
  // `orderKeysOverride` lets the Rankings view evaluate its in-progress drag
  // order live, before it's saved; otherwise the saved ranking (if any) rules.
  const rankingKeys = orderKeysOverride !== undefined ? orderKeysOverride : league.customRanking;
  const custom = Array.isArray(rankingKeys) && rankingKeys.length > 0;

  const rosterByKey = new Map(roster.map((e) => [e.key, e]));
  const lockedByIndex = (league.starters || []).map((s) => (hasStarted(s.player) ? rosterByKey.get(playerKey(s.player)) ?? null : null));
  const notStarted = (e) => !hasStarted(e.player);

  const rosterOrder = custom ? applySavedOrder(roster, rankingKeys) : defaultOrder(roster);
  // IR and taxi players can't start without a roster move. With the suggested
  // (default) order they're left out entirely, matching the server's optimizer;
  // with the user's own ranking they're honoured — they arranged it that way —
  // and flagged as needing a move on the lineup rows and cards.
  const startable = roster.filter((e) => (e.group === "starter" || e.group === "bench") && notStarted(e));
  const startableKeys = new Set(startable.map((e) => e.key));
  const rankedPicks = fillSlots(slots, custom ? rosterOrder.filter(notStarted) : rosterOrder.filter((e) => startableKeys.has(e.key)), lockedByIndex);

  const bestPicks = fillSlots(slots, defaultOrder([...startable, ...freeAgents.filter(notStarted)]), lockedByIndex);

  const rankedTotal = totalOf(rankedPicks);
  const bestTotal = totalOf(bestPicks);
  const betterDelta = Math.max(0, bestTotal - rankedTotal);

  // Which slot (if any) each ranked player would start in — shown on the cards.
  const startsAt = new Map();
  rankedPicks.forEach((e, i) => e && startsAt.set(e.key, slots[i]));

  // Yellow: anyone in exactly one of the two lineups (and not pinned by a
  // game that's already been played). Incoming gets "Better option", outgoing
  // "Consider benching".
  const yellow = new Map();
  if (betterDelta > BETTER_EPSILON) {
    const rankedKeys = new Set(rankedPicks.filter(Boolean).map((e) => e.key));
    const bestKeys = new Set(bestPicks.filter(Boolean).map((e) => e.key));
    const lockedKeys = new Set(lockedByIndex.filter(Boolean).map((e) => e.key));
    bestPicks.forEach((e, i) => {
      if (e && !rankedKeys.has(e.key) && !lockedKeys.has(e.key)) yellow.set(e.key, `Better option for ${slots[i]}`);
    });
    rankedPicks.forEach((e, i) => {
      if (e && !bestKeys.has(e.key) && !lockedKeys.has(e.key)) yellow.set(e.key, `A better projected player is available for ${slots[i]}`);
    });
  }

  let rows;
  let currentTotal;
  let optimalTotal;
  let delta;
  if (custom) {
    rows = slots.map((slot, i) => {
      const current = league.starters[i]?.player || null;
      const pick = rankedPicks[i];
      const locked = Boolean(lockedByIndex[i]);
      const changed = !locked && (current?.name ?? null) !== (pick?.player.name ?? null);
      const needsMove = pick && (pick.group === "ir" || pick.group === "taxi");
      return {
        slot,
        current: current ? { name: current.name, proj: current.proj, projSource: current.projSource } : null,
        optimal: pick
          ? {
              name: pick.player.name,
              proj: pick.player.proj ?? null,
              projSource: pick.player.projSource,
              note: locked
                ? (lockedByIndex[i]?.player?.played ? "Already played — locked to the actual result" : "Game has started — locked")
                : needsMove
                ? `On your ${GROUP_LABEL[pick.group]} — needs a roster move before they can start`
                : undefined,
            }
          : null,
        changed,
        locked,
        delta: changed ? (pick?.player.proj ?? 0) - (current?.proj ?? 0) : 0,
      };
    });
    currentTotal = rows.reduce((sum, r) => sum + (r.current?.proj ?? 0), 0);
    optimalTotal = rows.reduce((sum, r) => sum + (r.optimal?.proj ?? 0), 0);
    delta = Math.max(0, optimalTotal - currentTotal);
  } else {
    rows = league.lineupComparison || [];
    currentTotal = rows.reduce((sum, r) => sum + (r.current?.proj ?? 0), 0);
    optimalTotal = rows.reduce((sum, r) => sum + (r.optimal?.proj ?? 0), 0);
    delta = Math.max(0, optimalTotal - currentTotal);
  }

  // Starters projected at exactly 0 — the "red" case, for the status badge.
  const zeroStarters = (league.starters || []).map((s) => s.player).filter((p) => isZeroProjection(p));

  let status;
  if (custom) {
    const changed = rows.filter((r) => r.changed);
    const swing = changed.reduce((sum, r) => sum + Math.abs(r.delta), 0);
    status = changed.length === 0 ? "ok" : swing < 5 ? "minor" : "major";
    if (status === "ok" && betterDelta > BETTER_EPSILON) status = "minor";
  } else {
    status = delta === 0 ? "ok" : delta < 5 ? "minor" : "major";
  }
  if (zeroStarters.length > 0) status = "major";

  return {
    custom,
    rows,
    currentTotal,
    optimalTotal,
    delta,
    status,
    rosterOrder,
    rankedPicks,
    bestPicks,
    rankedTotal,
    bestTotal,
    betterDelta,
    startsAt,
    yellow,
    freeAgents: defaultOrder(freeAgents),
    zeroStarters,
  };
}
