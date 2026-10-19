import * as api from "../api.js";
import { fromDollars, toDollars } from "../waiverPlan.js";
import { Cloud, CloudRain, CloudSnow, GripHorizontal, GripVertical, Loader2, Wind, X, XCircle } from "lucide-react";
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
//
// v4.8: while a handle is held the card is LIFTED — a floating copy follows the finger / cursor — and a light line
// with a plus sign shows between the cards where it would land if let go; the list itself only changes on release
// (the original card stays put, dimmed, so the handle keeps receiving the touch). `groupOf(key)` (optional) gives the
// keys that travel together when the second, larger "group" handle is used; they float as a stacked deck of cards and
// land in the same order they had.
export function DragList({ items, getKey, render, onReorder, label = "Drag to reorder", groupOf = null }) {
  const [drag, setDrag] = useState(null); // { key, keys, group, rect, dx, dy, x, y, moved }
  const refs = useRef(new Map());
  const dragRef = useRef(null);
  const keys = items.map(getKey);
  const keysSig = keys.join("\n");
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const byKey = new Map(items.map((i) => [getKey(i), i]));

  // Where the lifted card(s) would land: index among the other cards = how many have their middle above the pointer.
  const slotFor = useCallback((d, y) => {
    const rest = keysRef.current.filter((k) => !d.keys.includes(k));
    let idx = 0;
    for (const k of rest) {
      const el = refs.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) idx++;
      else break;
    }
    return { rest, idx };
  }, []);

  const finish = useCallback(
    (apply) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d || !apply || !d.moved) return;
      const { rest, idx } = slotFor(d, d.y);
      const next = [...rest.slice(0, idx), ...d.keys, ...rest.slice(idx)];
      if (next.join("\n") !== keysRef.current.join("\n")) onReorder(next);
    },
    [onReorder, slotFor]
  );

  const active = Boolean(drag);
  useEffect(() => {
    if (!active) return undefined;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.abs(e.clientY - d.startY) > 4 || Math.abs(e.clientX - d.startX) > 4;
      const next = { ...d, x: e.clientX, y: e.clientY, moved };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => finish(true);
    const onKey = (e) => e.key === "Escape" && finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    let raf;
    const tick = () => {
      const d = dragRef.current;
      if (d) {
        if (d.y < 90) window.scrollBy(0, -14);
        else if (d.y > window.innerHeight - 90) window.scrollBy(0, 14);
        setDrag((cur) => (cur ? { ...cur } : cur)); // re-measure the landing slot while the page scrolls
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    };
  }, [active, finish]);

  // The list changed under a drag (another claim appeared): drop the drag rather than move the wrong cards.
  useEffect(() => {
    if (dragRef.current) finish(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig]);

  const begin = (key, group, e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const el = refs.current.get(key);
    const rect = el ? el.getBoundingClientRect() : { left: e.clientX, top: e.clientY, width: 280, height: 56 };
    const moving = group && groupOf ? groupOf(key).filter((k) => keysRef.current.includes(k)) : [key];
    const ordered = keysRef.current.filter((k) => moving.includes(k));
    const d = { key, keys: ordered.length ? ordered : [key], group: Boolean(group && ordered.length > 1), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    dragRef.current = d;
    setDrag(d);
  };

  const handleFor = (key, group = false) => ({
    onPointerDown: (e) => begin(key, group, e),
    onKeyDown: (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const moving = group && groupOf ? keys.filter((k) => groupOf(key).includes(k)) : [key];
      const from = keys.indexOf(moving[0]);
      const rest = keys.filter((k) => !moving.includes(k));
      const to = Math.max(0, Math.min(rest.length, from + (e.key === "ArrowUp" ? -1 : 1)));
      if (from < 0 || to === from) return;
      onReorder([...rest.slice(0, to), ...moving, ...rest.slice(to)]);
    },
    "aria-label": `${group ? "Drag to move all of this player's claims. " : ""}${label}. Or use the up and down arrow keys.`,
  });

  const slot = drag && drag.moved ? slotFor(drag, drag.y) : null;
  const lifted = new Set(drag ? drag.keys : []);
  const indicator = (
    <div className="flex items-center gap-2 py-0.5" data-drop-slot aria-hidden="true">
      <div style={{ flex: 1, borderTop: `2px dashed ${C.brand}99` }} />
      <div style={{ width: 22, height: 22, borderRadius: 11, background: `${C.brand}33`, border: `1px solid ${C.brand}99`, color: C.brand }} className="flex items-center justify-center text-sm font-semibold leading-none">+</div>
      <div style={{ flex: 1, borderTop: `2px dashed ${C.brand}99` }} />
    </div>
  );
  const out = [];
  let seen = 0; // cards that aren't lifted, counted as we go
  keys.forEach((k) => {
    const item = byKey.get(k);
    if (!item) return;
    if (slot && !lifted.has(k) && seen === slot.idx) out.push(<div key="__slot">{indicator}</div>);
    if (!lifted.has(k)) seen++;
    out.push(
      <div key={k} ref={(el) => (el ? refs.current.set(k, el) : refs.current.delete(k))} style={lifted.has(k) && drag?.moved ? { opacity: 0.35 } : undefined}>
        {render(item, { dragging: drag?.key === k && Boolean(drag?.moved), handleProps: handleFor(k), groupHandleProps: groupOf ? handleFor(k, true) : null })}
      </div>
    );
  });
  if (slot && slot.idx >= seen) out.push(<div key="__slot">{indicator}</div>);

  const ghostItem = drag && drag.moved ? byKey.get(drag.key) : null;
  const layers = drag?.group ? Math.min(3, drag.keys.length) : 1;
  return (
    <div className="space-y-1.5">
      {out}
      {ghostItem && (
        <div style={{ position: "fixed", left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.rect.width, zIndex: 80, pointerEvents: "none" }} data-drag-ghost={drag.group ? "stack" : "card"} aria-hidden="true">
          {Array.from({ length: layers - 1 }, (_, i) => layers - 1 - i).map((n) => (
            <div key={n} style={{ position: "absolute", left: n * 5, top: n * 6, width: "100%", height: drag.rect.height, background: C.surfaceRaised, border: `1px solid ${C.borderStrong || C.border}`, borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.35)" }} />
          ))}
          <div style={{ position: "relative", boxShadow: "0 10px 26px rgba(0,0,0,0.55)", borderRadius: 6, transform: "scale(1.02)" }}>
            {render(ghostItem, { dragging: true, ghost: true, handleProps: {}, groupHandleProps: null })}
            {drag.group && (
              <div style={{ position: "absolute", right: -6, top: -8, background: C.brand, color: "#fff" }} className="rounded-full px-1.5 text-[11px] font-semibold">
                ×{drag.keys.length}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function DragHandle({ handleProps, dragging, big = false }) {
  if (!handleProps) return null;
  return (
    <button type="button" {...handleProps} data-drag-handle={big ? "group" : "one"} title={big ? "Drag to move all of this player's claims at this bid" : undefined} style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab", color: big ? C.brand : C.textFaint, ...(big ? { border: `1px solid ${C.brand}66`, borderRadius: 6, width: 34, minHeight: 40, background: `${C.brand}14` } : {}) }} className={big ? "shrink-0 flex items-center justify-center -ml-1" : "p-1 -ml-1 shrink-0"}>
      {big ? <GripHorizontal size={22} /> : <GripVertical size={18} />}
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
        // v4.1: sent but not verified (a waiver claim Sleeper accepted that the read-back couldn't see) is yellow.
        <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${r.ok ? (r.verified === false ? C.minor : C.ok) : C.major}`, color: C.text }} className="rounded-md px-3 py-2 text-xs" data-push-result={r.ok ? (r.verified === false ? "sent" : "ok") : "failed"}>
          <div>{r.label}</div>
          <div style={{ color: r.ok ? (r.verified === false ? C.minor : C.ok) : C.major }}>{r.ok ? (r.verified ? "Done — read back from Sleeper and confirmed" : r.verified === false ? "Sent, not verified" : "Sent") : "Not confirmed"}{r.detail ? ` — ${r.detail}` : ""}</div>
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

/**
 * v4.4.2 — an "i" button that opens a note in place. Used instead of an always-visible explanation where the note is
 * helpful but not needed every time. `inline` puts the button on the line of the label next to it.
 */
export function InfoNote({ children, label = "More info", className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={className} data-info-note>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={label}
        aria-expanded={open}
        data-info-button
        style={{ color: open ? C.brand : C.textFaint, border: `1px solid ${open ? C.brand : C.border}` }}
        className="inline-flex items-center justify-center rounded-full w-[18px] h-[18px] text-[10px] font-semibold leading-none align-middle"
      >
        i
      </button>
      {open && (
        <span style={{ color: C.textMuted }} className="block text-[11px] leading-snug mt-1" data-info-text>
          {children}
        </span>
      )}
    </span>
  );
}
