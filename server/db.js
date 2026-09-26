import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Mounted as a volume in docker-compose.yml so data survives container
// recreation, not just restarts within the same container.
const DATA_DIR = process.env.DATA_DIR || "./data";

let db;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, "fantasy-manager.db"));
  db.pragma("journal_mode = WAL");
} catch (err) {
  // This runs at import time, before server.js ever binds to a port —
  // a failure here crashes the whole process before /api/health can
  // respond, which looks like "container unhealthy, never starts" from
  // the outside with no other clue. Naming the two known causes
  // explicitly turns a cryptic native-module stack trace into something
  // actionable straight from `docker logs`.
  console.error("[db] Failed to open the SQLite database — the server cannot start. Common causes:");
  console.error("  1. better-sqlite3's native binary doesn't match this container's platform (e.g. a glibc");
  console.error("     prebuilt binary on Alpine's musl libc). Rebuild the image with the Dockerfile's");
  console.error("     `npm install --build-from-source` step actually applied — this is fixed as of the");
  console.error("     Dockerfile shipped alongside this file, but an image built before that fix will still hit this.");
  console.error(`  2. ${DATA_DIR} isn't writable by the container's user — often a named Docker volume that`);
  console.error("     got created with the wrong ownership on first mount. entrypoint.sh fixes this at");
  console.error("     container start as of this version; an older image won't have that entrypoint.");
  console.error("Original error:", err.message);
  throw err;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS injury_seen (
    league_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    status TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (league_id, player_name)
  );

  CREATE TABLE IF NOT EXISTS built_leagues (
    username TEXT NOT NULL,
    league_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (username, league_id)
  );

  CREATE TABLE IF NOT EXISTS last_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT,
    league_ids TEXT,
    week INTEGER,
    updated_at INTEGER
  );
`);

/* ---------------- Generic cache (L1 memory + L2 SQLite) ---------------- */
// A hot in-memory Map avoids a DB round-trip on every request within the
// same process; SQLite is what makes the cache survive a restart, which
// a plain Map never would. Write-through: every set touches both.
const memCache = new Map();

export function cacheGet(key) {
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.value;

  const row = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?").get(key);
  if (row && row.expires_at > Date.now()) {
    const value = JSON.parse(row.value);
    memCache.set(key, { value, expiresAt: row.expires_at });
    return value;
  }
  return null;
}

export function cacheSet(key, value, ttlMs) {
  const expiresAt = Date.now() + ttlMs;
  memCache.set(key, { value, expiresAt });
  db.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at").run(
    key,
    JSON.stringify(value),
    expiresAt
  );
}

/** Fetch-through-cache helper: the pattern every data client below uses. */
export async function withCache(key, ttlMs, fetchFn) {
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const value = await fetchFn();
  cacheSet(key, value, ttlMs);
  return value;
}

/* ---------------- Injury persistence ---------------- */
// A status is "seen" once, forever, until it changes to a DIFFERENT
// status — matching "persist as long as the injury designation exists;
// minor once seen, major the first time a given status appears."
export function checkAndRecordInjury(leagueId, playerName, status) {
  const row = db.prepare("SELECT status, first_seen_at FROM injury_seen WHERE league_id = ? AND player_name = ?").get(leagueId, playerName);
  if (row && row.status === status) {
    return { seenBefore: true, firstSeenAt: row.first_seen_at };
  }
  // New status (or first time ever) — record it as seen starting now.
  const now = Date.now();
  db.prepare(
    "INSERT INTO injury_seen (league_id, player_name, status, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(league_id, player_name) DO UPDATE SET status = excluded.status, first_seen_at = excluded.first_seen_at"
  ).run(leagueId, playerName, status, now);
  return { seenBefore: false, firstSeenAt: now };
}

export function getInjurySeenForLeague(leagueId) {
  return db.prepare("SELECT player_name, status FROM injury_seen WHERE league_id = ?").all(leagueId);
}

// Called when a player is no longer injured, so a future re-injury with
// the same status (e.g. "Questionable" again, weeks later) is correctly
// treated as new/major rather than still "seen" from months ago.
export function clearInjurySeen(leagueId, playerName) {
  db.prepare("DELETE FROM injury_seen WHERE league_id = ? AND player_name = ?").run(leagueId, playerName);
}

/* ---------------- Per-user built-league cache (for the hourly background refresh) ---------------- */
export function getBuiltLeague(username, leagueId) {
  const row = db.prepare("SELECT data, updated_at FROM built_leagues WHERE username = ? AND league_id = ?").get(username, leagueId);
  return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
}
export function setBuiltLeague(username, leagueId, data) {
  db.prepare(
    "INSERT INTO built_leagues (username, league_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username, league_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).run(username, leagueId, JSON.stringify(data), Date.now());
}

/* ---------------- Last-session record (so the background scheduler survives a restart too) ---------------- */
export function getLastSession() {
  const row = db.prepare("SELECT username, league_ids, week FROM last_session WHERE id = 1").get();
  return row ? { username: row.username, leagueIds: JSON.parse(row.league_ids || "[]"), week: row.week } : null;
}
export function setLastSession(username, leagueIds, week) {
  db.prepare(
    "INSERT INTO last_session (id, username, league_ids, week, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, league_ids = excluded.league_ids, week = excluded.week, updated_at = excluded.updated_at"
  ).run(username, JSON.stringify(leagueIds), week, Date.now());
}

export default db;
