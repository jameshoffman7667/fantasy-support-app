import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const VERSION = read("VERSION").trim();

test("VERSION is MAJOR.MINOR.PATCH and matches both package.json files", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read("server/package.json")).version, VERSION);
  assert.equal(JSON.parse(read("client/package.json")).version, VERSION);
});

test("service worker cache name carries the version", () => {
  const m = read("client/public/sw.js").match(/CACHE_NAME = "fantasy-manager-v(\d+\.\d+\.\d+)"/);
  assert.ok(m, "CACHE_NAME not found in sw.js");
  assert.equal(m[1], VERSION);
});

test("CHANGELOG has this version with Short <= 50 and Long <= 250 characters", () => {
  const lines = read("CHANGELOG.md").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`## v${VERSION} `));
  assert.ok(i >= 0, `no entry for v${VERSION}`);
  const short = lines.slice(i + 1).find((l) => l.startsWith("**Short:** ")).slice(11);
  const long = lines.slice(i + 1).find((l) => l.startsWith("**Long:** ")).slice(10);
  assert.ok(short.length > 0 && short.length <= 50, `Short is ${short.length}`);
  assert.ok(long.length > 0 && long.length <= 250, `Long is ${long.length}`);
});

test("deploy/RELEASE.md is for this version and has exactly one Update: now|later line", () => {
  const r = read("deploy/RELEASE.md");
  assert.ok(r.includes(`# Release v${VERSION}\n`));
  assert.equal((r.match(/^Update: (now|later)$/gm) || []).length, 1);
});

test("deploy/compose.yaml pins both images to this version, never latest, and health checks use 127.0.0.1 and $PORT", () => {
  const c = read("deploy/compose.yaml");
  for (const img of ["fantasy-manager-server", "fantasy-manager-client"]) {
    assert.ok(c.includes(`image: mybadreligon/${img}:${VERSION}\n`), `${img} not pinned to ${VERSION}`);
  }
  assert.ok(!/image:.*:latest/.test(c));
  assert.ok(!c.includes("localhost"));
  assert.ok(c.includes("127.0.0.1:$${PORT}/healthz"));
});

test("release workflow runs only on version tags and never builds on a branch push", () => {
  const w = read(".github/workflows/release.yml");
  assert.ok(w.includes('tags: ["v[0-9]+.[0-9]+.[0-9]+"]'));
  assert.ok(!/branches:/.test(w));
  assert.ok(!/DOCKHAND/.test(w.replace(/#.*$/gm, "")));
});

test("server image follows the spec: tini, no syntax line, health check on 127.0.0.1 with $PORT", () => {
  const d = read("server/Dockerfile");
  assert.ok(!/^# syntax=/m.test(d));
  assert.ok(d.includes('"/sbin/tini"'));
  assert.match(d, /HEALTHCHECK[\s\S]*127\.0\.0\.1:\$\{PORT\}\/healthz/);
  assert.ok(!/HEALTHCHECK[\s\S]*localhost/.test(d));
});
