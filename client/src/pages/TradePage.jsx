import * as api from "../api.js";
import { Clock, Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { ConfirmPush, PrivateGate, PushResults, SectionLabel } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C, STATUS, fmtInt, fmtWhen } from "../ui/theme.js";

function StrengthWeaknessRow({ label, items, color }) {
  if (!items?.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{label}:</span>
      {items.map((it, i) => (
        <span key={i} style={{ background: `${color}22`, color }} className="text-[11px] rounded px-1.5 py-0.5">
          {it.pos} <span style={{ opacity: 0.75 }}>{it.label ? it.label : it.avgEcr != null ? `(~${it.avgEcr})` : ""}</span>
        </span>
      ))}
    </div>
  );
}

// v2.9: "5 days 3 hr left" from the deadline's end time (an estimate: the last
// kickoff of the deadline week plus a few hours).
function countdownLabel(endsAt, now) {
  const ms = endsAt - now;
  if (ms <= 0) return "passed";
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return d > 0 ? `${d} day${d === 1 ? "" : "s"} ${h} hr left` : h > 0 ? `${h} hr ${m} min left` : `${m} min left`;
}

function DeadlineBanner({ info }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
  if (!info.configured) {
    return <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textMuted }} className="rounded-md px-3 py-2 mb-3 text-xs" data-deadline>This league has no trade deadline.</div>;
  }
  const passed = info.passed || (info.endsAt && info.endsAt <= now);
  const left = info.endsAt ? countdownLabel(info.endsAt, now) : null;
  const urgent = !passed && info.endsAt && info.endsAt - now < 7 * 86400e3;
  const color = passed ? C.textMuted : urgent ? C.minor : C.text;
  return (
    <div style={{ background: urgent ? C.minorBg : C.surfaceRaised, border: `1px solid ${urgent ? `${C.minor}66` : C.border}`, color }} className="rounded-md px-3 py-2 mb-3 text-xs" data-deadline>
      <div className="flex items-center gap-1.5 font-medium">
        <Clock size={13} />
        {passed ? "Trade deadline has passed" : `Trade deadline: ${left || info.label}`}
      </div>
      {info.when ? <div style={{ color: C.textMuted }} className="mt-0.5" data-deadline-when>{info.when}</div> : info.label && !passed && left ? <div style={{ color: C.textMuted }} className="mt-0.5">{info.label}</div> : null}
      {info.note && <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">{info.note}</div>}
    </div>
  );
}

const NEWS_COLOR = { ok: C.ok, caution: C.minor, avoid: C.major };

const NEWS_LABEL = { ok: "No red flags", caution: "Caution", avoid: "Avoid" };

function OwnershipSection({ ownership }) {
  // v3.5: best ball leagues are left out unless switched on; shares are a % of each opponent's own leagues.
  const [withBB, setWithBB] = useState(false);
  if (!ownership) return null;
  if (ownership.pending) {
    return (
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-3 flex items-center gap-1.5" data-ownership-pending>
        <Loader2 size={12} className="animate-spin" /> Checking which of your players your opponents also own in their other leagues — this takes a minute the first time. Refresh shortly.
      </div>
    );
  }
  const k = withBB ? { pct: "pct", leagues: "leagues", total: "total", count: "opponentCount", avg: "avgPct", high: "highBB" } : { pct: "pctNoBB", leagues: "leaguesNoBB", total: "totalNoBB", count: "opponentCountNoBB", avg: "avgPctNoBB", high: "high" };
  const list = (ownership.players || [])
    .map((p) => ({ ...p, _count: p[k.count] ?? p.opponentCount, _avg: p[k.avg] ?? null, _high: Boolean(p[k.high] ?? p.high) }))
    .filter((p) => p._count > 0)
    .sort((a, b) => Number(b._high) - Number(a._high) || (b._avg ?? 0) - (a._avg ?? 0));
  const high = list.filter((p) => p._high);
  const rest = list.filter((p) => !p._high);
  return (
    <div className="mb-3" data-ownership>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        Players on your roster that opponents in this league also roster in their other Sleeper leagues, as a share of each opponent's leagues (so managers in many leagues don't dominate). Based on {ownership.leaguesChecked ?? 0} league(s) checked across {ownership.opponents ?? 0} opponents
        {ownership.capped ? " (capped — not every league was checked)" : ""}.
      </div>
      <label className="flex items-center gap-1.5 text-[11px] px-1 pb-2" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={withBB} onChange={(e) => setWithBB(e.target.checked)} data-ownership-bb />
        Include best ball leagues{ownership.bestBallLeagues != null ? ` (${ownership.bestBallLeagues})` : ""}
      </label>
      {list.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1">None found.</div>
      ) : (
        <div className="space-y-1.5">
          {[...high, ...rest.slice(0, 8)].map((p) => (
            <div key={p.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${p._high ? C.brand : C.border}` }} className="rounded-md px-3 py-2" data-ownership-player={p.id}>
              <div style={{ color: C.text }} className="text-sm">
                <PlayerLink player={p} className="inline">{p.name}</PlayerLink> <span style={{ color: C.textFaint }} className="text-[11px]">{p.pos}</span>
                {p._high && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">High ownership</span>}
                {p._avg != null && <span style={{ color: C.textMuted }} className="text-[11px] ml-1.5" data-ownership-avg>{p._avg}% of opponents' leagues on average</span>}
              </div>
              <div style={{ color: C.textMuted }} className="text-[11px]">
                {p._count} of {ownership.opponents} opponents ·{" "}
                {(p.opponents || [])
                  .filter((o) => (o[k.leagues] ?? o.leagues) > 0)
                  .map((o) => `${o.team} ${o[k.pct] ?? "?"}% (${o[k.leagues] ?? o.leagues} of ${o[k.total] ?? "?"})`)
                  .join(", ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeTab({ league, sessionId, onRefresh, onOpenAccount }) {
  const teams = league.leagueTeams || [];
  const me = teams.find((t) => t.isMe);
  const others = teams.filter((t) => !t.isMe);
  const suggestionsByTeam = {};
  (league.trade.rows || []).forEach((t) => {
    (suggestionsByTeam[t.theirTeam] = suggestionsByTeam[t.theirTeam] || []).push(t);
  });
  const finder = league.tradeFinder || [];
  const [advice, setAdvice] = useState({ loading: false, configured: null, byKey: {}, at: null, error: null });
  const finderSig = finder.map((t) => `${t.give.name}>${t.get.name}`).join("|");
  const runAdvice = useCallback(
    async (force) => {
      if (!finderSig) return;
      setAdvice((a) => ({ ...a, loading: true, error: null }));
      try {
        const r = await api.getTradeAdvice(sessionId, league.id, force === true, force === "open");
        setAdvice({ loading: false, configured: r.configured, byKey: r.byKey || {}, at: r.at, error: null });
      } catch (err) {
        setAdvice((a) => ({ ...a, loading: false, error: err.message }));
      }
    },
    [sessionId, league.id, finderSig]
  );
  // Opening the page only shows what is already cached (v3.3); the news check itself runs when you press its button.
  useEffect(() => {
    runAdvice("open");
  }, [runAdvice]);

  return (
    <div className="px-4 py-3">
      <DeadlineBanner info={league.tradeDeadline} />
      <TradeOffers league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2" data-trade-basis>
        {tradeBasisText(league.tradeBasis)}
      </div>

      {me && (
        <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 mb-3 space-y-1.5">
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm mb-1">Your Team</div>
          <StrengthWeaknessRow label="Strong" items={me.strengths} color={C.ok} />
          <StrengthWeaknessRow label="Weak" items={me.weaknesses} color={C.major} />
        </div>
      )}

      <SectionLabel>Owned by opponents elsewhere</SectionLabel>
      <OwnershipSection ownership={league.ownership} />

      <div className="flex items-center justify-between">
        <SectionLabel>Trade Finder — 1-for-1 Swaps</SectionLabel>
        {finder.length > 0 && advice.configured && (
          <button onClick={() => runAdvice(true)} disabled={advice.loading} style={{ color: C.brand }} className="text-[11px] pt-3 flex items-center gap-1" data-recheck-news>
            {advice.loading ? <Loader2 size={11} className="animate-spin" /> : null}Re-check news
          </button>
        )}
      </div>
      <div style={{ color: C.textMuted }} className="text-xs px-1 pb-2">
        You sell from a position of strength and buy at a position of weakness — never the same position — against real rival rosters, kept to offers close enough in trade value that a rival could plausibly accept. Ranked by the net change to your projected starting lineup.
        {advice.configured === false ? " (Add a Gemini key on the server to get a news check on each swap.)" : advice.configured ? " Each swap has a news check from Gemini with Google Search — it can be wrong, so verify before trading." : ""}
      </div>
      {advice.error && <div style={{ color: C.major }} className="text-xs px-1 pb-2">News check failed: {advice.error}</div>}
      {finder.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 pb-3">No fair 1-for-1 swaps found against any rival roster right now.</div>
      ) : (
        <div className="space-y-1.5 mb-3">
          {finder.map((t, i) => {
            const news = advice.byKey[`${t.give.name} > ${t.get.name}`];
            const nc = news ? NEWS_COLOR[news.flag] || C.textMuted : null;
            return (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${nc || C.ok}` }} className="rounded-md px-3.5 py-2.5" data-finder={i}>
                <div style={{ color: C.text }} className="text-xs">
                  <span style={{ color: C.textMuted }}>Give </span><PlayerLink player={t.give} className="inline">{t.give.name}</PlayerLink> <span style={{ color: C.textFaint }}>({t.give.pos})</span>
                  <span style={{ color: C.textMuted }}> · Get </span><PlayerLink player={t.get} className="inline">{t.get.name}</PlayerLink> <span style={{ color: C.textFaint }}>({t.get.pos})</span>
                  <span style={{ color: C.textMuted }}> from </span>{t.theirTeam}
                  {t.mutual && <span style={{ color: C.brand }} className="text-[10px] ml-1.5">They're weak at {t.give.pos} too</span>}
                </div>
                {t.give.value != null && t.get.value != null && (
                  <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5" data-finder-values>
                    Trade value {fmtInt(t.give.value)} → {fmtInt(t.get.value)}
                  </div>
                )}
                <div style={{ color: C.ok }} className="text-[11px] mt-0.5">
                  {t.gain >= 0 ? "+" : ""}{t.gain.toFixed(1)} projected pts to your starting lineup
                  {t.gainParts ? <span style={{ color: C.textFaint }}> ({t.get.name} adds {t.gainParts.add.toFixed(1)}{t.gainParts.loss > 0 ? `, losing ${t.give.name} costs ${t.gainParts.loss.toFixed(1)}` : ""})</span> : null}
                </div>
                {news && (
                  <div style={{ color: nc }} className="text-[11px] mt-1" data-news={news.flag}>
                    <span className="font-medium">{NEWS_LABEL[news.flag] || news.flag}:</span> {news.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {advice.at && advice.configured && <div style={{ color: C.textFaint }} className="text-[10px] px-1 pb-3">News checked {fmtWhen(advice.at)}</div>}

      <SectionLabel>League Teams &amp; Trade Ideas</SectionLabel>
      {others.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No other teams' data available yet.</div>
      ) : (
        <div className="space-y-2.5">
          {others.map((t, i) => {
            const suggestions = suggestionsByTeam[t.team] || [];
            return (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-1.5">
                <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{t.team}</div>
                <StrengthWeaknessRow label="Strong" items={t.strengths} color={C.ok} />
                <StrengthWeaknessRow label="Weak" items={t.weaknesses} color={C.major} />
                {suggestions.length > 0 ? (
                  <div className="space-y-1.5 pt-1.5" style={{ borderTop: `1px solid ${C.border}` }}>
                    {suggestions.map((s, j) => {
                      const sc = STATUS[s.severity];
                      return (
                        <div key={j}>
                          <div style={{ color: C.text }} className="text-xs">
                            <span style={{ color: C.textMuted }}>Give </span>{s.give}<span style={{ color: C.textMuted }}> · Get </span>{s.get}
                          </div>
                          <div style={{ color: sc.color }} className="text-[11px] mt-0.5">{s.note}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: C.textFaint }} className="text-[11px] pt-1">No mutually beneficial swap found with this team right now.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// v3.5: what each trade value source means for this league.
function tradeBasisText(tb) {
  if (!tb) return "";
  if (typeof tb === "string") return tb === "projection" ? "Trade value here is each player's rank by this week's projection among rostered players at his position." : "Trade value here is FantasyPros ECR by position.";
  const type = tb.leagueType === "dynasty" ? "Dynasty league" : "Redraft / keeper league";
  const ros = tb.ros && String(tb.strength).startsWith("rest") ? ` (weeks ${tb.ros.from}–${tb.ros.to})` : "";
  const stale = tb.valuesStale ? " — the value site didn't answer, so yesterday's values are used" : tb.valuesError ? ` — trade values unavailable (${tb.valuesError})` : "";
  return `${type}: strengths and weaknesses are each team's rank at a position by ${tb.strength}${ros}; trade fairness uses ${tb.value} values${stale}.`;
}

// v3.5: an offer's two sides valued with the league's trade-value table, plus Roster Audit's own verdict (dynasty).
function OfferValue({ v, ra }) {
  if (!v || v.verdict === "unknown") return null;
  const color = v.verdict === "win" ? C.ok : v.verdict === "loss" ? C.minor : C.textMuted;
  const what = v.verdict === "win" ? "good for you" : v.verdict === "loss" ? "you'd lose value" : "about even";
  return (
    <div className="text-[11px] space-y-0.5" data-offer-value={v.verdict}>
      <div style={{ color }}>
        <span className="font-medium">{v.pct > 0 ? "+" : ""}{v.pct}% value — {what}</span>
        <span style={{ color: C.textFaint }}> · you get {fmtInt(v.getValue)}, you give {fmtInt(v.giveValue)} ({v.source}{v.picksIgnored ? `; ${v.picksIgnored} pick(s) not valued in redraft` : ""})</span>
      </div>
      {v.missing?.length > 0 && <div style={{ color: C.textFaint }}>No value found for: {v.missing.join(", ")}</div>}
      {ra && !ra.error && !ra.skipped && (ra.verdict || (ra.totalA != null && ra.totalB != null)) && (
        // We send "what you get" as side A and "what you give" as side B, so RA's verdict text is shown with that key.
        <div style={{ color: C.textMuted }} data-offer-ra>
          Roster Audit calculator
          {ra.totalA != null && ra.totalB != null ? `: you get ${fmtInt(ra.totalA)}, you give ${fmtInt(ra.totalB)}` : ""}
          {ra.verdict ? ` · "${ra.verdict}" (side A = what you get)` : ""}
          {ra.cliffWarnings?.length ? ` · age warnings: ${ra.cliffWarnings.join("; ")}` : ""}
        </div>
      )}
    </div>
  );
}

function OfferSide({ players, picks }) {
  const items = [
    ...(players || []).map((p) => (
      <PlayerLink key={`p${p.id}`} player={p} className="inline font-bold">
        {p.name || p.id}{p.pos ? ` (${p.pos})` : ""}
      </PlayerLink>
    )),
    ...(picks || []).map((pk, i) => <b key={`k${i}`}>{pk}</b>),
  ];
  if (!items.length) return <b>nothing</b>;
  return items.map((el, i) => (
    <React.Fragment key={i}>
      {i > 0 ? ", " : ""}
      {el}
    </React.Fragment>
  ));
}

function OfferCard({ o, kind, league, onRefresh, onOpenAccount }) {
  const [state, setState] = useState({ confirming: false, busy: false, result: null });
  const side = (players, picks) => [...(players || []).map((p) => `${p.name || p.id}${p.pos ? ` (${p.pos})` : ""}`), ...(picks || [])].join(", ") || "nothing";
  const reject = async () => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const r = await api.rejectTrade(league.id, o.id, o.leg ?? league.week);
      setState({ confirming: false, busy: false, result: { ok: r.ok, verified: r.ok, detail: r.detail } });
      if (r.ok) onRefresh?.();
    } catch (e) {
      setState({ confirming: false, busy: false, result: { ok: false, detail: e.message } });
    }
  };
  const withdraw = async () => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const r = await api.withdrawTrade(league.id, o.id, o.leg ?? league.week);
      setState({ confirming: false, busy: false, result: { ok: r.ok, verified: r.verified, detail: r.detail } });
      if (r.ok) onRefresh?.();
    } catch (e) {
      setState({ confirming: false, busy: false, result: { ok: false, detail: e.message } });
    }
  };
  const color = kind === "outgoing" && o.stale ? C.major : kind === "incoming" && !o.cleared ? C.minor : C.border;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}` }} className="rounded-md px-3 py-2.5 space-y-1.5" data-offer={o.id} data-offer-kind={kind}>
      <div style={{ color: C.textFaint }} className="text-[11px]">{kind === "incoming" ? "From" : "To"} {o.partner || "another team"}{o.ageDays != null ? ` · ${o.ageDays} day${o.ageDays === 1 ? "" : "s"} ago` : ""}</div>
      <div style={{ color: C.text }} className="text-sm">You get: <OfferSide players={o.get} picks={o.getPicks} /></div>
      <div style={{ color: C.text }} className="text-sm">You give: <OfferSide players={o.give} picks={o.givePicks} /></div>
      <OfferValue v={o.value} ra={o.ra} />
      {kind === "outgoing" && o.stale && <div style={{ color: C.major }} className="text-xs">Stale — {o.stale}</div>}
      {kind === "outgoing" && (
        <PrivateGate league={league} group="trades" onOpenAccount={onOpenAccount}>
          {!state.confirming && !state.result?.ok && (
            <button type="button" onClick={() => setState((s) => ({ ...s, confirming: true }))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-withdraw-trade>
              Withdraw this offer
            </button>
          )}
          {state.confirming && <ConfirmPush title="Withdraw this trade offer in Sleeper?" lines={[`Withdraw your offer to ${o.partner || "the other team"}: you give ${side(o.give, o.givePicks)}; you get ${side(o.get, o.getPicks)}`]} buttonLabel="Yes, withdraw it" busy={state.busy} onConfirm={withdraw} onCancel={() => setState((s) => ({ ...s, confirming: false }))} />}
          {state.result && <PushResults results={[{ label: "Withdraw offer", ...state.result }]} />}
        </PrivateGate>
      )}
      {kind === "incoming" && (
        <PrivateGate league={league} group="trades" onOpenAccount={onOpenAccount}>
          {!state.confirming && !state.result?.ok && (
            <button type="button" onClick={() => setState((s) => ({ ...s, confirming: true }))} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-reject-trade>
              Reject this offer
            </button>
          )}
          {state.confirming && <ConfirmPush title="Reject this trade offer in Sleeper?" lines={[`Reject ${o.partner || "the"} offer: you get ${side(o.get, o.getPicks)}; you give ${side(o.give, o.givePicks)}`]} buttonLabel="Yes, reject it" busy={state.busy} onConfirm={reject} onCancel={() => setState((s) => ({ ...s, confirming: false }))} note="This can't be undone from here." />}
          {state.result && <PushResults results={[{ label: "Reject offer", ...state.result }]} />}
        </PrivateGate>
      )}
    </div>
  );
}

function TradeOffers({ league, onRefresh, onOpenAccount }) {
  const pi = league.privateInfo;
  if (!pi?.configured) {
    return (
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-offers-hint>
        Trade offers waiting on you (and all your own outstanding offers) appear here once you add your Sleeper token under Account → Sleeper access.
        {onOpenAccount && <> <button type="button" onClick={onOpenAccount} style={{ color: C.brand }} className="underline">Set up</button></>}
      </div>
    );
  }
  if (pi.readsOff) {
    return (
      <div style={{ color: C.textFaint }} className="text-[11px] px-1 pb-2" data-offers-hint>
        Trade offers are hidden because reading from Sleeper is switched off (Account → Sleeper access).
      </div>
    );
  }
  const T = league.tradeOffers || league.privateInfo?.trades || { incoming: [], outgoing: [] };
  if (T.error) return <div style={{ color: C.minor }} className="text-xs px-1 pb-2">Couldn't read trade offers from Sleeper: {T.error}</div>;
  if (pi.empty) return null;
  const inc = T.incoming || [];
  const out = T.outgoing || [];
  return (
    <div className="pb-2" data-offers>
      <SectionLabel>Offers waiting on you — {inc.length}</SectionLabel>
      {inc.length === 0 ? <div style={{ color: C.textMuted }} className="text-sm px-1">No incoming offers.</div> : <div className="space-y-1.5">{inc.map((o) => <OfferCard key={o.id} o={o} kind="incoming" league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />)}</div>}
      <SectionLabel>Your outstanding offers — {out.length}</SectionLabel>
      {out.length === 0 ? <div style={{ color: C.textMuted }} className="text-sm px-1">None outstanding.</div> : <div className="space-y-1.5">{out.map((o) => <OfferCard key={o.id} o={o} kind="outgoing" league={league} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />)}</div>}
    </div>
  );
}
