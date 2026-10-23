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

test("RELEASE.md rollback names an exact tag, not latest", () => {
  const line = read("deploy/RELEASE.md").split("\n").find((l) => l.startsWith("Rollback: "));
  assert.ok(line && /sha-[0-9a-f]{7}|\d+\.\d+\.\d+/.test(line));
  assert.ok(!/\blatest\b/.test(line));
});

test("deploy/compose.yaml pins both images to this version, never latest, and health checks use 127.0.0.1 and $PORT", () => {
  const c = read("deploy/compose.yaml");
  for (const img of ["fantasy-manager-server", "fantasy-manager-client"]) {
    assert.ok(c.includes(`image: mybadreligon/${img}:${VERSION}\n`), `${img} not pinned to ${VERSION}`);
  }
  assert.ok(!/image:.*:latest/.test(c));
  assert.ok(!c.includes("localhost"));
  assert.ok(c.includes("127.0.0.1:$${PORT}/healthz"));
  assert.match(c, /interval: 30s\n\s+timeout: 5s\n\s+start_period: 30s\n\s+retries: 3/);
});

test("release workflow: starts on a VERSION change on main, tag only as fallback, one concurrency group, tag made by gh release", () => {
  const w = read(".github/workflows/release.yml");
  assert.ok(w.includes("branches: [main]"));
  assert.ok(w.includes('paths: ["VERSION"]'));
  assert.ok(w.includes('tags: ["v[0-9]+.[0-9]+.[0-9]+"]'));
  assert.match(w, /concurrency:\n  group: release\n  cancel-in-progress: false/);
  assert.match(w, /permissions:\n  contents: write/);
  assert.ok(w.includes('gh release create "v$VERSION" --target "$GITHUB_SHA"'));
  assert.ok(w.includes('git ls-remote --exit-code --tags origin "refs/tags/v$VERSION"'));
  assert.ok(w.includes('gh release view "v$VERSION"'));
  assert.ok(!/DOCKHAND/.test(w.replace(/#.*$/gm, "")));
  // image tags must be raw tags (type=semver only works on git tag refs, not on a push to main)
  assert.ok(!/type=semver/.test(w.replace(/#.*$/gm, "")));
  assert.ok(w.includes("type=raw,value=${{ needs.validate.outputs.version }}"));
  assert.ok(w.includes("type=raw,value=${{ needs.validate.outputs.minor }}"));
  assert.ok(w.includes("type=raw,value=latest"));
  assert.ok(w.includes("org.opencontainers.image.version=${{ needs.validate.outputs.version }}"));
  assert.ok(w.includes("org.opencontainers.image.revision=${{ github.sha }}"));
  assert.ok(w.includes("name: Verify tags and labels"));
  // the release job is last and needs both the checks and the images
  assert.match(w, /release:\n    needs: \[validate, images\]/);
});

test("server image follows the spec: tini, no syntax line, health check on 127.0.0.1 with $PORT", () => {
  const d = read("server/Dockerfile");
  assert.ok(!/^# syntax=/m.test(d));
  assert.ok(d.includes('"/sbin/tini"'));
  assert.match(d, /HEALTHCHECK[\s\S]*127\.0\.0\.1:\$\{PORT\}\/healthz/);
  assert.ok(d.includes("--interval=30s --timeout=5s --start-period=30s --retries=3"));
  assert.ok(!/HEALTHCHECK[\s\S]*localhost/.test(d));
});
