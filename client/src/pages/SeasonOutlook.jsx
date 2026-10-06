import * as api from "../api.js";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { C } from "../ui/theme.js";

export function SeasonOutlookTab({ league, sessionId }) {
  const [state, setState] = useState({ loading: true, odds: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, odds: null, error: null });
    api
      .getSeasonOdds(sessionId, league.id)
      .then((result) => {
        if (!cancelled) setState({ loading: false, odds: result.odds, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, odds: null, error: err.message || "Couldn't compute season odds." });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, league.id]);

  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Rest-of-season Monte Carlo simulation (3,000 trials) using each team's season-to-date scoring average against the
        remaining Sleeper schedule — not a full per-player projection re-run for every roster. Treat this as a rough,
        directional read, not a guarantee.
      </div>
      {state.loading && (
        <div className="flex items-center gap-2 px-1 py-4" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">Simulating the rest of the season…</span>
        </div>
      )}
      {state.error && <div style={{ color: C.major }} className="text-xs px-1 py-2">{state.error}</div>}
      {state.odds && (
        <div className="space-y-1.5">
          {state.odds.map((o, i) => (
            <div
              key={i}
              style={{ background: C.surface, border: `1px solid ${o.isMe ? C.brand : C.border}` }}
              className="rounded-md px-3.5 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm truncate">
                  {o.label}
                </div>
                <div style={{ color: C.textMuted }} className="text-xs shrink-0">{o.currentRecord}</div>
              </div>
              <div className="flex items-center gap-4 mt-1.5">
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Proj. wins</div>
                  <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.projectedWins}</div>
                </div>
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Playoff odds</div>
                  <div style={{ color: C.brand, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.playoffPct}%</div>
                </div>
                <div>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Title odds</div>
                  <div style={{ color: C.ok, fontVariantNumeric: "tabular-nums" }} className="text-sm font-medium">{o.championshipPct}%</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
