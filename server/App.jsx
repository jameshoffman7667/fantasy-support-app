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
import { effectiveLineup, isZeroProjection, GROUP_LABEL, hasStarted } from "./lineup.js";
import { applyAcks, collectVariances, groupTree, minorKeys, PAGE_LABEL } from "./variances.js";

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
    if (OUT_LIKE.includes(player.status)) return { slot, label: player.name, issues: [iss("Starter out / doubtful / IR", "major", player.note || `${player.status} — hasn't been swapped`)] };
    if (player.status === "Questionable") return { slot, label: player.name, issues: [iss("Questionable starter", "minor", player.note || "Questionable — game-time decision")] };
    return { slot, label: player.name, issues: [] };
  });

  league.starters.forEach(({ slot, player: flexPlayer }, idx) => {
    if (!FLEX_ELIGIBLE[slot] || !flexPlayer || flexPlayer.kickoff == null) return;
    const posIdx = league.starters.findIndex(
      (s) => s.slot === flexPlayer.pos && s.player && s.player.kickoff != null && s.player.kickoff > flexPlayer.kickoff
    );
    if (posIdx < 0) return;
    const positional = league.starters[posIdx];
    starterRows[idx].issues.push(
      iss("Flex lock order", "major", `Locks ${flexPlayer.kickoffLabel} — before ${positional.slot} slot's ${positional.player.name} (${positional.player.kickoffLabel}). Swap these two.`)
    );
    starterRows[posIdx].issues.push(iss("Flex lock order", "major", `Later kickoff than ${slot}'s ${flexPlayer.name} — swap these two to preserve flexibility.`));
  });

  const benchRows = league.bench.map((p) => {
    if (!p) return { slot: "BN", label: "(empty)", issues: [iss("Open bench slot", "minor", "Open bench slot — consider a waiver add")] };
    if (p.irEligible) return { slot: "BN", label: p.name, issues: [iss("IR-eligible on bench", "minor", "IR-eligible — move to an empty IR slot")], usage: p.usage };
    return { slot: "BN", label: p.name, issues: [], usage: p.usage };
  });
  const irRows = (league.ir || []).map((p) => ({ slot: "IR", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));
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

// Projection source codes from the server (v2.4): V = Vegas props, T = Tank01,
// S = Sleeper, E = ESPN.
const SOURCE_TAG = { V: "VEGAS", T: "TANK01", S: "SLEEPER", E: "ESPN" };

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
    <span style={{ color: C.textFaint }} className="absolute bottom-1 right-1.5 text-[9px] font-medium tracking-wide">
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
      Proj ({src}): {formatStatLine(player.projStats)}
      {player.projSource === "E" ? " — ESPN only gives receptions and pass TDs" : ""}
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
  const [open, setOpen] = useState(() => new Set()); // default: everything collapsed
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
  const toggle = (id) =>
    setOpen((prev) => {
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
        <button onClick={() => setOpen(new Set(allIds))} style={{ color: C.brand, border: `1px solid ${C.brand}55` }} className="text-[11px] rounded-md px-2 py-1">
          Expand all
        </button>
        <button onClick={() => setOpen(new Set())} style={{ color: C.brand, border: `1px solid ${C.brand}55` }} className="text-[11px] rounded-md px-2 py-1">
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
              <div className="flex items-center gap-1 flex-wrap px-4 pb-2.5 pt-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
                {STATUS_BADGE_TABS.map((key) => (
                  <StatusBadge key={key} status={lg[key].status} label={TAB_META[key].short} compact onClick={() => onOpenTab(lg.id, key)} />
                ))}
                <button onClick={() => onOpenTab(lg.id, "odds")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
                  <Trophy size={11} />
                  Outlook
                </button>
                <VarianceButton compact variances={lg.variances || []} onOpen={() => onOpenVariances({ leagueId: lg.id })} />
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
        <div style={{ color: C.textFaint }} className="text-[10px]">{p.projSource === "actual" ? "FINAL" : SOURCE_TAG[p.projSource] || p.projSource || "no proj"}{p.projFactor ? ` ×${p.projFactor}` : ""}</div>
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

function LineupTab({ league, onSaveRanking }) {
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
      {L.weatherStarters?.length > 0 && (
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
              <SourceTag source={p.projSource} factor={p.projFactor} />
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
            const sev = e.cleared ? "ok" : e.seen ? "minor" : "major";
            const s = STATUS[sev];
            return (
              <div key={e.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3 flex items-center gap-3">
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div style={{ color: C.text }} className="text-sm font-medium">{e.player}</div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{e.status}{e.note ? ` — ${e.note}` : ""}</div>
                </div>
                <div style={{ color: C.textFaint }} className="text-xs shrink-0">{e.cleared ? "Cleared" : e.seen ? "Seen before" : "New"}</div>
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

/* ------------------------------------------------------------------ */
/*  PROJECTION ACCURACY (v2.5)                                         */
/* ------------------------------------------------------------------ */
const SRC_NAME = { V: "Vegas", T: "Tank01", S: "Sleeper", E: "ESPN" };
const SRC_COLOR = { V: "#4A8FC2", T: "#D9A521", S: "#3FAE58", E: "#B07CC6" };

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

// v2.8: Analytics has two views — projection accuracy and matchup rankings.
function AnalyticsScreen({ authUser, onDvpChange }) {
  const [view, setView] = useState("matchups");
  return (
    <div>
      <div className="flex gap-1.5 px-4 pt-3">
        {[
          ["matchups", "Matchup rankings"],
          ["accuracy", "Projection accuracy"],
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
      {view === "accuracy" ? <AccuracyScreen authUser={authUser} /> : <MatchupRankings onDvpChange={onDvpChange} authUser={authUser} />}
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

  const rows = (side === "def" ? data?.defense : data?.offense)?.[pos] || [];
  const th = "text-left font-medium px-1.5 py-1";
  const td = "px-1.5 py-1.5";
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Fantasy points per game by position, in your league's scoring, from Sleeper's game stats. Your sample and adjustment choices here also colour the matchups on player cards.
      </div>
      <div className="flex flex-wrap gap-2 items-end mb-2">
        <Select label="Scoring" value={profile} onChange={setProfile} options={(data?.profiles || []).map((p) => ({ value: p.profile, label: p.label }))} />
        <Select label="Sample" value={data?.mode || "blended"} onChange={(v) => saveSettings({ mode: v })} options={Object.entries(SAMPLE_LABEL).map(([value, label]) => ({ value, label }))} />
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
        {" "}Tap a team for the games behind it.
      </div>
      {error && <div style={{ color: C.major }} className="text-xs pb-2">{error}</div>}
      {data?.note && <div style={{ color: C.textMuted }} className="text-xs pb-2">{data.note}</div>}
      {!data && !error && <Loader2 size={18} className="animate-spin" style={{ color: C.brand }} />}
      {rows.length > 0 && (
        <table className="w-full text-xs" style={{ color: C.text }}>
          <thead style={{ color: C.textFaint }}>
            <tr>
              <th className={th}>#</th>
              <th className={th}>Team</th>
              <th className={th}>Pts/g</th>
              {data.adjusted && <th className={th}>Raw</th>}
              <th className={th}>Games</th>
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
                <td className={td} style={{ color: C.textMuted }}>{r.games}{r.weight !== r.games ? ` (wt ${r.weight})` : ""}</td>
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

function AccuracyScreen({ authUser }) {
  const thisSeason = new Date().getFullYear();
  const [f, setF] = useState({ season: String(thisSeason), profile: "", pos: "ALL", weekFrom: "1", weekTo: "18", sameOnly: false, adjusted: false });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getAccuracy({ ...f, sameOnly: f.sameOnly ? "1" : "0", adjusted: f.adjusted ? "1" : "0" })
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
  const rows = (data?.summary || []).filter((r) => (f.pos === "ALL" ? true : r.pos === f.pos));
  const th = "text-[10px] uppercase tracking-wide font-medium px-1.5 py-1 text-right";
  const td = "text-xs px-1.5 py-1 text-right";

  return (
    <div className="px-4 py-3 space-y-4">
      <div style={{ color: C.textMuted }} className="text-xs px-1">
        Every source's projection (frozen at each player's kickoff) compared with actual points, scored with the selected scoring profile. A projected player with no stat line counts as 0. Projections under 0.5 pts are ignored.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select label="Season" value={f.season} onChange={set("season")} options={seasons.map((s) => ({ value: String(s), label: String(s) }))} />
        <Select label="Scoring" value={f.profile} onChange={set("profile")} options={(data?.meta?.profiles || []).map((p) => ({ value: p.profile, label: p.label }))} />
        <Select label="Position" value={f.pos} onChange={set("pos")} options={["ALL", "QB", "RB", "WR", "TE", "K", "DEF"].map((p) => ({ value: p, label: p === "ALL" ? "All positions" : p }))} />
        <div className="grid grid-cols-2 gap-2">
          <Select label="From" value={f.weekFrom} onChange={set("weekFrom")} options={weekOpts} />
          <Select label="To" value={f.weekTo} onChange={set("weekTo")} options={weekOpts} />
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
          <div>
            <SectionLabel>Accuracy by source</SectionLabel>
            {rows.length === 0 ? (
              <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No scored projections for these filters yet.</div>
            ) : (
              <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }}>
                <table className="w-full" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>
                  <thead style={{ background: C.surfaceRaised, color: C.textMuted }}>
                    <tr>
                      <th className={`${th} text-left`}>Source</th>
                      <th className={`${th} text-left`}>Pos</th>
                      <th className={th}>n</th>
                      <th className={th} title="Average projected minus actual (+ = runs high)">Bias</th>
                      <th className={th} title="Average absolute miss">Avg miss</th>
                      <th className={th}>RMSE</th>
                      <th className={th} title="Standard deviation of the error">SD</th>
                      <th className={th} title="Correlation of projected with actual">Corr</th>
                      <th className={th} title="Rank correlation within position each week">Rank</th>
                      <th className={th}>±3</th>
                      <th className={th}>±5</th>
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
        {p.leagues.map((l, i) => (
          <span key={i} style={{ color: l.side === "for" ? C.ok : C.major, border: `1px solid ${l.side === "for" ? C.ok : C.major}55` }} className="text-[10px] rounded px-1.5 py-0.5">
            {l.side === "for" ? "+" : "−"} {l.league} ({l.weight})
          </span>
        ))}
      </div>
    </div>
  );
}

function GameDayScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [slot, setSlot] = useState("all");
  const [cat, setCat] = useState("all");
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
  const shown = data.players.filter((p) => (slot === "all" || p.kickoffLabel === slot) && (cat === "all" || p.category === cat));
  const counts = { for: 0, balanced: 0, against: 0 };
  data.players.forEach((p) => counts[p.category]++);

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
          <div key={l.id} style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: l.include === false ? 0.5 : 1 }} className="rounded-md px-3 py-2">
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
          </div>
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
        <div>{shown.map((p) => <CheerRow key={p.id} p={p} ratio={data.settings.ratio} />)}</div>
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

function PickCard({ g, onSeen, leverageOn, publicPct, onPublicPct }) {
  const colors = barColors(g.away, g.home);
  const awayP = g.homeProb == null ? 0.5 : 1 - g.homeProb;
  const textOn = (hex) => (luminance(hex) > 0.6 ? "#10171A" : "#FFFFFF");
  const final = g.state === "post";
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
          <div style={{ width: `${awayP * 100}%`, background: colors.away, color: textOn(colors.away) }} className="flex items-center pl-2 min-w-[2.5rem]">{g.away} {pct(awayP)}</div>
          <div style={{ width: `${(1 - awayP) * 100}%`, background: colors.home, color: textOn(colors.home) }} className="flex items-center justify-end pr-2 min-w-[2.5rem]">{pct(g.homeProb)} {g.home}</div>
        </div>
        <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5 flex justify-between">
          <span>{g.source || "no line yet"}{g.homeSpread != null ? ` · ${g.home} ${g.homeSpread > 0 ? "+" : ""}${Math.round(g.homeSpread * 2) / 2}` : ""}</span>
          <span>ESPN FPI: {g.fpiHomeProb != null ? `${g.home} ${pct(g.fpiHomeProb)}` : "—"}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {g.pick ? (
          <span style={{ background: g.leverage ? C.minorBg : C.okBg, color: g.leverage ? C.minor : C.ok }} className="text-xs font-semibold rounded px-2 py-0.5">
            Pick: {g.pick}{g.leverage ? " (leverage)" : ""}
          </span>
        ) : (
          <span style={{ color: C.textFaint }} className="text-xs">No pick yet</span>
        )}
        {g.changed && g.prevPick && <span style={{ color: C.major }} className="text-[11px]">changed from {g.prevPick} — tap to dismiss</span>}
      </div>
      {g.reason && g.leverage && <div style={{ color: C.textMuted }} className="text-[11px]">{g.reason}</div>}

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
      {leverageOn && !g.started && (
        <label className="flex items-center gap-2 text-[10px]" style={{ color: C.textFaint }} onClick={(e) => e.stopPropagation()}>
          Pool % on {g.home} (optional)
          <input
            type="number" min="0" max="100" defaultValue={publicPct ?? ""}
            onBlur={(e) => onPublicPct(g.key, e.target.value)}
            style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
            className="w-16 rounded px-1.5 py-0.5 text-xs"
          />
        </label>
      )}
    </div>
  );
}

function PickemScreen({ onChangedCount }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
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
      {showSettings && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2 text-xs" >
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.leverage} onChange={(e) => saveSettings({ leverage: e.target.checked })} />
            Weekly leverage picks (for the weekly prize)
          </label>
          <div className="grid grid-cols-2 gap-2" style={{ color: C.textMuted }}>
            <label className="flex flex-col gap-0.5">How many upsets
              <input type="number" min="0" max="8" defaultValue={s.leverageCount} onBlur={(e) => saveSettings({ leverageCount: e.target.value })} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">Min underdog win chance (%)
              <input type="number" min="20" max="50" defaultValue={Math.round(s.minDogProb * 100)} onBlur={(e) => saveSettings({ minDogProb: Number(e.target.value) / 100 })} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-1" />
            </label>
          </div>
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.notify} onChange={(e) => saveSettings({ notify: e.target.checked })} />
            Push alert when a recommendation changes before kickoff
          </label>
          <div style={{ color: C.textFaint }} className="text-[11px]">
            Default picks are the betting favourite in every game (best for the season prize). Leverage swaps in up to {s.leverageCount} near-coin-flip underdogs the pool is likely to fade, to give you a shot at the weekly prize — at some cost to the season standings.
          </div>
        </div>
      )}
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
      <div style={{ color: C.textFaint }} className="text-[10px] px-1">
        {data.gemini.configured ? (data.gemini.at ? `Article scan (Gemini) ${new Date(data.gemini.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Article scan pending") : "Article scan off — set GEMINI_API_KEY to add upset mentions and game notes"}
      </div>
      <div className="space-y-2.5">
        {data.games.map((g) => (
          <PickCard key={g.key} g={g} onSeen={seen} leverageOn={s.leverage} publicPct={s.publicPct?.[g.key]} onPublicPct={(k, v) => saveSettings({ publicPct: { [k]: v } })} />
        ))}
      </div>
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
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return;
    const built = rawComputed.filter((lg) => !lg.error);
    if (!built.length) return;
    const present = built.flatMap((lg) => collectVariances(lg).map((v) => v.key));
    api
      .pruneVarianceAcks(built.map((lg) => lg.id), built[0].week, present)
      .then((r) => setAcks(new Set(r.keys || [])))
      .catch(() => {});
  }, [rawComputed, authUser]);
  const clearVariances = useCallback(async (keys) => {
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
    if (view.screen === "tab" && activeLeague) return [root, { label: activeLeague.name, onClick: () => navigate({ screen: "league", leagueId: activeLeague.id }) }, { label: TAB_META[view.tab].label }];
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
        syncedLabel={showRefresh ? `Synced ${syncedAt} · ${sourceStatusLabel(sourceStatus)}` : null}
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
        const Comp = TAB_COMPONENTS[view.tab];
        const pageVariances = (activeLeague.variances || []).filter((v) => v.page === view.tab);
        return (
          <>
            {STATUS_BADGE_TABS.includes(view.tab) && (
              <div className="flex justify-end px-4 pt-3 -mb-1">
                <VarianceButton variances={pageVariances} onOpen={() => openVariances({ leagueId: activeLeague.id, page: view.tab })} label="Variance report — this page" />
              </div>
            )}
            <Comp league={activeLeague} sessionId={sessionId} onSaveRanking={handleSaveRanking} />
          </>
        );
      })()}
    </div>
    </CardCtx.Provider>
  );
}
