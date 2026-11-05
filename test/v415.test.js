// v4.15: player-list refresh, post-push roster overlay, over-limit with an empty slot, drop order, trade builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tuesdayRefreshSlot, tradeIdeasSlot } from "../server/scheduler.js";
import { noteRosterWritten, effectiveRoster } from "../server/sleeper.js";
import { parseTradeIdeas } from "../server/gemini.js";
import { buildTrades, leagueCandidates, teamNeeds, LEAN } from "../server/tradeIdeas.js";
import { depthByPosition } from "../server/tradeTools.js";
import { rosterCompliance } from "../client/src/ui/compute.js";
import { dropMetric, dropOptions, rankDrops } from "../client/src/rosterChanges.js";

test("Tuesday 08:00 refresh slot", () => {
  assert.equal(tuesdayRefreshSlot({ weekday: "Tue", hour: 7, date: "2026-11-10" }), null);
  assert.equal(tuesdayRefreshSlot({ weekday: "Tue", hour: 8, date: "2026-11-10" }), "tue-players:2026-11-10");
  assert.equal(tuesdayRefreshSlot({ weekday: "Wed", hour: 9, date: "2026-11-11" }), null);
});
test("Thursday trade search slot", () => {
  assert.equal(tradeIdeasSlot({ weekday: "Thu", hour: 7, date: "2026-11-12" }), null);
  assert.equal(tradeIdeasSlot({ weekday: "Thu", hour: 8, date: "2026-11-12" }), "trade-ideas:2026-11-12");
  assert.equal(tradeIdeasSlot({ weekday: "Fri", hour: 9, date: "2026-11-13" }), null);
});

test("roster overlay: a confirmed IR move is used until Sleeper's public roster agrees", () => {
  const pub = { roster_id: 9, players: ["a", "b", "c"], starters: ["a"], reserve: [], taxi: [] };
  noteRosterWritten("L1", 9, { reserve: ["b"] });
  const eff = effectiveRoster("L1", pub);
  assert.deepEqual(eff.reserve, ["b"]);
  assert.deepEqual(eff.players, ["a", "b", "c"]);
  const agreed = effectiveRoster("L1", { ...pub, reserve: ["b"] });
  assert.deepEqual(agreed.reserve, ["b"]);
  assert.equal(effectiveRoster("L1", pub).reserve.length, 0, "forgotten once the public read agreed");
});
test("roster overlay: a confirmed drop removes the player", () => {
  const pub = { roster_id: 3, players: ["a", "b"], starters: ["a", "b"], reserve: [], taxi: [] };
  noteRosterWritten("L2", 3, { dropped: "b" });
  const eff = effectiveRoster("L2", pub);
  assert.deepEqual(eff.players, ["a"]);
  assert.deepEqual(eff.starters, ["a", "0"]);
});

const P = (id, pos, proj, value = null, extra = {}) => ({ id, name: `P${id}`, pos, proj, value, irEligible: true, rostered: 50, ...extra });
test("over the limit: an empty starting slot still counts as a slot", () => {
  const league = {
    starters: [{ slot: "QB", player: P("1", "QB", 20) }, { slot: "RB", player: null }, { slot: "WR", player: P("3", "WR", 12) }],
    bench: [P("4", "RB", 8), P("5", "WR", 6)],
    ir: [], irSlots: 0, benchSlots: 2,
  };
  const c = rosterCompliance(league);
  assert.equal(c.spots, 5);
  assert.equal(c.over, 0);
  assert.ok(!c.issues.some((t) => t.includes("over the limit")));
  const full = { ...league, bench: [...league.bench, P("6", "TE", 3), P("7", "TE", 2)] };
  assert.equal(rosterCompliance(full).over, 1);
});

test("drop order: weekly projection in redraft, dynasty value in dynasty, unknown last", () => {
  const a = P("a", "WR", 5, 900), b = P("b", "WR", 12, 100), c = P("c", "RB", null, null), d = P("d", "RB", 1, 500);
  assert.deepEqual(rankDrops({ leagueType: "redraft" }, [a, b, c, d]).map((p) => p.id), ["d", "a", "b", "c"]);
  assert.deepEqual(rankDrops({ leagueType: "dynasty" }, [a, b, c, d]).map((p) => p.id), ["b", "d", "a", "c"]);
  assert.equal(dropMetric({ leagueType: "dynasty" }, b), 100);
});
test("drop options for an add list the whole team", () => {
  const league = {
    leagueType: "redraft",
    starters: [{ slot: "QB", player: P("1", "QB", 20) }, { slot: "WR", player: P("3", "WR", 12) }],
    bench: [P("4", "RB", 8)], ir: [P("5", "WR", 0)], taxi: [P("6", "TE", 2)],
  };
  const opts = dropOptions(league, { slotIndex: 1 }, {}, null);
  assert.deepEqual(opts.map((o) => o.id), ["5", "6", "4", "3", "1"]);
  assert.match(opts.find((o) => o.id === "3").where, /being replaced/);
});

// ---- trade builder ----
const stats = {
  1: ["QB", 300], 2: ["RB", 280], 3: ["WR", 250], 4: ["TE", 120], 5: ["RB", 110], 6: ["WR", 100],
  11: ["QB", 280], 12: ["RB", 90], 13: ["WR", 260], 14: ["TE", 150], 15: ["RB", 70], 16: ["WR", 60],
  21: ["QB", 120], 22: ["RB", 270], 23: ["WR", 240], 24: ["TE", 100], 25: ["RB", 260], 26: ["WR", 230],
};
const posOf = (id) => stats[id]?.[0];
const valueOf = (id) => stats[id]?.[1] ?? null;
const rosters = [
  { rosterId: 1, label: "Your Team", players: ["1", "2", "3", "4", "5", "6"] },
  { rosterId: 2, label: "Rival A", players: ["11", "12", "13", "14", "15", "16"] },
  { rosterId: 3, label: "Rival B", players: ["21", "22", "23", "24", "25", "26"] },
];
const depth = depthByPosition(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"]);
test("team need = weak starting slots", () => {
  const needs = teamNeeds({ rosters, posOf, valueOf, depth });
  assert.ok(needs.get(2).RB > 0, "Rival A is weak at RB");
  assert.ok(needs.get(3).QB > 0, "Rival B is weak at QB");
  assert.equal(needs.get(1).QB, 0);
});
test("trades lean 10% in my favour and use the ticked players", () => {
  const out = buildTrades({ rosters, myRosterId: 1, posOf, valueOf, depth, forIds: ["22"], awayIds: ["1"] });
  assert.ok(out.length > 0);
  for (const t of out) {
    assert.ok(t.getValue >= t.giveValue, "never gives up more than he gets");
    assert.ok(t.pct >= 0 && t.pct <= 40, `pct ${t.pct}`);
  }
  const forB = out.find((t) => t.theirRosterId === 3 && t.get.includes("22"));
  assert.ok(forB, "a trade for player 22 from Rival B");
  assert.ok(forB.includes.includes("22"));
  assert.equal(LEAN, 0.1);
  // the QB sale goes to the team that needs a QB
  const sale = out.find((t) => t.give.includes("1"));
  assert.ok(sale && sale.theirRosterId === 3, "QB 1 is offered to Rival B (weak at QB)");
});
test("candidates: trade-for must be on another team, trade-away on mine", () => {
  const research = { players: [
    { name: "Z", pos: "RB", direction: "for", mentions: 2 }, { name: "Y", pos: "RB", direction: "for", mentions: 1 },
    { name: "X", pos: "QB", direction: "away", mentions: 1 }, { name: "W", pos: "WR", direction: "away", mentions: 1 },
  ] };
  const ids = { Z: "22", Y: "2", X: "1", W: "13" };
  const { forList, awayList } = leagueCandidates({ research, findId: (n) => ids[n], rosters, myRosterId: 1 });
  assert.deepEqual(forList.map((p) => p.id), ["22"]);
  assert.deepEqual(awayList.map((p) => p.id), ["1"]);
});
test("trade ideas parser keeps direction and drops junk", () => {
  const out = parseTradeIdeas([{ name: "A B", pos: "wr", direction: "for", mentions: 3, sources: ["x"] }, { name: "C", direction: "maybe" }, { name: "A B", pos: "WR", direction: "for" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pos, "WR");
});
import { tradeNet } from "../client/src/tradeNet.js";
test("editable trade net: values, percent and dynasty net", () => {
  const table = { a: { value: 110, dyn: 500 }, b: { value: 60, dyn: 200 }, c: { value: 40, dyn: 100 } };
  const t = tradeNet(["a"], ["b", "c"], (id) => table[id]);
  assert.equal(t.get.value, 110);
  assert.equal(t.give.value, 100);
  assert.equal(t.net, 10);
  assert.equal(t.pct, 10);
  assert.equal(t.dynNet, 200);
  assert.equal(tradeNet(["a"], ["b"], (id) => table[id]).pct, 83.3);
});
