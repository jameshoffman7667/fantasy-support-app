/**
 * v3.9 — the Available page's categories.
 *
 *   hype      Hype Train: free agents recommended by this week's waiver articles / Reddit / X posts (Gemini research),
 *             most mentions first
 *   spot      Spot Start: this week's projection
 *   ros       ROS: rest-of-season projected points
 *   stash     Stashes: dynasty / long-term adds named by the research first (most mentions), then the best dynasty
 *             values (dynasty leagues)
 *   trending  Trending: Sleeper's most-added players (24 h), most adds first
 *   handcuff  Handcuff: the injury adds (backups whose starter is out), best projection first
 *
 * Each category is an ordered list of { id, key } (key = the number it's sorted by), at most PER_POS[pos] per
 * position — enough for the page's caps (All: 5 per position; QB/RB/WR/TE: 15; FLEX: 25 across RB/WR/TE).
 * Every listed player also gets the research note (if any source mentioned him) and the injury fill-in note
 * (if he backs up an injured starter), whichever list he's in.
 */
export const PER_POS = { QB: 15, RB: 25, WR: 25, TE: 25, K: 5, DEF: 5 };
export const CATEGORY_KEYS = ["hype", "spot", "ros", "stash", "trending", "handcuff"];

export const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");

/** name index for matching research names to Sleeper ids: "name|POS" and "name" (when unique). */
export function nameIndex(sleeperPlayers) {
  const byNamePos = new Map();
  const byName = new Map();
  for (const [id, m] of Object.entries(sleeperPlayers || {})) {
    if (!m) continue;
    const pos = m.position;
    if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
    const name = pos === "DEF" ? `${m.first_name || ""} ${m.last_name || ""}` : m.full_name || `${m.first_name || ""} ${m.last_name || ""}`;
    const n = normName(name);
    if (!n) continue;
    const better = (prev) => !prev || (!sleeperPlayers[prev]?.team && m.team) || (sleeperPlayers[prev]?.active === false && m.active !== false);
    if (better(byNamePos.get(`${n}|${pos}`))) byNamePos.set(`${n}|${pos}`, String(id));
    const list = byName.get(n) || [];
    list.push(String(id));
    byName.set(n, list);
    if (pos === "DEF" && m.team) byNamePos.set(`${normName(m.team)}|DEF`, String(id));
  }
  return (name, pos, team) => {
    const n = normName(name);
    if (pos && byNamePos.has(`${n}|${pos}`)) return byNamePos.get(`${n}|${pos}`);
    if (pos === "DEF" && team && byNamePos.has(`${normName(team)}|DEF`)) return byNamePos.get(`${normName(team)}|DEF`);
    const list = byName.get(n) || [];
    if (list.length === 1) return list[0];
    const onTeam = list.filter((id) => team && sleeperPlayers[id]?.team === team);
    return onTeam.length === 1 ? onTeam[0] : null;
  };
}

/** Research players → { id: { mentions, sources, kind, dynasty, note } } (only ids that resolve). */
export function matchHype(hypePlayers, findId) {
  const out = new Map();
  for (const h of hypePlayers || []) {
    const id = findId(h.name, h.pos, h.team);
    if (!id || out.has(id)) continue;
    out.set(id, { mentions: h.mentions, sources: h.sources || [], kind: h.kind, dynasty: Boolean(h.dynasty), note: h.note || null });
  }
  return out;
}

/** Keeps the first PER_POS[pos] ids per position of an already ordered [{ id, key }] list. */
export function capPerPosition(list, posOf, perPos = PER_POS) {
  const seen = {};
  const out = [];
  const ids = new Set();
  for (const e of list) {
    const pos = posOf(e.id);
    if (!pos || perPos[pos] == null || ids.has(e.id)) continue;
    seen[pos] = (seen[pos] || 0) + 1;
    if (seen[pos] > perPos[pos]) continue;
    ids.add(e.id);
    out.push(e);
  }
  return out;
}

const desc = (a, b) => b.key - a.key;

/**
 * ctx: {
 *   isFree(id)            available in this league (not rostered, not waiver-locked)
 *   posOf(id), projOf(id), rosOf(id), valueOf(id)
 *   spotPool: [{ id, proj }]   eligible this week (healthy, not on bye) — any order
 *   rosIds: iterable of ids with a rest-of-season figure
 *   valueIds: iterable of ids with a dynasty value (dynasty leagues; empty otherwise)
 *   trending: [{ player_id, count }]
 *   hype: Map id -> research entry
 *   handcuffs: [{ id, proj, fillIn }]
 * }
 */
export function buildCategories(ctx) {
  const cap = (list) => capPerPosition(list.sort(desc), ctx.posOf);
  const free = (id) => ctx.isFree(String(id));
  const hype = ctx.hype || new Map();

  const lists = {};
  lists.hype = cap([...hype.entries()].filter(([id]) => free(id)).map(([id, h]) => ({ id, key: h.mentions + (ctx.projOf(id) ?? 0) / 1000 })));
  lists.spot = cap((ctx.spotPool || []).filter((x) => free(x.id) && x.proj != null).map((x) => ({ id: String(x.id), key: x.proj })));
  lists.ros = cap([...(ctx.rosIds || [])].filter(free).map((id) => ({ id: String(id), key: ctx.rosOf(id) })).filter((x) => x.key != null && x.key > 0));
  {
    const stashHype = [...hype.entries()].filter(([id, h]) => free(id) && (h.kind === "stash" || h.dynasty));
    const named = new Set(stashHype.map(([id]) => id));
    const byValue = [...(ctx.valueIds || [])].map(String).filter((id) => free(id) && !named.has(id)).map((id) => ({ id, key: ctx.valueOf(id) })).filter((x) => x.key != null);
    // Research-named stashes first (most mentions), then dynasty value: one number keeps the order when lists merge.
    lists.stash = cap([...stashHype.map(([id, h]) => ({ id, key: 1e9 + h.mentions * 1e6 + (ctx.valueOf(id) ?? 0) })), ...byValue]);
  }
  lists.trending = cap((ctx.trending || []).filter((t) => free(t.player_id)).map((t) => ({ id: String(t.player_id), key: Number(t.count) || 0 })));
  lists.handcuff = cap((ctx.handcuffs || []).filter((h) => free(h.id)).map((h) => ({ id: String(h.id), key: h.proj ?? 0 })));
  return lists;
}

/** Injury fill-in notes from the league's injury events: id -> "Fills in for X (Out) — DAL RB1". */
export function fillInNotes(events) {
  const notes = new Map();
  for (const e of events || []) {
    const who = `${e.injured.name} (${e.injured.status}${e.injured.note ? ` — ${e.injured.note}` : ""}), ${e.injured.team} ${e.injured.slot}`;
    for (const p of [...(e.freeAdds || []), ...(e.backups || [])]) {
      if (!p?.id || notes.has(String(p.id))) continue;
      const note = p.opposite ? `Target share opens up: ${who} is out` : p.otherTeam ? `Replacement option for your ${who}` : `Fills in for ${who}`;
      notes.set(String(p.id), note);
    }
  }
  return notes;
}
