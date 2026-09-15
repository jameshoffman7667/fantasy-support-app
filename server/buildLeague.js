import * as sleeper from "./sleeper.js";
import * as fp from "./fantasyPros.js";
import { buildFpIndex, lookupFp } from "./matching.js";

const FLEX_ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"] };
const OUT_LIKE = ["Out", "Doubtful", "IR", "Suspended", "NA"];

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
  return rawSlot === "SUPER_FLEX" ? "SUPERFLEX" : rawSlot;
}
function playerName(meta, id) {
  return meta ? `${meta.first_name} ${meta.last_name}` : `Player ${id}`;
}
function mapPlayerStatus(meta) {
  return meta?.injury_status || "Healthy";
}

// In-memory "last seen" status snapshots, keyed by leagueId. Good enough
// for a single-process dev/personal-use server; swap for a real DB
// (or even a JSON file) if you deploy this somewhere that restarts often
// and you want Injury Watch history to survive a restart.
const injurySnapshots = new Map();

function snapshotStatuses(league) {
  const snap = {};
  [...league.starters.map((s) => s.player), ...league.bench, ...league.ir].filter(Boolean).forEach((p) => {
    snap[p.name] = p.status;
  });
  return snap;
}
function initialInjuryEvents(league) {
  const events = [];
  [...league.starters.map((s) => s.player), ...league.bench, ...league.ir].filter(Boolean).forEach((p) => {
    if (p.status !== "Healthy") {
      events.push({ id: `${p.name}-init`, player: p.name, from: "Healthy", to: p.status, time: "Since you connected", seen: false });
    }
  });
  return events;
}
function diffInjuryEvents(prevSnapshot, league) {
  const events = [];
  for (const p of [...league.starters.map((s) => s.player), ...league.bench, ...league.ir].filter(Boolean)) {
    const prev = prevSnapshot[p.name] ?? "Healthy";
    if (prev !== p.status) {
      events.push({ id: `${p.name}-${Date.now()}`, player: p.name, from: prev, to: p.status, time: "Just now", seen: false });
    }
  }
  return events;
}

/**
 * A greedy (not globally-optimal via ILP, but strong in practice) lineup
 * solver: fill strict positional slots first with the highest-projected
 * eligible player, then fill FLEX/SUPERFLEX slots from what's left. Good
 * enough for real fantasy rosters, where there's rarely a case where a
 * greedy assignment loses meaningfully to a true optimum.
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

  return startingSlotLabels.map((slot, idx) => ({
    slot,
    name: results[idx]?.name ?? null,
    proj: results[idx] ? results[idx].proj ?? null : 0,
    note: results[idx]?.origin === "waiver" ? "Available on waivers — not currently on your roster" : undefined,
  }));
}

function rankThreshold(pos, superflex) {
  if (pos === "QB") return superflex ? 36 : 24;
  if (pos === "RB" || pos === "WR") return 48;
  if (pos === "TE") return 24;
  return 0;
}

/**
 * Builds one fully-populated league object — real Sleeper roster data,
 * real FantasyPros projections and ECR, real trending-add waivers, a
 * greedy-optimal lineup, and a heuristic (not a true valuation-engine)
 * trade radar based on positional ECR depth across the league.
 */
export async function buildFullLeague(userId, leagueSummary, week, trending, prevLeagues = []) {
  const leagueId = leagueSummary.league_id;
  const season = leagueSummary.season;

  const [league, rosters, sleeperPlayers, fpProjections, fpConsensus] = await Promise.all([
    sleeper.getLeague(leagueId),
    sleeper.getRosters(leagueId),
    sleeper.getPlayers(),
    fp.getProjections(season, week, { scoring: fpScoringParam(leagueSummary.scoring_settings) }),
    fp.getConsensusRankings(season, { scoring: fpScoringParam(leagueSummary.scoring_settings), week }),
  ]);

  const projIndex = buildFpIndex(fpProjections.players || fpProjections.data || []);
  const ecrIndex = buildFpIndex(fpConsensus.players || fpConsensus.data || []);

  const myRoster = rosters.find((r) => r.owner_id === userId);
  if (!myRoster) throw new Error(`Couldn't find your roster in ${league.name}.`);

  const startingSlots = (league.roster_positions || []).filter((p) => p !== "BN" && p !== "IR" && p !== "TAXI");
  const starterIds = myRoster.starters || [];
  const irIds = myRoster.reserve || [];
  const starterIdSet = new Set(starterIds);
  const irIdSet = new Set(irIds);
  const benchIds = (myRoster.players || []).filter((id) => !starterIdSet.has(id) && !irIdSet.has(id));

  const enrich = (id) => {
    if (!id || id === "0") return null;
    const meta = sleeperPlayers[id];
    const name = playerName(meta, id);
    const pos = meta?.position || "?";
    const projRec = lookupFp(projIndex, name, pos);
    const ecrRec = lookupFp(ecrIndex, name, pos);
    return {
      name,
      pos,
      team: meta?.team || "FA",
      status: mapPlayerStatus(meta),
      kickoff: null, // still not exposed by either API without a schedule/odds feed
      kickoffLabel: "Kickoff time needs a schedule feed",
      proj: projRec ? Number(projRec.stats?.points ?? projRec.stats?.points_ppr ?? projRec.points ?? null) : null,
      ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null,
      irEligible: meta?.injury_status === "IR" || meta?.injury_status === "PUP",
      note: meta?.injury_status && meta?.injury_body_part ? `${meta.injury_status} — ${meta.injury_body_part}` : undefined,
    };
  };

  const starters = startingSlots.map((slot, i) => ({ slot: slotLabel(slot), player: enrich(starterIds[i]) }));
  const bench = benchIds.map(enrich).filter(Boolean);
  const ir = irIds.map(enrich).filter(Boolean);

  // --- Lineup Advice: real optimal lineup from current roster + real waiver pool ---
  const ownedIds = new Set(myRoster.players || []);
  const rosterPool = [
    ...starters.filter((s) => s.player).map((s) => ({ ...s.player, origin: "roster" })),
    ...bench.map((p) => ({ ...p, origin: "roster" })),
  ];
  const trendingFreeAgents = (trending || [])
    .filter((t) => !ownedIds.has(t.player_id))
    .map((t) => {
      const meta = sleeperPlayers[t.player_id];
      const name = playerName(meta, t.player_id);
      const pos = meta?.position || "?";
      const projRec = lookupFp(projIndex, name, pos);
      const ecrRec = lookupFp(ecrIndex, name, pos);
      return {
        name,
        pos,
        proj: projRec ? Number(projRec.stats?.points ?? projRec.stats?.points_ppr ?? projRec.points ?? null) : null,
        ecr: ecrRec ? Number(ecrRec.rank_ecr ?? ecrRec.rank ?? null) : null,
        trending: true,
        origin: "waiver",
      };
    });

  const optimalLineup = solveOptimalLineup(
    startingSlots.map(slotLabel),
    [...rosterPool, ...trendingFreeAgents]
  );

  // --- Waiver Management: real trending + real rank threshold ---
  const superflex = (league.roster_positions || []).includes("SUPER_FLEX");
  const freeAgents = trendingFreeAgents.slice(0, 20).map((fa) => ({
    name: fa.name,
    pos: fa.pos,
    proj: fa.proj,
    ecr: fa.ecr,
    trending: true,
  }));

  // --- Trade Radar (heuristic): find your weakest position by average
  // ECR among your rostered players there, and any league-mate whose
  // roster shows real surplus (3+ rostered, strong average ECR) at that
  // same position. This is a real signal, not a placeholder — but it's
  // a depth/rank heuristic, not a dedicated trade-value model, since
  // FantasyPros doesn't publish one via this API.
  const tradeSuggestions = [];
  try {
    const users = await sleeper.getRosters(leagueId); // already fetched above as `rosters`; kept for clarity
    const posGroups = ["QB", "RB", "WR", "TE"];
    const ecrOf = (id) => {
      const meta = sleeperPlayers[id];
      if (!meta) return null;
      const rec = lookupFp(ecrIndex, playerName(meta, id), meta.position);
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
    const myWeak = posGroups
      .filter((p) => myAvg[p].avgEcr != null)
      .sort((a, b) => myAvg[b].avgEcr - myAvg[a].avgEcr)[0]; // highest (worst) avg ECR
    const mySurplus = posGroups
      .filter((p) => myAvg[p].avgEcr != null && myAvg[p].count >= 3)
      .sort((a, b) => myAvg[a].avgEcr - myAvg[b].avgEcr)[0]; // lowest (best) avg ECR with depth

    if (myWeak && mySurplus && myWeak !== mySurplus) {
      for (const other of rosters) {
        if (other.roster_id === myRoster.roster_id) continue;
        const theirAvg = avgEcrByPos(other);
        const theirSurplusHere = theirAvg[myWeak];
        const theirNeed = theirAvg[mySurplus];
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
    // Trade Radar is a bonus heuristic — if it fails for any reason,
    // fail soft (empty list) rather than take down the whole league load.
  }

  const built = {
    id: leagueId,
    name: league.name,
    week,
    scoring: scoringLabel(league.scoring_settings),
    superflex,
    lockLabel: "Live from Sleeper",
    dataSource: "live",
    starters,
    bench,
    ir,
    optimalLineup,
    freeAgents,
    tradeSuggestions,
    injuryEvents: [],
  };

  // If a starter or a pool player never matched a FantasyPros record, its
  // proj is null — and null silently behaves like 0 in a sum. Surface
  // that explicitly rather than let Lineup Advice quietly understate
  // "current" points and overstate the gap to "optimal."
  const unmatchedStarters = starters
    .filter((s) => s.player && s.player.proj == null)
    .map((s) => s.player.name);
  const unmatchedOptimal = optimalLineup
    .filter((p) => p.name && p.proj == null)
    .map((p) => p.name);
  const unmatched = [...new Set([...unmatchedStarters, ...unmatchedOptimal])];
  const dataWarnings = unmatched.length
    ? [`Couldn't match to FantasyPros by name, so proj is unknown: ${unmatched.join(", ")}`]
    : [];

  const prev = prevLeagues.find((p) => p.id === leagueId);
  const injuryEvents = prev ? diffInjuryEvents(injurySnapshots.get(leagueId) || {}, built) : initialInjuryEvents(built);
  injurySnapshots.set(leagueId, snapshotStatuses(built));

  return { ...built, injuryEvents, dataWarnings };
}

export { rankThreshold, OUT_LIKE, FLEX_ELIGIBLE };
