// v4.18: migration safeguards (P-9), audit log (P-7), light palette (P-6), desktop layout helpers (P-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { migrate, appliedMigrations } from "../server/migrate.js";
import { classify, auditMiddleware, record, list } from "../server/auditLog.js";
import { PALETTES } from "../client/src/ui/theme.js";
import { DESKTOP_QUERY, MAX_DESKTOP_WIDTH } from "../client/src/ui/desktop.js";

const Database = createRequire(new URL("../server/package.json", import.meta.url))("better-sqlite3");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fm-mig-"));

test("migrate: applied once, recorded, idempotent on rerun", () => {
  const dir = tmp();
  const db = new Database(path.join(dir, "t.db"));
  let runs = 0;
  assert.equal(migrate(db, "t-1", "create a", () => { runs++; db.exec("CREATE TABLE a (x INTEGER)"); }, { dataDir: dir }), true);
  assert.equal(migrate(db, "t-1", "create a", () => { runs++; }, { dataDir: dir }), false);
  assert.equal(runs, 1);
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), ["t-1"]);
});

test("migrate: a failing migration leaves nothing behind and is not recorded", () => {
  const dir = tmp();
  const db = new Database(path.join(dir, "t.db"));
  assert.throws(() => migrate(db, "bad", "fails halfway", () => { db.exec("CREATE TABLE half (x INTEGER)"); throw new Error("boom"); }, { dataDir: dir }), /boom/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
  assert.equal(appliedMigrations(db).length, 0);
});

test("migrate: backup() takes a timestamped copy first, then the change runs; copies are kept", () => {
  const dir = tmp();
  const db = new Database(path.join(dir, "t.db"));
  db.exec("CREATE TABLE people (n TEXT); INSERT INTO people VALUES ('a'),('b')");
  migrate(db, "drop-people", "drops the table", ({ backup }) => { backup(); db.exec("DROP TABLE people"); }, { dataDir: dir, now: Date.parse("2026-11-08T20:00:00Z") });
  const [m] = appliedMigrations(db);
  assert.ok(m.backup && fs.existsSync(m.backup));
  assert.match(path.basename(m.backup), /^fantasy-manager-2026-11-08T20-00-00-000Z-before-drop-people\.db$/);
  const copy = new Database(m.backup, { readonly: true });
  assert.equal(copy.prepare("SELECT count(*) AS c FROM people").get().c, 2); // the copy still has the data
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'people'").get(), undefined);
});

test("audit: only the listed requests are logged, with labels", () => {
  assert.deepEqual(classify("POST", "/api/private/lineup"), { kind: "push", action: "Lineup push" });
  assert.equal(classify("POST", "/api/cbs/account").kind, "setting");
  assert.equal(classify("DELETE", "/api/ticker-token").action, "Multiview token revoked");
  assert.equal(classify("POST", "/api/admin/users/bob/role").kind, "user");
  assert.equal(classify("GET", "/api/private/lineup"), null);
  assert.equal(classify("POST", "/api/leagues/build"), null);
  assert.equal(classify("POST", "/api/private/token?x=1").action, "Sleeper token saved");
});

test("audit: middleware records user, outcome and league id but never the body secrets", () => {
  let finish;
  const req = { method: "POST", originalUrl: "/api/private/claim", user: { username: "tester" }, headers: { "x-forwarded-for": "10.0.0.9, 1.1.1.1" }, body: { leagueId: "L9", bid: 12, password: "hunter2", token: "abc" } };
  const res = { statusCode: 200, on: (e, fn) => { if (e === "finish") finish = fn; } };
  let nexted = false;
  auditMiddleware(() => null)(req, res, () => { nexted = true; });
  assert.ok(nexted);
  finish();
  const row = list({ kind: "push", limit: 5 }).find((r) => r.username === "tester" && r.detail === "league L9");
  assert.ok(row);
  assert.equal(row.ok, true);
  assert.equal(row.ip, "10.0.0.9");
  assert.equal(JSON.stringify(list({ limit: 1000 })).includes("hunter2"), false);
  res.statusCode = 502;
  finish();
  assert.ok(list({ limit: 5 }).some((r) => r.ok === false && /HTTP 502/.test(r.detail || "")));
  record({ username: "tester", kind: "auth", action: "Signed in" });
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("palettes: both are complete and text colours are readable on their cards", () => {
  assert.deepEqual(Object.keys(PALETTES.light).sort(), Object.keys(PALETTES.dark).sort());
  // the new light palette is held to WCAG AA on its cards; the long-standing dark palette is only checked for its main text
  for (const k of ["text", "textMuted", "textFaint", "brand", "ok", "minor", "major"]) {
    assert.ok(ratio(PALETTES.light[k], PALETTES.light.surface) >= (k === "text" ? 7 : 4.5), `light ${k}: ${ratio(PALETTES.light[k], PALETTES.light.surface).toFixed(2)}`);
  }
  assert.ok(ratio(PALETTES.dark.text, PALETTES.dark.surface) >= 7);
  assert.ok(ratio("#FFFFFF", PALETTES.light.brand) >= 4.5); // white text on the light brand buttons
  assert.ok(ratio("#FFFFFF", PALETTES.light.ok) >= 4.5);
});

test("desktop layout constants", () => {
  assert.equal(DESKTOP_QUERY, "(min-width: 1024px)");
  assert.equal(MAX_DESKTOP_WIDTH, 1600);
});
