import * as values from "./values.js";
import { nameIndex } from "./waiverCategories.js";

/**
 * v4.7 — Trade → Value opportunities: the players whose dynasty value differs most between value sources.
 *
 * Every source speaks its own scale, so each is first put on 0–100: 0 = the lowest-valued player, 100 = the
 * highest-valued player. The scale is set over the players that EVERY loaded source lists (so a source with a longer tail
 * of cheap players doesn't stretch its scale differently from the others); with fewer than MIN_COMMON players in common
 * each source is scaled over its own table. A player outside that range is clamped to 0 or 100. The gap between a
 * player's highest and lowest scaled value is the "spread" the page sorts by.
 *
 * Sources: Roster Audit and FantasyCalc (both keyed by Sleeper id) and KeepTradeCut via the parse.bot wrapper (keyed by
 * its own ids, so matched to Sleeper players by name + position + team).
 */
export const MIN_COMMON = 40;
export const SOURCE_LABEL = { ra: "Roster Audit", fc: "FantasyCalc", ktc: "KeepTradeCut" };
const r1 = (x) => Math.round(x * 10) / 10;

/** Map(id → raw value) → Map(id → 0–100) given the range to scale over. */
export function scaleMap(map, { min, max }) {
  const out = new Map();
  const span = max - min;
  for (const [id, v] of map) {
    const x = span > 0 ? ((v - min) / span) * 100 : 50;
    out.set(id, Math.min(100, Math.max(0, x)));
  }
  return out;
}

/**
 * sources: [{ key, label, values: Map(id → raw value) }] (empty sources are ignored)
 * info:    Map(id → { name, pos, team, age })
 * → { scaledOver: 'common' | 'own', commonCount, rows: [{ id, name, pos, team, age, values: { key: { raw, scaled } }, spread, high, low }] }
 */
export function buildOpportunities({ sources, info = new Map(), limit = 150, minSources = 2 }) {
  const live = (sources || []).filter((s) => s.values && s.values.size > 0);
  if (live.length < minSources) return { scaledOver: null, commonCount: 0, rows: [] };
  let common = null;
  for (const s of live) {
    const ids = new Set(s.values.keys());
    common = common ? new Set([...common].filter((id) => ids.has(id))) : ids;
  }
  const useCommon = common.size >= MIN_COMMON;
  const scaled = {};
  for (const s of live) {
    const pool = useCommon ? [...common].map((id) => s.values.get(id)) : [...s.values.values()];
    scaled[s.key] = scaleMap(s.values, { min: Math.min(...pool), max: Math.max(...pool) });
  }
  const ids = new Set();
  for (const s of live) for (const id of s.values.keys()) ids.add(id);
  const rows = [];
  for (const id of ids) {
    const present = live.filter((s) => s.values.has(id));
    if (present.length < minSources) continue;
    const vals = {};
    for (const s of present) vals[s.key] = { raw: s.values.get(id), scaled: r1(scaled[s.key].get(id)) };
    const order = present.map((s) => ({ key: s.key, scaled: vals[s.key].scaled })).sort((a, b) => b.scaled - a.scaled);
    const meta = info.get(id) || {};
    rows.push({ id, name: meta.name || id, pos: meta.pos || null, team: meta.team || null, age: meta.age ?? null, values: vals, spread: r1(order[0].scaled - order[order.length - 1].scaled), high: order[0], low: order[order.length - 1] });
  }
  rows.sort((a, b) => b.spread - a.spread || b.high.scaled - a.high.scaled);
  return { scaledOver: useCommon ? "common" : "own", commonCount: common.size, rows: rows.slice(0, limit) };
}

/** KTC list → Map(sleeperId → value), matched by name + position + team; also how many could not be matched. */
export function matchKtc(list, findId) {
  const map = new Map();
  let unmatched = 0;
  for (const e of list || []) {
    const id = findId(e.name, e.pos, e.team);
    if (!id) {
      unmatched++;
      continue;
    }
    // two KTC rows resolving to one Sleeper id: keep the higher value
    if (!map.has(id) || e.value > map.get(id)) map.set(id, e.value);
  }
  return { map, unmatched };
}

const playerInfo = (m, id) => {
  const pos = m?.position || null;
  return { name: pos === "DEF" ? `${m?.first_name || ""} ${m?.last_name || ""}`.trim() : m?.full_name || `${m?.first_name || ""} ${m?.last_name || ""}`.trim() || id, pos, team: m?.team || null, age: m?.age ?? null };
};

/** The page's data: loads the three sources for a format and builds the table. */
export async function valueOpportunities({ superflex, sleeperPlayers }) {
  const fmt = values.raFormatKey({ superflex, ppr: 1 });
  const [ra, fc, ktc] = await Promise.all([values.raValues(fmt).catch((e) => ({ map: new Map(), error: e.message })), values.fcValues({ dynasty: true, numQbs: superflex ? 2 : 1, numTeams: 12, ppr: 1 }).catch((e) => ({ map: new Map(), error: e.message })), values.ktcValues({ superflex }).catch((e) => ({ configured: values.ktcConfigured(), list: [], error: e.message }))]);
  const raMap = new Map();
  for (const [id, v] of ra.map || []) {
    const x = superflex ? v.sf ?? v.oneqb : v.oneqb ?? v.sf;
    if (x != null) raMap.set(String(id), x);
  }
  const fcMap = new Map();
  for (const [id, v] of fc.map || []) if (v.value != null) fcMap.set(String(id), v.value);
  const k = matchKtc(ktc.list, nameIndex(sleeperPlayers));
  const sources = [
    { key: "ra", label: SOURCE_LABEL.ra, values: raMap },
    { key: "fc", label: SOURCE_LABEL.fc, values: fcMap },
    { key: "ktc", label: SOURCE_LABEL.ktc, values: k.map },
  ];
  const info = new Map();
  const wanted = new Set();
  for (const s of sources) for (const id of s.values.keys()) wanted.add(id);
  for (const id of wanted) info.set(id, playerInfo(sleeperPlayers?.[id], id));
  // keep fantasy positions only (the tables also hold K/DEF/IDP entries)
  for (const s of sources) for (const id of [...s.values.keys()]) if (!["QB", "RB", "WR", "TE"].includes(info.get(id)?.pos)) s.values.delete(id);
  const built = buildOpportunities({ sources, info });
  return {
    format: superflex ? "sf" : "1qb",
    ...built,
    sources: [
      { key: "ra", label: SOURCE_LABEL.ra, count: raMap.size, at: ra.at ?? null, stale: Boolean(ra.stale), error: ra.error || null, configured: true },
      { key: "fc", label: SOURCE_LABEL.fc, count: fcMap.size, at: fc.at ?? null, stale: Boolean(fc.stale), error: fc.error || null, configured: true },
      { key: "ktc", label: SOURCE_LABEL.ktc, count: k.map.size, at: ktc.at ?? null, stale: Boolean(ktc.stale), error: ktc.error || null, configured: ktc.configured !== false, unmatched: k.unmatched, creditsUsed: values.ktcCreditsUsed() },
    ],
  };
}
