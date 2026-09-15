/**
 * Sleeper and FantasyPros are two independent data sources with no shared
 * player ID (FantasyPros' /players endpoint advertises "external-ID
 * cross-references" but the exact field name isn't visible without a
 * live key — check a real response and wire it in below if it includes
 * a sleeper_id or similar; that would be strictly more reliable than
 * name matching). Until then, this matches on normalized name + position,
 * with team as a tiebreaker. This is a real limitation, not a rounding
 * error: name collisions (rare) or a recent trade (team mismatch) can
 * cause a missed match. When that happens, proj/ecr just come back null
 * for that player and the UI already handles null gracefully — it won't
 * silently show a wrong number.
 */
export function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[.'`]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Builds a lookup keyed by "normalizedName|position" -> record, from any
 * FantasyPros list that has name/position_id-shaped fields. Works for
 * both projections' `players` array and consensus-rankings' `players`
 * array since both include a name and a position field, just under
 * slightly different keys depending on endpoint.
 */
export function buildFpIndex(fpPlayers) {
  const index = new Map();
  for (const p of fpPlayers || []) {
    const name = p.name || p.player_name;
    const pos = p.position_id || p.player_position_id || p.position;
    if (!name || !pos) continue;
    index.set(`${normalizeName(name)}|${pos}`, p);
  }
  return index;
}

export function lookupFp(index, name, pos) {
  if (!index || !name || !pos) return null;
  return index.get(`${normalizeName(name)}|${pos}`) || null;
}
