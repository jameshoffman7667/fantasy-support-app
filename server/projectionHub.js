import * as tank01 from "./tank01.js";
import * as slp from "./sleeperProjections.js";
import * as espn from "./espnProjections.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";
import { ensureCrosswalk } from "./playerIdMap.js";
import { normalizeName } from "./matching.js";

/**
 * v2.5: one place that, for a week and a league's scoring settings, works
 * out EVERY source's projection for every player it can identify:
 *   V = Vegas props (full prop set only), T = Tank01, S = Sleeper, E = ESPN
 * then
 *   - records them all (raw + lean-adjusted) for accuracy tracking,
 *   - computes each source's per-position "lean" against Vegas over a
 *     rolling 4-week window, per scoring profile,
 *   - and hands buildLeague.js the adjusted numbers.
 *
 * Player identity: everything is keyed by Sleeper player ID. Tank01 and
 * ESPN players are mapped through the local crosswalk table first, then
 * (Tank01) the Sleeper ID in Tank01's player list, then name + position
 * (+ team). Every new match is written back to the crosswalk.
 */
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
export const LEAN_WINDOW_WEEKS = 4;
export const LEAN_MIN_SAMPLE = 8;
export const LEAN_MIN = 0.8;
export const LEAN_MAX = 1.2;
const RECOMPUTE_MS = 10 * 60 * 1000;

/* ---------------- identity ---------------- */
function buildSleeperIndex(sleeperPlayers) {
  const byNamePos = new Map(); // "name|POS" -> [ids]
  const byNamePosTeam = new Map(); // "name|POS|TEAM" -> id
  for (const [id, p] of Object.entries(sleeperPlayers || {})) {
    if (!p || !POSITIONS.includes(p.position) || p.position === "DEF") continue;
    const name = normalizeName(`${p.first_name || ""} ${p.last_name || ""}`);
    if (!name) continue;
    const k = `${name}|${p.position}`;
    if (!byNamePos.has(k)) byNamePos.set(k, []);
    byNamePos.get(k).push(id);
    if (p.team) byNamePosTeam.set(`${k}|${tank01.normTeam(p.team)}`, id);
  }
  return { byNamePos, byNamePosTeam };
}
function nameMatch(index, name, pos, team) {
  if (!name || !pos) return null;
  const k = `${normalizeName(name)}|${pos}`;
  if (team) {
    const hit = index.byNamePosTeam.get(`${k}|${tank01.normTeam(team)}`);
    if (hit) return { id: hit, method: "name_pos_team" };
  }
  const list = index.byNamePos.get(k);
  return list && list.length === 1 ? { id: list[0], method: "name_pos" } : null; // ambiguous names are skipped, not guessed
}

/* ---------------- all sources for one week + scoring ---------------- */
/**
 * pools: { tankWeek: {projections, odds}, tankIds, sleeperPool, espnPool }
 * Returns Map sleeperId -> { pos, team, V?, T?, S?, E? } (raw league-scored points).
 */
export function computeAllSources({ pools, settings, sleeperPlayers }) {
  const out = new Map();
  const index = buildSleeperIndex(sleeperPlayers);
  const cw = store.allCrosswalk();
  const byTank = new Map();
  const byTankViaEspn = new Map();
  const byEspn = new Map();
  for (const r of cw) {
    if (r.tank01_id) byTank.set(String(r.tank01_id), r.sleeper_id);
    // Tank01's playerID is the ESPN player ID (verified live), so a known
    // ESPN ID is also a Tank01 ID.
    else if (r.espn_id && r.espn_method === "ffb_ids") byTankViaEspn.set(String(r.espn_id), r.sleeper_id);
    if (r.espn_id) byEspn.set(String(r.espn_id), r.sleeper_id);
  }
  const entry = (id, pos, team) => {
    if (!out.has(id)) out.set(id, { pos, team: team || null });
    const e = out.get(id);
    if (!e.pos && pos) e.pos = pos;
    if (!e.team && team) e.team = team;
    return e;
  };
  const metaPos = (id) => sleeperPlayers?.[id]?.position || null;
  const metaTeam = (id) => sleeperPlayers?.[id]?.team || null;

  // --- Tank01 (projections + props) ---
  const { tankWeek, tankIds } = pools;
  if (tankWeek) {
    const tankPlayers = tankWeek.projections?.players || {};
    const propIds = new Set();
    for (const g of Object.values(tankWeek.odds || {})) for (const id of Object.keys(g?.props || {})) propIds.add(id);
    const allTankIds = new Set([...Object.keys(tankPlayers), ...propIds]);
    const sleeperByTankFromList = new Map(Object.entries(tankIds?.bySleeperId || {}).map(([sid, tid]) => [String(tid), sid]));
    for (const tid of allTankIds) {
      const proj = tankPlayers[tid] || null;
      const info = tankIds?.info?.[tid] || {};
      const name = proj?.name || info.name;
      const pos = proj?.pos || info.pos;
      const team = proj?.team || info.team;
      let sid = byTank.get(tid) || null;
      if (!sid && byTankViaEspn.has(tid)) {
        sid = byTankViaEspn.get(tid);
        store.learnId(sid, "tank01", tid, "espn_id", { name, pos, team });
      }
      if (!sid && sleeperByTankFromList.has(tid)) {
        sid = sleeperByTankFromList.get(tid);
        store.learnId(sid, "tank01", tid, "tank01_sleeper_id", { name, pos, team });
      }
      if (!sid) {
        const m = nameMatch(index, name, pos, team);
        if (m) {
          sid = m.id;
          store.learnId(sid, "tank01", tid, m.method, { name, pos, team });
        }
      }
      if (!sid) continue;
      const p = metaPos(sid) || pos;
      const e = entry(sid, p, metaTeam(sid) || team);
      const props = tank01.propsFor(tankWeek, tid);
      if (props) e.props = props; // v3.6: the raw prop lines, shown on roster cards
      const vegas = tank01.propsStatLine(props, p, proj);
      if (vegas) {
        const pts = vegas.points ?? slp.scoreStats({ pos: p, stats: vegas.stats }, settings);
        if (pts != null) {
          e.V = round(pts);
          setLine(e, "V", vegas.stats || (vegas.points != null ? { kick_pts: vegas.points } : null));
        }
      }
      if (proj) {
        const hasStats = proj.stats && Object.keys(proj.stats).length > 0 && p !== "K";
        const pts = hasStats ? slp.scoreStats({ pos: p, stats: proj.stats }, settings) : tank01.presetPoints(proj, settings);
        if (pts != null) {
          e.T = round(pts);
          setLine(e, "T", proj.stats);
        }
      }
    }
    for (const [team, d] of Object.entries(tankWeek.projections?.defenses || {})) {
      const sid = team; // Sleeper's DEF player IDs are team abbreviations
      const pts = tank01.presetPoints(d, settings);
      if (pts != null) {
        const e = entry(sid, "DEF", team);
        e.T = round(pts);
        setLine(e, "T", d.stats);
      }
    }
  }

  // --- Sleeper (already keyed by Sleeper ID) ---
  for (const [sid, rec] of Object.entries(pools.sleeperPool?.byId || {})) {
    const p = rec.pos || metaPos(sid);
    const pts = slp.scoreStats({ ...rec, pos: p }, settings);
    if (pts != null) {
      const e = entry(sid, p, metaTeam(sid));
      e.S = round(pts);
      setLine(e, "S", rec.stats);
    }
  }

  // --- ESPN ---
  const ep = pools.espnPool;
  if (ep) {
    for (const [eid, rec] of Object.entries(ep.byId || {})) {
      if (rec.pos === "DEF") continue;
      let sid = byEspn.get(String(eid)) || null;
      if (!sid) {
        const m = nameMatch(index, rec.name, rec.pos, rec.team);
        if (m) {
          sid = m.id;
          store.learnId(sid, "espn", eid, m.method, { name: rec.name, pos: rec.pos, team: rec.team });
        }
      }
      if (!sid) continue;
      const e = entry(sid, metaPos(sid) || rec.pos, metaTeam(sid) || rec.team);
      e.E = round(espn.adjustForScoring(rec, settings));
      // ESPN's feed only gives us receptions and passing TDs, not a full line.
      setLine(e, "E", { rec: rec.rec, pass_td: rec.passTd });
    }
    for (const [team, rec] of Object.entries(ep.byTeamDef || {})) {
      entry(team, "DEF", team).E = round(espn.adjustForScoring(rec, settings));
    }
  }
  return out;
}
function round(x) {
  return Math.round(Number(x) * 100) / 100;
}

/* ---------------- projected stat lines (v2.8) ---------------- */
/** The stats shown on a player card, in display order (Sleeper stat keys). */
export const STAT_LINE_KEYS = ["pass_yd", "pass_td", "pass_int", "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td", "fgm", "xpm", "kick_pts", "sack", "int", "fum_rec", "def_td", "pts_allow", "yds_allow"];
/** Keeps only the displayable, non-zero stats, rounded to 0.1. */
export function trimStatLine(stats) {
  if (!stats || typeof stats !== "object") return null;
  const out = {};
  for (const k of STAT_LINE_KEYS) {
    const v = Number(stats[k]);
    if (stats[k] == null || !Number.isFinite(v)) continue;
    if (v === 0 && k !== "pts_allow") continue;
    out[k] = Math.round(v * 10) / 10;
  }
  return Object.keys(out).length ? out : null;
}
function setLine(e, src, stats) {
  const t = trimStatLine(stats);
  if (!t) return;
  e.lines ??= {};
  e.lines[src] = t;
}

/* ---------------- leans ---------------- */
/**
 * Per-source, per-position lean of each non-Vegas source vs Vegas for one
 * scoring profile: Σ Vegas / Σ source over every player-week in the last
 * LEAN_WINDOW_WEEKS weeks (current week included) that has both. Positions
 * with fewer than LEAN_MIN_SAMPLE overlaps use the source's all-positions
 * factor; with fewer than that overall, no adjustment (1). Clamped.
 * Returns { [source]: { [pos]: { factor, n, pooled } } }.
 */
export function computeLeans(profile, season, week) {
  const weeks = [];
  for (let w = Math.max(1, week - LEAN_WINDOW_WEEKS + 1); w <= week; w++) weeks.push(w);
  const rows = store.projRows({ profile, season, weeks });
  const byKey = new Map(); // "week|player" -> {pos, V, T, S, E}
  for (const r of rows) {
    const k = `${r.week}|${r.player_id}`;
    if (!byKey.has(k)) byKey.set(k, { pos: r.pos });
    byKey.get(k)[r.source] = r.proj;
  }
  const sums = {}; // source -> pos -> {v, s, n}
  for (const rec of byKey.values()) {
    if (rec.V == null) continue;
    for (const src of ["T", "S", "E"]) {
      if (rec[src] == null || rec[src] <= 0) continue;
      sums[src] ??= {};
      for (const key of [rec.pos, "ALL"]) {
        sums[src][key] ??= { v: 0, s: 0, n: 0 };
        sums[src][key].v += rec.V;
        sums[src][key].s += rec[src];
        sums[src][key].n++;
      }
    }
  }
  const clamp = (f) => Math.min(LEAN_MAX, Math.max(LEAN_MIN, f));
  const leans = {};
  for (const src of ["T", "S", "E"]) {
    leans[src] = {};
    const all = sums[src]?.ALL;
    const pooled = all && all.n >= LEAN_MIN_SAMPLE && all.s > 0 ? clamp(all.v / all.s) : null;
    for (const pos of POSITIONS) {
      const s = sums[src]?.[pos];
      if (s && s.n >= LEAN_MIN_SAMPLE && s.s > 0) leans[src][pos] = { factor: round3(clamp(s.v / s.s)), n: s.n, pooled: false };
      else if (pos !== "DEF" && pooled != null) leans[src][pos] = { factor: round3(pooled), n: s?.n || 0, pooled: true };
      else leans[src][pos] = { factor: 1, n: s?.n || 0, pooled: false, none: true };
    }
  }
  return leans;
}
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
// DEF has no Vegas props, so there is never anything to calibrate it against.

/* ---------------- record ---------------- */
export function toRecords({ season, week, profile, all, leans, kickoffFor, backfill = false }) {
  const rows = [];
  for (const [sid, e] of all) {
    const kickoff = kickoffFor ? kickoffFor(e.team) : null;
    for (const src of ["V", "T", "S", "E"]) {
      if (e[src] == null) continue;
      const f = src === "V" ? 1 : leans?.[src]?.[e.pos]?.factor ?? 1;
      rows.push({ season: Number(season), week: Number(week), player_id: sid, source: src, profile, pos: e.pos, proj: e[src], adj_proj: round(e[src] * f), kickoff, backfill });
    }
  }
  return rows;
}

/* ---------------- live entry point for buildLeague ---------------- */
const cache = new Map(); // `${season}|${week}|${profile}` -> { at, result }
let lastSummary = null;
/** v2.6: what the last projection computation actually got from each source (for the header status). */
export function getLastSummary() {
  return lastSummary;
}

/**
 * Everything buildLeague needs for one league: per-player sources (raw), the
 * league profile's leans, and a picker. Recomputed at most every 10 minutes
 * per (week, profile); `force` (pre-kickoff refresh) skips that.
 */
export async function getWeek({ season, week, settings, sleeperPlayers, force = false }) {
  const profile = store.rememberProfile(settings);
  const key = `${season}|${week}|${profile.key}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < RECOMPUTE_MS) return hit.result;

  await ensureCrosswalk();
  const [tankWeek, tankIds, sleeperPool, espnPool, sched] = await Promise.all([
    tank01.getWeekData(season, week).catch(() => null),
    tank01.getIdMap().catch(() => null),
    slp.getWeekProjections(season, week).catch((err) => {
      console.warn(`[projectionHub] Sleeper projections unavailable: ${err.message}`);
      return null;
    }),
    espn.getWeekProjections(season, week).catch((err) => {
      console.warn(`[projectionHub] ESPN projections unavailable: ${err.message}`);
      return null;
    }),
    schedule.getWeekSchedule(season, week).catch(() => null),
  ]);
  const players = sleeperPlayers || (await sleeper.getPlayers());
  const all = computeAllSources({ pools: { tankWeek, tankIds, sleeperPool, espnPool }, settings, sleeperPlayers: players });
  const kickoffFor = (team) => (sched && team ? sched.byTeam?.[schedule.normalizeTeam(team)]?.kickoffMillis ?? null : null);

  // Record raw first so this week counts toward its own lean, then compute
  // leans, then re-record with the adjusted values.
  store.recordProjections(toRecords({ season, week, profile: profile.key, all, leans: null, kickoffFor }));
  const leans = computeLeans(profile.key, Number(season), Number(week));
  store.recordProjections(toRecords({ season, week, profile: profile.key, all, leans, kickoffFor }));

  const counts = { V: 0, T: 0, S: 0, E: 0 };
  for (const e of all.values()) for (const s of Object.keys(counts)) if (e[s] != null) counts[s]++;
  console.log(`[projectionHub] ${season} wk${week} ${profile.label}: ${all.size} players — Vegas ${counts.V}, Tank01 ${counts.T}, Sleeper ${counts.S}, ESPN ${counts.E}. Leans: ${leanSummary(leans)}`);

  lastSummary = { season: Number(season), week: Number(week), profile: profile.label, players: all.size, counts, at: Date.now(), tank01: Boolean(tankWeek), sleeper: Boolean(sleeperPool), espn: Boolean(espnPool) };
  const result = { profile, all, leans, gameLines: gameLinesByTeam(tankWeek) };
  cache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * v3.6: Vegas game lines by team from Tank01's odds (spread and total averaged across sportsbooks) →
 * implied team totals: home = (total − home spread) / 2, away = (total + home spread) / 2.
 * Returns { [TEAM]: { implied, oppImplied, spread, total, source } } (team's own spread: negative = favourite).
 */
export function gameLinesByTeam(tankWeek) {
  const out = {};
  for (const g of Object.values(tankWeek?.odds || {})) {
    const l = g?.lines;
    if (!l || l.total == null || l.homeSpread == null || !l.home || !l.away) continue;
    const home = schedule.normalizeTeam(l.home);
    const away = schedule.normalizeTeam(l.away);
    const hi = round1((l.total - l.homeSpread) / 2);
    const ai = round1((l.total + l.homeSpread) / 2);
    out[home] = { implied: hi, oppImplied: ai, spread: round1(l.homeSpread), total: round1(l.total), source: "Tank01" };
    out[away] = { implied: ai, oppImplied: hi, spread: round1(-l.homeSpread), total: round1(l.total), source: "Tank01" };
  }
  return out;
}
function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}
export function leanSummary(leans) {
  return ["T", "S", "E"]
    .map((src) => `${src} ` + ["QB", "RB", "WR", "TE", "K"].map((p) => `${p}×${leans[src][p].factor}${leans[src][p].none ? "(none)" : leans[src][p].pooled ? "(pooled)" : ""}`).join(" "))
    .join(" | ");
}

/** Picks the projection for one player: Vegas raw, else the first other source with its lean applied. */
export function pick(result, sleeperId) {
  const e = result?.all?.get(String(sleeperId));
  if (!e) return { proj: null, projSource: null, projFactor: null, projStats: null };
  // v2.8: projStats is the stat line from the same source as the number
  // (raw, before any lean — the lean only scales the points total).
  const props = e.props || null; // v3.6
  if (e.V != null) return { proj: e.V, projSource: "V", projFactor: null, projStats: e.lines?.V || null, props };
  for (const src of ["T", "S", "E"]) {
    if (e[src] == null) continue;
    const lean = result.leans?.[src]?.[e.pos];
    const f = lean && !lean.none ? lean.factor : 1;
    return { proj: round(e[src] * f), projSource: src, projFactor: f !== 1 ? f : null, projRaw: e[src], projStats: e.lines?.[src] || null, props };
  }
  return { proj: null, projSource: null, projFactor: null, projStats: null, props };
}

export function clearCache() {
  cache.clear();
}
