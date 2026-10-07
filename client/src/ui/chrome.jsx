import * as api from "../api.js";
import { ArrowLeftRight, Bell, BellOff, CheckCircle2, ChevronRight, ClipboardList, ListChecks, Loader2, LogOut, RefreshCw, Settings2, Stethoscope, TrendingUp, Trophy, UserCog, Users } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Avatar, FootballPlayerIcon, UprightsIcon } from "./common.jsx";
import { C } from "./theme.js";

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

// v3.9: a crumb with `options` (the league name, the page name) is a drop-down for quick navigation.
function CrumbMenu({ c, current }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative min-w-0 shrink" data-crumb-menu={c.menuKey || c.label}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-0.5 min-w-0 max-w-full">
        <span style={{ color: current ? C.text : C.textMuted, fontFamily: "Oswald, sans-serif", fontWeight: current ? 600 : 400 }} className="text-[15px] truncate">
          {c.label}
        </span>
        <ChevronRight size={13} style={{ color: C.textFaint, transform: open ? "rotate(270deg)" : "rotate(90deg)" }} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="menu" className="absolute left-0 top-full mt-2 z-30 rounded-lg w-60 py-1 shadow-lg max-h-[70vh] overflow-y-auto" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
            {c.options.map((o, i) =>
              o.divider ? (
                <div key={`d${i}`} style={{ borderTop: `1px solid ${C.border}` }} className="my-1" />
              ) : (
                <button key={o.key || o.label} type="button" role="menuitem" onClick={() => { setOpen(false); o.onSelect?.(); }} className="w-full text-left px-3 py-2 text-sm truncate" style={{ color: o.current ? C.brand : C.text, fontWeight: o.current ? 600 : 400 }} data-crumb-option={o.key || o.label}>
                  {o.label}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Breadcrumb({ crumbs }) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight size={13} style={{ color: C.textFaint }} className="shrink-0" />}
          {c.options?.length ? (
            <CrumbMenu c={c} current={i === crumbs.length - 1} />
          ) : c.onClick ? (
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

// v3.5: tapping your name or photo (top left) opens League management, alerts, Account settings and Log out.
function UserMenu({ name, avatar, onEditLeagues, onOpenAccount, onLogout, onHome, compact = false }) {
  const [open, setOpen] = useState(false);
  const item = (Icon, label, onClick, sub) => (
    <button type="button" role="menuitem" onClick={() => { setOpen(false); onClick?.(); }} className="w-full text-left px-3 py-2 flex items-start gap-2.5" style={{ color: C.text }} data-menu-item={label}>
      <Icon size={15} className="mt-0.5 shrink-0" style={{ color: C.textMuted }} />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {sub && <span className="block text-[11px]" style={{ color: C.textFaint }}>{sub}</span>}
      </span>
    </button>
  );
  return (
    <div className="relative shrink-0 min-w-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-2 min-w-0" data-user-menu>
        <Avatar avatar={avatar} name={name} size={28} />
        {!compact && <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-[15px] truncate max-w-[8.5rem]">{name}</span>}
        {!compact && <ChevronRight size={14} style={{ color: C.textFaint, transform: open ? "rotate(270deg)" : "rotate(90deg)" }} className="shrink-0" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div role="menu" className="absolute left-0 top-full mt-2 z-30 rounded-lg w-64 py-1 shadow-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} data-user-menu-panel>
            {onHome && item(ListChecks, "My leagues", onHome, "The League Management dashboard")}
            {item(Settings2, "League management", onEditLeagues, "Choose which leagues are tracked")}
            <div className="px-3 py-2" style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
              <PushToggle align="start" />
            </div>
            {item(UserCog, "Account settings", onOpenAccount, "Password, Sleeper access, CBS pick'em")}
            {item(LogOut, "Log out", onLogout)}
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar({ crumbs, onRefresh, refreshing, week, onWeekChange, showWeek, userMenu }) {
  const rest = userMenu ? crumbs.filter((c) => !c.root) : crumbs;
  return (
    <div className="sticky top-0 z-10" style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-1.5 min-w-0">
          {userMenu && <UserMenu {...userMenu} compact={rest.length > 0} />}
          {userMenu && rest.length > 0 && <ChevronRight size={13} style={{ color: C.textFaint }} className="shrink-0" />}
          {rest.length > 0 && <Breadcrumb crumbs={rest} />}
        </div>
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
    </div>
  );
}

export const TAB_META = {
  roster: { label: "Roster", short: "Roster", Icon: ListChecks },
  waiver: { label: "Waivers", short: "Waivers", Icon: Users },
  trade: { label: "Trade Radar", short: "Trades", Icon: ArrowLeftRight },
  injury: { label: "Injury Watch", short: "Injury", Icon: Stethoscope },
  league: { label: "League", short: "League", Icon: Settings2 },
  odds: { label: "Season Outlook", short: "Outlook", Icon: Trophy },
};

// v3.9: the team pages as tabs under the League Management header (Overview, Roster, Waivers, …).
export function LeagueTabs({ active, onSelect, statusOf }) {
  const tabs = [{ key: "overview", short: "Overview" }, ...Object.entries(TAB_META).map(([key, m]) => ({ key, short: m.short }))];
  const dotColor = { major: C.major, minor: C.minor };
  return (
    <div className="flex overflow-x-auto px-2" style={{ borderBottom: `1px solid ${C.border}`, background: C.bg }} data-league-tabs>
      {tabs.map((t) => {
        const st = statusOf?.(t.key);
        return (
          <button key={t.key} type="button" onClick={() => onSelect(t.key)} aria-current={active === t.key ? "page" : undefined} data-league-tab={t.key} style={{ color: active === t.key ? C.text : C.textMuted, borderBottom: `2px solid ${active === t.key ? C.brand : "transparent"}` }} className="relative shrink-0 px-3 py-2 text-xs font-medium whitespace-nowrap">
            {t.short}
            {dotColor[st] && <span className="absolute top-1.5 right-0.5 inline-block w-1.5 h-1.5 rounded-full" style={{ background: dotColor[st] }} aria-label={st === "major" ? "Needs action" : "Worth a look"} />}
          </button>
        );
      })}
    </div>
  );
}

// Season Outlook is fetched on demand (like FAAB), not derived from the
// league build response, so it has no pass/fail "status" the way the
// other tabs do — excluded from the per-league status-badge rows on the
// Dashboard and League Overview screens, but still a normal tab
// otherwise (breadcrumb, navigation, TAB_COMPONENTS all use it as-is).
export const STATUS_BADGE_TABS = Object.keys(TAB_META).filter((k) => k !== "odds");

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
function PushToggle({ align = "end" } = {}) {
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

  if (!state.supported) return <div style={{ color: C.textFaint }} className="text-xs">Alerts aren't supported in this browser.</div>;
  return (
    <div className={`flex flex-col ${align === "start" ? "items-start" : "items-end"} gap-1`}>
      <button onClick={toggle} disabled={state.busy} style={{ color: state.subscribed ? C.ok : C.textMuted }} className="text-xs font-medium flex items-center gap-1">
        {state.busy ? <Loader2 size={13} className="animate-spin" /> : state.subscribed ? <Bell size={13} /> : <BellOff size={13} />}
        {state.subscribed ? "Alerts on" : "Enable alerts"}
      </button>
      {state.error && <div style={{ color: C.major }} className="text-[10px] max-w-[180px] text-right">{state.error}</div>}
    </div>
  );
}

const TABS = [
  { key: "leagues", label: "League Management", Icon: FootballPlayerIcon },
  { key: "gameday", label: "Game Day", Icon: UprightsIcon },
  { key: "pickem", label: "Pick'em", Icon: CheckCircle2 },
  { key: "analytics", label: "Analytics", Icon: TrendingUp },
  { key: "commish", label: "Commish", Icon: ClipboardList }, // v3.8
];

export function TabBar({ active, onSelect, dots = {} }) {
  // v3.5: icon above a short label so every tab fits on a phone (and a fifth tab can be added).
  return (
    <div className="flex" style={{ borderBottom: `1px solid ${C.border}`, background: C.bg }}>
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          style={{ color: active === key ? C.text : C.textMuted, borderBottom: `2px solid ${active === key ? C.brand : "transparent"}` }}
          className="flex-1 min-w-0 pt-2 pb-1.5 px-0.5 flex flex-col items-center justify-center gap-0.5"
          aria-current={active === key ? "page" : undefined}
          data-tab={key}
        >
          <span className="relative">
            <Icon size={18} />
            {dots[key] ? <span className="absolute -top-0.5 -right-1.5 inline-block w-2 h-2 rounded-full" style={{ background: C.major }} aria-label={key === "commish" ? "Charter action due within a week" : "Changed picks"} /> : null}
          </span>
          <span className="text-[10.5px] font-medium leading-tight text-center">{label}</span>
        </button>
      ))}
    </div>
  );
}

// Real projection-source status for the header (replaces fixed text).
export function sourceStatusLabel(st) {
  const p = st?.projections;
  if (!p) return "Projections: not loaded yet";
  const parts = [`Vegas ${p.counts.V}`, `Tank01 ${p.counts.T}`, `Sleeper ${p.counts.S}`, `ESPN ${p.counts.E}`];
  const t = st.tank01;
  const tank = !t?.configured ? " · Tank01 key not set" : t.rateLimited ? " · Tank01 paused (rate limit)" : t.projectionsAt ? ` · Tank01 data ${new Date(t.projectionsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}, props for ${t.oddsWithProps}/${t.oddsGames} games` : " · no Tank01 data yet";
  return `Projections (players): ${parts.join(" · ")}${tank}`;
}
