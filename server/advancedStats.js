import * as nv from "./nflverseStats.js";

/**
 * v3.5 — season-to-date advanced stats for the player card, with red / yellow / green colouring.
 *
 * Every metric is computed for every player at the position (so the card can colour by percentile), from
 * nflverse's weekly player stats, team stats, snap counts, Pro Football Reference advanced stats and Next Gen
 * Stats. Two colourings are returned for each value, and the card's toggle chooses:
 *   percentile — among qualifying players at the same position: top third green, middle yellow, bottom red;
 *   fixed      — the starting thresholds agreed with James (2026-10-05).
 * "Context" metrics (depth of target, cushion, stacked boxes, time to throw) are shown without a colour.
 *
 * Estimated routes (WR/TE only): nflverse's per-play participation data isn't published during the season, so
 * routes = offensive snaps × the team's dropback rate that week ((attempts + sacks) / (attempts + sacks +
 * carries)). It overcounts players who block on pass plays; it is labelled "est.".
 */

// key, label, positions, format, higher-is-better (null = context, uncoloured), fixed thresholds [good, bad] per position.
// Fixed thresholds = the 2025 season's top-third / bottom-third cut-offs among qualifying players (WR 40+ targets,
// TE 30+, RB 80+ carries, QB 200+ dropbacks), computed from nflverse data while building v3.5 and rounded. They
// replace the rough starting numbers proposed in chat, several of which didn't match real distributions.
export const METRICS = [
  { key: "snapPct", label: "Snap share", fmt: "pct0", pos: ["QB", "RB", "WR", "TE"], better: "high", fixed: { QB: [96, 91], RB: [58, 46], WR: [79, 61], TE: [75, 57] } },
  { key: "targetShare", label: "Target share", fmt: "pct1", pos: ["RB", "WR", "TE"], better: "high", fixed: { WR: [21, 15], TE: [17, 12.5], RB: [10, 5.5] } },
  { key: "airYardsShare", label: "Air yards share", fmt: "pct1", pos: ["WR", "TE"], better: "high", fixed: { WR: [31, 19.5], TE: [15, 9] } },
  { key: "tprr", label: "Targets per route (est.)", fmt: "dec2", pos: ["WR", "TE"], better: "high", fixed: { WR: [0.25, 0.19], TE: [0.205, 0.17] }, estimate: true },
  { key: "yprr", label: "Yards per route (est.)", fmt: "dec2", pos: ["WR", "TE"], better: "high", fixed: { WR: [1.93, 1.5], TE: [1.65, 1.28] }, estimate: true },
  { key: "adot", label: "Avg depth of target", fmt: "dec1", pos: ["WR", "TE", "RB"], better: null },
  { key: "separation", label: "Avg separation (yds)", fmt: "dec2", pos: ["WR", "TE"], better: "high", fixed: { WR: [3.0, 2.63], TE: [3.66, 3.25] } },
  { key: "cushion", label: "Avg cushion (yds)", fmt: "dec1", pos: ["WR", "TE"], better: null },
  { key: "yacOe", label: "YAC above expected", fmt: "sgn2", pos: ["WR", "TE"], better: "high", fixed: { WR: [0.75, 0.22], TE: [0.8, 0.08] } },
  { key: "dropRate", label: "Drop rate", fmt: "pct1", pos: ["WR", "TE", "RB"], better: "low", fixed: { WR: [2.4, 5.05], TE: [2.1, 4.9], RB: [3.2, 5.7] } },
  { key: "carryShare", label: "Carry share", fmt: "pct0", pos: ["RB"], better: "high", fixed: { RB: [55, 35.5] } },
  { key: "ypc", label: "Yards per carry", fmt: "dec1", pos: ["RB"], better: "high", fixed: { RB: [4.55, 3.97] } },
  { key: "ryoe", label: "Rush yds over expected / carry", fmt: "sgn2", pos: ["RB"], better: "high", fixed: { RB: [0.6, 0.1] } },
  { key: "yacPerCarry", label: "Yards after contact / carry", fmt: "dec2", pos: ["RB"], better: "high", fixed: { RB: [2.08, 1.77] } },
  { key: "brokenTacklesPerCarry", label: "Broken tackles / carry", fmt: "dec3", pos: ["RB"], better: "high", fixed: { RB: [0.068, 0.048] } },
  { key: "stackedBox", label: "Carries vs 8+ in box", fmt: "pct0", pos: ["RB"], better: null },
  { key: "cpoe", label: "Completion % over expected", fmt: "sgn1", pos: ["QB"], better: "high", fixed: { QB: [2.0, -2.0] } },
  { key: "epaPerDropback", label: "EPA per dropback", fmt: "sgn2", pos: ["QB"], better: "high", fixed: { QB: [0.11, 0] } },
  { key: "pressureRate", label: "Pressure rate", fmt: "pct1", pos: ["QB"], better: "low", fixed: { QB: [20.6, 23.7] } },
  { key: "badThrowPct", label: "Bad throw %", fmt: "pct1", pos: ["QB"], better: "low", fixed: { QB: [13.6, 15.3] } },
  { key: "qbAdot", label: "Avg intended air yards", fmt: "dec1", pos: ["QB"], better: null },
  { key: "timeToThrow", label: "Time to throw (s)", fmt: "dec2", pos: ["QB"], better: null },
];

// Minimum sample before a value is coloured (and counted in the percentile pool).
const QUALIFY = {
  QB: (a) => a.dropbacks >= 50,
  RB: (a) => a.carries >= 20 || a.targets >= 10,
  WR: (a) => a.targets >= 10,
  TE: (a) => a.targets >= 8,
};
const RUSH_QUAL = (a) => a.carries >= 20;
const REC_QUAL = (a) => a.targets >= 8;

const sum = (list, f) => list.reduce((s, r) => s + (f(r) ?? 0), 0);
const safeDiv = (a, b) => (b > 0 ? a / b : null);

/** Fixed colour: 'good' | 'ok' | 'bad' from [goodAt, badAt] and direction. */
export function fixedColor(value, [goodAt, badAt], better) {
  if (value == null || better == null) return null;
  if (better === "high") return value >= goodAt ? "good" : value < badAt ? "bad" : "ok";
  return value <= goodAt ? "good" : value > badAt ? "bad" : "ok";
}

/** Percentile (0-100, 100 = best) of `value` within `pool` (direction-adjusted). */
export function percentileOf(value, pool, better) {
  if (value == null || better == null || !pool.length) return null;
  const below = pool.filter((v) => (better === "high" ? v < value : v > value)).length;
  const equal = pool.filter((v) => v === value).length;
  return Math.round(((below + 0.5 * equal) / pool.length) * 100);
}
export const percentileColor = (p) => (p == null ? null : p >= 67 ? "good" : p >= 33 ? "ok" : "bad");

/**
 * Aggregates for every player this season: Map(gsis → { pos, team, games, targets, carries, dropbacks, metrics: {...} }).
 * Pure given the datasets (unit-tested); see compute() for the loading.
 */
export function aggregate({ weekly, team, snaps, pfrRec, pfrRush, pfrPass, ngsRec, ngsRush, ngsPass, players }) {
  const teamWeek = new Map(team.map((t) => [`${t.week}|${t.team}`, t]));
  const snapByPfrWeek = new Map(snaps.map((s) => [`${s.pfr_player_id}|${s.week}`, s]));
  const pfrIdOf = (gsis) => players?.byGsis?.get(gsis)?.pfr_id || null;
  const byPfr = (rows) => {
    const m = new Map();
    for (const r of rows) (m.get(r.pfr_player_id) || m.set(r.pfr_player_id, []).get(r.pfr_player_id)).push(r);
    return m;
  };
  const recBy = byPfr(pfrRec);
  const rushBy = byPfr(pfrRush);
  const passBy = byPfr(pfrPass);
  const ngsSeason = (rows) => {
    // week 0 = season to date; otherwise the target/attempt-weighted mean of the weekly rows
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.player_gsis_id);
      if (r.week === 0) m.set(r.player_gsis_id, { ...r, _season: true });
      else if (!cur?._season) (m.get(r.player_gsis_id)?._weeks || m.set(r.player_gsis_id, { _weeks: [] }).get(r.player_gsis_id)._weeks).push(r);
    }
    for (const [k, v] of m) {
      if (v._season) continue;
      const w = v._weeks;
      const weight = (r) => r.targets ?? r.rush_attempts ?? r.attempts ?? 1;
      const tot = sum(w, weight);
      const avg = (f) => (tot > 0 ? sum(w, (r) => (r[f] ?? 0) * weight(r)) / tot : null);
      m.set(k, Object.fromEntries(Object.keys(w[0] || {}).map((f) => [f, typeof w[0][f] === "number" ? avg(f) : w[0][f]])));
    }
    return m;
  };
  const nRec = ngsSeason(ngsRec);
  const nRush = ngsSeason(ngsRush);
  const nPass = ngsSeason(ngsPass);

  const byPlayer = new Map();
  for (const r of weekly) (byPlayer.get(r.player_id) || byPlayer.set(r.player_id, []).get(r.player_id)).push(r);

  const out = new Map();
  for (const [gsis, rows] of byPlayer) {
    const pos = rows[0].position;
    if (!["QB", "RB", "WR", "TE"].includes(pos)) continue;
    const pfrId = pfrIdOf(gsis);
    const teamRows = rows.map((r) => teamWeek.get(`${r.week}|${r.team}`)).filter(Boolean);
    const snapRows = pfrId ? rows.map((r) => snapByPfrWeek.get(`${pfrId}|${r.week}`)).filter(Boolean) : [];
    const targets = sum(rows, (r) => r.targets);
    const carries = sum(rows, (r) => r.carries);
    const dropbacks = sum(rows, (r) => (r.attempts ?? 0) + (r.sacks_suffered ?? 0));
    const teamTargets = sum(teamRows, (t) => t.targets);
    const teamAir = sum(teamRows, (t) => t.passing_air_yards);
    const teamCarries = sum(teamRows, (t) => t.carries);
    // routes (est.): offensive snaps × that week's team dropback rate
    let routes = 0;
    for (const r of rows) {
      const s = pfrId ? snapByPfrWeek.get(`${pfrId}|${r.week}`) : null;
      const t = teamWeek.get(`${r.week}|${r.team}`);
      if (!s || !t) continue;
      const db = (t.attempts ?? 0) + (t.sacks_suffered ?? 0);
      const plays = db + (t.carries ?? 0);
      if (plays > 0) routes += (s.offense_snaps ?? 0) * (db / plays);
    }
    const rec = pfrId ? recBy.get(pfrId) || [] : [];
    const rush = pfrId ? rushBy.get(pfrId) || [] : [];
    const pass = pfrId ? passBy.get(pfrId) || [] : [];
    const ngR = nRec.get(gsis);
    const ngRu = nRush.get(gsis);
    const ngP = nPass.get(gsis);
    const agg = { pos, team: rows[rows.length - 1].team, games: rows.length, targets, carries, dropbacks };
    const m = {
      snapPct: snapRows.length ? (sum(snapRows, (s) => s.offense_pct) / snapRows.length) * 100 : null,
      targetShare: teamTargets > 0 ? (targets / teamTargets) * 100 : null,
      airYardsShare: teamAir > 0 ? (sum(rows, (r) => r.receiving_air_yards) / teamAir) * 100 : null,
      tprr: routes > 0 ? targets / routes : null,
      yprr: routes > 0 ? sum(rows, (r) => r.receiving_yards) / routes : null,
      adot: safeDiv(sum(rows, (r) => r.receiving_air_yards), targets),
      separation: ngR?.avg_separation ?? null,
      cushion: ngR?.avg_cushion ?? null,
      yacOe: ngR?.avg_yac_above_expectation ?? null,
      dropRate: rec.length && targets > 0 ? (sum(rec, (x) => x.receiving_drop) / targets) * 100 : null,
      carryShare: teamCarries > 0 ? (carries / teamCarries) * 100 : null,
      ypc: safeDiv(sum(rows, (r) => r.rushing_yards), carries),
      ryoe: ngRu?.rush_yards_over_expected_per_att ?? null,
      yacPerCarry: rush.length ? safeDiv(sum(rush, (x) => x.rushing_yards_after_contact), sum(rush, (x) => x.carries)) : null,
      brokenTacklesPerCarry: rush.length ? safeDiv(sum(rush, (x) => x.rushing_broken_tackles), sum(rush, (x) => x.carries)) : null,
      stackedBox: ngRu?.percent_attempts_gte_eight_defenders ?? null,
      cpoe: ngP?.completion_percentage_above_expectation ?? (dropbacks > 0 ? sum(rows, (r) => (r.passing_cpoe ?? 0) * (r.attempts ?? 0)) / Math.max(1, sum(rows, (r) => r.attempts)) : null),
      epaPerDropback: dropbacks > 0 ? sum(rows, (r) => r.passing_epa) / dropbacks : null,
      pressureRate: pass.length && dropbacks > 0 ? (sum(pass, (x) => x.times_pressured) / dropbacks) * 100 : null,
      badThrowPct: pass.length ? safeDiv(sum(pass, (x) => x.passing_bad_throws), sum(rows, (r) => r.attempts)) * 100 : null,
      qbAdot: ngP?.avg_intended_air_yards ?? null,
      timeToThrow: ngP?.avg_time_to_throw ?? null,
    };
    // A value only means something with a sample behind it.
    if (!(targets > 0)) for (const k of ["targetShare", "airYardsShare", "tprr", "yprr", "adot", "dropRate"]) m[k] = null;
    if (!(carries > 0)) for (const k of ["ypc", "carryShare", "yacPerCarry", "brokenTacklesPerCarry"]) m[k] = null;
    if (pos !== "WR" && pos !== "TE") (m.tprr = null), (m.yprr = null);
    agg.metrics = m;
    agg.routesEst = routes > 0 && (pos === "WR" || pos === "TE") ? Math.round(routes) : null;
    out.set(gsis, agg);
  }
  return out;
}

/** The card's advanced-stat rows for one player: value, percentile + colour, fixed colour, sample flag. */
export function rowsFor(gsis, all) {
  const me = all.get(gsis);
  if (!me) return null;
  const qualifies = QUALIFY[me.pos] || (() => false);
  const rows = [];
  for (const def of METRICS) {
    if (!def.pos.includes(me.pos)) continue;
    const value = me.metrics[def.key];
    if (value == null) continue;
    const rushMetric = ["ypc", "ryoe", "yacPerCarry", "brokenTacklesPerCarry", "carryShare", "stackedBox"].includes(def.key);
    const recMetric = ["targetShare", "airYardsShare", "tprr", "yprr", "adot", "dropRate", "yacOe", "separation", "cushion"].includes(def.key);
    const enough = me.pos === "RB" ? (rushMetric ? RUSH_QUAL(me) : recMetric ? REC_QUAL(me) : qualifies(me)) : qualifies(me);
    const pool = [];
    for (const other of all.values()) {
      if (other.pos !== me.pos) continue;
      const v = other.metrics[def.key];
      if (v == null) continue;
      const ok = me.pos === "RB" ? (rushMetric ? RUSH_QUAL(other) : recMetric ? REC_QUAL(other) : (QUALIFY.RB)(other)) : (QUALIFY[other.pos] || (() => false))(other);
      if (ok) pool.push(v);
    }
    const percentile = enough ? percentileOf(value, pool, def.better) : null;
    rows.push({
      key: def.key,
      label: def.label,
      fmt: def.fmt,
      value: Math.round(value * 1000) / 1000,
      context: def.better == null,
      estimate: Boolean(def.estimate),
      enough,
      percentile,
      pctColor: enough ? percentileColor(percentile) : null,
      fixedColor: enough ? fixedColor(value, def.fixed?.[me.pos] || [null, null], def.fixed?.[me.pos] ? def.better : null) : null,
      fixed: def.fixed?.[me.pos] || null,
      better: def.better,
      poolSize: pool.length,
    });
  }
  return { pos: me.pos, games: me.games, targets: me.targets, carries: me.carries, dropbacks: me.dropbacks, routesEst: me.routesEst, rows };
}

/** Loads this season's datasets and aggregates every player (memoized 1 hour). */
let memo = null;
export async function compute(season) {
  if (memo && memo.season === season && Date.now() - memo.at < 3600e3) return memo.value;
  const [weekly, team, snaps, pfrRec, pfrRush, pfrPass, ngsRec, ngsRush, ngsPass, players] = await Promise.all([
    nv.weekly(season),
    nv.teamWeekly(season),
    nv.snaps(season).catch(() => []),
    nv.pfr("rec", season).catch(() => []),
    nv.pfr("rush", season).catch(() => []),
    nv.pfr("pass", season).catch(() => []),
    nv.ngs("receiving", season).catch(() => []),
    nv.ngs("rushing", season).catch(() => []),
    nv.ngs("passing", season).catch(() => []),
    nv.players().catch(() => ({ byGsis: new Map(), byEspn: new Map() })),
  ]);
  const all = aggregate({ weekly, team, snaps, pfrRec, pfrRush, pfrPass, ngsRec, ngsRush, ngsPass, players });
  const throughWeek = Math.max(0, ...weekly.map((r) => r.week || 0));
  const value = { all, throughWeek, at: Date.now() };
  memo = { season, at: Date.now(), value };
  return value;
}
