#!/usr/bin/env node
// v4.19.0: fails unless the app's served /.well-known/assetlinks.json source (server/androidApp.js, with no
// environment override) lists the given signing-certificate fingerprint for the app's package.
// Usage: node android/tools/check-assetlinks.mjs <sha256 fingerprint, any common format> [package id]
import { DEFAULT_PACKAGE, assetLinks, normalizeFingerprint } from "../../server/androidApp.js";

const fp = normalizeFingerprint(process.argv[2]);
const pkg = process.argv[3] || DEFAULT_PACKAGE;
if (!fp) {
  console.error("Usage: check-assetlinks.mjs <SHA-256 fingerprint> [package id]");
  process.exit(2);
}
const statements = assetLinks({ ANDROID_APP_SHA256: "", ANDROID_APP_PACKAGE: pkg }); // the built-in defaults only
const target = statements?.[0]?.target;
if (!target || target.package_name !== pkg) {
  console.error(`assetlinks: the served file does not name the package ${pkg}.`);
  process.exit(1);
}
if (!target.sha256_cert_fingerprints.includes(fp)) {
  console.error(
    `assetlinks: the APK is signed with ${fp}, which is not in DEFAULT_SHA256 (server/androidApp.js: ${target.sha256_cert_fingerprints.join(", ")}). ` +
      "Add it there in the same release, or the app would open with an address bar."
  );
  process.exit(1);
}
console.log(`assetlinks OK: ${pkg} is vouched for with ${fp}`);
