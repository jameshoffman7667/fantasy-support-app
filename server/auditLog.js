import db from "./db.js";
import { migrate } from "./migrate.js";

/**
 * v4.18.0 (P-7): audit log — who signed in (and failed to), signed out, pushed to Sleeper or CBS, or changed a setting,
 * credential or user. One row per event: time, user, kind, action, ok, an optional non-secret detail (league id), and the
 * caller's address. Request bodies, passwords, tokens and cookies are never stored. Kept 90 days (pruned at most once a day).
 * Server-side jobs (scheduled lineup moves, the CBS auto push) are not in this log.
 */
export const KEEP_MS = 90 * 24 * 3600 * 1000;

migrate(db, "4.18-audit-log", "audit_log table", () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      username TEXT,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
  `);
});

let lastPrune = 0;
export function record({ username = null, kind, action, ok = true, detail = null, ip = null }, now = Date.now()) {
  try {
    db.prepare("INSERT INTO audit_log (at, username, kind, action, ok, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)").run(now, username, kind, action, ok ? 1 : 0, detail ? String(detail).slice(0, 200) : null, ip ? String(ip).slice(0, 64) : null);
    if (now - lastPrune > 24 * 3600 * 1000) {
      lastPrune = now;
      db.prepare("DELETE FROM audit_log WHERE at < ?").run(now - KEEP_MS);
    }
  } catch (e) {
    console.warn("[audit] couldn't write an entry:", e.message);
  }
}

export function list({ limit = 200, kind = null } = {}) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = kind
    ? db.prepare("SELECT id, at, username, kind, action, ok, detail, ip FROM audit_log WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, n)
    : db.prepare("SELECT id, at, username, kind, action, ok, detail, ip FROM audit_log ORDER BY id DESC LIMIT ?").all(n);
  return rows.map((r) => ({ ...r, ok: Boolean(r.ok), at: new Date(r.at).toISOString() }));
}

/* Which requests are logged: [kind, label, method, path regex]. Anything else is not. */
const RULES = [
  ["push", "Lineup push", "POST", /^\/api\/private\/lineup$/],
  ["push", "IR / reserve push", "POST", /^\/api\/private\/reserve$/],
  ["push", "Drop push", "POST", /^\/api\/private\/drop$/],
  ["push", "Taxi push", "POST", /^\/api\/private\/taxi$/],
  ["push", "Waiver claim push", "POST", /^\/api\/private\/claim$/],
  ["push", "Add and lineup move", "POST", /^\/api\/private\/add-move$/],
  ["push", "Waiver claim cancel", "POST", /^\/api\/private\/claim\/cancel$/],
  ["push", "Trade reject", "POST", /^\/api\/private\/reject-trade$/],
  ["push", "Trade withdraw", "POST", /^\/api\/private\/withdraw-trade$/],
  ["push", "CBS pick'em push", "POST", /^\/api\/cbs\/push$/],
  ["setting", "Sleeper token saved", "POST", /^\/api\/private\/token$/],
  ["setting", "Sleeper token cleared", "POST", /^\/api\/private\/token\/clear$/],
  ["setting", "Sleeper write groups changed", "POST", /^\/api\/private\/(writes|perms)$/],
  ["setting", "CBS login saved", "POST", /^\/api\/cbs\/account$/],
  ["setting", "CBS login cleared", "POST", /^\/api\/cbs\/account\/clear$/],
  ["setting", "CBS settings changed", "POST", /^\/api\/cbs\/settings$/],
  ["setting", "Multiview token created", "POST", /^\/api\/ticker-token$/],
  ["setting", "Multiview token revoked", "DELETE", /^\/api\/ticker-token$/],
  ["setting", "API preset changed", "POST", /^\/api\/api-presets$/],
  ["setting", "AI sources changed", "POST", /^\/api\/ai-sources$/],
  ["setting", "Weather settings changed", "POST", /^\/api\/weather\/settings$/],
  ["auth", "Password changed", "POST", /^\/api\/account\/password$/],
  ["user", "User admin change", "POST", /^\/api\/admin\/users(\/.*)?$/],
  ["user", "User deleted", "DELETE", /^\/api\/admin\/users\/[^/]+$/],
];

export function classify(method, urlPath) {
  const p = String(urlPath || "").split("?")[0];
  const hit = RULES.find(([, , m, re]) => m === method && re.test(p));
  return hit ? { kind: hit[0], action: hit[1] } : null;
}

const ipOf = (req) => String(req.headers?.["cf-connecting-ip"] || req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
export const clientIp = ipOf;

/** Express middleware: logs a matching request when its response finishes. `resolveUser(req)` finds the user when requireAuth did not set req.user. */
export function auditMiddleware(resolveUser) {
  return (req, res, next) => {
    const c = classify(req.method, req.originalUrl || req.url);
    if (!c) return next();
    res.on("finish", () => {
      let username = req.user?.username || null;
      if (!username) { try { username = resolveUser?.(req)?.username || null; } catch { /* none */ } }
      const lid = req.body && typeof req.body.leagueId !== "undefined" ? String(req.body.leagueId).slice(0, 40) : null;
      record({ username, kind: c.kind, action: c.action, ok: res.statusCode < 400, detail: [lid ? `league ${lid}` : null, res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null].filter(Boolean).join(", ") || null, ip: ipOf(req) });
    });
    next();
  };
}
