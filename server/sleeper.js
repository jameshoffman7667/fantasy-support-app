const SLEEPER_BASE = "https://api.sleeper.app/v1";
import { cacheGet, cacheSet } from "./db.js";

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
export function getLeagueUsers(leagueId) {
  return sleeperFetch(`/league/${leagueId}/users`);
}
export function getTrendingAdds(limit = 60, lookbackHours = 24) {
  return sleeperFetch(`/players/nfl/trending/add?lookback_hours=${lookbackHours}&limit=${limit}`);
}
export function getTransactions(leagueId, round) {
  return sleeperFetch(`/league/${leagueId}/transactions/${round}`);
}
// Sleeper's own docs only show a per-team `points` total in this
// response, but the real payload is widely reported (community wrappers,
// not confirmed by a live fetch of my own) to also include
// `players_points` (player_id -> points) and `starters_points` (parallel
// to `starters`) once stats start coming in for a game. Used for "lock
// in actual score once played" — see buildLeague.js, which checks for
// this field's actual presence rather than assuming it's there.
export function getMatchups(leagueId, week) {
  return sleeperFetch(`/league/${leagueId}/matchups/${week}`);
}

// ~5MB dictionary of every NFL player. Sleeper's own docs ask integrators
// not to poll this more than once a day. Now persisted via db.js so a
// container restart doesn't force an immediate 5MB re-fetch either.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export async function getPlayers() {
  const cached = cacheGet("sleeper:players");
  if (cached !== null) return cached;
  const data = await sleeperFetch(`/players/nfl`);
  cacheSet("sleeper:players", data, ONE_DAY_MS);
  return data;
}
