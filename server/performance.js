import crypto from "node:crypto";
import db, { cacheGet, cacheSet } from "./db.js";
import * as store from "./projectionStore.js";
import * as slp from "./sleeperProjections.js";
import { fetchLeagueTransactions } from "./transactions.js";
import * as sleeper from "./sleeper.js";

/**
 * v3.3 — "My performance" on the Analytics page.
 *
 * Tracks only what James chose: LINEUP SWAPS and WAIVER CLAIMS. History starts at the first build that includes this
 * (nothing was stored about earlier suggestions).
 *
 * How it works
 *  - Every time a league is built (hourly in the background and whenever the app builds one) the app's current lineup
 *    swaps and flagged waiver pickups are stored — but only when they CHANGED, so the stored snapshots are a compact timeline.
 *  - Once a week's actual scores are in, each suggestion is judged against the LATEST suggestion that was still actionable
 *    before the relevant kickoff:
 *      lineup:  for each slot, the last snapshot in which that slot was not yet locked. If it suggested a swap (S replaces A)
 *               and James's final starter there is not S, he went against it. Scored two ways:
 *               (1) actual points: ignored -> (what he started) - S ; followed -> S - A      (+ = his decision gained points)
 *               (2) the app's own projection vs reality: projected gap S-A vs actual gap S-A (did the app call it right?)
 *      waiver:  a free agent flagged as out-projecting a starter / bench player. Judged from the week it was first flagged
 *               (and still available) through the latest scored week: his actual points vs the player James added instead,
 *               or vs the player he kept (the one the free agent out-projected) if he added nobody. Cumulative.
 *  - Actual points = the player's stat line scored with that league's scoring settings (the same data the accuracy page uses).
 *
 * Limits (stated plainly): points are the player's raw weekly score, not the effect on a matchup result; a free agent claimed
 * by someone else is still judged; "followed" for lineup means the suggested player ended up starting anywhere; unverified
 * against live data until the first real weeks have run.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS perf_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL, league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
    kind TEXT NOT NULL, at INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS perf_snap_lookup ON perf_snapshots (username, season, league_id, week, kind, at);
`);

const ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"], SFLX: ["QB", "RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"], WRRB_FLEX: ["RB", "WR"],
};
const eligible = (slot, pos) => (ELIGIBLE[slot] ? ELIGIBLE[slot].includes(pos) : slot === pos);
const r2 = (x) => Math.round(x * 100) / 100;

/* ---------------- snapshots ---------------- */
/** Pure: the decision-relevant parts of one built league. */
export function snapshotsFromBuilt(built) {
  const byId = new Map();
  for (const s of built.starters || []) if (s.player) byId.set(String(s.player.id), s.player);
  for (const p of [...(built.bench || []), ...(built.ir || []), ...(built.taxi || []), ...(built.freeAgents || [])]) if (p) byId.set(String(p.id), p);
  const info = (x) => {
    if (!x || x.id == null) return null;
    const full = byId.get(String(x.id)) || {};
    return { id: String(x.id), name: x.name ?? full.name ?? null, pos: full.pos ?? x.pos ?? null, proj: x.proj ?? full.proj ?? null, kick: full.kickoff ?? null };
  };
  const lineup = (built.lineupComparison || []).map((c, i) => ({ i, slot: c.slot, cur: info(c.current), opt: info(c.optimal), locked: Boolean(c.locked), changed: Boolean(c.changed) }));

  const projOf = (p) => (p && p.proj != null ? p.proj : 0);
  const waiver = [];
  for (const fa of built.freeAgents || []) {
    if (fa.proj == null) continue;
    const slots = (built.starters || []).filter((s) => eligible(s.slot, fa.pos));
    const weakest = slots.length ? slots.reduce((m, s) => (projOf(s.player) < projOf(m.player) ? s : m)) : null;
    let rule = null;
    let ref = null;
    if (weakest && fa.proj > projOf(weakest.player)) {
      rule = "starter";
      ref = weakest.player ? { ...info(weakest.player), slot: weakest.slot } : { id: null, name: "(empty slot)", pos: fa.pos, proj: 0, slot: weakest.slot };
    } else {
      const bench = (built.bench || []).filter((p) => p && p.pos === fa.pos);
      const weakBench = bench.length ? bench.reduce((m, p) => (projOf(p) < projOf(m) ? p : m)) : null;
      if (weakBench && fa.proj > projOf(weakBench)) {
        rule = "bench";
        ref = info(weakBench);
      }
    }
    if (rule) waiver.push({ rule, fa: { id: String(fa.id), name: fa.name, pos: fa.pos, proj: fa.proj, kick: fa.kickoff ?? null }, ref });
  }
  const meta = { name: built.name, profile: built.scoringProfile || null, myRosterId: built.myRosterId ?? null, weekOver: Boolean(built.weekOver) };
  return { meta, lineup, waiver };
}
const hashOf = (kind, rows) =>
  crypto.createHash("sha1").update(JSON.stringify(kind === "lineup" ? rows.map((r) => [r.i, r.cur?.id, r.opt?.id, r.locked, r.changed]) : rows.map((r) => [r.fa.id, r.ref?.id ?? null, r.rule]))).digest("hex");

/** Called after a league is built. Stores a snapshot only when the suggestions/lineup actually changed. */
export function record(username, built, { now = Date.now() } = {}) {
  try {
    if (!built || built.dataSource !== "live" || !built.week || !built.season || !built.id) return 0;
    const snap = snapshotsFromBuilt(built);
    let wrote = 0;
    for (const kind of ["lineup", "waiver"]) {
      const rows = kind === "lineup" ? snap.lineup : snap.waiver;
      const hash = hashOf(kind, rows);
      const last = db.prepare("SELECT hash FROM perf_snapshots WHERE username=? AND league_id=? AND season=? AND week=? AND kind=? ORDER BY at DESC, id DESC LIMIT 1").get(username, String(built.id), Number(built.season), Number(built.week), kind);
      if (last?.hash === hash) continue;
      db.prepare("INSERT INTO perf_snapshots (username, league_id, season, week, kind, at, hash, json) VALUES (?,?,?,?,?,?,?,?)").run(
        username, String(built.id), Number(built.season), Number(built.week), kind, now, hash, JSON.stringify({ meta: snap.meta, rows })
      );
      wrote++;
    }
    return wrote;
  } catch (e) {
    console.warn(`[performance] couldn't record a snapshot: ${e.message}`);
    return 0;
  }
}
const loadSnaps = (username, season) =>
  db.prepare("SELECT league_id, week, kind, at, json FROM perf_snapshots WHERE username=? AND season=? ORDER BY at ASC, id ASC").all(username, Number(season)).map((r) => ({ leagueId: r.league_id, week: r.week, kind: r.kind, at: r.at, ...JSON.parse(r.json) }));

/* ---------------- lineup scoring (pure) ---------------- */
/**
 * snaps: lineup snapshots of ONE league-week, oldest first ({at, rows:[{i,slot,cur,opt,locked,changed}]}).
 * pts(player) -> number | null (null = week not scored yet). Returns { rows, summary } or null.
 */
export function evalLineupWeek(snaps, pts) {
  if (!snaps?.length) return null;
  const last = snaps[snaps.length - 1];
  const finalIds = new Set(last.rows.map((r) => r.cur?.id).filter(Boolean));
  const rows = [];
  let pending = 0;
  for (let i = 0; i < last.rows.length; i++) {
    // Walk the snapshots in which this slot was still open. The standing suggestion is the latest "swap" the app showed;
    // it stays standing if later snapshots show James doing exactly that swap (the app then agrees with the lineup), and is
    // withdrawn if the app later agrees with some other player (new information changed its mind).
    let standing = null;
    for (const sn of snaps) {
      const r0 = sn.rows[i];
      if (!r0 || r0.locked) continue;
      if (r0.changed && r0.opt?.id) standing = { r: r0, sn };
      else if (standing && r0.cur?.id === standing.r.opt.id) continue; // he made the swap
      else standing = null;
    }
    if (!standing) continue; // nothing was suggested for this slot at the last moment it was actionable
    const { r, sn } = standing;
    const S = r.opt;
    const A = r.cur;
    const F = last.rows[i].cur;
    const ptsS = pts(S);
    const ptsA = A ? pts(A) : 0;
    const ptsF = F ? pts(F) : 0;
    if (ptsS == null || ptsA == null || ptsF == null) {
      pending++;
      continue;
    }
    const followed = finalIds.has(S.id);
    const effect = followed ? ptsS - ptsA : ptsF - ptsS;
    const projGap = (S.proj ?? 0) - (A?.proj ?? 0);
    const actualGap = ptsS - ptsA;
    rows.push({
      slot: r.slot, at: sn.at, followed,
      suggested: { id: S.id, name: S.name, pos: S.pos, proj: S.proj, pts: r2(ptsS) },
      replaced: A ? { id: A.id, name: A.name, pos: A.pos, proj: A.proj, pts: r2(ptsA) } : null,
      started: followed ? null : F ? { id: F.id, name: F.name, pos: F.pos, proj: F.proj, pts: r2(ptsF) } : null,
      effect: r2(effect), projGap: r2(projGap), actualGap: r2(actualGap), projErr: r2(actualGap - projGap),
      appRight: actualGap > 0 ? true : actualGap < 0 ? false : null,
    });
  }
  const ign = rows.filter((x) => !x.followed);
  const fol = rows.filter((x) => x.followed);
  const judged = rows.filter((x) => x.appRight != null);
  return {
    rows,
    summary: {
      suggested: rows.length,
      followed: fol.length,
      ignored: ign.length,
      pending,
      ignoredEffect: r2(ign.reduce((a, x) => a + x.effect, 0)), // + = going against the app gained points
      followedGain: r2(fol.reduce((a, x) => a + x.effect, 0)), // + = following gained points
      ignoredBetter: ign.filter((x) => x.effect > 0).length,
      appRight: judged.filter((x) => x.appRight).length,
      appJudged: judged.length,
      avgProjGap: rows.length ? r2(rows.reduce((a, x) => a + x.projGap, 0) / rows.length) : null,
      avgActualGap: rows.length ? r2(rows.reduce((a, x) => a + x.actualGap, 0) / rows.length) : null,
    },
  };
}

/* ---------------- waiver scoring (pure) ---------------- */
/**
 * Picks, per week, the suggestions that were still standing at the latest snapshot before the free agent's kickoff,
 * then keeps only the FIRST week each free agent was suggested (the claim window opens then).
 * weekSnaps: Map(week -> waiver snapshots oldest first).
 */
export function waiverSuggestions(weekSnaps) {
  const first = new Map();
  for (const week of [...weekSnaps.keys()].sort((a, b) => a - b)) {
    const snaps = weekSnaps.get(week);
    const ids = new Map();
    for (const sn of snaps) for (const w of sn.rows) ids.set(w.fa.id, w.fa.kick);
    for (const [id, kick] of ids) {
      const before = kick != null ? snaps.filter((s) => s.at < kick) : snaps;
      const decisive = before.length ? before[before.length - 1] : null;
      const hit = decisive?.rows.find((w) => w.fa.id === id);
      if (hit && !first.has(id)) first.set(id, { week, at: decisive.at, ...hit });
    }
  }
  return [...first.values()];
}
/**
 * suggestions: from waiverSuggestions. claims: [{week, addId, dropIds:[...]}] = James's completed adds in that league.
 * ptsFor(player, week) -> number | null. lastWeek = last scored week. Cumulative from the suggestion week through lastWeek.
 */
export function evalWaiver(suggestions, claims, ptsFor, lastWeek) {
  const out = [];
  for (const s of suggestions) {
    if (s.week > lastWeek) continue;
    const S = s.fa;
    const mine = (claims || []).find((c) => c.addId === S.id && c.week >= s.week);
    let alt;
    let altKind;
    if (mine) {
      const dropId = mine.dropIds?.[0] || null;
      alt = dropId ? { id: dropId, name: mine.dropName || null, pos: mine.dropPos || S.pos } : s.ref;
      altKind = dropId ? "dropped" : "kept";
    } else {
      const sameWeek = (claims || []).filter((c) => c.week === s.week && c.addId !== S.id);
      const pick = sameWeek.find((c) => c.addPos === S.pos) || sameWeek[0];
      if (pick) {
        alt = { id: pick.addId, name: pick.addName || null, pos: pick.addPos || S.pos };
        altKind = "added";
      } else {
        alt = s.ref;
        altKind = "kept";
      }
    }
    let cumS = 0;
    let cumAlt = 0;
    let weeks = 0;
    let unknown = false;
    for (let w = s.week; w <= lastWeek; w++) {
      const a = ptsFor(S, w);
      const b = alt?.id ? ptsFor(alt, w) : 0;
      if (a == null || b == null) {
        unknown = true;
        continue;
      }
      cumS += a;
      cumAlt += b;
      weeks++;
    }
    out.push({
      week: s.week, rule: s.rule, followed: Boolean(mine),
      suggested: { id: S.id, name: S.name, pos: S.pos, proj: S.proj },
      alt: alt ? { id: alt.id, name: alt.name, pos: alt.pos, proj: alt.proj ?? null } : null, altKind,
      weeks, unknownWeeks: unknown, suggestedPts: r2(cumS), altPts: r2(cumAlt), diff: r2(cumS - cumAlt), // + = the suggested player outscored the alternative
    });
  }
  return out;
}

/* ---------------- report ---------------- */
function makePts(season, profiles) {
  const cache = new Map(); // week -> { scored, stats: Map }
  const week = (w) => {
    if (!cache.has(w)) {
      const scored = Boolean(store.actualWeek(season, w));
      const stats = new Map(store.actualsFor(season, [w]).map((a) => [a.player_id, JSON.parse(a.stats_json)]));
      cache.set(w, { scored, stats });
    }
    return cache.get(w);
  };
  return {
    scoredWeeks: () => {
      const rows = db.prepare("SELECT week FROM actual_weeks WHERE season = ? ORDER BY week").all(Number(season));
      return rows.map((r) => r.week);
    },
    ptsFor: (profile) => (player, w) => {
      const c = week(w);
      if (!c.scored) return null;
      const settings = profiles.get(profile)?.settings;
      if (!settings) return null;
      const st = c.stats.get(String(player.id));
      return st ? slp.scoreStats({ pos: player.pos, stats: st }, settings) ?? 0 : 0;
    },
  };
}

async function claimsFor(leagueId, myRosterId, weeks) {
  if (myRosterId == null || !weeks.length) return { known: false, claims: [] };
  try {
    const rows = await fetchLeagueTransactions(leagueId, weeks);
    let dict = {};
    try {
      dict = (await sleeper.getPlayers()) || {};
    } catch {
      dict = {};
    }
    const nameOf = (id) => (dict[id] ? `${dict[id].first_name || ""} ${dict[id].last_name || ""}`.trim() || null : null);
    const posOf = (id) => dict[id]?.position || null;
    const claims = [];
    for (const t of rows) {
      if (t.status !== "complete" || !["waiver", "free_agent"].includes(t.type)) continue;
      const adds = t.adds.filter((a) => a.rosterId === myRosterId);
      const drops = t.drops.filter((d) => d.rosterId === myRosterId);
      for (const a of adds) claims.push({ week: t.week ?? null, addId: a.playerId, addName: nameOf(a.playerId), addPos: posOf(a.playerId), dropIds: drops.map((d) => d.playerId), dropName: drops[0] ? nameOf(drops[0].playerId) : null, dropPos: drops[0] ? posOf(drops[0].playerId) : null });
    }
    return { known: true, claims };
  } catch {
    return { known: false, claims: [] };
  }
}

export async function report(username, { season, leagueId = null, now = Date.now() } = {}) {
  const ck = `perf:${username}:${season}:${leagueId || "all"}`;
  const hit = cacheGet(ck);
  if (hit !== null) return hit;
  const profiles = new Map(store.listProfiles().map((p) => [p.profile, p]));
  const snaps = loadSnaps(username, season).filter((s) => !leagueId || s.leagueId === String(leagueId));
  const pt = makePts(season, profiles);
  const scoredWeeks = pt.scoredWeeks();
  const lastScored = scoredWeeks.length ? Math.max(...scoredWeeks) : 0;
  const leagues = new Map();
  for (const s of snaps) leagues.set(s.leagueId, { id: s.leagueId, name: s.meta?.name || s.leagueId, profile: s.meta?.profile || null, myRosterId: s.meta?.myRosterId ?? null });

  const lineupWeeks = []; // {week, leagueId, ...}
  const waiverRows = [];
  for (const lg of leagues.values()) {
    const ptsFor = pt.ptsFor(lg.profile);
    const weeks = [...new Set(snaps.filter((s) => s.leagueId === lg.id).map((s) => s.week))].sort((a, b) => a - b);
    for (const w of weeks) {
      const ls = snaps.filter((s) => s.leagueId === lg.id && s.week === w && s.kind === "lineup");
      const ev = evalLineupWeek(ls, (p) => ptsFor(p, w));
      if (ev && (ev.rows.length || ev.summary.pending)) lineupWeeks.push({ week: w, leagueId: lg.id, leagueName: lg.name, ...ev });
    }
    const wmap = new Map();
    for (const w of weeks) {
      const ws = snaps.filter((s) => s.leagueId === lg.id && s.week === w && s.kind === "waiver");
      if (ws.length) wmap.set(w, ws);
    }
    const sugg = waiverSuggestions(wmap);
    if (!sugg.length) continue;
    const minW = Math.min(...sugg.map((s) => s.week));
    const claimWeeks = [];
    for (let w = minW; w <= Math.max(lastScored, minW); w++) claimWeeks.push(w);
    const { known, claims } = await claimsFor(lg.id, lg.myRosterId, claimWeeks);
    // the trend: judge again as of every scored week
    const asOf = scoredWeeks.filter((w) => w >= minW);
    const final = evalWaiver(sugg, claims, ptsFor, lastScored);
    const byWeek = asOf.map((w) => ({ week: w, diffs: evalWaiver(sugg, claims, ptsFor, w) }));
    waiverRows.push(...final.map((x) => ({ leagueId: lg.id, leagueName: lg.name, claimsKnown: known, ...x })));
    lg.waiverTrend = byWeek.map((b) => ({ week: b.week, missed: r2(b.diffs.filter((x) => !x.followed).reduce((a, x) => a + x.diff, 0)), claimed: r2(b.diffs.filter((x) => x.followed).reduce((a, x) => a + x.diff, 0)) }));
  }

  // weekly report + season trend
  const weekNums = [...new Set([...lineupWeeks.map((x) => x.week), ...waiverRows.map((x) => x.week)])].sort((a, b) => a - b);
  const weekly = weekNums.map((w) => {
    const L = lineupWeeks.filter((x) => x.week === w);
    const W = waiverRows.filter((x) => x.week === w);
    const sum = (k) => r2(L.reduce((a, x) => a + (x.summary[k] || 0), 0));
    return {
      week: w,
      lineup: {
        suggested: sum("suggested"), followed: sum("followed"), ignored: sum("ignored"), pending: sum("pending"),
        ignoredEffect: sum("ignoredEffect"), followedGain: sum("followedGain"), ignoredBetter: sum("ignoredBetter"),
        appRight: sum("appRight"), appJudged: sum("appJudged"),
        rows: L.flatMap((x) => x.rows.map((r) => ({ ...r, leagueId: x.leagueId, leagueName: x.leagueName }))),
      },
      waiver: { suggested: W.length, claimed: W.filter((x) => x.followed).length, missed: W.filter((x) => !x.followed).length, rows: W },
      scored: scoredWeeks.includes(w),
    };
  });
  const trend = [];
  let cumLineup = 0;
  for (const wk of weekly) {
    cumLineup += wk.lineup.ignoredEffect;
    const wTrend = [...leagues.values()].flatMap((lg) => (lg.waiverTrend || []).filter((t) => t.week === wk.week));
    trend.push({
      week: wk.week,
      lineupCum: r2(cumLineup),
      waiverMissedCum: r2(wTrend.reduce((a, t) => a + t.missed, 0)),
      waiverClaimedCum: r2(wTrend.reduce((a, t) => a + t.claimed, 0)),
      appHitRate: wk.lineup.appJudged ? r2(wk.lineup.appRight / wk.lineup.appJudged) : null,
    });
  }
  const tot = weekly.reduce((a, w) => ({ suggested: a.suggested + w.lineup.suggested, followed: a.followed + w.lineup.followed, ignored: a.ignored + w.lineup.ignored, ignoredEffect: a.ignoredEffect + w.lineup.ignoredEffect, followedGain: a.followedGain + w.lineup.followedGain, appRight: a.appRight + w.lineup.appRight, appJudged: a.appJudged + w.lineup.appJudged }), { suggested: 0, followed: 0, ignored: 0, ignoredEffect: 0, followedGain: 0, appRight: 0, appJudged: 0 });
  const first = snaps.length ? Math.min(...snaps.map((s) => s.at)) : null;
  const out = {
    season: Number(season), since: first, lastScoredWeek: lastScored, leagues: [...leagues.values()].map((l) => ({ id: l.id, name: l.name })),
    weekly, trend,
    totals: { ...tot, ignoredEffect: r2(tot.ignoredEffect), followedGain: r2(tot.followedGain), waiverMissed: r2(waiverRows.filter((x) => !x.followed).reduce((a, x) => a + x.diff, 0)), waiverClaimed: r2(waiverRows.filter((x) => x.followed).reduce((a, x) => a + x.diff, 0)), waiverSuggested: waiverRows.length },
    note: first ? null : "No history yet — the app starts recording its suggestions from the first build that includes this, and scores them once a week's results are in.",
  };
  cacheSet(ck, out, 10 * 60 * 1000);
  return out;
}
