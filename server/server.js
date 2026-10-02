import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import * as sleeper from "./sleeper.js";
import { buildFullLeague } from "./buildLeague.js";
import { getFaabSuggestions } from "./faab.js";
import {
  getBuiltLeague,
  setBuiltLeague,
  getUser,
  listUsers,
  createUser,
  setUserPassword,
  setUserRole,
  setUserActive,
  touchUserLogin,
  deleteUser,
  getUserState,
  setUserState,
  getRankingOrder,
  setRankingOrder,
  deleteSessionsForUser,
  deletePushSubscriptionsForUser,
} from "./db.js";
import { startScheduler } from "./scheduler.js";
import { simulateSeason } from "./simulate.js";
import { isPushConfigured, getPublicKey, saveSubscription, removeSubscription } from "./push.js";
import {
  normalizeUsername,
  isValidUsername,
  isEnvOwner,
  envOwnerUsername,
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  validateNewPassword,
  generateTempPassword,
  isThrottled,
  recordFailure,
  clearFailures,
  ensureOwnerFromEnv,
  newSessionToken,
  parseCookies,
  getSessionToken,
  buildSetCookieHeader,
  publicUser,
  resolveUser,
  requireSession,
  requireAuth,
  requireOwner,
  deleteWebSession,
} from "./auth.js";

const app = express();
app.use(cors());
app.use(express.json());

// Manual cookie parsing (see auth.js) — populates req.cookies for every
// route below, including the login route itself.
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});

// In-memory session store: connect once, keep the built league list around
// so refresh can diff against it. Fine for personal use on one machine;
// swap for a real session store if you deploy this for many people.
// (The SQLite layer in db.js is separate from this — that's what
// actually survives a restart; this Map is just per-process request state.)
// Each entry records which app user (`appUser`) created it, and every route
// that takes a sessionId checks it belongs to the requesting user.
const sessions = new Map(); // sessionId -> { appUser, userId, username, leaguesRaw, week, builtLeagues, trackedLeagueIds }

function newSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

/** The caller's own connect-session, or sends a 400 and returns null. */
function ownSession(req, res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.appUser !== req.user.username) {
    res.status(400).json({ error: "Unknown session — connect again." });
    return null;
  }
  return session;
}

function dropConnectSessionsFor(username) {
  for (const [id, s] of sessions) if (s.appUser === username) sessions.delete(id);
}

// Deliberately left unprotected — this is what the Docker healthcheck
// hits, and it carries nothing sensitive.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, fantasyProsKeySet: Boolean(process.env.FANTASYPROS_API_KEY && process.env.FANTASYPROS_API_KEY !== "your_key_here") });
});

/* ---------------- Login / logout / auth status (per-user, v2.1) ---------------- */
app.post("/api/login", async (req, res) => {
  try {
    if (!envOwnerUsername()) {
      return res.status(500).json({ error: "OWNER_USERNAME isn't set on the server — nobody can log in until it is. See README." });
    }
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Enter your Sleeper username and password." });
    }
    if (isThrottled(username)) {
      return res.status(429).json({ error: "Too many failed attempts for that username — wait a few minutes and try again." });
    }

    const user = isValidUsername(username) ? getUser(username) : null;
    // Always do a real password check (a dummy one when there's no such
    // account) so timing doesn't reveal which usernames exist.
    let passwordOk = false;
    if (user) passwordOk = await verifyPassword(password, user.passwordHash);
    else await burnPasswordCheck(password);

    if (!user || !passwordOk) {
      recordFailure(username);
      return res.status(401).json({ error: "Wrong username or password." });
    }
    if (!user.active) {
      // Only said once the password is right, so it doesn't confirm an account exists to a guesser.
      return res.status(403).json({ error: "Your access has been revoked. Ask the owner to restore it." });
    }

    clearFailures(username);
    touchUserLogin(username);
    const token = newSessionToken(username);
    res.setHeader("Set-Cookie", buildSetCookieHeader(req, token));
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("[auth] Login failed unexpectedly:", err);
    res.status(500).json({ error: "Login failed — check the server logs." });
  }
});

app.post("/api/logout", (req, res) => {
  const token = getSessionToken(req);
  if (token) deleteWebSession(token);
  res.setHeader("Set-Cookie", buildSetCookieHeader(req, null, { clear: true }));
  res.json({ ok: true });
});

// Also returns this user's saved tracked-leagues/week when authenticated —
// the server-side record that makes persistence follow the person across
// devices rather than living in one browser.
app.get("/api/auth/status", (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: publicUser(user), lastSession: getUserState(user.username) });
});

// Change your own password. Needs the current one even though you're
// logged in — a borrowed unlocked phone shouldn't be enough to take over
// the account. Works while a forced change is pending (that's its point).
app.post("/api/account/password", requireSession, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const username = req.user.username;
    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({ error: "Enter your current password." });
    }
    if (isThrottled(username)) {
      return res.status(429).json({ error: "Too many failed attempts — wait a few minutes and try again." });
    }
    // 403, not 401: the session is fine — a 401 would make the client think it was logged out.
    if (!(await verifyPassword(currentPassword, req.user.passwordHash))) {
      recordFailure(username);
      return res.status(403).json({ error: "Current password is incorrect." });
    }
    const problem = validateNewPassword(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (newPassword === currentPassword) return res.status(400).json({ error: "Choose a password different from your current one." });

    clearFailures(username);
    setUserPassword(username, await hashPassword(newPassword), false);
    // Sign out every OTHER device — if someone else had the old password, this cuts them off.
    deleteSessionsForUser(username, getSessionToken(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[auth] Password change failed:", err);
    res.status(500).json({ error: "Couldn't change the password — check the server logs." });
  }
});

/* ---------------- Owner administration (v2.1) ---------------- */
function adminView(user) {
  return {
    username: user.username,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    isEnvOwner: isEnvOwner(user.username),
  };
}

// Resolves :username to an existing user the owner may modify, or replies and returns null.
// `allowSelf` is true only for actions that are harmless on yourself (resetting your own password).
function adminTarget(req, res, { allowSelf = false, protectEnvOwner = true } = {}) {
  const username = normalizeUsername(req.params.username);
  const target = getUser(username);
  if (!target) {
    res.status(404).json({ error: `No user named "${username}".` });
    return null;
  }
  if (!allowSelf && target.username === req.user.username) {
    res.status(400).json({ error: "You can't do that to your own account — it would risk locking you out." });
    return null;
  }
  if (protectEnvOwner && isEnvOwner(target.username)) {
    res.status(400).json({ error: `"${target.username}" is the owner defined by the OWNER_USERNAME setting and can't be changed from inside the app.` });
    return null;
  }
  return target;
}

app.get("/api/admin/users", requireOwner, (req, res) => {
  res.json({ users: listUsers().map(adminView) });
});

app.post("/api/admin/users", requireOwner, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const role = req.body?.role === "owner" ? "owner" : "guest";
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: "Enter a valid Sleeper username (letters, numbers, _ . - only)." });
    }
    if (getUser(username)) return res.status(409).json({ error: `"${username}" already has an account.` });

    let password = req.body?.password;
    if (password === undefined || password === null || password === "") password = generateTempPassword();
    const problem = validateNewPassword(password);
    if (problem) return res.status(400).json({ error: problem });

    // Best-effort check that this really is a Sleeper account (login connects to
    // Sleeper by this username, so a typo would just be a dead account). A Sleeper
    // outage shouldn't block adding someone, so only a definite "no such user" stops it.
    try {
      const sleeperUser = await sleeper.getUser(username);
      if (!sleeperUser) return res.status(404).json({ error: `No Sleeper account named "${username}" — check the spelling.` });
    } catch {
      console.warn(`[admin] Couldn't verify "${username}" against Sleeper (network issue) — adding the account anyway.`);
    }

    createUser({ username, role, passwordHash: await hashPassword(password), mustChangePassword: true });
    res.json({ user: adminView(getUser(username)), temporaryPassword: password });
  } catch (err) {
    console.error("[admin] Create user failed:", err);
    res.status(500).json({ error: "Couldn't create the user — check the server logs." });
  }
});

app.post("/api/admin/users/:username/reset-password", requireOwner, async (req, res) => {
  try {
    const target = adminTarget(req, res, { allowSelf: true, protectEnvOwner: false });
    if (!target) return;
    let password = req.body?.password;
    if (password === undefined || password === null || password === "") password = generateTempPassword();
    const problem = validateNewPassword(password);
    if (problem) return res.status(400).json({ error: problem });

    setUserPassword(target.username, await hashPassword(password), true);
    // Everything they were signed in on ends — except the owner's own current session when resetting themselves.
    deleteSessionsForUser(target.username, target.username === req.user.username ? getSessionToken(req) : null);
    res.json({ user: adminView(getUser(target.username)), temporaryPassword: password });
  } catch (err) {
    console.error("[admin] Reset password failed:", err);
    res.status(500).json({ error: "Couldn't reset the password — check the server logs." });
  }
});

app.post("/api/admin/users/:username/role", requireOwner, (req, res) => {
  const target = adminTarget(req, res);
  if (!target) return;
  const role = req.body?.role;
  if (role !== "owner" && role !== "guest") return res.status(400).json({ error: 'Role must be "owner" or "guest".' });
  setUserRole(target.username, role);
  res.json({ user: adminView(getUser(target.username)) });
});

// Revoke or restore access. Revoking ends their sessions and push alerts at once.
app.post("/api/admin/users/:username/access", requireOwner, (req, res) => {
  const target = adminTarget(req, res);
  if (!target) return;
  const active = Boolean(req.body?.active);
  setUserActive(target.username, active);
  if (!active) {
    deleteSessionsForUser(target.username);
    deletePushSubscriptionsForUser(target.username);
    dropConnectSessionsFor(target.username);
  }
  res.json({ user: adminView(getUser(target.username)) });
});

app.delete("/api/admin/users/:username", requireOwner, (req, res) => {
  const target = adminTarget(req, res);
  if (!target) return;
  deleteUser(target.username);
  dropConnectSessionsFor(target.username);
  res.json({ ok: true });
});

// Everything below this point requires a fully-usable session (logged in
// AND past any forced password change).
app.use("/api/connect", requireAuth);
app.use("/api/leagues", requireAuth);
app.use("/api/faab", requireAuth);
app.use("/api/season-odds", requireAuth);
app.use("/api/rankings", requireAuth);
app.use("/api/push", requireAuth);

// Step 1: the logged-in user's Sleeper account -> their leagues for the
// current season. (v2.1: the username comes from the login, not from a form
// field — everyone can only ever connect to their own Sleeper account.)
app.get("/api/connect", async (req, res) => {
  const username = req.user.username;
  try {
    const user = await sleeper.getUser(username);
    if (!user) return res.status(404).json({ error: `No Sleeper user found named "${username}".` });
    const state = await sleeper.getState();
    const leaguesRaw = await sleeper.getUserLeagues(user.user_id, state.season);
    if (leaguesRaw.length === 0) {
      return res.status(404).json({ error: "That account has no leagues for the current season." });
    }
    const sessionId = newSessionId();
    sessions.set(sessionId, { appUser: username, userId: user.user_id, username, leaguesRaw, week: state.week, builtLeagues: [], trackedLeagueIds: [] });
    res.json({
      sessionId,
      user: { user_id: user.user_id, display_name: user.display_name },
      week: state.week,
      leagues: leaguesRaw.map((l) => ({ league_id: l.league_id, name: l.name, season: l.season })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't reach Sleeper." });
  }
});

// Step 2: build (or rebuild, on refresh, or on a week change) the
// selected leagues with real Sleeper + real ESPN projections + FantasyPros rankings merged in.
app.post("/api/leagues/build", async (req, res) => {
  const { sessionId, leagueIds, week } = req.body || {};
  const session = ownSession(req, res, sessionId);
  if (!session) return;
  if (!Array.isArray(leagueIds) || leagueIds.length === 0) {
    return res.status(400).json({ error: "leagueIds must be a non-empty array." });
  }

  if (Number.isInteger(week) && week >= 1 && week <= 22) {
    session.week = week;
  }
  session.trackedLeagueIds = leagueIds;

  try {
    const chosen = session.leaguesRaw.filter((l) => leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(60, 24);
    const built = [];
    // Sequential, not Promise.all — FantasyPros' free/personal tiers have
    // modest rate limits, and this keeps errors attributable to one league
    // instead of Promise.all's all-or-nothing rejection.
    for (const leagueSummary of chosen) {
      try {
        const league = await buildFullLeague(session.userId, leagueSummary, session.week, trending, session.builtLeagues);
        built.push(league);
        setBuiltLeague(req.user.username, leagueSummary.league_id, league);
      } catch (err) {
        // A live build failing doesn't have to mean an empty screen —
        // if the background scheduler (or a previous successful build)
        // left a cached copy in SQLite, serve that instead, clearly
        // marked as stale, rather than just an error card.
        const cached = getBuiltLeague(req.user.username, leagueSummary.league_id);
        if (cached) {
          built.push({ ...cached.data, stale: true, staleUpdatedAt: cached.updatedAt, dataWarnings: [`Showing cached data from ${new Date(cached.updatedAt).toLocaleString()} — a fresh build just failed: ${err.message}`, ...(cached.data.dataWarnings || [])] });
        } else {
          built.push({ id: leagueSummary.league_id, name: leagueSummary.name, error: err.message });
        }
      }
    }
    session.builtLeagues = built.filter((l) => !l.error);
    setUserState(req.user.username, leagueIds, session.week);
    // The user's drag-ordered Player Rankings override rides along with each
    // league (it's per user, so it's attached here, not stored in the shared build cache).
    const withRankings = built.map((l) => (l.error ? l : { ...l, customRanking: getRankingOrder(req.user.username, l.id) }));
    res.json({ leagues: withRankings, week: session.week });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't build leagues." });
  }
});

// FAAB suggestions for one league's current waiver pool, using bid
// history pooled across every currently-tracked league (see faab.js for
// why "all Sleeper leagues" isn't achievable, and what the percentiles
// below actually mean statistically).
app.post("/api/faab", async (req, res) => {
  const { sessionId, leagueId } = req.body || {};
  const session = ownSession(req, res, sessionId);
  if (!session) return;

  const targetLeague = session.builtLeagues.find((l) => l.id === leagueId);
  if (!targetLeague) return res.status(400).json({ error: "That league hasn't been built yet — refresh the dashboard first." });

  try {
    const trackedIds = session.trackedLeagueIds.length ? session.trackedLeagueIds : [leagueId];
    const fullLeagues = await Promise.all(
      trackedIds.map((id) => sleeper.getLeague(id).catch(() => null))
    );
    const sleeperPlayers = await sleeper.getPlayers();
    const result = await getFaabSuggestions(
      targetLeague.freeAgents || [],
      fullLeagues.filter(Boolean),
      sleeperPlayers,
      session.week
    );
    const thisLeague = fullLeagues.find((l) => l?.league_id === leagueId);
    res.json({ ...result, budget: thisLeague?.settings?.waiver_budget ?? null });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't compute FAAB suggestions." });
  }
});

// Rest-of-season playoff/championship odds via Monte Carlo simulation
// (see simulate.js for the methodology and its documented limitations).
app.post("/api/season-odds", async (req, res) => {
  const { sessionId, leagueId } = req.body || {};
  const session = ownSession(req, res, sessionId);
  if (!session) return;
  try {
    const league = await sleeper.getLeague(leagueId);
    const rosters = await sleeper.getRosters(leagueId);
    const leagueUsers = await sleeper.getLeagueUsers(leagueId);
    const odds = await simulateSeason(rosters, league, session.week, sleeper.getMatchups, leagueId);
    const withLabels = odds.map((o) => {
      const roster = rosters.find((r) => r.roster_id === o.rosterId);
      const owner = leagueUsers.find((u) => u.user_id === roster?.owner_id);
      const isMe = roster?.owner_id === session.userId;
      const label = isMe ? "Your Team" : roster?.metadata?.team_name || owner?.metadata?.team_name || owner?.display_name || `Roster #${o.rosterId}`;
      return { ...o, label, isMe };
    });
    withLabels.sort((a, b) => b.championshipPct - a.championshipPct);
    res.json({ odds: withLabels });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't compute season odds." });
  }
});

/* ---------------- Web Push subscription management (pre-kickoff alerts) ---------------- */
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: getPublicKey(), configured: isPushConfigured() });
});

app.post("/api/push/subscribe", (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: "A valid push subscription is required." });
  saveSubscription(req.user.username, subscription);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) removeSubscription(endpoint);
  res.json({ ok: true });
});

/* ---------------- Player Rankings override (v2.1) ---------------- */
// Saves the user's drag-ordered ranking for one league (an array of player
// keys, best first), or clears it (order: null) to go back to the suggested
// order. Stored per user per league, so it follows them across devices.
app.post("/api/rankings", (req, res) => {
  const { leagueId, order } = req.body || {};
  if (typeof leagueId !== "string" || !/^[0-9A-Za-z_-]{1,40}$/.test(leagueId)) {
    return res.status(400).json({ error: "A valid leagueId is required." });
  }
  if (order !== null) {
    const valid = Array.isArray(order) && order.length <= 500 && order.every((k) => typeof k === "string" && k.length > 0 && k.length <= 120);
    if (!valid) return res.status(400).json({ error: "order must be an array of player keys, or null to reset." });
  }
  setRankingOrder(req.user.username, leagueId, order);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
// Make sure the owner account exists before accepting any requests.
await ensureOwnerFromEnv();
app.listen(PORT, () => {
  console.log(`Fantasy manager server listening on http://localhost:${PORT}`);
  if (!process.env.FANTASYPROS_API_KEY || process.env.FANTASYPROS_API_KEY === "your_key_here") {
    console.warn("⚠️  FANTASYPROS_API_KEY is not set — copy server/.env.example to server/.env and add your key.");
  }
  if (!isPushConfigured()) {
    console.warn("⚠️  VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set — pre-kickoff push alerts are disabled until they are. See README.");
  }
  startScheduler();
});
