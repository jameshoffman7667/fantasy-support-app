import db from "./db.js";
import * as store from "./projectionStore.js";
import * as pickem from "./pickem.js";
import { encrypt, decrypt } from "./sleeperPrivate.js";
import { sendPushToUser, isPushConfigured } from "./push.js";
import { getAllUserStates, getUser } from "./db.js";

/**
 * v3.2 — push Pick'em picks to CBS pick'em pools.
 *
 * HONESTY FIRST: CBS has no public API and the build sandbox cannot reach cbssports.com, so none of
 * CBS's real URLs, form fields or response formats are known to this code. Everything CBS-specific lives in
 * a per-user "recipe" (login request, submit request, optional games lookup and read-back) that James fills
 * in from his browser's network tab (see CBS-CAPTURE.md). The engine around it — encrypted credentials,
 * cookie session, templating, per-game timing, safeguards, log, notifications — is built and tested against
 * a mock server only. Nothing is reported as successful unless CBS answered with what the recipe says is success.
 *
 * Safeguards: opt-in (off by default), pause switch, dry run, submission log, read-back verification (when the
 * recipe has one), the first real run touches ONE test pool until it is verified (or the user confirms it),
 * and a game is never sent once it has kicked off. Auto-push runs ~60 minutes before each kickoff slot.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS cbs_push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL, at INTEGER NOT NULL, season INTEGER, week INTEGER,
    slot INTEGER, pool_id TEXT, mode TEXT, games INTEGER, sent INTEGER, ok INTEGER NOT NULL,
    verified TEXT, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS cbs_push_log_user ON cbs_push_log (username, at DESC);
`);

export const AUTO_LEAD_MS = 60 * 60 * 1000;
const MIN_LEAD_MS = 2 * 60 * 1000; // don't start a push in the last 2 minutes before a slot
const RETRY_GAP_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SESSION_TTL_MS = 20 * 60 * 1000;
const ALLOWED_HOSTS = () => (process.env.CBS_ALLOWED_HOSTS || "cbssports.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const BLOCKED_HEADERS = new Set(["cookie", "host", "content-length", "connection", "transfer-encoding"]);

const accKey = (u) => `cbs_account:${u}`;
const setKey = (u) => `cbs_settings:${u}`;
const autoKey = (u, season, week, slot) => `cbs_auto:${u}:${season}:${week}:${slot}`;

export const DEFAULT_SETTINGS = { enabled: false, paused: false, notify: true, pools: [], testPoolId: null, verifiedOnce: false, recipe: {} };

/* ---------------- account + settings ---------------- */
export function setAccount(username, { email, password }) {
  email = String(email || "").trim();
  password = String(password || "");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new CbsError("Enter the email address you use for CBS.");
  if (password.length < 1 || password.length > 500) throw new CbsError("Enter your CBS password.");
  store.setState(accKey(username), { email, password: encrypt(password), savedAt: Date.now() });
  sessions.delete(username);
  return status(username);
}
export function clearAccount(username) {
  store.setState(accKey(username), null);
  sessions.delete(username);
  const s = getSettings(username);
  saveSettings(username, { enabled: false });
  return status(username);
}
const account = (u) => store.getState(accKey(u), null);
const creds = (u) => {
  const a = account(u);
  return a ? { email: a.email, password: decrypt(a.password) } : null;
};

export class CbsError extends Error {
  constructor(m, extra = {}) {
    super(m);
    this.name = "CbsError";
    Object.assign(this, extra);
  }
}

export function getSettings(username) {
  const s = store.getState(setKey(username), null) || {};
  return { ...DEFAULT_SETTINGS, ...s, pools: Array.isArray(s.pools) ? s.pools : [], recipe: s.recipe || {} };
}

const str = (v, max = 4000) => (v == null ? "" : String(v).slice(0, max));
function cleanSpec(s, { needBody = true } = {}) {
  if (!s || typeof s !== "object") return null;
  const method = String(s.method || "POST").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH"].includes(method)) throw new CbsError(`Unsupported method "${s.method}".`);
  const contentType = ["form", "json", "raw"].includes(s.contentType) ? s.contentType : "form";
  const headers = {};
  for (const [k, v] of Object.entries(s.headers || {})) if (k && !BLOCKED_HEADERS.has(String(k).toLowerCase())) headers[str(k, 100)] = str(v, 1000);
  const out = { url: str(s.url, 1000).trim(), method, contentType, headers, body: needBody ? str(s.body, 20000) : "" };
  for (const k of ["successIncludes", "failIncludes", "successStatus"]) if (s[k] != null && s[k] !== "") out[k] = str(s[k], 500);
  if (s.mode) out.mode = s.mode === "batch" ? "batch" : "perGame";
  for (const k of ["itemBody", "itemSep"]) if (s[k] != null) out[k] = str(s[k], 5000);
  if (s.csrf && s.csrf.url) out.csrf = { url: str(s.csrf.url, 1000).trim(), regex: str(s.csrf.regex, 500) };
  if (s.idRegex) out.idRegex = str(s.idRegex, 800);
  if (s.pickRegex) out.pickRegex = str(s.pickRegex, 800);
  if (out.url) assertHost(out.url.replace(/\{\{[^}]+\}\}/g, "x"));
  return out;
}
function cleanRecipe(r) {
  r = r && typeof r === "object" ? r : {};
  const out = {};
  if (r.login?.url) out.login = cleanSpec(r.login);
  if (r.submit?.url) out.submit = cleanSpec(r.submit);
  if (r.games?.url) out.games = cleanSpec({ ...r.games, method: r.games.method || "GET" }, { needBody: false });
  if (r.readback?.url) out.readback = cleanSpec({ ...r.readback, method: r.readback.method || "GET" }, { needBody: false });
  const tm = {};
  for (const [k, v] of Object.entries(r.teamMap || {})) if (/^[A-Z]{2,4}$/.test(k)) tm[k] = str(v, 40);
  out.teamMap = tm;
  return out;
}
export function saveSettings(username, patch = {}) {
  const cur = getSettings(username);
  const next = { ...cur };
  for (const k of ["enabled", "paused", "notify", "verifiedOnce"]) if (typeof patch[k] === "boolean") next[k] = patch[k];
  if (Array.isArray(patch.pools)) {
    next.pools = patch.pools
      .map((p) => ({ id: str(p.id, 80).trim(), name: str(p.name, 120).trim() || str(p.id, 80).trim(), enabled: p.enabled !== false }))
      .filter((p) => p.id)
      .slice(0, 30);
  }
  if ("testPoolId" in patch) next.testPoolId = patch.testPoolId ? str(patch.testPoolId, 80) : null;
  if (patch.recipe !== undefined) next.recipe = cleanRecipe(patch.recipe);
  if (next.enabled && !account(username)) next.enabled = false;
  store.setState(setKey(username), next);
  return status(username);
}

/* ---------------- templating + HTTP ---------------- */
function assertHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new CbsError(`"${url}" is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new CbsError("Only https URLs are allowed.");
  const h = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS().some((d) => h === d || h.endsWith("." + d))) throw new CbsError(`Host ${h} isn't allowed (allowed: ${ALLOWED_HOSTS().join(", ")}; set CBS_ALLOWED_HOSTS to change).`);
  return u;
}
const encFor = {
  form: (v) => encodeURIComponent(v),
  json: (v) => JSON.stringify(String(v)).slice(1, -1),
  url: (v) => encodeURIComponent(v),
  none: (v) => String(v),
};
export function fill(tpl, vars, enc = "none") {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (k in vars && vars[k] != null ? encFor[enc](vars[k]) : ""));
}
const bodyEnc = (ct) => (ct === "form" ? "form" : ct === "json" ? "json" : "none");
const CT = { form: "application/x-www-form-urlencoded", json: "application/json", raw: "text/plain" };

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar, res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      const val = pair.slice(i + 1).trim();
      if (!val || /expires=thu, 01 jan 1970/i.test(c)) jar.delete(name);
      else jar.set(name, val);
    }
  }
}

/** Builds (but doesn't send) a request from a spec. Credentials appear only when `vars` carry them. */
export function buildRequest(spec, vars) {
  const url = fill(spec.url, vars, "url");
  assertHost(url);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; fantasy-manager)", Accept: "*/*" };
  for (const [k, v] of Object.entries(spec.headers || {})) headers[k] = fill(v, vars, "none");
  let body;
  if (spec.method !== "GET") {
    body = fill(spec.body, vars, bodyEnc(spec.contentType));
    headers["Content-Type"] = headers["Content-Type"] || CT[spec.contentType] || CT.form;
  }
  return { url, method: spec.method, headers, body };
}

async function send(jar, req, { timeoutMs = 20000 } = {}) {
  let url = req.url;
  let method = req.method;
  let body = req.body;
  for (let hop = 0; hop < 6; hop++) {
    assertHost(url);
    const headers = { ...req.headers };
    const ck = cookieHeader(jar);
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    absorb(jar, res);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString();
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
        delete req.headers["Content-Type"];
      }
      continue;
    }
    const text = await res.text().catch(() => "");
    return { status: res.status, text, url };
  }
  throw new CbsError("Too many redirects.");
}

function judge(spec, r) {
  const okStatus = spec.successStatus ? String(r.status) === String(spec.successStatus) : r.status >= 200 && r.status < 300;
  if (!okStatus) return { ok: false, detail: `HTTP ${r.status}` };
  if (spec.failIncludes && r.text.includes(spec.failIncludes)) return { ok: false, detail: `Response contained the failure text "${spec.failIncludes}"` };
  if (spec.successIncludes && !r.text.includes(spec.successIncludes)) return { ok: false, detail: `Response did not contain the success text "${spec.successIncludes}"` };
  return { ok: true, detail: `HTTP ${r.status}` };
}
async function csrfFor(jar, spec, vars) {
  if (!spec.csrf?.url) return null;
  const r = await send(jar, buildRequest({ url: spec.csrf.url, method: "GET", headers: {}, body: "" }, vars));
  const m = spec.csrf.regex ? new RegExp(spec.csrf.regex).exec(r.text) : null;
  if (!m) throw new CbsError("Couldn't find the CSRF/token value on the page named in the recipe.");
  return m[1] ?? m[0];
}

/* ---------------- session ---------------- */
const sessions = new Map(); // username -> { jar, at }
async function login(username, recipe) {
  const c = creds(username);
  if (!c) throw new CbsError("No CBS login saved.");
  if (!recipe.login) throw new CbsError("The recipe has no login step.");
  const jar = new Map();
  const vars = { email: c.email, password: c.password };
  const t = await csrfFor(jar, recipe.login, vars);
  if (t) vars.csrf = t;
  const r = await send(jar, buildRequest(recipe.login, vars));
  const j = judge(recipe.login, r);
  if (!j.ok) throw new CbsError(`CBS login did not succeed: ${j.detail}.`);
  sessions.set(username, { jar, at: Date.now() });
  return jar;
}
async function session(username, recipe, { fresh = false } = {}) {
  const s = sessions.get(username);
  if (!fresh && s && Date.now() - s.at < SESSION_TTL_MS) return s.jar;
  return login(username, recipe);
}
export async function testLogin(username) {
  const recipe = getSettings(username).recipe;
  try {
    await session(username, recipe, { fresh: true });
    log(username, { mode: "login-test", ok: true, detail: "login accepted" });
    return { ok: true, detail: "CBS accepted the login." };
  } catch (e) {
    log(username, { mode: "login-test", ok: false, detail: e.message });
    return { ok: false, detail: e.message };
  }
}

/* ---------------- picks ---------------- */
export function teamToken(recipe, team) {
  return recipe.teamMap?.[team] || team;
}
/** The user's final pick per game: their own choice if they made one, otherwise the app's recommendation. */
export function finalPicks(username, board) {
  const recs = pickem.recommend(board, pickem.getSettings(username));
  const ch = pickem.getChoices(username, board.season, board.week);
  const out = new Map();
  for (const g of board.games) {
    const pick = ch.games?.[g.key] || recs.get(g.key)?.pick || null;
    if (pick && (pick === g.home || pick === g.away)) out.set(g.key, { pick, chosen: Boolean(ch.games?.[g.key]) });
  }
  return { picks: out, tiebreaker: ch.tiebreaker ?? board.tiebreaker?.total ?? null };
}

function gameVars(recipe, g, pick, base) {
  const side = pick === g.home ? "home" : "away";
  return {
    ...base,
    away: teamToken(recipe, g.away),
    home: teamToken(recipe, g.home),
    awayCode: g.away,
    homeCode: g.home,
    gameKey: g.key,
    pick: teamToken(recipe, pick),
    pickCode: pick,
    pickSide: side,
    pickOpp: teamToken(recipe, side === "home" ? g.away : g.home),
    gameId: base.gameIds?.[g.key] ?? "",
  };
}

async function lookupGameIds(jar, recipe, vars, games) {
  if (!recipe.games?.url || !recipe.games.idRegex) return {};
  const r = await send(jar, buildRequest(recipe.games, vars));
  const out = {};
  let re;
  try {
    re = new RegExp(recipe.games.idRegex, "g");
  } catch {
    throw new CbsError("The games lookup regex isn't valid.");
  }
  const norm = (s) => String(s || "").toUpperCase();
  const wanted = new Map(games.map((g) => [`${norm(teamToken(recipe, g.away))}@${norm(teamToken(recipe, g.home))}`, g.key]));
  for (const m of r.text.matchAll(re)) {
    const gr = m.groups || {};
    const key = wanted.get(`${norm(gr.away)}@${norm(gr.home)}`);
    if (key && gr.id) out[key] = gr.id;
  }
  return out;
}

/** Reads the pool's picks back and compares to what was sent. Returns { checked, matched, missing[] } or null (no read-back configured). */
async function readBack(jar, recipe, vars, expected) {
  if (!recipe.readback?.url || !recipe.readback.pickRegex) return null;
  const r = await send(jar, buildRequest(recipe.readback, vars));
  let re;
  try {
    re = new RegExp(recipe.readback.pickRegex, "g");
  } catch {
    return { checked: 0, matched: 0, missing: [], note: "read-back regex invalid" };
  }
  const seen = new Map();
  for (const m of r.text.matchAll(re)) {
    const gr = m.groups || {};
    const id = String(gr.id ?? gr.game ?? "").toUpperCase();
    if (id && gr.team) seen.set(id, String(gr.team).toUpperCase());
  }
  let matched = 0;
  const missing = [];
  for (const e of expected) {
    const got = seen.get(String(e.gameId || e.gameKey).toUpperCase()) ?? seen.get(String(e.gameKey).toUpperCase());
    if (got && got === String(e.pickToken).toUpperCase()) matched++;
    else missing.push(e.gameKey);
  }
  return { checked: expected.length, matched, missing };
}

/* ---------------- push ---------------- */
function log(username, row) {
  db.prepare("INSERT INTO cbs_push_log (username, at, season, week, slot, pool_id, mode, games, sent, ok, verified, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    username, Date.now(), row.season ?? null, row.week ?? null, row.slot ?? null, row.poolId ?? null, row.mode || "manual", row.games ?? null, row.sent ?? null, row.ok ? 1 : 0, row.verified ?? null, String(row.detail || "").slice(0, 600)
  );
}
export function getLog(username, limit = 40) {
  return db.prepare("SELECT * FROM cbs_push_log WHERE username=? ORDER BY at DESC, id DESC LIMIT ?").all(username, limit).map((r) => ({ id: r.id, at: r.at, season: r.season, week: r.week, slot: r.slot, poolId: r.pool_id, mode: r.mode, games: r.games, sent: r.sent, ok: Boolean(r.ok), verified: r.verified, detail: r.detail }));
}

function poolsToUse(settings, only) {
  let pools = settings.pools.filter((p) => p.enabled);
  if (only?.length) pools = pools.filter((p) => only.includes(p.id));
  if (!settings.verifiedOnce && pools.length) {
    const test = pools.find((p) => p.id === settings.testPoolId) || pools[0];
    return { pools: [test], testOnly: true, skipped: pools.filter((p) => p !== test).map((p) => p.id) };
  }
  return { pools, testOnly: false, skipped: [] };
}

/**
 * Sends the user's picks to the pools. Options: mode ("auto"|"manual"), slot (kickoff ms: only that slot's games),
 * poolIds, dryRun. Never includes a game that has kicked off.
 */
export async function pushForUser(username, { mode = "manual", slot = null, poolIds = null, dryRun = false, board = null } = {}) {
  const settings = getSettings(username);
  const recipe = settings.recipe;
  if (!account(username)) throw new CbsError("Save your CBS login first.");
  if (!recipe.submit) throw new CbsError("The recipe has no submit step yet — see CBS-CAPTURE.md.");
  if (!recipe.login) throw new CbsError("The recipe has no login step yet — see CBS-CAPTURE.md.");
  if (!settings.pools.some((p) => p.enabled)) throw new CbsError("Add at least one pool (its id) and leave it enabled.");
  board = board || (await pickem.getBoard());
  const now = Date.now();
  const { picks, tiebreaker } = finalPicks(username, board);
  const games = board.games.filter((g) => picks.has(g.key) && g.kickoff != null && g.kickoff > now && g.state !== "in" && g.state !== "post" && (slot == null || g.kickoff === slot));
  const { pools, skipped } = poolsToUse(settings, poolIds);
  const tbGame = board.tiebreaker ? board.games.find((g) => g.key === board.tiebreaker.game) : null;
  const tbOpen = tiebreaker != null && (!tbGame || tbGame.kickoff == null || tbGame.kickoff > now);
  const results = [];
  if (!games.length) return { ok: true, nothing: true, detail: "No unstarted games with a pick to send.", results, skippedPools: skipped };

  const base = { season: board.season, week: board.week, tiebreaker: tbOpen ? tiebreaker : "" };
  const slotKey = slot ?? null;

  if (dryRun) {
    const reqs = [];
    for (const pool of pools) {
      const baseP = { ...base, poolId: pool.id, csrf: "<csrf>", gameIds: {} };
      reqs.push({ pool: pool.id, login: buildRequest(recipe.login, { email: "<email>", password: "<password>", csrf: "<csrf>" }), submit: buildSubmitRequests(recipe, games, picks, baseP).map((q) => q.req) });
    }
    return { ok: true, dryRun: true, games: games.map((g) => ({ key: g.key, pick: picks.get(g.key).pick })), requests: reqs, skippedPools: skipped };
  }

  let jar;
  let loginError = null;
  try {
    jar = await session(username, recipe);
  } catch (e) {
    loginError = e.message;
  }
  for (const pool of pools) {
    const row = { season: board.season, week: board.week, slot: slotKey, poolId: pool.id, mode, games: games.length };
    if (loginError) {
      results.push({ pool: pool.id, ok: false, detail: loginError });
      log(username, { ...row, ok: false, sent: 0, detail: loginError });
      continue;
    }
    try {
      const r = await pushPool(username, recipe, jar, pool, games, picks, base);
      results.push({ pool: pool.id, ...r });
      log(username, { ...row, ok: r.ok, sent: r.sent, verified: r.verified, detail: r.detail });
      if (!settings.verifiedOnce && r.ok && r.verified === "yes" && pool.id === (pools[0]?.id)) saveSettings(username, { verifiedOnce: true });
    } catch (e) {
      results.push({ pool: pool.id, ok: false, detail: e.message });
      log(username, { ...row, ok: false, sent: 0, detail: e.message });
    }
  }
  const okN = results.filter((r) => r.ok).length;
  const out = { ok: okN === results.length && results.length > 0, results, games: games.length, skippedPools: skipped };
  if (settings.notify && isPushConfigured()) {
    const first = results.find((r) => !r.ok);
    await sendPushToUser(username, {
      title: out.ok ? `CBS pick'em: ${games.length} game${games.length > 1 ? "s" : ""} sent to ${okN} pool${okN > 1 ? "s" : ""}` : `CBS pick'em: ${results.length - okN} of ${results.length} pools FAILED`,
      body: out.ok ? results.map((r) => `${r.pool}: ${r.verified === "yes" ? "verified" : r.verified === "partial" ? "partly verified" : "sent, not verified"}`).join("; ") : `${first?.pool}: ${first?.detail}`,
    }).catch(() => {});
  }
  return out;
}

function buildSubmitRequests(recipe, games, picks, baseP) {
  const sp = recipe.submit;
  const gv = (g) => gameVars(recipe, g, picks.get(g.key).pick, baseP);
  if (sp.mode === "batch") {
    const items = games.map((g) => fill(sp.itemBody || "", gv(g), bodyEnc(sp.contentType))).join(sp.itemSep ?? "&");
    const vars = { ...baseP, games: items };
    // `games` holds already-encoded text, so substitute it after normal templating.
    const body = fill(String(sp.body).replace(/\{\{\s*games\s*\}\}/g, "\u0000G\u0000"), vars, bodyEnc(sp.contentType)).replace(/\u0000G\u0000/g, items);
    const req = buildRequest({ ...sp, body: "" }, vars);
    req.body = body;
    return [{ req, games }];
  }
  return games.map((g) => ({ req: buildRequest(sp, gv(g)), games: [g] }));
}

async function pushPool(username, recipe, jar, pool, games, picks, base) {
  const baseP = { ...base, poolId: pool.id, gameIds: {} };
  const csrf = await csrfFor(jar, recipe.submit, baseP);
  if (csrf) baseP.csrf = csrf;
  baseP.gameIds = await lookupGameIds(jar, recipe, baseP, games);
  if (recipe.games?.idRegex && games.some((g) => !baseP.gameIds[g.key])) {
    const miss = games.filter((g) => !baseP.gameIds[g.key]).map((g) => g.key);
    // not fatal: a recipe may not need ids for every game, but say so
    baseP.missingIds = miss;
  }
  const reqs = buildSubmitRequests(recipe, games, picks, baseP);
  let sent = 0;
  const failures = [];
  for (const q of reqs) {
    let r = await send(jar, q.req);
    let j = judge(recipe.submit, r);
    if (!j.ok && [401, 403].includes(r.status)) {
      // session may have expired: log in once more and retry this request
      jar = await session(username, getSettings(username).recipe, { fresh: true });
      r = await send(jar, q.req);
      j = judge(recipe.submit, r);
    }
    if (j.ok) sent += q.games.length;
    else failures.push(`${q.games.map((g) => g.key).join(",")}: ${j.detail}`);
  }
  const expected = games.map((g) => ({ gameKey: g.key, gameId: baseP.gameIds[g.key], pickToken: teamToken(recipe, picks.get(g.key).pick) }));
  let verified = "no-readback";
  let vnote = "";
  try {
    const rb = await readBack(jar, recipe, baseP, expected);
    if (rb) {
      verified = rb.matched === rb.checked ? "yes" : rb.matched > 0 ? "partial" : "no";
      vnote = ` Read-back: ${rb.matched}/${rb.checked} match${rb.missing.length ? ` (not matching: ${rb.missing.join(", ")})` : ""}.`;
    }
  } catch (e) {
    verified = "unavailable";
    vnote = ` Read-back failed: ${e.message}.`;
  }
  const ok = failures.length === 0 && sent === games.length && verified !== "no" ;
  return { ok, sent, verified, detail: `${sent}/${games.length} game(s) accepted.${failures.length ? " Failed: " + failures.slice(0, 4).join("; ") + "." : ""}${vnote}${baseP.missingIds?.length ? ` No CBS id found for: ${baseP.missingIds.join(", ")}.` : ""}${verified === "no-readback" ? " (No read-back configured, so CBS's acceptance is the only evidence.)" : ""}` };
}

/* ---------------- auto-push ---------------- */
/** Scheduler hook (every ~5 min): for each opted-in user, push each kickoff slot's games ~60 min before it starts. */
export async function autoTick({ now = Date.now(), board = null } = {}) {
  const users = getAllUserStates().map((s) => s.username).filter((u) => {
    const st = getSettings(u);
    return st.enabled && !st.paused && account(u) && st.recipe.submit && st.recipe.login && getUser(u)?.active;
  });
  if (!users.length) return [];
  board = board || (await pickem.getBoard());
  const slots = [...new Set(board.games.filter((g) => g.kickoff != null && g.kickoff > now).map((g) => g.kickoff))].sort((a, b) => a - b);
  const ran = [];
  for (const u of users) {
    for (const slot of slots) {
      const lead = slot - now;
      if (lead > AUTO_LEAD_MS || lead < MIN_LEAD_MS) continue;
      const k = autoKey(u, board.season, board.week, slot);
      const st = store.getState(k, null) || { attempts: 0, done: false, lastAt: 0 };
      if (st.done || st.attempts >= MAX_ATTEMPTS || now - st.lastAt < RETRY_GAP_MS) continue;
      st.attempts++;
      st.lastAt = now;
      store.setState(k, st);
      try {
        const out = await pushForUser(u, { mode: "auto", slot, board });
        if (out.ok || out.nothing) st.done = true;
        ran.push({ user: u, slot, ok: out.ok });
      } catch (e) {
        log(u, { season: board.season, week: board.week, slot, mode: "auto", ok: false, detail: e.message });
        if (getSettings(u).notify && isPushConfigured()) await sendPushToUser(u, { title: "CBS pick'em: push FAILED", body: e.message }).catch(() => {});
        ran.push({ user: u, slot, ok: false });
      }
      store.setState(k, st);
    }
  }
  return ran;
}

/* ---------------- status ---------------- */
export function status(username) {
  const a = account(username);
  const s = getSettings(username);
  const r = s.recipe;
  return {
    configured: Boolean(a),
    email: a?.email || null,
    savedAt: a?.savedAt || null,
    enabled: s.enabled,
    paused: s.paused,
    notify: s.notify,
    pools: s.pools,
    testPoolId: s.testPoolId,
    verifiedOnce: s.verifiedOnce,
    recipe: r,
    recipeReady: Boolean(r.login && r.submit),
    hasReadback: Boolean(r.readback?.url && r.readback?.pickRegex),
    allowedHosts: ALLOWED_HOSTS(),
  };
}
