import * as sleeper from "./sleeper.js";
import { buildFullLeague } from "./buildLeague.js";
import { getLastSession, setBuiltLeague } from "./db.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly, per the request this exists to satisfy

/**
 * Refreshes whichever leagues were last actively tracked (recorded via
 * db.js's last_session, written by server.js whenever /api/leagues/build
 * runs) so the data in built_leagues is already warm the next time
 * someone opens the app — the actual point of "improve time... running
 * 24/7." Only ever operates on one user's leagues: the most recent one,
 * since "for the last logged-in user's team-specific data" was the
 * explicit scope asked for, not a general multi-user cache.
 */
async function refreshLastSession() {
  const session = getLastSession();
  if (!session?.username || !session.leagueIds?.length) return;

  try {
    const user = await sleeper.getUser(session.username);
    if (!user) return; // username changed/deleted since last recorded — nothing sensible to refresh
    const state = await sleeper.getState();
    const week = session.week || state.week;
    const leaguesRaw = await sleeper.getUserLeagues(user.user_id, state.season);
    const chosen = leaguesRaw.filter((l) => session.leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(60, 24);

    for (const leagueSummary of chosen) {
      try {
        const built = await buildFullLeague(user.user_id, leagueSummary, week, trending, []);
        setBuiltLeague(session.username, leagueSummary.league_id, built);
      } catch (err) {
        console.warn(`[scheduler] Background refresh failed for league ${leagueSummary.league_id}: ${err.message}`);
      }
    }
    console.log(`[scheduler] Background-refreshed ${chosen.length} league(s) for ${session.username}.`);
  } catch (err) {
    console.warn(`[scheduler] Background refresh cycle failed: ${err.message}`);
  }
}

export function startScheduler() {
  // Run once shortly after boot (so a fresh deploy warms up quickly
  // rather than waiting a full hour), then on the regular interval.
  setTimeout(refreshLastSession, 15 * 1000);
  setInterval(refreshLastSession, REFRESH_INTERVAL_MS);
}
