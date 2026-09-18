/**
 * Sleeper and FantasyPros are joined two ways now: primarily via
 * normalized name + position (below), and — where available — an extra
 * candidate name pulled from the ffb_ids crosswalk (playerIdMap.js),
 * which sometimes spells a player's name slightly differently than
 * Sleeper's first_name+last_name concatenation does. FantasyPros'
 * scraped pages and the consensus-rankings API don't expose an ID field
 * this app has confirmed, so a true ID join for FantasyPros specifically
 * isn't wired up — only the name-based approach. (ESPN, by contrast,
 * does get a real ID join now — see espnProjections.js.) When a name
 * match still fails, proj/ecr come back null and the UI shows that
 * explicitly rather than a silently wrong number.
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

/** Tries each candidate name in order (e.g. Sleeper's name, then the
 * ffb_ids crosswalk's name) and returns the first match. */
export function lookupFpMulti(index, names, pos) {
  for (const name of names) {
    const hit = lookupFp(index, name, pos);
    if (hit) return hit;
  }
  return null;
}
