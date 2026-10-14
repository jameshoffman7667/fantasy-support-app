import * as api from "../api.js";
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

const money = (n) => (n == null ? "—" : `$${Number(n).toLocaleString()}`);
const KIND = {
  pending: { label: "Pending", color: () => C.brand },
  won: { label: "Won", color: () => C.ok },
  lost: { label: "Lost", color: () => C.major },
};

/** One line per claim: league · Pending/Won/Lost · bid (% of budget) · winning bid when lost. */
export function CopyEntries({ entries }) {
  return (
    <div className="space-y-0.5" data-copy-entries>
      {entries.map((e, i) => {
        const k = KIND[e.kind];
        return (
          <div key={i} className="text-[11px] flex flex-wrap items-baseline gap-x-1.5" style={{ color: C.textMuted }} data-copy-entry={e.kind}>
            <span style={{ color: C.text }} className="font-medium">{e.leagueName}</span>
            <span style={{ color: k.color() }} className="font-semibold">{k.label}</span>
            <span>
              {e.kind === "pending" && e.bid == null ? "bid not shown (waiver priority)" : `${e.kind === "lost" ? "your bid " : "bid "}${money(e.bid)}${e.pct != null ? ` (${e.pct}%)` : ""}`}
            </span>
            {e.kind === "lost" && <span style={{ color: C.textFaint }}>{e.winningBid != null ? `winning bid ${money(e.winningBid)}${e.winningPct != null ? ` (${e.winningPct}%)` : ""}` : "winning bid unknown"}</span>}
            {e.kind === "won" && <span style={{ color: C.textFaint }}>winning bid {money(e.winningBid ?? e.bid)}</span>}
            {e.at ? <span style={{ color: C.textFaint }}>· {fmtWhen(e.at)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
