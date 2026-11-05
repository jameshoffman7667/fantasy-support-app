import * as sleeper from "./sleeper.js";
import * as values from "./values.js";
import * as rosProjections from "./rosProjections.js";
import { nameIndex } from "./waiverCategories.js";
import { TRADE_POSITIONS, depthByPosition } from "./tradeTools.js";

/**
 * v4.15.0 (P-25) — Trade page → Trending/Ending.
 *
 * The weekly article search (gemini.tradeIdeas) names players to trade FOR (trending up) and to trade AWAY (ending).
 * Here those names are matched to Sleeper ids per league, and potential trades are built from the players the user
 * ticks. Everything below the "context" part is pure (no network) and unit-tested.
 *
 * Value in a trade = the league's own number: dynasty value in dynasty leagues, rest-of-season projected points in
 * redraft / keeper leagues. Every trade leans 10% in the user's favour: what he gets is worth about 1.10 times what he
 * gives (never less than 1.00). Team need = weak STARTING slots: at each position the j-th best player of a team is
 * compared with the league average j-th best; a slot far below the average (or empty) is a need.
 */
export const LEAN = 0.1;
const WEAK_SHARE = 0.8; // a starting slot filled at under 80% of the league average for that slot is weak

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Starting-slot need per roster: Map(rosterId → { QB, RB, WR, TE }) where 0 = no weak slot and larger = weaker.
 * rosters: [{ rosterId, players:[ids] }]; depth = tradeTools.depthByPosition(); valueOf(id) → number|null.
 */
export function teamNeeds({ rosters, posOf, valueOf, depth }) {
  const slotVals = new Map(); // rosterId → { pos: [top-k values, padded with 0] }
  for (const r of rosters) {
    const byPos = {};
    for (const id of r.players || []) {
      const pos = posOf(id);
      if (!TRADE_POSITIONS.includes(pos)) continue;
      const v = valueOf(id);
      if (v == null) continue;
      (byPos[pos] ||= []).push(v);
    }
    const row = {};
    for (const pos of TRADE_POSITIONS) {
      const k = depth[pos] || 1;
      const list = (byPos[pos] || []).sort((a, b) => b - a).slice(0, k);
      while (list.length < k) list.push(0);
      row[pos] = list;
    }
    slotVals.set(r.rosterId, row);
  }
  const avg = {};
  for (const pos of TRADE_POSITIONS) {
    const k = depth[pos] || 1;
    avg[pos] = Array.from({ length: k }, (_, j) => {
      const xs = [...slotVals.values()].map((row) => row[pos][j]);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }
  const needs = new Map();
  for (const [rid, row] of slotVals) {
    const need = {};
    for (const pos of TRADE_POSITIONS) {
      let n = 0;
      row[pos].forEach((v, j) => {
        const a = avg[pos][j];
        if (a > 0 && v < a * WEAK_SHARE) n += (a - v) / a;
      });
      need[pos] = Math.round(n * 100) / 100;
    }
    needs.set(rid, need);
  }
  return needs;
}

/** All subsets of `items` with 1..maxSize members. */
function* subsets(items, maxSize) {
  const n = items.length;
  const pick = [];
  function* rec(start) {
    if (pick.length) yield pick.map((i) => items[i]);
    if (pick.length === maxSize) return;
    for (let i = start; i < n; i++) {
      pick.push(i);
      yield* rec(i + 1);
      pick.pop();
    }
  }
  yield* rec(0);
}

/**
 * Potential trades from the ticked players.
 *   rosters       [{ rosterId, label, players:[ids] }] (every team, the user's included)
 *   myRosterId
 *   posOf, valueOf, nameOf   as in teamNeeds / for display
 *   depth         tradeTools.depthByPosition(roster_positions)
 *   forIds        ticked trade-for players (on other teams)
 *   awayIds       ticked trade-away players (on the user's team)
 * Returns [{ theirRosterId, theirTeam, get:[ids], give:[ids], getValue, giveValue, net, pct, includes:[ids ticked], reasons:[text] }]
 * best first. `net` = getValue − giveValue; `pct` = net / giveValue × 100 (the target is +10).
 */
export function buildTrades({ rosters, myRosterId, posOf, valueOf, nameOf = (id) => id, depth, forIds = [], awayIds = [], lean = LEAN, perTeam = 2, max = 12 }) {
  const me = rosters.find((r) => r.rosterId === myRosterId);
  if (!me) return [];
  const needs = teamNeeds({ rosters, posOf, valueOf, depth });
  const myNeed = needs.get(myRosterId) || {};
  const target = 1 + lean;
  const val = (id) => valueOf(id);
  const mine = new Set((me.players || []).map(String));
  const forSet = new Set(forIds.map(String));
  const awaySet = new Set(awayIds.map(String).filter((id) => mine.has(id)));

  // my starters per position (the top-k by value): giving one up at a position where I am already weak costs more
  const myTop = {};
  for (const pos of TRADE_POSITIONS) {
    myTop[pos] = new Set(
      (me.players || []).map(String).filter((id) => posOf(id) === pos && val(id) != null).sort((a, b) => val(b) - val(a)).slice(0, depth[pos] || 1)
    );
  }
  const starterCost = (id) => {
    const pos = posOf(id);
    if (!myTop[pos]?.has(String(id))) return 0; // bench player: free to give
    return myNeed[pos] > 0 ? 1.5 : 0.4; // starter: heavy at a position I'm weak at, light elsewhere
  };

  const out = [];
  for (const team of rosters) {
    if (team.rosterId === myRosterId) continue;
    const theirs = new Set((team.players || []).map(String));
    const theirNeed = needs.get(team.rosterId) || {};
    const found = [];

    // A) the ticked trade-for players this team owns: get them, give back what they need that I can spare
    const wanted = [...forSet].filter((id) => theirs.has(id) && val(id) != null).sort((a, b) => val(b) - val(a));
    const getSets = wanted.slice(0, 3).map((id) => [id]);
    if (wanted.length >= 2) getSets.push(wanted.slice(0, 2));
    for (const gets of getSets) {
      const getValue = gets.reduce((s, id) => s + val(id), 0);
      const pool = [...mine]
        .filter((id) => val(id) != null && val(id) > 0)
        .map((id) => {
          const pos = posOf(id);
          const theyNeedIt = (theirNeed[pos] || 0) > 0;
          const pref = (awaySet.has(id) ? 2 : 0) + (theyNeedIt ? 1 : 0) - starterCost(id);
          return { id, pref };
        })
        .sort((a, b) => b.pref - a.pref || val(b.id) - val(a.id))
        .slice(0, 9);
      let best = null;
      for (const combo of subsets(pool, 3)) {
        const giveValue = combo.reduce((s, c) => s + val(c.id), 0);
        if (giveValue <= 0 || getValue < giveValue) continue; // never give up more than I get
        const err = Math.abs(getValue / giveValue - target);
        const score = err * 10 - combo.reduce((s, c) => s + c.pref, 0) * 0.35 + combo.length * 0.05;
        if (!best || score < best.score) best = { combo, giveValue, score };
      }
      if (best) found.push({ gets, give: best.combo.map((c) => c.id), getValue, giveValue: best.giveValue, ticked: [...gets, ...best.combo.map((c) => c.id).filter((id) => awaySet.has(id))] });
    }

    // B) the ticked trade-away players this team could use: sell them for what I'm short of
    const sells = [...awaySet].filter((id) => val(id) != null && val(id) > 0 && (theirNeed[posOf(id)] || 0) > 0);
    for (const sell of sells) {
      const sellValue = val(sell);
      const pool = [...theirs]
        .filter((id) => val(id) != null && val(id) > 0 && !forSet.has(id) && posOf(id) !== posOf(sell))
        .map((id) => {
          const pos = posOf(id);
          const pref = (myNeed[pos] || 0) > 0 ? 1 : 0;
          return { id, pref };
        })
        .sort((a, b) => b.pref - a.pref || val(b.id) - val(a.id))
        .slice(0, 9);
      let best = null;
      for (const combo of subsets(pool, 2)) {
        const getValue = combo.reduce((s, c) => s + val(c.id), 0);
        if (getValue < sellValue) continue;
        const err = Math.abs(getValue / sellValue - target);
        const score = err * 10 - combo.reduce((s, c) => s + c.pref, 0) * 0.35 + combo.length * 0.05;
        if (!best || score < best.score) best = { combo, getValue, score };
      }
      if (best) found.push({ gets: best.combo.map((c) => c.id), give: [sell], getValue: best.getValue, giveValue: sellValue, ticked: [sell] });
    }

    // keep this team's best trades (closest to +10%, most ticked players), no duplicates
    const seen = new Set();
    const ranked = found
      .map((f) => ({ f, err: Math.abs(f.getValue / f.giveValue - target), key: `${[...f.gets].sort().join(",")}>${[...f.give].sort().join(",")}` }))
      .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
      .sort((a, b) => b.f.ticked.length - a.f.ticked.length || a.err - b.err)
      .slice(0, perTeam);
    for (const { f } of ranked) {
      const reasons = [];
      const needPos = f.give.map((id) => posOf(id)).filter((p) => (theirNeed[p] || 0) > 0);
      if (needPos.length) reasons.push(`${team.label} is weak at ${[...new Set(needPos)].join("/")} in the starting lineup`);
      const mineNeed = f.gets.map((id) => posOf(id)).filter((p) => (myNeed[p] || 0) > 0);
      if (mineNeed.length) reasons.push(`fills your weak ${[...new Set(mineNeed)].join("/")} slot`);
      out.push({
        theirRosterId: team.rosterId,
        theirTeam: team.label,
        get: f.gets,
        give: f.give,
        getValue: round1(f.getValue),
        giveValue: round1(f.giveValue),
        net: round1(f.getValue - f.giveValue),
        pct: round1(((f.getValue - f.giveValue) / f.giveValue) * 100),
        includes: [...new Set(f.ticked)],
        reasons,
      });
    }
  }
  return out
    .sort((a, b) => b.includes.length - a.includes.length || Math.abs(a.pct - lean * 100) - Math.abs(b.pct - lean * 100))
    .slice(0, max);
}

/**
 * Matches the weekly research names to this league: trade-for players owned by ANOTHER team, trade-away players on
 * the user's team. Pure given `findId` (waiverCategories.nameIndex) and the rosters.
 */
export function leagueCandidates({ research, findId, rosters, myRosterId }) {
  const owner = new Map();
  for (const r of rosters) for (const id of r.players || []) owner.set(String(id), r.rosterId);
  const forList = [];
  const awayList = [];
  const seen = new Set();
  for (const p of research?.players || []) {
    const id = findId(p.name, p.pos, p.team);
    if (!id) continue;
    const key = `${p.direction}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rid = owner.get(String(id));
    if (p.direction === "away" && rid === myRosterId) awayList.push({ ...p, id: String(id), ownerRosterId: rid });
    else if (p.direction === "for" && rid != null && rid !== myRosterId) forList.push({ ...p, id: String(id), ownerRosterId: rid });
  }
  return { forList, awayList };
}

/* ---------------- league context (network) ---------------- */

const fullName = (m, id) => (m ? m.full_name || `${m.first_name || ""} ${m.last_name || ""}`.trim() || String(id) : String(id));

/**
 * Everything the Trending/Ending tab needs for one built league: rosters, the player number used for trades (dynasty
 * value or ROS points), each player's dynasty value, and name matching. Mirrors how buildLeague picks its numbers.
 */
export async function leagueContext(lg) {
  const [raw, rosters, players] = await Promise.all([sleeper.getLeague(lg.id), sleeper.getRosters(lg.id), sleeper.getPlayers()]);
  const season = Number(lg.season) || Number(raw?.season) || new Date().getFullYear();
  const week = Number(lg.week) || 1;
  const dynasty = Number(raw?.settings?.type) === 2;
  const superflex = (raw?.roster_positions || []).includes("SUPER_FLEX");
  const ppr = Number(raw?.scoring_settings?.rec ?? 0);
  const tep = Number(raw?.scoring_settings?.bonus_rec_te ?? 0) > 0;
  const teams = rosters.length;
  const empty = { source: null, valueOf: () => null };
  const [valueTable, dynTable, ros] = await Promise.all([
    values.leagueValues({ dynasty, superflex, ppr, tep, teams }).catch(() => empty),
    dynasty ? null : values.leagueValues({ dynasty: true, superflex, ppr, tep, teams }).catch(() => empty),
    rosProjections.rosPoints({ season, week, settings: raw?.scoring_settings }).catch(() => null),
  ]);
  const dyn = dynasty ? valueTable : dynTable || empty;
  const rosOf = (id) => (ros?.byId?.size ? ros.byId.get(String(id)) ?? null : null);
  const valueOf = dynasty ? (id) => valueTable.valueOf(id) ?? rosOf(id) : (id) => rosOf(id) ?? valueTable.valueOf(id);
  const labels = new Map((lg.leagueTeams || []).map((t) => [t.rosterId, t.label]));
  const teamsOut = rosters.map((r) => ({ rosterId: r.roster_id, label: labels.get(r.roster_id) || `Roster #${r.roster_id}`, players: (r.players || []).map(String) }));
  return {
    dynasty,
    basis: dynasty ? (valueTable.source ? `${valueTable.source} dynasty values` : "rest-of-season projections") : "rest-of-season projected points",
    rosters: teamsOut,
    myRosterId: lg.myRosterId,
    depth: depthByPosition(raw?.roster_positions || []),
    posOf: (id) => players[id]?.position,
    valueOf,
    dynOf: (id) => dyn.valueOf(String(id)) ?? null,
    nameOf: (id) => fullName(players[id], id),
    infoOf: (id) => {
      const m = players[id];
      const v = valueOf(id);
      const d = dyn.valueOf(String(id)) ?? null;
      return { id: String(id), name: fullName(m, id), pos: m?.position || null, team: m?.team || null, value: v == null ? null : round1(v), dyn: d == null ? null : Math.round(d) };
    },
    findId: nameIndex(players),
  };
}
