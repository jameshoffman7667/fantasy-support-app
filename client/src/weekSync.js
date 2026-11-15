// v4.20.0 (P-37): which week the app shows. The SERVER decides the current week (it already moves on at the week's last
// kickoff + 4 h). The client only keeps a week the person picked by hand until the real week changes or the app is reopened.
// Pure so it can be unit-tested.
/**
 * `real`   the server's current week now; `known` the real week the app last saw (null = never);
 * `shown`  the week on screen; `manual` the hand-picked week's record ({ realAt }) or null.
 * Returns { move: weekToShow | null, known, manual }: `move` is the week to load (null = leave the screen alone).
 */
export function weekDecision({ real, known, shown, manual }) {
  if (!Number.isInteger(real)) return { move: null, known, manual };
  if (known == null) return { move: null, known: real, manual }; // first reading: nothing moved yet
  if (real === known) return { move: null, known, manual }; // the real week did not change: a hand-picked week stays
  // the real week moved on: any hand pick ends and the app follows the real week
  return { move: shown === real ? null : real, known: real, manual: null };
}
/** A hand pick is recorded unless he picked the real week itself (that is automatic again). */
export const manualPick = (picked, real) => (picked === real ? null : { realAt: real });
