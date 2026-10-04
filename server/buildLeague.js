import * as sleeper from "./sleeper.js";
import * as fp from "./fantasyPros.js";
import * as schedule from "./schedule.js";
import * as hub from "./projectionHub.js"; // v2.5: all projection sources, leans, tracking
import { lookupBySleeperId } from "./playerIdMap.js";
import { buildFpIndex, lookupFpMulti } from "./matching.js";
import { checkAndRecordInjury, clearInjurySeen, getInjurySeenForLeague } from "./db.js";
import * as weather from "./weather.js"; // v2.8
import * as store from "./projectionStore.js";
import * as transactions from "./transactions.js"; // v2.9: recent drops
import { deadlineInfo } from "./tradeDeadline.js"; // v2.9
import * as ownership from "./crossOwnership.js"; // v2.9
import * as injuryOpps from "./injuryOpps.js"; // v3.1
import { getSnapShareForWeek, getUsageStatsForWeek, lookupUsage } from "./nflverseUsage.js";

// Slot labels as they appear AFTER slotLabel() (SUPER_FLEX -> "SFLX"). Before
// v2.1 this map was keyed "SUPERFLEX", which never matched the "SFLX" label the
// rest of the build actually uses — so in superflex leagues the SFLX slot was
// treated as a strict position nobody plays, and never got an optimal pick.
// REC_FLEX/WRRB_FLEX (Sleeper's receiver-only and RB/WR flex slots) are
// included so those leagues' flex slots resolve too.
const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"],
  SFLX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
};
const OUT_LIKE = ["Out", "Doubtful", "IR", "Suspended", "NA"];
// Positions FantasyPros expert consensus rankings (ECR) are fetched for.
// (Projections no longer come from FantasyPros at all as of v2.2 — see
// espnProjections.js.)
const FP_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
// Sleeper's position code for a team defense is "DEF" (confirmed via
// community API docs); FantasyPros' is "DST". Every FP lookup for a
// defense has to translate first, or it silently misses regardless of
// name-matching quality.
function toFpPosition(sleeperPos) {
  return sleeperPos === "DEF" ? "DST" : sleeperPos;
}
let _loggedNoLivePoints = false;
let _loggedNoEcr = false;

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

  // Usage context (snap share/targets/carries) is naturally a week behind —
  // it's how much a player played LAST week, used to sanity-check THIS
  // week's projection, not a projection itself. Clamped to 1 so week 1
  // doesn't request week 0.
  const usageWeek = Math.max(1, week - 1);

  const [league, rosters, leagueUsers, sleeperPlayers, weekSchedule, matchups, snapShareMap, usageStatsMap] = await Promise.all([
    sleeper.getLeague(leagueId),
    sleeper.getRosters(leagueId),
    sleeper.getLeagueUsers(leagueId),
    sleeper.getPlayers(),
    schedule.getWeekSchedule(season, week).catch(() => null), // unofficial endpoint — degrade to "kickoff unknown" rather than fail the whole build
    sleeper.getMatchups(leagueId, week).catch(() => null), // used for "lock in actual score once played" — degrade to projections-only if unavailable
    getSnapShareForWeek(season, usageWeek),
    getUsageStatsForWeek(season, usageWeek),
  ]);

  // v2.8: game-day forecasts for outdoor stadiums (Open-Meteo, keyless).
  const weekWeather = await weather.getWeekWeather(season, week, weekSchedule).catch((err) => {
    console.warn(`[buildLeague] Weather unavailable: ${err.message}`);
    return null;
  });

  const scoring = fpScoringParam(league.scoring_settings);
  // v2.5: projectionHub works out every source (Vegas props → Tank01 →
  // Sleeper → ESPN) for every player, records them for accuracy tracking,
  // and applies each source's rolling per-position lean vs Vegas for this
  // league's scoring profile. FantasyPros is used for ECR only.
  const [projWeek, ...ecrByPosition] = await Promise.all([
    hub.getWeek({ season, week, settings: league.scoring_settings, sleeperPlayers }).catch((err) => {
      console.warn(`[buildLeague] Projections unavailable this build: ${err.message}`);
      return null;
    }),
    // v2.9: ECR is optional now. If FantasyPros is down, out of quota or not
    // configured, the build carries on without ECR (waivers no longer use it;
    // Trade Radar falls back to projections) instead of failing the league.
    ...FP_POSITIONS.map((position) =>
      fp.getConsensusRankings(season, { position, scoring, week }).catch((err) => {
        if (!_loggedNoEcr) {
          console.warn(`[buildLeague] ECR unavailable (${err.message.slice(0, 120)}) — continuing without it.`);
          _loggedNoEcr = true;
        }
        return { players: [] };
      })
    ),
  ]);

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

  // v3.1: waiver lock. A player whose own game has kicked off can't be claimed until the
  // week's last game is done, so he is hidden from every waiver list until then. The week is
  // over when every game is final (or started more than 4.5 h ago, in case ESPN's status lags).
  // No schedule data → nobody is treated as locked (better to over-show than hide everyone).
  const nowMs = Date.now();
  const weekOver = !weekSchedule?.games?.length || weekSchedule.games.every((g) => g.state === "post" || (g.kickoffMillis != null && g.kickoffMillis + 4.5 * 3600 * 1000 < nowMs));
  const waiverLocked = (teamAbbr) => {
    if (weekOver) return false;
    const { kickoff } = kickoffFor(teamAbbr);
    return kickoff != null && kickoff <= nowMs;
  };
  const lockedHidden = new Set();

  // v3.1: which injury statuses this league lets you put on IR. Read from the league settings
  // (reserve_allow_out / _doubtful / _sus / _na / _dnr / _cov — names expected from Sleeper's league
  // object but UNVERIFIED). IR and PUP are always allowed. If the league carries none of those
  // flags, the default is Out + IR + PUP.
  const IR_FLAG_STATUS = { reserve_allow_out: ["Out"], reserve_allow_doubtful: ["Doubtful"], reserve_allow_sus: ["Sus", "Suspended"], reserve_allow_na: ["NA"], reserve_allow_dnr: ["DNR"], reserve_allow_cov: ["COV"] };
  const hasIrFlags = Object.keys(IR_FLAG_STATUS).some((k) => league.settings?.[k] !== undefined && league.settings?.[k] !== null);
  const irAllowed = new Set(["IR", "PUP"]);
  if (hasIrFlags) {
    for (const [k, sts] of Object.entries(IR_FLAG_STATUS)) if (Number(league.settings?.[k]) === 1) sts.forEach((x) => irAllowed.add(x));
  } else irAllowed.add("Out");
  const irStatusOk = (status) => irAllowed.has(status);

  /**
   * proj + source (v2.5): "V" Vegas props (raw), else "T" Tank01 / "S" Sleeper /
   * "E" ESPN with that source's lean factor applied (projFactor). All scored
   * with this league's settings.
   */
  const projSourceCounts = { V: 0, T: 0, S: 0, E: 0, none: 0 };
  async function resolveProjection(sleeperId) {
    const r = hub.pick(projWeek, sleeperId);
    projSourceCounts[r.projSource || "none"]++;
    return r;
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
    let { proj, projSource, projFactor, projStats } = await resolveProjection(id);
    // v2.8: this week's matchup and forecast, for the player card.
    const nt = meta?.team ? schedule.normalizeTeam(meta.team) : null;
    const g = nt && weekSchedule ? weekSchedule.byTeam[nt] : null;
    const matchup = g ? { team: nt, opp: g.opponent, home: g.homeAway === "home", kickoff: g.kickoffMillis, kickoffLabel: g.kickoffLabel } : null;
    const wx = nt && weekWeather ? weekWeather.byTeam[nt] || null : null;

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
      id: String(id),
      name,
      pos,
      team: meta?.team || "FA",
      matchup,
      weather: wx,
      projStats: projSource === "actual" ? null : projStats || null,
      status: onBye && (!meta?.injury_status || meta.injury_status === "Healthy") ? "Bye" : mapPlayerStatus(meta),
      kickoff,
      kickoffLabel,
      proj,
      projSource,
      projFactor: projSource === "actual" ? null : projFactor ?? null,
      played: Boolean(played),
      // v2.6: a player whose game has kicked off can't be moved in or out of a
      // lineup any more, so he's out of every recommendation from then on.
      started: kickoff != null && kickoff <= Date.now(),
      ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null,
      irEligible: irStatusOk(meta?.injury_status),
      // v3.1: today's game state for this player's team ("pre" | "in" | "post" | null) and whether
      // the game is today (US Eastern), used by the "non-eligible player in an IR slot" rule.
      gameState: g?.state ?? null,
      gameToday: g?.kickoffMillis != null && new Date(g.kickoffMillis).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      note: meta?.injury_status && meta?.injury_body_part ? `${meta.injury_status} — ${meta.injury_body_part}` : undefined,
      // Supplemental context from nflverse (last week's usage), not a
      // projection input — null fields mean no match/no data this week,
      // not zero usage.
      usage: lookupUsage(snapShareMap, usageStatsMap, name),
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

  // --- v2.9 waiver pool: top 5 PROJECTED + top 5 TRENDING per position ---
  // Candidates are everyone with a projection who isn't rostered in THIS
  // league (any team). Projected: best 5 per position by this league's
  // numbers, skipping players who are out/on bye or have no team. Trending:
  // Sleeper's most-added feed (24h), first 5 per position, same filters minus
  // the projection requirement. A player in both lists appears once, flagged
  // both ways. ECR is no longer part of waivers.
  const WAIVER_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const WAIVER_TOP_N = 5;
  const rosterSlots = league.roster_positions || [];
  const posWanted = (pos) => WAIVER_POSITIONS.includes(pos) && (pos !== "K" || rosterSlots.includes("K")) && (pos !== "DEF" || rosterSlots.includes("DEF"));
  const faEligible = (sid) => {
    const meta = sleeperPlayers[sid];
    if (!meta || !posWanted(meta.position)) return false;
    if (allRosteredIds.has(String(sid))) return false;
    if (meta.position !== "DEF" && (meta.active === false || !meta.team)) return false;
    if (waiverLocked(meta.team)) {
      lockedHidden.add(String(sid));
      return false;
    }
    return true;
  };
  const projTop = new Map(); // pos -> [{id, proj}]
  if (projWeek?.all) {
    for (const [sid] of projWeek.all) {
      if (!faEligible(sid)) continue;
      const meta = sleeperPlayers[sid];
      if (OUT_LIKE.includes(meta.injury_status)) continue; // can't play
      if (kickoffFor(meta.team).onBye) continue;
      const r = hub.pick(projWeek, sid);
      if (r.proj == null) continue;
      if (!projTop.has(meta.position)) projTop.set(meta.position, []);
      projTop.get(meta.position).push({ id: String(sid), proj: r.proj });
    }
  }
  const faFlags = new Map(); // id -> { topProj, trending, trendCount, projRank }
  for (const [pos, list] of projTop) {
    list.sort((x, y) => y.proj - x.proj);
    list.slice(0, WAIVER_TOP_N).forEach((x, i) => faFlags.set(x.id, { topProj: true, projRank: i + 1, trending: false, trendCount: null }));
  }
  const trendSeen = {};
  for (const t of trending || []) {
    const sid = String(t.player_id);
    if (!faEligible(sid)) continue;
    const pos = sleeperPlayers[sid].position;
    trendSeen[pos] = (trendSeen[pos] || 0) + 1;
    if (trendSeen[pos] > WAIVER_TOP_N) continue;
    const f = faFlags.get(sid) || { topProj: false, projRank: null };
    faFlags.set(sid, { ...f, trending: true, trendCount: t.count ?? null, trendRank: trendSeen[pos] });
  }
  const trendingFreeAgents = await Promise.all(
    [...faFlags.entries()].map(async ([sid, f]) => {
      const card = await enrich(sid);
      return { ...card, ...f, origin: "waiver" };
    })
  );
  const POS_ORDER = Object.fromEntries(WAIVER_POSITIONS.map((p, i) => [p, i]));
  trendingFreeAgents.sort((x, y) => (POS_ORDER[x.pos] ?? 9) - (POS_ORDER[y.pos] ?? 9) || (y.proj ?? -1) - (x.proj ?? -1));

  // v2.6: lock every starter whose game has kicked off (not only once Sleeper
  // reports his points), and drop any bench player or free agent whose game
  // has started from the candidate pool — neither can be swapped any more.
  const lockedByIndex = starters.map((s) => (s.player && (s.player.played || s.player.started) ? s.player : null));
  const candidatePool = [...rosterPool, ...trendingFreeAgents].filter((p) => !p.started);
  const optimalPicks = solveOptimalLineup(startingSlots.map(slotLabel), candidatePool, lockedByIndex);

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
      current: current ? { id: current.id, name: current.name, proj: current.proj, projSource: current.projSource, projFactor: current.projFactor ?? null } : null,
      optimal: optimal
        ? {
            id: optimal.id,
            origin: optimal.origin || null,
            name: optimal.name,
            proj: optimal.proj ?? null,
            projSource: optimal.projSource,
            projFactor: optimal.projFactor ?? null,
            note: locked ? (lockedByIndex[idx]?.played ? "Already played — locked to the actual result" : "Game has started — locked") : optimal.origin === "waiver" ? "Available on waivers — not currently on your roster" : undefined,
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
  const freeAgents = trendingFreeAgents.map((fa) => ({
    id: fa.id,
    name: fa.name,
    pos: fa.pos,
    team: fa.team,
    status: fa.status,
    matchup: fa.matchup,
    weather: fa.weather,
    projStats: fa.projStats,
    kickoff: fa.kickoff,
    kickoffLabel: fa.kickoffLabel,
    started: fa.started,
    proj: fa.proj,
    projSource: fa.projSource,
    projFactor: fa.projFactor ?? null,
    ecr: fa.ecr ?? null,
    topProj: Boolean(fa.topProj),
    projRank: fa.projRank ?? null,
    trending: Boolean(fa.trending),
    trendCount: fa.trendCount ?? null,
    usage: fa.usage,
  }));

  // --- Trade value index (v2.9) ---
  // Trade Radar and Trade Finder compare players by a "value" where LOWER IS
  // BETTER, on FantasyPros' ECR-rank scale. ECR is optional now: when it
  // matches fewer than 60% of the league's rostered QB/RB/WR/TE (FantasyPros
  // down, over quota, or not configured) the value falls back to each player's
  // rank by projection among all rostered players at his position in this
  // league, stretched onto a similar scale (QB 36 / RB 80 / WR 100 / TE 36
  // deep) so the "25 spots" and "20 spots" thresholds keep a similar meaning.
  // That scaling is a judgement call, not something measured.
  const posGroups = ["QB", "RB", "WR", "TE"];
  const POS_DEPTH = { QB: 36, RB: 80, WR: 100, TE: 36 };
  const valueById = new Map();
  let tradeBasis = "ecr";
  {
    let total = 0;
    let withEcr = 0;
    for (const id of allRosteredIds) {
      const meta = sleeperPlayers[id];
      if (!meta || !posGroups.includes(meta.position)) continue;
      total++;
      const rec = lookupFpMulti(ecrIndex, [playerName(meta, id)], toFpPosition(meta.position));
      const ecr = rec ? Number(rec.rank_ecr ?? rec.rank ?? null) : null;
      if (ecr != null && !Number.isNaN(ecr)) {
        valueById.set(String(id), ecr);
        withEcr++;
      }
    }
    if (!total || withEcr / total < 0.6) {
      tradeBasis = "projection";
      valueById.clear();
      const byPos = {};
      for (const id of allRosteredIds) {
        const meta = sleeperPlayers[id];
        if (!meta || !posGroups.includes(meta.position)) continue;
        const proj = hub.pick(projWeek, id).proj;
        if (proj == null) continue;
        (byPos[meta.position] ||= []).push({ id: String(id), proj });
      }
      for (const [pos, list] of Object.entries(byPos)) {
        list.sort((x, y) => y.proj - x.proj);
        list.forEach((x, i) => valueById.set(x.id, Math.round(((i + 1) * POS_DEPTH[pos]) / list.length)));
      }
    }
  }

  // --- Trade Radar: every team's strengths/weaknesses, suggestions grouped by opponent ---
  // "Team strength" at a position = the average trade value (ECR rank, or the
  // projection-based stand-in above) of that roster's players there.
  let leagueTeams = [];
  const tradeSuggestions = [];
  let myAnalysis = null;
  let teamAnalyses = [];
  try {
    const avgValueByPos = (roster) => {
      const byPos = {};
      (roster.players || []).forEach((id) => {
        const meta = sleeperPlayers[id];
        if (!meta || !posGroups.includes(meta.position)) return;
        const v = valueById.get(String(id));
        if (v == null) return;
        byPos[meta.position] = byPos[meta.position] || [];
        byPos[meta.position].push(v);
      });
      const avg = {};
      for (const pos of posGroups) {
        const list = byPos[pos] || [];
        avg[pos] = { count: list.length, avgEcr: list.length ? list.reduce((a, b) => a + b, 0) / list.length : null };
      }
      return avg;
    };

    teamAnalyses = rosters.map((r) => {
      const avg = avgValueByPos(r);
      const withValues = posGroups.filter((p) => avg[p].avgEcr != null && avg[p].count >= 1);
      // Lower average value = better (rank 1 is the best player at a position).
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

    myAnalysis = teamAnalyses.find((t) => t.isMe);

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
            note: `You're weak at ${myWeak} (avg ${tradeBasis === "ecr" ? "ECR" : "proj. rank"} ~${Math.round(myAnalysis.avg[myWeak].avgEcr)}) — they're strong there (~${Math.round(other.avg[myWeak].avgEcr)}). You're strong at ${mutualGive}, which is one of their weak spots — mutually beneficial.`,
          });
        }
        const capped = suggestionsForTeam.slice(0, 2);
        if (capped.length) {
          capped.forEach((s) => tradeSuggestions.push({ ...s, theirTeam: other.label }));
        }
      }
    }
  } catch (err) {
    console.warn(`[buildLeague] Trade Radar failed for league ${leagueId}, continuing without it: ${err.message}`);
  }

  // --- Trade Finder (v2.9): concrete 1-for-1 swaps, never the same position ---
  // You SELL from a position of strength and BUY at a position of weakness:
  // give one of your players at a strength position, get one of a rival's at
  // a position where you're weak. Kept only when the two are close enough in
  // trade value (|Δ| <= 20 on the value scale) that the rival could plausibly
  // say yes, and when the swap raises YOUR projected starting lineup:
  //   net gain = (what the new player adds over the starter he'd replace)
  //            - (what you lose if the player you give is a starter, i.e. he
  //               drops to the best bench player at his position)
  // `mutual` marks rivals who are themselves weak where you're giving.
  const tradeFinder = [];
  try {
    const FAIRNESS_TOLERANCE = 20;
    const eligibleForSlot = (slot, pos) => (FLEX_ELIGIBLE[slot] ? FLEX_ELIGIBLE[slot].includes(pos) : slot === pos);
    const myStarters = starters.filter((s) => s.player);
    const gainFromAdding = (pos, proj) => {
      const slots = starters.map((s, i) => ({ s, i })).filter(({ s }) => eligibleForSlot(s.slot, pos));
      if (!slots.length) return 0;
      const low = Math.min(...slots.map(({ s }) => (s.player ? s.player.proj ?? 0 : 0)));
      return Math.max(0, proj - low);
    };
    const myByPos = (pos) => [...myStarters.map((s) => ({ ...s.player, starter: true })), ...bench.filter(Boolean).map((p) => ({ ...p, starter: false }))].filter((p) => p.pos === pos && p.proj != null);
    const lossFromGiving = (g) => {
      if (!g.starter) return 0;
      const replacement = bench.filter(Boolean).filter((p) => p.pos === g.pos && p.proj != null).sort((x, y) => y.proj - x.proj)[0];
      return Math.max(0, g.proj - (replacement?.proj ?? 0));
    };

    if (myAnalysis?.strengths.length && myAnalysis?.weaknesses.length) {
      const myWeakSet = new Set(myAnalysis.weaknesses);
      const giveCandidates = myAnalysis.strengths
        .filter((sPos) => !myWeakSet.has(sPos))
        .flatMap((sPos) => myByPos(sPos).sort((x, y) => y.proj - x.proj).slice(0, 4))
        .map((p) => ({ ...p, value: valueById.get(String(p.id)) ?? null }))
        .filter((p) => p.value != null);
      for (const otherRoster of rosters) {
        if (otherRoster.roster_id === myRoster.roster_id) continue;
        const theirs = teamAnalyses.find((t) => t.rosterId === otherRoster.roster_id);
        const owner = leagueUsers.find((u) => u.user_id === otherRoster.owner_id);
        const theirLabel = otherRoster.metadata?.team_name || owner?.metadata?.team_name || owner?.display_name || `Roster #${otherRoster.roster_id}`;
        const wants = (otherRoster.players || [])
          .map((id) => ({ id: String(id), meta: sleeperPlayers[id], value: valueById.get(String(id)) }))
          .filter((c) => c.meta && myWeakSet.has(c.meta.position) && c.value != null)
          .sort((x, y) => x.value - y.value)
          .slice(0, 8);
        const swapsForTeam = [];
        for (const give of giveCandidates) {
          if (!give.proj) continue;
          const near = wants.filter((c) => c.meta.position !== give.pos && Math.abs(c.value - give.value) <= FAIRNESS_TOLERANCE).slice(0, 3);
          for (const cand of near) {
            const { proj: candProj } = await resolveProjection(cand.id);
            if (candProj == null) continue;
            const add = gainFromAdding(cand.meta.position, candProj);
            const loss = lossFromGiving(give);
            const net = add - loss;
            if (net <= 0.5) continue;
            swapsForTeam.push({
              theirTeam: theirLabel,
              mutual: Boolean(theirs?.weaknesses.includes(give.pos)),
              give: { name: give.name, pos: give.pos, proj: give.proj, ecr: give.value },
              get: { name: cand.meta ? playerName(cand.meta, cand.id) : cand.id, pos: cand.meta.position, proj: candProj, ecr: cand.value },
              gain: Math.round(net * 10) / 10,
              gainParts: { add: Math.round(add * 10) / 10, loss: Math.round(loss * 10) / 10 },
            });
          }
        }
        swapsForTeam.sort((a, b) => Number(b.mutual) - Number(a.mutual) || b.gain - a.gain);
        tradeFinder.push(...swapsForTeam.slice(0, 2)); // cap per rival so one team doesn't crowd out the rest
      }
      tradeFinder.sort((a, b) => b.gain - a.gain);
    }
  } catch (err) {
    console.warn(`[buildLeague] Trade Finder failed for league ${leagueId}, continuing without it: ${err.message}`);
  }

  // --- v2.9 league facts: slots, FAAB budget, trade deadline, recent drops, ownership ---
  const countSlots = (name) => (league.roster_positions || []).filter((p) => p === name).length;
  const benchSlots = countSlots("BN");
  const irSlots = Number(league.settings?.reserve_slots ?? countSlots("IR")) || 0;
  const waiverBudgetTotal = Number(league.settings?.waiver_budget ?? 0) || 0;
  const waiverBudgetUsed = Number(myRoster.settings?.waiver_budget_used ?? 0) || 0;
  const waiverInfo = {
    type: league.settings?.waiver_type ?? null, // Sleeper: 0 = rolling/standard, 1 = reverse standings, 2 = FAAB (unverified mapping)
    faab: waiverBudgetTotal > 0,
    budget: waiverBudgetTotal,
    used: waiverBudgetUsed,
    remaining: Math.max(0, waiverBudgetTotal - waiverBudgetUsed),
    priority: myRoster.settings?.waiver_position ?? null,
  };
  const tradeDeadline = await deadlineInfo({ settings: league.settings || {}, currentWeek: week, season, getWeekSchedule: schedule.getWeekSchedule }).catch(() => null);

  // --- v3.1: injury opportunities (pickups and plays caused by injuries at relevant depth-chart slots) ---
  let injuryOpportunities = null;
  try {
    const global = await injuryOpps.compute({ season, week, sleeperPlayers, trending });
    const myActive = new Set([...starterIds, ...benchIds].map(String));
    const myStashed = new Set([...irIds, ...taxiIds].map(String));
    const cardOf = (id) => {
      const m = sleeperPlayers[id] || {};
      const { kickoff, kickoffLabel } = kickoffFor(m.team);
      return { id: String(id), name: playerName(m, id), pos: m.position || "?", team: m.team || "FA", status: mapPlayerStatus(m), kickoffLabel, kickoff };
    };
    injuryOpportunities = injuryOpps.forLeague(global, {
      superflex,
      sleeperPlayers,
      allRosteredIds,
      mine: { active: myActive, stashed: myStashed },
      waiverLocked,
      projOf: (id) => {
        const r = projWeek ? hub.pick(projWeek, id) : null;
        return r?.proj ?? null;
      },
      topFree: (pos) => (projTop.get(pos) || [])[0] || null,
      cardOf,
    });
  } catch (err) {
    console.warn(`[buildLeague] Injury opportunities failed for league ${leagueId}, continuing without them: ${err.message}`);
  }

  let dropSummary = { windowDays: 3, items: [], error: null };
  try {
    const activity = await transactions.getLeagueActivity(leagueId, { week });
    const items = transactions.decorate(activity.drops, { sleeperPlayers, rosters, leagueUsers }).map((d) => {
      const r = hub.pick(projWeek, d.playerId);
      return { ...d, available: !allRosteredIds.has(String(d.playerId)) && !waiverLocked(sleeperPlayers[String(d.playerId)]?.team), locked: !allRosteredIds.has(String(d.playerId)) && waiverLocked(sleeperPlayers[String(d.playerId)]?.team), proj: r.proj ?? null, projSource: r.projSource ?? null };
    });
    dropSummary = { windowDays: 3, items, error: null };
  } catch (err) {
    dropSummary = { windowDays: 3, items: [], error: err.message };
  }

  // Players on your roster that opponents ALSO roster in their other leagues.
  // ~60 Sleeper calls, so it is computed in the background and cached 6h; the
  // first build after a cold start shows `pending: true`.
  let ownershipInfo = { pending: true, at: null, players: [] };
  try {
    const oppIds = rosters.filter((r) => r.roster_id !== myRoster.roster_id && r.owner_id).map((r) => r.owner_id);
    const res = ownership.getOrStart({
      key: `own:${leagueId}:${userId}:${season}`,
      compute: () => ownership.computeOwnership({ leagueId, myPlayerIds: myRoster.players || [], opponentOwnerIds: oppIds, season, sleeperPlayers }),
    });
    if (res) {
      const high = new Set(ownership.highOwnership(res, { opponentsTotal: oppIds.length }));
      const labelOf = (ownerId) => {
        const r = rosters.find((x) => x.owner_id === ownerId);
        const u = leagueUsers.find((x) => x.user_id === ownerId);
        return r?.metadata?.team_name || u?.metadata?.team_name || u?.display_name || ownerId;
      };
      ownershipInfo = {
        pending: false,
        at: res.at,
        opponents: oppIds.length,
        leaguesChecked: res.leaguesChecked,
        errors: res.errors,
        capped: res.capped,
        min: { opponents: ownership.MIN_OPPONENTS, pct: ownership.MIN_PCT },
        players: Object.entries(res.players || {})
          .filter(([, p]) => p.opponentCount > 0)
          .map(([id, p]) => ({
            id,
            name: playerName(sleeperPlayers[id], id),
            pos: sleeperPlayers[id]?.position || "?",
            opponentCount: p.opponentCount,
            leagueCount: p.leagueCount,
            high: high.has(id),
            opponents: p.opponents.map((o) => ({ team: labelOf(o.ownerId), leagues: o.leagues })),
          }))
          .sort((a, b) => Number(b.high) - Number(a.high) || b.opponentCount - a.opponentCount),
      };
    }
  } catch (err) {
    console.warn(`[buildLeague] Ownership lookup skipped: ${err.message}`);
  }

  const built = {
    id: leagueId,
    name: league.name,
    teamName,
    week,
    season,
    scoring: scoringLabel(league.scoring_settings),
    benchSlots,
    irSlots,
    waiverInfo,
    tradeDeadline,
    dropSummary,
    ownership: ownershipInfo,
    tradeBasis,
    myRosterId: myRoster.roster_id,
    ownerId: userId,
    // v3.0: raw roster arrays (slot order, '0' = empty) for pushing lineup / IR changes to Sleeper.
    starterIds: (myRoster.starters || []).map(String),
    reserveIds: (myRoster.reserve || []).map(String),
    rosterIds: (myRoster.players || []).map(String),
    scoringProfile: store.profileOf(league.scoring_settings).key, // v2.8: which matchup-difficulty table to colour with
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
    injuryOpportunities,
    weekOver,
    irAllowed: [...irAllowed],
    waiverLock: { active: !weekOver, hidden: lockedHidden.size, lockedIds: [...lockedHidden] },
    tradeSuggestions,
    leagueTeams,
    tradeFinder: tradeFinder.slice(0, 10),
  };

  const unmatchedStarters = starters.filter((s) => s.player && s.player.proj == null).map((s) => s.player.name);
  const unmatchedOptimal = optimalLineup.filter((p) => p.name && p.proj == null).map((p) => p.name);
  const unmatched = [...new Set([...unmatchedStarters, ...unmatchedOptimal])];
  const dataWarnings = [];
  if (unmatched.length) {
    dataWarnings.push(`No projection from any source for: ${unmatched.join(", ")}`);
  }

  console.log(`[buildLeague] ${league.name} week ${week} projections — Vegas: ${projSourceCounts.V}, Tank01: ${projSourceCounts.T}, Sleeper: ${projSourceCounts.S}, ESPN: ${projSourceCounts.E}, none: ${projSourceCounts.none}`);

  const injuryEvents = buildInjuryRows(leagueId, built);

  return { ...built, injuryEvents, dataWarnings };
}

export { rankThreshold, OUT_LIKE, FLEX_ELIGIBLE };
