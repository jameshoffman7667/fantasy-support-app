/**
 * v4.20.0 (P-48): the one projection model, used by Game Day, the league colour and the ticker.
 * (client/src/livePace.js carries the same formulas for the browser; test/v420.test.js proves they agree.)
 *
 * Per player:
 *  - projection      the pregame expected points (never changes)
 *  - liveProjection  while his game is on: actual + (1 - p) x (p x actual + (1 - p^2) x projection), p = share of the game played.
 *                    That is the actual plus the rest of the game at a rate that blends his pace so far (weight p^2) with his
 *                    projection (weight 1 - p^2). Starts at the projection, ends at the actual, never below the actual,
 *                    and has no division by p, so an early touchdown cannot blow it up.
 *  - actual          the points scored so far (the final once the game is over)
 *  - expected final  not started: projection; live: liveProjection; finished: actual.
 * A team's expected final is the sum of its starters' expected finals.
 *
 * Colour (same 5 % rule as the league colour, but against the player's own projection instead of the opponent's score):
 *  green when the expected final is above the projection by at least 5 % of the points still to come (projection - actual),
 *  red when below by that much, otherwise amber. No colour before kickoff or without a projection.
 */
export const COLOUR_PCT = 0.05;
const r2 = (x) => Math.round(x * 100) / 100;

/** Share of the game played (0..1) from ESPN's short status text ("4:12 - 3rd", "Halftime", "End of 2nd", "Final/OT"); null when unknown. */
export function gameProgress(detail) {
  const t = String(detail || "").trim();
  if (!t) return null;
  if (/half/i.test(t)) return 0.5;
  if (/OT|overtime/i.test(t)) return 1;
  let m = t.match(/end of (\d)/i);
  if (m) return Math.min(1, Number(m[1]) / 4);
  m = t.match(/(\d{1,2}):(\d{2})\s*-\s*(\d)/);
  if (m) {
    const q = Number(m[3]);
    const left = Number(m[1]) + Number(m[2]) / 60;
    return Math.min(1, Math.max(0, ((q - 1) * 15 + (15 - left)) / 60));
  }
  return null;
}

const isNum = (x) => x != null && x !== "" && Number.isFinite(Number(x));

/** The live projection for a game in progress, or null without a projection. Unknown progress falls back to max(points, projection). */
export function liveProjection(points, projection, progress) {
  if (!isNum(projection)) return null;
  const a = isNum(points) ? Number(points) : 0;
  const proj = Number(projection);
  if (progress == null || !Number.isFinite(progress)) return Math.max(a, proj);
  const p = Math.min(1, Math.max(0, progress));
  const rest = Math.max(0, p * a + (1 - p * p) * proj);
  return a + (1 - p) * rest;
}

/** Everything the app needs about one player: { projection, liveProjection, actual, expected, colour }. colour is "green" | "amber" | "red" | "". */
export function playerView({ state, points, proj, statusDetail }) {
  const projection = isNum(proj) ? Number(proj) : null;
  const actual = isNum(points) ? Number(points) : null;
  const a = actual ?? 0;
  let live = null;
  let expected;
  if (state === "post") expected = a;
  else if (state === "in") {
    live = liveProjection(actual, projection, gameProgress(statusDetail));
    expected = live ?? a;
  } else expected = projection ?? 0;
  let colour = "";
  if ((state === "in" || state === "post") && projection != null) {
    const diff = expected - projection;
    const threshold = COLOUR_PCT * Math.max(0, projection - a);
    colour = diff > 1e-9 && diff >= threshold ? "green" : diff < -1e-9 && -diff >= threshold ? "red" : "amber";
  }
  return { projection, liveProjection: live == null ? null : r2(live), actual, expected: r2(expected), colour };
}

/** The opponent sees the mirror of the league colour: green and red swap, amber (and anything else) stays. */
export const mirrorColour = (c) => (c === "green" ? "red" : c === "red" ? "green" : c);
