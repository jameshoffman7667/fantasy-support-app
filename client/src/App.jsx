import React, { useState, useMemo, useCallback } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ChevronLeft,
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
/*  DEMO DATA — used only when "Use demo data" is selected instead of  */
/*  connecting a real Sleeper account. Fictional players.             */
/* ------------------------------------------------------------------ */
const SEED_LEAGUES = [
  {
    id: "demo1",
    name: "Dynasty Dungeon (Demo)",
    week: 3,
    scoring: "Half-PPR",
    superflex: false,
    lockLabel: "Locks in 1h 40m",
    starters: [
      { slot: "QB", player: { name: "R. Ashfield", pos: "QB", team: "KC", status: "Healthy", kickoff: 780, kickoffLabel: "1:00 PM ET", proj: 19.4 } },
      { slot: "RB", player: { name: "D. Marchetti", pos: "RB", team: "DAL", status: "Out", kickoff: 1225, kickoffLabel: "4:25 PM ET", proj: 0, note: "Ruled out Fri (hamstring)" } },
      { slot: "RB", player: { name: "T. Okafor", pos: "RB", team: "SF", status: "Healthy", kickoff: 1225, kickoffLabel: "4:25 PM ET", proj: 14.1 } },
      { slot: "WR", player: { name: "J. Beaumont", pos: "WR", team: "MIA", status: "Bye", kickoff: null, kickoffLabel: "On bye", proj: 0, note: "Team on bye week 3" } },
      { slot: "WR", player: { name: "K. Sowande", pos: "WR", team: "BUF", status: "Healthy", kickoff: 780, kickoffLabel: "1:00 PM ET", proj: 13.2 } },
      { slot: "TE", player: { name: "P. Odum", pos: "TE", team: "CIN", status: "Questionable", kickoff: 780, kickoffLabel: "1:00 PM ET", proj: 8.6, note: "Limited in practice Thu/Fri" } },
      { slot: "FLEX", player: { name: "A. Marsh", pos: "WR", team: "GB", status: "Healthy", kickoff: 780, kickoffLabel: "1:00 PM ET", proj: 10.9 } },
    ],
    bench: [
      { name: "G. Vance", pos: "RB", team: "TEN", status: "Healthy", proj: 7.4, irEligible: false },
      { name: "N. Foulkes", pos: "WR", team: "LAC", status: "IR", proj: 0, irEligible: true },
      null,
    ],
    ir: [null],
    optimalLineup: [
      { slot: "QB", name: "R. Ashfield", proj: 19.4 },
      { slot: "RB", name: "T. Okafor", proj: 14.1 },
      { slot: "RB", name: "G. Vance", proj: 7.4, note: "Swap in for D. Marchetti (Out)" },
      { slot: "WR", name: "K. Sowande", proj: 13.2 },
      { slot: "WR", name: "A. Marsh", proj: 10.9 },
      { slot: "TE", name: "P. Odum", proj: 8.6 },
      { slot: "FLEX", name: "S. Delacroix", proj: 11.6, note: "Available now — better than a Bye/Out slot" },
    ],
    freeAgents: [
      { name: "S. Delacroix", pos: "WR", proj: 11.6, ecr: 41, trending: true },
      { name: "C. Whitfield", pos: "RB", proj: 9.8, ecr: 52, trending: true },
      { name: "M. Castillo", pos: "TE", proj: 4.1, ecr: 21, trending: false },
    ],
    tradeSuggestions: [
      { severity: "major", note: "WR corps thin behind Sowande/Marsh — Bramble owns 3 top-30 WRs and needs RB depth you have.", give: "G. Vance (RB)", get: "L. Tran (WR)", theirTeam: "Bramble's Ballers" },
    ],
    injuryEvents: [
      { id: "e1", player: "D. Marchetti", from: "Questionable", to: "Out", time: "Fri 4:10 PM", seen: false },
      { id: "e2", player: "P. Odum", from: "Healthy", to: "Questionable", time: "Thu 6:30 PM", seen: false },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  VARIANCE CALCULATIONS                                             */
/* ------------------------------------------------------------------ */
const FLEX_ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"] };
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

  const rows = [...starterRows, ...benchRows].map((r) => ({ ...r, reason: r.reasons.join(" ") || null }));
  return { rows, status: worst(rows.map((r) => r.severity)) };
}

function computeLineup(league) {
  const currentTotal = league.starters.reduce((sum, s) => sum + (s.player?.proj ?? 0), 0);
  const optimalTotal = (league.optimalLineup || []).reduce((sum, p) => sum + (p.proj ?? 0), 0);
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

function computeInjury(league) {
  const rows = league.injuryEvents || [];
  const active = rows.filter((e) => !e.seen);
  const status = active.length === 0 ? "ok" : active.some((e) => ["Out", "Doubtful", "IR", "Suspended"].includes(e.to)) ? "major" : "minor";
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
      className={`flex items-center gap-1 rounded-md ${compact ? "px-2 py-1" : "px-2.5 py-1.5"} shrink-0`}
    >
      <Icon size={14} strokeWidth={2.3} />
      {label && <span className="text-xs font-medium" style={{ fontFamily: "Inter, sans-serif" }}>{label}</span>}
    </button>
  );
}

function TopBar({ title, subtitle, onBack, onRefresh, refreshing, syncedLabel }) {
  return (
    <div className="sticky top-0 z-10" style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button onClick={onBack} style={{ color: C.textMuted }} className="shrink-0 -ml-1 p-1">
              <ChevronLeft size={22} />
            </button>
          )}
          <div className="min-w-0">
            <div className="truncate text-lg leading-tight" style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, letterSpacing: 0.2, color: C.text }}>
              {title}
            </div>
            {subtitle && <div className="truncate text-xs" style={{ color: C.textMuted }}>{subtitle}</div>}
          </div>
        </div>
        <button
          onClick={onRefresh}
          style={{ color: refreshing ? C.brand : C.textMuted, visibility: onRefresh ? "visible" : "hidden" }}
          className="shrink-0 p-2 -mr-1"
          aria-label="Refresh"
        >
          <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
        </button>
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
function Dashboard({ computed, onOpenLeague, onOpenTab }) {
  return (
    <div className="px-4 py-3 space-y-3">
      {computed.map((lg) => (
        <div key={lg.id} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg overflow-hidden">
          <button onClick={() => onOpenLeague(lg.id)} className="w-full flex items-center justify-between px-3.5 py-3">
            <div className="text-left min-w-0">
              <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, color: C.text }} className="text-[15px] truncate">{lg.name}</div>
              <div className="text-xs" style={{ color: C.textMuted }}>
                {lg.error ? "Failed to load" : `Week ${lg.week ?? "?"} · ${lg.scoring}`}
              </div>
            </div>
            <ChevronRight size={18} style={{ color: C.textFaint }} className="shrink-0" />
          </button>
          {!lg.error && (
            <div className="flex items-center gap-1.5 px-3.5 pb-3 overflow-x-auto" style={{ borderTop: `1px solid ${C.border}` }}>
              <div className="pt-2.5 flex gap-1.5">
                {Object.entries(TAB_META).map(([key, meta]) => (
                  <StatusBadge key={key} status={lg[key].status} label={meta.short} compact onClick={() => onOpenTab(lg.id, key)} />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
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
      ? `${league.injury.rows.filter((r) => !r.seen).length} new status change(s)`
      : "No new news since last sync",
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      {league.dataWarnings?.length > 0 && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textMuted }} className="text-xs rounded-md px-3 py-2">
          {league.dataWarnings[0]}
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
          {r.reason && <div style={{ color: s.color }} className="text-xs mt-0.5">{r.reason}</div>}
        </div>
        <s.Icon size={16} style={{ color: s.color }} className="shrink-0 mt-0.5" />
      </div>
    );
  };
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Flex lock-order and bye-week checks need kickoff times and a schedule feed that neither Sleeper nor FantasyPros expose via this API — everything else here is live.
      </div>
      <SectionLabel>Starting Lineup</SectionLabel>
      <div className="space-y-1.5">{starterRows.map((r, i) => <Row key={i} r={r} />)}</div>
      <SectionLabel>Bench</SectionLabel>
      <div className="space-y-1.5">{benchRows.map((r, i) => <Row key={i} r={r} />)}</div>
    </div>
  );
}

function LineupTab({ league }) {
  const { currentTotal, optimalTotal, delta } = league.lineup;
  return (
    <div className="px-4 py-3">
      {league.dataWarnings?.length > 0 && (
        <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">{league.dataWarnings[0]}</div>
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
      <SectionLabel>Optimal Lineup</SectionLabel>
      <div className="space-y-1.5">
        {(league.optimalLineup || []).map((p, i) => (
          <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 flex items-center gap-3">
            <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs w-14 shrink-0">{p.slot}</div>
            <div className="min-w-0 flex-1">
              <div style={{ color: C.text }} className="text-sm font-medium truncate">{p.name ?? "(none available)"}</div>
              {p.note && <div style={{ color: C.brand }} className="text-xs mt-0.5">{p.note}</div>}
            </div>
            <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm shrink-0">{p.proj != null ? p.proj.toFixed(1) : "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WaiverTab({ league }) {
  return (
    <div className="px-4 py-3">
      <SectionLabel>Available Players</SectionLabel>
      <div className="space-y-1.5">
        {league.waiver.rows.map((p, i) => {
          const s = STATUS[p.severity];
          return (
            <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3 py-2.5">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradeTab({ league }) {
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Heuristic, based on positional ECR depth across your league — not a dedicated trade-value model (FantasyPros doesn't publish one via this API).
      </div>
      <SectionLabel>Trade Suggestions</SectionLabel>
      {league.trade.rows.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No standout trade opportunities right now.</div>
      ) : (
        <div className="space-y-2">
          {league.trade.rows.map((t, i) => {
            const s = STATUS[t.severity];
            return (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3">
                <div style={{ color: C.textMuted }} className="text-xs mb-1.5">vs. {t.theirTeam}</div>
                <div style={{ color: C.text }} className="text-sm mb-1.5">
                  <span style={{ color: C.textMuted }}>Give </span>{t.give}<span style={{ color: C.textMuted }}> · Get </span>{t.get}
                </div>
                <div style={{ color: s.color }} className="text-xs">{t.note}</div>
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
      <SectionLabel>Status Changes</SectionLabel>
      {league.injury.rows.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No injury news for this roster.</div>
      ) : (
        <div className="space-y-1.5">
          {league.injury.rows.map((e) => {
            const sev = !e.seen && ["Out", "Doubtful", "IR", "Suspended"].includes(e.to) ? "major" : !e.seen ? "minor" : "ok";
            const s = STATUS[sev];
            return (
              <div key={e.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3 flex items-center gap-3">
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm font-medium">{e.player}</div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{e.from} → {e.to}</div>
                </div>
                <div style={{ color: C.textFaint }} className="text-xs flex items-center gap-1 shrink-0"><Clock size={12} />{e.time}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TAB_COMPONENTS = { roster: RosterTab, lineup: LineupTab, waiver: WaiverTab, trade: TradeTab, injury: InjuryTab };

function ConnectScreen({ username, setUsername, onSubmit, connecting, error, onUseDemo }) {
  return (
    <div className="px-5 py-8 flex flex-col items-center text-center gap-4">
      <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><Link2 size={22} /></div>
      <div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg mb-1">Connect your Sleeper account</div>
        <div style={{ color: C.textMuted }} className="text-sm max-w-xs">Enter your Sleeper username. Real rosters, real FantasyPros projections — this now runs through your own backend.</div>
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
      <button onClick={onUseDemo} style={{ color: C.textMuted }} className="text-xs underline underline-offset-2">Or just look around with demo data</button>
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

/* ------------------------------------------------------------------ */
/*  ROOT APP                                                           */
/* ------------------------------------------------------------------ */
export default function App() {
  const [mockLeagues] = useState(SEED_LEAGUES);
  const [mode, setMode] = useState("demo"); // 'demo' | 'live'
  const [view, setView] = useState({ screen: "dashboard" });
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

  const rawLeagues = mode === "live" ? liveLeagues : mockLeagues;

  const computed = useMemo(
    () =>
      rawLeagues.map((lg) =>
        lg.error
          ? lg
          : {
              ...lg,
              roster: computeRoster(lg),
              lineup: computeLineup(lg),
              waiver: computeWaiver(lg, rawLeagues),
              trade: computeTrade(lg),
              injury: computeInjury(lg),
            }
      ),
    [rawLeagues]
  );

  const activeLeague = useMemo(() => computed.find((l) => l.id === (view.leagueId || null)), [computed, view.leagueId]);

  const handleConnectSubmit = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const { sessionId, user, week, leagues } = await api.connect(username.trim());
      setSessionId(sessionId);
      setSleeperUser({ ...user, week });
      setAvailableLeagues(leagues);
      setSelectedIds(leagues.map((l) => l.league_id));
      setView({ screen: "select" });
    } catch (err) {
      setConnectError(err.message || "Couldn't reach the server. Is it running on localhost:4000?");
    } finally {
      setConnecting(false);
    }
  }, [username]);

  const handleToggleLeague = useCallback((id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const handleConfirmSelection = useCallback(async () => {
    setLoadingLeagues(true);
    setConnectError(null);
    try {
      const { leagues } = await api.buildLeagues(sessionId, selectedIds);
      setLiveLeagues(leagues);
      setMode("live");
      setSyncedAt("just now");
      setView({ screen: "dashboard" });
    } catch (err) {
      setConnectError(err.message || "Couldn't load those leagues — try again.");
    } finally {
      setLoadingLeagues(false);
    }
  }, [sessionId, selectedIds]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    if (mode === "demo") {
      setTimeout(() => {
        setRefreshing(false);
        setSyncedAt("just now");
      }, 400);
      return;
    }
    try {
      const { leagues } = await api.buildLeagues(sessionId, selectedIds);
      setLiveLeagues(leagues);
      setSyncedAt("just now");
    } catch (err) {
      setConnectError(err.message || "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [mode, sessionId, selectedIds]);

  const goToConnect = () => {
    setConnectError(null);
    setView({ screen: "connect" });
  };
  const goToDemo = () => {
    setMode("demo");
    setView({ screen: "dashboard" });
  };

  let title = "Your Leagues";
  let subtitle = mode === "live" ? `${liveLeagues.length} tracked · live` : `${mockLeagues.length} tracked · demo data`;
  let onBack = null;
  if (view.screen === "connect") {
    title = "Connect Sleeper";
    subtitle = null;
    onBack = () => setView({ screen: "dashboard" });
  } else if (view.screen === "select") {
    title = "Choose Leagues";
    subtitle = sleeperUser?.display_name ? `Signed in as ${sleeperUser.display_name}` : null;
    onBack = () => setView({ screen: "connect" });
  } else if (view.screen === "league" && activeLeague) {
    title = activeLeague.name;
    subtitle = activeLeague.error ? null : `Week ${activeLeague.week ?? "?"} · ${activeLeague.scoring} · ${activeLeague.lockLabel}`;
    onBack = () => setView({ screen: "dashboard" });
  } else if (view.screen === "tab" && activeLeague) {
    title = TAB_META[view.tab].label;
    subtitle = activeLeague.name;
    onBack = () => setView({ screen: "league", leagueId: activeLeague.id });
  }

  const showRefresh = view.screen === "dashboard" || view.screen === "league" || view.screen === "tab";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="max-w-md mx-auto">
      <TopBar
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        onRefresh={showRefresh ? handleRefresh : undefined}
        refreshing={refreshing}
        syncedLabel={showRefresh ? `Synced ${syncedAt} · ${mode === "live" ? "Sleeper + FantasyPros (live)" : "Demo data"}` : null}
      />
      {view.screen === "dashboard" && (
        <>
          <div className="px-4 pt-3 flex justify-end">
            <button onClick={mode === "live" ? goToDemo : goToConnect} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
              <Link2 size={13} />
              {mode === "live" ? "Switch to demo data" : "Connect Sleeper account"}
            </button>
          </div>
          <Dashboard computed={computed} onOpenLeague={(id) => setView({ screen: "league", leagueId: id })} onOpenTab={(id, tab) => setView({ screen: "tab", leagueId: id, tab })} />
        </>
      )}
      {view.screen === "connect" && (
        <ConnectScreen username={username} setUsername={setUsername} onSubmit={handleConnectSubmit} connecting={connecting} error={connectError} onUseDemo={goToDemo} />
      )}
      {view.screen === "select" && (
        <SelectLeaguesScreen leagues={availableLeagues} selectedIds={selectedIds} onToggle={handleToggleLeague} onConfirm={handleConfirmSelection} loading={loadingLeagues} error={connectError} />
      )}
      {view.screen === "league" && activeLeague && (
        <LeagueOverview league={activeLeague} onOpenTab={(tab) => setView({ screen: "tab", leagueId: activeLeague.id, tab })} />
      )}
      {view.screen === "tab" && activeLeague && (() => {
        if (activeLeague.error) return <ErrorScreen message={activeLeague.error} />;
        const Comp = TAB_COMPONENTS[view.tab];
        return <Comp league={activeLeague} />;
      })()}
    </div>
  );
}
