// v4.4.2 — numbers behind the suggested-bid graph. Pure, so it can be unit-tested.
// `sample` = winning bids as a percent of budget (the same sample the 70% / 95% suggestions come from).

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export const normalPdf = (x, mu, sd) => (sd > 0 ? Math.exp(-0.5 * ((x - mu) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI)) : 0);

/** Percentile on a sorted array — the same rule the server uses for the suggestions. */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/**
 * Dollars (budget × percent) summary of a sample: min, max, mean, median, standard deviation, the −2/−1/+1/+2 σ
 * points, the 70% and 95% suggestions, and a histogram. Null when there is nothing to draw.
 */
export function bidStats(samplePct, budget, bins = 12) {
  const pct = (samplePct || []).filter((x) => Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!pct.length || !(budget > 0)) return null;
  const d = pct.map((x) => (x * budget) / 100);
  const n = d.length;
  const mu = mean(d);
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1)) : 0;
  const min = d[0];
  const max = d[n - 1];
  const mid = Math.floor(n / 2);
  const median = n % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
  const span = max - min;
  const hist = Array.from({ length: bins }, () => 0);
  if (span > 0) for (const x of d) hist[Math.min(bins - 1, Math.floor(((x - min) / span) * bins))] += 1;
  return {
    n, min, max, mean: mu, sd, median,
    sigma: { m2: mu - 2 * sd, m1: mu - sd, p1: mu + sd, p2: mu + 2 * sd },
    p70: percentile(d, 70), p95: percentile(d, 95),
    hist, flat: !(span > 0) || !(sd > 0),
  };
}
