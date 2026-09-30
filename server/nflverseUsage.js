// Supplemental usage data (snap share, targets, carries) from nflverse's
// free, public community data releases — used to add context alongside
// FantasyPros/ESPN projections, not to replace them.
//
// NOT INDEPENDENTLY VERIFIED against a live response while building this
// (same limitation noted elsewhere in this project for other unofficial
// sources): the URLs and column names below are nflverse's documented
// release layout (github.com/nflverse/nflverse-data), but the exact
// header names are discovered and logged at runtime rather than assumed,
// the same defensive pattern already used for the ffb_ids crosswalk.
// If nflverse changes a release path or header name, this degrades to
// "no usage data" for that week rather than a build failure.
import { cacheGet, cacheSet } from "./db.js";

const SNAP_COUNTS_URL = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts.csv";
const WEEKLY_STATS_URL_TEMPLATE = "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats.csv";
const USAGE_TTL_MS = 6 * 60 * 60 * 1000; // usage data updates roughly weekly; 6h just keeps a stuck build from serving day-old data forever

let _loggedSnapHeaders = false;
let _loggedStatsHeaders = false;

function parseCsv(text) {
  // Minimal CSV parser (no quoted-comma fields expected in these
  // releases' relevant columns) — avoids pulling in a CSV dependency for
  // a small, well-known file shape.
  const lines = text.split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
    .trim();
}

async function fetchCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`nflverse fetch error ${res.status} on ${url}`);
  return res.text();
}

/** Returns a Map keyed by normalized player name -> { snapPct, position, team }, for one season+week. */
export async function getSnapShareForWeek(season, week) {
  const cacheKey = `nflverse:snaps:${season}:${week}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return new Map(cached);

  try {
    const csv = await fetchCsv(SNAP_COUNTS_URL);
    const rows = parseCsv(csv);
    if (!_loggedSnapHeaders && rows.length) {
      console.log("[nflverseUsage] snap_counts.csv columns:", Object.keys(rows[0]).join(", "));
      _loggedSnapHeaders = true;
    }
    const map = new Map();
    for (const row of rows) {
      if (String(row.season) !== String(season) || String(row.week) !== String(week)) continue;
      const name = row.player || row.player_display_name || row.full_name;
      if (!name) continue;
      const offensePct = row.offense_pct != null ? Number(row.offense_pct) : null;
      map.set(normalizeName(name), {
        snapPct: offensePct != null && !Number.isNaN(offensePct) ? Math.round(offensePct * 100) : null,
        position: row.position || null,
        team: row.team || null,
      });
    }
    cacheSet(cacheKey, [...map.entries()], USAGE_TTL_MS);
    return map;
  } catch (err) {
    console.warn(`[nflverseUsage] Couldn't fetch snap counts (${err.message}) — usage badges will be unavailable this refresh.`);
    return new Map();
  }
}

/** Returns a Map keyed by normalized player name -> { targets, carries }, for one season+week. */
export async function getUsageStatsForWeek(season, week) {
  const cacheKey = `nflverse:usage:${season}:${week}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return new Map(cached);

  try {
    const csv = await fetchCsv(WEEKLY_STATS_URL_TEMPLATE);
    const rows = parseCsv(csv);
    if (!_loggedStatsHeaders && rows.length) {
      console.log("[nflverseUsage] player_stats.csv columns:", Object.keys(rows[0]).join(", "));
      _loggedStatsHeaders = true;
    }
    const map = new Map();
    for (const row of rows) {
      if (String(row.season) !== String(season) || String(row.week) !== String(week)) continue;
      const name = row.player_display_name || row.player_name;
      if (!name) continue;
      map.set(normalizeName(name), {
        targets: row.targets != null ? Number(row.targets) : null,
        carries: row.carries != null ? Number(row.carries) : null,
      });
    }
    cacheSet(cacheKey, [...map.entries()], USAGE_TTL_MS);
    return map;
  } catch (err) {
    console.warn(`[nflverseUsage] Couldn't fetch weekly usage stats (${err.message}) — usage badges will be unavailable this refresh.`);
    return new Map();
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
