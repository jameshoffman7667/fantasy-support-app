import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const serverDir = new URL("../server/", import.meta.url).pathname;
const hasDeps = fs.existsSync(path.join(serverDir, "node_modules", "express"));
const VERSION = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
const opts = { skip: hasDeps ? false : "run `npm install --prefix server` first" };

function start(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDir,
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => out };
}

async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out");
}

test("/healthz returns status and version, and SIGTERM stops the server cleanly and quickly", opts, async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const s = start({ PORT: String(port), OWNER_USERNAME: "testowner", OWNER_PASSWORD: "longenough1" });
  try {
    const res = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      return r.ok ? r : null;
    });
    assert.deepEqual(await res.json(), { status: "ok", version: VERSION });
    const t = Date.now();
    s.child.kill("SIGTERM");
    const { code } = await s.exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - t < 10000, "took longer than 10 s");
    assert.ok(s.output().includes("[shutdown] done"));
  } finally {
    s.child.kill("SIGKILL");
  }
});

test("missing OWNER_USERNAME fails fast with a clear message", opts, async () => {
  const s = start({ PORT: "4590" });
  const { code } = await s.exited;
  assert.equal(code, 1);
  assert.ok(s.output().includes("OWNER_USERNAME is not set"));
});

test("a first start without OWNER_PASSWORD fails fast with a clear message", opts, async () => {
  const s = start({ PORT: "4591", OWNER_USERNAME: "someowner" });
  const { code } = await s.exited;
  assert.equal(code, 1);
  assert.ok(s.output().includes("OWNER_PASSWORD is not set"));
});
