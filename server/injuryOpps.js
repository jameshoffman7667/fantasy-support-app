import { cacheGet, cacheSet } from "./db.js";
import { normalizeName } from "./matching.js";
import * as schedule from "./schedule.js";
import * as gemini from "./gemini.js";

/**
 * v3.1 — injury opportunities.
 *
 * When a player at a relevant depth-chart slot (QB1, or QB1-2 in superflex; RB1-2; WR1-3; TE1) is Out /
 * IR / PUP / Suspended / Doubtful — or Questionable AND the news check or the backup's trending rank says
 * he's likely to miss — the next two players at his position on the team's depth chart become pickup
 * (or, if you already own one, play) opportunities. For WR and TE injuries a third suggestion is added:
 * the best available player at the other of those two positions. K and DST are not covered.
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

/** Parses an ESPN depth chart response into { QB:[names], RB:[], WR:[], TE:[] } (offence). Defensive; null if nothing usable. */
export function parseEspnDepth(json) {
  const charts = Array.isArray(json?.depthchart) ? json.depthchart : Array.isArray(json?.depthCharts) ? json.depthCharts : Array.isArray(json?.items) ? json.items : [];
  const out = {};
  for (const chart of charts) {
    const positions = chart?.positions;
    if (!positions || typeof positions !== "object") continue;
    for (const [key, val] of Object.entries(positions)) {
      const pos = String(val?.position?.abbreviation || key).toUpperCase();
      if (!POSITIONS.includes(pos)) continue;
      const names = (val?.athletes || []).map((a) => a?.athlete?.displayName || a?.athlete?.fullName || a?.displayName || a?.fullName || null).filter(Boolean);
      if (names.length) out[pos] = [...(out[pos] || []), ...names.filter((n) => !(out[pos] || []).includes(n))];
    }
    if (Object.keys(out).length) break; // first chart with offence is the one we want
  }
  return Object.keys(out).length ? out : null;
}

function sleeperDepth(sleeperPlayers) {
  const byTeam = {};
  for (const [id, m] of Object.entries(sleeperPlayers || {})) {
    if (!m || !POSITIONS.includes(m.position) || !m.team || m.active === false) continue;
    const order = Number(m.depth_chart_order);
    if (!Number.isFinite(order) || order < 1) continue;
    const t = schedule.normalizeTeam(m.team);
    ((byTeam[t] ||= {})[m.position] ||= []).push({ id: String(id), order });
  }
  for (const t of Object.values(byTeam)) for (const pos of Object.keys(t)) t[pos] = t[pos].sort((a, b) => a.order - b.order).slice(0, 6).map((x) => x.id);
  return byTeam;
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
  const key = `injopps:depth:v1:${season}`;
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
        const mapped = {};
        for (const pos of POSITIONS) mapped[pos] = (parsed[pos] || []).map((n) => idx.get(`${normalizeName(n)}|${team}`)).filter(Boolean);
        // ESPN gave a chart but nothing matched for a position → use Sleeper for that position
        for (const pos of POSITIONS) if (!mapped[pos].length) mapped[pos] = fallback[team]?.[pos] || [];
        byTeam[team] = mapped;
        source[team] = "espn";
      } else {
        byTeam[team] = { QB: [], RB: [], WR: [], TE: [], ...(fallback[team] || {}) };
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

/** Pure: events from a depth chart + statuses. `trendingIds` is the set of Sleeper ids on the 24h trending-adds list. */
export function buildEvents({ depth, sleeperPlayers, trendingIds = new Set() }) {
  const events = [];
  for (const [team, chart] of Object.entries(depth.byTeam || {})) {
    for (const pos of POSITIONS) {
      const list = chart?.[pos] || [];
      for (let i = 0; i < Math.min(LIMIT[pos], list.length); i++) {
        const m = sleeperPlayers[list[i]];
        const status = m?.injury_status;
        if (!m || !(DEFINITE.has(status) || status === "Questionable")) continue;
        const backups = [];
        for (let j = i + 1; j < list.length && backups.length < 2; j++) {
          const bm = sleeperPlayers[list[j]];
          if (!bm || GONE.has(bm.injury_status) || bm.active === false) continue;
          backups.push({ id: list[j], rank: j + 1 });
        }
        events.push({ key: `${list[i]}|${status}`, id: list[i], pos, team, rank: i + 1, status, backups, backupTrending: backups.some((b) => trendingIds.has(b.id)), questionable: status === "Questionable" });
      }
    }
  }
  return events;
}

export async function compute({ season, week, sleeperPlayers, trending = [] }) {
  const key = `injopps:events:v1:${season}:${week}`;
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
  const out = { at: Date.now(), depthSource: { espnTeams: depth.espnTeams, source: depth.source }, events, newsConfigured: gemini.isConfigured(), newsError: sentimentError, newsAt: sentiment?.at ?? null };
  cacheSet(key, out, EVENTS_TTL);
  return out;
}

/**
 * Annotates the global events for one league.
 * ctx: { superflex, sleeperPlayers, allRosteredIds:Set, mine:{active:Set, stashed:Set}, waiverLocked(team), projOf(id)->number|null,
 *        topFree(pos)->{id}|null, cardOf(id)->{...} }
 */
export function forLeague(global, ctx) {
  if (!global) return null;
  const out = [];
  for (const e of global.events || []) {
    if (e.pos === "QB" && e.rank === 2 && !ctx.superflex) continue;
    if (e.questionable && !e.flagged) continue; // Questionable with no sign of a miss: nothing to do
    const meta = ctx.sleeperPlayers[e.id];
    const owner = (id) => (ctx.mine.active.has(id) || ctx.mine.stashed.has(id) ? "mine" : ctx.allRosteredIds.has(id) ? "other" : "free");
    const backups = e.backups.map((b) => {
      const o = owner(b.id);
      const locked = o === "free" && ctx.waiverLocked(ctx.sleeperPlayers[b.id]?.team);
      return { ...ctx.cardOf(b.id), rank: b.rank, owner: o, locked, proj: ctx.projOf(b.id) };
    });
    const freeBackups = backups.filter((b) => b.owner === "free" && !b.locked);
    let opposite = null;
    const opp = OPPOSITE[e.pos];
    if (opp) {
      const t = ctx.topFree(opp);
      if (t) opposite = { ...ctx.cardOf(t.id), proj: t.proj ?? ctx.projOf(t.id), owner: "free", locked: false };
    }
    const mineState = ctx.mine.active.has(e.id) ? "active" : ctx.mine.stashed.has(e.id) ? "stashed" : null;
    out.push({
      key: e.key,
      injured: { id: e.id, name: fullName(meta), pos: e.pos, team: e.team, status: e.status, note: meta?.injury_body_part || null, rank: e.rank, slot: `${e.pos}${e.rank}` },
      mine: mineState,
      questionable: e.questionable,
      signals: e.signals || [],
      news: e.news || null,
      backups,
      freeAdds: [...freeBackups, ...(opposite ? [opposite] : [])],
      opposite,
    });
  }
  return { at: global.at, depthSource: global.depthSource, newsConfigured: global.newsConfigured, newsError: global.newsError, newsAt: global.newsAt, events: out };
}
