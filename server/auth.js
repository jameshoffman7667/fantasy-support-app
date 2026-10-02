import crypto from "crypto";
import { promisify } from "util";
import * as db from "./db.js";

const scrypt = promisify(crypto.scrypt);

export const COOKIE_NAME = "fm_session";
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/* ---------------- Usernames ---------------- */
// Sleeper usernames are case-insensitive, so every username in this app
// (login, owner env var, database keys) is stored lowercased.
export function normalizeUsername(username) {
  return String(username ?? "").trim().toLowerCase();
}
export function isValidUsername(username) {
  return /^[a-z0-9_.-]{1,40}$/.test(username);
}
/** The owner named by the OWNER_USERNAME env var — protected from demotion, revocation and removal. */
export function envOwnerUsername() {
  return normalizeUsername(process.env.OWNER_USERNAME);
}
export function isEnvOwner(username) {
  const owner = envOwnerUsername();
  return Boolean(owner) && owner === username;
}

/* ---------------- Passwords (scrypt) ---------------- */
// Stored as `scrypt$<salt hex>$<hash hex>` — a random 16-byte salt per
// password and scrypt's default cost parameters (N=16384, r=8, p=1).
// Async scrypt so hashing doesn't block the event loop for other requests.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = await scrypt(String(password ?? ""), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// A throwaway hash to verify against when the username doesn't exist (or is
// revoked), so "no such user" takes about as long as "wrong password" and
// doesn't reveal which usernames have accounts.
let dummyHashPromise = null;
export async function burnPasswordCheck(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("not-a-real-password");
  await verifyPassword(password, await dummyHashPromise);
}

/** Returns an error message, or null if the password is acceptable. */
export function validateNewPassword(password) {
  if (typeof password !== "string") return "A password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

/** Random temporary password for owner-issued resets/new accounts (12 URL-safe characters). */
export function generateTempPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

/* ---------------- Login throttling ---------------- */
// Keyed by username, not IP: behind nginx + Caddy every request reaches
// this process from a proxy address, and X-Forwarded-For can't be trusted
// without knowing the exact proxy depth of a given deployment. The tradeoff
// is that someone can briefly lock a *named* account by guessing wrong
// passwords against it — a nuisance, not a break-in — and it clears itself.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // username -> { count, resetAt }

export function isThrottled(username) {
  const rec = failures.get(username);
  if (!rec) return false;
  if (rec.resetAt <= Date.now()) {
    failures.delete(username);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}
export function recordFailure(username) {
  const now = Date.now();
  const rec = failures.get(username);
  if (!rec || rec.resetAt <= now) failures.set(username, { count: 1, resetAt: now + WINDOW_MS });
  else rec.count++;
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k); // keep the map bounded
  }
}
export function clearFailures(username) {
  failures.delete(username);
}

/* ---------------- Owner bootstrap ---------------- */
/**
 * Makes sure the owner named by OWNER_USERNAME exists. Runs at startup.
 *  - Missing account: created with OWNER_PASSWORD, flagged to change it on first login.
 *  - Existing account: forced back to owner role + active (the env var is the
 *    source of truth for who the owner is — it can't be locked out or demoted
 *    from inside the app).
 *  - OWNER_FORCE_RESET=true (with OWNER_PASSWORD set): resets the owner's
 *    password too — the recovery path if the owner forgets theirs. Remove
 *    the flag again afterwards or the password resets on every restart.
 */
export async function ensureOwnerFromEnv() {
  const name = envOwnerUsername();
  if (!name) {
    console.warn("⚠️  OWNER_USERNAME is not set — nobody can log in until it is (it names the owner's Sleeper username). See README.");
    return null;
  }
  if (!isValidUsername(name)) {
    console.warn(`⚠️  OWNER_USERNAME "${name}" isn't a valid username (letters, numbers, _ . - only) — nobody can log in until it's fixed.`);
    return null;
  }
  const envPassword = process.env.OWNER_PASSWORD;
  const existing = db.getUser(name);

  if (!existing) {
    const problem = validateNewPassword(envPassword);
    if (problem) {
      console.warn(`⚠️  Can't create the owner account "${name}": OWNER_PASSWORD is missing or invalid (${problem}) — nobody can log in until it's set.`);
      return null;
    }
    db.createUser({ username: name, role: "owner", passwordHash: await hashPassword(envPassword), mustChangePassword: true });
    console.log(`[auth] Created owner account "${name}" — log in with OWNER_PASSWORD; you'll be asked to choose a new password.`);
    return name;
  }

  if (existing.role !== "owner") db.setUserRole(name, "owner");
  if (!existing.active) db.setUserActive(name, true);

  if (String(process.env.OWNER_FORCE_RESET).toLowerCase() === "true") {
    const problem = validateNewPassword(envPassword);
    if (problem) {
      console.warn(`⚠️  OWNER_FORCE_RESET is set but OWNER_PASSWORD is missing or invalid (${problem}) — owner password NOT reset.`);
    } else {
      db.setUserPassword(name, await hashPassword(envPassword), true);
      db.deleteSessionsForUser(name);
      console.warn(`⚠️  OWNER_FORCE_RESET is set — reset the password for owner "${name}" to OWNER_PASSWORD (they must change it at next login). Remove OWNER_FORCE_RESET now, or this repeats on every restart.`);
    }
  }
  return name;
}

/* ---------------- Sessions / cookies ---------------- */
export function newSessionToken(username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.createWebSession(token, username);
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

/** Public shape of a user (never includes the password hash). */
export function publicUser(user) {
  return { username: user.username, role: user.role, mustChangePassword: user.mustChangePassword };
}

/**
 * Resolves the request's cookie to a live, still-authorized user — or null.
 * Re-checks the users table on every request (not just at login), which is
 * what makes "revoke access" take effect immediately: a revoked or deleted
 * user's still-valid cookie stops working on their very next request.
 */
export function resolveUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const username = db.getWebSessionUsername(token);
  if (!username) return null;
  const user = db.getUser(username);
  if (!user || !user.active) {
    db.deleteWebSession(token);
    return null;
  }
  return user;
}

const NOT_LOGGED_IN = { error: "Not logged in — refresh the page to log in again." };

/** Any logged-in user, even one who still owes a forced password change. */
export function requireSession(req, res, next) {
  const user = resolveUser(req);
  if (!user) return res.status(401).json(NOT_LOGGED_IN);
  req.user = user;
  next();
}

/** A fully-usable session: logged in AND past any forced password change. */
export function requireAuth(req, res, next) {
  requireSession(req, res, () => {
    if (req.user.mustChangePassword) {
      return res.status(403).json({ error: "Change your temporary password before continuing.", code: "must_change_password" });
    }
    next();
  });
}

export function requireOwner(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "owner") return res.status(403).json({ error: "Owner access required." });
    next();
  });
}

export const deleteWebSession = db.deleteWebSession;
