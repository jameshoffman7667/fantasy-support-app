/**
 * v4.7 — Waivers → Available → Copy: what you did in your OTHER leagues of the same type (dynasty vs redraft/keeper;
 * never best ball), for players who are also available in the league you are looking at.
 *
 *   pending   a claim still queued in Sleeper (read with the roster; bid may be unknown for priority leagues)
 *   won       a claim that already processed and succeeded (the winning bid is yours)
 *   lost      a claim that already processed and failed, with the winning bid when the FAAB database has it
 *
 * Processed claims come from the FAAB database (faabDb: your own rows = roster_id is yours; the winner is the "won" row
 * for the same player in the same league nearest in time). The window is the last 7 days.
 */
export const WINDOW_MS = 7 * 24 * 3600e3;
const DAY = 24 * 3600e3;

export const sameType = (a, b) => (a === "dynasty") === (b === "dynasty");

/** Player ids that are free agents in a built league (the union of every list the build keeps). */
export function availableIds(built) {
  const ids = new Set();
  for (const p of built?.freeAgents || []) if (p?.id != null) ids.add(String(p.id));
  for (const p of built?.waiver?.rows || []) if (p?.id != null) ids.add(String(p.id));
  for (const id of Object.keys(built?.waiverCategories?.cards || {})) ids.add(String(id));
  return ids;
}

/** The winner's row for a lost claim: the "won" row for that player in that league nearest in time. */
export function winnerFor(lost, rows) {
  let best = null;
  for (const r of rows) {
    if (r.status !== "won" || String(r.player_id) !== String(lost.player_id) || String(r.league_id) !== String(lost.league_id)) continue;
    if (best == null || Math.abs((r.at ?? 0) - (lost.at ?? 0)) < Math.abs((best.at ?? 0) - (lost.at ?? 0))) best = r;
  }
  return best && Math.abs((best.at ?? 0) - (lost.at ?? 0)) <= 2 * DAY ? best : null;
}

/**
 * others: [{ id, name, myRosterId, budget, pending: [{ id, adds: [playerId], drops: [], bid, leg }], rows: [faab_claims rows for this league] }]
 * available: Set of player ids free in the target league.  players: Sleeper player map (name / position / team lookup).
 */
export function buildCopy({ others, available, players = {}, now = Date.now(), windowMs = WINDOW_MS }) {
  const byPlayer = new Map();
  const push = (playerId, entry) => {
    const id = String(playerId);
    if (!available.has(id)) return;
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push(entry);
  };
  const since = now - windowMs;
  for (const o of others) {
    const budget = Number(o.budget) || null;
    for (const c of o.pending || []) {
      for (const pid of c.adds || []) {
        push(pid, { leagueId: String(o.id), leagueName: o.name, kind: "pending", bid: c.bid == null ? null : Number(c.bid), budget, pct: c.bid != null && budget ? Math.round((Number(c.bid) / budget) * 1000) / 10 : null, winningBid: null, at: null, drops: (c.drops || []).length });
      }
    }
    for (const r of o.rows || []) {
      if (Number(r.roster_id) !== Number(o.myRosterId)) continue;
      if ((r.at ?? 0) < since) continue;
      if (r.status !== "won" && r.status !== "lost") continue;
      const win = r.status === "won" ? r : winnerFor(r, o.rows);
      push(r.player_id, {
        leagueId: String(o.id),
        leagueName: o.name,
        kind: r.status,
        bid: r.bid,
        budget: Number(r.budget) || budget,
        pct: r.pct,
        winningBid: win ? win.bid : null,
        winningPct: win ? win.pct : null,
        at: r.at,
        drops: 0,
      });
    }
  }
  const order = { pending: 0, won: 1, lost: 2 };
  const items = [...byPlayer.entries()].map(([id, entries]) => {
    const m = players[id] || {};
    entries.sort((a, b) => order[a.kind] - order[b.kind] || (b.at ?? 0) - (a.at ?? 0));
    return { id, name: m.full_name || `${m.first_name || ""} ${m.last_name || ""}`.trim() || id, pos: m.position || null, team: m.team || null, entries };
  });
  items.sort((a, b) => b.entries.length - a.entries.length || Math.max(0, ...b.entries.map((e) => e.pct ?? 0)) - Math.max(0, ...a.entries.map((e) => e.pct ?? 0)) || a.name.localeCompare(b.name));
  return { windowDays: Math.round(windowMs / DAY), leagues: others.map((o) => ({ id: String(o.id), name: o.name })), items };
}
