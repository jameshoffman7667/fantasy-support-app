import * as api from "../api.js";
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { InfoNote } from "./common.jsx";
import { PlayerLink } from "./playerCard.jsx";
import { C, fmtWhen, inputStyle } from "./theme.js";

/* v4.10: Auto mode's settings card and its "what it would do" preview — moved from Waivers → Available → Auto to the League page. */
// v4.4: Auto mode check box (every league except best ball) and what it has done lately.
export function AutoModeCard({ league, onOpenAccount, onChanged = null }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getAutoMode(league.id).then((r) => alive && setSt(r)).catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [league.id]);
  const act = async (patch) => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.setAutoMode({ leagueId: league.id, ...patch }));
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pk = st?.packages?.[league.id] || { ir: false, roster: false, lineup: false, flex: false, ranking: "all" };
  const on = Boolean(st?.leagues?.[league.id]);
  const faab = Boolean(league.waiverInfo?.faab) && (league.waiverInfo.type == null || Number(league.waiverInfo.type) === 2);
  const [open, setOpen] = useState(true); // v4.8: the section collapses
  const [applyArmed, setApplyArmed] = useState(false); // v4.10: the second tap applies the settings to every league
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (!applyArmed) return undefined;
    const t = setTimeout(() => setApplyArmed(false), 4000);
    return () => clearTimeout(t);
  }, [applyArmed]);
  const PKGS = [
    ["ir", "Auto IR", "Moves players into and out of injured reserve (and fills empty taxi spots)."],
    ["roster", "Auto roster", faab ? "Places $0 bench claims — two more than there are empty bench spots." : "Claims only apply in FAAB leagues — this one is waiver priority."],
    ["lineup", "Auto lineup", "Swaps bench players and starters for the most projected points."],
    ["flex", "Auto flex", "Puts later games into the flex spots (a flex starter swaps with a same-position starter who plays later)."],
  ];
  const RANK_LABEL = { all: "All (trending, then value)", trending: "Trending", hype: "Hype Train", spot: "Spot Start", ros: "ROS", stash: "Stashes", handcuff: "Handcuff" };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 mb-3 text-xs space-y-1.5" data-auto-mode>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between text-left" data-auto-mode-collapse>
        <span style={{ color: C.text }} className="text-sm font-medium">Auto mode {on ? <span style={{ color: C.ok }} className="text-[11px] font-normal">· {PKGS.filter(([k]) => pk[k]).length} of 4 on</span> : <span style={{ color: C.textFaint }} className="text-[11px] font-normal">· off</span>}</span>
        <ChevronRight size={14} style={{ transform: open ? "rotate(90deg)" : "none", color: C.textMuted }} />
      </button>
      {open && (
        <>
          <div style={{ color: C.textMuted }}>
            Runs in this order — IR, roster, lineup, flex — at 6 am Toronto time every day, an hour before kickoffs, and an hour before waivers.
            {" "}<InfoNote label="About Auto mode">Needs "Roster changes"{faab ? " and \"Waiver claims\"" : ""} on in <button type="button" onClick={onOpenAccount} style={{ color: C.brand }} className="underline">Account → Sleeper access</button>. Nothing is ever dropped. The IR and lineup calls have only been confirmed by Sleeper's own answer, never watched live.</InfoNote>
          </div>
          {PKGS.map(([k, label, blurb]) => (
            <label key={k} className="flex items-start gap-2.5" data-auto-pkg={k}>
              <input type="checkbox" checked={Boolean(pk[k])} disabled={busy || !st} onChange={(e) => act({ pkg: k, on: e.target.checked })} className="mt-0.5" data-auto-mode-toggle={k} />
              <span>
                <span style={{ color: C.text }} className="text-sm font-medium">{label}</span>
                <span style={{ color: C.textMuted }} className="block">{blurb}</span>
              </span>
            </label>
          ))}
          {pk.lineup && (
            <label className="flex items-start gap-2 pl-6" style={{ color: C.textMuted }} data-auto-zeros>
              <input type="checkbox" checked={Boolean(pk.zerosOnly)} disabled={busy || !st} onChange={(e) => act({ zerosOnly: e.target.checked })} className="mt-0.5" data-auto-zeros-toggle />
              <span><span style={{ color: C.text }}>Zeros only</span> — only swaps out starters projected 0 because they are on bye or injured (not players with no projection); Auto flex still runs after.</span>
            </label>
          )}
          {pk.roster && faab && (
            <label className="flex items-center gap-2 pl-6" style={{ color: C.textMuted }} data-auto-ranking>
              Pick up players from
              <select value={pk.ranking || "all"} disabled={busy} onChange={(e) => act({ ranking: e.target.value })} style={inputStyle} className="rounded px-1.5 py-1 text-xs" aria-label="Ranking Auto roster picks from" data-auto-ranking-select>
                {(st?.rankings || Object.keys(RANK_LABEL)).map((r) => <option key={r} value={r}>{RANK_LABEL[r] || r}</option>)}
              </select>
            </label>
          )}
          <div className="flex items-center gap-2 flex-wrap" data-auto-apply-all>
            <button type="button" disabled={busy || !st} onClick={() => { if (!applyArmed) return setApplyArmed(true); setApplyArmed(false); act({ applyAll: true }).then(() => setApplied(true)); }} style={{ color: applyArmed ? C.major : C.brand, border: `1px solid ${applyArmed ? C.major : C.brand}66` }} className="rounded-md px-2.5 py-1 text-xs" data-auto-apply-all-btn>
              {applyArmed ? "Tap again to apply to every league" : "Apply these settings to all leagues"}
            </button>
            {applied && !applyArmed && <span style={{ color: C.ok }} className="text-[11px]" data-auto-applied>Applied — the four boxes, zeros only and the pick-up list are now the same in every league.</span>}
          </div>
          {on && (
            <label className="flex items-center gap-2" style={{ color: C.textMuted }}>
              <input type="checkbox" checked={Boolean(st?.paused)} disabled={busy} onChange={(e) => act({ paused: e.target.checked })} data-auto-mode-pause />
              Pause Auto mode in every league
            </label>
          )}
          {on && st?.log?.length > 0 && (
            <div style={{ color: C.textFaint }} className="space-y-0.5" data-auto-mode-log>
              {st.log.slice(0, 5).map((e, i) => (
                <div key={i} style={{ color: e.ok ? C.textMuted : C.minor }}>
                  {fmtWhen(e.at)} · {{ ir: "IR", "ir-out": "IR out", taxi: "Taxi", lineup: "Lineup", flex: "Flex" }[e.kind] || "$0 claim"}{e.player ? ` · ${e.player}` : ""} · {e.ok ? "done" : "not done"}{e.detail ? ` — ${e.detail}` : ""}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {err && <div style={{ color: C.major }}>{err}</div>}
    </div>
  );
}

// v4.7: Waivers → Available → Auto — the check box, then what Auto mode would do right now (text) and the claims that follow.
export function AutoView({ league, onOpenAccount, withCard = true }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const builtAt = league.builtAt || league.cachedAt || null;
  useEffect(() => {
    let alive = true;
    api.getAutoPreview(league.id).then((r) => alive && (setData(r), setErr(null))).catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [league.id, builtAt, tick]);
  return (
    <div data-auto-view>
      {withCard && !league.bestBall && <AutoModeCard league={league} onOpenAccount={onOpenAccount} onChanged={() => setTick((t) => t + 1)} />}
      {err && <div style={{ color: C.major }} className="text-sm px-1 py-2" data-auto-error>{err}</div>}
      {!data && !err && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Working out what Auto mode would do…</div>}
      {data && (
        <>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 mb-3 space-y-1" data-auto-lines>
            <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Auto mode would</div>
            {data.lines.map((l, i) => <div key={i} style={{ color: C.text }} className="text-xs">{l}</div>)}
            <div style={{ color: C.textFaint }} className="text-[10px] pt-0.5">A preview from the last time this league was read — nothing is sent from this page.</div>
          </div>
          <div style={{ color: C.textMuted }} className="text-xs px-1 pb-1.5">Resulting claims{data.claims.length ? ` (${data.claims.length})` : ""}</div>
          {data.claims.length === 0 ? (
            <div style={{ color: C.textMuted }} className="text-sm px-1 py-1" data-auto-claims-empty>No claims.</div>
          ) : (
            <div className="space-y-1.5" data-auto-claims>
              {data.claims.map((c) => (
                <div key={c.addId} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.brand}` }} className="rounded-md px-3 py-2.5" data-auto-claim={c.addId}>
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <PlayerLink player={{ id: c.addId, name: c.name, pos: c.pos, team: c.team }} className="min-w-0 truncate"><span style={{ color: C.text }} className="text-sm font-medium">{c.name}</span></PlayerLink>
                    <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{c.pos}{c.team ? ` · ${c.team}` : ""}</span>
                  </div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">$0 claim, no drop{c.trendCount ? ` · +${Number(c.trendCount).toLocaleString()} adds in 24 h` : ""}{c.value != null ? ` · value ${Math.round(c.value).toLocaleString()}` : ""}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
