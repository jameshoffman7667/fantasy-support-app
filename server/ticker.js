import crypto from "crypto";
import * as store from "./projectionStore.js";
import * as gameday from "./gameday.js";
import * as sleeper from "./sleeper.js";
import { getUser, listUsers } from "./db.js";
import { playerView, mirrorColour } from "./projection.js"; // v4.20.0 (P-48)

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
// v4.20.0 (P-48): several named tokens per user, each with scope "ticker:read" only. Only the SHA-256 hash is stored; the plain
// token is shown once at creation. Records made before 4.20.0 have no id/name/scope and read as the token "multiview".
export const SCOPE = "ticker:read";
export const MAX_TOKENS_PER_USER = 10;
export const RATE_LIMIT_PER_MIN = 120;
const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const loadTokens = () => store.getState(TOKENS_KEY, {}) || {};
const publicToken = (hash, t) => ({ id: t.id || hash.slice(0, 8), name: t.name || "multiview", last4: t.last4 || null, scope: t.scope || SCOPE, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null });
export function listTokens(username) {
  return Object.entries(loadTokens()).filter(([, v]) => v.username === username).map(([h, v]) => publicToken(h, v)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function tokenStatus(username) {
  const list = listTokens(username);
  const t = list[list.length - 1];
  return t ? { exists: true, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt } : { exists: false };
}
/**
 * Creates a token. The legacy name "multiview" REPLACES the user's existing token of that name (the Account screen's rotate);
 * any other name adds one (at most MAX_TOKENS_PER_USER). The plain token is returned ONCE.
 */
export function createToken(username, opts = {}) {
  const o = typeof opts === "number" ? { now: opts } : opts || {};
  const now = o.now ?? Date.now();
  const name = String(o.name ?? "multiview").trim().slice(0, 40) || "multiview";
  const token = `fmt_${crypto.randomBytes(32).toString("base64url")}`;
  let all = loadTokens();
  if (name === "multiview") all = Object.fromEntries(Object.entries(all).filter(([, v]) => !(v.username === username && (v.name || "multiview") === "multiview")));
  if (Object.values(all).filter((v) => v.username === username).length >= MAX_TOKENS_PER_USER) throw new Error(`At most ${MAX_TOKENS_PER_USER} tokens per user — revoke one first.`);
  const rec = { id: crypto.randomBytes(4).toString("hex"), username, name, last4: token.slice(-4), scope: SCOPE, createdAt: new Date(now).toISOString(), lastUsedAt: null };
  all[hashOf(token)] = rec;
  store.setState(TOKENS_KEY, all);
  dropUser(username);
  return { token, id: rec.id, name, last4: rec.last4, scope: SCOPE, createdAt: rec.createdAt };
}
/** Revokes every token of the user (the legacy call), or one token by its id. Returns how many were removed. */
export function revokeToken(username, id = null) {
  const before = loadTokens();
  const all = Object.fromEntries(Object.entries(before).filter(([h, v]) => !(v.username === username && (id == null || (v.id || h.slice(0, 8)) === id))));
  store.setState(TOKENS_KEY, all);
  dropUser(username);
  return Object.keys(before).length - Object.keys(all).length;
}
const usedAt = new Map();
/** "Authorization: Bearer x" -> { username, id, hash, scope } for a live token whose user is not disabled, or null. */
export function authenticate(header, now = Date.now()) {
  const m = /^Bearer\s+(\S{20,200})$/i.exec(String(header || ""));
  if (!m) return null;
  const h = hashOf(m[1]);
  const rec = loadTokens()[h];
  if (!rec) return null;
  if (getUser(rec.username)?.active === false) return null; // a disabled account's tokens stop working at once
  if (now - (usedAt.get(h) || 0) > 60 * 1000) {
    usedAt.set(h, now);
    const all = loadTokens();
    if (all[h]) { all[h].lastUsedAt = new Date(now).toISOString(); store.setState(TOKENS_KEY, all); }
  }
  return { username: rec.username, id: rec.id || h.slice(0, 8), hash: h, scope: rec.scope || SCOPE };
}
export const verifyBearer = (header, now = Date.now()) => authenticate(header, now)?.username ?? null;
export const tokenUsers = () => [...new Set(Object.values(loadTokens()).map((t) => t.username))];

const windows = new Map(); // token hash -> { start, n }
/** Fixed one-minute window per token: { ok, retryAfter (seconds) }. */
export function rateLimit(hash, now = Date.now(), limit = RATE_LIMIT_PER_MIN) {
  let w = windows.get(hash);
  if (!w || now - w.start >= 60 * 1000) { w = { start: now, n: 0 }; windows.set(hash, w); }
  w.n += 1;
  return w.n <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + 60 * 1000 - now) / 1000)) };
}

/** v4.20.0: the only /api paths a "ticker" account may use (everything else is 403 for it, see server.js). */
const TICKER_ROLE_ALLOWED = [/^\/api\/auth\//, /^\/api\/(login|logout)$/, /^\/api\/account\/password$/, /^\/api\/ticker-sync(\/|$)/, /^\/api\/ticker\//, /^\/api\/headshot\//, /^\/api\/health$/];
export const tickerRoleAllows = (pathname) => TICKER_ROLE_ALLOWED.some((r) => r.test(pathname));

/* ---------------- sync settings (v4.20.0, P-48) ---------------- */
const syncKey = (u) => `ticker_sync:${u}`;
const CAP_KEY = "ticker_user_cap";
export const MAX_TICKER_USERS = 20;
/** { linked, leagueList: [{id, name}], chosen: {leagueId: bool}, leaguesSyncedAt } */
export function getSync(username) {
  const s = store.getState(syncKey(username), null) || {};
  return { linked: s.linked !== false, leagueList: Array.isArray(s.leagueList) ? s.leagueList : [], chosen: s.chosen && typeof s.chosen === "object" ? s.chosen : {}, leaguesSyncedAt: s.leaguesSyncedAt || null };
}
const putSync = (username, patch) => { const s = { ...getSync(username), ...patch }; store.setState(syncKey(username), s); return s; };
export function setLinked(username, linked) { dropUser(username); return putSync(username, { linked: Boolean(linked) }); }
export function setLeagueChoices(username, choices) {
  const cur = getSync(username);
  const known = new Set(cur.leagueList.map((l) => l.id));
  const chosen = { ...cur.chosen };
  for (const [id, v] of Object.entries(choices || {})) if (known.has(id)) chosen[id] = Boolean(v);
  dropUser(username);
  return putSync(username, { chosen });
}
/** Reads the user's leagues from Sleeper (the login name IS the Sleeper username) and keeps earlier choices. New leagues start included. */
export async function syncLeagues(username, now = Date.now()) {
  const user = await sleeper.getUser(username, { fresh: true });
  if (!user) throw new Error(`No Sleeper user found named "${username}".`);
  const nfl = await sleeper.getState();
  const raw = await sleeper.getUserLeagues(user.user_id, nfl.season, { fresh: true });
  const leagueList = raw.map((l) => ({ id: String(l.league_id), name: l.name }));
  const cur = getSync(username);
  const chosen = {};
  for (const l of leagueList) chosen[l.id] = cur.chosen[l.id] !== false;
  dropUser(username);
  putSync(username, { linked: true, leagueList, chosen, leaguesSyncedAt: new Date(now).toISOString() });
  return { sleeperUser: { userId: user.user_id, displayName: user.display_name }, leagueCount: leagueList.length };
}
/** Which leagues the ticker uses for this user: ticker-role accounts have no saved session, so their chosen list IS the league list. */
export function selection(username) {
  const sync = getSync(username);
  const included = (id) => sync.chosen[id] !== false;
  const exclude = new Set(Object.keys(sync.chosen).filter((id) => sync.chosen[id] === false));
  return { linked: sync.linked, override: getUser(username)?.role === "ticker" ? sync.leagueList.map((l) => l.id).filter(included) : null, exclude };
}
export const tickerCap = () => Math.max(0, Math.min(MAX_TICKER_USERS, Number(store.getState(CAP_KEY, 0)) || 0));
export function setTickerCap(n) { const v = Math.max(0, Math.min(MAX_TICKER_USERS, Math.floor(Number(n) || 0))); store.setState(CAP_KEY, v); return v; }
export const tickerUserCount = () => listUsers().filter((u) => u.role === "ticker").length;
/** Admin view: every ticker-role user with last sync and token use. */
export function adminView() {
  return {
    cap: tickerCap(), maxCap: MAX_TICKER_USERS,
    users: listUsers().filter((u) => u.role === "ticker").map((u) => {
      const tokens = listTokens(u.username);
      const used = tokens.map((t) => t.lastUsedAt).filter(Boolean).sort().pop() || null;
      const sync = getSync(u.username);
      return { username: u.username, active: u.active, lastLoginAt: u.lastLoginAt || null, linked: sync.linked, leagueCount: sync.leagueList.length, leaguesSyncedAt: sync.leaguesSyncedAt, lastSnapshotAt: lastUpdate(u.username), tokens: tokens.map((t) => ({ name: t.name, last4: t.last4, lastUsedAt: t.lastUsedAt })), lastTokenUseAt: used };
    }),
  };
}

/* ---------------- pure: frames, summary, events ---------------- */
const colourWord = (c) => (c === "yellow" ? "amber" : c === "green" || c === "red" ? c : "amber");
const gameStatus = (state) => (state === "in" ? "live" : state === "post" ? "final" : "pre");
const leagueStatus = (states) => {
  const s = states.filter(Boolean);
  if (!s.length || s.every((x) => x === "pre")) return "pre";
  return s.every((x) => x === "post") ? "final" : "live";
};

/** v4.20.0 (P-48): projection (pregame, fixed), liveProjection (only while his game is on), projected (= the expected final) and its colour. */
const projFields = (p) => {
  const v = playerView({ state: p.state, points: p.pts, proj: p.proj, statusDetail: p.statusDetail });
  return { projection: v.projection == null ? null : r2(v.projection), liveProjection: v.liveProjection, projected: v.projection == null && p.state !== "post" && p.state !== "in" ? null : r2(v.expected), projectedColour: v.colour };
};

/** One league's frame: totals, colour and every player (starters and bench) keyed by side:id. */
export function buildFrame(raw, { exclude = null } = {}) {
  const leagues = [];
  for (const l of raw?.leagues || []) {
    if (!l?.ticker || l.include === false || l.myPoints == null || exclude?.has(String(l.id))) continue;
    const players = {};
    const put = (list, side, starter) => {
      for (const p of list || []) players[`${side}:${p.id}`] = { playerId: String(p.id), name: p.name, pos: p.pos, nflTeam: p.team, side, starter, points: p.pts == null ? 0 : r2(p.pts), ...projFields(p), state: p.state ?? null, statusDetail: p.statusDetail ?? null, slot: p.slot ?? null, slotOrder: p.slotOrder ?? null, kickoffAt: Number.isFinite(p.kickoff) ? new Date(p.kickoff).toISOString() : null, stats: p.stats ?? null };
    };
    put(l.ticker.my, "mine", true); put(l.ticker.opp, "opp", true);
    put(l.ticker.myBench, "mine", false); put(l.ticker.oppBench, "opp", false);
    leagues.push({
      leagueId: String(l.id), name: l.name, colour: colourWord(l.color), status: leagueStatus([...(l.ticker.my || []), ...(l.ticker.opp || [])].map((p) => p.state)),
      mine: { teamId: String(l.ticker.myRosterId), name: l.myTeam, points: r2(l.myPoints), projection: l.myProjection == null ? null : r2(l.myProjection), projected: r2(l.myProjected), projectedColour: colourWord(l.color) },
      opp: { teamId: String(l.ticker.oppRosterId), name: l.oppTeam, points: r2(l.oppPoints), projection: l.oppProjection == null ? null : r2(l.oppProjection), projected: r2(l.oppProjected), projectedColour: mirrorColour(colourWord(l.color)) },
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
        playerId: p.playerId, name: p.name, pos: p.pos, nflTeam: p.nflTeam, side: p.side, starter: p.starter, points: p.points, projection: p.projection, liveProjection: p.liveProjection, projected: p.projected, projectedColour: p.projectedColour,
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
export function dropUser(username) {
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
      const sel = selection(username);
      const raw = sel.linked && !(sel.override && !sel.override.length) ? await gameday.getGameDay(username, { ticker: true, leagueIds: sel.override }) : { season: null, week: null, leagues: [] };
      const frame = buildFrame(raw, { exclude: sel.exclude });
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
    const sel = selection(username);
    const frame = buildFrame(sel.linked && !(sel.override && !sel.override.length) ? await gameday.getGameDay(username, { ticker: true, week: Number(week), leagueIds: sel.override }) : { leagues: [] }, { exclude: sel.exclude });
    s.byWeek.set(String(week), { at: now, frame });
    return buildSummary(frame, { bench, now });
  }
  if (due(s, now)) await refresh(username, { now });
  return buildSummary(s.frame, { bench, now });
}

/** Scheduler hook: keeps the snapshot warm (and detects scores) for every user with a token. */
export async function tick(now = Date.now()) {
  for (const username of tokenUsers()) {
    if (!selection(username).linked || getUser(username)?.active === false) continue;
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
