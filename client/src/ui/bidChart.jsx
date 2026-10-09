import { bidStats, normalPdf } from "../bidStats.js";
import { Modal } from "./common.jsx";
import { C, fmtMoney } from "./theme.js";

/**
 * v4.4.2 — normal-distribution graph of the winning bids behind a suggested bid. The x axis runs from the smallest bid
 * (left axis) to the largest (right axis); the curve is a normal distribution with the sample's mean and standard
 * deviation, the bars are the real bids, and the lines mark −2σ, −1σ, the average, the median, +1σ, +2σ and the two
 * suggestions.
 */
export function BidDistributionModal({ player, budget, samplePct, scope, onClose }) {
  const st = bidStats(samplePct, budget);
  const W = 360, H = 262, L = 34, R = 34, T = 50, B = 42;
  const iw = W - L - R, ih = H - T - B;
  const body = () => {
    if (!st) return <div style={{ color: C.textMuted }} className="text-sm">Not enough bids to draw a graph.</div>;
    const lo = st.min, hi = st.max;
    const span = hi - lo || 1;
    const x = (v) => L + ((Math.min(hi, Math.max(lo, v)) - lo) / span) * iw;
    const steps = 60;
    const pts = Array.from({ length: steps + 1 }, (_, i) => lo + (span * i) / steps);
    const dens = pts.map((v) => normalPdf(v, st.mean, st.sd));
    const histMax = Math.max(...st.hist, 1);
    // scale both to the same height: the bars as a share of bids per bin, the curve as the density × bin width
    const binW = span / st.hist.length;
    const curveMax = Math.max(...dens.map((d) => d * binW * st.n), 0.0001);
    const top = Math.max(histMax, curveMax);
    const y = (count) => T + ih - (count / top) * ih;
    const path = pts.map((v, i) => `${i ? "L" : "M"}${x(v).toFixed(1)},${y(dens[i] * binW * st.n).toFixed(1)}`).join(" ");
    const lines = [
      { k: "min", v: st.min, label: `min ${fmtMoney(st.min)}`, color: C.textMuted, row: 0, edge: "left" },
      { k: "m2", v: st.sigma.m2, label: "−2σ", color: C.textFaint, row: 1 },
      { k: "m1", v: st.sigma.m1, label: "−1σ", color: C.textFaint, row: 2 },
      { k: "median", v: st.median, label: `median ${fmtMoney(st.median)}`, color: C.brand, row: 3 },
      { k: "mean", v: st.mean, label: `avg ${fmtMoney(st.mean)}`, color: C.ok, row: 4 },
      { k: "p1", v: st.sigma.p1, label: "+1σ", color: C.textFaint, row: 2 },
      { k: "p2", v: st.sigma.p2, label: "+2σ", color: C.textFaint, row: 1 },
      { k: "max", v: st.max, label: `max ${fmtMoney(st.max)}`, color: C.textMuted, row: 0, edge: "right" },
    ].filter((l) => l.k === "min" || l.k === "max" || (l.v > lo && l.v < hi));
    const marks = [
      { k: "p70", v: st.p70, label: `70% ${fmtMoney(st.p70)}` },
      { k: "p95", v: st.p95, label: `95% ${fmtMoney(st.p95)}` },
    ];
    return (
      <>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Distribution of winning bids: min ${fmtMoney(st.min)}, median ${fmtMoney(st.median)}, average ${fmtMoney(st.mean)}, max ${fmtMoney(st.max)}`} data-bid-chart>
          {st.hist.map((c, i) => (
            <rect key={i} x={L + (i / st.hist.length) * iw + 1} y={y(c)} width={iw / st.hist.length - 2} height={T + ih - y(c)} fill={C.border} opacity="0.7" />
          ))}
          {!st.flat && <path d={path} fill="none" stroke={C.brand} strokeWidth="2" />}
          <line x1={L} y1={T} x2={L} y2={T + ih} stroke={C.textMuted} />
          <line x1={W - R} y1={T} x2={W - R} y2={T + ih} stroke={C.textMuted} />
          <line x1={L} y1={T + ih} x2={W - R} y2={T + ih} stroke={C.border} />
          {lines.filter((l) => !l.edge).map((l) => (
            <g key={l.k} data-bid-line={l.k}>
              <line x1={x(l.v)} y1={T - l.row * 9 - 4} x2={x(l.v)} y2={T + ih} stroke={l.color} strokeDasharray={l.k === "mean" || l.k === "median" ? "0" : "3 3"} strokeWidth={l.k === "mean" || l.k === "median" ? 1.5 : 1} />
              <text x={x(l.v)} y={T - l.row * 9 - 6} fontSize="8.5" fill={l.color} textAnchor="middle">{l.label}</text>
            </g>
          ))}
          <text x={L - 4} y={T + 4} fontSize="9" fill={C.textMuted} textAnchor="end" data-bid-line="min">min</text>
          <text x={L - 4} y={T + 15} fontSize="9" fill={C.textMuted} textAnchor="end">{fmtMoney(st.min)}</text>
          <text x={W - R + 4} y={T + 4} fontSize="9" fill={C.textMuted} textAnchor="start" data-bid-line="max">max</text>
          <text x={W - R + 4} y={T + 15} fontSize="9" fill={C.textMuted} textAnchor="start">{fmtMoney(st.max)}</text>
          {marks.map((m, i) => (
            <g key={m.k} data-bid-mark={m.k}>
              <path d={`M${x(m.v) - 4},${T + ih + 2} L${x(m.v) + 4},${T + ih + 2} L${x(m.v)},${T + ih + 9} Z`} fill={C.minor} />
              <text x={x(m.v)} y={T + ih + 21 + i * 11} fontSize="9" fill={C.minor} textAnchor="middle">{m.label}</text>
            </g>
          ))}
        </svg>
        <div style={{ color: C.textMuted }} className="text-[11px] mt-1">
          {st.n} winning bids ({scope}). Curve = a normal distribution with the same average ({fmtMoney(st.mean)}) and standard deviation ({fmtMoney(st.sd)}); bars = the actual bids. Real bids are rarely a perfect bell.
        </div>
      </>
    );
  };
  return (
    <Modal title={`Bids${player ? ` — ${player.name}` : ""}`} onClose={onClose}>
      <div data-bid-modal>{body()}</div>
    </Modal>
  );
}
