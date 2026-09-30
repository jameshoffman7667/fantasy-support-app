// Rest-of-season Monte Carlo simulator: playoff odds + championship odds.
//
// Deliberately uses each team's season-to-date scoring average (fpts_for /
// games played) as its projected mean, rather than re-running full
// per-player projections for every roster in the league — that would mean
// resolving FantasyPros/ESPN projections for every player on every team,
// which risks the FantasyPros free-tier rate limit (already a known
// constraint in this project) for a number that's fundamentally a rough
// estimate either way. A team's own scoring history is a defensible,
// zero-extra-API-calls proxy for its rest-of-season output.
//
// Not independently verified against a live Sleeper league — in
// particular, `settings.playoff_teams` / `settings.playoff_week_start`
// field names and the generic bye-seeded bracket below are built from
// Sleeper's documented schema, not confirmed against a real response.
// Falls back to sane defaults (6 playoff teams, playoffs starting week 15)
// if those fields are missing.

const DEFAULT_PLAYOFF_TEAMS = 6;
const DEFAULT_PLAYOFF_WEEK_START = 15;
const TRIALS = 3000;
// No per-team score variance is available without a full projection
// pass, so a flat coefficient of variation is used as a stand-in for
// week-to-week randomness — documented as a modeling simplification.
const SCORE_CV = 0.18;

function gaussianRandom(mean, stddev) {
  // Box-Muller transform — no external dependency needed for this.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, mean + z * stddev);
}

function nextPowerOfTwo(n) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}

/** Generic single-elimination bracket with byes for top seeds when the
 * field isn't a power of two (covers the common 4- and 6-team fantasy
 * playoff formats; an unusual league-specific format may differ). */
function simulateBracket(seededRosterIds, scoreFn) {
  const k = seededRosterIds.length;
  const bracketSize = nextPowerOfTwo(k);
  const byes = bracketSize - k;
  let remaining = seededRosterIds.slice(0, byes); // top seeds auto-advance round 1
  const round1Field = seededRosterIds.slice(byes);
  // Highest remaining seed vs lowest remaining seed, working inward.
  for (let i = 0, j = round1Field.length - 1; i < j; i++, j--) {
    remaining.push(scoreFn(round1Field[i], round1Field[j]));
  }
  if (round1Field.length % 2 === 1) remaining.push(round1Field[Math.floor(round1Field.length / 2)]);
  // Subsequent rounds: pair by current order, same inward pattern.
  while (remaining.length > 1) {
    const next = [];
    for (let i = 0, j = remaining.length - 1; i < j; i++, j--) {
      next.push(scoreFn(remaining[i], remaining[j]));
    }
    remaining = next;
  }
  return remaining[0]; // champion roster_id
}

/**
 * @param {object[]} rosters - Sleeper roster objects (settings.wins/losses/ties, settings.fpts_for etc.)
 * @param {object} league - Sleeper league object (settings.playoff_teams, settings.playoff_week_start)
 * @param {number} currentWeek
 * @param {(leagueId:string, week:number) => Promise<object[]>} getMatchups
 * @param {string} leagueId
 */
export async function simulateSeason(rosters, league, currentWeek, getMatchups, leagueId) {
  const playoffTeams = league.settings?.playoff_teams || DEFAULT_PLAYOFF_TEAMS;
  const playoffWeekStart = league.settings?.playoff_week_start || DEFAULT_PLAYOFF_WEEK_START;
  const regularSeasonEnd = playoffWeekStart - 1;

  const teams = rosters.map((r) => {
    const games = (r.settings?.wins || 0) + (r.settings?.losses || 0) + (r.settings?.ties || 0);
    const fptsFor = Number(r.settings?.fpts_for || 0) + Number(r.settings?.fpts_for_decimal || 0) / 100;
    const mean = games > 0 ? fptsFor / games : 100; // 100 is a generic placeholder for a team with zero games played
    return {
      rosterId: r.roster_id,
      wins: r.settings?.wins || 0,
      losses: r.settings?.losses || 0,
      ties: r.settings?.ties || 0,
      fpts: fptsFor,
      mean,
      stddev: mean * SCORE_CV,
    };
  });
  const byId = new Map(teams.map((t) => [t.rosterId, t]));

  // Pre-fetch remaining weeks' matchup pairings once, outside the trial loop.
  const remainingWeeks = [];
  for (let wk = currentWeek + 1; wk <= regularSeasonEnd; wk++) {
    try {
      const matchups = await getMatchups(leagueId, wk);
      const byMatchupId = new Map();
      (matchups || []).forEach((m) => {
        if (m.matchup_id == null) return;
        if (!byMatchupId.has(m.matchup_id)) byMatchupId.set(m.matchup_id, []);
        byMatchupId.get(m.matchup_id).push(m.roster_id);
      });
      const pairs = [...byMatchupId.values()].filter((g) => g.length === 2);
      if (pairs.length) remainingWeeks.push(pairs);
    } catch {
      // A missing/unpublished future week's matchups just isn't simulated —
      // better than failing the whole odds calculation.
    }
  }

  const playoffCount = new Map(teams.map((t) => [t.rosterId, 0]));
  const championCount = new Map(teams.map((t) => [t.rosterId, 0]));
  const winsTotal = new Map(teams.map((t) => [t.rosterId, 0]));

  for (let trial = 0; trial < TRIALS; trial++) {
    const sim = new Map(teams.map((t) => [t.rosterId, { ...t }]));
    for (const pairs of remainingWeeks) {
      for (const [a, b] of pairs) {
        const ta = sim.get(a), tb = sim.get(b);
        if (!ta || !tb) continue;
        const sa = gaussianRandom(ta.mean, ta.stddev);
        const sb = gaussianRandom(tb.mean, tb.stddev);
        if (sa > sb) ta.wins++; else if (sb > sa) tb.wins++; else { ta.ties++; tb.ties++; }
        ta.fpts += sa; tb.fpts += sb;
      }
    }
    const standings = [...sim.values()].sort((x, y) => y.wins - x.wins || y.ties - x.ties || y.fpts - x.fpts);
    const seeded = standings.slice(0, playoffTeams).map((t) => t.rosterId);
    seeded.forEach((id) => playoffCount.set(id, playoffCount.get(id) + 1));
    standings.forEach((t) => winsTotal.set(t.rosterId, winsTotal.get(t.rosterId) + t.wins));

    if (seeded.length >= 2) {
      const scoreFn = (idA, idB) => {
        const ta = byId.get(idA), tb = byId.get(idB);
        const sa = gaussianRandom(ta.mean, ta.stddev);
        const sb = gaussianRandom(tb.mean, tb.stddev);
        return sa >= sb ? idA : idB;
      };
      const champion = simulateBracket(seeded, scoreFn);
      championCount.set(champion, championCount.get(champion) + 1);
    }
  }

  return teams.map((t) => ({
    rosterId: t.rosterId,
    currentRecord: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
    projectedWins: Math.round((winsTotal.get(t.rosterId) / TRIALS) * 10) / 10,
    playoffPct: Math.round((playoffCount.get(t.rosterId) / TRIALS) * 1000) / 10,
    championshipPct: Math.round((championCount.get(t.rosterId) / TRIALS) * 1000) / 10,
  }));
}
