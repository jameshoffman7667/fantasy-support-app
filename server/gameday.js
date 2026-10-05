import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as hub from "./projectionHub.js";
import * as store from "./projectionStore.js";
import { getUserState } from "./db.js";

/**
 * v2.6 Game Day: across all of a user's tracked leagues this week, who to
 * cheer for and who to cheer against.
 *
 * For each included league, the user's starters count FOR them and their
 * current matchup opponent's starters count AGAINST them, each weighted by
 * the league's importance (dues, or any relative number). Per NFL player:
 *   F = Σ weight where he's your starter, A = Σ weight where he's your opponent's
 *   lean = F / (F + A)   (1 = all for, 0.5 = balanced, 0 = all against)
 * Category bands use a ratio (default 2:1): "for" if F ≥ ratio·A, "against"
 * if A ≥ ratio·F, otherwise "balanced". Bench players don't score, so they
 * don't count.
 *
 * Optional close-matchup weighting scales each league's importance by how
 * close that matchup is (live points + remaining projections): within
 * closeMargin% it counts fully; beyond, factor = max(closeFloor, closeMargin / margin%).
 *
 * Data: Sleeper rosters + matchups (live points), ESPN scoreboard (game
 * status), the projection hub (projections) — no Tank01 calls.
 */
export const DEFAULT_SETTINGS = { ratio: 2, closeWeighting: false, closeMargin: 20, closeFloor: 0.25, leagues: {} };

export function getSettings(username) {
  const saved = store.getState(`gameday_settings:${username}`, {}) || {};
  return { ...DEFAULT_SETTINGS, ...saved, leagues: { ...(saved.leagues || {}) } };
}
export function saveSettings(username, input) {
  const cur = getSettings(username);
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const next = {
    ratio: num(input.ratio ?? cur.ratio, 2, 1, 20),
    closeWeighting: Boolean(input.closeWeighting ?? cur.closeWeighting),
    closeMargin: num(input.closeMargin ?? cur.closeMargin, 20, 1, 200),
    closeFloor: num(input.closeFloor ?? cur.closeFloor, 0.25, 0, 1),
    leagues: { ...cur.leagues },
  };
  for (const [id, l] of Object.entries(input.leagues || {})) {
    next.leagues[id] = { importance: num(l.importance ?? 1, 1, 0, 1e9), include: l.include !== false };
  }
  store.setState(`gameday_settings:${username}`, next);
  return next;
}

export function closenessFactor(myFinal, oppFinal, settings) {
  const avg = Math.max(1, (myFinal + oppFinal) / 2);
  const marginPct = (Math.abs(myFinal - oppFinal) / avg) * 100;
  if (marginPct <= settings.closeMargin) return { factor: 1, marginPct };
  return { factor: Math.max(settings.closeFloor, settings.closeMargin / marginPct), marginPct };
}

export function categorize(F, A, ratio) {
  if (F > 0 && A === 0) return "for";
  if (A > 0 && F === 0) return "against";
  if (F >= ratio * A) return "for";
  if (A >= ratio * F) return "against";
  return "balanced";
}

const name = (p, id) => (p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : `Player ${id}`);
const r2 = (x) => Math.round(x * 100) / 100;

export async function getGameDay(username, { week: weekParam } = {}) {
  const state = getUserState(username);
  const leagueIds = state?.leagueIds || [];
  const settings = getSettings(username);
  const nfl = await sleeper.getState();
  const season = nfl.season;
  const week = Number(weekParam) || Number(nfl.week);
  const user = await sleeper.getUser(username);
  if (!user) throw new Error(`No Sleeper user named "${username}".`);
  // R5: the live scoreboard (and the 45-second shared Sleeper matchup look) only runs while a game is actually on.
  const sched0 = await schedule.getWeekSchedule(season, week, { live: false }).catch(() => null);
  const nowMs = Date.now();
  const liveNow = Object.values(sched0?.byTeam || {}).some((g) => g.kickoffMillis != null && g.kickoffMillis <= nowMs && nowMs <= g.kickoffMillis + 5 * 3600 * 1000);
  const [players, sched] = await Promise.all([sleeper.getPlayers(), liveNow ? schedule.getWeekSchedule(season, week, { live: true }).catch(() => sched0) : sched0]);
  const gameFor = (team) => (team && sched ? sched.byTeam?.[schedule.normalizeTeam(team)] || null : null);

  const leagues = [];
  const byPlayer = new Map();

  for (const leagueId of leagueIds) {
    try {
      const [league, rosters, users, matchups] = await Promise.all([
        sleeper.getLeague(leagueId),
        sleeper.getRosters(leagueId),
        sleeper.getLeagueUsers(leagueId),
        (liveNow ? sleeper.getMatchupsLive(leagueId, week) : sleeper.getMatchups(leagueId, week)).catch(() => []),
      ]);
      const ls = settings.leagues[leagueId] || { importance: 1, include: true };
      const mine = rosters.find((r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
      const teamName = (roster) => {
        if (!roster) return null;
        const u = users.find((x) => x.user_id === roster.owner_id);
        return roster.metadata?.team_name || u?.metadata?.team_name || u?.display_name || `Roster ${roster.roster_id}`;
      };
      const myM = mine ? (matchups || []).find((m) => m.roster_id === mine.roster_id) : null;
      const oppM = myM && myM.matchup_id != null ? matchups.find((m) => m.matchup_id === myM.matchup_id && m.roster_id !== myM.roster_id) : null;
      const summary = {
        id: leagueId,
        name: league.name,
        importance: ls.importance,
        include: ls.include,
        myTeam: teamName(mine),
        oppTeam: oppM ? teamName(rosters.find((r) => r.roster_id === oppM.roster_id)) : null,
        note: !mine ? "Your roster wasn't found" : !myM ? "No matchup this week" : !oppM ? "No opponent this week (bye/median)" : null,
      };
      leagues.push(summary);
      if (!myM || !oppM) continue;

      const proj = await hub.getWeek({ season, week, settings: league.scoring_settings, sleeperPlayers: players }).catch(() => null);
      // Expected final score for one side: finished games count their actual
      // points, games in progress the larger of points so far and the
      // projection (a rough live estimate), games not started the projection.
      const sideInfo = (m) => {
        const starters = (m.starters || []).filter((id) => id && id !== "0");
        let final = 0;
        const list = starters.map((id) => {
          const p = players[id];
          const g = gameFor(p?.team || (p?.position === "DEF" ? id : null));
          const pts = m.players_points?.[id] != null ? Number(m.players_points[id]) : null;
          const projPts = proj ? hub.pick(proj, id).proj : null;
          if (g?.state === "post") final += pts ?? 0;
          else if (g?.state === "in") final += Math.max(pts ?? 0, projPts ?? 0);
          else final += projPts ?? 0;
          return { id, pts, proj: projPts };
        });
        return { list, final, points: Number(m.points ?? 0) };
      };
      const me = sideInfo(myM);
      const opp = sideInfo(oppM);
      const close = closenessFactor(me.final, opp.final, settings);
      Object.assign(summary, {
        myPoints: r2(me.points),
        oppPoints: r2(opp.points),
        myProjected: r2(me.final),
        oppProjected: r2(opp.final),
        marginPct: r2(close.marginPct),
        closeFactor: r2(close.factor),
      });
      if (!ls.include || !(ls.importance > 0)) continue;
      const weight = ls.importance * (settings.closeWeighting ? close.factor : 1);

      const add = (entry, side) => {
        const p = players[entry.id];
        if (!byPlayer.has(entry.id)) {
          const team = p?.team || (p?.position === "DEF" ? entry.id : null);
          const g = gameFor(team);
          byPlayer.set(entry.id, {
            id: entry.id,
            name: p?.position === "DEF" ? `${p?.first_name || entry.id} ${p?.last_name || "D/ST"}`.trim() : name(p, entry.id),
            pos: p?.position || null,
            team,
            kickoff: g?.kickoffMillis ?? null,
            kickoffLabel: g?.kickoffLabel ?? null,
            state: g?.state ?? null,
            statusDetail: g?.statusDetail ?? null,
            opponent: g?.opponent ?? null,
            points: entry.pts,
            proj: entry.proj,
            F: 0,
            A: 0,
            leagues: [],
          });
        }
        const rec = byPlayer.get(entry.id);
        if (entry.pts != null) rec.points = entry.pts;
        if (rec.proj == null && entry.proj != null) rec.proj = entry.proj;
        if (side === "for") rec.F += weight;
        else rec.A += weight;
        rec.leagues.push({ leagueId, league: league.name, side, weight: r2(weight), importance: ls.importance });
      };
      me.list.forEach((e) => add(e, "for"));
      opp.list.forEach((e) => add(e, "against"));
    } catch (err) {
      leagues.push({ id: leagueId, name: leagueId, note: `Couldn't load: ${err.message}` });
    }
  }

  const list = [...byPlayer.values()].map((p) => {
    const stake = p.F + p.A;
    return { ...p, F: r2(p.F), A: r2(p.A), stake: r2(stake), lean: stake > 0 ? r2(p.F / stake) : 0.5, category: categorize(p.F, p.A, settings.ratio) };
  });
  list.sort((a, b) => b.stake - a.stake || b.lean - a.lean);
  return { season, week, settings, leagues, players: list, updatedAt: Date.now() };
}
