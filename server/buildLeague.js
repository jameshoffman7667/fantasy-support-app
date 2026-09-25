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
// K and DST were missing entirely before this round — meaning every
// kicker and every team defense in a tracked league (a near-universal
// pair of starting slots in standard leagues) NEVER got a projection,
// regardless of name-matching quality, because their positions simply
// weren't in this list. Confirmed live that fantasypros.com/nfl/projections/k.php
// and .../dst.php are both real pages before adding them.
const FP_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
// Sleeper's position code for a team defense is "DEF" (confirmed via
// community API docs); FantasyPros' is "DST". Every FP lookup for a
// defense has to translate first, or it silently misses regardless of
// name-matching quality.
function toFpPosition(sleeperPos) {
  return sleeperPos === "DEF" ? "DST" : sleeperPos;
}
let _loggedNoLivePoints = false;

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
 *
 * `lockedByIndex` is parallel to startingSlotLabels — a non-null entry
 * means that slot's real-world outcome is already decided (the starter
 * has actually played) and must not be re-suggested away; that player is
 * also removed from the candidate pool so they can't double-appear in a
 * different slot's recommendation.
 */
function solveOptimalLineup(startingSlotLabels, pool, lockedByIndex = []) {
  const lockedNames = new Set(lockedByIndex.filter(Boolean).map((p) => p.name));
  const remaining = pool.filter((p) => !lockedNames.has(p.name)).map((p) => ({ ...p }));
  const results = new Array(startingSlotLabels.length).fill(null);

  startingSlotLabels.forEach((slot, idx) => {
    if (lockedByIndex[idx]) results[idx] = lockedByIndex[idx];
  });

  const takeBest = (predicate, idx) => {
    if (results[idx]) return; // already locked to the actual outcome
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

  const [league, rosters, leagueUsers, sleeperPlayers, weekSchedule, matchups] = await Promise.all([
    sleeper.getLeague(leagueId),
    sleeper.getRosters(leagueId),
    sleeper.getLeagueUsers(leagueId),
    sleeper.getPlayers(),
    schedule.getWeekSchedule(season, week).catch(() => null), // unofficial endpoint — degrade to "kickoff unknown" rather than fail the whole build
    sleeper.getMatchups(leagueId, week).catch(() => null), // used for "lock in actual score once played" — degrade to projections-only if unavailable
  ]);

  const scoring = fpScoringParam(league.scoring_settings);
  // Three-tier projection pipeline, in priority order:
  //  1. FantasyPros API (/projections) — capped at ~10 players/position on
  //     the free tier, but its response carries a real `fpid` per player
  //     (confirmed shape), which is a genuine ID join against the
  //     crosswalk's fantasyprosId column. One call covers every position
  //     at once (unlike consensus-rankings, which needs one call per
  //     position), so this is cheap.
  //  2. FantasyPros scraped pages — fills whatever the API's cap left out.
  //     Confirmed (by direct inspection, not by this code) that scraped
  //     rows carry no usable ID — name-fuzzy-matching only, deliberately,
  //     rather than repeating the earlier speculative ID-extraction
  //     attempt that turned out not to apply here.
  //  3. ESPN — real ID join via the crosswalk's espnId column, tried only
  //     for whatever's left after both FantasyPros tiers miss.
  const [apiProjections, scrapedProjections, ...ecrByPosition] = await Promise.all([
    fp.getProjections(season, week, { scoring }).catch((err) => {
      console.warn(`[buildLeague] FantasyPros API projections failed, continuing with scrape+ESPN only: ${err.message}`);
      return null;
    }),
    fpScrape.getAllProjections(season, week, scoring, FP_POSITIONS),
    ...FP_POSITIONS.map((position) => fp.getConsensusRankings(season, { position, scoring, week })),
  ]);

  function extractApiPoints(rec) {
    const pts = rec?.stats?.points ?? rec?.stats?.points_ppr ?? rec?.points;
    return pts != null ? Number(pts) : null;
  }
  const apiProjByFpid = new Map(
    (apiProjections?.players || apiProjections?.data || [])
      .filter((p) => p.fpid != null)
      .map((p) => [String(p.fpid), p])
  );

  const projIndex = buildFpIndex(scrapedProjections);
  const fpConsensusPlayers = ecrByPosition.flatMap((r, i) =>
    (r.players || r.data || []).map((p) => ({ ...p, position_id: p.position_id || p.player_position_id || FP_POSITIONS[i] }))
  );
  const ecrIndex = buildFpIndex(fpConsensusPlayers);

  // Team defenses are unreliable to name-match (Sleeper vs FantasyPros
  // might format "49ers" / "San Francisco 49ers" / "SF" differently) —
  // team abbreviation is a far more robust join for this one position,
  // used as a fallback when the name lookup misses. Scraped projection
  // rows carry `team`; the consensus-rankings API's confirmed shape
  // carries `player_team_id` instead — different field, so two builders.
  function buildDstTeamIndex(records, teamField) {
    const idx = new Map();
    for (const r of records) {
      if ((r.position_id || "").toUpperCase() !== "DST") continue;
      const team = (r[teamField] || "").toUpperCase();
      if (team) idx.set(team, r);
    }
    return idx;
  }
  const projTeamIndex = buildDstTeamIndex(scrapedProjections, "team");
  const ecrTeamIndex = buildDstTeamIndex(fpConsensusPlayers, "player_team_id");

  const myRoster = rosters.find((r) => r.owner_id === userId);
  if (!myRoster) throw new Error(`Couldn't find your roster in ${league.name}.`);

  // "Lock in the actual score once a player has played." Sleeper's
  // *documented* matchups response only shows a team total (`points`),
  // but the real payload is widely reported elsewhere to also carry
  // `players_points` (player_id -> points) once a game's stats start
  // flowing. Checked for defensively — logged once if genuinely absent
  // so this is diagnosable rather than silently just never activating.
  const myMatchup = matchups?.find((m) => m.roster_id === myRoster.roster_id);
  const livePointsById = myMatchup?.players_points || null;
  if (matchups && !livePointsById && !_loggedNoLivePoints) {
    console.log("[buildLeague] Matchup object has no players_points field — actual-score locking is disabled until this is confirmed. Sample matchup keys:", myMatchup ? Object.keys(myMatchup) : "no matchup found");
    _loggedNoLivePoints = true;
  }

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

  /** proj + which source it came from (FP/E/null) — tier 1: FantasyPros API via real ID; tier 2: FantasyPros scrape via name; tier 3: ESPN via real ID. */
  async function resolveProjection(sleeperId, name, fpPos, crosswalkName, teamAbbr, crosswalkFpid) {
    if (crosswalkFpid) {
      const apiRec = apiProjByFpid.get(String(crosswalkFpid));
      const apiPts = extractApiPoints(apiRec);
      if (apiPts != null) return { proj: apiPts, projSource: "FP" };
    }
    let fpRec = lookupFpMulti(projIndex, crosswalkName ? [name, crosswalkName] : [name], fpPos);
    if (!fpRec && fpPos === "DST" && teamAbbr) {
      fpRec = projTeamIndex.get(schedule.normalizeTeam(teamAbbr)) || null;
    }
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
    const fpPos = toFpPosition(pos);
    const crosswalk = await lookupBySleeperId(id).catch(() => null);
    let ecrRec = lookupFpMulti(ecrIndex, crosswalk?.name ? [name, crosswalk.name] : [name], fpPos);
    if (!ecrRec && fpPos === "DST" && meta?.team) {
      ecrRec = ecrTeamIndex.get(schedule.normalizeTeam(meta.team)) || null;
    }
    const { kickoff, kickoffLabel, onBye } = kickoffFor(meta?.team);
    let { proj, projSource } = await resolveProjection(id, name, fpPos, crosswalk?.name, meta?.team, crosswalk?.fantasyprosId);

    // "Once players have played, update their projection to their actual
    // score." Two signals required together, not either alone: a
    // numeric entry in players_points (Sleeper has scored them) AND a
    // kickoff time already in the past (guards against a pre-game 0
    // being misread as a final score, since it's genuinely ambiguous
    // whether an absent/zero entry means "hasn't started" or "scored
    // zero so far").
    const played = livePointsById && kickoff != null && kickoff < Date.now() && livePointsById[id] != null;
    if (played) {
      proj = Number(livePointsById[id]);
      projSource = "actual";
    }

    return {
      name,
      pos,
      team: meta?.team || "FA",
      status: onBye && (!meta?.injury_status || meta.injury_status === "Healthy") ? "Bye" : mapPlayerStatus(meta),
      kickoff,
      kickoffLabel,
      proj,
      projSource,
      played: Boolean(played),
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
      const fpPos = toFpPosition(pos);
      const crosswalk = await lookupBySleeperId(t.player_id).catch(() => null);
      let ecrRec = lookupFpMulti(ecrIndex, crosswalk?.name ? [name, crosswalk.name] : [name], fpPos);
      if (!ecrRec && fpPos === "DST" && meta?.team) {
        ecrRec = ecrTeamIndex.get(schedule.normalizeTeam(meta.team)) || null;
      }
      const { proj, projSource } = await resolveProjection(t.player_id, name, fpPos, crosswalk?.name, meta?.team, crosswalk?.fantasyprosId);
      return { name, pos, proj, projSource, ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null, trending: true, origin: "waiver" };
    })
  );

  const lockedByIndex = starters.map((s) => (s.player?.played ? s.player : null));
  const optimalPicks = solveOptimalLineup(startingSlots.map(slotLabel), [...rosterPool, ...trendingFreeAgents], lockedByIndex);

  // --- Lineup Advice: side-by-side current vs. optimal, per slot ---
  // solveOptimalLineup's greedy fill order finds the best-scoring SET of
  // players, but naively pairing that set slot-by-slot with the current
  // lineup often reassigns two interchangeable players (e.g. two WRs
  // with equal projections) to each other's slots for no scoring reason
  // — which reads as a meaningless "recommended swap." Fixed below: a
  // player already in both the current AND optimal sets keeps their
  // current slot in the display, no matter which slot the solver
  // internally assigned them. Only the real symmetric difference (who's
  // actually entering or leaving the lineup) gets flagged as changed —
  // the total score is identical either way, since it's the same set of
  // players regardless of which eligible slot each display shows them in.
  const slotLabels = startingSlots.map(slotLabel);
  const optimalNames = new Set(optimalPicks.filter(Boolean).map((p) => p.name));
  const currentNames = new Set(starters.filter((s) => s.player).map((s) => s.player.name));
  const toAddPool = optimalPicks
    .filter((p) => p && !currentNames.has(p.name))
    .sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));

  const displaySlots = starters.map((s) => s.player); // default: everyone keeps their current slot
  const vacantIdx = [];
  displaySlots.forEach((p, idx) => {
    if (!p || !optimalNames.has(p.name)) vacantIdx.push(idx); // empty, or this starter isn't part of the optimal set
  });
  // Fill strict-position vacancies before flex ones, same ordering
  // solveOptimalLineup itself uses — a flex-only-eligible leftover
  // shouldn't get first pick over an exact-position match.
  const vacantOrdered = [...vacantIdx.filter((i) => !FLEX_ELIGIBLE[slotLabels[i]]), ...vacantIdx.filter((i) => FLEX_ELIGIBLE[slotLabels[i]])];
  for (const idx of vacantOrdered) {
    const slot = slotLabels[idx];
    const eligible = FLEX_ELIGIBLE[slot] ? (p) => FLEX_ELIGIBLE[slot].includes(p.pos) : (p) => p.pos === slot;
    const pickIdx = toAddPool.findIndex(eligible);
    if (pickIdx >= 0) {
      displaySlots[idx] = toAddPool[pickIdx];
      toAddPool.splice(pickIdx, 1);
    } else {
      displaySlots[idx] = null;
    }
  }

  const lineupComparison = slotLabels.map((slot, idx) => {
    const current = starters[idx]?.player || null;
    const optimal = displaySlots[idx] || null;
    const locked = Boolean(lockedByIndex[idx]);
    const changed = !locked && (current?.name ?? null) !== (optimal?.name ?? null);
    return {
      slot,
      current: current ? { name: current.name, proj: current.proj, projSource: current.projSource } : null,
      optimal: optimal
        ? {
            name: optimal.name,
            proj: optimal.proj ?? null,
            projSource: optimal.projSource,
            note: locked ? "Already played — locked to the actual result" : optimal.origin === "waiver" ? "Available on waivers — not currently on your roster" : undefined,
          }
        : null,
      changed,
      locked,
      delta: changed ? (optimal?.proj ?? 0) - (current?.proj ?? 0) : 0,
    };
  });
  // Kept for anything still reading the older flat shape.
  const optimalLineup = lineupComparison.map((c) => ({ slot: c.slot, name: c.optimal?.name ?? null, proj: c.optimal?.proj ?? null, note: c.optimal?.note }));

  const superflex = (league.roster_positions || []).includes("SUPER_FLEX");
  // Leagues without a K or DEF/DST starting slot have no use for those
  // waiver candidates — showing them anyway was just noise.
  const rosterHasK = (league.roster_positions || []).includes("K");
  const rosterHasDef = (league.roster_positions || []).includes("DEF");
  const relevantTrending = trendingFreeAgents.filter((fa) => {
    if (fa.pos === "K") return rosterHasK;
    if (fa.pos === "DEF") return rosterHasDef;
    return true;
  });
  const freeAgents = relevantTrending.slice(0, 20).map((fa) => ({
    name: fa.name,
    pos: fa.pos,
    proj: fa.proj,
    projSource: fa.projSource,
    ecr: fa.ecr,
    trending: true,
  }));

  // --- Trade Radar: every team's strengths/weaknesses, suggestions grouped by opponent ---
  // Uses ECR (already fetched, and consensus-rankings is inherently a
  // rest-of-season-oriented signal by nature, not a single-week snapshot)
  // as the "team strength" value per position — not literal rest-of-season
  // point projections, which FantasyPros doesn't expose in a form this
  // app fetches today. If literal ROS point totals are wanted later,
  // that would need a separate fetch (FantasyPros does have ROS-specific
  // rankings pages, confirmed to exist, just not wired up here yet).
  let leagueTeams = [];
  const tradeSuggestions = [];
  try {
    const posGroups = ["QB", "RB", "WR", "TE"];
    const avgEcrByPos = (roster) => {
      const byPos = {};
      (roster.players || []).forEach((id) => {
        const meta = sleeperPlayers[id];
        if (!meta || !posGroups.includes(meta.position)) return;
        const rec = lookupFpMulti(ecrIndex, [playerName(meta, id)], toFpPosition(meta.position));
        const ecr = rec ? Number(rec.rank_ecr ?? rec.rank ?? null) : null;
        if (ecr == null || Number.isNaN(ecr)) return;
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

    const teamAnalyses = rosters.map((r) => {
      const avg = avgEcrByPos(r);
      const withValues = posGroups.filter((p) => avg[p].avgEcr != null && avg[p].count >= 1);
      // Lower average ECR = better (rank 1 is the best player at a position).
      const ranked = [...withValues].sort((a, b) => avg[a].avgEcr - avg[b].avgEcr);
      const strengths = ranked.slice(0, Math.min(2, ranked.length));
      const weaknesses = [...ranked].reverse().slice(0, Math.min(2, ranked.length));
      const owner = leagueUsers.find((u) => u.user_id === r.owner_id);
      const label =
        r.roster_id === myRoster.roster_id
          ? "Your Team"
          : r.metadata?.team_name || owner?.metadata?.team_name || owner?.display_name || `Roster #${r.roster_id}`;
      return { rosterId: r.roster_id, label, isMe: r.roster_id === myRoster.roster_id, avg, strengths, weaknesses };
    });

    const myAnalysis = teamAnalyses.find((t) => t.isMe);

    leagueTeams = teamAnalyses.map((t) => ({
      team: t.label,
      isMe: t.isMe,
      strengths: t.strengths.map((p) => ({ pos: p, avgEcr: Math.round(t.avg[p].avgEcr) })),
      weaknesses: t.weaknesses.map((p) => ({ pos: p, avgEcr: Math.round(t.avg[p].avgEcr) })),
    }));

    if (myAnalysis) {
      for (const other of teamAnalyses) {
        if (other.isMe) continue;
        const suggestionsForTeam = [];
        // A real trade opportunity: a position I'm weak at where they're
        // strong, paired with a position I'm strong at where THEY'RE
        // weak — a swap that helps both sides, not just mine.
        for (const myWeak of myAnalysis.weaknesses) {
          if (!other.strengths.includes(myWeak)) continue;
          const mutualGive = myAnalysis.strengths.find((s) => other.weaknesses.includes(s));
          if (!mutualGive) continue;
          const gap = myAnalysis.avg[myWeak].avgEcr - other.avg[myWeak].avgEcr;
          if (gap <= 0) continue;
          suggestionsForTeam.push({
            severity: gap > 25 ? "major" : "minor",
            give: `A ${mutualGive}`,
            get: `A ${myWeak}`,
            note: `You're weak at ${myWeak} (avg ECR ~${Math.round(myAnalysis.avg[myWeak].avgEcr)}) — they're strong there (avg ECR ~${Math.round(other.avg[myWeak].avgEcr)}). You're strong at ${mutualGive}, which is one of their weak spots — mutually beneficial.`,
          });
        }
        const capped = suggestionsForTeam.slice(0, 2);
        if (capped.length) {
          capped.forEach((s) => tradeSuggestions.push({ ...s, theirTeam: other.label }));
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
    leagueTeams,
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
