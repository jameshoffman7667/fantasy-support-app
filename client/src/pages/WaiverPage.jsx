import * as api from "../api.js";
import { isLocked } from "../lineup.js";
import { pushKeys, waiverBaselineKeys } from "../variances.js";
import { CATEGORIES, PERF_SORTS, POSITION_FILTERS, categoryRows, categoryView, keyLabel, perfValue } from "../waiverLists.js"; // v3.9, v4.8
import { CopyEntries, applyCopiedBid, useCopyClaims } from "../ui/copyClaims.jsx"; // v4.7, v4.8
import { availableElsewhere, compareToRoster, waiverRosterWarnings } from "../ui/compute.js"; // v3.9, v4.1
import { claimKey, clearClaims, clearDrops, afterPush, bidGroups, deleteBid, describeClaim, dropPool, effectiveClaims, flatten, groupClaims, orderDrops, reorderBids, resetClaims, selectedClaims, setBid, simulate, stampBids, syncDrops, toDollars } from "../waiverPlan.js";
import { ChevronRight, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { expandPositions, fmtValue, normalizeView, sortRows } from "../statsView.js"; // v4.2
import { StatPickers } from "../ui/statPickers.jsx"; // v4.2
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BidBox, ConfirmPush, DragHandle, DragList, EntryModeToggle, Headshot, InfoNote, MatchupChip, Modal, PrivateGate, PushResults, SectionLabel, SourceTag, UsageBadge, WeatherChip } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { AutoView } from "../ui/autoMode.jsx"; // v4.10
import { DropCandidatesPage } from "./DropCandidates.jsx"; // v4.8
import { forgetSent, isSent, markSent } from "../sentClaims.js"; // v4.8
import { BidDistributionModal } from "../ui/bidChart.jsx"; // v4.4.2
import { C, POS_COLOR, STATUS, fmtInt, fmtMoney, fmtPct, fmtWhen, inputStyle } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  WAIVERS (v2.9): Available page + Claim Generator                       */
/* ------------------------------------------------------------------ */
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

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

// v4.8: the FAAB card shared by the Available page and the Claim Generator — identical layout. Left = the real
// available budget; right = what is left after the bids / claims entered (live).
function FaabCard({ current, currentPct, spent, wins, after, afterPct, children }) {
  const Stat = ({ label, dollars, pct, accent }) => (
    <div className="text-center">
      <div style={{ color: C.textMuted }} className="text-[11px] mb-0.5">{label}</div>
      <div style={{ color: accent || C.text, fontFamily: "Oswald, sans-serif", fontVariantNumeric: "tabular-nums" }} className="text-xl font-semibold">{fmtMoney(dollars)}</div>
      <div style={{ color: C.textFaint }} className="text-[11px]">{fmtPct(pct)}</div>
    </div>
  );
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-lg p-3 mb-2" data-budget>
      <div className="flex items-center justify-around">
        <Stat label="Budget now" dollars={current} pct={currentPct} />
        <div style={{ color: C.textFaint }} className="text-xs text-center">
          − {fmtMoney(spent)}
          <div className="text-[10px]">{wins} win{wins === 1 ? "" : "s"}</div>
        </div>
        <Stat label="After proposed" dollars={after} pct={afterPct} accent={after < 0 ? C.major : C.brand} />
      </div>
      {children}
    </div>
  );
}

// v4.8: under a bid box — dollars entered: bid ÷ original budget / budget left ÷ original budget (both in %);
// % entered: the bid in dollars / the budget left in dollars. "Left" is the live figure (after every bid entered).
const pctOf1 = (x, budget) => (budget > 0 ? Math.round((x / budget) * 1000) / 10 : null);
function BidMath({ mode, bid, budget, remaining }) {
  if (!(budget > 0) || bid == null) return null;
  const text = mode === "percent" ? `${fmtMoney(bid)} / ${fmtMoney(remaining)} left` : `${pctOf1(bid, budget)}% of budget / ${pctOf1(remaining, budget)}% left`;
  return (
    <span style={{ color: remaining < 0 ? C.major : C.textFaint }} className="text-[10px] whitespace-nowrap" data-bid-math title={mode === "percent" ? "Bid in dollars / budget left in dollars (after all bids entered)" : "Bid as % of the original budget / budget left as % of the original budget (after all bids entered)"}>
      {text}
    </span>
  );
}

function AvailableRow({ p, plan, mode, budget, isFaab, faabHint, onBidInfo = null, onBid, profile, leagueType, keyText = null, elsewhere = null, onElsewhere = null, remainingLive = null }) {
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
            {keyText ? <span style={{ color: C.brand }}> · {keyText}</span> : null}
          </div>
          <TypeExtras p={p} leagueType={leagueType} />
          {p.status && p.status !== "Healthy" && <div style={{ color: C.minor }} className="text-[11px]">{p.status}</div>}
          {(p.matchup || p.weather) && (
            <div className="flex items-center gap-1 flex-wrap mt-1">
              <MatchupChip player={p} profile={profile} />
              <WeatherChip player={p} />
            </div>
          )}
          {p.fillIn && <div style={{ color: C.minor }} className="text-[11px] mt-1" data-fill-in>🩹 {p.fillIn}</div>}
          {p.hype && (
            <div style={{ color: C.textMuted }} className="text-[11px] mt-1 leading-snug" data-hype-note>
              <span style={{ color: C.brand }}>📰 {p.hype.mentions} source{p.hype.mentions === 1 ? "" : "s"}{p.hype.sources?.length ? ` (${p.hype.sources.slice(0, 3).join(", ")})` : ""}{p.hype.kind ? ` · ${{ spot: "spot start", ros: "rest of season", stash: "stash" }[p.hype.kind] || p.hype.kind}` : ""}{p.hype.dynasty ? " · dynasty" : ""}:</span> {p.hype.note || "recommended as a pickup."}
            </div>
          )}
          {p.note && p.rule && <div style={{ color: s.color }} className="text-[11px] mt-1">{p.rule === "Free agent outprojects a starter" ? "Beats a starter" : "Beats a bench player"}: {p.note}</div>}
          {p.usage && <div className="mt-1"><UsageBadge usage={p.usage} /></div>}
          {(elsewhere || p.elsewhere)?.length > 0 && onElsewhere && (
            <button type="button" onClick={() => onElsewhere(p, elsewhere || p.elsewhere)} style={{ color: C.brand }} className="text-[11px] mt-1 underline" data-available-elsewhere={(elsewhere || p.elsewhere).length}>
              Available elsewhere
            </button>
          )}
          {faabHint && (
            <div style={{ color: C.textFaint }} className="text-[11px] mt-1 flex items-center gap-1.5 flex-wrap" data-faab-hint>
              <span>Suggested bid</span>
              {[["70%", faabHint.suggestion70Pct], ["95%", faabHint.suggestion95Pct]].map(([label, v]) => (
                <button key={label} type="button" onClick={() => onBidInfo?.(p, faabHint)} style={{ color: C.brand, border: `1px solid ${C.brand}55` }} className="rounded px-1.5 py-0.5 text-[11px]" data-faab-bid={label} aria-label={`${label} suggested bid ${fmtMoney((budget * v) / 100)} — show the bid distribution`}>
                  {fmtMoney((budget * v) / 100)} <span style={{ color: C.textFaint }}>{label}</span>
                </button>
              ))}
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
          {isFaab && bid && remainingLive != null && <BidMath mode={mode} bid={bid.bid} budget={budget} remaining={remainingLive} />}
          {bid && <span style={{ color: C.ok }} className="text-[10px]">on Claim Generator</span>}
        </div>
      </div>
      <SourceTag source={p.projSource} factor={p.projFactor} />
    </div>
  );
}

// v3.9: the Available page — position filter and $/% on top, then the categories (Hype Train, Spot Start, ROS,
// Stashes, Trending, Handcuff). FAAB suggestions sit on each card. Caps: All = 5 per position sorted together,
// QB/RB/WR/TE = 15, FLEX = 25 (waiverLists.js).
function fallbackLists(league) {
  // An older saved build without categories: Spot Start and Trending from the old list.
  const rows = league.waiver?.rows || [];
  const cards = Object.fromEntries(rows.map((r) => [r.id, r]));
  const spot = rows.filter((r) => r.proj != null).map((r) => ({ id: r.id, key: r.proj })).sort((a, b) => b.key - a.key);
  const trending = rows.filter((r) => r.trending).map((r) => ({ id: r.id, key: r.trendCount ?? 0 })).sort((a, b) => b.key - a.key);
  return { lists: { spot, trending }, cards, hype: { state: "off" } };
}

function ResearchStatus({ hype, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async (force) => {
    setBusy(true);
    setErr(null);
    try {
      await api.runWaiverResearch({ force });
      onRefresh?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!hype || hype.state === "off") return <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2">The research needs a Gemini key on the server (GEMINI_API_KEY).</div>;
  return (
    <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2 flex items-center gap-2 flex-wrap" data-research-status>
      <span>{hype.state === "ready" ? `Research from ${fmtWhen(hype.at)} · ${hype.players} players found · runs by itself Tue & Wed ~8 am and 4 pm` : "The research is running — refresh in a minute."}</span>
      <button type="button" disabled={busy} onClick={() => run(hype.state === "ready")} style={{ color: C.brand }} className="underline" data-research-refresh>
        {busy ? "Researching…" : hype.state === "ready" ? "Research again" : "Refresh"}
      </button>
      {err && <span style={{ color: C.major }}>{err}</span>}
    </div>
  );
}


// v4.7: Waivers → Available → Copy — your claims in your other leagues of the same type for players free in this league.
function CopyView({ league, filter, rowProps, cardFor, isFaab = false, budget = 0, remaining = 0, onCopyAll = null, onUseEntry = null }) {
  const { data, error, loading, reload } = useCopyClaims(league.id, true);
  const [from, setFrom] = useState("");
  const [copied, setCopied] = useState(null); // { text }
  const [usedKey, setUsedKey] = useState({});
  if (error) return <div style={{ color: C.major }} className="text-sm px-1 py-2" data-copy-error>{error}</div>;
  if (loading && !data) return <div style={{ color: C.textMuted }} className="text-sm px-1 py-2 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Reading your other leagues…</div>;
  if (!data) return null;
  if (data.applicable === false) return <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>{data.reason}</div>;
  const FLEXP = ["RB", "WR", "TE"];
  const shown = (data.items || []).filter((i) => filter === "ALL" || (filter === "FLEX" ? FLEXP.includes(i.pos) : i.pos === filter));
  // v4.8: copy every bid by percentage from one other league: the pending claims there for players who are free here,
  // as the same % of THIS league's budget. Existing bids for those players are overwritten.
  const fromId = from || data.leagues?.[0]?.id || "";
  const canCopy = isFaab && budget > 0 && onCopyAll && data.leagues?.length > 0;
  const copyAll = () => {
    const picks = [];
    for (const i of data.items || []) {
      const pcts = i.entries.filter((e) => e.leagueId === String(fromId) && e.kind === "pending" && e.pct != null).map((e) => e.pct);
      if (!pcts.length) continue;
      const dollars = Math.min(Math.round((Math.max(...pcts) / 100) * budget), remaining);
      picks.push({ player: { id: i.id, name: i.name, pos: i.pos }, dollars, pct: Math.max(...pcts) });
    }
    const name = data.leagues.find((l) => String(l.id) === String(fromId))?.name || "that league";
    if (!picks.length) return setCopied({ text: `${name} has no pending FAAB bids for players who are free here.`, none: true });
    onCopyAll(picks);
    setCopied({ text: `Copied ${picks.length} bid${picks.length === 1 ? "" : "s"} from ${name} as a % of this budget (existing bids for those players were replaced) — see the Claim Generator.` });
  };
  return (
    <div data-copy>
      {canCopy && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2 mb-2 space-y-1.5" data-copy-all>
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ color: C.text }} className="text-xs font-medium">Copy all bids by %</span>
            <select value={fromId} onChange={(e) => setFrom(e.target.value)} style={inputStyle} className="rounded px-1.5 py-1 text-xs" aria-label="League to copy bids from" data-copy-from>
              {data.leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" onClick={copyAll} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-2.5 py-1 text-xs font-medium" data-copy-all-btn>Copy bids</button>
          </div>
          <div style={{ color: C.textFaint }} className="text-[10px]">Takes your queued bids in the chosen league and sets the same percentage of this league's budget for each player who is free here, replacing any bid you already entered for them.</div>
          {copied && <div style={{ color: copied.none ? C.minor : C.ok }} className="text-[11px]" data-copy-all-result>{copied.text}</div>}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-1 pb-2 text-xs" style={{ color: C.textMuted }}>
        <span data-copy-summary>
          {data.leagues.length ? `${data.leagues.length} other ${data.type} league${data.leagues.length === 1 ? "" : "s"}` : `No other ${data.type} leagues`} · {shown.length} player{shown.length === 1 ? "" : "s"}
          <InfoNote label="About Copy">Pending claims are as last read from Sleeper in each league (needs Account → Sleeper access). Processed claims are the last {data.windowDays} days from the FAAB database, which reads each league after its waivers run; a lost claim shows the winning bid when the database has it. Best ball leagues are left out, and keeper counts as redraft.{data.notBuilt ? ` ${data.notBuilt} tracked league${data.notBuilt === 1 ? " hasn't" : "s haven't"} been read yet and ${data.notBuilt === 1 ? "is" : "are"} left out.` : ""}</InfoNote>
        </span>
        <button type="button" onClick={reload} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2 py-1 text-xs shrink-0" data-copy-refresh>Read again</button>
      </div>
      {shown.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>Nothing to copy — none of your claims in your other {data.type} leagues is for a player who is free here.</div>}
      <div className="space-y-2" data-category-list="copy">
        {shown.map((i) => {
          const card = cardFor(i.id);
          const keyText = `${i.entries.length} claim${i.entries.length === 1 ? "" : "s"} in your other leagues`;
          return (
            <div key={i.id} data-copy-player={i.id}>
              {card ? (
                <AvailableRow {...rowProps(card, keyText)} />
              ) : (
                <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <PlayerLink player={{ id: i.id, name: i.name, pos: i.pos, team: i.team }} className="min-w-0 truncate"><span style={{ color: C.text }} className="text-sm font-medium">{i.name}</span></PlayerLink>
                    <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{i.pos}{i.team ? ` · ${i.team}` : ""}</span>
                  </div>
                  <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{keyText}</div>
                </div>
              )}
              <div className="px-3 pt-1" style={{ borderLeft: `2px solid ${C.border}`, marginLeft: 6 }}>
                <CopyEntries entries={i.entries} usedKey={usedKey[i.id] ?? null} onUse={isFaab && budget > 0 && onUseEntry ? (e) => { onUseEntry({ id: i.id, name: i.name, pos: i.pos }, e.pct); setUsedKey((m) => ({ ...m, [i.id]: `${e.leagueId}:${e.kind}:${e.at ?? ""}` })); } : null} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// v4.1: roster warnings at the top of the Waivers screen (Available and Claims).
function RosterWarnings({ league }) {
  const w = waiverRosterWarnings(league);
  if (!w.irMoves.length && !w.ineligible) return null;
  return (
    <div className="space-y-1.5 mb-3" data-roster-warnings>
      {w.ineligible && (
        <div style={{ background: C.majorBg, border: `1px solid ${C.major}55`, color: C.text }} className="rounded-md px-3 py-2 text-xs" data-roster-ineligible>
          <div style={{ color: C.major }} className="font-semibold">Claims may fail — your roster is ineligible</div>
          {w.over && <div>You have {w.over.players} players for {w.over.spots} starting and bench spots — drop or move {w.over.players - w.over.spots} first.</div>}
          {w.badIr.map((p) => (
            <div key={p.id}>
              <PlayerLink player={p} className="inline underline">{p.name}</PlayerLink> is in an IR slot but isn't IR-eligible here ({p.status || "Healthy"}) — move him out of IR.
            </div>
          ))}
        </div>
      )}
      {w.irMoves.length > 0 && (
        <div style={{ background: C.minorBg, border: `1px solid ${C.minor}55`, color: C.text }} className="rounded-md px-3 py-2 text-xs" data-ir-warning>
          <div style={{ color: C.minor }} className="font-semibold">{w.openIr} IR spot{w.openIr === 1 ? " is" : "s are"} empty</div>
          {w.irMoves.map((p) => (
            <div key={p.id}>
              <PlayerLink player={p} className="inline underline">{p.name}</PlayerLink> ({p.status}) is IR-eligible but not on IR — moving him frees a roster spot for a claim.
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// v4.1: "Available elsewhere" — the other leagues he can be claimed in, with each league's FAAB left / budget and a
// bid box (or "Add claim" without FAAB). A bid goes straight into THAT league's waiver plan (its Claim Generator tab).
function ElsewhereModal({ player, leagues, mode, onClose }) {
  const [plans, setPlans] = useState({});
  const [msg, setMsg] = useState({});
  useEffect(() => {
    let alive = true;
    for (const l of leagues) api.getWaiverPlan(l.id).then((pl) => alive && setPlans((m) => ({ ...m, [l.id]: pl }))).catch((e) => alive && setMsg((m) => ({ ...m, [l.id]: { err: e.message } })));
    return () => {
      alive = false;
    };
  }, [leagues]);
  const save = async (l, dollars) => {
    const pl = plans[l.id];
    if (!pl) return;
    const next = { ...pl, bids: stampBids(pl.bids || [], setBid(pl.bids || [], player, dollars)) };
    setPlans((m) => ({ ...m, [l.id]: next }));
    try {
      const saved = await api.saveWaiverPlan(l.id, next);
      setPlans((m) => ({ ...m, [l.id]: saved }));
      setMsg((m) => ({ ...m, [l.id]: { ok: dollars == null ? "Removed from its Claim Generator" : "Added to its Claim Generator" } }));
    } catch (e) {
      setMsg((m) => ({ ...m, [l.id]: { err: e.message } }));
    }
  };
  return (
    <Modal title={`${player.name} — available elsewhere`} onClose={onClose}>
      <div className="space-y-1.5" data-elsewhere-modal>
        {leagues.map((l) => {
          const pl = plans[l.id];
          const bid = pl ? (pl.bids || []).find((b) => String(b.id) === String(player.id)) : null;
          const m = msg[l.id];
          const lmode = l.faab && l.budget ? pl?.entryMode || mode : "dollars";
          return (
            <div key={l.id} style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2 flex items-center justify-between gap-2" data-elsewhere-league={l.id}>
              <div className="min-w-0">
                <div style={{ color: C.text }} className="text-sm truncate">{l.name}</div>
                <div style={{ color: C.textFaint }} className="text-[11px]">{l.faab ? `FAAB ${fmtMoney(l.remaining)} left of ${fmtMoney(l.budget)}` : "No FAAB — waiver priority"}</div>
                {m?.ok && <div style={{ color: C.ok }} className="text-[11px]">{m.ok}</div>}
                {m?.err && <div style={{ color: C.major }} className="text-[11px]">{m.err}</div>}
              </div>
              <div className="shrink-0">
                {!pl ? (
                  <Loader2 size={14} className="animate-spin" style={{ color: C.textMuted }} />
                ) : l.faab ? (
                  <BidBox dollars={bid ? bid.bid : null} mode={lmode} budget={l.budget} onCommit={(d) => save(l, d)} ariaLabel={`Bid for ${player.name} in ${l.name}`} />
                ) : (
                  <button type="button" onClick={() => save(l, bid ? null : 0)} style={{ color: bid ? C.ok : C.brand, border: `1px solid ${bid ? C.ok : C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-elsewhere-claim>
                    {bid ? "Claimed ✓" : "Add claim"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div style={{ color: C.textFaint }} className="text-[11px] pt-1">A bid here is saved to that league's Claim Generator.</div>
      </div>
    </Modal>
  );
}

// v4.1: search any free agent in this league (in a list below or not) and add a claim on him.
function FreeAgentSearch({ league, renderRow, right = null }) {
  const [q, setQ] = useState("");
  const [st, setSt] = useState({ loading: false, players: null, error: null });
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setSt({ loading: false, players: null, error: null });
      return undefined;
    }
    let alive = true;
    setSt((x) => ({ ...x, loading: true }));
    const timer = setTimeout(() => {
      api
        .searchFreeAgents(league.id, t)
        .then((r) => alive && setSt({ loading: false, players: r.players || [], error: null }))
        .catch((e) => alive && setSt({ loading: false, players: null, error: e.message }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, league.id]);
  return (
    <div className="px-1 pb-2" data-fa-search>
      <div className="flex items-center gap-2">
      <label className="flex-1 min-w-0 flex items-center gap-2 rounded-md px-2 py-1.5" style={inputStyle}>
        <Search size={14} style={{ color: C.textFaint }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any free agent to add a claim…" className="flex-1 bg-transparent outline-none text-sm" style={{ color: C.text }} aria-label="Search free agents" data-fa-search-input />
        {st.loading && <Loader2 size={13} className="animate-spin" style={{ color: C.textMuted }} />}
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search" style={{ color: C.textFaint }}>
            <X size={13} />
          </button>
        )}
      </label>
      {right}
      </div>
      {st.error && <div style={{ color: C.major }} className="text-[11px] pt-1">{st.error}</div>}
      {st.players && (
        <div className="space-y-1.5 pt-2" data-fa-search-results>
          {st.players.length === 0 ? (
            <div style={{ color: C.textMuted }} className="text-xs">No free agent in this league matches “{q.trim()}”.</div>
          ) : (
            st.players.map((p) =>
              p.locked ? (
                <div key={p.id} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-2 text-xs" data-fa-search-locked={p.id}>
                  <PlayerLink player={p} className="inline" style={{ color: C.text }}>{p.name}</PlayerLink> {p.pos}{p.team ? ` · ${p.team}` : ""} — his game has started; he can be claimed once the week's last game ends.
                </div>
              ) : (
                renderRow(p)
              )
            )
          )}
        </div>
      )}
    </div>
  );
}

// v4.2: the stats list is the same for every page — loaded once per session.
let statsCfgPromise = null;
export function loadStatsConfig() {
  if (!statsCfgPromise) statsCfgPromise = api.getStatsConfig().catch((e) => ((statsCfgPromise = null), Promise.reject(e)));
  return statsCfgPromise;
}
export const resetStatsConfig = () => (statsCfgPromise = null);
const PAGE = 20;
export function defaultWaiverView(cur) {
  return { mode: "proj", categories: ["General"], stats: ["fpts"], dir: "desc", seasons: [cur?.season].filter(Boolean), period: "weeks", weeks: [cur?.week].filter(Boolean) };
}

// v4.2: Waivers → Available → All: every free agent in the league, sorted by any stat from the stats list.
function AllTab({ league, filter, rowProps, cardFor }) {
  const [cfg, setCfg] = useState(null);
  const [view, setView] = useState(null);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ loading: true, rows: [], error: null });
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef(null);
  const positions = expandPositions(filter);
  useEffect(() => {
    let alive = true;
    Promise.all([loadStatsConfig(), api.getStatsView("waivers").catch(() => ({ state: null }))])
      .then(([c, v]) => {
        if (!alive) return;
        setCfg(c);
        // A saved "this week" follows the calendar: it means the current week, not the week it was saved in.
        const saved = v.state || {};
        const follow = saved.followsWeek ? { seasons: [c.cur?.season], period: "weeks", weeks: [c.cur?.week] } : {};
        setView(normalizeView({ ...defaultWaiverView(c.cur), ...saved, ...follow }, c, { positions: expandPositions("ALL"), cur: c.cur }));
      })
      .catch((e) => alive && setData({ loading: false, rows: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, []);
  const changeView = (v) => {
    setView(v);
    const cur = cfg?.cur;
    const followsWeek = Boolean(cur && v.period === "weeks" && v.weeks.length === 1 && v.weeks[0] === cur.week && v.seasons.length === 1 && v.seasons[0] === cur.season);
    api.saveStatsView("waivers", { ...v, followsWeek }).catch(() => {});
  };
  const statId = view?.stats?.[0] || null;
  const sig = view ? JSON.stringify([league.id, positions, view.mode, view.seasons, view.period, view.weeks, statId]) : null;
  useEffect(() => {
    if (!view) return undefined;
    let alive = true;
    setData((d) => ({ ...d, loading: true, error: null }));
    const t = setTimeout(() => {
      api
        .queryStats({ scope: "fa", leagueId: league.id, positions, mode: view.mode, time: { seasons: view.seasons, period: view.period, weeks: view.weeks }, stats: statId ? [statId] : [] })
        .then((r) => alive && (setData({ loading: false, rows: r.rows || [], error: null, note: r.loaded?.length ? r.loaded.join("; ") : null }), setShown(PAGE)))
        .catch((e) => alive && setData({ loading: false, rows: [], error: e.message }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const sorted = useMemo(() => (statId ? sortRows(data.rows, [statId], { [statId]: { dir: view?.dir || "desc" } }) : data.rows), [data.rows, statId, view?.dir]);
  // load more as the list scrolls into view (the button is the fallback)
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => n + PAGE), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [sorted.length, shown]);
  const statName = statId ? cfg?.rows.find((r) => r.id === statId)?.stat || statId : null;
  const timeLabel = view ? `${view.mode === "proj" ? "Projected" : "Actual"} · ${view.seasons.join(", ")} · ${view.period === "season" ? "season" : view.period === "avg" ? "season average" : `week ${view.weeks.join(", ")}`}` : "";
  return (
    <div data-all-tab>
      <FreeAgentSearch
        league={league}
        renderRow={(r) => <AvailableRow key={r.id} {...rowProps({ ...r, ...compareToRoster(league, r) }, "search")} />}
        right={
          <button type="button" onClick={() => setOpen(true)} aria-label="Filters and sort" title="Filters and sort" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} className="rounded-md p-2 shrink-0" data-filters-button>
            <SlidersHorizontal size={16} />
          </button>
        }
      />
      {open && cfg && view && (
        <Modal title="Filters & sort" onClose={() => setOpen(false)}>
          <StatPickers cfg={cfg} cur={cfg.cur} view={view} onChange={changeView} positions={positions} rows={data.rows} firstStat={cfg.firstStatSeason} firstProj={cfg.firstProjSeason} />
          <button type="button" onClick={() => setOpen(false)} style={{ background: C.brand, color: "#fff" }} className="w-full rounded-md py-2 text-sm font-medium mt-3" data-filters-done>
            Done
          </button>
        </Modal>
      )}
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-all-sort>
        {statName ? `Sorted by ${statName} (${view?.dir === "asc" ? "low to high" : "high to low"}) · ${timeLabel}` : "Choose a stat to sort by (filter button)."} · {data.loading ? "loading…" : `${data.rows.length} free agents`}
      </div>
      {data.error && <div style={{ color: C.major }} className="text-xs px-1 pb-2">{data.error}</div>}
      {data.note && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-2">Some weeks couldn't load: {data.note}</div>}
      <div className="space-y-1.5" data-category-list="all">
        {sorted.slice(0, shown).map((r) => {
          const p = cardFor(r);
          const v = statId ? r.values?.[statId] : null;
          return <AvailableRow key={r.id} {...rowProps(p, statId ? `${statName}: ${fmtValue(statId, v)}` : null)} />;
        })}
      </div>
      {shown < sorted.length && (
        <div ref={sentinel} className="pt-2">
          <button type="button" onClick={() => setShown((n) => n + PAGE)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="w-full rounded-md py-2 text-sm" data-load-more>
            Load more ({sorted.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}

function AvailablePage({ league, plan, setPlan, faab, onRefresh, onOpenAccount = null, allLeagues = [] }) {
  const budget = league.waiverInfo?.budget || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  // v4.8: FAAB left now (real) and after every bid entered on this page (live)
  const remaining = Math.max(0, budget - (league.waiverInfo?.used || 0));
  const totalBids = (plan.bids || []).reduce((t, b) => t + (Number(b.bid) || 0), 0);
  const remainingLive = remaining - totalBids;
  const wc = league.waiverCategories || fallbackLists(league);
  const hypeReady = (wc.lists?.hype || []).length > 0;
  const [filter, setFilter] = useState("ALL");
  const [cat, setCat] = useState("all"); // v4.2: All is the default tab
  const hints = useMemo(() => {
    const m = new Map();
    for (const x of faab.result?.players || []) {
      if (x.id) m.set(`id:${x.id}`, x);
      m.set(`name:${x.name}`, x);
    }
    return m;
  }, [faab.result]);
  const rowsById = useMemo(() => new Map((league.waiver?.rows || []).map((r) => [r.id, r])), [league.waiver]);
  const onBid = (p, dollars) => setPlan((pl) => ({ ...pl, bids: setBid(pl.bids, p, dollars) }));
  const view = cat === "all" ? [] : categoryView(wc.lists, wc.cards, cat, filter);
  const rowFor = (id) => {
    const card = wc.cards[id];
    const known = rowsById.get(id);
    return known ? { ...card, ...known, hype: card.hype ?? known.hype, fillIn: card.fillIn ?? known.fillIn } : { ...card, ...compareToRoster(league, card) };
  };
  const meta = CATEGORIES.find((c) => c.key === cat);
  const [elsewhereFor, setElsewhereFor] = useState(null); // v4.1: { player, leagues }
  const [bidInfo, setBidInfo] = useState(null); // v4.4.2: { player, hint } — the bid distribution pop-up
  const rowProps = (p, keyText = null) => {
    const hint = isFaab && budget ? hints.get(`id:${p.id}`) || hints.get(`name:${p.name}`) : null;
    return { p, plan, mode, budget, isFaab, faabHint: hint, onBidInfo: (pl, h) => setBidInfo({ player: pl, hint: h }), onBid, remainingLive, profile: league.scoringProfile, leagueType: league.leagueType, keyText, elsewhere: availableElsewhere(p, league, allLeagues), onElsewhere: (pl, leagues) => setElsewhereFor({ player: pl, leagues }) };
  };
  const chip = (active) => ({ background: active ? C.brand : "transparent", color: active ? "#fff" : C.textMuted, border: `1px solid ${active ? C.brand : C.border}` });
  return (
    <div>
      {bidInfo && <BidDistributionModal player={bidInfo.player} budget={budget} samplePct={faab.result?.samples?.[bidInfo.hint.sampleKey] || []} scope={bidInfo.hint.sampleScope || "tracked leagues"} onClose={() => setBidInfo(null)} />}
      {elsewhereFor && <ElsewhereModal player={elsewhereFor.player} leagues={elsewhereFor.leagues} mode={mode} onClose={() => setElsewhereFor(null)} />}
      {isFaab && budget > 0 && (
        <FaabCard current={remaining} currentPct={pctOf1(remaining, budget)} spent={totalBids} wins={(plan.bids || []).length} after={remainingLive} afterPct={pctOf1(remainingLive, budget)}>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">Left: the budget available in Sleeper. Right: that minus every bid entered on this page, updated as you type.</div>
        </FaabCard>
      )}
      {cat !== "auto" && <div className="flex items-center justify-between gap-2 px-1 pb-2 flex-wrap" data-available-controls>
        <div className="flex items-center gap-1 flex-wrap" data-pos-filter>
          {POSITION_FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} style={chip(filter === f)} className="rounded-full px-2.5 py-0.5 text-[11px]" data-pos-filter-btn={f} aria-pressed={filter === f}>
              {f === "ALL" ? "All" : f}
            </button>
          ))}
        </div>
        {isFaab && <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />}
      </div>}
      <div className="mb-2" data-category-tabs>
        {categoryRows().map((row, ri) => (
          <div key={ri} className="flex" style={{ borderBottom: `1px solid ${C.border}` }} data-category-row={ri}>
            {row.map((c) => (
              <button key={c.key} type="button" onClick={() => setCat(c.key)} aria-current={cat === c.key ? "page" : undefined} data-category={c.key} style={{ color: cat === c.key ? C.text : C.textMuted, borderBottom: `2px solid ${cat === c.key ? C.brand : "transparent"}` }} className="flex-1 px-1 py-1.5 text-xs font-medium whitespace-nowrap">
                {c.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-1">
        {meta?.blurb}
      </div>
      {cat === "hype" && <ResearchStatus hype={wc.hype} onRefresh={onRefresh} />}
      {isFaab && cat !== "auto" && (
        <div style={{ color: faab.error ? C.major : C.textFaint }} className="text-[10px] px-1 pb-2" data-faab-status>
          {faab.loading ? "Working out suggested bids…" : faab.error ? `Suggested bids unavailable: ${faab.error}` : faab.result?.note ? faab.result.note : null}
        </div>
      )}
      {cat === "all" && <AllTab league={league} filter={filter} rowProps={rowProps} cardFor={(r) => (wc.cards[r.id] ? rowFor(r.id) : rowsById.get(r.id) || { ...r, ...compareToRoster(league, r) })} />}
      {cat === "auto" && <><div style={{ color: C.textMuted }} className="text-xs px-1 pb-2" data-auto-moved>Auto mode's check boxes are now on the League page → Auto mode.</div><AutoView league={league} onOpenAccount={onOpenAccount} withCard={false} /></>}
      {cat === "copy" && <CopyView league={league} filter={filter} rowProps={rowProps} cardFor={(id) => (wc.cards[id] ? rowFor(id) : rowsById.get(id) || null)} isFaab={isFaab} budget={budget} remaining={remaining} onCopyAll={(bids) => setPlan((pl) => ({ ...pl, bids: bids.reduce((acc, x) => setBid(acc, x.player, x.dollars), pl.bids) }))} onUseEntry={(player, pct) => { const dollars = Math.min(Math.round((pct / 100) * budget), remaining); onBid(player, dollars); return dollars; }} />}
      {cat === "perf" && <PerformanceView league={league} filter={filter} rowProps={rowProps} cardFor={(r) => (wc.cards[r.id] ? rowFor(r.id) : rowsById.get(r.id) || { ...r, ...compareToRoster(league, r) })} />}
      {cat === "drops" && <DropsTab league={league} filter={filter} rowProps={rowProps} cardFor={(id) => (wc.cards[id] ? rowFor(id) : rowsById.get(id) || null)} />}
      {!["all", "drops", "auto", "copy", "perf"].includes(cat) && view.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>{cat === "hype" && !hypeReady ? "No research yet for this week." : "Nobody available here right now."}</div>}
      {!["all", "drops", "auto", "copy", "perf"].includes(cat) && <div className="space-y-1.5" data-category-list={cat}>
        {view.map((e) => {
          const p = rowFor(e.id);
          return <AvailableRow key={p.id} {...rowProps(p, keyLabel(cat, p))} />;
        })}
      </div>}
      {cat !== "drops" && cat !== "auto" && league.waiverLock?.hidden > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pt-2" data-waiver-lock>{league.waiverLock.hidden} player(s) are hidden because their game has started. They can't be claimed until the week's last game ends.</div>}
      {cat !== "drops" && cat !== "auto" && <div className="mt-3">
        <DropSummary league={league} />
      </div>}
    </div>
  );
}

/* v4.8 — Performance: free agents by the fantasy points they actually scored (games with more than 20% of snaps). */
function PerformanceView({ league, filter, rowProps, cardFor }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sort, setSort] = useState("last4");
  const [mode, setMode] = useState("total");
  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    api.getFaPerformance(league.id).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [league.id]);
  if (err) return <div style={{ color: C.major }} className="text-sm px-1 py-2" data-perf-error>{err}</div>;
  if (!data) return <div style={{ color: C.textMuted }} className="text-sm px-1 py-2 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Reading this season's games…</div>;
  const FLEXP = ["RB", "WR", "TE"];
  const inFilter = (r) => filter === "ALL" || (filter === "FLEX" ? FLEXP.includes(r.pos) : r.pos === filter);
  const rows = (data.rows || []).filter(inFilter).map((r) => ({ r, v: perfValue(r, sort, mode) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v).slice(0, 40);
  const seg = (on) => ({ background: on ? C.brand : "transparent", color: on ? "#fff" : C.textMuted, border: `1px solid ${on ? C.brand : C.border}` });
  const unit = mode === "ppg" || sort === "weighted" ? "pts/game" : "pts";
  return (
    <div data-perf>
      <div className="flex flex-wrap gap-1.5 px-1 pb-1.5" data-perf-sorts>
        {PERF_SORTS.map(([k, label]) => <button key={k} type="button" onClick={() => setSort(k)} style={seg(sort === k)} className="rounded-md px-2.5 py-1 text-xs" data-perf-sort={k}>{label}</button>)}
      </div>
      <div className="flex items-center gap-1.5 px-1 pb-2" data-perf-modes>
        {[["total", "Total points"], ["ppg", "PPG"]].map(([k, label]) => <button key={k} type="button" onClick={() => setMode(k)} disabled={sort === "lastWeek" || sort === "weighted"} style={{ ...seg(mode === k), opacity: sort === "lastWeek" || sort === "weighted" ? 0.45 : 1 }} className="rounded-md px-2.5 py-1 text-xs" data-perf-mode={k}>{label}</button>)}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-2" data-perf-note>
        Only games where he played more than 20% of his team's offensive snaps count; missed games are skipped and "4 weeks" is his last 4 such games. Weighted avg = (1·latest + ½·2nd + ¼·3rd + ⅛·4th) ÷ 1.875 and is the same in Total and PPG. Through week {data.through}.{data.note ? ` ${data.note}` : ""}
      </div>
      {rows.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>Nobody matches.</div>}
      <div className="space-y-1.5" data-category-list="perf">
        {rows.map(({ r, v }) => {
          const g = sort === "season" ? r.games : sort === "last4" ? r.last4Games : sort === "weighted" ? Math.min(4, r.games) : 1;
          return <AvailableRow key={r.id} {...rowProps(cardFor(r), `${v.toFixed(1)} ${unit}${sort !== "lastWeek" ? ` · ${g} game${g === 1 ? "" : "s"}` : ""}`)} />;
        })}
      </div>
    </div>
  );
}

/* v4.4.2 — Drops: players other teams dropped in the last 14 days (never your own drops). */
function DropsTab({ league, filter, rowProps, cardFor }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [onlyFree, setOnlyFree] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    api.getDrops(league.id).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [league.id]);
  if (err) return <div style={{ color: C.major }} className="text-sm px-1 py-2" data-drops-error>{err}</div>;
  if (!data) return <div style={{ color: C.textMuted }} className="text-sm px-1 py-2 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Reading this league's transactions…</div>;
  const FLEXP = ["RB", "WR", "TE"];
  const all = data.drops || [];
  const inFilter = (d) => filter === "ALL" || (filter === "FLEX" ? FLEXP.includes(d.pos) : d.pos === filter);
  const shown = all.filter((d) => inFilter(d) && (!onlyFree || !d.pickedUpBy));
  const free = all.filter((d) => !d.pickedUpBy).length;
  const when = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div data-drops>
      <div className="flex items-center justify-between gap-2 px-1 pb-2 text-xs" style={{ color: C.textMuted }}>
        <span data-drops-summary>{all.length} dropped in the last {data.days} days · {free} still available</span>
        <label className="flex items-center gap-1.5 shrink-0"><input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} data-drops-free-only /> Available only</label>
      </div>
      {shown.length === 0 && <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-category-empty>Nobody matches.</div>}
      <div className="space-y-1.5" data-category-list="drops">
        {shown.map((d) => {
          const keyText = `Dropped by ${d.droppedBy} · ${when(d.at)}`;
          const card = !d.pickedUpBy ? cardFor(d.id) : null;
          if (card) return <AvailableRow key={d.id} {...rowProps(card, keyText)} />;
          return (
            <div key={d.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${d.pickedUpBy ? C.border : C.ok}` }} className="rounded-md px-3 py-2.5" data-drop={d.id}>
              <div className="flex items-baseline gap-1.5 min-w-0">
                <PlayerLink player={{ id: d.id, name: d.name }} className="min-w-0 truncate"><span style={{ color: C.text }} className="text-sm font-medium">{d.name}</span></PlayerLink>
                <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">{d.pos}{d.team ? ` · ${d.team}` : ""}{d.injury ? ` · ${d.injury}` : ""}</span>
              </div>
              <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{keyText}</div>
              <div style={{ color: d.pickedUpBy ? C.textFaint : C.ok }} className="text-[11px] mt-0.5">{d.mine ? "Now on your team" : d.pickedUpBy ? `Picked up by ${d.pickedUpBy}` : "Available"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const simColor = (pct) => (pct == null ? C.textFaint : pct >= 70 ? C.ok : pct >= 40 ? C.minor : C.major);
function ClaimRow({ c, result, sim, mode, budget, isFaab, bench, handle, groupHandle = null, dragging, onBid, onDrop, onDelete, selected = true, onSelect }) {
  const failed = result && !result.ok;
  const dropP = c.dropId ? bench.find((x) => String(x.id) === String(c.dropId)) : null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${failed ? `${C.minor}66` : C.border}`, borderLeft: `3px solid ${failed ? C.minor : C.ok}`, boxShadow: dragging ? "0 6px 18px rgba(0,0,0,0.5)" : "none", opacity: dragging ? 0.92 : selected ? 1 : 0.55 }} className="rounded-md px-2.5 py-2 flex items-start gap-2" data-claim={c.key}>
      <div className="flex flex-col items-center gap-1 shrink-0">{handle}{groupHandle && <span data-group-handle title="Drag to move all of this player's claims in this group together">{groupHandle}</span>}</div>
      {onSelect && <input type="checkbox" checked={selected} onChange={(e) => onSelect(c, e.target.checked)} className="mt-1 shrink-0" aria-label={`Push the claim for ${c.addName}`} data-claim-select={c.key} />}
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
        {dropP && (
          <div className="text-[11px] mt-0.5" style={{ color: C.textFaint }}>
            Dropping <PlayerLink player={dropP} className="inline underline" style={{ color: C.textMuted }}>{dropP.name}</PlayerLink>
          </div>
        )}
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

function ClaimsPage({ league, plan, setPlan, onRefresh, onOpenAccount, pushSignal = 0 }) {
  const [sentTick, setSentTick] = useState(0); // bumps when a push marks claims as sent
  const budget = league.waiverInfo?.budget || 0;
  const used = league.waiverInfo?.used || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const allBench = league.bench || [];
  // v3.4: a locked player can't be dropped. v4.9: any roster player can be — bench lowest projection first, then starters.
  const bench = useMemo(() => dropPool(league, isLocked), [league]);
  const benchByProj = bench;
  const openSpots = Math.max(0, (league.benchSlots ?? allBench.length) - allBench.length);

  // Keep the drop ranking in step with the bench (new bench players go to the bottom, unticked).
  // v4.1: "Drops" — least-rostered first by default; once dragged, the user's order is kept (plan.dropsArranged).
  const syncedDrops = useMemo(() => orderDrops(syncDrops(plan.drops, bench), bench, plan.dropsArranged), [plan.drops, plan.dropsArranged, bench]);
  useEffect(() => {
    const same = syncedDrops.length === plan.drops.length && syncedDrops.every((d, i) => d.id === plan.drops[i].id && d.name === plan.drops[i].name);
    if (!same) setPlan((pl) => ({ ...pl, drops: orderDrops(syncDrops(pl.drops, bench), bench, pl.dropsArranged) }));
  }, [syncedDrops, plan.drops, bench, setPlan]);
  const benchById = useMemo(() => new Map(bench.map((p) => [String(p.id), p])), [bench]);

  const eff = useMemo(() => effectiveClaims({ ...plan, drops: syncedDrops }, { openSpots }), [plan, syncedDrops, openSpots]);
  // v3.0: claims already queued in Sleeper aren't proposed again. A queued claim matches a
  // proposed one when it adds the same player and drops the same player (or nobody).
  const pending = league.privateInfo?.claims?.pending || [];
  const existing = useMemo(
    () => pending.map((x) => ({ key: `sl:${x.id}`, addId: String(x.adds[0] ?? ""), dropId: x.drops[0] != null ? String(x.drops[0]) : null, bid: Number(x.bid) || 0, source: "sleeper", dropPriority: -2, entryIdx: -1, txId: x.id, leg: x.leg ?? null })),
    [pending]
  );
  const existingKeys = useMemo(() => new Set(existing.map((x) => claimKey(x.addId, x.dropId))), [existing]);
  // v3.1: a claim for a player whose game has started is hidden until the week's last game ends.
  const lockedIds = useMemo(() => new Set((league.waiverLock?.lockedIds || []).map(String)), [league.waiverLock]);
  const visibleClaims = useMemo(() => eff.claims.filter((c) => !existingKeys.has(claimKey(c.addId, c.dropId)) && !lockedIds.has(String(c.addId))), [eff.claims, existingKeys, lockedIds]);
  const hiddenCount = eff.claims.length - visibleClaims.length;
  const groups = useMemo(() => groupClaims(visibleClaims, plan.order), [visibleClaims, plan.order]);
  const ordered = useMemo(() => flatten(groups), [groups]);
  // v4.1: tick boxes — only ticked claims are pushed and listed on the checklist.
  const unselected = useMemo(() => new Set(plan.unselected || []), [plan.unselected]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toPush = useMemo(() => selectedClaims(ordered, plan.unselected).filter((c) => !isSent(league.id, c)), [ordered, plan.unselected, league.id, sentTick]);
  const allTicked = toPush.length === ordered.length;
  const onSelect = (c, on) => setPlan((pl) => {
    const set = new Set(pl.unselected || []);
    if (on) set.delete(c.key);
    else set.add(c.key);
    return { ...pl, unselected: [...set] };
  });
  const [clearArm, setClearArm] = useState(null); // "claims" | "drops" — the second tap clears
  useEffect(() => {
    if (!clearArm) return undefined;
    const t = setTimeout(() => setClearArm(null), 4000);
    return () => clearTimeout(t);
  }, [clearArm]);
  const clear = (what) => {
    if (clearArm !== what) return setClearArm(what);
    setClearArm(null);
    if (what === "claims") setPlan((pl) => clearClaims(pl));
    else setPlan((pl) => ({ ...pl, drops: clearDrops(syncDrops(pl.drops, bench)) }));
  };
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
  // v4.1: names (and card details) for claims already queued in Sleeper, which arrive as player ids.
  const nameOf = useMemo(() => {
    const m = new Map();
    for (const p of [...Object.values(league.waiverCategories?.cards || {}), ...(league.waiver?.rows || []), ...addCandidates, ...allBench.filter(Boolean)]) if (p?.id != null) m.set(String(p.id), p);
    return (id) => m.get(String(id)) || { id: String(id), name: String(id) };
  }, [league.waiverCategories, league.waiver, addCandidates, allBench]);
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

  return (
    <div>
      {isFaab ? (
        <FaabCard current={sim.current} currentPct={sim.currentPct} spent={sim.spent} wins={sim.wins} after={sim.after} afterPct={sim.afterPct}>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">
            Predicted for your claims only, assuming you win every possible one. <InfoNote label="About the prediction">Only your highest bid per player counts, a player can be dropped once, and without a drop you can only add as many players as you have open bench spots ({openSpots} now). Other teams' bids aren't visible; equal bids process in the order shown.</InfoNote>
          </div>
        </FaabCard>
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

      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-1" data-drops-moved>
        Bench players you are willing to drop (and their order) are on the Drop candidates page. The claim list below is built from them.
      </div>

      <div>
        <SectionLabel>Proposed claims — {visibleClaims.length}</SectionLabel>
        <div className="flex items-center gap-2 pb-2 flex-wrap px-1">
          {ordered.length > 0 && (
            <button type="button" onClick={() => setPlan((pl) => ({ ...pl, unselected: allTicked ? ordered.map((c) => c.key) : [] }))} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="text-xs rounded-md px-2 py-1" data-select-all>
              {allTicked ? "Deselect all" : "Select all"}
            </button>
          )}
          <button type="button" onClick={() => clear("claims")} disabled={!ordered.length} style={{ color: clearArm === "claims" ? C.major : C.textMuted, border: `1px solid ${clearArm === "claims" ? C.major : C.border}`, opacity: ordered.length ? 1 : 0.5 }} className="text-xs rounded-md px-2 py-1" data-clear-claims>
            {clearArm === "claims" ? "Tap again to clear" : "Clear all"}
          </button>
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
                groupOf={(key) => { const me = g.claims.find((y) => y.key === key); return g.claims.filter((x) => x.addId === me?.addId).map((x) => x.key); }}
                onReorder={(keys) => {
                  const next = flatten(groups.map((x) => (x.bid === g.bid ? { ...x, claims: keys.map((k) => x.claims.find((c) => c.key === k)) } : x))).map((c) => c.key);
                  setPlan((pl) => ({ ...pl, order: next }));
                }}
                render={(c, { handleProps, groupHandleProps, dragging }) => (
                  <ClaimRow c={c} result={resultByKey.get(c.key)} sim={mcByKey.get(c.key)} mode={mode} budget={budget} isFaab={isFaab} bench={benchByProj} dragging={dragging} handle={<DragHandle handleProps={handleProps} dragging={dragging} />} groupHandle={g.claims.filter((x) => x.addId === c.addId).length > 1 ? <DragHandle big handleProps={groupHandleProps} dragging={dragging} /> : null} onBid={onBid} onDrop={onDrop} onDelete={onDelete} selected={!unselected.has(c.key)} onSelect={onSelect} />
                )}
              />
            </div>
          ))}
        </div>
      )}

      <ClaimsPush league={league} ordered={toPush} onSent={(pushed) => { setSentTick((t) => t + 1); if (pushed?.length) setPlan((pl) => afterPush(pl, pushed)); }} pushSignal={pushSignal} existing={existing} isFaab={isFaab} onRefresh={onRefresh} onOpenAccount={onOpenAccount} nameOf={nameOf} />

      {toPush.length > 0 && (
        <>
          <SectionLabel>Enter these in Sleeper, in this order</SectionLabel>
          <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
            Tick each one once it's entered.{" "}
            <a href={`https://sleeper.com/leagues/${league.id}`} target="_blank" rel="noreferrer" style={{ color: C.brand }} className="underline">Open this league in Sleeper</a>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-claim-checklist>
            {toPush.map((c, i) => (
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
// The FIRST push is a single claim; once one has been read back from Sleeper — or the user has confirmed he can
// see it in Sleeper (v4.1) — every ticked claim goes in one go.
function ClaimsPush({ league, ordered, onSent = null, pushSignal = 0, existing, isFaab, onRefresh, onOpenAccount, nameOf = (id) => ({ id, name: id }) }) {
  const [st, setSt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const loadStatus = useCallback(() => api.getPrivateStatus().then(setSt).catch(() => setSt(null)), []);
  useEffect(() => {
    if (league.privateInfo?.configured) loadStatus();
  }, [league.privateInfo?.configured, loadStatus]);
  // v4.1: proven = a verified read-back or the user's "I can see it in Sleeper" (server flag), or a v3.x verified log line.
  const proven = Boolean(st?.claimsProven) || Boolean(st?.log?.some((l) => l.action === "submit_waiver_claim" && l.ok && /and verified/.test(l.detail || "")));
  const batch = proven ? ordered : ordered.slice(0, 1);
  const label = (c) => (isFaab ? describeClaim(c) : `Claim ${c.addName}${c.dropName ? ` and drop ${c.dropName}` : " (no drop)"}`);
  const rootRef = useRef(null);
  useEffect(() => {
    // v4.9: the bar's "Push to Sleeper" button opens the confirm box here and scrolls it into view.
    if (!pushSignal) return;
    if (ordered.length > 0) setConfirming(true);
    rootRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushSignal]);
  const sentUnverified = !proven && results?.some((r) => r.ok && r.verified === false);
  const send = async () => {
    if (busy) return;
    setBusy(true);
    const out = [];
    const okClaims = [];
    for (const c of batch) {
      try {
        const r = await api.pushClaim(league.id, { addId: c.addId, dropId: c.dropId, bid: c.bid }, { keys: pushKeys(league, "waiver"), baseline: waiverBaselineKeys(league) });
        out.push({ label: label(c), ok: r.ok, verified: r.verified, detail: r.detail });
        if (r.ok || r.duplicate) { markSent(league.id, c); okClaims.push(c); }
        if (!r.ok) break; // stop at the first claim Sleeper doesn't accept
      } catch (e) {
        out.push({ label: label(c), ok: false, detail: e.message });
        break;
      }
    }
    setResults(out);
    setBusy(false);
    setConfirming(false);
    onSent?.(okClaims);
    loadStatus();
    if (out.some((o) => o.ok)) onRefresh?.();
  };
  const confirmWorks = async () => {
    try {
      await api.confirmClaimsWork();
      setResults((r) => [...(r || []), { label: "Claim pushes marked as working", ok: true, detail: "the next push sends every ticked claim." }]);
      loadStatus();
    } catch (e) {
      setResults((r) => [...(r || []), { label: "Couldn't save that", ok: false, detail: e.message }]);
    }
  };
  const cancel = async (x) => {
    const who = nameOf(x.addId).name;
    try {
      const r = await api.cancelClaim(league.id, x.txId, x.leg ?? null);
      setResults([{ label: `Cancel queued claim for ${who}`, ok: r.ok, detail: r.detail }]);
      if (r.ok) { forgetSent(league.id, { addId: x.addId, dropId: x.dropId, bid: x.bid }); onSent?.(); onRefresh?.(); }
    } catch (e) {
      setResults([{ label: `Cancel queued claim for ${who}`, ok: false, detail: e.message }]);
    }
  };
  return (
    <div ref={rootRef} className="mt-3 space-y-2" data-claims-push>
      <SectionLabel>Push to Sleeper</SectionLabel>
      <PrivateGate league={league} group="claims" onOpenAccount={onOpenAccount}>
        {league.privateInfo?.claims?.error && <div style={{ color: C.minor }} className="text-[11px] px-1">Couldn't read your queued claims from Sleeper ({league.privateInfo.claims.error}) — proposed claims may duplicate ones already there.</div>}
        {existing.length > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y" data-existing-claims>
            <div style={{ color: C.textFaint }} className="px-3 py-1.5 text-[11px]">Already queued in Sleeper</div>
            {existing.map((x) => {
              const add = nameOf(x.addId);
              const drop = x.dropId ? nameOf(x.dropId) : null;
              return (
                <div key={x.key} style={{ color: C.text, borderColor: C.border }} className="px-3 py-2 text-xs flex items-center justify-between gap-2" data-existing-claim={x.txId}>
                  <span className="min-w-0">
                    Add <PlayerLink player={add} className="inline underline">{add.name}</PlayerLink>
                    {drop ? <>, drop <PlayerLink player={drop} className="inline underline">{drop.name}</PlayerLink></> : ""}
                    {isFaab ? ` · bid ${fmtMoney(x.bid)}` : ""}
                  </span>
                  <button type="button" onClick={() => cancel(x)} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded px-2 py-0.5 text-[11px] shrink-0">Cancel</button>
                </div>
              );
            })}
          </div>
        )}
        {ordered.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-xs px-1">Nothing ticked to push.</div>
        ) : !confirming ? (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} style={{ background: C.brand, color: C.text, opacity: busy ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium" data-push-claims>
            {proven ? `Push ${ordered.length} claim${ordered.length === 1 ? "" : "s"} to Sleeper` : "Push first claim to Sleeper (test)"}
          </button>
        ) : (
          <ConfirmPush title={proven ? "Send these claims to Sleeper?" : "Send ONE test claim to Sleeper?"} lines={batch.map(label)} buttonLabel={proven ? "Yes, submit them" : "Yes, submit this claim"} busy={busy} onConfirm={send} onCancel={() => setConfirming(false)} note={proven ? "Each claim is read back from Sleeper; the push stops at the first one Sleeper doesn't accept." : "This sends only the first ticked claim and reads it back. Once one is confirmed — by the read-back or by you seeing it in Sleeper — the next push sends the rest. Either way, the checklist below still works."} />
        )}
        <PushResults results={results} />
        {sentUnverified && (
          <div style={{ background: C.surface, border: `1px solid ${C.minor}66` }} className="rounded-md px-3 py-2 text-xs space-y-1.5" data-confirm-claims>
            <div style={{ color: C.textMuted }}>Open the league in Sleeper and check your pending claims. If the claim is there, tell the app so it can send the rest in one go.</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={confirmWorks} style={{ background: C.ok, color: "#fff" }} className="rounded px-2.5 py-1" data-confirm-claims-btn>I can see it in Sleeper</button>
              <a href={`https://sleeper.com/leagues/${league.id}`} target="_blank" rel="noreferrer" style={{ color: C.brand }} className="underline">Open Sleeper</a>
            </div>
          </div>
        )}
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


/* ------------------------------------------------------------------ */
/*  v4.6 PENDING CLAIMS: the claims queued in Sleeper, read back       */
/* ------------------------------------------------------------------ */
// Change a bid = cancel the queued claim, then submit it again with the new bid (Sleeper's own "edit" call isn't
// known to the app). Cancel = Sleeper's cancel call (unverified until a cancel has been seen to work).
function PendingClaimsPage({ league, onRefresh, onOpenAccount }) {
  const isFaab = Boolean(league.waiverInfo?.faab);
  const budget = league.waiverInfo?.budget || 0;
  const used = league.waiverInfo?.used || 0;
  const pending = league.privateInfo?.claims?.pending || [];
  const canWrite = Boolean(league.privateInfo?.perms?.claims ?? league.privateInfo?.writesEnabled);
  const nameOf = useMemo(() => {
    const m = new Map();
    const all = [...Object.values(league.waiverCategories?.cards || {}), ...(league.waiver?.rows || []), ...(league.addCandidates || []), ...(league.bench || []), ...(league.ir || []), ...(league.taxi || []), ...(league.starters || []).map((s) => s.player)];
    for (const p of all) if (p?.id != null) m.set(String(p.id), p);
    return (id) => m.get(String(id)) || { id: String(id), name: String(id) };
  }, [league]);
  const [bids, setBids] = useState({});
  const [confirm, setConfirm] = useState(null); // { kind: "cancel" | "bid", x, bid }
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const describe = (x) => {
    const add = nameOf(x.adds[0]);
    const drop = x.drops[0] != null ? nameOf(x.drops[0]) : null;
    return { add, drop, text: `${add.name}${drop ? `, dropping ${drop.name}` : ", no drop"}` };
  };
  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    const { x, kind } = confirm;
    const d = describe(x);
    try {
      const c = await api.cancelClaim(league.id, x.id, x.leg ?? null);
      if (!c.ok) {
        setResults([{ label: `${kind === "bid" ? "Change bid for" : "Cancel claim for"} ${d.add.name}`, ok: false, detail: c.detail || "Sleeper didn't cancel it." }]);
      } else if (kind === "cancel") {
        setResults([{ label: `Cancelled the claim for ${d.add.name}`, ok: true, detail: c.detail }]);
      } else {
        try {
          const r = await api.pushClaim(league.id, { addId: x.adds[0], dropId: x.drops[0] ?? null, bid: confirm.bid }, { keys: pushKeys(league, "waiver"), baseline: waiverBaselineKeys(league) });
          setResults([{ label: `${d.add.name} re-submitted at ${fmtMoney(confirm.bid)}`, ok: r.ok, verified: r.verified, detail: r.ok ? r.detail : `The old claim was cancelled but the new one failed: ${r.detail}. Submit it again from the Claim Generator.` }]);
        } catch (e) {
          setResults([{ label: `${d.add.name} re-submit`, ok: false, detail: `The old claim was cancelled but the new one failed: ${e.message}. Submit it again from the Claim Generator.` }]);
        }
      }
    } catch (e) {
      setResults([{ label: `${kind === "bid" ? "Change bid for" : "Cancel claim for"} ${d.add.name}`, ok: false, detail: e.message }]);
    } finally {
      setBusy(false);
      setConfirm(null);
      onRefresh?.(league.id);
    }
  };
  const readAt = league.privateInfo?.claimsAt;
  return (
    <div className="space-y-2" data-pending-claims>
      <PrivateGate league={league} onOpenAccount={onOpenAccount}>
        <div className="flex items-center justify-between gap-2 px-1">
          <div style={{ color: C.textMuted }} className="text-xs">
            Claims queued in Sleeper{readAt ? ` · read ${fmtWhen(readAt)}` : ""}.
            <InfoNote label="About pending claims">Read from Sleeper whenever the roster is read and after every claim you send. Changing a bid cancels the queued claim and submits it again with the new bid — Sleeper's own edit call isn't known to the app, so the new claim may not keep the old one's place in your order. Cancelling uses Sleeper's cancel call, which is still unverified until you've seen one work. Both need "Waiver claims" switched on under Account → Sleeper access.</InfoNote>
          </div>
          <button type="button" onClick={() => onRefresh?.(league.id)} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded-md px-2 py-1 text-xs shrink-0" data-pending-refresh>Read again</button>
        </div>
        {league.privateInfo?.claims?.error && <div style={{ color: C.minor }} className="text-[11px] px-1">Couldn't read your queued claims from Sleeper ({league.privateInfo.claims.error}).</div>}
        {pending.length === 0 ? (
          <div style={{ color: C.textMuted }} className="text-sm px-1 py-2" data-pending-empty>No claims are queued in Sleeper for this league.</div>
        ) : (
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md divide-y">
            {pending.map((x) => {
              const d = describe(x);
              const typed = bids[x.id] ?? String(Number(x.bid) || 0);
              const newBid = Math.max(0, Math.min(Math.max(0, budget - used), Math.round(Number(typed) || 0)));
              const changed = isFaab && newBid !== (Number(x.bid) || 0);
              return (
                <div key={x.id} style={{ borderColor: C.border }} className="px-3 py-2.5 space-y-1.5" data-pending-claim={x.id}>
                  <div style={{ color: C.text }} className="text-sm">
                    Add <PlayerLink player={d.add} className="inline underline">{d.add.name}</PlayerLink>
                    {d.add.pos ? <span style={{ color: C.textFaint }} className="text-xs"> {d.add.pos}{d.add.team ? ` · ${d.add.team}` : ""}</span> : null}
                    {d.drop ? <>, drop <PlayerLink player={d.drop} className="inline underline">{d.drop.name}</PlayerLink></> : ", no drop"}
                  </div>
                  <div style={{ color: C.textFaint }} className="text-[11px]">{x.status || "pending"}{x.leg ? ` · week ${x.leg}` : ""}{isFaab ? ` · bid ${fmtMoney(Number(x.bid) || 0)}` : ""}</div>
                  {canWrite && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {isFaab && (
                        <>
                          <input type="number" inputMode="numeric" min={0} value={typed} onChange={(e) => setBids((b) => ({ ...b, [x.id]: e.target.value }))} style={inputStyle} className="w-20 rounded-md px-2 py-1 text-sm" aria-label={`New bid for ${d.add.name}`} data-pending-bid />
                          <button type="button" disabled={!changed || busy} onClick={() => setConfirm({ kind: "bid", x, bid: newBid })} style={{ color: changed ? C.brand : C.textFaint, border: `1px solid ${changed ? C.brand : C.border}66` }} className="rounded-md px-2 py-1 text-xs" data-pending-change-bid>Change bid</button>
                        </>
                      )}
                      <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "cancel", x })} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2 py-1 text-xs ml-auto" data-pending-cancel>Cancel claim</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!canWrite && pending.length > 0 && <div style={{ color: C.textFaint }} className="text-[11px] px-1">Changing or cancelling claims is switched off — turn on "Waiver claims" under Account → Sleeper access.</div>}
        {confirm && (
          <ConfirmPush
            title={confirm.kind === "cancel" ? "Cancel this claim in Sleeper?" : "Change this bid?"}
            lines={confirm.kind === "cancel" ? [`Cancel the claim for ${describe(confirm.x).text}`] : [`${describe(confirm.x).text}`, `Bid ${fmtMoney(Number(confirm.x.bid) || 0)} → ${fmtMoney(confirm.bid)}`]}
            buttonLabel={confirm.kind === "cancel" ? "Yes, cancel it" : "Yes, change it"}
            busy={busy}
            onConfirm={run}
            onCancel={() => setConfirm(null)}
            note={confirm.kind === "bid" ? "This cancels the queued claim and submits it again with the new bid. If the new one fails, the old one is already gone." : undefined}
          />
        )}
        <PushResults results={results} />
      </PrivateGate>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v4.9 CLAIM RANKINGS: players with bids grouped by bid (highest      */
/*  first); inside a group the order they were entered, or the one you  */
/*  drag. That order is the Claim Generator's order.                    */
/* ------------------------------------------------------------------ */
function RankingsPage({ league, plan, setPlan }) {
  const budget = league.waiverInfo?.budget || 0;
  const isFaab = Boolean(league.waiverInfo?.faab);
  const mode = plan.entryMode;
  const remaining = Math.max(0, budget - (league.waiverInfo?.used || 0));
  const totalBids = (plan.bids || []).reduce((t, b) => t + (Number(b.bid) || 0), 0);
  const remainingLive = remaining - totalBids;
  const wc = league.waiverCategories || fallbackLists(league);
  const rowsById = useMemo(() => new Map((league.waiver?.rows || []).map((r) => [r.id, r])), [league.waiver]);
  const groups = useMemo(() => bidGroups(plan), [plan]);
  const cardOf = (b) => wc.cards?.[b.id] || rowsById.get(b.id) || { id: b.id, name: b.name, pos: b.pos };
  const onBid = (b, dollars) => setPlan((pl) => (dollars == null ? deleteBid(pl, b.id) : { ...pl, bids: setBid(pl.bids || [], { id: b.id, name: b.name, pos: b.pos }, dollars) }));
  return (
    <div data-rankings>
      {isFaab && budget > 0 && (
        <FaabCard current={remaining} currentPct={pctOf1(remaining, budget)} spent={totalBids} wins={(plan.bids || []).length} after={remainingLive} afterPct={pctOf1(remainingLive, budget)}>
          <div style={{ color: C.textFaint }} className="text-[10px] mt-2">Left: the budget available in Sleeper. Right: that minus every bid entered, updated as you type.</div>
        </FaabCard>
      )}
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <SectionLabel>Claim rankings</SectionLabel>
        {isFaab && <EntryModeToggle mode={mode} onChange={(m) => setPlan((pl) => ({ ...pl, entryMode: m }))} />}
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Players with bids, highest bid first. Within the same bid, drag the handle to set which claim goes first — this is the order the Claim Generator uses. Clearing a bid box deletes the bid everywhere.
      </div>
      {groups.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-3" data-rankings-empty>No bids yet. Enter a bid on the Available page and it shows up here.</div>
      ) : (
        groups.map((g) => (
          <div key={g.bid} className="mb-3" data-rank-group={g.bid}>
            {isFaab && <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-1">{fmtMoney(g.bid)}{pctOf1(g.bid, budget) != null ? ` · ${pctOf1(g.bid, budget)}% of budget` : ""} · {g.bids.length} player{g.bids.length === 1 ? "" : "s"}</div>}
            <DragList
              items={g.bids}
              getKey={(b) => b.id}
              onReorder={(ids) => setPlan((pl) => reorderBids(pl, g.bid, ids))}
              label="Drag to set the claim order within this bid"
              render={(b, { handleProps, dragging }) => {
                const p = cardOf(b);
                return (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: dragging ? 0.92 : 1 }} className="rounded-md px-2.5 py-2 flex items-center gap-2" data-rank-row={b.id}>
                    <DragHandle handleProps={handleProps} dragging={dragging} />
                    <PlayerLink player={p} className="shrink-0 rounded-full">
                      <Headshot player={p} size={30} />
                    </PlayerLink>
                    <div className="min-w-0 flex-1">
                      <PlayerLink player={p} className="block min-w-0 truncate">
                        <span style={{ color: C.text }} className="text-sm">{b.name}</span> <span style={{ color: C.textFaint }} className="text-[11px]">{b.pos}{p.team ? ` · ${p.team}` : ""}</span>
                      </PlayerLink>
                      <div style={{ color: C.textMuted }} className="text-[11px]">{p.proj != null ? `Proj ${Number(p.proj).toFixed(1)}` : "No projection"}{p.status && p.status !== "Healthy" ? ` · ${p.status}` : ""}</div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {isFaab && <BidBox dollars={b.bid} mode={mode} budget={budget} onCommit={(d) => onBid(b, d)} ariaLabel={`Bid for ${b.name}`} />}
                      {isFaab && <BidMath mode={mode} bid={b.bid} budget={budget} remaining={remainingLive} />}
                      <button type="button" onClick={() => setPlan((pl) => deleteBid(pl, b.id))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="text-[11px] rounded px-2 py-0.5" data-rank-delete={b.id} aria-label={`Delete the claim for ${b.name}`}>Delete</button>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        ))
      )}
    </div>
  );
}

const PAGE_FLOW = ["drops", "available", "rankings", "claims"]; // v4.9: pages the bottom Back / Next bar cycles through
export function WaiverTab({ league, sessionId, onRefresh, onOpenAccount, allLeagues = [] }) {
  const [sub, setSub] = useState("drops"); // v4.9: always opens on Drop candidates
  const [pushSignal, setPushSignal] = useState(0);
  const [plan, setPlanState] = useState(null);
  const [planError, setPlanError] = useState(null);
  const [faab, setFaab] = useState({ loading: false, result: null, error: null });
  const saveTimer = useRef(null);
  const latest = useRef(null);
  const leagueId = league.id;

  useEffect(() => {
    setSub("drops");
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
        let next = typeof fn === "function" ? fn(prev) : fn;
        // v4.9: bids and custom claims remember when they were made / last changed (the weekly clear keeps recent ones).
        const now = Date.now();
        if (next.bids !== prev.bids) next = { ...next, bids: stampBids(prev.bids || [], next.bids || [], now) };
        if (next.custom !== prev.custom) next = { ...next, custom: (next.custom || []).map((c) => (c.at != null ? c : { ...c, at: now })) };
        latest.current = next;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flush, 500);
        return next;
      });
    },
    [flush]
  );

  // v3.9: suggested bids load by themselves (no button) and show on each Available card.
  const isFaabLeague = Boolean(league.waiverInfo?.faab);
  const builtAt = league.builtAt || league.cachedAt || null;
  useEffect(() => {
    if (!isFaabLeague || !sessionId) return;
    let cancelled = false;
    setFaab((f) => ({ ...f, loading: true, error: null }));
    api
      .getFaabSuggestions(sessionId, leagueId)
      .then((result) => !cancelled && setFaab({ loading: false, result, error: null }))
      .catch((err) => !cancelled && setFaab({ loading: false, result: null, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [isFaabLeague, sessionId, leagueId, builtAt]);

  // v4.8: a bid filled from the player card / Copy list lands in this open plan (so its next save keeps it).
  useEffect(() => {
    const on = (e) => {
      const d = e.detail;
      if (!d || String(d.leagueId) !== String(leagueId)) return;
      e.preventDefault();
      setPlan((pl) => ({ ...pl, bids: setBid(pl.bids || [], d.player, d.dollars) }));
    };
    window.addEventListener("fm-plan-bid", on);
    return () => window.removeEventListener("fm-plan-bid", on);
  }, [leagueId, setPlan]);
  const go = (key) => {
    setSub(key);
    try { window.scrollTo?.({ top: 0 }); } catch { /* no window */ }
  };
  const dropCount = plan ? (plan.drops || []).filter((d) => d.willing).length : 0;
  const bidCount = plan ? (plan.bids || []).length : 0;
  const claimCount = plan ? effectiveClaims(plan, { openSpots: Math.max(0, (league.benchSlots ?? (league.bench || []).length) - (league.bench || []).length) }).claims.length : 0;
  const tab = (key, label) => (
    <button key={key} onClick={() => setSub(key)} aria-current={sub === key ? "page" : undefined} data-waiver-tab={key} style={{ color: sub === key ? C.text : C.textMuted, borderBottom: `2px solid ${sub === key ? C.brand : "transparent"}` }} className="flex-1 py-2 px-0.5 text-xs font-medium leading-tight">
      {label}
    </button>
  );
  return (
    <div className="px-4 py-3">
      <div className="flex mb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        {tab("drops", `Drop candidates${dropCount ? ` (${dropCount})` : ""}`)}
        {tab("available", `Available${bidCount ? ` (${bidCount})` : ""}`)}
        {tab("rankings", `Claim rankings${bidCount ? ` (${bidCount})` : ""}`)}
        {tab("claims", `Claim Generator${claimCount ? ` (${claimCount})` : ""}`)}
        {tab("pending", `Pending Claims${(league.privateInfo?.claims?.pending || []).length ? ` (${league.privateInfo.claims.pending.length})` : ""}`)}
        {league.waiverInfo?.faab && tab("opponents", "Opponents")}
      </div>
      {planError && <div style={{ color: C.major }} className="text-xs px-1 pb-2">{planError}</div>}
      {sub !== "opponents" && sub !== "pending" && <RosterWarnings league={league} />}
      {sub === "pending" ? (
        <PendingClaimsPage league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      ) : !plan ? (
        <div className="flex items-center gap-2 px-1 py-4" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" /> <span className="text-sm">Loading your waiver plan…</span>
        </div>
      ) : sub === "drops" ? (
        <DropCandidatesPage league={league} plan={plan} setPlan={setPlan} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      ) : sub === "available" ? (
        <AvailablePage league={league} plan={plan} setPlan={setPlan} faab={faab} onRefresh={onRefresh} onOpenAccount={onOpenAccount} allLeagues={allLeagues} />
      ) : sub === "opponents" ? (
        <OpponentsPage league={league} />
      ) : sub === "rankings" ? (
        <RankingsPage league={league} plan={plan} setPlan={setPlan} />
      ) : (
        <ClaimsPage league={league} plan={plan} setPlan={setPlan} onRefresh={onRefresh} onOpenAccount={onOpenAccount} pushSignal={pushSignal} />
      )}
      {plan && PAGE_FLOW.includes(sub) && (
        <div style={{ background: C.bg, borderTop: `1px solid ${C.border}`, bottom: 0 }} className="sticky z-20 -mx-4 px-4 py-2 mt-3 flex items-center gap-2" data-waiver-nav>
          {sub !== PAGE_FLOW[0] && (
            <button type="button" onClick={() => go(PAGE_FLOW[PAGE_FLOW.indexOf(sub) - 1])} style={{ flex: "1 1 0", color: C.text, border: `1px solid ${C.border}`, background: C.surface }} className="rounded-md py-2.5 text-sm font-medium" data-nav-back>← Back</button>
          )}
          {sub === "claims" ? (
            <button type="button" onClick={() => setPushSignal((n) => n + 1)} style={{ flex: "2 1 0", background: C.brand, color: C.text }} className="rounded-md py-2.5 text-sm font-medium" data-nav-push>Push to Sleeper</button>
          ) : (
            <button type="button" onClick={() => go(PAGE_FLOW[PAGE_FLOW.indexOf(sub) + 1])} style={{ flex: sub === PAGE_FLOW[0] ? "1 1 100%" : "2 1 0", background: C.brand, color: C.text }} className="rounded-md py-2.5 text-sm font-medium" data-nav-next>Next →</button>
          )}
        </div>
      )}
    </div>
  );
}
