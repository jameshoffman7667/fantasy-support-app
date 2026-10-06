import * as api from "../api.js";
import { fromDollars, toDollars } from "../waiverPlan.js";
import { Cloud, CloudRain, CloudSnow, GripVertical, Loader2, Wind, X, XCircle } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { C, SOURCE_TAG, SRC_COLOR, STATUS, TIER_COLORS, TIER_LABELS, formatStatLine, initials, inputStyle, normTeam, ordinal } from "./theme.js";

/* ------------------------------------------------------------------ */
/*  UI PRIMITIVES                                                      */
/* ------------------------------------------------------------------ */
export function StatusBadge({ status, label, onClick, compact }) {
  const s = STATUS[status];
  const Icon = s.Icon;
  const Tag = onClick ? "button" : "span"; // a plain badge inside an already-clickable row must not be a nested button
  return (
    <Tag
      onClick={onClick}
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}33` }}
      className={`flex items-center ${compact ? "gap-0.5 px-1 py-1" : "gap-1 px-2.5 py-1.5"} rounded-md shrink-0`}
    >
      <Icon size={compact ? 11 : 14} strokeWidth={2.3} />
      {label && <span className={`${compact ? "text-[10.5px] tracking-tight" : "text-xs"} font-medium`} style={{ fontFamily: "Inter, sans-serif" }}>{label}</span>}
    </Tag>
  );
}

export function SourceTag({ source, factor }) {
  if (!source) return null;
  if (source === "actual") {
    return (
      <span style={{ color: C.brand }} className="absolute bottom-1 right-1.5 text-[9px] font-semibold tracking-wide">
        FINAL
      </span>
    );
  }
  return (
    <span style={{ color: SRC_COLOR[source] || C.textFaint }} className="absolute bottom-1 right-1.5 text-[9px] font-medium tracking-wide">
      {SOURCE_TAG[source] || source}
      {factor ? ` ×${factor}` : ""}
    </span>
  );
}

// What player cards need from the App: the matchup tables and the pop-ups.
export const CardCtx = React.createContext({ dvpRow: () => null, openDvp: () => {}, openWeather: () => {} });

export function Headshot({ player, size = 32 }) {
  const [failed, setFailed] = useState(false);
  const isDef = player?.pos === "DEF";
  const src = !player?.id ? null : isDef ? api.teamLogoUrl(player.id) : api.playerImageUrl(player.id);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div
        style={{ width: size, height: size, background: C.surfaceRaised, color: C.textMuted, fontSize: Math.max(9, size * 0.34) }}
        className="rounded-full flex items-center justify-center shrink-0 font-semibold"
        aria-hidden="true"
      >
        {isDef ? player?.id : initials(player?.name)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: isDef ? "contain" : "cover", background: C.surfaceRaised }}
      className="rounded-full shrink-0"
    />
  );
}

export function TeamLogo({ team, size = 20 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [team]);
  if (!team) return null;
  if (failed) {
    return (
      <span style={{ width: size, height: size, fontSize: Math.max(8, size * 0.36), color: C.textMuted, background: C.surfaceRaised }} className="inline-flex items-center justify-center rounded shrink-0 font-semibold">
        {team}
      </span>
    );
  }
  return <img src={api.teamLogoUrl(team)} alt={team} loading="lazy" onError={() => setFailed(true)} width={size} height={size} style={{ width: size, height: size, objectFit: "contain" }} className="shrink-0" />;
}

function TeamPill({ team, row, side, pos, profile }) {
  const ctx = React.useContext(CardCtx);
  const color = row ? TIER_COLORS[row.tier] : C.textMuted;
  const what = side === "off" ? `${team} ${pos}s score ${row?.value} pts/game — ${row ? ordinal(row.rank) : ""} best offense` : `${team} allows ${row?.value} pts/game to ${pos}s — ${row ? ordinal(row.rank) : ""} toughest defense`;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (row) ctx.openDvp({ profile, side, team, pos });
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ color, border: `1px solid ${color}88`, background: row ? `${color}22` : "transparent" }}
      className="text-[10px] rounded px-1.5 py-0.5 font-semibold"
      title={row ? `${what} (${TIER_LABELS[row.tier].toLowerCase()} for your player)` : team}
      aria-label={row ? what : team}
    >
      {team}
    </button>
  );
}

export function MatchupChip({ player, profile }) {
  const ctx = React.useContext(CardCtx);
  const m = player?.matchup;
  if (!m?.opp) return null;
  const own = normTeam(m.team || player.team);
  const opp = normTeam(m.opp);
  const offRow = ctx.dvpRow(profile, "off", player.pos, own);
  const defRow = ctx.dvpRow(profile, "def", player.pos, opp);
  return (
    <span className="inline-flex items-center gap-1" data-matchup={`${own}${m.home ? " vs " : " @ "}${opp}`}>
      <TeamPill team={own} row={offRow} side="off" pos={player.pos} profile={profile} />
      <span style={{ color: C.textFaint }} className="text-[10px]">{m.home ? "vs" : "@"}</span>
      <TeamPill team={opp} row={defRow} side="def" pos={player.pos} profile={profile} />
    </span>
  );
}

function weatherIcon(w) {
  if (w.precipType === "snow") return CloudSnow;
  if (w.precipType) return CloudRain;
  if ((w.wind ?? 0) >= 12 || (w.gust ?? 0) >= 20) return Wind;
  return Cloud;
}

export function WeatherChip({ player }) {
  const ctx = React.useContext(CardCtx);
  const w = player?.weather;
  // Domes get nothing; games with no forecast yet get nothing.
  if (!w || w.indoor || w.temp == null) return null;
  const Icon = weatherIcon(w);
  const color = w.flag ? C.minor : C.textMuted;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.openWeather(w.key);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ color, border: `1px solid ${color}66`, background: w.flag ? C.minorBg : "transparent" }}
      className="text-[10px] rounded px-1.5 py-0.5 inline-flex items-center gap-1"
      title={w.flag ? w.reasons.join("; ") : "Game-time forecast"}
    >
      <Icon size={11} />
      {Math.round(w.temp)}° · {Math.round(w.wind ?? 0)} mph{w.precipProb >= 30 ? ` · ${w.precipProb}%` : ""}
      {w.roofNote ? " · roof" : ""}
    </button>
  );
}

export function StatLine({ player }) {
  if (!player?.projStats || player.projSource === "actual") return null;
  const src = SOURCE_TAG[player.projSource] || player.projSource;
  return (
    <div style={{ color: C.textFaint }} className="text-[10px] mt-1 leading-snug">
      Proj (<span style={{ color: SRC_COLOR[player.projSource] || undefined }}>{src}</span>): {formatStatLine(player.projStats)}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{ background: "rgba(0,0,0,0.6)" }} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-t-xl sm:rounded-xl p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-base">{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ color: C.textMuted }} className="p-1">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// v3.5: Sleeper avatar (user photo or league picture) with an initials fallback.
export function Avatar({ avatar, name, size = 28, square = false }) {
  const [failed, setFailed] = useState(false);
  const src = api.avatarUrl(avatar);
  useEffect(() => setFailed(false), [src]);
  const shape = square ? "rounded-md" : "rounded-full";
  if (!src || failed) {
    return (
      <span style={{ width: size, height: size, background: C.surfaceRaised, color: C.textMuted, fontSize: Math.max(9, size * 0.38) }} className={`${shape} inline-flex items-center justify-center shrink-0 font-semibold`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: "cover", background: C.surfaceRaised }} className={`${shape} shrink-0`} />;
}

export function ErrorScreen({ message }) {
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

export function SectionLabel({ children }) {
  return <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-[11px] tracking-wide px-1 pt-3 pb-1.5">{children}</div>;
}

// Usage badge: snap %/targets/carries from the nflverse-backed `usage`
// field (see server/nflverseUsage.js). That source isn't guaranteed to
// match every player by name, so this renders nothing rather than a
// misleading placeholder when usage is missing.
export function UsageBadge({ usage }) {
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

// Matchup + weather chips for the compact lineup rows.
export function RowChips({ player, profile }) {
  if (!player || (!player.matchup && !player.weather)) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap mt-1">
      <MatchupChip player={player} profile={profile} />
      <WeatherChip player={player} />
    </div>
  );
}

// Reusable vertical drag list. Items can only move inside their own list, so
// one list per FAAB group keeps claims from being dragged between groups.
export function DragList({ items, getKey, render, onReorder, label = "Drag to reorder" }) {
  const [live, setLive] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const refs = useRef(new Map());
  const lastY = useRef(0);
  const liveRef = useRef(null);
  const keys = items.map(getKey);
  const keysSig = keys.join("\n");
  const order = live || keys;
  const byKey = new Map(items.map((i) => [getKey(i), i]));
  const orderRef = useRef(order);
  orderRef.current = order;

  const reorderToPointer = useCallback(() => {
    const key = dragKey;
    if (!key) return;
    const cur = liveRef.current || orderRef.current;
    const without = cur.filter((k) => k !== key);
    let idx = 0;
    for (const k of without) {
      const el = refs.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (lastY.current > r.top + r.height / 2) idx++;
      else break;
    }
    const next = [...without.slice(0, idx), key, ...without.slice(idx)];
    if (next.some((k, i) => k !== cur[i])) {
      liveRef.current = next;
      setLive(next);
    }
  }, [dragKey]);

  useEffect(() => {
    if (!dragKey) return undefined;
    const onMove = (e) => {
      lastY.current = e.clientY;
      reorderToPointer();
    };
    const onUp = () => {
      const result = liveRef.current;
      liveRef.current = null;
      setLive(null);
      setDragKey(null);
      if (result && result.join("\n") !== keysSig) onReorder(result);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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
  }, [dragKey, reorderToPointer, onReorder, keysSig]);

  const handleFor = (key) => ({
    onPointerDown: (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      lastY.current = e.clientY;
      liveRef.current = null;
      setDragKey(key);
    },
    onKeyDown: (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const from = keys.indexOf(key);
      const to = from + (e.key === "ArrowUp" ? -1 : 1);
      if (from < 0 || to < 0 || to >= keys.length) return;
      const next = [...keys];
      next.splice(from, 1);
      next.splice(to, 0, key);
      onReorder(next);
    },
    "aria-label": `${label}. Or use the up and down arrow keys.`,
  });

  return (
    <div className="space-y-1.5">
      {order.map((k) => {
        const item = byKey.get(k);
        if (!item) return null;
        return (
          <div key={k} ref={(el) => (el ? refs.current.set(k, el) : refs.current.delete(k))}>
            {render(item, { dragging: dragKey === k, handleProps: handleFor(k) })}
          </div>
        );
      })}
    </div>
  );
}

export function DragHandle({ handleProps, dragging }) {
  return (
    <button type="button" {...handleProps} data-drag-handle style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab", color: C.textFaint }} className="p-1 -ml-1 shrink-0">
      <GripVertical size={18} />
    </button>
  );
}

// A bid box: type dollars or a % of the budget; empty removes the claim, 0 is a real bid.
export function BidBox({ dollars, mode, budget, onCommit, width = 64, ariaLabel }) {
  const shown = fromDollars(dollars, mode, budget);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const d = toDollars(text, mode, budget);
    if (d == null && text.trim() !== "") {
      setText(shown); // not a number — put back what was there
      return;
    }
    if (d === dollars) {
      setText(shown);
      return;
    }
    onCommit(d);
  };
  return (
    <label className="flex items-center gap-0.5" style={{ color: C.textMuted }}>
      {mode === "dollars" && <span className="text-xs">$</span>}
      <input
        inputMode="decimal"
        value={text}
        placeholder="bid"
        aria-label={ariaLabel || "Bid"}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        style={{ ...inputStyle, width }}
        className="rounded-md px-2 py-1 text-sm outline-none text-right"
        data-bid-input
      />
      {mode === "percent" && <span className="text-xs">%</span>}
    </label>
  );
}

export function EntryModeToggle({ mode, onChange }) {
  const b = (m, label) => (
    <button type="button" onClick={() => onChange(m)} aria-pressed={mode === m} style={{ background: mode === m ? C.brand : "transparent", color: mode === m ? C.text : C.textMuted }} className="text-xs px-2.5 py-1">
      {label}
    </button>
  );
  return (
    <div style={{ border: `1px solid ${C.border}` }} className="inline-flex rounded-md overflow-hidden" role="group" aria-label="Enter bids as">
      {b("dollars", "$")}
      {b("percent", "% of budget")}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.0 — Sleeper private access: gate, confirm box, results          */
/* ------------------------------------------------------------------ */
const GROUP_NAME = { roster: "Roster changes", claims: "Waiver claims", trades: "Trades" };

// v3.1: `group` is one of roster | claims | trades (the three write switches); a read-only
// gate has none. Reads switched off hides everything private.
export function PrivateGate({ league, group = null, write = false, onOpenAccount, children }) {
  const pi = league.privateInfo;
  const box = (text) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-xs space-y-2" data-private-gate>
      <div>{text}</div>
      {onOpenAccount && (
        <button type="button" onClick={onOpenAccount} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2.5 py-1 text-xs">
          Open Account → Sleeper access
        </button>
      )}
    </div>
  );
  if (!pi?.configured) return box("This needs your Sleeper login token (Account → Sleeper access). It stays on your server and is optional — everything else works without it.");
  if (pi.readsOff) return box("Reading from Sleeper's private API is switched off. Turn on \"Read from Sleeper\" under Account → Sleeper access to use this.");
  const g = group || (write ? "roster" : null);
  if (g && !(pi.perms ? pi.perms[g] : pi.writesEnabled)) return box(`Pushing ${GROUP_NAME[g].toLowerCase()} to Sleeper is switched off. Turn on "${GROUP_NAME[g]}" under Account → Sleeper access to use this.`);
  return children;
}

// Shows exactly what will be sent and asks for a second click.
export function ConfirmPush({ title, lines, buttonLabel, busy, onConfirm, onCancel, note }) {
  return (
    <div style={{ background: C.surfaceRaised, border: `1px solid ${C.brand}66` }} className="rounded-md px-3 py-3 space-y-2" data-confirm-push>
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-sm">{title}</div>
      <ul className="text-xs space-y-1" style={{ color: C.text }}>
        {lines.map((l, i) => <li key={i}>• {l}</li>)}
      </ul>
      {note && <div style={{ color: C.textMuted }} className="text-[11px]">{note}</div>}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={onConfirm} style={{ background: C.brand, color: C.text, opacity: busy ? 0.6 : 1 }} className="rounded-md px-3 py-1.5 text-sm" data-confirm-send>
          {busy ? "Sending…" : buttonLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-sm">Cancel</button>
      </div>
    </div>
  );
}

export function PushResults({ results }) {
  if (!results?.length) return null;
  return (
    <div className="space-y-1" data-push-results>
      {results.map((r, i) => (
        <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${r.ok ? C.ok : C.major}`, color: C.text }} className="rounded-md px-3 py-2 text-xs">
          <div>{r.label}</div>
          <div style={{ color: r.ok ? C.ok : C.major }}>{r.ok ? (r.verified ? "Done — read back from Sleeper and confirmed" : "Sent") : "Not confirmed"}{r.detail ? ` — ${r.detail}` : ""}</div>
        </div>
      ))}
    </div>
  );
}

export function TextField({ type = "text", value, onChange, onEnter, placeholder, autoFocus, autoComplete }) {
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

export function PrimaryButton({ onClick, disabled, loading, Icon, children }) {
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

export function Chip({ children, color }) {
  return (
    <span style={{ color, border: `1px solid ${color}66` }} className="text-[10px] rounded-full px-1.5 py-0.5 uppercase tracking-wide">{children}</span>
  );
}

export function Select({ value, onChange, options, label }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide" style={{ color: C.textFaint }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
        className="text-xs rounded-md px-2 py-1.5 outline-none normal-case tracking-normal"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ checked, onChange, children }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{ border: `1px solid ${checked ? C.brand : C.border}`, color: checked ? C.brand : C.textMuted }}
      className="text-[11px] rounded-full px-2.5 py-1"
    >
      {checked ? "✓ " : ""}{children}
    </button>
  );
}

export function RedDot({ title }) {
  return <span title={title} aria-label={title} className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: C.major }} />;
}

/* ------------------------------------------------------------------ */
/*  TABS (v2.6)                                                         */
/* ------------------------------------------------------------------ */
// v3.5: League Management = a football player outline, Game Day = goal-post uprights.
export function FootballPlayerIcon({ size = 16, className = "", style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true" data-icon="football-player">
      <path d="M9 10V7.2a3.2 3.2 0 0 1 6.4 0v1.6h-1.6" />
      <path d="M13.8 8.8h3v2.2h-3" />
      <path d="M15.6 11v1" />
      <path d="M4 21v-3.2A4.8 4.8 0 0 1 8.8 13h6.4a4.8 4.8 0 0 1 4.8 4.8V21" />
      <path d="M9.5 13l2.5 2.6 2.5-2.6" />
    </svg>
  );
}

export function UprightsIcon({ size = 16, className = "", style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true" data-icon="uprights">
      <path d="M5 3v9h14V3" />
      <path d="M12 12v9" />
      <path d="M9 21h6" />
    </svg>
  );
}

export function BootstrapScreen() {
  return (
    <div className="px-5 py-16 flex flex-col items-center gap-3">
      <Loader2 size={24} className="animate-spin" style={{ color: C.brand }} />
      <div style={{ color: C.textMuted }} className="text-sm">Reconnecting…</div>
    </div>
  );
}
