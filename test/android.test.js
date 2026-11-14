// v4.19.0: Android build checks, adapted from the template (spec v1.11 section 15, backend/test/android.test.js).
// The template's twa-manifest.json assertions are made against the Gradle project (android/app/build.gradle and
// gradle.properties), because this app builds with Gradle, not Bubblewrap. Each assertion guards a bug that cost
// a release in the pilot app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const { versionCode } = createRequire(import.meta.url)("../scripts/android-version.js");
const { DEFAULT_PACKAGE, DEFAULT_SHA256, assetLinks } = await import("../server/androidApp.js");

const FINGERPRINT = "34:64:9C:1D:1A:1F:96:21:65:D4:BE:5C:D8:AA:76:8C:3F:B7:77:DE:21:62:D7:DF:D5:FC:61:F8:03:53:D5:37";
const gradle = read("android/app/build.gradle");
const props = read("android/gradle.properties");
const workflow = read(".github/workflows/release.yml");
const serverDir = path.join(root, "server");
const hasDeps = fs.existsSync(path.join(serverDir, "node_modules", "express"));

test("versionCode = MAJOR*100000000 + MINOR*10000 + PATCH, with the limits", () => {
  assert.strictEqual(versionCode("2.11.0"), 200110000);
  assert.strictEqual(versionCode("4.19.0"), 400190000);
  assert.strictEqual(versionCode("0.1.0"), 10000);
  assert.strictEqual(versionCode("20.9999.9999"), 2000000000 + 99990000 + 9999);
  assert.ok(versionCode("2.12.0") > versionCode("2.11.9999"));
  assert.throws(() => versionCode("2.10000.0"), /9999 or less/);
  assert.throws(() => versionCode("2.0.10000"), /9999 or less/);
  assert.throws(() => versionCode("21.0.0"), /20 or less/);
  assert.throws(() => versionCode("2.1"), /MAJOR\.MINOR\.PATCH/);
});

test("the Gradle project has the identity and settings the F-Droid build needs", () => {
  assert.match(gradle, /applicationId: 'ca\.hoffmanhouse\.fantasymanager'/, "the package id never changes");
  assert.match(DEFAULT_PACKAGE, /^ca\.hoffmanhouse\.[a-z0-9]+$/, "package id: lowercase letters and digits only, no hyphens");
  assert.match(props, /^twaHost=fantasy\.hoffmanhouse\.ca$/m);
  assert.match(gradle, /prop\('twaHost', 'fantasy\.hoffmanhouse\.ca'\)/);
  for (const f of ["android/app/build.gradle", "android/gradle.properties", "android/README.md", "ANDROID_APK.md", "deploy/RELEASE.md", "docs/functional-spec.md"]) {
    assert.ok(!read(f).includes("fantasymanager.hoffmanhouse.ca"), `${f} still names the host that has no DNS record`);
  }
  assert.match(gradle, /minSdkVersion 2[4-9]|minSdkVersion [3-9]\d/, "minSdk at least 24 (androidbrowserhelper needs it)");
  assert.match(gradle, /enableSiteSettingsShortcut: 'true'/, "the browser helper library toggles ManageDataLauncherActivity at start and crashes if it is missing");
  assert.match(gradle, /enableNotifications: true/, "the app uses Web Push");
  assert.match(gradle, /fallbackType: 'customtabs'/);
  assert.ok(!/password\s*[:=]\s*['"][^'"]/i.test(gradle) && !/password/i.test(props), "no passwords in the Gradle files");
  assert.match(gradle, /System\.getenv\('ANDROID_KEYSTORE_PATH'\)/);
  assert.ok(!/debug/i.test(gradle.replace(/\/\*[\s\S]*?\*\//g, "")), "no debug signing config");
});

test("the Android colours match the web manifest", () => {
  const web = JSON.parse(read("client/public/manifest.webmanifest"));
  for (const key of ["themeColor", "themeColorDark", "navigationColor", "navigationColorDark"]) {
    assert.match(gradle, new RegExp(`${key}: '${web.theme_color}'`, "i"), key);
  }
  assert.match(gradle, new RegExp(`backgroundColor: '${web.background_color}'`, "i"));
});

test("assetlinks: built in, names the package and the real signing fingerprint", () => {
  assert.ok(DEFAULT_SHA256.includes(FINGERPRINT));
  const j = assetLinks({});
  assert.strictEqual(j[0].target.namespace, "android_app");
  assert.strictEqual(j[0].target.package_name, "ca.hoffmanhouse.fantasymanager");
  assert.ok(j[0].target.sha256_cert_fingerprints.length >= 1);
  assert.ok(j[0].target.sha256_cert_fingerprints.every((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)), "real SHA-256 fingerprint, not a placeholder");
  assert.ok(j[0].target.sha256_cert_fingerprints.includes(FINGERPRINT));
  assert.deepEqual(j[0].relation, ["delegate_permission/common.handle_all_urls"]);
  // an empty or invalid environment override falls back to the built-in fingerprint
  assert.ok(assetLinks({ ANDROID_APP_SHA256: "not-a-fingerprint" })[0].target.sha256_cert_fingerprints.includes(FINGERPRINT));
});

test("the fingerprint check script accepts the real fingerprint and rejects another", async () => {
  const run = (fp) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(root, "android/tools/check-assetlinks.mjs"), fp]);
    c.on("exit", (code) => resolve(code));
  });
  assert.strictEqual(await run(FINGERPRINT), 0);
  assert.strictEqual(await run(FINGERPRINT.toLowerCase().replace(/:/g, "")), 0);
  assert.strictEqual(await run(Array(32).fill("11").join(":")), 1);
});

test("/.well-known/assetlinks.json is served public, as JSON, without a redirect", { skip: hasDeps ? false : "run `npm install --prefix server` first" }, async () => {
  const port = 4900 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-android-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDir,
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), OWNER_USERNAME: "testowner", OWNER_PASSWORD: "longenough1" },
  });
  try {
    let r;
    for (let i = 0; i < 100 && !r; i++) {
      try { r = await fetch(`http://127.0.0.1:${port}/.well-known/assetlinks.json`, { redirect: "manual" }); } catch { await new Promise((s) => setTimeout(s, 150)); }
    }
    assert.ok(r, "server did not start");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/json/);
    const j = await r.json();
    assert.strictEqual(j[0].target.package_name, "ca.hoffmanhouse.fantasymanager");
    assert.ok(j[0].target.sha256_cert_fingerprints.includes(FINGERPRINT));
  } finally {
    child.kill("SIGKILL");
  }
});

test("release workflow: validate, images, release, android in order; manual rebuild; overwrite guard; standard secrets", () => {
  assert.match(workflow, /\n  validate:/);
  assert.match(workflow, /\n  images:\n    needs: validate/);
  assert.match(workflow, /\n  release:\n    needs: \[validate, images\]/);
  assert.match(workflow, /\n  android:\n    needs: \[validate, images, release\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs:\n\s+tag:/);
  assert.match(workflow, /overwrite:/);
  assert.equal(workflow.split("if: github.event_name != 'workflow_dispatch'").length - 1, 3, "validate, images and release are skipped on a manual run");
  assert.match(workflow, /needs\.release\.result == 'success'/, "the android job waits for the tag and release");
  for (const s of ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
    assert.ok(workflow.includes(`secrets.${s}`), s);
  }
  assert.ok(!workflow.includes("ANDROID_KEYSTORE_BASE64"), "the old secret name is retired");
  assert.match(workflow, /Missing secrets:/, "the skip notice names the missing secrets");
  assert.match(workflow, /APP: fantasy-support-app/);
  assert.match(workflow, /\$APP-\$VERSION\.apk/);
  assert.match(workflow, /gh release upload "\$TAG" "\$APK" --clobber/);
  assert.match(workflow, /OVERWRITE" != "true"/);
  assert.match(workflow, /scripts\/android-version\.js/);
  assert.match(workflow, /android\/tools\/check-assetlinks\.mjs/);
  assert.match(workflow, /android\/tools\/inspect-apk\.py/);
  assert.match(workflow, /APKSIGNER" verify/);
  assert.match(workflow, /assembleRelease/);
  assert.ok(!/assembleDebug|bubblewrap build/.test(workflow), "never a debug-signed APK");
  assert.ok(!fs.existsSync(path.join(root, ".github/workflows/android-apk.yml")), "the rolling android-latest workflow is retired");
});

test("job-level env uses only contexts GitHub allows there (runner.* is not one: it made the 4.19.0 run fail before any job started)", () => {
  const jobEnv = workflow.slice(workflow.indexOf("\n  android:")).split("    steps:")[0];
  assert.ok(!/runner\./.test(jobEnv));
});

test("the android job never prints a secret", () => {
  const job = workflow.slice(workflow.indexOf("\n  android:"));
  assert.ok(!/echo[^\n]*\$\{?(ANDROID_)?(KEYSTORE_B64|KEYSTORE_PASSWORD|KEY_PASSWORD)\b/.test(job), "no echo of a secret's value");
  assert.ok(!/set -x/.test(job));
});
