import * as store from "./statsStore.js";
import * as nv from "./nflverseStats.js";
import * as adv from "./advancedStats.js";
import * as slp from "./sleeperProjections.js";
import { DEFS } from "./statDefs.js";

/**
 * v4.2: works out the chosen stats for a set of players over the chosen seasons and weeks (Waivers "All" tab and
 * Analytics → Scouting). Pure apart from loading weeks into the stats table and the nflverse files.
 *
 * time = { seasons: [2025, 2026], period: "season" | "avg" | "weeks", weeks: [3, 4] }
 *   season  every week of each chosen season (this season: up to the current week for stats; all 18 for projections)
 *   avg     the same weeks; counting stats are divided by games played (weeks with offensive snaps > 0, or with a
 *           stat line for kickers and defenses); rates and shares stay the value over all those games
 *   weeks   just those weeks of each chosen season, combined (summed)
 * Current-only stats (rostered %, age, ECR …) have a value only when the time is "now": this season, Season /
 * Season average or the current week. Otherwise they are blank (null).
 */
export const MAX_WEEK = 18;

export function weekPairs(mode, time, cur) {
  const seasons = [...new Set((time.seasons?.length ? time.seasons : [cur.season]).map(Number))].sort((a, b) => a - b);
  const pairs = [];
  for (const s of seasons) {
    const last = mode === "stat" && s === Number(cur.season) ? Math.min(MAX_WEEK, Number(cur.week)) : MAX_WEEK;
    const weeks = time.period === "weeks" && time.weeks?.length ? time.weeks.map(Number).filter((w) => w >= 1 && w <= MAX_WEEK) : Array.from({ length: MAX_WEEK }, (_, i) => i + 1);
    for (const w of [...new Set(weeks)].sort((a, b) => a - b)) if (w <= last || mode === "proj") pairs.push([s, w]);
  }
  return pairs;
}

/** "Now": this season with Season / Season average, or exactly the current week. */
export function isCurrentTime(time, cur) {
  const seasons = time.seasons?.length ? time.seasons.map(Number) : [Number(cur.season)];
  if (seasons.length !== 1 || seasons[0] !== Number(cur.season)) return false;
  if (time.period === "season" || time.period === "avg" || !time.period) return true;
  return time.period === "weeks" && (time.weeks || []).length === 1 && Number(time.weeks[0]) === Number(cur.week);
}

const played = (line, pos) => {
  if (line.nv_snaps != null) return line.nv_snaps > 0;
  if (line.off_snp != null) return line.off_snp > 0;
  if (line.gp != null) return line.gp > 0;
  if (pos === "K" || pos === "DEF") return true;
  return Object.entries(line).some(([k, v]) => !k.startsWith("nv_") && Number(v) !== 0);
};

/**
 * Sums lines per player: { id → { pos, team, sums: {key: n}, fpts, games, weeks } }. fpts is scored week by week
 * (defense points-allowed tiers are per game). Pure.
 */
export function sumLines(lines, { mode, settings }) {
  const out = new Map();
  for (const l of lines) {
    const e = out.get(l.id) || out.set(l.id, { pos: l.pos, team: l.team, sums: {}, fpts: 0, fptsWeeks: 0, games: 0, weeks: 0 }).get(l.id);
    e.weeks++;
    if (mode === "proj" || played(l.stats, l.pos)) e.games++;
    for (const [k, v] of Object.entries(l.stats)) {
      const n = Number(v);
      if (!Number.isFinite(n) || k === "nv_snap_pct") continue;
      e.sums[k] = (e.sums[k] || 0) + n;
    }
    const pts = settings ? slp.scoreStats({ pos: l.pos, stats: l.stats }, settings) : null;
    if (pts != null) {
      e.fpts += pts;
      e.fptsWeeks++;
    }
    e.team = l.team || e.team;
  }
  return out;
}

/** Advanced metrics (rates/shares) for the chosen weeks: Map(sleeperId → metrics). */
async function advancedFor(pairs, cur, gsisToSleeper) {
  if (!pairs.length) return new Map();
  const bySeason = new Map();
  for (const [s, w] of pairs) (bySeason.get(s) || bySeason.set(s, new Set()).get(s)).add(w);
  const multi = bySeason.size > 1;
  const sets = { weekly: [], team: [], snaps: [], pfrRec: [], pfrRush: [], pfrPass: [], ngsRec: [], ngsRush: [], ngsPass: [] };
  let players = null;
  for (const [s, weeks] of bySeason) {
    const full = weeks.size >= MAX_WEEK || (s === Number(cur.season) && weeks.size >= Number(cur.week));
    const keep = (r) => weeks.has(r.week);
    const re = (r) => (multi ? { ...r, week: s * 100 + r.week } : r);
    const [weekly, team, snaps, pfrRec, pfrRush, pfrPass, ngsRec, ngsRush, ngsPass, dir] = await Promise.all([
      nv.weekly(s, cur.season).catch(() => []),
      nv.teamWeekly(s, cur.season).catch(() => []),
      nv.snaps(s, cur.season).catch(() => []),
      nv.pfr("rec", s, cur.season).catch(() => []),
      nv.pfr("rush", s, cur.season).catch(() => []),
      nv.pfr("pass", s, cur.season).catch(() => []),
      nv.ngs("receiving", s).catch(() => []),
      nv.ngs("rushing", s).catch(() => []),
      nv.ngs("passing", s).catch(() => []),
      nv.players().catch(() => ({ byGsis: new Map(), byEspn: new Map() })),
    ]);
    players = dir;
    sets.weekly.push(...weekly.filter(keep).map(re));
    sets.team.push(...team.filter(keep).map(re));
    sets.snaps.push(...snaps.filter(keep).map(re));
    sets.pfrRec.push(...pfrRec.filter(keep).map(re));
    sets.pfrRush.push(...pfrRush.filter(keep).map(re));
    sets.pfrPass.push(...pfrPass.filter(keep).map(re));
    // NGS week 0 = the whole season; use it only for one full season, otherwise the chosen weeks' rows
    const ngsKeep = (r) => (full && !multi ? true : r.week !== 0 && weeks.has(r.week));
    sets.ngsRec.push(...ngsRec.filter(ngsKeep).map(re));
    sets.ngsRush.push(...ngsRush.filter(ngsKeep).map(re));
    sets.ngsPass.push(...ngsPass.filter(ngsKeep).map(re));
  }
  const all = adv.aggregate({ ...sets, players });
  const out = new Map();
  for (const [gsis, a] of all) {
    const sid = gsisToSleeper.get(gsis);
    if (sid) out.set(sid, { ...a.metrics, _games: a.games });
  }
  return out;
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const div = (a, b) => (b > 0 && a != null ? a / b : null);

/**
 * Values for one player. ctx = { mode, avg, sums (from sumLines, or undefined), advanced, ranks, current, isNow }.
 * Pure.
 */
export function valueFor(statId, id, ctx) {
  const d = DEFS[statId];
  if (!d) return null;
  const s = ctx.sums;
  const per = (x) => (x == null ? null : ctx.avg ? div(x, s?.games || 0) : x);
  if (d.current) return ctx.isNow ? ctx.current?.(d.current, id) ?? null : null;
  if (d.line) {
    if (!s) return null;
    const v = s.sums[d.line] ?? (d.fallback ? s.sums[d.fallback] : undefined);
    return v == null ? null : r2(per(v));
  }
  if (d.adv) {
    if (ctx.mode !== "stat") return null;
    const v = ctx.advanced?.get(id)?.[d.adv];
    return v == null ? null : r2(v);
  }
  switch (d.calc) {
    case "fpts":
      return s && s.fptsWeeks ? r2(per(s.fpts)) : null;
    case "proj_rank":
      return ctx.ranks?.get(id) ?? null;
    case "ypc":
      return s ? r2(div(s.sums.rush_yd ?? 0, s.sums.rush_att ?? 0)) : null;
    case "racr":
      return s ? r2(div(s.sums.rec_yd ?? 0, s.sums.nv_rec_air_yd ?? 0)) : null;
    case "wopr": {
      const a = ctx.advanced?.get(id);
      if (!a || a.targetShare == null || a.airYardsShare == null) return null;
      return r2((1.5 * a.targetShare + 0.7 * a.airYardsShare) / 100);
    }
    default:
      return null;
  }
}

/** Position ranks by projected fantasy points (1 = best) over every projected player. Pure. */
export function projRanks(summed) {
  const byPos = new Map();
  for (const [id, e] of summed) if (e.fptsWeeks) (byPos.get(e.pos) || byPos.set(e.pos, []).get(e.pos)).push([id, e.fpts]);
  const out = new Map();
  for (const list of byPos.values()) list.sort((a, b) => b[1] - a[1]).forEach(([id], i) => out.set(id, i + 1));
  return out;
}

/**
 * The main query. universe: [{ id, name, pos, team, … }] (who to return), stats: ids, time, mode, settings (league
 * scoring for fantasy points), cur: { season, week }, currentValues(kind, id) for current-only stats,
 * gsisToSleeper (for advanced stats). Returns { rows: [{ ...player, values: {statId: n|null} }], loaded }.
 */
export async function run({ universe, stats, time, mode, settings, cur, currentValues, gsisToSleeper }) {
  const wanted = stats.filter((id) => DEFS[id]);
  const needLines = wanted.some((id) => DEFS[id].line || DEFS[id].calc);
  const needAdv = mode === "stat" && wanted.some((id) => DEFS[id].adv || DEFS[id].calc === "wopr");
  const pairs = weekPairs(mode, time, cur);
  let summed = new Map();
  let loaded = [];
  if (needLines && pairs.length) {
    loaded = await store.ensureWeeks(mode, pairs, cur);
    summed = sumLines(store.linesFor(mode, pairs), { mode, settings });
  }
  const advanced = needAdv ? await advancedFor(pairs, cur, gsisToSleeper || new Map()).catch((err) => (console.warn(`[statQuery] advanced stats: ${err.message}`), new Map())) : new Map();
  const ranks = wanted.includes("proj_rank") ? projRanks(summed) : null;
  const isNow = isCurrentTime(time, cur);
  const avg = time.period === "avg";
  const rows = universe.map((p) => {
    const ctx = { mode, avg, sums: summed.get(p.id), advanced, ranks, current: currentValues, isNow };
    const values = {};
    for (const id of wanted) values[id] = valueFor(id, p.id, ctx);
    const games = summed.get(p.id)?.games ?? advanced.get(p.id)?._games ?? null;
    return { ...p, games, values };
  });
  return { rows, loaded: loaded.filter((x) => !x.ok).map((x) => `${x.season} wk ${x.week}: ${x.error || x.reason}`).slice(0, 5), weeks: pairs.length };
}
