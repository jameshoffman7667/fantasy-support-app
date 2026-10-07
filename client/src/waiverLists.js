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
  { key: "hype", label: "Hype Train", blurb: "Recommended in this week's waiver articles, Reddit and X posts — most mentions first." },
  { key: "spot", label: "Spot Start", blurb: "Best projections for this week." },
  { key: "ros", label: "ROS", blurb: "Most projected points for the rest of the season." },
  { key: "stash", label: "Stashes", blurb: "Dynasty and long-term adds named in the research first, then the best dynasty values." },
  { key: "trending", label: "Trending", blurb: "Most added on Sleeper in the last 24 hours." },
  { key: "handcuff", label: "Handcuff", blurb: "Backups whose starter is out, doubtful or likely to miss." },
];
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
