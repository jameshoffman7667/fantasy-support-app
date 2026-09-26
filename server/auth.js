import crypto from "crypto";
import { createWebSession, isValidWebSession, deleteWebSession } from "./db.js";

export const COOKIE_NAME = "fm_session";

export function isPasswordConfigured() {
  return Boolean(process.env.APP_PASSWORD);
}

// Timing-safe comparison via fixed-length SHA-256 digests, rather than
// comparing the raw strings (or padding buffers to match length, which
// doesn't reliably zero-fill and can leak timing info of its own).
// Hashing first means both sides are always the same length regardless
// of the candidate's length, so timingSafeEqual is actually safe to use.
export function checkPassword(candidate) {
  const real = process.env.APP_PASSWORD;
  if (!real) return false; // not configured -> fail closed, never open
  const a = crypto.createHash("sha256").update(String(candidate ?? "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

export function newSessionToken() {
  const token = crypto.randomBytes(32).toString("hex");
  createWebSession(token);
  return token;
}

// Minimal manual cookie parsing — this app only ever needs to read the
// one cookie it sets, so pulling in a dependency for it isn't worth it.
export function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function getSessionToken(req) {
  return req.cookies?.[COOKIE_NAME];
}

// Trusts X-Forwarded-Proto because it's set explicitly by nginx in
// client/nginx.conf, which itself only forwards whatever Caddy determined
// from the real browser request — not something an end user can spoof
// through the reverse-proxy chain this app actually ships with.
export function isRequestSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
}

export function buildSetCookieHeader(req, token, { clear = false } = {}) {
  const parts = [`${COOKIE_NAME}=${clear ? "" : encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  parts.push(clear ? "Max-Age=0" : `Max-Age=${30 * 24 * 60 * 60}`);
  // Only mark the cookie Secure when we know the request actually arrived
  // over HTTPS — marking it Secure unconditionally would silently break
  // login for anyone hitting the app over plain HTTP (e.g. LAN-only setups).
  if (isRequestSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

export function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (token && isValidWebSession(token)) return next();
  res.status(401).json({ error: "Not logged in — refresh the page to log in again." });
}

export { deleteWebSession };
