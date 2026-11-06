// v4.8: with league cards selected, each player's cheer meter counts ONLY the selected leagues (the server computes it
// across all of them). Same rules as the server's categorize(): for / against / balanced by the ratio.
export function categorizeCheer(F, A, ratio) {
  if (F > 0 && A === 0) return "for";
  if (A > 0 && F === 0) return "against";
  if (F >= ratio * A) return "for";
  if (A >= ratio * F) return "against";
  return "balanced";
}
export function scopeCheer(players, leagueSel, ratio) {
  if (!leagueSel || leagueSel.size === 0) return players;
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = [];
  for (const p of players) {
    const leagues = p.leagues.filter((l) => leagueSel.has(l.leagueId));
    if (!leagues.length) continue;
    const F = r2(leagues.filter((l) => l.side === "for").reduce((t, l) => t + l.weight, 0));
    const A = r2(leagues.filter((l) => l.side !== "for").reduce((t, l) => t + l.weight, 0));
    const stake = r2(F + A);
    out.push({ ...p, leagues, F, A, stake, lean: stake > 0 ? r2(F / stake) : 0.5, category: categorizeCheer(F, A, Number(ratio)) });
  }
  return out.sort((a, b) => b.stake - a.stake || b.lean - a.lean);
}

/** v4.16.0 (P-31): the game slot filter's labels in kickoff order; labels with no kickoff time (bye, unavailable) go last. */
export function slotLabelsChronological(players = []) {
  const first = new Map();
  for (const p of players) {
    if (!p.kickoffLabel) continue;
    const k = p.kickoff == null ? Infinity : Number(p.kickoff);
    first.set(p.kickoffLabel, Math.min(first.get(p.kickoffLabel) ?? Infinity, k));
  }
  return [...first.entries()].map(([label, k], i) => ({ label, k, i })).sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < b.k ? -1 : 1)).map((x) => x.label);
}
