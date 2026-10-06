import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "./db.js";

/**
 * v3.5 — player trade values.
 *
 *   Dynasty leagues:          Roster Audit (rosteraudit.com, free, keyless), superflex or 1QB values by Sleeper id.
 *   Redraft / keeper leagues: FantasyCalc redraft values (api.fantasycalc.com, free, keyless).
 *   Fallbacks:                dynasty → FantasyCalc dynasty values; redraft → none (the caller uses rest-of-season
 *                             projections instead).
 *
 * Values are "higher is better" numbers on each source's own scale, so they are only ever compared within one
 * source. Bulk tables are pulled at most once a day per format and the last good copy is kept for a week, so a
 * dead site degrades to yesterday's values rather than nothing.
 *
 * UNVERIFIED (neither site is reachable from the build sandbox): response shapes. The parsers below accept the
 * documented field names plus the obvious variants (arrays, id-keyed objects, nesting under data/values/players).
 */
const RA_BASE = process.env.ROSTER_AUDIT_BASE || "https://rosteraudit.com/wp-json/ra/v1";
const FC_BASE = process.env.FANTASYCALC_BASE || "https://api.fantasycalc.com";
const USER_AGENT = process.env.VALUES_USER_AGENT || "fantasy-manager (personal self-hosted app)";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TABLE_TTL = DAY;
const LAST_GOOD_TTL = 7 * DAY;
const FAIL_TTL = 10 * 60 * 1000;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function getJson(url, { method = "GET", body = null, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Cached fetch of a whole table: fresh copy for `ttl`, last good copy for a week, failures remembered 10 minutes. */
async function cachedTable(key, ttl, fetcher) {
  const hit = cacheGet(key);
  if (hit !== null) return { ...hit, stale: false };
  const last = cacheGet(`${key}:last`);
  if (cacheGet(`${key}:fail`) !== null) return last ? { ...last, stale: true } : null;
  try {
    const value = await fetcher();
    const rec = { at: Date.now(), value };
    cacheSet(key, rec, ttl);
    cacheSet(`${key}:last`, rec, LAST_GOOD_TTL);
    return { ...rec, stale: false };
  } catch (err) {
    console.warn(`[values] ${key} unavailable: ${err.message}`);
    cacheSet(`${key}:fail`, err.message, FAIL_TTL);
    return last ? { ...last, stale: true, error: err.message } : { at: null, value: null, error: err.message };
  }
}

/* ---------------- Roster Audit (dynasty) ---------------- */

/** Roster Audit's scoring preset for a league: sf_ppr, 1qb_ppr, sf_half, 1qb_half or sf_ppr_tep. */
export function raFormatKey({ superflex = false, ppr = 1, tep = false } = {}) {
  const qb = superflex ? "sf" : "1qb";
  const rec = Number(ppr) >= 1 ? "ppr" : "half"; // standard scoring has no preset; half-PPR is the nearest
  if (tep && superflex && rec === "ppr") return "sf_ppr_tep";
  return `${qb}_${rec}`;
}

function listFrom(json) {
  if (Array.isArray(json)) return json;
  for (const k of ["data", "values", "players", "rankings", "results", "items"]) {
    if (Array.isArray(json?.[k])) return json[k];
    if (json?.[k] && typeof json[k] === "object") return listFrom(json[k]);
  }
  if (json && typeof json === "object") {
    // id-keyed object: { "4046": { val_sf, val_1qb } } or { "4046": [sf, oneqb] }
    return Object.entries(json)
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => (Array.isArray(v) ? { sleeper_id: k, val_sf: v[0], val_1qb: v[1] } : typeof v === "object" ? { sleeper_id: k, ...v } : { sleeper_id: k, value: v }));
  }
  return [];
}

/** Map(sleeperId → { sf, oneqb, trend7, trend30, age, name, pos }) from any of Roster Audit's player list shapes. */
export function parseRaValues(json) {
  const out = new Map();
  for (const e of listFrom(json)) {
    if (!e || typeof e !== "object") continue;
    const id = e.sleeper_id ?? e.sleeperId ?? e.sleeper ?? e.player_id ?? e.id;
    if (id == null) continue;
    const sf = num(e.val_sf ?? e.sf ?? e.value_sf ?? e.superflex ?? e.sf_value);
    const oneqb = num(e.val_1qb ?? e["1qb"] ?? e.oneqb ?? e.value_1qb ?? e.one_qb ?? e["1qb_value"]);
    const single = num(e.value);
    if (sf == null && oneqb == null && single == null) continue;
    out.set(String(id), {
      sf: sf ?? single,
      oneqb: oneqb ?? single,
      trend7: num(e.trend_7d ?? e.trend7 ?? e.trend_7),
      trend30: num(e.trend_30d ?? e.trend30 ?? e.trend_30),
      age: num(e.age),
      name: e.name || e.player_name || null,
      pos: e.position || e.pos || null,
    });
  }
  return out;
}

export async function raValues(fmt) {
  const r = await cachedTable(`values:ra:${fmt}`, TABLE_TTL, async () => {
    const json = await getJson(`${RA_BASE}/rankings/values?format_key=${encodeURIComponent(fmt)}`);
    const map = parseRaValues(json);
    if (!map.size) throw new Error("no usable values in the response");
    return [...map.entries()];
  });
  return { at: r?.at ?? null, stale: Boolean(r?.stale), error: r?.error || null, map: new Map(r?.value || []) };
}

/**
 * Pick values: [{ season, round, slot: early|mid|late, sf, oneqb }]. Accepts a flat list or one entry per
 * season+round with nested early/mid/late objects or arrays.
 */
export function parseRaPicks(json) {
  const out = [];
  const add = (season, round, slot, v) => {
    const sf = num(v?.val_sf ?? v?.sf ?? v?.value_sf ?? (Array.isArray(v) ? v[0] : null));
    const oneqb = num(v?.val_1qb ?? v?.["1qb"] ?? v?.oneqb ?? v?.value_1qb ?? (Array.isArray(v) ? v[1] : null));
    const single = num(v?.value ?? (typeof v === "number" ? v : null));
    if (sf == null && oneqb == null && single == null) return;
    out.push({ season: num(season), round: num(round), slot: String(slot || "mid").toLowerCase(), sf: sf ?? single, oneqb: oneqb ?? single });
  };
  const visit = (e, ctx = {}) => {
    if (!e || typeof e !== "object") return;
    const season = e.season ?? e.year ?? e.draft_year ?? ctx.season;
    const round = e.round ?? ctx.round;
    if (num(e.val_sf) != null || num(e.val_1qb) != null || num(e.value) != null) return add(season, round, e.slot ?? e.tier ?? e.position ?? ctx.slot, e);
    for (const slot of ["early", "mid", "late"]) if (e[slot] != null) add(season, round, slot, e[slot]);
    for (const k of ["val_sf", "val_1qb"]) {
      const v = e[k];
      if (v && typeof v === "object" && !Array.isArray(v)) for (const slot of ["early", "mid", "late"]) if (v[slot] != null) add(season, round, slot, { [k]: v[slot] });
    }
    for (const k of ["picks", "rounds", "data", "values", "items"]) if (Array.isArray(e[k])) e[k].forEach((x) => visit(x, { season, round }));
  };
  if (Array.isArray(json)) json.forEach((x) => visit(x));
  else visit(json);
  // merge duplicates created by the per-format nesting above
  const merged = new Map();
  for (const p of out) {
    const k = `${p.season}|${p.round}|${p.slot}`;
    const m = merged.get(k) || { season: p.season, round: p.round, slot: p.slot, sf: null, oneqb: null };
    m.sf = m.sf ?? p.sf;
    m.oneqb = m.oneqb ?? p.oneqb;
    merged.set(k, m);
  }
  return [...merged.values()].filter((p) => p.round != null);
}

export async function raPicks() {
  const r = await cachedTable("values:ra:picks", TABLE_TTL, async () => {
    const list = parseRaPicks(await getJson(`${RA_BASE}/picks`));
    if (!list.length) throw new Error("no usable pick values in the response");
    return list;
  });
  return { at: r?.at ?? null, error: r?.error || null, list: r?.value || [] };
}

/** Value of one pick: exact season, else the nearest season listed; slot defaults to mid. */
export function pickValue(list, { season, round, slot = "mid" }, superflex) {
  if (!list?.length || round == null) return null;
  const pick = (p) => (p ? (superflex ? p.sf ?? p.oneqb : p.oneqb ?? p.sf) : null);
  const same = list.filter((p) => p.round === Number(round) && p.slot === slot);
  if (!same.length) return null;
  const exact = same.find((p) => p.season === Number(season));
  if (exact) return pick(exact);
  const sorted = [...same].sort((a, b) => Math.abs((a.season ?? 0) - Number(season)) - Math.abs((b.season ?? 0) - Number(season)));
  return pick(sorted[0]);
}

/** One player's Roster Audit profile (values, trends, age) — for the player card. Cached 12 hours. */
export async function raPlayer(sleeperId) {
  const key = `values:ra:player:${sleeperId}`;
  const r = await cachedTable(key, 12 * HOUR, async () => {
    const json = await getJson(`${RA_BASE}/players/${encodeURIComponent(sleeperId)}`);
    const one = parseRaValues(Array.isArray(json) ? json : json?.player ? [json.player] : [{ sleeper_id: sleeperId, ...json }]).get(String(sleeperId));
    if (!one) throw new Error("player not found in the response");
    return one;
  });
  return r?.value || null;
}

// The trade calculator allows 40 calls an hour (keyless). Stay under 35 and cache results.
const calcTimes = [];
const CALC_LIMIT = 35;
export function calcBudgetLeft(now = Date.now()) {
  while (calcTimes.length && now - calcTimes[0] > HOUR) calcTimes.shift();
  return CALC_LIMIT - calcTimes.length;
}

/** Roster Audit's own verdict on a trade. sides: [{type:'player', id}|{type:'pick', season, round, slot}]. */
export function parseRaCalc(json) {
  const a = json?.side_a || json?.sideA || {};
  const b = json?.side_b || json?.sideB || {};
  const warnings = json?.cliff_warnings || json?.cliffWarnings || json?.warnings || [];
  return {
    totalA: num(a.total_value ?? a.totalValue ?? a.total),
    totalB: num(b.total_value ?? b.totalValue ?? b.total),
    differential: num(json?.differential ?? json?.diff),
    verdict: json?.verdict || null,
    cliffWarnings: (Array.isArray(warnings) ? warnings : []).map((w) => (typeof w === "string" ? w : w?.message || w?.text || JSON.stringify(w))).slice(0, 6),
  };
}

export async function raCalc({ sideA, sideB, superflex }, { cacheOnly = false } = {}) {
  const sig = JSON.stringify([sideA, sideB, Boolean(superflex)]);
  const key = `values:ra:calc:${createHash("sha1").update(sig).digest("hex")}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  if (cacheOnly) return null;
  if (calcBudgetLeft() <= 0) return { skipped: "Roster Audit's hourly calculator limit reached; try again later." };
  calcTimes.push(Date.now());
  try {
    const json = await getJson(`${RA_BASE}/trade/calculate`, { method: "POST", body: { side_a: sideA, side_b: sideB, settings: { is_superflex: Boolean(superflex) } } });
    const out = parseRaCalc(json);
    cacheSet(key, out, 6 * HOUR);
    return out;
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------------- FantasyCalc (redraft; dynasty fallback) ---------------- */

/** Map(sleeperId → { value, redraft, dynasty, trend30 }) from FantasyCalc's /values/current. */
export function parseFcValues(json) {
  const out = new Map();
  for (const e of listFrom(json)) {
    const p = e?.player || e || {};
    const id = p.sleeperId ?? p.sleeper_id ?? e?.sleeperId;
    if (id == null || id === "") continue;
    const value = num(e.value);
    const redraft = num(e.redraftValue ?? e.redraft_value);
    if (value == null && redraft == null) continue;
    out.set(String(id), { value, redraft, trend30: num(e.trend30Day ?? e.trend30), name: p.name || null, pos: p.position || null });
  }
  return out;
}

export async function fcValues({ dynasty = false, numQbs = 1, numTeams = 12, ppr = 1 } = {}) {
  const teams = Math.min(16, Math.max(8, Math.round(Number(numTeams) || 12)));
  const p = Number(ppr) >= 1 ? 1 : Number(ppr) > 0 ? 0.5 : 0;
  const key = `values:fc:${dynasty ? "dyn" : "red"}:${numQbs}:${teams}:${p}`;
  const r = await cachedTable(key, TABLE_TTL, async () => {
    const json = await getJson(`${FC_BASE}/values/current?isDynasty=${dynasty ? "true" : "false"}&numQbs=${numQbs}&numTeams=${teams}&ppr=${p}`);
    const map = parseFcValues(json);
    if (!map.size) throw new Error("no usable values in the response");
    return [...map.entries()];
  });
  return { at: r?.at ?? null, stale: Boolean(r?.stale), error: r?.error || null, map: new Map(r?.value || []) };
}

/* ---------------- one league ---------------- */

/**
 * The value table a league uses. Returns { kind: 'dynasty'|'redraft', source, at, stale, error, valueOf(id) → number|null,
 * picks: [...] (dynasty only) }. `source` is null when nothing could be loaded.
 */
export async function leagueValues({ dynasty, superflex, ppr = 1, tep = false, teams = 12 }) {
  if (dynasty) {
    const fmt = raFormatKey({ superflex, ppr, tep });
    const ra = await raValues(fmt);
    if (ra.map.size) {
      const picks = await raPicks().catch(() => ({ list: [] }));
      return {
        kind: "dynasty", source: "Roster Audit", format: fmt, at: ra.at, stale: ra.stale, error: ra.error,
        valueOf: (id) => {
          const v = ra.map.get(String(id));
          return v ? (superflex ? v.sf ?? v.oneqb : v.oneqb ?? v.sf) : null;
        },
        details: (id) => ra.map.get(String(id)) || null,
        picks: picks.list || [],
      };
    }
    const fc = await fcValues({ dynasty: true, numQbs: superflex ? 2 : 1, numTeams: teams, ppr });
    if (fc.map.size) {
      return {
        kind: "dynasty", source: "FantasyCalc (dynasty, Roster Audit unavailable)", at: fc.at, stale: fc.stale, error: ra.error,
        valueOf: (id) => fc.map.get(String(id))?.value ?? null,
        details: (id) => fc.map.get(String(id)) || null,
        picks: [],
      };
    }
    return { kind: "dynasty", source: null, error: ra.error || fc.error || "no values", valueOf: () => null, details: () => null, picks: [] };
  }
  const fc = await fcValues({ dynasty: false, numQbs: superflex ? 2 : 1, numTeams: teams, ppr });
  if (fc.map.size) {
    return {
      kind: "redraft", source: "FantasyCalc", at: fc.at, stale: fc.stale, error: fc.error,
      valueOf: (id) => {
        const v = fc.map.get(String(id));
        return v ? v.redraft ?? v.value : null;
      },
      details: (id) => fc.map.get(String(id)) || null,
      picks: [],
    };
  }
  return { kind: "redraft", source: null, error: fc.error || "no values", valueOf: () => null, details: () => null, picks: [] };
}

/**
 * Value of each side of a trade offer from one league's table.
 * offer: { get:[{id,name}], give:[...], getPicksDetail:[{season,round,originalRosterId}], givePicksDetail:[...] }
 * pickSlotOf(rosterId) → 'early'|'mid'|'late' (projected finish of the pick's original owner).
 */
export function valueOffer(offer, vals, { superflex = false, pickSlotOf = () => "mid", threshold = 0.1 } = {}) {
  if (!vals?.source) return null;
  const missing = [];
  const sumPlayers = (list) =>
    (list || []).reduce((s, p) => {
      const v = vals.valueOf(p.id);
      if (v == null) missing.push(p.name || p.id);
      return s + (v ?? 0);
    }, 0);
  let picksIgnored = 0;
  const sumPicks = (list) =>
    (list || []).reduce((s, pk) => {
      if (vals.kind !== "dynasty") {
        picksIgnored++;
        return s;
      }
      const v = pickValue(vals.picks, { season: pk.season, round: pk.round, slot: pickSlotOf(pk.originalRosterId) }, superflex);
      if (v == null) missing.push(`${pk.season} round ${pk.round} pick`);
      return s + (v ?? 0);
    }, 0);
  const getValue = sumPlayers(offer.get) + sumPicks(offer.getPicksDetail);
  const giveValue = sumPlayers(offer.give) + sumPicks(offer.givePicksDetail);
  const top = Math.max(getValue, giveValue);
  const pctDiff = top > 0 ? (getValue - giveValue) / top : 0;
  const verdict = top <= 0 ? "unknown" : pctDiff <= -threshold ? "loss" : pctDiff >= threshold ? "win" : "fair";
  return {
    source: vals.source,
    kind: vals.kind,
    getValue: Math.round(getValue),
    giveValue: Math.round(giveValue),
    diff: Math.round(getValue - giveValue),
    pct: Math.round(pctDiff * 1000) / 10, // percent of the larger side, + = you gain
    verdict,
    missing,
    picksIgnored,
  };
}
