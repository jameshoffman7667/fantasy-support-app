// v4.17: ticker API for Multiview (P-33) and Claim Generator vs pending claims (P-32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, buildSummary, diffEvents, subscribe, _reset, createToken, verifyBearer, revokeToken, tokenStatus } from "../server/ticker.js";
import { compareClaims, isOff, planPush, integrateRow, applyIntegration, planSignature, freshPlan } from "../client/src/claimCompare.js";
import { setBid } from "../client/src/waiverPlan.js";

const P = (id, pts, state = "in", extra = {}) => ({ id, name: `P${id}`, pos: "WR", team: "KC", pts, proj: 10, state, statusDetail: "Q2 3:00", ...extra });
const league = (over = {}) => ({
  id: "L1", name: "League One", color: "green", include: true, myPoints: 20, myProjected: 100, oppPoints: 15, oppProjected: 90, myRemaining: 40, oppRemaining: 30, threshold: 5, myTeam: "Me", oppTeam: "Them",
  ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 10), P("2", 10)], opp: [P("3", 15)], myBench: [P("4", 0, "pre")], oppBench: [] }, ...over,
});
const raw = (leagues, week = 9) => ({ season: "2026", week, leagues });

test("buildFrame keeps included leagues only and maps colour words", () => {
  const f = buildFrame(raw([league({ color: "yellow" }), league({ id: "L2", include: false })]));
  assert.equal(f.leagues.length, 1);
  assert.equal(f.leagues[0].colour, "amber");
  assert.equal(f.leagues[0].status, "live");
  assert.ok(f.leagues[0].players["mine:1"].starter);
  assert.equal(f.leagues[0].players["mine:4"].starter, false);
});

test("buildSummary: bench off by default, status pre/final, gameClock only when in or post", () => {
  const f = buildFrame(raw([league({ ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 0, "pre")], opp: [P("3", 0, "pre")], myBench: [P("4", 0, "pre")], oppBench: [] } })]));
  const s = buildSummary(f);
  assert.equal(s.leagues[0].status, "pre");
  assert.equal(s.leagues[0].players.length, 2);
  assert.equal(s.leagues[0].players[0].gameClock, null);
  assert.equal(buildSummary(f, { bench: true }).leagues[0].players.length, 3);
  const fin = buildSummary(buildFrame(raw([league({ ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 5, "post")], opp: [P("3", 5, "post")], myBench: [], oppBench: [] } })])));
  assert.equal(fin.leagues[0].status, "final");
});

test("diffEvents: baseline, increases only, rolling totals", () => {
  let n = 0;
  const nextId = () => `evt_${++n}`;
  const a = buildFrame(raw([league()]));
  assert.deepEqual(diffEvents(null, a, { nextId }), []);
  assert.deepEqual(diffEvents(a, buildFrame(raw([league()], 10)), { nextId }), []); // new week = baseline
  const b = buildFrame(raw([league({ ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 16), P("2", 12)], opp: [P("3", 14)], myBench: [P("4", 0, "pre")], oppBench: [] } })]));
  const ev = diffEvents(a, b, { nextId });
  assert.deepEqual(ev.map((e) => e.playerId), ["1", "2"]); // P3 went down: no event
  assert.equal(ev[0].delta, 6);
  assert.equal(ev[0].leagues[0].mineBefore, 20);
  assert.equal(ev[0].leagues[0].mineAfter, 26);
  assert.equal(ev[1].leagues[0].mineBefore, 26); // rolls on from the first event
  assert.equal(ev[1].leagues[0].mineAfter, 28);
  assert.equal(ev[0].providerAt, null);
  assert.equal(ev[0].reason, null);
});

test("diffEvents: a league not in the earlier frame is a baseline, and one player in two leagues merges", () => {
  let n = 0;
  const nextId = () => `evt_${++n}`;
  const mk = (l1, l2) => buildFrame(raw([league({ ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", l1)], opp: [], myBench: [], oppBench: [] } }), ...(l2 == null ? [] : [league({ id: "L2", name: "Two", ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", l2)], opp: [], myBench: [], oppBench: [] } })])]));
  assert.deepEqual(diffEvents(mk(5, null), mk(8, 8), { nextId }).map((e) => e.leagues.length), [1]);
  const ev = diffEvents(mk(5, 5), mk(8, 9), { nextId });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].leagues.length, 2);
  assert.equal(ev[0].delta, 4);
});

test("token: created once, verified by hash, revoked", () => {
  const { token } = createToken("tester");
  assert.match(token, /^fmt_/);
  assert.equal(verifyBearer(`Bearer ${token}`), "tester");
  assert.equal(verifyBearer("Bearer nope-not-a-token-at-all-xx"), null);
  assert.equal(tokenStatus("tester").exists, true);
  assert.equal(JSON.stringify(tokenStatus("tester")).includes(token), false);
  const second = createToken("tester");
  assert.equal(verifyBearer(`Bearer ${token}`), null); // replaced
  assert.equal(verifyBearer(`Bearer ${second.token}`), "tester");
  revokeToken("tester");
  assert.equal(verifyBearer(`Bearer ${second.token}`), null);
});

test("subscribe replays events after Last-Event-ID", () => {
  _reset();
  const out = [];
  const res = { write: (s) => out.push(s) };
  const unsub = subscribe("nobody", res, "evt_5");
  assert.equal(out.length, 0);
  unsub();
});

// ---------------- P-32 ----------------
const claim = (add, drop, bid, key) => ({ key: key || `${add}|${drop || "-"}`, addId: add, dropId: drop, bid, addName: `A${add}`, dropName: drop ? `D${drop}` : null });
const ex = (tx, add, drop, bid) => ({ txId: tx, addId: add, dropId: drop, bid, leg: 9 });
const nm = (id) => ({ name: `N${id}` });

test("compareClaims: identical, bid change, drop change, same drop", () => {
  const existing = [ex("t1", "10", "1", 5), ex("t2", "20", "2", 3), ex("t3", "30", "9", 2)];
  const proposed = [claim("10", "1", 5), claim("20", "2", 7), claim("30", "4", 2), claim("40", "9", 1)];
  const c = compareClaims(proposed, existing, nm);
  assert.equal(c.get("10|1").status, "same");
  assert.equal(c.get("20|2").status, "bid");
  assert.match(c.get("20|2").notes[0], /\$3 will be updated to \$7/);
  assert.equal(c.get("30|4").status, "drop");
  assert.match(c.get("30|4").notes[0], /will be updated/);
  assert.equal(c.get("40|9").status, "new");
  assert.match(c.get("40|9").notes[0], /already drops/);
});

test("compareClaims: a queued claim whose drop is still proposed is not an update", () => {
  const c = compareClaims([claim("10", "1", 5), claim("10", "2", 5)], [ex("t1", "10", "1", 5)], nm);
  assert.equal(c.get("10|1").status, "same");
  assert.equal(c.get("10|2").status, "new");
  assert.deepEqual(c.get("10|2").notes, []);
});

test("identical claims are off unless ticked; others on unless unticked", () => {
  const c = compareClaims([claim("10", "1", 5), claim("11", null, 2)], [ex("t1", "10", "1", 5)], nm);
  assert.equal(isOff(claim("10", "1", 5), c, [], []), true);
  assert.equal(isOff(claim("10", "1", 5), c, [], ["10|1"]), false);
  assert.equal(isOff(claim("11", null, 2), c, [], []), false);
  assert.equal(isOff(claim("11", null, 2), c, ["11|-"], []), true);
});

test("planPush: only new claims -> no cancels; bid update cancels its queued claim; reorder of identical resends all", () => {
  const existing = [ex("t1", "10", "1", 5), ex("t2", "20", "2", 3)];
  let ordered = [claim("10", "1", 5), claim("20", "2", 7), claim("30", null, 1)];
  let cmp = compareClaims(ordered, existing, nm);
  let p = planPush(ordered, cmp, existing);
  assert.deepEqual(p.push.map((c) => c.key), ["20|2", "30|-"]);
  assert.deepEqual(p.cancel.map((x) => x.txId), ["t2"]);
  assert.equal(p.resendAll, false);

  const e2 = [ex("t1", "10", "1", 5), ex("t2", "20", "2", 5)];
  ordered = [claim("20", "2", 5), claim("10", "1", 5)]; // identical, swapped
  cmp = compareClaims(ordered, e2, nm);
  p = planPush(ordered, cmp, e2);
  assert.equal(p.resendAll, true);
  assert.deepEqual(p.cancel.map((x) => x.txId), ["t1", "t2"]);
  assert.deepEqual(p.push.map((c) => c.key), ["20|2", "10|1"]);

  ordered = [claim("10", "1", 5), claim("20", "2", 5)]; // same order, untouched
  cmp = compareClaims(ordered, e2, nm);
  p = planPush(ordered, cmp, e2);
  assert.deepEqual(p.push, []);
  assert.deepEqual(p.cancel, []);
});

test("integrateRow: prefill unless Available has a different bid", () => {
  const x = ex("t1", "10", "1", 5);
  assert.deepEqual(integrateRow(x, []), { oldBid: 5, availableBid: null, differs: false, prefill: 5 });
  assert.equal(integrateRow(x, [{ id: "10", bid: 5 }]).differs, false);
  const d = integrateRow(x, [{ id: "10", bid: 8 }]);
  assert.equal(d.differs, true);
  assert.equal(d.prefill, null);
  assert.equal(d.availableBid, 8);
});

test("applyIntegration ticks the drop and sets the bid, then the plan is fresh", () => {
  const plan = { bids: [], drops: [{ id: "1", name: "D1", willing: false }, { id: "2", name: "D2", willing: false }], edits: { a: 1 }, order: ["x"], unselected: ["y"], dupOn: ["z"] };
  const out = applyIntegration(plan, [{ x: ex("t1", "10", "1", 5), bid: 6 }], (id) => ({ name: `N${id}`, pos: "RB" }), setBid);
  assert.deepEqual(out.drops.map((d) => d.willing), [true, false]);
  assert.deepEqual(out.bids, [{ id: "10", name: "N10", pos: "RB", bid: 6 }]);
  assert.deepEqual(out.order, []);
  assert.deepEqual(out.unselected, []);
});

test("planSignature changes with bids and drop ticks, not with order/edits; freshPlan clears manual changes", () => {
  const a = { bids: [{ id: "1", bid: 5 }], drops: [{ id: "2", willing: true }], edits: {}, order: [] };
  assert.equal(planSignature(a), planSignature({ ...a, order: ["k"], edits: { k: { bid: 1 } } }));
  assert.notEqual(planSignature(a), planSignature({ ...a, bids: [{ id: "1", bid: 6 }] }));
  assert.notEqual(planSignature(a), planSignature({ ...a, drops: [{ id: "2", willing: false }] }));
  const f = freshPlan({ ...a, edits: { k: 1 }, order: ["k"], unselected: ["k"], custom: [{ key: "c" }] });
  assert.deepEqual([f.edits, f.order, f.unselected], [{}, [], []]);
  assert.equal(f.custom.length, 1);
});

// ---------------- P-34 (v4.17.1) ----------------
test("ticker summary carries slot, slotOrder, kickoffAt and stats in a stable order", () => {
  const k = Date.parse("2026-11-08T18:00:00Z");
  const l = league({ ticker: { myRosterId: 1, oppRosterId: 2,
    my: [P("2", 5, "in", { slot: "WR", slotOrder: 2, kickoff: k, stats: { rec: 3, recYds: 40, recTd: 0 } }), P("1", 7, "in", { slot: "QB", slotOrder: 0, kickoff: k, stats: null })],
    opp: [P("3", 0, "pre", { slot: "RB", slotOrder: 1, kickoff: null })], myBench: [P("4", 0, "pre", { slot: "BN", slotOrder: null })], oppBench: [] } });
  const s = buildSummary(buildFrame(raw([l])), { bench: true });
  const pl = s.leagues[0].players;
  assert.deepEqual(pl.map((p) => p.playerId), ["1", "2", "4", "3"]); // mine by slot, mine bench, then opponent
  assert.equal(pl[0].slot, "QB");
  assert.equal(pl[1].kickoffAt, "2026-11-08T18:00:00.000Z");
  assert.deepEqual(pl[1].stats, { rec: 3, recYds: 40, recTd: 0 });
  assert.equal(pl[3].kickoffAt, null);
  assert.equal(pl[2].slotOrder, null);
});
