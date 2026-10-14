/**
 * v3.9 — what the Available page shows for a category and position filter (pure, unit-tested).
 *
 *   All   → each position's first 5 (in the category's order), then all of them sorted together
 *   QB / RB / WR / TE → that position's first 15
 *   FLEX  → RB, WR and TE together, first 25
 *
 * lists: { [category]: [{ id, key }] } sorted by key, highest first (server/waiverCategories.js)
 * cards: { [id]: { pos, ... } }
 */
export const CATEGORIES = [
  // v4.2: "All" — every free agent in the league, sorted by any stat (Filters & sort); the default tab.
  { key: "all", label: "All", blurb: "Every free agent in this league, sorted by the stat you choose (filter button)." },
  // v4.7: not ranked lists of free agents — Auto shows what Auto mode would do, Copy your claims in your other leagues.
  { key: "auto", label: "Auto", blurb: "What Auto mode would do in this league right now: the moves, and the claims that result." },
  { key: "trending", label: "Trending", blurb: "Most added on Sleeper in the last 24 hours." },
  { key: "copy", label: "Copy", blurb: "Your claims in your other leagues of the same type, for players who are free in this league." },
  // v4.4.2: not a ranked list of free agents — other teams' drops in the last 14 days (own page, own data).
  { key: "drops", label: "Drops", blurb: "Players other teams dropped in the last 14 days." },
  { key: "hype", label: "Hype Train", blurb: "Recommended in this week's waiver articles, Reddit and X posts — most mentions first." },
  { key: "spot", label: "Spot Start", blurb: "Best projections for this week." },
  { key: "ros", label: "ROS", blurb: "Most projected points for the rest of the season." },
  { key: "stash", label: "Stashes", blurb: "Dynasty and long-term adds named in the research first, then the best dynasty values." },
  { key: "handcuff", label: "Handcuff", blurb: "Backups whose starter is out, doubtful or likely to miss." },
];
// v4.7: the views are drawn in two rows — these five first, the rest below in their order above.
export const TOP_ROW = ["all", "auto", "trending", "copy", "drops"];
export const categoryRows = () => [TOP_ROW.map((k) => CATEGORIES.find((c) => c.key === k)), CATEGORIES.filter((c) => !TOP_ROW.includes(c.key))];
export const POSITION_FILTERS = ["ALL", "QB", "RB", "WR", "TE", "FLEX"];
export const CAPS = { all: 5, position: 15, flex: 25 };
const FLEX = ["RB", "WR", "TE"];

export function categoryView(lists, cards, category, filter = "ALL") {
  const list = (lists?.[category] || []).filter((e) => cards?.[e.id]);
  const posOf = (e) => cards[e.id].pos;
  if (filter === "FLEX") return list.filter((e) => FLEX.includes(posOf(e))).slice(0, CAPS.flex);
  if (filter && filter !== "ALL") return list.filter((e) => posOf(e) === filter).slice(0, CAPS.position);
  const per = {};
  const picked = list.filter((e) => {
    const p = posOf(e);
    per[p] = (per[p] || 0) + 1;
    return per[p] <= CAPS.all;
  });
  return picked.map((e, i) => ({ e, i })).sort((a, b) => b.e.key - a.e.key || a.i - b.i).map((x) => x.e);
}

/** How the card should describe the number the list is sorted by. */
export function keyLabel(category, card) {
  if (category === "hype" && card.hype) return `${card.hype.mentions} mention${card.hype.mentions === 1 ? "" : "s"}`;
  if (category === "trending" && card.trendCount != null) return `+${card.trendCount.toLocaleString()} adds`;
  if (category === "ros" && card.ros != null) return `ROS ${Number(card.ros).toFixed(1)} pts`;
  if (category === "stash" && card.value != null) return `Value ${Math.round(card.value).toLocaleString()}`;
  return null;
}
