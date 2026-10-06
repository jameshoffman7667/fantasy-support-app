import * as api from "../api.js";
import { ChevronRight, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Avatar, BootstrapScreen, ErrorScreen, Headshot, PrimaryButton, Select, Toggle } from "../ui/common.jsx";
import { PlayerLink } from "../ui/playerCard.jsx";
import { C } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  GAME DAY (v2.6)                                                     */
/* ------------------------------------------------------------------ */
const CAT_COLOR = { for: C.ok, balanced: C.minor, against: C.major };

const CAT_LABEL = { for: "Cheer for", balanced: "Balanced", against: "Cheer against" };

function GameDaySettings({ data, onSaved }) {
  const [s, setS] = useState(() => ({
    ratio: data.settings.ratio,
    closeWeighting: data.settings.closeWeighting,
    closeMargin: data.settings.closeMargin,
    closeFloor: data.settings.closeFloor,
    leagues: Object.fromEntries(data.leagues.map((l) => [l.id, { importance: l.importance ?? 1, include: l.include !== false }])),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = { background: C.surface, border: `1px solid ${C.border}`, color: C.text };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveGameDaySettings(s);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const setLeague = (id, patch) => setS((prev) => ({ ...prev, leagues: { ...prev.leagues, [id]: { ...prev.leagues[id], ...patch } } }));
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-3">
      <div style={{ color: C.textMuted }} className="text-xs">
        Importance weights each league (league dues, or any relative numbers). A player who counts 200 for you and 2 × 100 against you is balanced.
      </div>
      <div className="space-y-1.5">
        {data.leagues.map((l) => (
          <div key={l.id} className="flex items-center gap-2">
            <input type="checkbox" checked={s.leagues[l.id]?.include !== false} onChange={(e) => setLeague(l.id, { include: e.target.checked })} aria-label={`Include ${l.name}`} />
            <span style={{ color: C.text }} className="text-xs flex-1 truncate">{l.name}</span>
            <input
              type="number"
              min="0"
              value={s.leagues[l.id]?.importance ?? 1}
              onChange={(e) => setLeague(l.id, { importance: e.target.value })}
              style={field}
              className="w-20 rounded px-2 py-1 text-xs text-right"
              aria-label={`Importance for ${l.name}`}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]" style={{ color: C.textMuted }}>
        <label className="flex flex-col gap-0.5">
          For/against ratio (×)
          <input type="number" step="0.1" min="1" value={s.ratio} onChange={(e) => setS({ ...s, ratio: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" />
        </label>
        <label className="flex items-center gap-2 pt-4">
          <input type="checkbox" checked={s.closeWeighting} onChange={(e) => setS({ ...s, closeWeighting: e.target.checked })} />
          Close-matchup weighting
        </label>
        <label className="flex flex-col gap-0.5">
          Close margin (%)
          <input type="number" min="1" value={s.closeMargin} onChange={(e) => setS({ ...s, closeMargin: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" disabled={!s.closeWeighting} />
        </label>
        <label className="flex flex-col gap-0.5">
          Blowout minimum (0–1)
          <input type="number" step="0.05" min="0" max="1" value={s.closeFloor} onChange={(e) => setS({ ...s, closeFloor: e.target.value })} style={field} className="rounded px-2 py-1 text-xs" disabled={!s.closeWeighting} />
        </label>
      </div>
      <div style={{ color: C.textFaint }} className="text-[11px]">
        "For" when a player's for-weight is at least {s.ratio}× his against-weight; "against" the other way round; otherwise balanced. With close-matchup weighting, a league within the close margin counts fully and a blowout drops toward the minimum.
      </div>
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      <PrimaryButton onClick={save} loading={busy}>{busy ? "Saving…" : "Save settings"}</PrimaryButton>
    </div>
  );
}

function CheerRow({ p, ratio }) {
  const color = CAT_COLOR[p.category];
  const x = Math.min(94, Math.max(6, (1 - p.lean) * 100));
  const forEdge = (1 / (Number(ratio) + 1)) * 100; // lean ≥ ratio/(ratio+1) => x ≤ 1/(ratio+1)
  const live = p.state === "in";
  return (
    <div className="py-2" style={{ borderTop: `1px solid ${C.border}` }}>
      <div className="relative h-7 rounded" style={{ background: C.surface }}>
        <div className="absolute inset-y-0 left-0 rounded-l" style={{ width: `${forEdge}%`, background: C.okBg }} />
        <div className="absolute inset-y-0 right-0 rounded-r" style={{ width: `${forEdge}%`, background: C.majorBg }} />
        <div className="absolute inset-y-0" style={{ left: "50%", width: 1, background: C.border }} />
        <PlayerLink
          player={p}
          leagueId={(p.leagues.find((l) => l.side === "for") || p.leagues[0])?.leagueId}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
          style={{ left: `${x}%`, background: C.bg, border: `1px solid ${color}`, color: C.text, fontWeight: p.stake >= 2 ? 600 : 400, opacity: 0.55 + Math.min(0.45, p.stake / 10) }}
          title={`For ${p.F} · Against ${p.A}`}
        >
          {p.name}
        </PlayerLink>
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-1 px-0.5">
        <PlayerLink player={p} leagueId={(p.leagues.find((l) => l.side === "for") || p.leagues[0])?.leagueId} className="shrink-0 rounded-full">
          <Headshot player={p} size={20} />
        </PlayerLink>
        <span style={{ color: C.textFaint }} className="text-[10px]">{p.pos}{p.team ? ` · ${p.team}` : ""}{p.opponent ? ` vs ${p.opponent}` : ""}</span>
        <span style={{ color: live ? C.brand : C.textFaint }} className="text-[10px]">{p.statusDetail || p.kickoffLabel || ""}</span>
        <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }} className="text-[11px] font-medium">
          {p.points != null ? `${p.points.toFixed(1)} pts` : p.proj != null ? `proj ${p.proj.toFixed(1)}` : ""}
        </span>
      </div>
      {/* v2.9: leagues you cheer FOR sit on the left, leagues you cheer AGAINST on the right. */}
      {p.leagues.length > 0 && (
        <div className="flex items-start justify-between gap-2 mt-1 px-0.5">
          <div className="flex flex-wrap gap-1" data-chips="for">
            {p.leagues.filter((l) => l.side === "for").map((l, i) => (
              <span key={i} style={{ color: C.ok, border: `1px solid ${C.ok}55` }} className="text-[10px] rounded px-1.5 py-0.5">+ {l.league} ({l.weight})</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 justify-end" data-chips="against">
            {p.leagues.filter((l) => l.side !== "for").map((l, i) => (
              <span key={i} style={{ color: C.major, border: `1px solid ${C.major}55` }} className="text-[10px] rounded px-1.5 py-0.5">− {l.league} ({l.weight})</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// v3.5: Game Day league card colours. `color` comes from the server: green when your expected final leads by at
// least 5% of the points both teams still have to score, red when it trails by that much, yellow in between.
const OUTLOOK = { green: C.ok, red: C.major, yellow: C.minor };

function GameDayLeagueCard({ l, selected, onToggle }) {
  const title = OUTLOOK[l.color] || C.text;
  const myColor = l.color === "green" ? C.ok : l.color === "red" ? C.major : C.minor;
  const oppColor = l.color === "green" ? C.major : l.color === "red" ? C.ok : C.minor;
  const f1 = (x) => (x == null ? "—" : Number(x).toFixed(1));
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      data-gd-league={l.id}
      data-gd-color={l.color || ""}
      style={{ background: selected ? C.surfaceRaised : C.surface, border: `1px solid ${selected ? C.brand : C.border}`, opacity: l.include === false ? 0.5 : 1 }}
      className="rounded-md px-2.5 py-2 w-full text-left min-w-0"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Avatar avatar={l.avatar} name={l.name} size={18} square />
        <span style={{ color: l.note ? C.text : title }} className="text-xs font-semibold truncate" data-gd-title>{l.name}</span>
      </div>
      {l.note ? (
        <div style={{ color: C.textFaint }} className="text-[11px] mt-0.5">{l.note}</div>
      ) : (
        <>
          <div style={{ fontVariantNumeric: "tabular-nums" }} className="text-[12px] mt-1 whitespace-nowrap" data-gd-score>
            <span style={{ color: myColor }} className="font-semibold">{f1(l.myPoints)}</span>{" "}
            <span style={{ color: l.myBelowBaseline ? C.major : C.textMuted }} data-gd-myproj>({f1(l.myProjected)})</span>
            <span style={{ color: C.textFaint }}> – </span>
            <span style={{ color: oppColor }} className="font-semibold">{f1(l.oppPoints)}</span>{" "}
            <span style={{ color: l.oppBelowBaseline ? C.major : C.textMuted }} data-gd-oppproj>({f1(l.oppProjected)})</span>
          </div>
          {l.winProb != null && <div style={{ color: C.textFaint }} className="text-[10px] mt-0.5">Win {Math.round(l.winProb * 100)}%{l.importance && l.importance !== 1 ? ` · ×${l.importance}` : ""}</div>}
        </>
      )}
    </button>
  );
}

/** time slot → game → team groups, earliest slot first. */
function groupGameDay(list) {
  const slots = [];
  [...list]
    .sort((a, b) => (a.kickoff ?? Infinity) - (b.kickoff ?? Infinity))
    .forEach((p) => {
      const label = p.kickoffLabel || "Time TBD";
      let slot = slots.find((x) => x.label === label);
      if (!slot) slots.push((slot = { label, kickoff: p.kickoff ?? null, games: [] }));
      const gk = p.gameKey || `${p.team || "?"}`;
      let game = slot.games.find((g) => g.key === gk);
      if (!game) slot.games.push((game = { key: gk, label: p.gameKey ? p.gameKey.replace("@", " @ ") : p.team || "?", statusDetail: p.statusDetail || null, state: p.state || null, teams: [] }));
      let team = game.teams.find((t) => t.team === p.team);
      if (!team) game.teams.push((team = { team: p.team, players: [] }));
      team.players.push(p);
    });
  return slots;
}

function GameDayGroups({ slots, ratio, collapsed, toggle, prefix = "" }) {
  return slots.map((g) => {
    const id = `${prefix}${g.label}`;
    const isOpen = !collapsed.has(id);
    const count = g.games.reduce((n, gm) => n + gm.teams.reduce((m, t) => m + t.players.length, 0), 0);
    return (
      <div key={id} data-slot-group={g.label}>
        <button type="button" onClick={() => toggle(id)} className="w-full flex items-center justify-between pt-3 pb-1" style={{ borderBottom: `1px solid ${C.border}` }} aria-expanded={isOpen} data-slot-toggle={g.label}>
          <span style={{ color: C.textFaint, fontFamily: "Oswald, sans-serif" }} className="text-[11px] tracking-wide flex items-center gap-1">
            <ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : "none" }} />
            {g.label}
          </span>
          <span style={{ color: C.textFaint }} className="text-[10px]">{count} player{count === 1 ? "" : "s"}</span>
        </button>
        {isOpen &&
          g.games.map((gm) => (
            <div key={gm.key} className="pl-1" data-game-group={gm.key}>
              <div className="flex items-center justify-between pt-2" style={{ color: C.textMuted }}>
                <span className="text-[11px] font-semibold">{gm.label}</span>
                {gm.statusDetail && <span style={{ color: gm.state === "in" ? C.brand : C.textFaint }} className="text-[10px]">{gm.statusDetail}</span>}
              </div>
              {gm.teams.map((t) => (
                <div key={t.team || "?"} className="pl-1" data-team-group={t.team}>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide pt-1">{t.team}</div>
                  {t.players.map((p) => <CheerRow key={p.id} p={p} ratio={ratio} />)}
                </div>
              ))}
            </div>
          ))}
      </div>
    );
  });
}

export function GameDayScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [slot, setSlot] = useState("all");
  const [cat, setCat] = useState("all");
  // v2.9: tap league cards to show only those leagues' starters (yours + your opponents'); none selected = all.
  const [leagueSel, setLeagueSel] = useState(() => new Set());
  // v3.5: collapsible time slots; the Complete section starts collapsed.
  const [collapsed, setCollapsed] = useState(() => new Set(["__complete"]));
  const toggleCollapsed = (id) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleLeague = (id) =>
    setLeagueSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const load = useCallback(() => {
    api
      .getGameDay()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60 * 1000); // live points during games (Sleeper + ESPN, no Tank01 calls)
    return () => clearInterval(id);
  }, [load]);

  if (error && !data) return <div className="px-4 py-6"><ErrorScreen message={error} /></div>;
  if (!data) return <BootstrapScreen />;
  const slots = [...new Set(data.players.map((p) => p.kickoffLabel).filter(Boolean))];
  const inLeagues = (p) => leagueSel.size === 0 || p.leagues.some((l) => leagueSel.has(l.leagueId));
  const shown = data.players.filter((p) => inLeagues(p) && (slot === "all" || p.kickoffLabel === slot) && (cat === "all" || p.category === cat));
  const counts = { for: 0, balanced: 0, against: 0 };
  data.players.filter(inLeagues).forEach((p) => counts[p.category]++);
  const complete = shown.filter((p) => p.state === "post");
  const upcoming = shown.filter((p) => p.state !== "post");
  const completeOpen = !collapsed.has("__complete");

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div style={{ color: C.textMuted }} className="text-xs">Week {data.week} · updated {new Date(data.updatedAt).toLocaleTimeString()}</div>
        <button onClick={() => setShowSettings((v) => !v)} style={{ color: C.brand }} className="text-xs font-medium flex items-center gap-1">
          <Settings2 size={13} /> {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>
      {showSettings && (
        <GameDaySettings
          data={data}
          onSaved={() => {
            setShowSettings(false);
            load();
          }}
        />
      )}
      <div className="grid grid-cols-2 gap-1.5" data-gd-cards>
        {data.leagues.map((l) => (
          <GameDayLeagueCard key={l.id} l={l} selected={leagueSel.has(l.id)} onToggle={() => toggleLeague(l.id)} />
        ))}
      </div>
      <div style={{ color: C.textFaint }} className="text-[10px] px-0.5">
        Your score (expected final) – opponent's. Green: you lead by at least 5% of the points both teams still have to score; red: you trail by that much. A projection in red has dropped since the week's first kickoff.
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Select label="Game slot" value={slot} onChange={setSlot} options={[{ value: "all", label: "All games" }, ...slots.map((s) => ({ value: s, label: s }))]} />
        <div className="flex gap-1.5 pt-3.5">
          {["all", "for", "balanced", "against"].map((c) => (
            <Toggle key={c} checked={cat === c} onChange={() => setCat(c)}>
              {c === "all" ? `All ${data.players.length}` : `${CAT_LABEL[c]} ${counts[c]}`}
            </Toggle>
          ))}
        </div>
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-wide px-1" style={{ color: C.textFaint }}>
        <span style={{ color: C.ok }}>← Cheer for</span>
        <span>Balanced</span>
        <span style={{ color: C.major }}>Cheer against →</span>
      </div>
      {shown.length === 0 ? (
        <div style={{ color: C.textMuted }} className="text-sm px-1 py-2">No players for these filters.</div>
      ) : (
        <div>
          {complete.length > 0 && (
            <div className="mb-2 rounded-md px-2" style={{ background: C.surface, border: `1px solid ${C.border}` }} data-complete-section>
              <button type="button" onClick={() => toggleCollapsed("__complete")} className="w-full flex items-center justify-between py-2" aria-expanded={completeOpen} data-complete-toggle>
                <span style={{ color: C.textMuted, fontFamily: "Oswald, sans-serif" }} className="text-xs tracking-wide flex items-center gap-1">
                  <ChevronRight size={12} style={{ transform: completeOpen ? "rotate(90deg)" : "none" }} />
                  Complete
                </span>
                <span style={{ color: C.textFaint }} className="text-[10px]">{complete.length} player{complete.length === 1 ? "" : "s"}</span>
              </button>
              {completeOpen && <div className="pb-2"><GameDayGroups slots={groupGameDay(complete)} ratio={data.settings.ratio} collapsed={collapsed} toggle={toggleCollapsed} prefix="done:" /></div>}
            </div>
          )}
          <GameDayGroups slots={groupGameDay(upcoming)} ratio={data.settings.ratio} collapsed={collapsed} toggle={toggleCollapsed} />
        </div>
      )}
    </div>
  );
}
