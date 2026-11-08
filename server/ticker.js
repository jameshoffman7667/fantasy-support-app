import crypto from "crypto";
import * as store from "./projectionStore.js";
import * as gameday from "./gameday.js";

/**
 * v4.17.0 (P-33): read-only ticker API for the IPTV Multiview app.
 *  - a dedicated bearer token (stored as a SHA-256 hash, never logged; one per owner, rotate/revoke in Account)
 *  - a cached snapshot per user built from Game Day's numbers (the same league colour rule: server/gameday.js matchupOutlook)
 *  - `score` events for every starter whose points went UP between two snapshots, kept 10 minutes in memory for SSE catch-up
 * Nothing here writes to Sleeper. The pure functions (buildFrame, buildSummary, diffEvents) are unit-tested.
 */
export const EVENT_KEEP_MS = 10 * 60 * 1000;
export const LIVE_REFRESH_MS = 15 * 1000;
export const IDLE_REFRESH_MS = 60 * 1000;
export const HEARTBEAT_MS = 15 * 1000;
const TOKENS_KEY = "ticker_tokens";
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/* ---------------- tokens ---------------- */
const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const loadTokens = () => store.getState(TOKENS_KEY, {}) || {};
export function tokenStatus(username) {
  const t = Object.values(loadTokens()).find((x) => x.username === username);
  return t ? { exists: true, name: "multiview", createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null } : { exists: false };
}
/** Creates (or replaces) the user's token. The plain token is returned ONCE; only its hash is kept. */
export function createToken(username, now = Date.now()) {
  const token = `fmt_${crypto.randomBytes(32).toString("base64url")}`;
  const all = Object.fromEntries(Object.entries(loadTokens()).filter(([, v]) => v.username !== username));
  all[hashOf(token)] = { username, createdAt: new Date(now).toISOString(), lastUsedAt: null };
  store.setState(TOKENS_KEY, all);
  dropUser(username);
  return { token, createdAt: all[hashOf(token)].createdAt };
}
export function revokeToken(username) {
  const all = Object.fromEntries(Object.entries(loadTokens()).filter(([, v]) => v.username !== username));
  store.setState(TOKENS_KEY, all);
  dropUser(username);
}
const usedAt = new Map();
/** "Authorization: Bearer x" -> the username the token belongs to, or null. */
export function verifyBearer(header, now = Date.now()) {
  const m = /^Bearer\s+(\S{20,200})$/i.exec(String(header || ""));
  if (!m) return null;
  const h = hashOf(m[1]);
  const rec = loadTokens()[h];
  if (!rec) return null;
  if (now - (usedAt.get(h) || 0) > 60 * 1000) {
    usedAt.set(h, now);
    const all = loadTokens();
    if (all[h]) { all[h].lastUsedAt = new Date(now).toISOString(); store.setState(TOKENS_KEY, all); }
  }
  return rec.username;
}
export const tokenUsers = () => [...new Set(Object.values(loadTokens()).map((t) => t.username))];

/* ---------------- pure: frames, summary, events ---------------- */
const colourWord = (c) => (c === "yellow" ? "amber" : c === "green" || c === "red" ? c : "amber");
const gameStatus = (state) => (state === "in" ? "live" : state === "post" ? "final" : "pre");
const leagueStatus = (states) => {
  const s = states.filter(Boolean);
  if (!s.length || s.every((x) => x === "pre")) return "pre";
  return s.every((x) => x === "post") ? "final" : "live";
};

/** One league's frame: totals, colour and every player (starters and bench) keyed by side:id. */
export function buildFrame(raw) {
  const leagues = [];
  for (const l of raw?.leagues || []) {
    if (!l?.ticker || l.include === false || l.myPoints == null) continue;
    const players = {};
    const put = (list, side, starter) => {
      for (const p of list || []) players[`${side}:${p.id}`] = { playerId: String(p.id), name: p.name, pos: p.pos, nflTeam: p.team, side, starter, points: p.pts == null ? 0 : r2(p.pts), projected: p.proj == null ? null : r2(p.proj), state: p.state ?? null, statusDetail: p.statusDetail ?? null, slot: p.slot ?? null, slotOrder: p.slotOrder ?? null, kickoffAt: Number.isFinite(p.kickoff) ? new Date(p.kickoff).toISOString() : null, stats: p.stats ?? null };
    };
    put(l.ticker.my, "mine", true); put(l.ticker.opp, "opp", true);
    put(l.ticker.myBench, "mine", false); put(l.ticker.oppBench, "opp", false);
    leagues.push({
      leagueId: String(l.id), name: l.name, colour: colourWord(l.color), status: leagueStatus([...(l.ticker.my || []), ...(l.ticker.opp || [])].map((p) => p.state)),
      mine: { teamId: String(l.ticker.myRosterId), name: l.myTeam, points: r2(l.myPoints), projected: r2(l.myProjected) },
      opp: { teamId: String(l.ticker.oppRosterId), name: l.oppTeam, points: r2(l.oppPoints), projected: r2(l.oppProjected) },
      basis: { points: r2(l.myPoints), projected: r2(l.myProjected), oppPoints: r2(l.oppPoints), oppProjected: r2(l.oppProjected), remaining: r2((l.myRemaining || 0) + (l.oppRemaining || 0)), threshold: r2(l.threshold || 0) },
      players,
    });
  }
  return { season: raw?.season ?? null, week: raw?.week ?? null, leagues };
}

// Stable order: your side first, then the opponent; starters by lineup slot, bench after, then by name.
const byLineup = (a, b) => (a.side === b.side ? 0 : a.side === "mine" ? -1 : 1) || (a.starter === b.starter ? 0 : a.starter ? -1 : 1) || (a.slotOrder ?? 999) - (b.slotOrder ?? 999) || String(a.name).localeCompare(String(b.name));
export function buildSummary(frame, { bench = false, now = Date.now() } = {}) {
  return {
    generatedAt: new Date(now).toISOString(), season: frame.season, week: frame.week,
    leagues: frame.leagues.map((l) => ({
      leagueId: l.leagueId, name: l.name, platform: "sleeper", status: l.status, colour: l.colour,
      colourBasis: l.basis, mine: l.mine, opp: l.opp,
      players: Object.values(l.players).filter((p) => bench || p.starter).sort(byLineup).map((p) => ({
        playerId: p.playerId, name: p.name, pos: p.pos, nflTeam: p.nflTeam, side: p.side, starter: p.starter, points: p.points, projected: p.projected,
        slot: p.slot, slotOrder: p.slotOrder, kickoffAt: p.kickoffAt, stats: p.stats, gameStatus: gameStatus(p.state), gameClock: p.state === "in" || p.state === "post" ? p.statusDetail || null : null,
      })),
    })),
  };
}

/**
 * Events between two frames: one per player whose STARTER points went up in at least one league (merged over leagues).
 * No events for a new week/season or a league that wasn't in the earlier frame (that look is the baseline). Negative changes
 * and corrections are left out. Totals roll league by league so a second event in the same poll starts where the first ended.
 */
export function diffEvents(prev, next, { nextId, now = Date.now() } = {}) {
  if (!prev || !next || prev.season !== next.season || prev.week !== next.week) return [];
  const running = {};
  const byPlayer = new Map();
  for (const nl of next.leagues) {
    const pl = prev.leagues.find((x) => x.leagueId === nl.leagueId);
    if (!pl) continue;
    running[nl.leagueId] = { mine: pl.mine.points, opp: pl.opp.points };
    for (const [key, p] of Object.entries(nl.players)) {
      if (!p.starter) continue;
      const old = pl.players[key];
      if (!old || !old.starter) continue;
      const delta = r2(p.points - old.points);
      if (!(delta > 0.005)) continue;
      if (!byPlayer.has(p.playerId)) byPlayer.set(p.playerId, { p, items: [] });
      byPlayer.get(p.playerId).items.push({ league: nl, side: p.side, delta, points: p.points });
    }
  }
  const events = [];
  for (const [playerId, { p, items }] of [...byPlayer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const leagues = items.map(({ league, side, delta }) => {
      const run = running[league.leagueId];
      const before = { ...run };
      run[side === "mine" ? "mine" : "opp"] = r1(run[side === "mine" ? "mine" : "opp"] + delta);
      return { leagueId: league.leagueId, name: league.name, side, delta, mineBefore: r1(before.mine), mineAfter: r1(run.mine), oppBefore: r1(before.opp), oppAfter: r1(run.opp), colour: league.colour };
    });
    const best = items.reduce((a, b) => (b.delta > a.delta ? b : a));
    events.push({
      id: nextId(), detectedAt: new Date(now).toISOString(), providerAt: null,
      playerId, name: p.name, pos: p.pos, nflTeam: p.nflTeam, delta: best.delta, points: items[0].points, reason: null,
      headshot: `/api/headshot/${playerId}`, leagues,
    });
  }
  return events;
}

/* ---------------- running state ---------------- */
const users = new Map(); // username -> { frame, raw, at, live, events: [], subs: Set, inflight, byWeek: Map }
let lastSeq = 0;
const nextId = () => `evt_${(lastSeq = Math.max(lastSeq + 1, Date.now()))}`;
const seqOf = (id) => { const m = /^evt_(\d+)$/.exec(String(id || "")); return m ? Number(m[1]) : null; };
function st(username) {
  if (!users.has(username)) users.set(username, { frame: null, at: 0, live: false, events: [], subs: new Set(), inflight: null, byWeek: new Map() });
  return users.get(username);
}
function dropUser(username) {
  const s = users.get(username);
  if (s) for (const res of s.subs) { try { res.end(); } catch { /* closed */ } }
  users.delete(username);
}
const prune = (s, now) => { s.events = s.events.filter((e) => now - Date.parse(e.detectedAt) <= EVENT_KEEP_MS); };
export const lastUpdate = (username) => (users.get(username)?.at ? new Date(users.get(username).at).toISOString() : null);

/** Rebuilds the user's snapshot (one at a time per user) and emits events for what changed. */
export function refresh(username, { now = Date.now() } = {}) {
  const s = st(username);
  if (s.inflight) return s.inflight;
  s.inflight = (async () => {
    try {
      const raw = await gameday.getGameDay(username, { ticker: true });
      const frame = buildFrame(raw);
      const events = diffEvents(s.frame, frame, { nextId, now });
      s.frame = frame; s.at = now; s.live = frame.leagues.some((l) => l.status === "live");
      if (events.length) {
        s.events.push(...events);
        for (const e of events) for (const res of s.subs) writeEvent(res, e);
      }
      prune(s, now);
      return s;
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}
const due = (s, now) => !s.frame || now - s.at >= (s.live ? LIVE_REFRESH_MS - 1000 : IDLE_REFRESH_MS);

/** The summary for the current week from the cache; a snapshot older than the refresh age is rebuilt first. */
export async function getSummary(username, { week = null, bench = false, now = Date.now() } = {}) {
  const s = st(username);
  if (week && s.frame && Number(week) !== Number(s.frame.week)) {
    const hit = s.byWeek.get(String(week));
    if (hit && now - hit.at < IDLE_REFRESH_MS) return buildSummary(hit.frame, { bench, now });
    const frame = buildFrame(await gameday.getGameDay(username, { ticker: true, week: Number(week) }));
    s.byWeek.set(String(week), { at: now, frame });
    return buildSummary(frame, { bench, now });
  }
  if (due(s, now)) await refresh(username, { now });
  return buildSummary(s.frame, { bench, now });
}

/** Scheduler hook: keeps the snapshot warm (and detects scores) for every user with a token. */
export async function tick(now = Date.now()) {
  for (const username of tokenUsers()) {
    const s = st(username);
    if (due(s, now)) await refresh(username, { now }).catch((err) => console.warn(`[ticker] snapshot for ${username} failed: ${err.message}`));
  }
}

/* ---------------- server-sent events ---------------- */
function writeEvent(res, e) {
  try { res.write(`id: ${e.id}\nevent: score\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ }
}
/** Starts a stream: replays the kept events newer than `since` (an id), then follows new ones. Returns the unsubscribe. */
export function subscribe(username, res, since = null, now = Date.now()) {
  const s = st(username);
  prune(s, now);
  const after = seqOf(since);
  if (after != null) for (const e of s.events) if (seqOf(e.id) > after) writeEvent(res, e);
  s.subs.add(res);
  return () => s.subs.delete(res);
}
export function heartbeat() {
  for (const s of users.values()) for (const res of s.subs) { try { res.write(": hb\n\n"); } catch { /* closed */ } }
}
let timers = [];
export function start() {
  if (timers.length) return;
  timers = [setInterval(() => tick().catch(() => {}), LIVE_REFRESH_MS), setInterval(heartbeat, HEARTBEAT_MS)];
  timers.forEach((t) => t.unref?.());
}
export function _reset() { users.clear(); lastSeq = 0; }
export const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#2b2f36"/><circle cx="48" cy="36" r="16" fill="#6b7280"/><path d="M16 92c0-18 14-30 32-30s32 12 32 30z" fill="#6b7280"/></svg>';
