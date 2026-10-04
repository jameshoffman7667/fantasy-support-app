import * as store from "./projectionStore.js";

/**
 * Which minor variances each user has cleared ("Clear minor variances" in the
 * variance report, plus the v2.9 auto-clearing ones). Stored per user in
 * app_state so it follows them across devices. Keys are built by the client
 * (client/src/variances.js): "leagueId|W<week or *>|page|rule|subject".
 *
 * prune(): after each COMPLETE live league build the client sends the
 * variance keys that currently exist. A cleared key whose league (and week,
 * for week-specific keys) is in that build and which is still present just
 * gets its `seen` time refreshed. One that is absent is only dropped once it
 * has been absent for GRACE_MS (v2.9) — before that, an issue that merely
 * flickers (a wind forecast bobbing around its threshold, a trending list or
 * projection that wobbles between builds, a source that's briefly down)
 * would be dropped and then show up again as "new" straight after you
 * cleared it. That flicker is the most likely cause of the v2.8.1 report
 * "cleared minors come right back"; it could not be reproduced from the
 * code alone, so this is a fix for the likeliest cause, not a proven one.
 *
 * Storage: [{k, at, seen}]; older versions stored plain strings, which are
 * upgraded on read.
 */
const MAX_KEYS = 5000;
export const GRACE_MS = 12 * 3600 * 1000;
const k = (username) => `variance_acks:${username}`;

function read(username) {
  const v = store.getState(k(username), []);
  const now = Date.now();
  return (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === "string" ? { k: x, at: now, seen: now } : x && typeof x.k === "string" ? { k: x.k, at: x.at ?? now, seen: x.seen ?? x.at ?? now } : null))
    .filter(Boolean);
}
function write(username, recs) {
  const seen = new Set();
  const list = recs.filter((r) => !seen.has(r.k) && seen.add(r.k)).slice(-MAX_KEYS);
  store.setState(k(username), list);
  return list;
}
const valid = (x) => typeof x === "string" && x.length > 0 && x.length <= 400;

export function getAcks(username) {
  return read(username).map((r) => r.k);
}

export function addAcks(username, keys) {
  const now = Date.now();
  const add = (Array.isArray(keys) ? keys.filter(valid) : []).map((key) => ({ k: key, at: now, seen: now }));
  return write(username, [...read(username), ...add]).map((r) => r.k);
}

export function prune(username, { leagueIds, week, present, now = Date.now() }) {
  const leagues = new Set((Array.isArray(leagueIds) ? leagueIds : []).map(String));
  const keep = new Set((Array.isArray(present) ? present : []).filter(valid));
  const wk = `W${week}`;
  const next = [];
  for (const rec of read(username)) {
    const [leagueId, w] = rec.k.split("|");
    if (!leagues.has(leagueId) || (w !== "W*" && w !== wk)) {
      next.push(rec); // not part of this build — leave alone
    } else if (keep.has(rec.k)) {
      next.push({ ...rec, seen: now }); // still happening
    } else if (now - rec.seen <= GRACE_MS) {
      next.push(rec); // absent, but not for long enough to call it gone
    } // else: gone for good — drop, so if it returns it is new
  }
  return write(username, next).map((r) => r.k);
}

export function clearAll(username) {
  return write(username, []).map((r) => r.k);
}
