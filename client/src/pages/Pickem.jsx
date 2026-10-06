import * as api from "../api.js";
import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BootstrapScreen, ConfirmPush, ErrorScreen, RedDot, TeamLogo, WeatherChip } from "../ui/common.jsx";
import { C, TEAM_COLORS, pct } from "../ui/theme.js";

function hexDist(a, b) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
}

function luminance(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function barColors(away, home) {
  const a = TEAM_COLORS[away] || ["#5E7570", "#8FA39E"];
  const h = TEAM_COLORS[home] || ["#4A8FC2", "#8FA39E"];
  // A near-black main colour disappears on the dark card, so use the alternate.
  let ac = luminance(a[0]) < 0.08 ? a[1] : a[0];
  let hc = luminance(h[0]) < 0.08 ? h[1] : h[0];
  if (hexDist(ac, hc) < 90) hc = h[1]; // too similar — home switches to its alternate colour
  if (hexDist(ac, hc) < 90) ac = a[1];
  return { away: ac, home: hc };
}

// v3.6 card (James's design): big logos at both ends of the win bar — tap one to pick it. Picks are shown by the
// logo box OUTLINE only: the app's pick dashed and semi-transparent, yours solid; green = favourite, yellow =
// underdog. "JAX (Away)" above each logo, "Favourite (-2.5)" below; weather above the bar, game status below the
// card. After the game: ✓ on the winner's box, ✗ on the loser's outside corner. The card's own border shows how
// the pick that counts (yours, else the app's) is doing: green leading/won, red trailing/lost, grey level.
function PickCard({ g, onSeen, onChoose }) {
  const colors = barColors(g.away, g.home);
  const awayP = g.homeProb == null ? 0.5 : 1 - g.homeProb;
  const textOn = (hex) => (luminance(hex) > 0.6 ? "#10171A" : "#FFFFFF");
  const live = g.state === "in";
  const final = g.state === "post";
  const canPick = Boolean(onChoose) && g.state === "pre" && !g.started;
  const counts = g.final || g.pick || null; // the pick that counts
  const colorOf = (team) => (team && team === g.underdog ? C.minor : C.ok);
  const scoreOf = (team) => (team === g.home ? g.homeScore : team === g.away ? g.awayScore : null);
  const winner = final && g.homeScore != null && g.awayScore != null && g.homeScore !== g.awayScore ? (g.homeScore > g.awayScore ? g.home : g.away) : null;
  let cardBorder = g.changed ? C.major : C.border;
  let cardState = "pre";
  if ((live || final) && counts && g.homeScore != null && g.awayScore != null) {
    const mine = scoreOf(counts);
    const theirs = counts === g.home ? g.awayScore : g.homeScore;
    cardState = mine > theirs ? "ahead" : mine < theirs ? "behind" : "level";
    cardBorder = cardState === "ahead" ? C.ok : cardState === "behind" ? C.major : C.textFaint;
  }
  const spreadOf = (team) => {
    if (g.homeSpread == null) return null;
    const v = Math.round((team === g.home ? g.homeSpread : -g.homeSpread) * 2) / 2;
    return v === 0 ? "PK" : `${v > 0 ? "+" : ""}${v}`;
  };
  const side = (team, homeAway, align) => {
    const mine = g.chosen === team;
    const app = g.pick === team;
    const col = colorOf(team);
    // yours solid; the app's dashed + semi-transparent (only drawn where yours isn't)
    const outline = mine ? `2px solid ${col}` : app ? `2px dashed ${col}99` : `2px solid transparent`;
    const kind = !g.favorite ? null : team === g.favorite ? "Favourite" : "Underdog";
    const sp = spreadOf(team);
    const lost = winner && winner !== team;
    return (
      <div className={`flex flex-col items-center gap-1 shrink-0 w-[4.75rem] ${align}`}>
        <div style={{ color: C.textMuted }} className="text-[10px] font-semibold whitespace-nowrap" data-pick-side={team}>{team} ({homeAway})</div>
        <button
          type="button"
          disabled={!canPick}
          onClick={(e) => {
            e.stopPropagation();
            if (canPick) onChoose(g.key, g.chosen === team ? null : team);
          }}
          style={{ border: outline, background: C.surfaceRaised, cursor: canPick ? "pointer" : "default" }}
          className="relative w-16 h-16 rounded-lg flex items-center justify-center"
          aria-label={canPick ? `Pick ${team}${mine ? " (your pick — tap to go back to the app's pick)" : ""}` : `${team}${mine ? ", your pick" : app ? ", app pick" : ""}`}
          aria-pressed={mine}
          data-pick-logo={team}
          data-pick-outline={mine ? "mine" : app ? "app" : "none"}
          data-pick-kind={mine || app ? (team === g.underdog ? "underdog" : "favourite") : undefined}
        >
          <TeamLogo team={team} size={46} />
          {winner === team && (
            <span style={{ background: C.ok, color: "#10171A" }} className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-bold" data-pick-won aria-label="won">✓</span>
          )}
          {lost && (
            <span style={{ background: C.major, color: "#fff" }} className={`absolute -top-2 ${align === "items-start" ? "-left-2" : "-right-2"} w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold`} data-pick-lost aria-label="lost">✕</span>
          )}
        </button>
        <div style={{ color: kind === "Underdog" ? C.minor : kind ? C.ok : C.textFaint }} className="text-[10px] whitespace-nowrap" data-pick-label={kind || "none"}>
          {kind ? `${kind}${sp ? ` (${sp})` : ""}` : "No line"}
        </div>
      </div>
    );
  };
  const w = g.weather && !g.weather.indoor && g.weather.temp != null ? g.weather : null;
  return (
    <div>
      <div
        onClick={() => g.changed && onSeen(g.key)}
        style={{ background: C.surface, border: `2px solid ${cardBorder}` }}
        className="rounded-lg px-3 pt-3 pb-2.5 space-y-2"
        data-pick-card={g.key}
        data-pick-state={cardState}
      >
        {g.changed && (
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: C.major }}>
            <RedDot title="Recommendation changed" /> App pick changed{g.prevPick ? ` from ${g.prevPick}` : ""} — tap to dismiss
          </div>
        )}
        {w && (
          <div className="flex flex-col items-center gap-0.5" data-pick-weather={w.flag ? "bad" : "ok"}>
            <WeatherChip player={{ weather: w }} />
            {w.flag && <span style={{ color: C.minor }} className="text-[10px] text-center">{w.reasons.join("; ")}</span>}
          </div>
        )}
        <div className="flex items-center gap-2">
          {side(g.away, "Away", "items-start")}
          <div className="flex-1 min-w-0">
            <div className="flex h-7 rounded overflow-hidden text-[11px] font-semibold" role="img" aria-label={`Win chance: ${g.away} ${pct(awayP)}, ${g.home} ${pct(g.homeProb)}`}>
              <div style={{ width: `${awayP * 100}%`, background: colors.away, color: textOn(colors.away) }} className="flex items-center pl-1.5 min-w-[2.25rem]">{pct(awayP)}</div>
              <div style={{ width: `${(1 - awayP) * 100}%`, background: colors.home, color: textOn(colors.home) }} className="flex items-center justify-end pr-1.5 min-w-[2.25rem]">{pct(g.homeProb)}</div>
            </div>
            <div style={{ color: C.textFaint }} className="text-[9px] mt-1 text-center leading-tight">
              {g.source || "no line yet"} · FPI {g.fpiHomeProb != null ? `${g.home} ${pct(g.fpiHomeProb)}` : "—"}
            </div>
          </div>
          {side(g.home, "Home", "items-end")}
        </div>
        <div style={{ color: C.textFaint }} className="text-[10px] text-center" data-pick-legend>
          {g.chosen
            ? g.pick && g.pick !== g.chosen
              ? `Your pick ${g.chosen} (solid) · app pick ${g.pick} (dashed)`
              : `Your pick ${g.chosen} — same as the app`
            : g.pick
            ? `App pick ${g.pick} (dashed)${canPick ? " — tap a logo to make your own pick" : ""}`
            : "No pick yet"}
        </div>
        {g.reason && g.upset && <div style={{ color: C.textMuted }} className="text-[11px]">{g.reason}</div>}
        {g.underdog && (
          <div>
            <div className="flex justify-between text-[10px]" style={{ color: C.textMuted }}>
              <span>Upset potential ({g.underdog})</span>
              <span title={`odds ${g.upsetParts?.base} · line move ${g.upsetParts?.shift} · articles ${g.upsetParts?.gemini}`}>{g.upsetPotential}/100</span>
            </div>
            <div className="h-1.5 rounded mt-0.5" style={{ background: C.surfaceRaised }}>
              <div className="h-1.5 rounded" style={{ width: `${g.upsetPotential}%`, background: g.upsetPotential >= 60 ? C.major : g.upsetPotential >= 35 ? C.minor : C.textFaint }} />
            </div>
            <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">
              {Math.abs(g.dogShift) >= 0.005
                ? `Line moved ${g.dogShift > 0 ? "toward" : "away from"} ${g.underdog} by ${Math.abs(Math.round(g.dogShift * 100))}% since ${g.openedAt ? new Date(g.openedAt).toLocaleDateString([], { weekday: "short" }) : "the first snapshot"}`
                : "No line movement yet"}
              {g.gemini ? ` · ${g.gemini.upsetMentions} article(s) picking the upset` : ""}
            </div>
          </div>
        )}
        {g.gemini?.note && (
          <div style={{ color: C.textMuted }} className="text-[11px]">
            {g.gemini.note}
            {g.gemini.sources?.length > 0 && <span style={{ color: C.textFaint }}> — {g.gemini.sources.join(", ")}</span>}
          </div>
        )}
      </div>
      <div style={{ color: live ? C.brand : final ? C.textMuted : C.textFaint }} className="text-[11px] text-center mt-1" data-pick-status>
        {live || final ? `${g.away} ${g.awayScore ?? 0} – ${g.homeScore ?? 0} ${g.home} · ${final ? "Final" : g.statusDetail || "Live"}` : g.kickoffLabel}
      </div>
    </div>
  );
}

function CbsPushBar({ week, st, reload }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!st || !st.configured || !st.recipeReady || !(st.pools || []).length) return null;
  const run = async (dryRun) => {
    setBusy(true);
    try {
      setOut(await api.pushCbs({ dryRun }));
    } catch (e) {
      setOut({ ok: false, error: e.message });
    } finally {
      setBusy(false);
      setConfirming(false);
      reload?.();
    }
  };
  const setAuto = async (on) => {
    setBusy(true);
    try {
      await api.saveCbsSettings({ enabled: on });
    } catch (e) {
      setOut({ ok: false, error: e.message });
    } finally {
      setBusy(false);
      reload?.();
    }
  };
  const pools = (st.pools || []).filter((p) => p.enabled);
  const autoOn = st.enabled && !st.paused;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2 space-y-1.5 text-xs" data-cbs-bar>
      <div className="flex items-center justify-between gap-2">
        <div style={{ color: C.text }} className="font-medium">CBS pick'em · {autoOn ? "auto mode ON" : st.paused ? "paused" : "auto mode off — you pick"}</div>
        <label className="flex items-center gap-1.5" style={{ color: C.textMuted }}>
          Auto
          <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => setAuto(e.target.checked)} data-cbs-auto-toggle />
        </label>
      </div>
      {st.alert && <div style={{ color: C.minor }} data-cbs-alert>{st.alert.detail}</div>}
      <div style={{ color: C.textMuted }}>
        {autoOn
          ? `Your picks (the recommendation where you haven't chosen) go to CBS about 60 minutes before each kickoff slot. Choosing a pick yourself turns auto mode off; so does changing a pick on CBS.`
          : `Auto mode is off: choose your own picks below. "Push now" sends them (and the recommendation where you haven't chosen) for games that haven't started to ${st.verifiedOnce ? `${pools.length} pool${pools.length === 1 ? "" : "s"}` : "the test pool"}.`}
      </div>
      {!confirming ? (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => run(true)} style={{ color: C.text, border: `1px solid ${C.border}` }} className="rounded px-2.5 py-1" data-cbs-dry>Preview (reads CBS, sends nothing)</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} style={{ background: C.brand, color: "#fff" }} className="rounded px-2.5 py-1 font-medium" data-cbs-push>Push now…</button>
        </div>
      ) : (
        <ConfirmPush title="Push picks to CBS?" lines={[`Week ${week}: every unstarted game with a pick (only picks that differ from CBS are sent)`, `${st.verifiedOnce ? pools.map((p) => p.name).join(", ") : (pools.find((p) => p.id === st.testPoolId) || pools[0])?.name + " (test pool)"}`]} buttonLabel="Send to CBS" busy={busy} onConfirm={() => run(false)} onCancel={() => setConfirming(false)} />
      )}
      {out && (
        <div style={{ color: out.ok ? C.ok : C.major }} data-cbs-result>
          {out.error ? out.error : out.dryRun ? (out.native ? out.pools.map((q) => `${q.name}: ${q.toSave.length} pick(s) would change on CBS (${q.unchanged} already match${q.unmatched?.length ? `, not found on CBS: ${q.unmatched.join(", ")}` : ""}${q.tiebreaker != null ? `, tiebreaker ${q.tiebreaker}` : ""}); nothing was sent.`).join(" | ") : `Preview: ${out.games.length} game(s) would be sent to ${out.requests.length} pool(s); nothing was sent.`) : out.nothing ? out.detail : (out.results || []).map((r) => `${r.pool}: ${r.ok ? "ok" : "FAILED"} — ${r.detail}`).join(" | ")}
        </div>
      )}
    </div>
  );
}

/* v3.4: You vs the app vs Vegas vs actual results, by week and for the season. */
const fmtRecN = (t) => (t && t.n ? `${t.correct}/${t.n}` : "—");

const fmtRecPct = (t) => (t && t.n ? `${Math.round((t.correct / t.n) * 100)}%` : "");

function PickemPerformance({ onClose }) {
  const [perf, setPerf] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [inclRecon, setInclRecon] = useState(true);
  const load = useCallback(() => {
    api.getPickemPerformance().then((d) => { setPerf(d); setError(null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const setMine = async (week, gameKey, pick) => {
    await api.savePickemChoice({ season: perf.season, week, gameKey, pick });
    load();
  };
  if (error && !perf) return <ErrorScreen message={error} />;
  if (!perf) return <div style={{ color: C.textMuted }} className="text-xs py-6 text-center">Loading results…</div>;
  // optionally leave out weeks whose app picks were only reconstructed
  const weeks = perf.weeks;
  const t = { vegas: { n: 0, correct: 0 }, app: { n: 0, correct: 0 }, mine: { n: 0, correct: 0 }, appUpsets: { n: 0, correct: 0 }, same: { n: 0, mine: 0, app: 0, vegas: 0 } };
  for (const w of weeks) {
    if (!inclRecon && w.appSource === "reconstructed") continue;
    for (const k of ["vegas", "app", "mine", "appUpsets"]) { t[k].n += w[k].n; t[k].correct += w[k].correct; }
    for (const k of ["n", "mine", "app", "vegas"]) t.same[k] += w.same[k];
  }
  const Cell = ({ label, rec }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
      <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">{label}</div>
      <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-semibold">{fmtRecN(rec)} <span style={{ color: C.textFaint }} className="text-[11px] font-normal">{fmtRecPct(rec)}</span></div>
    </div>
  );
  return (
    <div className="space-y-3" data-pick-performance>
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Vegas (favourites)" rec={t.vegas} />
        <Cell label="App picks" rec={t.app} />
        <Cell label="Your picks" rec={t.mine} />
        <Cell label="App upset picks" rec={t.appUpsets} />
      </div>
      {t.same.n > 0 && (
        <div style={{ color: C.textMuted }} className="text-[11px]">
          On the {t.same.n} finished games you picked: you {t.same.mine}, app {t.same.app}, Vegas {t.same.vegas} correct.
        </div>
      )}
      <label className="flex items-center gap-1.5 text-[11px]" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={inclRecon} onChange={(e) => setInclRecon(e.target.checked)} data-pick-recon-toggle />
        Include weeks where the app's picks were reconstructed from ESPN odds
      </label>
      {weeks.length === 0 && <div style={{ color: C.textFaint }} className="text-xs">No finished games recorded yet.</div>}
      <div className="space-y-1.5">
        {weeks.map((w) => (
          <div key={w.week} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md" data-pick-week={w.week}>
            <button type="button" onClick={() => setOpen(open === w.week ? null : w.week)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs">
              <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }}>Week {w.week}</span>
              <span style={{ color: C.textMuted, fontVariantNumeric: "tabular-nums" }} className="flex gap-3">
                <span>Vegas {fmtRecN(w.vegas)}</span>
                <span>App {fmtRecN(w.app)}{w.appSource === "reconstructed" ? "~" : ""}</span>
                <span>You {fmtRecN(w.mine)}</span>
              </span>
            </button>
            {open === w.week && (
              <div className="px-3 pb-2 space-y-1">
                {w.appSource !== "stored" && <div style={{ color: C.textFaint }} className="text-[10px]">~ = app picks reconstructed from ESPN odds only; the real board would also use line movement and articles.</div>}
                {w.games.map((g) => (
                  <div key={g.key} className="flex items-center justify-between gap-2 text-[11px]" style={{ color: C.textMuted }} data-pick-perf-game={g.key}>
                    <span style={{ color: C.text }} className="w-20 shrink-0">{g.away} @ {g.home}</span>
                    <span className="w-14 shrink-0">won {g.winner}</span>
                    <span style={{ color: g.vegas === g.winner ? C.ok : C.textMuted }} className="w-14 shrink-0">V {g.vegas || "—"}</span>
                    <span style={{ color: g.app === g.winner ? C.ok : g.appUpset ? C.minor : C.textMuted }} className="w-16 shrink-0">A {g.app || "—"}{g.appUpset ? "↑" : ""}</span>
                    <select
                      value={g.mine || ""}
                      onChange={(e) => setMine(w.week, g.key, e.target.value || null)}
                      style={{ background: C.bg, border: `1px solid ${C.border}`, color: g.mine === g.winner ? C.ok : C.text }}
                      className="rounded px-1 py-0.5 text-[11px]"
                      aria-label={`Your pick ${g.key} week ${w.week}`}
                    >
                      <option value="">You —</option>
                      <option value={g.away}>You {g.away}</option>
                      <option value={g.home}>You {g.home}</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px]">
        V = favourite on the last stored line before kickoff (ESPN's listed odds where no line was stored). A = the app's pick, ↑ = underdog/upset pick. "You" = picks entered in the app; use the drop-down on a finished game to load an earlier pick by hand. Ties are left out.
      </div>
    </div>
  );
}

export function PickemScreen({ onChangedCount }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [cbsSt, setCbsSt] = useState(null);
  const [view, setView] = useState("games"); // v3.4: "games" | "performance"
  const [pendingChoice, setPendingChoice] = useState(null); // v3.3: a manual pick made while CBS auto mode is on
  const loadCbs = useCallback(() => api.getCbsStatus().then(setCbsSt).catch(() => {}), []);
  useEffect(() => {
    loadCbs();
  }, [loadCbs]);
  const load = useCallback(() => {
    api.getPickem().then((d) => {
      setData(d);
      setError(null);
      onChangedCount?.(d.changedCount);
    }).catch((err) => setError(err.message));
  }, [onChangedCount]);
  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);
  const saveSettings = async (patch) => {
    await api.savePickemSettings({ ...data.settings, ...patch });
    load();
  };
  const seen = async (gameKey) => {
    await api.markPickemSeen(data.season, data.week, gameKey);
    load();
  };
  const applyChoice = async (gameKey, pick) => {
    await api.savePickemChoice({ season: data.season, week: data.week, gameKey, pick });
    load();
  };
  const choose = async (gameKey, pick) => {
    // Making a manual pick while auto mode is on needs confirmation, and turns auto mode off.
    if (cbsSt?.configured && cbsSt.enabled && !cbsSt.paused) return setPendingChoice({ gameKey, pick });
    return applyChoice(gameKey, pick);
  };
  const confirmChoice = async () => {
    const pc = pendingChoice;
    setPendingChoice(null);
    await api.saveCbsSettings({ enabled: false }).catch(() => {});
    await applyChoice(pc.gameKey, pc.pick);
    loadCbs();
  };
  const setTiebreaker = async (v) => {
    await api.savePickemChoice({ season: data.season, week: data.week, tiebreaker: v });
    load();
  };
  if (error && !data) return <div className="px-4 py-6"><ErrorScreen message={error} /></div>;
  if (!data) return <BootstrapScreen />;
  const s = data.settings;
  const r = data.record;
  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div style={{ color: C.textMuted }} className="text-xs flex items-center gap-2">
          Week {data.week} · straight-up
          {data.changedCount > 0 && (
            <button onClick={() => seen(null)} className="flex items-center gap-1" style={{ color: C.major }}>
              <RedDot title="Changed picks" /> {data.changedCount} changed — dismiss all
            </button>
          )}
        </div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          <Settings2 size={13} /> {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>
      <div className="flex gap-1.5 text-xs" data-pick-views>
        {[["games", "This week"], ["performance", "Performance"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)} style={{ background: view === k ? C.brand : "transparent", color: view === k ? "#fff" : C.textMuted, border: `1px solid ${C.border}` }} className="rounded-full px-3 py-1 font-medium" data-pick-view={k}>{label}</button>
        ))}
      </div>
      {view === "performance" && <PickemPerformance />}
      {view === "games" && showSettings && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2 text-xs" >
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.upsets !== false} onChange={(e) => saveSettings({ upsets: e.target.checked })} data-pick-upsets-toggle />
            Upset picks (app picks differ from Vegas)
          </label>
          <div className="grid grid-cols-2 gap-2" style={{ color: C.textMuted }}>
            <label className="flex flex-col gap-0.5">Extra upsets need upset potential of at least
              <input type="number" min="20" max="90" defaultValue={s.upsetThreshold ?? 45} onBlur={(e) => saveSettings({ upsetThreshold: e.target.value })} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-1" />
            </label>
          </div>
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={s.notify} onChange={(e) => saveSettings({ notify: e.target.checked })} />
            Push alert when a recommendation changes before kickoff
          </label>
          <div style={{ color: C.textFaint }} className="text-[11px]">
            The app picks the favourite in every game except the upset picks: always the single game with the highest upset potential, plus up to 3 more at or above the threshold (4 at most). Started games keep the pick made before kickoff. Logo outlines: dashed = the app's pick, solid = yours; green = favourite, yellow = underdog. Tap a logo to pick that team (tap it again to go back to the app's pick).
          </div>
        </div>
      )}
      {view === "games" && (
      <>
      <div className="grid grid-cols-2 gap-2">
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Season record</div>
          <div style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-sm font-semibold">{r.correct}/{r.games} <span style={{ color: C.textFaint }} className="text-[11px] font-normal">favourites {r.favoritesCorrect}/{r.games}</span></div>
          <div style={{ color: C.textFaint }} className="text-[10px]">This week {r.weekCorrect}/{r.weekGames}</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2">
          <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide">Tiebreaker</div>
          {data.tiebreaker ? (
            <>
              <div style={{ color: C.text }} className="text-sm font-semibold">{data.tiebreaker.total} total pts</div>
              <div style={{ color: C.textFaint }} className="text-[10px]">{data.tiebreaker.game} · Vegas over/under</div>
            </>
          ) : (
            <div style={{ color: C.textFaint }} className="text-xs">No total posted yet</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: C.textMuted }}>
        <label className="flex items-center gap-1.5">Your tiebreaker total
          <input type="number" min="0" max="200" defaultValue={data.choices?.tiebreaker ?? ""} placeholder={data.tiebreaker ? String(data.tiebreaker.total) : ""} onBlur={(e) => setTiebreaker(e.target.value)} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} className="rounded px-2 py-0.5 w-16" data-pick-tiebreaker />
        </label>
      </div>
      {pendingChoice && (
        <ConfirmPush
          title="Turn off CBS auto mode?"
          lines={["Choosing a pick yourself switches auto mode off.", "Nothing will be sent to CBS automatically until you turn it back on (or press Push now)."]}
          buttonLabel="Turn off and use my pick"
          onConfirm={confirmChoice}
          onCancel={() => setPendingChoice(null)}
        />
      )}
      <CbsPushBar week={data.week} st={cbsSt} reload={loadCbs} />
      <div style={{ color: C.textFaint }} className="text-[10px] px-1">
        {data.gemini.configured ? (data.gemini.at ? `Article scan (Gemini) ${new Date(data.gemini.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Article scan pending") : "Article scan off — set GEMINI_API_KEY to add upset mentions and game notes"}
      </div>
      <div className="space-y-2.5">
        {data.games.map((g) => (
          <PickCard key={g.key} g={g} onSeen={seen} onChoose={choose} />
        ))}
      </div>
      </>
      )}
    </div>
  );
}
