import * as api from "../api.js";
import { FLEX_ELIGIBLE, GROUP_LABEL, effectiveLineup, hasStarted, isZeroProjection, lockedNames } from "../lineup.js";
import { arrangement, buildPush, changeNotes, customChange, dropOptions, openSpotsForAdd, proposeChanges, swapOptions, toggle as toggleChange } from "../rosterChanges.js";
import { lineupGap, pushKeys } from "../variances.js";
import { ArrowLeft, GripVertical, ListOrdered } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmPush, Headshot, InfoNote, MatchupChip, Modal, PrivateGate, PushResults, RowChips, SectionLabel, SourceTag, StatLine, UsageBadge, WeatherChip } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C, POS_COLOR, SOURCE_TAG, SRC_COLOR, STATUS, backupLine, fmtWhen, formatStatLine } from "../ui/theme.js";
import { StartSitButton, StartSitIcon } from "../ui/startSit.jsx"; // v4.3

/* ------------------------------------------------------------------ */
/*  v3.6 ROSTER PAGE: "Current lineup" and "Proposed lineup" tabs        */
/* ------------------------------------------------------------------ */
// Sleeper-style slot colours: positions from POS_COLOR, bench / IR / taxi their own.
const SLOT_EXTRA = { BN: "#5E7570", IR: "#D6533B", TAXI: "#A08BE0" };
const slotColor = (slot) => POS_COLOR[slot] || SLOT_EXTRA[slot] || POS_COLOR.FLEX;
// v4.5: a flex slot is shown as vertical bands in the colours of the positions that can play it.
const flexBands = (label) => (FLEX_ELIGIBLE[label] ? FLEX_ELIGIBLE[label].map((p) => POS_COLOR[p]).filter(Boolean) : null);
const bandBackground = (label) => {
  const bands = flexBands(label);
  if (!bands || bands.length < 2) return null;
  const w = 100 / bands.length;
  return `linear-gradient(to right, ${bands.map((c, i) => `${c} ${i * w}%, ${c} ${(i + 1) * w}%`).join(", ")})`;
};
export function PosBox({ label, small = false }) {
  const bands = bandBackground(label);
  return (
    <span
      style={{ background: bands || slotColor(label), color: "#0E1416", fontFamily: "Oswald, sans-serif", letterSpacing: "0.02em", textShadow: bands ? "0 0 3px rgba(255,255,255,0.75), 0 0 1px rgba(255,255,255,0.9)" : undefined }}
      className={`inline-flex items-center justify-center rounded font-bold shrink-0 ${small ? "text-[9px] w-9 h-5" : "text-[11px] w-11 h-7"}`}
      data-pos-box={label}
      {...(bands ? { "data-flex-bands": flexBands(label).length } : {})}
    >
      {label}
    </span>
  );
}

const PROP_ORDER = ["passyds", "passtd", "intsthrown", "comp", "passatt", "rushyds", "longrush", "recs", "recyds", "rushrec", "anytd", "kickpts"];
const PROP_LABEL = { passyds: "pass yd", passtd: "pass TD", intsthrown: "INT", comp: "cmp", passatt: "att", rushyds: "rush yd", longrush: "long rush", recs: "rec", recyds: "rec yd", rushrec: "rush+rec yd", kickpts: "kick pts" };
export function propText(props) {
  if (!props) return "";
  return PROP_ORDER.filter((k) => props[k] != null)
    .map((k) => (k === "anytd" ? `anytime TD ${props[k] > 0 ? "+" : ""}${props[k]}` : `${props[k]} ${PROP_LABEL[k]}`))
    .join(" · ");
}

// Implied team totals (Vegas) before and during the game; the live or final score once it has started.
function GameLines({ m }) {
  if (!m) return null;
  const started = m.state === "in" || m.state === "post";
  const sign = (n) => `${n > 0 ? "+" : ""}${n}`;
  return (
    <>
      {m.implied != null && (
        <div style={{ color: C.textMuted }} className="text-[11px] mt-0.5" data-implied>
          Implied <b style={{ color: C.text }}>{m.team} {m.implied}</b> – {m.opp} {m.oppImplied}
          <span style={{ color: C.textFaint }}>{m.spread != null ? ` · ${m.team} ${sign(m.spread)}` : ""}{m.total != null ? ` · O/U ${m.total}` : ""}</span>
        </div>
      )}
      {started && m.teamScore != null && m.oppScore != null && (
        <div style={{ color: m.state === "in" ? C.brand : m.teamScore > m.oppScore ? C.ok : m.teamScore < m.oppScore ? C.major : C.textMuted }} className="text-[11px] mt-0.5 font-medium" data-game-score>
          {m.state === "post" ? "Final" : m.statusDetail || "Live"} · {m.team} {m.teamScore} – {m.opp} {m.oppScore}
        </div>
      )}
    </>
  );
}

function PointsCol({ p }) {
  if (p.projSource === "actual") {
    const live = p.matchup?.state === "in";
    return (
      <div className="text-right shrink-0 min-w-[3.25rem]" data-points="actual">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-lg font-semibold leading-tight">{p.proj != null ? p.proj.toFixed(1) : "—"}</div>
        <div style={{ color: live ? C.brand : C.textMuted }} className="text-[10px] font-semibold">{live ? "LIVE" : "FINAL"}</div>
        {p.preProj != null && <div style={{ color: C.textFaint }} className="text-[10px]">proj {p.preProj.toFixed(1)}</div>}
        <StartSitButton player={p} />
      </div>
    );
  }
  return (
    <div className="text-right shrink-0 min-w-[3.25rem]" data-points="proj">
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-lg font-semibold leading-tight">{p.proj != null ? p.proj.toFixed(1) : "—"}</div>
      <div style={{ color: SRC_COLOR[p.projSource] || C.textFaint }} className="text-[10px]">{SOURCE_TAG[p.projSource] || "no proj"}{p.projFactor ? ` ×${p.projFactor}` : ""}</div>
      <StartSitButton player={p} />
    </div>
  );
}

/**
 * One roster row with everything the old player cards showed: photo, position colours, team strength vs the
 * opponent's defence, kickoff and weather, implied team totals, live/final score, prop lines, projected and
 * actual stat lines, usage, projected and actual points. `notes` are coloured lines under it; `highlight`
 * ("in" | "out" | "ir") marks a change on the Proposed lineup tab.
 */
function RosterPlayerRow({ slot, player: p, profile, severity = null, notes = [], highlight = null, sub = null, emptyLabel = "(empty)", onTapEmpty = null, onSlotTap = null }) {
  // v4.4: on the Proposed lineup the position box is a button that opens the swap list
  const pos = (onSlotTap ? <button type="button" onClick={onSlotTap} className="rounded" style={{ outline: `1px dashed ${C.brand}88`, outlineOffset: 2 }} aria-label={`${slot}: choose who plays here`} data-slot-edit={slot}><PosBox label={slot} /></button> : <PosBox label={slot} />);
  const sev = severity ? STATUS[severity] : null;
  const edge = highlight === "in" ? C.ok : highlight === "out" ? C.minor : highlight === "ir" ? C.major : sev ? sev.color : C.border;
  const bg = highlight === "in" ? C.okBg : highlight === "out" ? C.minorBg : C.surface;
  if (!p) {
    // v4.1: an open bench spot (with its "consider a waiver add" note) is a link to this league's Waivers page.
    const Tag = onTapEmpty ? "button" : "div";
    return (
      <Tag {...(onTapEmpty ? { type: "button", onClick: onTapEmpty, "aria-label": `${emptyLabel} — open Waivers`, "data-open-waivers": true } : {})} style={{ background: bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${edge}` }} className="w-full text-left rounded-md px-2.5 py-2.5 flex items-center gap-2.5" data-roster-row="empty" data-slot={slot}>
        {pos}
        <div className="min-w-0 flex-1">
          <div style={{ color: C.textMuted }} className="text-sm">{emptyLabel}</div>
          {sub}
          {notes.map((n, i) => <div key={i} style={{ color: n.color }} className="text-xs mt-0.5" {...(n.attr || {})}>{n.text}</div>)}
        </div>
        {onTapEmpty && <span style={{ color: C.brand }} className="text-[11px] shrink-0">Waivers ›</span>}
      </Tag>
    );
  }
  const m = p.matchup;
  const when = m?.state === "in" || m?.state === "post" ? null : m?.kickoffLabel || p.kickoffLabel;
  return (
    <div style={{ background: bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${edge}` }} className="rounded-md px-2.5 py-2.5 flex items-start gap-2" data-roster-row={p.id} data-slot={slot}>
      <div className="flex flex-col items-center gap-1.5 shrink-0">
        {pos}
        <PlayerLink player={p} className="rounded-full">
          <Headshot player={p} size={40} />
        </PlayerLink>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <PlayerLink player={p} className="min-w-0 truncate">
            <span style={{ color: C.text }} className="text-sm font-semibold">{p.name}</span>
          </PlayerLink>
          <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">
            <span style={{ color: POS_COLOR[p.pos] || C.textMuted }} className="font-semibold">{p.pos}</span>
            {p.team ? ` · ${p.team}` : ""}
            {p.bye ? ` · Bye ${p.bye}` : ""}
          </span>
        </div>
        {p.status && p.status !== "Healthy" && (
          <span style={{ color: p.status === "Questionable" ? C.minor : C.major, border: `1px solid ${p.status === "Questionable" ? C.minor : C.major}55` }} className="inline-block text-[10px] rounded px-1.5 py-0.5 mt-0.5" data-status>
            {p.status}{p.injuryDetail ? ` · ${p.injuryDetail}` : ""}
          </span>
        )}
        {(m || p.weather) && (
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <MatchupChip player={p} profile={profile} />
            {when && <span style={{ color: C.textFaint }} className="text-[10px]">{when}</span>}
            <WeatherChip player={p} />
          </div>
        )}
        <GameLines m={m} />
        {p.props && <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5 leading-snug" data-props>Props: {propText(p.props)}</div>}
        <StatLine player={p} />
        {p.actualStats && <div style={{ color: C.text }} className="text-[10px] mt-0.5 leading-snug" data-actual-stats>Actual: {formatStatLine(p.actualStats)}</div>}
        {(p.usage || p.trending) && (
          <div className="flex items-center gap-1.5 mt-1">
            <UsageBadge usage={p.usage} />
            {p.trending && <span style={{ color: C.brand }} className="text-[10px]">Trending add</span>}
          </div>
        )}
        {sub}
        {notes.map((n, i) => <div key={i} style={{ color: n.color }} className="text-xs mt-0.5" {...(n.attr || {})}>{n.text}</div>)}
      </div>
      <PointsCol p={p} />
    </div>
  );
}

// The notes the old Roster rows carried: rule reasons, injury notes, injury-opportunity notes.
function rowNotes(league) {
  const ioEvents = league.injuryOpportunities?.events || [];
  const playNotes = new Map();
  const replNotes = new Map();
  const lockedNow = lockedNames(league); // v3.4: no move can help a locked player, so no note for him
  for (const e of ioEvents) {
    for (const b of e.backups || []) if (b.owner === "mine" && !lockedNow.has(b.name)) playNotes.set(b.name, `Opportunity: ${e.injured.name} (${e.injured.slot}, ${e.injured.status}) is hurt and ${b.name} moves up.`);
    if (e.mine && !lockedNow.has(e.injured.name)) replNotes.set(e.injured.name, `Replacements: ${(e.backups || []).map(backupLine).join("; ") || "none on the depth chart"}${e.opposite ? `; also ${backupLine({ ...e.opposite, rank: null })}` : ""}`);
  }
  return (row, name) => {
    const out = [];
    const sev = STATUS[row?.severity] || STATUS.ok;
    if (row?.reason) out.push({ text: row.reason, color: sev.color });
    else if (row?.note) out.push({ text: row.note, color: C.textMuted });
    if (name && playNotes.get(name)) out.push({ text: playNotes.get(name), color: C.minor, attr: { "data-play-note": true } });
    if (name && replNotes.get(name)) out.push({ text: replNotes.get(name), color: C.minor, attr: { "data-repl-note": true } });
    return out;
  };
}

// v4.3: where the start/sit research stands for this roster, and a button to run it again.
function StartSitStatus({ league, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const st = league.startSit;
  if (!st || st.state === "off") return null;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.researchStartSit(league.id);
      onRefresh?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ color: C.textFaint }} className="text-[11px] px-1 pt-1 flex items-center gap-2 flex-wrap" data-start-sit-status>
      <span className="inline-flex items-center gap-1"><StartSitIcon verdict="start" size={13} /><StartSitIcon verdict="mixed" size={13} /><StartSitIcon verdict="sit" size={13} /></span>
      <span>{st.state === "ready" ? `Start/sit articles read ${st.at ? fmtWhen(st.at) : ""} · tap an icon for the summary` : "Reading this week's start/sit articles — refresh in a minute."}</span>
      <button type="button" onClick={run} disabled={busy} style={{ color: C.brand }} className="underline" data-start-sit-refresh>{busy ? "Reading…" : "Read again"}</button>
      {err && <span style={{ color: C.major }}>{err}</span>}
    </div>
  );
}

function CurrentLineup({ league, changes = [], onOpenWaivers = null, onRefresh = null }) {
  const baseNotes = rowNotes(league);
  // v4.5: every player a suggested change touches gets a note on his card
  const moveNotes = useMemo(() => changeNotes(league, changes), [league, changes]);
  const notesFor = (row, name, id) => [...baseNotes(row, name), ...((id != null && moveNotes.get(String(id))) || []).map((t) => ({ text: t, color: C.minor, attr: { "data-change-note": true } }))];
  const starterRows = league.roster.rows.filter((r) => r.slot !== "BN");
  const benchRows = league.roster.rows.filter((r) => r.slot === "BN");
  const bench = league.bench || [];
  return (
    <div data-current-lineup>
      <StartSitStatus league={league} onRefresh={onRefresh} />
      <SectionLabel>Starters</SectionLabel>
      <div className="space-y-1.5">
        {(league.starters || []).map((s, i) => (
          <RosterPlayerRow key={i} slot={s.slot} player={s.player} profile={league.scoringProfile} severity={starterRows[i]?.severity} notes={notesFor(starterRows[i], s.player?.name, s.player?.id)} />
        ))}
      </div>
      <SectionLabel>Bench</SectionLabel>
      <div className="space-y-1.5">
        {benchRows.map((r, i) => (
          <RosterPlayerRow key={i} slot="BN" player={bench[i] || null} profile={league.scoringProfile} severity={r.severity} notes={notesFor(r, bench[i]?.name, bench[i]?.id)} emptyLabel="Open bench slot" onTapEmpty={!bench[i] && onOpenWaivers ? onOpenWaivers : null} />
        ))}
      </div>
      {(league.ir || []).length > 0 && (
        <>
          <SectionLabel>IR</SectionLabel>
          <div className="space-y-1.5">
            {league.ir.map((p, i) => (
              <RosterPlayerRow key={i} slot="IR" player={p} profile={league.scoringProfile} severity={league.roster.irRows[i]?.severity} notes={notesFor(league.roster.irRows[i], p?.name, p?.id)} />
            ))}
          </div>
        </>
      )}
      {(league.taxi || []).length > 0 && (
        <>
          <SectionLabel>Taxi Squad</SectionLabel>
          <div className="space-y-1.5">
            {league.taxi.map((p, i) => <RosterPlayerRow key={i} slot="TAXI" player={p} profile={league.scoringProfile} />)}
          </div>
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

function RankingCard({ entry, rank, startsAt, yellowNote, draggable, dragging, onHandleDown, onHandleKey, cardRef, profile }) {
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
      <PlayerLink player={p} className="shrink-0 rounded-full">
        <Headshot player={p} size={36} />
      </PlayerLink>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <PlayerLink player={p} className="min-w-0 truncate">
            <span style={{ color: C.text }} className="text-sm font-medium">{p.name}</span>
          </PlayerLink>
          <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{p.pos}{p.team ? ` · ${p.team}` : ""}{p.bye ? ` · Bye ${p.bye}` : ""}</span>
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
          {hasStarted(p) && (
            <span style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[10px] rounded px-1.5 py-0.5">
              {p.played ? "Played" : "Game started"} — locked
            </span>
          )}
          <UsageBadge usage={p.usage} />
        </div>
        {(p.matchup || p.weather) && (
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <MatchupChip player={p} profile={profile} />
            {p.matchup?.kickoffLabel && <span style={{ color: C.textFaint }} className="text-[10px]">{p.matchup.kickoffLabel}</span>}
            <WeatherChip player={p} />
          </div>
        )}
        {p.weather?.flag && !hasStarted(p) && <div style={{ color: C.minor }} className="text-[11px] mt-1">Weather: {p.weather.reasons.join("; ")}</div>}
        <StatLine player={p} />
        {zero && <div style={{ color: C.major }} className="text-xs mt-1">Projected for 0 points</div>}
        {yellowNote && <div style={{ color: C.minor }} className="text-xs mt-1">{yellowNote}</div>}
        {needsMove && <div style={{ color: C.textMuted }} className="text-xs mt-1">On your {GROUP_LABEL[entry.group]} — needs a roster move before they can start.</div>}
      </div>
      <div className="text-right shrink-0">
        <div style={{ color: zero ? C.major : C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-base font-semibold">
          {p.proj != null ? p.proj.toFixed(1) : "—"}
        </div>
        <div style={{ color: p.projSource === "actual" ? C.brand : SRC_COLOR[p.projSource] || C.textFaint }} className="text-[10px]">{p.projSource === "actual" ? "FINAL" : SOURCE_TAG[p.projSource] || p.projSource || "no proj"}{p.projFactor ? ` ×${p.projFactor}` : ""}</div>
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
        Drag the handle to rank your players. <InfoNote label="About rankings">Higher-ranked players get first claim on the slots they fit, and your order replaces the suggested lineup. Keyboard: focus the handle and use the arrow keys. Saved per league.</InfoNote>
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
      {eff.weatherStarters?.length > 0 && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 mb-2 space-y-0.5">
          {eff.weatherStarters.map((p) => (
            <div key={p.id || p.name}>
              Weather: {p.name} ({p.team}) — {p.weather.reasons.join("; ")}
            </div>
          ))}
        </div>
      )}
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
            profile={league.scoringProfile}
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
        Not on your roster, so not ranked — shown to compare against your lineup.
      </div>
      {eff.freeAgents.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No notable free agents right now.</div>
      ) : (
        <div className="space-y-1.5">
          {eff.freeAgents.map((entry) => (
            <RankingCard key={entry.key} entry={entry} rank={null} startsAt={null} yellowNote={eff.yellow.get(entry.key)} profile={league.scoringProfile} />
          ))}
        </div>
      )}
    </div>
  );
}

function LineupTab({ league, onSaveRanking, hideWeather = false }) {
  const [showRankings, setShowRankings] = useState(false);
  if (showRankings) {
    return <PlayerRankings league={league} onSaveRanking={onSaveRanking} onBack={() => setShowRankings(false)} />;
  }

  const L = league.lineup;
  const { currentTotal, optimalTotal, delta, custom } = L;
  // v2.8: full player objects by name, for headshots / matchup / weather on the rows.
  const byName = new Map();
  [...(league.starters || []).map((s) => s.player), ...(league.bench || []), ...(league.ir || []), ...(league.taxi || []), ...(league.freeAgents || [])].forEach((p) => p && !byName.has(p.name) && byName.set(p.name, p));
  const rows = L.rows || [];
  const suggestedLabel = custom ? "Your ranking" : "Optimal";
  const better = custom && L.betterDelta > 0.05 && !L.betterCleared;
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
      {!hideWeather && L.weatherStarters?.length > 0 && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 mb-2 space-y-0.5">
          {L.weatherStarters.map((p) => (
            <div key={p.id || p.name}>
              Weather: {p.name} ({p.team}) — {p.weather.reasons.join("; ")}
            </div>
          ))}
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
                  <PlayerLink player={c.current ? byName.get(c.current.name) || c.current : null} className="flex items-center gap-1.5 min-w-0 max-w-full">
                    {c.current && <Headshot player={byName.get(c.current.name) || c.current} size={22} />}
                    <div style={{ color: curZero || c.changed ? C.major : C.text }} className="text-sm font-medium truncate">{c.current?.name ?? "(empty)"}</div>
                  </PlayerLink>
                  <div style={{ color: curZero ? C.major : C.textMuted }} className="text-xs mt-0.5">
                    {c.current?.proj != null ? c.current.proj.toFixed(1) : "—"}{curZero ? " · projected 0" : ""}
                  </div>
                  <RowChips player={byName.get(c.current?.name)} profile={league.scoringProfile} />
                  <SourceTag source={c.current?.projSource} factor={c.current?.projFactor} />
                </div>
                <div style={{ background: optZero ? C.majorBg : c.changed ? C.okBg : "transparent" }} className="relative px-3 py-2.5 pb-4">
                  <PlayerLink player={c.optimal ? byName.get(c.optimal.name) || c.optimal : null} className="flex items-center gap-1.5 min-w-0 max-w-full">
                    {c.optimal && <Headshot player={byName.get(c.optimal.name) || c.optimal} size={22} />}
                    <div style={{ color: optZero ? C.major : c.changed ? C.ok : C.text }} className="text-sm font-medium truncate">{c.optimal?.name ?? "(none available)"}</div>
                  </PlayerLink>
                  <div style={{ color: optZero ? C.major : C.textMuted }} className="text-xs mt-0.5">
                    {c.optimal?.proj != null ? c.optimal.proj.toFixed(1) : "—"}{optZero ? " · projected 0" : ""}
                  </div>
                  {c.optimal?.note && <div style={{ color: C.brand }} className="text-[10px] mt-0.5">{c.optimal.note}</div>}
                  {c.changed && <RowChips player={byName.get(c.optimal?.name)} profile={league.scoringProfile} />}
                  <SourceTag source={c.optimal?.projSource} factor={c.optimal?.projFactor} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.0 — merged Roster page: roster, then Proposed changes / Update   */
/* ------------------------------------------------------------------ */
export function RosterPage({ league, onSaveRanking, onRefresh, onOpenAccount, onOpenTab = null }) {
  const [sub, setSub] = useState("current");
  const suggested = useMemo(() => proposeChanges(league), [league]);
  // v4.4: hand-made changes from the Proposed lineup (tap a position box), applied after the ticked suggestions
  const [customs, setCustoms] = useState([]);
  useEffect(() => setCustoms([]), [league]);
  // v4.4.1: the drop / bid chosen in the pop-up for each ticked free agent / waiver add
  const [plans, setPlans] = useState({});
  const [planFor, setPlanFor] = useState(null);
  useEffect(() => setPlans({}), [league]);
  const suggestedP = useMemo(() => suggested.map((c) => (c.type === "add" ? { ...c, plan: plans[c.key] } : c)), [suggested, plans]);
  const changes = useMemo(() => [...suggestedP, ...customs], [suggestedP, customs]);
  const [checked, setChecked] = useState(() => new Set());
  useEffect(() => {
    setChecked((prev) => {
      const valid = new Set(changes.filter((c) => !c.blocked).map((c) => c.key));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [changes]);
  // Changing the ticked suggestions would change what the custom changes were made against, so they are undone.
  const onToggle = (key, on) => (setCustoms((c) => (c.length ? [] : c)), !on && setPlans(({ [key]: _gone, ...rest }) => rest), setChecked((prev) => toggleChange(suggested, new Set([...prev].filter((k) => suggested.some((c) => c.key === k))), key, on)));
  // A ticked add with no plan yet (ticked directly, by a cascade or by Accept all) opens its pop-up, one at a time.
  useEffect(() => {
    if (planFor) return;
    const m = suggested.find((c) => c.type === "add" && checked.has(c.key) && !plans[c.key]);
    if (m) setPlanFor(m);
  }, [checked, plans, planFor, suggested]);
  const acceptAll = () => (setCustoms([]), setChecked(new Set(suggested.filter((c) => !c.blocked).map((c) => c.key))));
  const addCustom = (c) => {
    setCustoms((prev) => [...prev.filter((x) => x.key !== c.key), c]);
    setChecked((prev) => new Set([...prev, c.key]));
  };
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-roster-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2.5 text-sm font-medium">
      {label}
    </button>
  );
  return (
    <div className="px-4 pb-4">
      {league.lineup?.weatherStarters?.length > 0 && (
        <div className="pt-3" data-roster-weather>
          <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 space-y-0.5">
            {league.lineup.weatherStarters.map((p) => (
              <div key={p.id || p.name}>Weather: {p.name} ({p.team}) — {p.weather.reasons.join("; ")}</div>
            ))}
          </div>
        </div>
      )}
      <div className="flex mt-2 sticky z-10" style={{ top: "var(--topbar-h, 0px)", background: C.bg, borderBottom: `1px solid ${C.border}` }}>
        {tab("current", "Current lineup")}
        {tab("proposed", `Proposed lineup${checked.size ? ` (${checked.size})` : ""}`)}
      </div>
      {planFor && (
        <AddPlanModal
          league={league}
          change={planFor}
          plans={plans}
          onSave={(plan) => (setPlans((p) => ({ ...p, [planFor.key]: plan })), setPlanFor(null))}
          onCancel={() => (onToggle(planFor.key, false), setPlanFor(null))}
        />
      )}
      {sub === "current" ? (
        <>
          <PendingMoves league={league} onRefresh={onRefresh} />
          <CurrentLineup league={league} changes={suggested} onRefresh={onRefresh} onOpenWaivers={onOpenTab ? () => onOpenTab(league.id, "waiver") : null} />
          <SuggestedChanges league={league} changes={suggested} checked={checked} onToggle={onToggle} onAcceptAll={acceptAll} onSaveRanking={onSaveRanking} onGoProposed={() => setSub("proposed")} />
        </>
      ) : (
        <ProposedLineup league={league} changes={changes} checked={checked} customs={customs} onAddCustom={addCustom} onUndoCustoms={() => (setChecked((prev) => new Set([...prev].filter((k) => !customs.some((c) => c.key === k)))), setCustoms([]))} onRefresh={onRefresh} onOpenAccount={onOpenAccount} onDone={() => (setChecked(new Set()), setCustoms([]))} onGoCurrent={() => setSub("current")} />
      )}
    </div>
  );
}

function changeText(c) {
  if (c.type === "lineup") return { title: <><PosBox label={c.slot} small /> <span className="ml-1">{c.fromName ?? "(empty)"} → <b>{c.toName}</b></span></>, sub: [c.delta > 0 ? `+${c.delta.toFixed(1)} projected points` : null, c.altNote || null].filter(Boolean).join(" · ") || null };
  if (c.type === "add") return { title: <><PosBox label={c.slot} small /> <span className="ml-1">{c.fromName ?? "(empty)"} → <b>{c.toName}</b></span> <span style={{ color: C.minor, border: `1px solid ${C.minor}66` }} className="ml-2 rounded px-1.5 text-[10px]">add from FA / waivers</span></>, sub: [c.delta > 0 ? `+${c.delta.toFixed(1)} projected points` : null, "Ticking asks who to drop (and the bid on waivers); he is added, then started once he is on your roster."].filter(Boolean).join(" · ") };
  if (c.type === "swap")
    return {
      title: <><PosBox label={c.slot} small /> <span className="mx-1">↔</span> <PosBox label={c.slotB_label} small /> <span className="ml-1"><b>{c.nameB}</b> to {c.slot}, {c.nameA} to {c.slotB_label}</span></>,
      sub: `Timing: ${c.nameA} plays ${c.kickA || "earlier"}, ${c.nameB} ${c.kickB || "later"} — the flex keeps the later game, so you can still change it if someone is ruled out.`,
    };
  return { title: <span>Move <b>{c.name}</b> to injured reserve</span>, sub: null };
}

function SuggestedChanges({ league, changes, checked, onToggle, onAcceptAll, onSaveRanking, onGoProposed }) {
  const [details, setDetails] = useState(false);
  const usable = changes.filter((c) => !c.blocked);
  return (
    <div className="mt-4" data-proposed-changes>
      <SectionLabel>Suggested changes{usable.length ? ` — ${usable.length}` : ""}</SectionLabel>
      {changes.length === 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-sm">
          No changes suggested — your lineup already matches the best projection.
        </div>
      ) : (
        <div className="space-y-1.5">
          {changes.map((c) => {
            const t = changeText(c);
            return (
              <label key={c.key} style={{ background: checked.has(c.key) ? C.okBg : C.surface, border: `1px solid ${checked.has(c.key) ? `${C.ok}66` : C.border}`, opacity: c.blocked ? 0.7 : 1 }} className="rounded-md px-3 py-2.5 flex items-start gap-3" data-change={c.key} data-change-type={c.type}>
                <input type="checkbox" disabled={Boolean(c.blocked)} checked={checked.has(c.key)} onChange={(e) => onToggle(c.key, e.target.checked)} className="mt-1" aria-label={c.type === "lineup" || c.type === "add" ? `Start ${c.toName} at ${c.slot}` : c.type === "swap" ? `Swap ${c.nameA} and ${c.nameB}` : `Move ${c.name} to IR`} />
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm flex items-center flex-wrap gap-y-1">{t.title}</div>
                  {t.sub && <div style={{ color: c.type === "lineup" || c.type === "add" ? C.ok : C.textMuted }} className="text-xs mt-0.5">{t.sub}</div>}
                  {c.blocked && <div style={{ color: C.minor }} className="text-xs mt-0.5">{c.blocked}</div>}
                </div>
              </label>
            );
          })}
        </div>
      )}
      {usable.length > 0 && (
        <div className="flex items-center justify-between gap-2 pt-2">
          <span style={{ color: C.textMuted }} className="text-xs">{checked.size} of {usable.length} accepted</span>
          <div className="flex gap-2">
            <button type="button" onClick={onAcceptAll} disabled={checked.size === usable.length} style={{ color: C.ok, border: `1px solid ${C.ok}88`, opacity: checked.size === usable.length ? 0.5 : 1 }} className="rounded-md px-3 py-1.5 text-sm" data-accept-all>
              Accept all
            </button>
            <button type="button" onClick={onGoProposed} disabled={checked.size === 0} style={{ background: C.brand, color: C.text, opacity: checked.size ? 1 : 0.5 }} className="rounded-md px-3 py-1.5 text-sm" data-go-update>
              Proposed lineup →
            </button>
          </div>
        </div>
      )}
      <button type="button" onClick={() => setDetails((v) => !v)} style={{ color: C.brand }} className="text-xs underline mt-3" data-lineup-details-toggle>
        {details ? "Hide" : "Show"} Player Rankings and the per-slot view
      </button>
      {details && <div className="-mx-4"><LineupTab league={league} onSaveRanking={onSaveRanking} hideWeather /></div>}
    </div>
  );
}

function ProposedLineup({ league, changes, checked, customs = [], onAddCustom, onUndoCustoms, onRefresh, onOpenAccount, onDone, onGoCurrent }) {
  const arr = useMemo(() => arrangement(league, changes, checked), [league, changes, checked]);
  // v4.5: players in a suggested change that isn't ticked yet carry its note (ticked ones show "In for …" / "Moved to the bench")
  const moveNotes = useMemo(() => changeNotes(league, changes.filter((c) => !checked.has(c.key) && c.type !== "custom")), [league, changes, checked]);
  const noteFor = (p) => ((p?.id != null && moveNotes.get(String(p.id))) || []).map((t) => ({ text: t, color: C.minor, attr: { "data-change-note": true } }));
  const [picker, setPicker] = useState(null); // v4.4: { kind: "starter", index } | { kind: "bench"|"taxi", id }
  const pushRef = useRef(null);
  // The floating "Review & push" button hides once the push panel itself is on screen.
  const [panelVisible, setPanelVisible] = useState(false);
  useEffect(() => {
    const el = pushRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([e]) => setPanelVisible(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const t = arr.totals;
  return (
    <div data-proposed-lineup>
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-4 py-3 mt-3 flex items-center justify-around text-center" data-proposed-totals>
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-0.5">Current</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{t.current.toFixed(1)}</div>
        </div>
        <div style={{ color: t.delta > 0 ? C.ok : t.delta < 0 ? C.major : C.textMuted }} className="text-sm font-medium">{t.delta > 0 ? "+" : ""}{t.delta.toFixed(1)} pts</div>
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-0.5">Proposed</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-2xl font-semibold">{t.proposed.toFixed(1)}</div>
        </div>
      </div>
      {arr.count === 0 && (
        <div style={{ color: C.textMuted }} className="text-xs px-1 pt-2" data-proposed-empty>
          No changes accepted yet — this is your current lineup. Tick suggestions (or Accept all) at the bottom of{" "}
          <button type="button" onClick={onGoCurrent} style={{ color: C.brand }} className="underline">Current lineup</button>.
        </div>
      )}
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pt-2 flex items-center justify-between gap-2" data-swap-hint>
        <span>Tap a position box to swap that player with anyone who fits.</span>
        {customs.length > 0 && <button type="button" onClick={onUndoCustoms} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2 py-0.5 shrink-0" data-undo-customs>Undo custom ({customs.length})</button>}
      </div>
      <SectionLabel>Starters</SectionLabel>
      <div className="space-y-1.5">
        {arr.starters.map((s, i) => (
          <RosterPlayerRow
            key={i}
            slot={s.slot}
            onSlotTap={s.adding ? null : () => setPicker({ kind: "starter", index: i })}
            player={s.player}
            profile={league.scoringProfile}
            notes={s.changed ? [] : noteFor(s.player)}
            highlight={s.changed ? "in" : null}
            sub={
              !s.changed ? null : s.adding ? (
                <div style={{ color: C.minor }} className="text-xs mt-0.5" data-was data-adding>Added from FA / waivers, in for {s.was?.name || "(empty)"}{s.was?.proj != null && s.player?.proj != null ? ` (${s.player.proj - s.was.proj >= 0 ? "+" : ""}${(s.player.proj - s.was.proj).toFixed(1)} pts)` : ""} — started once he is on your roster</div>
              ) : s.swapFrom ? (
                <div style={{ color: C.ok }} className="text-xs mt-0.5" data-was>Moved from {s.swapFrom} — {s.custom ? "custom swap" : "timing swap"} with {s.was?.name || "(empty)"}</div>
              ) : (
                <div style={{ color: C.ok }} className="text-xs mt-0.5" data-was>In for {s.was?.name || "(empty)"}{s.was?.proj != null && s.player?.proj != null ? ` (${s.player.proj - s.was.proj >= 0 ? "+" : ""}${(s.player.proj - s.was.proj).toFixed(1)} pts)` : ""}</div>
              )
            }
          />
        ))}
      </div>
      <SectionLabel>Bench</SectionLabel>
      <div className="space-y-1.5">
        {arr.bench.map((b, i) => (
          <RosterPlayerRow key={i} slot="BN" player={b.player} profile={league.scoringProfile} notes={b.change ? [] : noteFor(b.player)} onSlotTap={b.player?.id != null ? () => setPicker({ kind: "bench", id: b.player.id }) : null} highlight={b.change === "benched" || b.change === "from taxi" ? "out" : null} sub={b.change === "benched" ? <div style={{ color: C.minor }} className="text-xs mt-0.5">Moved to the bench</div> : b.change === "from taxi" ? <div style={{ color: C.minor }} className="text-xs mt-0.5">Moved from the taxi squad to the bench</div> : null} />
        ))}
      </div>
      {arr.ir.length > 0 && (
        <>
          <SectionLabel>IR</SectionLabel>
          <div className="space-y-1.5">
            {arr.ir.map((b, i) => (
              <RosterPlayerRow key={i} slot="IR" player={b.player} profile={league.scoringProfile} notes={b.change ? [] : noteFor(b.player)} highlight={b.change ? "ir" : null} sub={b.change ? <div style={{ color: C.major }} className="text-xs mt-0.5">Moved to injured reserve</div> : null} />
            ))}
          </div>
        </>
      )}
      {arr.taxi.length > 0 && (
        <>
          <SectionLabel>Taxi Squad</SectionLabel>
          <div className="space-y-1.5">{arr.taxi.map((b, i) => <RosterPlayerRow key={i} slot="TAXI" player={b.player} profile={league.scoringProfile} onSlotTap={b.player?.id != null ? () => setPicker({ kind: "taxi", id: b.player.id }) : null} />)}</div>
        </>
      )}
      {picker && <SwapPicker league={league} arr={arr} target={picker} onClose={() => setPicker(null)} onPick={(opt) => { const c = customChange(arr, picker, opt); if (c) onAddCustom(c); setPicker(null); }} />}
      <div ref={pushRef} className="mt-4">
        <PushPanel league={league} changes={changes} checked={checked} onRefresh={onRefresh} onOpenAccount={onOpenAccount} onDone={onDone} />
      </div>
      {arr.count > 0 && !panelVisible && (
        <div className="sticky bottom-0 pt-2 pb-3 -mx-4 px-4" style={{ background: `linear-gradient(to top, ${C.bg} 70%, transparent)` }}>
          <button type="button" onClick={() => pushRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} style={{ background: C.brand, color: C.text }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium shadow-lg" data-push-jump>
            Review &amp; push to Sleeper ({arr.count})
          </button>
        </div>
      )}
    </div>
  );
}

/** v4.4: the swap list for one position box — everyone who can trade places with that player, best projection first. */
function SwapPicker({ league, arr, target, onClose, onPick }) {
  const info = useMemo(() => swapOptions(league, arr, target), [league, arr, target]);
  const group = (o) => (o.group === "starter" ? `Starting${o.otherSlot != null ? ` · ${arr.starters[o.otherSlot].slot}` : o.slotLabel ? ` · ${o.slotLabel}` : ""}` : GROUP_LABEL[o.group] || o.group);
  return (
    <Modal title={target.kind === "taxi" ? `Taxi squad — ${info.title}` : target.kind === "bench" ? `Start ${info.title} instead of…` : `Swap — ${info.title}`} onClose={onClose}>
      <div className="space-y-1.5 text-sm" data-swap-picker={target.kind}>
        {info.locked && <div style={{ color: C.minor }} data-swap-locked>His game has started, so he can't be moved.</div>}
        {!info.locked && info.options.length === 0 && <div style={{ color: C.textMuted }}>Nobody on your roster fits here.</div>}
        {target.kind === "taxi" && <div style={{ color: C.textMuted }} className="text-xs">Taxi players can only be moved to the bench.</div>}
        {info.options.map((o, i) => (
          <button key={`${o.player.id ?? "e"}-${i}`} type="button" disabled={!o.enabled} onClick={() => onPick(o)} style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: o.enabled ? 1 : 0.55 }} className="w-full text-left rounded-md px-3 py-2 flex items-center gap-2" data-swap-option={o.player.id ?? "empty"} data-enabled={o.enabled ? "1" : "0"}>
            <span className="min-w-0 flex-1">
              <span style={{ color: C.text }} className="font-medium">{o.toBench ? `Move ${o.player.name} to the bench` : o.player.name}</span>{" "}
              <span style={{ color: POS_COLOR[o.player.pos] || C.textMuted }} className="text-[11px] font-semibold">{o.player.pos}</span>{" "}
              <span style={{ color: C.textFaint }} className="text-[11px]">{o.player.team || ""}{o.toBench ? "" : ` · ${group(o)}`}</span>
              {!o.enabled && o.reason && <span style={{ color: C.minor }} className="block text-[11px]">{o.reason}</span>}
            </span>
            <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm shrink-0">{o.player.proj != null ? `${Number(o.player.proj).toFixed(1)}` : "—"}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function PushPanel({ league, changes, checked, onRefresh, onOpenAccount, onDone }) {
  const push = useMemo(() => buildPush(league, changes, checked), [league, changes, checked]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  // v4.5: the confirmation belongs to the league it was pushed for — switching league clears it (and a push that
  // finishes after switching never shows its result on the other league).
  const leagueRef = useRef(league.id);
  useEffect(() => { leagueRef.current = league.id; setResults(null); setConfirming(false); setBusy(false); }, [league.id]);
  const send = async () => {
    const pushedFor = league.id;
    setBusy(true);
    const out = [];
    try {
      if (push.starters) {
        try {
          const r = await api.pushLineup(league.id, push.starters, { gap: lineupGap(league), keys: pushKeys(league, "lineup") });
          out.push({ label: "Starting lineup", ok: r.ok, verified: r.verified, detail: r.detail });
        } catch (e) {
          out.push({ label: "Starting lineup", ok: false, detail: e.message });
        }
      }
      for (const a of push.adds || []) {
        try {
          const r = await api.pushAddMove(league.id, a);
          out.push({ label: `Add ${a.addName}`, ok: r.ok, verified: r.claim?.verified, detail: r.detail });
        } catch (e) {
          out.push({ label: `Add ${a.addName}`, ok: false, detail: e.message });
        }
      }
      if (push.taxi) {
        try {
          const r = await api.pushTaxi(league.id, push.taxi);
          out.push({ label: "Taxi squad", ok: r.ok, verified: r.verified, detail: r.detail });
        } catch (e) {
          out.push({ label: "Taxi squad", ok: false, detail: e.message });
        }
      }
      if (push.reserve) {
        try {
          const r = await api.pushReserve(league.id, push.reserve);
          out.push({ label: "Injured reserve", ok: r.ok, verified: r.verified, detail: r.detail });
        } catch (e) {
          out.push({ label: "Injured reserve", ok: false, detail: e.message });
        }
      }
    } finally {
      const same = leagueRef.current === pushedFor;
      if (same) {
        setResults(out);
        setBusy(false);
        setConfirming(false);
      }
      if (out.some((o) => o.ok)) {
        if (same) onDone();
        onRefresh?.(pushedFor); // v4.5: re-read THAT league now, so Current and Proposed lineup show what Sleeper holds
      }
    }
  };
  return (
    <div data-update-roster>
      <PrivateGate league={league} group="roster" onOpenAccount={onOpenAccount}>
        <PrivateGate league={league} group={push.adds.length ? "claims" : null} onOpenAccount={onOpenAccount}>
        {checked.size === 0 && !results ? null : (
          <div className="space-y-2">
            {checked.size > 0 && (
              <>
                <div style={{ color: C.textMuted }} className="text-xs px-1">Accepted changes</div>
                <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-approved-summary>
                  {push.summary.map((l, i) => (
                    <div key={i} style={{ color: C.text, borderColor: C.border }} className="px-3 py-2 text-sm">{l}</div>
                  ))}
                </div>
                {push.errors.map((e, i) => <div key={i} style={{ color: C.major }} className="text-xs px-1">{e}</div>)}
                {!confirming && (
                  <button type="button" disabled={push.errors.length > 0} onClick={() => setConfirming(true)} style={{ background: C.brand, color: C.text, opacity: push.errors.length ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium" data-push-sleeper>
                    Push to Sleeper
                  </button>
                )}
                {confirming && (
                  <ConfirmPush title="Send these changes to Sleeper?" lines={push.summary} buttonLabel="Yes, update my roster" busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note="Sleeper is then asked for the roster back to check it. The lineup is written to both your roster and this week's matchup. Moving a player to IR or off the taxi squad is an untested Sleeper call — it is reported honestly if it doesn't take." />
                )}
              </>
            )}
            <PushResults results={results} />
          </div>
        )}
        </PrivateGate>
      </PrivateGate>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v4.4.1 — add a free agent / waiver player, then the lineup move     */
/* ------------------------------------------------------------------ */
function AddPlanModal({ league, change, plans, onSave, onCancel }) {
  const isFaab = Boolean(league.waiverInfo?.faab);
  const remaining = Number(league.waiverInfo?.remaining) || 0;
  const open = openSpotsForAdd(league, plans, change.key);
  const mustDrop = open != null && open <= 0;
  const options = useMemo(() => dropOptions(league, change, plans, change.key), [league, change, plans]);
  const [kind, setKind] = useState("fa");
  const [bid, setBid] = useState("0");
  const [dropId, setDropId] = useState("");
  const bidN = Math.max(0, Math.min(Math.round(Number(bid) || 0), remaining));
  const drop = options.find((o) => o.id === dropId) || null;
  const ready = !mustDrop || Boolean(drop);
  const seg = (k, label, sub) => (
    <button type="button" onClick={() => setKind(k)} aria-pressed={kind === k} data-add-kind={k} style={{ border: `1px solid ${kind === k ? C.brand : C.border}`, background: kind === k ? C.surfaceRaised : "transparent", color: C.text }} className="flex-1 rounded-md px-2.5 py-2 text-left">
      <div className="text-sm">{label}</div>
      <div style={{ color: C.textMuted }} className="text-[11px] leading-snug">{sub}</div>
    </button>
  );
  return (
    <Modal title={`Add ${change.toName}`} onClose={onCancel}>
      <div className="space-y-3 text-sm" data-add-plan>
        <div style={{ color: C.textMuted }} className="text-xs leading-snug">
          {change.toName} would start at {change.slot} in place of {change.fromName ?? "(empty)"}. He is added first; the lineup move is made once he is on your roster.
        </div>
        <div className="flex gap-2">
          {seg("fa", "Free agent", "Add now. The lineup move follows right away.")}
          {seg("waiver", "On waivers", isFaab ? "Claim with a bid. The lineup move follows after waivers process." : "Claim. The lineup move follows after waivers process.")}
        </div>
        {kind === "waiver" && isFaab && (
          <label className="block text-xs" style={{ color: C.textMuted }}>
            FAAB bid (you have ${remaining})
            <input type="number" min="0" max={remaining} value={bid} onChange={(e) => setBid(e.target.value)} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="block w-28 rounded px-2 py-1 mt-1 text-sm" data-add-bid />
          </label>
        )}
        {kind === "waiver" && !isFaab && <div style={{ color: C.textMuted }} className="text-xs">This league uses waiver priority — there is no bid.</div>}
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">{mustDrop ? "Your roster is full — who should be dropped?" : "Drop someone to make room? (optional)"}</div>
          <div className="max-h-56 overflow-y-auto space-y-1" role="listbox" aria-label="Player to drop">
            {!mustDrop && (
              <button type="button" onClick={() => setDropId("")} aria-pressed={dropId === ""} data-drop-none style={{ border: `1px solid ${dropId === "" ? C.brand : C.border}`, color: C.text }} className="w-full text-left rounded px-2.5 py-1.5 text-xs">Don't drop anyone</button>
            )}
            {options.length === 0 && <div style={{ color: C.major }} className="text-xs">No one can be dropped right now (everyone is locked).</div>}
            {options.map((o) => (
              <button key={o.id} type="button" onClick={() => setDropId(o.id)} aria-pressed={dropId === o.id} data-drop-option={o.id} style={{ border: `1px solid ${dropId === o.id ? C.brand : C.border}`, color: C.text }} className="w-full text-left rounded px-2.5 py-1.5 text-xs flex items-center justify-between gap-2">
                <span className="truncate">{o.name} <span style={{ color: C.textMuted }}>{o.pos} {o.team}</span></span>
                <span style={{ color: C.textMuted }} className="shrink-0">{o.where}{o.proj != null ? ` · ${Number(o.proj).toFixed(1)}` : ""}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-sm" data-add-cancel>Cancel</button>
          <button type="button" disabled={!ready} onClick={() => onSave({ kind, bid: kind === "waiver" && isFaab ? bidN : 0, isFaab, dropId: drop?.id || null, dropName: drop?.name || null })} style={{ background: C.brand, color: C.text, opacity: ready ? 1 : 0.5 }} className="rounded-md px-3 py-1.5 text-sm" data-add-save>Use these settings</button>
        </div>
      </div>
    </Modal>
  );
}

/** Waiting "add, then lineup move" items for this league (cancellable), plus what finished lately. */
function PendingMoves({ league, onRefresh }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api.getPendingMoves(league.id).then(setData).catch(() => {}), [league.id]);
  useEffect(() => { load(); }, [load, league]);
  if (!data || !Array.isArray(data.moves) || (data.moves.length === 0 && !(data.log || []).length)) return null;
  const cancel = async (id) => { await api.cancelPendingMove(id).catch(() => {}); load(); onRefresh?.(); };
  return (
    <div className="mt-3 space-y-1.5" data-pending-moves>
      {data.moves.map((m) => (
        <div key={m.id} style={{ background: C.surface, border: `1px solid ${C.minor}55` }} className="rounded-md px-3 py-2 flex items-start justify-between gap-2" data-pending-move={m.id}>
          <div className="min-w-0 text-xs" style={{ color: C.text }}>
            <b>{m.addName}</b> {m.kind === "waiver" ? `waiver claim${m.bid ? ` · $${m.bid}` : ""}` : "free agent add"}{m.dropName ? `, dropping ${m.dropName}` : ""}.
            <div style={{ color: C.textMuted }}>Waiting — he starts at {m.slot} once he is on your roster.{m.kind === "waiver" && m.checkFrom > Date.now() ? ` Waivers process about ${new Date(m.checkFrom).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.` : ""}</div>
          </div>
          <button type="button" onClick={() => cancel(m.id)} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded px-2 py-0.5 text-[11px] shrink-0" data-pending-cancel>Cancel lineup move</button>
        </div>
      ))}
      {(data.log || []).slice(0, 2).map((e, i) => (
        <div key={i} style={{ color: e.status === "done" ? C.ok : C.minor }} className="text-[11px] px-1">{new Date(e.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · {e.player}: {e.detail}</div>
      ))}
    </div>
  );
}
