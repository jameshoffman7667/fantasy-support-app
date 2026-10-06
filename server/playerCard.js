import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as nv from "./nflverseStats.js";
import * as adv from "./advancedStats.js";
import * as store from "./projectionStore.js";
import * as slp from "./sleeperProjections.js";
import * as values from "./values.js";
import * as injuryOpps from "./injuryOpps.js";
import { cacheGet, cacheSet, getUserState } from "./db.js";

/**
 * v3.5 — the player card pop-up (benchmarked on Sleeper's own card from James's screenshots):
 * header (age to one decimal, height, weight, experience, number, team, bye), availability in your other
 * leagues, then SUMMARY (ranks, points per game, last game, projections vs finals, advanced stats, news),
 * GAME LOG (this season and last, week by week), TEAM (team ranks, depth chart with ages) and HISTORY (moves in
 * this league, draft, career by season), plus a dynasty / trade value panel.
 *
 * Fantasy points use the league's own scoring on Sleeper's stat lines (the same numbers the app shows
 * elsewhere); the career table uses nflverse's standard / half-PPR / PPR points.
 */
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_SCORING = { pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2, rush_yd: 0.1, rush_td: 6, rush_2pt: 2, rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2, fgm: 3, xpm: 1 };
const FANTASY_POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export function ageFrom(birthDate, now = Date.now()) {
  const t = Date.parse(birthDate);
  if (!Number.isFinite(t)) return null;
  return Math.floor(((now - t) / (365.25 * DAY)) * 10) / 10;
}
export function heightLabel(h) {
  const inches = Number(String(h ?? "").replace(/[^\d.]/g, ""));
  if (!inches) return null;
  if (String(h).includes("'")) return String(h);
  return `${Math.floor(inches / 12)}'${Math.round(inches % 12)}"`;
}
const fullName = (m, id) => (m ? `${m.first_name || ""} ${m.last_name || ""}`.trim() : `Player ${id}`);

/* ---------- league-scoring points and ranks from Sleeper's actual stat lines (memoized per profile/season/week) ---------- */
const weekScoreMemo = new Map();
function weekScores(season, week, settings, players) {
  const profile = store.profileOf(settings).key;
  const key = `${profile}|${season}|${week}`;
  const hit = weekScoreMemo.get(key);
  if (hit && Date.now() - hit.at < 6 * HOUR) return hit.value;
  const rows = store.actualsFor(season, [week]);
  const byId = new Map();
  const byPos = {};
  for (const r of rows) {
    const pos = players[r.player_id]?.position;
    if (!FANTASY_POS.includes(pos)) continue;
    const stats = JSON.parse(r.stats_json);
    if (Number(stats.gp ?? 1) <= 0) continue;
    const pts = slp.scoreStats({ pos, stats }, settings);
    if (pts == null) continue;
    byId.set(r.player_id, { pts, pos, stats });
    (byPos[pos] ||= []).push(pts);
  }
  for (const list of Object.values(byPos)) list.sort((a, b) => b - a);
  const value = { byId, rankOf: (id) => {
    const e = byId.get(String(id));
    if (!e) return null;
    return byPos[e.pos].indexOf(e.pts) + 1;
  } };
  weekScoreMemo.set(key, { at: Date.now(), value });
  if (weekScoreMemo.size > 200) weekScoreMemo.delete(weekScoreMemo.keys().next().value);
  return value;
}

/** Season totals through `throughWeek` in league scoring, with position and overall ranks. */
function seasonRanks(season, throughWeek, settings, players) {
  const totals = new Map();
  for (let w = 1; w <= throughWeek; w++) {
    const ws = weekScores(season, w, settings, players);
    for (const [id, e] of ws.byId) {
      const t = totals.get(id) || { pts: 0, games: 0, pos: e.pos };
      t.pts += e.pts;
      t.games += 1;
      totals.set(id, t);
    }
  }
  const all = [...totals.entries()].sort((a, b) => b[1].pts - a[1].pts);
  const overall = new Map(all.map(([id], i) => [id, i + 1]));
  const posRank = new Map();
  const seen = {};
  for (const [id, t] of all) {
    seen[t.pos] = (seen[t.pos] || 0) + 1;
    posRank.set(id, seen[t.pos]);
  }
  return { totals, overall, posRank };
}

/* ---------- ESPN fantasy news (free, keyless; Rotowire-style items) ---------- */
export function parseEspnNews(json) {
  const feed = Array.isArray(json?.feed) ? json.feed : [];
  const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return feed
    .map((f) => ({ headline: strip(f.headline), story: strip(f.story || f.description).slice(0, 900), published: f.published || f.lastModified || null, source: f.type === "Rotowire" || /rotowire/i.test(f.dataSourceIdentifier || "") ? "RotoWire" : f.type || "ESPN" }))
    .filter((f) => f.headline)
    .sort((a, b) => Date.parse(b.published || 0) - Date.parse(a.published || 0))
    .slice(0, 5);
}
async function espnNews(espnId) {
  if (!espnId) return { items: [], error: null };
  const key = `espn-news:${espnId}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  try {
    const res = await fetch(`https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=10&playerId=${encodeURIComponent(espnId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = { items: parseEspnNews(await res.json()), error: null };
    cacheSet(key, out, HOUR);
    return out;
  } catch (err) {
    const out = { items: [], error: err.message };
    cacheSet(key, out, 10 * 60 * 1000);
    return out;
  }
}

/* ---------- game log ---------- */
function statColumns(pos) {
  if (pos === "QB") return [["completions", "CMP"], ["attempts", "ATT"], ["passing_yards", "YD"], ["passing_tds", "TD"], ["passing_interceptions", "INT"], ["carries", "CAR"], ["rushing_yards", "RUSH YD"], ["rushing_tds", "RUSH TD"]];
  if (pos === "RB") return [["carries", "CAR"], ["rushing_yards", "YD"], ["rushing_tds", "TD"], ["targets", "TGT"], ["receptions", "REC"], ["receiving_yards", "REC YD"], ["receiving_tds", "REC TD"]];
  if (pos === "WR" || pos === "TE") return [["targets", "TGT"], ["receptions", "REC"], ["receiving_yards", "YD"], ["receiving_tds", "TD"], ["carries", "CAR"], ["rushing_yards", "RUSH YD"]];
  if (pos === "K") return [["fg_made", "FGM"], ["fg_att", "FGA"], ["pat_made", "XPM"]];
  return [];
}

async function gameLog({ season, currentSeason, currentWeek, gsis, pfrId, sleeperId, pos, team, settings, players, seasonSched }) {
  const [weekly, snapRows] = await Promise.all([gsis ? nv.weekly(season, currentSeason).catch(() => []) : [], pfrId ? nv.snaps(season, currentSeason).catch(() => []) : []]);
  const mine = weekly.filter((r) => r.player_id === gsis);
  const snapByWeek = new Map(snapRows.filter((s) => s.pfr_player_id === pfrId).map((s) => [s.week, s]));
  const byWeek = new Map(mine.map((r) => [r.week, r]));
  const lastWeek = season < currentSeason ? 18 : 18;
  const rows = [];
  for (let w = 1; w <= lastWeek; w++) {
    const r = byWeek.get(w);
    const ws = season < currentSeason || w < currentWeek ? weekScores(season, w, settings, players) : null;
    const scored = ws?.byId.get(String(sleeperId)) || null;
    let opp = null;
    let home = null;
    if (r) {
      opp = r.opponent_team;
      const parts = String(r.game_id || "").split("_");
      home = parts.length >= 4 ? parts[3] === r.team : null;
    } else if (season === currentSeason && seasonSched?.byWeek?.[w] && team) {
      const g = seasonSched.byWeek[w][schedule.normalizeTeam(team)];
      if (g) (opp = g.opp), (home = g.home);
    }
    const bye = season === currentSeason && seasonSched?.byes?.[schedule.normalizeTeam(team || "")] === w;
    const snap = snapByWeek.get(w);
    const fallbackPts = r ? (Number(settings.rec ?? 0) >= 1 ? r.fantasy_points_ppr : Number(settings.rec ?? 0) > 0 ? (r.fantasy_points + r.fantasy_points_ppr) / 2 : r.fantasy_points) : null;
    const played = Boolean(r || scored);
    const stats = {};
    for (const [k] of statColumns(pos)) if (r && r[k] != null) stats[k] = r[k];
    rows.push({
      week: w,
      opp: opp || null,
      home,
      bye: Boolean(bye),
      played,
      future: season === currentSeason && w >= currentWeek && !played,
      fpts: scored ? r2(scored.pts) : fallbackPts != null ? r2(fallbackPts) : null,
      rank: scored ? ws.rankOf(sleeperId) : null,
      snapPct: snap?.offense_pct != null ? Math.round(snap.offense_pct * 100) : null,
      stats,
    });
  }
  return { season, columns: statColumns(pos).map(([key, label]) => ({ key, label })), rows: season === currentSeason ? rows : rows.filter((x) => x.played || x.opp) };
}

/* ---------- team tab ---------- */
async function teamRanks(season, team) {
  const rows = await nv.teamWeekly(season).catch(() => []);
  if (!rows.length || !team) return null;
  const agg = new Map();
  for (const r of rows) {
    const a = agg.get(r.team) || { games: 0, passYd: 0, passAtt: 0, passTd: 0, rushYd: 0, tds: 0 };
    a.games += 1;
    a.passYd += r.passing_yards ?? 0;
    a.passAtt += r.attempts ?? 0;
    a.passTd += r.passing_tds ?? 0;
    a.rushYd += r.rushing_yards ?? 0;
    a.tds += (r.passing_tds ?? 0) + (r.rushing_tds ?? 0);
    agg.set(r.team, a);
  }
  const metrics = [
    ["offense", "Offense (yds/g)", (a) => (a.passYd + a.rushYd) / a.games],
    ["passYd", "Pass yds/g", (a) => a.passYd / a.games],
    ["passAtt", "Pass att/g", (a) => a.passAtt / a.games],
    ["passTd", "Pass TD/g", (a) => a.passTd / a.games],
    ["rushYd", "Rush yds/g", (a) => a.rushYd / a.games],
    ["tds", "Offensive TD/g", (a) => a.tds / a.games],
  ];
  const t = schedule.normalizeTeam(team);
  const key = [...agg.keys()].find((k) => schedule.normalizeTeam(k) === t);
  if (!key) return null;
  return metrics.map(([k, label, f]) => {
    const sorted = [...agg.entries()].map(([tm, a]) => [tm, f(a)]).sort((x, y) => y[1] - x[1]);
    const rank = sorted.findIndex(([tm]) => tm === key) + 1;
    return { key: k, label, value: r1(f(agg.get(key))), rank, of: sorted.length };
  });
}

async function depthChart(season, team, players) {
  if (!team) return null;
  const depth = await injuryOpps.getDepth(season, players).catch(() => null);
  const chart = depth?.byTeam?.[schedule.normalizeTeam(team)];
  if (!chart) return null;
  const who = (id) => {
    const m = players[id] || {};
    return { id: String(id), name: fullName(m, id), age: m.birth_date ? ageFrom(m.birth_date) : m.age ?? null, status: m.injury_status || null, rookie: Number(m.years_exp) === 0 };
  };
  const rows = [];
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const slots = chart.slots?.[pos]?.length ? chart.slots[pos] : chart[pos]?.length ? [chart[pos]] : [];
    slots.forEach((ids, i) => rows.push({ label: pos === "WR" && slots.length > 1 ? `WR${i + 1}` : pos, players: ids.slice(0, 3).map(who) }));
  }
  return { source: depth?.source?.[schedule.normalizeTeam(team)] || null, rows };
}

/* ---------- history tab ---------- */
async function leagueHistory(leagueId, sleeperId, currentWeek, players) {
  if (!leagueId) return { moves: [], drafts: [] };
  const league = await sleeper.getLeague(leagueId).catch(() => null);
  const [rosters, users] = await Promise.all([sleeper.getRosters(leagueId).catch(() => []), sleeper.getLeagueUsers(leagueId).catch(() => [])]);
  const label = (rid) => {
    const r = rosters.find((x) => Number(x.roster_id) === Number(rid));
    const u = users.find((x) => x.user_id === r?.owner_id);
    return r?.metadata?.team_name || u?.metadata?.team_name || u?.display_name || (rid != null ? `Roster ${rid}` : "?");
  };
  const moves = [];
  for (let w = 1; w <= Math.max(1, currentWeek); w++) {
    const tx = await sleeper.getTransactions(leagueId, w).catch(() => []);
    for (const t of tx || []) {
      if (t?.status !== "complete") continue;
      const add = t.adds?.[sleeperId];
      const drop = t.drops?.[sleeperId];
      if (add == null && drop == null) continue;
      const at = t.status_updated || t.created || null;
      if (t.type === "trade") moves.push({ at, type: "traded", text: `Traded from ${label(drop)} to ${label(add)}` });
      else if (add != null) moves.push({ at, type: t.type === "waiver" ? "waiver" : "added", text: `${t.type === "waiver" ? "Claimed" : "Added"} by ${label(add)}${t.settings?.waiver_bid != null ? ` ($${t.settings.waiver_bid})` : ""}` });
      else moves.push({ at, type: "dropped", text: `Dropped by ${label(drop)}` });
    }
  }
  moves.sort((a, b) => (b.at || 0) - (a.at || 0));
  // Draft picks for this player: this season's league and up to three previous seasons (dynasty leagues renew).
  const drafts = [];
  let lg = league;
  for (let hop = 0; lg && hop < 4; hop++) {
    if (lg.draft_id) {
      const picks = await sleeper.getDraftPicks(lg.draft_id).catch(() => []);
      const p = (picks || []).find((x) => String(x.player_id) === String(sleeperId));
      if (p) {
        const teams = Number(lg.settings?.num_teams || lg.total_rosters || rosters.length || 12);
        const inRound = p.draft_slot ?? ((p.pick_no - 1) % teams) + 1;
        drafts.push({ season: Number(lg.season), text: `Drafted by ${p.picked_by ? users.find((u) => u.user_id === p.picked_by)?.display_name || label(p.roster_id) : label(p.roster_id)} with pick ${p.round}.${String(inRound).padStart(2, "0")}`, round: p.round, pick: p.pick_no });
      }
    }
    if (!lg.previous_league_id || lg.previous_league_id === "0") break;
    lg = await sleeper.getLeague(lg.previous_league_id).catch(() => null);
  }
  return { moves: moves.slice(0, 30), drafts };
}

async function career({ gsis, currentSeason, rookieSeason, pos, settings }) {
  if (!gsis) return [];
  const rec = Number(settings.rec ?? 0);
  const ptsOf = (r) => (rec >= 1 ? r.fantasy_points_ppr : rec > 0 ? (r.fantasy_points + r.fantasy_points_ppr) / 2 : r.fantasy_points);
  const first = Math.max(rookieSeason || currentSeason - 9, currentSeason - 9, 2017);
  const out = [];
  for (let s = first; s <= currentSeason; s++) {
    let rows;
    if (s === currentSeason) {
      const weekly = await nv.weekly(s, currentSeason).catch(() => []);
      const by = new Map();
      for (const r of weekly) {
        const a = by.get(r.player_id) || { player_id: r.player_id, position: r.position, recent_team: r.team, games: 0, fantasy_points: 0, fantasy_points_ppr: 0, passing_yards: 0, passing_tds: 0, rushing_yards: 0, rushing_tds: 0, receptions: 0, receiving_yards: 0, receiving_tds: 0, targets: 0 };
        a.games += 1;
        for (const k of ["fantasy_points", "fantasy_points_ppr", "passing_yards", "passing_tds", "rushing_yards", "rushing_tds", "receptions", "receiving_yards", "receiving_tds", "targets"]) a[k] += r[k] ?? 0;
        a.recent_team = r.team;
        by.set(r.player_id, a);
      }
      rows = [...by.values()];
    } else {
      rows = await nv.seasonTotals(s, currentSeason).catch(() => []);
    }
    const me = rows.find((r) => r.player_id === gsis);
    if (!me) continue;
    const samePos = rows.filter((r) => r.position === me.position);
    const rankBy = (f) => [...samePos].sort((a, b) => (f(b) ?? 0) - (f(a) ?? 0)).findIndex((r) => r.player_id === gsis) + 1;
    out.push({
      season: s,
      team: me.recent_team || null,
      games: me.games ?? null,
      fpts: r1(ptsOf(me)),
      rankHalf: rankBy((r) => (r.fantasy_points + r.fantasy_points_ppr) / 2),
      rankPpr: rankBy((r) => r.fantasy_points_ppr),
      stats: pos === "QB" ? { "Pass YD": me.passing_yards, "Pass TD": me.passing_tds, "Rush YD": me.rushing_yards } : pos === "RB" ? { "Rush YD": me.rushing_yards, "Rush TD": me.rushing_tds, REC: me.receptions, "Rec YD": me.receiving_yards } : { TGT: me.targets, REC: me.receptions, YD: me.receiving_yards, TD: me.receiving_tds },
    });
  }
  return out.reverse();
}

/* ---------- value panel ---------- */
async function valuePanel({ leagueType, superflex, ppr, tep, teams, sleeperId, pos }) {
  const dynasty = leagueType === "dynasty";
  try {
    if (dynasty) {
      const fmt = values.raFormatKey({ superflex, ppr, tep });
      const table = await values.raValues(fmt);
      const v = (e) => (e ? (superflex ? e.sf ?? e.oneqb : e.oneqb ?? e.sf) : null);
      const me = table.map.get(String(sleeperId));
      if (!me) return { source: table.map.size ? "Roster Audit" : null, value: null, error: table.error || null };
      const all = [...table.map.entries()].map(([id, e]) => ({ id, value: v(e), pos: e.pos })).filter((x) => x.value != null).sort((a, b) => b.value - a.value);
      const overall = all.findIndex((x) => x.id === String(sleeperId)) + 1;
      const posList = all.filter((x) => (x.pos || "").toUpperCase() === String(me.pos || pos).toUpperCase());
      const posRank = posList.findIndex((x) => x.id === String(sleeperId)) + 1;
      const detail = await values.raPlayer(sleeperId).catch(() => null);
      return { source: "Roster Audit", kind: "dynasty", format: fmt, value: Math.round(v(me)), overall: overall || null, posRank: posRank || null, trend7: detail?.trend7 ?? me.trend7 ?? null, trend30: detail?.trend30 ?? me.trend30 ?? null, age: detail?.age ?? me.age ?? null, at: table.at };
    }
    const fc = await values.fcValues({ dynasty: false, numQbs: superflex ? 2 : 1, numTeams: teams, ppr });
    const me = fc.map.get(String(sleeperId));
    if (!me) return { source: fc.map.size ? "FantasyCalc" : null, value: null, error: fc.error || null };
    const all = [...fc.map.entries()].map(([id, e]) => ({ id, value: e.redraft ?? e.value, pos: e.pos })).filter((x) => x.value != null).sort((a, b) => b.value - a.value);
    return { source: "FantasyCalc", kind: "redraft", value: Math.round(me.redraft ?? me.value), overall: all.findIndex((x) => x.id === String(sleeperId)) + 1 || null, posRank: all.filter((x) => x.pos === (me.pos || pos)).findIndex((x) => x.id === String(sleeperId)) + 1 || null, trend30: me.trend30 ?? null, at: fc.at };
  } catch (err) {
    return { source: null, value: null, error: err.message };
  }
}

/* ---------- the card ---------- */
export async function getPlayerCard(username, sleeperId, { leagueId = null } = {}) {
  const id = String(sleeperId);
  const st = await sleeper.getState();
  const season = Number(st.season);
  const currentWeek = Number(st.week) || 1;
  const players = await sleeper.getPlayers();
  const meta = players[id];
  if (!meta) throw Object.assign(new Error("Unknown player."), { status: 404 });
  const pos = meta.position;
  const team = meta.team || null;

  // League context (scoring, type, who owns him)
  let league = null;
  let settings = DEFAULT_SCORING;
  if (leagueId) {
    league = await sleeper.getLeague(leagueId).catch(() => null);
    if (league?.scoring_settings) settings = league.scoring_settings;
  }
  const leagueType = Number(league?.settings?.type) === 2 ? "dynasty" : "redraft";
  const superflex = (league?.roster_positions || []).includes("SUPER_FLEX");

  // ids across sources
  const dir = await nv.players().catch(() => ({ byGsis: new Map(), byEspn: new Map() }));
  let gsis = String(meta.gsis_id || "").trim() || null;
  if (!gsis && meta.espn_id) gsis = dir.byEspn.get(String(meta.espn_id))?.gsis_id || null;
  const nvp = gsis ? dir.byGsis.get(gsis) : null;
  const pfrId = nvp?.pfr_id || null;
  const espnId = meta.espn_id || nvp?.espn_id || null;

  const seasonSched = await schedule.getSeasonSchedule(season).catch(() => null);
  const bye = team ? seasonSched?.byes?.[schedule.normalizeTeam(team)] ?? null : null;
  const lastDone = Math.max(0, currentWeek - 1);

  const [logNow, logPrev, advanced, ranksTeam, depth, news, history, careerRows, value, trending] = await Promise.all([
    gameLog({ season, currentSeason: season, currentWeek, gsis, pfrId, sleeperId: id, pos, team, settings, players, seasonSched }),
    gameLog({ season: season - 1, currentSeason: season, currentWeek, gsis, pfrId, sleeperId: id, pos, team, settings, players, seasonSched }).catch(() => null),
    gsis ? adv.compute(season).then((r) => ({ ...adv.rowsFor(gsis, r.all), throughWeek: r.throughWeek })).catch((err) => ({ error: err.message })) : null,
    teamRanks(season, team).catch(() => null),
    depthChart(season, team, players).catch(() => null),
    espnNews(espnId),
    leagueHistory(leagueId, id, currentWeek, players).catch(() => ({ moves: [], drafts: [] })),
    career({ gsis, currentSeason: season, rookieSeason: nvp?.rookie_season || (meta.years_exp != null ? season - Number(meta.years_exp) : null), pos, settings }).catch(() => []),
    league ? valuePanel({ leagueType, superflex, ppr: Number(settings.rec ?? 0), tep: Number(settings.bonus_rec_te ?? 0) > 0, teams: Number(league.total_rosters || 12), sleeperId: id, pos }) : null,
    sleeper.getTrendingAdds(200, 24).catch(() => []),
  ]);

  // Summary: season ranks and points per game in league scoring; last game; projection vs final strip
  const ranks = lastDone > 0 ? seasonRanks(season, lastDone, settings, players) : null;
  const tot = ranks?.totals.get(id) || null;
  const played = logNow.rows.filter((r) => r.played);
  const last = played[played.length - 1] || null;
  let lastGame = null;
  if (last) {
    const sch = await schedule.getWeekSchedule(season, last.week).catch(() => null);
    const g = team ? sch?.byTeam?.[schedule.normalizeTeam(team)] : null;
    lastGame = { week: last.week, opp: last.opp, home: last.home, fpts: last.fpts, stats: last.stats, teamScore: g?.score ?? null, oppScore: g?.opponentScore ?? null, result: g?.score != null && g?.opponentScore != null ? (g.score > g.opponentScore ? "W" : g.score < g.opponentScore ? "L" : "T") : null };
  }
  const profile = store.profileOf(settings).key;
  const projWeeks = [currentWeek - 2, currentWeek - 1, currentWeek, currentWeek + 1].filter((w) => w >= 1 && w <= 18);
  const projRows = store.playerProjHistory({ profile, season, playerId: id, weeks: projWeeks });
  const RANK = { V: 0, T: 1, S: 2, E: 3 };
  const projections = [];
  for (const w of projWeeks) {
    const best = projRows.filter((r) => r.week === w).sort((a, b) => (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9))[0];
    let proj = best ? best.adj_proj ?? best.proj : null;
    if (proj == null && w > currentWeek) {
      const pool = await slp.getWeekProjections(season, w, { ttlMs: DAY }).catch(() => null);
      const e = pool?.byId?.[id];
      proj = e ? slp.scoreStats(e, settings) : null;
    }
    const row = logNow.rows.find((r) => r.week === w);
    projections.push({ week: w, opp: row?.opp ?? null, home: row?.home ?? null, bye: Boolean(row?.bye), proj: r1(proj), final: row?.played ? row.fpts : null });
  }

  // Availability in your other tracked leagues
  const tracked = getUserState(username)?.leagueIds || [];
  const me = await sleeper.getUser(username).catch(() => null);
  const availability = [];
  for (const lid of tracked) {
    try {
      const [lg, rosters, users] = await Promise.all([sleeper.getLeague(lid), sleeper.getRosters(lid), sleeper.getLeagueUsers(lid)]);
      const r = rosters.find((x) => (x.players || []).map(String).includes(id));
      let status = "available";
      let owner = null;
      if (r) {
        const mine = me && (r.owner_id === me.user_id || (r.co_owners || []).includes(me.user_id));
        status = mine ? "yours" : "rostered";
        const u = users.find((x) => x.user_id === r.owner_id);
        owner = mine ? null : r.metadata?.team_name || u?.metadata?.team_name || u?.display_name || null;
      }
      availability.push({ leagueId: lid, league: lg?.name || lid, avatar: lg?.avatar || null, status, owner, current: lid === leagueId });
    } catch {
      /* skip a league that can't be read right now */
    }
  }
  const trend = (trending || []).find((t) => String(t.player_id) === id);

  return {
    id,
    gsis,
    name: fullName(meta, id),
    firstName: meta.first_name || "",
    lastName: meta.last_name || "",
    pos,
    team,
    number: meta.number ?? nvp?.jersey_number ?? null,
    age: meta.birth_date ? ageFrom(meta.birth_date) : nvp?.birth_date ? ageFrom(nvp.birth_date) : meta.age ?? null,
    height: heightLabel(meta.height ?? nvp?.height),
    weight: meta.weight ? Number(meta.weight) : nvp?.weight ?? null,
    exp: meta.years_exp ?? nvp?.years_of_experience ?? null,
    college: meta.college || nvp?.college_name || null,
    draft: nvp?.draft_year ? { year: nvp.draft_year, round: nvp.draft_round, pick: nvp.draft_pick, team: nvp.draft_team } : null,
    injury: meta.injury_status ? { status: meta.injury_status, detail: meta.injury_body_part || null, notes: meta.injury_notes || null } : null,
    bye,
    league: league ? { id: leagueId, name: league.name, type: leagueType, scoring: Number(settings.rec ?? 0) >= 1 ? "PPR" : Number(settings.rec ?? 0) > 0 ? "Half-PPR" : "Standard" } : null,
    summary: {
      posRank: ranks?.posRank.get(id) ?? null,
      overallRank: ranks?.overall.get(id) ?? null,
      fptsPerGame: tot ? r2(tot.pts / tot.games) : null,
      games: tot?.games ?? played.length,
      lastGame,
      projections,
      trendingAdds: trend ? trend.count ?? null : null,
    },
    advanced,
    news,
    gameLog: [logNow, logPrev].filter(Boolean),
    teamTab: { ranks: ranksTeam, depth },
    history: { ...history, career: careerRows },
    value,
    availability,
    asOf: { season, week: currentWeek, statsThroughWeek: advanced?.throughWeek ?? lastDone },
  };
}
