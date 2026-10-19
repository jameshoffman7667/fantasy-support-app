// Supplemental usage data (snap share, targets, carries) from nflverse's free, public community data releases —
// context alongside the projections, not a replacement.
//
// v4.8: the old single files (snap_counts.csv, player_stats.csv) no longer exist (404). Both now come from the
// per-season release files that server/nflverseStats.js already reads (snap_counts/snap_counts_<season>.csv and
// stats_player/stats_player_week_<season>.csv). A failed fetch keeps the last good data for that season/week and the
// miss is logged once, then at most once a day — not on every league refresh.
// NOT verified against a live response from the build sandbox (no access to github.com there): the column names are
// the ones nflverseStats.js already declares.
import { cacheGet, cacheSet } from "./db.js";
import * as nfl from "./nflverseStats.js";

const USAGE_TTL_MS = 6 * 60 * 60 * 1000;
const LOG_EVERY_MS = 24 * 60 * 60 * 1000;
const lastGood = new Map(); // cache key -> [[name, value], ...] from the last successful fetch
const lastLogged = new Map(); // what -> ms

function logMissOnce(what, err, now = Date.now()) {
  if (now - (lastLogged.get(what) || 0) < LOG_EVERY_MS) return false;
  lastLogged.set(what, now);
  console.warn(`[nflverseUsage] Couldn't fetch ${what} (${err.message}) — keeping the last data we had; usage badges may be missing until it returns. (Logged once a day.)`);
  return true;
}
export function _resetForTests() {
  lastGood.clear();
  lastLogged.clear();
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
    .trim();
}

/** Returns a Map keyed by normalized player name -> { snapPct, position, team }, for one season+week. */
export async function getSnapShareForWeek(season, week) {
  const cacheKey = `nflverse:snaps:${season}:${week}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return new Map(cached);
  try {
    const rows = await nfl.snaps(season, season);
    const map = new Map();
    for (const row of rows) {
      if (String(row.week) !== String(week)) continue;
      const name = row.player;
      if (!name) continue;
      const offensePct = row.offense_pct != null ? Number(row.offense_pct) : null;
      map.set(normalizeName(name), {
        snapPct: offensePct != null && !Number.isNaN(offensePct) ? Math.round(offensePct * 100) : null,
        position: row.position || null,
        team: row.team || null,
      });
    }
    cacheSet(cacheKey, [...map.entries()], USAGE_TTL_MS);
    lastGood.set(cacheKey, [...map.entries()]);
    return map;
  } catch (err) {
    logMissOnce("snap counts", err);
    return new Map(lastGood.get(cacheKey) || []);
  }
}

/** Returns a Map keyed by normalized player name -> { targets, carries }, for one season+week. */
export async function getUsageStatsForWeek(season, week) {
  const cacheKey = `nflverse:usage:${season}:${week}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return new Map(cached);
  try {
    const rows = await nfl.weekly(season, season);
    const map = new Map();
    for (const row of rows) {
      if (String(row.week) !== String(week)) continue;
      const name = row.player_display_name;
      if (!name) continue;
      map.set(normalizeName(name), {
        targets: row.targets != null ? Number(row.targets) : null,
        carries: row.carries != null ? Number(row.carries) : null,
      });
    }
    cacheSet(cacheKey, [...map.entries()], USAGE_TTL_MS);
    lastGood.set(cacheKey, [...map.entries()]);
    return map;
  } catch (err) {
    logMissOnce("weekly usage stats", err);
    return new Map(lastGood.get(cacheKey) || []);
  }
}

/** Convenience combined lookup for one player by name. */
export function lookupUsage(snapMap, statsMap, name) {
  const key = normalizeName(name);
  const snap = snapMap.get(key);
  const stats = statsMap.get(key);
  if (!snap && !stats) return null;
  return {
    snapPct: snap?.snapPct ?? null,
    targets: stats?.targets ?? null,
    carries: stats?.carries ?? null,
  };
}
