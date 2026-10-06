import * as api from "../api.js";
import { groupTree, minorKeys } from "../variances.js";
import { CheckCircle2, ChevronRight, ListChecks, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal, TeamLogo } from "./common.jsx";
import { C, SAMPLE_LABEL, SEV_COLOR, STATUS, TIER_COLORS, TIER_LABELS, ordinal, worstSev } from "./theme.js";

export function DvpDetailModal({ params, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getDvpDetail(params).then(setD).catch((err) => setError(err.message));
  }, [params]);
  const isDef = params.side !== "off";
  const title = isDef ? `${params.team} vs ${params.pos}` : `${params.team} offense — ${params.pos}`;
  const th = "text-left font-medium px-1.5 py-1";
  const td = "px-1.5 py-1";
  return (
    <Modal title={title} onClose={onClose}>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {!d && !error && <Loader2 size={18} className="animate-spin" style={{ color: C.brand }} />}
      {d && (
        <>
          <div className="flex items-center gap-3 mb-2">
            <TeamLogo team={d.team} size={36} />
            <div>
              {d.row ? (
                <div style={{ color: TIER_COLORS[d.row.tier] }} className="text-sm font-semibold">
                  {ordinal(d.row.rank)} of {d.of} · {d.row.value} pts/game{d.adjusted ? " (adjusted)" : ""} · {TIER_LABELS[d.row.tier]} matchup
                </div>
              ) : (
                <div style={{ color: C.textMuted }} className="text-sm">Not enough games yet.</div>
              )}
              <div style={{ color: C.textMuted }} className="text-[11px]">
                {isDef ? `Fantasy points ${d.pos}s scored against ${d.team}` : `Fantasy points ${d.team}'s ${d.pos}s scored`} · league avg {d.leagueAvg} · {SAMPLE_LABEL[d.mode]}
                {d.adjusted ? " · schedule adjusted" : ""} · {d.profileLabel}
              </div>
            </div>
          </div>
          <table className="w-full text-xs" style={{ color: C.text }}>
            <thead style={{ color: C.textFaint }}>
              <tr>
                <th className={th}>Game</th>
                <th className={th}>Opp</th>
                <th className={th}>Pts</th>
                <th className={th} title={isDef ? "That offense's average at this position" : "What that defense allows at this position"}>Opp avg</th>
                {d.adjusted && <th className={th} title="Points after removing the opponent's strength">Adj</th>}
                <th className={th}>Weight</th>
              </tr>
            </thead>
            <tbody>
              {d.games.map((g, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}`, color: g.season < d.season ? C.textMuted : C.text }}>
                  <td className={td}>{g.season < d.season ? `'${String(g.season).slice(2)} ` : ""}Wk {g.week}</td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-1">
                      <TeamLogo team={g.opp} size={16} />
                      {g.opp}
                    </span>
                  </td>
                  <td className={td}>{g.pts}</td>
                  <td className={td}>{g.oppAvg ?? "—"}</td>
                  {d.adjusted && <td className={td}>{g.adjPts}</td>}
                  <td className={td}>{g.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">
            {isDef
              ? "Rank 1 = allows the fewest points (toughest). Adjusted: each game counts as points minus how far that offense usually runs above or below average."
              : "Rank 1 = scores the most. Adjusted: each game counts as points minus how far that defense usually allows above or below average."}
            {d.mode === "blended" ? " Last season's games share a combined weight that fades as this season goes on." : ""}
          </div>
        </>
      )}
    </Modal>
  );
}

export function WeatherModal({ gameKey, week, onClose }) {
  const [g, setG] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api
      .getWeather(week)
      .then((d) => {
        const hit = (d.games || []).find((x) => x.key === gameKey);
        if (hit) setG(hit);
        else setError("No forecast for this game.");
      })
      .catch((err) => setError(err.message));
  }, [gameKey, week]);
  const roofLabel = { open: "Open air", dome: "Dome", retractable: "Retractable roof" };
  const th = "text-left font-medium px-1 py-1";
  const td = "px-1 py-1 whitespace-nowrap";
  return (
    <Modal title={`Weather · ${gameKey.replace("@", " @ ")}`} onClose={onClose}>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {!g && !error && <Loader2 size={18} className="animate-spin" style={{ color: C.brand }} />}
      {g && (
        <>
          <div style={{ color: C.textMuted }} className="text-xs mb-2">
            {g.stadium || "Stadium unknown"} · {roofLabel[g.roof] || "Roof unknown"} · {g.kickoffLabel}
          </div>
          {g.note && <div style={{ color: C.textMuted }} className="text-xs mb-2">{g.note}</div>}
          {g.temp != null && (
            <div
              style={{ background: g.flag ? C.minorBg : C.surfaceRaised, border: `1px solid ${g.flag ? `${C.minor}66` : C.border}`, color: g.flag ? C.minor : C.text }}
              className="text-xs rounded-md px-3 py-2 mb-2"
            >
              {g.flag ? <div className="font-semibold">Flagged: {g.reasons.join("; ")}</div> : <div>Not flagged — {g.whyNot}</div>}
              {g.roofNote && <div className="mt-0.5">{g.roofNote}{g.reasons?.length ? ` (would have been: ${g.reasons.join("; ")})` : ""}</div>}
              <div style={{ color: C.textMuted }} className="mt-1">
                At kickoff: {g.temp}° (feels {g.feelsLike}°) · {g.conditions || ""} · wind {g.wind} mph {g.windDir || ""}, gusts {g.gust} · precip {g.precipProb}%
                {g.precipTotal ? ` · ${g.precipTotal}" over the game` : ""}
                {g.snowTotal ? ` · snow ${g.snowTotal}"` : ""}
              </div>
            </div>
          )}
          {g.hourly?.length > 0 && (
            <table className="w-full text-[11px]" style={{ color: C.text }}>
              <thead style={{ color: C.textFaint }}>
                <tr>
                  <th className={th}>Time</th>
                  <th className={th}>Temp</th>
                  <th className={th}>Wind</th>
                  <th className={th}>Precip</th>
                  <th className={th}>Sky</th>
                </tr>
              </thead>
              <tbody>
                {g.hourly.map((h) => {
                  const kick = h.time === Math.floor(g.kickoff / 3600e3) * 3600e3;
                  return (
                    <tr key={h.time} style={{ borderTop: `1px solid ${C.border}`, background: kick ? C.surfaceRaised : "transparent" }}>
                      <td className={td}>{new Date(h.time).toLocaleTimeString([], { hour: "numeric" })}{kick ? " ▸" : ""}</td>
                      <td className={td}>{Math.round(h.temp)}° <span style={{ color: C.textFaint }}>({Math.round(h.feelsLike)}°)</span></td>
                      <td className={td}>{Math.round(h.wind)} <span style={{ color: C.textFaint }}>g{Math.round(h.gust)}</span> {h.windDir}</td>
                      <td className={td}>{h.precipProb ?? 0}%{h.precip ? ` ${h.precip}"` : ""}{h.type ? ` ${h.type}` : ""}</td>
                      <td className={td} style={{ color: C.textMuted }}>{h.conditions || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">Forecast: Open-Meteo, mph / °F / inches. Wind is measured 10 m up, not inside the bowl.</div>
        </>
      )}
    </Modal>
  );
}

// Opens the report for a scope; coloured by the worst live variance in it.
export function VarianceButton({ variances, onOpen, compact = false, label = "Variance report" }) {
  const live = variances.filter((v) => !v.cleared);
  const sev = worstSev(live.map((v) => v.severity));
  const color = SEV_COLOR(sev);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      style={{ color, border: `1px solid ${color}66`, background: sev === "ok" ? "transparent" : STATUS[sev].bg }}
      className={`${compact ? "text-[11px] px-2 py-1" : "text-xs px-2.5 py-1.5"} rounded-full font-medium flex items-center gap-1 shrink-0`}
      aria-label={`${label}: ${live.length} variance(s)`}
    >
      <ListChecks size={compact ? 11 : 13} />
      {compact ? "Report" : label}
      {live.length > 0 && <span style={{ fontVariantNumeric: "tabular-nums" }}>· {live.length}</span>}
    </button>
  );
}

export function VarianceReportModal({ title, variances, onClear, onClose }) {
  // v2.9: opens fully expanded (collapse is still one tap away). Groups that
  // appear later (a new league/page/rule) also open, unless the user collapsed them.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [showCleared, setShowCleared] = useState(false);
  const [clearing, setClearing] = useState(false);
  const shown = showCleared ? variances : variances.filter((v) => !v.cleared);
  const tree = useMemo(() => groupTree(shown), [shown]);
  const clearedCount = variances.filter((v) => v.cleared).length;
  const toClear = minorKeys(variances);
  const allIds = [];
  tree.forEach((l) => {
    allIds.push(`L:${l.id}`);
    l.pages.forEach((p) => {
      allIds.push(`P:${l.id}:${p.page}`);
      p.rules.forEach((r) => allIds.push(`R:${l.id}:${p.page}:${r.rule}`));
    });
  });
  const open = { has: (id) => !collapsed.has(id) };
  const toggle = (id) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const Head = ({ id, level, sev, label, count }) => {
    const isOpen = open.has(id);
    const color = SEV_COLOR(sev, sev === "ok");
    return (
      <button
        type="button"
        onClick={() => toggle(id)}
        aria-expanded={isOpen}
        data-variance-group={id}
        style={{ color, paddingLeft: level * 14 }}
        className={`w-full flex items-center gap-1.5 text-left py-1.5 ${level === 0 ? "text-sm font-semibold" : level === 1 ? "text-[13px] font-medium" : "text-xs"}`}
      >
        <ChevronRight size={13} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }} className="shrink-0" />
        <span className="truncate">{label}</span>
        <span style={{ color: C.textFaint }} className="text-[11px] font-normal shrink-0">({count})</span>
      </button>
    );
  };
  const count = (items) => items.filter((v) => !v.cleared).length + (showCleared ? items.filter((v) => v.cleared).length : 0);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <button onClick={() => setCollapsed(new Set())} style={{ color: C.brand, border: `1px solid ${C.brand}55` }} className="text-[11px] rounded-md px-2 py-1">
          Expand all
        </button>
        <button onClick={() => setCollapsed(new Set(allIds))} style={{ color: C.brand, border: `1px solid ${C.brand}55` }} className="text-[11px] rounded-md px-2 py-1">
          Collapse all
        </button>
        <button
          disabled={!toClear.length || clearing}
          onClick={async () => {
            setClearing(true);
            try {
              await onClear(toClear);
            } finally {
              setClearing(false);
            }
          }}
          style={{ color: toClear.length ? C.minor : C.textFaint, border: `1px solid ${toClear.length ? C.minor : C.border}66` }}
          className="text-[11px] rounded-md px-2 py-1 ml-auto"
        >
          {clearing ? "Clearing…" : `Clear minor variances${toClear.length ? ` (${toClear.length})` : ""}`}
        </button>
      </div>
      {clearedCount > 0 && (
        <button onClick={() => setShowCleared((v) => !v)} style={{ color: C.textMuted }} className="text-[11px] mb-1 underline">
          {showCleared ? "Hide" : "Show"} {clearedCount} cleared minor variance(s)
        </button>
      )}
      {tree.length === 0 ? (
        <div style={{ color: C.ok }} className="text-sm py-2 flex items-center gap-1.5">
          <CheckCircle2 size={15} /> No variances here.
        </div>
      ) : (
        <div>
          {tree.map((l) => (
            <div key={l.id} style={{ borderTop: `1px solid ${C.border}` }}>
              <Head id={`L:${l.id}`} level={0} sev={l.severity} label={l.name} count={count(l.pages.flatMap((p) => p.rules.flatMap((r) => r.items)))} />
              {open.has(`L:${l.id}`) &&
                l.pages.map((p) => (
                  <div key={p.page}>
                    <Head id={`P:${l.id}:${p.page}`} level={1} sev={p.severity} label={p.label} count={count(p.rules.flatMap((r) => r.items))} />
                    {open.has(`P:${l.id}:${p.page}`) &&
                      p.rules.map((r) => (
                        <div key={r.rule}>
                          <Head id={`R:${l.id}:${p.page}:${r.rule}`} level={2} sev={r.severity} label={r.rule} count={count(r.items)} />
                          {open.has(`R:${l.id}:${p.page}:${r.rule}`) && (
                            <ul style={{ paddingLeft: 48 }} className="pb-1 space-y-0.5">
                              {r.items.map((v) => (
                                <li key={v.key} style={{ color: SEV_COLOR(v.severity, v.cleared) }} className="text-xs" data-variance={v.severity}>
                                  {v.text}
                                  {v.cleared ? " (cleared)" : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
      <div style={{ color: C.textFaint }} className="text-[10px] mt-3">
        Clearing hides the yellow (minor) items listed here until a new one appears. Red items can't be cleared. A cleared item that turns red shows again.
      </div>
    </Modal>
  );
}
