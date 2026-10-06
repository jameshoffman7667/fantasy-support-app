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
  cacheGet,
  cacheSet,
} from "./db.js";
import { startScheduler } from "./scheduler.js";
import { computeAccuracy } from "./accuracy.js";
import * as backfill from "./backfill.js";
import * as gameday from "./gameday.js";
import * as pickem from "./pickem.js";
import * as cbs from "./cbs.js";
import * as performance from "./performance.js";
import * as dvp from "./dvp.js";
import * as weather from "./weather.js";
import { getImage } from "./images.js";
import * as varianceAcks from "./varianceAcks.js";
import * as priv from "./sleeperPrivate.js";
import * as privateData from "./privateData.js";
import * as playerCard from "./playerCard.js"; // v3.5
import * as waiverPlan from "./waiverPlan.js";
import * as faabDb from "./faabDb.js"; // v3.7: FAAB database, opponent bid report, waiver simulator
import * as gemini from "./gemini.js";
import * as tank01 from "./tank01.js";
import { getLastSummary } from "./projectionHub.js";
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
      const sleeperUser = await sleeper.getUser(username, { fresh: true });
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
app.use("/api/accuracy", requireAuth);
app.use("/api/gameday", requireAuth);
app.use("/api/pickem", requireAuth);
app.use("/api/status", requireAuth);
app.use("/api/push", requireAuth);
app.use("/api/dvp", requireAuth);
app.use("/api/weather", requireAuth);
app.use("/api/img", requireAuth);
app.use("/api/variances", requireAuth);
app.use("/api/waiver-plan", requireAuth);
app.use("/api/private", requireAuth);
app.use("/api/trade", requireAuth);
app.use("/api/player-card", requireAuth); // v3.5

// Step 1: the logged-in user's Sleeper account -> their leagues for the
// current season. (v2.1: the username comes from the login, not from a form
// field — everyone can only ever connect to their own Sleeper account.)
app.get("/api/connect", async (req, res) => {
  const username = req.user.username;
  try {
    const user = await sleeper.getUser(username, { fresh: true }); // R14: login/reconnect is when the id is looked up
    if (!user) return res.status(404).json({ error: `No Sleeper user found named "${username}".` });
    const state = await sleeper.getState();
    const leaguesRaw = await sleeper.getUserLeagues(user.user_id, state.season, { fresh: true });
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

// v2.9: the last saved build for the user's tracked leagues, straight from
// SQLite — no Sleeper calls — so the app can paint instantly at open while
// the live build runs in the background.
app.get("/api/leagues/cached", (req, res) => {
  const username = req.user.username;
  const st = getUserState(username);
  if (!st || !st.leagueIds.length) return res.json({ leagues: [], week: null, leagueIds: [] });
  const leagues = [];
  for (const id of st.leagueIds) {
    const c = getBuiltLeague(username, id);
    if (c) leagues.push({ ...c.data, customRanking: getRankingOrder(username, id), fromCache: true, cachedAt: c.updatedAt });
  }
  privateData.attach(username, leagues, { live: false }).then(
    (withPrivate) => res.json({ leagues: withPrivate, week: leagues[0]?.week ?? st.week ?? null, leagueIds: st.leagueIds }),
    () => res.json({ leagues, week: leagues[0]?.week ?? st.week ?? null, leagueIds: st.leagueIds })
  );
});

// Step 2: build (or rebuild, on refresh, or on a week change) the
// selected leagues with real Sleeper + real Sleeper/ESPN projections + FantasyPros rankings merged in.
// v2.9: `leagueIds` are the leagues to build NOW (the client can ask for one
// at a time and show each as it arrives); `trackedIds` is the full tracked
// list to remember (defaults to leagueIds). Results are merged into the
// session, not replaced.
app.post("/api/leagues/build", async (req, res) => {
  const { sessionId, leagueIds, week, trackedIds, manual } = req.body || {};
  const session = ownSession(req, res, sessionId);
  if (!session) return;
  if (!Array.isArray(leagueIds) || leagueIds.length === 0) {
    return res.status(400).json({ error: "leagueIds must be a non-empty array." });
  }

  if (Number.isInteger(week) && week >= 1 && week <= 22) {
    session.week = week;
  }
  const tracked = Array.isArray(trackedIds) && trackedIds.length ? trackedIds : leagueIds;
  session.trackedLeagueIds = tracked;

  try {
    const chosen = session.leaguesRaw.filter((l) => leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(200, 24);
    const built = [];
    // Sequential within one request — FantasyPros' free/personal tiers have
    // modest rate limits, and this keeps errors attributable to one league.
    for (const leagueSummary of chosen) {
      try {
        const league = await buildFullLeague(session.userId, leagueSummary, session.week, trending, session.builtLeagues);
        built.push(league);
        setBuiltLeague(req.user.username, leagueSummary.league_id, league);
        performance.record(req.user.username, league); // v3.3
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
    const keep = (session.builtLeagues || []).filter((l) => !leagueIds.includes(l.id));
    session.builtLeagues = [...keep, ...built.filter((l) => !l.error)];
    setUserState(req.user.username, tracked, session.week);
    // The user's drag-ordered Player Rankings override rides along with each
    // league (it's per user, so it's attached here, not stored in the shared build cache).
    const withRankings = built.map((l) => (l.error ? l : { ...l, customRanking: getRankingOrder(req.user.username, l.id) }));
    // v3.0: per-user private data (trade offers, pending claims, settings log) — only when a token is set up.
    // v3.5: a manual refresh (the refresh button) re-reads trade offers and pending claims even within the 6-hour snapshot.
    const withPrivate = await privateData.attach(req.user.username, withRankings, { live: true, force: manual === true }).catch((e) => {
      console.warn(`[private] attach failed: ${e.message}`);
      return withRankings;
    });
    res.json({ leagues: withPrivate, week: session.week });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't build leagues." });
  }
});

/* ---------------- Waiver plan (v2.9): bids, drop ranking, claim edits ---------------- */
app.get("/api/waiver-plan", (req, res) => {
  const leagueId = String(req.query.leagueId || "");
  if (!leagueId) return res.status(400).json({ error: "leagueId is required." });
  res.json(waiverPlan.getPlan(req.user.username, leagueId));
});
app.post("/api/waiver-plan", (req, res) => {
  const leagueId = String(req.body?.leagueId || "");
  if (!leagueId) return res.status(400).json({ error: "leagueId is required." });
  res.json(waiverPlan.savePlan(req.user.username, leagueId, req.body?.plan));
});


/* ---------------- Sleeper private API (v3.0): token, trade reject, lineup / claim pushes ---------------- */
const privError = (res, e) => {
  const code = { no_token: 400, writes_off: 403, unconfirmed: 400, invalid: 400, unauthorized: 401, network: 502, bad_response: 502, http: 502, graphql: 502 }[e.kind] || 500;
  // A Sleeper "unauthorized" means THEIR token expired — not our session — so it must not look like a logout (401 → 409).
  res.status(e.kind === "unauthorized" ? 409 : code).json({ error: e.message || "Sleeper request failed.", kind: e.kind || "error" });
};
// The league must be one of the caller's own tracked leagues; the roster id always comes from OUR build, never the client.
function ownBuilt(req, res, leagueId) {
  const c = getBuiltLeague(req.user.username, String(leagueId || ""));
  if (!c?.data?.myRosterId) {
    res.status(400).json({ error: "That league isn't one of your tracked leagues (or hasn't been built yet)." });
    return null;
  }
  return c.data;
}
app.get("/api/private/status", (req, res) => {
  res.json({ ...priv.status(req.user.username), log: priv.writeLog(req.user.username, 20) });
});
app.post("/api/private/token", async (req, res) => {
  try {
    res.json(await priv.setToken(req.user.username, req.body?.token));
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/token/clear", (req, res) => res.json(priv.clearToken(req.user.username)));
app.post("/api/private/writes", (req, res) => {
  try {
    res.json(priv.setWritesEnabled(req.user.username, req.body?.enabled === true));
  } catch (e) {
    privError(res, e);
  }
});
// v3.1: per-group switches. Body: any of { reads, roster, claims, trades } as booleans.
app.post("/api/private/perms", (req, res) => {
  try {
    res.json(priv.setPerms(req.user.username, req.body || {}));
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/reject-trade", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    res.json(await priv.rejectTrade(req.user.username, { leagueId: lg.id, transactionId: req.body?.transactionId, leg: Number(req.body?.leg ?? lg.week), confirm: req.body?.confirm }));
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/withdraw-trade", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    res.json(await priv.withdrawTrade(req.user.username, { leagueId: lg.id, transactionId: req.body?.transactionId, leg: Number(req.body?.leg ?? lg.week), confirm: req.body?.confirm }));
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/lineup", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    const out = await priv.updateStarters(req.user.username, { leagueId: lg.id, rosterId: lg.myRosterId, round: Number(lg.week), starters: req.body?.starters, confirm: req.body?.confirm });
    if (out?.ok) privateData.recordPush(req.user.username, lg.id, "lineup", { week: lg.week, gap: req.body?.gap, keys: req.body?.keys });
    res.json(out);
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/reserve", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    res.json(await priv.updateReserve(req.user.username, { leagueId: lg.id, rosterId: lg.myRosterId, reserve: req.body?.reserve, confirm: req.body?.confirm }));
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/claim", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    const out = await priv.submitClaim(req.user.username, { leagueId: lg.id, rosterId: lg.myRosterId, leg: Number(lg.week), addId: req.body?.addId, dropId: req.body?.dropId, bid: req.body?.bid, confirm: req.body?.confirm });
    if (out?.ok) privateData.recordPush(req.user.username, lg.id, "waiver", { keys: req.body?.keys });
    res.json(out);
  } catch (e) {
    privError(res, e);
  }
});
app.post("/api/private/claim/cancel", async (req, res) => {
  const lg = ownBuilt(req, res, req.body?.leagueId);
  if (!lg) return;
  try {
    res.json(await priv.cancelClaim(req.user.username, { leagueId: lg.id, transactionId: req.body?.transactionId, leg: Number(lg.week), confirm: req.body?.confirm }));
  } catch (e) {
    privError(res, e);
  }
});

/* ---------------- Trade advice (v2.9): Gemini news check on Trade Finder swaps ---------------- */
app.post("/api/trade/advice", async (req, res) => {
  const { sessionId, leagueId, force, cacheOnly } = req.body || {};
  const session = ownSession(req, res, sessionId);
  if (!session) return;
  const lg = (session.builtLeagues || []).find((l) => l.id === leagueId);
  if (!lg) return res.status(400).json({ error: "That league hasn't been built yet — refresh first." });
  if (!gemini.isConfigured()) return res.json({ configured: false, byKey: {}, sources: [] });
  const items = (lg.tradeFinder || []).slice(0, 10).map((t) => ({
    key: `${t.give.name} > ${t.get.name}`,
    give: { name: t.give.name, pos: t.give.pos },
    get: { name: t.get.name, pos: t.get.pos },
  }));
  try {
    const out = await gemini.tradeNews(lg.season || new Date().getFullYear(), lg.week, items, { force: Boolean(force), cacheOnly: Boolean(cacheOnly) });
    res.json({ configured: true, at: out?.at ?? null, byKey: out?.byKey ?? {}, sources: out?.sources ?? [] });
  } catch (err) {
    res.json({ configured: true, error: err.message, byKey: {}, sources: [] });
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
    const thisLeagueRaw = fullLeagues.find((l) => l?.league_id === leagueId);
    const result = await getFaabSuggestions(
      targetLeague.freeAgents || [],
      fullLeagues.filter(Boolean),
      sleeperPlayers,
      session.week,
      { leagueType: thisLeagueRaw ? faabDb.leagueTypeOf(thisLeagueRaw) : null, season: Number(thisLeagueRaw?.season) || null } // v3.7: + the FAAB database
    );
    const thisLeague = fullLeagues.find((l) => l?.league_id === leagueId);
    res.json({ ...result, budget: thisLeague?.settings?.waiver_budget ?? null });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't compute FAAB suggestions." });
  }
});

/* ---------------- v3.7: FAAB database, opponent bid report, waiver simulator ---------------- */
const trackedLeague = (req, res, leagueId) => {
  const ids = getUserState(req.user.username)?.leagueIds || [];
  if (!leagueId || !ids.includes(String(leagueId))) {
    res.status(404).json({ error: "That league isn't one of your tracked leagues." });
    return false;
  }
  return true;
};
app.get("/api/faab/report", async (req, res) => {
  const leagueId = String(req.query.leagueId || "");
  if (!trackedLeague(req, res, leagueId)) return;
  try {
    const st = await sleeper.getState();
    const [league, rosters, users, players, me] = await Promise.all([
      sleeper.getLeague(leagueId),
      sleeper.getRosters(leagueId),
      sleeper.getLeagueUsers(leagueId),
      sleeper.getPlayers(),
      sleeper.getUser(req.user.username).catch(() => null),
    ]);
    if (!faabDb.isFaab(league)) return res.json({ faab: false });
    res.json({ faab: true, ...faabDb.buildReport(req.user.username, { league, rosters, users, myUserId: me?.user_id, players, season: Number(st.season), week: Number(st.week) }) });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't build the bid report." });
  }
});
app.get("/api/faab/claims", async (req, res) => {
  const ownerId = String(req.query.ownerId || "");
  if (!/^\d{1,25}$/.test(ownerId)) return res.status(400).json({ error: "ownerId is required." });
  try {
    res.json({ claims: faabDb.ownerClaims(ownerId, { players: await sleeper.getPlayers() }) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/faab/settings", (req, res) => {
  const b = req.body || {};
  if (b.waiverTime?.leagueId && !trackedLeague(req, res, String(b.waiverTime.leagueId))) return;
  res.json(faabDb.saveSettings(req.user.username, { reportEnabled: typeof b.reportEnabled === "boolean" ? b.reportEnabled : undefined, waiverTime: b.waiverTime }));
});
app.post("/api/faab/collect", async (req, res) => {
  const leagueId = String(req.body?.leagueId || "");
  if (!trackedLeague(req, res, leagueId)) return;
  const k = `faab:manual:${leagueId}`;
  const last = cacheGet(k);
  if (last) return res.status(429).json({ error: "Collected less than 10 minutes ago — try again shortly." });
  cacheSet(k, Date.now(), 10 * 60 * 1000);
  try {
    res.json(await faabDb.collect(req.user.username, leagueId, { reason: "Collect now" }));
  } catch (err) {
    res.status(502).json({ error: err.message || "Collection failed." });
  }
});
app.post("/api/faab/simulate", async (req, res) => {
  const b = req.body || {};
  const leagueId = String(b.leagueId || "");
  if (!trackedLeague(req, res, leagueId)) return;
  const claims = (Array.isArray(b.claims) ? b.claims : []).slice(0, 60).map((c, i) => ({ key: String(c.key ?? i).slice(0, 100), addId: String(c.addId ?? ""), bid: Math.max(0, Math.round(Number(c.bid) || 0)), dropId: c.dropId != null && c.dropId !== "" ? String(c.dropId) : null })).filter((c) => c.addId);
  try {
    const st = await sleeper.getState();
    const [league, rosters, players, me, trending] = await Promise.all([sleeper.getLeague(leagueId), sleeper.getRosters(leagueId), sleeper.getPlayers(), sleeper.getUser(req.user.username).catch(() => null), sleeper.getTrendingAdds(200, 24).catch(() => [])]);
    if (!faabDb.isFaab(league)) return res.json({ faab: false });
    const budget = Number(league.settings.waiver_budget) || 0;
    const mine = rosters.find((r) => String(r.owner_id) === String(me?.user_id));
    const remaining = Math.max(0, budget - (Number(mine?.settings?.waiver_budget_used) || 0));
    const opponentsLeft = rosters.filter((r) => r !== mine).map((r) => Math.max(0, budget - (Number(r.settings?.waiver_budget_used) || 0)));
    const leagueType = faabDb.leagueTypeOf(league);
    const trendBy = new Map((trending || []).map((t) => [String(t.player_id), Number(t.count) || 0]));
    const lf = faabDb.leagueFactor({ leagueId, leagueType, season: Number(st.season) });
    const refFor = (pid) => faabDb.playerReference({ playerId: pid, pos: players?.[pid]?.position, leagueType, season: Number(st.season), week: Number(st.week), trendCount: trendBy.get(String(pid)) || 0, excludeLeagueId: leagueId });
    const sim = faabDb.simulateClaims({ claims, budget, remaining, openSpots: Math.max(0, Number(b.openSpots) || 0), opponentsLeft, refFor, leagueFactor: lf.factor, trials: 2000 });
    const threats = (bid) => rosters.filter((r) => r !== mine && budget - (Number(r.settings?.waiver_budget_used) || 0) >= bid).length;
    res.json({ faab: true, budget, remaining, leagueFactor: lf, ...sim, results: sim.results.map((r) => ({ ...r, canOutbid: threats(claims.find((c) => c.key === r.key)?.bid ?? 0) })) });
  } catch (err) {
    res.status(502).json({ error: err.message || "Simulation failed." });
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
/* ---------------- Projection accuracy (v2.5) ---------------- */
app.get("/api/accuracy", (req, res) => {
  try {
    const q = req.query || {};
    const result = computeAccuracy({
      profile: q.profile || undefined,
      season: Number(q.season) || new Date().getFullYear(),
      weekFrom: Number(q.weekFrom) || 1,
      weekTo: Number(q.weekTo) || 18,
      // v2.9: multi-select positions as "QB,RB" ("ALL" or empty = every fantasy position)
      positions: q.positions && q.positions !== "ALL" ? String(q.positions).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined,
      sameOnly: q.sameOnly === "1" || q.sameOnly === "true",
      adjusted: q.adjusted === "1" || q.adjusted === "true",
    });
    res.json(result);
  } catch (err) {
    console.error("[accuracy] failed:", err);
    res.status(500).json({ error: "Couldn't compute accuracy — check the server logs." });
  }
});

/* ---------------- Game Day (v2.6) ---------------- */
app.get("/api/gameday", async (req, res) => {
  try {
    res.json(await gameday.getGameDay(req.user.username, { week: req.query.week }));
  } catch (err) {
    console.error("[gameday] failed:", err);
    res.status(502).json({ error: err.message || "Couldn't load Game Day." });
  }
});
app.get("/api/gameday/settings", (req, res) => res.json(gameday.getSettings(req.user.username)));
app.post("/api/gameday/settings", (req, res) => res.json(gameday.saveSettings(req.user.username, req.body || {})));

/* ---------------- Pick'em (v2.7) ---------------- */
app.get("/api/pickem", async (req, res) => {
  try {
    res.json(await pickem.getPickem(req.user.username));
  } catch (err) {
    console.error("[pickem] failed:", err);
    res.status(502).json({ error: err.message || "Couldn't load Pick'em." });
  }
});
app.get("/api/pickem/performance", async (req, res) => {
  try {
    res.json(await pickem.getPerformance(req.user.username));
  } catch (err) {
    console.error("[pickem] performance failed:", err);
    res.status(502).json({ error: err.message || "Couldn't load Pick'em performance." });
  }
});
app.post("/api/pickem/choice", async (req, res) => {
  try {
    const st = await sleeper.getState();
    const season = Number(req.body?.season || st.season);
    const week = Number(req.body?.week || st.week);
    res.json(pickem.saveChoice(req.user.username, season, week, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- My performance (v3.3) ---------------- */
/* ---------------- Player card (v3.5) ---------------- */
app.get("/api/player-card", async (req, res) => {
  const id = String(req.query.id || "");
  if (!/^[A-Za-z0-9_]{1,20}$/.test(id)) return res.status(400).json({ error: "A player id is required." });
  const leagueId = req.query.leagueId ? String(req.query.leagueId) : null;
  // Only one of the caller's own tracked leagues may be used as context.
  const tracked = getUserState(req.user.username)?.leagueIds || [];
  try {
    res.json(await playerCard.getPlayerCard(req.user.username, id, { leagueId: leagueId && tracked.includes(leagueId) ? leagueId : null }));
  } catch (err) {
    console.error("[player-card] failed:", err);
    res.status(err.status || 502).json({ error: err.message || "Couldn't load the player card." });
  }
});

app.get("/api/performance", requireAuth, async (req, res) => {
  try {
    const st = await sleeper.getState();
    res.json(await performance.report(req.user.username, { season: Number(req.query.season) || Number(st.season), leagueId: req.query.leagueId || null }));
  } catch (err) {
    console.error("[performance] failed:", err);
    res.status(502).json({ error: err.message || "Couldn't build the performance report." });
  }
});

/* ---------------- CBS pick'em push (v3.2) ---------------- */
app.use("/api/cbs", requireAuth);
const cbsError = (res, e) => res.status(e instanceof cbs.CbsError ? 400 : 502).json({ error: e.message });
app.get("/api/cbs/status", (req, res) => res.json({ ...cbs.status(req.user.username), log: cbs.getLog(req.user.username) }));
app.post("/api/cbs/account", (req, res) => {
  try {
    res.json(cbs.setAccount(req.user.username, req.body || {}));
  } catch (e) {
    cbsError(res, e);
  }
});
app.post("/api/cbs/account/clear", (req, res) => res.json(cbs.clearAccount(req.user.username)));
app.post("/api/cbs/settings", (req, res) => {
  try {
    res.json(cbs.saveSettings(req.user.username, req.body || {}));
  } catch (e) {
    cbsError(res, e);
  }
});
app.post("/api/cbs/login-test", async (req, res) => res.json(await cbs.testLogin(req.user.username)));
app.post("/api/cbs/push", async (req, res) => {
  try {
    const b = req.body || {};
    const dryRun = b.dryRun === true;
    if (!dryRun && b.confirm !== true) return res.status(400).json({ error: "Pushing needs an explicit confirm." });
    res.json(await cbs.pushForUser(req.user.username, { mode: "manual", dryRun, poolIds: Array.isArray(b.poolIds) ? b.poolIds : null }));
  } catch (e) {
    cbsError(res, e);
  }
});
app.post("/api/pickem/settings", (req, res) => res.json(pickem.saveSettings(req.user.username, req.body || {})));
app.post("/api/pickem/seen", (req, res) => {
  const { season, week, gameKey } = req.body || {};
  pickem.markSeen(req.user.username, Number(season), Number(week), gameKey || null);
  res.json({ ok: true });
});

/* ---------------- Matchup difficulty (v2.8) ---------------- */
app.get("/api/dvp", async (req, res) => {
  try {
    res.json(await dvp.getTable(req.user.username, { profile: req.query.profile, mode: req.query.mode, adjusted: req.query.adjusted }));
  } catch (err) {
    console.error("[dvp] failed:", err);
    res.status(502).json({ error: err.message || "Couldn't load matchup rankings." });
  }
});
app.get("/api/dvp/detail", async (req, res) => {
  try {
    const { profile, side, team, pos, mode, adjusted } = req.query;
    res.json(await dvp.getDetail(req.user.username, { profile, side: side === "off" ? "off" : "def", team, pos, mode, adjusted }));
  } catch (err) {
    res.status(400).json({ error: err.message || "Couldn't load that matchup." });
  }
});
app.get("/api/dvp/settings", (req, res) => res.json(dvp.getSettings(req.user.username)));
app.post("/api/dvp/settings", (req, res) => res.json(dvp.saveSettings(req.user.username, req.body || {})));

/* ---------------- Variance report: cleared minors (v2.8.1) ---------------- */
app.get("/api/variances/acks", (req, res) => res.json({ keys: varianceAcks.getAcks(req.user.username) }));
app.post("/api/variances/ack", (req, res) => res.json({ keys: varianceAcks.addAcks(req.user.username, req.body?.keys) }));
app.post("/api/variances/prune", (req, res) => {
  const { leagueIds, week, present } = req.body || {};
  res.json({ keys: varianceAcks.prune(req.user.username, { leagueIds, week, present }) });
});

/* ---------------- Weather (v2.8) ---------------- */
app.get("/api/weather", async (req, res) => {
  try {
    const nfl = await sleeper.getState();
    const week = Number(req.query.week) || Number(nfl.week);
    const w = await weather.getWeekWeather(nfl.season, week);
    res.json({ season: Number(nfl.season), week, games: w.games, settings: w.settings });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't load the weather." });
  }
});
app.get("/api/weather/settings", (req, res) => res.json(weather.getSettings()));
app.post("/api/weather/settings", requireOwner, (req, res) => res.json(weather.saveSettings(req.body || {})));

/* ---------------- Headshots & logos (v2.8, cached) ---------------- */
app.get("/api/img/:kind/:id", async (req, res) => {
  try {
    const img = await getImage(req.params.kind, req.params.id);
    if (!img) return res.status(404).end();
    res.set("Content-Type", img.type);
    res.set("Cache-Control", "private, max-age=604800");
    res.send(img.buf);
  } catch {
    res.status(404).end();
  }
});

/* ---------------- Data-source status (v2.6) ---------------- */
// What the projections are actually coming from right now — replaces the
// old fixed "Vegas + Tank01/Sleeper/ESPN (live)" text in the header.
app.get("/api/status/sources", async (req, res) => {
  const last = getLastSummary();
  res.json({ projections: last, tank01: last ? tank01.weekStatus(last.season, last.week) : { configured: tank01.isConfigured(), callsThisMonth: tank01.callsThisMonth() } });
});

/* ---------------- History backfill (v2.5, owner only) ---------------- */
app.get("/api/admin/backfill", requireOwner, (req, res) => {
  res.json(backfill.getStatus());
});
app.post("/api/admin/backfill", requireOwner, (req, res) => {
  if (backfill.isRunning()) return res.json({ started: false, message: "A backfill is already running.", status: backfill.getStatus() });
  backfill.startBatch(1, { budget: "full", reason: `started by ${req.user.username}` });
  res.json({ started: true, status: backfill.getStatus() });
});

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
