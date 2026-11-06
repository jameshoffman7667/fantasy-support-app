// v4.16: pending-move check schedule, IR drops with a swap, manual moves held, news matching, per-source notes, slot order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReason } from "../server/pendingMoves.js";
import { newsIsAbout, parseEspnNews } from "../server/playerCard.js";
import { cleanNotes, linkFor, linkNotes, applyRemovals } from "../server/aiSources.js";
import { parseHype, parseStartSit, parseTradeIdeas } from "../server/gemini.js";
import { buildPush, changeTouchesPlayers, dropOptions, heldPlayerIds, irSwapCandidate } from "../client/src/rosterChanges.js";
import { slotLabelsChronological } from "../client/src/gameDayCheer.js";

// ---- P-29 ----
const Z = (s) => Date.parse(s); // EST is UTC-5 from 2026-11-01
test("P-29: 12:30 PM Toronto on a non-Sunday opens a check, once-only key per date", () => {
  assert.equal(checkReason(Z("2026-11-09T17:30:00Z"), []), "noon:2026-11-09"); // Monday 12:30
  assert.equal(checkReason(Z("2026-11-09T17:40:00Z"), []), "noon:2026-11-09"); // still inside the 15 minutes
  assert.equal(checkReason(Z("2026-11-09T17:50:00Z"), []), null);
  assert.equal(checkReason(Z("2026-11-09T17:20:00Z"), []), null);
});
test("P-29: no 12:30 check on Sunday", () => {
  assert.equal(checkReason(Z("2026-11-08T17:30:00Z"), []), null);
});
test("P-29: 1 hour before a kickoff window, every day", () => {
  const k = Z("2026-11-08T18:00:00Z"); // Sunday 1 PM
  assert.equal(checkReason(k - 58 * 60000, [k]), `kick:${k}`); // Sunday 12:02 PM
  assert.equal(checkReason(k - 50 * 60000, [k]), `kick:${k}`);
  assert.equal(checkReason(k - 40 * 60000, [k]), null);
  assert.equal(checkReason(k - 65 * 60000, [k]), null);
  const thu = Z("2026-11-13T01:15:00Z"); // Thursday 8:15 PM
  assert.equal(checkReason(thu - 55 * 60000, [thu]), `kick:${thu}`);
});
test("P-29: a quiet time of day has no check", () => {
  assert.equal(checkReason(Z("2026-11-10T20:00:00Z"), []), null);
});

// ---- P-26 ----
const P = (id, pos, proj, extra = {}) => ({ id, name: `P${id}`, pos, team: "AAA", proj, value: null, irEligible: false, ...extra });
const league = (over = {}) => ({
  leagueType: "redraft",
  starterIds: ["1", "3"],
  starters: [{ slot: "QB", player: P("1", "QB", 20) }, { slot: "WR", player: P("3", "WR", 12) }],
  bench: [P("4", "RB", 8, { irEligible: true }), P("7", "WR", 15, { irEligible: true }), P("8", "TE", 2)],
  ir: [P("5", "WR", 0), P("9", "RB", 0)], reserveIds: ["5", "9"], taxi: [],
  ...over,
});
test("P-26: IR players are drop candidates only when an IR-eligible bench player can take the spot", () => {
  const opts = dropOptions(league(), { slotIndex: 1 }, {}, null);
  assert.ok(opts.some((o) => o.id === "5" && o.irSwap));
  const noElig = league({ bench: [P("8", "TE", 2)] });
  assert.ok(!dropOptions(noElig, { slotIndex: 1 }, {}, null).some((o) => o.id === "5" || o.id === "9"));
});
test("P-26: the HIGHEST-ranked IR-eligible bench player goes into IR", () => {
  assert.equal(irSwapCandidate(league(), {}, null).inId, "7"); // 15 beats 8
  const dyn = league({ leagueType: "dynasty", bench: [P("4", "RB", 8, { irEligible: true, value: 900 }), P("7", "WR", 15, { irEligible: true, value: 100 })] });
  assert.equal(irSwapCandidate(dyn, {}, null).inId, "4");
});
test("P-26: two adds never use the same IR replacement", () => {
  const plans = { A: { dropId: "5", irSwap: { inId: "7", inName: "P7" } } };
  assert.equal(irSwapCandidate(league(), plans, "B").inId, "4");
  assert.equal(irSwapCandidate(league(), plans, "A").inId, "7");
});
const addChange = { key: "A:1:50", type: "add", slotIndex: 1, slot: "WR", fromId: "3", fromName: "P3", toId: "50", toName: "New Guy", delta: 3, blocked: null };
test("P-26: pushing an add that drops an IR player sends IR out, IR in, then the add", () => {
  const lg = league();
  const plan = { kind: "fa", bid: 0, dropId: "5", dropName: "P5", irSwap: { inId: "7", inName: "P7" } };
  const out = buildPush(lg, [{ ...addChange, plan }], new Set([addChange.key]));
  assert.deepEqual(out.errors, []);
  const a = out.adds[0];
  assert.equal(a.dropId, "5");
  assert.deepEqual(a.irSwap.outReserve, ["9"]);
  assert.deepEqual(a.irSwap.inReserve, ["9", "7"]);
  assert.match(out.summary.join(" "), /comes off IR to the bench and P7 takes the IR spot/);
});
test("P-26: the swap is refused when the replacement left the bench or the drop left IR", () => {
  const plan = { kind: "fa", bid: 0, dropId: "5", dropName: "P5", irSwap: { inId: "99", inName: "Gone" } };
  assert.ok(buildPush(league(), [{ ...addChange, plan }], new Set([addChange.key])).errors.length);
  const plan2 = { kind: "fa", bid: 0, dropId: "42", dropName: "Nobody", irSwap: { inId: "7", inName: "P7" } };
  assert.ok(buildPush(league(), [{ ...addChange, plan: plan2 }], new Set([addChange.key])).errors.length);
});
test("P-26: an IR replacement that a ticked move also starts is an error", () => {
  const plan = { kind: "fa", bid: 0, dropId: "5", dropName: "P5", irSwap: { inId: "7", inName: "P7" } };
  const start7 = { key: "L:0:7", type: "lineup", slotIndex: 0, slot: "QB", fromId: "1", fromName: "P1", toId: "7", toName: "P7", delta: 1, blocked: null };
  const out = buildPush(league(), [start7, { ...addChange, plan }], new Set([start7.key, addChange.key]));
  assert.ok(out.errors.some((e) => /take an IR spot/.test(e)));
});
test("P-26: a plain bench drop is unchanged (no swap)", () => {
  const plan = { kind: "fa", bid: 0, dropId: "8", dropName: "P8" };
  const out = buildPush(league(), [{ ...addChange, plan }], new Set([addChange.key]));
  assert.equal(out.adds[0].irSwap, null);
  assert.equal(out.reserve, null);
});

// ---- P-30 ----
test("P-30: players he moved in by hand are held, and no suggestion may touch them", () => {
  const custom = { key: "C:1:4:b", type: "custom", slotIndex: 1, fromId: "3", toId: "4", otherSlot: null };
  const held = heldPlayerIds([custom, { type: "lineup", toId: "9" }]);
  assert.deepEqual([...held], ["4"]);
  const reverse = { type: "lineup", fromId: "4", toId: "3" }; // starts the benched player again in place of the one he chose
  const unrelated = { type: "lineup", fromId: "1", toId: "8" };
  assert.ok(changeTouchesPlayers(reverse, held));
  assert.ok(!changeTouchesPlayers(unrelated, held));
});
test("P-30: a hand-made swap holds both players", () => {
  const sw = { type: "custom", slotIndex: 0, otherSlot: 2, fromId: "1", toId: "3" };
  assert.deepEqual([...heldPlayerIds([sw])].sort(), ["1", "3"]);
});

// ---- P-27 ----
const feed = (items) => ({ feed: items });
test("P-27: an item tagged to our player is kept; one tagged only to others is dropped", () => {
  const who = { espnId: "3043078", name: "Derrick Henry" };
  assert.ok(newsIsAbout({ headline: "Henry runs wild", categories: [{ type: "athlete", athleteId: 3043078 }] }, who));
  assert.ok(!newsIsAbout({ headline: "Lamar Jackson sits", categories: [{ type: "athlete", athleteId: 3916387 }] }, who));
});
test("P-27: a multi-player item needs his name in the text", () => {
  const who = { espnId: "1", name: "Derrick Henry" };
  const both = (text) => ({ headline: text, story: text, categories: [{ type: "athlete", athleteId: 1 }, { type: "athlete", athleteId: 2 }] });
  assert.ok(newsIsAbout(both("Derrick Henry and Lamar Jackson split carries"), who));
  assert.ok(!newsIsAbout(both("Lamar Jackson questionable"), who));
});
test("P-27: untagged items need his full name or initial + last name", () => {
  const who = { espnId: "1", name: "Derrick Henry" };
  assert.ok(newsIsAbout({ headline: "D. Henry limited in practice" }, who));
  assert.ok(newsIsAbout({ headline: "Report: Derrick Henry on track" }, who));
  assert.ok(!newsIsAbout({ headline: "Henry Ruggs case update" }, who));
  assert.ok(!newsIsAbout({ headline: "Ravens RB room" }, who));
});
test("P-27: parse keeps only his items, drops repeats, carries the link", () => {
  const who = { espnId: "1", name: "Derrick Henry" };
  const out = parseEspnNews(feed([
    { headline: "Henry out", story: "x", published: "2026-11-01T00:00:00Z", categories: [{ type: "athlete", athleteId: 1 }], links: { web: { href: "https://espn.com/a" } } },
    { headline: "Henry out", story: "dup", published: "2026-11-02T00:00:00Z", categories: [{ type: "athlete", athleteId: 1 }] },
    { headline: "Someone else", categories: [{ type: "athlete", athleteId: 5 }] },
  ]), who);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://espn.com/a");
});

// ---- P-28 ----
test("P-28: cleanNotes keeps Gemini's detail and still lists plain source names", () => {
  const n = cleanNotes([{ source: "FantasyPros", detail: "Calls him a top-10 RB." }], ["FantasyPros", "ESPN"]);
  assert.equal(n.length, 2);
  assert.equal(n[0].detail, "Calls him a top-10 RB.");
  assert.equal(n[1].detail, null);
  assert.deepEqual(cleanNotes(null, []), []);
});
test("P-28: a source's link is the grounding link whose site matches its name", () => {
  const g = [{ title: "fantasypros.com", uri: "https://g/1" }, { title: "reddit.com", uri: "https://g/2" }, { title: "x.com", uri: "https://g/3" }];
  assert.equal(linkFor("FantasyPros", g), "https://g/1");
  assert.equal(linkFor("r/DynastyFF", g), "https://g/2");
  assert.equal(linkFor("@someone", g), "https://g/3");
  assert.equal(linkFor("Obscure Blog", g), null);
  const item = linkNotes({ sourceNotes: cleanNotes([{ source: "FantasyPros", detail: "d" }]) }, g);
  assert.equal(item.sourceNotes[0].url, "https://g/1");
});
test("P-28: the parsers carry sourceNotes", () => {
  const h = parseHype([{ name: "A B", pos: "WR", sources: ["ESPN"], sourceNotes: [{ source: "ESPN", detail: "d" }] }]);
  assert.equal(h[0].sourceNotes[0].detail, "d");
  const t = parseTradeIdeas([{ name: "A B", pos: "WR", direction: "for", sources: ["ESPN"], sourceNotes: [{ source: "ESPN", detail: "d" }] }]);
  assert.equal(t[0].sourceNotes[0].detail, "d");
  const s = parseStartSit([{ name: "A B", pos: "WR", startVotes: 2, sitVotes: 0, sources: ["ESPN"], sourceNotes: [{ source: "ESPN", detail: "d" }] }], [{ id: "9", name: "A B", pos: "WR" }]);
  assert.equal(s["9"].sourceNotes[0].detail, "d");
});
test("P-28: a removed source disappears from the notes too", () => {
  const out = { players: [{ name: "A", mentions: 2, sources: ["ESPN", "Bad Site"], sourceNotes: [{ source: "ESPN", detail: "x" }, { source: "Bad Site", detail: "y" }] }] };
  const res = applyRemovals("hype", out, ["Bad Site"]);
  assert.deepEqual(res.players[0].sourceNotes.map((n) => n.source), ["ESPN"]);
});

// ---- P-31 ----
test("P-31: game slots are listed earliest kickoff first, unknown times last", () => {
  const ps = [
    { kickoffLabel: "Sun 4:25 PM", kickoff: 300 }, { kickoffLabel: "Thu 8:15 PM", kickoff: 100 }, { kickoffLabel: "Kickoff time unavailable", kickoff: null },
    { kickoffLabel: "Sun 1:00 PM", kickoff: 200 }, { kickoffLabel: "Sun 1:00 PM", kickoff: 200 }, { kickoffLabel: "Mon 8:15 PM", kickoff: 400 },
  ];
  assert.deepEqual(slotLabelsChronological(ps), ["Thu 8:15 PM", "Sun 1:00 PM", "Sun 4:25 PM", "Mon 8:15 PM", "Kickoff time unavailable"]);
});
