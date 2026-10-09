import * as store from "./projectionStore.js";

/**
 * v4.4.1 — API call presets (app-wide; only the owner switches them).
 *
 * A preset is a named bundle of parameters. "Minimal" is the set of API-call reductions built in v3.3
 * (R1, R3, R5, R6, R10-R25 — spec section 8.2l); those values live in server/sleeper.js (TTL), server/scheduler.js
 * and the other modules and apply under EVERY preset. Presets add behaviour on top of them, so a preset only lists
 * what it changes. "Medium" = Minimal + a fresh read of rosters and free agents every time the app is opened.
 * More Medium changes are coming from James: add them to MEDIUM.params and MEDIUM.adds.
 */
const KEY = "api_preset";
export const DEFAULT = "medium";

const MINIMAL_LIST = [
  "Hourly background refresh of each active person's leagues (skips people inactive 14 days; stops in the off-season after the first warm-up)",
  "Own rosters and matchups reused for 5 minutes (read live within 15 minutes of a kickoff and for 15 minutes after a push)",
  "Trending adds 1 hour · FantasyPros 60 minutes · Sleeper/ESPN projections 6 hours (forced 3 hours and 60 minutes before each kickoff slot)",
  "League settings and league users 7 days · user id and league list 30 days · player dictionary daily in season",
  "Transactions: current round 6 hours, finished rounds kept for good · other managers' leagues weekly",
  "Trade offers and pending claims 6-hour snapshot · one shared 45-second Game Day look · actuals twice a day · trade-news AI never runs on page open",
];

export const PRESETS = {
  minimal: {
    key: "minimal",
    label: "Minimal",
    summary: "Fewest calls: the reductions from v3.3 as they run today. Rosters and free agents are reused for up to 5 minutes and refreshed by the hourly background check.",
    adds: [],
    params: { freshOnOpen: false },
  },
  medium: {
    key: "medium",
    label: "Medium",
    summary: "Minimal plus a fresh read of rosters, matchups, trending adds and the free-agent pool every time the app is opened. More changes to follow.",
    adds: ["Every time the app is opened (or returned to after 5+ minutes away): rosters, matchups and trending adds are read live, and the free agents are re-worked from them. At most once a minute per league."],
    params: { freshOnOpen: true, openMinGapMs: 60 * 1000, awayMs: 5 * 60 * 1000 },
  },
};

export function active() {
  const k = store.getState(KEY, DEFAULT);
  return PRESETS[k] ? k : DEFAULT;
}
export function params() {
  return PRESETS[active()].params;
}
export function overview() {
  return { active: active(), default: DEFAULT, baseline: MINIMAL_LIST, presets: Object.values(PRESETS) };
}
export function setActive(key) {
  if (!PRESETS[key]) throw new Error("Unknown preset.");
  store.setState(KEY, key);
  return overview();
}

/** When the app is opened: does this preset call for fresh reads, and has this league been read this minute already? */
const lastOpen = new Map();
export function shouldFreshOnOpen(username, leagueId, now = Date.now()) {
  const p = params();
  if (!p.freshOnOpen) return false;
  const k = `${username}:${leagueId}`;
  if (now - (lastOpen.get(k) || 0) < (p.openMinGapMs || 0)) return false;
  lastOpen.set(k, now);
  return true;
}
export function _resetForTests() { lastOpen.clear(); }
