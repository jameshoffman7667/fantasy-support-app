import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  DESIGN TOKENS                                                     */
/* ------------------------------------------------------------------ */
export const C = {
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

export const STATUS = {
  ok: { color: C.ok, bg: C.okBg, Icon: CheckCircle2, label: "OK" },
  minor: { color: C.minor, bg: C.minorBg, Icon: AlertTriangle, label: "Minor" },
  major: { color: C.major, bg: C.majorBg, Icon: XCircle, label: "Major" },
  na: { color: C.textMuted, bg: "rgba(143,163,158,0.12)", Icon: HelpCircle, label: "No data" },
};

export const RANK = { ok: 0, minor: 1, major: 2 };

export const worst = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "ok");

// v3.5: position colours in the style of Sleeper's app (QB pink-red, RB green, WR blue, TE orange, K purple, DEF brown).
export const POS_COLOR = { QB: "#FC2B6D", RB: "#20CEB8", WR: "#56C9F8", TE: "#FEAE58", K: "#C96CFF", DEF: "#BF755D", FLEX: "#B6C2CF", SFLX: "#B6C2CF" };

// Projection source codes from the server (v2.4): V = Vegas props, T = Tank01,
// S = Sleeper, E = ESPN.
export const SOURCE_TAG = { V: "VEGAS", T: "TANK01", S: "SLEEPER", E: "ESPN" };

// v3.3: the same per-source colours the Analytics page uses; tags on player cards / lineup rows match them.
export const SRC_COLOR = { V: "#4A8FC2", T: "#D9A521", S: "#3FAE58", E: "#B07CC6" };

/* ------------------------------------------------------------------ */
/*  v2.8 PLAYER-CARD PIECES: headshots, logos, matchup, weather, stats */
/* ------------------------------------------------------------------ */
// Matchup tiers from the player's point of view: 0 = hardest (red) … 4 = easiest (dark green).
export const TIER_COLORS = ["#D6533B", "#E8833A", "#D9C021", "#9CC23A", "#2E9E4F"];

export const TIER_LABELS = ["Hardest", "Hard", "Middle", "Good", "Best"];

export const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const SAMPLE_LABEL = { blended: "Blended (incl. last season)", current: "This season only", last4: "Last 4 games" };

export function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// v2.8: "[NYJ] @ [MIA]" — the player's team coloured by its offensive rank at
// his position, the opponent by its defensive rank against that position.
// Each team opens the games behind its own rank.
export const normTeam = (t) => ({ JAX: "JAC", WSH: "WAS", LA: "LAR" }[t] || t);

const STAT_LABEL = {
  pass_yd: "pass yd", pass_td: "pass TD", pass_int: "INT", rush_att: "car", rush_yd: "rush yd", rush_td: "rush TD",
  rec_tgt: "tgt", rec: "rec", rec_yd: "rec yd", rec_td: "rec TD", fgm: "FG", xpm: "XP", kick_pts: "kick pts",
  sack: "sack", int: "INT", fum_rec: "fum rec", def_td: "TD", pts_allow: "pts allowed", yds_allow: "yds allowed",
};

export function formatStatLine(stats) {
  if (!stats) return "";
  const whole = (k) => k.endsWith("_yd") || k === "yds_allow" || k === "pts_allow";
  return Object.entries(stats)
    .map(([k, v]) => `${whole(k) ? Math.round(v) : Math.round(v * 10) / 10} ${STAT_LABEL[k] || k}`)
    .join(" · ");
}

export const ADV_COLOR = { good: C.ok, ok: C.minor, bad: C.major };

export function fmtAdv(v, fmt) {
  if (v == null) return "—";
  const n = Number(v);
  switch (fmt) {
    case "pct0": return `${Math.round(n)}%`;
    case "pct1": return `${n.toFixed(1)}%`;
    case "dec1": return n.toFixed(1);
    case "dec2": return n.toFixed(2);
    case "dec3": return n.toFixed(3);
    case "sgn1": return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
    case "sgn2": return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
    default: return String(Math.round(n * 100) / 100);
  }
}

export const ordinalN = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function readPref(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

export const rankColor = (rank) => (rank == null ? C.textFaint : rank <= 12 ? C.ok : rank <= 24 ? C.minor : C.major);

export const teamRankColor = (rank, of = 32) => (rank == null ? C.textFaint : rank <= Math.round(of * 0.32) ? C.ok : rank <= Math.round(of * 0.69) ? C.minor : C.major);

export const timeAgo = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/* ------------------------------------------------------------------ */
/*  VARIANCE REPORT (v2.8.1)                                           */
/* ------------------------------------------------------------------ */
export const SEV_COLOR = (sev, cleared) => (cleared ? C.textFaint : sev === "major" ? C.major : sev === "minor" ? C.minor : C.ok);

export const worstSev = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "ok");

export const fmtMoney = (n) => `$${Math.round(n)}`;

export const fmtPct = (n) => (n == null ? "—" : `${n}%`);

export const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

const OWNER_LABEL = { mine: "you own him", other: "owned by another team", free: "available" };

export function backupLine(b) {
  return `${b.name} (${b.pos}${b.rank != null ? b.rank : ""}${b.team ? `, ${b.team}` : ""})${b.proj != null ? ` proj ${b.proj.toFixed(1)}` : ""} — ${b.owner === "free" && b.locked ? "locked until the week's last game ends" : OWNER_LABEL[b.owner] || b.owner}`;
}

/* ------------------------------------------------------------------ */
/*  v3.0 — Trade offers (inbox + your own outstanding offers)           */
/* ------------------------------------------------------------------ */
export const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString());

export const inputStyle = { background: C.surface, border: `1px solid ${C.border}`, color: C.text };

/* ------------------------------------------------------------------ */
/*  PROJECTION ACCURACY (v2.5)                                         */
/* ------------------------------------------------------------------ */
export const SRC_NAME = { V: "Vegas", T: "Tank01", S: "Sleeper", E: "ESPN" };

/* ------------------------------------------------------------------ */
/*  MY PERFORMANCE (v3.3)                                              */
/* ------------------------------------------------------------------ */
export const signed = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}`);

export const goodBad = (n) => (n > 0 ? C.ok : n < 0 ? C.major : C.textMuted);

/* ------------------------------------------------------------------ */
/*  PICK'EM (v2.7)                                                      */
/* ------------------------------------------------------------------ */
// Team colours [main, alternate] — the alternate is used when both teams' main colours look alike.
export const TEAM_COLORS = {
  ARI: ["#97233F", "#FFB612"], ATL: ["#A71930", "#000000"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"],
  CAR: ["#0085CA", "#101820"], CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#000000"], CLE: ["#311D00", "#FF3C00"],
  DAL: ["#003594", "#869397"], DEN: ["#FB4F14", "#002244"], DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"],
  HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#A2AAAD"], JAX: ["#006778", "#D7A22A"], KC: ["#E31837", "#FFB81C"],
  LV: ["#000000", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"],
  MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#C60C30"], NO: ["#D3BC8D", "#101820"], NYG: ["#0B2265", "#A71930"],
  NYJ: ["#125740", "#FFFFFF"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#FFB612", "#101820"], SF: ["#AA0000", "#B3995D"],
  SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#34302B"], TEN: ["#0C2340", "#4B92DB"], WAS: ["#5A1414", "#FFB612"],
};

export const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
