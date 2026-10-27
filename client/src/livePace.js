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
export const PACE = { good: 0.95, ok: 0.6, minProgress: 0.1 };
/** "ok" (green) on or above the pace of the projection, "minor" (yellow) a little behind, "major" (red) well behind; null when it can't be judged. */
export function livePaceTone(points, proj, progress) {
  if (points == null || proj == null || !(proj > 0) || progress == null || progress < PACE.minProgress) return null;
  const ratio = points / (proj * progress);
  return ratio >= PACE.good ? "ok" : ratio >= PACE.ok ? "minor" : "major";
}
export function paceColor(tone, C) {
  return tone === "ok" ? C.ok : tone === "minor" ? C.minor : tone === "major" ? C.major : null;
}
