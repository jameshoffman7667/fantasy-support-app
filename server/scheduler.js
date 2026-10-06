import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as slp from "./sleeperProjections.js";
import * as espn from "./espnProjections.js";
import * as tank01 from "./tank01.js";
import * as hub from "./projectionHub.js";
import * as actuals from "./actuals.js";
import * as dvp from "./dvp.js";
import * as backfill from "./backfill.js";
import * as pickem from "./pickem.js";
import * as cbs from "./cbs.js";
import * as performance from "./performance.js";
import * as gameday from "./gameday.js"; // v3.5: Game Day baselines before the week's first kickoff
import { buildFullLeague } from "./buildLeague.js";
import { getAllUserStates, getUser, setBuiltLeague, cacheGet, cacheSet } from "./db.js";
import { sendPushToUser, isPushConfigured } from "./push.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly, per the request this exists to satisfy
// v2.4: on top of the hourly refresh, a fresh projection pull ~60 minutes
// before each kickoff slot (TNF, Sunday early/late/night, MNF, ...).
const PREKICK_LEAD_MS = 60 * 60 * 1000;
// v3.3 (R23): Sleeper and ESPN projections also get a refresh 3 hours before each slot (Tank01/Pick'em stay at 60 minutes).
const PREKICK_EARLY_LEAD_MS = 3 * 60 * 60 * 1000;
const PREKICK_WINDOW_MS = 15 * 60 * 1000; // fires between 60 and 45 min before kickoff, so a short outage doesn't skip it
const PREKICK_CHECK_MS = 5 * 60 * 1000;

// v3.3 (R12): background refreshes skip people who haven't used the app for this long (their data rebuilds when they come back).
export const INACTIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
export function isInactive(user, state, now = Date.now()) {
  const seen = Math.max(user?.lastLoginAt || 0, state?.updatedAt || 0);
  return seen > 0 && now - seen > INACTIVE_AFTER_MS;
}

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
  if (isInactive(user, state)) return; // R12

  try {
    const sleeperUser = await sleeper.getUser(state.username); // R14: cached after login
    if (!sleeperUser) return; // username changed/deleted on Sleeper since — nothing sensible to refresh
    const sleeperState = await sleeper.getState();
    const week = state.week || sleeperState.week;
    const leaguesRaw = await sleeper.getUserLeagues(sleeperUser.user_id, sleeperState.season);
    const chosen = leaguesRaw.filter((l) => state.leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(200, 24);

    for (const leagueSummary of chosen) {
      try {
        const built = await buildFullLeague(sleeperUser.user_id, leagueSummary, week, trending, []);
        setBuiltLeague(state.username, leagueSummary.league_id, built);
        performance.record(state.username, built); // v3.3: timeline of the app's suggestions (for My performance)
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

let refreshing = null;
let warmedOnce = false;
async function refreshAllUsers() {
  // One run at a time: the hourly and pre-kickoff refreshes can coincide.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // Sequential on purpose: shared projection caches make the second
    // user's refresh mostly cache hits, and it keeps rate limits safe.
    // R13: no hourly rebuilds in the offseason (Sleeper's season_type "off"); the first run after boot still warms the cache.
    let offSeason = false;
    try {
      offSeason = (await sleeper.getState())?.season_type === "off";
    } catch { /* unknown: keep refreshing */ }
    if (offSeason && warmedOnce) return;
    warmedOnce = true;
    for (const state of getAllUserStates()) {
      await refreshUser(state);
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Pre-kickoff refresh: ~60 minutes before each kickoff slot this week,
 * re-pull projections bypassing the hourly cache — Sleeper and ESPN for
 * the whole week, Tank01 projections plus fresh Vegas props for just the
 * games in that slot — then rebuild every user's leagues so lineup advice
 * and alerts use the latest numbers before lock.
 */
async function preKickoffCheck() {
  try {
    const state = await sleeper.getState();
    const season = state.season;
    const week = state.week;
    const sched = await schedule.getWeekSchedule(season, week);
    if (!sched?.byTeam) return;
    const slots = new Map(); // kickoff millis -> teams
    for (const [team, g] of Object.entries(sched.byTeam)) {
      if (g.kickoffMillis == null) continue;
      if (!slots.has(g.kickoffMillis)) slots.set(g.kickoffMillis, []);
      slots.get(g.kickoffMillis).push(tank01.normTeam(team));
    }
    sleeper.setKickoffs([...slots.keys()]); // R1: rosters/matchups skip their 5-minute cache within 15 minutes of a kickoff
    const now = Date.now();
    for (const [kickoff, teams] of slots) {
      for (const leadMs of [PREKICK_EARLY_LEAD_MS, PREKICK_LEAD_MS]) {
        const lead = kickoff - now;
        if (lead > leadMs || lead <= leadMs - PREKICK_WINDOW_MS) continue;
        const early = leadMs === PREKICK_EARLY_LEAD_MS;
        const doneKey = `prekick:${season}:${week}:${kickoff}${early ? ":3h" : ""}`;
        if (cacheGet(doneKey) !== null) continue;
        cacheSet(doneKey, true, 2 * 24 * 60 * 60 * 1000);
        console.log(`[scheduler] ${early ? "3-hour" : "Pre-kickoff"} refresh for the ${new Date(kickoff).toISOString()} slot (${teams.join(", ")}).`);

        await slp.getWeekProjections(season, week, { force: true }).catch((err) => console.warn(`[scheduler] Pre-kickoff Sleeper pull failed: ${err.message}`));
        await espn.getWeekProjections(season, week, { force: true }).catch((err) => console.warn(`[scheduler] Pre-kickoff ESPN pull failed: ${err.message}`));
        if (!early && tank01.isConfigured()) {
          const current = await tank01.getWeekData(season, week); // schedule comes from here
          const gameIDs = (current?.schedule?.games || []).filter((g) => teams.includes(g.home) || teams.includes(g.away)).map((g) => g.gameID);
          await tank01.getWeekData(season, week, { projections: true, gameIDs });
        }
        hub.clearCache(); // recompute (and re-record) every source with the fresh numbers
        await refreshAllUsers();
        if (!early) await pickem.updateAllUsers(); // final pre-kickoff recommendations (flags/pushes any change)
        // v3.5: an hour before the week's FIRST kickoff, record each Game Day matchup's projected totals (the
        // baseline that later projections are compared with), in case Game Day isn't opened before then.
        if (!early && kickoff === Math.min(...slots.keys())) {
          const users = getAllUserStates().filter((st) => getUser(st.username)?.active && st.leagueIds?.length && !isInactive(getUser(st.username), st)).map((st) => st.username);
          await gameday.snapshotBaselines(users);
        }
      }
    }
  } catch (err) {
    console.warn(`[scheduler] Pre-kickoff check failed: ${err.message}`);
  }
}

export function startScheduler() {
  // Run once shortly after boot (so a fresh deploy warms up quickly
  // rather than waiting a full hour), then on the regular interval.
  setTimeout(refreshAllUsers, 15 * 1000);
  setInterval(refreshAllUsers, REFRESH_INTERVAL_MS);
  setInterval(preKickoffCheck, PREKICK_CHECK_MS);
  // v2.5: actual scores for finished weeks (hourly) and the history backfill's
  // scheduled runs (batch 2 at +40 days; month-end continuation).
  // R6: actuals only matter once a week is over — check twice a day (a check with nothing to fetch costs no calls).
  setInterval(() => actuals.updateActuals().catch((err) => console.warn(`[scheduler] Actuals update failed: ${err.message}`)), 12 * 60 * 60 * 1000);
  setTimeout(() => actuals.updateActuals().catch(() => {}), 60 * 1000);
  // v2.7: Pick'em recommendations hourly (red-dot flags + push on changes before kickoff).
  setInterval(() => pickem.updateAllUsers().catch((err) => console.warn(`[scheduler] Pick'em update failed: ${err.message}`)), REFRESH_INTERVAL_MS);
  // v3.2: CBS pick'em auto-push (opt-in per user): each kickoff slot's games ~60 minutes before it starts.
  setInterval(() => cbs.autoTick().catch((err) => console.warn(`[scheduler] CBS auto-push failed: ${err.message}`)), PREKICK_CHECK_MS);
  // v3.3: while auto mode is on, look at CBS about every 30 min (the call itself is throttled per user) and switch auto mode
  // off if a pick was changed on CBS.
  setInterval(() => cbs.watchTick().catch((err) => console.warn(`[scheduler] CBS watch failed: ${err.message}`)), PREKICK_CHECK_MS);
  // v2.8: matchup-difficulty stats — finished games hourly; last season once.
  setTimeout(() => dvp.ensureLoaded().catch((err) => console.warn(`[scheduler] Matchup stats load failed: ${err.message}`)), 20 * 1000);
  // R22: finished games are loaded after Tuesday's finals and again Thursday (corrections), not hourly; the check itself is free.
  setInterval(() => {
    const t = sleeper.torontoNow();
    if (!["Tue", "Thu"].includes(t.weekday) || t.hour < 5) return;
    const k = `dvp-run:${t.date}`;
    if (cacheGet(k) !== null) return;
    cacheSet(k, true, 2 * 24 * 60 * 60 * 1000);
    dvp.ensureLoaded().catch((err) => console.warn(`[scheduler] Matchup stats load failed: ${err.message}`));
  }, 30 * 60 * 1000);
  setInterval(() => backfill.scheduledCheck().catch((err) => console.warn(`[scheduler] Backfill check failed: ${err.message}`)), PREKICK_CHECK_MS);
}

export { preKickoffCheck as _preKickoffCheckForTests };
