import * as api from "../api.js";
import { isLocked } from "../lineup.js";
import { rosterCompliance } from "../ui/compute.js";
import { clearDrops, dropPool, orderDrops, syncDrops } from "../waiverPlan.js";
import { useEffect, useMemo, useState } from "react";
import { DragHandle, DragList, MatchupChip, PrivateGate, PushResults, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C } from "../ui/theme.js";

/* v4.8: Waivers → Drop candidates (the first Waivers page): roster compliance + the willing-to-drop ranking. */
export const STAGE_PAUSE_MS = 10000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function useDropState(league, plan, setPlan) {
  // v4.9: every roster player can be a drop — bench first (lowest projection first), then starters the same way.
  const bench = useMemo(() => dropPool(league, isLocked), [league]);
  const syncedDrops = useMemo(() => orderDrops(syncDrops(plan.drops, bench), bench, plan.dropsArranged), [plan.drops, plan.dropsArranged, bench]);
  useEffect(() => {
    const same = syncedDrops.length === plan.drops.length && syncedDrops.every((d, i) => d.id === plan.drops[i].id && d.name === plan.drops[i].name);
    if (!same) setPlan((pl) => ({ ...pl, drops: orderDrops(syncDrops(pl.drops, bench), bench, pl.dropsArranged) }));
  }, [syncedDrops, plan.drops, bench, setPlan]);
  return { bench, syncedDrops };
}

function ComplianceCard({ league, onRefresh, onOpenAccount }) {
  const [outSel, setOutSel] = useState(null); // null = defaults (all)
  const [inSel, setInSel] = useState(null);
  const [dropSel, setDropSel] = useState(null); // null = automatic (as many as needed, lowest first)
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [results, setResults] = useState([]);
  const base = rosterCompliance(league, { outIds: outSel, inIds: inSel });
  const outIds = outSel ?? base.badIr.map((p) => String(p.id));
  const inIds = inSel ?? base.inSelDefault;
  const dropIds = dropSel ?? base.dropList.slice(0, base.dropsNeeded).map((p) => String(p.id));
  const ok = base.issues.length === 0;
  const toggle = (set, setter, id, on, def) => setter(((set ?? def).includes(id) ? (set ?? def).filter((x) => x !== id) : [...(set ?? def), id]));
  const finalOver = base.over - dropIds.filter((id) => base.dropList.some((p) => String(p.id) === id)).length;
  const nothing = !outIds.length && !inIds.length && !dropIds.length;
  const row = (p, checked, onChange, note, key) => (
    <label key={p.id} className="flex items-center gap-2 text-xs py-0.5" style={{ color: C.text }} data-compliance-move={key}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="min-w-0 truncate"><PlayerLink player={p} className="inline underline">{p.name}</PlayerLink> <span style={{ color: C.textFaint }}>{p.pos}{p.status && p.status !== "Healthy" ? ` · ${p.status}` : ""}</span> {note}</span>
    </label>
  );
  const push = async () => {
    setBusy(true);
    setResults([]);
    const out = [];
    const add = (r) => { out.push(r); setResults([...out]); return r.ok; };
    const ir = (league.ir || []).filter(Boolean).map((p) => String(p.id));
    try {
      const afterOut = ir.filter((id) => !outIds.includes(id));
      if (outIds.length) {
        setStage("Moving players out of IR…");
        const r = await api.pushReserve(league.id, afterOut);
        if (!add({ label: `IR out: ${base.badIr.filter((p) => outIds.includes(String(p.id))).map((p) => p.name).join(", ")}`, ok: r.ok, verified: r.verified, detail: r.detail })) return;
        await onRefresh?.();
        if (inIds.length || dropIds.length) { setStage("Pausing before the next step…"); await wait(STAGE_PAUSE_MS); }
      }
      if (inIds.length) {
        setStage("Moving players into IR…");
        const r = await api.pushReserve(league.id, [...afterOut, ...inIds]);
        if (!add({ label: `IR in: ${base.inCandidates.filter((p) => inIds.includes(String(p.id))).map((p) => p.name).join(", ")}`, ok: r.ok, verified: r.verified, detail: r.detail })) return;
        await onRefresh?.();
        if (dropIds.length) { setStage("Pausing before the drops…"); await wait(STAGE_PAUSE_MS); }
      }
      for (const id of dropIds) {
        const p = base.dropList.find((x) => String(x.id) === id);
        setStage(`Dropping ${p?.name || id}…`);
        const r = await api.pushDrop(league.id, id);
        if (!add({ label: `Drop ${p?.name || id}`, ok: r.ok, verified: r.verified, detail: r.detail })) return;
      }
      await onRefresh?.();
    } catch (e) {
      add({ label: "Roster fix", ok: false, detail: e.message });
    } finally {
      setBusy(false);
      setStage(null);
    }
  };
  return (
    <div style={{ background: ok ? C.surface : C.majorBg, border: `1px solid ${ok ? C.border : `${C.major}66`}` }} className="rounded-lg p-3 mb-3" data-compliance={ok ? "ok" : "issues"}>
      <div style={{ color: ok ? C.ok : C.major }} className="text-sm font-semibold">{ok ? "Roster is compliant" : "Roster needs fixing"}</div>
      {ok ? (
        <div style={{ color: C.textMuted }} className="text-xs mt-0.5">No ineligible players in IR, no IR-eligible players waiting, and the roster is within its limit ({base.spots} spots).</div>
      ) : (
        <>
          <ul className="text-xs mt-1" style={{ color: C.text }}>{base.issues.map((t) => <li key={t}>• {t}</li>)}</ul>
          {base.badIr.length > 0 && (
            <div className="mt-2" data-compliance-out>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Move out of IR (step 1)</div>
              {base.badIr.map((p) => row(p, outIds.includes(String(p.id)), () => setOutSel(outIds.includes(String(p.id)) ? outIds.filter((x) => x !== String(p.id)) : [...outIds, String(p.id)]), null, `out:${p.id}`))}
            </div>
          )}
          {base.inCandidates.length > 0 && (
            <div className="mt-2" data-compliance-in>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Move into IR (step 2) — {base.irOpenAfterOuts} slot{base.irOpenAfterOuts === 1 ? "" : "s"} free</div>
              {base.inCandidates.map((p) => row(p, inIds.includes(String(p.id)), () => setInSel(inIds.includes(String(p.id)) ? inIds.filter((x) => x !== String(p.id)) : inIds.length < base.irOpenAfterOuts ? [...inIds, String(p.id)] : inIds), null, `in:${p.id}`))}
            </div>
          )}
          {(base.over > 0 || dropIds.length > 0) && (
            <div className="mt-2" data-compliance-drops>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Drop — {base.over} still over the limit after the IR moves (step 3; lowest-rostered first)</div>
              {base.dropList.map((p) => row(p, dropIds.includes(String(p.id)), () => setDropSel(dropIds.includes(String(p.id)) ? dropIds.filter((x) => x !== String(p.id)) : [...dropIds, String(p.id)]), <span style={{ color: C.textFaint }}>{p.rostered != null ? `${p.rostered}% rostered` : "rostered % n/a"}</span>, `drop:${p.id}`))}
              <div style={{ color: finalOver > 0 ? C.major : C.ok }} className="text-[11px] mt-0.5" data-compliance-final>{finalOver > 0 ? `Still ${finalOver} over the limit with these ticked.` : finalOver < 0 ? `${-finalOver} more than needed ticked.` : "These moves bring the roster within its limit."}</div>
            </div>
          )}
          <PrivateGate league={league} group="roster" write onOpenAccount={onOpenAccount}>
            <button type="button" disabled={busy || nothing} onClick={push} style={{ background: C.brand, color: C.text, opacity: busy || nothing ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2 text-sm font-medium mt-3" data-compliance-push>
              {busy ? stage || "Sending…" : "Push to Sleeper"}
            </button>
            <div style={{ color: C.textFaint }} className="text-[10px] mt-1">Runs in steps with a short pause between them: IR moves out, then IR moves in, then drops. It stops at the first step Sleeper does not confirm. The IR move and the drop calls have not been verified against Sleeper yet.</div>
          </PrivateGate>
          <PushResults results={results} />
        </>
      )}
    </div>
  );
}

export function DropCandidatesPage({ league, plan, setPlan, onRefresh, onOpenAccount }) {
  const { bench, syncedDrops } = useDropState(league, plan, setPlan);
  const benchById = useMemo(() => new Map(bench.map((p) => [String(p.id), p])), [bench]);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const moveDrops = (keys) => setPlan((pl) => {
    const cur = syncDrops(pl.drops, bench);
    const byId = new Map(cur.map((d) => [d.id, d]));
    return { ...pl, drops: keys.map((k) => byId.get(k)).filter(Boolean), dropsArranged: true };
  });
  return (
    <div data-drop-candidates>
      <ComplianceCard league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Drop candidates</SectionLabel>
        <div className="flex items-center gap-2 pt-3">
          {plan.dropsArranged && (
            <button type="button" onClick={() => setPlan((pl) => ({ ...pl, dropsArranged: false }))} style={{ color: C.textMuted }} className="text-[11px] underline" data-drops-default>Sort by projection</button>
          )}
          <button type="button" onClick={() => { if (!armed) return setArmed(true); setArmed(false); setPlan((pl) => ({ ...pl, drops: clearDrops(syncDrops(pl.drops, bench)) })); }} disabled={!syncedDrops.some((d) => d.willing)} style={{ color: armed ? C.major : C.textMuted, border: `1px solid ${armed ? C.major : C.border}`, opacity: syncedDrops.some((d) => d.willing) ? 1 : 0.5 }} className="text-xs rounded-md px-2 py-1" data-clear-drops>
            {armed ? "Tap again to clear" : "Clear all"}
          </button>
        </div>
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Tick the players you're willing to drop, most willing first. {plan.dropsArranged ? "Your own order is kept." : "Bench players first, then starters, each lowest projection first, until you drag them into your own order."} The Claim Generator is built from this.
      </div>
      {syncedDrops.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-2">No players to drop.</div>
      ) : (
        <DragList
          items={syncedDrops}
          getKey={(d) => d.id}
          onReorder={moveDrops}
          label="Drag to rank the player you would drop"
          render={(d, { handleProps, dragging }) => {
            const p = benchById.get(String(d.id)) || { id: d.id, name: d.name, pos: d.pos };
            const st = p.status && p.status !== "Healthy" ? p.status : null;
            return (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-center gap-2" data-drop-row={d.id}>
                <DragHandle handleProps={handleProps} dragging={dragging} />
                <span style={{ color: C.textFaint, fontVariantNumeric: "tabular-nums" }} className="text-xs w-5 text-right shrink-0">{syncedDrops.findIndex((x) => x.id === d.id) + 1}</span>
                <div className="min-w-0 flex-1">
                  <PlayerLink player={p} className="block min-w-0 truncate">
                    <span style={{ color: C.text }} className="text-sm">{d.name}</span> <span style={{ color: C.textFaint }} className="text-[11px]">{d.pos}{p.team ? ` · ${p.team}` : ""}</span>
                  </PlayerLink>
                  <div style={{ color: C.textMuted }} className="text-[11px] flex items-center gap-1.5 flex-wrap mt-0.5" data-drop-info>
                    <span data-drop-rostered>{p.rostered != null ? `${p.rostered}% rostered` : "rostered % n/a"}</span>
                    <span>· {p.proj != null ? `Proj ${p.proj.toFixed(1)}` : "No projection"}</span>
                    <span data-drop-where>· {p.where === "starter" ? `Starter${p.slot ? ` (${p.slot})` : ""}` : "Bench"}</span>
                    {st && <span style={{ color: st === "Bye" ? C.textMuted : C.minor }} data-drop-status>· {st}</span>}
                    {p.matchup && <MatchupChip player={p} profile={league.scoringProfile} />}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-xs shrink-0" style={{ color: C.textMuted }}>
                  <input type="checkbox" checked={d.willing} onChange={(e) => setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench).map((x) => (x.id === d.id ? { ...x, willing: e.target.checked } : x)) }))} data-willing />
                  Willing
                </label>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
