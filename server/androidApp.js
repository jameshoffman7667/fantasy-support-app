/**
 * v4.0 — Digital Asset Links for the Android app (android/, a Trusted Web Activity).
 *
 * Android only opens the app full screen (no address bar) when the site vouches for it: the site's
 * /.well-known/assetlinks.json must name the app's package and the SHA-256 fingerprint of the key
 * that signed it. The fingerprint comes from the server's environment, so nothing has to be rebuilt:
 *
 *   ANDROID_APP_SHA256   optional override: the signing key's SHA-256 fingerprint ("AB:CD:…"); several can be
 *                        given, separated by commas (e.g. an old and a new key). When it is empty or has no valid
 *                        fingerprint, DEFAULT_SHA256 below is used (v4.19.0: no server setting is needed any more).
 *   ANDROID_APP_PACKAGE  the app's package name (default ca.hoffmanhouse.fantasymanager)
 *
 * Served publicly (Android fetches it without a login) and contains nothing secret.
 */
export const DEFAULT_PACKAGE = "ca.hoffmanhouse.fantasymanager";

/**
 * v4.19.0: the SHA-256 fingerprint(s) of the key that signs the app (public, not secret; the key alias is "fantasy").
 * The release workflow's android job fails when the APK's signing certificate is not listed here, so a new key
 * means adding its fingerprint to this list in the same release as the first APK it signs.
 */
export const DEFAULT_SHA256 = ["34:64:9C:1D:1A:1F:96:21:65:D4:BE:5C:D8:AA:76:8C:3F:B7:77:DE:21:62:D7:DF:D5:FC:61:F8:03:53:D5:37"];

/**
 * "ab:cd…" / "ABCD…" / "AB CD …" / "SHA256: AB:CD:…" (keytool's line, pasted whole) → "AB:CD:…" (32 bytes),
 * or null when it isn't a SHA-256 fingerprint.
 */
export function normalizeFingerprint(value) {
  const hex = String(value || "")
    .replace(/^\s*sha-?256(\s+digest)?\s*:?/i, "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (hex.length !== 64) return null;
  return hex.match(/.{2}/g).join(":");
}

/** The assetlinks.json statements for the configured app, or null when no valid fingerprint is set. */
export function assetLinks(env = process.env) {
  const fromEnv = [...new Set(String(env.ANDROID_APP_SHA256 || "").split(/[,;\s]+/).map(normalizeFingerprint).filter(Boolean))];
  const fingerprints = fromEnv.length ? fromEnv : DEFAULT_SHA256.map(normalizeFingerprint).filter(Boolean);
  if (!fingerprints.length) return null;
  const pkg = String(env.ANDROID_APP_PACKAGE || DEFAULT_PACKAGE).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
    },
  ];
}
