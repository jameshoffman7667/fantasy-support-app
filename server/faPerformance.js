import * as slp from "./sleeperProjections.js";

/**
 * v4.8: Waivers → Available → Performance. Actual fantasy points (the league's own scoring) from the games where a
 * player played MORE than 20% of his team's offensive snaps. Games below that are skipped, and "last 4" means his last
 * 4 such games. Pure; the route loads the weekly lines (statsStore) and passes them in.
 *
 * Snap share comes from the stored line: nflverse's offense_pct (nv_snap_pct, 0–1) when present, else Sleeper's
 * off_snp ÷ tm_off_snp. Kickers and defenses have no snap share and count whenever they have a stat line. A game with
 * no snap figure at all counts only when the line shows offensive work (pass/rush attempts, targets).
 * UNVERIFIED against live data: whether Sleeper's weekly stats carry off_snp / tm_off_snp, and nflverse's file layout.
 */
export const SNAP_MIN = 0.2; // strictly more than 20%
export const WEIGHTS = [1, 0.5, 0.25, 0.125]; // last game first → shares of about 53 / 27 / 13 / 7 %

export function snapShare(stats) {
  const nvPct = Number(stats?.nv_snap_pct);
  if (stats?.nv_snap_pct != null && Number.isFinite(nvPct)) return nvPct > 1 ? nvPct / 100 : nvPct;
  const off = Number(stats?.off_snp);
  const tm = Number(stats?.tm_off_snp);
  if (stats?.off_snp != null && stats?.tm_off_snp != null && tm > 0 && Number.isFinite(off)) return off / tm;
  return null;
}
export function qualifies(stats, pos) {
  if (pos === "K" || pos === "DEF") return Object.values(stats || {}).some((v) => Number(v) !== 0);
  const share = snapShare(stats);
  if (share != null) return share > SNAP_MIN;
  return ["pass_att", "rush_att", "rec_tgt", "rec"].some((k) => Number(stats?.[k]) > 0);
}

/** Weighted average of up to 4 games (newest first): (1·w1 + .5·w2 + .25·w3 + .125·w4) ÷ the weights used. */
export function weightedAvg(pointsNewestFirst) {
  const pts = pointsNewestFirst.slice(0, 4);
  if (!pts.length) return null;
  let num = 0;
  let den = 0;
  pts.forEach((p, i) => { num += WEIGHTS[i] * p; den += WEIGHTS[i]; });
  return num / den;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * lines: [{ season, week, id, pos, stats }] for the weeks to use; through = the last finished week.
 * Returns Map(id → { lastWeek, seasonTotal, seasonPpg, games, last4Total, last4Ppg, last4Games, weighted }).
 */
export function performanceByPlayer(lines, { settings, through }) {
  const byId = new Map();
  for (const l of lines) {
    if (l.week > through) continue;
    if (!qualifies(l.stats, l.pos)) continue;
    const pts = slp.scoreStats({ pos: l.pos, stats: l.stats }, settings);
    if (pts == null) continue;
    (byId.get(l.id) || byId.set(l.id, []).get(l.id)).push({ week: l.week, pts });
  }
  const out = new Map();
  for (const [id, games] of byId) {
    games.sort((a, b) => b.week - a.week); // newest first
    const total = games.reduce((t, g) => t + g.pts, 0);
    const last4 = games.slice(0, 4);
    const last4Total = last4.reduce((t, g) => t + g.pts, 0);
    out.set(id, {
      lastWeek: games[0].week === through ? r1(games[0].pts) : null,
      seasonTotal: r1(total),
      seasonPpg: r1(total / games.length),
      games: games.length,
      last4Total: r1(last4Total),
      last4Ppg: r1(last4Total / last4.length), // ÷ the games he has (4 once he has played that many)
      last4Games: last4.length,
      weighted: r1(weightedAvg(games.map((g) => g.pts))),
    });
  }
  return out;
}
