// v4.20.0 (P-48): projection model, ticker fields, tokens, ticker role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gameProgress, liveProjection, playerView, mirrorColour } from "../server/projection.js";
import * as client from "../client/src/livePace.js";
import { buildFrame, buildSummary, tickerRoleAllows, rateLimit } from "../server/ticker.js";

const root = new URL("../", import.meta.url).pathname;
const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test("live projection: starts at the projection, ends at the actual, p-squared blend, never below the actual", () => {
  near(liveProjection(0, 20, 0), 20);
  near(liveProjection(33, 20, 1), 33);
  near(liveProjection(6, 20, 0.5), 15); // 6 + 0.5 x (0.5 x 6 + 0.75 x 20)
  near(liveProjection(7, 20, 0.03), 26.6, 0.1); // the early-touchdown case James looked at
  near(liveProjection(16, 20, 0.5), 27.5);
  near(liveProjection(10, 20, 0.75), 14.1, 0.05);
  assert.ok(liveProjection(-2, 20, 0.5) >= -2);
  assert.equal(liveProjection(5, null, 0.5), null);
  assert.equal(liveProjection(12, 8, null), 12); // unreadable progress: the larger of points and projection
  assert.equal(liveProjection(3, 8, null), 8);
});

test("player view: expected final by state, colour by the 5 % rule against the projection", () => {
  assert.deepEqual(playerView({ state: "pre", points: null, proj: 12 }), { projection: 12, liveProjection: null, actual: null, expected: 12, colour: "" });
  assert.equal(playerView({ state: "pre", points: 0, proj: 12 }).colour, ""); // none before kickoff
  assert.equal(playerView({ state: "in", points: 14, proj: 20, statusDetail: "Halftime" }).colour, "green");
  assert.equal(playerView({ state: "in", points: 7, proj: 20, statusDetail: "Halftime" }).colour, "red"); // behind a 10-point halftime pace
  assert.equal(playerView({ state: "in", points: 0, proj: 20, statusDetail: "End of 3rd" }).colour, "red");
  assert.equal(playerView({ state: "in", points: 5, proj: 20, statusDetail: "14:50 - 1st" }).liveProjection > 20, true);
  assert.equal(playerView({ state: "in", points: 3, proj: 20, statusDetail: "" }).colour, "amber"); // fallback: max(points, projection) equals the projection
  assert.equal(playerView({ state: "post", points: 30, proj: 20 }).colour, "green");
  assert.equal(playerView({ state: "post", points: 8, proj: 20 }).colour, "red");
  assert.equal(playerView({ state: "post", points: 20, proj: 20 }).colour, "amber");
  assert.equal(playerView({ state: "post", points: 9, proj: null }).colour, "");
  assert.equal(playerView({ state: "post", points: 9, proj: null }).expected, 9);
  assert.equal(mirrorColour("green"), "red");
  assert.equal(mirrorColour("red"), "green");
  assert.equal(mirrorColour("amber"), "amber");
});

test("the browser copy of the model gives the same answers as the server copy", () => {
  for (const detail of ["", "Halftime", "End of 1st", "9:30 - 2nd", "2:00 - 4th", "Final/OT"]) assert.equal(client.gameProgress(detail), gameProgress(detail));
  for (const state of ["pre", "in", "post"]) for (const pts of [null, 0, 4.2, 18, 31]) for (const proj of [null, 0, 9.5, 20]) for (const d of ["", "Halftime", "3:10 - 1st", "1:00 - 4th"]) {
    assert.deepEqual(client.playerView({ state, points: pts, proj, statusDetail: d }), playerView({ state, points: pts, proj, statusDetail: d }), `${state} ${pts} ${proj} ${d}`);
  }
});

const P = (id, pts, state, proj, extra = {}) => ({ id, name: `P${id}`, pos: "WR", team: "KC", pts, proj, state, statusDetail: state === "in" ? "Halftime" : null, ...extra });
const raw = () => ({ season: 2026, week: 10, leagues: [{
  id: "L1", name: "One", color: "green", include: true, myPoints: 20, myProjected: 100, oppPoints: 15, oppProjected: 90, myProjection: 96, oppProjection: 92, myRemaining: 40, oppRemaining: 30, threshold: 6,
  ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 14, "in", 20), P("2", null, "pre", 12)], opp: [P("3", 30, "post", 20)], myBench: [P("4", 0, "pre", 5)], oppBench: [] },
}, {
  id: "L2", name: "Two", color: "yellow", include: true, myPoints: 1, myProjected: 10, oppPoints: 1, oppProjected: 10,
  ticker: { myRosterId: 1, oppRosterId: 2, my: [P("1", 0, "pre", 10)], opp: [], myBench: [], oppBench: [] },
}] });

test("ticker summary: projection, liveProjection, projected (expected final), colours; league colour for me, its mirror for the opponent", () => {
  const sum = buildSummary(buildFrame(raw()), { bench: true });
  const l = sum.leagues[0];
  assert.deepEqual([l.mine.projectedColour, l.opp.projectedColour, l.colour], ["green", "red", "green"]);
  assert.equal(l.mine.projection, 96);
  assert.equal(l.mine.projected, 100); // unchanged: the team expected final from Game Day
  const live = l.players.find((p) => p.playerId === "1");
  assert.equal(live.points, 14); assert.equal(live.projection, 20); assert.ok(live.liveProjection > 20 && live.projected === live.liveProjection); assert.equal(live.projectedColour, "green");
  const pre = l.players.find((p) => p.playerId === "2");
  assert.deepEqual([pre.projection, pre.liveProjection, pre.projected, pre.projectedColour], [12, null, 12, ""]);
  const fin = l.players.find((p) => p.playerId === "3");
  assert.deepEqual([fin.points, fin.projection, fin.liveProjection, fin.projected, fin.projectedColour], [30, 20, null, 30, "green"]);
  assert.equal(sum.leagues[1].colour, "amber"); assert.equal(sum.leagues[1].opp.projectedColour, "amber");
  for (const k of ["colourBasis", "status", "name", "leagueId"]) assert.ok(k in l, `${k} kept`);
  for (const k of ["slot", "slotOrder", "kickoffAt", "stats", "gameStatus", "gameClock", "starter", "side"]) assert.ok(k in live, `${k} kept`);
  // a league the user switched off for the ticker is left out
  assert.equal(buildFrame(raw(), { exclude: new Set(["L2"]) }).leagues.length, 1);
});

test("ticker role: the only API paths it may use; per-token rate limit", () => {
  for (const p of ["/api/ticker-sync", "/api/ticker-sync/tokens/ab12", "/api/login", "/api/logout", "/api/auth/status", "/api/account/password", "/api/ticker/summary", "/api/headshot/4881"]) assert.ok(tickerRoleAllows(p), p);
  for (const p of ["/api/gameday", "/api/leagues/build", "/api/admin/users", "/api/admin/ticker", "/api/ticker-token", "/api/trade/x", "/api/ticker-syncx", "/api/pending-moves", "/api/audit-log"]) assert.ok(!tickerRoleAllows(p), p);
  const t0 = 1_000_000;
  for (let i = 0; i < 120; i++) assert.equal(rateLimit("h1", t0 + i, 120).ok, true);
  const over = rateLimit("h1", t0 + 500, 120);
  assert.equal(over.ok, false); assert.ok(over.retryAfter >= 1 && over.retryAfter <= 60);
  assert.equal(rateLimit("h2", t0 + 500, 120).ok, true); // another token is separate
  assert.equal(rateLimit("h1", t0 + 61_000, 120).ok, true); // next minute
});

const serverDir = path.join(root, "server");
const hasDeps = fs.existsSync(path.join(serverDir, "node_modules", "express"));
test("ticker role end to end: cap, 403 everywhere else, own tokens (hashed, scoped, revocable), admin view, disable", { skip: hasDeps ? false : "run `npm install --prefix server` first" }, async () => {
  const port = 5100 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ticker-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: serverDir, env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), OWNER_USERNAME: "testowner", OWNER_PASSWORD: "longenough1", SLEEPER_BASE: "http://127.0.0.1:9" } });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, { cookie, body, bearer } = {}) => {
    const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: j, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
  };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch { await new Promise((s) => setTimeout(s, 150)); } }
    const login = async (u, p) => { const r = await call("POST", "/api/login", { body: { username: u, password: p } }); assert.equal(r.status, 200, `${u} login`); return r.cookie; };
    let owner = await login("testowner", "longenough1");
    const pw = await call("POST", "/api/account/password", { cookie: owner, body: { currentPassword: "longenough1", newPassword: "newlongenough2" } });
    assert.equal(pw.status, 200); owner = await login("testowner", "newlongenough2");
    // cap defaults to 0: no ticker users yet
    assert.equal((await call("GET", "/api/admin/ticker", { cookie: owner })).body.cap, 0);
    const refused = await call("POST", "/api/admin/users", { cookie: owner, body: { username: "tick1", role: "ticker", password: "tickerpass1" } });
    assert.equal(refused.status, 400); assert.match(refused.body.error, /switched off|limit/i);
    assert.equal((await call("POST", "/api/admin/ticker/cap", { cookie: owner, body: { cap: 1 } })).body.cap, 1);
    const made = await call("POST", "/api/admin/users", { cookie: owner, body: { username: "tick1", role: "ticker", password: "tickerpass1" } });
    assert.equal(made.status, 200); assert.equal(made.body.user.role, "ticker");
    assert.equal((await call("POST", "/api/admin/users", { cookie: owner, body: { username: "tick2", role: "ticker", password: "tickerpass2" } })).status, 400); // cap of 1 reached
    let t = await login("tick1", "tickerpass1");
    assert.equal((await call("POST", "/api/account/password", { cookie: t, body: { currentPassword: "tickerpass1", newPassword: "tickerpass9" } })).status, 200);
    t = await login("tick1", "tickerpass9");
    // 403 on the main app, the admin side and other users' data
    for (const [m, u] of [["GET", "/api/gameday"], ["GET", "/api/leagues/cached"], ["GET", "/api/admin/users"], ["GET", "/api/admin/ticker"], ["GET", "/api/audit-log"], ["GET", "/api/ticker-token"], ["POST", "/api/pending-moves"], ["GET", "/api/trade/x"]]) {
      const r = await call(m, u, { cookie: t });
      assert.equal(r.status, 403, `${m} ${u}`); assert.equal(r.body.code, "ticker_only");
    }
    assert.equal((await call("GET", "/api/auth/status", { cookie: t })).body.user.role, "ticker");
    // its own page: status, tokens
    const st = await call("GET", "/api/ticker-sync", { cookie: t });
    assert.equal(st.status, 200); assert.deepEqual([st.body.linked, st.body.leagues, st.body.tokens, st.body.scope], [true, [], [], "ticker:read"]);
    assert.equal((await call("POST", "/api/ticker-sync/tokens", { cookie: t, body: { name: "" } })).status, 400);
    const c1 = await call("POST", "/api/ticker-sync/tokens", { cookie: t, body: { name: "Living room TV" } });
    assert.equal(c1.status, 200);
    const plain = c1.body.created.token;
    assert.match(plain, /^fmt_/); assert.equal(c1.body.created.last4, plain.slice(-4)); assert.equal(c1.body.created.scope, "ticker:read");
    const again = await call("GET", "/api/ticker-sync", { cookie: t });
    assert.ok(!JSON.stringify(again.body).includes(plain), "the plain token is never shown again");
    assert.deepEqual(again.body.tokens.map((x) => [x.name, x.last4]), [["Living room TV", plain.slice(-4)]]);
    // stored hashed only
    const dbText = fs.readdirSync(dataDir).filter((f) => f.endsWith(".db") || f.endsWith(".sqlite") || f.includes("fantasy")).map((f) => fs.readFileSync(path.join(dataDir, f)).toString("latin1")).join("");
    assert.ok(dbText.length > 0 && !dbText.includes(plain), "the plain token is not in the database");
    // the token reads the ticker API (own leagues: none yet) and nothing else
    assert.equal((await call("GET", "/api/ticker/health", { bearer: plain })).status, 200);
    const sum = await call("GET", "/api/ticker/summary", { bearer: plain });
    assert.equal(sum.status, 200); assert.deepEqual(sum.body.leagues, []);
    for (const u of ["/api/gameday", "/api/admin/users", "/api/ticker-sync"]) assert.equal((await call("GET", u, { bearer: plain })).status, 401, `token on ${u}`);
    assert.equal((await call("GET", "/api/ticker/health", { bearer: "fmt_nope_nope_nope_nope_nope" })).status, 401);
    // admin view shows the ticker user, its token use, and the 403s are in the audit log
    const adm = (await call("GET", "/api/admin/ticker", { cookie: owner })).body;
    assert.equal(adm.users.length, 1); assert.equal(adm.users[0].username, "tick1"); assert.equal(adm.users[0].tokens[0].last4, plain.slice(-4)); assert.ok(adm.users[0].lastTokenUseAt);
    const audit = (await call("GET", "/api/audit-log?kind=ticker&limit=100", { cookie: owner })).body.entries.map((e) => e.action);
    assert.ok(audit.includes("Ticker token created")); assert.ok(audit.includes("Blocked (ticker account)"));
    // revoke: the token stops; disable: the account's tokens stop and its login is refused
    const c2 = await call("POST", "/api/ticker-sync/tokens", { cookie: t, body: { name: "Second" } });
    const id1 = again.body.tokens[0].id;
    assert.equal((await call("DELETE", `/api/ticker-sync/tokens/${id1}`, { cookie: t })).status, 200);
    assert.equal((await call("GET", "/api/ticker/health", { bearer: plain })).status, 401);
    assert.equal((await call("GET", "/api/ticker/health", { bearer: c2.body.created.token })).status, 200);
    assert.equal((await call("POST", "/api/admin/users/tick1/access", { cookie: owner, body: { active: false } })).status, 200);
    assert.equal((await call("GET", "/api/ticker/health", { bearer: c2.body.created.token })).status, 401);
    assert.equal((await call("POST", "/api/login", { body: { username: "tick1", password: "tickerpass9" } })).status, 403);
    const audit2 = (await call("GET", "/api/audit-log?kind=ticker&limit=100", { cookie: owner })).body.entries.map((e) => e.action);
    assert.ok(audit2.includes("Ticker token revoked"));
  } finally {
    child.kill("SIGKILL");
  }
});

import { statusTags } from "../client/src/ui/compute.js";
test("P-44: Out and Bye tags by player id (Bye wins, Doubtful/healthy get none)", () => {
  const tags = statusTags({
    starters: [{ player: { id: "1", name: "A", status: "Out" } }, { player: { id: "2", name: "B", status: "Questionable" } }],
    bench: [{ id: "3", name: "C", status: "Bye" }, { id: "4", name: "D", kickoffLabel: "On bye" }, { id: "5", name: "E", status: "Doubtful" }],
    ir: [{ id: "6", name: "F", status: "Out" }], taxi: [], freeAgents: [{ id: "7", name: "G", status: "Out" }],
  });
  assert.deepEqual([...tags.entries()].sort(), [["1", "Out"], ["3", "Bye"], ["4", "Bye"], ["6", "Out"], ["7", "Out"]]);
});

import { compareToRoster } from "../client/src/ui/compute.js";
test("P-45: one variance names every starter (or bench player) the free agent beats, weakest first", () => {
  const pl = (id, name, pos, proj, extra = {}) => ({ id, name, pos, proj, ...extra });
  const league = {
    id: "L", roster_positions: [], leagueType: "redraft",
    starters: [{ slot: "WR", player: pl("1", "Lee", "WR", 11) }, { slot: "WR", player: pl("2", "Smith", "WR", 8) }, { slot: "FLEX", player: pl("3", "Jones", "WR", 9.5) }, { slot: "RB", player: pl("4", "Back", "RB", 20) }, { slot: "WR", player: pl("8", "Gone", "WR", 1, { kickoffLabel: "On bye" }) }],
    bench: [pl("5", "Cole", "WR", 4.2), pl("6", "Park", "WR", 6.1), pl("7", "Diaz", "WR", 13)],
  };
  const fa = pl("9", "New", "WR", 12.1);
  const r = compareToRoster(league, fa);
  assert.equal(r.rule, "Free agent outprojects a starter"); assert.equal(r.severity, "major");
  assert.equal(r.note, "projected 12.1 vs Smith 8.0 at WR, Jones 9.5 at FLEX, Lee 11.0 at WR"); // the bye starter and the stronger RB are left out
  const bench = compareToRoster({ ...league, starters: [{ slot: "WR", player: pl("1", "Lee", "WR", 30) }] }, pl("9", "New", "WR", 9));
  assert.equal(bench.rule, "Free agent outprojects a bench player"); assert.equal(bench.severity, "minor");
  assert.equal(bench.note, "projected 9.0 vs bench Cole 4.2, Park 6.1"); // Diaz (13) is not beaten
  const dyn = compareToRoster({ ...league, leagueType: "dynasty", starters: [], bench: [pl("5", "Cole", "WR", 1, { value: 120 }), pl("6", "Park", "WR", 1, { value: 200 }), pl("7", "Diaz", "WR", 1, { value: 900 })] }, pl("9", "New", "WR", 5, { value: 310 }));
  assert.equal(dyn.note, "dynasty value 310 vs bench Cole 120, Park 200");
  assert.equal(compareToRoster(league, pl("9", "Low", "WR", 1)).rule, null);
});

import { majorItems, majorKeys, minorKeys, tickedItems, ackKey } from "../client/src/variances.js";
test("P-42 / P-43: major keys carry the red suffix; only ticked variances are cleared; cleared and grey ones are never included", () => {
  const v = (key, severity, cleared = false) => ({ key, severity, cleared, rule: "R", subject: key, league: "L" });
  const all = [v("a", "major"), v("b", "major"), v("b", "major"), v("c", "major", true), v("d", "minor"), v("e", "minor"), v("f", "info")];
  assert.deepEqual(majorKeys(all), ["a|RED", "b|RED"]); // duplicates collapse, cleared reds are left out
  assert.equal(majorItems(all).length, 2);
  assert.deepEqual(minorKeys(all), ["d", "e"]);
  const unticked = new Set(["a|RED", "e"]);
  assert.deepEqual(tickedItems(all, "major", unticked).map(ackKey), ["b|RED", "b|RED"].slice(0, 2));
  assert.deepEqual(tickedItems(all, "minor", unticked).map(ackKey), ["d"]);
  assert.deepEqual(tickedItems(all, "minor", new Set()).map(ackKey), ["d", "e"]); // default: everything ticked
});

import { dropRankMetric as dropMetric, dropPool, orderDrops } from "../client/src/waiverPlan.js";
test("P-36: drop candidates rank by projection, a bye player's rest-of-season average, or dynasty value", () => {
  const league = { leagueType: "redraft", ros: { from: 10, to: 17, loaded: 8 }, starters: [{ slot: "WR", player: { id: "s1", name: "Start", proj: 15 } }],
    bench: [{ id: "b1", name: "Bye guy", proj: 0, status: "Bye", ros: 70, bye: 10 }, { id: "b2", name: "Low", proj: 3 }, { id: "b3", name: "Bye none", proj: 0, kickoffLabel: "On bye", bye: 10 }, { id: "b4", name: "Mid", proj: 6 }] };
  assert.deepEqual(dropMetric(league.bench[0], league), { value: 10, kind: "ros" }); // 70 over the 7 weeks that are not the bye
  assert.deepEqual(dropMetric(league.bench[2], league), { value: null, kind: "ros" });
  const pool = dropPool(league);
  assert.deepEqual(pool.map((p) => p.id), ["b2", "b4", "b1", "b3", "s1"]); // bench by number (bye with no number last in the bench), then starters
  assert.deepEqual(orderDrops([{ id: "b3" }, { id: "b1" }, { id: "b2" }], pool).map((d) => d.id), ["b2", "b1", "b3"]);
  const dyn = { leagueType: "dynasty", starters: [], bench: [{ id: "a", name: "A", value: 900, proj: 1 }, { id: "b", name: "B", value: 120, proj: 20 }, { id: "c", name: "C", proj: 5 }] };
  assert.deepEqual(dropPool(dyn).map((p) => p.id), ["b", "a", "c"]); // lowest dynasty value first, no value last
  assert.equal(dropPool(dyn)[0].dropKind, "dynasty");
});

import { layerChanges, toggle } from "../client/src/rosterChanges.js";
test("P-47: unticking the flex/bench move still offers the flex-timing swap, and the two conflict", () => {
  const future = (h) => Date.now() + h * 3600 * 1000;
  const pl = (id, name, pos, proj, kickoff) => ({ id, name, pos, proj, kickoff, kickoffLabel: `in ${kickoff}` });
  const flexP = pl("f", "Flex Early", "WR", 8, future(2)); // kicks off earlier than the positional starter
  const wrP = pl("w", "WR Late", "WR", 14, future(30));
  const benchB = pl("b", "Bench Better", "RB", 12, future(26));
  const league = {
    id: "L", starters: [{ slot: "WR", player: wrP }, { slot: "FLEX", player: flexP }], bench: [benchB], ir: [], taxi: [],
  };
  const move = { key: "L:1:b", type: "lineup", slotIndex: 1, slot: "FLEX", fromId: "f", fromName: "Flex Early", toId: "b", toName: "Bench Better", delta: 4, blocked: null };
  // ticked: the swap is not offered at the first layer (the flex player is replaced)
  const on = layerChanges(league, [move], new Set([move.key]));
  assert.equal(on.changes.filter((c) => c.type === "swap").length, 0);
  // unticked: the flex player is still there, so the swap with the later positional starter is suggested
  const off = layerChanges(league, [move], new Set());
  const swap = off.changes.find((c) => c.type === "swap");
  assert.ok(swap, "the flex-timing swap is offered");
  assert.deepEqual([swap.nameA, swap.nameB, swap.slot, swap.slotB_label], ["Flex Early", "WR Late", "FLEX", "WR"]);
  assert.deepEqual(swap.conflicts, [move.key]); assert.equal(swap.parent, undefined);
  // ticking the swap leaves the move unticked; ticking the move unticks the swap
  const withSwap = toggle(off.changes, off.checked, swap.key, true);
  assert.ok(withSwap.has(swap.key) && !withSwap.has(move.key));
  const back = toggle(off.changes, withSwap, move.key, true);
  assert.ok(back.has(move.key) && !back.has(swap.key));
  // and once the move is ticked again the alternative is gone
  assert.equal(layerChanges(league, [move], back).changes.filter((c) => c.type === "swap").length, 0);
  // the swap stays when it is ticked (it must not vanish the moment it is chosen)
  const kept = layerChanges(league, [move], withSwap);
  assert.ok(kept.changes.some((c) => c.key === swap.key) && kept.checked.has(swap.key));
});

import { weekDecision, manualPick } from "../client/src/weekSync.js";
import { advanceWeek, GAME_OVER_MS } from "../server/sleeper.js";
test("P-37: the real week moves the app on after the last game; a hand-picked week stays until the real week changes", () => {
  assert.deepEqual(weekDecision({ real: 11, known: null, shown: 10, manual: null }), { move: null, known: 11, manual: null }); // first reading never moves anything
  assert.equal(weekDecision({ real: 10, known: 10, shown: 10, manual: null }).move, null);
  const moved = weekDecision({ real: 11, known: 10, shown: 10, manual: null });
  assert.deepEqual([moved.move, moved.known, moved.manual], [11, 11, null]); // week 10 ended: load week 11
  const pick = manualPick(8, 10); // he looked back at week 8 by hand
  assert.deepEqual(pick, { realAt: 10 });
  assert.equal(weekDecision({ real: 10, known: 10, shown: 8, manual: pick }).move, null); // kept while the real week is the same
  assert.deepEqual(weekDecision({ real: 11, known: 10, shown: 8, manual: pick }), { move: 11, known: 11, manual: null }); // real week moved: he follows it
  assert.equal(manualPick(10, 10), null); // picking the real week is automatic again
  assert.equal(weekDecision({ real: 11, known: 10, shown: 11, manual: null }).move, null); // already showing it
});
test("P-37: the server's week moves to N+1 once the week's last kickoff + 4 h has passed", () => {
  const st = { season: "2026", season_type: "regular", week: 10 };
  const last = Date.UTC(2026, 10, 17, 1, 15); // Monday night kickoff
  assert.equal(advanceWeek(st, 1, last + GAME_OVER_MS - 1, last).week, 10);
  const after = advanceWeek(st, 1, last + GAME_OVER_MS, last);
  assert.deepEqual([after.week, after.sleeperWeek, after.weekAdvanced], [11, 10, true]);
  assert.equal(advanceWeek({ ...st, week: 18 }, 1, last + GAME_OVER_MS, last).week, 18); // never past 18
  assert.equal(advanceWeek({ ...st, season_type: "post" }, 1, last + GAME_OVER_MS, last).week, 10); // regular season only
});

import * as sl from "../server/sleeper.js";
test("P-39: a confirmed IR edit is kept up to 30 minutes while Sleeper's public roster lags, and dropped when it agrees", () => {
  let t = 1_000_000;
  sl._setNowForTests(() => t);
  const pub = { roster_id: 1, players: ["a", "b", "c"], starters: ["a"], reserve: ["x"], taxi: [] }; // stale: still shows the old IR list
  sl.noteRosterWritten("LG", 1, { reserve: ["x", "b"] });
  assert.deepEqual(sl.effectiveRoster("LG", pub).reserve, ["x", "b"]);
  t += 20 * 60 * 1000; // 20 minutes later the public roster still lags: the confirmed edit still holds (it used to lapse after 5)
  assert.deepEqual(sl.effectiveRoster("LG", pub).reserve, ["x", "b"]);
  t += 11 * 60 * 1000; // past 30 minutes it is forgotten
  assert.deepEqual(sl.effectiveRoster("LG", pub).reserve, ["x"]);
  sl.noteRosterWritten("LG", 1, { reserve: ["x", "b"] });
  const agreed = { ...pub, reserve: ["b", "x"] };
  assert.deepEqual(sl.effectiveRoster("LG", agreed).reserve, ["b", "x"]); // public agrees: the overlay is forgotten
  assert.deepEqual(sl.effectiveRoster("LG", pub).reserve, ["x"]); // so a later change made in Sleeper itself is not hidden
  assert.equal(sl.ROSTER_EDIT_TTL_MS, 30 * 60 * 1000);
  sl._setNowForTests(null);
});

import { defaultGameDayTab, tnfTones } from "../client/src/tnf.js";
test("P-40: default Game Day tab by Eastern time", () => {
  const et = (y, mo, d, h, mi = 0) => { // an Eastern wall time in November 2026 (EST, UTC-5)
    return Date.UTC(y, mo - 1, d, h + 5, mi);
  };
  // 2026-11-17 is a Tuesday
  assert.equal(defaultGameDayTab(et(2026, 11, 17, 2, 59)), "primetime"); // Tue before 3 am
  assert.equal(defaultGameDayTab(et(2026, 11, 17, 3, 0)), "tnf");
  assert.equal(defaultGameDayTab(et(2026, 11, 19, 21)), "tnf"); // Thursday night
  assert.equal(defaultGameDayTab(et(2026, 11, 20, 2, 59)), "tnf"); // Fri before 3 am
  assert.equal(defaultGameDayTab(et(2026, 11, 20, 3, 0)), "cheer");
  assert.equal(defaultGameDayTab(et(2026, 11, 21, 12)), "cheer"); // Saturday
  assert.equal(defaultGameDayTab(et(2026, 11, 22, 13), "waiting"), "cheer"); // Sunday afternoon
  assert.equal(defaultGameDayTab(et(2026, 11, 22, 19), "sunday"), "primetime"); // 4 pm games done
  assert.equal(defaultGameDayTab(et(2026, 11, 22, 19), null), "cheer"); // no stage: clock fallback 8 pm
  assert.equal(defaultGameDayTab(et(2026, 11, 22, 20, 5), null), "primetime");
  assert.equal(defaultGameDayTab(et(2026, 11, 23, 12)), "primetime"); // Monday
});
test("P-40: TNF red/green comparisons, locked players excluded", () => {
  const future = Date.now() + 3600e3, past = Date.now() - 3600e3;
  const P = (id, proj, extra = {}) => ({ id, name: id, proj, kickoff: future, ...extra });
  const entry = {
    thursday: [{ player: P("tb", 9), slot: "BN", group: "bench" }, { player: P("ts", 12), slot: "WR", group: "starter" }],
    lowStarters: [{ player: P("lo", 6), slot: "RB", group: "starter" }, { player: P("hi", 15), slot: "TE", group: "starter" }, { player: P("lk", 2, { kickoff: past }), slot: "QB", group: "starter" }],
    highReserve: [{ player: P("gr", 14), slot: "BN", group: "bench" }, { player: P("lw", 8), slot: "BN", group: "bench" }],
  };
  const t = tnfTones(entry, {});
  assert.deepEqual(t.lowStarters.map((r) => r.tone), ["red", null, null]); // 6 < 9 red; 15 not; locked never
  assert.deepEqual(t.highReserve.map((r) => r.tone), ["green", null]); // 14 > 12 green; 8 not
});

import { dropPool as dp38, freeIrReplacements, reconcileIr, generateClaims as gen38, syncDrops as sd38 } from "../client/src/waiverPlan.js";
test("P-38: IR players are drop candidates while a bench player can take the IR spot; claims carry the IR swap", () => {
  const b = (id, proj, extra = {}) => ({ id, name: `B${id}`, pos: "WR", proj, irEligible: true, ...extra });
  const league = { leagueType: "redraft", starters: [], bench: [b("1", 5), b("2", 9), b("3", 2, { irEligible: false })], ir: [{ id: "ir1", name: "Hurt One", pos: "RB", proj: 0 }, { id: "ir2", name: "Hurt Two", pos: "RB", proj: 0 }], reserveIds: ["ir1", "ir2"] };
  const pool = dp38(league);
  assert.deepEqual(pool.filter((p) => p.where === "ir").map((p) => p.id), ["ir1", "ir2"]);
  // no IR-eligible bench player: IR players are not offered
  assert.equal(dp38({ ...league, bench: [b("3", 2, { irEligible: false })] }).some((p) => p.where === "ir"), false);
  let drops = sd38([], pool).map((d) => (d.id === "ir1" || d.id === "ir2" ? { ...d, willing: true } : d));
  drops = reconcileIr(drops, league);
  const [a1, a2] = drops.filter((d) => d.isIr);
  assert.equal(a1.irIn, "2"); // best free bench player first
  assert.equal(a2.irIn, "1"); // each bench player is used once
  // a third IR drop has nobody left: it is un-ticked
  const three = reconcileIr([...drops, { id: "ir3", name: "H3", pos: "RB", isIr: true, willing: true }], { ...league, ir: [...league.ir, { id: "ir3", name: "H3", pos: "RB" }] });
  assert.equal(three.find((d) => d.id === "ir3").willing, false);
  assert.deepEqual(freeIrReplacements(league, drops, () => false, "ir1").map((p) => p.id), ["2"]); // for ir1, "1" is held by ir2
  const { claims } = gen38({ bids: [{ id: "fa", name: "FA", pos: "RB", bid: 5 }], drops, openSpots: 0 });
  assert.deepEqual(claims[0].irSwap, { inId: "2", inName: "B2" });
  assert.equal(claims[0].dropId, "ir1");
  // an IR drop without a chosen replacement makes no claim
  assert.equal(gen38({ bids: [{ id: "fa", name: "FA", pos: "RB", bid: 5 }], drops: [{ ...a1, irIn: null }], openSpots: 0 }).claims.length, 0);
});

import { projStatLine } from "../server/playerCard.js";
test("P-35: projected stat line maps Sleeper keys to the game-log columns, nothing invented", () => {
  const cols = [{ key: "targets", label: "TGT" }, { key: "receptions", label: "REC" }, { key: "receiving_yards", label: "YD" }, { key: "carries", label: "CAR" }];
  assert.deepEqual(projStatLine({ rec_tgt: 8.04, rec: 5.5, rec_yd: 61.234, gp: 1 }, cols), { targets: 8, receptions: 5.5, receiving_yards: 61.2 });
  assert.equal(projStatLine({ gp: 1 }, cols), null);
  assert.equal(projStatLine(null, cols), null);
});
