import * as api from "../api.js";
import { isLocked } from "../lineup.js";
import { rosterCompliance } from "./compute.js";
import { useMemo, useState } from "react";
import { PrivateGate, PushResults } from "./common.jsx";
import { PlayerLink } from "./playerCard.jsx";
import { C, inputStyle } from "./theme.js";

/*
 * v4.10: roster validity (IR eligibility + roster limit) — one card, used on Waivers → Drop candidates and on both
 * Roster pages. Steps: IR out, IR in, then one drop CARD per player still over the limit, each with a drop-down
 * (like a waiver add card). The eligibility moves always process first, and while they are not enough to make the
 * roster valid the Roster pages hide every other move.
 */
export const STAGE_PAUSE_MS = 10000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Selection state + what it means. `blocking` = the roster can't take moves yet; `valid` = the ticks fix that. */
export function useCompliance(league, { startTicked = true } = {}) {
  // startTicked = false (Roster pages): nothing is ticked until the user ticks it, so the other moves stay hidden until then
  const [outSel, setOutSel] = useState(startTicked ? null : []); // null = defaults (all)
  const [inSel, setInSel] = useState(startTicked ? null : []);
  const [picks, setPicks] = useState([]); // per drop card: a chosen player id, or null = the default
  const [dropOn, setDropOn] = useState([]); // per drop card: ticked? (default: startTicked)
  const base = rosterCompliance(league, { outIds: outSel, inIds: inSel });
  const outIds = outSel ?? base.badIr.map((p) => String(p.id));
  const inIds = inSel ?? base.inSelDefault;
  const pool = useMemo(
    () => (league.bench || []).filter((p) => p && !isLocked(p, league) && !inIds.includes(String(p.id))).sort((a, b) => (a.rostered ?? 101) - (b.rostered ?? 101) || (a.proj ?? 0) - (b.proj ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, inIds.join(",")]
  );
  // one drop per card; a card's own choice stands unless another card has it, otherwise the next-lowest-rostered player
  const cardIds = [];
  for (let i = 0; i < base.over; i++) {
    const want = picks[i] != null && pool.some((p) => String(p.id) === String(picks[i])) && !cardIds.includes(String(picks[i])) ? String(picks[i]) : null;
    const pick = want ?? pool.map((p) => String(p.id)).find((id) => !cardIds.includes(id));
    cardIds.push(pick ?? null);
  }
  const cardOn = cardIds.map((id, i) => id != null && (dropOn[i] ?? startTicked));
  const dropIds = cardIds.filter((id, i) => cardOn[i]);
  const blocking = base.badIr.length > 0 || base.rawOver > 0;
  const valid = !blocking || (base.badIr.every((p) => outIds.includes(String(p.id))) && dropIds.length >= base.over);
  const count = outIds.length + inIds.length + dropIds.length;
  return { base, outSel, setOutSel, inSel, setInSel, picks, setPicks, dropOn, setDropOn, cardIds, cardOn, outIds, inIds, dropIds, pool, blocking, valid, count };
}

/** The staged push: IR out → pause → IR in → pause → drops. Stops at the first step Sleeper doesn't confirm. → { ok, results } */
export async function runComplianceSteps(league, comp, { onRefresh = null, onStage = () => {}, onResult = () => {} } = {}) {
  const { base, outIds, inIds, dropIds } = comp;
  const out = [];
  const add = (r) => { out.push(r); onResult([...out]); return r.ok; };
  const ir = (league.ir || []).filter(Boolean).map((p) => String(p.id));
  try {
    const afterOut = ir.filter((id) => !outIds.includes(id));
    if (outIds.length) {
      onStage("Moving players out of IR…");
      const r = await api.pushReserve(league.id, afterOut);
      if (!add({ label: `IR out: ${base.badIr.filter((p) => outIds.includes(String(p.id))).map((p) => p.name).join(", ")}`, ok: r.ok, verified: r.verified, detail: r.detail })) return { ok: false, results: out };
      await onRefresh?.();
      if (inIds.length || dropIds.length) { onStage("Pausing before the next step…"); await wait(STAGE_PAUSE_MS); }
    }
    if (inIds.length) {
      onStage("Moving players into IR…");
      const r = await api.pushReserve(league.id, [...afterOut, ...inIds]);
      if (!add({ label: `IR in: ${base.inCandidates.filter((p) => inIds.includes(String(p.id))).map((p) => p.name).join(", ")}`, ok: r.ok, verified: r.verified, detail: r.detail })) return { ok: false, results: out };
      await onRefresh?.();
      if (dropIds.length) { onStage("Pausing before the drops…"); await wait(STAGE_PAUSE_MS); }
    }
    for (const id of dropIds) {
      const p = (league.bench || []).find((x) => x && String(x.id) === id);
      onStage(`Dropping ${p?.name || id}…`);
      const r = await api.pushDrop(league.id, id);
      if (!add({ label: `Drop ${p?.name || id}`, ok: r.ok, verified: r.verified, detail: r.detail })) return { ok: false, results: out };
    }
    return { ok: true, results: out };
  } catch (e) {
    add({ label: "Roster fix", ok: false, detail: e.message });
    return { ok: false, results: out };
  }
}

/** The card. `showPush` = its own "Push to Sleeper" button (the Roster pages also push these moves with the lineup). */
export function ComplianceFixes({ league, comp, onRefresh, onOpenAccount, showPush = true, onPushed = null, blockedNote = false }) {
  const { base, outIds, inIds, dropIds, pool, cardIds, cardOn } = comp;
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [results, setResults] = useState([]);
  const ok = base.issues.length === 0;
  const nothing = !comp.count;
  const finalOver = base.over - dropIds.length;
  const toggleId = (list, setter, id, limit = null) => setter(list.includes(id) ? list.filter((x) => x !== id) : limit == null || list.length < limit ? [...list, id] : list);
  const row = (p, checked, onChange, note, key) => (
    <label key={p.id} className="flex items-center gap-2 text-xs py-0.5" style={{ color: C.text }} data-compliance-move={key}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="min-w-0 truncate"><PlayerLink player={p} className="inline underline">{p.name}</PlayerLink> <span style={{ color: C.textFaint }}>{p.pos}{p.status && p.status !== "Healthy" ? ` · ${p.status}` : ""}</span> {note}</span>
    </label>
  );
  const push = async () => {
    setBusy(true);
    setResults([]);
    const r = await runComplianceSteps(league, comp, { onRefresh, onStage: setStage, onResult: setResults });
    setBusy(false);
    setStage(null);
    if (r.results.some((x) => x.ok)) onPushed?.();
    await onRefresh?.();
  };
  const setPick = (i, id) => comp.setPicks((p) => { const n = [...p]; n[i] = id; return n; });
  return (
    <div style={{ background: ok ? C.surface : C.majorBg, border: `1px solid ${ok ? C.border : `${C.major}66`}` }} className="rounded-lg p-3 mb-3 mt-3" data-compliance={ok ? "ok" : "issues"}>
      <div style={{ color: ok ? C.ok : C.major }} className="text-sm font-semibold">{ok ? "Roster is compliant" : comp.blocking ? "Roster needs fixing before other moves" : "Roster tidy-up available"}</div>
      {ok ? (
        <div style={{ color: C.textMuted }} className="text-xs mt-0.5">No ineligible players in IR, no IR-eligible players waiting, and the roster is within its limit ({base.spots} spots).</div>
      ) : (
        <>
          <ul className="text-xs mt-1" style={{ color: C.text }}>{base.issues.map((t) => <li key={t}>• {t}</li>)}</ul>
          {blockedNote && comp.blocking && (
            <div style={{ color: comp.valid ? C.ok : C.minor }} className="text-[11px] mt-1" data-compliance-gate>
              {comp.valid ? "These moves make the roster valid — the other suggested moves are back below. Everything can be pushed together; these moves go first." : "Sleeper blocks roster moves until this is fixed, so the other suggested moves are hidden until the ticked moves below make the roster valid."}
            </div>
          )}
          {base.badIr.length > 0 && (
            <div className="mt-2" data-compliance-out>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Move out of IR (step 1)</div>
              {base.badIr.map((p) => row(p, outIds.includes(String(p.id)), () => toggleId(outIds, comp.setOutSel, String(p.id)), null, `out:${p.id}`))}
            </div>
          )}
          {base.inCandidates.length > 0 && (
            <div className="mt-2" data-compliance-in>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Move into IR (step 2) — {base.irOpenAfterOuts} slot{base.irOpenAfterOuts === 1 ? "" : "s"} free</div>
              {base.inCandidates.map((p) => row(p, inIds.includes(String(p.id)), () => toggleId(inIds, comp.setInSel, String(p.id), base.irOpenAfterOuts), null, `in:${p.id}`))}
            </div>
          )}
          {base.over > 0 && (
            <div className="mt-2 space-y-1.5" data-compliance-drops>
              <div style={{ color: C.textMuted }} className="text-[11px] font-semibold">Drop {base.over} player{base.over === 1 ? "" : "s"} (step 3) — pick who from each list</div>
              {Array.from({ length: base.over }, (_, i) => {
                const cur = cardIds[i] ?? "";
                const taken = new Set(cardIds.filter((x, j) => j !== i && x != null));
                const sel = pool.find((p) => String(p.id) === cur);
                return (
                  <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.major}` }} className="rounded-md px-3 py-2" data-compliance-drop-card={i}>
                    <label style={{ color: C.textMuted }} className="text-[11px] mb-1 flex items-center gap-1.5">
                      <input type="checkbox" checked={Boolean(cardOn[i])} disabled={!cur} onChange={(e) => comp.setDropOn((d) => { const n = [...d]; n[i] = e.target.checked; return n; })} data-compliance-drop-tick={i} />
                      Drop {i + 1} of {base.over}
                    </label>
                    <select value={cur} onChange={(e) => setPick(i, e.target.value)} style={{ ...inputStyle, width: "100%" }} className="rounded px-2 py-1.5 text-sm" aria-label={`Player to drop (${i + 1} of ${base.over})`} data-compliance-drop-select={i}>
                      {!cur && <option value="">Choose a player…</option>}
                      {pool.filter((p) => !taken.has(String(p.id))).map((p) => (
                        <option key={p.id} value={String(p.id)}>{p.name} · {p.pos}{p.team ? ` · ${p.team}` : ""} · {p.rostered != null ? `${p.rostered}% rostered` : "rostered n/a"} · {p.proj != null ? `proj ${Number(p.proj).toFixed(1)}` : "no proj"}</option>
                      ))}
                    </select>
                    {sel && <div style={{ color: C.textMuted }} className="text-[11px] mt-1">Lowest-rostered bench players come first in the list.</div>}
                  </div>
                );
              })}
              <div style={{ color: finalOver > 0 ? C.major : C.ok }} className="text-[11px]" data-compliance-final>{finalOver > 0 ? `Still ${finalOver} over the limit with these ticked.` : "These drops bring the roster within its limit."}</div>
            </div>
          )}
          {showPush && (
            <PrivateGate league={league} group="roster" write onOpenAccount={onOpenAccount}>
              <button type="button" disabled={busy || nothing} onClick={push} style={{ background: C.brand, color: C.text, opacity: busy || nothing ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2 text-sm font-medium mt-3" data-compliance-push>
                {busy ? stage || "Sending…" : "Push to Sleeper"}
              </button>
              <div style={{ color: C.textFaint }} className="text-[10px] mt-1">Runs in steps with a short pause between them: IR moves out, then IR moves in, then drops. It stops at the first step Sleeper does not confirm. The IR move and the drop calls have not been verified against Sleeper yet.</div>
            </PrivateGate>
          )}
          <PushResults results={results} />
        </>
      )}
    </div>
  );
}
