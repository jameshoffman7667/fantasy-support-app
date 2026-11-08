import * as api from "../api.js";
import { Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { InfoNote, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { SourceSummary } from "../ui/sourceNotes.jsx"; // v4.16.0 (P-28)
import { tradeNet } from "../tradeNet.js";
import { C, fmtWhen } from "../ui/theme.js";

/*
 * v4.15.0 (P-25) — Trade page → Trending/Ending.
 * The weekly article search names players to trade FOR (not on your team) and trade AWAY (on your team). Tick the ones
 * to include; the app builds potential trades from them (league number: dynasty value in dynasty leagues, rest-of-season
 * points in redraft), choosing players by weak starting slots and leaning 10% in your favour. Each trade can be levelled:
 * remove a player, or add one from either roster. Every player shows its dynasty value; every trade its net value.
 */
const fmtVal = (v, dynasty) => (v == null ? "—" : dynasty ? String(Math.round(v)) : Number(v).toFixed(1));

function CandidateRow({ p, checked, onToggle, dynasty }) {
  return (
    <label className="flex items-start gap-2 py-1.5 px-2" style={{ borderBottom: `1px solid ${C.border}` }} data-ideas-row={p.id}>
      <input type="checkbox" className="mt-1" checked={checked} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <span style={{ color: C.text }} className="text-sm"><PlayerLink player={p} className="inline underline">{p.name}</PlayerLink> <span style={{ color: C.textFaint }} className="text-xs">{p.pos}{p.team ? ` · ${p.team}` : ""}</span></span>
        <SourceSummary title={`${p.name} — ${p.direction === "away" ? "trade away" : "trade for"}`} item={p} summary={p.note} className="block text-[11px]" style={{ color: C.textMuted }}>
          <span className="block">{p.owner ? `On ${p.owner} · ` : ""}{p.mentions} mention{p.mentions === 1 ? "" : "s"}{p.sources?.length ? ` · ${p.sources.slice(0, 3).join(", ")}` : ""}</span>
          {p.note && <span style={{ color: C.textFaint }} className="block">{p.note}</span>}
        </SourceSummary>
      </span>
      <span className="text-right shrink-0 text-[11px]" style={{ color: C.textMuted }}>
        <span style={{ color: C.text }} className="block text-xs">{fmtVal(p.value, dynasty)}<span style={{ color: C.textFaint }}> {dynasty ? "value" : "ROS"}</span></span>
        <span className="block">dyn {p.dyn != null ? p.dyn : "—"}</span>
      </span>
    </label>
  );
}

function PlayerLine({ p, dynasty, onRemove }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs" data-trade-player={p.id}>
      <button type="button" onClick={onRemove} aria-label={`Remove ${p.name}`} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded px-1.5 leading-4" data-trade-remove={p.id}>×</button>
      <span className="min-w-0 flex-1 truncate" style={{ color: C.text }}>{p.name} <span style={{ color: C.textFaint }}>{p.pos}{p.team ? ` · ${p.team}` : ""}</span></span>
      <span style={{ color: C.textMuted }} className="shrink-0">{fmtVal(p.value, dynasty)} · dyn {p.dyn != null ? p.dyn : "—"}</span>
    </div>
  );
}

function Proposal({ proposal, rosters, info, dynasty }) {
  const [gets, setGets] = useState(proposal.get);
  const [gives, setGives] = useState(proposal.give);
  const lookup = useCallback((id) => info[id] || rosters.me?.players.find((p) => p.id === id) || rosters[proposal.theirRosterId]?.players.find((p) => p.id === id) || null, [info, rosters, proposal.theirRosterId]);
  const t = tradeNet(gets, gives, lookup);
  const theirs = (rosters[proposal.theirRosterId]?.players || []).filter((p) => !gets.includes(p.id));
  const mine = (rosters.me?.players || []).filter((p) => !gives.includes(p.id));
  const good = t.net >= 0;
  const addTo = (setter, list) => (e) => { if (e.target.value) setter([...list, e.target.value]); e.target.value = ""; };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5 mb-3" data-trade-proposal={proposal.theirRosterId}>
      <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">Trade with {proposal.theirTeam}</div>
      {proposal.reasons?.length > 0 && <div style={{ color: C.textMuted }} className="text-[11px]">{proposal.reasons.join("; ")}.</div>}
      <div style={{ color: C.ok }} className="text-[11px] font-semibold mt-2">You get</div>
      {gets.length === 0 && <div style={{ color: C.textFaint }} className="text-xs">Nobody yet.</div>}
      {gets.map((id) => lookup(id) && <PlayerLine key={id} p={lookup(id)} dynasty={dynasty} onRemove={() => setGets(gets.filter((x) => x !== id))} />)}
      <select defaultValue="" onChange={addTo(setGets, gets)} style={{ background: C.surfaceRaised, color: C.text, border: `1px solid ${C.border}` }} className="rounded px-2 py-1 text-xs mt-1 w-full" aria-label={`Add a player from ${proposal.theirTeam}`} data-trade-add-get>
        <option value="">+ Add a player from {proposal.theirTeam}…</option>
        {theirs.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.pos} · {fmtVal(p.value, dynasty)} · dyn {p.dyn ?? "—"}</option>)}
      </select>
      <div style={{ color: C.major }} className="text-[11px] font-semibold mt-3">You give</div>
      {gives.length === 0 && <div style={{ color: C.textFaint }} className="text-xs">Nobody yet.</div>}
      {gives.map((id) => lookup(id) && <PlayerLine key={id} p={lookup(id)} dynasty={dynasty} onRemove={() => setGives(gives.filter((x) => x !== id))} />)}
      <select defaultValue="" onChange={addTo(setGives, gives)} style={{ background: C.surfaceRaised, color: C.text, border: `1px solid ${C.border}` }} className="rounded px-2 py-1 text-xs mt-1 w-full" aria-label="Add a player from your team" data-trade-add-give>
        <option value="">+ Add a player from your team…</option>
        {mine.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.pos} · {fmtVal(p.value, dynasty)} · dyn {p.dyn ?? "—"}</option>)}
      </select>
      <div className="mt-3 pt-2 text-xs" style={{ borderTop: `1px solid ${C.border}` }} data-trade-net>
        <div className="flex justify-between" style={{ color: C.textMuted }}><span>You get {fmtVal(t.get.value, dynasty)}{!dynasty ? " ROS pts" : ""}</span><span>You give {fmtVal(t.give.value, dynasty)}</span></div>
        <div style={{ color: good ? C.ok : C.major }} className="font-semibold mt-0.5">
          Net {t.net > 0 ? "+" : ""}{fmtVal(t.net, dynasty)}{t.pct != null ? ` (${t.pct > 0 ? "+" : ""}${t.pct}%)` : ""}{good ? "" : " — in their favour"}
        </div>
        {t.dynNet != null && <div style={{ color: C.textMuted }} className="mt-0.5">Net dynasty value {t.dynNet > 0 ? "+" : ""}{t.dynNet} (you get {t.get.dyn}, you give {t.give.dyn})</div>}
      </div>
    </div>
  );
}

export function TrendingEnding({ league }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);
  const [forSel, setForSel] = useState([]);
  const [awaySel, setAwaySel] = useState([]);
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await api.getTradeIdeas(league.id));
    } catch (e) {
      setError(e.message);
    }
  }, [league.id]);
  useEffect(() => { setData(null); setForSel([]); setAwaySel([]); setBuilt(null); load(); }, [load]);

  const toggle = (list, setter, id) => setter(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const search = async () => {
    setSearching(true);
    try { await api.searchTradeIdeas(); await load(); } catch (e) { setError(e.message); }
    setSearching(false);
  };
  const build = async () => {
    setBuilding(true);
    setBuilt(null);
    try { setBuilt(await api.buildTradeIdeas(league.id, forSel, awaySel)); } catch (e) { setError(e.message); }
    setBuilding(false);
  };
  const dynasty = Boolean(data?.dynasty);
  const none = useMemo(() => data && !data.forList.length && !data.awayList.length, [data]);
  const ticked = forSel.length + awaySel.length;

  return (
    <div className="px-4 py-3" data-trending-ending>
      <div className="flex items-center justify-between gap-2">
        <div style={{ color: C.textMuted }} className="text-xs">
          Players the week's trade articles name. {data?.at ? `Searched ${fmtWhen(data.at)}.` : "Not searched yet."}
          <InfoNote label="About Trending/Ending">Once a week (Thursday 8:00) the app searches articles, Reddit and X for players to trade for (trending) and to trade away (ending), starting from the sources the start/sit review uses. Trade-for players not on your team and trade-away players on your team are listed here for this league.</InfoNote>
        </div>
        {data?.configured && (
          <button type="button" onClick={search} disabled={searching} style={{ color: C.brand }} className="text-[11px] flex items-center gap-1 shrink-0" data-ideas-search>
            {searching ? <Loader2 size={11} className="animate-spin" /> : null}Search now
          </button>
        )}
      </div>
      {data && <div style={{ color: C.textMuted }} className="text-[11px] px-1 pt-1">Trades use {data.basis}; every trade leans 10% your way. "dyn" is the dynasty value.</div>}
      {error && <div style={{ color: C.major }} className="text-xs px-1 py-2">{error}</div>}
      {!data && !error && <div style={{ color: C.textMuted }} className="text-sm py-3 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Loading…</div>}
      {data && data.configured === false && <div style={{ color: C.textMuted }} className="text-sm py-3">Add a Gemini key on the server to search for trade articles.</div>}
      {none && data.configured && <div style={{ color: C.textMuted }} className="text-sm py-3">No trade-for players on other teams or trade-away players on yours in this league yet{data.at ? "" : " — press Search now"}.</div>}

      {data?.forList.length > 0 && (
        <>
          <SectionLabel>Trade for — trending, not on your team</SectionLabel>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md">
            {data.forList.map((p) => <CandidateRow key={p.id} p={p} dynasty={dynasty} checked={forSel.includes(p.id)} onToggle={() => toggle(forSel, setForSel, p.id)} />)}
          </div>
        </>
      )}
      {data?.awayList.length > 0 && (
        <>
          <SectionLabel>Trade away — ending, on your team</SectionLabel>
          <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md">
            {data.awayList.map((p) => <CandidateRow key={p.id} p={p} dynasty={dynasty} checked={awaySel.includes(p.id)} onToggle={() => toggle(awaySel, setAwaySel, p.id)} />)}
          </div>
        </>
      )}
      {data && !none && (
        <button type="button" onClick={build} disabled={!ticked || building} style={{ background: C.brand, color: "#fff", opacity: !ticked || building ? 0.5 : 1 }} className="w-full rounded-md px-3 py-2.5 text-sm font-medium mt-3" data-ideas-build>
          {building ? "Building trades…" : ticked ? `Build trades from ${ticked} player${ticked === 1 ? "" : "s"}` : "Tick players to build trades"}
        </button>
      )}
      {built && (
        <div className="mt-4">
          <SectionLabel>Potential trades</SectionLabel>
          {built.proposals.length === 0 && <div style={{ color: C.textMuted }} className="text-sm py-2">No trade found that leans your way with the ticked players. Tick more players, or try others.</div>}
          {built.proposals.map((p, i) => <Proposal key={`${p.theirRosterId}:${p.get.join(",")}:${p.give.join(",")}:${i}`} proposal={p} rosters={built.rosters} info={built.info} dynasty={Boolean(built.dynasty)} />)}
        </div>
      )}
    </div>
  );
}
