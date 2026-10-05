import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Mounted as a volume in docker-compose.yml so data survives container
// recreation, not just restarts within the same container.
const DATA_DIR = process.env.DATA_DIR || "./data";

let db;

// Which journal mode actually got used (logged at startup, and exposed for
// diagnostics). WAL is preferred — it's faster and lets readers and the
// writer coexist — but it needs a shared-memory file (-shm) next to the
// database, and some storage (network shares like NFS/SMB, certain
// overlay/FUSE/ZFS-backed volumes) can't provide one: SQLite fails with
// SQLITE_IOERR_SHMSIZE ("disk I/O error") the moment it tries, which used
// to crash the server before it ever listened (an "unhealthy" container
// in a restart loop). So this tries progressively more conservative
// modes instead of giving up on the first one.
export let journalModeUsed = "unknown";

function openDatabase() {
  const file = path.join(DATA_DIR, "fantasy-manager.db");
  const override = String(process.env.DB_JOURNAL_MODE || "").trim().toUpperCase();
  // Each attempt: [label, setup function]. EXCLUSIVE locking has SQLite keep
  // the WAL index in ordinary heap memory instead of a shared-memory file —
  // safe here because exactly one process (this server) ever opens the DB.
  const attempts = {
    WAL: ["WAL", (d) => d.pragma("journal_mode = WAL")],
    WAL_EXCLUSIVE: ["WAL (exclusive locking, no shared-memory file)", (d) => { d.pragma("locking_mode = EXCLUSIVE"); d.pragma("journal_mode = WAL"); }],
    DELETE: ["DELETE (rollback journal)", (d) => { d.pragma("locking_mode = EXCLUSIVE"); d.pragma("journal_mode = DELETE"); d.pragma("locking_mode = NORMAL"); }],
  };
  const order = override && attempts[override] ? [override] : ["WAL", "WAL_EXCLUSIVE", "DELETE"];
  if (override && !attempts[override]) {
    console.warn(`[db] Ignoring DB_JOURNAL_MODE="${override}" — expected WAL, WAL_EXCLUSIVE or DELETE. Using automatic fallback.`);
  }

  let lastErr;
  for (const key of order) {
    const [label, setup] = attempts[key];
    let candidate;
    try {
      candidate = new Database(file);
      setup(candidate);
      // Prove writes really work in this mode before committing to it — a
      // pragma can succeed while the first real write still hits the I/O error.
      candidate.exec("CREATE TABLE IF NOT EXISTS _startup_probe (x INTEGER); DROP TABLE _startup_probe;");
      journalModeUsed = label;
      if (key !== "WAL" && lastErr) {
        console.warn(`[db] WAL mode isn't available on this data volume (${lastErr.message}) — using ${label} instead. Works fine, just slightly slower; a local (non-network) volume avoids this.`);
      }
      console.log(`[db] SQLite journal mode: ${label}`);
      return candidate;
    } catch (err) {
      lastErr = err;
      console.warn(`[db] Journal mode "${label}" failed: ${err.message}`);
      try { candidate?.close(); } catch { /* already closed or never opened */ }
    }
  }
  throw lastErr;
}

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = openDatabase();
} catch (err) {
  // This runs at import time, before server.js ever binds to a port —
  // a failure here crashes the whole process before /api/health can
  // respond, which looks like "container unhealthy, never starts" from
  // the outside with no other clue. Naming the known causes explicitly
  // turns a cryptic native-module stack trace into something actionable
  // straight from `docker logs`.
  console.error("[db] Failed to open the SQLite database in ANY journal mode — the server cannot start. Common causes:");
  console.error("  1. better-sqlite3's native binary doesn't match this container's platform (e.g. a glibc");
  console.error("     prebuilt binary on Alpine's musl libc). Rebuild the image so the Dockerfile's");
  console.error("     `npm install --build-from-source` step is actually applied.");
  console.error(`  2. ${DATA_DIR} isn't writable by the container's user, or isn't on a filesystem SQLite can lock`);
  console.error("     (a network share). Use a local Docker volume or a bind mount on local disk instead.");
  console.error("Original error:", err.message);
  throw err;
}

// v2.1 migrations that can't be expressed as CREATE TABLE IF NOT EXISTS:
// web_sessions and push_subscriptions each gained a `username` column.
// Existing rows can't be attributed to anyone (v2 had one shared login),
// and they're cheap to recreate — everyone logs in again once, and
// re-taps "Enable alerts" — so those two tables are simply recreated.
function tableHasColumn(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.length === 0 || cols.some((c) => c.name === column); // no table yet -> nothing to migrate
}
for (const table of ["web_sessions", "push_subscriptions"]) {
  if (!tableHasColumn(table, "username")) db.exec(`DROP TABLE ${table}`);
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

  -- v2.1: accounts. username is the person's Sleeper username, lowercased.
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'guest',
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- v2.1: per-user "which leagues am I tracking, which week" (replaces the
  -- single shared last_session row, so every user resumes their own view).
  CREATE TABLE IF NOT EXISTS user_state (
    username TEXT PRIMARY KEY,
    league_ids TEXT,
    week INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS web_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- v2.1: a user's drag-ordered Player Rankings override, per league.
  CREATE TABLE IF NOT EXISTS ranking_orders (
    username TEXT NOT NULL,
    league_id TEXT NOT NULL,
    order_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (username, league_id)
  );
`);

// One-time carry-over from v1/v2's single shared last_session row, so the
// first user to log in (normally the owner) doesn't have to re-pick leagues.
// INSERT OR IGNORE: never overwrites a row a user has since saved.
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='last_session'").get()) {
  db.exec(`
    INSERT OR IGNORE INTO user_state (username, league_ids, week, updated_at)
    SELECT lower(username), league_ids, week, updated_at FROM last_session WHERE username IS NOT NULL;
  `);
}

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

/* ---------------- Users (v2.1) ---------------- */
function rowToUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    role: row.role,
    passwordHash: row.password_hash,
    mustChangePassword: Boolean(row.must_change_password),
    active: Boolean(row.active),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}
export function getUser(username) {
  return rowToUser(db.prepare("SELECT * FROM users WHERE username = ?").get(username));
}
export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY (role = 'owner') DESC, username ASC").all().map(rowToUser);
}
export function createUser({ username, role, passwordHash, mustChangePassword }) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO users (username, role, password_hash, must_change_password, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(username, role, passwordHash, mustChangePassword ? 1 : 0, now, now);
}
export function setUserPassword(username, passwordHash, mustChangePassword) {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE username = ?").run(
    passwordHash,
    mustChangePassword ? 1 : 0,
    Date.now(),
    username
  );
}
export function setUserRole(username, role) {
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE username = ?").run(role, Date.now(), username);
}
export function setUserActive(username, active) {
  db.prepare("UPDATE users SET active = ?, updated_at = ? WHERE username = ?").run(active ? 1 : 0, Date.now(), username);
}
export function touchUserLogin(username) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE username = ?").run(Date.now(), username);
}
/** Removes the account and everything tied to it. */
export function deleteUser(username) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM web_sessions WHERE username = ?").run(username);
    db.prepare("DELETE FROM push_subscriptions WHERE username = ?").run(username);
    db.prepare("DELETE FROM user_state WHERE username = ?").run(username);
    db.prepare("DELETE FROM ranking_orders WHERE username = ?").run(username);
    db.prepare("DELETE FROM built_leagues WHERE username = ?").run(username);
    db.prepare("DELETE FROM users WHERE username = ?").run(username);
  });
  tx();
}

/* ---------------- Per-user tracked leagues / week ---------------- */
export function getUserState(username) {
  const row = db.prepare("SELECT league_ids, week FROM user_state WHERE username = ?").get(username);
  return row ? { username, leagueIds: JSON.parse(row.league_ids || "[]"), week: row.week } : null;
}
export function setUserState(username, leagueIds, week) {
  db.prepare(
    "INSERT INTO user_state (username, league_ids, week, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET league_ids = excluded.league_ids, week = excluded.week, updated_at = excluded.updated_at"
  ).run(username, JSON.stringify(leagueIds), week, Date.now());
}
export function getAllUserStates() {
  return db.prepare("SELECT username, league_ids, week, updated_at FROM user_state").all().map((r) => ({
    username: r.username,
    updatedAt: r.updated_at,
    leagueIds: JSON.parse(r.league_ids || "[]"),
    week: r.week,
  }));
}

/* ---------------- Player Rankings override (per user, per league) ---------------- */
export function getRankingOrder(username, leagueId) {
  const row = db.prepare("SELECT order_json FROM ranking_orders WHERE username = ? AND league_id = ?").get(username, leagueId);
  return row ? JSON.parse(row.order_json) : null;
}
/** order === null clears the override (back to the suggested ranking). */
export function setRankingOrder(username, leagueId, order) {
  if (order === null) {
    db.prepare("DELETE FROM ranking_orders WHERE username = ? AND league_id = ?").run(username, leagueId);
    return;
  }
  db.prepare(
    "INSERT INTO ranking_orders (username, league_id, order_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username, league_id) DO UPDATE SET order_json = excluded.order_json, updated_at = excluded.updated_at"
  ).run(username, leagueId, JSON.stringify(order), Date.now());
}

/* ---------------- Web login sessions ---------------- */
// Opaque random tokens, not signed/JWT cookies, checked against this table
// on every protected request — the point being that logout (or the owner
// revoking someone's access) can actually invalidate a token server-side,
// which a self-verifying signed cookie can't do without a separate
// revocation list anyway. 30 days is a soft "stay logged in on your own
// devices" window.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function createWebSession(token, username) {
  const now = Date.now();
  db.prepare("INSERT INTO web_sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, username, now, now + SESSION_MS);
}

/** Returns the username a live token belongs to, or null. */
export function getWebSessionUsername(token) {
  const row = db.prepare("SELECT username, expires_at FROM web_sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    // Opportunistic cleanup — no need for a separate sweep job for what
    // amounts to a handful of rows per household deployment.
    db.prepare("DELETE FROM web_sessions WHERE token = ?").run(token);
    return null;
  }
  return row.username;
}

export function deleteWebSession(token) {
  db.prepare("DELETE FROM web_sessions WHERE token = ?").run(token);
}

/** Ends every session for a user (optionally keeping one, e.g. the one that just changed its password). */
export function deleteSessionsForUser(username, exceptToken = null) {
  if (exceptToken) db.prepare("DELETE FROM web_sessions WHERE username = ? AND token != ?").run(username, exceptToken);
  else db.prepare("DELETE FROM web_sessions WHERE username = ?").run(username);
}

/* ---------------- Web Push subscriptions (for pre-kickoff alerts), per user ---------------- */
export function addPushSubscription(username, endpoint, subscriptionJson) {
  db.prepare(
    "INSERT INTO push_subscriptions (endpoint, username, subscription_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, subscription_json = excluded.subscription_json"
  ).run(endpoint, username, subscriptionJson, Date.now());
}
export function getPushSubscriptionsForUser(username) {
  return db.prepare("SELECT endpoint, subscription_json FROM push_subscriptions WHERE username = ?").all(username);
}
export function deletePushSubscription(endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}
export function deletePushSubscriptionsForUser(username) {
  db.prepare("DELETE FROM push_subscriptions WHERE username = ?").run(username);
}

export default db;
