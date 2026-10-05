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
  Wind,
  CloudRain,
  CloudSnow,
  Cloud,
  X,
} from "lucide-react";
import * as api from "./api.js";
import { claimKey, generateClaims, effectiveClaims, groupClaims, flatten, simulate, toDollars, fromDollars, setBid, syncDrops, describeClaim, resetClaims } from "./waiverPlan.js";
import { effectiveLineup, isZeroProjection, GROUP_LABEL, hasStarted, isLocked, lockedNames } from "./lineup.js";
import { applyAcks, collectVariances, groupTree, minorKeys, autoClearKeys, PAGE_LABEL, varianceKey, pushKeys, lineupGap, RULE } from "./variances.js";
import { proposeChanges, toggle as toggleChange, buildPush } from "./rosterChanges.js";

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

// v2.8.1: each row lists the rules it breaks (`issues`), so the variance
// report can group by rule; severity/reason are derived from them.
function computeRoster(league) {
  const iss = (rule, severity, text) => ({ rule, severity, text });
  const starterRows = league.starters.map(({ slot, player }) => {
    if (!player) return { slot, label: "(empty)", issues: [iss("Empty starting slot", "major", "Empty starting roster slot")] };
    if (player.status === "Bye") return { slot, label: player.name, issues: [iss("Starter on bye", "major", "On bye — guaranteed zero")] };
    // v3.4: once his game has kicked off he is locked in his slot — no move can fix anything, so no flag.
    if (OUT_LIKE.includes(player.status)) return { slot, label: player.name, issues: isLocked(player, league) ? [] : [iss("Starter out / doubtful / IR", "major", player.note || `${player.status} — hasn't been swapped`)] };
    // v3.1: a Questionable starter stops being flagged once his game has kicked off, and is flagged
    // again after the week's last game if he still carries the status.
    if (player.status === "Questionable") {
      if (hasStarted(player) && !league.weekOver) return { slot, label: player.name, issues: [] };
      return { slot, label: player.name, issues: [iss("Questionable starter", "minor", player.note || "Questionable — game-time decision")] };
    }
    return { slot, label: player.name, issues: [] };
  });

  league.starters.forEach(({ slot, player: flexPlayer }, idx) => {
    if (!FLEX_ELIGIBLE[slot] || !flexPlayer || flexPlayer.kickoff == null) return;
    if (isLocked(flexPlayer, league)) return; // v3.4: already locked — the swap can't be made
    const posIdx = league.starters.findIndex(
      (s) => s.slot === flexPlayer.pos && s.player && s.player.kickoff != null && s.player.kickoff > flexPlayer.kickoff
    );
    if (posIdx < 0) return;
    const positional = league.starters[posIdx];
    if (isLocked(positional.player, league)) return;
    starterRows[idx].issues.push(
      iss("Flex lock order", "major", `Locks ${flexPlayer.kickoffLabel} — before ${positional.slot} slot's ${positional.player.name} (${positional.player.kickoffLabel}). Swap these two.`)
    );
    starterRows[posIdx].issues.push(iss("Flex lock order", "major", `Later kickoff than ${slot}'s ${flexPlayer.name} — swap these two to preserve flexibility.`));
  });

  // v2.9: Sleeper only lists players, so pad the bench with empty slots up to
  // the league's bench size (this is what makes "Open bench slot" appear).
  const benchList = [...(league.bench || [])];
  if (Number.isFinite(league.benchSlots)) while (benchList.length < league.benchSlots) benchList.push(null);
  // v2.9: an IR-eligible bench player is only worth flagging when there is an
  // open IR slot to move him into. Unknown IR size -> flag as before.
  const openIr = Number.isFinite(league.irSlots) ? league.irSlots - (league.ir || []).length : null;
  const benchRows = benchList.map((p) => {
    if (!p) return { slot: "BN", label: "(empty)", issues: [iss("Open bench slot", "minor", "Open bench slot — consider a waiver add")] };
    if (p.irEligible) {
      if (isLocked(p, league)) return { slot: "BN", label: p.name, issues: [], usage: p.usage }; // v3.4: locked — can't be moved to IR now
      if (openIr == null || openIr > 0) return { slot: "BN", label: p.name, issues: [iss("IR-eligible on bench", "minor", "IR-eligible — move to an empty IR slot")], usage: p.usage };
      return { slot: "BN", label: p.name, issues: [], note: "IR-eligible, but there is no open IR slot", usage: p.usage };
    }
    return { slot: "BN", label: p.name, issues: [], usage: p.usage };
  });
  // v3.1: a player who isn't IR-eligible in this league sitting in an IR slot is red from his game
  // day until his game ends (he can't be played from there and should be moved).
  const irRows = (league.ir || []).map((p) => {
    const bad = !p.irEligible && p.gameToday && p.gameState !== "post" && !isLocked(p, league); // v3.4: red only until kickoff (then he's locked)
    const issues = bad ? [iss("Non-IR-eligible player in IR slot", "major", `${p.name} is ${p.status || "healthy"} — not IR-eligible here, and his game is ${p.gameState === "in" ? "in progress" : "today"}. Move him out of the IR slot.`)] : [];
    return { slot: "IR", label: p.name, issues, severity: worst(issues.map((i) => i.severity)), reasons: issues.map((i) => i.text), reason: issues.map((i) => i.text).join(" ") || null, kickoffLabel: p.kickoffLabel };
  });
  const taxiRows = (league.taxi || []).map((p) => ({ slot: "TAXI", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));

  // Open bench slots share a label; number them so each is its own variance.
  let emptyBench = 0;
  benchRows.forEach((r) => {
    if (r.label === "(empty)") r.label = `(empty ${++emptyBench})`;
  });
  const rows = [...starterRows, ...benchRows].map((r) => ({
    ...r,
    severity: worst(r.issues.map((i) => i.severity)),
    reasons: r.issues.map((i) => i.text),
    reason: r.issues.map((i) => i.text).join(" ") || null,
  }));
  return { rows, irRows, taxiRows, status: worst([...rows, ...irRows].map((r) => r.severity)) };
}

// The Lineup tab's numbers, status and per-slot rows — including the user's
// own Player Rankings override when they've saved one. All the logic lives in
// lineup.js so it can be tested without React.
function computeLineup(league) {
  return effectiveLineup(league);
}

// v2.9: waiver flags are by projection, not ECR or "trending":
//  - red:    a free agent projected higher than one of your current starters in
//            a slot he could fill (flex included) — you'd start him;
//  - yellow: a free agent projected higher than a bench player at his position.
// Trending is shown on the card but no longer flags anything.
function computeWaiver(league, allLeagues) {
  const eligible = (slot, pos) => (FLEX_ELIGIBLE[slot] ? FLEX_ELIGIBLE[slot].includes(pos) : slot === pos);
  const projOf = (p) => (p && p.proj != null ? p.proj : 0);
  const rows = (league.freeAgents || []).map((fa) => {
    let rule = null;
    let note = null;
    let severity = "ok";
    if (fa.proj != null) {
      // v3.4: a locked starter can't be replaced this week, so he's not a comparison
      const slots = (league.starters || []).filter((s) => eligible(s.slot, fa.pos) && !isLocked(s.player, league));
      const weakest = slots.length ? slots.reduce((m, s) => (projOf(s.player) < projOf(m.player) ? s : m)) : null;
      if (weakest && fa.proj > projOf(weakest.player)) {
        rule = "Free agent outprojects a starter";
        severity = "major";
        note = `projected ${fa.proj.toFixed(1)} vs ${weakest.player ? weakest.player.name : "(empty)"} ${projOf(weakest.player).toFixed(1)} at ${weakest.slot}`;
      } else {
        const bench = (league.bench || []).filter((p) => p && p.pos === fa.pos && !isLocked(p, league)); // v3.4: nor can a locked bench player be dropped
        const weakBench = bench.length ? bench.reduce((m, p) => (projOf(p) < projOf(m) ? p : m)) : null;
        if (weakBench && fa.proj > projOf(weakBench)) {
          rule = "Free agent outprojects a bench player";
          severity = "minor";
          note = `projected ${fa.proj.toFixed(1)} vs bench ${weakBench.name} ${projOf(weakBench).toFixed(1)}`;
        }
      }
    }
    const crossLeagues = allLeagues
      .filter((l) => l.id !== league.id && !l.error)
      .filter((l) => (l.freeAgents || []).some((x) => x.id === fa.id || x.name === fa.name))
      .map((l) => l.name);
    return { ...fa, rule, note, severity, crossLeagues };
  });
  return { rows, status: worst(rows.map((r) => r.severity)) };
}

// v2.9: a big-gap opportunity is yellow and clears itself once the page has
// been viewed and left; a smaller one is listed but is not a variance.
function computeTrade(league) {
  const rows = (league.tradeSuggestions || []).map((t) => {
    const big = t.severity === "major";
    return { ...t, bigGap: big, severity: big ? "minor" : "ok", auto: big };
  });
  return { rows, status: worst(rows.map((t) => t.severity)) };
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
  const Tag = onClick ? "button" : "span"; // a plain badge inside an already-clickable row must not be a nested button
  return (
    <Tag
      onClick={onClick}
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}33` }}
      className={`flex items-center gap-1 rounded-md ${compact ? "px-1.5 py-1" : "px-2.5 py-1.5"} shrink-0`}
    >
      <Icon size={14} strokeWidth={2.3} />
      {label && <span className="text-xs font-medium" style={{ fontFamily: "Inter, sans-serif" }}>{label}</span>}
    </Tag>
  );
}

// Projection source codes from the server (v2.4): V = Vegas props, T = Tank01,
// S = Sleeper, E = ESPN.
const SOURCE_TAG = { V: "VEGAS", T: "TANK01", S: "SLEEPER", E: "ESPN" };
// v3.3: the same per-source colours the Analytics page uses; tags on player cards / lineup rows match them.
const SRC_COLOR = { V: "#4A8FC2", T: "#D9A521", S: "#3FAE58", E: "#B07CC6" };

function SourceTag({ source, factor }) {
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

/* ------------------------------------------------------------------ */
/*  v2.8 PLAYER-CARD PIECES: headshots, logos, matchup, weather, stats */
/* ------------------------------------------------------------------ */
// Matchup tiers from the player's point of view: 0 = hardest (red) … 4 = easiest (dark green).
const TIER_COLORS = ["#D6533B", "#E8833A", "#D9C021", "#9CC23A", "#2E9E4F"];
const TIER_LABELS = ["Hardest", "Hard", "Middle", "Good", "Best"];
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const SAMPLE_LABEL = { blended: "Blended (incl. last season)", current: "This season only", last4: "Last 4 games" };

// What player cards need from the App: the matchup tables and the pop-ups.
const CardCtx = React.createContext({ dvpRow: () => null, openDvp: () => {}, openWeather: () => {} });

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function Headshot({ player, size = 32 }) {
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

function TeamLogo({ team, size = 20 }) {
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

// v2.8: "[NYJ] @ [MIA]" — the player's team coloured by its offensive rank at
// his position, the opponent by its defensive rank against that position.
// Each team opens the games behind its own rank.
const normTeam = (t) => ({ JAX: "JAC", WSH: "WAS", LA: "LAR" }[t] || t);
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
function MatchupChip({ player, profile }) {
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
function WeatherChip({ player }) {
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

const STAT_LABEL = {
  pass_yd: "pass yd", pass_td: "pass TD", pass_int: "INT", rush_att: "car", rush_yd: "rush yd", rush_td: "rush TD",
  rec_tgt: "tgt", rec: "rec", rec_yd: "rec yd", rec_td: "rec TD", fgm: "FG", xpm: "XP", kick_pts: "kick pts",
  sack: "sack", int: "INT", fum_rec: "fum rec", def_td: "TD", pts_allow: "pts allowed", yds_allow: "yds allowed",
};
function formatStatLine(stats) {
  if (!stats) return "";
  const whole = (k) => k.endsWith("_yd") || k === "yds_allow" || k === "pts_allow";
  return Object.entries(stats)
    .map(([k, v]) => `${whole(k) ? Math.round(v) : Math.round(v * 10) / 10} ${STAT_LABEL[k] || k}`)
    .join(" · ");
}
function StatLine({ player }) {
  if (!player?.projStats || player.projSource === "actual") return null;
  const src = SOURCE_TAG[player.projSource] || player.projSource;
  return (
    <div style={{ color: C.textFaint }} className="text-[10px] mt-1 leading-snug">
      Proj (<span style={{ color: SRC_COLOR[player.projSource] || undefined }}>{src}</span>): {formatStatLine(player.projStats)}
    </div>
  );
}

function Modal({ title, onClose, children }) {
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

function DvpDetailModal({ params, onClose }) {
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

function WeatherModal({ gameKey, week, onClose }) {
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

/* ------------------------------------------------------------------ */
/*  VARIANCE REPORT (v2.8.1)                                           */
/* ------------------------------------------------------------------ */
const SEV_COLOR = (sev, cleared) => (cleared ? C.textFaint : sev === "major" ? C.major : sev === "minor" ? C.minor : C.ok);

// Opens the report for a scope; coloured by the worst live variance in it.
function VarianceButton({ variances, onOpen, compact = false, label = "Variance report" }) {
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
const worstSev = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "ok");

function VarianceReportModal({ title, variances, onClear, onClose }) {
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
  waiver: { label: "Waivers", short: "Waivers", Icon: Users },
  trade: { label: "Trade Radar", short: "Trades", Icon: ArrowLeftRight },
  injury: { label: "Injury Watch", short: "Injury", Icon: Stethoscope },
  league: { label: "League", short: "League", Icon: Settings2 },
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
function Dashboard({ computed, onOpenLeague, onOpenTab, onLogout, onEditLeagues, onOpenAccount, onOpenAccuracy, sleeperUser, onOpenVariances }) {
  const allVariances = computed.flatMap((lg) => lg.variances || []);
  return (
    <div className="px-4 py-3">
      <div className="flex justify-end pb-2">
        <VarianceButton variances={allVariances} onOpen={() => onOpenVariances({})} label="Variance report — all leagues" />
      </div>
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
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <button onClick={() => onOpenLeague(lg.id)} className="text-left min-w-0 flex-1" data-league-open={lg.id}>
                <div className="flex items-center gap-1 min-w-0">
                  <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, color: C.text }} className="text-[15px] truncate">{lg.name}</span>
                  <ChevronRight size={16} style={{ color: C.textFaint }} className="shrink-0" />
                </div>
                <div className="text-xs truncate" style={{ color: C.textMuted }}>
                  {lg.error ? "Failed to load" : lg.teamName || "—"}
                </div>
              </button>
              {!lg.error && (
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => onOpenTab(lg.id, "odds")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
                    <Trophy size={11} />
                    Outlook
                  </button>
                  <VarianceButton compact variances={lg.variances || []} onOpen={() => onOpenVariances({ leagueId: lg.id })} />
                </div>
              )}
            </div>
            {!lg.error && (
              <div className="flex items-center gap-1 flex-nowrap overflow-x-auto px-4 pb-2.5 pt-2.5" style={{ borderTop: `1px solid ${C.border}` }} data-badge-row={lg.id}>
                {STATUS_BADGE_TABS.map((key) => (
                  <StatusBadge key={key} status={lg[key].status} label={TAB_META[key].short} compact onClick={() => onOpenTab(lg.id, key)} />
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

function LeagueOverview({ league, onOpenTab, onOpenVariances }) {
  if (league.error) return <ErrorScreen message={league.error} />;
  const summaries = {
    roster: (() => {
      const L = league.lineup;
      const rosterPart = league.roster.rows.some((r) => r.severity !== "ok")
        ? `${league.roster.rows.filter((r) => r.severity === "major").length} major, ${league.roster.rows.filter((r) => r.severity === "minor").length} minor issue(s)`
        : "Lineup is clean";
      let lineupPart;
      if (L.zeroStarters.length) lineupPart = `${L.zeroStarters.length} starter(s) projected for 0 pts`;
      else if (L.custom) {
        const changed = L.rows.filter((r) => r.changed).length;
        lineupPart = changed === 0 ? "matches your ranking" : `your ranking changes ${changed} slot(s)`;
      } else lineupPart = L.delta === 0 ? "already optimal" : `optimal lineup gains +${L.delta.toFixed(1)} pts`;
      return `${rosterPart} · ${lineupPart}`;
    })(),
    league: !league.privateInfo?.configured
      ? "Settings change log — needs your Sleeper token"
      : league.privateInfo?.readsOff
      ? "Settings change log — reading from Sleeper is switched off"
      : (league.leaguePage?.items || []).filter((i) => !i.cleared).length
      ? `${(league.leaguePage.items || []).filter((i) => !i.cleared).length} settings change(s) to review`
      : "No new settings changes",
    waiver: `${league.waiver.rows.filter((r) => r.severity !== "ok").length} worth a look this week`,
    trade: (league.tradeOffers?.incoming || []).filter((o) => !o.cleared).length
      ? `${(league.tradeOffers.incoming || []).filter((o) => !o.cleared).length} offer(s) waiting on you`
      : league.trade.rows.length
      ? league.trade.rows[0].note
      : "No standout trade opportunities",
    injury: league.injury.rows.filter((r) => !r.seen).length
      ? `${league.injury.rows.filter((r) => !r.seen).length} new injury flag(s)`
      : league.injury.rows.length
      ? `${league.injury.rows.length} tracked, none new`
      : "No injuries on this roster",
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex justify-end">
        <VarianceButton variances={league.variances || []} onOpen={() => onOpenVariances({ leagueId: league.id })} label="Variance report — this league" />
      </div>
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
  // v3.1: injury-opportunity notes on roster rows — a backup you own who moves up, and
  // replacement options (free agents or not) for your own injured starter or backup.
  const ioEvents = league.injuryOpportunities?.events || [];
  const playNotes = new Map();
  const replNotes = new Map();
  const lockedNow = lockedNames(league); // v3.4: no move can help a locked player, so no note for him
  for (const e of ioEvents) {
    for (const b of e.backups || []) if (b.owner === "mine" && !lockedNow.has(b.name)) playNotes.set(b.name, `Opportunity: ${e.injured.name} (${e.injured.slot}, ${e.injured.status}) is hurt and ${b.name} moves up.`);
    if (e.mine && !lockedNow.has(e.injured.name)) replNotes.set(e.injured.name, `Replacements: ${(e.backups || []).map(backupLine).join("; ") || "none on the depth chart"}${e.opposite ? `; also ${backupLine({ ...e.opposite, rank: null })}` : ""}`);
  }
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
          {r.note && !r.reason && <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{r.note}</div>}
          {playNotes.get(r.label) && <div style={{ color: C.minor }} className="text-xs mt-0.5" data-play-note>{playNotes.get(r.label)}</div>}
          {replNotes.get(r.label) && <div style={{ color: C.minor }} className="text-xs mt-0.5" data-repl-note>{replNotes.get(r.label)}</div>}
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
      <Headshot player={p} size={36} />
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
        Not on your roster, so they can't be ranked — they're shown with their projections so you can see whether a pickup would beat your lineup.
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

// Matchup + weather chips for the compact lineup rows.
function RowChips({ player, profile }) {
  if (!player || (!player.matchup && !player.weather)) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap mt-1">
      <MatchupChip player={player} profile={profile} />
      <WeatherChip player={player} />
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
                  <div className="flex items-center gap-1.5 min-w-0">
                    {c.current && <Headshot player={byName.get(c.current.name) || c.current} size={22} />}
                    <div style={{ color: curZero || c.changed ? C.major : C.text }} className="text-sm font-medium truncate">{c.current?.name ?? "(empty)"}</div>
                  </div>
                  <div style={{ color: curZero ? C.major : C.textMuted }} className="text-xs mt-0.5">
                    {c.current?.proj != null ? c.current.proj.toFixed(1) : "—"}{curZero ? " · projected 0" : ""}
                  </div>
                  <RowChips player={byName.get(c.current?.name)} profile={league.scoringProfile} />
                  <SourceTag source={c.current?.projSource} factor={c.current?.projFactor} />
                </div>
                <div style={{ background: optZero ? C.majorBg : c.changed ? C.okBg : "transparent" }} className="relative px-3 py-2.5 pb-4">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {c.optimal && <Headshot player={byName.get(c.optimal.name) || c.optimal} size={22} />}
                    <div style={{ color: optZero ? C.major : c.changed ? C.ok : C.text }} className="text-sm font-medium truncate">{c.optimal?.name ?? "(none available)"}</div>
                  </div>
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
/*  WAIVERS (v2.9): Available page + Claims page                       */
/* ------------------------------------------------------------------ */
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

// Reusable vertical drag list. Items can only move inside their own list, so
// one list per FAAB group keeps claims from being dragged between groups.
function DragList({ items, getKey, render, onReorder, label = "Drag to reorder" }) {
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

function DragHandle({ handleProps, dragging }) {
  return (
    <button type="button" {...handleProps} data-drag-handle style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab", color: C.textFaint }} className="p-1 -ml-1 shrink-0">
      <GripVertical size={18} />
    </button>
  );
}

// A bid box: type dollars or a % of the budget; empty removes the claim, 0 is a real bid.
function BidBox({ dollars, mode, budget, onCommit, width = 64, ariaLabel }) {
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

function EntryModeToggle({ mode, onChange }) {
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

const fmtMoney = (n) => `$${Math.round(n)}`;
const fmtPct = (n) => (n == null ? "—" : `${n}%`);
const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function FaabPanel({ faab, onRun }) {
  const { loading, result, error } = faab;
  const h = result?.history;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm flex items-center gap-1.5">
          <DollarSign size={14} style={{ color: C.brand }} />
          FAAB Suggestions
        </div>
        <button onClick={onRun} disabled={loading} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          {loading ? <Loader2 size={12} className="animate-spin" /> : null}
          {loading ? "Calculating…" : result ? "Refresh" : "Get suggestions"}
        </button>
      </div>
      <div style={{ color: C.textMuted }} className="text-[11px] mb-2">
        Based on winning waiver bids in your tracked leagues over the last 21 days — not platform-wide (Sleeper's API doesn't expose that). With a small sample, treat this as a directional guide, not a confidence interval.
      </div>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {result?.note && <div style={{ color: C.textMuted }} className="text-xs">{result.note}</div>}
      {h && (h.bids.length > 0 || Object.keys(h.byPosition || {}).length > 0) && (
        <div className="mt-1 mb-2" data-faab-history>
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide mb-1">Bid history · {h.windowLabel}</div>
          {Object.entries(h.byPosition).length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {Object.entries(h.byPosition).map(([pos, v]) => (
                <span key={pos} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[10px] rounded px-1.5 py-0.5">
                  {pos}: median ${v.median} ({v.medianPct}%), max ${v.max}, n={v.n}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-0.5">
            {h.bids.map((b, i) => (
              <div key={i} style={{ color: C.textMuted }} className="text-[11px] flex justify-between gap-2">
                <span className="truncate">{b.playerName} <span style={{ color: C.textFaint }}>({b.pos}) · {b.leagueName}</span></span>
                <span className="shrink-0">${b.bid} <span style={{ color: C.textFaint }}>({b.pct}%)</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
      {result?.players?.length > 0 && <div style={{ color: C.textFaint }} className="text-[10px]">Suggested bids (70% / 95% level) appear on each player below.</div>}
    </div>
  );
}

function DropSummary({ league }) {
  const d = league.dropSummary;
  const [open, setOpen] = useState(true);
  if (!d) return null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mb-3" data-drop-summary>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between" aria-expanded={open}>
        <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">Dropped in the last {d.windowDays} days</span>
        <span style={{ color: C.textFaint }} className="text-xs">{d.items.length}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {d.error && <div style={{ color: C.major }} className="text-xs">Couldn't load transactions: {d.error}</div>}
          {!d.error && d.items.length === 0 && <div style={{ color: C.textMuted }} className="text-xs">No drops in this league in the last {d.windowDays} days.</div>}
          {d.items.map((x, i) => (
            <div key={i} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <span style={{ color: C.text }}>{x.name}</span> <span style={{ color: C.textFaint }}>({x.pos}{x.team ? ` · ${x.team}` : ""})</span>
                <div style={{ color: C.textFaint }} className="text-[10px]">dropped by {x.teamLabel || "a team"} · {fmtWhen(x.at)}</div>
              </div>
              <div className="text-right shrink-0">
                <div style={{ color: x.available ? C.ok : C.textMuted }} className="text-[11px]">{x.available ? "Available" : x.locked ? "Locked until week ends" : x.readded ? "Re-added" : "Rostered"}</div>
                {x.proj != null && <div style={{ color: C.textFaint }} className="text-[10px]">proj {x.proj.toFixed(1)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AvailableRow({ p, plan, mode, budget, isFaab, faabHint, onBid, profile }) {
  const s = STATUS[p.severity] || STATUS.ok;
  const bid = (plan.bids || []).find((b) => b.id === p.id);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="relative rounded-md px-3 py-2.5 pb-4" data-fa={p.id}>
      <div className="flex items-start gap-2.5">
        <Headshot player={p} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span style={{ color: C.text }} className="text-sm font-medium truncate">{p.name}</span>
            <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{p.pos}{p.team ? ` · ${p.team}` : ""}</span>
          </div>
          <div style={{ color: C.textMuted }} className="text-xs mt-0.5">
            {p.proj != null ? `Proj ${p.proj.toFixed(1)}` : "No projection"}
            {p.topProj ? ` · #${p.projRank} projected at ${p.pos}` : ""}
            {p.trending ? ` · Trending add${p.trendCount ? ` (+${p.trendCount})` : ""}` : ""}
          </div>
          {p.status && p.status !== "Healthy" && <div style={{ color: C.minor }} className="text-[11px]">{p.status}</div>}
          {(p.matchup || p.weather) && (
            <div className="flex items-center gap-1 flex-wrap mt-1">
              <MatchupChip player={p} profile={profile} />
              <WeatherChip player={p} />
            </div>
          )}
          {p.note && p.rule && <div style={{ color: s.color }} className="text-[11px] mt-1">{p.rule === "Free agent outprojects a starter" ? "Beats a starter" : "Beats a bench player"}: {p.note}</div>}
          {p.usage && <div className="mt-1"><UsageBadge usage={p.usage} /></div>}
          {p.crossLeagues?.length > 0 && <div style={{ color: C.brand }} className="text-[11px] mt-1">Also available in: {p.crossLeagues.join(", ")}</div>}
          {faabHint && (
            <div style={{ color: C.textFaint }} className="text-[10px] mt-1">
              Suggested bid: {fmtMoney((budget * faabHint.suggestion70Pct) / 100)} (70%) · {fmtMoney((budget * faabHint.suggestion95Pct) / 100)} (95%) · n={faabHint.sampleSize}
              {faabHint.playerBids?.length ? ` · this player: ${faabHint.playerBids.map((b) => `$${b.bid}`).join(", ")}` : ""}
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {isFaab ? (
            <BidBox dollars={bid ? bid.bid : null} mode={mode} budget={budget} onCommit={(d) => onBid(p, d)} ariaLabel={`Bid for ${p.name}`} />
          ) : (
            <button type="button" onClick={() => onBid(p, bid ? null : 0)} style={{ color: bid ? C.ok : C.brand, border: `1px solid ${bid ? C.ok : C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-claim-toggle>
              {bid ? "Claimed ✓" : "Add claim"}
            </button>
          )}
          {bid && <span style={{ color: C.ok }} className="text-[10px]">on Claims page</span>}
        </div>
      </div>
      <SourceTag source={p.projSource} factor={p.projFactor} />
    </div>
  );
}

// v3.1: pickups caused by injuries at relevant depth-chart slots (only players you can actually claim).
function InjuryAddsSection({ league, plan, mode, budget, isFaab, onBid }) {
  const events = (league.injuryOpportunities?.events || []).filter((e) => (e.freeAdds || []).length > 0 && (!e.questionable || e.flagged));
  if (events.length === 0) return null;
  const sevOf = (e) => {
    const v = (league.variances || []).find((x) => x.page === "waiver" && x.subject === `${e.injured.name} (${e.injured.status})`);
    return v && !v.cleared ? (v.severity === "major" ? "major" : "minor") : "ok";
  };
  return (
    <div className="mb-3" data-injury-adds>
      <SectionLabel>Injury adds — {events.length}</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Starters and top backups who are out, doubtful or likely to miss (QB{league.superflex ? "1-2" : "1"}, RB1-2, WR1-3, TE1), and the next players on their depth chart. Only players you can claim are listed.
      </div>
      <div className="space-y-2.5">
        {events.map((e) => {
          const sev = sevOf(e);
          const s = STATUS[sev];
          return (
            <div key={e.key} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-2.5 py-2.5 space-y-1.5" data-injury-event={e.key}>
              <div style={{ color: C.text }} className="text-sm">
                <span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs mr-1.5">{e.injured.team} {e.injured.slot}</span>
                {e.injured.name} <span style={{ color: s.color }} className="text-xs">{e.injured.status}{e.injured.note ? ` — ${e.injured.note}` : ""}</span>
                {e.mine === "active" && <span style={{ color: C.major }} className="text-[10px] ml-1.5">On your roster</span>}
              </div>
              {e.questionable && <div style={{ color: C.minor }} className="text-[11px]">News check: {(e.signals || []).join("; ")}{e.news?.note ? ` — ${e.news.note}` : ""}</div>}
              <div className="space-y-1.5">
                {e.freeAdds.map((p) => (
                  <div key={p.id}>
                    {p.pos !== e.injured.pos && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-0.5">Also consider (top available {p.pos})</div>}
                    <AvailableRow p={{ ...p, severity: "ok" }} plan={plan} mode={mode} budget={budget} isFaab={isFaab} faabHint={null} onBid={onBid} profile={league.scoringProfile} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AvailablePage({ league, plan, setPlan, faab, onRunFaab }) {
  const budget = league.waiverInfo?.budget || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const hints = new Map((faab.result?.players || []).map((x) => [x.name, x]));
  const groups = POS_ORDER.map((pos) => ({
    pos,
    rows: (league.waiver.rows || []).filter((r) => r.pos === pos).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1)),
  })).filter((g) => g.rows.length);
  const onBid = (p, dollars) => setPlan((pl) => ({ ...pl, bids: setBid(pl.bids, p, dollars) }));
  return (
    <div>
      {isFaab && <FaabPanel faab={faab} onRun={onRunFaab} />}
      <InjuryAddsSection league={league} plan={plan} mode={mode} budget={budget} isFaab={isFaab} onBid={onBid} />
      <DropSummary league={league} />
      <div className="flex items-center justify-between gap-2 px-1 pb-2 flex-wrap">
        <div style={{ color: C.textMuted }} className="text-xs max-w-[60%]">
          Top 5 projected and top 5 trending free agents at each position, by projection. {isFaab ? "Enter a bid (0 counts) to add a claim." : "Tap “Add claim” to add a claim."}
        </div>
        {isFaab && <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />}
      </div>
      {league.waiverLock?.hidden > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-waiver-lock>{league.waiverLock.hidden} player(s) are hidden because their game has started. They can't be claimed until the week's last game ends.</div>}
      {groups.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No notable free agents right now.</div>}
      {groups.map((g) => (
        <div key={g.pos} data-pos-group={g.pos}>
          <SectionLabel>{g.pos}</SectionLabel>
          <div className="space-y-1.5">
            {g.rows.map((p) => (
              <AvailableRow key={p.id || p.name} p={p} plan={plan} mode={mode} budget={budget} isFaab={isFaab} faabHint={isFaab && budget ? hints.get(p.name) : null} onBid={onBid} profile={league.scoringProfile} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClaimRow({ c, result, mode, budget, isFaab, bench, handle, dragging, onBid, onDrop, onDelete }) {
  const failed = result && !result.ok;
  return (
    <div style={{ background: C.surface, border: `1px solid ${failed ? `${C.minor}66` : C.border}`, borderLeft: `3px solid ${failed ? C.minor : C.ok}`, boxShadow: dragging ? "0 6px 18px rgba(0,0,0,0.5)" : "none", opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-start gap-2" data-claim={c.key}>
      {handle}
      <div className="min-w-0 flex-1">
        <div style={{ color: C.text }} className="text-sm font-medium truncate">
          {c.addName} <span style={{ color: C.textFaint }} className="text-[11px]">{c.pos}{c.source === "custom" ? " · custom" : c.edited ? " · edited" : ""}</span>
        </div>
        <label className="flex items-center gap-1 mt-1 text-[11px]" style={{ color: C.textMuted }}>
          Drop
          <select
            value={c.dropId || ""}
            onChange={(e) => {
              const id = e.target.value;
              const b = bench.find((x) => String(x.id) === id);
              onDrop(c, id ? { dropId: id, dropName: b?.name } : { dropId: null, dropName: null });
            }}
            style={{ ...inputStyle, maxWidth: 170 }}
            className="rounded px-1.5 py-0.5 text-xs outline-none"
            aria-label={`Player to drop for ${c.addName}`}
          >
            <option value="">No drop</option>
            {bench.map((b) => (
              <option key={b.id} value={String(b.id)}>{b.name} ({b.pos})</option>
            ))}
          </select>
        </label>
        {result && <div style={{ color: result.ok ? C.ok : C.minor }} className="text-[11px] mt-1">{result.ok ? "Would succeed (if no one outbids you)" : `Would fail: ${result.reason}`}</div>}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {isFaab ? <BidBox dollars={c.bid} mode={mode} budget={budget} onCommit={(d) => d != null && onBid(c, d)} width={58} ariaLabel={`Bid for ${c.addName}`} /> : null}
        <button type="button" onClick={() => onDelete(c)} style={{ color: C.textMuted }} className="text-[11px] flex items-center gap-1" aria-label={`Delete claim for ${c.addName}`} data-claim-delete>
          <X size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

function ClaimsPage({ league, plan, setPlan, onRefresh, onOpenAccount }) {
  const budget = league.waiverInfo?.budget || 0;
  const used = league.waiverInfo?.used || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const allBench = league.bench || [];
  const bench = allBench.filter((p) => !p || !isLocked(p, league)); // v3.4: a locked player can't be dropped
  const openSpots = Math.max(0, (league.benchSlots ?? allBench.length) - allBench.length);

  // Keep the drop ranking in step with the bench (new bench players go to the bottom, unticked).
  const syncedDrops = useMemo(() => syncDrops(plan.drops, bench), [plan.drops, bench]);
  useEffect(() => {
    const same = syncedDrops.length === plan.drops.length && syncedDrops.every((d, i) => d.id === plan.drops[i].id && d.name === plan.drops[i].name);
    if (!same) setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench) }));
  }, [syncedDrops, plan.drops, bench, setPlan]);

  const eff = useMemo(() => effectiveClaims({ ...plan, drops: syncedDrops }, { openSpots }), [plan, syncedDrops, openSpots]);
  // v3.0: claims already queued in Sleeper aren't proposed again. A queued claim matches a
  // proposed one when it adds the same player and drops the same player (or nobody).
  const pending = league.privateInfo?.claims?.pending || [];
  const existing = useMemo(
    () => pending.map((x) => ({ key: `sl:${x.id}`, addId: String(x.adds[0] ?? ""), dropId: x.drops[0] != null ? String(x.drops[0]) : null, bid: Number(x.bid) || 0, source: "sleeper", dropPriority: -2, txId: x.id })),
    [pending]
  );
  const existingKeys = useMemo(() => new Set(existing.map((x) => claimKey(x.addId, x.dropId))), [existing]);
  // v3.1: a claim for a player whose game has started is hidden until the week's last game ends.
  const lockedIds = useMemo(() => new Set((league.waiverLock?.lockedIds || []).map(String)), [league.waiverLock]);
  const visibleClaims = useMemo(() => eff.claims.filter((c) => !existingKeys.has(claimKey(c.addId, c.dropId)) && !lockedIds.has(String(c.addId))), [eff.claims, existingKeys, lockedIds]);
  const hiddenCount = eff.claims.length - visibleClaims.length;
  const groups = useMemo(() => groupClaims(visibleClaims, plan.order), [visibleClaims, plan.order]);
  const ordered = useMemo(() => flatten(groups), [groups]);
  // The budget prediction counts what is already queued in Sleeper too.
  const simOrder = useMemo(() => flatten(groupClaims([...visibleClaims, ...existing], plan.order)), [visibleClaims, existing, plan.order]);
  const sim = useMemo(() => simulate(simOrder, { budget, used, openSpots }), [simOrder, budget, used, openSpots]);
  const resultByKey = new Map(sim.results.map((r) => [r.key, r]));

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ addId: "", dropId: "", bidText: "" });
  const [ticked, setTicked] = useState(() => new Set());

  const onBid = (c, d) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.map((x) => (x.key === c.key ? { ...x, bid: d } : x)) }));
    else setPlan((pl) => ({ ...pl, edits: { ...pl.edits, [c.key]: { ...(pl.edits[c.key] || {}), bid: d } } }));
  };
  const onDrop = (c, drop) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.map((x) => (x.key === c.key ? { ...x, ...drop } : x)) }));
    else setPlan((pl) => ({ ...pl, edits: { ...pl.edits, [c.key]: { ...(pl.edits[c.key] || {}), ...drop } } }));
  };
  const onDelete = (c) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.filter((x) => x.key !== c.key) }));
    else setPlan((pl) => ({ ...pl, removed: [...new Set([...pl.removed, c.key])] }));
  };
  const addCustom = () => {
    const fa = (league.waiver.rows || []).find((r) => r.id === draft.addId);
    const bid = toDollars(draft.bidText, mode, budget);
    if (!fa || (isFaab && bid == null)) return;
    const b = bench.find((x) => String(x.id) === draft.dropId);
    setPlan((pl) => ({ ...pl, custom: [...pl.custom, { key: `c:${Date.now()}:${fa.id}`, addId: fa.id, addName: fa.name, pos: fa.pos, bid: bid ?? 0, dropId: b ? String(b.id) : null, dropName: b?.name ?? null }] }));
    setDraft({ addId: "", dropId: "", bidText: "" });
    setAdding(false);
  };

  const moveDrops = (keys) => setPlan((pl) => {
    const cur = syncDrops(pl.drops, bench);
    const byId = new Map(cur.map((d) => [d.id, d]));
    return { ...pl, drops: keys.map((k) => byId.get(k)).filter(Boolean) };
  });

  const Stat = ({ label, dollars, pct, accent }) => (
    <div className="text-center">
      <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">{label}</div>
      <div style={{ color: accent || C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-xl font-semibold">{fmtMoney(dollars)}</div>
      <div style={{ color: C.textFaint }} className="text-[11px]">{fmtPct(pct)}</div>
    </div>
  );

  return (
    <div>
      {isFaab ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-3 mb-2" data-budget>
          <div className="flex items-center justify-around">
            <Stat label="Budget now" dollars={sim.current} pct={sim.currentPct} />
            <div style={{ color: C.textFaint }} className="text-xs text-center">
              − {fmtMoney(sim.spent)}
              <div className="text-[10px]">{sim.wins} win{sim.wins === 1 ? "" : "s"}</div>
            </div>
            <Stat label="After proposed" dollars={sim.after} pct={sim.afterPct} accent={C.brand} />
          </div>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">
            Predicted for YOUR claims only, assuming you win every one that's possible: only your highest bid per player counts, a dropped player can only be dropped once, and without a drop you can only add as many players as you have open bench spots ({openSpots} now). Other teams' bids aren't visible, so a higher outside bid would change this. Equal bids are assumed to process in the order shown.
          </div>
        </div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-lg p-3 mb-2 text-xs">
          This league doesn't use FAAB{league.waiverInfo?.priority != null ? ` — your waiver priority is #${league.waiverInfo.priority}` : ""}. Claims are processed in priority order; order within your list is the order Sleeper tries them. {openSpots} open bench spot{openSpots === 1 ? "" : "s"}.
        </div>
      )}
      {isFaab && (
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <span style={{ color: C.textMuted }} className="text-xs">Enter bids as</span>
          <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />
        </div>
      )}

      <SectionLabel>Who you'd drop — rank most willing first</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Drag your bench into the order you'd drop them, and tick the ones you're willing to lose. The claim list below is built from this.
      </div>
      {syncedDrops.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-2">No bench players to drop.</div>
      ) : (
        <DragList
          items={syncedDrops}
          getKey={(d) => d.id}
          onReorder={moveDrops}
          label="Drag to rank the player you would drop"
          render={(d, { handleProps, dragging }) => (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-center gap-2" data-drop-row={d.id}>
              <DragHandle handleProps={handleProps} dragging={dragging} />
              <span style={{ color: C.textFaint, fontVariantNumeric: "tabular-nums" }} className="text-xs w-5 text-right">{syncedDrops.findIndex((x) => x.id === d.id) + 1}</span>
              <span style={{ color: C.text }} className="text-sm truncate flex-1">{d.name} <span style={{ color: C.textFaint }} className="text-[11px]">{d.pos}</span></span>
              <label className="flex items-center gap-1 text-xs shrink-0" style={{ color: C.textMuted }}>
                <input type="checkbox" checked={d.willing} onChange={(e) => setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench).map((x) => (x.id === d.id ? { ...x, willing: e.target.checked } : x)) }))} data-willing />
                Willing to drop
              </label>
            </div>
          )}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Proposed claims — {visibleClaims.length}</SectionLabel>
        <div className="flex items-center gap-2 pt-3">
          <button type="button" onClick={() => setAdding((v) => !v)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-add-custom>
            + Custom claim
          </button>
          <button type="button" onClick={() => setPlan((pl) => resetClaims(pl))} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-xs rounded-md px-2 py-1" data-reset-claims>
            Reset to defaults
          </button>
        </div>
      </div>
      {adding && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 mb-2 space-y-2" data-custom-form>
          <select value={draft.addId} onChange={(e) => setDraft({ ...draft, addId: e.target.value })} style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="Player to add">
            <option value="">Player to add…</option>
            {(league.waiver.rows || []).map((r) => (
              <option key={r.id || r.name} value={r.id}>{r.name} ({r.pos})</option>
            ))}
          </select>
          <select value={draft.dropId} onChange={(e) => setDraft({ ...draft, dropId: e.target.value })} style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="Player to drop">
            <option value="">No drop</option>
            {bench.map((b) => (
              <option key={b.id} value={String(b.id)}>Drop {b.name} ({b.pos})</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {isFaab && (
              <input value={draft.bidText} onChange={(e) => setDraft({ ...draft, bidText: e.target.value })} placeholder={mode === "percent" ? "bid %" : "bid $"} inputMode="decimal" style={{ ...inputStyle, width: 90 }} className="rounded px-2 py-1.5 text-sm outline-none" aria-label="Bid" />
            )}
            <button type="button" onClick={addCustom} disabled={!draft.addId || (isFaab && toDollars(draft.bidText, mode, budget) == null)} style={{ background: C.brand, color: C.text, opacity: !draft.addId || (isFaab && toDollars(draft.bidText, mode, budget) == null) ? 0.5 : 1 }} className="text-sm rounded-md px-3 py-1.5">
              Add claim
            </button>
          </div>
        </div>
      )}
      {eff.warnings.map((w, i) => (
        <div key={i} style={{ color: C.minor }} className="text-[11px] px-1 pb-1">{w}</div>
      ))}
      {hiddenCount > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-1" data-hidden-existing>{hiddenCount} proposed claim{hiddenCount === 1 ? " is" : "s are"} already in Sleeper and hidden here.</div>}
      {visibleClaims.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">
          {hiddenCount > 0 ? "Everything proposed is already queued in Sleeper." : <>No claims yet. Enter a bid on the Available page{plan.bids.length ? ", then tick the bench players you're willing to drop above" : ""}.</>}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.bid} data-claim-group={g.bid}>
              <div style={{ color: C.brand, fontFamily: "Oswald, sans-serif" }} className="text-xs px-1 pb-1">
                {isFaab ? `${fmtMoney(g.bid)}${budget ? ` · ${fmtPct(Math.round((g.bid / budget) * 1000) / 10)}` : ""}` : "Claims"} — {g.claims.length} claim{g.claims.length === 1 ? "" : "s"}
              </div>
              <DragList
                items={g.claims}
                getKey={(c) => c.key}
                label={`Drag to reorder within the ${fmtMoney(g.bid)} group`}
                onReorder={(keys) => {
                  const next = flatten(groups.map((x) => (x.bid === g.bid ? { ...x, claims: keys.map((k) => x.claims.find((c) => c.key === k)) } : x))).map((c) => c.key);
                  setPlan((pl) => ({ ...pl, order: next }));
                }}
                render={(c, { handleProps, dragging }) => (
                  <ClaimRow c={c} result={resultByKey.get(c.key)} mode={mode} budget={budget} isFaab={isFaab} bench={bench} dragging={dragging} handle={<DragHandle handleProps={handleProps} dragging={dragging} />} onBid={onBid} onDrop={onDrop} onDelete={onDelete} />
                )}
              />
            </div>
          ))}
        </div>
      )}

      <ClaimsPush league={league} ordered={ordered} existing={existing} isFaab={isFaab} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />

      {ordered.length > 0 && (
        <>
          <SectionLabel>Enter these in Sleeper, in this order</SectionLabel>
          <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
            Tick each one once it's entered.{" "}
            <a href={`https://sleeper.com/leagues/${league.id}`} target="_blank" rel="noreferrer" style={{ color: C.brand }} className="underline">Open this league in Sleeper</a>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-claim-checklist>
            {ordered.map((c, i) => (
              <label key={c.key} className="flex items-start gap-2 px-3 py-2 text-xs" style={{ color: ticked.has(c.key) ? C.textFaint : C.text, borderColor: C.border, textDecoration: ticked.has(c.key) ? "line-through" : "none" }}>
                <input type="checkbox" checked={ticked.has(c.key)} onChange={(e) => setTicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.key); else n.delete(c.key); return n; })} />
                <span>{i + 1}. {isFaab ? describeClaim(c) : `Claim ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// v3.0: push the proposed claims to Sleeper (private API, opt-in, confirm, read-back).
// The submit/cancel claim calls have never been confirmed to work, so the FIRST push
// is a single claim; once one has been read back successfully, the rest go in one go.
function ClaimsPush({ league, ordered, existing, isFaab, onRefresh, onOpenAccount }) {
  const [st, setSt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const loadStatus = useCallback(() => api.getPrivateStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => {
    if (league.privateInfo?.configured) loadStatus();
  }, [league.privateInfo?.configured, loadStatus]);
  const proven = Boolean(st?.log?.some((l) => l.action === "submit_waiver_claim" && l.ok));
  const batch = proven ? ordered : ordered.slice(0, 1);
  const label = (c) => (isFaab ? describeClaim(c) : `Claim ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`);
  const send = async () => {
    setBusy(true);
    const out = [];
    for (const c of batch) {
      try {
        const r = await api.pushClaim(league.id, { addId: c.addId, dropId: c.dropId, bid: c.bid }, { keys: pushKeys(league, "waiver") });
        out.push({ label: label(c), ok: r.ok, verified: r.verified, detail: r.detail });
        if (!r.ok) break; // stop at the first claim Sleeper doesn't confirm
      } catch (e) {
        out.push({ label: label(c), ok: false, detail: e.message });
        break;
      }
    }
    setResults(out);
    setBusy(false);
    setConfirming(false);
    loadStatus();
    if (out.some((o) => o.ok)) onRefresh?.();
  };
  const cancel = async (x) => {
    try {
      const r = await api.cancelClaim(league.id, x.txId);
      setResults([{ label: `Cancel queued claim for ${x.addId}`, ok: r.ok, detail: r.detail }]);
      if (r.ok) onRefresh?.();
    } catch (e) {
      setResults([{ label: "Cancel queued claim", ok: false, detail: e.message }]);
    }
  };
  return (
    <div className="mt-3 space-y-2" data-claims-push>
      <SectionLabel>Push to Sleeper</SectionLabel>
      <PrivateGate league={league} group="claims" onOpenAccount={onOpenAccount}>
        {league.privateInfo?.claims?.error && <div style={{ color: C.minor }} className="text-[11px] px-1">Couldn't read your queued claims from Sleeper ({league.privateInfo.claims.error}) — proposed claims may duplicate ones already there.</div>}
        {existing.length > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-existing-claims>
            <div style={{ color: C.textFaint }} className="px-3 py-1.5 text-[11px]">Already queued in Sleeper</div>
            {existing.map((x) => (
              <div key={x.key} style={{ color: C.text, borderColor: C.border }} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                <span>Add {x.addId}{x.dropId ? `, drop ${x.dropId}` : ""} · bid {fmtMoney(x.bid)}</span>
                <button type="button" onClick={() => cancel(x)} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded px-2 py-0.5 text-[11px]">Cancel</button>
              </div>
            ))}
          </div>
        )}
        {ordered.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-xs px-1">Nothing to push.</div>
        ) : !confirming ? (
          <button type="button" onClick={() => setConfirming(true)} style={{ background: C.brand, color: C.text }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium" data-push-claims>
            {proven ? `Push ${ordered.length} claim${ordered.length === 1 ? "" : "s"} to Sleeper` : "Push first claim to Sleeper (test)"}
          </button>
        ) : (
          <ConfirmPush title={proven ? "Send these claims to Sleeper?" : "Send ONE test claim to Sleeper?"} lines={batch.map(label)} buttonLabel={proven ? "Yes, submit them" : "Yes, submit this claim"} busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note={proven ? "Each claim is read back from Sleeper to confirm it registered; the push stops at the first one that doesn't." : "Entering waiver claims through Sleeper's private API has never been confirmed to work. This sends only the first claim and reads it back. If it registers, the next push sends the rest. Either way, the checklist below still works."} />
        )}
        <PushResults results={results} />
      </PrivateGate>
    </div>
  );
}

function WaiverTab({ league, sessionId, onRefresh, onOpenAccount }) {
  const [sub, setSub] = useState("available");
  const [plan, setPlanState] = useState(null);
  const [planError, setPlanError] = useState(null);
  const [faab, setFaab] = useState({ loading: false, result: null, error: null });
  const saveTimer = useRef(null);
  const latest = useRef(null);
  const leagueId = league.id;

  useEffect(() => {
    let cancelled = false;
    setPlanState(null);
    api.getWaiverPlan(leagueId).then((p) => !cancelled && setPlanState(p)).catch((e) => !cancelled && setPlanError(e.message));
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (latest.current) {
      const p = latest.current;
      latest.current = null;
      api.saveWaiverPlan(leagueId, p).catch((e) => setPlanError(e.message));
    }
  }, [leagueId]);
  useEffect(() => () => flush(), [flush]);

  // Updates are applied at once and saved shortly after (so typing and dragging stay snappy).
  const setPlan = useCallback(
    (fn) => {
      setPlanState((prev) => {
        if (!prev) return prev;
        const next = typeof fn === "function" ? fn(prev) : fn;
        latest.current = next;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flush, 500);
        return next;
      });
    },
    [flush]
  );

  const runFaab = async () => {
    setFaab({ loading: true, result: faab.result, error: null });
    try {
      setFaab({ loading: false, result: await api.getFaabSuggestions(sessionId, leagueId), error: null });
    } catch (err) {
      setFaab({ loading: false, result: null, error: err.message });
    }
  };

  const claimCount = plan ? effectiveClaims(plan, { openSpots: Math.max(0, (league.benchSlots ?? (league.bench || []).length) - (league.bench || []).length) }).claims.length : 0;
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-waiver-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 text-sm font-medium">
      {label}
    </button>
  );
  return (
    <div className="px-4 py-3">
      <div className="flex mb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        {tab("available", "Available")}
        {tab("claims", `Claims${claimCount ? ` (${claimCount})` : ""}`)}
      </div>
      {planError && <div style={{ color: C.major }} className="text-xs px-1 pb-2">{planError}</div>}
      {!plan ? (
        <div className="flex items-center gap-2 px-1 py-4" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" /> <span className="text-sm">Loading your waiver plan…</span>
        </div>
      ) : sub === "available" ? (
        <AvailablePage league={league} plan={plan} setPlan={setPlan} faab={faab} onRunFaab={runFaab} />
      ) : (
        <ClaimsPage league={league} plan={plan} setPlan={setPlan} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      )}
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

// v2.9: "5 days 3 hr left" from the deadline's end time (an estimate: the last
// kickoff of the deadline week plus a few hours).
function countdownLabel(endsAt, now) {
  const ms = endsAt - now;
  if (ms <= 0) return "passed";
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return d > 0 ? `${d} day${d === 1 ? "" : "s"} ${h} hr left` : h > 0 ? `${h} hr ${m} min left` : `${m} min left`;
}

function DeadlineBanner({ info }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
  if (!info.configured) {
    return <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-2 mb-3 text-xs" data-deadline>This league has no trade deadline.</div>;
  }
  const passed = info.passed || (info.endsAt && info.endsAt <= now);
  const left = info.endsAt ? countdownLabel(info.endsAt, now) : null;
  const urgent = !passed && info.endsAt && info.endsAt - now < 7 * 86400e3;
  const color = passed ? C.textMuted : urgent ? C.minor : C.text;
  return (
    <div style={{ background: urgent ? C.minorBg : C.surfaceRaised, border: `1px solid ${urgent ? `${C.minor}66` : C.border}`, color }} className="rounded-md px-3 py-2 mb-3 text-xs" data-deadline>
      <div className="flex items-center gap-1.5 font-medium">
        <Clock size={13} />
        {passed ? "Trade deadline has passed" : `Trade deadline: ${left || info.label}`}
      </div>
      {info.label && !passed && left && <div style={{ color: C.textMuted }} className="mt-0.5">{info.label}</div>}
      {info.note && <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">{info.note}</div>}
    </div>
  );
}

const NEWS_COLOR = { ok: C.ok, caution: C.minor, avoid: C.major };
const NEWS_LABEL = { ok: "No red flags", caution: "Caution", avoid: "Avoid" };

function OwnershipSection({ ownership }) {
  if (!ownership) return null;
  if (ownership.pending) {
    return (
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-3 flex items-center gap-1.5" data-ownership-pending>
        <Loader2 size={12} className="animate-spin" /> Checking which of your players your opponents also own in their other leagues — this takes a minute the first time. Refresh shortly.
      </div>
    );
  }
  const list = ownership.players || [];
  const high = list.filter((p) => p.high);
  const rest = list.filter((p) => !p.high);
  return (
    <div className="mb-3" data-ownership>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Players on your roster that opponents in this league also roster in their other Sleeper leagues. A rival who owns the same player elsewhere may value him differently when you offer him. Based on {ownership.leaguesChecked ?? 0} league(s) checked across {ownership.opponents ?? 0} opponents
        {ownership.capped ? " (capped — not every league was checked)" : ""}.
      </div>
      {list.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1">None found.</div>
      ) : (
        <div className="space-y-1.5">
          {[...high, ...rest.slice(0, 8)].map((p) => (
            <div key={p.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${p.high ? C.brand : C.border}` }} className="rounded-md px-3 py-2">
              <div style={{ color: C.text }} className="text-sm">
                {p.name} <span style={{ color: C.textFaint }} className="text-[11px]">{p.pos}</span>
                {p.high && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">High ownership</span>}
              </div>
              <div style={{ color: C.textMuted }} className="text-[11px]">
                {p.opponentCount} of {ownership.opponents} opponents · {(p.opponents || []).map((o) => `${o.team} (${o.leagues} league${o.leagues === 1 ? "" : "s"})`).join(", ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradeTab({ league, sessionId, onRefresh, onOpenAccount }) {
  const teams = league.leagueTeams || [];
  const me = teams.find((t) => t.isMe);
  const others = teams.filter((t) => !t.isMe);
  const suggestionsByTeam = {};
  (league.trade.rows || []).forEach((t) => {
    (suggestionsByTeam[t.theirTeam] = suggestionsByTeam[t.theirTeam] || []).push(t);
  });
  const finder = league.tradeFinder || [];
  const [advice, setAdvice] = useState({ loading: false, configured: null, byKey: {}, at: null, error: null });
  const finderSig = finder.map((t) => `${t.give.name}>${t.get.name}`).join("|");
  const runAdvice = useCallback(
    async (force) => {
      if (!finderSig) return;
      setAdvice((a) => ({ ...a, loading: true, error: null }));
      try {
        const r = await api.getTradeAdvice(sessionId, league.id, force === true, force === "open");
        setAdvice({ loading: false, configured: r.configured, byKey: r.byKey || {}, at: r.at, error: null });
      } catch (err) {
        setAdvice((a) => ({ ...a, loading: false, error: err.message }));
      }
    },
    [sessionId, league.id, finderSig]
  );
  // Opening the page only shows what is already cached (v3.3); the news check itself runs when you press its button.
  useEffect(() => {
    runAdvice("open");
  }, [runAdvice]);

  return (
    <div className="px-4 py-3">
      <DeadlineBanner info={league.tradeDeadline} />
      <TradeOffers league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        {league.tradeBasis === "projection"
          ? "FantasyPros rankings weren't available for enough of your league, so trade value here is each player's rank by projected points among rostered players at his position — a single-week signal, not a dedicated trade-value model."
          : "Based on average ECR by position across every roster in the league (a rest-of-season-oriented signal, not a single week's projection) — not a dedicated trade-value model."}
      </div>

      {me && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 mb-3 space-y-1.5">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm mb-1">Your Team</div>
          <StrengthWeaknessRow label="Strong" items={me.strengths} color={C.ok} />
          <StrengthWeaknessRow label="Weak" items={me.weaknesses} color={C.major} />
        </div>
      )}

      <SectionLabel>Owned by opponents elsewhere</SectionLabel>
      <OwnershipSection ownership={league.ownership} />

      <div className="flex items-center justify-between">
        <SectionLabel>Trade Finder — 1-for-1 Swaps</SectionLabel>
        {finder.length > 0 && advice.configured && (
          <button onClick={() => runAdvice(true)} disabled={advice.loading} style={{ color: C.brand }} className="text-[11px] pt-3 flex items-center gap-1" data-recheck-news>
            {advice.loading ? <Loader2 size={11} className="animate-spin" /> : null}Re-check news
          </button>
        )}
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        You sell from a position of strength and buy at a position of weakness — never the same position — against real rival rosters, kept to offers close enough in trade value that a rival could plausibly accept. Ranked by the net change to your projected starting lineup.
        {advice.configured === false ? " (Add a Gemini key on the server to get a news check on each swap.)" : advice.configured ? " Each swap has a news check from Gemini with Google Search — it can be wrong, so verify before trading." : ""}
      </div>
      {advice.error && <div style={{ color: C.major }} className="text-xs px-1 pb-2">News check failed: {advice.error}</div>}
      {finder.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-3">No fair 1-for-1 swaps found against any rival roster right now.</div>
      ) : (
        <div className="space-y-1.5 mb-3">
          {finder.map((t, i) => {
            const news = advice.byKey[`${t.give.name} > ${t.get.name}`];
            const nc = news ? NEWS_COLOR[news.flag] || C.textMuted : null;
            return (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${nc || C.ok}` }} className="rounded-md px-3.5 py-2.5" data-finder={i}>
                <div style={{ color: C.text }} className="text-xs">
                  <span style={{ color: C.textMuted }}>Give </span>{t.give.name} <span style={{ color: C.textFaint }}>({t.give.pos})</span>
                  <span style={{ color: C.textMuted }}> · Get </span>{t.get.name} <span style={{ color: C.textFaint }}>({t.get.pos})</span>
                  <span style={{ color: C.textMuted }}> from </span>{t.theirTeam}
                  {t.mutual && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">They're weak at {t.give.pos} too</span>}
                </div>
                <div style={{ color: C.ok }} className="text-[11px] mt-0.5">
                  {t.gain >= 0 ? "+" : ""}{t.gain.toFixed(1)} projected pts to your starting lineup
                  {t.gainParts ? <span style={{ color: C.textFaint }}> ({t.get.name} adds {t.gainParts.add.toFixed(1)}{t.gainParts.loss > 0 ? `, losing ${t.give.name} costs ${t.gainParts.loss.toFixed(1)}` : ""})</span> : null}
                </div>
                {news && (
                  <div style={{ color: nc }} className="text-[11px] mt-1" data-news={news.flag}>
                    <span className="font-medium">{NEWS_LABEL[news.flag] || news.flag}:</span> {news.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {advice.at && advice.configured && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-3">News checked {fmtWhen(advice.at)}</div>}

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

const OWNER_LABEL = { mine: "you own him", other: "owned by another team", free: "available" };
function backupLine(b) {
  return `${b.name} (${b.pos}${b.rank != null ? b.rank : ""}${b.team ? `, ${b.team}` : ""})${b.proj != null ? ` proj ${b.proj.toFixed(1)}` : ""} — ${b.owner === "free" && b.locked ? "locked until the week's last game ends" : OWNER_LABEL[b.owner] || b.owner}`;
}

function InjuryTab({ league }) {
  const io = league.injuryOpportunities;
  const events = io?.events || [];
  const mineByName = new Map(events.filter((e) => e.mine).map((e) => [e.injured.name, e]));
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
            const sev = e.cleared ? "ok" : e.seen ? "minor" : "major";
            const s = STATUS[sev];
            return (
              <div key={e.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3 flex items-center gap-3">
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm font-medium">{e.player}</div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{e.status}{e.note ? ` — ${e.note}` : ""}</div>
                  {mineByName.get(e.player) && (
                    <div style={{ color: C.minor }} className="text-[11px] mt-0.5" data-injury-note>
                      Replacements: {mineByName.get(e.player).backups.map(backupLine).join("; ") || "none on the depth chart"}
                      {mineByName.get(e.player).opposite ? `; also ${backupLine({ ...mineByName.get(e.player).opposite, rank: null })}` : ""}
                    </div>
                  )}
                </div>
                <div style={{ color: C.textFaint }} className="text-xs shrink-0">{e.cleared ? "Cleared" : e.seen ? "Seen before" : "New"}</div>
              </div>
            );
          })}
        </div>
      )}
      <SectionLabel>Injury opportunities</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Notes only. Starters and top backups (QB{league.superflex ? "1-2" : "1"}, RB1-2, WR1-3, TE1) who are out, doubtful or likely to miss, with who moves up. Depth chart from {io?.depthSource?.espnTeams ? `ESPN (${io.depthSource.espnTeams}/32 teams; the rest from Sleeper)` : "Sleeper's depth order (ESPN's depth chart wasn't available)"}.
        {io?.newsConfigured === false ? " Questionable players are only included when their backup is trending, because no Gemini key is set." : ""}
        {io?.newsError ? ` The news check failed (${io.newsError.slice(0, 80)}).` : ""}
      </div>
      {events.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No injuries at these depth-chart slots right now.</div>
      ) : (
        <div className="space-y-1.5" data-injury-opps>
          {events.map((e) => (
            <div key={e.key} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-2.5 space-y-1" data-injury-opp={e.key}>
              <div style={{ color: C.text }} className="text-sm font-medium">
                <span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs mr-1.5">{e.injured.team} {e.injured.slot}</span>
                {e.injured.name} <span style={{ color: C.minor }} className="text-xs font-normal">{e.injured.status}{e.injured.note ? ` — ${e.injured.note}` : ""}</span>
                {e.mine && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">{e.mine === "active" ? "On your roster" : "On your IR/taxi"}</span>}
              </div>
              {e.questionable && <div style={{ color: C.minor }} className="text-[11px]">News check: {(e.signals || []).join("; ")}{e.news?.practice ? ` · practice: ${e.news.practice}` : ""}{e.news?.note ? ` — ${e.news.note}` : ""}</div>}
              {e.backups.length === 0 && <div style={{ color: C.textFaint }} className="text-[11px]">No healthy backups on the depth chart.</div>}
              {e.backups.map((b) => (
                <div key={b.id} style={{ color: C.minor }} className="text-[11px]">{backupLine(b)}</div>
              ))}
              {e.opposite && <div style={{ color: C.minor }} className="text-[11px]">Also consider: {backupLine({ ...e.opposite, rank: null })}</div>}
            </div>
          ))}
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

/* ------------------------------------------------------------------ */
/*  v3.0 — Sleeper private access: gate, confirm box, results          */
/* ------------------------------------------------------------------ */
const GROUP_NAME = { roster: "Roster changes", claims: "Waiver claims", trades: "Trades" };
// v3.1: `group` is one of roster | claims | trades (the three write switches); a read-only
// gate has none. Reads switched off hides everything private.
function PrivateGate({ league, group = null, write = false, onOpenAccount, children }) {
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
function ConfirmPush({ title, lines, buttonLabel, busy, onConfirm, onCancel, note }) {
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

function PushResults({ results }) {
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

/* ------------------------------------------------------------------ */
/*  v3.0 — merged Roster page: roster, then Proposed changes / Update   */
/* ------------------------------------------------------------------ */
function RosterPage({ league, onSaveRanking, onRefresh, onOpenAccount }) {
  const [sub, setSub] = useState("proposed");
  const changes = useMemo(() => proposeChanges(league), [league]);
  const [checked, setChecked] = useState(() => new Set());
  useEffect(() => {
    setChecked((prev) => {
      const valid = new Set(changes.filter((c) => !c.blocked).map((c) => c.key));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [changes]);
  const onToggle = (key, on) => setChecked((prev) => toggleChange(changes, prev, key, on));
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-roster-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 text-sm font-medium">
      {label}
    </button>
  );
  const usable = changes.filter((c) => !c.blocked).length;
  return (
    <div>
      {league.lineup?.weatherStarters?.length > 0 && (
        <div className="px-4 pt-3 -mb-1" data-roster-weather>
          <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2 space-y-0.5">
            {league.lineup.weatherStarters.map((p) => (
              <div key={p.id || p.name}>Weather: {p.name} ({p.team}) — {p.weather.reasons.join("; ")}</div>
            ))}
          </div>
        </div>
      )}
      <RosterTab league={league} />
      <div className="px-4 pb-3">
        <div className="flex mb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
          {tab("proposed", `Proposed changes${usable ? ` (${usable})` : ""}`)}
          {tab("update", `Update roster${checked.size ? ` (${checked.size})` : ""}`)}
        </div>
        {sub === "proposed" ? (
          <ProposedChanges league={league} changes={changes} checked={checked} onToggle={onToggle} onSaveRanking={onSaveRanking} onGoUpdate={() => setSub("update")} />
        ) : (
          <UpdateRoster league={league} changes={changes} checked={checked} onRefresh={onRefresh} onOpenAccount={onOpenAccount} onDone={() => setChecked(new Set())} />
        )}
      </div>
    </div>
  );
}

function ProposedChanges({ league, changes, checked, onToggle, onSaveRanking, onGoUpdate }) {
  const [details, setDetails] = useState(false);
  return (
    <div data-proposed-changes>
      {changes.length === 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-sm">
          No changes recommended — your lineup already matches the best projected lineup, and nothing needs moving to IR.
        </div>
      ) : (
        <div className="space-y-1.5">
          {changes.map((c) => (
            <label key={c.key} style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: c.blocked ? 0.7 : 1 }} className="rounded-md px-3 py-2.5 flex items-start gap-3" data-change={c.key}>
              <input type="checkbox" disabled={Boolean(c.blocked)} checked={checked.has(c.key)} onChange={(e) => onToggle(c.key, e.target.checked)} className="mt-1" aria-label={c.type === "lineup" ? `Start ${c.toName} at ${c.slot}` : `Move ${c.name} to IR`} />
              <div className="min-w-0 flex-1">
                {c.type === "lineup" ? (
                  <>
                    <div style={{ color: C.text }} className="text-sm"><span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs mr-1.5">{c.slot}</span>{c.fromName ?? "(empty)"} → <b>{c.toName}</b></div>
                    {c.delta > 0 && <div style={{ color: C.ok }} className="text-xs">+{c.delta.toFixed(1)} projected points</div>}
                  </>
                ) : (
                  <div style={{ color: C.text }} className="text-sm">Move <b>{c.name}</b> to injured reserve</div>
                )}
                {c.blocked && <div style={{ color: C.minor }} className="text-xs mt-0.5">{c.blocked}</div>}
              </div>
            </label>
          ))}
        </div>
      )}
      {changes.some((c) => !c.blocked) && (
        <div className="flex items-center justify-between pt-2">
          <span style={{ color: C.textMuted }} className="text-xs">{checked.size} approved</span>
          <button type="button" onClick={onGoUpdate} disabled={checked.size === 0} style={{ background: C.brand, color: C.text, opacity: checked.size ? 1 : 0.5 }} className="rounded-md px-3 py-1.5 text-sm" data-go-update>
            Review in Update roster →
          </button>
        </div>
      )}
      <button type="button" onClick={() => setDetails((v) => !v)} style={{ color: C.brand }} className="text-xs underline mt-3" data-lineup-details-toggle>
        {details ? "Hide" : "Show"} lineup details (rankings, per-slot view)
      </button>
      {details && <div className="-mx-4"><LineupTab league={league} onSaveRanking={onSaveRanking} hideWeather /></div>}
    </div>
  );
}

function UpdateRoster({ league, changes, checked, onRefresh, onOpenAccount, onDone }) {
  const push = useMemo(() => buildPush(league, changes, checked), [league, changes, checked]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const send = async () => {
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
      if (push.reserve) {
        try {
          const r = await api.pushReserve(league.id, push.reserve);
          out.push({ label: "Injured reserve", ok: r.ok, verified: r.verified, detail: r.detail });
        } catch (e) {
          out.push({ label: "Injured reserve", ok: false, detail: e.message });
        }
      }
    } finally {
      setResults(out);
      setBusy(false);
      setConfirming(false);
      if (out.some((o) => o.ok)) {
        onDone();
        onRefresh?.();
      }
    }
  };
  return (
    <div data-update-roster>
      <PrivateGate league={league} group="roster" onOpenAccount={onOpenAccount}>
        {checked.size === 0 && !results ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-sm">
            Nothing approved yet. Tick changes on the Proposed changes tab.
          </div>
        ) : (
          <div className="space-y-2">
            {checked.size > 0 && (
              <>
                <div style={{ color: C.textMuted }} className="text-xs px-1">Approved changes</div>
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
                  <ConfirmPush title="Send these changes to Sleeper?" lines={push.summary} buttonLabel="Yes, update my roster" busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note="Sleeper is then asked for the roster back to check it. The lineup is written to both your roster and this week's matchup. Moving a player to IR is an untested Sleeper call — it is reported honestly if it doesn't take." />
                )}
              </>
            )}
            <PushResults results={results} />
          </div>
        )}
      </PrivateGate>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.0 — League page: settings change log                            */
/* ------------------------------------------------------------------ */
function LeaguePage({ league, onClearVariances, onOpenAccount }) {
  const lp = league.leaguePage;
  const items = lp?.items || [];
  const open = items.filter((i) => !i.cleared);
  return (
    <div className="px-4 py-3 space-y-2" data-league-page>
      <div style={{ color: C.textMuted }} className="text-xs px-1">Settings change log — who changed which league setting, with old and new values. Highlighted yellow on the league until you clear it.</div>
      <PrivateGate league={league} onOpenAccount={onOpenAccount}>
        {lp?.error && <div style={{ color: C.major }} className="text-xs px-1">Couldn't read the log from Sleeper: {lp.error}</div>}
        {items.length === 0 && !lp?.error ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-sm">No settings changes recorded.</div>
        ) : (
          <>
            {open.length > 0 && (
              <div className="flex justify-end">
                <button type="button" onClick={() => onClearVariances(open.map((i) => leagueLogKey(league, i)))} style={{ color: C.minor, border: `1px solid ${C.minor}66` }} className="rounded-md px-2.5 py-1 text-xs" data-clear-league-log>
                  Clear {open.length} change{open.length === 1 ? "" : "s"}
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              {items.map((it) => (
                <div key={it.id} data-log-item={it.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${it.cleared ? C.border : C.minor}` }} className="rounded-md px-3 py-2">
                  <div style={{ color: it.cleared ? C.textMuted : C.text }} className="text-sm">{it.text}</div>
                  {it.at && <div style={{ color: C.textFaint }} className="text-[11px]">{new Date(it.at).toLocaleString()}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </PrivateGate>
    </div>
  );
}
const leagueLogKey = (league, it) => varianceKey(league.id, league.week, "league", "Settings change", `log ${it.id}`);

/* ------------------------------------------------------------------ */
/*  v3.0 — Trade offers (inbox + your own outstanding offers)           */
/* ------------------------------------------------------------------ */
function OfferCard({ o, kind, league, onRefresh, onOpenAccount }) {
  const [state, setState] = useState({ confirming: false, busy: false, result: null });
  const side = (players, picks) => [...(players || []).map((p) => `${p.name || p.id}${p.pos ? ` (${p.pos})` : ""}`), ...(picks || [])].join(", ") || "nothing";
  const reject = async () => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const r = await api.rejectTrade(league.id, o.id, o.leg ?? league.week);
      setState({ confirming: false, busy: false, result: { ok: r.ok, verified: r.ok, detail: r.detail } });
      if (r.ok) onRefresh?.();
    } catch (e) {
      setState({ confirming: false, busy: false, result: { ok: false, detail: e.message } });
    }
  };
  const withdraw = async () => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const r = await api.withdrawTrade(league.id, o.id, o.leg ?? league.week);
      setState({ confirming: false, busy: false, result: { ok: r.ok, verified: r.verified, detail: r.detail } });
      if (r.ok) onRefresh?.();
    } catch (e) {
      setState({ confirming: false, busy: false, result: { ok: false, detail: e.message } });
    }
  };
  const color = kind === "outgoing" && o.stale ? C.major : kind === "incoming" && !o.cleared ? C.minor : C.border;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}` }} className="rounded-md px-3 py-2.5 space-y-1.5" data-offer={o.id} data-offer-kind={kind}>
      <div style={{ color: C.textFaint }} className="text-[11px]">{kind === "incoming" ? "From" : "To"} {o.partner || "another team"}{o.ageDays != null ? ` · ${o.ageDays} day${o.ageDays === 1 ? "" : "s"} ago` : ""}</div>
      <div style={{ color: C.text }} className="text-sm">You get: <b>{side(o.get, o.getPicks)}</b></div>
      <div style={{ color: C.text }} className="text-sm">You give: <b>{side(o.give, o.givePicks)}</b></div>
      {kind === "outgoing" && o.stale && <div style={{ color: C.major }} className="text-xs">Stale — {o.stale}</div>}
      {kind === "outgoing" && (
        <PrivateGate league={league} group="trades" onOpenAccount={onOpenAccount}>
          {!state.confirming && !state.result?.ok && (
            <button type="button" onClick={() => setState((s) => ({ ...s, confirming: true }))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-withdraw-trade>
              Withdraw this offer
            </button>
          )}
          {state.confirming && <ConfirmPush title="Withdraw this trade offer in Sleeper?" lines={[`Withdraw your offer to ${o.partner || "the other team"}: you give ${side(o.give, o.givePicks)}; you get ${side(o.get, o.getPicks)}`]} buttonLabel="Yes, withdraw it" busy={state.busy} onConfirm={withdraw} onCancel={() => setState((s) => ({ ...s, confirming: false }))} note="Withdrawing through Sleeper's private API is untested. The offer is read back afterwards, and this says so if it is still open." />}
          {state.result && <PushResults results={[{ label: "Withdraw offer", ...state.result }]} />}
        </PrivateGate>
      )}
      {kind === "incoming" && (
        <PrivateGate league={league} group="trades" onOpenAccount={onOpenAccount}>
          {!state.confirming && !state.result?.ok && (
            <button type="button" onClick={() => setState((s) => ({ ...s, confirming: true }))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-reject-trade>
              Reject this offer
            </button>
          )}
          {state.confirming && <ConfirmPush title="Reject this trade offer in Sleeper?" lines={[`Reject ${o.partner || "the"} offer: you get ${side(o.get, o.getPicks)}; you give ${side(o.give, o.givePicks)}`]} buttonLabel="Yes, reject it" busy={state.busy} onConfirm={reject} onCancel={() => setState((s) => ({ ...s, confirming: false }))} note="This can't be undone from here." />}
          {state.result && <PushResults results={[{ label: "Reject offer", ...state.result }]} />}
        </PrivateGate>
      )}
    </div>
  );
}

function TradeOffers({ league, onRefresh, onOpenAccount }) {
  const pi = league.privateInfo;
  if (!pi?.configured) {
    return (
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-offers-hint>
        Trade offers waiting on you (and all your own outstanding offers) appear here once you add your Sleeper token under Account → Sleeper access.
        {onOpenAccount && <> <button type="button" onClick={onOpenAccount} style={{ color: C.brand }} className="underline">Set up</button></>}
      </div>
    );
  }
  if (pi.readsOff) {
    return (
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-offers-hint>
        Trade offers are hidden because reading from Sleeper is switched off (Account → Sleeper access).
      </div>
    );
  }
  const T = league.tradeOffers || league.privateInfo?.trades || { incoming: [], outgoing: [] };
  if (T.error) return <div style={{ color: C.minor }} className="text-xs px-1 pb-2">Couldn't read trade offers from Sleeper: {T.error}</div>;
  if (pi.empty) return null;
  const inc = T.incoming || [];
  const out = T.outgoing || [];
  return (
    <div className="pb-2" data-offers>
      <SectionLabel>Offers waiting on you — {inc.length}</SectionLabel>
      {inc.length === 0 ? <div style={{ color: C.textMuted }} className="text-sm px-1">No incoming offers.</div> : <div className="space-y-1.5">{inc.map((o) => <OfferCard key={o.id} o={o} kind="incoming" league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />)}</div>}
      <SectionLabel>Your outstanding offers — {out.length}</SectionLabel>
      {out.length === 0 ? <div style={{ color: C.textMuted }} className="text-sm px-1">None outstanding.</div> : <div className="space-y-1.5">{out.map((o) => <OfferCard key={o.id} o={o} kind="outgoing" league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />)}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.0 — Account: Sleeper access (token, allow changes)               */
/* ------------------------------------------------------------------ */
function SleeperAccessPanel() {
  const [st, setSt] = useState(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api.getPrivateStatus().then(setSt).catch((e) => setMsg(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (fn, okMsg) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      setToken("");
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2.5" data-sleeper-access>
      <div style={{ color: C.textMuted }} className="text-xs">
        Optional. Lets the app read your trade offers and league settings log, and — only if you switch it on — push lineup changes, reject trades and enter waiver claims. It uses Sleeper's private, undocumented API with your login token. That API can change without notice and Sleeper's terms arguably restrict automation, so it's off until you turn it on. The token is stored encrypted on your server and never sent back to the browser.
      </div>
      {!st ? (
        <div style={{ color: C.textMuted }} className="text-xs">Loading…</div>
      ) : st.configured ? (
        <>
          <div style={{ color: C.ok }} className="text-xs">Connected{st.sleeperUsername ? ` as ${st.sleeperUsername}` : ""}{st.verifiedAt ? ` · verified ${new Date(st.verifiedAt).toLocaleDateString()}` : ""}.</div>
          {[
            ["reads", "Read from Sleeper", "Trade offers, queued waiver claims and the League change log. Off = none of these are fetched or shown."],
            ["roster", "Roster changes", "Push lineup changes and IR moves."],
            ["claims", "Waiver claims", "Submit and cancel waiver claims."],
            ["trades", "Trades", "Reject incoming offers and withdraw your own."],
          ].map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-sm" style={{ color: C.text }}>
              <input type="checkbox" checked={Boolean(st.perms?.[key])} disabled={busy} onChange={(e) => act(() => api.setPrivatePerms({ [key]: e.target.checked }))} className="mt-1" data-perm={key} />
              <span>{label}<span style={{ color: C.textMuted }} className="block text-xs">{hint}{key !== "reads" ? " Every push still shows exactly what it will send and asks you to confirm." : ""}</span></span>
            </label>
          ))}
          <button type="button" disabled={busy} onClick={() => act(() => api.clearPrivateToken(), "Token removed.")} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-remove-token>Remove token</button>
          {st.log?.length > 0 && (
            <div>
              <div style={{ color: C.textFaint }} className="text-[11px] pb-1">Recent changes sent to Sleeper</div>
              {st.log.slice(0, 8).map((l, i) => (
                <div key={i} style={{ color: l.ok ? C.textMuted : C.major }} className="text-[11px]">{new Date(l.at).toLocaleString()} · {l.action.replace(/_/g, " ")} · {l.ok ? "ok" : "failed"}{l.detail ? ` — ${l.detail}` : ""}</div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ color: C.textMuted }} className="text-xs">In Sleeper's website, open the browser's developer tools → Application → Local storage → sleeper.com → <code>token</code>, and paste its value here.</div>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Sleeper token" autoComplete="off" style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="Sleeper token" data-token-input />
          <button type="button" disabled={busy || token.trim().length < 20} onClick={() => act(() => api.setPrivateToken(token), "Connected. Reading is on; every kind of change to Sleeper is still switched off.")} style={{ background: C.brand, color: C.text, opacity: busy || token.trim().length < 20 ? 0.5 : 1 }} className="rounded-md px-3 py-1.5 text-sm" data-save-token>Verify &amp; save</button>
        </>
      )}
      {msg && <div style={{ color: C.minor }} className="text-xs">{msg}</div>}
    </div>
  );
}

const TAB_COMPONENTS = { roster: RosterPage, waiver: WaiverTab, trade: TradeTab, injury: InjuryTab, league: LeaguePage, odds: SeasonOutlookTab };

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


/* ------------------------------------------------------------------ */
/*  v3.2 — CBS pick'em: account panel (login, pools, recipe, switches)  */
/* ------------------------------------------------------------------ */
const RECIPE_EXAMPLE = `{
  "login":  { "url": "", "method": "POST", "contentType": "form", "body": "email={{email}}&password={{password}}", "successIncludes": "" },
  "submit": { "url": "", "method": "POST", "contentType": "form", "body": "", "successIncludes": "" },
  "games":    { "url": "", "idRegex": "" },
  "readback": { "url": "", "pickRegex": "" },
  "teamMap": {}
}`;
function CbsPanel() {
  const [st, setSt] = useState(null);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [recipeText, setRecipeText] = useState("");
  const [poolsText, setPoolsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(
    () =>
      api.getCbsStatus().then((d) => {
        setSt(d);
        setRecipeText((t) => t || (d.recipe && Object.keys(d.recipe).some((k) => k !== "teamMap") ? JSON.stringify(d.recipe, null, 2) : ""));
        setPoolsText((t) => t || (d.pools || []).map((p) => `${d.engine === "native" ? `https://picks.cbssports.com/football/pickem/pools/${p.id}${p.entryId ? `?entryId=${p.entryId}` : ""}` : p.id} ${p.name === p.id ? "" : p.name}`.trim()).join("\n"));
      }).catch((e) => setMsg(e.message)),
    []
  );
  useEffect(() => {
    load();
  }, [load]);
  const act = async (fn, okMsg) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (okMsg) setMsg(typeof okMsg === "function" ? okMsg(r) : okMsg);
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const parsePools = () =>
    poolsText.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, ...rest] = l.split(/\s+/);
      const old = (st?.pools || []).find((p) => p.id === id || id.includes(p.id));
      return { id, url: id, name: rest.join(" ") || old?.name || id, enabled: old ? old.enabled : true, entryId: old?.entryId || null };
    });
  const savePools = () => act(() => api.saveCbsSettings({ pools: parsePools() }), "Pools saved.");
  const saveRecipe = () => {
    let r;
    try {
      r = JSON.parse(recipeText || "{}");
    } catch {
      return setMsg("The recipe isn't valid JSON.");
    }
    return act(() => api.saveCbsSettings({ recipe: r, pools: parsePools() }), "Recipe and pools saved.");
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2.5" data-cbs-panel>
      <div style={{ color: C.textMuted }} className="text-xs">
        Optional. Auto mode sends your Pick'em picks to your CBS pick'em pools about an hour before each kickoff slot, and switches itself off if you change a pick on CBS. CBS has no public API, so this signs in with your CBS email and password (stored encrypted on your server, never sent back to the browser) and uses the same requests CBS's own site makes. CBS's terms may not allow automation, it can stop working whenever CBS changes its site or blocks scripted sign-ins, and it has not yet been tried against the real CBS — use "Test login" first. It is off until you switch it on, and every push is logged.
      </div>
      {!st ? (
        <div style={{ color: C.textMuted }} className="text-xs">Loading…</div>
      ) : (
        <>
          {st.configured ? (
            <div style={{ color: C.ok }} className="text-xs">Login saved for {st.email}.</div>
          ) : (
            <div className="space-y-1.5">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="CBS email" autoComplete="off" style={inputStyle} className="w-full rounded-md px-2.5 py-1.5 text-xs" data-cbs-email />
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="CBS password" autoComplete="new-password" style={inputStyle} className="w-full rounded-md px-2.5 py-1.5 text-xs" data-cbs-password />
              <button type="button" disabled={busy || !email || !pw} onClick={() => act(async () => { await api.saveCbsAccount(email, pw); setPw(""); }, "Login saved (encrypted).")} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-account>Save login</button>
            </div>
          )}
          {st.configured && (
            <>
              <label className="flex flex-col gap-0.5 text-xs" style={{ color: C.textMuted }}>
                {st.engine === "native" ? "Pools (one per line: paste the address of the pool's picks page from your browser — it contains /pools/… and ?entryId=… — then an optional name)" : "Pools (one per line: pool id, then an optional name)"}
                <textarea value={poolsText} onChange={(e) => setPoolsText(e.target.value)} rows={3} style={inputStyle} className="rounded-md px-2.5 py-1.5 text-xs font-mono" data-cbs-pools />
              </label>
              {st.engine === "recipe" && (
                <label className="flex flex-col gap-0.5 text-xs" style={{ color: C.textMuted }}>
                  Request recipe (JSON from your captured requests)
                  <textarea value={recipeText} onChange={(e) => setRecipeText(e.target.value)} rows={9} placeholder={RECIPE_EXAMPLE} style={inputStyle} className="rounded-md px-2.5 py-1.5 text-[11px] font-mono" data-cbs-recipe />
                </label>
              )}
              <div className="flex gap-2 flex-wrap">
                {st.engine === "recipe" ? (
                  <button type="button" disabled={busy} onClick={saveRecipe} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-recipe>Save recipe &amp; pools</button>
                ) : (
                  <button type="button" disabled={busy} onClick={savePools} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-pools>Save pools</button>
                )}
                <button type="button" disabled={busy || !st.recipeReady} onClick={() => act(() => api.testCbsLogin(), (r) => `${r.ok ? "" : "Login test failed: "}${r.detail}${r.cookieNames?.length ? ` Cookies received (names only): ${r.cookieNames.join(", ")}.` : ""}${r.warnings?.length ? ` Note: ${r.warnings.join(" ")}` : ""}`)} style={{ color: C.text, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-xs" data-cbs-login-test>Test login</button>
              </div>
              <label className="flex items-start gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.enabled} disabled={busy || !st.recipeReady || !(st.pools || []).length} onChange={(e) => act(() => api.saveCbsSettings({ enabled: e.target.checked }))} className="mt-1" data-cbs-enabled />
                <span>Auto mode<span style={{ color: C.textMuted }} className="block text-xs">Sends your picks about 60 minutes before each kickoff slot; never for a game that has started. Switches itself off if you change a pick on CBS (the app looks at CBS about every 30 minutes while auto mode is on). Needs at least one pool.</span></span>
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.paused} disabled={busy} onChange={(e) => act(() => api.saveCbsSettings({ paused: e.target.checked }))} data-cbs-paused />
                Pause (keeps your settings, sends nothing)
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.notify} disabled={busy} onChange={(e) => act(() => api.saveCbsSettings({ notify: e.target.checked }))} data-cbs-notify />
                Notify me after every push (success or failure)
              </label>
              {st.alert && (
                <div style={{ color: C.minor, border: `1px solid ${C.minor}55` }} className="rounded-md px-2.5 py-1.5 text-xs" data-cbs-alert>{st.alert.detail}</div>
              )}
              {st.engine === "native" && (
                <details className="text-xs" style={{ color: C.textMuted }}>
                  <summary className="cursor-pointer">Advanced: values copied from CBS's site</summary>
                  <div className="space-y-1.5 pt-1.5">
                    <div>If CBS changes its site these may need updating. The sign-in id is re-discovered automatically when it stops working.</div>
                    <div className="font-mono text-[10px] break-all">sign-in id: {st.native?.nextActionId}</div>
                    <div className="font-mono text-[10px] break-all">picks-page query: {st.native?.picksPageHash}</div>
                    <div className="font-mono text-[10px] break-all">save query: {st.native?.saveHash}</div>
                    <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ engine: "recipe" }), "Switched to the older request-recipe mode.")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-2.5 py-1 text-xs">Use the older request-recipe mode instead</button>
                  </div>
                </details>
              )}
              {st.engine === "recipe" && (
                <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ engine: "native" }), "Switched back to the built-in CBS mode.")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-2.5 py-1 text-xs">Use the built-in CBS mode</button>
              )}
              {!st.verifiedOnce && (st.pools || []).length > 0 && (
                <div style={{ color: C.minor }} className="text-xs" data-cbs-testonly>
                  First run: only the first pool ({(st.pools.find((p) => p.id === st.testPoolId) || st.pools[0]).name}) is used until a push is read back from CBS{st.hasReadback ? "" : " (no read-back is set up, so check that pool on CBS yourself)"}.{" "}
                  <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ verifiedOnce: true }), "All pools will be used from now on.")} style={{ color: C.brand }} className="underline" data-cbs-trust>I checked it — use all pools</button>
                </div>
              )}
              <button type="button" disabled={busy} onClick={() => act(() => api.clearCbsAccount(), "CBS login removed and auto-push switched off.")} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-cbs-remove>Remove CBS login</button>
              {(st.log || []).length > 0 && (
                <div data-cbs-log>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide mb-1">Recent pushes</div>
                  <div className="space-y-1">
                    {st.log.slice(0, 12).map((r) => (
                      <div key={r.id} style={{ color: r.ok ? C.textMuted : C.major }} className="text-[11px]">
                        {new Date(r.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · {r.mode}{r.poolId ? ` · pool ${r.poolId}` : ""} · {r.ok ? "ok" : "FAILED"} — {r.detail}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
      {msg && <div style={{ color: C.textMuted }} className="text-xs" data-cbs-msg>{msg}</div>}
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
        <SectionLabel>Sleeper access (optional)</SectionLabel>
        <div className="pt-1.5"><SleeperAccessPanel /></div>
      </div>
      <div>
        <SectionLabel>CBS pick'em push (optional)</SectionLabel>
        <div className="pt-1.5"><CbsPanel /></div>
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

/* ------------------------------------------------------------------ */
/*  PROJECTION ACCURACY (v2.5)                                         */
/* ------------------------------------------------------------------ */
const SRC_NAME = { V: "Vegas", T: "Tank01", S: "Sleeper", E: "ESPN" };

function Select({ value, onChange, options, label }) {
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

function Toggle({ checked, onChange, children }) {
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

/* ------------------------------------------------------------------ */
/*  MY PERFORMANCE (v3.3)                                              */
/* ------------------------------------------------------------------ */
const signed = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}`);
const goodBad = (n) => (n > 0 ? C.ok : n < 0 ? C.major : C.textMuted);

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
function AnalyticsScreen({ authUser, onDvpChange }) {
  const [view, setView] = useState("matchups");
  return (
    <div>
      <div className="flex gap-1.5 px-4 pt-3">
        {[
          ["matchups", "Matchup rankings"],
          ["accuracy", "Projection accuracy"],
          ["performance", "My performance"],
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
      {view === "accuracy" ? <AccuracyScreen authUser={authUser} /> : view === "performance" ? <PerformanceScreen /> : <MatchupRankings onDvpChange={onDvpChange} authUser={authUser} />}
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

/* ------------------------------------------------------------------ */
/*  GAME DAY (v2.6)                                                     */
/* ------------------------------------------------------------------ */
const CAT_COLOR = { for: C.ok, balanced: C.minor, against: C.major };
const CAT_LABEL = { for: "Cheer for", balanced: "Balanced", against: "Cheer against" };

function GameDaySettings({ data, onSaved }) {
  const [s, setS] = useState(() => ({
    ratio: data.settings.ratio,
    closeWeighting: data.settings.closeWeighting,
    closeMargin: data.settings.closeMargin,
    closeFloor: data.settings.closeFloor,
    leagues: Object.fromEntries(data.leagues.map((l) => [l.id, { importance: l.importance ?? 1, include: l.include !== false }])),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = { background: C.surface, border: `1px solid ${C.border}`, color: C.text };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveGameDaySettings(s);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const setLeague = (id, patch) => setS((prev) => ({ ...prev, leagues: { ...prev.leagues, [id]: { ...prev.leagues[id], ...patch } } }));
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-3">
      <div style={{ color: C.textMuted }} className="text-xs">
        Importance weights each league (league dues, or any relative numbers). A player who counts 200 for you and 2 × 100 against you is balanced.
      </div>
      <div className="space-y-1.5">
        {data.leagues.map((l) => (
          <div key={l.id} className="flex items-center gap-2">
            <input type="checkbox" checked={s.leagues[l.id]?.include !== false} onChange={(e) => setLeague(l.id, { include: e.target.checked })} aria-label={`Include ${l.name}`} />
            <span style={{ color: C.text }} className="text-xs flex-1 truncate">{l.name}</span>
            <input
              type="number"
              min="0"
              value={s.leagues[l.id]?.importance ?? 1}
              onChange={(e) => setLeague(l.id, { importance: e.target.value })}
              style={field}
              className="w-20 rounded px-2 py-1 text-xs text-right"
              aria-label={`Importance for ${l.name}`}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]" style={{ color: C.textMuted }}>
        <label className="flex flex-col gap-0.5">
          For/against ratio (×)
          <input type="number" step="0.1" min="1" value={s.ratio} onChange={(e) => setS({ ...s, ratio: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" />
        </label>
        <label className="flex items-center gap-2 pt-4">
          <input type="checkbox" checked={s.closeWeighting} onChange={(e) => setS({ ...s, closeWeighting: e.target.checked })} />
          Close-matchup weighting
        </label>
        <label className="flex flex-col gap-0.5">
          Close margin (%)
          <input type="number" min="1" value={s.closeMargin} onChange={(e) => setS({ ...s, closeMargin: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" disabled={!s.closeWeighting} />
        </label>
        <label className="flex flex-col gap-0.5">
          Blowout minimum (0–1)
          <input type="number" step="0.05" min="0" max="1" value={s.closeFloor} onChange={(e) => setS({ ...s, closeFloor: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" disabled={!s.closeWeighting} />
        </label>
      </div>
      <div style={{ color: C.textFaint }} className="text-[11px]">
        "For" when a player's for-weight is at least {s.ratio}× his against-weight; "against" the other way round; otherwise balanced. With close-matchup weighting, a league within the close margin counts fully and a blowout drops toward the minimum.
      </div>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      <PrimaryButton onClick={save} loading={busy}>{busy ? "Saving…" : "Save settings"}</PrimaryButton>
    </div>
  );
}

function CheerRow({ p, ratio }) {
  const color = CAT_COLOR[p.category];
  const x = Math.min(94, Math.max(6, (1 - p.lean) * 100));
  const forEdge = (1 / (Number(ratio) + 1)) * 100; // lean ≥ ratio/(ratio+1) => x ≤ 1/(ratio+1)
  const live = p.state === "in";
  return (
    <div className="py-2" style={{ borderTop: `1px solid ${C.border}` }}>
      <div className="relative h-7 rounded" style={{ background: C.surface }}>
        <div className="absolute inset-y-0 left-0 rounded-l" style={{ width: `${forEdge}%`, background: C.okBg }} />
        <div className="absolute inset-y-0 right-0 rounded-r" style={{ width: `${forEdge}%`, background: C.majorBg }} />
        <div className="absolute inset-y-0" style={{ left: "50%", width: 1, background: C.border }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
          style={{ left: `${x}%`, background: C.bg, border: `1px solid ${color}`, color: C.text, fontWeight: p.stake >= 2 ? 600 : 400, opacity: 0.55 + Math.min(0.45, p.stake / 10) }}
          title={`For ${p.F} · Against ${p.A}`}
        >
          {p.name}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-1 px-0.5">
        <Headshot player={p} size={20} />
        <span style={{ color: C.textFaint }} className="text-[10px]">{p.pos}{p.team ? ` · ${p.team}` : ""}{p.opponent ? ` vs ${p.opponent}` : ""}</span>
        <span style={{ color: live ? C.brand : C.textFaint }} className="text-[10px]">{p.statusDetail || p.kickoffLabel || ""}</span>
        <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-[11px] font-medium">
          {p.points != null ? `${p.points.toFixed(1)} pts` : p.proj != null ? `proj ${p.proj.toFixed(1)}` : ""}
        </span>
      </div>
      {/* v2.9: leagues you cheer FOR sit on the left, leagues you cheer AGAINST on the right. */}
      {p.leagues.length > 0 && (
        <div className="flex items-start justify-between gap-2 mt-1 px-0.5">
          <div className="flex flex-wrap gap-1" data-chips="for">
            {p.leagues.filter((l) => l.side === "for").map((l, i) => (
              <span key={i} style={{ color: C.ok, border: `1px solid ${C.ok}55` }} className="text-[10px] rounded px-1.5 py-0.5">+ {l.league} ({l.weight})</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 justify-end" data-chips="against">
            {p.leagues.filter((l) => l.side !== "for").map((l, i) => (
              <span key={i} style={{ color: C.major, border: `1px solid ${C.major}55` }} className="text-[10px] rounded px-1.5 py-0.5">− {l.league} ({l.weight})</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GameDayScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [slot, setSlot] = useState("all");
  const [cat, setCat] = useState("all");
  // v2.9: tap league cards to show only those leagues' starters (yours + your opponents'); none selected = all.
  const [leagueSel, setLeagueSel] = useState(() => new Set());
  const toggleLeague = (id) =>
    setLeagueSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const load = useCallback(() => {
    api
      .getGameDay()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60 * 1000); // live points during games (Sleeper + ESPN, no Tank01 calls)
    return () => clearInterval(id);
  }, [load]);

  if (error && !data) return <div className="px-4 py-6"><ErrorScreen message={error} /></div>;
  if (!data) return <BootstrapScreen />;
  const slots = [...new Set(data.players.map((p) => p.kickoffLabel).filter(Boolean))];
  const inLeagues = (p) => leagueSel.size === 0 || p.leagues.some((l) => leagueSel.has(l.leagueId));
  const shown = data.players.filter((p) => inLeagues(p) && (slot === "all" || p.kickoffLabel === slot) && (cat === "all" || p.category === cat));
  const counts = { for: 0, balanced: 0, against: 0 };
  data.players.filter(inLeagues).forEach((p) => counts[p.category]++);
  // Group by game time slot, earliest first, with a header between groups.
  const slotGroups = [];
  [...shown]
    .sort((a, b) => (a.kickoff ?? Infinity) - (b.kickoff ?? Infinity))
    .forEach((p) => {
      const label = p.kickoffLabel || "Time TBD";
      let g = slotGroups.find((x) => x.label === label);
      if (!g) slotGroups.push((g = { label, players: [] }));
      g.players.push(p);
    });

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div style={{ color: C.textMuted }} className="text-xs">Week {data.week} · updated {new Date(data.updatedAt).toLocaleTimeString()}</div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          <Settings2 size={13} /> {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>
      {showSettings && (
        <GameDaySettings
          data={data}
          onSaved={() => {
            setShowSettings(false);
            load();
          }}
        />
      )}
      <div className="space-y-1.5">
        {data.leagues.map((l) => (
          <button
            type="button"
            key={l.id}
            onClick={() => toggleLeague(l.id)}
            aria-pressed={leagueSel.has(l.id)}
            data-gd-league={l.id}
            style={{ background: leagueSel.has(l.id) ? C.surfaceRaised : C.surface, border: `1px solid ${leagueSel.has(l.id) ? C.brand : C.border}`, opacity: l.include === false ? 0.5 : 1 }}
            className="rounded-md px-3 py-2 w-full text-left"
          >
            <div className="flex items-center justify-between gap-2">
              <span style={{ color: C.text }} className="text-xs font-medium truncate">{l.name}</span>
              <span style={{ color: C.textFaint }} className="text-[10px] shrink-0">×{l.importance ?? 1}{data.settings.closeWeighting && l.closeFactor != null ? ` · close ×${l.closeFactor}` : ""}</span>
            </div>
            {l.note ? (
              <div style={{ color: C.textFaint }} className="text-[11px]">{l.note}</div>
            ) : (
              <div style={{ color: C.textMuted, fontVariantNumeric: "tabular-nums" }} className="text-[11px]">
                {l.myTeam} {l.myPoints?.toFixed(1)} – {l.oppPoints?.toFixed(1)} {l.oppTeam} · proj {l.myProjected?.toFixed(1)} – {l.oppProjected?.toFixed(1)}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Select label="Game slot" value={slot} onChange={setSlot} options={[{ value: "all", label: "All games" }, ...slots.map((s) => ({ value: s, label: s }))]} />
        <div className="flex gap-1.5 pt-3.5">
          {["all", "for", "balanced", "against"].map((c) => (
            <Toggle key={c} checked={cat === c} onChange={() => setCat(c)}>
              {c === "all" ? `All ${data.players.length}` : `${CAT_LABEL[c]} ${counts[c]}`}
            </Toggle>
          ))}
        </div>
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-wide px-1" style={{ color: C.textFaint }}>
        <span style={{ color: C.ok }}>← Cheer for</span>
        <span>Balanced</span>
        <span style={{ color: C.major }}>Cheer against →</span>
      </div>
      {shown.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No players for these filters.</div>
      ) : (
        <div>
          {slotGroups.map((g) => (
            <div key={g.label} data-slot-group={g.label}>
              <div style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif", borderBottom: `1px solid ${C.border}` }} className="text-[11px] tracking-wide pt-3 pb-1">{g.label}</div>
              {g.players.map((p) => <CheerRow key={p.id} p={p} ratio={data.settings.ratio} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PICK'EM (v2.7)                                                      */
/* ------------------------------------------------------------------ */
// Team colours [main, alternate] — the alternate is used when both teams' main colours look alike.
const TEAM_COLORS = {
  ARI: ["#97233F", "#FFB612"], ATL: ["#A71930", "#000000"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"],
  CAR: ["#0085CA", "#101820"], CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#000000"], CLE: ["#311D00", "#FF3C00"],
  DAL: ["#003594", "#869397"], DEN: ["#FB4F14", "#002244"], DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"],
  HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#A2AAAD"], JAX: ["#006778", "#D7A22A"], KC: ["#E31837", "#FFB81C"],
  LV: ["#000000", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"],
  MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#C60C30"], NO: ["#D3BC8D", "#101820"], NYG: ["#0B2265", "#A71930"],
  NYJ: ["#125740", "#FFFFFF"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#FFB612", "#101820"], SF: ["#AA0000", "#B3995D"],
  SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#34302B"], TEN: ["#0C2340", "#4B92DB"], WAS: ["#5A1414", "#FFB612"],
};
function hexDist(a, b) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
}
function luminance(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function barColors(away, home) {
  const a = TEAM_COLORS[away] || ["#5E7570", "#8FA39E"];
  const h = TEAM_COLORS[home] || ["#4A8FC2", "#8FA39E"];
  // A near-black main colour disappears on the dark card, so use the alternate.
  let ac = luminance(a[0]) < 0.08 ? a[1] : a[0];
  let hc = luminance(h[0]) < 0.08 ? h[1] : h[0];
  if (hexDist(ac, hc) < 90) hc = h[1]; // too similar — home switches to its alternate colour
  if (hexDist(ac, hc) < 90) ac = a[1];
  return { away: ac, home: hc };
}
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function RedDot({ title }) {
  return <span title={title} aria-label={title} className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: C.major }} />;
}

function PickCard({ g, onSeen, onChoose }) {
  const colors = barColors(g.away, g.home);
  const awayP = g.homeProb == null ? 0.5 : 1 - g.homeProb;
  const textOn = (hex) => (luminance(hex) > 0.6 ? "#10171A" : "#FFFFFF");
  const final = g.state === "post";
  // v3.4: the pick that counts (yours if you chose, else the app's) is boxed — green = favourite, yellow = underdog.
  const shown = g.final || g.pick || null;
  const kind = !shown ? null : shown === g.underdog ? "underdog" : "favourite";
  const boxColor = kind === "underdog" ? C.minor : C.ok;
  const boxBg = kind === "underdog" ? C.minorBg : C.okBg;
  const boxFor = (team) => (shown === team ? { outline: `2px solid ${boxColor}`, outlineOffset: "-2px" } : {});
  return (
    <div
      onClick={() => g.changed && onSeen(g.key)}
      style={{ background: C.surface, border: `1px solid ${g.changed ? C.major : C.border}` }}
      className="rounded-lg px-3.5 py-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {g.changed && <RedDot title="Recommendation changed" />}
          <TeamLogo team={g.away} size={22} />
          <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-sm">{g.away} @ {g.home}</span>
          <TeamLogo team={g.home} size={22} />
        </div>
        <span style={{ color: g.state === "in" ? C.brand : C.textFaint }} className="text-[11px] shrink-0">
          {final || g.state === "in" ? `${g.awayScore ?? ""}–${g.homeScore ?? ""} · ${g.statusDetail || ""}` : g.kickoffLabel}
        </span>
      </div>

      <div>
        <div className="flex h-6 rounded overflow-hidden text-[11px] font-semibold" role="img" aria-label={`Win chance: ${g.away} ${pct(awayP)}, ${g.home} ${pct(g.homeProb)}`}>
          <div style={{ width: `${awayP * 100}%`, background: colors.away, color: textOn(colors.away), ...boxFor(g.away) }} className="flex items-center pl-2 min-w-[2.5rem]" data-pick-box={shown === g.away ? kind : undefined}>{g.away} {pct(awayP)}</div>
          <div style={{ width: `${(1 - awayP) * 100}%`, background: colors.home, color: textOn(colors.home), ...boxFor(g.home) }} className="flex items-center justify-end pr-2 min-w-[2.5rem]" data-pick-box={shown === g.home ? kind : undefined}>{pct(g.homeProb)} {g.home}</div>
        </div>
        <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5 flex justify-between">
          <span>{g.source || "no line yet"}{g.homeSpread != null ? ` · ${g.home} ${g.homeSpread > 0 ? "+" : ""}${Math.round(g.homeSpread * 2) / 2}` : ""}</span>
          <span>ESPN FPI: {g.fpiHomeProb != null ? `${g.home} ${pct(g.fpiHomeProb)}` : "—"}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {shown ? (
          <span style={{ background: boxBg, color: boxColor, border: `1px solid ${boxColor}` }} className="text-xs font-semibold rounded px-2 py-0.5" data-pick-label={kind}>
            {g.chosen ? "Your pick" : "App pick"}: {shown} ({kind === "underdog" ? "underdog — upset pick" : "favourite"})
          </span>
        ) : (
          <span style={{ color: C.textFaint }} className="text-xs">No pick yet</span>
        )}
        {g.changed && g.prevPick && <span style={{ color: C.major }} className="text-[11px]">changed from {g.prevPick} — tap to dismiss</span>}
      </div>
      {onChoose && g.state === "pre" && !g.started && (
        <div className="flex items-center gap-1.5 text-[11px]" data-pick-choose={g.key}>
          <span style={{ color: C.textFaint }}>Your pick:</span>
          {[g.away, g.home].map((t) => (
            <button
              key={t}
              type="button"
              onClick={(e) => { e.stopPropagation(); onChoose(g.key, g.chosen === t ? null : t); }}
              style={{ background: (g.final || g.pick) === t ? (t === g.underdog ? C.minor : C.ok) : "transparent", color: (g.final || g.pick) === t ? "#10171A" : C.text, border: `1px solid ${C.border}` }}
              className="rounded px-2 py-0.5 font-semibold"
              data-pick-btn={t}
            >{t}</button>
          ))}
          {g.chosen && <span style={{ color: C.minor }}>your choice (tap again to use the recommendation)</span>}
        </div>
      )}
      {g.reason && g.upset && <div style={{ color: C.textMuted }} className="text-[11px]">{g.reason}</div>}
      {g.weather && !g.weather.indoor && g.weather.temp != null && (
        <div className="flex items-center gap-1.5 flex-wrap" data-pick-weather={g.weather.flag ? "bad" : "ok"}>
          <WeatherChip player={{ weather: g.weather }} />
          {g.weather.flag && <span style={{ color: C.minor }} className="text-[11px]">{g.weather.reasons.join("; ")}</span>}
        </div>
      )}

      {g.underdog && (
        <div>
          <div className="flex justify-between text-[10px]" style={{ color: C.textMuted }}>
            <span>Upset potential ({g.underdog})</span>
            <span title={`odds ${g.upsetParts?.base} · line move ${g.upsetParts?.shift} · articles ${g.upsetParts?.gemini}`}>{g.upsetPotential}/100</span>
          </div>
          <div className="h-1.5 rounded mt-0.5" style={{ background: C.surfaceRaised }}>
            <div className="h-1.5 rounded" style={{ width: `${g.upsetPotential}%`, background: g.upsetPotential >= 60 ? C.major : g.upsetPotential >= 35 ? C.minor : C.textFaint }} />
          </div>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">
            {Math.abs(g.dogShift) >= 0.005
              ? `Line moved ${g.dogShift > 0 ? "toward" : "away from"} ${g.underdog} by ${Math.abs(Math.round(g.dogShift * 100))}% since ${g.openedAt ? new Date(g.openedAt).toLocaleDateString([], { weekday: "short" }) : "the first snapshot"}`
              : "No line movement yet"}
            {g.gemini ? ` · ${g.gemini.upsetMentions} article(s) picking the upset` : ""}
          </div>
        </div>
      )}
      {g.gemini?.note && (
        <div style={{ color: C.textMuted }} className="text-[11px]">
          {g.gemini.note}
          {g.gemini.sources?.length > 0 && <span style={{ color: C.textFaint }}> — {g.gemini.sources.join(", ")}</span>}
        </div>
      )}
    </div>
  );
}


function CbsPushBar({ week, st, reload }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!st || !st.configured || !st.recipeReady || !(st.pools || []).length) return null;
  const run = async (dryRun) => {
    setBusy(true);
    try {
      setOut(await api.pushCbs({ dryRun }));
    } catch (e) {
      setOut({ ok: false, error: e.message });
    } finally {
      setBusy(false);
      setConfirming(false);
      reload?.();
    }
  };
  const setAuto = async (on) => {
    setBusy(true);
    try {
      await api.saveCbsSettings({ enabled: on });
    } catch (e) {
      setOut({ ok: false, error: e.message });
    } finally {
      setBusy(false);
      reload?.();
    }
  };
  const pools = (st.pools || []).filter((p) => p.enabled);
  const autoOn = st.enabled && !st.paused;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2 space-y-1.5 text-xs" data-cbs-bar>
      <div className="flex items-center justify-between gap-2">
        <div style={{ color: C.text }} className="font-medium">CBS pick'em · {autoOn ? "auto mode ON" : st.paused ? "paused" : "auto mode off — you pick"}</div>
        <label className="flex items-center gap-1.5" style={{ color: C.textMuted }}>
          Auto
          <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => setAuto(e.target.checked)} data-cbs-auto-toggle />
        </label>
      </div>
      {st.alert && <div style={{ color: C.minor }} data-cbs-alert>{st.alert.detail}</div>}
      <div style={{ color: C.textMuted }}>
        {autoOn
          ? `Your picks (the recommendation where you haven't chosen) go to CBS about 60 minutes before each kickoff slot. Choosing a pick yourself turns auto mode off; so does changing a pick on CBS.`
          : `Auto mode is off: choose your own picks below. "Push now" sends them (and the recommendation where you haven't chosen) for games that haven't started to ${st.verifiedOnce ? `${pools.length} pool${pools.length === 1 ? "" : "s"}` : "the test pool"}.`}
      </div>
      {!confirming ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => run(true)} style={{ color: C.text, border: `1px solid ${C.border}` }} className="rounded px-2.5 py-1" data-cbs-dry>Preview (reads CBS, sends nothing)</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} style={{ background: C.brand, color: "#fff" }} className="rounded px-2.5 py-1 font-medium" data-cbs-push>Push now…</button>
        </div>
      ) : (
        <ConfirmPush title="Push picks to CBS?" lines={[`Week ${week}: every unstarted game with a pick (only picks that differ from CBS are sent)`, `${st.verifiedOnce ? pools.map((p) => p.name).join(", ") : (pools.find((p) => p.id === st.testPoolId) || pools[0])?.name + " (test pool)"}`]} buttonLabel="Send to CBS" busy={busy} onConfirm={() => run(false)} onCancel={() => setConfirming(false)} />
      )}
      {out && (
        <div style={{ color: out.ok ? C.ok : C.major }} data-cbs-result>
          {out.error ? out.error : out.dryRun ? (out.native ? out.pools.map((q) => `${q.name}: ${q.toSave.length} pick(s) would change on CBS (${q.unchanged} already match${q.unmatched?.length ? `, not found on CBS: ${q.unmatched.join(", ")}` : ""}${q.tiebreaker != null ? `, tiebreaker ${q.tiebreaker}` : ""}); nothing was sent.`).join(" | ") : `Preview: ${out.games.length} game(s) would be sent to ${out.requests.length} pool(s); nothing was sent.`) : out.nothing ? out.detail : (out.results || []).map((r) => `${r.pool}: ${r.ok ? "ok" : "FAILED"} — ${r.detail}`).join(" | ")}
        </div>
      )}
    </div>
  );
}


/* v3.4: You vs the app vs Vegas vs actual results, by week and for the season. */
const fmtRecN = (t) => (t && t.n ? `${t.correct}/${t.n}` : "—");
const fmtRecPct = (t) => (t && t.n ? `${Math.round((t.correct / t.n) * 100)}%` : "");
function PickemPerformance({ onClose }) {
  const [perf, setPerf] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [inclRecon, setInclRecon] = useState(true);
  const load = useCallback(() => {
    api.getPickemPerformance().then((d) => { setPerf(d); setError(null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const setMine = async (week, gameKey, pick) => {
    await api.savePickemChoice({ season: perf.season, week, gameKey, pick });
    load();
  };
  if (error && !perf) return <ErrorScreen message={error} />;
  if (!perf) return <div style={{ color: C.textMuted }} className="text-xs py-6 text-center">Loading results…</div>;
  // optionally leave out weeks whose app picks were only reconstructed
  const weeks = perf.weeks;
  const t = { vegas: { n: 0, correct: 0 }, app: { n: 0, correct: 0 }, mine: { n: 0, correct: 0 }, appUpsets: { n: 0, correct: 0 }, same: { n: 0, mine: 0, app: 0, vegas: 0 } };
  for (const w of weeks) {
    if (!inclRecon && w.appSource === "reconstructed") continue;
    for (const k of ["vegas", "app", "mine", "appUpsets"]) { t[k].n += w[k].n; t[k].correct += w[k].correct; }
    for (const k of ["n", "mine", "app", "vegas"]) t.same[k] += w.same[k];
  }
  const Cell = ({ label, rec }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
      <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{label}</div>
      <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-semibold">{fmtRecN(rec)} <span style={{ color: C.textFaint }} className="text-[11px] font-normal">{fmtRecPct(rec)}</span></div>
    </div>
  );
  return (
    <div className="space-y-3" data-pick-performance>
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Vegas (favourites)" rec={t.vegas} />
        <Cell label="App picks" rec={t.app} />
        <Cell label="Your picks" rec={t.mine} />
        <Cell label="App upset picks" rec={t.appUpsets} />
      </div>
      {t.same.n > 0 && (
        <div style={{ color: C.textMuted }} className="text-[11px]">
          On the {t.same.n} finished games you picked: you {t.same.mine}, app {t.same.app}, Vegas {t.same.vegas} correct.
        </div>
      )}
      <label className="flex items-center gap-1.5 text-[11px]" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={inclRecon} onChange={(e) => setInclRecon(e.target.checked)} data-pick-recon-toggle />
        Include weeks where the app's picks were reconstructed from ESPN odds
      </label>
      {weeks.length === 0 && <div style={{ color: C.textFaint }} className="text-xs">No finished games recorded yet.</div>}
      <div className="space-y-1.5">
        {weeks.map((w) => (
          <div key={w.week} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md" data-pick-week={w.week}>
            <button type="button" onClick={() => setOpen(open === w.week ? null : w.week)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs">
              <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }}>Week {w.week}</span>
              <span style={{ color: C.textMuted, fontVariantNumeric: "tabular-nums" }} className="flex gap-3">
                <span>Vegas {fmtRecN(w.vegas)}</span>
                <span>App {fmtRecN(w.app)}{w.appSource === "reconstructed" ? "~" : ""}</span>
                <span>You {fmtRecN(w.mine)}</span>
              </span>
            </button>
            {open === w.week && (
              <div className="px-3 pb-2 space-y-1">
                {w.appSource !== "stored" && <div style={{ color: C.textFaint }} className="text-[10px]">~ = app picks reconstructed from ESPN odds only; the real board would also use line movement and articles.</div>}
                {w.games.map((g) => (
                  <div key={g.key} className="flex items-center justify-between gap-2 text-[11px]" style={{ color: C.textMuted }} data-pick-perf-game={g.key}>
                    <span style={{ color: C.text }} className="w-20 shrink-0">{g.away} @ {g.home}</span>
                    <span className="w-14 shrink-0">won {g.winner}</span>
                    <span style={{ color: g.vegas === g.winner ? C.ok : C.textMuted }} className="w-14 shrink-0">V {g.vegas || "—"}</span>
                    <span style={{ color: g.app === g.winner ? C.ok : g.appUpset ? C.minor : C.textMuted }} className="w-16 shrink-0">A {g.app || "—"}{g.appUpset ? "↑" : ""}</span>
                    <select
                      value={g.mine || ""}
                      onChange={(e) => setMine(w.week, g.key, e.target.value || null)}
                      style={{ background: C.bg, border: `1px solid ${C.border}`, color: g.mine === g.winner ? C.ok : C.text }}
                      className="rounded px-1 py-0.5 text-[11px]"
                      aria-label={`Your pick ${g.key} week ${w.week}`}
                    >
                      <option value="">You —</option>
                      <option value={g.away}>You {g.away}</option>
                      <option value={g.home}>You {g.home}</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px]">
        V = favourite on the last stored line before kickoff (ESPN's listed odds where no line was stored). A = the app's pick, ↑ = underdog/upset pick. "You" = picks entered in the app; use the drop-down on a finished game to load an earlier pick by hand. Ties are left out.
      </div>
    </div>
  );
}

function PickemScreen({ onChangedCount }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [cbsSt, setCbsSt] = useState(null);
  const [view, setView] = useState("games"); // v3.4: "games" | "performance"
  const [pendingChoice, setPendingChoice] = useState(null); // v3.3: a manual pick made while CBS auto mode is on
  const loadCbs = useCallback(() => api.getCbsStatus().then(setCbsSt).catch(() => {}), []);
  useEffect(() => {
    loadCbs();
  }, [loadCbs]);
  const load = useCallback(() => {
    api.getPickem().then((d) => {
      setData(d);
      setError(null);
      onChangedCount?.(d.changedCount);
    }).catch((err) => setError(err.message));
  }, [onChangedCount]);
  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);
  const saveSettings = async (patch) => {
    await api.savePickemSettings({ ...data.settings, ...patch });
    load();
  };
  const seen = async (gameKey) => {
    await api.markPickemSeen(data.season, data.week, gameKey);
    load();
  };
  const applyChoice = async (gameKey, pick) => {
    await api.savePickemChoice({ season: data.season, week: data.week, gameKey, pick });
    load();
  };
  const choose = async (gameKey, pick) => {
    // Making a manual pick while auto mode is on needs confirmation, and turns auto mode off.
    if (cbsSt?.configured && cbsSt.enabled && !cbsSt.paused) return setPendingChoice({ gameKey, pick });
    return applyChoice(gameKey, pick);
  };
  const confirmChoice = async () => {
    const pc = pendingChoice;
    setPendingChoice(null);
    await api.saveCbsSettings({ enabled: false }).catch(() => {});
    await applyChoice(pc.gameKey, pc.pick);
    loadCbs();
  };
  const setTiebreaker = async (v) => {
    await api.savePickemChoice({ season: data.season, week: data.week, tiebreaker: v });
    load();
  };
  if (error && !data) return <div className="px-4 py-6"><ErrorScreen message={error} /></div>;
  if (!data) return <BootstrapScreen />;
  const s = data.settings;
  const r = data.record;
  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div style={{ color: C.textMuted }} className="text-xs flex items-center gap-2">
          Week {data.week} · straight-up
          {data.changedCount > 0 && (
            <button onClick={() => seen(null)} className="flex items-center gap-1" style={{ color: C.major }}>
              <RedDot title="Changed picks" /> {data.changedCount} changed — dismiss all
            </button>
          )}
        </div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          <Settings2 size={13} /> {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>
      <div className="flex gap-1.5 text-xs" data-pick-views>
        {[["games", "This week"], ["performance", "Performance"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)} style={{ background: view === k ? C.brand : "transparent", color: view === k ? "#fff" : C.textMuted, border: `1px solid ${C.border}` }} className="rounded-full px-3 py-1 font-medium" data-pick-view={k}>{label}</button>
        ))}
      </div>
      {view === "performance" && <PickemPerformance />}
      {view === "games" && showSettings && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2 text-xs" >
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.upsets !== false} onChange={(e) => saveSettings({ upsets: e.target.checked })} data-pick-upsets-toggle />
            Upset picks (app picks differ from Vegas)
          </label>
          <div className="grid grid-cols-2 gap-2" style={{ color: C.textMuted }}>
            <label className="flex flex-col gap-0.5">Extra upsets need upset potential of at least
              <input type="number" min="20" max="90" defaultValue={s.upsetThreshold ?? 45} onBlur={(e) => saveSettings({ upsetThreshold: e.target.value })} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-1" />
            </label>
          </div>
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.notify} onChange={(e) => saveSettings({ notify: e.target.checked })} />
            Push alert when a recommendation changes before kickoff
          </label>
          <div style={{ color: C.textFaint }} className="text-[11px]">
            The app picks the favourite in every game except the upset picks: always the single game with the highest upset potential, plus up to 3 more at or above the threshold (4 at most). Started games keep the pick made before kickoff. Boxes: green = favourite, yellow = underdog.
          </div>
        </div>
      )}
      {view === "games" && (
      <>
      <div className="grid grid-cols-2 gap-2">
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Season record</div>
          <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-semibold">{r.correct}/{r.games} <span style={{ color: C.textFaint }} className="text-[11px] font-normal">favourites {r.favoritesCorrect}/{r.games}</span></div>
          <div style={{ color: C.textFaint }} className="text-[10px]">This week {r.weekCorrect}/{r.weekGames}</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Tiebreaker</div>
          {data.tiebreaker ? (
            <>
              <div style={{ color: C.text }} className="text-sm font-semibold">{data.tiebreaker.total} total pts</div>
              <div style={{ color: C.textFaint }} className="text-[10px]">{data.tiebreaker.game} · Vegas over/under</div>
            </>
          ) : (
            <div style={{ color: C.textFaint }} className="text-xs">No total posted yet</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: C.textMuted }}>
        <label className="flex items-center gap-1.5">Your tiebreaker total
          <input type="number" min="0" max="200" defaultValue={data.choices?.tiebreaker ?? ""} placeholder={data.tiebreaker ? String(data.tiebreaker.total) : ""} onBlur={(e) => setTiebreaker(e.target.value)} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-0.5 w-16" data-pick-tiebreaker />
        </label>
      </div>
      {pendingChoice && (
        <ConfirmPush
          title="Turn off CBS auto mode?"
          lines={["Choosing a pick yourself switches auto mode off.", "Nothing will be sent to CBS automatically until you turn it back on (or press Push now)."]}
          buttonLabel="Turn off and use my pick"
          onConfirm={confirmChoice}
          onCancel={() => setPendingChoice(null)}
        />
      )}
      <CbsPushBar week={data.week} st={cbsSt} reload={loadCbs} />
      <div style={{ color: C.textFaint }} className="text-[10px] px-1">
        {data.gemini.configured ? (data.gemini.at ? `Article scan (Gemini) ${new Date(data.gemini.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Article scan pending") : "Article scan off — set GEMINI_API_KEY to add upset mentions and game notes"}
      </div>
      <div className="space-y-2.5">
        {data.games.map((g) => (
          <PickCard key={g.key} g={g} onSeen={seen} onChoose={choose} />
        ))}
      </div>
      </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TABS (v2.6)                                                         */
/* ------------------------------------------------------------------ */
const TABS = [
  { key: "leagues", label: "League Management", Icon: ListChecks },
  { key: "gameday", label: "Game Day", Icon: Trophy },
  { key: "pickem", label: "Pick'em", Icon: CheckCircle2 },
  { key: "analytics", label: "Analytics", Icon: TrendingUp },
];
function TabBar({ active, onSelect, dots = {} }) {
  return (
    <div className="flex" style={{ borderBottom: `1px solid ${C.border}`, background: C.bg }}>
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          style={{ color: active === key ? C.text : C.textMuted, borderBottom: `2px solid ${active === key ? C.brand : "transparent"}` }}
          className="flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1.5"
          aria-current={active === key ? "page" : undefined}
        >
          <Icon size={13} />
          {label}
          {dots[key] ? <span className="inline-block w-2 h-2 rounded-full" style={{ background: C.major }} aria-label="Changed picks" /> : null}
        </button>
      ))}
    </div>
  );
}

// Real projection-source status for the header (replaces fixed text).
function sourceStatusLabel(st) {
  const p = st?.projections;
  if (!p) return "Projections: not loaded yet";
  const parts = [`Vegas ${p.counts.V}`, `Tank01 ${p.counts.T}`, `Sleeper ${p.counts.S}`, `ESPN ${p.counts.E}`];
  const t = st.tank01;
  const tank = !t?.configured ? " · Tank01 key not set" : t.rateLimited ? " · Tank01 paused (rate limit)" : t.projectionsAt ? ` · Tank01 data ${new Date(t.projectionsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}, props for ${t.oddsWithProps}/${t.oddsGames} games` : " · no Tank01 data yet";
  return `Projections (players): ${parts.join(" · ")}${tank}`;
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
const BUILD_CONCURRENCY = 2;

// Merge freshly built leagues into the list, keeping the tracked order.
function mergeLeagues(prev, incoming, order) {
  const byId = new Map(prev.map((l) => [l.id, l]));
  for (const l of incoming) byId.set(l.id, l);
  const ids = order && order.length ? order : [...byId.keys()];
  const rest = [...byId.keys()].filter((id) => !ids.includes(id));
  return [...ids, ...rest].map((id) => byId.get(id)).filter(Boolean);
}

export default function App() {
  const [view, setView] = useState({ screen: "bootstrapping" });
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState("just now");
  const [sourceStatus, setSourceStatus] = useState(null);
  // v2.7: red dot on the Pick'em tab when a recommendation changed before kickoff.
  const [pickemChanged, setPickemChanged] = useState(0);
  // v2.8: matchup-difficulty tables per scoring profile (colour the cards) and the card pop-ups.
  const [dvpTables, setDvpTables] = useState({});
  const [dvpVersion, setDvpVersion] = useState(0);
  const [modal, setModal] = useState(null);
  // v2.6: refresh the real source-status line whenever the "synced" time changes.
  useEffect(() => {
    api.getSourceStatus().then(setSourceStatus).catch(() => {});
  }, [syncedAt, refreshing]);

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
  // v2.9: per-week copies of the last build, so switching weeks shows something instantly.
  const weekCache = useRef(new Map());
  const buildSeq = useRef(0);

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

  const rawComputed = useMemo(
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
  // v2.8.1: cleared minor variances (per user, server-side) are applied on
  // top — they stop colouring rows, page badges and league cards.
  const [acks, setAcks] = useState(() => new Set());
  const computed = useMemo(() => rawComputed.map((lg) => applyAcks(lg, acks)), [rawComputed, acks]);

  const activeLeague = useMemo(() => computed.find((l) => l.id === (view.leagueId || null)), [computed, view.leagueId]);

  // v2.9: build leagues a couple at a time and show each as it arrives (the
  // last saved copy is already on screen, so nothing blocks on this). A newer
  // build supersedes an older one. Returns { week, superseded }; throws only if
  // not a single league could be built.
  const buildAll = useCallback(async (sid, ids, wk) => {
    const seq = ++buildSeq.current;
    let builtWeek = wk;
    let ok = 0;
    let firstError = null;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const r = await api.buildLeagues(sid, [id], wk, ids);
          if (seq !== buildSeq.current) return;
          builtWeek = r.week ?? builtWeek;
          if (r.leagues.some((l) => !l.error)) ok += 1;
          setLiveLeagues((prev) => {
            const next = mergeLeagues(prev, r.leagues, ids);
            weekCache.current.set(builtWeek, next.filter((l) => !l.error));
            return next;
          });
        } catch (err) {
          firstError = firstError || err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BUILD_CONCURRENCY, ids.length) }, worker));
    if (seq !== buildSeq.current) return { week: builtWeek, superseded: true };
    if (!ok && firstError) throw firstError;
    return { week: builtWeek, superseded: false };
  }, []);

  // Shared by both the bootstrap effect and the post-login handler: given
  // the server's last-session record (username + tracked leagues + week),
  // reconnect to Sleeper and refresh the dashboard. This is what replaces
  // localStorage — the record lives in SQLite, tied to the login, not the
  // browser, so it follows the person across devices.
  const reconnectFromLastSession = useCallback(
    async (last, { showedCache = false } = {}) => {
      try {
        const { sessionId, user, week: currentWeek, leagues } = await api.connect();
        setSessionId(sessionId);
        setSleeperUser(user);
        setAvailableLeagues(leagues);
        const validIds = leagues.map((l) => l.league_id);
        const restoredIds = (last?.leagueIds || []).filter((id) => validIds.includes(id));
        setSelectedIds(restoredIds.length ? restoredIds : validIds);
        setWeek((w) => w ?? currentWeek);
        if (restoredIds.length === 0) {
          navigate({ screen: "select" }, { replace: true });
          return;
        }
        if (!showedCache) setLoadingLeagues(true);
        setRefreshing(true);
        const { week: builtWeek } = await buildAll(sessionId, restoredIds, last?.week ?? undefined);
        setWeek(builtWeek ?? currentWeek);
        setSyncedAt("just now");
        if (!showedCache) navigate({ screen: "dashboard" }, { replace: true });
      } catch (err) {
        // Logged in fine, but Sleeper couldn't be reached. With saved data on screen, stay on it;
        // otherwise land on the league picker with the reason shown.
        setConnectError(err.message || "Couldn't reach Sleeper — try again.");
        if (!showedCache) navigate({ screen: "select" }, { replace: true });
      } finally {
        setLoadingLeagues(false);
        setRefreshing(false);
      }
    },
    [navigate, buildAll]
  );

  // After login/bootstrap: a pending forced password change blocks everything else.
  // v2.9: show the last saved build at once, then update it live in the background.
  const enterApp = useCallback(
    async (status) => {
      setAuthUser(status.user);
      if (status.user.mustChangePassword) {
        navigate({ screen: "forceChange" }, { replace: true });
        return;
      }
      let showedCache = false;
      try {
        const c = await api.getCachedLeagues();
        if (c.leagues?.length) {
          setLiveLeagues(c.leagues);
          setWeek(c.week ?? null);
          setSelectedIds(c.leagueIds || c.leagues.map((l) => l.id));
          setSyncedAt("saved copy");
          navigate({ screen: "dashboard" }, { replace: true });
          showedCache = true;
        }
      } catch {
        // No saved copy (or the call failed) — fall through to the normal path.
      }
      await reconnectFromLastSession(status.lastSession, { showedCache });
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
      // Drop leagues that are no longer tracked, then build the chosen ones.
      setLiveLeagues((prev) => prev.filter((l) => selectedIds.includes(l.id)));
      const { week: builtWeek } = await buildAll(sessionId, selectedIds, week);
      setWeek(builtWeek);
      setSyncedAt("just now");
      // No client-side persistence call needed here — the build endpoint
      // already saves the tracked list server-side, which is what
      // reconnectFromLastSession() reads on the next login/bootstrap.
      navigate({ screen: "dashboard" });
    } catch (err) {
      setConnectError(err.message || "Couldn't load those leagues — try again.");
    } finally {
      setLoadingLeagues(false);
    }
  }, [sessionId, selectedIds, week, navigate, buildAll]);

  const handleRefresh = useCallback(async () => {
    if (!sessionId || selectedIds.length === 0) return;
    setRefreshing(true);
    try {
      const { week: builtWeek } = await buildAll(sessionId, selectedIds, week);
      setWeek(builtWeek);
      setSyncedAt("just now");
    } catch (err) {
      setConnectError(err.message || "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, selectedIds, week, buildAll]);

  const handleWeekChange = useCallback(
    async (newWeek) => {
      if (!sessionId || selectedIds.length === 0) {
        setWeek(newWeek);
        return;
      }
      setWeek(newWeek);
      // Show the last build we have for that week straight away (marked as a saved copy), then rebuild.
      const cached = weekCache.current.get(newWeek);
      if (cached) setLiveLeagues(cached.map((l) => ({ ...l, fromCache: true })));
      setRefreshing(true);
      try {
        const { week: builtWeek } = await buildAll(sessionId, selectedIds, newWeek);
        setWeek(builtWeek ?? newWeek);
        setSyncedAt("just now");
      } catch (err) {
        setConnectError(err.message || "Couldn't load that week.");
      } finally {
        setRefreshing(false);
      }
    },
    [sessionId, selectedIds, buildAll]
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
    weekCache.current.clear();
    buildSeq.current += 1;
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

  // v2.7: keep the Pick'em tab's red dot current even when the tab isn't open.
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return undefined;
    const check = () => api.getPickem().then((d) => setPickemChanged(d.changedCount || 0)).catch(() => {});
    check();
    const id = setInterval(check, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [authUser]);

  // v2.8.1: load cleared variances; after each build, drop clears for issues
  // that have gone away (so if one comes back it's new again).
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return;
    api.getVarianceAcks().then((r) => setAcks(new Set(r.keys || []))).catch(() => {});
  }, [authUser]);
  // v2.9: clears for issues that have gone away are only dropped after a
  // COMPLETE, fresh, live build of every tracked league for one week — never
  // after a saved copy, a stale fallback, a failed league or a half-finished
  // progressive build (those make issues look like they vanished, which then
  // wrongly un-clears them when they "reappear"). `ackEpoch` stops a slow
  // prune response from overwriting a clear the person made in the meantime.
  const ackEpoch = useRef(0);
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword || refreshing) return;
    if (!rawComputed.length) return;
    const complete = rawComputed.every((lg) => !lg.error && !lg.stale && !lg.fromCache);
    const sameWeek = new Set(rawComputed.map((lg) => lg.week)).size === 1;
    const tracked = selectedIds.length === 0 || selectedIds.every((id) => rawComputed.some((lg) => lg.id === id));
    if (!complete || !sameWeek || !tracked) return;
    const present = rawComputed.flatMap((lg) => collectVariances(lg).map((v) => v.key));
    const epoch = ackEpoch.current;
    api
      .pruneVarianceAcks(rawComputed.map((lg) => lg.id), rawComputed[0].week, present)
      .then((r) => {
        if (epoch === ackEpoch.current) setAcks(new Set(r.keys || []));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawComputed, authUser, refreshing]);
  const clearVariances = useCallback(async (keys) => {
    ackEpoch.current += 1;
    setAcks((prev) => new Set([...prev, ...keys])); // optimistic
    try {
      const r = await api.ackVariances(keys);
      setAcks(new Set(r.keys || []));
    } catch {
      setAcks((prev) => {
        const n = new Set(prev);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  }, []);

  // v2.9: auto-clearing minors (weather, big-gap trades) are acknowledged once
  // their page has been viewed and left — so they show on the first visit and
  // not on later ones unless they come back.
  const prevView = useRef(null);
  const computedRef = useRef(computed);
  computedRef.current = computed;
  useEffect(() => {
    const prev = prevView.current;
    prevView.current = view;
    if (!prev || prev.screen !== "tab" || !STATUS_BADGE_TABS.includes(prev.tab)) return;
    if (view.screen === "tab" && view.leagueId === prev.leagueId && view.tab === prev.tab) return;
    const lg = computedRef.current.find((l) => l.id === prev.leagueId);
    const keys = autoClearKeys(lg?.variances || [], { leagueId: prev.leagueId, page: prev.tab });
    if (keys.length) clearVariances(keys);
  }, [view, clearVariances]);
  const openVariances = useCallback((scope) => setModal({ type: "variances", scope }), []);

  // v2.8: fetch the matchup table for each scoring profile in use; re-fetch
  // when the Analytics sample/adjust settings change.
  const profileKeys = useMemo(() => [...new Set(liveLeagues.map((l) => l.scoringProfile).filter(Boolean))].sort(), [liveLeagues]);
  const profileSig = JSON.stringify(profileKeys); // profile keys contain "|", so no string joining
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return;
    for (const p of JSON.parse(profileSig)) {
      api.getDvp({ profile: p }).then((t) => setDvpTables((prev) => ({ ...prev, [p]: t }))).catch(() => {});
    }
  }, [profileSig, dvpVersion, authUser]);
  const cardCtx = useMemo(
    () => ({
      dvpRow: (profile, side, pos, team) => {
        const t = dvpTables[profile];
        if (!t || t.profile !== profile) return null;
        return (side === "off" ? t.offense : t.defense)?.[pos]?.find((r) => r.team === team) || null;
      },
      openDvp: (params) => setModal({ type: "dvp", params }),
      openWeather: (key) => setModal({ type: "weather", key, week }),
    }),
    [dvpTables, week]
  );
  const closeModal = useCallback(() => setModal(null), []);

  // Breadcrumb trail: username > League Name > Sub tab name. Every level
  // but the current one is clickable.
  const crumbs = useMemo(() => {
    const root = { label: sleeperUser?.display_name || "Fantasy Manager", onClick: liveLeagues.length ? () => navigate({ screen: "dashboard" }) : undefined };
    if (view.screen === "bootstrapping") return [{ label: "Fantasy Manager" }];
    if (view.screen === "login") return [{ label: "Fantasy Manager" }];
    if (view.screen === "forceChange") return [{ label: "Change password" }];
    if (view.screen === "account") return [root, { label: "Account" }];
    if (view.screen === "analytics") return [{ label: "Analytics" }];
    if (view.screen === "gameday") return [{ label: "Game Day" }];
    if (view.screen === "pickem") return [{ label: "Pick'em" }];
    if (view.screen === "admin") return [root, { label: "Account", onClick: () => navigate({ screen: "account" }) }, { label: "Manage users" }];
    if (view.screen === "select") return liveLeagues.length ? [root, { label: "Edit Leagues" }] : [{ label: "Choose Leagues" }];
    if (view.screen === "dashboard") return [{ label: root.label }];
    if (view.screen === "league" && activeLeague) return [root, { label: activeLeague.name }];
    if (view.screen === "tab" && activeLeague) return [root, { label: activeLeague.name, onClick: () => navigate({ screen: "league", leagueId: activeLeague.id }) }, { label: (TAB_META[view.tab] || TAB_META.roster).label }];
    return [root];
  }, [view, sleeperUser, liveLeagues.length, activeLeague, navigate]);

  const showRefresh = view.screen === "dashboard" || view.screen === "league" || view.screen === "tab";
  const showWeek = showRefresh && week != null;

  return (
    <CardCtx.Provider value={cardCtx}>
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="max-w-lg mx-auto">
      {modal?.type === "dvp" && <DvpDetailModal params={modal.params} onClose={closeModal} />}
      {modal?.type === "weather" && <WeatherModal gameKey={modal.key} week={modal.week} onClose={closeModal} />}
      {modal?.type === "variances" && (() => {
        const sc = modal.scope || {};
        const lg = sc.leagueId ? computed.find((l) => l.id === sc.leagueId) : null;
        const list = computed.flatMap((l) => l.variances || []).filter((v) => (!sc.leagueId || v.leagueId === sc.leagueId) && (!sc.page || v.page === sc.page));
        const title = sc.page ? `Variances · ${lg?.name || ""} · ${PAGE_LABEL[sc.page]}` : sc.leagueId ? `Variances · ${lg?.name || ""}` : "Variances · all leagues";
        return <VarianceReportModal title={title} variances={list} onClear={clearVariances} onClose={closeModal} />;
      })()}
      <TopBar
        crumbs={crumbs}
        onRefresh={showRefresh ? handleRefresh : undefined}
        refreshing={refreshing}
        syncedLabel={showRefresh ? `${computed.some((l) => l.fromCache) ? "Showing your last saved data — updating live… · " : ""}Synced ${syncedAt} · ${sourceStatusLabel(sourceStatus)}` : null}
        week={week}
        onWeekChange={handleWeekChange}
        showWeek={showWeek}
      />
      {authUser && !authUser.mustChangePassword && !["login", "bootstrapping", "forceChange"].includes(view.screen) && (
        <TabBar
          active={["gameday", "analytics", "pickem"].includes(view.screen) ? view.screen : "leagues"}
          dots={{ pickem: pickemChanged > 0 }}
          onSelect={(tab) => {
            if (tab === "gameday") navigate({ screen: "gameday" });
            else if (tab === "pickem") navigate({ screen: "pickem" });
            else if (tab === "analytics") navigate({ screen: "analytics" });
            else navigate(liveLeagues.length ? { screen: "dashboard" } : { screen: "select" });
          }}
        />
      )}
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
          onOpenVariances={openVariances}
        />
      )}
      {view.screen === "forceChange" && <ForcePasswordScreen authUser={authUser} onDone={handlePasswordChanged} onLogout={handleLogout} />}
      {view.screen === "analytics" && <AnalyticsScreen authUser={authUser} onDvpChange={() => setDvpVersion((v) => v + 1)} />}
      {view.screen === "gameday" && <GameDayScreen />}
      {view.screen === "pickem" && <PickemScreen onChangedCount={setPickemChanged} />}
      {view.screen === "account" && <AccountScreen authUser={authUser} onOpenAdmin={() => navigate({ screen: "admin" })} onLogout={handleLogout} />}
      {view.screen === "admin" && authUser?.role === "owner" && <AdminScreen authUser={authUser} />}
      {view.screen === "select" && (
        <SelectLeaguesScreen leagues={availableLeagues} selectedIds={selectedIds} onToggle={handleToggleLeague} onConfirm={handleConfirmSelection} loading={loadingLeagues || connecting} error={connectError} />
      )}
      {view.screen === "league" && activeLeague && (
        <LeagueOverview league={activeLeague} onOpenVariances={openVariances} onOpenTab={(tab) => navigate({ screen: "tab", leagueId: activeLeague.id, tab })} />
      )}
      {view.screen === "tab" && activeLeague && (() => {
        if (activeLeague.error) return <ErrorScreen message={activeLeague.error} />;
        const tabKey = view.tab === "lineup" ? "roster" : view.tab; // v3.0: Lineup merged into Roster
        const Comp = TAB_COMPONENTS[tabKey];
        const pageVariances = (activeLeague.variances || []).filter((v) => v.page === tabKey);
        return (
          <>
            {STATUS_BADGE_TABS.includes(tabKey) && (
              <div className="flex justify-end px-4 pt-3 -mb-1">
                <VarianceButton variances={pageVariances} onOpen={() => openVariances({ leagueId: activeLeague.id, page: tabKey })} label="Variance report — this page" />
              </div>
            )}
            <Comp league={activeLeague} sessionId={sessionId} onSaveRanking={handleSaveRanking} onRefresh={handleRefresh} onOpenAccount={() => navigate({ screen: "account" })} onClearVariances={clearVariances} />
          </>
        );
      })()}
    </div>
    </CardCtx.Provider>
  );
}
