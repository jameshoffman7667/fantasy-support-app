import * as slp from "./sleeperProjections.js";
import * as store from "./projectionStore.js";
import { cacheGet, cacheSet } from "./db.js";

/**
 * v3.5 — rest-of-season (ROS) projected points per player, in one league's scoring.
 *
 * Sum of Sleeper's weekly projections from the current week through the league's last week (the end of its
 * playoffs, or week 17 when that can't be read). Sleeper publishes projections for future weeks too; they are
 * rougher than this week's but cost nothing extra. The current week is refreshed with the usual cache (6 h),
 * later weeks are kept a day. Bye weeks simply have no row. Scored totals are cached 6 hours per scoring profile.
 */
const SIX_HOURS = 6 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

/** Last fantasy week of a league: playoff start + rounds - 1 (rounds from the playoff team count), else 17. */
export function lastFantasyWeek(settings = {}) {
  const start = Number(settings.playoff_week_start);
  const teams = Number(settings.playoff_teams);
  if (Number.isFinite(start) && start > 0) {
    const rounds = Number.isFinite(teams) && teams > 1 ? Math.ceil(Math.log2(teams)) : 3;
    return Math.min(18, Math.max(start, start + rounds - 1));
  }
  return 17;
}

export async function rosPoints({ season, week, settings, lastWeek = null, getWeek = slp.getWeekProjections }) {
  const toWeek = Math.max(Number(week), lastWeek ?? lastFantasyWeek(settings));
  const profile = store.profileOf(settings).key;
  const key = `ros:v1:${profile}:${season}:${week}:${toWeek}`;
  const hit = cacheGet(key);
  if (hit !== null) return { weeks: hit.weeks, byId: new Map(hit.entries), at: hit.at };
  const totals = new Map();
  let weeksLoaded = 0;
  for (let w = Number(week); w <= toWeek; w++) {
    let pool;
    try {
      pool = await getWeek(season, w, w > Number(week) ? { ttlMs: DAY } : {});
    } catch (err) {
      console.warn(`[ros] week ${w} projections unavailable: ${err.message}`);
      continue;
    }
    weeksLoaded++;
    for (const [id, entry] of Object.entries(pool?.byId || {})) {
      const pts = slp.scoreStats(entry, settings);
      if (pts == null) continue;
      totals.set(id, (totals.get(id) || 0) + pts);
    }
  }
  const rounded = [...totals.entries()].map(([id, v]) => [id, Math.round(v * 10) / 10]);
  const out = { weeks: { from: Number(week), to: toWeek, loaded: weeksLoaded }, entries: rounded, at: Date.now() };
  if (weeksLoaded > 0) cacheSet(key, out, SIX_HOURS);
  return { weeks: out.weeks, byId: new Map(rounded), at: out.at };
}
