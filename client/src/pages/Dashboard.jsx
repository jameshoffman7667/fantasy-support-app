import { CheckCircle2, ChevronRight, Loader2, Trophy } from "lucide-react";
import { STATUS_BADGE_TABS, TAB_META } from "../ui/chrome.jsx";
import { Avatar, ErrorScreen, StatusBadge } from "../ui/common.jsx";
import { VarianceButton } from "../ui/modals.jsx";
import { C, STATUS } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  SCREENS                                                            */
/* ------------------------------------------------------------------ */
export function Dashboard({ computed, onOpenLeague, onOpenTab, onLogout, onEditLeagues, onOpenAccount, onOpenAccuracy, sleeperUser, onOpenVariances }) {
  const allVariances = computed.flatMap((lg) => lg.variances || []);
  return (
    <div className="px-4 py-3">
      <div className="flex justify-end pb-2">
        <VarianceButton variances={allVariances} onOpen={() => onOpenVariances({})} label="Variance report — all leagues" />
      </div>
      <div className="space-y-3">
        {computed.map((lg) => (
          <div key={lg.id} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <button onClick={() => onOpenLeague(lg.id)} className="text-left min-w-0 flex-1 flex items-center gap-2.5" data-league-open={lg.id}>
                <Avatar avatar={lg.avatar} name={lg.name} size={34} square />
                <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, color: C.text }} className="text-[15px] truncate">{lg.name}</span>
                  <ChevronRight size={16} style={{ color: C.textFaint }} className="shrink-0" />
                </div>
                <div className="text-xs truncate" style={{ color: C.textMuted }}>
                  {lg.error ? "Failed to load" : lg.teamName || "—"}
                </div>
                </div>
              </button>
              {!lg.error && (
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => onOpenTab(lg.id, "odds")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
                    <Trophy size={11} />
                    Outlook
                  </button>
                  <VarianceButton compact variances={lg.variances || []} onOpen={() => onOpenVariances({ leagueId: lg.id })} />
                </div>
              )}
            </div>
            {!lg.error && (
              <div className="flex items-center gap-1 flex-nowrap overflow-x-auto px-4 pb-2.5 pt-2.5" style={{ borderTop: `1px solid ${C.border}` }} data-badge-row={lg.id}>
                {STATUS_BADGE_TABS.map((key) => (
                  <StatusBadge key={key} status={lg[key].status} label={TAB_META[key].short} compact onClick={() => onOpenTab(lg.id, key)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LeagueOverview({ league, onOpenTab, onOpenVariances }) {
  if (league.error) return <ErrorScreen message={league.error} />;
  const summaries = {
    roster: (() => {
      const L = league.lineup;
      const rosterPart = league.roster.rows.some((r) => r.severity !== "ok")
        ? `${league.roster.rows.filter((r) => r.severity === "major").length} major, ${league.roster.rows.filter((r) => r.severity === "minor").length} minor issue(s)`
        : "Lineup is clean";
      let lineupPart;
      if (L.zeroStarters.length) lineupPart = `${L.zeroStarters.length} starter(s) projected for 0 pts`;
      else if (L.custom) {
        const changed = L.rows.filter((r) => r.changed).length;
        lineupPart = changed === 0 ? "matches your ranking" : `your ranking changes ${changed} slot(s)`;
      } else lineupPart = L.delta === 0 ? "already optimal" : `optimal lineup gains +${L.delta.toFixed(1)} pts`;
      return `${rosterPart} · ${lineupPart}`;
    })(),
    league: !league.privateInfo?.configured
      ? "Settings change log — needs your Sleeper token"
      : league.privateInfo?.readsOff
      ? "Settings change log — reading from Sleeper is switched off"
      : (league.leaguePage?.items || []).filter((i) => !i.cleared).length
      ? `${(league.leaguePage.items || []).filter((i) => !i.cleared).length} settings change(s) to review`
      : "No new settings changes",
    waiver: `${league.waiver.rows.filter((r) => r.severity !== "ok").length} worth a look this week`,
    trade: (league.tradeOffers?.incoming || []).filter((o) => !o.cleared).length
      ? `${(league.tradeOffers.incoming || []).filter((o) => !o.cleared).length} offer(s) waiting on you`
      : league.trade.rows.length
      ? league.trade.rows[0].note
      : "No standout trade opportunities",
    injury: league.injury.rows.filter((r) => !r.seen).length
      ? `${league.injury.rows.filter((r) => !r.seen).length} new injury flag(s)`
      : league.injury.rows.length
      ? `${league.injury.rows.length} tracked, none new`
      : "No injuries on this roster",
  };

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex justify-end">
        <VarianceButton variances={league.variances || []} onOpen={() => onOpenVariances({ leagueId: league.id })} label="Variance report — this league" />
      </div>
      {league.stale && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.minor }} className="text-xs rounded-md px-3 py-2">
          Showing cached data — a live refresh just failed. Try refreshing again shortly.
        </div>
      )}
      {league.dataWarnings?.length > 0 && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textMuted }} className="text-xs rounded-md px-3 py-2 space-y-1">
          {league.dataWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      {STATUS_BADGE_TABS.map((key) => {
        const meta = TAB_META[key];
        const s = STATUS[league[key].status];
        const Icon = meta.Icon;
        return (
          <button key={key} onClick={() => onOpenTab(key)} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-left">
            <div style={{ background: s.bg, color: s.color }} className="p-2 rounded-md shrink-0">
              <Icon size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-[14px]">{meta.label}</div>
              <div style={{ color: C.textMuted }} className="text-xs truncate">{summaries[key]}</div>
            </div>
            <StatusBadge status={league[key].status} compact />
          </button>
        );
      })}
      <button onClick={() => onOpenTab("odds")} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-left">
        <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-2 rounded-md shrink-0">
          <Trophy size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-[14px]">Season Outlook</div>
          <div style={{ color: C.textMuted }} className="text-xs truncate">Playoff &amp; championship odds, simulated</div>
        </div>
        <ChevronRight size={16} style={{ color: C.textFaint }} />
      </button>
    </div>
  );
}

export function SelectLeaguesScreen({ leagues, selectedIds, onToggle, onConfirm, loading, error }) {
  return (
    <div className="px-4 py-3">
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-3">Pick which leagues to track.</div>
      <div className="space-y-1.5">
        {leagues.map((l) => {
          const checked = selectedIds.includes(l.league_id);
          return (
            <button
              key={l.league_id}
              onClick={() => onToggle(l.league_id)}
              style={{ background: C.surface, border: `1px solid ${checked ? C.brand : C.border}` }}
              className="w-full flex items-center justify-between rounded-md px-3.5 py-3 text-left"
            >
              <div className="min-w-0">
                <div style={{ color: C.text }} className="text-sm font-medium truncate">{l.name}</div>
                <div style={{ color: C.textMuted }} className="text-xs">{l.season} season</div>
              </div>
              <div style={{ background: checked ? C.brand : "transparent", border: `1px solid ${checked ? C.brand : C.textFaint}` }} className="w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                {checked && <CheckCircle2 size={14} color={C.bg} />}
              </div>
            </button>
          );
        })}
      </div>
      {error && <div style={{ color: C.major }} className="text-xs px-1 pt-3">{error}</div>}
      <button
        onClick={onConfirm}
        disabled={loading || selectedIds.length === 0}
        style={{ background: loading || selectedIds.length === 0 ? C.surfaceRaised : C.brand, color: C.text }}
        className="w-full rounded-md py-2.5 text-sm font-medium flex items-center justify-center gap-2 mt-4"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : null}
        {loading ? "Pulling rosters + projections…" : `Track ${selectedIds.length} league(s)`}
      </button>
    </div>
  );
}
