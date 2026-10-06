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
import * as values from "./values.js"; // v3.5: trade values (Roster Audit / FantasyCalc)
import * as rosProjections from "./rosProjections.js"; // v3.5
import * as tradeTools from "./tradeTools.js"; // v3.5
import * as slp from "./sleeperProjections.js"; // v3.5: scores past stat lines (injury rule)

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
      playerId: p.id,
      status: p.status,
      // v3.5: only the detail ("Coach's Decision", "Hamstring"); the page already shows the status in front of it.
      note: p.injuryDetail || null,
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
/** Age with one decimal (rounded down) from Sleeper's birth_date, else Sleeper's whole-number age. */
export function ageOf(meta) {
  if (meta?.birth_date && Number.isFinite(Date.parse(meta.birth_date))) return Math.floor(((Date.now() - Date.parse(meta.birth_date)) / (365.25 * 86400000)) * 10) / 10;
  return meta?.age ?? null;
}

/** v3.6: implied team totals from ESPN's listed odds (fallback when Tank01 has no line). */
export function espnGameLines(weekSchedule) {
  const out = {};
  for (const g of weekSchedule?.games || []) {
    const o = g.espnOdds;
    if (!o || o.total == null || o.homeSpread == null || !g.home || !g.away) continue;
    const r1 = (x) => Math.round(x * 10) / 10;
    const hi = r1((o.total - o.homeSpread) / 2);
    const ai = r1((o.total + o.homeSpread) / 2);
    out[g.home] = { implied: hi, oppImplied: ai, spread: r1(o.homeSpread), total: r1(o.total), source: "ESPN" };
    out[g.away] = { implied: ai, oppImplied: hi, spread: r1(-o.homeSpread), total: r1(o.total), source: "ESPN" };
  }
  return out;
}

/** v3.6: Tank01 prop bag → { key: line } for display; anytime TD keeps its American odds. */
export function propLines(props) {
  if (!props) return null;
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    const val = k === "anytd" ? v?.odds ?? v?.line : v?.line ?? v?.odds;
    if (val != null && Number.isFinite(Number(val))) out[k] = Number(val);
  }
  return Object.keys(out).length ? out : null;
}

export async function buildFullLeague(userId, leagueSummary, week, trending, prevLeagues = []) {
  const leagueId = leagueSummary.league_id;
  const season = leagueSummary.season;

  // Usage context (snap share/targets/carries) is naturally a week behind —
  // it's how much a player played LAST week, used to sanity-check THIS
  // week's projection, not a projection itself. Clamped to 1 so week 1
  // doesn't request week 0.
  const usageWeek = Math.max(1, week - 1);
  // v3.5: the whole season's schedule (bye weeks for player cards); 18 cached weekly scoreboards, started early.
  const seasonSchedPromise = schedule.getSeasonSchedule(season).catch(() => null);

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

  const seasonSched = await seasonSchedPromise;
  const byeOf = (team) => (team && seasonSched?.byes ? seasonSched.byes[schedule.normalizeTeam(team)] ?? null : null);

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

  // v3.6: game lines (implied team totals) — Tank01's sportsbook average when present, else ESPN's listed odds —
  // and, once any game this week has kicked off, Sleeper's live weekly stats for actual stat lines on the cards.
  const gameLines = { ...espnGameLines(weekSchedule), ...(projWeek?.gameLines || {}) };
  const anyStarted = (weekSchedule?.games || []).some((g) => g.state === "in" || g.state === "post" || (g.kickoffMillis != null && g.kickoffMillis <= nowMs));
  const weekStats = anyStarted ? await sleeper.getWeekStatsLive(season, week).catch(() => null) : null;

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
    let { proj, projSource, projFactor, projStats, props } = await resolveProjection(id);
    // v2.8: this week's matchup and forecast, for the player card.
    const nt = meta?.team ? schedule.normalizeTeam(meta.team) : null;
    const g = nt && weekSchedule ? weekSchedule.byTeam[nt] : null;
    const ln = nt ? gameLines[nt] || null : null;
    // v3.6: + live state, both teams' points, implied team totals and the spread.
    const matchup = g
      ? {
          team: nt, opp: g.opponent, home: g.homeAway === "home", kickoff: g.kickoffMillis, kickoffLabel: g.kickoffLabel,
          state: g.state ?? null, statusDetail: g.statusDetail ?? null, teamScore: g.score ?? null, oppScore: g.opponentScore ?? null,
          implied: ln?.implied ?? null, oppImplied: ln?.oppImplied ?? null, spread: ln?.spread ?? null, total: ln?.total ?? null, linesSource: ln?.source ?? null,
        }
      : null;
    const wx = nt && weekWeather ? weekWeather.byTeam[nt] || null : null;

    // "Once players have played, update their projection to their actual
    // score." Two signals required together, not either alone: a
    // numeric entry in players_points (Sleeper has scored them) AND a
    // kickoff time already in the past (guards against a pre-game 0
    // being misread as a final score, since it's genuinely ambiguous
    // whether an absent/zero entry means "hasn't started" or "scored
    // zero so far").
    const played = livePointsById && kickoff != null && kickoff < Date.now() && livePointsById[id] != null;
    // v3.6: keep the pre-game projection so the roster card can show projected AND actual points.
    const preProj = played ? proj : null;
    const preProjSource = played ? projSource : null;
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
      // v3.6: Vegas player prop lines (Tank01) and, once his game has started, his actual stat line (Sleeper).
      props: propLines(props),
      actualStats: g && (g.state === "in" || g.state === "post" || (g.kickoffMillis != null && g.kickoffMillis <= Date.now())) ? hub.trimStatLine(weekStats?.[String(id)]) : null,
      status: onBye && (!meta?.injury_status || meta.injury_status === "Healthy") ? "Bye" : mapPlayerStatus(meta),
      kickoff,
      kickoffLabel,
      proj,
      projSource,
      projFactor: projSource === "actual" ? null : projFactor ?? null,
      preProj: preProj ?? null,
      preProjSource: preProjSource ?? null,
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
      // v3.5: the injury detail on its own (Injury Watch shows "status — detail"; `note` already starts with the status).
      injuryDetail: meta?.injury_body_part || null,
      bye: byeOf(meta?.team), // v3.5: bye week for the card
      age: ageOf(meta),
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
  // v3.7: the same test without recording hidden players (used for the longer lists below).
  const faFree = (sid) => {
    const meta = sleeperPlayers[sid];
    if (!meta || !posWanted(meta.position) || allRosteredIds.has(String(sid))) return false;
    if (meta.position !== "DEF" && (meta.active === false || !meta.team)) return false;
    return !waiverLocked(meta.team);
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

  // --- v3.5 trade values and team strength ---
  // Dynasty leagues: Roster Audit dynasty values (FantasyCalc's dynasty values if Roster Audit is down) for both
  // team strength and trade fairness. Redraft / keeper leagues: team strength from rest-of-season projected points
  // (Sleeper's weekly projections summed to the end of the league's playoffs), trade fairness from FantasyCalc
  // redraft values. When neither source loads, the old stand-in (FantasyPros ECR rank, or each player's rank by
  // this week's projection) is turned into a value so the page still works.
  const posGroups = ["QB", "RB", "WR", "TE"];
  const POS_DEPTH = { QB: 36, RB: 80, WR: 100, TE: 36 };
  const legacyRank = new Map(); // lower = better
  let legacyBasis = "ecr";
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
        legacyRank.set(String(id), ecr);
        withEcr++;
      }
    }
    if (!total || withEcr / total < 0.6) {
      legacyBasis = "projection";
      legacyRank.clear();
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
        list.forEach((x, i) => legacyRank.set(x.id, Math.round(((i + 1) * POS_DEPTH[pos]) / list.length)));
      }
    }
  }
  const legacyValueOf = (id) => {
    const r = legacyRank.get(String(id));
    const pos = sleeperPlayers[id]?.position;
    return r == null || !POS_DEPTH[pos] ? null : POS_DEPTH[pos] + 1 - r;
  };

  const leagueType = Number(league.settings?.type) === 2 ? "dynasty" : "redraft"; // Sleeper: 0 redraft, 1 keeper, 2 dynasty
  const bestBall = Number(league.settings?.best_ball) === 1;
  const pprSetting = Number(league.scoring_settings?.rec ?? 0);
  const tepSetting = Number(league.scoring_settings?.bonus_rec_te ?? 0) > 0;
  const valueTable = await values
    .leagueValues({ dynasty: leagueType === "dynasty", superflex, ppr: pprSetting, tep: tepSetting, teams: rosters.length })
    .catch((err) => ({ source: null, error: err.message, valueOf: () => null, details: () => null, picks: [] }));
  let ros = null;
  if (leagueType !== "dynasty" || !valueTable.source) {
    ros = await rosProjections.rosPoints({ season, week, settings: league.scoring_settings }).catch((err) => {
      console.warn(`[buildLeague] Rest-of-season projections unavailable: ${err.message}`);
      return null;
    });
  }
  const rosOf = (id) => (ros?.byId?.size ? ros.byId.get(String(id)) ?? null : null);
  let strengthOf;
  let strengthBasis;
  if (leagueType === "dynasty" && valueTable.source) (strengthOf = valueTable.valueOf), (strengthBasis = valueTable.source);
  else if (ros?.byId?.size) (strengthOf = rosOf), (strengthBasis = "rest-of-season projections");
  else if (valueTable.source) (strengthOf = valueTable.valueOf), (strengthBasis = valueTable.source);
  else (strengthOf = legacyValueOf), (strengthBasis = legacyBasis === "ecr" ? "FantasyPros ECR" : "this week's projections");
  let tradeValueOf;
  let valueBasis;
  if (valueTable.source) (tradeValueOf = valueTable.valueOf), (valueBasis = valueTable.source);
  else if (ros?.byId?.size) (tradeValueOf = rosOf), (valueBasis = "rest-of-season projections");
  else (tradeValueOf = legacyValueOf), (valueBasis = legacyBasis === "ecr" ? "FantasyPros ECR" : "this week's projections");
  const tradeBasis = {
    leagueType,
    strength: strengthBasis,
    value: valueBasis,
    valuesAt: valueTable.at ?? null,
    valuesStale: Boolean(valueTable.stale),
    valuesError: valueTable.source ? null : valueTable.error || null,
    ros: ros ? { from: ros.weeks?.from ?? null, to: ros.weeks?.to ?? null, loaded: ros.weeks?.loaded ?? null } : null,
  };

  // --- v3.7: waiver extras by league type ---
  // Every listed free agent gets his trade value (dynasty: Roster Audit; redraft/keeper: FantasyCalc redraft), his
  // rest-of-season points (redraft/keeper), age, bye and rookie flag. "addCandidates" = the top 10 per position by
  // this week's projection (the Claims page's "player to add" list); "dynastyStash" = the best available players by
  // dynasty value who aren't already listed (dynasty leagues only).
  for (const fa of freeAgents) {
    const m = sleeperPlayers[fa.id];
    fa.value = valueTable.source ? valueTable.valueOf(fa.id) ?? null : null;
    fa.ros = rosOf(fa.id);
    fa.age = ageOf(m);
    fa.bye = byeOf(m?.team);
    fa.rookie = Number(m?.years_exp) === 0;
  }
  const ADD_TOP_N = 10;
  const addCandidates = [];
  for (const [pos, list] of projTop) {
    for (const x of list.slice(0, ADD_TOP_N)) {
      const m = sleeperPlayers[x.id];
      addCandidates.push({ id: x.id, name: playerName(m, x.id), pos, team: m?.team || "FA", proj: x.proj });
    }
  }
  let dynastyStash = [];
  if (leagueType === "dynasty" && valueTable.source) {
    const listed = new Set(freeAgents.map((f) => String(f.id)));
    const pool = [];
    for (const [id, meta] of Object.entries(sleeperPlayers)) {
      if (!["QB", "RB", "WR", "TE"].includes(meta?.position) || listed.has(String(id)) || !faFree(id)) continue;
      const v = valueTable.valueOf(id);
      if (v != null) pool.push({ id: String(id), v });
    }
    pool.sort((a, b) => b.v - a.v);
    dynastyStash = await Promise.all(
      pool.slice(0, 10).map(async ({ id, v }) => {
        const c = await enrich(id);
        const m = sleeperPlayers[id];
        return { ...c, value: v, age: ageOf(m), rookie: Number(m?.years_exp) === 0, origin: "waiver", stash: true };
      })
    );
  }

  // --- Trade Radar: every team's strengths and weaknesses (rank at each position), mutual ideas per rival ---
  const rosterLabel = (r) => {
    if (!r) return null;
    if (r.roster_id === myRoster.roster_id) return "Your Team";
    const owner = leagueUsers.find((u) => u.user_id === r.owner_id);
    return r.metadata?.team_name || owner?.metadata?.team_name || owner?.display_name || `Roster #${r.roster_id}`;
  };
  const rosterLabels = Object.fromEntries(rosters.map((r) => [r.roster_id, rosterLabel(r)]));
  let leagueTeams = [];
  const tradeSuggestions = [];
  let myAnalysis = null;
  let teamAnalyses = [];
  let pickSlotByRoster = {};
  try {
    const depth = tradeTools.depthByPosition(league.roster_positions || []);
    const strength = tradeTools.positionStrength({
      rosters: rosters.map((r) => ({ rosterId: r.roster_id, players: r.players || [] })),
      posOf: (id) => sleeperPlayers[id]?.position,
      valueOf: strengthOf,
      depth,
    });
    pickSlotByRoster = tradeTools.pickSlots(strength);
    const n = rosters.length;
    teamAnalyses = rosters.map((r) => {
      const row = strength.get(r.roster_id);
      const sw = tradeTools.strengthsAndWeaknesses(row, n);
      return { rosterId: r.roster_id, ownerId: r.owner_id, label: rosterLabel(r), isMe: r.roster_id === myRoster.roster_id, row, ...sw };
    });
    myAnalysis = teamAnalyses.find((t) => t.isMe);
    leagueTeams = teamAnalyses.map((t) => ({ rosterId: t.rosterId, label: t.label, team: t.label, isMe: t.isMe, strengths: t.strengths, weaknesses: t.weaknesses }));
    if (myAnalysis) {
      for (const other of teamAnalyses) {
        if (other.isMe) continue;
        tradeTools.radarIdeas(myAnalysis, other, n).forEach((s) => tradeSuggestions.push({ ...s, theirTeam: other.label }));
      }
    }
  } catch (err) {
    console.warn(`[buildLeague] Trade Radar failed for league ${leagueId}, continuing without it: ${err.message}`);
  }

  // --- Trade Finder: concrete 1-for-1 swaps, never the same position ---
  // You SELL from a position of strength and BUY at a position of weakness: give one of your players at a strong
  // position, get one of a rival's at a weak one. Kept only when the two trade values are within 10% of each other
  // (a rival could plausibly say yes) and the swap raises YOUR projected starting lineup this week:
  //   net gain = (what the new player adds over the starter he'd replace)
  //            - (what you lose if the player you give is a starter, i.e. he drops to the best bench player at his position)
  // `mutual` marks rivals who are themselves weak where you're giving.
  const tradeFinder = [];
  try {
    const FAIRNESS = 0.1;
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
      const myWeakSet = new Set(myAnalysis.weaknesses.map((w) => w.pos));
      const giveCandidates = myAnalysis.strengths
        .map((s) => s.pos)
        .filter((sPos) => !myWeakSet.has(sPos))
        .flatMap((sPos) => myByPos(sPos).map((p) => ({ ...p, value: tradeValueOf(p.id) })).filter((p) => p.value != null).sort((x, y) => y.value - x.value).slice(0, 4));
      for (const otherRoster of rosters) {
        if (otherRoster.roster_id === myRoster.roster_id) continue;
        const theirs = teamAnalyses.find((t) => t.rosterId === otherRoster.roster_id);
        const theirLabel = rosterLabel(otherRoster);
        const wants = (otherRoster.players || [])
          .map((id) => ({ id: String(id), meta: sleeperPlayers[id], value: tradeValueOf(id) }))
          .filter((c) => c.meta && myWeakSet.has(c.meta.position) && c.value != null)
          .sort((x, y) => y.value - x.value)
          .slice(0, 8);
        const swapsForTeam = [];
        for (const give of giveCandidates) {
          if (!give.proj) continue;
          const near = wants.filter((c) => c.meta.position !== give.pos && tradeTools.closeInValue(c.value, give.value, FAIRNESS)).slice(0, 3);
          for (const cand of near) {
            const { proj: candProj } = await resolveProjection(cand.id);
            if (candProj == null) continue;
            const add = gainFromAdding(cand.meta.position, candProj);
            const loss = lossFromGiving(give);
            const net = add - loss;
            if (net <= 0.5) continue;
            swapsForTeam.push({
              theirTeam: theirLabel,
              mutual: Boolean(theirs?.weaknesses.some((w) => w.pos === give.pos)),
              give: { id: String(give.id), name: give.name, pos: give.pos, proj: give.proj, value: Math.round(give.value) },
              get: { id: cand.id, name: cand.meta ? playerName(cand.meta, cand.id) : cand.id, pos: cand.meta.position, proj: candProj, value: Math.round(cand.value) },
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
  const profileKey = store.profileOf(league.scoring_settings).key;
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
      // v3.5: best available players at a position (projection order), for topping up injury replacements.
      topFreeList: (pos, n, exclude = new Set()) => (projTop.get(pos) || []).filter((x) => !exclude.has(String(x.id))).slice(0, n),
      // v3.5: the injured player's projection before the injury: this week's if still above 0, else his latest
      // recorded projection from the previous three weeks, else his points per game this season.
      preInjuryProj: (id) => {
        const cur = projWeek ? hub.pick(projWeek, id)?.proj : null;
        if (cur != null && cur > 0) return cur;
        const prevWeeks = [week - 1, week - 2, week - 3].filter((w) => w >= 1);
        const rows = store.playerProjHistory({ profile: profileKey, season, playerId: id, weeks: prevWeeks });
        const RANK = { V: 0, T: 1, S: 2, E: 3 };
        for (const w of prevWeeks) {
          const best = rows.filter((r) => r.week === w && (r.adj_proj ?? r.proj) > 0).sort((a, b) => (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9))[0];
          if (best) return best.adj_proj ?? best.proj;
        }
        const pos = sleeperPlayers[id]?.position;
        const games = store.playerActuals(season, id).filter((g) => Number(g.stats?.gp ?? 1) > 0);
        if (!games.length) return null;
        const pts = games.map((g) => slp.scoreStats({ pos, stats: g.stats }, league.scoring_settings) ?? 0);
        return pts.reduce((a, b) => a + b, 0) / pts.length;
      },
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
      const highBB = new Set(ownership.highOwnership(res, { opponentsTotal: oppIds.length, includeBestBall: true }));
      const labelOf = (ownerId) => {
        const r = rosters.find((x) => x.owner_id === ownerId);
        const u = leagueUsers.find((x) => x.user_id === ownerId);
        return r?.metadata?.team_name || u?.metadata?.team_name || u?.display_name || ownerId;
      };
      const avg = (list, key) => (list.length ? Math.round((list.reduce((s, o) => s + (o[key] || 0), 0) / list.length) * 10) / 10 : 0);
      ownershipInfo = {
        pending: false,
        at: res.at,
        opponents: oppIds.length,
        leaguesChecked: res.leaguesChecked,
        bestBallLeagues: res.bestBallLeagues ?? null,
        errors: res.errors,
        capped: res.capped,
        min: { opponents: ownership.MIN_OPPONENTS, pct: ownership.MIN_PCT },
        players: Object.entries(res.players || {})
          .filter(([, p]) => p.opponentCount > 0)
          .map(([id, p]) => {
            const opps = (p.opponents || []).map((o) => ({
              ownerId: o.ownerId,
              team: labelOf(o.ownerId),
              leagues: o.leagues, total: o.total, pct: o.pct ?? null,
              leaguesNoBB: o.leaguesNoBB ?? o.leagues, totalNoBB: o.totalNoBB ?? o.total, pctNoBB: o.pctNoBB ?? o.pct ?? null,
            }));
            // Average share of their leagues across ALL opponents in this league (0% for those who don't hold him).
            const all = oppIds.map((oid) => opps.find((o) => String(o.ownerId) === String(oid)) || { pct: 0, pctNoBB: 0 });
            return {
              id,
              name: playerName(sleeperPlayers[id], id),
              pos: sleeperPlayers[id]?.position || "?",
              opponentCount: p.opponentCount,
              opponentCountNoBB: p.opponentCountNoBB ?? p.opponentCount,
              leagueCount: p.leagueCount,
              avgPct: avg(all, "pct"),
              avgPctNoBB: avg(all, "pctNoBB"),
              high: high.has(id),
              highBB: highBB.has(id),
              opponents: opps,
            };
          })
          .sort((a, b) => Number(b.high) - Number(a.high) || b.avgPctNoBB - a.avgPctNoBB),
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
    leagueType, // v3.5: "dynasty" | "redraft" (keeper counts as redraft)
    bestBall,
    avatar: league.avatar || null, // v3.5: league picture (Sleeper avatar id)
    rosterLabels, // v3.5: roster id -> team name (trade offers show names, not numbers)
    pickSlots: pickSlotByRoster, // v3.5: projected early/mid/late slot of each roster's own picks (dynasty pick values)
    valueParams: { ppr: pprSetting, tep: tepSetting, teams: rosters.length }, // v3.5: which value table offers use
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
    addCandidates, // v3.7
    dynastyStash, // v3.7
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
