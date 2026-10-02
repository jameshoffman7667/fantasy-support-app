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
  Trophy,
  Bell,
  BellOff,
  GripVertical,
  ListOrdered,
  ArrowLeft,
  UserCog,
  KeyRound,
  UserPlus,
  Copy,
} from "lucide-react";
import * as api from "./api.js";
import { effectiveLineup, isZeroProjection, GROUP_LABEL } from "./lineup.js";

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
    if (p.irEligible) return { slot: "BN", label: p.name, severity: "minor", reasons: ["IR-eligible — move to an empty IR slot"], usage: p.usage };
    return { slot: "BN", label: p.name, severity: "ok", reasons: [], usage: p.usage };
  });
  const irRows = (league.ir || []).map((p) => ({ slot: "IR", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));
  const taxiRows = (league.taxi || []).map((p) => ({ slot: "TAXI", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));

  const rows = [...starterRows, ...benchRows].map((r) => ({ ...r, reason: r.reasons.join(" ") || null }));
  return { rows, irRows, taxiRows, status: worst(rows.map((r) => r.severity)) };
}

// The Lineup tab's numbers, status and per-slot rows — including the user's
// own Player Rankings override when they've saved one. All the logic lives in
// lineup.js so it can be tested without React.
function computeLineup(league) {
  return effectiveLineup(league);
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
      {source === "E" ? "ESPN" : source}
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
  odds: { label: "Season Outlook", short: "Outlook", Icon: Trophy },
};
// Season Outlook is fetched on demand (like FAAB), not derived from the
// league build response, so it has no pass/fail "status" the way the
// other tabs do — excluded from the per-league status-badge rows on the
// Dashboard and League Overview screens, but still a normal tab
// otherwise (breadcrumb, navigation, TAB_COMPONENTS all use it as-is).
const STATUS_BADGE_TABS = Object.keys(TAB_META).filter((k) => k !== "odds");

// Converts a base64url VAPID public key into the Uint8Array the Push API
// expects — standard boilerplate for subscribing with applicationServerKey.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Pre-kickoff alerts (v2) ride on Web Push through the existing PWA service
// worker — not a native Android app with FCM push. That's a deliberate
// scoping decision (see README/CHANGELOG): a true native wrapper needs
// packaging, signing and Play Store review that's out of scope here, while
// Web Push is real, works on this app today, and needs no app-store step.
function PushToggle() {
  const [state, setState] = useState({ supported: true, subscribed: false, busy: false, error: null, configured: true });

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState((s) => ({ ...s, supported: false }));
        return;
      }
      try {
        const { configured } = await api.getPushPublicKey();
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        setState((s) => ({ ...s, configured, subscribed: Boolean(existing) }));
      } catch {
        // Can't reach the server yet — leave defaults, the button will
        // surface any real error on the next click instead.
      }
    })();
  }, []);

  const toggle = async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const reg = await navigator.serviceWorker.ready;
      if (state.subscribed) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api.unsubscribePush(sub.endpoint);
          await sub.unsubscribe();
        }
        setState((s) => ({ ...s, subscribed: false, busy: false }));
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setState((s) => ({ ...s, busy: false, error: "Notifications permission was denied." }));
          return;
        }
        const { publicKey, configured } = await api.getPushPublicKey();
        if (!configured) {
          setState((s) => ({ ...s, busy: false, configured: false, error: "Push alerts aren't configured on the server yet (VAPID keys missing) — see README." }));
          return;
        }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
        await api.subscribePush(sub.toJSON());
        setState((s) => ({ ...s, subscribed: true, busy: false }));
      }
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message || "Couldn't update push alerts." }));
    }
  };

  if (!state.supported) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={toggle} disabled={state.busy} style={{ color: state.subscribed ? C.ok : C.textMuted }} className="text-xs font-medium flex items-center gap-1">
        {state.busy ? <Loader2 size={13} className="animate-spin" /> : state.subscribed ? <Bell size={13} /> : <BellOff size={13} />}
        {state.subscribed ? "Alerts on" : "Enable alerts"}
      </button>
      {state.error && <div style={{ color: C.major }} className="text-[10px] max-w-[180px] text-right">{state.error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SCREENS                                                            */
/* ------------------------------------------------------------------ */
function Dashboard({ computed, onOpenLeague, onOpenTab, onLogout, onEditLeagues, onOpenAccount, sleeperUser }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between flex-wrap gap-y-2 pb-3">
        <PushToggle />
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={onOpenAccount} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
            <UserCog size={13} />
            Account
          </button>
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
                {STATUS_BADGE_TABS.map((key) => (
                  <StatusBadge key={key} status={lg[key].status} label={TAB_META[key].short} compact onClick={() => onOpenTab(lg.id, key)} />
                ))}
                <button onClick={() => onOpenTab(lg.id, "odds")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
                  <Trophy size={11} />
                  Outlook
                </button>
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
    lineup: (() => {
      const L = league.lineup;
      if (L.zeroStarters.length) return `${L.zeroStarters.length} starter(s) projected for 0 pts`;
      if (L.custom) {
        const changed = L.rows.filter((r) => r.changed).length;
        const base = changed === 0 ? "Matches your player ranking" : `Your ranking changes ${changed} slot(s)`;
        return L.betterDelta > 0.05 ? `${base} · better lineup exists (+${L.betterDelta.toFixed(1)})` : base;
      }
      return L.delta === 0 ? "Current lineup is already optimal" : `Optimal lineup gains +${L.delta.toFixed(1)} pts`;
    })(),
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
      {STATUS_BADGE_TABS.map((key) => {
        const meta = TAB_META[key];
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
      <button onClick={() => onOpenTab("odds")} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-left">
        <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-2 rounded-md shrink-0">
          <Trophy size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-[14px]">Season Outlook</div>
          <div style={{ color: C.textMuted }} className="text-xs truncate">Playoff &amp; championship odds, simulated</div>
        </div>
        <ChevronRight size={16} style={{ color: C.textFaint }} />
      </button>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-[11px] tracking-wide px-1 pt-3 pb-1.5">{children}</div>;
}

// Usage badge: snap %/targets/carries from the nflverse-backed `usage`
// field (see server/nflverseUsage.js). That source isn't guaranteed to
// match every player by name, so this renders nothing rather than a
// misleading placeholder when usage is missing.
function UsageBadge({ usage }) {
  if (!usage) return null;
  const parts = [];
  if (usage.snapPct != null) parts.push(`${usage.snapPct}% snaps`);
  if (usage.targets != null) parts.push(`${usage.targets} tgt`);
  if (usage.carries != null) parts.push(`${usage.carries} car`);
  if (parts.length === 0) return null;
  return (
    <span style={{ color: C.textFaint, border: `1px solid ${C.border}` }} className="text-[10px] rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap">
      {parts.join(" · ")}
    </span>
  );
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
          {r.usage && <div className="mt-1"><UsageBadge usage={r.usage} /></div>}
        </div>
        <s.Icon size={16} style={{ color: s.color }} className="shrink-0 mt-0.5" />
      </div>
    );
  };
  // starterRows is index-aligned with league.starters (both built from the
  // same array with no filtering in between), so kickoff time can just be
  // zipped in by position rather than re-matched by label/slot text.
  const starterRowsWithKickoff = starterRows.map((r, i) => ({ ...r, kickoffLabel: league.starters[i]?.player?.kickoffLabel, usage: league.starters[i]?.player?.usage }));

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

// Player Rankings (v2.1): every player on the roster (starters, bench, IR, taxi)
// as a draggable card sorted by projected points, then free agents in their own
// section. The order the user drags them into becomes the lineup suggestion on
// the Lineup tab; the cards highlight yellow when a better projected lineup
// exists, and red when a player is projected for exactly 0 (not just missing).
const GROUP_STYLE = {
  starter: { color: C.brand },
  bench: { color: C.textMuted },
  ir: { color: C.major },
  taxi: { color: "#A08BE0" },
  fa: { color: C.ok },
};

function RankingCard({ entry, rank, startsAt, yellowNote, draggable, dragging, onHandleDown, onHandleKey, cardRef }) {
  const p = entry.player;
  const zero = isZeroProjection(p);
  const g = GROUP_STYLE[entry.group];
  const needsMove = Boolean(startsAt) && (entry.group === "ir" || entry.group === "taxi");
  const accent = zero ? C.major : yellowNote ? C.minor : g.color;
  return (
    <div
      ref={cardRef}
      data-player-key={entry.key}
      style={{
        background: zero ? C.majorBg : yellowNote ? C.minorBg : C.surface,
        border: `1px solid ${zero ? `${C.major}66` : yellowNote ? `${C.minor}66` : C.border}`,
        borderLeft: `3px solid ${accent}`,
        boxShadow: dragging ? "0 6px 18px rgba(0,0,0,0.5)" : "none",
        opacity: dragging ? 0.92 : 1,
      }}
      className="rounded-md px-2.5 py-2.5 flex items-start gap-2"
    >
      {draggable && (
        <button
          type="button"
          aria-label={`Drag to reorder ${p.name}. Or use the up and down arrow keys.`}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab", color: C.textFaint }}
          className="p-1 -ml-1 shrink-0"
        >
          <GripVertical size={18} />
        </button>
      )}
      {rank != null && (
        <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-xs w-6 pt-1 shrink-0 text-right">
          {rank}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span style={{ color: C.text }} className="text-sm font-medium truncate">{p.name}</span>
          <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{p.pos}{p.team ? ` · ${p.team}` : ""}</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap mt-1">
          <span style={{ color: g.color, border: `1px solid ${g.color}55` }} className="text-[10px] rounded px-1.5 py-0.5">{GROUP_LABEL[entry.group]}</span>
          {startsAt && (
            <span style={{ color: C.ok, background: C.okBg }} className="text-[10px] rounded px-1.5 py-0.5">Starts at {startsAt}</span>
          )}
          {p.status && p.status !== "Healthy" && (
            <span style={{ color: C.minor, border: `1px solid ${C.minor}55` }} className="text-[10px] rounded px-1.5 py-0.5">{p.status}</span>
          )}
          {p.trending && <span style={{ color: C.brand }} className="text-[10px]">Trending add</span>}
          <UsageBadge usage={p.usage} />
        </div>
        {zero && <div style={{ color: C.major }} className="text-xs mt-1">Projected for 0 points</div>}
        {yellowNote && <div style={{ color: C.minor }} className="text-xs mt-1">{yellowNote}</div>}
        {needsMove && <div style={{ color: C.textMuted }} className="text-xs mt-1">On your {GROUP_LABEL[entry.group]} — needs a roster move before they can start.</div>}
      </div>
      <div className="text-right shrink-0">
        <div style={{ color: zero ? C.major : C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-base font-semibold">
          {p.proj != null ? p.proj.toFixed(1) : "—"}
        </div>
        <div style={{ color: C.textFaint }} className="text-[10px]">{p.projSource === "actual" ? "FINAL" : p.projSource === "E" ? "ESPN" : p.projSource || "no proj"}</div>
      </div>
    </div>
  );
}

function PlayerRankings({ league, onSaveRanking, onBack }) {
  // The order the lineup is currently built from: the saved ranking, or the
  // default (highest projection first).
  const baseline = useMemo(() => effectiveLineup(league).rosterOrder.map((e) => e.key), [league]);
  const baselineSig = baseline.join("\n");
  const [order, setOrder] = useState(baseline);
  // True once the user has moved a card (or a ranking was already saved). Until then
  // the lineup uses the suggested order exactly as the Lineup tab does.
  const [touched, setTouched] = useState(false);
  const [dragKey, setDragKey] = useState(null);
  const [saveState, setSaveState] = useState({ saving: false, error: null });

  const orderRef = useRef(order);
  orderRef.current = order;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const draggingRef = useRef(null);
  const lastY = useRef(0);
  const cardRefs = useRef(new Map());
  const saveTimer = useRef(null);

  // Pick up changes from outside (a refresh, another device) — but never mid-drag.
  useEffect(() => {
    if (!draggingRef.current) setOrder(baselineRef.current);
  }, [baselineSig]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const hasCustom = Array.isArray(league.customRanking) && league.customRanking.length > 0;
  const eff = useMemo(() => effectiveLineup(league, hasCustom || touched ? order : undefined), [league, order, hasCustom, touched]);

  const persist = useCallback(
    async (keys) => {
      if (keys.join("\n") === baselineRef.current.join("\n")) return; // nothing actually moved
      setSaveState({ saving: true, error: null });
      try {
        await onSaveRanking(league.id, keys);
        setSaveState({ saving: false, error: null });
      } catch (err) {
        setSaveState({ saving: false, error: err.message || "Couldn't save your ranking." });
        setOrder(baselineRef.current); // put the cards back where the server has them
        setTouched(false);
      }
    },
    [league.id, onSaveRanking]
  );

  // Moves the dragged card to wherever the pointer currently is, by comparing
  // the pointer to the vertical midpoint of each other card.
  const reorderToPointer = useCallback(() => {
    const key = draggingRef.current;
    if (!key) return;
    const keys = orderRef.current;
    const without = keys.filter((k) => k !== key);
    let idx = 0;
    for (const k of without) {
      const el = cardRefs.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (lastY.current > r.top + r.height / 2) idx++;
      else break;
    }
    const next = [...without.slice(0, idx), key, ...without.slice(idx)];
    if (next.some((k, i) => k !== keys[i])) {
      orderRef.current = next;
      setTouched(true);
      setOrder(next);
    }
  }, []);

  useEffect(() => {
    if (!dragKey) return undefined;
    const onMove = (e) => {
      lastY.current = e.clientY;
      reorderToPointer();
    };
    const onUp = () => {
      draggingRef.current = null;
      setDragKey(null);
      persist(orderRef.current);
    };
    // Window-level listeners rather than pointer capture: React moves the card's
    // DOM node as it reorders, which can drop a capture mid-drag.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // Edge auto-scroll, and re-evaluating the position every frame so the
    // order keeps up while the page scrolls under a stationary finger.
    let raf;
    const tick = () => {
      const y = lastY.current;
      if (y < 90) window.scrollBy(0, -14);
      else if (y > window.innerHeight - 90) window.scrollBy(0, 14);
      reorderToPointer();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(raf);
    };
  }, [dragKey, reorderToPointer, persist]);

  const startDrag = (e, key) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button / touch / pen only
    e.preventDefault();
    draggingRef.current = key;
    lastY.current = e.clientY;
    setDragKey(key);
  };

  // Keyboard alternative to dragging: arrow keys nudge the focused card.
  const nudge = (e, key) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const keys = orderRef.current;
    const from = keys.indexOf(key);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (from < 0 || to < 0 || to >= keys.length) return;
    const next = [...keys];
    next.splice(from, 1);
    next.splice(to, 0, key);
    orderRef.current = next;
    setTouched(true);
    setOrder(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(orderRef.current), 600);
  };

  const resetOrder = async () => {
    setTouched(false);
    setSaveState({ saving: true, error: null });
    try {
      await onSaveRanking(league.id, null);
      setSaveState({ saving: false, error: null });
    } catch (err) {
      setSaveState({ saving: false, error: err.message || "Couldn't reset your ranking." });
    }
  };

  const better = eff.betterDelta > 0.05;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between pb-2">
        <button onClick={onBack} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          <ArrowLeft size={13} />
          Back to lineup
        </button>
        {(hasCustom || touched) && (
          <button onClick={resetOrder} disabled={saveState.saving} style={{ color: C.textMuted }} className="text-xs font-medium">
            Reset to suggested order
          </button>
        )}
      </div>

      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Drag the handle to rank your players (or focus it and use the arrow keys). Players ranked higher get first claim on the lineup slots they're eligible for,
        and your order replaces the suggested lineup on the Lineup tab. It's saved to your account, per league.
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-3 flex items-center justify-around text-center mb-2">
        <div>
          <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">Set in Sleeper</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-lg font-semibold">{eff.currentTotal.toFixed(1)}</div>
        </div>
        <div>
          <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">{hasCustom || touched ? "Your ranking" : "Suggested"}</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-lg font-semibold">{eff.rankedTotal.toFixed(1)}</div>
        </div>
        <div>
          <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">Best possible</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-lg font-semibold">{eff.bestTotal.toFixed(1)}</div>
        </div>
      </div>
      {better && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 mb-2">
          A better projected lineup exists: +{eff.betterDelta.toFixed(1)} pts over this ranking. The players involved are highlighted yellow.
        </div>
      )}
      {saveState.error && <div style={{ color: C.major }} className="text-xs px-1 pb-2">{saveState.error}</div>}
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-1 h-4">{saveState.saving ? "Saving…" : ""}</div>

      <SectionLabel>Your Roster — {eff.rosterOrder.length} players</SectionLabel>
      <div className="space-y-1.5">
        {eff.rosterOrder.map((entry, i) => (
          <RankingCard
            key={entry.key}
            entry={entry}
            rank={i + 1}
            startsAt={eff.startsAt.get(entry.key)}
            yellowNote={eff.yellow.get(entry.key)}
            draggable
            dragging={dragKey === entry.key}
            onHandleDown={(e) => startDrag(e, entry.key)}
            onHandleKey={(e) => nudge(e, entry.key)}
            cardRef={(el) => {
              if (el) cardRefs.current.set(entry.key, el);
              else cardRefs.current.delete(entry.key);
            }}
          />
        ))}
      </div>

      <SectionLabel>Free Agents</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Not on your roster, so they can't be ranked — they're shown with their projections so you can see whether a pickup would beat your lineup.
      </div>
      {eff.freeAgents.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No notable free agents right now.</div>
      ) : (
        <div className="space-y-1.5">
          {eff.freeAgents.map((entry) => (
            <RankingCard key={entry.key} entry={entry} rank={null} startsAt={null} yellowNote={eff.yellow.get(entry.key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LineupTab({ league, onSaveRanking }) {
  const [showRankings, setShowRankings] = useState(false);
  if (showRankings) {
    return <PlayerRankings league={league} onSaveRanking={onSaveRanking} onBack={() => setShowRankings(false)} />;
  }

  const L = league.lineup;
  const { currentTotal, optimalTotal, delta, custom } = L;
  const rows = L.rows || [];
  const suggestedLabel = custom ? "Your ranking" : "Optimal";
  const better = custom && L.betterDelta > 0.05;
  return (
    <div className="px-4 py-3">
      {league.dataWarnings?.length > 0 && (
        <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2 space-y-1">
          {league.dataWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pb-2">
        <div style={{ color: C.textMuted }} className="text-xs px-1">
          {custom ? "Your player ranking is replacing the suggested lineup." : "Suggested lineup from projections."}
        </div>
        <button
          onClick={() => setShowRankings(true)}
          style={{ color: C.brand, border: `1px solid ${C.brand}66` }}
          className="text-xs font-medium rounded-md px-2.5 py-1.5 flex items-center gap-1.5 shrink-0"
        >
          <ListOrdered size={14} />
          Player Rankings
        </button>
      </div>
      {L.zeroStarters.length > 0 && (
        <div style={{ background: C.majorBg, border: `1px solid ${C.major}55`, color: C.major }} className="text-xs rounded-md px-3 py-2 mb-2">
          Projected for 0 points: {L.zeroStarters.map((p) => p.name).join(", ")}
        </div>
      )}
      {better && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 mb-2">
          A better projected lineup exists: +{L.betterDelta.toFixed(1)} pts over your ranking — open Player Rankings to see who.
        </div>
      )}
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-4 flex items-center justify-around text-center mb-3">
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">Current</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{currentTotal.toFixed(1)}</div>
        </div>
        <div style={{ color: STATUS[L.status].color }} className="text-sm font-medium">
          {delta === 0 ? `= ${suggestedLabel.toLowerCase()}` : `+${delta.toFixed(1)} pts`}
        </div>
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">{suggestedLabel}</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{optimalTotal.toFixed(1)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-1 pb-1">
        <div style={{ color: C.textFaint }} className="text-[11px] font-medium tracking-wide">CURRENT</div>
        <div style={{ color: C.textFaint }} className="text-[11px] font-medium tracking-wide">{custom ? "YOUR RANKING" : "OPTIMAL"}</div>
      </div>
      <div className="space-y-1.5">
        {rows.map((c, i) => {
          const curZero = isZeroProjection(c.current);
          const optZero = isZeroProjection(c.optimal);
          return (
            <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md overflow-hidden">
              <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif", borderBottom: `1px solid ${C.border}` }} className="text-[10px] px-3 py-1 flex items-center justify-between">
                <span>{c.slot}{c.locked ? " · Played" : ""}</span>
                {c.changed && c.delta !== 0 && (
                  <span style={{ color: c.delta > 0 ? C.minor : C.ok }}>{c.delta > 0 ? "+" : ""}{c.delta.toFixed(1)} pts</span>
                )}
              </div>
              <div className="grid grid-cols-2">
                <div
                  style={{ background: curZero ? C.majorBg : c.changed ? C.majorBg : "transparent", borderRight: `1px solid ${C.border}` }}
                  className="relative px-3 py-2.5 pb-4"
                >
                  <div style={{ color: curZero || c.changed ? C.major : C.text }} className="text-sm font-medium truncate">{c.current?.name ?? "(empty)"}</div>
                  <div style={{ color: curZero ? C.major : C.textMuted }} className="text-xs mt-0.5">
                    {c.current?.proj != null ? c.current.proj.toFixed(1) : "—"}{curZero ? " · projected 0" : ""}
                  </div>
                  <SourceTag source={c.current?.projSource} />
                </div>
                <div style={{ background: optZero ? C.majorBg : c.changed ? C.okBg : "transparent" }} className="relative px-3 py-2.5 pb-4">
                  <div style={{ color: optZero ? C.major : c.changed ? C.ok : C.text }} className="text-sm font-medium truncate">{c.optimal?.name ?? "(none available)"}</div>
                  <div style={{ color: optZero ? C.major : C.textMuted }} className="text-xs mt-0.5">
                    {c.optimal?.proj != null ? c.optimal.proj.toFixed(1) : "—"}{optZero ? " · projected 0" : ""}
                  </div>
                  {c.optimal?.note && <div style={{ color: C.brand }} className="text-[10px] mt-0.5">{c.optimal.note}</div>}
                  <SourceTag source={c.optimal?.projSource} />
                </div>
              </div>
            </div>
          );
        })}
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
                  {p.usage && <div className="mt-1"><UsageBadge usage={p.usage} /></div>}
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

      <SectionLabel>Trade Finder — 1-for-1 Swaps</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Concrete player-for-player swaps against real rival rosters, ranked by the projected-points gain to your starting lineup. Filtered to offers close enough in trade value (ECR) that a rival could plausibly accept — not "my worst bench guy for their All-Pro."
      </div>
      {(league.tradeFinder || []).length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-3">No fair 1-for-1 swaps found against any rival roster right now.</div>
      ) : (
        <div className="space-y-1.5 mb-3">
          {league.tradeFinder.map((t, i) => (
            <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.ok}` }} className="rounded-md px-3.5 py-2.5">
              <div style={{ color: C.text }} className="text-xs">
                <span style={{ color: C.textMuted }}>Give </span>{t.give.name} <span style={{ color: C.textFaint }}>({t.give.pos})</span>
                <span style={{ color: C.textMuted }}> · Get </span>{t.get.name} <span style={{ color: C.textFaint }}>({t.get.pos})</span>
                <span style={{ color: C.textMuted }}> from </span>{t.theirTeam}
              </div>
              <div style={{ color: C.ok }} className="text-[11px] mt-0.5">+{t.gain.toFixed(1)} projected pts to your starting lineup</div>
            </div>
          ))}
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

function SeasonOutlookTab({ league, sessionId }) {
  const [state, setState] = useState({ loading: true, odds: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, odds: null, error: null });
    api
      .getSeasonOdds(sessionId, league.id)
      .then((result) => {
        if (!cancelled) setState({ loading: false, odds: result.odds, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, odds: null, error: err.message || "Couldn't compute season odds." });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, league.id]);

  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Rest-of-season Monte Carlo simulation (3,000 trials) using each team's season-to-date scoring average against the
        remaining Sleeper schedule — not a full per-player projection re-run for every roster. Treat this as a rough,
        directional read, not a guarantee.
      </div>
      {state.loading && (
        <div className="flex items-center gap-2 px-1 py-4" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">Simulating the rest of the season…</span>
        </div>
      )}
      {state.error && <div style={{ color: C.major }} className="text-xs px-1 py-2">{state.error}</div>}
      {state.odds && (
        <div className="space-y-1.5">
          {state.odds.map((o, i) => (
            <div
              key={i}
              style={{ background: C.surface, border: `1px solid ${o.isMe ? C.brand : C.border}` }}
              className="rounded-md px-3.5 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm truncate">
                  {o.label}
                </div>
                <div style={{ color: C.textMuted }} className="text-xs shrink-0">{o.currentRecord}</div>
              </div>
              <div className="flex items-center gap-4 mt-1.5">
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Proj. wins</div>
                  <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.projectedWins}</div>
                </div>
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Playoff odds</div>
                  <div style={{ color: C.brand, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.playoffPct}%</div>
                </div>
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Title odds</div>
                  <div style={{ color: C.ok, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.championshipPct}%</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TAB_COMPONENTS = { roster: RosterTab, lineup: LineupTab, waiver: WaiverTab, trade: TradeTab, injury: InjuryTab, odds: SeasonOutlookTab };

const inputStyle = { background: C.surface, border: `1px solid ${C.border}`, color: C.text };

function TextField({ type = "text", value, onChange, onEnter, placeholder, autoFocus, autoComplete }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter && onEnter()}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      style={inputStyle}
      className="w-full rounded-md px-3.5 py-2.5 text-sm outline-none"
    />
  );
}

function PrimaryButton({ onClick, disabled, loading, Icon, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{ background: disabled || loading ? C.surfaceRaised : C.brand, color: C.text }}
      className="w-full rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-2"
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

function LoginScreen({ username, setUsername, password, setPassword, onSubmit, loading, error }) {
  const ready = username.trim() && password;
  return (
    <div className="px-5 py-8 flex flex-col items-center text-center gap-4">
      <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><Lock size={22} /></div>
      <div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg mb-1">Log in</div>
        <div style={{ color: C.textMuted }} className="text-sm max-w-xs">Use your Sleeper username and the password the owner of this app set up for you.</div>
      </div>
      <div className="w-full max-w-xs space-y-2.5">
        <TextField value={username} onChange={setUsername} placeholder="Sleeper username" autoFocus autoComplete="username" onEnter={() => ready && !loading && onSubmit()} />
        <TextField type="password" value={password} onChange={setPassword} placeholder="Password" autoComplete="current-password" onEnter={() => ready && !loading && onSubmit()} />
      </div>
      {error && <div style={{ color: C.major }} className="text-xs max-w-xs">{error}</div>}
      <div className="w-full max-w-xs">
        <PrimaryButton onClick={onSubmit} disabled={!ready} loading={loading} Icon={Lock}>{loading ? "Logging in…" : "Log in"}</PrimaryButton>
      </div>
    </div>
  );
}

// Used for both the forced first-login change and the voluntary one from the Account screen.
function ChangePasswordForm({ forced, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) return setError("New password must be at least 8 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      if (onDone) onDone();
    } catch (err) {
      setError(err.message || "Couldn't change the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {forced && (
        <div style={{ color: C.textMuted }} className="text-sm">
          You're signed in with a temporary password. Choose your own to continue — enter the temporary one as your current password.
        </div>
      )}
      <TextField type="password" value={current} onChange={setCurrent} placeholder="Current password" autoComplete="current-password" />
      <TextField type="password" value={next} onChange={setNext} placeholder="New password (8+ characters)" autoComplete="new-password" />
      <TextField type="password" value={confirm} onChange={setConfirm} placeholder="Confirm new password" autoComplete="new-password" onEnter={() => current && next && confirm && !busy && submit()} />
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {done && !forced && <div style={{ color: C.ok }} className="text-xs">Password changed. Your other devices were signed out.</div>}
      <PrimaryButton onClick={submit} disabled={!current || !next || !confirm} loading={busy} Icon={KeyRound}>
        {busy ? "Saving…" : "Change password"}
      </PrimaryButton>
    </div>
  );
}

function ForcePasswordScreen({ authUser, onDone, onLogout }) {
  return (
    <div className="px-5 py-8 flex flex-col gap-4 max-w-sm mx-auto">
      <div className="flex flex-col items-center text-center gap-3">
        <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><KeyRound size={22} /></div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg">Choose a new password</div>
        <div style={{ color: C.textMuted }} className="text-xs">Signed in as {authUser?.username}</div>
      </div>
      <ChangePasswordForm forced onDone={onDone} />
      <button onClick={onLogout} style={{ color: C.textMuted }} className="text-xs font-medium flex items-center justify-center gap-1 pt-1">
        <LogOut size={13} /> Log out
      </button>
    </div>
  );
}

function AccountScreen({ authUser, onOpenAdmin, onLogout }) {
  return (
    <div className="px-4 py-3 space-y-4">
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{authUser?.username}</div>
        <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{authUser?.role === "owner" ? "Owner" : "Guest"}</div>
      </div>
      <div>
        <SectionLabel>Change password</SectionLabel>
        <div className="pt-1.5"><ChangePasswordForm /></div>
      </div>
      {authUser?.role === "owner" && (
        <button onClick={onOpenAdmin} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }} className="w-full rounded-md px-3.5 py-3 text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2"><UserCog size={16} style={{ color: C.brand }} /> Manage users</span>
          <ChevronRight size={16} style={{ color: C.textFaint }} />
        </button>
      )}
      <button onClick={onLogout} style={{ color: C.textMuted }} className="text-xs font-medium flex items-center gap-1 px-1">
        <LogOut size={13} /> Log out
      </button>
    </div>
  );
}

function Chip({ children, color }) {
  return (
    <span style={{ color, border: `1px solid ${color}66` }} className="text-[10px] rounded-full px-1.5 py-0.5 uppercase tracking-wide">{children}</span>
  );
}

function AdminScreen({ authUser }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { username, password, verb }
  const [busyKey, setBusyKey] = useState(null);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("guest");
  const [newPassword, setNewPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { users: list } = await api.adminListUsers();
      setUsers(list);
    } catch (err) {
      setError(err.message || "Couldn't load users.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, fn) => {
    setBusyKey(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err.message || "That didn't work.");
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const add = async () => {
    const res = await run("add", () => api.adminCreateUser(newName.trim(), newRole, newPassword));
    if (res) {
      setNotice({ username: res.user.username, password: res.temporaryPassword, verb: "created" });
      setNewName("");
      setNewPassword("");
      setNewRole("guest");
      load();
    }
  };
  const reset = async (u) => {
    const res = await run(`reset:${u.username}`, () => api.adminResetPassword(u.username));
    if (res) {
      setNotice({ username: u.username, password: res.temporaryPassword, verb: "reset" });
      load();
    }
  };
  const setRole = async (u, role) => {
    if (await run(`role:${u.username}`, () => api.adminSetRole(u.username, role))) load();
  };
  const setAccess = async (u, active) => {
    if (await run(`access:${u.username}`, () => api.adminSetAccess(u.username, active))) load();
  };
  const remove = async (u) => {
    if (await run(`rm:${u.username}`, () => api.adminDeleteUser(u.username))) {
      setConfirmRemove(null);
      load();
    }
  };
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked on plain HTTP; the password is shown on screen to copy by hand.
    }
  };

  const small = { border: `1px solid ${C.border}`, color: C.textMuted };

  return (
    <div className="px-4 py-3 space-y-4">
      {notice && (
        <div style={{ background: C.surface, border: `1px solid ${C.brand}` }} className="rounded-md px-3.5 py-3 space-y-1.5">
          <div style={{ color: C.text }} className="text-xs">
            Temporary password for <b>{notice.username}</b> ({notice.verb}). Share it with them now — it isn't shown again. They must change it at first login.
          </div>
          <div className="flex items-center gap-2">
            <code style={{ background: C.bg, color: C.brand }} className="text-sm rounded px-2 py-1 select-all break-all">{notice.password}</code>
            <button onClick={() => copy(notice.password)} style={small} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
              <Copy size={11} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setNotice(null)} style={{ color: C.textFaint }} className="text-[11px]">Dismiss</button>
        </div>
      )}
      {error && <div style={{ color: C.major }} className="text-xs px-1">{error}</div>}

      <div>
        <SectionLabel>Users</SectionLabel>
        {!users && !error && <div className="flex items-center gap-2 px-1 py-3" style={{ color: C.textMuted }}><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading…</span></div>}
        <div className="space-y-2">
          {(users || []).map((u) => {
            const self = u.username === authUser?.username;
            const locked = u.isEnvOwner;
            return (
              <div key={u.username} style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: u.active ? 1 : 0.7 }} className="rounded-md px-3.5 py-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{u.username}</span>
                  <Chip color={u.role === "owner" ? C.brand : C.textMuted}>{u.role}</Chip>
                  {!u.active && <Chip color={C.major}>revoked</Chip>}
                  {u.mustChangePassword && <Chip color={C.minor}>temp password</Chip>}
                  {self && <Chip color={C.textFaint}>you</Chip>}
                </div>
                <div style={{ color: C.textFaint }} className="text-[11px]">
                  {u.lastLoginAt ? `Last login ${new Date(u.lastLoginAt).toLocaleString()}` : "Never logged in"}
                  {locked ? " · set by OWNER_USERNAME" : ""}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={() => reset(u)} disabled={busyKey === `reset:${u.username}`} style={small} className="text-[11px] rounded-full px-2.5 py-1 flex items-center gap-1">
                    <KeyRound size={11} /> Reset password
                  </button>
                  {!locked && !self && (
                    <>
                      <button onClick={() => setRole(u, u.role === "owner" ? "guest" : "owner")} disabled={busyKey === `role:${u.username}`} style={small} className="text-[11px] rounded-full px-2.5 py-1">
                        {u.role === "owner" ? "Make guest" : "Make owner"}
                      </button>
                      <button onClick={() => setAccess(u, !u.active)} disabled={busyKey === `access:${u.username}`} style={{ ...small, color: u.active ? C.major : C.ok }} className="text-[11px] rounded-full px-2.5 py-1">
                        {u.active ? "Revoke access" : "Restore access"}
                      </button>
                      {confirmRemove === u.username ? (
                        <>
                          <button onClick={() => remove(u)} disabled={busyKey === `rm:${u.username}`} style={{ border: `1px solid ${C.major}`, color: C.major }} className="text-[11px] rounded-full px-2.5 py-1">Confirm remove</button>
                          <button onClick={() => setConfirmRemove(null)} style={small} className="text-[11px] rounded-full px-2.5 py-1">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmRemove(u.username)} style={small} className="text-[11px] rounded-full px-2.5 py-1">Remove</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <SectionLabel>Add a user</SectionLabel>
        <div className="space-y-2.5 pt-1.5">
          <TextField value={newName} onChange={setNewName} placeholder="Their Sleeper username" />
          <TextField value={newPassword} onChange={setNewPassword} placeholder="Temporary password (blank = generate one)" autoComplete="off" />
          <div className="flex items-center gap-2">
            {["guest", "owner"].map((r) => (
              <button key={r} onClick={() => setNewRole(r)} style={{ border: `1px solid ${newRole === r ? C.brand : C.border}`, color: newRole === r ? C.brand : C.textMuted }} className="text-xs rounded-full px-3 py-1 capitalize">{r}</button>
            ))}
          </div>
          <PrimaryButton onClick={add} disabled={!newName.trim()} loading={busyKey === "add"} Icon={UserPlus}>
            {busyKey === "add" ? "Adding…" : "Add user"}
          </PrimaryButton>
        </div>
      </div>
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

  const [authUser, setAuthUser] = useState(null);
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
      try {
        const { sessionId, user, week: currentWeek, leagues } = await api.connect();
        setSessionId(sessionId);
        setSleeperUser(user);
        setAvailableLeagues(leagues);
        const validIds = leagues.map((l) => l.league_id);
        const restoredIds = (last?.leagueIds || []).filter((id) => validIds.includes(id));
        setSelectedIds(restoredIds.length ? restoredIds : validIds);
        setWeek(currentWeek);
        if (restoredIds.length === 0) {
          navigate({ screen: "select" }, { replace: true });
          return;
        }
        setLoadingLeagues(true);
        const { leagues: built, week: builtWeek } = await api.buildLeagues(sessionId, restoredIds, last?.week ?? undefined);
        setLiveLeagues(built);
        setWeek(builtWeek ?? currentWeek);
        setSyncedAt("just now");
        navigate({ screen: "dashboard" }, { replace: true });
      } catch (err) {
        // Logged in fine, but Sleeper couldn't be reached — land on the account screen so
        // the person isn't stuck, with the reason shown on the league picker.
        setConnectError(err.message || "Couldn't reach Sleeper — try again.");
        navigate({ screen: "select" }, { replace: true });
      } finally {
        setLoadingLeagues(false);
      }
    },
    [navigate]
  );

  // After login/bootstrap: a pending forced password change blocks everything else.
  const enterApp = useCallback(
    async (status) => {
      setAuthUser(status.user);
      if (status.user.mustChangePassword) {
        navigate({ screen: "forceChange" }, { replace: true });
        return;
      }
      await reconnectFromLastSession(status.lastSession);
    },
    [navigate, reconnectFromLastSession]
  );

  useEffect(() => {
    (async () => {
      try {
        const status = await api.getAuthStatus();
        if (!status.authenticated) {
          navigate({ screen: "login" }, { replace: true });
          return;
        }
        await enterApp(status);
      } catch {
        navigate({ screen: "login" }, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server says the session is gone (logged out elsewhere, or the owner revoked access).
  useEffect(() => {
    const onUnauthorized = () => {
      setAuthUser(null);
      setSessionId(null);
      setLiveLeagues([]);
      setPassword("");
      setLoginError("Your session ended — please log in again.");
      setView((v) => (v.screen === "login" ? v : { screen: "login" }));
      window.history.replaceState({ screen: "login" }, "");
    };
    window.addEventListener("fm-unauthorized", onUnauthorized);
    return () => window.removeEventListener("fm-unauthorized", onUnauthorized);
  }, []);

  const handleLoginSubmit = useCallback(async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await api.login(username.trim(), password);
      setPassword("");
      const status = await api.getAuthStatus();
      await enterApp(status);
    } catch (err) {
      setLoginError(err.message || "Couldn't log in — try again.");
    } finally {
      setLoggingIn(false);
    }
  }, [username, password, enterApp]);

  const handlePasswordChanged = useCallback(async () => {
    const status = await api.getAuthStatus();
    if (status.authenticated) await enterApp(status);
  }, [enterApp]);

  // Optimistic: show the new ranking at once, save in the background, roll back on failure.
  const handleSaveRanking = useCallback(async (leagueId, order) => {
    let previous;
    setLiveLeagues((prev) =>
      prev.map((l) => {
        if (l.id !== leagueId) return l;
        previous = l.customRanking;
        return { ...l, customRanking: order };
      })
    );
    try {
      await api.saveRanking(leagueId, order);
    } catch (err) {
      setLiveLeagues((prev) => prev.map((l) => (l.id === leagueId ? { ...l, customRanking: previous ?? null } : l)));
      throw err;
    }
  }, []);

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
  }, [sessionId, selectedIds, week, navigate]);

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
    setAuthUser(null);
    setUsername("");
    setPassword("");
    setConnectError(null);
    setLoginError(null);
    navigate({ screen: "login" });
  }, [navigate]);

  const handleEditLeagues = useCallback(async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      const { sessionId: freshSessionId, user, leagues } = await api.connect();
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
  }, [liveLeagues, navigate]);

  // Breadcrumb trail: username > League Name > Sub tab name. Every level
  // but the current one is clickable.
  const crumbs = useMemo(() => {
    const root = { label: sleeperUser?.display_name || "Fantasy Manager", onClick: liveLeagues.length ? () => navigate({ screen: "dashboard" }) : undefined };
    if (view.screen === "bootstrapping") return [{ label: "Fantasy Manager" }];
    if (view.screen === "login") return [{ label: "Fantasy Manager" }];
    if (view.screen === "forceChange") return [{ label: "Change password" }];
    if (view.screen === "account") return [root, { label: "Account" }];
    if (view.screen === "admin") return [root, { label: "Account", onClick: () => navigate({ screen: "account" }) }, { label: "Manage users" }];
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
        syncedLabel={showRefresh ? `Synced ${syncedAt} · Sleeper + ESPN projections (live)` : null}
        week={week}
        onWeekChange={handleWeekChange}
        showWeek={showWeek}
      />
      {view.screen === "bootstrapping" && <BootstrapScreen />}
      {view.screen === "login" && (
        <LoginScreen username={username} setUsername={setUsername} password={password} setPassword={setPassword} onSubmit={handleLoginSubmit} loading={loggingIn} error={loginError} />
      )}
      {view.screen === "dashboard" && (
        <Dashboard
          computed={computed}
          onOpenLeague={(id) => navigate({ screen: "league", leagueId: id })}
          onOpenTab={(id, tab) => navigate({ screen: "tab", leagueId: id, tab })}
          onLogout={handleLogout}
          onEditLeagues={handleEditLeagues}
          onOpenAccount={() => navigate({ screen: "account" })}
          sleeperUser={sleeperUser}
        />
      )}
      {view.screen === "forceChange" && <ForcePasswordScreen authUser={authUser} onDone={handlePasswordChanged} onLogout={handleLogout} />}
      {view.screen === "account" && <AccountScreen authUser={authUser} onOpenAdmin={() => navigate({ screen: "admin" })} onLogout={handleLogout} />}
      {view.screen === "admin" && authUser?.role === "owner" && <AdminScreen authUser={authUser} />}
      {view.screen === "select" && (
        <SelectLeaguesScreen leagues={availableLeagues} selectedIds={selectedIds} onToggle={handleToggleLeague} onConfirm={handleConfirmSelection} loading={loadingLeagues || connecting} error={connectError} />
      )}
      {view.screen === "league" && activeLeague && (
        <LeagueOverview league={activeLeague} onOpenTab={(tab) => navigate({ screen: "tab", leagueId: activeLeague.id, tab })} />
      )}
      {view.screen === "tab" && activeLeague && (() => {
        if (activeLeague.error) return <ErrorScreen message={activeLeague.error} />;
        const Comp = TAB_COMPONENTS[view.tab];
        return <Comp league={activeLeague} sessionId={sessionId} onSaveRanking={handleSaveRanking} />;
      })()}
    </div>
  );
}
