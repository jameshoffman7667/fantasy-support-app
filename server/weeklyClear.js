import { getUserState } from "./db.js";
import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import * as waiverPlan from "./waiverPlan.js";
import * as faabDb from "./faabDb.js";

/**
 * v4.6: once a league's weekly waiver run has happened, the user's waiver plan for that league is wiped clean:
 * every proposed claim / bid / hand edit / custom claim / saved order / tick (the Claim Generator) and every
 * "willing to drop" tick on the Drops list. Claims already queued in Sleeper are never touched.
 *
 * - Runs from the scheduler every 10 minutes; each league's run is handled once (`waiver_cleared:{user}:{league}`
 *   remembers the last run time it handled).
 * - The first time a league is seen only the baseline is stored (nothing is cleared), so a plan built after the
 *   last run isn't wiped on upgrade.
 * - Waits GRACE_MS after the run, and leaves the plan alone if it was edited after that window (he has already
 *   started next week's plan).
 * - Daily-waiver leagues are skipped (a "week" doesn't exist there).
 * - The waiver time is the league's (settings, estimated) or the one he set per league in the Opponents tab.
 */
export const GRACE_MS = 15 * 60 * 1000;
const key = (u, l) => `waiver_cleared:${u}:${l}`;

/** Pure: what to do for one league. Returns "baseline" | "clear" | "skip" | "wait". */
export function decide({ prev, handled, planUpdatedAt, now }) {
  if (!Number.isFinite(prev) || now < prev + GRACE_MS) return "wait";
  if (handled == null) return "baseline";
  if (handled >= prev) return "skip";
  return planUpdatedAt != null && planUpdatedAt >= prev + GRACE_MS ? "skip" : "clear";
}

/** Pure: the plan with claims and willing-to-drop ticks cleared (the order of the Drops list stays). */
export function clearedPlan(plan) {
  return { ...plan, bids: [], edits: {}, removed: [], custom: [], order: [], unselected: [], drops: (plan.drops || []).map((d) => ({ ...d, willing: false })) };
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
      const sched = faabDb.waiverSchedule(league, settings.waiverTimes[String(leagueId)], now);
      if (sched.daily) continue;
      const handled = store.getState(key(username, leagueId), null);
      const plan = waiverPlan.getPlan(username, leagueId);
      const what = decide({ prev: sched.prev, handled, planUpdatedAt: plan.updatedAt, now });
      if (what === "wait") continue;
      if (what === "clear") {
        waiverPlan.savePlan(username, leagueId, clearedPlan(plan));
        done.push({ username, leagueId });
      }
      store.setState(key(username, leagueId), sched.prev);
    }
  }
  return done;
}
