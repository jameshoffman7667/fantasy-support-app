import * as sleeper from "./sleeper.js";

/**
 * SCOPE REALITY CHECK (read this before the math below):
 * The original ask was FAAB data "across all 2026 Sleeper leagues."
 * Confirmed via Sleeper's own docs and five independent third-party
 * wrappers: there is no endpoint to browse/search leagues platform-wide.
 * Every endpoint needs either a user_id you already know or a league_id
 * you already know. This can only ever see transactions in the leagues
 * this app is tracking — a handful of leagues, not a meaningful
 * cross-platform sample.
 *
 * That has a real statistical consequence: with maybe a few dozen
 * winning waiver bids total across a couple of tracked leagues, there's
 * usually zero or one data point for any *specific* player — nowhere
 * near enough for a genuine "70%/95% confidence of winning THIS player."
 * What's actually computed below is the 70th/95th percentile of recent
 * winning bids **as a % of budget**, grouped by position when there's
 * enough of a sample (10+) and falling back to the overall distribution
 * otherwise. Read it as "bids at this percentile usually win, for
 * players like this one" — a directional guide, not a confidence
 * interval on one player. Framed any more precisely than that would be
 * overstating what a few tracked leagues' worth of data can support.
 */

function mostRecentTuesdayMidnightUTC(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day - 2 + 7) % 7; // days since Tuesday
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/** Pulls recent waiver transactions from the tracked leagues, since the last Tuesday 12am UTC. */
async function collectRecentWaiverBids(leagueSummaries, currentWeek) {
  const cutoff = mostRecentTuesdayMidnightUTC();
  const bids = []; // { leagueId, playerId, bidPct, budget, bidAmount }

  for (const leagueSummary of leagueSummaries) {
    const budget = leagueSummary.settings?.waiver_budget ?? leagueSummary.waiver_budget ?? null;
    if (!budget) continue; // this league isn't FAAB-based — nothing to compute

    // Check this week's and last week's rounds — Sleeper's waiver
    // processing schedule varies by league, so "since Tuesday" can land
    // in either depending on exactly when it ran.
    const rounds = [currentWeek, Math.max(1, currentWeek - 1)];
    for (const round of rounds) {
      let transactions;
      try {
        transactions = await sleeper.getTransactions(leagueSummary.league_id, round);
      } catch {
        continue;
      }
      for (const t of transactions || []) {
        if (t.type !== "waiver" || t.status !== "complete") continue;
        if (!t.created || t.created < cutoff) continue;
        const bidAmount = t.settings?.waiver_bid ?? t.settings?.waiverBid;
        if (bidAmount == null) continue;
        const addedPlayerId = t.adds ? Object.keys(t.adds)[0] : null;
        if (!addedPlayerId) continue;
        bids.push({
          leagueId: leagueSummary.league_id,
          playerId: addedPlayerId,
          bidAmount,
          budget,
          bidPct: (bidAmount / budget) * 100,
        });
      }
    }
  }
  return bids;
}

/**
 * Returns { players, sampleSize, note } for the given free-agent
 * candidates. sleeperPlayers is Sleeper's full player dict (for position
 * lookups); leagueSummaries are the raw league objects for every league
 * currently tracked (need .settings for budget); currentWeek from the
 * connected session.
 */
export async function getFaabSuggestions(freeAgents, leagueSummaries, sleeperPlayers, currentWeek) {
  const bids = await collectRecentWaiverBids(leagueSummaries, currentWeek);
  if (bids.length === 0) {
    return { players: [], sampleSize: 0, note: "No completed FAAB waiver transactions found in tracked leagues since last Tuesday." };
  }

  const byPosition = {};
  const allPct = [];
  for (const b of bids) {
    const pos = sleeperPlayers[b.playerId]?.position || "?";
    byPosition[pos] = byPosition[pos] || [];
    byPosition[pos].push(b.bidPct);
    allPct.push(b.bidPct);
  }
  for (const pos in byPosition) byPosition[pos].sort((a, b) => a - b);
  allPct.sort((a, b) => a - b);

  const players = freeAgents.map((fa) => {
    const posSample = byPosition[fa.pos] || [];
    const useSample = posSample.length >= 10 ? posSample : allPct;
    const sampleScope = posSample.length >= 10 ? `${fa.pos} bids` : "all tracked-league bids (too few at this position alone)";
    return {
      name: fa.name,
      pos: fa.pos,
      suggestion70Pct: percentile(useSample, 70),
      suggestion95Pct: percentile(useSample, 95),
      sampleSize: useSample.length,
      sampleScope,
    };
  });

  return { players, sampleSize: bids.length, note: null };
}
