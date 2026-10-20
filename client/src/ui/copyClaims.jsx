import * as api from "../api.js";
import { setBid, stampBids } from "../waiverPlan.js";
import { useEffect, useState } from "react";
import { C, fmtWhen } from "./theme.js";

/* v4.7 — your claims in your other leagues of the same type (Waivers → Available → Copy, and the player card). */

const cache = new Map(); // leagueId -> { at, promise }
const TTL = 60 * 1000;
export function loadCopyClaims(leagueId, force = false) {
  const hit = cache.get(String(leagueId));
  if (!force && hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = api.getCopyClaims(leagueId);
  cache.set(String(leagueId), { at: Date.now(), promise });
  promise.catch(() => cache.delete(String(leagueId)));
  return promise;
}

/** → { data, error, loading, reload } */
export function useCopyClaims(leagueId, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(enabled && leagueId) });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !leagueId) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadCopyClaims(leagueId, tick > 0)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: e.message, loading: false }));
    return () => {
      alive = false;
    };
  }, [leagueId, enabled, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/**
 * v4.8: fill this league's bid for a player with another league's percentage of budget. The Waivers page, when it is
 * open, takes the change into its own plan (so it isn't overwritten by its next save); otherwise the saved plan is
 * updated directly. Returns the dollars bid.
 */
export async function applyCopiedBid(league, player, pct) {
  const budget = Number(league?.waiverInfo?.budget) || 0;
  if (!budget || pct == null) throw new Error("This league has no FAAB budget to apply a percentage to.");
  const dollars = Math.min(Math.round((Number(pct) / 100) * budget), Math.max(0, budget - (league.waiverInfo?.used || 0)));
  const ev = new CustomEvent("fm-plan-bid", { cancelable: true, detail: { leagueId: String(league.id), player, dollars } });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    const plan = await api.getWaiverPlan(league.id);
    await api.saveWaiverPlan(league.id, { ...plan, bids: stampBids(plan.bids || [], setBid(plan.bids || [], player, dollars)) });
  }
  return dollars;
}

const money = (n) => (n == null ? "—" : `$${Number(n).toLocaleString()}`);
const KIND = {
  pending: { label: "Pending", color: () => C.brand },
  won: { label: "Won", color: () => C.ok },
  lost: { label: "Lost", color: () => C.major },
};

/**
 * One line per claim: league · Pending/Won/Lost · bid (% of budget) · winning bid when lost.
 * v4.8: `onUse(entry)` (optional) makes the league name and the bid tappable — tapping fills this league's bid for the
 * player with that claim's percentage of budget. `usedKey` marks the entry just used.
 */
export function CopyEntries({ entries, onUse = null, usedKey = null }) {
  return (
    <div className="space-y-0.5" data-copy-entries>
      {entries.map((e, i) => {
        const k = KIND[e.kind];
        const usable = onUse && e.pct != null;
        const tap = (children, label) => (usable ? (
          <button type="button" onClick={() => onUse(e)} style={{ color: "inherit" }} className="underline decoration-dotted text-left" data-copy-use={e.leagueId} aria-label={label}>{children}</button>
        ) : children);
        return (
          <div key={i} className="text-[11px] flex flex-wrap items-baseline gap-x-1.5" style={{ color: C.textMuted }} data-copy-entry={e.kind}>
            <span style={{ color: C.text }} className="font-medium">{tap(e.leagueName, `Use the ${e.pct}% bid from ${e.leagueName}`)}</span>
            <span style={{ color: k.color() }} className="font-semibold">{k.label}</span>
            <span>
              {e.kind === "pending" && e.bid == null ? "bid not shown (waiver priority)" : tap(`${e.kind === "lost" ? "your bid " : "bid "}${money(e.bid)}${e.pct != null ? ` (${e.pct}%)` : ""}`, `Use the ${e.pct}% bid from ${e.leagueName}`)}
            </span>
            {usedKey != null && usedKey === `${e.leagueId}:${e.kind}:${e.at ?? ""}` && <span style={{ color: C.ok }}>✓ filled</span>}
            {e.kind === "lost" && <span style={{ color: C.textFaint }}>{e.winningBid != null ? `winning bid ${money(e.winningBid)}${e.winningPct != null ? ` (${e.winningPct}%)` : ""}` : "winning bid unknown"}</span>}
            {e.kind === "won" && <span style={{ color: C.textFaint }}>winning bid {money(e.winningBid ?? e.bid)}</span>}
            {e.at ? <span style={{ color: C.textFaint }}>· {fmtWhen(e.at)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
