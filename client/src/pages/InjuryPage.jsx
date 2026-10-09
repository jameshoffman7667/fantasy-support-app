import { InfoNote, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C, STATUS, backupLine } from "../ui/theme.js";

export function InjuryTab({ league }) {
  const io = league.injuryOpportunities;
  const events = io?.events || [];
  const mineByName = new Map(events.filter((e) => e.mine).map((e) => [e.injured.name, e]));
  return (
    <div className="px-4 py-3">
      <SectionLabel>Currently Tracked</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Red the first time a status appears; plain once you've seen it.
      </div>
      {league.injury.rows.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No injury designations on this roster right now.</div>
      ) : (
        <div className="space-y-1.5">
          {league.injury.rows.map((e) => {
            const sev = e.cleared || e.seen ? "ok" : "major"; // v4.4.2: seen before = no colour
            const s = STATUS[sev];
            return (
              <div key={e.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-3.5 py-3 flex items-center gap-3">
                <s.Icon size={16} style={{ color: s.color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <PlayerLink player={{ id: e.playerId, name: e.player }} className="block" style={{ color: C.text }}>
                    <span className="text-sm font-medium">{e.player}</span>
                  </PlayerLink>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{e.status}{e.note ? ` — ${e.note}` : ""}</div>
                  {mineByName.get(e.player) && (
                    <div style={{ color: C.minor }} className="text-[11px] mt-0.5" data-injury-note>
                      Replacements: {mineByName.get(e.player).backups.map(backupLine).join("; ") || "none on the depth chart"}
                      {mineByName.get(e.player).opposite ? `; also ${backupLine({ ...mineByName.get(e.player).opposite, rank: null })}` : ""}
                    </div>
                  )}
                </div>
                <div style={{ color: C.textFaint }} className="text-xs shrink-0">{e.cleared ? "Cleared" : e.seen ? "Seen before" : "New"}</div>
              </div>
            );
          })}
        </div>
      )}
      <SectionLabel>Injury opportunities</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Starters and top backups who are out, doubtful or likely to miss, and who moves up.
        <InfoNote label="About injury opportunities">Covers QB{league.superflex ? "1-2" : "1"}, RB1-2, WR1-3 and TE1. Depth chart from {io?.depthSource?.espnTeams ? `ESPN (${io.depthSource.espnTeams}/32 teams; the rest from Sleeper)` : "Sleeper's depth order (ESPN's depth chart wasn't available)"}.{io?.newsConfigured === false ? " Questionable players are only included when their backup is trending (no Gemini key is set)." : ""}{io?.newsError ? ` The news check failed (${io.newsError.slice(0, 80)}).` : ""}</InfoNote>
      </div>
      {events.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No injuries at these depth-chart slots right now.</div>
      ) : (
        <div className="space-y-1.5" data-injury-opps>
          {events.map((e) => (
            <div key={e.key} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-2.5 space-y-1" data-injury-opp={e.key}>
              <div style={{ color: C.text }} className="text-sm font-medium">
                <span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs mr-1.5">{e.injured.team} {e.injured.slot}</span>
                <PlayerLink player={e.injured} className="inline">{e.injured.name}</PlayerLink> <span style={{ color: C.minor }} className="text-xs font-normal">{e.injured.status}{e.injured.note ? ` — ${e.injured.note}` : ""}</span>
                {e.mine && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">{e.mine === "active" ? "On your roster" : "On your IR/taxi"}</span>}
              </div>
              {e.questionable && <div style={{ color: C.minor }} className="text-[11px]">News check: {(e.signals || []).join("; ")}{e.news?.practice ? ` · practice: ${e.news.practice}` : ""}{e.news?.note ? ` — ${e.news.note}` : ""}</div>}
              {e.backups.length === 0 && <div style={{ color: C.textFaint }} className="text-[11px]">No healthy backups on the depth chart.</div>}
              {e.backups.map((b) => (
                <div key={b.id} style={{ color: C.minor }} className="text-[11px]">{backupLine(b)}</div>
              ))}
              {e.opposite && <div style={{ color: C.minor }} className="text-[11px]">Also consider: {backupLine({ ...e.opposite, rank: null })}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
