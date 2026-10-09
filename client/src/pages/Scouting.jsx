import * as api from "../api.js";
import { Bookmark, Download, Loader2, MoreVertical, Palette, RotateCcw, Search, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { Dropdown, StatPickers } from "../ui/statPickers.jsx";
import { C, POS_COLOR, inputStyle } from "../ui/theme.js";
import { FORMAT_LABEL, POSITIONS, applyMinMax, bandsFor, cellColor, clearColumn, columnRange, cycleSort, fmtValue, leagueStatus, normBands, nextFormat, normalizeView, setSort, sortLevel, sortRows, suggestBands } from "../statsView.js";
import { loadStatsConfig, resetStatsConfig } from "./WaiverPage.jsx";

/**
 * v4.2: Analytics → Scouting. The same pickers as Waivers → All (multi-select here), a position filter and a player
 * search, then a table of every chosen stat for every player (20 at a time) or just the players picked in the search.
 * Tapping a column header opens its definition, source, Min / Max, sort and sort bands. The last setup is kept on
 * the server, and setups can be saved as named bookmarks.
 */
const PAGE = 20;
const EMPTY = (cur) => ({ positions: [], scoringLeagueId: null, mode: "stat", categories: [], stats: ["fpts"], seasons: [cur?.season].filter(Boolean), period: "season", weeks: [], players: [], cols: {}, order: [], format: "band" });

function PositionChips({ value, onChange }) {
  const all = !value.length;
  const chip = (on) => ({ background: on ? C.brand : "transparent", color: on ? "#fff" : C.textMuted, border: `1px solid ${on ? C.brand : C.border}` });
  const toggle = (p) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  return (
    <div className="flex items-center gap-1 flex-wrap" data-scout-positions>
      <button type="button" onClick={() => onChange([])} style={chip(all)} className="rounded-full px-2.5 py-0.5 text-[11px]" aria-pressed={all} data-scout-pos="ALL">All</button>
      {POSITIONS.map((p) => (
        <button key={p} type="button" onClick={() => toggle(p)} style={chip(value.includes(p))} className="rounded-full px-2.5 py-0.5 text-[11px]" aria-pressed={value.includes(p)} data-scout-pos={p}>{p}</button>
      ))}
    </div>
  );
}

/** Search with a live preview of matching players (position filter + text); multi-select; Clear inside. */
function PlayerPicker({ rows, selected, onChange, positions }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [open]);
  const t = q.trim().toLowerCase();
  const pos = new Set(positions.length ? positions : POSITIONS);
  const matches = useMemo(() => (t.length < 2 ? [] : rows.filter((r) => pos.has(r.pos) && `${r.name} ${r.team || ""}`.toLowerCase().includes(t)).slice(0, 40)), [rows, t, positions.join()]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="relative" ref={ref} data-player-picker>
      <label className="flex items-center gap-2 rounded-md px-2 py-1.5" style={inputStyle}>
        <Search size={14} style={{ color: C.textFaint }} />
        <input value={q} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} placeholder={selected.length ? `${selected.length} player${selected.length === 1 ? "" : "s"} picked — search to add more` : "Search players…"} className="flex-1 bg-transparent outline-none text-sm" style={{ color: C.text }} aria-label="Search players" data-player-picker-input />
      </label>
      {open && (t.length >= 2 || selected.length > 0) && (
        <div className="absolute z-40 left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-md shadow-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} role="listbox" aria-multiselectable="true" data-player-preview>
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px]" style={{ color: C.textFaint, borderBottom: `1px solid ${C.border}` }}>
            <span>{selected.length} picked{t.length >= 2 ? ` · ${matches.length} match${matches.length === 1 ? "" : "es"}` : ""}</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="underline" style={{ color: C.textMuted }} data-player-clear>
                Clear players
              </button>
            )}
          </div>
          {(t.length >= 2 ? matches : selected.map((id) => byId.get(id)).filter(Boolean)).map((r) => {
            const on = selected.includes(r.id);
            return (
              <button key={r.id} type="button" role="option" aria-selected={on} onClick={() => toggle(r.id)} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2" style={{ color: C.text, background: on ? C.surface : "transparent" }} data-player-option={r.id}>
                <input type="checkbox" readOnly checked={on} tabIndex={-1} />
                <span className="truncate flex-1">{r.name}</span>
                <span style={{ color: POS_COLOR[r.pos] || C.textFaint }} className="text-[11px] font-semibold">{r.pos}</span>
                <span style={{ color: C.textFaint }} className="text-[11px] w-9 text-right">{r.team || "FA"}</span>
              </button>
            );
          })}
          {t.length >= 2 && matches.length === 0 && <div className="px-3 py-2 text-xs" style={{ color: C.textMuted }}>No player matches “{q.trim()}”.</div>}
        </div>
      )}
    </div>
  );
}

/** Column pop-up: definition, source, Min/Max, sort, sort bands (per position) and Clear. */
function ColumnModal({ id, cfg, state, setState, rows, positions, onClose }) {
  const meta = cfg.rows.find((r) => r.id === id) || { stat: id };
  const def = cfg.defs[id] || {};
  const col = state.cols?.[id] || {};
  const posList = [...new Set(rows.map((r) => r.pos))].filter((p) => !positions.length || positions.includes(p));
  const [bandPos, setBandPos] = useState(posList.length === 1 ? posList[0] : "ALL");
  const bands = col.bands?.[bandPos] || [];
  const setCol = (patch) => setState((s) => ({ ...s, cols: { ...(s.cols || {}), [id]: { ...(s.cols?.[id] || {}), ...patch } } }));
  const setBands = (list) => setCol({ bands: { ...(col.bands || {}), [bandPos]: list } });
  const level = sortLevel(state, id);
  const src = typeof def.src === "object" ? def.src[state.mode] || def.src.stat : def.src;
  const num = (v) => (v === "" || v == null ? "" : v);
  return (
    <Modal title={meta.abbrev && meta.abbrev !== meta.stat ? `${meta.stat} (${meta.abbrev})` : meta.stat} onClose={onClose}>
      <div className="space-y-3 text-sm" data-column-modal={id}>
        <div style={{ color: C.text }}>{def.def || "—"}</div>
        <div style={{ color: C.textFaint }} className="text-xs">Source: {src || "—"}{def.rate ? " · a rate or share: Season average keeps the value over all the chosen games" : ""}</div>
        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: C.textMuted }}>
            Min
            <input value={num(col.min)} onChange={(e) => setCol({ min: e.target.value })} inputMode="decimal" style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none mt-0.5" data-col-min />
          </label>
          <label className="flex-1 text-xs" style={{ color: C.textMuted }}>
            Max
            <input value={num(col.max)} onChange={(e) => setCol({ max: e.target.value })} inputMode="decimal" style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none mt-0.5" data-col-max />
          </label>
        </div>
        <div>
          <div style={{ color: C.textMuted }} className="text-xs mb-1">Sort {level ? `(level ${level})` : ""}</div>
          <div className="flex gap-1.5">
            {[[null, "None"], ["asc", "Ascending"], ["desc", "Descending"]].map(([d, label]) => (
              <button key={label} type="button" onClick={() => setState((s) => setSort(s, id, d))} style={{ background: (col.dir || null) === d ? C.brand : C.surfaceRaised, color: (col.dir || null) === d ? "#fff" : C.textMuted, border: `1px solid ${C.border}` }} className="flex-1 rounded-md py-1.5 text-xs" data-col-sort={d || "none"}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ color: C.textFaint }} className="text-[11px] mt-1">The first sort you set is level 1; each later one sorts within it. Columns with bands sort by band first.</div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span style={{ color: C.textMuted }} className="text-xs">Sort bands</span>
            <div className="flex gap-1 flex-wrap justify-end">
              {["ALL", ...posList].map((p) => (
                <button key={p} type="button" onClick={() => setBandPos(p)} style={{ background: bandPos === p ? C.brand : "transparent", color: bandPos === p ? "#fff" : C.textMuted, border: `1px solid ${bandPos === p ? C.brand : C.border}` }} className="rounded-full px-2 py-0.5 text-[10px]" data-band-pos={p}>
                  {p === "ALL" ? "All positions" : p}
                  {col.bands?.[p]?.length ? " ●" : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1" data-bands>
            {bands.map((b, i) => (
              <div key={i} className="flex items-center gap-1.5" data-band-row={i}>
                <input value={b.label ?? ""} onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Label" style={inputStyle} className="w-20 rounded px-1.5 py-1 text-xs outline-none" aria-label="Band label" />
                <input value={num(b.min)} onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} placeholder="from" inputMode="decimal" style={inputStyle} className="w-16 rounded px-1.5 py-1 text-xs outline-none" aria-label="From (at least)" data-band-min />
                <span style={{ color: C.textFaint }} className="text-[11px]">≤ x &lt;</span>
                <input value={num(b.max)} onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} placeholder="to" inputMode="decimal" style={inputStyle} className="w-16 rounded px-1.5 py-1 text-xs outline-none" aria-label="To (below)" data-band-max />
                <button type="button" onClick={() => setBands(bands.filter((_, j) => j !== i))} style={{ color: C.textMuted }} aria-label="Remove band" data-band-remove>
                  <X size={14} />
                </button>
              </div>
            ))}
            {!bands.length && <div style={{ color: C.textFaint }} className="text-[11px]">No bands — a plain sort by value.</div>}
          </div>
          <div className="flex gap-2 mt-1.5">
            <button type="button" onClick={() => setBands([...bands, { label: "", min: "", max: "" }])} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2 py-1 text-xs" data-band-add>+ Band</button>
            <button type="button" onClick={() => setBands(suggestBands(id, bandPos === "ALL" ? null : bandPos, rows, cfg.defs))} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-2 py-1 text-xs" data-band-suggest>Suggested good / OK / poor</button>
          </div>
          <div style={{ color: C.textFaint }} className="text-[11px] mt-1">Leave "from" or "to" empty for an open end. A position's own bands win over "All positions".</div>
        </div>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={() => (setState((s) => clearColumn(s, id)), onClose())} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="flex-1 rounded-md py-2 text-sm" data-col-clear>Clear this stat</button>
          <button type="button" onClick={onClose} style={{ background: C.brand, color: "#fff" }} className="flex-1 rounded-md py-2 text-sm">Done</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * v4.4: a column header. A tap sorts (new column → bottom level descending; an existing level cycles descending →
 * ascending → off). Press-and-hold (touch or mouse, ~0.5 s), right-click, the ⋮ button that shows when the mouse is
 * over the header, or Shift+Enter / the menu key opens the column pop-up (definition, Min/Max, sort, bands).
 */
const HOLD_MS = 500;
function ColumnHeader({ id, label, title, lvl, dir, flags, onSort, onMenu }) {
  const timer = useRef(null);
  const held = useRef(false);
  const [hover, setHover] = useState(false);
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return (
    <th className="text-right px-2 py-1.5 whitespace-nowrap" onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)} onPointerLeave={() => setHover(false)}>
      <span className="inline-flex items-start gap-0.5">
        {hover && (
          <button type="button" onClick={onMenu} style={{ color: C.textMuted }} className="mt-0.5" aria-label={`${title}: definition, Min / Max, sort and bands`} title="Definition, Min / Max, sort and bands" data-col-menu={id}>
            <MoreVertical size={12} />
          </button>
        )}
        <button
          type="button"
          className="text-right select-none"
          style={{ color: lvl ? C.brand : C.text, WebkitTouchCallout: "none", touchAction: "manipulation" }}
          title={`${title} — tap to sort; hold, right-click or ⋮ for more`}
          data-col-header={id}
          onPointerDown={() => {
            held.current = false;
            stop();
            timer.current = setTimeout(() => {
              held.current = true;
              onMenu();
            }, HOLD_MS);
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => {
            e.preventDefault();
            stop();
            if (!held.current) onMenu();
            held.current = true;
          }}
          onClick={() => {
            if (held.current) {
              held.current = false;
              return;
            }
            onSort();
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" && e.shiftKey) || e.key === "ContextMenu") {
              e.preventDefault();
              onMenu();
            } else held.current = false;
          }}
        >
          {label}
          {lvl ? <span data-sort-level={lvl}> {dir === "asc" ? "↑" : "↓"}{lvl}</span> : null}
          {flags.length ? <span style={{ color: C.textFaint }} className="block text-[9px] font-normal">{flags.join(" · ")}</span> : null}
        </button>
      </span>
    </th>
  );
}

function BookmarkModal({ state, onLoad, onClose }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.getBookmarks().then((r) => setList(r.bookmarks || [])).catch((e) => setErr(e.message));
  }, []);
  const save = async () => {
    if (!name.trim()) return;
    try {
      const r = await api.saveBookmark(name.trim(), state);
      setList(r.bookmarks);
      setName("");
    } catch (e) {
      setErr(e.message);
    }
  };
  const del = async (n) => {
    try {
      setList((await api.deleteBookmark(n)).bookmarks);
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Bookmarks" onClose={onClose}>
      <div className="space-y-3" data-bookmarks>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Name this setup" style={inputStyle} className="flex-1 rounded px-2 py-1.5 text-sm outline-none" data-bookmark-name />
          <button type="button" onClick={save} disabled={!name.trim()} style={{ background: C.brand, color: "#fff", opacity: name.trim() ? 1 : 0.5 }} className="rounded-md px-3 text-sm" data-bookmark-save>Save</button>
        </div>
        {err && <div style={{ color: C.major }} className="text-xs">{err}</div>}
        {!list ? (
          <div style={{ color: C.textMuted }} className="text-xs"><Loader2 size={12} className="inline animate-spin" /> Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-xs">No bookmarks yet.</div>
        ) : (
          <div className="space-y-1">
            {list.map((b) => (
              <div key={b.name} className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} data-bookmark={b.name}>
                <button type="button" onClick={() => onLoad(b.state)} className="flex-1 text-left text-sm truncate" style={{ color: C.text }} data-bookmark-load>{b.name}</button>
                <button type="button" onClick={() => del(b.name)} style={{ color: C.textMuted }} aria-label={`Delete ${b.name}`}><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function StatsSheet({ isOwner, onImported }) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error("Couldn't read the file."));
        r.readAsDataURL(file);
      });
      const out = await api.importStatsSheet(b64);
      setMsg({ ok: true, text: `Saved — ${out.changed} change${out.changed === 1 ? "" : "s"} from ${out.rows} rows.${out.unknown?.length ? ` Unknown IDs ignored: ${out.unknown.join(", ")}.` : ""}${out.missing?.length ? ` Not in the sheet (switched to No): ${out.missing.join(", ")}.` : ""}` });
      onImported?.();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3 py-2.5 text-xs space-y-1.5" data-stats-sheet>
      <div style={{ color: C.text }} className="font-medium">Stats list</div>
      <div style={{ color: C.textMuted }}>Which stats these pickers offer, their names, categories and types come from the stats spreadsheet. Download it, change it in Excel, upload it again.</div>
      <div className="flex gap-2 flex-wrap">
        <a href={api.statsSheetUrl()} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2.5 py-1 flex items-center gap-1" data-sheet-download><Download size={13} /> Download sheet</a>
        {isOwner && (
          <label style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2.5 py-1 flex items-center gap-1 cursor-pointer" data-sheet-upload>
            <Upload size={13} /> {busy ? "Uploading…" : "Upload sheet"}
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
          </label>
        )}
      </div>
      {msg && <div style={{ color: msg.ok ? C.ok : C.major }} data-sheet-result>{msg.text}</div>}
    </div>
  );
}

export function ScoutingPage({ authUser, leagues = [] }) {
  const [cfg, setCfg] = useState(null);
  const [state, setStateRaw] = useState(null);
  const [data, setData] = useState({ loading: false, rows: [], error: null });
  const [shown, setShown] = useState(PAGE);
  const [colModal, setColModal] = useState(null);
  const [bookmarks, setBookmarks] = useState(false);
  const saveT = useRef(null);
  const tracked = leagues.filter((l) => l && !l.error);

  const reloadCfg = () => {
    resetStatsConfig();
    loadStatsConfig().then(setCfg).catch(() => {});
  };
  useEffect(() => {
    let alive = true;
    Promise.all([loadStatsConfig(), api.getStatsView("scouting").catch(() => ({ state: null }))])
      .then(([c, v]) => {
        if (!alive) return;
        setCfg(c);
        setStateRaw({ ...EMPTY(c.cur), ...(v.state || {}) });
      })
      .catch((e) => alive && setData({ loading: false, rows: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, []);
  // Every change is saved (as the last setup) shortly after.
  const setState = (fn) =>
    setStateRaw((prev) => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      clearTimeout(saveT.current);
      saveT.current = setTimeout(() => api.saveStatsView("scouting", next).catch(() => {}), 600);
      return next;
    });
  const scoringLeagueId = state?.scoringLeagueId && tracked.some((l) => l.id === state.scoringLeagueId) ? state.scoringLeagueId : tracked[0]?.id || null;
  const sig = state ? JSON.stringify([state.positions, state.mode, state.seasons, state.period, state.weeks, state.stats, scoringLeagueId]) : null;
  useEffect(() => {
    if (!state) return undefined;
    let alive = true;
    setData((d) => ({ ...d, loading: true, error: null }));
    const t = setTimeout(() => {
      api
        .queryStats({ scope: "all", scoringLeagueId, positions: state.positions, mode: state.mode, time: { seasons: state.seasons, period: state.period, weeks: state.weeks }, stats: state.stats })
        .then((r) => alive && (setData({ loading: false, rows: r.rows || [], error: null, note: r.loaded?.length ? r.loaded.join("; ") : null }), setShown(PAGE)))
        .catch((e) => alive && setData({ loading: false, rows: [], error: e.message }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const table = useMemo(() => {
    if (!state) return [];
    const picked = state.players?.length ? data.rows.filter((r) => state.players.includes(r.id)) : data.rows;
    const cols = Object.fromEntries(Object.entries(state.cols || {}).filter(([id]) => state.stats.includes(id)));
    return sortRows(applyMinMax(picked, cols), state.order.filter((id) => state.stats.includes(id)), cols);
  }, [data.rows, state]);

  // v4.4: the gradient runs worst → best over every player matching the filters (not just the rows shown)
  const ranges = useMemo(() => (state?.format === "gradient" ? Object.fromEntries((state.stats || []).map((id) => [id, columnRange(table, id)])) : {}), [table, state?.format, state?.stats]);

  if (!state || !cfg) return <div className="flex items-center gap-2 px-4 py-6 text-sm" style={{ color: C.textMuted }}>{data.error ? <span style={{ color: C.major }}>{data.error}</span> : <><Loader2 size={16} className="animate-spin" /> Loading Scouting…</>}</div>;

  const positions = state.positions;
  const posForPickers = positions.length ? positions : POSITIONS;
  const view = { mode: state.mode, categories: state.categories, stats: state.stats, seasons: state.seasons, period: state.period, weeks: state.weeks };
  const statName = (id) => cfg.rows.find((r) => r.id === id)?.stat || id;
  const statAbbrev = (id) => cfg.rows.find((r) => r.id === id)?.abbrev || statName(id); // v4.3: short column titles
  const list = state.players?.length ? table : table.slice(0, shown);
  const leagueOpts = tracked.map((l) => ({ value: l.id, label: l.name }));

  return (
    <div className="px-4 py-3 space-y-3" data-scouting>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Scouting</SectionLabel>
        <div className="flex items-center gap-2 pt-2">
          <button type="button" onClick={() => setState((s) => ({ ...s, format: nextFormat(s.format) }))} style={{ color: state.format === "none" ? C.textMuted : C.brand, border: `1px solid ${state.format === "none" ? C.border : `${C.brand}66`}` }} className="rounded-md px-2.5 py-1 text-xs flex items-center gap-1" title="Tap to switch: colours off, band colours, gradient" data-format-toggle={state.format}>
            <Palette size={13} /> {FORMAT_LABEL[state.format] || FORMAT_LABEL.none}
          </button>
          <button type="button" onClick={() => setBookmarks(true)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2.5 py-1 text-xs flex items-center gap-1" data-bookmarks-open>
            <Bookmark size={13} /> Bookmarks
          </button>
          <button type="button" onClick={() => setState((s) => ({ ...s, cols: {}, order: [], categories: [], positions: [], period: "season", weeks: [], seasons: [cfg.cur?.season].filter(Boolean) }))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs flex items-center gap-1" data-scout-clear>
            <RotateCcw size={13} /> Clear
          </button>
        </div>
      </div>
      <PositionChips value={positions} onChange={(p) => setState((s) => normalizeScout({ ...s, positions: p }, cfg))} />
      <PlayerPicker rows={data.rows} selected={state.players || []} onChange={(players) => setState((s) => ({ ...s, players }))} positions={positions} />
      <StatPickers multi cfg={cfg} cur={cfg.cur} view={view} positions={posForPickers} rows={data.rows} firstStat={cfg.firstStatSeason} firstProj={cfg.firstProjSeason} onChange={(v) => setState((s) => ({ ...s, ...v, order: s.order.filter((id) => v.stats.includes(id)) }))} />
      {state.stats.includes("fpts") && leagueOpts.length > 0 && (
        <Dropdown label="Fantasy points scored with" testId="scoring" options={leagueOpts} value={scoringLeagueId} onChange={(v) => setState((s) => ({ ...s, scoringLeagueId: v }))} />
      )}
      <div style={{ color: C.textFaint }} className="text-[11px]" data-scout-count>
        {data.loading ? "Loading…" : `${table.length} player${table.length === 1 ? "" : "s"}${state.players?.length ? " picked" : ""}`} · tap a column to sort · hold, right-click or ⋮ for its definition, Min / Max, sort and bands
      </div>
      {data.error && <div style={{ color: C.major }} className="text-xs">{data.error}</div>}
      {data.note && <div style={{ color: C.textFaint }} className="text-[10px]">Some weeks couldn't load: {data.note}</div>}
      <div className="overflow-x-auto rounded-md" style={{ border: `1px solid ${C.border}` }} data-scout-table>
        <table className="w-full text-xs" style={{ color: C.text, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.surfaceRaised }}>
              <th className="text-left px-2 py-1.5 sticky left-0" style={{ background: C.surfaceRaised, minWidth: 140 }}>Player</th>
              <th className="text-left px-2 py-1.5" style={{ minWidth: 90 }}>Leagues</th>
              {state.stats.map((id) => {
                const c = state.cols?.[id] || {};
                const lvl = sortLevel(state, id);
                const flags = [(c.min !== "" && c.min != null) || (c.max !== "" && c.max != null) ? "min/max" : null, Object.values(c.bands || {}).some((b) => normBands(b).length) ? "bands" : null].filter(Boolean);
                return <ColumnHeader key={id} id={id} label={statAbbrev(id)} title={statName(id)} lvl={lvl} dir={c.dir} flags={flags} onSort={() => setState((s) => cycleSort(s, id))} onMenu={() => setColModal(id)} />;
              })}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const st = leagueStatus(r.id, r.pos, tracked);
              return (
                <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }} data-scout-row={r.id}>
                  <td className="px-2 py-1.5 sticky left-0" style={{ background: C.surface }}>
                    <PlayerLink player={r} className="text-left">
                      <span className="font-medium">{r.name}</span> <span style={{ color: POS_COLOR[r.pos] || C.textFaint }} className="text-[10px] font-semibold">{r.pos}</span> <span style={{ color: C.textFaint }} className="text-[10px]">{r.team || "FA"}</span>
                    </PlayerLink>
                  </td>
                  <td className="px-2 py-1.5 text-[10px]" style={{ color: C.textMuted }} title={[st.mine.length ? `Yours: ${st.mine.join(", ")}` : null, st.available.length ? `Available: ${st.available.join(", ")}` : null].filter(Boolean).join(" · ")} data-league-status>
                    {st.mine.length ? <span style={{ color: C.ok }}>Yours{st.mine.length > 1 ? ` ×${st.mine.length}` : ""}</span> : null}
                    {st.mine.length && st.available.length ? " · " : ""}
                    {st.available.length ? <span style={{ color: C.brand }}>Avail {st.available.length}</span> : null}
                    {!st.mine.length && !st.available.length ? (st.rostered ? "Rostered" : "—") : null}
                  </td>
                  {state.stats.map((id) => {
                    const v = r.values?.[id];
                    const bg = cellColor({ format: state.format, value: v, bands: bandsFor(state.cols?.[id], r.pos), range: ranges[id], better: cfg.defs[id]?.better });
                    return (
                      <td key={id} className="px-2 py-1.5 text-right" style={{ background: bg || undefined, fontVariantNumeric: "tabular-nums" }} data-cell-format={bg ? state.format : undefined}>
                        {fmtValue(id, v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!state.players?.length && shown < table.length && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="w-full rounded-md py-2 text-sm" data-scout-more>
          Load more ({table.length - shown} left)
        </button>
      )}
      <StatsSheet isOwner={authUser?.role === "owner"} onImported={reloadCfg} />
      {colModal && <ColumnModal id={colModal} cfg={cfg} state={state} setState={setState} rows={data.rows} positions={positions} onClose={() => setColModal(null)} />}
      {bookmarks && <BookmarkModal state={state} onClose={() => setBookmarks(false)} onLoad={(s) => (setState({ ...EMPTY(cfg.cur), ...s }), setBookmarks(false))} />}
    </div>
  );
}

function normalizeScout(s, cfg) {
  const v = normalizeView({ mode: s.mode, categories: s.categories, stats: s.stats, seasons: s.seasons, period: s.period, weeks: s.weeks }, cfg, { positions: s.positions.length ? s.positions : POSITIONS, cur: cfg.cur });
  return { ...s, ...v, order: s.order.filter((id) => v.stats.includes(id)) };
}
