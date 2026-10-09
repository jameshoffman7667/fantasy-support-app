import crypto from "node:crypto";
import db from "./db.js";
import * as store from "./projectionStore.js";
import * as sleeperPublic from "./sleeper.js";

/**
 * v3.0 — Sleeper's PRIVATE (undocumented) GraphQL API, server-side only.
 *
 * What this is, honestly:
 *  - POST https://sleeper.app/graphql with the user's login token in an
 *    `authorization` header. It is the API Sleeper's own web app uses. It is
 *    not documented or supported, can change without notice, and Sleeper's
 *    terms (§5.20 automated means, §9.2 reverse engineering) arguably cover
 *    using it. No ban reports were found, but that is not a guarantee.
 *  - The query/mutation shapes come from github.com/Filip-Kin/sleeper-graphql's
 *    introspection notes. Proven (run for real by that project's author):
 *    reject_trade, roster_update_starters, update_matchup_leg. UNVERIFIED:
 *    roster_update_reserve, submit_waiver_claim, cancel_waiver_claim, the
 *    waiver-claim read-back, and league_event_logs with a token. This module
 *    never claims a write worked unless a read-back confirms it.
 *  - The sandbox that built this cannot reach sleeper.app; everything here is
 *    tested against a mock only.
 *
 * Safeguards: nothing is on by default. (1) The token is only stored when the
 * user pastes it (Account page) and is verified with `me`. (2) It is encrypted
 * at rest (AES-256-GCM, key from SESSION_SECRET or a generated secret) and is
 * NEVER sent to the browser. (3) Reading (inbox, change log) needs the token;
 * WRITING needs a second opt-in ("allow changes"), and every write call must
 * carry confirm:true from a confirmation step in the UI. (4) Every write is
 * logged in private_write_log, and read back to verify.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS private_write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, username TEXT NOT NULL,
    league_id TEXT, action TEXT NOT NULL, request TEXT, ok INTEGER NOT NULL, detail TEXT
  );
`);

export const ENDPOINT = process.env.SLEEPER_GRAPHQL_URL || "https://sleeper.app/graphql";
const tokenKey = (u) => `sleeper_token:${u}`;

/* ---------------- token storage (encrypted) ---------------- */
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = store.getState("private_secret", null);
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    store.setState("private_secret", s);
  }
  return s;
}
const aesKey = () => crypto.scryptSync(secret(), "fm-sleeper-token", 32);
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decrypt(blob) {
  try {
    const [iv, tag, enc] = String(blob).split(".").map((x) => Buffer.from(x, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function record(username) {
  return store.getState(tokenKey(username), null);
}

/**
 * v3.1 — per-user permissions. `reads` is one master switch for every private
 * read (trade offers, pending claims, League log); the three write groups are
 * separate: `roster` (lineup + IR moves), `claims` (waiver submit + cancel),
 * `trades` (reject + withdraw). A v3.0 record with the single "Allow changes"
 * flag maps to all three write groups on.
 */
export const WRITE_GROUPS = ["roster", "claims", "trades"];
export const PERM_KEYS = ["reads", ...WRITE_GROUPS];
export function permsOf(r) {
  if (!r) return { reads: false, roster: false, claims: false, trades: false };
  if (r.perms) return { reads: r.perms.reads !== false, roster: Boolean(r.perms.roster), claims: Boolean(r.perms.claims), trades: Boolean(r.perms.trades) };
  const w = Boolean(r.writes);
  return { reads: true, roster: w, claims: w, trades: w };
}
/** Never includes the token. */
export function status(username) {
  const r = record(username);
  if (!r) return { configured: false, writesEnabled: false, perms: permsOf(null) };
  const perms = permsOf(r);
  return { configured: true, perms, writesEnabled: WRITE_GROUPS.some((g) => perms[g]), claimsProven: claimsProven(username), sleeperUsername: r.sleeperUsername || null, sleeperUserId: r.sleeperUserId || null, verifiedAt: r.verifiedAt || null };
}
export const hasToken = (username) => Boolean(record(username)?.token);
function tokenOf(username) {
  const r = record(username);
  return r?.token ? decrypt(r.token) : null;
}

/* ---------------- transport ---------------- */
export class PrivateApiError extends Error {
  constructor(message, { code, status: st, kind } = {}) {
    super(message);
    this.name = "PrivateApiError";
    this.code = code;
    this.status = st;
    this.kind = kind || "error";
  }
}

/** One GraphQL round trip. Errors arrive as HTTP 200 + `errors`, so check both. */
export async function gql(token, query, variables, { timeoutMs = 15000 } = {}) {
  if (!token) throw new PrivateApiError("No Sleeper token is set up.", { kind: "no_token" });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify(variables ? { query, variables } : { query }), signal: ctl.signal });
  } catch (e) {
    throw new PrivateApiError(`Couldn't reach Sleeper's private API: ${e.name === "AbortError" ? "timed out" : e.message}`, { kind: "network" });
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PrivateApiError(`Sleeper's private API returned something unexpected (HTTP ${res.status}).`, { status: res.status, kind: "bad_response" });
  }
  if (!res.ok) throw new PrivateApiError(`Sleeper's private API said HTTP ${res.status}.`, { status: res.status, kind: res.status === 401 ? "unauthorized" : "http" });
  if (body.errors?.length) {
    const e = body.errors[0];
    const unauthorized = /unauthor/i.test(`${e.code} ${e.message}`);
    throw new PrivateApiError(`${e.code ? `${e.code}: ` : ""}${e.message || "unknown error"}`, { code: e.code, kind: unauthorized ? "unauthorized" : "graphql" });
  }
  return body.data || {};
}
const call = (username, query, variables, opts) => gql(tokenOf(username), query, variables, opts);

/* ---------------- setup ---------------- */
const ME = `query { me { user_id username display_name } }`;

/** Verifies the token with `me` (reads only), then stores it encrypted. Writes stay OFF. */
export async function setToken(username, rawToken) {
  const token = String(rawToken || "").trim().replace(/^Bearer\s+/i, "");
  if (token.length < 20 || token.length > 4000) throw new PrivateApiError("That doesn't look like a Sleeper token.", { kind: "invalid" });
  const data = await gql(token, ME);
  if (!data.me?.user_id) throw new PrivateApiError("Sleeper didn't recognise that token.", { kind: "unauthorized" });
  const prev = permsOf(record(username));
  store.setState(tokenKey(username), { token: encrypt(token), writes: false, perms: { reads: prev.reads || true, roster: false, claims: false, trades: false }, sleeperUsername: data.me.username || null, sleeperUserId: data.me.user_id, verifiedAt: Date.now() });
  return status(username);
}
export function clearToken(username) {
  db.prepare("DELETE FROM app_state WHERE key = ?").run(tokenKey(username));
  return status(username);
}
/** Legacy single switch: sets every write group at once. */
export function setWritesEnabled(username, on) {
  return setPerms(username, { roster: Boolean(on), claims: Boolean(on), trades: Boolean(on) });
}
/** Sets any of reads / roster / claims / trades (booleans); other keys are ignored. */
export function setPerms(username, patch) {
  const r = record(username);
  if (!r) throw new PrivateApiError("Set up your Sleeper token first.", { kind: "no_token" });
  const next = permsOf(r);
  for (const k of PERM_KEYS) if (patch && typeof patch[k] === "boolean") next[k] = patch[k];
  store.setState(tokenKey(username), { ...r, perms: next, writes: WRITE_GROUPS.some((g) => next[g]) });
  return status(username);
}
function needRead(username) {
  if (!permsOf(record(username)).reads) throw new PrivateApiError("Reading from Sleeper's private API is switched off (Account → Sleeper access).", { kind: "reads_off" });
}

/* ---------------- reads ---------------- */
const TX_FIELDS = "status type metadata created settings leg league_id draft_picks creator transaction_id adds drops consenter_ids roster_ids status_updated waiver_budget player_map";

/** All live trade offers in a league for a leg (`status:"proposed"`, not "pending"). */
export async function getProposedTrades(username, leagueId, leg) {
  needRead(username);
  const d = await call(username, `query($l:Snowflake!,$g:Int!){ league_transactions_by_status(league_id:$l, leg:$g, status:"proposed"){ ${TX_FIELDS} } }`, { l: String(leagueId), g: Number(leg) });
  return (d.league_transactions_by_status || []).filter((t) => t && t.type === "trade");
}

/** Waiver claims you have queued in Sleeper. UNVERIFIED: whether `status:"pending"` is the right word is a guess,
 *  so the distinct statuses seen are returned for diagnosis.
 *  v4.1: a claim made after the app's Tuesday 10:00 week change came back as "statuses seen: none" — the read looked
 *  at one leg only. Now every leg passed in is read (Sleeper's week and the next one), the results are merged by
 *  transaction id, and if the roster filter finds nothing at all the league-wide list is read and filtered to this
 *  roster here. Anything not finished (complete / failed / cancelled) counts as queued. */
const DONE_STATUSES = new Set(["complete", "completed", "failed", "cancelled", "canceled", "rejected", "processed"]);
export const claimLegs = (...legs) => [...new Set(legs.flat().map(Number).filter((n) => Number.isFinite(n) && n > 0))];
export async function getPendingClaims(username, leagueId, legs, rosterId) {
  needRead(username);
  const legList = claimLegs(legs);
  const q = (withRoster) => `query($l:Snowflake!,$g:Int!${withRoster ? ",$r:Int" : ""}){ league_transactions(league_id:$l, leg:$g, type:"waiver"${withRoster ? ", roster_id:$r" : ""}, limit:100){ ${TX_FIELDS} } }`;
  const read = async (withRoster) => {
    const rows = [];
    for (const g of legList) {
      const vars = { l: String(leagueId), g };
      if (withRoster) vars.r = Number(rosterId);
      const d = await call(username, q(withRoster), vars);
      rows.push(...(d.league_transactions || []).filter(Boolean));
    }
    return rows;
  };
  let all = await read(true);
  let scope = "roster";
  if (!all.length && rosterId != null) {
    all = (await read(false)).filter((t) => (t.roster_ids || []).map(Number).includes(Number(rosterId)));
    scope = "league";
  }
  const byId = new Map();
  for (const t of all) byId.set(String(t.transaction_id), t);
  const uniq = [...byId.values()];
  const claims = uniq.filter((t) => !DONE_STATUSES.has(String(t.status || "").toLowerCase()));
  return { claims, statuses: [...new Set(uniq.map((t) => t.status))], legs: legList, scope };
}

/** v4.1: "claim pushes work" — set by a verified read-back or by the user confirming he saw the claim in Sleeper.
 *  Until then the Claims page sends one claim per push. */
const provenKey = (u) => `claims_proven:${u}`;
export const claimsProven = (username) => store.getState(provenKey(username), null);
export function markClaimsProven(username, how) {
  const v = { at: Date.now(), how: how === "manual" ? "manual" : "verified" };
  store.setState(provenKey(username), v);
  return v;
}

/** Settings change log (who changed what, old → new). */
export async function getEventLogs(username, leagueId, limit = 30) {
  needRead(username);
  const d = await call(username, `query($l:Snowflake!,$n:Int){ league_event_logs(league_id:$l, limit:$n){ data created event_type league_id log_id } }`, { l: String(leagueId), n: limit });
  return (d.league_event_logs || []).filter(Boolean);
}

/** This roster's matchup leg for a round (what actually scores). */
export async function getMyLeg(username, leagueId, round, rosterId) {
  const d = await call(username, `query($l:Snowflake!,$r:Int!){ matchup_legs(league_id:$l, round:$r){ round leg roster_id starters } }`, { l: String(leagueId), r: Number(round) });
  return (d.matchup_legs || []).find((m) => m && Number(m.roster_id) === Number(rosterId)) || null;
}

/* ---------------- writes ---------------- */
function audit(username, leagueId, action, request, ok, detail) {
  db.prepare("INSERT INTO private_write_log (at, username, league_id, action, request, ok, detail) VALUES (?,?,?,?,?,?,?)").run(Date.now(), username, leagueId ? String(leagueId) : null, action, JSON.stringify(request).slice(0, 2000), ok ? 1 : 0, String(detail ?? "").slice(0, 1000));
}
export function writeLog(username, limit = 30) {
  return db.prepare("SELECT at, league_id AS leagueId, action, ok, detail FROM private_write_log WHERE username = ? ORDER BY id DESC LIMIT ?").all(username, limit);
}
const GROUP_LABEL = { roster: "Roster changes", claims: "Waiver claims", trades: "Trades" };
function guardWrite(username, confirm, group) {
  const s = status(username);
  if (!s.configured) throw new PrivateApiError("Set up your Sleeper token first (Account → Sleeper access).", { kind: "no_token" });
  if (!group || !WRITE_GROUPS.includes(group)) throw new PrivateApiError("Internal error: write group missing.", { kind: "invalid" });
  if (!s.perms[group]) throw new PrivateApiError(`${GROUP_LABEL[group]} to Sleeper are switched off. Turn on "${GROUP_LABEL[group]}" in Account → Sleeper access.`, { kind: "writes_off" });
  if (confirm !== true) throw new PrivateApiError("This needs an explicit confirmation.", { kind: "unconfirmed" });
}
async function doWrite(username, leagueId, action, request, fn) {
  try {
    store.setState(`priv_dirty:${username}:${leagueId}`, Date.now()); // v3.3 (R24): trade/claim snapshot is now out of date
    sleeperPublic.noteWrite(leagueId); // v3.3 (R1): the 5-minute rosters/matchups cache is skipped for 15 minutes after any push
    const out = await fn();
    audit(username, leagueId, action, request, out.ok !== false, out.detail || "");
    return out;
  } catch (e) {
    audit(username, leagueId, action, request, false, e.message);
    throw e;
  }
}

/** Reject an incoming trade offer. PROVEN mutation. Returns the status Sleeper reports back. */
export async function rejectTrade(username, { leagueId, transactionId, leg, confirm }) {
  guardWrite(username, confirm, "trades");
  return doWrite(username, leagueId, "reject_trade", { transactionId, leg }, async () => {
    const d = await call(username, `mutation($l:Snowflake!,$t:Snowflake!,$g:Int!){ reject_trade(league_id:$l, transaction_id:$t, leg:$g){ transaction_id status } }`, { l: String(leagueId), t: String(transactionId), g: Number(leg) });
    const r = d.reject_trade;
    const ok = String(r?.status).toLowerCase() === "rejected";
    return { ok, status: r?.status ?? null, detail: ok ? "rejected" : `Sleeper reported status "${r?.status}"` };
  });
}

/**
 * Withdraw an offer YOU made (v3.1). UNVERIFIED: the reference notes list no
 * dedicated withdraw/cancel mutation for a proposer (force_cancel_transaction is
 * commissioner-only), so this tries reject_trade on your own offer — the most
 * likely route — and then reads your open offers back. It only reports success
 * if the offer is no longer open (or Sleeper says rejected/cancelled).
 */
export async function withdrawTrade(username, { leagueId, transactionId, leg, confirm }) {
  guardWrite(username, confirm, "trades");
  return doWrite(username, leagueId, "withdraw_trade", { transactionId, leg }, async () => {
    let status = null;
    try {
      const d = await call(username, `mutation($l:Snowflake!,$t:Snowflake!,$g:Int!){ reject_trade(league_id:$l, transaction_id:$t, leg:$g){ transaction_id status } }`, { l: String(leagueId), t: String(transactionId), g: Number(leg) });
      status = d.reject_trade?.status ?? null;
    } catch (e) {
      return { ok: false, detail: `Sleeper refused the withdraw: ${e.message}. Withdraw it in Sleeper instead.` };
    }
    let stillOpen = null;
    try {
      const rows = await getProposedTrades(username, leagueId, leg);
      stillOpen = rows.some((t) => String(t.transaction_id) === String(transactionId));
    } catch {
      /* read-back unavailable */
    }
    const said = ["rejected", "cancelled", "canceled", "withdrawn"].includes(String(status).toLowerCase());
    const ok = stillOpen === false || (stillOpen === null && said);
    return { ok, status, verified: stillOpen === false, detail: ok ? "offer withdrawn" : `Sleeper answered "${status}" but the offer is still open when read back — withdraw it in Sleeper.` };
  });
}

/**
 * Set the starting lineup. roster_update_starters is proven, but it does NOT change
 * the matchup leg (what the app shows and scores) — so it is paired with
 * update_matchup_leg, and the leg is read back to verify. `starters` is the full
 * array in slot order, "0" for an empty slot.
 */
export async function updateStarters(username, { leagueId, rosterId, round, starters, confirm }) {
  guardWrite(username, confirm, "roster");
  const list = (Array.isArray(starters) ? starters : []).map((x) => (x == null || x === "" ? "0" : String(x)));
  const real = list.filter((x) => x !== "0");
  if (new Set(real).size !== real.length) throw new PrivateApiError("The lineup has the same player twice — nothing was sent.", { kind: "invalid" });
  return doWrite(username, leagueId, "update_lineup", { rosterId, round, starters: list }, async () => {
    await call(username, `mutation($l:Snowflake!,$r:Int!,$s:[String]){ roster_update_starters(league_id:$l, roster_id:$r, starters:$s){ roster_id starters } }`, { l: String(leagueId), r: Number(rosterId), s: list });
    await call(username, `mutation($l:Snowflake!,$r:Int!,$rd:Int!,$g:Int!,$s:[String]){ update_matchup_leg(league_id:$l, roster_id:$r, round:$rd, leg:$g, starters:$s){ roster_id starters } }`, { l: String(leagueId), r: Number(rosterId), rd: Number(round), g: Number(round), s: list });
    const leg = await getMyLeg(username, leagueId, round, rosterId);
    const got = (leg?.starters || []).map(String);
    const ok = got.length === list.length && got.every((x, i) => x === list[i]);
    return { ok, verified: ok, readBack: got, detail: ok ? "lineup set and verified" : "Sleeper accepted the call but the lineup read back differently — check Sleeper." };
  });
}

/** Move players to injured reserve. UNVERIFIED mutation — verified only by the response. */
export async function updateReserve(username, { leagueId, rosterId, reserve, confirm }) {
  guardWrite(username, confirm, "roster");
  const list = (Array.isArray(reserve) ? reserve : []).map(String);
  return doWrite(username, leagueId, "update_reserve", { rosterId, reserve: list }, async () => {
    const d = await call(username, `mutation($l:Snowflake!,$r:Int!,$s:[String]){ roster_update_reserve(league_id:$l, roster_id:$r, reserve:$s){ roster_id reserve } }`, { l: String(leagueId), r: Number(rosterId), s: list });
    const got = (d.roster_update_reserve?.reserve || []).map(String);
    const ok = list.every((id) => got.includes(id));
    return { ok, verified: ok, readBack: got, detail: ok ? "reserve updated and verified" : "Sleeper's response didn't list the reserve change — check Sleeper." };
  });
}

/**
 * v4.4: set the taxi squad (a player moved from taxi to the bench is left out of the list). UNVERIFIED: the mutation
 * name roster_update_taxi follows roster_update_reserve's pattern but has never been seen working — it is judged only
 * by Sleeper's response (the taxi it lists must not hold the players that were meant to leave).
 */
export async function updateTaxi(username, { leagueId, rosterId, taxi, confirm }) {
  guardWrite(username, confirm, "roster");
  const list = (Array.isArray(taxi) ? taxi : []).map(String);
  return doWrite(username, leagueId, "update_taxi", { rosterId, taxi: list }, async () => {
    const d = await call(username, `mutation($l:Snowflake!,$r:Int!,$s:[String]){ roster_update_taxi(league_id:$l, roster_id:$r, taxi:$s){ roster_id taxi } }`, { l: String(leagueId), r: Number(rosterId), s: list });
    const got = (d.roster_update_taxi?.taxi || []).map(String);
    const ok = got.length === list.length && list.every((id) => got.includes(id));
    return { ok, verified: ok, readBack: got, detail: ok ? "taxi squad updated and verified" : "Sleeper's response didn't match the new taxi squad — check Sleeper." };
  });
}

/** Submit ONE waiver claim. Verified by reading pending claims back.
 *  v4.1: `legs` = every leg the claim may be filed under. A claim Sleeper hands back with a transaction id counts as
 *  sent (ok) even when the read-back can't see it — it is then "sent, not verified" rather than a failure. */
export async function submitClaim(username, { leagueId, rosterId, leg, legs, addId, dropId, bid, confirm }) {
  guardWrite(username, confirm, "claims");
  const bidN = Math.max(0, Math.round(Number(bid) || 0));
  const req = { addId, dropId: dropId || null, bid: bidN };
  return doWrite(username, leagueId, "submit_waiver_claim", req, async () => {
    const vars = { l: String(leagueId), ka: [String(addId)], va: [Number(rosterId)], ks: ["waiver_bid"], vs: [bidN] };
    const hasDrop = dropId != null && dropId !== "";
    const q = hasDrop
      ? `mutation($l:Snowflake!,$ka:[String],$va:[Int],$kd:[String],$vd:[Int],$ks:[String],$vs:[Int]){ submit_waiver_claim(league_id:$l, k_adds:$ka, v_adds:$va, k_drops:$kd, v_drops:$vd, k_settings:$ks, v_settings:$vs){ transaction_id status leg adds drops settings } }`
      : `mutation($l:Snowflake!,$ka:[String],$va:[Int],$ks:[String],$vs:[Int]){ submit_waiver_claim(league_id:$l, k_adds:$ka, v_adds:$va, k_settings:$ks, v_settings:$vs){ transaction_id status leg adds drops settings } }`;
    if (hasDrop) Object.assign(vars, { kd: [String(dropId)], vd: [Number(rosterId)] });
    const d = await call(username, q, vars);
    const tx = d.submit_waiver_claim;
    if (!tx?.transaction_id) return { ok: false, verified: false, detail: "Sleeper didn't return a claim." };
    // The leg Sleeper filed it under (when it says) is read first.
    const legList = claimLegs(tx.leg, legs || [], leg);
    let back = { claims: [], statuses: [], legs: legList, scope: "roster" };
    let readErr = null;
    try {
      back = await getPendingClaims(username, leagueId, legList, rosterId);
    } catch (e) {
      readErr = e.message;
    }
    const found = back.claims.some((c) => String(c.transaction_id) === String(tx.transaction_id));
    if (found) markClaimsProven(username, "verified");
    return {
      ok: true,
      verified: found,
      transactionId: tx.transaction_id,
      status: tx.status ?? null,
      leg: tx.leg ?? null,
      detail: found
        ? "claim registered and verified"
        : `Sleeper accepted it (status "${tx.status}") but the read-back couldn't see it (weeks checked: ${back.legs.join(", ") || "none"}; statuses seen: ${back.statuses.join(", ") || "none"}${readErr ? `; read failed: ${readErr}` : ""}). Check Sleeper.`,
    };
  });
}

/** Cancel one of your pending claims. UNVERIFIED mutation. */
export async function cancelClaim(username, { leagueId, transactionId, leg, confirm }) {
  guardWrite(username, confirm, "claims");
  return doWrite(username, leagueId, "cancel_waiver_claim", { transactionId, leg }, async () => {
    const d = await call(username, `mutation($l:Snowflake!,$t:Snowflake!,$g:Int!){ cancel_waiver_claim(league_id:$l, transaction_id:$t, leg:$g){ transaction_id status } }`, { l: String(leagueId), t: String(transactionId), g: Number(leg) });
    return { ok: Boolean(d.cancel_waiver_claim), status: d.cancel_waiver_claim?.status ?? null, detail: `status ${d.cancel_waiver_claim?.status}` };
  });
}
