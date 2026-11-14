// v4.19.0: Android Back (history) behaviour of pop-ups and menus: client/src/ui/backLayer.js, run against a small
// fake of window.history (entries + index, pushState cutting off forward entries, go(n) firing popstate).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const hasReact = fs.existsSync(new URL("../client/node_modules/react", import.meta.url));
const opts = { skip: hasReact ? false : "run `npm install --prefix client` first" };

let entries, idx, pops;
let mod;
function installFakeWindow() {
  entries = [{ state: { screen: "dashboard" } }];
  idx = 0;
  pops = [];
  const fire = () => pops.push(mod.handlePop({ state: entries[idx].state }));
  globalThis.window = {
    history: {
      get state() { return entries[idx].state; },
      pushState(state) { entries = entries.slice(0, idx + 1); entries.push({ state }); idx += 1; },
      replaceState(state) { entries[idx] = { state }; },
      go(n) { idx = Math.max(0, Math.min(entries.length - 1, idx + n)); fire(); },
    },
  };
  return { back: () => window.history.go(-1) }; // the Android Back gesture
}

beforeEach(async () => {
  if (!hasReact) return;
  mod = await import("../client/src/ui/backLayer.js");
  mod.resetLayers();
});

test("Back closes an open pop-up instead of leaving the screen", opts, () => {
  const { back } = installFakeWindow();
  let closed = 0;
  mod.openLayer(() => closed++);
  assert.equal(mod.layerDepth(), 1);
  back();
  assert.equal(closed, 1);
  assert.equal(mod.layerDepth(), 0);
  assert.deepEqual(pops, [true], "the screen is not changed");
  assert.equal(idx, 0);
});

test("closing a pop-up from the page removes its history entry without calling close or changing the screen", opts, () => {
  installFakeWindow();
  let closed = 0;
  const layer = mod.openLayer(() => closed++);
  mod.closeLayer(layer);
  assert.equal(closed, 0);
  assert.equal(mod.layerDepth(), 0);
  assert.equal(idx, 0);
  assert.deepEqual(pops, [true], "the popstate caused by go() is swallowed");
  // the next real Back is not swallowed
  window.history.pushState({ screen: "league" }, "");
  window.history.go(-1);
  assert.deepEqual(pops, [true, false], "a later Back reaches the app's own screen handling");
});

test("two nested layers: Back closes only the top one", opts, () => {
  const { back } = installFakeWindow();
  const closed = [];
  mod.openLayer(() => closed.push("menu"));
  mod.openLayer(() => closed.push("modal"));
  back();
  assert.deepEqual(closed, ["modal"]);
  assert.equal(mod.layerDepth(), 1);
  back();
  assert.deepEqual(closed, ["modal", "menu"]);
  assert.equal(mod.layerDepth(), 0);
});

test("navigating while a pop-up is open turns its entry into the new screen's entry", opts, () => {
  const { back } = installFakeWindow();
  let closed = 0;
  mod.openLayer(() => closed++);
  assert.equal(entries.length, 2);
  mod.navigateWithLayers({ screen: "league" });
  assert.equal(closed, 1, "the layer is told to close");
  assert.equal(entries.length, 2, "no extra history entry");
  assert.deepEqual(entries[idx].state, { screen: "league" });
  back();
  assert.deepEqual(entries[idx].state, { screen: "dashboard" });
  assert.deepEqual(pops, [false], "Back from the new screen is an ordinary screen change");
});

test("navigating with no pop-up open pushes (or replaces) a normal entry", opts, () => {
  installFakeWindow();
  mod.navigateWithLayers({ screen: "league" });
  assert.equal(entries.length, 2);
  mod.navigateWithLayers({ screen: "roster" }, { replace: true });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[idx].state, { screen: "roster" });
});
