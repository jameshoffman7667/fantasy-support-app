import { cacheGet, cacheSet } from "./db.js";
import { lookupBySleeperId } from "./playerIdMap.js";

/**
 * Fallback projection source for players FantasyPros doesn't have (free
 * scrape/API coverage gaps, name mismatches, etc). Only ever called for
 * players that already failed to match FantasyPros — this is a gap-fill,
 * not a replacement.
 *
 * CONFIRMED (via search, cross-referenced across multiple independent
 * community API-documentation projects, not a single source):
 *  - sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes
 *    lists all athletes with numeric IDs, no auth needed.
 *  - sports.core.api.espn.com/.../seasons/{year}/types/2/athletes/{id}/projections
 *    exists and needs no auth or fantasy-league context (unlike the
 *    fantasy.espn.com/apis/v3 endpoints, which need real ESPN league IDs
 *    and often SWID/espn_s2 auth cookies — deliberately avoided here).
 *
 * NOT CONFIRMED: the exact JSON field names inside that projections
 * response for a fantasy-points total. The page-reading tools available
 * while writing this render pages as text, not raw JSON I could inspect
 * directly for this specific endpoint. The parser below tries several
 * plausible shapes based on ESPN's general "categories -> stats" API
 * convention seen elsewhere in their API, logs the raw shape of the
 * first response on first use, and returns null (not a guess) if none
 * of the shapes match — a wrong number here would be worse than no
 * number, since the UI would present it as real.
 */
const ESPN_CORE_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const ATHLETE_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECTION_TTL_MS = 60 * 60 * 1000;

let _loggedRawShape = false;

async function espnFetch(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ESPN core API error ${res.status} on ${url}`);
  return res.json();
}

function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Name -> ESPN athlete ID index, built once and cached for a day. */
async function getAthleteIndex() {
  const cached = cacheGet("espn:athlete-index");
  if (cached !== null) return cached;

  const data = await espnFetch(`${ESPN_CORE_BASE}/athletes?limit=20000&active=true`);
  const index = {};
  // ESPN's list endpoints are typically { items: [{ $ref, ... } or full objects] }.
  // Handle both a fully-embedded list and a $ref-only list defensively —
  // if it's $ref-only, resolving 20,000 individual refs isn't worth the
  // request budget for a fallback feature, so that case degrades to an
  // empty index (ESPN fallback simply unavailable) rather than attempting it.
  const items = data.items || [];
  for (const item of items) {
    if (item.fullName || item.displayName) {
      const name = item.fullName || item.displayName;
      const id = item.id || (item.$ref && item.$ref.match(/athletes\/(\d+)/)?.[1]);
      if (id) index[normalizeName(name)] = id;
    }
  }
  cacheSet("espn:athlete-index", index, ATHLETE_LIST_TTL_MS);
  return index;
}

function extractFantasyPoints(json) {
  // Try a few plausible shapes rather than committing to one guess.
  // ESPN's stats/projections responses commonly nest values under
  // splits.categories[].stats[] with a `name`/`abbreviation` + `value`.
  const categories = json?.splits?.categories || json?.categories || [];
  for (const cat of categories) {
    for (const stat of cat.stats || []) {
      if (["fantasyPoints", "points", "appliedTotal"].includes(stat.name || stat.abbreviation)) {
        const val = Number(stat.value);
        if (!Number.isNaN(val)) return val;
      }
    }
  }
  // Some ESPN responses expose a flatter top-level appliedTotal/points field.
  const flat = json?.appliedTotal ?? json?.totalPoints ?? json?.points;
  if (flat != null && !Number.isNaN(Number(flat))) return Number(flat);
  return null;
}

/**
 * Preferred entry point: resolves the ESPN athlete ID via the ffb_ids
 * crosswalk (playerIdMap.js) first — a real ID join, not a name guess —
 * and only falls back to the fuzzy 20k-athlete name index (getEspnProjection)
 * for players the crosswalk doesn't have (recent rookies, practice-squad
 * adds, etc). sleeperId is Sleeper's own player_id, already on hand for
 * every rostered/trending player in buildLeague.js.
 */
export async function getEspnProjectionBySleeperId(sleeperId, playerNameFallback, season, week) {
  const crosswalk = await lookupBySleeperId(sleeperId);
  if (crosswalk?.espnId) {
    try {
      const cacheKey = `espn:proj:${crosswalk.espnId}:${season}:${week}`;
      const cached = cacheGet(cacheKey);
      if (cached !== null) return cached === "null" ? null : cached;

      const url = `${ESPN_CORE_BASE}/seasons/${season}/types/2/athletes/${crosswalk.espnId}/projections`;
      const json = await espnFetch(url);
      if (!_loggedRawShape) {
        console.log("[espnProjections] Sample raw response shape (top-level keys):", Object.keys(json || {}));
        _loggedRawShape = true;
      }
      const points = extractFantasyPoints(json);
      cacheSet(cacheKey, points === null ? "null" : points, PROJECTION_TTL_MS);
      return points;
    } catch (err) {
      console.warn(`[espnProjections] Crosswalk ID ${crosswalk.espnId} failed for "${playerNameFallback}": ${err.message}`);
      // Fall through to name-based lookup below rather than giving up outright.
    }
  }
  return getEspnProjection(playerNameFallback, season, week);
}

/**
 * Returns projected fantasy points for one player by name, or null if
 * unavailable/unmatched/unparseable. Every failure mode returns null —
 * this function never throws, since it's a best-effort fallback and a
 * single player's lookup failing shouldn't affect anyone else's.
 */
export async function getEspnProjection(playerName, season, week) {
  try {
    const index = await getAthleteIndex();
    const athleteId = index[normalizeName(playerName)];
    if (!athleteId) return null;

    const cacheKey = `espn:proj:${athleteId}:${season}:${week}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached === "null" ? null : cached;

    const url = `${ESPN_CORE_BASE}/seasons/${season}/types/2/athletes/${athleteId}/projections`;
    const json = await espnFetch(url);

    if (!_loggedRawShape) {
      console.log("[espnProjections] Sample raw response shape (top-level keys):", Object.keys(json || {}));
      _loggedRawShape = true;
    }

    const points = extractFantasyPoints(json);
    cacheSet(cacheKey, points === null ? "null" : points, PROJECTION_TTL_MS);
    return points;
  } catch (err) {
    console.warn(`[espnProjections] Failed for "${playerName}": ${err.message}`);
    return null;
  }
}
