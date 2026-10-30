// v4.14: Toronto clock helper used by the Tuesday CBS push (loaded standalone from source to avoid server dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../server/cbs.js", import.meta.url), "utf8");
test("cbs.js: no auto-mode switch left", () => {
  assert.ok(!/watchTick|autoOff|changedPools/.test(src));
  assert.ok(/export const TUESDAY_PUSH_HOUR = 10/.test(src));
});
test("torontoClock: Tuesday 09:30 EST (after DST ends) is hour 9", () => {
  const m = src.match(/export function torontoClock\(now[^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(m, "torontoClock found");
  const fn = new Function(`${m[0].replace("export ", "")}; return torontoClock;`)();
  const c = fn(Date.parse("2026-11-03T14:30:00Z"));
  assert.equal(c.weekday, "Tue");
  assert.equal(c.hour, 9);
  assert.equal(fn(Date.parse("2026-10-27T14:30:00Z")).hour, 10); // EDT
});
