// v4.13: how a live player is tracking against the projection.
// Game progress (0..1) from ESPN's short status text ("4:12 - 3rd", "Halftime", "End of 2nd", "Final/OT"); null when unknown.
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
// v4.20.0 (P-48): the same projection model as server/projection.js (test/v420.test.js proves they agree).
const isNum = (x) => x != null && x !== "" && Number.isFinite(Number(x));
export const COLOUR_PCT = 0.05;
/** Live projection: actual + (1 - p) x (p x actual + (1 - p^2) x projection); unknown progress -> the larger of points and projection. */
export function liveProjection(points, projection, progress) {
  if (!isNum(projection)) return null;
  const a = isNum(points) ? Number(points) : 0;
  const proj = Number(projection);
  if (progress == null || !Number.isFinite(progress)) return Math.max(a, proj);
  const p = Math.min(1, Math.max(0, progress));
  return a + (1 - p) * Math.max(0, p * a + (1 - p * p) * proj);
}
/** { projection, liveProjection, actual, expected, colour } for one player; colour is "green" | "amber" | "red" | "" (none before kickoff). */
export function playerView({ state, points, proj, statusDetail }) {
  const projection = isNum(proj) ? Number(proj) : null;
  const actual = isNum(points) ? Number(points) : null;
  const a = actual ?? 0;
  let live = null;
  let expected;
  if (state === "post") expected = a;
  else if (state === "in") { live = liveProjection(actual, projection, gameProgress(statusDetail)); expected = live ?? a; }
  else expected = projection ?? 0;
  let colour = "";
  if ((state === "in" || state === "post") && projection != null) {
    const diff = expected - projection;
    const threshold = COLOUR_PCT * Math.max(0, projection - a);
    colour = diff > 1e-9 && diff >= threshold ? "green" : diff < -1e-9 && -diff >= threshold ? "red" : "amber";
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { projection, liveProjection: live == null ? null : r2(live), actual, expected: r2(expected), colour };
}
/** "ok" (green) / "minor" (amber) / "major" (red) for a live or finished player against his projection; null before kickoff or without one. */
export function paceToneOf(view) {
  return view.colour === "green" ? "ok" : view.colour === "amber" ? "minor" : view.colour === "red" ? "major" : null;
}
export function paceColor(tone, C) {
  return tone === "ok" ? C.ok : tone === "minor" ? C.minor : tone === "major" ? C.major : null;
}
