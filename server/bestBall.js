import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import * as gemini from "./gemini.js";

/**
 * v3.8 — Commish → Best Ball: leaderboards for best ball leagues.
 *
 * Default stat: Max Points For — Sleeper's own "potential points" (roster settings ppts), which in a best ball
 * league is the season total of the best possible lineup each week. When the commissioner's rules need more than
 * that — a "hero" player whose points are multiplied, only some weeks counting — every week is recomputed from
 * Sleeper's matchups (each roster's players and their points): the hero's points are multiplied, then the best
 * lineup for the league's starting slots is found exactly (an assignment solve), and the weeks are summed.
 * Leaderboards can combine several of the user's best ball leagues. The evidence behind every total (week, team,
 * slot, player, points, multiplier, counted) can be exported as CSV.
 *
 * Rules can be typed in plain words; Gemini turns them into the fields below (the commissioner reviews them).
 * Settings per user and league in app_state: { metric, combineWith, heroMultiplier, heroes, weeksFrom, weeksTo,
 * entryFee, payouts, prompt, notes }.
 */

const KEY = (u, l) => `bestball:${u}:${l}`;
const ELIG = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  DL: ["DL"], LB: ["LB"], DB: ["DB"], IDP_FLEX: ["DL", "LB", "DB"],
};
const NOT_STARTING = new Set(["BN", "IR", "TAXI"]);

export function defaultSettings() {
  return { metric: "maxPF", combineWith: [], heroMultiplier: null, heroes: {}, weeksFrom: null, weeksTo: null, entryFee: null, payouts: [], prompt: "", notes: null, updatedAt: null };
}
export function getSettings(username, leagueId) {
  return { ...defaultSettings(), ...(store.getState(KEY(username, leagueId), null) || {}) };
}
const num = (x, lo = -Infinity, hi = Infinity) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Math.min(hi, Math.max(lo, Number(x))));
export function saveSettings(username, leagueId, patch = {}) {
  const cur = getSettings(username, leagueId);
  const next = { ...cur };
  if (patch.metric) next.metric = patch.metric === "PF" ? "PF" : "maxPF";
  if (Array.isArray(patch.combineWith)) next.combineWith = [...new Set(patch.combineWith.map(String).filter((id) => id !== String(leagueId)))].slice(0, 5);
  if ("heroMultiplier" in patch) next.heroMultiplier = num(patch.heroMultiplier, 1, 10);
  if (patch.heroes && typeof patch.heroes === "object") next.heroes = Object.fromEntries(Object.entries(patch.heroes).filter(([k, v]) => /^[A-Za-z0-9_-]+:\d+$/.test(k) && v).map(([k, v]) => [k, String(v).slice(0, 20)]).slice(0, 64));
  if ("weeksFrom" in patch) next.weeksFrom = num(patch.weeksFrom, 1, 18);
  if ("weeksTo" in patch) next.weeksTo = num(patch.weeksTo, 1, 18);
  if ("entryFee" in patch) next.entryFee = num(patch.entryFee, 0, 100000);
  if (Array.isArray(patch.payouts)) next.payouts = patch.payouts.map((p) => ({ place: num(p?.place, 1, 50), pct: num(p?.pct, 0, 100) })).filter((p) => p.place && p.pct != null).sort((a, b) => a.place - b.place).slice(0, 10);
  if (typeof patch.prompt === "string") next.prompt = patch.prompt.slice(0, 4000);
  if ("notes" in patch) next.notes = patch.notes ? String(patch.notes).slice(0, 300) : null;
  next.updatedAt = Date.now();
  store.setState(KEY(username, leagueId), next);
  return next;
}

/* ---------------- best lineup (exact) ---------------- */
/**
 * Max-points lineup: slots (league starting positions) × players [{ id, pos: [positions], pts }]. Hungarian
 * algorithm (min cost) on slots × (players + one empty option per slot). Returns { total, lineup: [{ slot, id, pts }] }.
 */
export function bestLineup(slots, players) {
  const n = slots.length;
  if (!n) return { total: 0, lineup: [] };
  const m = players.length + n; // + an "empty" option per slot
  const INF = 1e12;
  const cost = (i, j) => {
    if (j >= players.length) return 0; // empty
    const p = players[j];
    const ok = (ELIG[slots[i]] || [slots[i]]).some((pos) => p.pos.includes(pos));
    return ok ? -Number(p.pts || 0) : INF;
  };
  // e-maxx Hungarian, 1-indexed, n rows ≤ m columns
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const lineup = new Array(n).fill(null);
  for (let j = 1; j <= m; j++) {
    if (!p[j]) continue;
    const i = p[j] - 1;
    if (j - 1 < players.length && cost(i, j - 1) < INF) lineup[i] = { slot: slots[i], id: players[j - 1].id, pts: Number(players[j - 1].pts || 0) };
    else lineup[i] = { slot: slots[i], id: null, pts: 0 };
  }
  const total = Math.round(lineup.reduce((s, x) => s + x.pts, 0) * 100) / 100;
  return { total, lineup };
}

/* ---------------- leaderboard ---------------- */
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const sleeperPts = (r, metric) => {
  const s = r.settings || {};
  return metric === "PF" ? r2((Number(s.fpts) || 0) + (Number(s.fpts_decimal) || 0) / 100) : r2((Number(s.ppts) || 0) + (Number(s.ppts_decimal) || 0) / 100);
};

/** Payout amounts for the places from the pot (entry fee × teams). */
export function payoutsFor({ entryFee, teams, payouts }) {
  const total = entryFee != null ? r2(entryFee * teams) : null;
  return { entryFee: entryFee ?? null, teams, total, places: (payouts || []).map((p) => ({ ...p, amount: total != null ? r2((total * p.pct) / 100) : null })) };
}

/**
 * The leaderboard. deps (tests): { state, getLeague, getRosters, getLeagueUsers, getMatchups(leagueId, week), players }.
 */
export async function board(username, leagueId, { evidence = false, deps = {} } = {}) {
  const s = getSettings(username, leagueId);
  const st = deps.state || (await sleeper.getState());
  const curWeek = Math.max(1, Number(st.week) || 1);
  const getLeague = deps.getLeague || ((id) => sleeper.getLeague(id));
  const getRosters = deps.getRosters || ((id) => sleeper.getRosters(id));
  const getLeagueUsers = deps.getLeagueUsers || ((id) => sleeper.getLeagueUsers(id));
  const getMatchups = deps.getMatchups || ((id, w) => sleeper.getMatchupsWeek(id, w, { settled: w < curWeek }));
  const players = deps.players || (await sleeper.getPlayers());
  const ids = [String(leagueId), ...s.combineWith.map(String)];
  const custom = Boolean(s.heroMultiplier && s.heroMultiplier !== 1) || s.weeksFrom != null || s.weeksTo != null;
  const recompute = custom || evidence;
  const from = s.weeksFrom || 1;
  const to = Math.min(s.weeksTo || 17, curWeek);
  const weeks = [];
  for (let w = from; w <= to; w++) weeks.push(w);
  const rows = [];
  const ev = [];
  const leagues = [];
  const nameOf = (id) => {
    const p = players?.[id];
    return p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() || id : /^[A-Z]{2,3}$/.test(String(id)) ? `${id} D/ST` : `Player ${id}`;
  };
  const posOf = (id) => {
    const p = players?.[id];
    if (p?.fantasy_positions?.length) return p.fantasy_positions;
    if (p?.position) return [p.position];
    return /^[A-Z]{2,3}$/.test(String(id)) ? ["DEF"] : [];
  };
  for (const id of ids) {
    const [league, rosters, users] = await Promise.all([getLeague(id), getRosters(id), getLeagueUsers(id).catch(() => [])]);
    if (!league) continue;
    leagues.push({ id, name: league.name, teams: (rosters || []).length, bestBall: Number(league.settings?.best_ball) === 1 });
    const slots = (league.roster_positions || []).filter((x) => !NOT_STARTING.has(x));
    const userById = new Map((users || []).map((u) => [String(u.user_id), u]));
    const byRoster = new Map((rosters || []).map((r) => [Number(r.roster_id), { r, total: 0, heroBonus: 0, weekly: [] }]));
    if (recompute) {
      for (const w of weeks) {
        const ms = await getMatchups(id, w).catch(() => []);
        for (const mu of ms || []) {
          const acc = byRoster.get(Number(mu.roster_id));
          if (!acc) continue;
          const heroId = s.heroes[`${id}:${mu.roster_id}`] || null;
          const mult = heroId && s.heroMultiplier ? s.heroMultiplier : 1;
          const pts = mu.players_points || {};
          const list = (mu.players || Object.keys(pts)).map((pid) => {
            const raw = Number(pts[pid]) || 0;
            const k = String(pid) === String(heroId) ? mult : 1;
            return { id: String(pid), pos: posOf(pid), raw, mult: k, pts: r2(raw * k) };
          });
          const best = bestLineup(slots, list);
          const heroPlayed = best.lineup.find((x) => x.id && x.id === String(heroId));
          const bonus = heroPlayed && mult !== 1 ? r2(heroPlayed.pts - heroPlayed.pts / mult) : 0;
          acc.total = r2(acc.total + best.total);
          acc.heroBonus = r2(acc.heroBonus + bonus);
          acc.weekly.push({ week: w, pts: best.total });
          if (evidence) {
            const u = userById.get(String(acc.r.owner_id));
            for (const x of best.lineup) {
              const pl = list.find((y) => y.id === x.id);
              ev.push({ league: league.name, week: w, team: u?.metadata?.team_name || u?.display_name || `Roster ${mu.roster_id}`, user: u?.display_name || "", slot: x.slot, player: x.id ? nameOf(x.id) : "(empty)", playerId: x.id || "", pos: x.id ? posOf(x.id).join("/") : "", points: pl ? pl.raw : 0, multiplier: pl ? pl.mult : 1, counted: x.pts, status: w < curWeek ? "final" : "current week" });
            }
          }
        }
      }
    }
    for (const { r, total, heroBonus, weekly } of byRoster.values()) {
      const u = userById.get(String(r.owner_id));
      const heroId = s.heroes[`${id}:${r.roster_id}`] || null;
      const sp = sleeperPts(r, s.metric);
      rows.push({
        leagueId: id,
        leagueName: league.name,
        rosterId: r.roster_id,
        ownerId: r.owner_id != null ? String(r.owner_id) : null,
        user: u?.display_name || `Roster ${r.roster_id}`,
        team: u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`,
        avatar: u?.avatar || null,
        value: custom ? total : sp,
        computed: recompute ? total : null,
        sleeperValue: sp,
        heroId,
        heroName: heroId ? nameOf(heroId) : null,
        heroBonus: custom ? heroBonus : 0,
        weekly,
        roster: (r.players || []).map((pid) => ({ id: String(pid), name: nameOf(pid), pos: posOf(pid)[0] || "" })).sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  rows.forEach((r, i) => (r.rank = i + 1));
  return {
    settings: s,
    leagues,
    metric: s.metric,
    weeks: { from, to, current: curWeek, live: to === curWeek },
    computedFrom: custom ? "matchups (hero / weeks rules)" : "Sleeper's season totals",
    rows,
    pot: payoutsFor({ entryFee: s.entryFee, teams: rows.length, payouts: s.payouts }),
    evidence: evidence ? ev : undefined,
    // One line per team: the sum of its counted lineups above, Sleeper's own season figure and the leaderboard value.
    evidenceTotals: evidence ? rows.map((r) => ({ rank: r.rank, league: r.leagueName, weeks: `${from}-${to}`, team: r.team, user: r.user, computed: r.computed, sleeper: r.sleeperValue, leaderboard: r.value, hero: r.heroName || "", heroBonus: r.heroBonus || 0 })) : undefined,
  };
}

/** The user's best ball leagues this season. */
export async function listLeagues(username) {
  const st = await sleeper.getState();
  const me = await sleeper.getUser(username);
  if (!me?.user_id) return [];
  const leagues = await sleeper.getUserLeagues(me.user_id, st.season);
  return (leagues || [])
    .filter((l) => Number(l.settings?.best_ball) === 1)
    .map((l) => ({ leagueId: String(l.league_id), name: l.name, avatar: l.avatar || null, season: l.season, teams: l.total_rosters ?? null, settings: getSettings(username, String(l.league_id)) }));
}

/** Plain-words rules → fields (Gemini). Leagues named in "combine with" are matched to the user's best ball leagues. */
export async function parseRules(username, leagueId, prompt) {
  const mine = await listLeagues(username);
  const self = mine.find((l) => l.leagueId === String(leagueId));
  const others = mine.filter((l) => l.leagueId !== String(leagueId));
  const out = await gemini.bestBallRules({ prompt, leagueName: self?.name || "this league", otherLeagues: others.map((l) => l.name) });
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
  const combineWith = out.combineWith.map((n) => others.find((l) => norm(l.name) === norm(n))?.leagueId).filter(Boolean);
  return { ...out, combineWith, unmatched: out.combineWith.filter((n) => !others.some((l) => norm(l.name) === norm(n))) };
}

/**
 * CSV for the evidence (quoted, header first): every counted lineup slot, week by week; then, after a blank line,
 * one total line per team (sum of its counted slots, Sleeper's own figure, the leaderboard value). "current week"
 * rows are still in progress — Sleeper's season figure may not include that week yet.
 */
export function evidenceCsv(rows, totals = []) {
  const cols = ["league", "week", "team", "user", "slot", "player", "playerId", "pos", "points", "multiplier", "counted", "status"];
  const tcols = ["rank", "league", "weeks", "team", "user", "computed", "sleeper", "leaderboard", "hero", "heroBonus"];
  const q = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))];
  if (totals?.length) out.push("", tcols.join(","), ...totals.map((r) => tcols.map((c) => q(r[c])).join(",")));
  return out.join("\n");
}
