import * as api from "../api.js";
import { isLocked } from "../lineup.js";
import { pushKeys } from "../variances.js";
import { useMemo, useState } from "react";
import { ConfirmPush, PrivateGate, PushResults } from "./common.jsx";
import { C, fmtMoney, inputStyle } from "./theme.js";

/**
 * v4.6: "Add" on the player card of an unowned player — bid amount (FAAB leagues), the player to drop, Submit claim.
 * The claim goes through the same private-API push as the Waivers page (opt-in "Waiver claims" switch, confirmed
 * here, read back from Sleeper) and the league is refreshed afterwards, so Pending Claims shows it.
 */
export function claimDropOptions(league) {
  return (league?.bench || []).filter((p) => p && !isLocked(p, league)).sort((a, b) => (a.proj ?? 0) - (b.proj ?? 0));
}

export function ClaimSection({ league, player, onOpenAccount, onRefresh }) {
  const isFaab = Boolean(league.waiverInfo?.faab);
  const remaining = isFaab ? Math.max(0, (league.waiverInfo?.budget || 0) - (league.waiverInfo?.used || 0)) : 0;
  const bench = useMemo(() => claimDropOptions(league), [league]);
  const openSpots = Math.max(0, (league.benchSlots ?? (league.bench || []).length) - (league.bench || []).length);
  const [bid, setBid] = useState("0");
  const [dropId, setDropId] = useState(() => (openSpots > 0 ? "" : bench[0] ? String(bench[0].id) : ""));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const locked = (league.waiverLock?.lockedIds || []).map(String).includes(String(player.id));
  const queued = (league.privateInfo?.claims?.pending || []).filter((x) => (x.adds || []).map(String).includes(String(player.id)));
  const bidN = Math.max(0, Math.min(remaining, Math.round(Number(bid) || 0)));
  const drop = bench.find((p) => String(p.id) === dropId) || null;
  const needsDrop = openSpots <= 0;
  const lines = [`Claim ${player.name}${isFaab ? ` for ${fmtMoney(bidN)}` : ""}`, drop ? `Drop ${drop.name}` : "No player dropped"];
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.pushClaim(league.id, { addId: player.id, dropId: dropId || null, bid: bidN }, { keys: pushKeys(league, "waiver") });
      setResults([{ label: lines[0], ok: r.ok, verified: r.verified, detail: r.detail }]);
      if (r.ok) onRefresh?.(league.id);
    } catch (e) {
      setResults([{ label: lines[0], ok: false, detail: e.message }]);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  if (locked) return <div style={{ color: C.textMuted }} className="text-xs" data-claim-locked>His game has started — he can be claimed once the week's last game ends.</div>;
  return (
    <div className="space-y-2" data-claim-section>
      <PrivateGate league={league} group="claims" onOpenAccount={onOpenAccount}>
        {queued.length > 0 && <div style={{ color: C.minor }} className="text-[11px]">You already have {queued.length} queued claim{queued.length === 1 ? "" : "s"} for him{isFaab ? ` (bid ${queued.map((x) => fmtMoney(Number(x.bid) || 0)).join(", ")})` : ""} — see Waivers → Pending Claims.</div>}
        <div className="grid grid-cols-2 gap-2">
          {isFaab && (
            <label className="text-[11px] block" style={{ color: C.textMuted }}>
              Bid (you have {fmtMoney(remaining)})
              <input type="number" inputMode="numeric" min={0} max={remaining} value={bid} onChange={(e) => setBid(e.target.value)} style={inputStyle} className="w-full rounded-md px-2 py-1.5 text-sm mt-0.5" data-claim-bid />
            </label>
          )}
          <label className={`text-[11px] block ${isFaab ? "" : "col-span-2"}`} style={{ color: C.textMuted }}>
            Drop
            <select value={dropId} onChange={(e) => setDropId(e.target.value)} style={inputStyle} className="w-full rounded-md px-2 py-1.5 text-sm mt-0.5" data-claim-drop>
              {openSpots > 0 && <option value="">No drop ({openSpots} open spot{openSpots === 1 ? "" : "s"})</option>}
              {bench.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name} ({p.pos}{p.proj != null ? ` · ${Number(p.proj).toFixed(1)}` : ""})</option>
              ))}
            </select>
          </label>
        </div>
        {needsDrop && !drop && <div style={{ color: C.minor }} className="text-[11px]">Your bench is full — pick a player to drop.</div>}
        {!confirming ? (
          <button type="button" disabled={needsDrop && !drop} onClick={() => setConfirming(true)} style={{ background: C.brand, color: C.text, opacity: needsDrop && !drop ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2 text-sm font-medium" data-claim-submit>
            Submit claim
          </button>
        ) : (
          <ConfirmPush title="Send this claim to Sleeper?" lines={lines} buttonLabel="Yes, submit it" busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note="The claim is read back from Sleeper afterwards and shows under Waivers → Pending Claims." />
        )}
        <PushResults results={results} />
      </PrivateGate>
    </div>
  );
}
