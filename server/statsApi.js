import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import * as statConfig from "./statConfig.js";
import * as statsStore from "./statsStore.js";
import * as statQuery from "./statQuery.js";
import * as hub from "./projectionHub.js";
import * as nv from "./nflverseStats.js";
import * as schedule from "./schedule.js";
import * as rosProjections from "./rosProjections.js";
import * as fp from "./fantasyPros.js";
import * as gemini from "./gemini.js";
import * as values from "./values.js";
import { nameIndex } from "./waiverCategories.js";
import { buildFpIndex, lookupFpMulti } from "./matching.js";
import { propLines } from "./buildLeague.js";
import { DEFS } from "./statDefs.js";

/**
 * v4.2 routes: the stats list (and its spreadsheet), the stats query behind Waivers → All and Analytics → Scouting,
 * and saved views / bookmarks. Registered from server.js with its auth helpers.
 */
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const viewKey = (u, k) => `stats_view:${u}:${k}`;
const bmKey = (u) => `scouting_bookmarks:${u}`;
const MAX_STATE = 60000;

/** Universe of players: everyone active at the positions, or a league's free agents. Pure. */
export function buildUniverse(players, { positions, scope, faSearch, ids, curSeason }) {
  const want = new Set((positions?.length ? positions : POSITIONS).filter((p) => POSITIONS.includes(p)));
  const idSet = ids?.length ? new Set(ids.map(String)) : null;
  const rostered = new Set((faSearch?.rosteredIds || []).map(String));
  const leaguePos = faSearch?.positions ? new Set(faSearch.positions) : null;
  const locked = new Set(faSearch?.lockedTeams || []);
  const out = [];
  for (const [id, m] of Object.entries(players || {})) {
    if (!m || !want.has(m.position)) continue;
    if (idSet && !idSet.has(String(id))) continue;
    const isDef = m.position === "DEF";
    if (!isDef && (m.active === false || !m.team)) continue;
    if (scope === "fa") {
      if (rostered.has(String(id))) continue;
      if (leaguePos && !leaguePos.has(m.position)) continue;
      if (m.team && locked.has(m.team)) continue;
    }
    const name = isDef ? `${m.first_name || ""} ${m.last_name || ""}`.trim() || String(id) : m.full_name || `${m.first_name || ""} ${m.last_name || ""}`.trim();
    const yrs = Number(m.years_exp);
    out.push({
      id: String(id),
      name,
      pos: m.position,
      team: m.team || (isDef ? String(id) : null),
      status: m.injury_status || null,
      rookie: Number.isFinite(yrs) ? Number(curSeason) - yrs : null,
    });
  }
  return out;
}

const ageOf = (m, now = Date.now()) => {
  if (m?.age != null && Number.isFinite(Number(m.age))) return Number(m.age);
  if (!m?.birth_date) return null;
  const b = Date.parse(m.birth_date);
  return Number.isFinite(b) ? Math.round(((now - b) / (365.25 * 864e5)) * 10) / 10 : null;
};

/** Lazily loads each current-only source the first time a stat needs it. */
function currentProvider({ players, settings, cur, superflex }) {
  const cache = new Map();
  const once = (k, fn) => {
    if (!cache.has(k)) cache.set(k, fn().catch((err) => (console.warn(`[statsApi] ${k}: ${err.message}`), null)));
    return cache.get(k);
  };
  const loaders = {
    hub: () => once("hub", () => hub.getWeek({ season: cur.season, week: cur.week, settings, sleeperPlayers: players })),
    ros: () => once("ros", () => rosProjections.rosPoints({ season: cur.season, week: cur.week, settings })),
    trend: () => once("trend", () => sleeper.getTrendingAdds(200, 24)),
    hype: () => once("hype", () => gemini.waiverHype(cur.season, cur.week, { cacheOnly: true })),
    dynasty: () => once("dynasty", () => values.leagueValues({ dynasty: true, superflex })),
    ecr: () =>
      once("ecr", async () => {
        const scoring = Number(settings?.rec ?? 0) >= 1 ? "PPR" : Number(settings?.rec ?? 0) > 0 ? "HALF" : "STD";
        const lists = await Promise.all(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => fp.getConsensusRankings(cur.season, { position, scoring, week: cur.week }).then((r) => (r.players || r.data || []).map((p) => ({ ...p, position_id: p.position_id || p.player_position_id || position }))).catch(() => [])));
        return lists.flat();
      }),
  };
  return {
    async prepare(kinds) {
      const need = new Set();
      for (const k of kinds) {
        if (k === "rostered" || k === "implied" || k === "spread" || k === "proj_source" || k.startsWith("prop:")) need.add("hub");
        else if (loaders[k]) need.add(k);
      }
      const got = {};
      for (const k of need) got[k] = await loaders[k]();
      const hubAll = got.hub?.all || null;
      const lines = got.hub?.gameLines || {};
      const trend = new Map((got.trend || []).map((t) => [String(t.player_id), t.count ?? null]));
      let hype = null;
      if (got.hype?.players?.length) {
        const find = nameIndex(players);
        hype = new Map();
        for (const h of got.hype.players) {
          const id = find(h.name, h.pos, h.team);
          if (id) hype.set(id, h.mentions);
        }
      }
      let ecr = null;
      if (got.ecr?.length) {
        const idx = buildFpIndex(got.ecr);
        const byTeam = new Map(got.ecr.filter((r) => String(r.position_id).toUpperCase() === "DST").map((r) => [String(r.player_team_id || "").toUpperCase(), r]));
        ecr = (id) => {
          const m = players[id];
          if (!m) return null;
          const rec = m.position === "DEF" ? byTeam.get(String(id).toUpperCase()) : lookupFpMulti(idx, [m.full_name || `${m.first_name} ${m.last_name}`], m.position === "DEF" ? "DST" : m.position);
          const r = rec ? Number(rec.rank_ecr ?? rec.rank) : null;
          return Number.isFinite(r) ? r : null;
        };
      }
      return (kind, id) => {
        const m = players[id];
        switch (kind) {
          case "age":
            return m?.position === "DEF" ? null : ageOf(m);
          case "rostered":
            return hubAll?.get(String(id))?.own ?? null;
          case "proj_source":
            return hub.pick(got.hub, id)?.projSource ?? null;
          case "implied":
          case "spread": {
            const t = m?.team;
            const l = t ? lines[schedule.normalizeTeam(t)] || lines[t] : null;
            return l ? l[kind] ?? null : null;
          }
          case "ros":
            return got.ros?.byId?.get(String(id)) ?? null;
          case "trend":
            return trend.get(String(id)) ?? null;
          case "hype":
            return hype ? hype.get(String(id)) ?? null : null;
          case "ecr":
            return ecr ? ecr(String(id)) : null;
          case "dynasty":
            return got.dynasty?.valueOf?.(String(id)) ?? null;
          default:
            if (kind.startsWith("prop:")) {
              const props = propLines(hub.pick(got.hub, id)?.props);
              const key = kind.slice(5);
              return props?.[key] ?? null;
            }
            return null;
        }
      };
    },
  };
}

let gsisMemo = null;
async function gsisToSleeper(players) {
  if (gsisMemo && Date.now() - gsisMemo.at < 6 * 3600e3) return gsisMemo.map;
  const dir = await nv.players().catch(() => ({ byEspn: new Map() }));
  const map = new Map();
  for (const [id, m] of Object.entries(players || {})) {
    const g = String(m?.gsis_id || "").trim();
    if (g) map.set(g, String(id));
  }
  for (const [id, m] of Object.entries(players || {})) {
    const g = m?.espn_id ? dir.byEspn.get(String(m.espn_id))?.gsis_id : null;
    if (g && !map.has(g)) map.set(g, String(id));
  }
  gsisMemo = { at: Date.now(), map };
  return map;
}

/** Cleans a client time selection. Pure. */
export function cleanTime(t, cur) {
  const seasons = (Array.isArray(t?.seasons) ? t.seasons : [cur.season]).map(Number).filter((s) => s >= statsStore.FIRST_STAT_SEASON && s <= Number(cur.season)).slice(0, 30);
  const period = ["season", "avg", "weeks"].includes(t?.period) ? t.period : "season";
  const weeks = (Array.isArray(t?.weeks) ? t.weeks : []).map(Number).filter((w) => w >= 1 && w <= statQuery.MAX_WEEK);
  return { seasons: seasons.length ? [...new Set(seasons)] : [Number(cur.season)], period: period === "weeks" && !weeks.length ? "season" : period, weeks: [...new Set(weeks)] };
}

export function registerStatsRoutes(app, { requireAuth, requireOwner, builtLeague, trackedLeagueIds, jsonBig }) {
  app.use("/api/stats", requireAuth);

  const curOf = async () => {
    const st = await sleeper.getState();
    return { season: Number(st.season), week: Math.max(1, Number(st.week) || 1), seasonType: st.season_type };
  };

  app.get("/api/stats/config", async (req, res) => {
    const cur = await curOf().catch(() => null);
    res.json({ ...statConfig.forClient(), cur, firstStatSeason: statsStore.FIRST_STAT_SEASON, firstProjSeason: statsStore.FIRST_PROJ_SEASON });
  });

  app.get("/api/stats/config.xlsx", (req, res) => {
    const buf = statConfig.exportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="fantasy-stats-list.xlsx"');
    res.send(buf);
  });

  app.post("/api/stats/config/import", requireOwner, jsonBig, (req, res) => {
    try {
      const b64 = String(req.body?.fileBase64 || "");
      if (!b64) return res.status(400).json({ error: "No file." });
      const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
      if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: "That file is too big (5 MB max)." });
      const out = statConfig.importXlsx(buf, req.user.username);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      res.status(400).json({ error: err.message || "Couldn't read that spreadsheet." });
    }
  });

  /**
   * Body: { scope: "fa" | "all", leagueId (fa), scoringLeagueId (all), positions, mode: "proj"|"stat", time, stats, ids }
   */
  app.post("/api/stats/query", async (req, res) => {
    try {
      const b = req.body || {};
      const cur = await curOf();
      const scope = b.scope === "fa" ? "fa" : "all";
      const leagueId = String((scope === "fa" ? b.leagueId : b.scoringLeagueId) || "");
      let lg = null;
      if (leagueId) {
        if (!trackedLeagueIds(req.user.username).includes(leagueId)) return res.status(404).json({ error: "That league isn't one of your tracked leagues." });
        lg = builtLeague(req.user.username, leagueId);
        if (!lg && scope === "fa") return res.status(400).json({ error: "That league hasn't been built yet — refresh first." });
      } else if (scope === "fa") return res.status(400).json({ error: "leagueId is required." });
      const players = await sleeper.getPlayers();
      const league = leagueId ? await sleeper.getLeague(leagueId).catch(() => null) : null;
      const settings = league?.scoring_settings || null;
      const mode = b.mode === "stat" ? "stat" : "proj";
      const time = cleanTime(b.time, cur);
      const enabled = new Set(statConfig.list().map((r) => r.id));
      const stats = (Array.isArray(b.stats) ? b.stats : []).map(String).filter((id) => enabled.has(id) && DEFS[id]).slice(0, 25);
      const universe = buildUniverse(players, { positions: b.positions, scope, faSearch: lg?.faSearch, ids: b.ids, curSeason: cur.season });
      const kinds = [...new Set(stats.map((id) => DEFS[id].current).filter(Boolean))];
      const isNow = statQuery.isCurrentTime(time, cur);
      const current = kinds.length && isNow ? await currentProvider({ players, settings: settings || {}, cur, superflex: Boolean(lg?.superflex) }).prepare(kinds) : null;
      const out = await statQuery.run({ universe, stats, time, mode, settings, cur, currentValues: current, gsisToSleeper: await gsisToSleeper(players) });
      res.json({ ...out, cur, time, mode, stats, isNow, scoring: league ? { leagueId, name: league.name } : null });
    } catch (err) {
      console.warn(`[statsApi] query failed: ${err.stack || err.message}`);
      res.status(502).json({ error: err.message || "The stats query failed." });
    }
  });

  // Saved views (last used settings) — key "waivers" or "scouting".
  app.get("/api/stats/view", (req, res) => {
    const k = ["waivers", "scouting"].includes(req.query.key) ? req.query.key : null;
    if (!k) return res.status(400).json({ error: "key must be waivers or scouting" });
    res.json({ state: store.getState(viewKey(req.user.username, k), null) });
  });
  app.post("/api/stats/view", (req, res) => {
    const k = ["waivers", "scouting"].includes(req.body?.key) ? req.body.key : null;
    if (!k) return res.status(400).json({ error: "key must be waivers or scouting" });
    const state = req.body?.state ?? null;
    if (JSON.stringify(state ?? null).length > MAX_STATE) return res.status(413).json({ error: "Too much to save." });
    store.setState(viewKey(req.user.username, k), state);
    res.json({ ok: true });
  });
  app.get("/api/stats/bookmarks", (req, res) => res.json({ bookmarks: store.getState(bmKey(req.user.username), []) }));
  app.post("/api/stats/bookmarks", (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const del = req.body?.delete === true;
    if (!name) return res.status(400).json({ error: "A bookmark needs a name." });
    const state = req.body?.state ?? null;
    if (!del && JSON.stringify(state).length > MAX_STATE) return res.status(413).json({ error: "Too much to save." });
    const list = store.getState(bmKey(req.user.username), []).filter((b) => b.name.toLowerCase() !== name.toLowerCase());
    if (!del) list.unshift({ name, state, at: Date.now() });
    store.setState(bmKey(req.user.username), list.slice(0, 50));
    res.json({ bookmarks: list.slice(0, 50) });
  });
  app.get("/api/stats/loaded", (req, res) => res.json({ weeks: statsStore.summary() }));
}
