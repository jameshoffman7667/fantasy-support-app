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

function erf(x) {
  // Abramowitz-Stegun 7.1.26
  const sgn = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sgn * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * v3.5 — one matchup's outlook from live points and expected finals.
 *  remaining = points still expected for BOTH teams (expected final minus points so far)
 *  threshold = 5% of remaining; colour: green when your expected final leads by at least the threshold, red when
 *              it trails by at least that much, yellow in between (at the end, remaining is 0: green = won).
 *  win %     = normal approximation: margin / (2.3 × √remaining) — about a 25-point spread for one team's full
 *              week. A rough estimate, not a model of each player's distribution.
 */
export const WIN_SD_PER_ROOT_POINT = 2.3;
export function matchupOutlook({ myPoints = 0, oppPoints = 0, myProjected = 0, oppProjected = 0 }) {
  const myRem = Math.max(0, myProjected - myPoints);
  const oppRem = Math.max(0, oppProjected - oppPoints);
  const remaining = myRem + oppRem;
  const diff = myProjected - oppProjected;
  const threshold = 0.05 * remaining;
  const color = diff > 0 && diff >= threshold ? "green" : diff < 0 && -diff >= threshold ? "red" : "yellow";
  const winProb = remaining <= 0.01 ? (diff > 0 ? 1 : diff < 0 ? 0 : 0.5) : normCdf(diff / Math.max(0.5, WIN_SD_PER_ROOT_POINT * Math.sqrt(remaining)));
  return { myRemaining: r2(myRem), oppRemaining: r2(oppRem), threshold: r2(threshold), color, winProb: Math.round(winProb * 1000) / 1000 };
}

/**
 * v3.5 — each matchup's projected totals at the week's first kickoff (the baseline that projections are compared
 * with: a projection below it shows red). Updated on every Game Day load before that kickoff, then frozen; the
 * scheduler also takes one about an hour before the first kickoff so it exists even if Game Day wasn't opened.
 */
const baselineKey = (u, season, week) => `gameday_baseline:${u}:${season}:${week}`;
export function getBaselines(username, season, week) {
  return store.getState(baselineKey(username, season, week), {}) || {};
}
function updateBaselines(username, season, week, leagues, firstKickoff, now = Date.now()) {
  const cur = getBaselines(username, season, week);
  let changed = false;
  for (const l of leagues) {
    if (l.myProjected == null || l.oppProjected == null) continue;
    const before = firstKickoff == null || now < firstKickoff;
    if (before || !cur[l.id]) {
      cur[l.id] = { my: l.myProjected, opp: l.oppProjected, at: now, late: !before };
      changed = true;
    }
  }
  if (changed) store.setState(baselineKey(username, season, week), cur);
  return cur;
}

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
      const avatarOf = (roster) => users.find((x) => x.user_id === roster?.owner_id)?.avatar || null;
      const myM = mine ? (matchups || []).find((m) => m.roster_id === mine.roster_id) : null;
      const oppM = myM && myM.matchup_id != null ? matchups.find((m) => m.matchup_id === myM.matchup_id && m.roster_id !== myM.roster_id) : null;
      const summary = {
        id: leagueId,
        name: league.name,
        importance: ls.importance,
        include: ls.include,
        myTeam: teamName(mine),
        oppTeam: oppM ? teamName(rosters.find((r) => r.roster_id === oppM.roster_id)) : null,
        avatar: league.avatar || null, // v3.5: league picture
        oppAvatar: oppM ? avatarOf(rosters.find((r) => r.roster_id === oppM.roster_id)) : null,
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
        ...matchupOutlook({ myPoints: me.points, oppPoints: opp.points, myProjected: me.final, oppProjected: opp.final }),
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
            // v3.5: the game this player is in ("AWAY@HOME"), for grouping by game then team
            gameKey: g?.opponent && team ? (g.homeAway === "home" ? `${schedule.normalizeTeam(g.opponent)}@${schedule.normalizeTeam(team)}` : `${schedule.normalizeTeam(team)}@${schedule.normalizeTeam(g.opponent)}`) : null,
            home: g ? g.homeAway === "home" : null,
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

  // v3.5: baselines (projected totals at the week's first kickoff) and each league's projection vs that baseline.
  const kickoffs = Object.values(sched0?.byTeam || {}).map((g) => g.kickoffMillis).filter((k) => Number.isFinite(k));
  const firstKickoff = kickoffs.length ? Math.min(...kickoffs) : null;
  const baselines = updateBaselines(username, season, week, leagues, firstKickoff);
  for (const l of leagues) {
    const b = baselines[l.id];
    if (!b) continue;
    l.baseline = { my: b.my, opp: b.opp, late: Boolean(b.late), at: b.at };
    l.myBelowBaseline = l.myProjected != null && l.myProjected < b.my - 0.05;
    l.oppBelowBaseline = l.oppProjected != null && l.oppProjected < b.opp - 0.05;
  }

  const list = [...byPlayer.values()].map((p) => {
    const stake = p.F + p.A;
    return { ...p, F: r2(p.F), A: r2(p.A), stake: r2(stake), lean: stake > 0 ? r2(p.F / stake) : 0.5, category: categorize(p.F, p.A, settings.ratio) };
  });
  list.sort((a, b) => b.stake - a.stake || b.lean - a.lean);
  return { season, week, settings, leagues, players: list, firstKickoff, updatedAt: Date.now() };
}

/** v3.5: scheduler hook — refresh every active user's baselines shortly before the week's first kickoff. */
export async function snapshotBaselines(usernames) {
  for (const u of usernames) {
    try {
      await getGameDay(u);
    } catch (err) {
      console.warn(`[gameday] baseline snapshot failed for ${u}: ${err.message}`);
    }
  }
}
