import * as api from "../api.js";
import { ackKey, canClear, groupTree, majorItems, minorKeys, tickedItems } from "../variances.js";
import { CheckCircle2, ChevronRight, ListChecks, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useBackLayer } from "./backLayer.js"; // v4.19.0
import { Modal, TeamLogo } from "./common.jsx";
import { C, ON_MINOR, SAMPLE_LABEL, SEV_COLOR, STATUS, TIER_COLORS, TIER_LABELS, ordinal, worstSev } from "./theme.js";

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
  const live = variances.filter((v) => !v.cleared && v.severity !== "info"); // v4.4.2: info items are listed in the report, not counted
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

// v4.1: yellow "Clear variances" — clears this page's clearable (yellow/minor) variances in one tap, left of the report button.
export function ClearVariancesButton({ variances, onClear }) {
  const keys = minorKeys(variances);
  const [busy, setBusy] = useState(false);
  const none = keys.length === 0;
  return (
    <button
      type="button"
      disabled={none || busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await onClear(keys);
        } finally {
          setBusy(false);
        }
      }}
      style={{ color: none ? C.textFaint : ON_MINOR, background: none ? "transparent" : C.minor, border: `1px solid ${none ? C.border : C.minor}` }}
      className="text-xs px-2.5 py-1.5 rounded-full font-medium shrink-0"
      aria-label={`Clear variances: ${keys.length} clearable`}
      data-clear-variances={keys.length}
    >
      {busy ? "Clearing…" : `Clear variances${keys.length ? ` · ${keys.length}` : ""}`}
    </button>
  );
}

// v4.20.0 (P-42): "Clear major variances" always asks first: it says how many reds will be cleared and lists them (up to 8).
export function ClearMajorsDialog({ items, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  useBackLayer(true, onCancel);
  const shownItems = items.slice(0, 8);
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Clear major variances?" className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => !busy && onCancel()} data-clear-majors-dialog>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full max-w-sm rounded-xl p-4 space-y-3">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-base">Clear {items.length} major variance{items.length === 1 ? "" : "s"}?</div>
        <ul className="text-xs space-y-0.5" style={{ color: C.major }}>
          {shownItems.map((v) => <li key={ackKey(v)}>{v.league ? `${v.league} · ` : ""}{v.rule}{v.subject ? `: ${v.subject}` : ""}</li>)}
          {items.length > shownItems.length && <li style={{ color: C.textMuted }}>and {items.length - shownItems.length} more</li>}
        </ul>
        <div style={{ color: C.textMuted }} className="text-[11px]">They stay hidden until they change or the week turns. Nothing is changed in your lineup or in Sleeper.</div>
        <div className="flex gap-2 justify-end">
          <button type="button" disabled={busy} onClick={onCancel} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-sm" data-clear-majors-no>Cancel</button>
          <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }} style={{ background: C.major, color: "#fff" }} className="rounded-md px-3 py-1.5 text-sm font-medium" data-clear-majors-yes>
            {busy ? "Clearing…" : `Clear ${items.length} major variance${items.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// v4.20.0 (P-42): the red twin of the yellow "Clear variances" chip. It asks before it clears anything.
export function ClearMajorVariancesButton({ variances, onClear }) {
  const items = majorItems(variances);
  const [asking, setAsking] = useState(false);
  const none = items.length === 0;
  return (
    <>
      <button
        type="button"
        disabled={none}
        onClick={(e) => { e.stopPropagation(); setAsking(true); }}
        style={{ color: none ? C.textFaint : C.major, background: "transparent", border: `1px solid ${none ? C.border : C.major}` }}
        className="text-xs px-2.5 py-1.5 rounded-full font-medium shrink-0"
        aria-label={`Clear major variances: ${items.length} clearable`}
        data-clear-major-variances={items.length}
      >
        {`Clear major variances${items.length ? ` · ${items.length}` : ""}`}
      </button>
      {asking && <ClearMajorsDialog items={items} onCancel={() => setAsking(false)} onConfirm={async () => { await onClear(items.map(ackKey)); setAsking(false); }} />}
    </>
  );
}

export function VarianceReportModal({ title, variances, onClear, onClose }) {
  // v2.9: opens fully expanded (collapse is still one tap away). Groups that
  // appear later (a new league/page/rule) also open, unless the user collapsed them.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [showCleared, setShowCleared] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirm, setConfirm] = useState(null); // v4.6: the variance waiting for "Clear it?"
  useBackLayer(Boolean(confirm), () => setConfirm(null)); // v4.19.0: Back closes the confirm first
  const [confirmBusy, setConfirmBusy] = useState(false);
  const shown = showCleared ? variances : variances.filter((v) => !v.cleared);
  const tree = useMemo(() => groupTree(shown), [shown]);
  const clearedCount = variances.filter((v) => v.cleared).length;
  // v4.20.0 (P-43): a checkbox on every uncleared variance, ticked by default; only the ticked ones clear.
  const [unticked, setUnticked] = useState(() => new Set());
  const [askMajors, setAskMajors] = useState(false);
  const toClear = [...new Set(tickedItems(variances, "minor", unticked).map((v) => v.key))];
  const majorsTicked = tickedItems(variances, "major", unticked);
  const setTicks = (items, on) => setUnticked((prev) => { const n = new Set(prev); for (const v of items) { if (on) n.delete(ackKey(v)); else n.add(ackKey(v)); } return n; });
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
  const Head = ({ id, level, sev, label, count, items = [] }) => {
    const isOpen = open.has(id);
    const color = SEV_COLOR(sev, sev === "ok");
    const live = items.filter(canClear);
    const on = live.filter((v) => !unticked.has(ackKey(v))).length;
    return (
      <div className="flex items-center" style={{ paddingLeft: level * 14 }}>
        {live.length > 0 && (
          <input
            type="checkbox"
            className="mr-1.5 shrink-0"
            checked={on === live.length}
            ref={(el) => { if (el) el.indeterminate = on > 0 && on < live.length; }}
            onChange={() => setTicks(live, on !== live.length)}
            aria-label={`Select the variances under ${label}`}
            data-variance-group-check={id}
          />
        )}
        <button
          type="button"
          onClick={() => toggle(id)}
          aria-expanded={isOpen}
          data-variance-group={id}
          style={{ color }}
          className={`flex-1 min-w-0 flex items-center gap-1.5 text-left py-1.5 ${level === 0 ? "text-sm font-semibold" : level === 1 ? "text-[13px] font-medium" : "text-xs"}`}
        >
          <ChevronRight size={13} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }} className="shrink-0" />
          <span className="truncate">{label}</span>
          <span style={{ color: C.textFaint }} className="text-[11px] font-normal shrink-0">({count})</span>
        </button>
      </div>
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
        <button
          disabled={!majorsTicked.length || clearing}
          onClick={() => setAskMajors(true)}
          style={{ color: majorsTicked.length ? C.major : C.textFaint, border: `1px solid ${majorsTicked.length ? C.major : C.border}66` }}
          className="text-[11px] rounded-md px-2 py-1"
          data-clear-major-report
        >
          {`Clear major variances${majorsTicked.length ? ` (${majorsTicked.length})` : ""}`}
        </button>
      </div>
      {askMajors && <ClearMajorsDialog items={majorsTicked} onCancel={() => setAskMajors(false)} onConfirm={async () => { await onClear(majorsTicked.map(ackKey)); setAskMajors(false); }} />}
      {clearedCount > 0 && (
        <button onClick={() => setShowCleared((v) => !v)} style={{ color: C.textMuted }} className="text-[11px] mb-1 underline">
          {showCleared ? "Hide" : "Show"} {clearedCount} cleared variance(s)
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
              <Head id={`L:${l.id}`} level={0} sev={l.severity} label={l.name} items={l.pages.flatMap((p) => p.rules.flatMap((r) => r.items))} count={count(l.pages.flatMap((p) => p.rules.flatMap((r) => r.items)))} />
              {open.has(`L:${l.id}`) &&
                l.pages.map((p) => (
                  <div key={p.page}>
                    <Head id={`P:${l.id}:${p.page}`} level={1} sev={p.severity} label={p.label} items={p.rules.flatMap((r) => r.items)} count={count(p.rules.flatMap((r) => r.items))} />
                    {open.has(`P:${l.id}:${p.page}`) &&
                      p.rules.map((r) => (
                        <div key={r.rule}>
                          <Head id={`R:${l.id}:${p.page}:${r.rule}`} level={2} sev={r.severity} label={r.rule} items={r.items} count={count(r.items)} />
                          {open.has(`R:${l.id}:${p.page}:${r.rule}`) && (
                            <ul style={{ paddingLeft: 48 }} className="pb-1 space-y-0.5">
                              {r.items.map((v) => (
                                <li key={v.key} style={{ color: SEV_COLOR(v.severity, v.cleared), listStyle: "none", marginLeft: -22 }} className="text-xs flex items-start gap-1.5" data-variance={v.severity}>
                                  {canClear(v) ? <input type="checkbox" className="mt-0.5 shrink-0" checked={!unticked.has(ackKey(v))} onChange={(e) => setTicks([v], e.target.checked)} aria-label={`Select: ${v.text}`} data-variance-check={v.severity} /> : <span className="shrink-0" style={{ width: 13 }} />}
                                  <span className="min-w-0">{canClear(v) ? (
                                    <button type="button" onClick={() => setConfirm(v)} style={{ color: "inherit" }} className="text-left underline decoration-dotted underline-offset-2" data-clear-one={v.severity} aria-label={`Clear this ${v.severity === "major" ? "red" : "yellow"} variance`}>
                                      {v.text}
                                    </button>
                                  ) : (
                                    v.text
                                  )}
                                  {v.cleared ? " (cleared)" : ""}</span>
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
        Tap a red or yellow item to clear it (you're asked to confirm). Clearing hides it until a new one appears. Tick the boxes on the left (all are ticked to start) and the "Clear minor / major variances" buttons clear only the ticked items; clearing reds asks first. Grey items can't be cleared.
      </div>
      {confirm && (
        <div role="alertdialog" aria-modal="true" aria-label="Clear this variance?" className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => !confirmBusy && setConfirm(null)} data-clear-confirm>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full max-w-sm rounded-xl p-4 space-y-3">
            <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-base">Clear this {confirm.severity === "major" ? "red" : "yellow"} variance?</div>
            <div style={{ color: SEV_COLOR(confirm.severity, false) }} className="text-xs">{confirm.league} · {confirm.text}</div>
            <div style={{ color: C.textMuted }} className="text-[11px]">It stops colouring the page, the league and the team list until a new one appears{confirm.severity === "major" ? ". Nothing is changed in your lineup or in Sleeper" : ""}.</div>
            <div className="flex gap-2 justify-end">
              <button type="button" disabled={confirmBusy} onClick={() => setConfirm(null)} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-sm" data-clear-confirm-no>Keep it</button>
              <button
                type="button"
                disabled={confirmBusy}
                onClick={async () => {
                  setConfirmBusy(true);
                  try {
                    await onClear([ackKey(confirm)]);
                  } finally {
                    setConfirmBusy(false);
                    setConfirm(null);
                  }
                }}
                style={{ background: confirm.severity === "major" ? C.major : C.minor, color: "#fff" }}
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                data-clear-confirm-yes
              >
                {confirmBusy ? "Clearing…" : "Yes, clear it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
