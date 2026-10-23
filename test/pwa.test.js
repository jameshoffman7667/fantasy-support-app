import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));
const manifest = JSON.parse(read("client/public/manifest.webmanifest"));

test("manifest has the required fields", () => {
  for (const k of ["name", "short_name", "id", "start_url", "scope", "display", "background_color", "theme_color", "description"]) {
    assert.ok(manifest[k], `manifest.${k} missing`);
  }
  assert.equal(manifest.display, "standalone");
  assert.ok(!manifest.start_url.startsWith("http"), "start_url should be relative");
});

test("manifest icons: 192, 512 and a maskable 512, all present on disk", () => {
  const find = (size, purpose) => manifest.icons.find((i) => i.sizes === size && i.purpose === purpose);
  assert.ok(find("192x192", "any"));
  assert.ok(find("512x512", "any"));
  assert.ok(find("512x512", "maskable"));
  for (const i of manifest.icons) assert.ok(exists(`client/public${i.src}`), `${i.src} missing`);
  assert.ok(exists("client/public/icons/apple-touch-icon.png"));
});

test("manifest has a wide and a narrow screenshot, present on disk", () => {
  const forms = manifest.screenshots.map((s) => s.form_factor);
  assert.ok(forms.includes("wide") && forms.includes("narrow"));
  for (const s of manifest.screenshots) assert.ok(exists(`client/public${s.src}`), `${s.src} missing`);
});

test("index.html links the manifest and has theme-color, viewport and apple-touch-icon", () => {
  const h = read("client/index.html");
  assert.ok(h.includes('rel="manifest"'));
  assert.ok(h.includes('name="theme-color"'));
  assert.ok(/name="viewport"[^>]*width=device-width, initial-scale=1/.test(h));
  assert.ok(h.includes('rel="apple-touch-icon"'));
});

test("service worker never caches API traffic or non-GET requests, has an offline page and no silent skipWaiting", () => {
  const sw = read("client/public/sw.js");
  assert.ok(sw.includes('startsWith("/api/")'));
  assert.ok(sw.includes('method !== "GET"'));
  assert.ok(sw.includes("/offline.html"));
  assert.ok(exists("client/public/offline.html"));
  // skipWaiting may only run from the message handler, never directly in install
  const install = sw.slice(sw.indexOf('"install"'), sw.indexOf('"message"')).replace(/\/\/.*$/gm, "");
  assert.ok(!install.includes("skipWaiting()"));
  assert.ok(sw.includes("SKIP_WAITING"));
});

test("page reloads on controllerchange only when it already had a controller", () => {
  const m = read("client/src/main.jsx");
  assert.ok(m.includes("hadController"));
  assert.match(m, /if \(!hadController \|\| reloading\) return;/);
});

test("Account offers an Install app button", () => {
  const a = read("client/src/pages/Account.jsx");
  assert.ok(a.includes("beforeinstallprompt") || read("client/src/main.jsx").includes("beforeinstallprompt"));
  assert.ok(a.includes("Install app"));
  assert.ok(a.includes("Add to Home Screen"));
});
