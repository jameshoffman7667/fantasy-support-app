import * as tank01 from "./tank01.js";
import * as slp from "./sleeperProjections.js";
import * as espn from "./espnProjections.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";
import * as hub from "./projectionHub.js";
import * as actuals from "./actuals.js";
import { ensureCrosswalk } from "./playerIdMap.js";
import { cacheGet, cacheSet } from "./db.js";
import db from "./db.js";

/**
 * v2.5 history backfill for the accuracy dashboard and lean calibration.
 *
 * Free sources (no Tank01 quota): Sleeper and ESPN projections and Sleeper
 * actual stats for concluded 2026 weeks and all of 2025.
 *
 * Tank01 (Vegas closing props + Tank01 projections) — per James:
 *   batch 1 (owner presses "Backfill history"): concluded 2026 games, newest
 *     first, then 2025 weeks 18 → 9.
 *   batch 2: 2025 weeks 8 → 1, automatically 40 days after batch 1 finishes.
 *   Month-end: on the last day of each month (Eastern, after 11 pm, after
 *   the day's regular pulls) any unfinished due batch continues "until the
 *   API rejects the call" — James is on the free plan, which rejects rather
 *   than bills. Progress is tracked per call in backfill_items, so nothing is
 *   ever fetched twice and each run resumes where the last one stopped.
 *
 * Tank01 serves odds for finished games (verified live 2026-10-02) — these
 * are closing lines, the most accurate a pre-kickoff snapshot could be.
 * Historical Sleeper/ESPN numbers are whatever those sources kept, which may
 * have been edited after kickoff; backfilled rows are flagged as such.
 */
const HIST_TTL = 400 * 24 * 60 * 60 * 1000;
const BATCH2_DELAY_MS = 40 * 24 * 60 * 60 * 1000;
const SEASON_2025 = 2025;

let running = null;
export function isRunning() {
  return Boolean(running);
}

function status(key) {
  return store.getItem(key)?.status || null;
}
class StopRun extends Error {}

/* ---------------- Tank01 pieces (each tracked as an item) ---------------- */
async function tankSchedule(season, batch, budget) {
  const key = `t01:sched:${season}`;
  const cached = cacheGet(`tank01:hist:sched:${season}`);
  if (status(key) === "done" && cached) return cached;
  try {
    const games = await tank01.fetchHistorySchedule(season, "all", budget); // one call covers the whole season
    cacheSet(`tank01:hist:sched:${season}`, games, HIST_TTL);
    store.setItem(key, batch, "done", `${games.length} games`);
    return games;
  } catch (err) {
    store.setItem(key, batch, "error", err.message);
    if (tank01.isStopError(err)) throw new StopRun(err.message);
    return null;
  }
}
async function tankProjections(season, week, currentSeason, batch, budget) {
  const key = `t01:proj:${season}:${week}`;
  const ck = `tank01:hist:proj:${season}:${week}`;
  if (status(key) === "done") return cacheGet(ck);
  try {
    const parsed = await tank01.fetchHistoryProjections(season, week, currentSeason, budget);
    cacheSet(ck, parsed, HIST_TTL);
    store.setItem(key, batch, "done", `${Object.keys(parsed.players).length} players`);
    return parsed;
  } catch (err) {
    store.setItem(key, batch, "error", err.message);
    if (tank01.isStopError(err)) throw new StopRun(err.message);
    return null;
  }
}
async function tankOdds(gameID, batch, budget) {
  const key = `t01:odds:${gameID}`;
  const ck = `tank01:hist:odds:${gameID}`;
  if (status(key) === "done" || status(key) === "empty") return cacheGet(ck);
  try {
    const props = await tank01.fetchHistoryOdds(gameID, budget);
    cacheSet(ck, props, HIST_TTL);
    const n = Object.keys(props).length;
    store.setItem(key, batch, n ? "done" : "empty", `${n} players with props`);
    return props;
  } catch (err) {
    store.setItem(key, batch, "error", err.message);
    if (tank01.isStopError(err)) throw new StopRun(err.message);
    return null;
  }
}

/* ---------------- one week ---------------- */
async function processWeek({ season, week, currentSeason, currentWeek, profiles, sleeperPlayers, tankIds, tank, batch, budget }) {
  const now = Date.now();
  let tankWeek = null;
  let games = null;
  if (tank && tank01.isConfigured()) {
    const sched = await tankSchedule(season, batch, budget);
    games = (sched || []).filter((g) => gameWeek(g) === week);
    const projections = await tankProjections(season, week, currentSeason, batch, budget);
    const odds = {};
    for (const g of games) {
      if (g.kickoff == null || g.kickoff > now) continue; // only concluded games
      const props = await tankOdds(g.gameID, batch, budget);
      if (props) odds[g.gameID] = { props };
    }
    tankWeek = { projections, odds };
  } else {
    // Previously fetched Tank01 history (from an earlier batch) is still used.
    const projections = cacheGet(`tank01:hist:proj:${season}:${week}`);
    const sched = cacheGet(`tank01:hist:sched:${season}`);
    games = (sched || []).filter((g) => gameWeek(g) === week);
    const odds = {};
    for (const g of games) {
      const props = cacheGet(`tank01:hist:odds:${g.gameID}`);
      if (props) odds[g.gameID] = { props };
    }
    if (projections || Object.keys(odds).length) tankWeek = { projections, odds };
  }

  const [sleeperPool, espnPool, espnSched] = await Promise.all([
    slp.getWeekProjections(season, week).catch(() => null),
    espn.getWeekProjections(season, week).catch(() => null),
    schedule.getWeekSchedule(season, week).catch(() => null),
  ]);
  const kickoffByTeam = new Map();
  for (const g of games || []) {
    if (g.kickoff == null) continue;
    kickoffByTeam.set(tank01.normTeam(g.home), g.kickoff);
    kickoffByTeam.set(tank01.normTeam(g.away), g.kickoff);
  }
  const kickoffFor = (team) => {
    if (!team) return null;
    const t = tank01.normTeam(team);
    if (kickoffByTeam.has(t)) return kickoffByTeam.get(t);
    return espnSched?.byTeam?.[schedule.normalizeTeam(team)]?.kickoffMillis ?? null;
  };
  const isCurrentWeek = Number(season) === Number(currentSeason) && Number(week) === Number(currentWeek);

  let recorded = 0;
  for (const prof of profiles) {
    const all = hub.computeAllSources({ pools: { tankWeek, tankIds, sleeperPool, espnPool }, settings: prof.settings, sleeperPlayers });
    if (isCurrentWeek) {
      for (const [sid, e] of all) {
        const k = kickoffFor(e.team);
        if (k == null || k > now) all.delete(sid); // future games this week are recorded live, not backfilled
      }
    }
    const rows = hub.toRecords({ season, week, profile: prof.profile, all, leans: null, kickoffFor, backfill: true });
    store.recordProjections(rows, { allowFrozen: true });
    recorded += rows.length;
  }
  if (!isCurrentWeek) {
    await actuals.fetchActuals(season, week).catch((err) => console.warn(`[backfill] actuals ${season} wk${week}: ${err.message}`));
  }
  return recorded;
}
function gameWeek(g) {
  return g.week ?? null;
}

/** Recomputes lean-adjusted values for backfilled rows, oldest week first, so each week's rolling window is complete. */
function recalcAdjusted(profiles, seasonWeeks) {
  const upd = db.prepare("UPDATE proj_records SET adj_proj = ROUND(proj * ?, 2) WHERE season = ? AND week = ? AND profile = ? AND source = ? AND pos = ? AND backfill = 1");
  const updV = db.prepare("UPDATE proj_records SET adj_proj = proj WHERE season = ? AND week = ? AND profile = ? AND source = 'V' AND backfill = 1");
  for (const prof of profiles) {
    for (const { season, week } of seasonWeeks) {
      const leans = hub.computeLeans(prof.profile, season, week);
      updV.run(season, week, prof.profile);
      for (const src of ["T", "S", "E"]) for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) upd.run(leans[src][pos].factor, season, week, prof.profile, src, pos);
    }
  }
}

/* ---------------- runs ---------------- */
/**
 * batch 1: free history for 2026-to-date + all 2025; Tank01 for 2026-to-date
 * then 2025 wk 18→9. batch 2: Tank01 for 2025 wk 8→1 (+ recompute those weeks).
 */
export function startBatch(batch, { budget = "full", reason = "manual" } = {}) {
  if (running) return running;
  running = runBatch(batch, budget, reason)
    .catch((err) => {
      console.warn(`[backfill] batch ${batch} failed: ${err.message}`);
      store.setState(`backfill_batch${batch}`, { ...(store.getState(`backfill_batch${batch}`) || {}), lastError: err.message, running: false });
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function runBatch(batch, budget, reason) {
  const profiles = store.listProfiles();
  if (!profiles.length) throw new Error("No scoring profiles yet — open your leagues in the app once first, then run the backfill.");
  const st = await sleeper.getState();
  const currentSeason = Number(st.season);
  const currentWeek = Number(st.week);
  const sleeperPlayers = await sleeper.getPlayers();
  await ensureCrosswalk();
  const tankIds = tank01.isConfigured() ? await tank01.getIdMap().catch(() => null) : null;

  const prevState = store.getState(`backfill_batch${batch}`) || {};
  store.setState(`backfill_batch${batch}`, { ...prevState, running: true, startedAt: prevState.startedAt || Date.now(), lastRunAt: Date.now(), lastReason: reason, lastError: null });
  console.log(`[backfill] Batch ${batch} starting (${reason}, budget: ${budget}). Tank01 calls this month so far: ${tank01.callsThisMonth()}.`);

  const tankWeeks = [];
  const freeWeeks = [];
  if (batch === 1) {
    for (let w = currentWeek; w >= 1; w--) tankWeeks.push({ season: currentSeason, week: w });
    for (let w = 18; w >= 9; w--) tankWeeks.push({ season: SEASON_2025, week: w });
    for (let w = 8; w >= 1; w--) freeWeeks.push({ season: SEASON_2025, week: w });
  } else {
    for (let w = 8; w >= 1; w--) tankWeeks.push({ season: SEASON_2025, week: w });
  }

  let stopped = null;
  const done = [];
  for (const sw of tankWeeks) {
    const tankOk = !stopped;
    try {
      const n = await processWeek({ ...sw, currentSeason, currentWeek, profiles, sleeperPlayers, tankIds, tank: tankOk, batch, budget });
      console.log(`[backfill] ${sw.season} wk${sw.week}: ${n} projection rows${tankOk ? "" : " (Sleeper/ESPN only — Tank01 stopped)"}.`);
    } catch (err) {
      if (err instanceof StopRun) {
        stopped = err.message;
        console.warn(`[backfill] Tank01 stopped: ${err.message}. Continuing with free sources; Tank01 resumes on the next run.`);
        await processWeek({ ...sw, currentSeason, currentWeek, profiles, sleeperPlayers, tankIds, tank: false, batch, budget }).catch(() => {});
      } else {
        console.warn(`[backfill] ${sw.season} wk${sw.week}: ${err.message}`);
      }
    }
    done.push(sw);
  }
  for (const sw of freeWeeks) {
    try {
      const n = await processWeek({ ...sw, currentSeason, currentWeek, profiles, sleeperPlayers, tankIds, tank: false, batch, budget });
      console.log(`[backfill] ${sw.season} wk${sw.week}: ${n} projection rows (Sleeper/ESPN; Tank01 in batch 2).`);
    } catch (err) {
      console.warn(`[backfill] ${sw.season} wk${sw.week}: ${err.message}`);
    }
    done.push(sw);
  }

  done.sort((a, b) => a.season - b.season || a.week - b.week);
  recalcAdjusted(profiles, done);

  const tankComplete = !stopped && tank01.isConfigured();
  const state = { ...(store.getState(`backfill_batch${batch}`) || {}), running: false, lastFinishedAt: Date.now(), tankComplete, stoppedBecause: stopped };
  if (tankComplete) state.completedAt = state.completedAt || Date.now();
  store.setState(`backfill_batch${batch}`, state);
  if (batch === 1 && tankComplete && !store.getState("backfill_batch2_due")) {
    store.setState("backfill_batch2_due", Date.now() + BATCH2_DELAY_MS);
  }
  console.log(`[backfill] Batch ${batch} finished. Tank01 ${tankComplete ? "complete" : `incomplete${stopped ? ` (${stopped})` : " (no TANK01_API_KEY)"}`}. Tank01 calls this month: ${tank01.callsThisMonth()}.`);
}

/* ---------------- scheduler hooks ---------------- */
function easternParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24 };
}
function isLastDayOfMonthEastern(d = new Date()) {
  const { y, m, d: day } = easternParts(d);
  return day === new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Called periodically by the scheduler. */
export async function scheduledCheck() {
  if (running || !tank01.isConfigured()) return;
  const b1 = store.getState("backfill_batch1");
  const b2 = store.getState("backfill_batch2");
  const due2 = store.getState("backfill_batch2_due");

  // Batch 2, 40 days after batch 1 finished.
  if (due2 && Date.now() >= due2 && !b2?.tankComplete && !b2?.running && !store.getState("backfill_batch2_autostarted")) {
    store.setState("backfill_batch2_autostarted", Date.now());
    return startBatch(2, { budget: "full", reason: "40 days after batch 1" });
  }

  // Month-end continuation: last day of the month, after 11 pm Eastern, once.
  const { y, m, d, h } = easternParts();
  if (isLastDayOfMonthEastern() && h >= 23) {
    const tag = `${y}-${m}-${d}`;
    if (store.getState("backfill_monthend_ran") === tag) return;
    const pending = [];
    if (b1 && !b1.tankComplete) pending.push(1);
    if (due2 && Date.now() >= due2 && !b2?.tankComplete) pending.push(2);
    if (!pending.length) return;
    store.setState("backfill_monthend_ran", tag);
    for (const batch of pending) await startBatch(batch, { budget: "unlimited", reason: "month-end continuation" });
  }
}

export function getStatus() {
  return {
    running: isRunning(),
    batch1: store.getState("backfill_batch1"),
    batch2: store.getState("backfill_batch2"),
    batch2DueAt: store.getState("backfill_batch2_due"),
    items: store.itemSummary(),
    tank01Configured: tank01.isConfigured(),
    tank01CallsThisMonth: tank01.callsThisMonth(),
    crosswalkRows: store.crosswalkCount(),
  };
}
