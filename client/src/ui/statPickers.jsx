import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PERIOD_OPTIONS, categoryOptions, isCurrentTime, normalizeView, periodFromValues, periodValues, seasonOptions, statOptions } from "../statsView.js";
import { C } from "./theme.js";

/**
 * v4.2: the stat pickers shared by the Waivers → All tab's Filters & sort pop-up (single choices) and Analytics →
 * Scouting (multi-select): Projection / Stats, Category → Stat, Season(s), Week / Season.
 */

/** A drop-down list; multi = check boxes (stays open), single = picks and closes. */
export function Dropdown({ label, options, value, onChange, multi = false, placeholder = "Choose…", testId, disabledNote = null, width = "100%" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [open]);
  const selected = multi ? (value || []) : value == null ? [] : [value];
  const labelOf = (v) => options.find((o) => o.value === v)?.label ?? String(v);
  const shown = selected.length === 0 ? placeholder : multi && selected.length > 2 ? `${labelOf(selected[0])} +${selected.length - 1}` : selected.map(labelOf).join(", ");
  const pick = (v) => {
    if (!multi) {
      onChange(v, v);
      setOpen(false);
      return;
    }
    const has = selected.includes(v);
    onChange(has ? selected.filter((x) => x !== v) : [...selected, v], v);
  };
  return (
    <div className="relative" ref={ref} style={{ width }} data-dropdown={testId}>
      {label && <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide mb-0.5">{label}</div>}
      <button type="button" onClick={() => setOpen((x) => !x)} style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: selected.length ? C.text : C.textMuted }} className="w-full rounded-md px-2.5 py-1.5 text-sm flex items-center justify-between gap-2" aria-expanded={open} data-dropdown-button={testId}>
        <span className="truncate">{shown}</span>
        <ChevronDown size={14} style={{ color: C.textFaint }} />
      </button>
      {open && (
        <div className="absolute z-40 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-md shadow-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, minWidth: 180 }} role="listbox" aria-multiselectable={multi || undefined}>
          {multi && selected.length > 0 && (
            <button type="button" onClick={() => onChange([], null)} className="w-full text-left px-3 py-1.5 text-[11px] underline" style={{ color: C.textMuted }} data-dropdown-clear={testId}>
              Clear
            </button>
          )}
          {options.length === 0 && <div className="px-3 py-2 text-xs" style={{ color: C.textMuted }}>{disabledNote || "Nothing to choose here."}</div>}
          {options.map((o) =>
            o.header ? (
              <div key={`h:${o.label}`} className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase" style={{ color: C.textFaint }}>{o.label}</div>
            ) : (
              <button key={String(o.value)} type="button" role="option" aria-selected={selected.includes(o.value)} onClick={() => pick(o.value)} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2" style={{ color: C.text, background: selected.includes(o.value) ? C.surface : "transparent" }} data-option={o.value}>
                {multi && <span className="w-3.5 h-3.5 rounded-sm flex items-center justify-center shrink-0" style={{ border: `1px solid ${selected.includes(o.value) ? C.brand : C.border}`, background: selected.includes(o.value) ? C.brand : "transparent" }}>{selected.includes(o.value) && <Check size={10} color="#fff" />}</span>}
                <span className="truncate">{o.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function ModeToggle({ mode, onChange }) {
  const btn = (k, label) => (
    <button key={k} type="button" onClick={() => onChange(k)} aria-pressed={mode === k} data-mode={k} style={{ background: mode === k ? C.brand : "transparent", color: mode === k ? "#fff" : C.textMuted }} className="flex-1 py-1.5 text-sm font-medium rounded-md">
      {label}
    </button>
  );
  return (
    <div className="flex p-0.5 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} data-mode-toggle>
      {btn("proj", "Projection")}
      {btn("stat", "Stats")}
    </div>
  );
}

export function SortDirButton({ dir, onChange }) {
  const Icon = dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return (
    <button type="button" onClick={() => onChange(dir === "asc" ? "desc" : "asc")} title={dir === "asc" ? "Ascending" : "Descending"} aria-label={dir === "asc" ? "Sorted ascending — tap for descending" : "Sorted descending — tap for ascending"} style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} className="rounded-md p-2 shrink-0 self-end" data-sort-dir={dir}>
      <Icon size={16} />
    </button>
  );
}

/**
 * The full set of pickers. view = { mode, categories: [], stats: [], seasons: [], period, weeks: [], dir }.
 * multi = Scouting (multi-select everything); otherwise one category, one stat, one season and one period, plus the
 * ascending/descending button next to the stat. Changing the mode, categories, positions or time drops any stat
 * no longer offered (current-only stats disappear once a time filter is on).
 */
export function StatPickers({ cfg, cur, view, onChange, positions, rows = [], multi = false, firstStat = 1999, firstProj = 2025 }) {
  const time = { seasons: view.seasons, period: view.period, weeks: view.weeks };
  const cats = categoryOptions(cfg, { mode: view.mode, positions, time, cur });
  const statsOffered = statOptions(cfg, { mode: view.mode, categories: view.categories, positions, time, cur });
  const seasons = seasonOptions({ mode: view.mode, cur, rows, firstStat, firstProj });
  const set = (patch) => onChange(normalizeView({ ...view, ...patch }, cfg, { positions, cur }));
  const now = isCurrentTime(time, cur);
  return (
    <div className="space-y-2.5" data-stat-pickers>
      <ModeToggle mode={view.mode} onChange={(mode) => set({ mode, seasons: mode === "proj" ? (view.seasons.filter((y) => y >= firstProj).length ? view.seasons.filter((y) => y >= firstProj) : [cur?.season].filter(Boolean)) : view.seasons })} />
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Dropdown label="Category" testId="category" multi={multi} options={cats.map((c) => ({ value: c, label: c }))} value={multi ? view.categories : view.categories[0] ?? null} placeholder="All categories" onChange={(v) => set({ categories: multi ? v : v == null ? [] : [v] })} />
        </div>
        <div className="flex-1 min-w-0">
          <Dropdown label="Stat" testId="stat" multi={multi} options={statsOffered.map((r) => ({ value: r.id, label: r.stat }))} value={multi ? view.stats : view.stats[0] ?? null} placeholder={multi ? "Choose stats" : "Choose a stat"} onChange={(v) => set({ stats: multi ? v : v == null ? [] : [v] })} />
        </div>
        {!multi && <SortDirButton dir={view.dir || "desc"} onChange={(dir) => set({ dir })} />}
      </div>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Dropdown label={multi ? "Seasons" : "Season"} testId="season" multi={multi} options={seasons.map((y) => ({ value: y, label: String(y) }))} value={multi ? view.seasons : view.seasons[0] ?? null} onChange={(v) => set({ seasons: multi ? (v.length ? v : [cur?.season]) : [v] })} />
        </div>
        <div className="flex-1 min-w-0">
          <Dropdown label="Week / season" testId="period" multi={multi} options={PERIOD_OPTIONS} value={multi ? periodValues(time) : periodValues(time)[0]} onChange={(v, last) => set(periodFromValues(multi ? v : [v], multi ? last : v))} />
        </div>
      </div>
      {!now && <div style={{ color: C.textFaint }} className="text-[11px]" data-time-note>Stats that only exist today (rostered %, age, ECR, article mentions…) aren't offered with a past season or week.</div>}
    </div>
  );
}

export function ClearX({ onClick, label = "Clear" }) {
  return (
    <button type="button" onClick={onClick} style={{ color: C.textMuted }} className="text-[11px] flex items-center gap-1" aria-label={label}>
      <X size={12} /> {label}
    </button>
  );
}
