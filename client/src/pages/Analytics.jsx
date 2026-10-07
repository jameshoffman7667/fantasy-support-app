import * as api from "../api.js";
import { ScoutingPage } from "./Scouting.jsx"; // v4.2
import { Loader2, RefreshCw, Wind } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { BootstrapScreen, CardCtx, ErrorScreen, Modal, SectionLabel, Select, TeamLogo, Toggle } from "../ui/common.jsx";
import { C, SRC_COLOR, SRC_NAME, TIER_COLORS, TIER_LABELS, goodBad, signed } from "../ui/theme.js";

// Average miss by week, one line per source. Plain inline SVG.
function MaeChart({ byWeek }) {
  const weeks = [...new Set(byWeek.map((r) => r.week))].sort((a, b) => a - b);
  if (weeks.length < 2) return <div style={{ color: C.textFaint }} className="text-xs px-1 py-2">Needs at least two scored weeks to chart.</div>;
  const W = 340, H = 150, P = { l: 28, r: 8, t: 8, b: 20 };
  const maxY = Math.max(1, ...byWeek.map((r) => r.mae)) * 1.1;
  const x = (w) => P.l + ((w - weeks[0]) / (weeks[weeks.length - 1] - weeks[0])) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const sources = ["V", "T", "S", "E"].filter((s) => byWeek.some((r) => r.source === s));
  const ticks = [0, maxY / 2, maxY].map((v) => Math.round(v * 10) / 10);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average miss by week, by source">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke={C.border} strokeWidth="1" />
            <text x={P.l - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill={C.textFaint}>{t}</text>
          </g>
        ))}
        {weeks.map((w) => (
          <text key={w} x={x(w)} y={H - 6} fontSize="9" textAnchor="middle" fill={C.textFaint}>{w}</text>
        ))}
        {sources.map((s) => {
          const pts = byWeek.filter((r) => r.source === s).sort((a, b) => a.week - b.week);
          return (
            <g key={s}>
              <polyline fill="none" stroke={SRC_COLOR[s]} strokeWidth="2" points={pts.map((r) => `${x(r.week)},${y(r.mae)}`).join(" ")} />
              {pts.map((r) => (
                <circle key={r.week} cx={x(r.week)} cy={y(r.mae)} r="2.5" fill={SRC_COLOR[s]}>
                  <title>{`${SRC_NAME[s]} week ${r.week}: average miss ${r.mae} pts (n=${r.n})`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3 px-1 pt-1">
        {sources.map((s) => (
          <span key={s} className="text-[11px] flex items-center gap-1" style={{ color: C.textMuted }}>
            <span style={{ background: SRC_COLOR[s] }} className="inline-block w-2.5 h-2.5 rounded-full" />
            {SRC_NAME[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function BackfillPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.adminBackfillStatus().then(setStatus).catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.adminStartBackfill();
      setStatus(r.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const b1 = status?.batch1;
  const b2 = status?.batch2;
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "—");
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2">
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">History backfill (owner)</div>
      <div style={{ color: C.textMuted }} className="text-xs">
        Fills past weeks so accuracy and leans have data from day one. Sleeper/ESPN projections and actual scores: 2026 to date and all of 2025 (no Tank01 calls).
        Tank01 (Vegas closing props + Tank01 projections): batch 1 = 2026 to date, then 2025 weeks 18–9 (~230 calls); batch 2 = 2025 weeks 8–1 (~140 calls), automatically 40 days after batch 1.
        Anything unfinished continues on the last day of the month after 11 pm ET until Tank01 rejects a call.
      </div>
      {status && (
        <div style={{ color: C.textMuted }} className="text-[11px] space-y-0.5">
          <div>Tank01 key: {status.tank01Configured ? "set" : "not set"} · app-counted Tank01 calls this month: {status.tank01CallsThisMonth} · crosswalk rows: {status.crosswalkRows}</div>
          <div>Batch 1: {b1 ? `${b1.running ? "running" : b1.tankComplete ? "complete" : "incomplete"} · last run ${fmt(b1.lastRunAt)}${b1.stoppedBecause ? ` · stopped: ${b1.stoppedBecause}` : ""}${b1.lastError ? ` · error: ${b1.lastError}` : ""}` : "not started"}</div>
          <div>Batch 2: {b2 ? `${b2.running ? "running" : b2.tankComplete ? "complete" : "incomplete"} · last run ${fmt(b2.lastRunAt)}` : status.batch2DueAt ? `scheduled for ${fmt(status.batch2DueAt)}` : "after batch 1 completes"}</div>
          {status.items?.length > 0 && <div>Items: {status.items.map((i) => `b${i.batch} ${i.status} ${i.n}`).join(" · ")}</div>}
        </div>
      )}
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      <button
        onClick={start}
        disabled={busy || status?.running}
        style={{ background: busy || status?.running ? C.surfaceRaised : C.brand, color: C.text }}
        className="rounded-md px-3 py-2 text-xs font-medium flex items-center gap-2"
      >
        {status?.running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {status?.running ? "Backfill running…" : b1 ? "Run / resume batch 1" : "Backfill history"}
      </button>
    </div>
  );
}

// Cumulative lines by week: lineup decisions, waiver misses and waiver claims. Plain inline SVG.
function PerfTrend({ trend }) {
  if (trend.length < 2) return <div style={{ color: C.textFaint }} className="text-xs px-1 py-2">The trend needs at least two scored weeks.</div>;
  const series = [
    { k: "lineupCum", label: "Lineup: going against the app", color: "#4A8FC2" },
    { k: "waiverMissedCum", label: "Waivers: passed on a pick-up", color: "#D9A521" },
    { k: "waiverClaimedCum", label: "Waivers: claims you made", color: "#3FAE58" },
  ];
  const W = 340, H = 160, P = { l: 34, r: 8, t: 8, b: 20 };
  const vals = trend.flatMap((t) => series.map((s) => t[s.k] || 0).concat(0));
  const lo = Math.min(...vals), hi = Math.max(...vals, 1);
  const span = hi - lo || 1;
  const weeks = trend.map((t) => t.week);
  const x = (w) => P.l + ((w - weeks[0]) / (weeks[weeks.length - 1] - weeks[0] || 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - lo) / span) * (H - P.t - P.b);
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i).map((v) => Math.round(v * 10) / 10);
  return (
    <div data-perf-trend>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative points by week">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.textFaint : C.border} strokeWidth="1" />
            <text x={P.l - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill={C.textFaint}>{t}</text>
          </g>
        ))}
        {weeks.map((w) => <text key={w} x={x(w)} y={H - 6} fontSize="9" textAnchor="middle" fill={C.textFaint}>{w}</text>)}
        {series.map((s) => (
          <g key={s.k}>
            <polyline fill="none" stroke={s.color} strokeWidth="2" points={trend.map((t) => `${x(t.week)},${y(t[s.k] || 0)}`).join(" ")} />
            {trend.map((t) => <circle key={t.week} cx={x(t.week)} cy={y(t[s.k] || 0)} r="2.5" fill={s.color}><title>{`${s.label}, through week ${t.week}: ${signed(t[s.k])} pts`}</title></circle>)}
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]" style={{ color: C.textMuted }}>
        {series.map((s) => <span key={s.k}><span style={{ color: s.color }}>●</span> {s.label}</span>)}
      </div>
    </div>
  );
}

function PerformanceScreen() {
  const [leagueId, setLeagueId] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [week, setWeek] = useState(null);
  useEffect(() => {
    setData(null);
    api.getPerformance(leagueId ? { leagueId } : {}).then((d) => {
      setData(d);
      setError(null);
      setWeek((w) => (w != null && d.weekly.some((x) => x.week === w) ? w : d.weekly.length ? d.weekly[d.weekly.length - 1].week : null));
    }).catch((e) => setError(e.message));
  }, [leagueId]);
  if (error) return <div className="px-4 py-3"><ErrorScreen message={error} /></div>;
  if (!data) return <div className="px-4 py-6"><BootstrapScreen /></div>;
  const wk = data.weekly.find((x) => x.week === week) || null;
  const t = data.totals;
  const th = "text-[10px] uppercase tracking-wide font-medium px-1.5 py-1 text-right";
  const td = "text-xs px-1.5 py-1 text-right whitespace-nowrap";
  return (
    <div className="px-4 py-3 space-y-3" data-performance>
      <div style={{ color: C.textMuted }} className="text-xs">
        How your lineup and waiver decisions worked out against what the app suggested, in real points once a week's scores are in. Only lineup swaps and waiver claims are tracked. Each suggestion is judged by the latest one the app showed before the relevant kickoff.
        {data.since ? ` History starts ${new Date(data.since).toLocaleDateString([], { month: "short", day: "numeric" })} — earlier weeks weren't recorded.` : ""}
      </div>
      {data.note && <div style={{ color: C.minor }} className="text-xs" data-perf-note>{data.note}</div>}
      {data.leagues.length > 1 && (
        <Select label="League" value={leagueId} onChange={setLeagueId} options={[{ value: "", label: "All leagues" }, ...data.leagues.map((l) => ({ value: l.id, label: l.name }))]} />
      )}
      {data.weekly.length > 0 && (
        <>
          <div>
            <SectionLabel>Season so far</SectionLabel>
            <div className="grid grid-cols-2 gap-2 pt-1.5 text-xs" data-perf-totals>
              {[
                ["Lineup swaps suggested", `${t.suggested} (you followed ${t.followed})`, null],
                ["Went against the app", signed(t.ignoredEffect) + " pts", t.ignoredEffect],
                ["Following the app gained", signed(t.followedGain) + " pts", t.followedGain],
                ["App right (lineup)", t.appJudged ? `${t.appRight}/${t.appJudged} (${Math.round((100 * t.appRight) / t.appJudged)}%)` : "—", null],
                ["Waiver pick-ups passed on", signed(t.waiverMissed) + " pts", t.waiverMissed ? -t.waiverMissed : 0],
                ["Waiver claims you made", signed(t.waiverClaimed) + " pts", t.waiverClaimed],
              ].map(([label, value, tone]) => (
                <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-2.5 py-2">
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{label}</div>
                  <div style={{ color: tone == null ? C.text : goodBad(tone) }} className="font-medium">{value}</div>
                </div>
              ))}
            </div>
            <div style={{ color: C.textFaint }} className="text-[10px] pt-1">+ means the decision gained you points. "Went against the app" is what you started minus what the app suggested, summed over every swap you declined. Waiver figures are the suggested player's points since the week he was flagged minus the player you added or kept; "passed on" is shown from your point of view (negative = you left points on the wire).</div>
          </div>
          <div>
            <SectionLabel>Trend by week (cumulative)</SectionLabel>
            <div className="pt-1.5"><PerfTrend trend={data.trend} /></div>
          </div>
          <div>
            <SectionLabel>Weekly report</SectionLabel>
            <div className="flex gap-1.5 flex-wrap pt-1.5">
              {data.weekly.map((w) => (
                <button key={w.week} onClick={() => setWeek(w.week)} style={{ background: week === w.week ? C.brand : C.surfaceRaised, color: week === w.week ? C.text : C.textMuted }} className="text-xs rounded-md px-2.5 py-1">Wk {w.week}{w.scored ? "" : " ·"}</button>
              ))}
            </div>
            {wk && (
              <div className="space-y-2.5 pt-2" data-perf-week>
                {!wk.scored && <div style={{ color: C.minor }} className="text-xs">Week {wk.week} hasn't been scored yet — results appear after the games finish and the app has pulled the final stats.</div>}
                <div style={{ color: C.text }} className="text-xs">
                  Lineup: {wk.lineup.suggested} swap{wk.lineup.suggested === 1 ? "" : "s"} suggested — followed {wk.lineup.followed}, declined {wk.lineup.ignored}.{" "}
                  <span style={{ color: goodBad(wk.lineup.ignoredEffect) }}>Going against the app: {signed(wk.lineup.ignoredEffect)} pts.</span>{" "}
                  {wk.lineup.appJudged ? `The app's pick outscored the player it replaced in ${wk.lineup.appRight} of ${wk.lineup.appJudged}.` : ""}
                </div>
                {wk.lineup.rows.length > 0 && (
                  <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
                    <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                      <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                        <tr>
                          <th className={`${th} text-left`}>Slot</th>
                          <th className={`${th} text-left`}>App suggested</th>
                          <th className={`${th} text-left`}>Instead</th>
                          <th className={th} title="Projected gap suggested minus replaced, when the app showed it">Proj gap</th>
                          <th className={th} title="Actual gap suggested minus replaced">Actual gap</th>
                          <th className={th} title="Points your decision gained (+) or lost (−) versus the app">You</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wk.lineup.rows.map((r, i) => (
                          <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                            <td className={`${td} text-left`} style={{ color: C.textMuted }}>{r.slot}{data.leagues.length > 1 ? ` · ${r.leagueName}` : ""}</td>
                            <td className={`${td} text-left`}>{r.suggested.name} <span style={{ color: C.textFaint }}>{r.suggested.pts}</span></td>
                            <td className={`${td} text-left`} style={{ color: C.textMuted }}>{r.followed ? <span style={{ color: C.ok }}>followed</span> : `${r.started ? r.started.name : "—"} ${r.started ? r.started.pts : ""}`}</td>
                            <td className={td}>{signed(r.projGap)}</td>
                            <td className={td} style={{ color: r.appRight == null ? C.textMuted : r.appRight ? C.ok : C.major }}>{signed(r.actualGap)}</td>
                            <td className={td} style={{ color: goodBad(r.effect) }}>{signed(r.effect)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ color: C.text }} className="text-xs">
                  Waivers: {wk.waiver.suggested} pick-up{wk.waiver.suggested === 1 ? "" : "s"} flagged this week — you claimed {wk.waiver.claimed}, passed on {wk.waiver.missed}.
                </div>
                {wk.waiver.rows.length > 0 && (
                  <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
                    <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                      <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                        <tr>
                          <th className={`${th} text-left`}>Flagged free agent</th>
                          <th className={`${th} text-left`}>You</th>
                          <th className={th} title="The free agent's points since the week he was flagged">His pts</th>
                          <th className={th} title="Points of the player you added or kept, same weeks">Other pts</th>
                          <th className={th} title="Free agent minus the other player">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wk.waiver.rows.map((r, i) => (
                          <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                            <td className={`${td} text-left`}>{r.suggested.name} <span style={{ color: C.textFaint }}>{r.suggested.pos}{data.leagues.length > 1 ? ` · ${r.leagueName}` : ""}</span></td>
                            <td className={`${td} text-left`} style={{ color: C.textMuted }}>
                              {r.followed ? <span style={{ color: C.ok }}>claimed</span> : r.altKind === "added" ? `added ${r.alt?.name || "someone else"}` : `kept ${r.alt?.name || "roster"}`}
                              {r.claimsKnown === false && !r.followed ? " (transactions unavailable)" : ""}
                            </td>
                            <td className={td}>{r.suggestedPts}</td>
                            <td className={td}>{r.altPts}</td>
                            <td className={td} style={{ color: r.followed ? goodBad(r.diff) : goodBad(-r.diff) }}>{signed(r.diff)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ color: C.textFaint }} className="text-[10px] px-1.5 py-1">Cumulative through week {data.lastScoredWeek}. Colour: green = your decision came out ahead.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// v2.8: Analytics has two views — projection accuracy and matchup rankings.
export function AnalyticsScreen({ authUser, onDvpChange, leagues = [] }) {
  const [view, setView] = useState("matchups");
  return (
    <div>
      <div className="flex gap-1.5 px-4 pt-3 flex-wrap">
        {[
          ["matchups", "Matchup rankings"],
          ["accuracy", "Projection accuracy"],
          ["performance", "My performance"],
          ["scouting", "Scouting"], // v4.2
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            style={{ background: view === k ? C.brand : C.surfaceRaised, color: view === k ? C.text : C.textMuted }}
            className="text-xs rounded-md px-3 py-1.5 font-medium"
          >
            {label}
          </button>
        ))}
      </div>
      {view === "scouting" ? <ScoutingPage authUser={authUser} leagues={leagues} /> : view === "accuracy" ? <AccuracyScreen authUser={authUser} /> : view === "performance" ? <PerformanceScreen /> : <MatchupRankings onDvpChange={onDvpChange} authUser={authUser} />}
    </div>
  );
}

function loadedSummary(loaded, season) {
  if (!loaded?.length) return "No game data loaded yet — it loads in the background after start-up.";
  const by = (s) => loaded.filter((w) => w.season === s);
  const fmt = (s) => {
    const full = by(s).filter((w) => !w.partial).map((w) => w.week);
    const part = by(s).filter((w) => w.partial).map((w) => w.week);
    if (!full.length && !part.length) return null;
    const range = full.length ? `wk ${Math.min(...full)}–${Math.max(...full)}` : "";
    return `${s} ${range}${part.length ? `${range ? " + " : ""}finished wk ${part.join(", ")} games` : ""}`;
  };
  return `Data: ${[fmt(season - 1), fmt(season)].filter(Boolean).join(" · ")}`;
}

function MatchupRankings({ onDvpChange, authUser }) {
  const ctx = React.useContext(CardCtx);
  const [side, setSide] = useState("def");
  const [pos, setPos] = useState("WR");
  const [profile, setProfile] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getDvp(profile ? { profile } : {})
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (!profile && d.profile) setProfile(d.profile);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [profile, reload]);

  // Sample and schedule-adjust are saved per user and also colour the player cards.
  const saveSettings = async (patch) => {
    setData((d) => (d ? { ...d, ...patch } : d));
    try {
      await api.saveDvpSettings(patch);
    } catch (err) {
      setError(err.message);
    }
    setReload((r) => r + 1);
    onDvpChange?.();
  };

  // v2.9: every column sorts when its header is tapped (tap again to reverse).
  const [sort, setSort] = useState({ key: "rank", dir: 1 });
  const baseRows = (side === "def" ? data?.defense : data?.offense)?.[pos] || [];
  const sortVal = (r, k) => (k === "team" ? r.team : r[k] == null ? null : Number(r[k]));
  const rows = [...baseRows].sort((a, b) => {
    const x = sortVal(a, sort.key);
    const y = sortVal(b, sort.key);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // missing values always last
    if (y == null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return c * sort.dir;
  });
  const showRos = Boolean(data?.adjusted) && baseRows.some((r) => r.ros != null);
  const clickSort = (key) => setSort((cur) => (cur.key === key ? { key, dir: -cur.dir } : { key, dir: key === "rank" || key === "team" ? 1 : -1 }));
  const th = "text-left font-medium px-1.5 py-1";
  const td = "px-1.5 py-1.5";
  const SortTh = ({ k, children, title }) => (
    <th className={th} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={title}>
      <button type="button" onClick={() => clickSort(k)} data-sort={k} className="font-medium inline-flex items-center gap-0.5" style={{ color: sort.key === k ? C.text : C.textFaint }}>
        {children}
        {sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Fantasy points per game by position, in your league's scoring, from Sleeper's game stats. Your sample and adjustment choices here also colour the matchups on player cards.
      </div>
      <div className="flex flex-wrap gap-2 items-end mb-2">
        <Select label="Scoring" value={profile} onChange={setProfile} options={(data?.profiles || []).map((p) => ({ value: p.profile, label: p.label }))} />
        <Toggle checked={(data?.mode || "blended") === "blended"} onChange={(v) => saveSettings({ mode: v ? "blended" : "current" })}>Blend ({(data?.season ?? new Date().getFullYear()) - 1})</Toggle>
        <Toggle checked={Boolean(data?.adjusted)} onChange={(v) => saveSettings({ adjusted: v })}>Schedule adjusted</Toggle>
      </div>
      <div className="flex gap-1.5 mb-2">
        {[
          ["def", "Defense vs position"],
          ["off", "Offense by position"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSide(k)}
            style={{ border: `1px solid ${side === k ? C.brand : C.border}`, color: side === k ? C.brand : C.textMuted }}
            className="text-[11px] rounded-md px-2.5 py-1"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex gap-1 mb-2">
        {["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => (
          <button
            key={p}
            onClick={() => setPos(p)}
            style={{ background: pos === p ? C.surfaceRaised : "transparent", border: `1px solid ${pos === p ? C.textMuted : C.border}`, color: pos === p ? C.text : C.textMuted }}
            className="text-[11px] rounded px-2 py-1 flex-1"
          >
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-1 mb-2" aria-label="Colour key">
        {TIER_LABELS.map((l, i) => (
          <span key={l} style={{ background: `${TIER_COLORS[i]}33`, color: TIER_COLORS[i] }} className="text-[10px] rounded px-1.5 py-0.5 flex-1 text-center">
            {l}
          </span>
        ))}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-2">
        {side === "def"
          ? pos === "DEF"
            ? "DEF: points opposing D/STs score against this offense. Rank 1 = fewest (toughest for your defense)."
            : `Points ${pos}s score against this defense. Rank 1 = fewest allowed (toughest for your ${pos}).`
          : pos === "DEF"
          ? "DEF: points this team's own D/ST scores. Rank 1 = most."
          : `Points this team's ${pos}s score. Rank 1 = most (best for your ${pos}).`}
        {" "}Tap a team for the games behind it, or a column heading to sort. Last 4 = average over the last 4 games ("*" = includes games from last season). {data?.adjusted ? "ROS is an estimate of rest-of-season points per game given the opponents still to come." : "Turn on Schedule adjusted to also see the rest-of-season (ROS) estimate."}
      </div>
      {error && <div style={{ color: C.major }} className="text-xs pb-2">{error}</div>}
      {data?.note && <div style={{ color: C.textMuted }} className="text-xs pb-2">{data.note}</div>}
      {!data && !error && <Loader2 size={18} className="animate-spin" style={{ color: C.brand }} />}
      {rows.length > 0 && (
        <table className="w-full text-xs" style={{ color: C.text }}>
          <thead style={{ color: C.textFaint }}>
            <tr>
              <SortTh k="rank">#</SortTh>
              <SortTh k="team">Team</SortTh>
              <SortTh k="value" title="Points per game in the selected sample">Pts/g</SortTh>
              {data.adjusted && <SortTh k="raw" title="Before the schedule adjustment">Raw</SortTh>}
              <SortTh k="last4" title="Average over the last 4 games played (this season, topped up from last season's end if needed; never schedule-adjusted)">Last 4</SortTh>
              {showRos && <SortTh k="ros" title="Rest-of-season expected points per game, from the schedule remaining (estimate)">ROS</SortTh>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.team}
                onClick={() => ctx.openDvp({ profile: data.profile, side, team: r.team, pos, mode: data.mode, adjusted: data.adjusted ? "1" : "0" })}
                style={{ borderTop: `1px solid ${C.border}`, background: `${TIER_COLORS[r.tier]}1c`, cursor: "pointer" }}
              >
                <td className={td} style={{ color: TIER_COLORS[r.tier], fontWeight: 600 }}>{r.rank}</td>
                <td className={td}>
                  <span className="inline-flex items-center gap-1.5">
                    <TeamLogo team={r.team} size={18} />
                    {r.team}
                  </span>
                </td>
                <td className={td} style={{ fontVariantNumeric: "tabular-nums" }}>{r.value}</td>
                {data.adjusted && <td className={td} style={{ color: C.textMuted }}>{r.raw}</td>}
                <td className={td} style={{ color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>{r.last4 ?? "—"}{r.last4Prev ? "*" : ""}</td>
                {showRos && <td className={td} style={{ color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>{r.ros ?? "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pt-2">{loadedSummary(data.loaded, data.season)}</div>}
      {authUser?.role === "owner" && <WeatherSettingsPanel />}
    </div>
  );
}

// Owner-only: the app-wide thresholds for flagging weather on the lineup page.
function WeatherSettingsPanel() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.getWeatherSettings().then(setS).catch(() => {});
  }, []);
  if (!s) return null;
  const field = (k, label, step = 1) => (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide" style={{ color: C.textFaint }}>
      {label}
      <input
        type="number"
        step={step}
        value={s[k]}
        onChange={(e) => {
          setSaved(false);
          setS({ ...s, [k]: e.target.value });
        }}
        style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
        className="w-20 text-xs rounded-md px-2 py-1 normal-case"
      />
    </label>
  );
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mt-4">
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm mb-1 flex items-center gap-1.5">
        <Wind size={14} style={{ color: C.brand }} /> Weather flags (all users)
      </div>
      <div style={{ color: C.textMuted }} className="text-[11px] mb-2">Outdoor games over the kickoff hour and the 3 after it. A flag marks the starter "minor" on the lineup page.</div>
      <div className="flex flex-wrap gap-2 mb-2">
        {field("windMph", "Wind mph")}
        {field("gustMph", "Gust mph")}
        {field("precipProbPct", "Rain chance %")}
        {field("minPrecipIn", 'Min in/hr', 0.01)}
        {field("heavyPrecipIn", 'Heavy in/hr', 0.01)}
        {field("snowIn", 'Snow in', 0.05)}
      </div>
      <div className="flex items-center gap-2">
        <Toggle checked={s.enabled !== false} onChange={(v) => setS({ ...s, enabled: v })}>Flags on</Toggle>
        <button
          onClick={() => api.saveWeatherSettings(s).then((n) => { setS(n); setSaved(true); })}
          style={{ background: C.brand, color: C.text }}
          className="text-xs rounded-md px-3 py-1.5"
        >
          Save
        </button>
        {saved && <span style={{ color: C.ok }} className="text-[11px]">Saved — applies on the next refresh</span>}
      </div>
    </div>
  );
}

const ACC_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

// What each accuracy measure means (shown in the info pop-up) — and which direction is better.
const ACC_METRICS = [
  { key: "rankCorr", label: "Rank correlation", short: "Rank", better: "high", fmt: (v) => v, help: "How well the source ORDERS players at the same position in the same week (Spearman correlation, averaged over position-weeks). 1 = perfect order, 0 = no better than chance. This is what matters for start/sit and waiver decisions." },
  { key: "mae", label: "Average miss (MAE)", short: "Avg miss", better: "low", fmt: (v) => v, help: "Average absolute difference between projection and actual points. Lower is better." },
  { key: "rmse", label: "RMSE", short: "RMSE", better: "low", fmt: (v) => v, help: "Like average miss but punishes big misses more. Lower is better." },
  { key: "bias", label: "Bias", short: "Bias", better: "zero", fmt: (v) => (v > 0 ? `+${v}` : v), help: "Average projected minus actual. Positive = the source runs high, negative = low. Closest to 0 is best." },
  { key: "sdErr", label: "SD of error", short: "SD", better: "low", fmt: (v) => v, help: "How spread out the errors are. Lower is steadier." },
  { key: "corr", label: "Correlation", short: "Corr", better: "high", fmt: (v) => v, help: "Pearson correlation of projected with actual points across all players. Higher is better." },
  { key: "within3", label: "Within ±3 pts", short: "±3", better: "high", fmt: (v) => `${Math.round(v * 100)}%`, help: "Share of projections within 3 points of the actual score." },
  { key: "within5", label: "Within ±5 pts", short: "±5", better: "high", fmt: (v) => `${Math.round(v * 100)}%`, help: "Share of projections within 5 points of the actual score." },
];

function AccuracyInfoModal({ onClose }) {
  return (
    <Modal title="How to read these numbers" onClose={onClose}>
      <div style={{ color: C.textMuted }} className="text-xs space-y-2">
        <div>Each source's projection is frozen at the player's kickoff and compared with what the player actually scored (in the selected scoring). A projected player with no stat line counts as 0; projections under 0.5 pts are ignored. Only QB, RB, WR, TE, K and DEF are scored.</div>
        {ACC_METRICS.map((m) => (
          <div key={m.key}>
            <span style={{ color: C.text }} className="font-medium">{m.label}.</span> {m.help}
          </div>
        ))}
        <div><span style={{ color: C.text }} className="font-medium">Same players only</span> keeps just the players every source projected that week, so a source isn't helped or hurt by covering different players. <span style={{ color: C.text }} className="font-medium">Lean-adjusted</span> scores the projections after the app's source-vs-Vegas lean correction.</div>
      </div>
    </Modal>
  );
}

function AccuracyScreen({ authUser }) {
  const thisSeason = new Date().getFullYear();
  const [f, setF] = useState({ season: String(thisSeason), profile: "", positions: ACC_POSITIONS, weekFrom: "1", weekTo: "18", sameOnly: false, adjusted: false });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState("rankCorr"); // matrix metric — rank correlation within position-week by default
  const [sort, setSort] = useState({ key: null, dir: -1 });
  const [info, setInfo] = useState(false);
  const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));
  const togglePos = (p) =>
    setF((prev) => {
      const has = prev.positions.includes(p);
      if (has && prev.positions.length === 1) return prev; // keep at least one
      return { ...prev, positions: has ? prev.positions.filter((x) => x !== p) : ACC_POSITIONS.filter((x) => x === p || prev.positions.includes(x)) };
    });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { positions, ...rest } = f;
    api
      .getAccuracy({ ...rest, ...(positions.length < ACC_POSITIONS.length ? { positions: positions.join(",") } : {}), sameOnly: f.sameOnly ? "1" : "0", adjusted: f.adjusted ? "1" : "0" })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (!f.profile && d.meta?.profile) setF((prev) => ({ ...prev, profile: d.meta.profile }));
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [f]);

  const seasons = [...new Set([...(data?.meta?.seasons || []), thisSeason, thisSeason - 1])].sort((a, b) => b - a);
  const weekOpts = Array.from({ length: 18 }, (_, i) => ({ value: String(i + 1), label: `Week ${i + 1}` }));
  const allSel = f.positions.length === ACC_POSITIONS.length;
  const baseRows = (data?.summary || []).filter((r) => (r.pos === "ALL" ? true : f.positions.includes(r.pos)));
  // v2.9: every column sorts on a header tap; with no sort chosen, the server's order is kept.
  const rows = sort.key
    ? [...baseRows].sort((a, b) => {
        const x = sort.key === "source" ? SRC_NAME[a.source] : sort.key === "pos" ? a.pos : a[sort.key];
        const y = sort.key === "source" ? SRC_NAME[b.source] : sort.key === "pos" ? b.pos : b[sort.key];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
      })
    : baseRows;
  const clickSort = (key) => setSort((cur) => (cur.key === key ? { key, dir: -cur.dir } : { key, dir: key === "source" || key === "pos" ? 1 : -1 }));
  const th = "text-[10px] uppercase tracking-wide font-medium px-1.5 py-1 text-right";
  const td = "text-xs px-1.5 py-1 text-right";
  const SortTh = ({ k, children, title, left }) => (
    <th className={`${th} ${left ? "text-left" : ""}`} title={title} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => clickSort(k)} data-acc-sort={k} className="uppercase tracking-wide font-medium" style={{ color: sort.key === k ? C.text : "inherit" }}>
        {children}
        {sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  // Source × position matrix for the chosen metric; the best source per column is highlighted.
  const m = ACC_METRICS.find((x) => x.key === metric) || ACC_METRICS[0];
  const matrixSources = ["V", "T", "S", "E"].filter((s) => (data?.summary || []).some((r) => r.source === s));
  const matrixCols = [...f.positions, ...(f.positions.length > 1 ? ["ALL"] : [])];
  const cell = (s, p) => (data?.summary || []).find((r) => r.source === s && r.pos === p) || null;
  const score = (r) => (r?.[m.key] == null ? null : m.better === "zero" ? Math.abs(r[m.key]) : r[m.key]);
  const bestIn = (p) => {
    const vals = matrixSources.map((s) => [s, score(cell(s, p))]).filter(([, v]) => v != null);
    if (vals.length < 2) return null;
    return vals.reduce((best, cur) => (m.better === "high" ? (cur[1] > best[1] ? cur : best) : cur[1] < best[1] ? cur : best))[0];
  };

  return (
    <div className="px-4 py-3 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div style={{ color: C.textMuted }} className="text-xs px-1">
          Every source's projection (frozen at each player's kickoff) compared with actual points, scored with the selected scoring profile. A projected player with no stat line counts as 0. Projections under 0.5 pts are ignored.
        </div>
        <button type="button" onClick={() => setInfo(true)} aria-label="What do these measures mean?" data-acc-info style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="text-xs rounded-full w-6 h-6 shrink-0 font-semibold">
          i
        </button>
      </div>
      {info && <AccuracyInfoModal onClose={() => setInfo(false)} />}
      <div className="grid grid-cols-2 gap-2">
        <Select label="Season" value={f.season} onChange={set("season")} options={seasons.map((s) => ({ value: String(s), label: String(s) }))} />
        <Select label="Scoring" value={f.profile} onChange={set("profile")} options={(data?.meta?.profiles || []).map((p) => ({ value: p.profile, label: p.label }))} />
        <div className="grid grid-cols-2 gap-2 col-span-2">
          <Select label="From" value={f.weekFrom} onChange={set("weekFrom")} options={weekOpts} />
          <Select label="To" value={f.weekTo} onChange={set("weekTo")} options={weekOpts} />
        </div>
      </div>
      <div>
        <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide pb-1">Positions</div>
        <div className="flex flex-wrap gap-1.5">
          {ACC_POSITIONS.map((p) => (
            <Toggle key={p} checked={f.positions.includes(p)} onChange={() => togglePos(p)}>{p}</Toggle>
          ))}
          {!allSel && (
            <button type="button" onClick={() => set("positions")(ACC_POSITIONS)} style={{ color: C.textMuted }} className="text-[11px] underline px-1">All</button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Toggle checked={f.sameOnly} onChange={set("sameOnly")}>Same players only</Toggle>
        <Toggle checked={f.adjusted} onChange={set("adjusted")}>Lean-adjusted</Toggle>
      </div>
      {loading && <div className="flex items-center gap-2 px-1" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /><span className="text-xs">Crunching…</span></div>}
      {error && <div style={{ color: C.major }} className="text-xs px-1">{error}</div>}
      {data?.meta?.note && <div style={{ color: C.textMuted }} className="text-xs px-1">{data.meta.note}</div>}

      {data && !data.meta?.note && (
        <>
          <div style={{ color: C.textFaint }} className="text-[11px] px-1">
            Scored weeks: {data.meta.scoredWeeks.length ? data.meta.scoredWeeks.join(", ") : "none yet (actuals arrive after each week finishes)"}
            {data.meta.backfilledWeeks.length > 0 && ` · backfilled (projection timing approximate): ${data.meta.backfilledWeeks.join(", ")}`}
          </div>
          <div data-acc-matrix>
            <div className="flex items-end justify-between gap-2">
              <SectionLabel>Source × position</SectionLabel>
              <Select label="Measure" value={metric} onChange={setMetric} options={ACC_METRICS.map((x) => ({ value: x.key, label: x.label }))} />
            </div>
            <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-1">
              {m.help} Best source per position is highlighted.
            </div>
            <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
              <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                  <tr>
                    <th className={`${th} text-left`}>Source</th>
                    {matrixCols.map((p) => (
                      <th key={p} className={th}>{p === "ALL" ? "All" : p}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixSources.map((s) => (
                    <tr key={s} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td className={`${td} text-left`}><span style={{ color: SRC_COLOR[s] }}>●</span> {SRC_NAME[s]}</td>
                      {matrixCols.map((p) => {
                        const r = cell(s, p);
                        const best = bestIn(p) === s;
                        return (
                          <td key={p} className={td} style={{ color: best ? C.ok : C.text, fontWeight: best ? 600 : 400 }} title={r ? `n=${r.n}` : "no data"} data-matrix-cell={`${s}|${p}`}>
                            {r && r[m.key] != null ? m.fmt(r[m.key]) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <SectionLabel>Accuracy by source</SectionLabel>
            {rows.length === 0 ? (
              <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No scored projections for these filters yet.</div>
            ) : (
              <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
                <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                  <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                    <tr>
                      <SortTh k="source" left>Source</SortTh>
                      <SortTh k="pos" left>Pos</SortTh>
                      <SortTh k="n">n</SortTh>
                      <SortTh k="bias" title="Average projected minus actual (+ = runs high)">Bias</SortTh>
                      <SortTh k="mae" title="Average absolute miss">Avg miss</SortTh>
                      <SortTh k="rmse">RMSE</SortTh>
                      <SortTh k="sdErr" title="Standard deviation of the error">SD</SortTh>
                      <SortTh k="corr" title="Correlation of projected with actual">Corr</SortTh>
                      <SortTh k="rankCorr" title="Rank correlation within position each week">Rank</SortTh>
                      <SortTh k="within3">±3</SortTh>
                      <SortTh k="within5">±5</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.source}|${r.pos}`} style={{ borderTop: `1px solid ${C.border}`, background: r.pos === "ALL" ? C.surface : "transparent" }}>
                        <td className={`${td} text-left`}><span style={{ color: SRC_COLOR[r.source] }}>●</span> {SRC_NAME[r.source]}</td>
                        <td className={`${td} text-left`} style={{ color: C.textMuted }}>{r.pos === "ALL" ? "All" : r.pos}</td>
                        <td className={td}>{r.n}</td>
                        <td className={td} style={{ color: Math.abs(r.bias) >= 1 ? C.minor : C.text }}>{r.bias > 0 ? "+" : ""}{r.bias}</td>
                        <td className={td}>{r.mae}</td>
                        <td className={td}>{r.rmse}</td>
                        <td className={td}>{r.sdErr}</td>
                        <td className={td}>{r.corr ?? "—"}</td>
                        <td className={td}>{r.rankCorr ?? "—"}</td>
                        <td className={td}>{Math.round(r.within3 * 100)}%</td>
                        <td className={td}>{Math.round(r.within5 * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <SectionLabel>Average miss by week</SectionLabel>
            <MaeChart byWeek={data.byWeek} />
          </div>
          {data.leans && (
            <div>
              <SectionLabel>Current leans vs Vegas (week {data.leans.week}, 4-week rolling)</SectionLabel>
              <div style={{ color: C.textMuted }} className="text-[11px] px-1 pb-1">
                Factor applied to each source's projection when a player has no Vegas props. 1.08 = the source runs 8% under Vegas. "pooled" = under 8 overlapping players, all-positions factor used.
              </div>
              <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
                <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                  <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                    <tr>
                      <th className={`${th} text-left`}>Source</th>
                      {["QB", "RB", "WR", "TE", "K"].map((p) => (
                        <th key={p} className={th}>{p}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {["T", "S", "E"].map((s) => (
                      <tr key={s} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td className={`${td} text-left`}><span style={{ color: SRC_COLOR[s] }}>●</span> {SRC_NAME[s]}</td>
                        {["QB", "RB", "WR", "TE", "K"].map((p) => {
                          const l = data.leans[s]?.[p];
                          return (
                            <td key={p} className={td} style={{ color: l?.none ? C.textFaint : C.text }} title={l ? `n=${l.n}` : ""}>
                              {l?.none ? "—" : `×${l.factor}${l.pooled ? "*" : ""}`}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: C.textFaint }} className="text-[10px] px-1 pt-1">* pooled · — not enough overlap yet (no adjustment) · DEF has no Vegas props, so it's never adjusted.</div>
            </div>
          )}
        </>
      )}
      {authUser?.role === "owner" && <BackfillPanel />}
    </div>
  );
}
