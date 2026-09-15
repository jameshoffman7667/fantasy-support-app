const SLEEPER_BASE = "https://api.sleeper.app/v1";

async function sleeperFetch(path) {
  const res = await fetch(`${SLEEPER_BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} on ${path}`);
  return res.json();
}

export function getUser(username) {
  return sleeperFetch(`/user/${encodeURIComponent(username)}`);
}
export function getState() {
  return sleeperFetch(`/state/nfl`);
}
export function getUserLeagues(userId, season) {
  return sleeperFetch(`/user/${userId}/leagues/nfl/${season}`);
}
export function getLeague(leagueId) {
  return sleeperFetch(`/league/${leagueId}`);
}
export function getRosters(leagueId) {
  return sleeperFetch(`/league/${leagueId}/rosters`);
}
export function getTrendingAdds(limit = 60, lookbackHours = 24) {
  return sleeperFetch(`/players/nfl/trending/add?lookback_hours=${lookbackHours}&limit=${limit}`);
}

// ~5MB dictionary of every NFL player. Sleeper's own docs ask integrators
// not to poll this more than once a day, so it's cached in the running
// process instead of being refetched on every request. Restarting the
// server clears the cache — that's fine, player data barely changes.
let _playersCache = null;
let _playersCacheAt = 0;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export async function getPlayers() {
  if (_playersCache && Date.now() - _playersCacheAt < ONE_DAY_MS) return _playersCache;
  _playersCache = await sleeperFetch(`/players/nfl`);
  _playersCacheAt = Date.now();
  return _playersCache;
}
