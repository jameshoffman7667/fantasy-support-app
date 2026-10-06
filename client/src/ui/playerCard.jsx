import * as api from "../api.js";
import { ChevronRight, Loader2, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Avatar, Headshot, MatchupChip, StatLine, WeatherChip } from "./common.jsx";
import { ADV_COLOR, C, POS_COLOR, SOURCE_TAG, SRC_COLOR, TEAM_COLORS, fmtAdv, fmtInt, normTeam, ordinalN, rankColor, readPref, teamRankColor, timeAgo, writePref } from "./theme.js";

/* ------------------------------------------------------------------ */
/*  v3.5 PLAYER CARD POP-UP (benchmarked on Sleeper's player card)      */
/* ------------------------------------------------------------------ */
// Anything that shows a player can open his card: PlayerCardCtx.open(player). The app supplies the league
// that's on screen (if any) as context for scoring, ownership and trade values.
export const PlayerCardCtx = React.createContext({ open: () => {} });

export function PlayerLink({ player, leagueId, children, className = "", style = {}, ...rest }) {
  const ctx = React.useContext(PlayerCardCtx);
  if (!player?.id) return <div className={className} style={style} {...rest}>{children}</div>;
  return (
    <button
      {...rest}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.open(player, { leagueId });
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`text-left ${className}`}
      style={style}
      data-player-link={player.id}
      aria-label={`Open ${player.name || "player"} card`}
    >
      {children}
    </button>
  );
}

function AdvancedStats({ adv }) {
  const [mode, setMode] = useState(() => readPref("fm-adv-colour", "percentile"));
  if (!adv) return null;
  if (adv.error) return <div style={{ color: C.textFaint }} className="text-xs">Advanced stats unavailable: {adv.error}</div>;
  if (!adv.rows?.length) return <div style={{ color: C.textFaint }} className="text-xs">No advanced stats yet this season.</div>;
  const setM = (m) => {
    setMode(m);
    writePref("fm-adv-colour", m);
  };
  return (
    <div data-advanced>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Advanced · season to date{adv.throughWeek ? ` (through week ${adv.throughWeek})` : ""}</div>
        <div className="flex rounded-md overflow-hidden text-[10px]" style={{ border: `1px solid ${C.border}` }} role="group" aria-label="Colouring">
          {["percentile", "fixed"].map((m) => (
            <button key={m} type="button" onClick={() => setM(m)} style={{ background: mode === m ? C.brand : "transparent", color: mode === m ? "#fff" : C.textMuted }} className="px-2 py-0.5" data-adv-mode={m} aria-pressed={mode === m}>
              {m === "percentile" ? "Percentile" : "Fixed"}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        {adv.rows.map((r) => {
          const c = mode === "fixed" ? r.fixedColor : r.pctColor;
          const color = r.context ? C.textMuted : ADV_COLOR[c] || C.textMuted;
          const sub = r.context
            ? "context"
            : !r.enough
            ? "small sample"
            : mode === "fixed"
            ? r.fixed ? `good ${r.better === "low" ? "≤" : "≥"} ${fmtAdv(r.fixed[0], r.fmt)}, poor ${r.better === "low" ? ">" : "<"} ${fmtAdv(r.fixed[1], r.fmt)}` : ""
            : r.percentile != null ? `${ordinalN(r.percentile)} percentile of ${r.poolSize}` : "";
          return (
            <div key={r.key} className="flex items-center justify-between gap-2 text-xs" data-adv-row={r.key} data-adv-color={r.context ? "context" : c || "none"}>
              <div className="min-w-0">
                <div style={{ color: C.text }} className="truncate">{r.label}</div>
                <div style={{ color: C.textFaint }} className="text-[10px]">{sub}</div>
              </div>
              <span style={{ color, background: r.context || !c ? "transparent" : `${color}22`, border: `1px solid ${r.context || !c ? C.border : `${color}66`}`, fontVariantNumeric: "tabular-nums" }} className="rounded px-1.5 py-0.5 font-semibold shrink-0">
                {fmtAdv(r.value, r.fmt)}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px] mt-1.5">
        Percentile: among {adv.pos}s with enough playing time this season (top third green, bottom third red). Fixed: last season's top-third / bottom-third cut-offs. "est." routes = offensive snaps × the team's dropback rate.
      </div>
    </div>
  );
}

export function PlayerCardModal({ target, onClose }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("summary");
  const [logSeason, setLogSeason] = useState(0);
  const [availOpen, setAvailOpen] = useState(false);
  const p = target.player || {};
  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    api.getPlayerCard(p.id, target.leagueId).then((c) => alive && setCard(c)).catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [p.id, target.leagueId]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const team = card?.team || p.team;
  const tc = TEAM_COLORS[normTeam(team)] || ["#2A3A3F", "#5E7570"];
  const name = card?.name || p.name || "Player";
  const first = card?.firstName || name.split(" ")[0];
  const last = card?.lastName || name.split(" ").slice(1).join(" ");
  const pos = card?.pos || p.pos;
  const posColor = POS_COLOR[pos] || C.textMuted;
  const owner = card?.availability?.find((a) => a.current);
  const stat = (label, value) => (
    <div className="text-center min-w-0">
      <div style={{ color: "#ffffffaa" }} className="text-[10px] tracking-wide">{label}</div>
      <div style={{ color: "#fff", fontFamily: "Oswald, sans-serif" }} className="text-xl font-semibold leading-tight">{value ?? "—"}</div>
    </div>
  );
  return (
    <div role="dialog" aria-modal="true" aria-label={`${name} player card`} onClick={onClose} style={{ background: "rgba(0,0,0,0.65)" }} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" data-player-card={p.id}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.bg, border: `1px solid ${C.border}` }} className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-xl sm:rounded-xl">
        {/* header */}
        <div className="relative px-4 pt-4 pb-3" style={{ background: `linear-gradient(120deg, ${tc[0]} 0%, ${tc[0]}cc 55%, ${tc[1]}88 100%)` }}>
          <button onClick={onClose} aria-label="Close" className="absolute top-2 right-2 p-1.5 rounded-full" style={{ color: "#fff", background: "#00000044" }} data-card-close>
            <X size={18} />
          </button>
          <div className="flex items-start gap-3">
            <Headshot player={{ id: p.id, pos, name }} size={76} />
            <div className="min-w-0 flex-1">
              {owner && <div style={{ color: "#ffffffcc" }} className="text-[11px]">{owner.status === "yours" ? "On your team" : owner.status === "rostered" ? `→ ${owner.owner || "another team"}` : "Available in this league"}</div>}
              <div style={{ color: "#fff", fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold leading-tight uppercase">{first}</div>
              <div style={{ color: "#fff", fontFamily: "Oswald, sans-serif" }} className="text-2xl font-bold leading-tight uppercase truncate">{last}</div>
              <div className="text-xs mt-0.5" style={{ color: "#ffffffdd" }}>
                <span style={{ color: posColor, background: "#00000055" }} className="font-bold rounded px-1">{pos}</span> · {team || "FA"}{card?.number != null ? ` · #${card.number}` : ""}
                {card?.bye != null || p.bye != null ? ` · Bye ${card?.bye ?? p.bye}` : ""}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1 mt-3">
            {stat("AGE", card?.age != null ? card.age.toFixed(1) : p.age != null ? Number(p.age).toFixed(1) : null)}
            {stat("HEIGHT", card?.height)}
            {stat("WEIGHT", card?.weight ? `${card.weight}` : null)}
            {stat("EXP", card?.exp)}
          </div>
          {card?.injury && (
            <div className="mt-2 text-xs rounded px-2 py-1" style={{ background: "#00000055", color: C.minor }}>
              {card.injury.status}{card.injury.detail ? ` — ${card.injury.detail}` : ""}{card.injury.notes ? ` · ${card.injury.notes}` : ""}
            </div>
          )}
        </div>
        {/* availability */}
        {card?.availability?.length > 0 && (
          <div className="px-4 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
            <button type="button" onClick={() => setAvailOpen((o) => !o)} className="w-full flex items-center justify-between text-xs" style={{ color: C.text }} aria-expanded={availOpen} data-card-availability>
              <span className="font-semibold tracking-wide">AVAILABILITY IN YOUR LEAGUES</span>
              <ChevronRight size={14} style={{ transform: availOpen ? "rotate(90deg)" : "none", color: C.textMuted }} />
            </button>
            {availOpen && (
              <div className="mt-1.5 space-y-1">
                {card.availability.map((a) => (
                  <div key={a.leagueId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 min-w-0" style={{ color: C.textMuted }}>
                      <Avatar avatar={a.avatar} name={a.league} size={16} square />
                      <span className="truncate">{a.league}</span>
                    </span>
                    <span style={{ color: a.status === "available" ? C.ok : a.status === "yours" ? C.brand : C.textFaint }} className="shrink-0">
                      {a.status === "available" ? "Available" : a.status === "yours" ? "Yours" : a.owner || "Rostered"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* tabs */}
        <div className="flex sticky top-0 z-10" style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
          {[["summary", "SUMMARY"], ["log", "GAME LOG"], ["team", "TEAM"], ["history", "HISTORY"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className="flex-1 py-2.5 text-[11px] font-semibold tracking-wide" style={{ color: tab === k ? C.text : C.textMuted, borderBottom: `2px solid ${tab === k ? C.text : "transparent"}` }} data-card-tab={k}>
              {label}
            </button>
          ))}
        </div>
        <div className="px-4 py-3 space-y-4">
          {error && <div style={{ color: C.major }} className="text-xs">Couldn't load the card: {error}</div>}
          {!card && !error && <div className="flex items-center gap-2 text-xs" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Loading…</div>}
          {card && tab === "summary" && <CardSummary card={card} preview={p} />}
          {card && tab === "log" && <CardGameLog card={card} index={logSeason} setIndex={setLogSeason} />}
          {card && tab === "team" && <CardTeam card={card} />}
          {card && tab === "history" && <CardHistory card={card} />}
        </div>
      </div>
    </div>
  );
}

function CardSection({ title, children, right }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function CardSummary({ card, preview }) {
  const s = card.summary || {};
  const v = card.value;
  const lg = card.gameLog?.[0];
  const colLabel = (k) => lg?.columns?.find((c) => c.key === k)?.label || k;
  return (
    <>
      <div className="grid grid-cols-3 gap-2" data-card-ranks>
        <div>
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Player rank</div>
          <div className="flex gap-3 mt-0.5">
            <div><div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold">{s.posRank ? `#${s.posRank}` : "—"}</div><div style={{ color: C.textFaint }} className="text-[10px]">{card.pos}</div></div>
            <div><div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold">{s.overallRank ? `#${s.overallRank}` : "—"}</div><div style={{ color: C.textFaint }} className="text-[10px]">OVERALL</div></div>
          </div>
        </div>
        <div>
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Fpts / game</div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold mt-0.5">{s.fptsPerGame != null ? s.fptsPerGame.toFixed(2) : "—"}</div>
          <div style={{ color: C.textFaint }} className="text-[10px]">{card.league?.scoring || "PPR"} · {s.games ?? 0} games</div>
        </div>
        <div>
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Trending</div>
          <div style={{ color: s.trendingAdds ? C.ok : C.textMuted, fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold mt-0.5">{s.trendingAdds ? `+${fmtInt(s.trendingAdds)}` : "—"}</div>
          <div style={{ color: C.textFaint }} className="text-[10px]">Sleeper adds (24h)</div>
        </div>
      </div>

      {(preview?.matchup || preview?.opponent || preview?.proj != null) && (
        // League pages pass the full player (matchup chip, weather, projection source); Game Day rows pass the
        // game (opponent, live status, points so far).
        <CardSection title={`This week${card.asOf?.week ? ` · week ${card.asOf.week}` : ""}`}>
          <div className="rounded-md px-3 py-2 space-y-1" style={{ background: C.surface, border: `1px solid ${C.border}` }} data-card-thisweek>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 flex-wrap">
                {preview.matchup ? (
                  <MatchupChip player={preview} profile={preview.profile} />
                ) : preview.opponent ? (
                  <span style={{ color: C.textMuted }} className="text-[11px] font-semibold">{preview.team} {preview.home ? "vs" : "@"} {preview.opponent}</span>
                ) : null}
                {(() => {
                  const when = preview.state === "in" || preview.state === "post" ? preview.statusDetail : preview.matchup?.kickoffLabel || preview.kickoffLabel;
                  return when ? <span style={{ color: preview.state === "in" ? C.brand : C.textFaint }} className="text-[10px]">{when}</span> : null;
                })()}
                <WeatherChip player={preview} />
              </div>
              {preview.points != null ? (
                <div className="text-right shrink-0">
                  <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-base font-semibold">{preview.points.toFixed(1)}</div>
                  <div style={{ color: preview.state === "in" ? C.brand : C.textFaint }} className="text-[10px]">{preview.state === "post" ? "FINAL" : "LIVE"}{preview.proj != null ? ` · proj ${preview.proj.toFixed(1)}` : ""}</div>
                </div>
              ) : preview.proj != null ? (
                <div className="text-right shrink-0">
                  <div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-base font-semibold">{preview.proj.toFixed(1)}</div>
                  <div style={{ color: preview.projSource === "actual" ? C.brand : SRC_COLOR[preview.projSource] || C.textFaint }} className="text-[10px]">{preview.projSource === "actual" ? "FINAL" : SOURCE_TAG[preview.projSource] || "proj"}</div>
                </div>
              ) : null}
            </div>
            <StatLine player={preview} />
          </div>
        </CardSection>
      )}

      {s.lastGame && (
        <CardSection title="Performance">
          <div className="rounded-md px-3 py-2" style={{ background: C.surface, border: `1px solid ${C.border}` }} data-card-lastgame>
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: C.textMuted }}>Week {s.lastGame.week} · {s.lastGame.home === false ? "@" : "vs"} {s.lastGame.opp}{s.lastGame.result ? ` · ${s.lastGame.result} ${s.lastGame.teamScore}-${s.lastGame.oppScore}` : ""}</span>
              <span style={{ color: C.text }} className="font-semibold">{s.lastGame.fpts != null ? `${s.lastGame.fpts.toFixed(1)} fpts` : ""}</span>
            </div>
            <div style={{ color: C.textMuted }} className="text-[11px] mt-1">
              {Object.entries(s.lastGame.stats || {}).filter(([, v]) => v).map(([k, v]) => `${v} ${colLabel(k).toLowerCase()}`).join(" · ") || "No stats"}
            </div>
          </div>
        </CardSection>
      )}

      {s.projections?.length > 0 && (
        <CardSection title="Projections">
          <div className="grid grid-cols-4 gap-1.5" data-card-projections>
            {s.projections.map((pr) => (
              <div key={pr.week} className="rounded-md px-1.5 py-1.5 text-center" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <div style={{ color: C.textFaint }} className="text-[10px]">WK {pr.week}{pr.opp ? ` ${pr.home === false ? "@" : "vs"} ${pr.opp}` : ""}</div>
                {pr.bye ? (
                  <div style={{ color: C.textMuted }} className="text-xs font-semibold py-1">BYE</div>
                ) : (
                  <>
                    <div className="text-[11px]" style={{ color: C.textMuted }}>PROJ <b style={{ color: C.text }}>{pr.proj != null ? pr.proj.toFixed(1) : "—"}</b></div>
                    <div className="text-[11px]" style={{ color: C.textMuted }}>FINAL <b style={{ color: pr.final != null ? C.text : C.textFaint }}>{pr.final != null ? pr.final.toFixed(1) : "—"}</b></div>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardSection>
      )}

      <AdvancedStats adv={card.advanced} />

      {v && (v.value != null || v.error) && (
        <CardSection title={v.kind === "dynasty" ? "Dynasty value" : "Trade value"}>
          {v.value == null ? (
            <div style={{ color: C.textFaint }} className="text-xs">{v.source ? `Not listed by ${v.source}.` : `Values unavailable${v.error ? `: ${v.error}` : ""}.`}</div>
          ) : (
            <div className="flex items-center gap-4 text-xs" data-card-value>
              <div><div style={{ color: C.text, fontFamily: "Oswald, sans-serif" }} className="text-lg font-semibold">{fmtInt(v.value)}</div><div style={{ color: C.textFaint }} className="text-[10px]">{v.source}</div></div>
              {v.posRank && <div><div style={{ color: C.text }} className="font-semibold">#{v.posRank} {card.pos}</div><div style={{ color: C.textFaint }} className="text-[10px]">#{v.overall} overall</div></div>}
              {(v.trend7 != null || v.trend30 != null) && (
                <div>
                  {v.trend7 != null && <div style={{ color: v.trend7 >= 0 ? C.ok : C.major }}>{v.trend7 >= 0 ? "▲" : "▼"} {fmtInt(Math.abs(v.trend7))} <span style={{ color: C.textFaint }}>7d</span></div>}
                  {v.trend30 != null && <div style={{ color: v.trend30 >= 0 ? C.ok : C.major }}>{v.trend30 >= 0 ? "▲" : "▼"} {fmtInt(Math.abs(v.trend30))} <span style={{ color: C.textFaint }}>30d</span></div>}
                </div>
              )}
            </div>
          )}
        </CardSection>
      )}

      <CardSection title="Recent news">
        {card.news?.items?.length ? (
          <div className="space-y-2" data-card-news>
            {card.news.items.map((n, i) => (
              <div key={i} className="rounded-md px-3 py-2" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <div style={{ color: C.text }} className="text-sm font-semibold leading-snug">{n.headline}</div>
                {n.story && <div style={{ color: C.textMuted }} className="text-xs mt-1 leading-snug">{n.story}</div>}
                <div style={{ color: C.textFaint }} className="text-[10px] mt-1">{n.source}{n.published ? ` · ${timeAgo(n.published)} ago` : ""}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: C.textFaint }} className="text-xs">{card.news?.error ? `News unavailable (${card.news.error}).` : "No recent news."}</div>
        )}
      </CardSection>
    </>
  );
}

function CardGameLog({ card, index, setIndex }) {
  const logs = card.gameLog || [];
  const lg = logs[index] || logs[0];
  if (!lg) return <div style={{ color: C.textFaint }} className="text-xs">No game log.</div>;
  const th = "px-1.5 py-1 text-[10px] font-semibold text-center whitespace-nowrap";
  const td = "px-1.5 py-1 text-[11px] text-center whitespace-nowrap";
  return (
    <div data-card-gamelog>
      <div className="flex gap-1.5 mb-2">
        {logs.map((l, i) => (
          <button key={l.season} type="button" onClick={() => setIndex(i)} className="rounded-full px-2.5 py-0.5 text-xs" style={{ background: i === index ? C.brand : "transparent", color: i === index ? "#fff" : C.textMuted, border: `1px solid ${C.border}` }} data-log-season={l.season}>
            {l.season}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full" style={{ color: C.text, borderCollapse: "separate", borderSpacing: "2px" }}>
          <thead>
            <tr style={{ color: C.textFaint }}>
              <th className={th}>WK</th><th className={th}>OPP</th><th className={th}>FPTS</th><th className={th}>SNP%</th><th className={th}>RANK</th>
              {lg.columns.map((c) => <th key={c.key} className={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {lg.rows.map((r) => (
              <tr key={r.week} data-log-week={r.week}>
                <td className={td} style={{ color: C.textMuted }}>{r.week}</td>
                <td className={td} style={{ color: r.home ? C.ok : r.home === false ? C.minor : C.textMuted }}>{r.bye ? "BYE" : r.opp ? `${r.home === false ? "@" : ""}${r.opp}` : "—"}</td>
                {r.bye ? (
                  <td colSpan={3 + lg.columns.length} className={td} style={{ background: C.surfaceRaised }} />
                ) : (
                  <>
                    <td className={td} style={{ background: r.played ? C.surfaceRaised : "transparent", color: r.played ? C.text : C.textFaint, fontVariantNumeric: "tabular-nums" }}>{r.fpts != null ? r.fpts.toFixed(2) : "-"}</td>
                    <td className={td} style={{ color: r.snapPct == null ? C.textFaint : r.snapPct >= 70 ? C.ok : r.snapPct >= 45 ? C.minor : C.major }}>{r.snapPct ?? "-"}</td>
                    <td className={td} style={{ color: rankColor(r.rank) }}>{r.rank ?? "-"}</td>
                    {lg.columns.map((c) => <td key={c.key} className={td} style={{ color: r.played ? C.text : C.textFaint }}>{r.stats?.[c.key] ?? "-"}</td>)}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px] mt-1.5">Fantasy points in this league's scoring (nflverse half/PPR points where Sleeper's stat line isn't stored). Home games green, away amber.</div>
    </div>
  );
}

function CardTeam({ card }) {
  const ranks = card.teamTab?.ranks;
  const depth = card.teamTab?.depth;
  const markOf = (st) => (!st ? null : st === "Questionable" ? "Q" : st === "Doubtful" ? "D" : st === "Out" ? "O" : st === "IR" ? "IR" : st === "PUP" ? "PUP" : st.slice(0, 3).toUpperCase());
  return (
    <>
      <CardSection title="Team rank (season to date)">
        {ranks?.length ? (
          <div className="grid grid-cols-3 gap-1.5" data-card-teamranks>
            {ranks.map((r) => (
              <div key={r.key} className="rounded-md px-2 py-1.5" style={{ background: `${teamRankColor(r.rank, r.of)}22`, border: `1px solid ${teamRankColor(r.rank, r.of)}55` }}>
                <div style={{ color: C.textMuted }} className="text-[10px] truncate">{r.label}</div>
                <div style={{ color: teamRankColor(r.rank, r.of) }} className="text-sm font-semibold">{ordinalN(r.rank)} <span style={{ color: C.textFaint }} className="text-[10px] font-normal">{r.value}</span></div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: C.textFaint }} className="text-xs">No team stats yet.</div>
        )}
      </CardSection>
      <CardSection title={`Depth chart${depth?.source ? ` (${depth.source === "espn" ? "ESPN" : "Sleeper"})` : ""}`}>
        {depth?.rows?.length ? (
          <div className="space-y-1" data-card-depth>
            {depth.rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[3rem_1fr_1fr_1fr] gap-1 items-center rounded-md px-1.5 py-1" style={{ background: C.surface }}>
                <div style={{ color: POS_COLOR[row.label.replace(/\d+$/, "")] || C.textMuted }} className="text-xs font-bold">{row.label}</div>
                {[0, 1, 2].map((i) => {
                  const pl = row.players[i];
                  return (
                    <div key={i} className="min-w-0">
                      {pl && (
                        <>
                          <div style={{ color: C.text }} className="text-[11px] truncate font-medium">
                            {pl.name.split(" ").slice(1).join(" ") || pl.name}
                            {pl.rookie && <span style={{ color: "#A08BE0" }} className="ml-1 text-[9px] font-bold">R</span>}
                            {markOf(pl.status) && <span style={{ color: pl.status === "Questionable" ? C.minor : C.major }} className="ml-1 text-[9px] font-bold">{markOf(pl.status)}</span>}
                          </div>
                          <div style={{ color: C.textFaint }} className="text-[9px]">{pl.age != null ? `${Number(pl.age).toFixed(1)} y/o` : ""}</div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: C.textFaint }} className="text-xs">No depth chart.</div>
        )}
      </CardSection>
    </>
  );
}

function CardHistory({ card }) {
  const h = card.history || {};
  const th = "px-1.5 py-1 text-[10px] font-semibold text-center whitespace-nowrap";
  const td = "px-1.5 py-1 text-[11px] text-center whitespace-nowrap";
  const statKeys = [...new Set((h.career || []).flatMap((r) => Object.keys(r.stats || {})))];
  return (
    <>
      <CardSection title={`In ${card.league?.name || "this league"}`}>
        {(h.drafts?.length || 0) + (h.moves?.length || 0) === 0 ? (
          <div style={{ color: C.textFaint }} className="text-xs">{card.league ? "No transactions involving him this season." : "Open the card from a league page to see its transactions."}</div>
        ) : (
          <div className="space-y-1" data-card-moves>
            {(h.drafts || []).map((d, i) => (
              <div key={`d${i}`} className="text-xs flex justify-between gap-2"><span style={{ color: C.text }}>{d.text}</span><span style={{ color: C.textFaint }}>{d.season}</span></div>
            ))}
            {(h.moves || []).map((m, i) => (
              <div key={`m${i}`} className="text-xs flex justify-between gap-2"><span style={{ color: C.text }}>{m.text}</span><span style={{ color: C.textFaint }}>{m.at ? new Date(m.at).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</span></div>
            ))}
          </div>
        )}
      </CardSection>
      <CardSection title="Career">
        {h.career?.length ? (
          <div className="overflow-x-auto" data-card-career>
            <table className="min-w-full" style={{ color: C.text, borderCollapse: "separate", borderSpacing: "2px" }}>
              <thead>
                <tr style={{ color: C.textFaint }}>
                  <th className={th}>SEASON</th><th className={th}>TM</th><th className={th}>GM</th><th className={th}>FPTS</th><th className={th}>HALF</th><th className={th}>PPR</th>
                  {statKeys.map((k) => <th key={k} className={th}>{k.toUpperCase()}</th>)}
                </tr>
              </thead>
              <tbody>
                {h.career.map((r) => (
                  <tr key={r.season}>
                    <td className={td}>{r.season}</td>
                    <td className={td} style={{ color: C.textMuted }}>{r.team || ""}</td>
                    <td className={td}>{r.games ?? "-"}</td>
                    <td className={td} style={{ background: C.surfaceRaised }}>{r.fpts != null ? r.fpts.toFixed(1) : "-"}</td>
                    <td className={td} style={{ color: rankColor(r.rankHalf) }}>{r.rankHalf || "-"}</td>
                    <td className={td} style={{ color: rankColor(r.rankPpr) }}>{r.rankPpr || "-"}</td>
                    {statKeys.map((k) => <td key={k} className={td}>{r.stats?.[k] ?? "-"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ color: C.textFaint }} className="text-xs">No career stats.</div>
        )}
      </CardSection>
    </>
  );
}
