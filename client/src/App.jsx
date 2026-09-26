import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ChevronRight,
  RefreshCw,
  ListChecks,
  TrendingUp,
  Users,
  ArrowLeftRight,
  Stethoscope,
  Clock,
  Link2,
  Loader2,
  LogOut,
  Settings2,
  DollarSign,
  Lock,
} from "lucide-react";
import * as api from "./api.js";

/* ------------------------------------------------------------------ */
/*  DESIGN TOKENS                                                     */
/* ------------------------------------------------------------------ */
const C = {
  bg: "#10171A",
  surface: "#1A2426",
  surfaceRaised: "#212C2E",
  border: "#2B3A3D",
  text: "#EDF3F1",
  textMuted: "#8FA39E",
  textFaint: "#5E7570",
  brand: "#4A8FC2",
  ok: "#3FAE58",
  okBg: "rgba(63,174,88,0.13)",
  minor: "#D9A521",
  minorBg: "rgba(217,165,33,0.14)",
  major: "#D6533B",
  majorBg: "rgba(214,83,59,0.14)",
};

const STATUS = {
  ok: { color: C.ok, bg: C.okBg, Icon: CheckCircle2, label: "OK" },
  minor: { color: C.minor, bg: C.minorBg, Icon: AlertTriangle, label: "Minor" },
  major: { color: C.major, bg: C.majorBg, Icon: XCircle, label: "Major" },
  na: { color: C.textMuted, bg: "rgba(143,163,158,0.12)", Icon: HelpCircle, label: "No data" },
};
const RANK = { ok: 0, minor: 1, major: 2 };
const worst = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "ok");

/* ------------------------------------------------------------------ */
/*  VARIANCE CALCULATIONS                                             */
/* ------------------------------------------------------------------ */
const FLEX_ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SFLX: ["QB", "RB", "WR", "TE"] };
const OUT_LIKE = ["Out", "Doubtful", "IR", "Suspended", "NA"];

function computeRoster(league) {
  const starterRows = league.starters.map(({ slot, player }) => {
    if (!player) return { slot, label: "(empty)", severity: "major", reasons: ["Empty starting roster slot"] };
    if (player.status === "Bye") return { slot, label: player.name, severity: "major", reasons: ["On bye — guaranteed zero"] };
    if (OUT_LIKE.includes(player.status))
      return { slot, label: player.name, severity: "major", reasons: [player.note || `${player.status} — hasn't been swapped`] };
    if (player.status === "Questionable")
      return { slot, label: player.name, severity: "minor", reasons: [player.note || "Questionable — game-time decision"] };
    return { slot, label: player.name, severity: "ok", reasons: [] };
  });

  league.starters.forEach(({ slot, player: flexPlayer }, idx) => {
    if (!FLEX_ELIGIBLE[slot] || !flexPlayer || flexPlayer.kickoff == null) return;
    const posIdx = league.starters.findIndex(
      (s) => s.slot === flexPlayer.pos && s.player && s.player.kickoff != null && s.player.kickoff > flexPlayer.kickoff
    );
    if (posIdx < 0) return;
    const positional = league.starters[posIdx];
    starterRows[idx].severity = "major";
    starterRows[idx].reasons.push(
      `Locks ${flexPlayer.kickoffLabel} — before ${positional.slot} slot's ${positional.player.name} (${positional.player.kickoffLabel}). Swap these two.`
    );
    starterRows[posIdx].severity = "major";
    starterRows[posIdx].reasons.push(`Later kickoff than ${slot}'s ${flexPlayer.name} — swap these two to preserve flexibility.`);
  });

  const benchRows = league.bench.map((p) => {
    if (!p) return { slot: "BN", label: "(empty)", severity: "minor", reasons: ["Open bench slot — consider a waiver add"] };
    if (p.irEligible) return { slot: "BN", label: p.name, severity: "minor", reasons: ["IR-eligible — move to an empty IR slot"] };
    return { slot: "BN", label: p.name, severity: "ok", reasons: [] };
  });
  const irRows = (league.ir || []).map((p) => ({ slot: "IR", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));
  const taxiRows = (league.taxi || []).map((p) => ({ slot: "TAXI", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));

  const rows = [...starterRows, ...benchRows].map((r) => ({ ...r, reason: r.reasons.join(" ") || null }));
  return { rows, irRows, taxiRows, status: worst(rows.map((r) => r.severity)) };
}

function computeLineup(league) {
  const rows = league.lineupComparison || [];
  const currentTotal = rows.reduce((sum, c) => sum + (c.current?.proj ?? 0), 0);
  const optimalTotal = rows.reduce((sum, c) => sum + (c.optimal?.proj ?? 0), 0);
  const delta = Math.max(0, optimalTotal - currentTotal);
  const status = delta === 0 ? "ok" : delta < 5 ? "minor" : "major";
  return { currentTotal, optimalTotal, delta, status };
}

function rankThreshold(pos, superflex) {
  if (pos === "QB") return superflex ? 36 : 24;
  if (pos === "RB" || pos === "WR") return 48;
  if (pos === "TE") return 24;
  return 0;
}

function computeWaiver(league, allLeagues) {
  const rows = (league.freeAgents || []).map((fa) => {
    const rankHit = fa.ecr != null && fa.ecr <= rankThreshold(fa.pos, league.superflex);
    const trendHit = fa.trending;
    const severity = rankHit && trendHit ? "major" : rankHit || trendHit ? "minor" : "ok";
    const crossLeagues = allLeagues
      .filter((l) => l.id !== league.id && !l.error)
      .filter((l) => (l.freeAgents || []).some((x) => x.name === fa.name))
      .map((l) => l.name);
    return { ...fa, rankHit, trendHit, severity, crossLeagues };
  });
  return { rows, status: worst(rows.map((r) => r.severity)) };
}

function computeTrade(league) {
  const rows = league.tradeSuggestions || [];
  return { rows, status: rows.length ? worst(rows.map((t) => t.severity)) : "ok" };
}

// Injury Watch now persists: every currently-injured player shows up
// every time, Minor once you've seen that exact status before, Major
// the first time. Rows come pre-computed this way from the server
// (db.js tracks "seen" per player+status in SQLite) — this just derives
// the tab's overall status from what the server already decided.
function computeInjury(league) {
  const rows = league.injuryEvents || [];
  const status = rows.length === 0 ? "ok" : rows.some((r) => !r.seen) ? "major" : "minor";
  return { rows, status };
}

/* ------------------------------------------------------------------ */
/*  UI PRIMITIVES                                                      */
/* ------------------------------------------------------------------ */
function StatusBadge({ status, label, onClick, compact }) {
  const s = STATUS[status];
  const Icon = s.Icon;
  return (
    <button
      onClick={onClick}
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}33` }}
      className={`flex items-center gap-1 rounded-md ${compact ? "px-1.5 py-1" : "px-2.5 py-1.5"} shrink-0`}
    >
      <Icon size={14} strokeWidth={2.3} />
      {label && <span className="text-xs font-medium" style={{ fontFamily: "Inter, sans-serif" }}>{label}</span>}
    </button>
  );
}

function SourceTag({ source }) {
  if (!source) return null;
  if (source === "actual") {
    return (
      <span style={{ color: C.brand }} className="absolute bottom-1 right-1.5 text-[9px] font-semibold tracking-wide">
        FINAL
      </span>
    );
  }
  return (
    <span style={{ color: C.textFaint }} className="absolute bottom-1 right-1.5 text-[9px] font-medium tracking-wide">
      {source}
    </span>
  );
}

function WeekPicker({ week, onChange, disabled }) {
  if (week == null) return null;
  return (
    <select
      value={week}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
      className="text-xs rounded-md px-2 py-1.5 outline-none shrink-0"
      aria-label="Select week"
    >
      {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
        <option key={w} value={w}>Week {w}</option>
      ))}
    </select>
  );
}

function Breadcrumb({ crumbs }) {
  return (
    <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight size={13} style={{ color: C.textFaint }} className="shrink-0" />}
          {c.onClick ? (
            <button
              onClick={c.onClick}
              style={{ color: C.textMuted, fontFamily: "Oswald, sans-serif" }}
              className="text-[15px] truncate shrink-0 max-w-[38%]"
            >
              {c.label}
            </button>
          ) : (
            <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-[15px] truncate">
              {c.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function TopBar({ crumbs, onRefresh, refreshing, syncedLabel, week, onWeekChange, showWeek }) {
  return (
    <div className="sticky top-0 z-10" style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <Breadcrumb crumbs={crumbs} />
        <div className="flex items-center gap-1.5 shrink-0">
          {showWeek && <WeekPicker week={week} onChange={onWeekChange} disabled={refreshing} />}
          <button
            onClick={onRefresh}
            style={{ color: refreshing ? C.brand : C.textMuted, visibility: onRefresh ? "visible" : "hidden" }}
            className="p-2 -mr-1"
            aria-label="Refresh"
          >
            <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {syncedLabel && <div className="px-4 pb-2 text-[11px]" style={{ color: C.textFaint }}>{syncedLabel}</div>}
    </div>
  );
}

const TAB_META = {
  roster: { label: "Roster", short: "Roster", Icon: ListChecks },
  lineup: { label: "Lineup Advice", short: "Lineup", Icon: TrendingUp },
  waiver: { label: "Waivers", short: "Waivers", Icon: Users },
  trade: { label: "Trade Radar", short: "Trades", Icon: ArrowLeftRight },
  injury: { label: "Injury Watch", short: "Injury", Icon: Stethoscope },
};

/* ------------------------------------------------------------------ */
/*  SCREENS                                                            */
/* ------------------------------------------------------------------ */
function Dashboard({ computed, onOpenLeague, onOpenTab, onLogout, onEditLeagues, sleeperUser }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-end pb-3">
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={onEditLeagues} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
            <Settings2 size={13} />
            Edit tracked leagues
          </button>
          <button onClick={onLogout} style={{ color: C.textMuted }} className="text-xs font-medium flex items-center gap-1">
            <LogOut size={13} />
            Log out
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {computed.map((lg) => (
          <div key={lg.id} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg overflow-hidden">
            <button onClick={() => onOpenLeague(lg.id)} className="w-full flex items-center justify-between px-4 py-3">
              <div className="text-left min-w-0">
                <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, color: C.text }} className="text-[15px] truncate">{lg.name}</div>
                <div className="text-xs truncate" style={{ color: C.textMuted }}>
                  {lg.error ? "Failed to load" : lg.teamName || "—"}
                </div>
              </div>
              <ChevronRight size={18} style={{ color: C.textFaint }} className="shrink-0" />
            </button>
            {!lg.error && (
              <div className="flex items-center gap-1 px-4 pb-2.5 pt-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
                {Object.entries(TAB_META).map(([key, meta]) => (
                  <StatusBadge key={key} status={lg[key].status} label={meta.short} compact onClick={() => onOpenTab(lg.id, key)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorScreen({ message }) {
  return (
    <div className="px-4 py-6">
      <div style={{ background: C.surface, border: `1px dashed ${C.major}55` }} className="rounded-lg px-4 py-5 text-center flex flex-col items-center gap-2">
        <XCircle size={20} style={{ color: C.major }} />
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">Couldn't load this league</div>
        <div style={{ color: C.textMuted }} className="text-xs max-w-xs">{message}</div>
      </div>
    </div>
  );
}

function LeagueOverview({ league, onOpenTab }) {
  if (league.error) return <ErrorScreen message={league.error} />;
  const summaries = {
    roster: league.roster.rows.some((r) => r.severity !== "ok")
      ? `${league.roster.rows.filter((r) => r.severity === "major").length} major, ${league.roster.rows.filter((r) => r.severity === "minor").length} minor issue(s)`
      : "Lineup is clean",
    lineup: league.lineup.delta === 0 ? "Current lineup is already optimal" : `Optimal lineup gains +${league.lineup.delta.toFixed(1)} pts`,
    waiver: `${league.waiver.rows.filter((r) => r.severity !== "ok").length} worth a look this week`,
    trade: league.trade.rows.length ? league.trade.rows[0].note : "No standout trade opportunities",
    injury: league.injury.rows.filter((r) => !r.seen).length
      ? `${league.injury.rows.filter((r) => !r.seen).length} new injury flag(s)`
      : league.injury.rows.length
      ? `${league.injury.rows.length} tracked, none new`
      : "No injuries on this roster",
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      {league.stale && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2">
          Showing cached data — a live refresh just failed. Try refreshing again shortly.
        </div>
      )}
      {league.dataWarnings?.length > 0 && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textMuted }} className="text-xs rounded-md px-3 py-2 space-y-1">
          {league.dataWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      {Object.entries(TAB_META).map(([key, meta]) => {
        const s = STATUS[league[key].status];
        const Icon = meta.Icon;
        return (
          <button key={key} onClick={() => onOpenTab(key)} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-left">
            <div style={{ background: s.bg, color: s.color }} className="p-2 rounded-md shrink-0">
              <Icon size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-[14px]">{meta.label}</div>
              <div style={{ color: C.textMuted }} className="text-xs truncate">{summaries[key]}</div>
            </div>
            <StatusBadge status={league[key].status} compact />
          </button>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-[11px] tracking-wide px-1 pt-3 pb-1.5">{children}</div>;
}

function RosterTab({ league }) {
  const starterRows = league.roster.rows.filter((r) => r.slot !== "BN");
  const benchRows = league.roster.rows.filter((r) => r.slot === "BN");
  const Row = ({ r }) => {
    const s = STATUS[r.severity];
    return (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3 py-2.5 flex items-start gap-3">
        <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs w-14 pt-0.5 shrink-0">{r.slot}</div>
        <div className="min-w-0 flex-1">
          <div style={{ color: C.text }} className="text-sm font-medium truncate">{r.label}</div>
          {r.kickoffLabel && <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{r.kickoffLabel}</div>}
          {r.reason && <div style={{ color: s.color }} className="text-xs mt-0.5">{r.reason}</div>}
        </div>
        <s.Icon size={16} style={{ color: s.color }} className="shrink-0 mt-0.5" />
      </div>
    );
  };
  // starterRows is index-aligned with league.starters (both built from the
  // same array with no filtering in between), so kickoff time can just be
  // zipped in by position rather than re-matched by label/slot text.
  const starterRowsWithKickoff = starterRows.map((r, i) => ({ ...r, kickoffLabel: league.starters[i]?.player?.kickoffLabel }));

  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Injury/IR/bye checks and flex lock-order all use live data — kickoff times and byes come from ESPN's schedule feed.
      </div>
      <SectionLabel>Starting Lineup</SectionLabel>
      <div className="space-y-1.5">{starterRowsWithKickoff.map((r, i) => <Row key={i} r={r} />)}</div>
      <SectionLabel>Bench</SectionLabel>
      <div className="space-y-1.5">{benchRows.map((r, i) => <Row key={i} r={r} />)}</div>
      {league.roster.irRows.length > 0 && (
        <>
          <SectionLabel>IR</SectionLabel>
          <div className="space-y-1.5">{league.roster.irRows.map((r, i) => <Row key={i} r={r} />)}</div>
        </>
      )}
      {league.roster.taxiRows.length > 0 && (
        <>
          <SectionLabel>Taxi Squad</SectionLabel>
          <div className="space-y-1.5">{league.roster.taxiRows.map((r, i) => <Row key={i} r={r} />)}</div>
        </>
      )}
    </div>
  );
}

function LineupTab({ league }) {
  const { currentTotal, optimalTotal, delta } = league.lineup;
  const rows = league.lineupComparison || [];
  return (
    <div className="px-4 py-3">
      {league.dataWarnings?.length > 0 && (
        <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2 space-y-1">
          {league.dataWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-4 flex items-center justify-around text-center mb-3">
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">Current</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{currentTotal.toFixed(1)}</div>
        </div>
        <div style={{ color: STATUS[league.lineup.status].color }} className="text-sm font-medium">
          {delta === 0 ? "= optimal" : `+${delta.toFixed(1)} pts`}
        </div>
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">Optimal</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{optimalTotal.toFixed(1)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-1 pb-1">
        <div style={{ color: C.textFaint }} className="text-[11px] font-medium tracking-wide">CURRENT</div>
        <div style={{ color: C.textFaint }} className="text-[11px] font-medium tracking-wide">OPTIMAL</div>
      </div>
      <div className="space-y-1.5">
        {rows.map((c, i) => (
          <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md overflow-hidden">
            <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif", borderBottom: `1px solid ${C.border}` }} className="text-[10px] px-3 py-1 flex items-center justify-between">
              <span>{c.slot}{c.locked ? " · Played" : ""}</span>
              {c.changed && c.delta !== 0 && (
                <span style={{ color: c.delta > 0 ? C.minor : C.ok }}>{c.delta > 0 ? "+" : ""}{c.delta.toFixed(1)} pts</span>
              )}
            </div>
            <div className="grid grid-cols-2">
              <div
                style={{ background: c.changed ? C.majorBg : "transparent", borderRight: `1px solid ${C.border}` }}
                className="relative px-3 py-2.5 pb-4"
              >
                <div style={{ color: c.changed ? C.major : C.text }} className="text-sm font-medium truncate">{c.current?.name ?? "(empty)"}</div>
                <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{c.current?.proj != null ? c.current.proj.toFixed(1) : "—"}</div>
                <SourceTag source={c.current?.projSource} />
              </div>
              <div style={{ background: c.changed ? C.okBg : "transparent" }} className="relative px-3 py-2.5 pb-4">
                <div style={{ color: c.changed ? C.ok : C.text }} className="text-sm font-medium truncate">{c.optimal?.name ?? "(none available)"}</div>
                <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{c.optimal?.proj != null ? c.optimal.proj.toFixed(1) : "—"}</div>
                {c.optimal?.note && <div style={{ color: C.brand }} className="text-[10px] mt-0.5">{c.optimal.note}</div>}
                <SourceTag source={c.optimal?.projSource} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FaabPanel({ sessionId, leagueId }) {
  const [state, setState] = useState({ loading: false, result: null, error: null });
  const run = async () => {
    setState({ loading: true, result: null, error: null });
    try {
      const result = await api.getFaabSuggestions(sessionId, leagueId);
      setState({ loading: false, result, error: null });
    } catch (err) {
      setState({ loading: false, result: null, error: err.message });
    }
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm flex items-center gap-1.5">
          <DollarSign size={14} style={{ color: C.brand }} />
          FAAB Suggestions
        </div>
        <button onClick={run} disabled={state.loading} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          {state.loading ? <Loader2 size={12} className="animate-spin" /> : null}
          {state.loading ? "Calculating…" : "Get suggestions"}
        </button>
      </div>
      <div style={{ color: C.textMuted }} className="text-[11px] mb-2">
        Based on winning waiver bids in your tracked leagues only since last Tuesday — not platform-wide (Sleeper's API doesn't expose that). With a small league sample, treat this as a directional guide, not a real confidence interval.
      </div>
      {state.error && <div style={{ color: C.major }} className="text-xs">{state.error}</div>}
      {state.result && state.result.note && <div style={{ color: C.textMuted }} className="text-xs">{state.result.note}</div>}
      {state.result?.players?.length > 0 && (
        <div className="space-y-1.5 mt-1">
          {state.result.players.map((p, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span style={{ color: C.text }} className="truncate">{p.name} <span style={{ color: C.textFaint }}>({p.pos})</span></span>
              <span style={{ color: C.textMuted }} className="shrink-0 ml-2 text-right">
                70%: {state.result.budget ? `$${Math.round((state.result.budget * p.suggestion70Pct) / 100)}` : `${p.suggestion70Pct?.toFixed(0)}%`}
                {" · "}
                95%: {state.result.budget ? `$${Math.round((state.result.budget * p.suggestion95Pct) / 100)}` : `${p.suggestion95Pct?.toFixed(0)}%`}
                {" "}<span style={{ color: C.textFaint }}>(n={p.sampleSize})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaiverTab({ league, sessionId }) {
  return (
    <div className="px-4 py-3">
      <FaabPanel sessionId={sessionId} leagueId={league.id} />
      <SectionLabel>Available Players</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Filtered against every roster in your league, not just yours.
      </div>
      <div className="space-y-1.5">
        {league.waiver.rows.map((p, i) => {
          const s = STATUS[p.severity];
          return (
            <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="relative rounded-md px-3 py-2.5 pb-4">
              <div className="flex items-center gap-3">
                <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs w-9 shrink-0">{p.pos}</div>
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm font-medium truncate">{p.name}</div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">
                    {p.proj != null ? `Proj ${p.proj.toFixed(1)} · ` : ""}
                    {p.ecr != null ? `ECR #${p.ecr} ` : "ECR unmatched "}
                    {p.trendHit ? "· Trending add" : ""}
                  </div>
                </div>
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
              </div>
              {p.crossLeagues.length > 0 && (
                <div style={{ color: C.brand }} className="text-xs mt-1.5 pl-12">Also available in: {p.crossLeagues.join(", ")}</div>
              )}
              <SourceTag source={p.projSource} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StrengthWeaknessRow({ label, items, color }) {
  if (!items?.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{label}:</span>
      {items.map((it, i) => (
        <span key={i} style={{ background: `${color}22`, color }} className="text-[11px] rounded px-1.5 py-0.5">
          {it.pos} <span style={{ opacity: 0.7 }}>(~{it.avgEcr})</span>
        </span>
      ))}
    </div>
  );
}

function TradeTab({ league }) {
  const teams = league.leagueTeams || [];
  const me = teams.find((t) => t.isMe);
  const others = teams.filter((t) => !t.isMe);
  const suggestionsByTeam = {};
  (league.trade.rows || []).forEach((t) => {
    (suggestionsByTeam[t.theirTeam] = suggestionsByTeam[t.theirTeam] || []).push(t);
  });

  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Based on average ECR by position across every roster in the league (a rest-of-season-oriented signal, not a single week's projection) — not a dedicated trade-value model.
      </div>

      {me && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 mb-3 space-y-1.5">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm mb-1">Your Team</div>
          <StrengthWeaknessRow label="Strong" items={me.strengths} color={C.ok} />
          <StrengthWeaknessRow label="Weak" items={me.weaknesses} color={C.major} />
        </div>
      )}

      <SectionLabel>League Teams &amp; Trade Ideas</SectionLabel>
      {others.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No other teams' data available yet.</div>
      ) : (
        <div className="space-y-2.5">
          {others.map((t, i) => {
            const suggestions = suggestionsByTeam[t.team] || [];
            return (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-1.5">
                <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{t.team}</div>
                <StrengthWeaknessRow label="Strong" items={t.strengths} color={C.ok} />
                <StrengthWeaknessRow label="Weak" items={t.weaknesses} color={C.major} />
                {suggestions.length > 0 ? (
                  <div className="space-y-1.5 pt-1.5" style={{ borderTop: `1px solid ${C.border}` }}>
                    {suggestions.map((s, j) => {
                      const sc = STATUS[s.severity];
                      return (
                        <div key={j}>
                          <div style={{ color: C.text }} className="text-xs">
                            <span style={{ color: C.textMuted }}>Give </span>{s.give}<span style={{ color: C.textMuted }}> · Get </span>{s.get}
                          </div>
                          <div style={{ color: sc.color }} className="text-[11px] mt-0.5">{s.note}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: C.textFaint }} className="text-[11px] pt-1">No mutually beneficial swap found with this team right now.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InjuryTab({ league }) {
  return (
    <div className="px-4 py-3">
      <SectionLabel>Currently Tracked</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Persists as long as a player carries a designation. Minor once you've seen this exact status before, Major the first time it appears.
      </div>
      {league.injury.rows.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No injury designations on this roster right now.</div>
      ) : (
        <div className="space-y-1.5">
          {league.injury.rows.map((e) => {
            const sev = e.seen ? "minor" : "major";
            const s = STATUS[sev];
            return (
              <div key={e.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3 flex items-center gap-3">
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm font-medium">{e.player}</div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{e.status}{e.note ? ` — ${e.note}` : ""}</div>
                </div>
                <div style={{ color: C.textFaint }} className="text-xs shrink-0">{e.seen ? "Seen before" : "New"}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TAB_COMPONENTS = { roster: RosterTab, lineup: LineupTab, waiver: WaiverTab, trade: TradeTab, injury: InjuryTab };

function LoginScreen({ password, setPassword, onSubmit, loading, error }) {
  return (
    <div className="px-5 py-8 flex flex-col items-center text-center gap-4">
      <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><Lock size={22} /></div>
      <div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg mb-1">Log in</div>
        <div style={{ color: C.textMuted }} className="text-sm max-w-xs">This app is shared across your devices with one password.</div>
      </div>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !loading && password && onSubmit()}
        placeholder="Password"
        autoFocus
        style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}
        className="w-full max-w-xs rounded-md px-3.5 py-2.5 text-sm outline-none"
      />
      {error && <div style={{ color: C.major }} className="text-xs max-w-xs">{error}</div>}
      <button
        onClick={onSubmit}
        disabled={loading || !password}
        style={{ background: loading || !password ? C.surfaceRaised : C.brand, color: C.text }}
        className="w-full max-w-xs rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-2"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
        {loading ? "Logging in…" : "Log in"}
      </button>
    </div>
  );
}

function ConnectScreen({ username, setUsername, onSubmit, connecting, error }) {
  return (
    <div className="px-5 py-8 flex flex-col items-center text-center gap-4">
      <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><Link2 size={22} /></div>
      <div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg mb-1">Connect your Sleeper account</div>
        <div style={{ color: C.textMuted }} className="text-sm max-w-xs">Enter your Sleeper username. This and your tracked leagues are remembered on the server — logging in from any device picks up right where you left off.</div>
      </div>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !connecting && username.trim() && onSubmit()}
        placeholder="Sleeper username"
        style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}
        className="w-full max-w-xs rounded-md px-3.5 py-2.5 text-sm outline-none"
      />
      {error && <div style={{ color: C.major }} className="text-xs max-w-xs">{error}</div>}
      <button
        onClick={onSubmit}
        disabled={connecting || !username.trim()}
        style={{ background: connecting || !username.trim() ? C.surfaceRaised : C.brand, color: C.text }}
        className="w-full max-w-xs rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-2"
      >
        {connecting ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
        {connecting ? "Looking you up…" : "Find my leagues"}
      </button>
    </div>
  );
}

function SelectLeaguesScreen({ leagues, selectedIds, onToggle, onConfirm, loading, error }) {
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-3">Pick which leagues to track.</div>
      <div className="space-y-1.5">
        {leagues.map((l) => {
          const checked = selectedIds.includes(l.league_id);
          return (
            <button
              key={l.league_id}
              onClick={() => onToggle(l.league_id)}
              style={{ background: C.surface, border: `1px solid ${checked ? C.brand : C.border}` }}
              className="w-full flex items-center justify-between rounded-md px-3.5 py-3 text-left"
            >
              <div className="min-w-0">
                <div style={{ color: C.text }} className="text-sm font-medium truncate">{l.name}</div>
                <div style={{ color: C.textMuted }} className="text-xs">{l.season} season</div>
              </div>
              <div style={{ background: checked ? C.brand : "transparent", border: `1px solid ${checked ? C.brand : C.textFaint}` }} className="w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                {checked && <CheckCircle2 size={14} color={C.bg} />}
              </div>
            </button>
          );
        })}
      </div>
      {error && <div style={{ color: C.major }} className="text-xs px-1 pt-3">{error}</div>}
      <button
        onClick={onConfirm}
        disabled={loading || selectedIds.length === 0}
        style={{ background: loading || selectedIds.length === 0 ? C.surfaceRaised : C.brand, color: C.text }}
        className="w-full rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-2 mt-4"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : null}
        {loading ? "Pulling rosters + projections…" : `Track ${selectedIds.length} league(s)`}
      </button>
    </div>
  );
}

function BootstrapScreen() {
  return (
    <div className="px-5 py-16 flex flex-col items-center gap-3">
      <Loader2 size={24} className="animate-spin" style={{ color: C.brand }} />
      <div style={{ color: C.textMuted }} className="text-sm">Reconnecting…</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ROOT APP                                                           */
/* ------------------------------------------------------------------ */
const AUTO_REFRESH_MS = 30 * 60 * 1000;

export default function App() {
  const [view, setView] = useState({ screen: "bootstrapping" });
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState("just now");

  const [username, setUsername] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [sleeperUser, setSleeperUser] = useState(null);
  const [availableLeagues, setAvailableLeagues] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  const [liveLeagues, setLiveLeagues] = useState([]);
  const [week, setWeek] = useState(null);

  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);

  // Browser back/forward support: every real navigation pushes a history
  // entry carrying the view state; popstate restores it directly without
  // pushing again (that's what "going back" means — undoing the push).
  const navigate = useCallback((newView, opts = {}) => {
    setView(newView);
    if (opts.replace) window.history.replaceState(newView, "");
    else window.history.pushState(newView, "");
  }, []);

  useEffect(() => {
    const onPopState = (e) => setView(e.state || { screen: "dashboard" });
    window.addEventListener("popstate", onPopState);
    window.history.replaceState({ screen: "bootstrapping" }, "");
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const computed = useMemo(
    () =>
      liveLeagues.map((lg) =>
        lg.error
          ? lg
          : {
              ...lg,
              roster: computeRoster(lg),
              lineup: computeLineup(lg),
              waiver: computeWaiver(lg, liveLeagues),
              trade: computeTrade(lg),
              injury: computeInjury(lg),
            }
      ),
    [liveLeagues]
  );

  const activeLeague = useMemo(() => computed.find((l) => l.id === (view.leagueId || null)), [computed, view.leagueId]);

  // Shared by both the bootstrap effect and the post-login handler: given
  // the server's last-session record (username + tracked leagues + week),
  // reconnect to Sleeper and rebuild the dashboard. This is what replaces
  // localStorage — the record lives in SQLite, tied to the login, not the
  // browser, so it follows the person across devices.
  const reconnectFromLastSession = useCallback(
    async (last) => {
      if (!last?.username) {
        navigate({ screen: "connect" }, { replace: true });
        return;
      }
      setUsername(last.username);
      try {
        const { sessionId, user, week: currentWeek, leagues } = await api.connect(last.username);
        setSessionId(sessionId);
        setSleeperUser(user);
        setAvailableLeagues(leagues);
        const validIds = leagues.map((l) => l.league_id);
        const restoredIds = (last.leagueIds || []).filter((id) => validIds.includes(id));
        setSelectedIds(restoredIds.length ? restoredIds : validIds);
        if (restoredIds.length === 0) {
          navigate({ screen: "select" }, { replace: true });
          return;
        }
        setLoadingLeagues(true);
        const { leagues: built, week: builtWeek } = await api.buildLeagues(sessionId, restoredIds, last.week ?? undefined);
        setLiveLeagues(built);
        setWeek(builtWeek ?? currentWeek);
        setSyncedAt("just now");
        navigate({ screen: "dashboard" }, { replace: true });
      } catch (err) {
        setConnectError(err.message || "Couldn't reconnect automatically — try again.");
        navigate({ screen: "connect" }, { replace: true });
      } finally {
        setLoadingLeagues(false);
      }
    },
    [navigate]
  );

  useEffect(() => {
    (async () => {
      try {
        const status = await api.getAuthStatus();
        if (!status.authenticated) {
          navigate({ screen: "login" }, { replace: true });
          return;
        }
        await reconnectFromLastSession(status.lastSession);
      } catch {
        navigate({ screen: "login" }, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoginSubmit = useCallback(async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await api.login(password);
      setPassword("");
      const status = await api.getAuthStatus();
      await reconnectFromLastSession(status.lastSession);
    } catch (err) {
      setLoginError(err.message || "Couldn't log in — try again.");
    } finally {
      setLoggingIn(false);
    }
  }, [password, reconnectFromLastSession]);

  const handleConnectSubmit = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { sessionId, user, week: currentWeek, leagues } = await api.connect(username.trim());
      setSessionId(sessionId);
      setSleeperUser(user);
      setAvailableLeagues(leagues);
      setSelectedIds(leagues.map((l) => l.league_id));
      setWeek(currentWeek);
      navigate({ screen: "select" });
    } catch (err) {
      setConnectError(err.message || "Couldn't reach the server. Is it running?");
    } finally {
      setConnecting(false);
    }
  }, [username, navigate]);

  const handleToggleLeague = useCallback((id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const handleConfirmSelection = useCallback(async () => {
    setLoadingLeagues(true);
    setConnectError(null);
    try {
      const { leagues, week: builtWeek } = await api.buildLeagues(sessionId, selectedIds, week);
      setLiveLeagues(leagues);
      setWeek(builtWeek);
      setSyncedAt("just now");
      // No client-side persistence call needed here — the build endpoint
      // already calls setLastSession() server-side, which is what
      // reconnectFromLastSession() reads on the next login/bootstrap.
      navigate({ screen: "dashboard" });
    } catch (err) {
      setConnectError(err.message || "Couldn't load those leagues — try again.");
    } finally {
      setLoadingLeagues(false);
    }
  }, [sessionId, selectedIds, week, username, navigate]);

  const handleRefresh = useCallback(async () => {
    if (!sessionId || selectedIds.length === 0) return;
    setRefreshing(true);
    try {
      const { leagues, week: builtWeek } = await api.buildLeagues(sessionId, selectedIds, week);
      setLiveLeagues(leagues);
      setWeek(builtWeek);
      setSyncedAt("just now");
    } catch (err) {
      setConnectError(err.message || "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, selectedIds, week]);

  const handleWeekChange = useCallback(
    async (newWeek) => {
      if (!sessionId || selectedIds.length === 0) {
        setWeek(newWeek);
        return;
      }
      setRefreshing(true);
      try {
        const { leagues, week: builtWeek } = await api.buildLeagues(sessionId, selectedIds, newWeek);
        setLiveLeagues(leagues);
        setWeek(builtWeek ?? newWeek);
        setSyncedAt("just now");
      } catch (err) {
        setConnectError(err.message || "Couldn't load that week.");
      } finally {
        setRefreshing(false);
      }
    },
    [sessionId, selectedIds]
  );

  const refreshRef = useRef(handleRefresh);
  refreshRef.current = handleRefresh;
  useEffect(() => {
    if (!sessionId || selectedIds.length === 0) return;
    const id = setInterval(() => refreshRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [sessionId, selectedIds.length]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // A network failure logging out shouldn't trap someone on the
      // dashboard — clear local state and send them to the login screen
      // regardless; the server-side session just won't be revoked until
      // it naturally expires.
    }
    setSessionId(null);
    setSleeperUser(null);
    setAvailableLeagues([]);
    setSelectedIds([]);
    setLiveLeagues([]);
    setWeek(null);
    setUsername("");
    setPassword("");
    setConnectError(null);
    setLoginError(null);
    navigate({ screen: "login" });
  }, [navigate]);

  const handleEditLeagues = useCallback(async () => {
    if (!username) {
      navigate({ screen: "connect" });
      return;
    }
    setConnectError(null);
    setConnecting(true);
    try {
      const { sessionId: freshSessionId, user, leagues } = await api.connect(username);
      setSessionId(freshSessionId);
      setSleeperUser(user);
      setAvailableLeagues(leagues);
      const validIds = leagues.map((l) => l.league_id);
      const currentIds = liveLeagues.map((l) => l.id).filter((id) => validIds.includes(id));
      setSelectedIds(currentIds.length ? currentIds : validIds);
      navigate({ screen: "select" });
    } catch (err) {
      setConnectError(err.message || "Couldn't refresh your league list — try again.");
    } finally {
      setConnecting(false);
    }
  }, [username, liveLeagues, navigate]);

  // Breadcrumb trail: username > League Name > Sub tab name. Every level
  // but the current one is clickable.
  const crumbs = useMemo(() => {
    const root = { label: sleeperUser?.display_name || "Fantasy Manager", onClick: liveLeagues.length ? () => navigate({ screen: "dashboard" }) : undefined };
    if (view.screen === "bootstrapping") return [{ label: "Fantasy Manager" }];
    if (view.screen === "login") return [{ label: "Fantasy Manager" }];
    if (view.screen === "connect") return [{ label: "Connect Sleeper" }];
    if (view.screen === "select") return liveLeagues.length ? [root, { label: "Edit Leagues" }] : [{ label: "Choose Leagues" }];
    if (view.screen === "dashboard") return [{ label: root.label }];
    if (view.screen === "league" && activeLeague) return [root, { label: activeLeague.name }];
    if (view.screen === "tab" && activeLeague) return [root, { label: activeLeague.name, onClick: () => navigate({ screen: "league", leagueId: activeLeague.id }) }, { label: TAB_META[view.tab].label }];
    return [root];
  }, [view, sleeperUser, liveLeagues.length, activeLeague, navigate]);

  const showRefresh = view.screen === "dashboard" || view.screen === "league" || view.screen === "tab";
  const showWeek = showRefresh && week != null;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="max-w-lg mx-auto">
      <TopBar
        crumbs={crumbs}
        onRefresh={showRefresh ? handleRefresh : undefined}
        refreshing={refreshing}
        syncedLabel={showRefresh ? `Synced ${syncedAt} · Sleeper + FantasyPros/ESPN (live)` : null}
        week={week}
        onWeekChange={handleWeekChange}
        showWeek={showWeek}
      />
      {view.screen === "bootstrapping" && <BootstrapScreen />}
      {view.screen === "login" && (
        <LoginScreen password={password} setPassword={setPassword} onSubmit={handleLoginSubmit} loading={loggingIn} error={loginError} />
      )}
      {view.screen === "dashboard" && (
        <Dashboard
          computed={computed}
          onOpenLeague={(id) => navigate({ screen: "league", leagueId: id })}
          onOpenTab={(id, tab) => navigate({ screen: "tab", leagueId: id, tab })}
          onLogout={handleLogout}
          onEditLeagues={handleEditLeagues}
          sleeperUser={sleeperUser}
        />
      )}
      {view.screen === "connect" && (
        <ConnectScreen username={username} setUsername={setUsername} onSubmit={handleConnectSubmit} connecting={connecting} error={connectError} />
      )}
      {view.screen === "select" && (
        <SelectLeaguesScreen leagues={availableLeagues} selectedIds={selectedIds} onToggle={handleToggleLeague} onConfirm={handleConfirmSelection} loading={loadingLeagues || connecting} error={connectError} />
      )}
      {view.screen === "league" && activeLeague && (
        <LeagueOverview league={activeLeague} onOpenTab={(tab) => navigate({ screen: "tab", leagueId: activeLeague.id, tab })} />
      )}
      {view.screen === "tab" && activeLeague && (() => {
        if (activeLeague.error) return <ErrorScreen message={activeLeague.error} />;
        const Comp = TAB_COMPONENTS[view.tab];
        return <Comp league={activeLeague} sessionId={sessionId} />;
      })()}
    </div>
  );
}
