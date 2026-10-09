// v4.2: the pure logic behind the stat pickers (Waivers → All tab's Filters & sort, Analytics → Scouting) and the
// Scouting table's filters, sort bands and multi-level sorting. No React, no network — unit-tested.

export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
export const MAX_WEEK = 18;

/** Position chip → the positions it means. */
export function expandPositions(filter) {
  if (!filter || filter === "ALL") return [...POSITIONS];
  if (filter === "FLEX") return ["RB", "WR", "TE"];
  return Array.isArray(filter) ? (filter.length ? filter.flatMap((f) => expandPositions(f)) : [...POSITIONS]) : [filter];
}

/** "Now": this season with Season / Season average, or exactly the current week (mirrors the server). */
export function isCurrentTime(time, cur) {
  if (!cur) return true;
  const seasons = time?.seasons?.length ? time.seasons.map(Number) : [Number(cur.season)];
  if (seasons.length !== 1 || seasons[0] !== Number(cur.season)) return false;
  const period = time?.period || "season";
  if (period === "season" || period === "avg") return true;
  return period === "weeks" && (time.weeks || []).length === 1 && Number(time.weeks[0]) === Number(cur.week);
}

const typeFits = (type, mode) => type === "Both" || type === "Neither" || (mode === "proj" ? type === "Projection" : type === "Stat");

/**
 * Stats offered in the Stat drop-down: in the drop-down (Yes), right type for the Projection/Stats switch, in the
 * chosen categories, used at one of the positions, and — when a time filter is on — not a current-only stat.
 * categories: null/[] = every category.
 */
export function statOptions(cfg, { mode, categories = null, positions = POSITIONS, time = null, cur = null }) {
  const cats = categories == null ? null : (Array.isArray(categories) ? categories : [categories]).filter(Boolean);
  const now = isCurrentTime(time, cur);
  const pos = new Set(positions?.length ? positions : POSITIONS);
  return (cfg?.rows || []).filter((r) => {
    if (!r.inDropdown || !typeFits(r.type, mode)) return false;
    if (cats && cats.length && !cats.includes(r.category)) return false;
    if (!r.positions.some((p) => pos.has(p))) return false;
    if (!now && cfg.defs?.[r.id]?.current) return false;
    return true;
  });
}

/** Categories that still have at least one stat to offer, in spreadsheet order. */
export function categoryOptions(cfg, opts) {
  const out = [];
  for (const r of statOptions(cfg, { ...opts, categories: null })) if (!out.includes(r.category)) out.push(r.category);
  return out;
}

/** Keeps only selections still on offer ("blank it out if already selected"). */
export function keepOffered(selected, options) {
  const ok = new Set(options.map((o) => (typeof o === "string" ? o : o.id)));
  return (Array.isArray(selected) ? selected : [selected]).filter((x) => x != null && ok.has(x));
}

/** Drops categories and stats no longer on offer after a change (mode, positions, time). */
export function normalizeView(view, cfg, { positions = POSITIONS, cur = null } = {}) {
  const time = { seasons: view.seasons, period: view.period, weeks: view.weeks };
  const cats = categoryOptions(cfg, { mode: view.mode, positions, time, cur });
  const categories = (view.categories || []).filter((c) => cats.includes(c));
  const stats = keepOffered(view.stats || [], statOptions(cfg, { mode: view.mode, categories, positions, time, cur }));
  return { ...view, categories, stats };
}

/**
 * Seasons for the Season filter, newest first: from the earliest rookie season among the players shown (each year
 * a player has been in the NFL) to this season, never before the data starts (stats 1999, projections 2025).
 */
export function seasonOptions({ mode, cur, rows = [], firstStat = 1999, firstProj = 2025 }) {
  const top = Number(cur?.season) || new Date().getFullYear();
  const floor = mode === "proj" ? firstProj : firstStat;
  const rookies = rows.map((r) => Number(r.rookie)).filter((x) => Number.isFinite(x) && x > 1900);
  const earliest = Math.max(floor, rookies.length ? Math.min(...rookies) : top - 5);
  const out = [];
  for (let y = top; y >= Math.min(earliest, top); y--) out.push(y);
  return out;
}

export const PERIOD_OPTIONS = [{ value: "season", label: "Season" }, { value: "avg", label: "Season average" }, ...Array.from({ length: MAX_WEEK }, (_, i) => ({ value: `w${i + 1}`, label: `Week ${i + 1}` }))];

/** time → the period drop-down's selected values. */
export function periodValues(time) {
  if (!time || time.period === "season" || !time.period) return ["season"];
  if (time.period === "avg") return ["avg"];
  return (time.weeks || []).map((w) => `w${w}`);
}
/**
 * Period drop-down values → time fields. Season and Season average are each exclusive; weeks combine (multi-select).
 * `last` = the value just picked (so picking a week after "Season" switches to weeks, and the reverse).
 */
export function periodFromValues(values, last = null) {
  const vals = (values || []).filter(Boolean);
  if (last === "season" || last === "avg") return { period: last, weeks: [] };
  const weeks = vals.filter((v) => /^w\d+$/.test(v)).map((v) => Number(v.slice(1))).sort((a, b) => a - b);
  if (weeks.length) return { period: "weeks", weeks };
  if (vals.includes("avg")) return { period: "avg", weeks: [] };
  return { period: "season", weeks: [] };
}

/* ---------------- value formatting ---------------- */
const SHARE = new Set(["snap_pct", "target_share", "air_yd_share", "carry_share", "stacked_box", "pressure_rate", "bad_throw", "drop_rate", "rostered_pct"]);
export function fmtValue(id, v) {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (SHARE.has(id)) return `${Math.round(v * 10) / 10}%`;
  if (id === "spread" || id === "prop_anytd") return v > 0 ? `+${v}` : String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return String(Math.round(v * (a >= 100 ? 1 : a >= 10 ? 10 : 100)) / (a >= 100 ? 1 : a >= 10 ? 10 : 100));
}

/* ---------------- bands ---------------- */
/** Bands as [{ label, min, max }] — min inclusive, max exclusive, null = open. Sorted low → high. */
export function normBands(bands) {
  return (bands || [])
    .map((b) => ({ label: String(b.label || "").slice(0, 20), min: b.min === "" || b.min == null || !Number.isFinite(Number(b.min)) ? null : Number(b.min), max: b.max === "" || b.max == null || !Number.isFinite(Number(b.max)) ? null : Number(b.max) }))
    .filter((b) => b.min != null || b.max != null)
    .sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity) || (a.max ?? Infinity) - (b.max ?? Infinity));
}
/** Index of the band (in low→high order) a value falls in; bands.length when none; null value → Infinity. */
export function bandIndex(value, bands) {
  if (value == null || !Number.isFinite(Number(value))) return Infinity;
  const v = Number(value);
  const list = normBands(bands);
  const i = list.findIndex((b) => (b.min == null || v >= b.min) && (b.max == null || v < b.max));
  return i < 0 ? list.length : i;
}
/** Bands for a player's position: his position's set, else the "ALL" set. */
export const bandsFor = (col, pos) => {
  const b = col?.bands || {};
  return b[pos]?.length ? b[pos] : b.ALL?.length ? b.ALL : null;
};

const round = (x) => {
  const a = Math.abs(x);
  const f = a >= 100 ? 1 : a >= 10 ? 10 : a >= 1 ? 100 : 1000;
  return Math.round(x * f) / f;
};
/**
 * Suggested good / ok / poor bands for one stat at one position: the player-card thresholds when the stat has them,
 * otherwise the top / middle / bottom third of the players shown with a value. Labelled by which way is good.
 */
export function suggestBands(statId, pos, rows, defs) {
  const d = defs?.[statId] || {};
  const better = d.better || "high";
  const fixed = d.fixed?.[pos];
  let lo, hi;
  if (fixed && fixed[0] != null && fixed[1] != null) {
    lo = Math.min(fixed[0], fixed[1]);
    hi = Math.max(fixed[0], fixed[1]);
  } else {
    const vals = rows.filter((r) => (!pos || pos === "ALL" || r.pos === pos)).map((r) => r.values?.[statId]).filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
    if (vals.length < 3) return [];
    lo = vals[Math.floor(vals.length / 3)];
    hi = vals[Math.floor((vals.length * 2) / 3)];
    if (lo === hi) return [];
  }
  lo = round(lo);
  hi = round(hi);
  const [top, bottom] = better === "low" ? ["Poor", "Good"] : ["Good", "Poor"];
  return [
    { label: bottom, min: null, max: lo },
    { label: "OK", min: lo, max: hi },
    { label: top, min: hi, max: null },
  ];
}

/* ---------------- min / max and multi-level sort ---------------- */
/** Drops rows outside any column's Min / Max (a blank value fails a set Min or Max). */
export function applyMinMax(rows, cols = {}) {
  const active = Object.entries(cols).filter(([, c]) => (c?.min !== "" && c?.min != null) || (c?.max !== "" && c?.max != null));
  if (!active.length) return rows;
  return rows.filter((r) =>
    active.every(([id, c]) => {
      const v = r.values?.[id];
      if (v == null || !Number.isFinite(Number(v))) return false;
      if (c.min !== "" && c.min != null && Number(v) < Number(c.min)) return false;
      if (c.max !== "" && c.max != null && Number(v) > Number(c.max)) return false;
      return true;
    })
  );
}

/**
 * Multi-level sort. `order` = stat ids in the order their sorts were set (level 1, 2, …); cols[id].dir = "asc"|"desc".
 * Every column with bands sorts by band first (in level order), then every column by its value (in level order):
 * e.g. Age (bands, asc) then TPRR (bands, desc) → Age band, TPRR band, Age, TPRR. Blanks always go last.
 * Ties keep the incoming order (stable).
 */
export function sortRows(rows, order = [], cols = {}) {
  const levels = order.filter((id) => cols[id]?.dir === "asc" || cols[id]?.dir === "desc");
  if (!levels.length) return rows;
  const keyed = rows.map((r, i) => {
    const bands = [];
    const vals = [];
    for (const id of levels) {
      const c = cols[id];
      const sign = c.dir === "desc" ? -1 : 1;
      const v = r.values?.[id];
      const num = v == null || !Number.isFinite(Number(v)) ? null : Number(v);
      const b = bandsFor(c, r.pos);
      if (b) {
        const bi = bandIndex(num, b);
        const n = normBands(b).length;
        // outside every band sorts after the bands; blank last of all
        bands.push(bi === Infinity ? [2, 0] : bi === n ? [1, 0] : [0, sign * bi]);
      }
      vals.push(num == null ? [1, 0] : [0, sign * num]);
    }
    return { r, i, keys: [...bands, ...vals] };
  });
  keyed.sort((a, b) => {
    for (let k = 0; k < a.keys.length; k++) {
      const x = a.keys[k];
      const y = b.keys[k];
      if (x[0] !== y[0]) return x[0] - y[0];
      if (x[1] !== y[1]) return x[1] - y[1];
    }
    return a.i - b.i;
  });
  return keyed.map((k) => k.r);
}

/** Sets a column's sort direction (null = off), keeping `order` (levels) in the order sorts were set. */
export function setSort(state, id, dir) {
  const cols = { ...(state.cols || {}), [id]: { ...(state.cols?.[id] || {}), dir: dir || null } };
  let order = (state.order || []).filter((x) => x !== id || dir);
  if (dir && !order.includes(id)) order = [...order, id];
  return { ...state, cols, order };
}
/**
 * v4.4: a plain header tap. A column that isn't a sort level yet is added as the BOTTOM level, descending; one that
 * already is (even inside a multi-level sort) cycles descending → ascending → off (off removes just that level).
 */
export function cycleSort(state, id) {
  const d = state.cols?.[id]?.dir;
  if (d !== "asc" && d !== "desc") return setSort(state, id, "desc");
  return setSort(state, id, d === "desc" ? "asc" : null);
}

/* ---------------- conditional formatting (v4.4) ---------------- */
/** none → band → gradient → none. */
export const FORMATS = ["none", "band", "gradient"];
export const FORMAT_LABEL = { none: "Colours off", band: "Colour: bands", gradient: "Colour: gradient" };
export const nextFormat = (f) => FORMATS[(Math.max(0, FORMATS.indexOf(f)) + 1) % FORMATS.length];
/** { min, max } of the numeric values of one stat over the rows (null when there are none). */
export function columnRange(rows, id) {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const v = r.values?.[id];
    if (v == null || !Number.isFinite(Number(v))) continue;
    min = Math.min(min, Number(v));
    max = Math.max(max, Number(v));
  }
  return min <= max ? { min, max } : null;
}
/** 0 (worst) … 1 (best) of a value inside the column's range; "low is better" stats flip. null = no colour. */
export function gradientT(value, range, better = "high") {
  if (value == null || !Number.isFinite(Number(value)) || !range || range.max === range.min) return null;
  const t = (Number(value) - range.min) / (range.max - range.min);
  return better === "low" ? 1 - t : t;
}
/** 0 (worst) … 1 (best) for a band: by its label (good / ok / poor), else by its place among the bands. */
export function bandT(bands, band, better = "high") {
  if (!band) return null;
  if (/good|great|elite|top/i.test(band.label)) return 1;
  if (/poor|bad|weak/i.test(band.label)) return 0;
  if (/ok|avg|average|mid/i.test(band.label)) return 0.5;
  const list = normBands(bands);
  const i = list.findIndex((b) => b.min === band.min && b.max === band.max);
  if (i < 0) return null;
  if (list.length === 1) return 0.5;
  const t = i / (list.length - 1);
  return better === "low" ? 1 - t : t;
}
/** Red (0) through yellow to green (1), as a see-through cell background. */
export const heatColor = (t) => (t == null ? null : `hsla(${Math.round(Math.max(0, Math.min(1, t)) * 120)}, 70%, 45%, 0.32)`);
/** The cell background for one value: format "band" | "gradient" (anything else = none). Pure. */
export function cellColor({ format, value, bands, range, better }) {
  if (format === "gradient") return heatColor(gradientT(value, range, better));
  if (format === "band") {
    if (value == null || !Number.isFinite(Number(value)) || !bands) return null;
    const v = Number(value);
    const band = normBands(bands).find((x) => (x.min == null || v >= x.min) && (x.max == null || v < x.max));
    return heatColor(bandT(bands, band, better));
  }
  return null;
}

/** Clears one column's min/max, bands and sort. */
export function clearColumn(state, id) {
  const cols = { ...(state.cols || {}) };
  delete cols[id];
  return { ...state, cols, order: (state.order || []).filter((x) => x !== id) };
}
/** Sort level (1-based) of a column, or null. */
export const sortLevel = (state, id) => {
  const levels = (state.order || []).filter((x) => state.cols?.[x]?.dir);
  const i = levels.indexOf(id);
  return i < 0 ? null : i + 1;
};

/* ---------------- league status (Scouting) ---------------- */
/** Where a player stands in the user's leagues: { mine: [names], rostered: n, available: [names] }. */
export function leagueStatus(id, pos, leagues = []) {
  const out = { mine: [], rostered: 0, available: [] };
  for (const l of leagues) {
    if (!l || l.error) continue;
    const sid = String(id);
    if ((l.rosterIds || []).map(String).includes(sid)) out.mine.push(l.name);
    else if ((l.faSearch?.rosteredIds || []).includes(sid)) out.rostered++;
    else if (l.faSearch && (!l.faSearch.positions || l.faSearch.positions.includes(pos))) out.available.push(l.name);
  }
  return out;
}
