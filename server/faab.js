import { fetchLeagueTransactions, winningBids } from "./transactions.js";
import * as faabDb from "./faabDb.js";

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
 *
 * v2.9: the lookback was widened from "since last Tuesday" to the last 21
 * days (weeks currentWeek-2..currentWeek) because one waiver run is far too
 * thin a sample. That makes the percentiles less "this week's market" and
 * more "the last three weeks' market"; early-season bids and late-season
 * bids are mixed together. Per-player history (`playerBids`) is just
 * whatever winning bids for that exact player happened to be in the
 * tracked leagues -- usually none.
 */


const WINDOW_DAYS = 21;
const DAY_MS = 24 * 3600e3;

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return null;
  return n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
}

/** Weeks to request: [week-2 .. week], clamped to >= 1 (so week 1-2 gives 1..week). */
function lookbackWeeks(currentWeek) {
  const w = Math.max(1, Number(currentWeek) || 1);
  const out = [];
  for (let k = Math.max(1, w - 2); k <= w; k++) out.push(k);
  return out;
}

/** Winning FAAB bids from the tracked leagues in the last 21 days. */
async function collectRecentWaiverBids(leagueSummaries, currentWeek, { now, getTransactions }) {
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const weeks = lookbackWeeks(currentWeek);
  const bids = []; // { leagueId, leagueName, playerId, bidAmount, budget, bidPct, at, week }
  for (const league of leagueSummaries) {
    const budget = league.settings?.waiver_budget ?? league.waiver_budget ?? null;
    if (!budget) continue; // not a FAAB league
    const rows = await fetchLeagueTransactions(league.league_id, weeks, { getTransactions });
    for (const b of winningBids(rows)) {
      if (b.at == null || b.at < cutoff || b.at > now) continue;
      bids.push({
        leagueId: league.league_id,
        leagueName: league.name || String(league.league_id),
        playerId: b.playerId,
        bidAmount: b.bid,
        budget,
        bidPct: (b.bid / budget) * 100,
        at: b.at,
        week: b.week,
      });
    }
  }
  return bids;
}

const posOf = (sleeperPlayers, id) => sleeperPlayers?.[id]?.position || (/^[A-Z]{2,3}$/.test(String(id)) ? "DEF" : "?");
const nameOf = (sleeperPlayers, id) => {
  const p = sleeperPlayers?.[id];
  const nm = p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : "";
  return nm || (/^[A-Z]{2,3}$/.test(String(id)) ? `${id} D/ST` : `Player ${id}`);
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Returns { players, sampleSize, note, history } for the given free-agent
 * candidates. sleeperPlayers is Sleeper's full player dict (for position
 * lookups); leagueSummaries are the raw league objects for every league
 * currently tracked (need .settings for budget); currentWeek from the
 * connected session. Optional 5th arg { now, getTransactions } is for tests.
 */
export async function getFaabSuggestions(freeAgents, leagueSummaries, sleeperPlayers, currentWeek, opts = {}) {
  const now = opts.now ?? Date.now();
  const bids = await collectRecentWaiverBids(leagueSummaries || [], currentWeek, { now, getTransactions: opts.getTransactions });
  // v3.7: add the app's own FAAB database (opponents' other leagues of the same type, collected before each
  // waiver run) — winning bids only here, same 21-day window, never best ball.
  if (opts.leagueType) {
    const seen = new Set(bids.map((b) => `${b.leagueId}|${b.playerId}|${b.at}`));
    for (const r of faabDb.claimsFor({ leagueType: opts.leagueType, season: opts.season, since: now - WINDOW_DAYS * DAY_MS })) {
      if (r.status !== "won" || r.best_ball || r.pct == null || !r.budget) continue;
      const k = `${r.league_id}|${r.player_id}|${r.at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      bids.push({ leagueId: r.league_id, leagueName: r.league_name || String(r.league_id), playerId: r.player_id, bidAmount: r.bid, budget: r.budget, bidPct: r.pct, at: r.at, week: r.week });
    }
  }
  const windowLabel = `Last ${WINDOW_DAYS} days (weeks ${lookbackWeeks(currentWeek)[0]}-${lookbackWeeks(currentWeek).slice(-1)[0]}) across tracked FAAB leagues${opts.leagueType ? ` and your opponents' other ${opts.leagueType === "dynasty" ? "dynasty" : "redraft/keeper"} leagues` : ""}`;

  const enriched = bids
    .map((b) => ({ ...b, pos: posOf(sleeperPlayers, b.playerId), playerName: nameOf(sleeperPlayers, b.playerId) }))
    .sort((a, b) => b.at - a.at);

  const recent = enriched.slice(0, 15).map((b) => ({
    playerName: b.playerName, pos: b.pos, bid: b.bidAmount, budget: b.budget,
    pct: Math.round(b.bidPct * 10) / 10, leagueName: b.leagueName, at: b.at,
  }));

  const posBuckets = {};
  const posPct = {};
  const allPct = [];
  for (const b of enriched) {
    (posBuckets[b.pos] = posBuckets[b.pos] || []).push(b.bidAmount);
    (posPct[b.pos] = posPct[b.pos] || []).push(b.bidPct);
    allPct.push(b.bidPct);
  }
  const byPositionHistory = {};
  for (const pos of Object.keys(posBuckets)) {
    const amt = posBuckets[pos].sort((a, b) => a - b);
    const pct = posPct[pos].sort((a, b) => a - b);
    byPositionHistory[pos] = { n: amt.length, min: amt[0], median: median(amt), max: amt[amt.length - 1], medianPct: Math.round(median(pct) * 10) / 10 };
  }
  const history = { windowLabel, bids: recent, byPosition: byPositionHistory };

  if (bids.length === 0) {
    return { players: [], sampleSize: 0, note: `No completed FAAB waiver transactions found in tracked leagues in the ${windowLabel.toLowerCase()}.`, history };
  }

  for (const pos in posPct) posPct[pos].sort((a, b) => a - b);
  allPct.sort((a, b) => a - b);

  const players = (freeAgents || []).map((fa) => {
    const posSample = posPct[fa.pos] || [];
    const useSample = posSample.length >= 10 ? posSample : allPct;
    const sampleScope = posSample.length >= 10 ? `${fa.pos} bids` : "all tracked-league bids (too few at this position alone)";
    // Free agents from buildLeague carry no Sleeper id, so match by id when
    // present, else by normalised name + position.
    const faId = fa.playerId ?? fa.player_id ?? fa.id ?? null;
    const playerBids = enriched
      .filter((b) => (faId != null ? String(b.playerId) === String(faId) : norm(b.playerName) === norm(fa.name) && (!fa.pos || b.pos === fa.pos)))
      .map((b) => ({ bid: b.bidAmount, budget: b.budget, pct: Math.round(b.bidPct * 10) / 10, leagueName: b.leagueName, at: b.at }));
    return {
      name: fa.name,
      pos: fa.pos,
      suggestion70Pct: percentile(useSample, 70),
      suggestion95Pct: percentile(useSample, 95),
      sampleSize: useSample.length,
      sampleScope,
      playerBids,
    };
  });

  return { players, sampleSize: bids.length, note: null, history };
}
