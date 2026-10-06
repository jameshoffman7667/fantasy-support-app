import * as api from "../api.js";
import { isLocked } from "../lineup.js";
import { pushKeys } from "../variances.js";
import { claimKey, describeClaim, effectiveClaims, flatten, groupClaims, resetClaims, setBid, simulate, syncDrops, toDollars } from "../waiverPlan.js";
import { ChevronRight, DollarSign, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BidBox, ConfirmPush, DragHandle, DragList, EntryModeToggle, Headshot, MatchupChip, PrivateGate, PushResults, SectionLabel, SourceTag, UsageBadge, WeatherChip } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C, POS_COLOR, STATUS, fmtInt, fmtMoney, fmtPct, fmtWhen, inputStyle } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  WAIVERS (v2.9): Available page + Claims page                       */
/* ------------------------------------------------------------------ */
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

function FaabPanel({ faab, onRun }) {
  const { loading, result, error } = faab;
  const h = result?.history;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm flex items-center gap-1.5">
          <DollarSign size={14} style={{ color: C.brand }} />
          FAAB Suggestions
        </div>
        <button onClick={onRun} disabled={loading} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          {loading ? <Loader2 size={12} className="animate-spin" /> : null}
          {loading ? "Calculating…" : result ? "Refresh" : "Get suggestions"}
        </button>
      </div>
      <div style={{ color: C.textMuted }} className="text-[11px] mb-2">
        Based on winning waiver bids over the last 21 days in your tracked leagues and — when the opponent report is on (Opponents tab) — your opponents' other leagues of the same type. Not platform-wide (Sleeper's API doesn't expose that); treat it as a directional guide, not a confidence interval.
      </div>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {result?.note && <div style={{ color: C.textMuted }} className="text-xs">{result.note}</div>}
      {h && (h.bids.length > 0 || Object.keys(h.byPosition || {}).length > 0) && (
        <div className="mt-1 mb-2" data-faab-history>
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide mb-1">Bid history · {h.windowLabel}</div>
          {Object.entries(h.byPosition).length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {Object.entries(h.byPosition).map(([pos, v]) => (
                <span key={pos} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-[10px] rounded px-1.5 py-0.5">
                  {pos}: median ${v.median} ({v.medianPct}%), max ${v.max}, n={v.n}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-0.5">
            {h.bids.map((b, i) => (
              <div key={i} style={{ color: C.textMuted }} className="text-[11px] flex justify-between gap-2">
                <span className="truncate">{b.playerName} <span style={{ color: C.textFaint }}>({b.pos}) · {b.leagueName}</span></span>
                <span className="shrink-0">${b.bid} <span style={{ color: C.textFaint }}>({b.pct}%)</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
      {result?.players?.length > 0 && <div style={{ color: C.textFaint }} className="text-[10px]">Suggested bids (70% / 95% level) appear on each player below.</div>}
    </div>
  );
}

function DropSummary({ league }) {
  const d = league.dropSummary;
  const [open, setOpen] = useState(true);
  if (!d) return null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 mb-3" data-drop-summary>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between" aria-expanded={open}>
        <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">Dropped in the last {d.windowDays} days</span>
        <span style={{ color: C.textFaint }} className="text-xs">{d.items.length}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {d.error && <div style={{ color: C.major }} className="text-xs">Couldn't load transactions: {d.error}</div>}
          {!d.error && d.items.length === 0 && <div style={{ color: C.textMuted }} className="text-xs">No drops in this league in the last {d.windowDays} days.</div>}
          {d.items.map((x, i) => (
            <div key={i} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <PlayerLink player={{ id: x.playerId, name: x.name, pos: x.pos, team: x.team }} className="inline" style={{ color: C.text }}>{x.name}</PlayerLink> <span style={{ color: C.textFaint }}>({x.pos}{x.team ? ` · ${x.team}` : ""})</span>
                <div style={{ color: C.textFaint }} className="text-[10px]">dropped by {x.teamLabel || "a team"} · {fmtWhen(x.at)}</div>
              </div>
              <div className="text-right shrink-0">
                <div style={{ color: x.available ? C.ok : C.textMuted }} className="text-[11px]">{x.available ? "Available" : x.locked ? "Locked until week ends" : x.readded ? "Re-added" : "Rostered"}</div>
                {x.proj != null && <div style={{ color: C.textFaint }} className="text-[10px]">proj {x.proj.toFixed(1)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// v3.7: what matters for this league type — dynasty value and age, or rest-of-season points.
function TypeExtras({ p, leagueType }) {
  const bits = [];
  if (leagueType === "dynasty") {
    if (p.value != null) bits.push(`Value ${fmtInt(p.value)}`);
    if (p.age != null) bits.push(`${Number(p.age).toFixed(1)} y/o`);
    if (p.rookie) bits.push("Rookie");
  } else if (p.ros != null) bits.push(`Rest of season ${Number(p.ros).toFixed(1)} pts`);
  if (!bits.length) return null;
  return <div style={{ color: C.brand }} className="text-[11px] mt-0.5" data-type-extras>{bits.join(" · ")}</div>;
}

function AvailableRow({ p, plan, mode, budget, isFaab, faabHint, onBid, profile, leagueType }) {
  const s = STATUS[p.severity] || STATUS.ok;
  const bid = (plan.bids || []).find((b) => b.id === p.id);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="relative rounded-md px-3 py-2.5 pb-4" data-fa={p.id}>
      <div className="flex items-start gap-2.5">
        <PlayerLink player={p} className="shrink-0 rounded-full">
          <Headshot player={p} size={34} />
        </PlayerLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <PlayerLink player={p} className="min-w-0 truncate">
              <span style={{ color: C.text }} className="text-sm font-medium">{p.name}</span>
            </PlayerLink>
            <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{p.pos}{p.team ? ` · ${p.team}` : ""}{p.bye ? ` · Bye ${p.bye}` : ""}</span>
          </div>
          <div style={{ color: C.textMuted }} className="text-xs mt-0.5">
            {p.proj != null ? `Proj ${p.proj.toFixed(1)}` : "No projection"}
            {p.topProj ? ` · #${p.projRank} projected at ${p.pos}` : ""}
            {p.trending ? ` · Trending add${p.trendCount ? ` (+${p.trendCount})` : ""}` : ""}
          </div>
          <TypeExtras p={p} leagueType={leagueType} />
          {p.status && p.status !== "Healthy" && <div style={{ color: C.minor }} className="text-[11px]">{p.status}</div>}
          {(p.matchup || p.weather) && (
            <div className="flex items-center gap-1 flex-wrap mt-1">
              <MatchupChip player={p} profile={profile} />
              <WeatherChip player={p} />
            </div>
          )}
          {p.note && p.rule && <div style={{ color: s.color }} className="text-[11px] mt-1">{p.rule === "Free agent outprojects a starter" ? "Beats a starter" : "Beats a bench player"}: {p.note}</div>}
          {p.usage && <div className="mt-1"><UsageBadge usage={p.usage} /></div>}
          {p.crossLeagues?.length > 0 && <div style={{ color: C.brand }} className="text-[11px] mt-1">Also available in: {p.crossLeagues.join(", ")}</div>}
          {faabHint && (
            <div style={{ color: C.textFaint }} className="text-[10px] mt-1">
              Suggested bid: {fmtMoney((budget * faabHint.suggestion70Pct) / 100)} (70%) · {fmtMoney((budget * faabHint.suggestion95Pct) / 100)} (95%) · n={faabHint.sampleSize}
              {faabHint.playerBids?.length ? ` · this player: ${faabHint.playerBids.map((b) => `$${b.bid}`).join(", ")}` : ""}
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {isFaab ? (
            <BidBox dollars={bid ? bid.bid : null} mode={mode} budget={budget} onCommit={(d) => onBid(p, d)} ariaLabel={`Bid for ${p.name}`} />
          ) : (
            <button type="button" onClick={() => onBid(p, bid ? null : 0)} style={{ color: bid ? C.ok : C.brand, border: `1px solid ${bid ? C.ok : C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-claim-toggle>
              {bid ? "Claimed ✓" : "Add claim"}
            </button>
          )}
          {bid && <span style={{ color: C.ok }} className="text-[10px]">on Claims page</span>}
        </div>
      </div>
      <SourceTag source={p.projSource} factor={p.projFactor} />
    </div>
  );
}

// v3.1: pickups caused by injuries at relevant depth-chart slots (only players you can actually claim).
function InjuryAddsSection({ league, plan, mode, budget, isFaab, onBid }) {
  const events = (league.injuryOpportunities?.events || []).filter((e) => (e.freeAdds || []).length > 0 && (!e.questionable || e.flagged));
  if (events.length === 0) return null;
  const sevOf = (e) => {
    const v = (league.variances || []).find((x) => x.page === "waiver" && x.subject === `${e.injured.name} (${e.injured.status})`);
    return v && !v.cleared ? (v.severity === "major" ? "major" : "minor") : "ok";
  };
  return (
    <div className="mb-3" data-injury-adds>
      <SectionLabel>Injury adds — {events.length}</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Starters and top backups who are out, doubtful or likely to miss (QB{league.superflex ? "1-2" : "1"}, RB1-2, WR1-3, TE1), and the next players on their depth chart. Only players you can claim are listed.
      </div>
      <div className="space-y-2.5">
        {events.map((e) => {
          const sev = sevOf(e);
          const s = STATUS[sev];
          return (
            <div key={e.key} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${s.color}` }} className="rounded-md px-2.5 py-2.5 space-y-1.5" data-injury-event={e.key}>
              <div style={{ color: C.text }} className="text-sm">
                <span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-xs mr-1.5">{e.injured.team} {e.injured.slot}</span>
                <PlayerLink player={e.injured} className="inline">{e.injured.name}</PlayerLink> <span style={{ color: s.color }} className="text-xs">{e.injured.status}{e.injured.note ? ` — ${e.injured.note}` : ""}</span>
                {e.mine === "active" && <span style={{ color: C.major }} className="text-[10px] ml-1.5">On your roster</span>}
              </div>
              {e.questionable && <div style={{ color: C.minor }} className="text-[11px]">News check: {(e.signals || []).join("; ")}{e.news?.note ? ` — ${e.news.note}` : ""}</div>}
              <div className="space-y-1.5">
                {e.freeAdds.map((p) => (
                  <div key={p.id}>
                    {p.pos !== e.injured.pos && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-0.5">Also consider (top available {p.pos})</div>}
                    <AvailableRow p={{ ...p, severity: "ok" }} plan={plan} mode={mode} budget={budget} isFaab={isFaab} faabHint={null} onBid={onBid} profile={league.scoringProfile} leagueType={league.leagueType} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AvailablePage({ league, plan, setPlan, faab, onRunFaab }) {
  const budget = league.waiverInfo?.budget || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const hints = new Map((faab.result?.players || []).map((x) => [x.name, x]));
  const dynasty = league.leagueType === "dynasty";
  // v3.7: sort by this week's projection, or by what matters for the league type (dynasty value / rest of season).
  const [sortBy, setSortBy] = useState("week");
  const keyOf = (r) => (sortBy === "week" ? r.proj : dynasty ? r.value : r.ros) ?? -1;
  const groups = POS_ORDER.map((pos) => ({
    pos,
    rows: (league.waiver.rows || []).filter((r) => r.pos === pos).sort((a, b) => keyOf(b) - keyOf(a) || (b.proj ?? -1) - (a.proj ?? -1)),
  })).filter((g) => g.rows.length);
  const hasType = (league.waiver.rows || []).some((r) => (dynasty ? r.value != null : r.ros != null));
  const onBid = (p, dollars) => setPlan((pl) => ({ ...pl, bids: setBid(pl.bids, p, dollars) }));
  return (
    <div>
      {isFaab && <FaabPanel faab={faab} onRun={onRunFaab} />}
      <InjuryAddsSection league={league} plan={plan} mode={mode} budget={budget} isFaab={isFaab} onBid={onBid} />
      <DropSummary league={league} />
      <div className="flex items-center justify-between gap-2 px-1 pb-2 flex-wrap">
        <div style={{ color: C.textMuted }} className="text-xs max-w-[60%]">
          Top 5 projected and top 5 trending free agents at each position, by projection. {isFaab ? "Enter a bid (0 counts) to add a claim." : "Tap “Add claim” to add a claim."}
        </div>
        {isFaab && <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />}
      </div>
      {hasType && (
        <div className="flex items-center gap-1.5 px-1 pb-2 text-[11px]" data-waiver-sort>
          <span style={{ color: C.textMuted }}>Sort by</span>
          {[["week", "This week"], ["type", dynasty ? "Dynasty value" : "Rest of season"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSortBy(k)} style={{ background: sortBy === k ? C.brand : "transparent", color: sortBy === k ? "#fff" : C.textMuted, border: `1px solid ${C.border}` }} className="rounded-full px-2.5 py-0.5" data-waiver-sort-by={k}>{label}</button>
          ))}
        </div>
      )}
      {dynasty && (league.dynastyStash || []).length > 0 && (
        <div className="mb-2" data-dynasty-stash>
          <SectionLabel>Dynasty stashes — best available by dynasty value</SectionLabel>
          <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">Players who may not help this week but hold long-term value ({league.tradeBasis?.value || "trade values"}).</div>
          <div className="space-y-1.5">
            {league.dynastyStash.map((p) => (
              <AvailableRow key={p.id} p={{ ...p, severity: "ok" }} plan={plan} mode={mode} budget={budget} isFaab={isFaab} faabHint={null} onBid={(pl, d) => setPlan((x) => ({ ...x, bids: setBid(x.bids, pl, d) }))} profile={league.scoringProfile} leagueType={league.leagueType} />
            ))}
          </div>
        </div>
      )}
      {league.waiverLock?.hidden > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-waiver-lock>{league.waiverLock.hidden} player(s) are hidden because their game has started. They can't be claimed until the week's last game ends.</div>}
      {groups.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No notable free agents right now.</div>}
      {groups.map((g) => (
        <div key={g.pos} data-pos-group={g.pos}>
          <SectionLabel>{g.pos}</SectionLabel>
          <div className="space-y-1.5">
            {g.rows.map((p) => (
              <AvailableRow key={p.id || p.name} p={p} plan={plan} mode={mode} budget={budget} isFaab={isFaab} faabHint={isFaab && budget ? hints.get(p.name) : null} onBid={onBid} profile={league.scoringProfile} leagueType={league.leagueType} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const simColor = (pct) => (pct == null ? C.textFaint : pct >= 70 ? C.ok : pct >= 40 ? C.minor : C.major);
function ClaimRow({ c, result, sim, mode, budget, isFaab, bench, handle, dragging, onBid, onDrop, onDelete }) {
  const failed = result && !result.ok;
  return (
    <div style={{ background: C.surface, border: `1px solid ${failed ? `${C.minor}66` : C.border}`, borderLeft: `3px solid ${failed ? C.minor : C.ok}`, boxShadow: dragging ? "0 6px 18px rgba(0,0,0,0.5)" : "none", opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-start gap-2" data-claim={c.key}>
      {handle}
      <div className="min-w-0 flex-1">
        <div style={{ color: C.text }} className="text-sm font-medium truncate">
          <PlayerLink player={{ id: c.addId, name: c.addName, pos: c.pos }} className="inline">{c.addName}</PlayerLink> <span style={{ color: C.textFaint }} className="text-[11px]">{c.pos}{c.source === "custom" ? " · custom" : c.edited ? " · edited" : ""}</span>
        </div>
        <label className="flex items-center gap-1 mt-1 text-[11px]" style={{ color: C.textMuted }}>
          Drop
          <select
            value={c.dropId || ""}
            onChange={(e) => {
              const id = e.target.value;
              const b = bench.find((x) => String(x.id) === id);
              onDrop(c, id ? { dropId: id, dropName: b?.name } : { dropId: null, dropName: null });
            }}
            style={{ ...inputStyle, maxWidth: 170 }}
            className="rounded px-1.5 py-0.5 text-xs outline-none"
            aria-label={`Player to drop for ${c.addName}`}
          >
            <option value="">None</option>
            {bench.map((b) => (
              <option key={b.id} value={String(b.id)}>{b.name} ({b.pos}{b.proj != null ? ` · ${b.proj.toFixed(1)}` : ""})</option>
            ))}
          </select>
        </label>
        {result && <div style={{ color: result.ok ? C.ok : C.minor }} className="text-[11px] mt-1">{result.ok ? "Would succeed (if no one outbids you)" : `Would fail: ${result.reason}`}</div>}
        {sim && (
          <div style={{ color: simColor(sim.winPct) }} className="text-[11px] mt-0.5" data-sim-result={sim.winPct} title={sim.basis}>
            Win chance {sim.winPct}%{sim.top ? ` · top rival bid ~${fmtMoney(sim.top.p50)} (1 in 4: ${fmtMoney(sim.top.p75)}+)` : " · no rival bid expected"}
            {sim.canOutbid != null ? <span style={{ color: C.textFaint }}> · {sim.canOutbid} team{sim.canOutbid === 1 ? "" : "s"} could outbid you</span> : null}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        {isFaab ? <BidBox dollars={c.bid} mode={mode} budget={budget} onCommit={(d) => d != null && onBid(c, d)} width={58} ariaLabel={`Bid for ${c.addName}`} /> : null}
        <button type="button" onClick={() => onDelete(c)} style={{ color: C.textMuted }} className="text-[11px] flex items-center gap-1" aria-label={`Delete claim for ${c.addName}`} data-claim-delete>
          <X size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

// v3.7: "player to add" — the top 10 per position by this week's projection, filtered as you type (name, position
// or team containing the text), shown "Name (QB - DAL)".
function PlayerSearch({ candidates, value, onChange }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const selected = candidates.find((c) => c.id === value);
  const label = (c) => `${c.name} (${c.pos} - ${c.team || "FA"})`;
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return candidates.filter((c) => !t || `${c.name} ${c.pos} ${c.team || ""}`.toLowerCase().includes(t));
  }, [candidates, q]);
  return (
    <div className="relative" data-player-search>
      <input
        value={open ? q : selected ? label(selected) : ""}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        placeholder="Player to add — type to search…"
        style={inputStyle}
        className="w-full rounded px-2 py-1.5 text-sm outline-none"
        aria-label="Player to add"
        data-player-search-input
      />
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-md shadow-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} role="listbox">
          {list.length === 0 ? (
            <div className="px-3 py-2 text-xs" style={{ color: C.textMuted }}>No match among the top 10 at each position.</div>
          ) : (
            POS_ORDER.filter((pos) => list.some((c) => c.pos === pos)).map((pos) => (
              <div key={pos}>
                <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-bold" style={{ color: POS_COLOR[pos] || C.textFaint }}>{pos}</div>
                {list
                  .filter((c) => c.pos === pos)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={c.id === value}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onChange(c.id);
                        setOpen(false);
                        setQ("");
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm flex justify-between gap-2"
                      style={{ color: C.text, background: c.id === value ? C.surface : "transparent" }}
                      data-search-option={c.id}
                    >
                      <span className="truncate">{label(c)}</span>
                      <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{c.proj != null ? c.proj.toFixed(1) : "—"}</span>
                    </button>
                  ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// v3.7: runs the server-side simulator (debounced) whenever the claims or their order change.
function useWaiverSim(league, claims, openSpots, enabled) {
  const [st, setSt] = useState({ loading: false, data: null, error: null });
  const sig = JSON.stringify(claims.map((c) => [c.key, c.addId, c.bid, c.dropId]));
  useEffect(() => {
    if (!enabled || !claims.length) {
      setSt({ loading: false, data: null, error: null });
      return undefined;
    }
    let alive = true;
    setSt((x) => ({ ...x, loading: true }));
    const t = setTimeout(() => {
      api
        .simulateWaivers(league.id, claims.map((c) => ({ key: c.key, addId: c.addId, bid: c.bid, dropId: c.dropId })), openSpots)
        .then((d) => alive && setSt({ loading: false, data: d, error: null }))
        .catch((e) => alive && setSt({ loading: false, data: null, error: e.message }));
    }, 700);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league.id, sig, openSpots, enabled]);
  return st;
}

function SimulatorBox({ mc }) {
  if (!mc.loading && !mc.data && !mc.error) return null;
  const d = mc.data;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3 py-2.5 mb-2" data-waiver-sim>
      <div className="flex items-center justify-between">
        <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">Waiver simulator</span>
        {mc.loading && <Loader2 size={13} className="animate-spin" style={{ color: C.textMuted }} />}
      </div>
      {mc.error && <div style={{ color: C.major }} className="text-xs mt-1">{mc.error}</div>}
      {d?.faab && (
        <>
          <div style={{ color: C.text }} className="text-xs mt-1" data-sim-summary>
            Expected: <b>{d.expectedWins}</b> win{d.expectedWins === 1 ? "" : "s"}, about <b>{fmtMoney(d.expectedSpend)}</b> spent ({d.trials.toLocaleString()} simulated waiver runs). Each claim shows its win chance.
          </div>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-1 leading-snug">
            How: whether another team bids on a player, and how much, comes from real winning bids in the app's FAAB database — his own bids in other leagues this week when there are 3 or more, otherwise winning bids at his position this season — scaled to this league ({d.leagueFactor?.basis}) and capped at the most FAAB any opponent has left. Your budget, open spots and drops are applied like the list above. Ties are counted as a coin flip.
          </div>
        </>
      )}
    </div>
  );
}

function ClaimsPage({ league, plan, setPlan, onRefresh, onOpenAccount }) {
  const budget = league.waiverInfo?.budget || 0;
  const used = league.waiverInfo?.used || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const allBench = league.bench || [];
  const bench = allBench.filter((p) => !p || !isLocked(p, league)); // v3.4: a locked player can't be dropped
  // v3.7: drop lists show the bench lowest projection first.
  const benchByProj = useMemo(() => [...bench].filter(Boolean).sort((a, b) => (a.proj ?? 0) - (b.proj ?? 0)), [bench]);
  const openSpots = Math.max(0, (league.benchSlots ?? allBench.length) - allBench.length);

  // Keep the drop ranking in step with the bench (new bench players go to the bottom, unticked).
  const syncedDrops = useMemo(() => syncDrops(plan.drops, bench), [plan.drops, bench]);
  useEffect(() => {
    const same = syncedDrops.length === plan.drops.length && syncedDrops.every((d, i) => d.id === plan.drops[i].id && d.name === plan.drops[i].name);
    if (!same) setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench) }));
  }, [syncedDrops, plan.drops, bench, setPlan]);

  const eff = useMemo(() => effectiveClaims({ ...plan, drops: syncedDrops }, { openSpots }), [plan, syncedDrops, openSpots]);
  // v3.0: claims already queued in Sleeper aren't proposed again. A queued claim matches a
  // proposed one when it adds the same player and drops the same player (or nobody).
  const pending = league.privateInfo?.claims?.pending || [];
  const existing = useMemo(
    () => pending.map((x) => ({ key: `sl:${x.id}`, addId: String(x.adds[0] ?? ""), dropId: x.drops[0] != null ? String(x.drops[0]) : null, bid: Number(x.bid) || 0, source: "sleeper", dropPriority: -2, txId: x.id })),
    [pending]
  );
  const existingKeys = useMemo(() => new Set(existing.map((x) => claimKey(x.addId, x.dropId))), [existing]);
  // v3.1: a claim for a player whose game has started is hidden until the week's last game ends.
  const lockedIds = useMemo(() => new Set((league.waiverLock?.lockedIds || []).map(String)), [league.waiverLock]);
  const visibleClaims = useMemo(() => eff.claims.filter((c) => !existingKeys.has(claimKey(c.addId, c.dropId)) && !lockedIds.has(String(c.addId))), [eff.claims, existingKeys, lockedIds]);
  const hiddenCount = eff.claims.length - visibleClaims.length;
  const groups = useMemo(() => groupClaims(visibleClaims, plan.order), [visibleClaims, plan.order]);
  const ordered = useMemo(() => flatten(groups), [groups]);
  // The budget prediction counts what is already queued in Sleeper too.
  const simOrder = useMemo(() => flatten(groupClaims([...visibleClaims, ...existing], plan.order)), [visibleClaims, existing, plan.order]);
  const sim = useMemo(() => simulate(simOrder, { budget, used, openSpots }), [simOrder, budget, used, openSpots]);
  const resultByKey = new Map(sim.results.map((r) => [r.key, r]));
  // v3.7: the waiver simulator (server: opposing bids from the FAAB database) for the same claims in the same order.
  const mc = useWaiverSim(league, simOrder, openSpots, isFaab);
  const mcByKey = new Map((mc.data?.results || []).map((r) => [r.key, r]));

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ addId: "", dropId: "auto", bidText: "" });
  const [ticked, setTicked] = useState(() => new Set());

  const onBid = (c, d) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.map((x) => (x.key === c.key ? { ...x, bid: d } : x)) }));
    else setPlan((pl) => ({ ...pl, edits: { ...pl.edits, [c.key]: { ...(pl.edits[c.key] || {}), bid: d } } }));
  };
  const onDrop = (c, drop) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.map((x) => (x.key === c.key ? { ...x, ...drop } : x)) }));
    else setPlan((pl) => ({ ...pl, edits: { ...pl.edits, [c.key]: { ...(pl.edits[c.key] || {}), ...drop } } }));
  };
  const onDelete = (c) => {
    if (c.source === "custom") setPlan((pl) => ({ ...pl, custom: pl.custom.filter((x) => x.key !== c.key) }));
    else setPlan((pl) => ({ ...pl, removed: [...new Set([...pl.removed, c.key])] }));
  };
  const addCandidates = league.addCandidates?.length ? league.addCandidates : league.waiver.rows || [];
  const addCustom = () => {
    const fa = addCandidates.find((r) => r.id === draft.addId) || (league.waiver.rows || []).find((r) => r.id === draft.addId);
    const bid = toDollars(draft.bidText, mode, budget);
    if (!fa || (isFaab && bid == null)) return;
    if (draft.dropId === "auto") {
      // v3.7: "Auto" = treat it like a bid from the Available page, so drops come from your willing-to-drop ranking.
      setPlan((pl) => ({ ...pl, bids: setBid(pl.bids, fa, bid ?? 0) }));
    } else {
      const b = bench.find((x) => String(x.id) === draft.dropId);
      setPlan((pl) => ({ ...pl, custom: [...pl.custom, { key: `c:${Date.now()}:${fa.id}`, addId: fa.id, addName: fa.name, pos: fa.pos, bid: bid ?? 0, dropId: b ? String(b.id) : null, dropName: b?.name ?? null }] }));
    }
    setDraft({ addId: "", dropId: "auto", bidText: "" });
    setAdding(false);
  };

  const moveDrops = (keys) => setPlan((pl) => {
    const cur = syncDrops(pl.drops, bench);
    const byId = new Map(cur.map((d) => [d.id, d]));
    return { ...pl, drops: keys.map((k) => byId.get(k)).filter(Boolean) };
  });

  const Stat = ({ label, dollars, pct, accent }) => (
    <div className="text-center">
      <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">{label}</div>
      <div style={{ color: accent || C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-xl font-semibold">{fmtMoney(dollars)}</div>
      <div style={{ color: C.textFaint }} className="text-[11px]">{fmtPct(pct)}</div>
    </div>
  );

  return (
    <div>
      {isFaab ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-3 mb-2" data-budget>
          <div className="flex items-center justify-around">
            <Stat label="Budget now" dollars={sim.current} pct={sim.currentPct} />
            <div style={{ color: C.textFaint }} className="text-xs text-center">
              − {fmtMoney(sim.spent)}
              <div className="text-[10px]">{sim.wins} win{sim.wins === 1 ? "" : "s"}</div>
            </div>
            <Stat label="After proposed" dollars={sim.after} pct={sim.afterPct} accent={C.brand} />
          </div>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">
            Predicted for YOUR claims only, assuming you win every one that's possible: only your highest bid per player counts, a dropped player can only be dropped once, and without a drop you can only add as many players as you have open bench spots ({openSpots} now). Other teams' bids aren't visible, so a higher outside bid would change this. Equal bids are assumed to process in the order shown.
          </div>
        </div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-lg p-3 mb-2 text-xs">
          This league doesn't use FAAB{league.waiverInfo?.priority != null ? ` — your waiver priority is #${league.waiverInfo.priority}` : ""}. Claims are processed in priority order; order within your list is the order Sleeper tries them. {openSpots} open bench spot{openSpots === 1 ? "" : "s"}.
        </div>
      )}
      {isFaab && <SimulatorBox mc={mc} />}
      {isFaab && (
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <span style={{ color: C.textMuted }} className="text-xs">Enter bids as</span>
          <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />
        </div>
      )}

      <SectionLabel>Who you'd drop — rank most willing first</SectionLabel>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Drag your bench into the order you'd drop them, and tick the ones you're willing to lose. The claim list below is built from this.
      </div>
      {syncedDrops.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-2">No bench players to drop.</div>
      ) : (
        <DragList
          items={syncedDrops}
          getKey={(d) => d.id}
          onReorder={moveDrops}
          label="Drag to rank the player you would drop"
          render={(d, { handleProps, dragging }) => (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-center gap-2" data-drop-row={d.id}>
              <DragHandle handleProps={handleProps} dragging={dragging} />
              <span style={{ color: C.textFaint, fontVariantNumeric: "tabular-nums" }} className="text-xs w-5 text-right">{syncedDrops.findIndex((x) => x.id === d.id) + 1}</span>
              <span style={{ color: C.text }} className="text-sm truncate flex-1">{d.name} <span style={{ color: C.textFaint }} className="text-[11px]">{d.pos}</span></span>
              <label className="flex items-center gap-1 text-xs shrink-0" style={{ color: C.textMuted }}>
                <input type="checkbox" checked={d.willing} onChange={(e) => setPlan((pl) => ({ ...pl, drops: syncDrops(pl.drops, bench).map((x) => (x.id === d.id ? { ...x, willing: e.target.checked } : x)) }))} data-willing />
                Willing to drop
              </label>
            </div>
          )}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Proposed claims — {visibleClaims.length}</SectionLabel>
        <div className="flex items-center gap-2 pt-3">
          <button type="button" onClick={() => setAdding((v) => !v)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-add-custom>
            + Custom claim
          </button>
          <button type="button" onClick={() => setPlan((pl) => resetClaims(pl))} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="text-xs rounded-md px-2 py-1" data-reset-claims>
            Reset to defaults
          </button>
        </div>
      </div>
      {adding && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 mb-2 space-y-2" data-custom-form>
          <PlayerSearch candidates={addCandidates} value={draft.addId} onChange={(id) => setDraft({ ...draft, addId: id })} />
          <select value={draft.dropId} onChange={(e) => setDraft({ ...draft, dropId: e.target.value })} style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="Player to drop" data-drop-select>
            <option value="auto">Auto — drops from your willing-to-drop ranking</option>
            <option value="">None (uses an open bench spot)</option>
            {benchByProj.map((b) => (
              <option key={b.id} value={String(b.id)}>Drop {b.name} ({b.pos}{b.proj != null ? ` · ${b.proj.toFixed(1)}` : ""})</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {isFaab && (
              <input value={draft.bidText} onChange={(e) => setDraft({ ...draft, bidText: e.target.value })} placeholder={mode === "percent" ? "bid %" : "bid $"} inputMode="decimal" style={{ ...inputStyle, width: 90 }} className="rounded px-2 py-1.5 text-sm outline-none" aria-label="Bid" />
            )}
            <button type="button" onClick={addCustom} disabled={!draft.addId || (isFaab && toDollars(draft.bidText, mode, budget) == null)} style={{ background: C.brand, color: C.text, opacity: !draft.addId || (isFaab && toDollars(draft.bidText, mode, budget) == null) ? 0.5 : 1 }} className="text-sm rounded-md px-3 py-1.5">
              Add claim
            </button>
          </div>
        </div>
      )}
      {eff.warnings.map((w, i) => (
        <div key={i} style={{ color: C.minor }} className="text-[11px] px-1 pb-1">{w}</div>
      ))}
      {hiddenCount > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-1" data-hidden-existing>{hiddenCount} proposed claim{hiddenCount === 1 ? " is" : "s are"} already in Sleeper and hidden here.</div>}
      {visibleClaims.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">
          {hiddenCount > 0 ? "Everything proposed is already queued in Sleeper." : <>No claims yet. Enter a bid on the Available page{plan.bids.length ? ", then tick the bench players you're willing to drop above" : ""}.</>}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.bid} data-claim-group={g.bid}>
              <div style={{ color: C.brand, fontFamily: "Oswald, sans-serif" }} className="text-xs px-1 pb-1">
                {isFaab ? `${fmtMoney(g.bid)}${budget ? ` · ${fmtPct(Math.round((g.bid / budget) * 1000) / 10)}` : ""}` : "Claims"} — {g.claims.length} claim{g.claims.length === 1 ? "" : "s"}
              </div>
              <DragList
                items={g.claims}
                getKey={(c) => c.key}
                label={`Drag to reorder within the ${fmtMoney(g.bid)} group`}
                onReorder={(keys) => {
                  const next = flatten(groups.map((x) => (x.bid === g.bid ? { ...x, claims: keys.map((k) => x.claims.find((c) => c.key === k)) } : x))).map((c) => c.key);
                  setPlan((pl) => ({ ...pl, order: next }));
                }}
                render={(c, { handleProps, dragging }) => (
                  <ClaimRow c={c} result={resultByKey.get(c.key)} sim={mcByKey.get(c.key)} mode={mode} budget={budget} isFaab={isFaab} bench={benchByProj} dragging={dragging} handle={<DragHandle handleProps={handleProps} dragging={dragging} />} onBid={onBid} onDrop={onDrop} onDelete={onDelete} />
                )}
              />
            </div>
          ))}
        </div>
      )}

      <ClaimsPush league={league} ordered={ordered} existing={existing} isFaab={isFaab} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />

      {ordered.length > 0 && (
        <>
          <SectionLabel>Enter these in Sleeper, in this order</SectionLabel>
          <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
            Tick each one once it's entered.{" "}
            <a href={`https://sleeper.com/leagues/${league.id}`} target="_blank" rel="noreferrer" style={{ color: C.brand }} className="underline">Open this league in Sleeper</a>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-claim-checklist>
            {ordered.map((c, i) => (
              <label key={c.key} className="flex items-start gap-2 px-3 py-2 text-xs" style={{ color: ticked.has(c.key) ? C.textFaint : C.text, borderColor: C.border, textDecoration: ticked.has(c.key) ? "line-through" : "none" }}>
                <input type="checkbox" checked={ticked.has(c.key)} onChange={(e) => setTicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.key); else n.delete(c.key); return n; })} />
                <span>{i + 1}. {isFaab ? describeClaim(c) : `Claim ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// v3.0: push the proposed claims to Sleeper (private API, opt-in, confirm, read-back).
// The submit/cancel claim calls have never been confirmed to work, so the FIRST push
// is a single claim; once one has been read back successfully, the rest go in one go.
function ClaimsPush({ league, ordered, existing, isFaab, onRefresh, onOpenAccount }) {
  const [st, setSt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const loadStatus = useCallback(() => api.getPrivateStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => {
    if (league.privateInfo?.configured) loadStatus();
  }, [league.privateInfo?.configured, loadStatus]);
  const proven = Boolean(st?.log?.some((l) => l.action === "submit_waiver_claim" && l.ok));
  const batch = proven ? ordered : ordered.slice(0, 1);
  const label = (c) => (isFaab ? describeClaim(c) : `Claim ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`);
  const send = async () => {
    setBusy(true);
    const out = [];
    for (const c of batch) {
      try {
        const r = await api.pushClaim(league.id, { addId: c.addId, dropId: c.dropId, bid: c.bid }, { keys: pushKeys(league, "waiver") });
        out.push({ label: label(c), ok: r.ok, verified: r.verified, detail: r.detail });
        if (!r.ok) break; // stop at the first claim Sleeper doesn't confirm
      } catch (e) {
        out.push({ label: label(c), ok: false, detail: e.message });
        break;
      }
    }
    setResults(out);
    setBusy(false);
    setConfirming(false);
    loadStatus();
    if (out.some((o) => o.ok)) onRefresh?.();
  };
  const cancel = async (x) => {
    try {
      const r = await api.cancelClaim(league.id, x.txId);
      setResults([{ label: `Cancel queued claim for ${x.addId}`, ok: r.ok, detail: r.detail }]);
      if (r.ok) onRefresh?.();
    } catch (e) {
      setResults([{ label: "Cancel queued claim", ok: false, detail: e.message }]);
    }
  };
  return (
    <div className="mt-3 space-y-2" data-claims-push>
      <SectionLabel>Push to Sleeper</SectionLabel>
      <PrivateGate league={league} group="claims" onOpenAccount={onOpenAccount}>
        {league.privateInfo?.claims?.error && <div style={{ color: C.minor }} className="text-[11px] px-1">Couldn't read your queued claims from Sleeper ({league.privateInfo.claims.error}) — proposed claims may duplicate ones already there.</div>}
        {existing.length > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-existing-claims>
            <div style={{ color: C.textFaint }} className="px-3 py-1.5 text-[11px]">Already queued in Sleeper</div>
            {existing.map((x) => (
              <div key={x.key} style={{ color: C.text, borderColor: C.border }} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                <span>Add {x.addId}{x.dropId ? `, drop ${x.dropId}` : ""} · bid {fmtMoney(x.bid)}</span>
                <button type="button" onClick={() => cancel(x)} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded px-2 py-0.5 text-[11px]">Cancel</button>
              </div>
            ))}
          </div>
        )}
        {ordered.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-xs px-1">Nothing to push.</div>
        ) : !confirming ? (
          <button type="button" onClick={() => setConfirming(true)} style={{ background: C.brand, color: C.text }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium" data-push-claims>
            {proven ? `Push ${ordered.length} claim${ordered.length === 1 ? "" : "s"} to Sleeper` : "Push first claim to Sleeper (test)"}
          </button>
        ) : (
          <ConfirmPush title={proven ? "Send these claims to Sleeper?" : "Send ONE test claim to Sleeper?"} lines={batch.map(label)} buttonLabel={proven ? "Yes, submit them" : "Yes, submit this claim"} busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note={proven ? "Each claim is read back from Sleeper to confirm it registered; the push stops at the first one that doesn't." : "Entering waiver claims through Sleeper's private API has never been confirmed to work. This sends only the first claim and reads it back. If it registers, the next push sends the rest. Either way, the checklist below still works."} />
        )}
        <PushResults results={results} />
      </PrivateGate>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.7 OPPONENTS: bids by your opponents (this league + their other  */
/*  leagues of the same type), their habits, and each one's claims      */
/* ------------------------------------------------------------------ */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`;

function OwnerClaims({ ownerId }) {
  const [st, setSt] = useState({ loading: true, claims: null, error: null });
  useEffect(() => {
    let alive = true;
    api.getOwnerClaims(ownerId).then((r) => alive && setSt({ loading: false, claims: r.claims, error: null })).catch((e) => alive && setSt({ loading: false, claims: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [ownerId]);
  if (st.loading) return <div className="text-xs py-1" style={{ color: C.textMuted }}><Loader2 size={12} className="inline animate-spin" /> Loading claims…</div>;
  if (st.error) return <div className="text-xs py-1" style={{ color: C.major }}>{st.error}</div>;
  if (!st.claims.length) return <div className="text-xs py-1" style={{ color: C.textMuted }}>No claims stored for this manager yet.</div>;
  return (
    <div className="mt-1.5 space-y-1" data-owner-claims={ownerId}>
      {st.claims.map((c, i) => (
        <div key={i} className="flex items-start justify-between gap-2 text-[11px]">
          <div className="min-w-0">
            <PlayerLink player={{ id: c.playerId, name: c.name, pos: c.pos, team: c.team }} className="inline" style={{ color: C.text }}>{c.name}</PlayerLink>
            <span style={{ color: C.textFaint }}> {c.pos || ""}{c.team ? ` · ${c.team}` : ""}</span>
            <div style={{ color: C.textFaint }} className="text-[10px] truncate">{c.leagueName || c.leagueId} · week {c.week}{c.note ? ` · ${c.note}` : ""}</div>
          </div>
          <div className="text-right shrink-0">
            <div style={{ color: c.status === "won" ? C.ok : C.major }} className="font-semibold">{fmtMoney(c.bid)}{c.pct != null ? ` (${c.pct}%)` : ""}</div>
            <div style={{ color: C.textFaint }} className="text-[10px]">{c.status === "won" ? "won" : "lost"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OpponentsPage({ league }) {
  const [rep, setRep] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [open, setOpen] = useState(null);
  const [editTime, setEditTime] = useState(false);
  const load = useCallback(() => {
    api.getFaabReport(league.id).then((r) => (setRep(r), setError(null))).catch((e) => setError(e.message));
  }, [league.id]);
  useEffect(() => {
    setRep(null);
    load();
  }, [load]);
  if (error && !rep) return <div style={{ color: C.major }} className="text-xs px-1">{error}</div>;
  if (!rep) return <div className="flex items-center gap-2 px-1 py-4 text-sm" style={{ color: C.textMuted }}><Loader2 size={16} className="animate-spin" /> Loading the bid report…</div>;
  if (!rep.faab) return <div style={{ color: C.textMuted }} className="text-sm px-1">This league doesn't use FAAB, so there are no bids to report.</div>;
  const toggle = async (on) => {
    await api.saveFaabSettings({ reportEnabled: on }).catch((e) => setMsg(e.message));
    load();
  };
  const collect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.collectFaab(league.id);
      setMsg(`Collected: ${r.own} claim(s) in this league${r.enabled ? `, ${r.opp.claims} from ${r.opp.leagues} of your opponents' other leagues${r.opp.capped ? " (capped)" : ""}` : ""}.`);
      load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const w = rep.waiver;
  const saveTime = async (day, hour, clear = false) => {
    await api.saveFaabSettings({ waiverTime: { leagueId: league.id, day: Number(day), hour: Number(hour), clear } }).catch((e) => setMsg(e.message));
    setEditTime(false);
    load();
  };
  const col = rep.collected;
  return (
    <div className="space-y-3" data-opponents>
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg px-3.5 py-3 space-y-2">
        <label className="flex items-start gap-2 text-sm" style={{ color: C.text }}>
          <input type="checkbox" checked={rep.settings.reportEnabled} onChange={(e) => toggle(e.target.checked)} className="mt-1" data-report-toggle />
          <span>
            Collect my opponents' bids from their other leagues
            <span style={{ color: C.textFaint }} className="block text-[11px]">Same type only ({rep.leagueType === "dynasty" ? "dynasty" : "redraft/keeper"}), never best ball. Runs automatically 2 hours before this league's waivers. Off = only this league's own claims are read.</span>
          </span>
        </label>
        <div className="text-xs flex items-center justify-between gap-2 flex-wrap" style={{ color: C.textMuted }} data-waiver-time>
          <span>
            Waivers run {w.daily ? "daily" : DAY_NAMES[w.day]} {hourLabel(w.hourET)} ET <span style={{ color: C.textFaint }}>({w.source})</span> · next collection {fmtWhen(w.collectAt)}
          </span>
          <button type="button" onClick={() => setEditTime((v) => !v)} style={{ color: C.brand }} className="underline text-[11px]" data-edit-waiver-time>{editTime ? "Cancel" : "Change"}</button>
        </div>
        {editTime && (
          <form
            className="flex items-center gap-2 text-xs flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              saveTime(f.get("day"), f.get("hour"));
            }}
          >
            <select name="day" defaultValue={w.day ?? 3} style={inputStyle} className="rounded px-1.5 py-1">
              {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
            <select name="hour" defaultValue={w.hourET ?? 3} style={inputStyle} className="rounded px-1.5 py-1">
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)} ET</option>)}
            </select>
            <button type="submit" style={{ background: C.brand, color: C.text }} className="rounded px-2.5 py-1">Save</button>
            {w.source === "your setting" && <button type="button" onClick={() => saveTime(0, 0, true)} style={{ color: C.textMuted }} className="underline">Use the league's setting</button>}
          </form>
        )}
        <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: C.textFaint }}>
          <span>
            {col ? `Last collected ${fmtWhen(col.at)} (${col.reason})` : "Not collected yet"} · {rep.pool.claims} claims in the database from {rep.pool.leagues} league(s){rep.pool.medianPct != null ? ` · median bid ${rep.pool.medianPct}% of budget` : ""}
          </span>
          <button type="button" onClick={collect} disabled={busy} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded px-2 py-0.5 shrink-0" data-collect-now>
            {busy ? "Collecting…" : "Collect now"}
          </button>
        </div>
        {msg && <div style={{ color: C.textMuted }} className="text-[11px]">{msg}</div>}
      </div>

      <div data-hot-players>
        <SectionLabel>Bid on elsewhere this week — {rep.hot.filter((h) => h.available).length} available here</SectionLabel>
        {rep.hot.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-xs px-1">{rep.settings.reportEnabled ? "No bids by your opponents in their other leagues this week or last (yet)." : "Turn on the collection above to see what your opponents bid elsewhere."}</div>
        ) : (
          <div className="space-y-1.5">
            {rep.hot.map((h) => (
              <div key={h.playerId} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${h.available ? C.ok : C.border}` }} className="rounded-md px-3 py-2" data-hot={h.playerId}>
                <div className="flex items-center justify-between gap-2">
                  <PlayerLink player={{ id: h.playerId, name: h.name, pos: h.pos, team: h.team }} className="min-w-0 truncate" style={{ color: C.text }}>
                    <span className="text-sm font-medium">{h.name}</span> <span style={{ color: POS_COLOR[h.pos] || C.textFaint }} className="text-[11px] font-semibold">{h.pos}</span>
                    <span style={{ color: C.textFaint }} className="text-[11px]">{h.team ? ` · ${h.team}` : ""}</span>
                  </PlayerLink>
                  <span style={{ color: h.available ? C.ok : C.textFaint }} className="text-[11px] shrink-0">{h.available ? "Available here" : "Rostered here"}</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {h.bids.map((b, i) => (
                    <span key={i} style={{ color: b.status === "won" ? C.ok : C.major, border: `1px solid ${b.status === "won" ? C.ok : C.major}55` }} className="text-[10px] rounded px-1.5 py-0.5" title={`${b.leagueName || ""} · week ${b.week}`}>
                      {b.team}: {fmtMoney(b.bid)}{b.pct != null ? ` (${b.pct}%)` : ""} {b.status === "won" ? "won" : "lost"}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>Opponents' bidding habits</SectionLabel>
        <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">From every claim stored for each manager this season (this league and their other {rep.leagueType === "dynasty" ? "dynasty" : "redraft/keeper"} leagues). Bids are a % of each league's budget. Tap a manager to see their actual claims.</div>
        <div className="space-y-1.5">
          {rep.opponents.map((o) => (
            <div key={o.ownerId} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2" data-opponent={o.ownerId}>
              <button type="button" onClick={() => setOpen((x) => (x === o.ownerId ? null : o.ownerId))} className="w-full text-left" aria-expanded={open === o.ownerId}>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: C.text }} className="text-sm font-medium truncate">{o.team}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {o.budgetLeft != null && <span style={{ color: C.textMuted }} className="text-[11px]">{fmtMoney(o.budgetLeft)} left</span>}
                    <ChevronRight size={14} style={{ color: C.textFaint, transform: open === o.ownerId ? "rotate(90deg)" : "none" }} />
                  </span>
                </div>
                <div style={{ color: C.textMuted }} className="text-[11px] mt-0.5">
                  {o.claims ? `${o.claims} claims (${o.won} won, ${o.lost} lost) · median ${o.medianPct ?? "—"}%, top quarter ${o.p75Pct ?? "—"}%+, max ${o.maxPct ?? "—"}%` : "No claims stored yet"}
                  {o.aggression && <span style={{ color: o.aggression.ratio >= 1.15 ? C.minor : o.aggression.ratio <= 0.85 ? C.ok : C.textMuted }}> · {o.aggression.label} ({o.aggression.ratio}×)</span>}
                </div>
                {Object.keys(o.byPos || {}).length > 0 && (
                  <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">{Object.entries(o.byPos).sort((a, b) => b[1] - a[1]).map(([pos, n]) => `${pos} ${n}`).join(" · ")}{o.thisLeague?.claims ? ` · in this league: ${o.thisLeague.claims} claims, median ${o.thisLeague.medianPct ?? "—"}%` : ""}</div>
                )}
              </button>
              {open === o.ownerId && <OwnerClaims ownerId={o.ownerId} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WaiverTab({ league, sessionId, onRefresh, onOpenAccount }) {
  const [sub, setSub] = useState("available");
  const [plan, setPlanState] = useState(null);
  const [planError, setPlanError] = useState(null);
  const [faab, setFaab] = useState({ loading: false, result: null, error: null });
  const saveTimer = useRef(null);
  const latest = useRef(null);
  const leagueId = league.id;

  useEffect(() => {
    let cancelled = false;
    setPlanState(null);
    api.getWaiverPlan(leagueId).then((p) => !cancelled && setPlanState(p)).catch((e) => !cancelled && setPlanError(e.message));
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (latest.current) {
      const p = latest.current;
      latest.current = null;
      api.saveWaiverPlan(leagueId, p).catch((e) => setPlanError(e.message));
    }
  }, [leagueId]);
  useEffect(() => () => flush(), [flush]);

  // Updates are applied at once and saved shortly after (so typing and dragging stay snappy).
  const setPlan = useCallback(
    (fn) => {
      setPlanState((prev) => {
        if (!prev) return prev;
        const next = typeof fn === "function" ? fn(prev) : fn;
        latest.current = next;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flush, 500);
        return next;
      });
    },
    [flush]
  );

  const runFaab = async () => {
    setFaab({ loading: true, result: faab.result, error: null });
    try {
      setFaab({ loading: false, result: await api.getFaabSuggestions(sessionId, leagueId), error: null });
    } catch (err) {
      setFaab({ loading: false, result: null, error: err.message });
    }
  };

  const claimCount = plan ? effectiveClaims(plan, { openSpots: Math.max(0, (league.benchSlots ?? (league.bench || []).length) - (league.bench || []).length) }).claims.length : 0;
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-waiver-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 text-sm font-medium">
      {label}
    </button>
  );
  return (
    <div className="px-4 py-3">
      <div className="flex mb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        {tab("available", "Available")}
        {tab("claims", `Claims${claimCount ? ` (${claimCount})` : ""}`)}
        {league.waiverInfo?.faab && tab("opponents", "Opponents")}
      </div>
      {planError && <div style={{ color: C.major }} className="text-xs px-1 pb-2">{planError}</div>}
      {!plan ? (
        <div className="flex items-center gap-2 px-1 py-4" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" /> <span className="text-sm">Loading your waiver plan…</span>
        </div>
      ) : sub === "available" ? (
        <AvailablePage league={league} plan={plan} setPlan={setPlan} faab={faab} onRunFaab={runFaab} />
      ) : sub === "opponents" ? (
        <OpponentsPage league={league} />
      ) : (
        <ClaimsPage league={league} plan={plan} setPlan={setPlan} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}
