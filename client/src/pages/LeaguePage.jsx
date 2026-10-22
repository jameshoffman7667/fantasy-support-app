import { useState } from "react";
import { AutoModeCard, AutoView } from "../ui/autoMode.jsx";
import { varianceKey } from "../variances.js";
import { PrivateGate } from "../ui/common.jsx";
import { C } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  v3.0 — League page: settings change log                            */
/* ------------------------------------------------------------------ */
/* v4.10: sub tabs — Auto mode (the check boxes) and Change log (the settings change log that used to be the whole page). */
export function LeaguePage({ league, onClearVariances, onOpenAccount }) {
  const [sub, setSub] = useState("auto");
  const [tick, setTick] = useState(0);
  const tab = (key, label) => (
    <button key={key} type="button" onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-league-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 text-sm font-medium">
      {label}
    </button>
  );
  return (
    <div data-league-tabs>
      <div className="flex mx-4 mt-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        {tab("auto", "Auto mode")}
        {tab("log", "Change log")}
      </div>
      {sub === "auto" ? (
        <div className="px-4 py-3" data-league-auto>
          {league.bestBall ? <div style={{ color: C.textMuted }} className="text-sm">Auto mode isn't available for best ball leagues.</div> : (
            <>
              <AutoModeCard league={league} onOpenAccount={onOpenAccount} onChanged={() => setTick((t) => t + 1)} />
              <AutoView key={`v${tick}`} league={league} onOpenAccount={onOpenAccount} withCard={false} />
            </>
          )}
        </div>
      ) : (
        <ChangeLog league={league} onClearVariances={onClearVariances} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}

function ChangeLog({ league, onClearVariances, onOpenAccount }) {
  const lp = league.leaguePage;
  const items = lp?.items || [];
  const open = items.filter((i) => !i.cleared);
  return (
    <div className="px-4 py-3 space-y-2" data-league-page>
      <div style={{ color: C.textMuted }} className="text-xs px-1">Settings change log — who changed which league setting, with old and new values. Highlighted yellow on the league until you clear it.</div>
      <PrivateGate league={league} onOpenAccount={onOpenAccount}>
        {lp?.error && <div style={{ color: C.major }} className="text-xs px-1">Couldn't read the log from Sleeper: {lp.error}</div>}
        {items.length === 0 && !lp?.error ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-3 text-sm">No settings changes recorded.</div>
        ) : (
          <>
            {open.length > 0 && (
              <div className="flex justify-end">
                <button type="button" onClick={() => onClearVariances(open.map((i) => leagueLogKey(league, i)))} style={{ color: C.minor, border: `1px solid ${C.minor}66` }} className="rounded-md px-2.5 py-1 text-xs" data-clear-league-log>
                  Clear {open.length} change{open.length === 1 ? "" : "s"}
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              {items.map((it) => (
                <div key={it.id} data-log-item={it.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${it.cleared ? C.border : C.minor}` }} className="rounded-md px-3 py-2">
                  <div style={{ color: it.cleared ? C.textMuted : C.text }} className="text-sm">{it.text}</div>
                  {it.at && <div style={{ color: C.textFaint }} className="text-[11px]">{new Date(it.at).toLocaleString()}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </PrivateGate>
    </div>
  );
}

const leagueLogKey = (league, it) => varianceKey(league.id, league.week, "league", "Settings change", `log ${it.id}`);
