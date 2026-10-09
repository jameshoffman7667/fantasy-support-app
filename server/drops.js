/**
 * v4.4.2 — Waivers → Available → Drops: players other teams dropped in this league in the past 14 days.
 * From Sleeper's public league transactions (waiver and free-agent moves; trades and commissioner moves are not drops).
 * Your own team's drops are left out. Pure: the caller supplies the transactions, rosters and player dictionary.
 */
export const WINDOW_DAYS = 14;
const DAY = 24 * 3600e3;

/** Which rounds (weeks) can hold the last 14 days: this one and the two before it (at least one round in the past). */
export function roundsFor(currentRound) {
  const cur = Number(currentRound);
  if (!Number.isFinite(cur) || cur < 1) return [1];
  const out = [];
  for (let r = cur; r >= Math.max(1, cur - 2); r--) out.push(r);
  return out;
}

/**
 * @param transactions every transaction of the fetched rounds (flat)
 * @param rosters Sleeper /rosters (roster_id, players[])
 * @returns [{ id, name, pos, team, status, droppedBy, droppedById, at, via, pickedUpBy|null, onWaivers }] newest first
 */
export function summarizeDrops({ transactions, rosters, players, myRosterId, labels = {}, now = Date.now(), days = WINDOW_DAYS }) {
  const since = now - days * DAY;
  const holder = new Map();
  for (const r of rosters || []) for (const id of r.players || []) holder.set(String(id), r.roster_id);
  const out = [];
  const seen = new Set();
  for (const t of transactions || []) {
    if (!t || t.status !== "complete" || !["waiver", "free_agent"].includes(t.type)) continue;
    const at = Number(t.status_updated ?? t.created);
    if (!Number.isFinite(at) || at < since) continue;
    for (const [pid, rid] of Object.entries(t.drops || {})) {
      if (Number(rid) === Number(myRosterId)) continue;
      const k = `${t.transaction_id}|${pid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = players?.[pid] || {};
      const h = holder.get(String(pid));
      out.push({
        id: String(pid),
        name: m.full_name || [m.first_name, m.last_name].filter(Boolean).join(" ") || (m.position === "DEF" ? `${m.team || pid} D/ST` : String(pid)),
        pos: m.position || "?",
        team: m.team || "FA",
        injury: m.injury_status || null,
        droppedBy: labels[rid] || `Team ${rid}`,
        droppedById: Number(rid),
        at,
        via: t.type,
        pickedUpBy: h != null ? (labels[h] || `Team ${h}`) : null,
        pickedUpById: h ?? null,
        mine: h != null && Number(h) === Number(myRosterId),
      });
    }
  }
  // a player dropped twice in the window shows once, at his latest drop
  const latest = new Map();
  for (const d of out) if (!latest.has(d.id) || d.at > latest.get(d.id).at) latest.set(d.id, d);
  return [...latest.values()].sort((a, b) => b.at - a.at);
}
