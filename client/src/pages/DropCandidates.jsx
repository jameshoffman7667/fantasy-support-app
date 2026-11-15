import { isLocked } from "../lineup.js";
import { ComplianceFixes, STAGE_PAUSE_MS as PAUSE, useCompliance } from "../ui/rosterCompliance.jsx";
import { clearDrops, dropPool, freeIrReplacements, orderDrops, reconcileIr, syncDrops } from "../waiverPlan.js";
import { useEffect, useMemo, useState } from "react";
import { DragHandle, DragList, MatchupChip, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C } from "../ui/theme.js";

/* v4.8: Waivers → Drop candidates (the first Waivers page): roster compliance + the willing-to-drop ranking. */
export const STAGE_PAUSE_MS = PAUSE;

export function useDropState(league, plan, setPlan) {
  // v4.9: every roster player can be a drop — bench first (lowest number first: projection, a bye player's rest-of-season average, or dynasty value), then starters the same way.
  const bench = useMemo(() => dropPool(league, isLocked), [league]);
  const syncedDrops = useMemo(() => reconcileIr(orderDrops(syncDrops(plan.drops, bench), bench, plan.dropsArranged), league, isLocked), [plan.drops, plan.dropsArranged, bench, league]);
  useEffect(() => {
    const same = syncedDrops.length === plan.drops.length && syncedDrops.every((d, i) => d.id === plan.drops[i].id && d.name === plan.drops[i].name && Boolean(d.willing) === Boolean(plan.drops[i].willing) && (d.irIn ?? null) === (plan.drops[i].irIn ?? null));
    if (!same) setPlan((pl) => ({ ...pl, drops: reconcileIr(orderDrops(syncDrops(pl.drops, bench), bench, pl.dropsArranged), league, isLocked) }));
  }, [syncedDrops, plan.drops, bench, setPlan, league]);
  return { bench, syncedDrops };
}

/* v4.10: the compliance card now lives in ui/rosterCompliance.jsx (shared with the Roster pages). */
function ComplianceCard({ league, onRefresh, onOpenAccount }) {
  const comp = useCompliance(league);
  return <ComplianceFixes league={league} comp={comp} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />;
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
        Tick the players you're willing to drop, most willing first. {plan.dropsArranged ? "Your own order is kept." : "Bench players first, then starters, then injured-reserve players (offered while an IR-eligible bench player is free to take the IR spot; tick one and choose who takes it), each lowest projection first, until you drag them into your own order."} The Claim Generator is built from this.
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
                    {p.dropKind === "dynasty" ? (
                      <span data-drop-metric="dynasty">· {p.dropValue != null ? `Value ${Math.round(p.dropValue)}` : "No value"}</span>
                    ) : p.dropKind === "ros" ? (
                      <span style={{ color: C.minor }} data-drop-metric="ros">· {p.dropValue != null ? `Rest-of-season avg ${p.dropValue.toFixed(1)}` : "No projection"}</span>
                    ) : (
                      <span data-drop-metric="proj">· {p.proj != null ? `Proj ${p.proj.toFixed(1)}` : "No projection"}</span>
                    )}
                    <span data-drop-where>· {p.where === "starter" ? `Starter${p.slot ? ` (${p.slot})` : ""}` : p.where === "ir" ? "Injured reserve" : "Bench"}</span>
                    {st && <span style={{ color: C.minor }} data-drop-status>· {st}</span>}
                    {p.matchup && <MatchupChip player={p} profile={league.scoringProfile} />}
                  </div>
                  {d.isIr && d.willing && (
                    <label className="flex items-center gap-1 mt-1 text-[11px]" style={{ color: C.textMuted }} data-drop-irswap>
                      Bench player who takes the IR spot
                      <select value={d.irIn || ""} onChange={(e) => { const id = e.target.value; const b = (league.bench || []).find((x) => String(x.id) === id); setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench).map((x) => (x.id === d.id ? { ...x, irIn: id, irInName: b?.name ?? null } : x)) })); }} style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, maxWidth: 170 }} className="rounded px-1.5 py-0.5 text-xs outline-none" aria-label={`Bench player who takes the IR spot when ${d.name} is dropped`}>
                        {[...freeIrReplacements(league, syncedDrops, isLocked, d.id), ...(d.irIn && !freeIrReplacements(league, syncedDrops, isLocked, d.id).some((x) => String(x.id) === String(d.irIn)) ? [{ id: d.irIn, name: d.irInName || "Player", pos: "" }] : [])].map((b) => (
                          <option key={b.id} value={String(b.id)}>{b.name}{b.pos ? ` (${b.pos}${b.proj != null ? ` · ${b.proj.toFixed(1)}` : ""})` : ""}</option>
                        ))}
                      </select>
                    </label>
                  )}
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
