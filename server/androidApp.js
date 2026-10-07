/**
 * v4.0 — Digital Asset Links for the Android app (android/, a Trusted Web Activity).
 *
 * Android only opens the app full screen (no address bar) when the site vouches for it: the site's
 * /.well-known/assetlinks.json must name the app's package and the SHA-256 fingerprint of the key
 * that signed it. The fingerprint comes from the server's environment, so nothing has to be rebuilt:
 *
 *   ANDROID_APP_SHA256   the signing key's SHA-256 fingerprint ("AB:CD:…" — the Android workflow prints
 *                        it); several can be given, separated by commas (e.g. an old and a new key)
 *   ANDROID_APP_PACKAGE  the app's package name (default ca.hoffmanhouse.fantasymanager)
 *
 * Served publicly (Android fetches it without a login) and contains nothing secret.
 */
export const DEFAULT_PACKAGE = "ca.hoffmanhouse.fantasymanager";

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
  const fingerprints = [...new Set(String(env.ANDROID_APP_SHA256 || "").split(/[,;\s]+/).map(normalizeFingerprint).filter(Boolean))];
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
