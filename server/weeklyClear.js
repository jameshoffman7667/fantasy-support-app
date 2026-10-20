import { getUserState } from "./db.js";
import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import * as waiverPlan from "./waiverPlan.js";
import * as faabDb from "./faabDb.js";

/**
 * v4.9 (replaces the v4.6 whole-plan wipe): after each league's weekly "after games" waiver clear, the Claim
 * Generator drops every claim made BEFORE that clear time; claims made since stay.
 *
 * - Every league has the weekly run (e.g. Wednesday); daily waivers are an extra on top and share the same clear time,
 *   so daily leagues are handled too (see faabDb.weeklyWaiverSchedule). The time is the league's (settings, estimated)
 *   or the one set per league in the Opponents tab.
 * - A bid carries `at` (when it was entered / last changed). A legacy bid without `at` is dated by the plan's
 *   `updatedAt`. Custom claims carry `at` as well.
 * - Hand edits, removals, saved order and unticks belong to a claim key `add|drop`; they are kept only for kept bids.
 * - The "willing to drop" ticks are cleared only when nothing was kept.
 * - Claims already queued in Sleeper are never touched. Each league's run is handled once
 *   (`waiver_cleared:{user}:{league}` remembers the last run time handled).
 */
export const GRACE_MS = 0;
const key = (u, l) => `waiver_cleared:${u}:${l}`;

/** Pure: what to do for one league. Returns "clear" | "skip" | "wait". */
export function decide({ prev, handled, now }) {
  if (!Number.isFinite(prev) || now < prev + GRACE_MS) return "wait";
  if (handled != null && handled >= prev) return "skip";
  return "clear";
}

/** Pure: the plan without claims made before `prev`. Returns the same object when nothing changes. */
export function clearedPlan(plan, prev) {
  const stamp = (x) => (Number.isFinite(Number(x?.at)) ? Number(x.at) : Number(plan.updatedAt) || 0);
  const bids = (plan.bids || []).filter((b) => stamp(b) >= prev);
  const custom = (plan.custom || []).filter((c) => stamp(c) >= prev);
  const adds = new Set([...bids.map((b) => String(b.id)), ...custom.map((c) => String(c.addId))]);
  const mine = (k) => adds.has(String(k).split("|")[0]);
  const edits = Object.fromEntries(Object.entries(plan.edits || {}).filter(([k]) => mine(k)));
  const kept = bids.length + custom.length > 0;
  const unchanged = bids.length === (plan.bids || []).length && custom.length === (plan.custom || []).length && kept;
  if (unchanged) return plan;
  return {
    ...plan,
    bids,
    custom,
    edits,
    removed: (plan.removed || []).filter(mine),
    order: (plan.order || []).filter(mine),
    unselected: (plan.unselected || []).filter(mine),
    drops: kept ? plan.drops : (plan.drops || []).map((d) => ({ ...d, willing: false })),
  };
}

export async function tick({ users, now = Date.now() } = {}) {
  const done = [];
  for (const username of users || []) {
    const ids = getUserState(username)?.leagueIds || [];
    const settings = faabDb.getSettings(username);
    for (const leagueId of ids) {
      let league;
      try {
        league = await sleeper.getLeague(leagueId);
      } catch {
        continue;
      }
      const sched = faabDb.weeklyWaiverSchedule(league, settings.waiverTimes[String(leagueId)], now);
      const handled = store.getState(key(username, leagueId), null);
      const what = decide({ prev: sched.prev, handled, now });
      if (what === "wait") continue;
      if (what === "clear") {
        const plan = waiverPlan.getPlan(username, leagueId);
        const next = clearedPlan(plan, sched.prev);
        if (next !== plan) {
          waiverPlan.savePlan(username, leagueId, next);
          done.push({ username, leagueId });
        }
      }
      store.setState(key(username, leagueId), sched.prev);
    }
  }
  return done;
}
