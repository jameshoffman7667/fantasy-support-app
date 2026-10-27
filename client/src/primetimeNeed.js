// v4.13: the Primetime "what you need" sentence, always from YOUR side, read as if it starts "You need…".
// Returns { kind, segments:[{t, tone?}] } where tone is "ok" (green bold) or "major" (red bold); no tone = plain.
// my / opp = the players still to play on each side ({name}), myPts / oppPts = current scores.
export const LOST_WITHIN = 4; // trailing by more than this with only the opponent's players left = just "Already lost"

const f1 = (x) => Number(x).toFixed(1);
const names = (list) => list.map((p) => p.name).join(" + ");

export function primetimeNeed({ my = [], opp = [], myPts = 0, oppPts = 0 }) {
  const diff = Math.round((myPts - oppPts) * 100) / 100;
  const gap = Math.abs(diff);
  const m = my.length;
  const o = opp.length;
  if (!m && !o) return null;
  if (m && !o) {
    // only your players left: they must score more than (their points − yours); negative when you lead
    const n = -diff;
    return { kind: "mine-only", segments: [{ t: names(my), tone: "ok" }, { t: m > 1 ? " combine for " : " to score ", tone: null }, { t: `more than ${f1(n)} points`, tone: "ok" }] };
  }
  if (!m && o) {
    const n = diff; // only the opponent's players left: they must score less than (your points − theirs)
    if (n < 0 && gap > LOST_WITHIN) return { kind: "lost", segments: [{ t: "Already lost", tone: "major" }] };
    return { kind: "opp-only", segments: [{ t: names(opp), tone: "major" }, { t: o > 1 ? " combine for " : " to score ", tone: null }, { t: `less than ${f1(n)} points`, tone: "major" }] };
  }
  if (diff < 0) {
    return { kind: "both-trailing", segments: [{ t: names(my), tone: "ok" }, { t: " " }, { t: "outscore", tone: "major" }, { t: " " }, { t: names(opp), tone: "major" }, { t: " by " }, { t: `${f1(gap)} points`, tone: "major" }] };
  }
  // leading or tied (a tie reads "within 0.0 points")
  return { kind: "both-leading", segments: [{ t: names(my), tone: "ok" }, { t: " to score " }, { t: "within", tone: "major" }, { t: " " }, { t: `${f1(gap)} points`, tone: "ok" }, { t: " of " }, { t: names(opp), tone: "major" }] };
}
