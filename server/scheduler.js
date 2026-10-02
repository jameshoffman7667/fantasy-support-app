import * as sleeper from "./sleeper.js";
import { buildFullLeague } from "./buildLeague.js";
import { getAllUserStates, getUser, setBuiltLeague, cacheGet, cacheSet } from "./db.js";
import { sendPushToUser, isPushConfigured } from "./push.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly, per the request this exists to satisfy

const ALERT_DEDUP_TTL_MS = 9 * 24 * 60 * 60 * 1000; // outlives a week so the same alert doesn't repeat next cycle
const ALERT_LOOKAHEAD_MS = 26 * 60 * 60 * 1000; // only alert about a kickoff within about a day
const ALERT_DELTA_THRESHOLD = 3; // points — "clearly better," not a rounding-noise swap

function alreadyAlerted(key) {
  return cacheGet(`alertsent:${key}`) !== null;
}
function markAlerted(key) {
  cacheSet(`alertsent:${key}`, true, ALERT_DEDUP_TTL_MS);
}

/**
 * Pre-kickoff alerts: push notifications for (1) a starter carrying a
 * real injury designation ahead of their kickoff, or (2) a bench option
 * that clearly outprojects a current starter — the same two conditions
 * Roster Optimization / Lineup Advice already surface in the UI, just
 * pushed proactively before the lock, not only when someone opens the app.
 *
 * Sleeper's injury_status is the official injury report, updated on its
 * own schedule — not a live gameday-inactive feed. A true last-minute
 * "ruled inactive" designation (~90 minutes before kickoff) isn't
 * confirmed available from any source this app already uses, so "Out" /
 * "IR" / "PUP" on the injury report is the closest available proxy, not
 * a guarantee of catching every inactive in time.
 */
async function scanForAlerts(username, built) {
  if (!isPushConfigured()) return;
  const now = Date.now();
  const dueSoon = (kickoff) => kickoff != null && kickoff > now && kickoff - now < ALERT_LOOKAHEAD_MS;

  for (const s of built.starters || []) {
    const p = s.player;
    if (!p || !["Out", "IR", "PUP"].includes(p.status) || !dueSoon(p.kickoff)) continue;
    const key = `${username}:${built.id}:${built.week}:${p.name}:status`;
    if (alreadyAlerted(key)) continue;
    await sendPushToUser(username, {
      title: `${built.name}: ${p.name} is ${p.status}`,
      body: `${p.name} (${s.slot}) is listed ${p.status} this week — check your lineup before kickoff.`,
    });
    markAlerted(key);
  }

  for (const c of built.lineupComparison || []) {
    if (!c.changed || c.locked || !c.optimal || c.delta < ALERT_DELTA_THRESHOLD) continue;
    const currentKickoff = (built.starters || []).find((s) => s.slot === c.slot)?.player?.kickoff;
    if (!dueSoon(currentKickoff)) continue;
    const key = `${username}:${built.id}:${built.week}:${c.slot}:swap:${c.optimal.name}`;
    if (alreadyAlerted(key)) continue;
    await sendPushToUser(username, {
      title: `${built.name}: better option at ${c.slot}`,
      body: `${c.optimal.name} projects ${c.delta.toFixed(1)} pts higher than ${c.current?.name || "your current starter"} at ${c.slot}.`,
    });
    markAlerted(key);
  }
}

/**
 * Refreshes one user's tracked leagues so the data in built_leagues is
 * already warm the next time they open the app, and runs the pre-kickoff
 * alert scan for them. (v2.1: runs for every user with saved leagues, not
 * just whoever logged in last.)
 */
async function refreshUser(state) {
  const user = getUser(state.username);
  if (!user?.active) return; // revoked/removed since they last used the app — don't spend API calls on them
  if (!state.leagueIds?.length) return;

  try {
    const sleeperUser = await sleeper.getUser(state.username);
    if (!sleeperUser) return; // username changed/deleted on Sleeper since — nothing sensible to refresh
    const sleeperState = await sleeper.getState();
    const week = state.week || sleeperState.week;
    const leaguesRaw = await sleeper.getUserLeagues(sleeperUser.user_id, sleeperState.season);
    const chosen = leaguesRaw.filter((l) => state.leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(60, 24);

    for (const leagueSummary of chosen) {
      try {
        const built = await buildFullLeague(sleeperUser.user_id, leagueSummary, week, trending, []);
        setBuiltLeague(state.username, leagueSummary.league_id, built);
        await scanForAlerts(state.username, built).catch((err) => console.warn(`[scheduler] Alert scan failed for league ${leagueSummary.league_id}: ${err.message}`));
      } catch (err) {
        console.warn(`[scheduler] Background refresh failed for ${state.username} / league ${leagueSummary.league_id}: ${err.message}`);
      }
    }
    console.log(`[scheduler] Background-refreshed ${chosen.length} league(s) for ${state.username}.`);
  } catch (err) {
    console.warn(`[scheduler] Background refresh cycle failed for ${state.username}: ${err.message}`);
  }
}

async function refreshAllUsers() {
  // Sequential on purpose: shared FantasyPros/ESPN caches make the second
  // user's refresh mostly cache hits, and it keeps the free-tier rate limit safe.
  for (const state of getAllUserStates()) {
    await refreshUser(state);
  }
}

export function startScheduler() {
  // Run once shortly after boot (so a fresh deploy warms up quickly
  // rather than waiting a full hour), then on the regular interval.
  setTimeout(refreshAllUsers, 15 * 1000);
  setInterval(refreshAllUsers, REFRESH_INTERVAL_MS);
}
