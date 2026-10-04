// Every call here goes to our own backend (proxied at /api by Vite in
// dev). The client never holds, sends, or sees the FantasyPros key.

// Raised (as a window event) when a request that should have been logged-in
// comes back 401 — the session ended, or the owner revoked this user's access.
// App.jsx listens and sends the person back to the login screen. The login and
// status calls are exempt: a 401 there just means "wrong password"/"not logged in".
const UNAUTH_EXEMPT = ["/api/login", "/api/auth/status"];

async function request(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !UNAUTH_EXEMPT.some((p) => path.startsWith(p))) {
    window.dispatchEvent(new Event("fm-unauthorized"));
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const jsonPost = (path, payload) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) });

// The logged-in user's own Sleeper account — the server knows who they are.
export function connect() {
  return request(`/api/connect`);
}

// v2.9: `leagueIds` = build these now; `trackedIds` = the full tracked list to remember.
export function buildLeagues(sessionId, leagueIds, week, trackedIds) {
  return request(`/api/leagues/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, leagueIds, week, trackedIds }),
  });
}

// v2.9: the last saved build of every tracked league, instantly (no Sleeper calls).
export function getCachedLeagues() {
  return request(`/api/leagues/cached`);
}

export function getFaabSuggestions(sessionId, leagueId) {
  return request(`/api/faab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, leagueId }),
  });
}

// Cookies are sent automatically for these same-origin requests in every
// deployment mode this app ships (Vite dev proxy, nginx production), so
// no explicit `credentials` option is needed.
// Cookies are sent automatically for these same-origin requests in every
// deployment mode this app ships (Vite dev proxy, nginx production), so
// no explicit `credentials` option is needed.
export function login(username, password) {
  return jsonPost(`/api/login`, { username, password });
}

export function logout() {
  return request(`/api/logout`, { method: "POST" });
}

export function getAuthStatus() {
  return request(`/api/auth/status`);
}

export function getSeasonOdds(sessionId, leagueId) {
  return request(`/api/season-odds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, leagueId }),
  });
}

export function getPushPublicKey() {
  return request(`/api/push/vapid-public-key`);
}

export function subscribePush(subscription) {
  return request(`/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
}

export function unsubscribePush(endpoint) {
  return request(`/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function changePassword(currentPassword, newPassword) {
  return jsonPost(`/api/account/password`, { currentPassword, newPassword });
}

// Saves the drag-ordered Player Rankings for one league; order === null resets it.
export function saveRanking(leagueId, order) {
  return jsonPost(`/api/rankings`, { leagueId, order });
}

/* ---------------- Owner administration ---------------- */
export function adminListUsers() {
  return request(`/api/admin/users`);
}
export function adminCreateUser(username, role, password) {
  return jsonPost(`/api/admin/users`, { username, role, password });
}
export function adminResetPassword(username, password) {
  return jsonPost(`/api/admin/users/${encodeURIComponent(username)}/reset-password`, { password });
}
export function adminSetRole(username, role) {
  return jsonPost(`/api/admin/users/${encodeURIComponent(username)}/role`, { role });
}
export function adminSetAccess(username, active) {
  return jsonPost(`/api/admin/users/${encodeURIComponent(username)}/access`, { active });
}
export function adminDeleteUser(username) {
  return request(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" });
}

/* ---------------- Projection accuracy + history backfill (v2.5) ---------------- */
export function getAccuracy(params) {
  return request(`/api/accuracy?${new URLSearchParams(params)}`);
}
export function adminBackfillStatus() {
  return request(`/api/admin/backfill`);
}
export function adminStartBackfill() {
  return jsonPost(`/api/admin/backfill`, {});
}

/* ---------------- Game Day + source status (v2.6) ---------------- */
export function getGameDay(week) {
  return request(`/api/gameday${week ? `?week=${week}` : ""}`);
}
export function saveGameDaySettings(settings) {
  return jsonPost(`/api/gameday/settings`, settings);
}
export function getSourceStatus() {
  return request(`/api/status/sources`);
}

/* ---------------- Pick'em (v2.7) ---------------- */
export function getPickem() {
  return request(`/api/pickem`);
}
export function savePickemSettings(settings) {
  return jsonPost(`/api/pickem/settings`, settings);
}
export function markPickemSeen(season, week, gameKey) {
  return jsonPost(`/api/pickem/seen`, { season, week, gameKey });
}

/* ---------------- Matchups, weather, images (v2.8) ---------------- */
export function getDvp(params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  return request(`/api/dvp${q.toString() ? `?${q}` : ""}`);
}
export function getDvpDetail(params) {
  return request(`/api/dvp/detail?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""))}`);
}
export function saveDvpSettings(settings) {
  return jsonPost(`/api/dvp/settings`, settings);
}
export function getWeather(week) {
  return request(`/api/weather${week ? `?week=${week}` : ""}`);
}
export function getWeatherSettings() {
  return request(`/api/weather/settings`);
}
export function saveWeatherSettings(settings) {
  return jsonPost(`/api/weather/settings`, settings);
}
export const playerImageUrl = (id) => `/api/img/player/${encodeURIComponent(id)}`;
export const teamLogoUrl = (team) => `/api/img/team/${encodeURIComponent(team)}`;

/* ---------------- Variance report (v2.8.1) ---------------- */
export function getVarianceAcks() {
  return request(`/api/variances/acks`);
}
export function ackVariances(keys) {
  return jsonPost(`/api/variances/ack`, { keys });
}
export function pruneVarianceAcks(leagueIds, week, present) {
  return jsonPost(`/api/variances/prune`, { leagueIds, week, present });
}

/* ---------------- Waiver plan + trade advice (v2.9) ---------------- */
export function getWaiverPlan(leagueId) {
  return request(`/api/waiver-plan?leagueId=${encodeURIComponent(leagueId)}`);
}
export function saveWaiverPlan(leagueId, plan) {
  return jsonPost(`/api/waiver-plan`, { leagueId, plan });
}
export function getTradeAdvice(sessionId, leagueId, force = false) {
  return jsonPost(`/api/trade/advice`, { sessionId, leagueId, force });
}

/* ---------------- Sleeper private access (v3.0) — the token itself never comes back to the browser ---------------- */
export function getPrivateStatus() {
  return request(`/api/private/status`);
}
export function setPrivateToken(token) {
  return jsonPost(`/api/private/token`, { token });
}
export function clearPrivateToken() {
  return jsonPost(`/api/private/token/clear`, {});
}
export function setPrivateWrites(enabled) {
  return jsonPost(`/api/private/writes`, { enabled });
}
export function setPrivatePerms(patch) {
  return jsonPost(`/api/private/perms`, patch);
}
export function withdrawTrade(leagueId, transactionId, leg) {
  return jsonPost(`/api/private/withdraw-trade`, { leagueId, transactionId, leg, confirm: true });
}
export function rejectTrade(leagueId, transactionId, leg) {
  return jsonPost(`/api/private/reject-trade`, { leagueId, transactionId, leg, confirm: true });
}
export function pushLineup(leagueId, starters, marks = {}) {
  return jsonPost(`/api/private/lineup`, { leagueId, starters, confirm: true, gap: marks.gap, keys: marks.keys });
}
export function pushReserve(leagueId, reserve) {
  return jsonPost(`/api/private/reserve`, { leagueId, reserve, confirm: true });
}
export function pushClaim(leagueId, claim, marks = {}) {
  return jsonPost(`/api/private/claim`, { leagueId, addId: claim.addId, dropId: claim.dropId || null, bid: claim.bid, confirm: true, keys: marks.keys });
}
export function cancelClaim(leagueId, transactionId) {
  return jsonPost(`/api/private/claim/cancel`, { leagueId, transactionId, confirm: true });
}
