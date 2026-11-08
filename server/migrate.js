import fs from "node:fs";
import path from "node:path";

/**
 * v4.18.0 (P-9): data migration safeguards.
 *  - `schema_version` records every migration by id (applied once, in the order the code calls them).
 *  - A migration runs inside a transaction: if it throws, nothing it did is kept and the error is raised.
 *  - A migration that CHANGES or DROPS existing data calls `backup()` first: a consistent, timestamped copy of the database
 *    (VACUUM INTO) is written to DATA_DIR/backups. Backups are never deleted by the app.
 *  - Migrations must be idempotent (check before they change): an older database that already has the change just records it.
 * Use: migrate(db, "4.18-add-foo", "add foo column", ({ backup }) => { ... }).
 */
export function ensureSchemaTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL, backup TEXT)");
}

export function appliedMigrations(db) {
  ensureSchemaTable(db);
  return db.prepare("SELECT id, description, applied_at AS appliedAt, backup FROM schema_version ORDER BY applied_at, id").all();
}

export function migrate(db, id, description, fn, { dataDir = process.env.DATA_DIR || "./data", now = Date.now() } = {}) {
  ensureSchemaTable(db);
  if (db.prepare("SELECT 1 FROM schema_version WHERE id = ?").get(id)) return false;
  let backupFile = null;
  const backup = () => {
    if (backupFile) return backupFile;
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `fantasy-manager-${stamp}-before-${id.replace(/[^A-Za-z0-9._-]/g, "_")}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    backupFile = file;
    console.log(`[migrate] database copy before ${id}: ${file}`);
    return file;
  };
  // VACUUM INTO can't run inside a transaction, so the copy (if the migration asks for one) is taken by a dry first pass:
  // fn runs in the transaction; if it wants a backup the transaction is rolled back, the copy is taken, and it runs again.
  const attempt = (allowBackup) => db.transaction(() => {
    fn({ db, backup: () => { if (allowBackup && !backupFile) throw new NeedBackup(); return backupFile; } });
    db.prepare("INSERT INTO schema_version (id, description, applied_at, backup) VALUES (?, ?, ?, ?)").run(id, description, now, backupFile);
  })();
  try {
    attempt(true);
  } catch (e) {
    if (!(e instanceof NeedBackup)) throw e;
    backup();
    attempt(false);
  }
  console.log(`[migrate] applied ${id}: ${description}`);
  return true;
}
class NeedBackup extends Error {}
