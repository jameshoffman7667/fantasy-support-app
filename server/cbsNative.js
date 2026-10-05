/**
 * v3.3 — native CBS pick'em adapter, written from the requests James captured in his own browser
 * (CBS sign-in = a Next.js "server action"; pick'em = Apollo GraphQL with persisted-query hashes).
 *
 * HONESTY: this has been tested against a mock that reproduces the captured request/response shapes — NOT against
 * the real cbssports.com (the build sandbox can't reach it). Unverified until the first real "Test login":
 *   - whether CBS accepts a scripted sign-in at all (reCAPTCHA is enabled on its login page),
 *   - whether the sign-in sets its session cookies in the HTTP response (cookies set by page JavaScript can't be captured),
 *   - whether the picks site accepts those cookies directly,
 *   - the build-specific "next-action" id (re-discovered from CBS's JavaScript when the saved one stops working),
 *   - how CBS treats a save that includes a started game (the app never sends one).
 * Everything here is plain functions with an injectable fetch so it can be tested without the network.
 */

export class NativeError extends Error {
  constructor(m, extra = {}) {
    super(m);
    this.name = "NativeError";
    Object.assign(this, extra);
  }
}

const ALLOWED = () => (process.env.CBS_ALLOWED_HOSTS || "cbssports.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export function assertHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NativeError(`"${url}" is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new NativeError("Only https URLs are allowed.");
  const h = u.hostname.toLowerCase();
  if (!ALLOWED().some((d) => h === d || h.endsWith("." + d))) throw new NativeError(`Host ${h} isn't allowed (set CBS_ALLOWED_HOSTS to change).`);
  return u;
}

/** Values captured from James's browser. All overridable in settings (`native`) because CBS can change any of them. */
export const DEFAULTS = {
  loginUrl: "https://www.cbssports.com/login?masterProductId=41406&product_abbrev=opm&show_opts=1&xurl=" + encodeURIComponent("https://picks.cbssports.com/football/lobby"),
  lobbyUrl: "https://picks.cbssports.com/football/lobby",
  graphqlUrl: "https://picks.cbssports.com/graphql",
  masterProductId: "41406",
  nextActionId: "600adc38e75190584ec8a2afb27a57000b03324cd9",
  routerStateTree: '["",{"children":["login",{"children":["__PAGE__",{},null,null,4256]},null,null,4192]},null,null,4176]',
  picksPageHash: "6e74c75b0e9548f80e1cb551848dc9235063e302b28e10cfa941af1794208848",
  saveHash: "54fd661577fa3261420c02a03301913612af353f94bace5a792e8425495c2276",
  apolloVersion: "4.2.12",
};
const UA = () => process.env.CBS_USER_AGENT || "Mozilla/5.0 (compatible; fantasy-manager)";
export const cfgOf = (native = {}) => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(native || {}).filter(([, v]) => typeof v === "string" && v)) });

/* ---------------- base32 ids (CBS ids are lowercase RFC4648 base32 of readable text, e.g. "Pool:123") ---------------- */
const ALPHA = "abcdefghijklmnopqrstuvwxyz234567";
export function b32encode(text) {
  const bytes = Buffer.from(String(text), "utf8");
  let bits = 0;
  let val = 0;
  let out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}
export function b32decode(s) {
  const clean = String(s).toLowerCase().replace(/=+$/, "");
  let bits = 0;
  let val = 0;
  const bytes = [];
  for (const ch of clean) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) return null;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Accepts the pool's address from the browser (with ?entryId=), a raw base32 id, or a number. */
export function parsePoolInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let poolId = null;
  let entryId = null;
  const url = raw.match(/https?:\/\/\S+/)?.[0];
  if (url) {
    const m = url.match(/\/pools\/([a-z2-7=]+)/i);
    if (m) poolId = m[1].toLowerCase();
    const e = url.match(/[?&]entryId=([a-z2-7=]+)/i);
    if (e) entryId = e[1].toLowerCase();
  } else {
    const tok = raw.split(/\s+/)[0];
    if (/^\d+$/.test(tok)) poolId = b32encode(`Pool:${tok}`);
    else if (/^[a-z2-7]+=*$/i.test(tok) && b32decode(tok)?.startsWith("Pool:")) poolId = tok.toLowerCase();
  }
  if (!poolId || !String(b32decode(poolId) || "").startsWith("Pool:")) return null;
  return { id: poolId, entryId: entryId && String(b32decode(entryId) || "").startsWith("Entry:") ? entryId : null };
}

/* ---------------- HTTP with a cookie jar (name -> value; every host is cbssports.com) ---------------- */
export function makeHttp(jar, fetchImpl = fetch) {
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (res) => {
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
  };
  return async function http({ url, method = "GET", headers = {}, body, timeoutMs = 20000 }) {
    let u = url;
    let m = method;
    let b = body;
    const h = { "User-Agent": UA(), ...headers };
    for (let hop = 0; hop < 6; hop++) {
      assertHost(u);
      const ck = cookieHeader();
      const res = await fetchImpl(u, { method: m, headers: { ...h, ...(ck ? { Cookie: ck } : {}) }, body: b, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      absorb(res);
      const loc = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        u = new URL(loc, u).toString();
        if (res.status !== 307 && res.status !== 308) {
          m = "GET";
          b = undefined;
          delete h["content-type"];
          delete h["Content-Type"];
        }
        continue;
      }
      return { status: res.status, text: await res.text().catch(() => ""), url: u, contentType: res.headers.get("content-type") || "" };
    }
    throw new NativeError("Too many redirects.");
  };
}

/* ---------------- login (Next.js server action) ---------------- */
function chunkUrls(html) {
  const re = /\/cbssports\/_next\/static\/chunks\/[A-Za-z0-9_\-.]+\.js(?:\?dpl=[A-Za-z0-9_\-]+)?/g;
  return [...new Set(html.match(re) || [])].slice(0, 30);
}
/** Candidate server-action ids found in CBS's JavaScript, most login-looking first. */
export function actionCandidates(chunkTexts) {
  const out = [];
  const re = /createServerReference\)?\(\s*["']([0-9a-f]{40,64})["']([^)]{0,200})\)/g;
  for (const t of chunkTexts) {
    for (const m of t.matchAll(re)) {
      const quoted = [...m[2].matchAll(/["']([A-Za-z0-9_$]+)["']/g)].map((x) => x[1]);
      const name = quoted[quoted.length - 1] || "";
      out.push({ id: m[1], name, score: /login|signin|sign_in/i.test(name) ? 2 : /auth/i.test(name) ? 1 : 0 });
    }
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => b.score - a.score);
}

function loginHeaders(cfg, dpl, actionId) {
  return {
    accept: "text/x-component",
    "content-type": "text/plain;charset=UTF-8",
    "next-action": actionId,
    "next-router-state-tree": encodeURIComponent(cfg.routerStateTree),
    origin: "https://www.cbssports.com",
    referer: cfg.loginUrl,
    ...(dpl ? { "x-deployment-id": dpl } : {}),
  };
}
function loginBody(cfg, email, password) {
  return JSON.stringify([
    { user: null, hasMissingFields: false, isAuth: false, error: null, missingFields: [], masterProductId: cfg.masterProductId, deleteAccount: false, devSource: "", refCode: "$undefined", refPage: "https://picks.cbssports.com/" },
    { email, password },
  ]);
}
function judgeLogin(r) {
  if (/"isAuth"\s*:\s*true/.test(r.text)) return { state: "ok" };
  if (/"isAuth"\s*:\s*false/.test(r.text)) {
    const err = r.text.match(/"error"\s*:\s*("(?:[^"\\]|\\.)*"|\{[^}]*\})/)?.[1];
    return { state: "rejected", detail: err ? `CBS said: ${err.slice(0, 200)}` : "CBS did not sign you in (wrong email/password, or it asked for another step)" };
  }
  return { state: "unknown", detail: `unrecognised response (HTTP ${r.status})` };
}

/**
 * Signs in. Tries the saved/captured server-action id first; only if the response doesn't look like the login action
 * answered at all (id changed after a CBS deploy) does it look the id up in CBS's JavaScript and try up to 3 candidates.
 * Credentials are only ever sent to the allow-listed CBS host. Returns { ok, detail, actionId, cookieNames, warnings }.
 */
export async function nativeLogin({ email, password, jar, fetchImpl, native }) {
  const cfg = cfgOf(native);
  const http = makeHttp(jar, fetchImpl);
  const warnings = [];
  const page = await http({ url: cfg.loginUrl, headers: { accept: "text/html" } });
  if (page.status >= 400) throw new NativeError(`CBS login page returned HTTP ${page.status}.`);
  const dpl = page.text.match(/dpl=([A-Za-z0-9_\-]+)/)?.[1] || null;
  const tried = new Set();
  const attempt = async (id) => {
    tried.add(id);
    const r = await http({ url: cfg.loginUrl, method: "POST", headers: loginHeaders(cfg, dpl, id), body: loginBody(cfg, email, password) });
    return { r, j: judgeLogin(r) };
  };
  let { r, j } = await attempt(cfg.nextActionId);
  let actionId = cfg.nextActionId;
  if (j.state === "unknown") {
    const texts = [];
    for (const p of chunkUrls(page.text)) {
      try {
        const c = await http({ url: "https://www.cbssports.com" + p, headers: { accept: "*/*" } });
        if (c.status === 200) texts.push(c.text);
      } catch {
        /* skip a chunk that fails */
      }
    }
    const cands = actionCandidates(texts).filter((c) => !tried.has(c.id)).slice(0, 3);
    for (const c of cands) {
      const a = await attempt(c.id);
      if (a.j.state !== "unknown") {
        r = a.r;
        j = a.j;
        actionId = c.id;
        warnings.push(`The saved sign-in id no longer worked; found a new one in CBS's code (${c.name || "unnamed"}). It is saved for next time.`);
        break;
      }
    }
    if (j.state === "unknown") return { ok: false, detail: `CBS didn't recognise the sign-in request (${j.detail}); tried ${tried.size} action id(s). CBS may have changed its sign-in or be blocking scripted sign-ins.`, actionId: null, cookieNames: [...jar.keys()].sort(), warnings };
  }
  if (j.state === "rejected") return { ok: false, detail: j.detail, actionId, cookieNames: [...jar.keys()].sort(), warnings };
  // Let the picks site set whatever it needs (the real flow lands on its lobby after sign-in).
  let lobby = null;
  try {
    lobby = await http({ url: cfg.lobbyUrl, headers: { accept: "text/html" } });
  } catch (e) {
    warnings.push(`Signed in, but opening the picks lobby failed: ${e.message}`);
  }
  const names = [...jar.keys()].sort();
  if (!names.some((n) => /auth|session/i.test(n))) warnings.push("The sign-in response set no cookie with 'auth' or 'session' in its name — CBS may set the session from page JavaScript, which this can't do.");
  return { ok: true, detail: "CBS accepted the sign-in.", actionId, cookieNames: names, warnings, lobbyStatus: lobby?.status ?? null };
}

/* ---------------- GraphQL ---------------- */
function gqlHeaders(extra = {}) {
  return {
    accept: "application/graphql-response+json,application/json;q=0.9",
    "apollographql-client-name": "picks-ui-client",
    "apollographql-client-version": "1.0",
    "content-type": "application/json",
    origin: "https://picks.cbssports.com",
    "x-ismanagermodeenabled": "false",
    ...extra,
  };
}
function parseGql(r, what) {
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new NativeError(`CBS ${what}: unexpected non-JSON answer (HTTP ${r.status}). Probably signed out or blocked.`, { code: r.status === 401 || r.status === 403 || /<html/i.test(r.text) ? "unauth" : "bad" });
  }
  if (j.errors?.length) {
    const msg = j.errors.map((e) => e.message).filter(Boolean).join("; ").slice(0, 300);
    const code = /PersistedQuery/i.test(msg) ? "hash" : /unauth|forbidden|not logged|login/i.test(msg) || j.errors.some((e) => /UNAUTH|FORBIDDEN/i.test(e.extensions?.code || "")) ? "unauth" : "gql";
    throw new NativeError(`CBS ${what} failed: ${msg}${code === "hash" ? " (CBS changed its stored query; the hash in Account → CBS → Advanced needs updating)" : ""}`, { code });
  }
  if (r.status >= 400) throw new NativeError(`CBS ${what}: HTTP ${r.status}.`, { code: r.status === 401 || r.status === 403 ? "unauth" : "bad" });
  return j.data;
}

/** The week's games (with CBS slot/team ids), the entry's saved picks and tiebreaker. */
export async function readPicksPage({ jar, fetchImpl, native, pool }) {
  const cfg = cfgOf(native);
  const http = makeHttp(jar, fetchImpl);
  const variables = { poolId: pool.id, ...(pool.entryId ? { entryId: pool.entryId } : {}), returnUpToCurrent: true };
  const extensions = { clientLibrary: { name: "@apollo/client", version: cfg.apolloVersion }, persistedQuery: { version: 1, sha256Hash: cfg.picksPageHash } };
  const url = `${cfg.graphqlUrl}?operationName=FootballPickemManagerPicksPage&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
  const r = await http({ url, headers: gqlHeaders({ referer: `https://picks.cbssports.com/football/pickem/pools/${pool.id}${pool.entryId ? `?entryId=${pool.entryId}` : ""}` }) });
  return normalizePage(parseGql(r, "picks page"));
}
export function normalizePage(data) {
  const cp = data?.commonPool;
  const ce = data?.commonEntry;
  if (!cp?.poolPeriod || !ce) throw new NativeError("CBS answered, but not with a picks page (missing pool, week or entry).", { code: "bad" });
  const events = (cp.poolPeriod.poolEvents || []).map((e) => ({
    id: e.id,
    eventId: e.cbsEventId,
    away: e.awayTeam?.abbrev,
    home: e.homeTeam?.abbrev,
    awayTeamId: e.awayTeamId,
    homeTeamId: e.homeTeamId,
    awayNum: e.awayTeam?.cbsTeamId,
    homeNum: e.homeTeam?.cbsTeamId,
    startsAt: e.startsAt ?? null,
    isLocked: Boolean(e.isLocked),
    status: e.gameStatus || null,
  }));
  const picks = {};
  for (const p of ce.entryPicks || []) picks[String(p.cbsSlotId)] = p.cbsItemId;
  const q = cp.entryTiebreakerQuestions?.[0] || null;
  const ans = (ce.entryTiebreakersAnswers || []).find((a) => !q || a.tiebreakerQuestionId === q.id) || null;
  return {
    poolName: cp.name || null,
    poolPeriodId: cp.poolPeriod.id,
    week: cp.poolPeriod.order ?? null,
    isCurrent: Boolean(cp.poolPeriod.isCurrent),
    entryId: ce.id,
    events,
    picks,
    picksCount: ce.picksCount ?? null,
    maxPicksCount: ce.maxPicksCount ?? null,
    tiebreakerQuestionId: q?.id || null,
    tiebreakerValue: ans?.value ?? null,
    myEntries: (cp.myEntries || []).map((e) => e.id),
  };
}

/* ---------------- matching & planning ---------------- */
const CANON = { JAC: "JAX", WAS: "WSH", ARZ: "ARI", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
export const canonTeam = (t) => {
  const u = String(t || "").toUpperCase();
  return CANON[u] || u;
};

/**
 * Decide what to send. `games` = the app's unstarted games; `picks` = Map(gameKey -> {pick}); tiebreaker = number|null.
 * Never includes a game CBS marks locked or that the app/CBS says has started.
 */
export function planPush({ page, games, picks, tiebreaker, tbOpen, now = Date.now() }) {
  const byTeams = new Map(page.events.map((e) => [`${canonTeam(e.away)}@${canonTeam(e.home)}`, e]));
  const toSave = [];
  const unchanged = [];
  const unmatched = [];
  const skippedLocked = [];
  for (const g of games) {
    const pick = picks.get(g.key)?.pick;
    if (!pick) continue;
    const ev = byTeams.get(`${canonTeam(g.away)}@${canonTeam(g.home)}`);
    if (!ev) {
      unmatched.push(g.key);
      continue;
    }
    if (ev.isLocked || (ev.startsAt != null && ev.startsAt <= now) || (ev.status && ev.status !== "S")) {
      skippedLocked.push(g.key);
      continue;
    }
    const wantTeam = canonTeam(pick) === canonTeam(ev.home) ? "home" : canonTeam(pick) === canonTeam(ev.away) ? "away" : null;
    if (!wantTeam) {
      unmatched.push(g.key);
      continue;
    }
    const itemId = wantTeam === "home" ? ev.homeTeamId : ev.awayTeamId;
    const teamNum = wantTeam === "home" ? ev.homeNum : ev.awayNum;
    const row = { gameKey: g.key, pick, slotId: ev.id, itemId, eventId: ev.eventId, teamNum };
    if (page.picks[String(ev.eventId)] === teamNum) unchanged.push(row);
    else toSave.push(row);
  }
  const tb = tbOpen && tiebreaker != null && Number.isFinite(Number(tiebreaker)) && page.tiebreakerQuestionId ? Math.round(Number(tiebreaker)) : null;
  const tbChange = tb != null && tb !== page.tiebreakerValue ? tb : null;
  return { toSave, unchanged, unmatched, skippedLocked, tiebreaker: tbChange };
}

/** Builds the GraphQL save request body from a plan (no network). */
export function buildSaveBody({ page, plan, native }) {
  const cfg = cfgOf(native);
  const tbOn = plan.tiebreaker != null;
  return {
    operationName: "FootballPickemManagerSavePicksMutation",
    variables: {
      entryId: page.entryId,
      poolPeriodId: page.poolPeriodId,
      picksToSave: plan.toSave.map((p) => ({ slotId: p.slotId, itemId: p.itemId })),
      picksToDelete: [],
      tiebreakerAnswers: tbOn ? [{ tiebreakerQuestionId: page.tiebreakerQuestionId, value: plan.tiebreaker, entryId: page.entryId, poolPeriodId: page.poolPeriodId }] : [],
      skipSavePicks: plan.toSave.length === 0,
      skipSaveTiebreakerAnswer: !tbOn,
    },
    extensions: { clientLibrary: { name: "@apollo/client", version: cfg.apolloVersion }, persistedQuery: { version: 1, sha256Hash: cfg.saveHash } },
  };
}

/** Sends the save and checks CBS's echo (it returns ALL saved picks) against what was sent. */
export async function savePicks({ jar, fetchImpl, native, pool, page, plan }) {
  const cfg = cfgOf(native);
  const http = makeHttp(jar, fetchImpl);
  const body = buildSaveBody({ page, plan, native });
  const r = await http({ url: cfg.graphqlUrl, method: "POST", headers: gqlHeaders({ referer: `https://picks.cbssports.com/football/pickem/pools/${pool.id}?entryId=${page.entryId}` }), body: JSON.stringify(body) });
  const data = parseGql(r, "save");
  const echoed = Array.isArray(data?.savePicks) ? data.savePicks : null;
  const now = {};
  if (echoed) for (const p of echoed) now[String(p.cbsSlotId)] = p.cbsItemId;
  let matched = 0;
  const notMatching = [];
  for (const p of plan.toSave) {
    if (echoed && now[String(p.eventId)] === p.teamNum) matched++;
    else notMatching.push(p.gameKey);
  }
  const tbEcho = Array.isArray(data?.saveEntryTiebreakerAnswer) ? data.saveEntryTiebreakerAnswer[0]?.value : undefined;
  const tbOk = plan.tiebreaker == null ? null : tbEcho === plan.tiebreaker;
  return { echoed: Boolean(echoed), matched, checked: plan.toSave.length, notMatching, tiebreakerOk: tbOk, savedPicks: echoed ? now : null, tiebreakerValue: tbEcho ?? null };
}

/* ---------------- "changed on CBS" detection ---------------- */
export const snapshotOf = (page) => ({ picks: { ...page.picks }, tb: page.tiebreakerValue ?? null, at: Date.now() });
/**
 * Compares a fresh CBS read with the last snapshot (what CBS held after the app's last push, or when auto mode last looked).
 * Only games still unlocked can be changed on CBS, so only those are compared. Returns the changed event ids / 'tiebreaker'.
 */
export function externalChanges(prev, page) {
  if (!prev) return [];
  const changed = [];
  for (const e of page.events) {
    if (e.isLocked) continue;
    const k = String(e.eventId);
    if ((prev.picks?.[k] ?? null) !== (page.picks[k] ?? null)) changed.push(k);
  }
  if ((prev.tb ?? null) !== (page.tiebreakerValue ?? null)) changed.push("tiebreaker");
  return changed;
}
