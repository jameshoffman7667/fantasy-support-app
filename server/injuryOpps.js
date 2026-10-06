import { cacheGet, cacheSet } from "./db.js";
import { normalizeName } from "./matching.js";
import * as schedule from "./schedule.js";
import * as gemini from "./gemini.js";

/**
 * v3.1 — injury opportunities.
 *
 * When a player at a relevant depth-chart slot (QB1, or QB1-2 in superflex; RB1-2; WR1-3; TE1) is Out /
 * IR / PUP / Suspended / Doubtful — or Questionable AND the news check or the backup's trending rank says
 * he's likely to miss — the next two players BELOW him at his position on the team's depth chart become pickup
 * (or, if you already own one, play) opportunities. For WR and TE injuries a third suggestion is added:
 * the same team's top player at the other of those two positions. K and DST are not covered.
 *
 * v3.5 changes (James):
 *  - Depth charts keep ESPN's separate WR1 / WR2 / WR3 slots. Ranks are starters first (WR1, WR2, WR3), then
 *    the backups by depth, and a hurt WR3 never makes the WR2 an "opportunity". The injured player's own slot
 *    backups come first.
 *  - Replacements come from the SAME NFL team (2 same position + 1 opposite WR/TE). Players from other teams
 *    are only added when the injured player is on your active roster and the team can't fill the 2+1 with
 *    available players (often Sunday/Monday night, when few unplayed options are left).
 *  - Only injuries to players projected for at least 5 points before the injury count.
 *
 * Depth chart: ESPN's team depth chart (UNVERIFIED from the build sandbox — the response shape below is
 * parsed defensively and anything that doesn't parse falls back, per team, to Sleeper's own
 * depth_chart_order). Which source each team used is reported in `source`.
 *
 * Two layers: compute() is global (the NFL, cached 30 min); forLeague() annotates it for one league
 * (ownership, availability, waiver lock, projections).
 */
const ESPN_TEAM_IDS = { ARI: 22, ATL: 1, BAL: 33, BUF: 2, CAR: 29, CHI: 3, CIN: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8, GB: 9, HOU: 34, IND: 11, JAC: 30, KC: 12, LV: 13, LAC: 24, LAR: 14, MIA: 15, MIN: 16, NE: 17, NO: 18, NYG: 19, NYJ: 20, PHI: 21, PIT: 23, SF: 25, SEA: 26, TB: 27, TEN: 10, WAS: 28 };
const POSITIONS = ["QB", "RB", "WR", "TE"];
const LIMIT = { QB: 2, RB: 2, WR: 3, TE: 1 }; // QB rank 2 only counts in superflex (filtered per league)
const DEFINITE = new Set(["Out", "IR", "PUP", "Sus", "Suspended", "Doubtful"]);
const GONE = new Set(["Out", "IR", "PUP", "Sus", "Suspended", "NA", "DNR", "COV"]);
const DEPTH_TTL = 6 * 3600 * 1000;
const EVENTS_TTL = 30 * 60 * 1000;
const OPPOSITE = { WR: "TE", TE: "WR" };

const fullName = (m) => `${m.first_name || ""} ${m.last_name || ""}`.trim();

function sleeperIndex(sleeperPlayers) {
  const byNameTeam = new Map();
  for (const [id, m] of Object.entries(sleeperPlayers || {})) {
    if (!m || !POSITIONS.includes(m.position) || !m.team) continue;
    byNameTeam.set(`${normalizeName(fullName(m))}|${schedule.normalizeTeam(m.team)}`, String(id));
  }
  return byNameTeam;
}

/**
 * Parses an ESPN depth chart response into { QB: [[names]], RB: [[names]], WR: [[slot 1 names], [slot 2], [slot 3]], TE: [[names]] }
 * (offence; one inner list per depth-chart slot, starter first). Defensive; null if nothing usable.
 */
export function parseEspnDepth(json) {
  const charts = Array.isArray(json?.depthchart) ? json.depthchart : Array.isArray(json?.depthCharts) ? json.depthCharts : Array.isArray(json?.items) ? json.items : [];
  const out = {};
  for (const chart of charts) {
    const positions = chart?.positions;
    if (!positions || typeof positions !== "object") continue;
    for (const [key, val] of Object.entries(positions)) {
      const pos = String(val?.position?.abbreviation || key).toUpperCase().replace(/\d+$/, "");
      if (!POSITIONS.includes(pos)) continue;
      const names = (val?.athletes || []).map((a) => a?.athlete?.displayName || a?.athlete?.fullName || a?.displayName || a?.fullName || null).filter(Boolean);
      if (names.length) (out[pos] ||= []).push(names);
    }
    if (Object.keys(out).length) break; // first chart with offence is the one we want
  }
  return Object.keys(out).length ? out : null;
}

/** Ranked list from depth slots: every slot's starter first (slot order), then every slot's 2nd, and so on. */
export function interleaveSlots(slots) {
  const out = [];
  const depth = Math.max(0, ...slots.map((x) => x.length));
  for (let d = 0; d < depth; d++) for (const slot of slots) if (slot[d] != null && !out.includes(slot[d])) out.push(slot[d]);
  return out;
}

function sleeperDepth(sleeperPlayers) {
  // Sleeper's depth_chart_order is per depth_chart_position (LWR / RWR / SWR ...), so group by that first.
  const byTeam = {};
  for (const [id, m] of Object.entries(sleeperPlayers || {})) {
    if (!m || !POSITIONS.includes(m.position) || !m.team || m.active === false) continue;
    const order = Number(m.depth_chart_order);
    if (!Number.isFinite(order) || order < 1) continue;
    const t = schedule.normalizeTeam(m.team);
    const slot = m.depth_chart_position || m.position;
    (((byTeam[t] ||= {})[m.position] ||= {})[slot] ||= []).push({ id: String(id), order });
  }
  const out = {};
  for (const [t, byPos] of Object.entries(byTeam)) {
    out[t] = { slots: {} };
    for (const [pos, bySlot] of Object.entries(byPos)) {
      const slots = Object.values(bySlot)
        .map((list) => list.sort((a, b) => a.order - b.order).map((x) => x.id))
        .sort((a, b) => Number(sleeperPlayers[a[0]]?.depth_chart_order || 9) - Number(sleeperPlayers[b[0]]?.depth_chart_order || 9));
      out[t].slots[pos] = slots;
      out[t][pos] = interleaveSlots(slots).slice(0, 8);
    }
  }
  return out;
}

async function fetchEspnTeam(team, espnId) {
  const urls = [`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnId}/depthcharts`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) continue;
      const parsed = parseEspnDepth(await res.json());
      if (parsed) return parsed;
    } catch {
      /* try next / fall back */
    }
  }
  return null;
}

export async function getDepth(season, sleeperPlayers) {
  const key = `injopps:depth:v2:${season}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const idx = sleeperIndex(sleeperPlayers);
  const fallback = sleeperDepth(sleeperPlayers);
  const byTeam = {};
  const source = {};
  const teams = Object.keys(ESPN_TEAM_IDS);
  let i = 0;
  const worker = async () => {
    while (i < teams.length) {
      const team = teams[i++];
      const parsed = await fetchEspnTeam(team, ESPN_TEAM_IDS[team]);
      if (parsed) {
        const mapped = { slots: {} };
        for (const pos of POSITIONS) {
          const slots = (parsed[pos] || []).map((names) => names.map((n) => idx.get(`${normalizeName(n)}|${team}`)).filter(Boolean)).filter((x) => x.length);
          mapped.slots[pos] = slots;
          mapped[pos] = interleaveSlots(slots);
        }
        // ESPN gave a chart but nothing matched for a position → use Sleeper for that position
        for (const pos of POSITIONS)
          if (!mapped[pos].length) {
            mapped[pos] = fallback[team]?.[pos] || [];
            mapped.slots[pos] = fallback[team]?.slots?.[pos] || [];
          }
        byTeam[team] = mapped;
        source[team] = "espn";
      } else {
        byTeam[team] = { QB: [], RB: [], WR: [], TE: [], slots: {}, ...(fallback[team] || {}) };
        source[team] = "sleeper";
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const espnTeams = Object.values(source).filter((s) => s === "espn").length;
  console.log(`[injuryOpps] Depth charts: ${espnTeams}/32 teams from ESPN, the rest from Sleeper's depth_chart_order.`);
  const out = { at: Date.now(), byTeam, source, espnTeams };
  cacheSet(key, out, DEPTH_TTL);
  return out;
}

/**
 * Pure: events from a depth chart + statuses. `trendingIds` is the set of Sleeper ids on the 24h trending-adds list.
 * Backups are always ranked BELOW the injured player: his own slot's backups first, then the next players down the
 * position's ranked list (never a starter ranked above him).
 */
export function buildEvents({ depth, sleeperPlayers, trendingIds = new Set() }) {
  const events = [];
  for (const [team, chart] of Object.entries(depth.byTeam || {})) {
    for (const pos of POSITIONS) {
      const list = chart?.[pos] || [];
      const slots = chart?.slots?.[pos] || [];
      for (let i = 0; i < Math.min(LIMIT[pos], list.length); i++) {
        const m = sleeperPlayers[list[i]];
        const status = m?.injury_status;
        if (!m || !(DEFINITE.has(status) || status === "Questionable")) continue;
        const backups = [];
        const take = (id) => {
          if (backups.length >= 2 || id === list[i] || backups.some((b) => b.id === id)) return;
          const j = list.indexOf(id);
          if (j !== -1 && j <= i) return; // never someone ranked above (or level with) the injured player
          const bm = sleeperPlayers[id];
          if (!bm || GONE.has(bm.injury_status) || bm.active === false) return;
          backups.push({ id, rank: j === -1 ? list.length + 1 : j + 1 });
        };
        const ownSlot = slots.find((sl) => sl[0] === list[i]);
        for (const id of (ownSlot || []).slice(1)) take(id);
        for (let j = i + 1; j < list.length && backups.length < 2; j++) take(list[j]);
        events.push({ key: `${list[i]}|${status}`, id: list[i], pos, team, rank: i + 1, status, backups, backupTrending: backups.some((b) => trendingIds.has(b.id)), questionable: status === "Questionable" });
      }
    }
  }
  return events;
}

export async function compute({ season, week, sleeperPlayers, trending = [] }) {
  const key = `injopps:events:v2:${season}:${week}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const depth = await getDepth(season, sleeperPlayers);
  const trendingIds = new Set((trending || []).map((t) => String(t.player_id)));
  const events = buildEvents({ depth, sleeperPlayers, trendingIds });
  // Questionable → news check (one grounded call for the whole NFL list, cached 3 h).
  const q = events.filter((e) => e.questionable);
  let sentiment = null;
  let sentimentError = null;
  if (q.length && gemini.isConfigured()) {
    try {
      sentiment = await gemini.injurySentiment(season, week, q.map((e) => ({ key: e.key, name: fullName(sleeperPlayers[e.id]), pos: e.pos, team: e.team, note: sleeperPlayers[e.id]?.injury_body_part ? `Questionable (${sleeperPlayers[e.id].injury_body_part})` : null })));
    } catch (err) {
      sentimentError = err.message;
      console.warn(`[injuryOpps] News check failed: ${err.message}`);
    }
  }
  for (const e of q) {
    const s = sentiment?.byKey?.[e.key];
    const signals = [];
    if (s?.flag === "down") signals.push("practice or reporting trending down");
    if (e.backupTrending) signals.push("backup is trending on Sleeper");
    e.signals = signals;
    e.flagged = signals.length > 0;
    e.news = s ? { flag: s.flag, practice: s.practice, note: s.note } : null;
  }
  const out = { at: Date.now(), depthSource: { espnTeams: depth.espnTeams, source: depth.source }, depth: depth.byTeam, events, newsConfigured: gemini.isConfigured(), newsError: sentimentError, newsAt: sentiment?.at ?? null };
  cacheSet(key, out, EVENTS_TTL);
  return out;
}

/**
 * Annotates the global events for one league.
 * ctx: { superflex, sleeperPlayers, allRosteredIds:Set, mine:{active:Set, stashed:Set}, waiverLocked(team), projOf(id)->number|null,
 *        preInjuryProj(id)->number|null, topFreeList(pos, n, excludeIds:Set)->[{id, proj}], cardOf(id)->{...} }
 */
export const MIN_PRE_INJURY_PROJ = 5;
export function forLeague(global, ctx) {
  if (!global) return null;
  const out = [];
  const owner = (id) => (ctx.mine.active.has(id) || ctx.mine.stashed.has(id) ? "mine" : ctx.allRosteredIds.has(id) ? "other" : "free");
  const card = (id, extra = {}) => {
    const o = owner(id);
    const locked = o === "free" && ctx.waiverLocked(ctx.sleeperPlayers[id]?.team);
    return { ...ctx.cardOf(id), owner: o, locked, proj: ctx.projOf(id), ...extra };
  };
  for (const e of global.events || []) {
    if (e.pos === "QB" && e.rank === 2 && !ctx.superflex) continue;
    if (e.questionable && !e.flagged) continue; // Questionable with no sign of a miss: nothing to do
    // v3.5: only injuries to players who mattered (projected 5+ points before the injury).
    const pre = ctx.preInjuryProj ? ctx.preInjuryProj(e.id) : null;
    if (ctx.preInjuryProj && (pre == null || pre < MIN_PRE_INJURY_PROJ)) continue;
    const meta = ctx.sleeperPlayers[e.id];
    const backups = e.backups.map((b) => card(b.id, { rank: b.rank }));
    // Opposite position (WR injury → the team's TE, TE injury → the team's WR): same NFL team, best projection
    // among the top three on that position's depth chart, healthy, not the injured player.
    let opposite = null;
    let oppCards = [];
    const opp = OPPOSITE[e.pos];
    const healthy = (id) => id && !GONE.has(ctx.sleeperPlayers[id]?.injury_status) && ctx.sleeperPlayers[id]?.active !== false;
    if (opp) {
      const chart = global.depth?.[e.team]?.[opp] || [];
      const cands = chart.slice(0, 3).filter((id) => id !== e.id && healthy(id));
      cands.sort((a, b) => (ctx.projOf(b) ?? -1) - (ctx.projOf(a) ?? -1));
      oppCards = cands.map((id) => card(id, { rank: chart.indexOf(id) + 1, opposite: true }));
      opposite = oppCards[0] || null; // the note names the best one, owned or not
    }
    const mineState = ctx.mine.active.has(e.id) ? "active" : ctx.mine.stashed.has(e.id) ? "stashed" : null;
    const available = (c) => c && c.owner === "free" && !c.locked;
    // Pickups: up to 2 available same-team players at his position ranked below him (his slot's backups first, then
    // down the depth chart — deeper than the two "moves up" backups when those are owned) and the best available of
    // the team's top three at the opposite position (WR <-> TE).
    const freeSame = backups.filter(available);
    {
      const chartSame = global.depth?.[e.team]?.[e.pos] || [];
      const ownSlot = (global.depth?.[e.team]?.slots?.[e.pos] || []).find((sl) => sl[0] === e.id) || [];
      const seen = new Set([e.id, ...backups.map((b) => b.id)]);
      for (const id of [...ownSlot.slice(1), ...chartSame.slice(e.rank)]) {
        if (freeSame.length >= 2) break;
        if (seen.has(id)) continue;
        seen.add(id);
        const j = chartSame.indexOf(id);
        if ((j !== -1 && j < e.rank) || !healthy(id)) continue; // never someone ranked above (or level with) him
        const c = card(id, { rank: j === -1 ? chartSame.length + 1 : j + 1 });
        if (available(c)) freeSame.push(c);
      }
    }
    const freeOpp = oppCards.filter(available).slice(0, 1);
    // Your own injured active player and the team can't fill 2 same-position (+1 opposite) adds: top up with the
    // best available players from other teams whose games haven't started.
    let otherTeam = [];
    if (mineState === "active" && ctx.topFreeList) {
      const exclude = new Set([e.id, ...backups.map((b) => b.id), ...freeSame.map((b) => b.id), ...oppCards.map((c) => c.id)]);
      const needSame = Math.max(0, 2 - freeSame.length);
      const needOpp = opp ? Math.max(0, 1 - freeOpp.length) : 0;
      const fill = (pos, n) => {
        const got = [];
        for (const t of ctx.topFreeList(pos, n + exclude.size, exclude) || []) {
          if (got.length >= n) break;
          if (exclude.has(String(t.id))) continue;
          const c = card(String(t.id), { otherTeam: true });
          if (!available(c)) continue;
          exclude.add(String(t.id));
          got.push({ ...c, proj: t.proj ?? c.proj });
        }
        return got;
      };
      otherTeam = [...fill(e.pos, needSame), ...(needOpp ? fill(opp, needOpp) : [])];
    }
    out.push({
      key: e.key,
      injured: { id: e.id, name: fullName(meta), pos: e.pos, team: e.team, status: e.status, note: meta?.injury_body_part || null, rank: e.rank, slot: `${e.pos}${e.rank}`, preProj: pre != null ? Math.round(pre * 10) / 10 : null },
      mine: mineState,
      questionable: e.questionable,
      signals: e.signals || [],
      news: e.news || null,
      backups,
      freeAdds: [...freeSame, ...freeOpp, ...otherTeam],
      opposite,
    });
  }
  return { at: global.at, depthSource: global.depthSource, newsConfigured: global.newsConfigured, newsError: global.newsError, newsAt: global.newsAt, events: out };
}
