// v4.13: Primetime wording, live pace colours, locked-in roster swaps, weather lookups, claim error text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { primetimeNeed } from "../client/src/primetimeNeed.js";
import { gameProgress, livePaceTone } from "../client/src/livePace.js";
import { arrangement, buildPush, customChange, defaultChecked, leagueAfter, proposeChanges } from "../client/src/rosterChanges.js";

const txt = (n) => n.segments.map((s) => s.t).join("");
const P = (...names) => names.map((name) => ({ name }));

test("Primetime: only your players left", () => {
  const n = primetimeNeed({ my: P("Kelce"), opp: [], myPts: 98.4, oppPts: 112.6 });
  assert.equal(txt(n), "Kelce to score more than 14.2 points");
  assert.deepEqual(n.segments.map((s) => s.tone), ["ok", null, "ok"]);
  assert.equal(txt(primetimeNeed({ my: P("Kelce", "Kupp"), opp: [], myPts: 80, oppPts: 95 })), "Kelce + Kupp combine for more than 15.0 points");
  assert.equal(txt(primetimeNeed({ my: P("Kelce"), opp: [], myPts: 120, oppPts: 105 })), "Kelce to score more than -15.0 points"); // negative stays
});
test("Primetime: only the opponent's players left", () => {
  const n = primetimeNeed({ my: [], opp: P("Henry"), myPts: 110, oppPts: 95 });
  assert.equal(txt(n), "Henry to score less than 15.0 points");
  assert.deepEqual(n.segments.map((s) => s.tone), ["major", null, "major"]);
  assert.equal(txt(primetimeNeed({ my: [], opp: P("Henry", "Diggs"), myPts: 100, oppPts: 90 })), "Henry + Diggs combine for less than 10.0 points");
});
test("Primetime: already lost shows the sentence only when within 4 points", () => {
  assert.equal(txt(primetimeNeed({ my: [], opp: P("Henry"), myPts: 90, oppPts: 104 })), "Already lost");
  assert.equal(txt(primetimeNeed({ my: [], opp: P("Henry"), myPts: 90, oppPts: 93 })), "Henry to score less than -3.0 points");
  assert.equal(txt(primetimeNeed({ my: [], opp: P("Henry"), myPts: 90, oppPts: 94 })), "Henry to score less than -4.0 points");
  assert.equal(txt(primetimeNeed({ my: [], opp: P("Henry"), myPts: 90, oppPts: 94.5 })), "Already lost");
});
test("Primetime: both sides — opponent leads, you lead, tie", () => {
  const a = primetimeNeed({ my: P("Kelce"), opp: P("Henry"), myPts: 80, oppPts: 91.5 });
  assert.equal(txt(a), "Kelce outscore Henry by 11.5 points");
  assert.deepEqual(a.segments.filter((s) => s.tone).map((s) => [s.t, s.tone]), [["Kelce", "ok"], ["outscore", "major"], ["Henry", "major"], ["11.5 points", "major"]]);
  assert.equal(txt(primetimeNeed({ my: P("Kelce", "Kupp"), opp: P("Henry", "Diggs"), myPts: 70, oppPts: 88 })), "Kelce + Kupp outscore Henry + Diggs by 18.0 points");
  const b = primetimeNeed({ my: P("Kelce"), opp: P("Henry"), myPts: 102, oppPts: 96 });
  assert.equal(txt(b), "Kelce to score within 6.0 points of Henry");
  assert.deepEqual(b.segments.filter((s) => s.tone).map((s) => [s.t, s.tone]), [["Kelce", "ok"], ["within", "major"], ["6.0 points", "ok"], ["Henry", "major"]]);
  assert.equal(txt(primetimeNeed({ my: P("Kelce"), opp: P("Henry"), myPts: 100, oppPts: 100 })), "Kelce to score within 0.0 points of Henry"); // tie = case 4
  assert.equal(primetimeNeed({ my: [], opp: [], myPts: 1, oppPts: 2 }), null);
});

test("live pace: progress from ESPN text and the colour bands", () => {
  assert.equal(gameProgress("Halftime"), 0.5);
  assert.equal(gameProgress("End of 3rd"), 0.75);
  assert.ok(Math.abs(gameProgress("7:30 - 2nd") - 0.375) < 1e-9);
  assert.equal(gameProgress("Sun 1:00 PM"), null);
  assert.equal(livePaceTone(10, 20, 0.5), "ok"); // exactly on pace
  assert.equal(livePaceTone(7, 20, 0.5), "minor");
  assert.equal(livePaceTone(2, 20, 0.5), "major");
  assert.equal(livePaceTone(5, 20, 0.05), null); // too early to judge
  assert.equal(livePaceTone(5, 0, 0.5), null);
});

// ---- locked-in manual swap ----
const later = Date.now() + 5 * 3600e3;
const Pl = (id, name, pos, proj) => ({ id: String(id), name, pos, proj, kickoff: later, status: "Healthy" });
const mk = (starters, bench) => ({ id: "L1", week: 7, weekOver: false, starters: starters.map(([slot, player]) => ({ slot, player })), starterIds: starters.map(([, p]) => p.id), bench, ir: [], taxi: [], lineup: { rows: [] } });
test("a manual swap is locked in and the suggestions are planned from it", () => {
  const a = Pl(1, "A", "WR", 5), b = Pl(2, "B", "WR", 9), c = Pl(3, "C", "WR", 12), d = Pl(4, "D", "WR", 7);
  const lg = mk([["WR", a], ["WR", b]], [c, d]);
  // he starts D at slot 0 by hand (D 7 replaces A 5)
  const arr0 = arrangement(lg, [], new Set());
  const cc = customChange(arr0, { kind: "bench", id: "4" }, { enabled: true, slotIndex: 0, player: d });
  assert.ok(cc, "custom change built");
  const frozen = [cc];
  const keys = new Set([cc.key]);
  const base = leagueAfter(lg, arrangement(lg, frozen, keys));
  assert.deepEqual(base.starters.map((s) => s.player.name), ["D", "B"]);
  const next = proposeChanges(base);
  // best from there: C (12) in for the lowest starter (D 7)
  assert.ok(next.length >= 1);
  const all = [...frozen, ...next];
  const ticked = new Set([...keys, ...defaultChecked(next)]);
  const out = arrangement(lg, all, ticked);
  assert.deepEqual(out.starters.map((s) => s.player.name), ["C", "B"], "from his lock-in, C (12) takes the slot of the lowest starter D (7)");
  const push = buildPush(lg, all, ticked);
  assert.deepEqual(push.errors, []);
  assert.equal(push.starters.length, 2);
  assert.ok(push.summary.some((x) => /custom/.test(x)), "the manual change is in the push, first");
  assert.ok(/custom/.test(push.summary[0]));
});
