import { normalizeName } from "./matching.js";

/**
 * v4.1: the Available page's search box — any player who can be claimed in this league, whether or not he is in
 * one of the category lists. "Can be claimed" = not rostered by any team here, a position this league uses, and
 * (non-DEF) an active player with an NFL team. Players whose game has locked are returned with `locked: true` so the
 * page can say why he can't be claimed yet. Matching: every typed word must appear in the name (accents, dots and
 * suffixes ignored); names starting with the text come first, then a word starting with it, then Sleeper's search rank.
 *
 *   players   Sleeper's /players/nfl map
 *   faSearch  the built league's { rosteredIds, positions, lockedTeams }
 *   projOf    (id) => { proj, rostered } | null   (this week's projection, when known)
 */
export function searchFreeAgents({ players = {}, faSearch = {}, q = "", projOf = () => null, limit = 15 }) {
  const words = normalizeName(String(q || "")).split(" ").filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const rostered = new Set((faSearch.rosteredIds || []).map(String));
  const positions = new Set(faSearch.positions || ["QB", "RB", "WR", "TE", "K", "DEF"]);
  const locked = new Set(faSearch.lockedTeams || []);
  const hits = [];
  for (const [id, m] of Object.entries(players)) {
    if (!m || rostered.has(String(id))) continue;
    const pos = m.position;
    if (!positions.has(pos)) continue;
    if (pos !== "DEF" && (m.active === false || !m.team)) continue;
    const name = pos === "DEF" ? `${m.first_name || ""} ${m.last_name || ""}`.trim() || String(id) : m.full_name || `${m.first_name || ""} ${m.last_name || ""}`.trim();
    if (!name) continue;
    const norm = normalizeName(name);
    if (!words.every((w) => norm.includes(w))) continue;
    const team = m.team || (pos === "DEF" ? String(id) : null);
    hits.push({ id: String(id), name, pos, team, status: m.injury_status || null, starts: norm.startsWith(words[0]) ? 0 : norm.split(" ").some((w) => w.startsWith(words[0])) ? 1 : 2, rank: Number(m.search_rank) || 1e9, locked: Boolean(team && locked.has(team)) });
  }
  hits.sort((a, b) => a.starts - b.starts || a.rank - b.rank || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map(({ starts, rank, ...h }) => {
    const p = projOf(h.id) || {};
    return { ...h, proj: p.proj ?? null, rostered: p.rostered ?? null };
  });
}
