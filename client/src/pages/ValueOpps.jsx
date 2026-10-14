import * as api from "../api.js";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InfoNote } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C, POS_COLOR, fmtWhen } from "../ui/theme.js";

/* v4.7 — Trade → Value opportunities: dynasty value sources compared on one 0–100 scale. */
const SRC_COLOR = { ra: "#4f9d69", fc: "#6f8fd6", ktc: "#d29a3a" };
const SRC_SHORT = { ra: "Roster Audit", fc: "FantasyCalc", ktc: "KTC" };
const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE"];

function Dots({ row, sources }) {
  // a 0–100 track with one dot per source; the gap between the outer dots is the spread
  const vals = sources.filter((s) => row.values[s.key]).map((s) => ({ key: s.key, v: row.values[s.key].scaled }));
  const lo = Math.min(...vals.map((x) => x.v));
  const hi = Math.max(...vals.map((x) => x.v));
  return (
    <div className="relative h-4 mt-1.5" role="img" aria-label={vals.map((x) => `${SRC_SHORT[x.key]} ${x.v}`).join(", ")} data-vo-track>
      <div className="absolute left-0 right-0 top-1/2 h-px" style={{ background: C.border }} />
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded" style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%`, background: `${C.minor}88` }} />
      {vals.map((x) => (
        <div key={x.key} className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full" style={{ left: `${Math.min(98, Math.max(2, x.v))}%`, width: 10, height: 10, background: SRC_COLOR[x.key], border: `1px solid ${C.bg}` }} title={`${SRC_SHORT[x.key]}: ${x.v}`} />
      ))}
    </div>
  );
}

export function ValueOpportunities({ league }) {
  const [format, setFormat] = useState(league.superflex ? "sf" : "1qb");
  const [pos, setPos] = useState("ALL");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    api.getValueOpps(format).then((d) => alive && setData(d)).catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [format, tick]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => pos === "ALL" || r.pos === pos), [data, pos]);
  const chip = (active) => ({ background: active ? C.brand : "transparent", color: active ? "#fff" : C.textMuted, border: `1px solid ${active ? C.brand : C.border}` });
  const srcs = data?.sources || [];
  const live = srcs.filter((s) => s.count > 0);
  return (
    <div data-value-opps>
      <div className="flex items-center justify-between gap-2 flex-wrap px-1 pb-2">
        <div className="flex items-center gap-1" data-vo-format>
          {[["sf", "Superflex"], ["1qb", "1QB"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFormat(k)} style={chip(format === k)} className="rounded-full px-2.5 py-0.5 text-[11px]" aria-pressed={format === k} data-vo-format-btn={k}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap" data-vo-pos>
          {POS_FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => setPos(f)} style={chip(pos === f)} className="rounded-full px-2.5 py-0.5 text-[11px]" aria-pressed={pos === f} data-vo-pos-btn={f}>{f === "ALL" ? "All" : f}</button>
          ))}
        </div>
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Dynasty players the value sources disagree on most. Each source is put on a 0–100 scale (0 = its lowest-valued player, 100 = its highest) and the gap is the difference between the highest and lowest.
        <InfoNote label="About value opportunities">Sources: Roster Audit, FantasyCalc (dynasty values) and KeepTradeCut, read through the third-party parse.bot wrapper because KeepTradeCut has no API of its own. {data?.scaledOver === "common" ? `The scale is set over the ${data.commonCount} players every loaded source lists, so a source with a longer tail of cheap players isn't stretched differently.` : "With too few players in common, each source is scaled over its own whole table."} A player a source doesn't list is left out of that source. PPR scoring, no tight-end premium. A big gap means one source rates him much higher — a buy-low or sell-high prompt, not a verdict.</InfoNote>
      </div>
      {!data && !err && <div style={{ color: C.textMuted }} className="text-sm px-1 py-3 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Loading the value sources…</div>}
      {err && <div style={{ color: C.major }} className="text-sm px-1 py-2" data-vo-error>{err}</div>}
      {data && (
        <div className="px-1 pb-2 space-y-0.5 text-[11px]" data-vo-sources>
          {srcs.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5" style={{ color: s.error && !s.count ? C.minor : C.textMuted }} data-vo-source={s.key}>
              <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: SRC_COLOR[s.key] }} />
              <span style={{ color: C.text }}>{s.label}</span>
              <span>
                {!s.configured ? "not set up — add PARSE_API_KEY on the server (see the README)" : s.count ? `${s.count} players${s.stale ? " · yesterday's copy" : ""}${s.at ? ` · read ${fmtWhen(s.at)}` : ""}` : `no values${s.error ? ` (${s.error})` : ""}`}
                {s.key === "ktc" && s.configured && s.unmatched ? ` · ${s.unmatched} not matched to Sleeper players` : ""}
                {s.key === "ktc" && s.configured && s.creditsUsed ? ` · ${s.creditsUsed} of 200 monthly credits used` : ""}
              </span>
            </div>
          ))}
          {live.length < 2 && <div style={{ color: C.minor }}>At least two sources are needed to compare values.</div>}
        </div>
      )}
      {data && live.length >= 2 && rows.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>No players for this filter.</div>}
      {data && live.length >= 2 && (
        <div className="space-y-1.5" data-vo-list>
          {rows.map((r) => (
            <div key={r.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${POS_COLOR[r.pos] || C.border}` }} className="rounded-md px-3 py-2" data-vo-row={r.id}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <PlayerLink player={{ id: r.id, name: r.name, pos: r.pos, team: r.team }} leagueId={league.id} className="min-w-0 truncate"><span style={{ color: C.text }} className="text-sm font-medium">{r.name}</span></PlayerLink>
                  <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{r.pos}{r.team ? ` · ${r.team}` : ""}{r.age != null ? ` · ${Number(r.age).toFixed(0)}` : ""}</span>
                </div>
                <span style={{ color: C.minor, fontVariantNumeric: "tabular-nums" }} className="text-sm font-semibold shrink-0" data-vo-spread>{r.spread.toFixed(0)}</span>
              </div>
              <Dots row={r} sources={srcs} />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px]" style={{ color: C.textMuted }}>
                {srcs.filter((s) => r.values[s.key]).map((s) => (
                  <span key={s.key} data-vo-val={s.key}><span style={{ color: SRC_COLOR[s.key] }}>●</span> {SRC_SHORT[s.key]} <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{r.values[s.key].scaled.toFixed(0)}</span> <span style={{ color: C.textFaint }}>({Math.round(r.values[s.key].raw).toLocaleString()})</span></span>
                ))}
              </div>
              <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">{SRC_SHORT[r.high.key]} rates him {r.spread.toFixed(0)} points higher than {SRC_SHORT[r.low.key]}.</div>
            </div>
          ))}
        </div>
      )}
      {data && <div className="pt-2"><button type="button" onClick={() => setTick((t) => t + 1)} style={{ color: C.brand }} className="text-[11px]">Reload</button></div>}
    </div>
  );
}
