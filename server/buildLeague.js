import * as sleeper from "./sleeper.js";
import * as fp from "./fantasyPros.js";
import * as fpScrape from "./fantasyProsScrape.js";
import * as schedule from "./schedule.js";
import * as espn from "./espnProjections.js";
import { lookupBySleeperId } from "./playerIdMap.js";
import { buildFpIndex, lookupFpMulti } from "./matching.js";
import { checkAndRecordInjury, clearInjurySeen, getInjurySeenForLeague } from "./db.js";

const FLEX_ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"] };
const OUT_LIKE = ["Out", "Doubtful", "IR", "Suspended", "NA"];
const ECR_POSITIONS = ["QB", "RB", "WR", "TE"];

function scoringLabel(settings) {
  const rec = settings?.rec ?? 0;
  if (rec >= 1) return "Full PPR";
  if (rec > 0) return "Half-PPR";
  return "Standard";
}
function fpScoringParam(settings) {
  const rec = settings?.rec ?? 0;
  if (rec >= 1) return "PPR";
  if (rec > 0) return "HALF";
  return "STD";
}
function slotLabel(rawSlot) {
  return rawSlot === "SUPER_FLEX" ? "SFLX" : rawSlot;
}
function playerName(meta, id) {
  return meta ? `${meta.first_name} ${meta.last_name}` : `Player ${id}`;
}
function mapPlayerStatus(meta) {
  return meta?.injury_status || "Healthy";
}

/**
 * Injury Watch now persists: a currently-injured player shows up every
 * refresh (not just the refresh where the status changed), Minor once
 * you've seen that exact status before, Major the first time. State
 * lives in SQLite (db.js), not an in-memory diff, so it survives
 * restarts and doesn't require comparing against "last refresh."
 */
function buildInjuryRows(leagueId, league) {
  const allPlayers = [...league.starters.map((s) => s.player), ...league.bench, ...league.ir, ...league.taxi].filter(Boolean);
  const currentlyInjured = allPlayers.filter((p) => p.status !== "Healthy");
  const currentNames = new Set(currentlyInjured.map((p) => p.name));

  // A player previously tracked as injured who's now healthy again —
  // clear their record so a *future* re-injury with the same status
  // (e.g. "Questionable" again in a different week) is correctly major,
  // not silently treated as already-seen from months ago.
  for (const rec of getInjurySeenForLeague(leagueId)) {
    if (!currentNames.has(rec.player_name)) clearInjurySeen(leagueId, rec.player_name);
  }

  return currentlyInjured.map((p) => {
    const { seenBefore } = checkAndRecordInjury(leagueId, p.name, p.status);
    return {
      id: `${p.name}-${p.status}`,
      player: p.name,
      status: p.status,
      note: p.note,
      seen: seenBefore,
    };
  });
}

/**
 * A greedy (not globally-optimal via ILP, but strong in practice) lineup
 * solver: fill strict positional slots first with the highest-projected
 * eligible player, then fill FLEX/SFLX slots from what's left.
 */
function solveOptimalLineup(startingSlotLabels, pool) {
  const remaining = pool.map((p) => ({ ...p }));
  const results = new Array(startingSlotLabels.length).fill(null);

  const takeBest = (predicate, idx) => {
    const candidates = remaining.filter(predicate).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
    if (candidates.length === 0) return;
    const pick = candidates[0];
    results[idx] = pick;
    remaining.splice(remaining.indexOf(pick), 1);
  };

  startingSlotLabels.forEach((slot, idx) => {
    if (!FLEX_ELIGIBLE[slot]) takeBest((p) => p.pos === slot, idx);
  });
  startingSlotLabels.forEach((slot, idx) => {
    if (FLEX_ELIGIBLE[slot]) takeBest((p) => FLEX_ELIGIBLE[slot].includes(p.pos), idx);
  });

  return results;
}

function rankThreshold(pos, superflex) {
  if (pos === "QB") return superflex ? 36 : 24;
  if (pos === "RB" || pos === "WR") return 48;
  if (pos === "TE") return 24;
  return 0;
}

/**
 * Builds one fully-populated league object — real Sleeper roster data
 * (including taxi squad), real FantasyPros projections and ECR with a
 * real ESPN fallback where FantasyPros has nothing, real trending-add
 * waivers, real kickoff times / bye weeks from ESPN, a side-by-side
 * current-vs-optimal lineup comparison, persistent Injury Watch, and a
 * heuristic Trade Radar based on positional ECR depth.
 */
export async function buildFullLeague(userId, leagueSummary, week, trending, prevLeagues = []) {
  const leagueId = leagueSummary.league_id;
  const season = leagueSummary.season;

  const [league, rosters, leagueUsers, sleeperPlayers, weekSchedule] = await Promise.all([
    sleeper.getLeague(leagueId),
    sleeper.getRosters(leagueId),
    sleeper.getLeagueUsers(leagueId),
    sleeper.getPlayers(),
    schedule.getWeekSchedule(season, week).catch(() => null), // unofficial endpoint — degrade to "kickoff unknown" rather than fail the whole build
  ]);

  const scoring = fpScoringParam(league.scoring_settings);
  const [scrapedProjections, ...ecrByPosition] = await Promise.all([
    fpScrape.getAllProjections(season, week, scoring, ECR_POSITIONS),
    ...ECR_POSITIONS.map((position) => fp.getConsensusRankings(season, { position, scoring, week })),
  ]);

  const projIndex = buildFpIndex(scrapedProjections);
  const fpConsensusPlayers = ecrByPosition.flatMap((r, i) =>
    (r.players || r.data || []).map((p) => ({ ...p, position_id: p.position_id || p.player_position_id || ECR_POSITIONS[i] }))
  );
  const ecrIndex = buildFpIndex(fpConsensusPlayers);

  const myRoster = rosters.find((r) => r.owner_id === userId);
  if (!myRoster) throw new Error(`Couldn't find your roster in ${league.name}.`);

  const myLeagueUser = leagueUsers.find((u) => u.user_id === userId);
  const teamName = myRoster.metadata?.team_name || myLeagueUser?.metadata?.team_name || myLeagueUser?.display_name || "Your Team";

  const startingSlots = (league.roster_positions || []).filter((p) => p !== "BN" && p !== "IR" && p !== "TAXI");
  const starterIds = myRoster.starters || [];
  const irIds = myRoster.reserve || [];
  const taxiIds = myRoster.taxi || [];
  const starterIdSet = new Set(starterIds);
  const irIdSet = new Set(irIds);
  const taxiIdSet = new Set(taxiIds);
  const benchIds = (myRoster.players || []).filter((id) => !starterIdSet.has(id) && !irIdSet.has(id) && !taxiIdSet.has(id));

  const kickoffFor = (teamAbbr) => {
    if (!weekSchedule || !teamAbbr) return { kickoff: null, kickoffLabel: "Kickoff time unavailable", onBye: false };
    const normalized = schedule.normalizeTeam(teamAbbr);
    const game = weekSchedule.byTeam[normalized];
    if (game) return { kickoff: game.kickoffMillis, kickoffLabel: game.kickoffLabel, onBye: false };
    const onBye = schedule.ALL_NFL_TEAMS.includes(normalized);
    return { kickoff: null, kickoffLabel: onBye ? "On bye" : "Kickoff time unavailable", onBye };
  };

  /** proj + which source it came from (FP/E/null), trying FantasyPros first and ESPN only as a gap-fill. */
  async function resolveProjection(sleeperId, name, pos, crosswalkName) {
    const fpRec = lookupFpMulti(projIndex, crosswalkName ? [name, crosswalkName] : [name], pos);
    if (fpRec?.fpts != null) return { proj: Number(fpRec.fpts), projSource: "FP" };
    const espnPts = await espn.getEspnProjectionBySleeperId(sleeperId, name, season, week);
    if (espnPts != null) return { proj: espnPts, projSource: "E" };
    return { proj: null, projSource: null };
  }

  const enrich = async (id) => {
    if (!id || id === "0") return null;
    const meta = sleeperPlayers[id];
    const name = playerName(meta, id);
    const pos = meta?.position || "?";
    const crosswalk = await lookupBySleeperId(id).catch(() => null);
    const ecrRec = lookupFpMulti(ecrIndex, crosswalk?.name ? [name, crosswalk.name] : [name], pos);
    const { kickoff, kickoffLabel, onBye } = kickoffFor(meta?.team);
    const { proj, projSource } = await resolveProjection(id, name, pos, crosswalk?.name);
    return {
      name,
      pos,
      team: meta?.team || "FA",
      status: onBye && (!meta?.injury_status || meta.injury_status === "Healthy") ? "Bye" : mapPlayerStatus(meta),
      kickoff,
      kickoffLabel,
      proj,
      projSource,
      ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null,
      irEligible: meta?.injury_status === "IR" || meta?.injury_status === "PUP",
      note: meta?.injury_status && meta?.injury_body_part ? `${meta.injury_status} — ${meta.injury_body_part}` : undefined,
    };
  };

  const [starterPlayers, bench, ir, taxi] = await Promise.all([
    Promise.all(starterIds.map(enrich)),
    Promise.all(benchIds.map(enrich)),
    Promise.all(irIds.map(enrich)),
    Promise.all(taxiIds.map(enrich)),
  ]);
  const starters = startingSlots.map((slot, i) => ({ slot: slotLabel(slot), player: starterPlayers[i] || null }));

  // Every player rostered by ANY team in the league — not just yours —
  // so a trending player already owned elsewhere never shows as available.
  const allRosteredIds = new Set(rosters.flatMap((r) => r.players || []));

  const rosterPool = [
    ...starters.filter((s) => s.player).map((s) => ({ ...s.player, origin: "roster" })),
    ...bench.filter(Boolean).map((p) => ({ ...p, origin: "roster" })),
  ];

  const trendingCandidates = (trending || []).filter((t) => !allRosteredIds.has(t.player_id));
  const trendingFreeAgents = await Promise.all(
    trendingCandidates.map(async (t) => {
      const meta = sleeperPlayers[t.player_id];
      const name = playerName(meta, t.player_id);
      const pos = meta?.position || "?";
      const crosswalk = await lookupBySleeperId(t.player_id).catch(() => null);
      const ecrRec = lookupFpMulti(ecrIndex, crosswalk?.name ? [name, crosswalk.name] : [name], pos);
      const { proj, projSource } = await resolveProjection(t.player_id, name, pos, crosswalk?.name);
      return { name, pos, proj, projSource, ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null, trending: true, origin: "waiver" };
    })
  );

  const optimalPicks = solveOptimalLineup(startingSlots.map(slotLabel), [...rosterPool, ...trendingFreeAgents]);

  // --- Lineup Advice: side-by-side current vs. optimal, per slot ---
  const lineupComparison = startingSlots.map(slotLabel).map((slot, idx) => {
    const current = starters[idx]?.player || null;
    const optimal = optimalPicks[idx] || null;
    const changed = (current?.name ?? null) !== (optimal?.name ?? null);
    return {
      slot,
      current: current ? { name: current.name, proj: current.proj, projSource: current.projSource } : null,
      optimal: optimal
        ? {
            name: optimal.name,
            proj: optimal.proj ?? null,
            projSource: optimal.projSource,
            note: optimal.origin === "waiver" ? "Available on waivers — not currently on your roster" : undefined,
          }
        : null,
      changed,
      delta: changed ? (optimal?.proj ?? 0) - (current?.proj ?? 0) : 0,
    };
  });
  // Kept for anything still reading the older flat shape.
  const optimalLineup = lineupComparison.map((c) => ({ slot: c.slot, name: c.optimal?.name ?? null, proj: c.optimal?.proj ?? null, note: c.optimal?.note }));

  const superflex = (league.roster_positions || []).includes("SUPER_FLEX");
  const freeAgents = trendingFreeAgents.slice(0, 20).map((fa) => ({
    name: fa.name,
    pos: fa.pos,
    proj: fa.proj,
    projSource: fa.projSource,
    ecr: fa.ecr,
    trending: true,
  }));

  // --- Trade Radar (heuristic) — unchanged from prior rounds ---
  const tradeSuggestions = [];
  try {
    const posGroups = ["QB", "RB", "WR", "TE"];
    const ecrOf = (id) => {
      const meta = sleeperPlayers[id];
      if (!meta) return null;
      const rec = lookupFpMulti(ecrIndex, [playerName(meta, id)], meta.position);
      return rec ? Number(rec.rank_ecr ?? rec.rank ?? null) : null;
    };
    const avgEcrByPos = (roster) => {
      const byPos = {};
      (roster.players || []).forEach((id) => {
        const meta = sleeperPlayers[id];
        if (!meta || !posGroups.includes(meta.position)) return;
        const ecr = ecrOf(id);
        if (ecr == null) return;
        byPos[meta.position] = byPos[meta.position] || [];
        byPos[meta.position].push(ecr);
      });
      const avg = {};
      for (const pos of posGroups) {
        const list = byPos[pos] || [];
        avg[pos] = { count: list.length, avgEcr: list.length ? list.reduce((a, b) => a + b, 0) / list.length : null };
      }
      return avg;
    };

    const myAvg = avgEcrByPos(myRoster);
    const myWeak = posGroups.filter((p) => myAvg[p].avgEcr != null).sort((a, b) => myAvg[b].avgEcr - myAvg[a].avgEcr)[0];
    const mySurplus = posGroups.filter((p) => myAvg[p].avgEcr != null && myAvg[p].count >= 3).sort((a, b) => myAvg[a].avgEcr - myAvg[b].avgEcr)[0];

    if (myWeak && mySurplus && myWeak !== mySurplus) {
      for (const other of rosters) {
        if (other.roster_id === myRoster.roster_id) continue;
        const theirAvg = avgEcrByPos(other);
        const theirSurplusHere = theirAvg[myWeak];
        if (theirSurplusHere?.count >= 3 && theirSurplusHere.avgEcr < myAvg[myWeak].avgEcr - 10) {
          const gap = myAvg[myWeak].avgEcr - theirSurplusHere.avgEcr;
          tradeSuggestions.push({
            severity: gap > 25 ? "major" : "minor",
            note: `Your ${myWeak} depth is thin (avg ECR ~${Math.round(myAvg[myWeak].avgEcr)}) — roster_id ${other.roster_id} carries real surplus there (avg ECR ~${Math.round(theirSurplusHere.avgEcr)}) and may value your ${mySurplus} depth in return.`,
            give: `A ${mySurplus} from your bench`,
            get: `A ${myWeak} from their depth`,
            theirTeam: `Roster #${other.roster_id}`,
          });
        }
      }
    }
  } catch {
    // Trade Radar is a bonus heuristic — fail soft, not a build failure.
  }

  const built = {
    id: leagueId,
    name: league.name,
    teamName,
    week,
    scoring: scoringLabel(league.scoring_settings),
    superflex,
    lockLabel: weekSchedule ? `Week ${week} — live kickoff times from ESPN` : "Live from Sleeper",
    dataSource: "live",
    starters,
    bench: bench.filter(Boolean),
    ir: ir.filter(Boolean),
    taxi: taxi.filter(Boolean),
    lineupComparison,
    optimalLineup,
    freeAgents,
    tradeSuggestions,
  };

  const unmatchedStarters = starters.filter((s) => s.player && s.player.proj == null).map((s) => s.player.name);
  const unmatchedOptimal = optimalLineup.filter((p) => p.name && p.proj == null).map((p) => p.name);
  const unmatched = [...new Set([...unmatchedStarters, ...unmatchedOptimal])];
  const dataWarnings = [];
  if (unmatched.length) {
    dataWarnings.push(`No projection from FantasyPros or ESPN for: ${unmatched.join(", ")}`);
  }

  const injuryEvents = buildInjuryRows(leagueId, built);

  return { ...built, injuryEvents, dataWarnings };
}

export { rankThreshold, OUT_LIKE, FLEX_ELIGIBLE };
