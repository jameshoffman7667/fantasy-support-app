// Every call here goes to our own backend (proxied at /api by Vite in
// dev). The client never holds, sends, or sees the FantasyPros key.

async function request(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function connect(username) {
  return request(`/api/connect?username=${encodeURIComponent(username)}`);
}

export function buildLeagues(sessionId, leagueIds, week) {
  return request(`/api/leagues/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, leagueIds, week }),
  });
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
export function login(password) {
  return request(`/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export function logout() {
  return request(`/api/logout`, { method: "POST" });
}

export function getAuthStatus() {
  return request(`/api/auth/status`);
}
