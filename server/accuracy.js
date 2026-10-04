import * as store from "./projectionStore.js";
import * as slp from "./sleeperProjections.js";
import { computeLeans } from "./projectionHub.js";

/**
 * v2.5 projection accuracy. Compares each source's recorded projection (as
 * frozen at kickoff) with the player's actual points in the same scoring
 * profile. A player with a projection but no stat line that week (inactive,
 * didn't play) counts as 0 actual points. Only projections of at least
 * 0.5 points are scored, so thousands of 0-vs-0 deep-bench pairs don't
 * flatter every source.
 */
const SOURCES = ["V", "T", "S", "E"];
// v2.9: only fantasy-relevant positions are scored; anything else a source
// happened to return (IDP, OL, …) is ignored here and not recorded.
export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const MIN_PROJ = 0.5;

function stats(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const errs = pairs.map(([p, a]) => p - a);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const bias = mean(errs);
  const mae = mean(errs.map(Math.abs));
  const rmse = Math.sqrt(mean(errs.map((e) => e * e)));
  const sdErr = n > 1 ? Math.sqrt(errs.reduce((s, e) => s + (e - bias) ** 2, 0) / (n - 1)) : 0;
  const ps = pairs.map((x) => x[0]);
  const as = pairs.map((x) => x[1]);
  const mp = mean(ps);
  const ma = mean(as);
  let cov = 0, vp = 0, va = 0;
  for (let i = 0; i < n; i++) {
    cov += (ps[i] - mp) * (as[i] - ma);
    vp += (ps[i] - mp) ** 2;
    va += (as[i] - ma) ** 2;
  }
  const corr = vp > 0 && va > 0 ? cov / Math.sqrt(vp * va) : null;
  const within = (t) => errs.filter((e) => Math.abs(e) <= t).length / n;
  return { n, bias: r2(bias), mae: r2(mae), rmse: r2(rmse), sdErr: r2(sdErr), corr: corr == null ? null : r3(corr), within3: r3(within(3)), within5: r3(within(5)), avgProj: r2(mp), avgActual: r2(ma) };
}
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(pairs) {
  if (pairs.length < 3) return null;
  const rp = ranks(pairs.map((x) => x[0]));
  const ra = ranks(pairs.map((x) => x[1]));
  return stats(rp.map((v, i) => [v, ra[i]]))?.corr ?? null;
}
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * opts: { profile, season, weekFrom, weekTo, positions, sameOnly, adjusted }
 * `positions` (v2.9): array of the positions to include in the "ALL" rows and
 * the by-week chart (default: all six). Per-position rows are always returned
 * so the client can show a source × position matrix.
 * Returns { summary: [{source, pos, ...metrics, rankCorr}], byWeek: [{week, source, mae, bias, n}], meta }.
 */
export function computeAccuracy(opts) {
  const profiles = store.listProfiles();
  const profile = opts.profile || profiles[0]?.profile;
  const prof = profiles.find((p) => p.profile === profile);
  if (!prof) return { summary: [], byWeek: [], meta: { profiles, note: "No scoring profiles yet — open your leagues once so the app records projections." } };
  const season = Number(opts.season);
  const weeks = [];
  for (let w = Number(opts.weekFrom || 1); w <= Number(opts.weekTo || 18); w++) weeks.push(w);

  const wanted = new Set((Array.isArray(opts.positions) && opts.positions.length ? opts.positions : FANTASY_POSITIONS).filter((p) => FANTASY_POSITIONS.includes(p)));
  const rows = store.projRows({ profile, season, weeks }).filter((r) => FANTASY_POSITIONS.includes(r.pos));
  const actualRows = store.actualsFor(season, weeks);
  const actualWeeks = new Set(weeks.filter((w) => store.actualWeek(season, w)));
  const actual = new Map(actualRows.map((a) => [`${a.week}|${a.player_id}`, JSON.parse(a.stats_json)]));

  // Group by player-week so "same players only" can compare like with like.
  const byPW = new Map();
  for (const r of rows) {
    if (!actualWeeks.has(r.week)) continue; // week not scored yet
    const k = `${r.week}|${r.player_id}`;
    if (!byPW.has(k)) byPW.set(k, { week: r.week, player: r.player_id, pos: r.pos, src: {}, backfill: false });
    const e = byPW.get(k);
    e.src[r.source] = opts.adjusted && r.adj_proj != null ? r.adj_proj : r.proj;
    if (r.backfill) e.backfill = true;
  }
  // Sources present at all in each week (for the same-players filter).
  const weekSources = new Map();
  for (const e of byPW.values()) {
    if (!weekSources.has(e.week)) weekSources.set(e.week, new Set());
    for (const s of Object.keys(e.src)) weekSources.get(e.week).add(s);
  }

  const groups = new Map(); // `${src}|${pos}` -> pairs
  const rankGroups = new Map(); // `${src}|${pos}|${week}` -> pairs
  const weekGroups = new Map(); // `${src}|${week}` -> pairs
  let backfilledWeeks = new Set();
  for (const e of byPW.values()) {
    const present = weekSources.get(e.week);
    if (opts.sameOnly && [...present].some((s) => e.src[s] == null)) continue;
    const st = actual.get(`${e.week}|${e.player}`);
    const act = st ? slp.scoreStats({ pos: e.pos, stats: st }, prof.settings) ?? 0 : 0;
    if (e.backfill) backfilledWeeks.add(e.week);
    for (const s of SOURCES) {
      const p = e.src[s];
      if (p == null || p < MIN_PROJ) continue;
      for (const key of wanted.has(e.pos) ? [`${s}|${e.pos}`, `${s}|ALL`] : [`${s}|${e.pos}`]) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push([p, act]);
      }
      const rk = `${s}|${e.pos}|${e.week}`;
      if (!rankGroups.has(rk)) rankGroups.set(rk, []);
      rankGroups.get(rk).push([p, act]);
      if (wanted.has(e.pos)) {
        const wk = `${s}|${e.week}`;
        if (!weekGroups.has(wk)) weekGroups.set(wk, []);
        weekGroups.get(wk).push([p, act]);
      }
    }
  }

  const summary = [];
  for (const [key, pairs] of groups) {
    const [source, pos] = key.split("|");
    const m = stats(pairs);
    // Rank correlation: within each position-week, n-weighted average.
    let num = 0, den = 0;
    for (const [rk, rp] of rankGroups) {
      const [s2, p2] = rk.split("|");
      if (s2 !== source || (pos !== "ALL" && p2 !== pos) || (pos === "ALL" && !wanted.has(p2))) continue;
      const rho = spearman(rp);
      if (rho == null) continue;
      num += rho * rp.length;
      den += rp.length;
    }
    summary.push({ source, pos, ...m, rankCorr: den ? r3(num / den) : null });
  }
  summary.sort((a, b) => (a.pos === b.pos ? SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) : a.pos === "ALL" ? -1 : b.pos === "ALL" ? 1 : a.pos.localeCompare(b.pos)));

  const byWeek = [];
  for (const [key, pairs] of weekGroups) {
    const [source, week] = key.split("|");
    const m = stats(pairs);
    byWeek.push({ source, week: Number(week), n: m.n, mae: m.mae, bias: m.bias });
  }
  byWeek.sort((a, b) => a.week - b.week || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));

  const lastWeek = Math.max(0, ...store.recordedWeeks().filter((r) => r.season === season && r.profile === profile).map((r) => r.week));
  return {
    summary,
    byWeek,
    leans: lastWeek ? { week: lastWeek, ...computeLeans(profile, season, lastWeek) } : null,
    meta: {
      profile,
      positions: [...wanted],
      profileLabel: prof.label,
      profiles: profiles.map((p) => ({ profile: p.profile, label: p.label })),
      seasons: [...new Set(store.recordedWeeks().map((r) => r.season))].sort(),
      scoredWeeks: [...actualWeeks].sort((a, b) => a - b),
      backfilledWeeks: [...backfilledWeeks].sort((a, b) => a - b),
    },
  };
}
