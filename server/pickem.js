import db, { cacheGet, cacheSet, getAllUserStates, getUser } from "./db.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as tank01 from "./tank01.js";
import * as gemini from "./gemini.js";
import * as store from "./projectionStore.js";
import { sendPushToUser, isPushConfigured } from "./push.js";

/**
 * v2.7 Pick'em (straight-up). James's pool: CBS, no confidence points,
 * weekly + season prizes, 40–50 entrants.
 *
 * Win probability per game, best source first:
 *   1. Tank01 sportsbook moneylines (8 books), no-vig, averaged — from the
 *      odds the app already pulls (no extra Tank01 calls)
 *   2. ESPN scoreboard moneylines, no-vig
 *   3. Spread → probability, margin ~ Normal(−spread, 13.5)
 *   4. ESPN FPI predictor (also always shown as a second opinion)
 * Default pick = the favourite. Optional "weekly leverage": up to N
 * underdogs (default 2) in near-coin-flip games (dog ≥ 40%) where the pool
 * is likely heavy on the favourite — estimated from the market, or typed in.
 *
 * Upset potential (0–100) = underdog win chance (up to 30) + line movement
 * toward the underdog since the week's first snapshot (up to 30) + Gemini's
 * count of articles picking the upset (up to 40). Grows through the week as
 * lines shift and more articles agree.
 *
 * A recommendation that changes before that game's kickoff is flagged (red
 * dot) until the user opens it, and pushed as a notification if they've
 * enabled alerts.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pickem_snapshots (
    season INTEGER NOT NULL, week INTEGER NOT NULL, game_key TEXT NOT NULL,
    at INTEGER NOT NULL, home_prob REAL, home_spread REAL, source TEXT,
    PRIMARY KEY (season, week, game_key, at)
  );
  CREATE TABLE IF NOT EXISTS pickem_recs (
    username TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, game_key TEXT NOT NULL,
    pick TEXT NOT NULL, prev_pick TEXT, changed_at INTEGER, seen INTEGER NOT NULL DEFAULT 1, kickoff INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (username, season, week, game_key)
  );
`);

export const DEFAULT_SETTINGS = { leverage: false, leverageCount: 2, minDogProb: 0.4, notify: true, publicPct: {} };
const SNAPSHOT_EVERY_MS = 60 * 60 * 1000;
const SIGMA = 13.5;

export function getSettings(username) {
  const s = store.getState(`pickem_settings:${username}`, {}) || {};
  return { ...DEFAULT_SETTINGS, ...s, publicPct: { ...(s.publicPct || {}) } };
}
export function saveSettings(username, input) {
  const cur = getSettings(username);
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const next = {
    leverage: Boolean(input.leverage ?? cur.leverage),
    leverageCount: Math.round(n(input.leverageCount ?? cur.leverageCount, 2, 0, 8)),
    minDogProb: n(input.minDogProb ?? cur.minDogProb, 0.4, 0.2, 0.5),
    notify: input.notify == null ? cur.notify : Boolean(input.notify),
    publicPct: { ...cur.publicPct },
  };
  for (const [k, v] of Object.entries(input.publicPct || {})) {
    if (v === "" || v == null) delete next.publicPct[k];
    else next.publicPct[k] = n(v, 50, 0, 100); // % of the pool picking the HOME team
  }
  store.setState(`pickem_settings:${username}`, next);
  return next;
}

/* ---------------- maths ---------------- */
function erf(x) {
  // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
/** Home win probability from the home spread (negative = home favoured). */
export function probFromSpread(homeSpread) {
  return normCdf(-homeSpread / SIGMA);
}
function devig(homeML, awayML) {
  const ph = tank01.impliedProb(homeML);
  const pa = tank01.impliedProb(awayML);
  return ph != null && pa != null ? ph / (ph + pa) : null;
}
/** Crowd estimate when no real pick % is known: pools over-pick favourites. */
export function estPublicFav(favProb) {
  return Math.min(0.97, Math.max(0.5, 0.5 + 1.6 * (favProb - 0.5)));
}
export function upsetPotential({ dogProb, dogShift, mentions }) {
  const base = Math.min(30, dogProb * 60);
  const shift = Math.min(30, Math.max(0, dogShift * 300));
  const gem = Math.min(40, (mentions || 0) * 8);
  return { score: Math.round(Math.min(100, base + shift + gem)), parts: { base: Math.round(base), shift: Math.round(shift), gemini: Math.round(gem) } };
}

/* ---------------- ESPN FPI (free) ---------------- */
async function fpiHomeProb(espnId) {
  if (!espnId) return null;
  const key = `espn:fpi:${espnId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached === "null" ? null : cached;
  try {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${espnId}/competitions/${espnId}/predictor`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const stat = (side, name) => side?.statistics?.find((s) => s.name === name)?.value;
    const v = stat(j.homeTeam, "gameProjection");
    const p = v != null ? Number(v) / 100 : null;
    cacheSet(key, p ?? "null", 6 * 60 * 60 * 1000);
    return p;
  } catch {
    cacheSet(key, "null", 60 * 60 * 1000);
    return null;
  }
}

/* ---------------- board ---------------- */
function snapshot(season, week, key, homeProb, homeSpread, source) {
  const last = db.prepare("SELECT at, home_prob, home_spread FROM pickem_snapshots WHERE season=? AND week=? AND game_key=? ORDER BY at DESC LIMIT 1").get(season, week, key);
  if (last && Date.now() - last.at < SNAPSHOT_EVERY_MS && last.home_prob === homeProb && last.home_spread === homeSpread) return;
  if (last && Date.now() - last.at < SNAPSHOT_EVERY_MS) return;
  db.prepare("INSERT OR IGNORE INTO pickem_snapshots (season, week, game_key, at, home_prob, home_spread, source) VALUES (?,?,?,?,?,?,?)").run(season, week, key, Date.now(), homeProb, homeSpread, source);
}
function opening(season, week, key) {
  return db.prepare("SELECT at, home_prob, home_spread FROM pickem_snapshots WHERE season=? AND week=? AND game_key=? AND home_prob IS NOT NULL ORDER BY at ASC LIMIT 1").get(season, week, key) || null;
}

/** The week's games with probabilities, line movement, upset potential and notes (same for every user). */
export async function getBoard({ season, week } = {}) {
  if (!season || !week) {
    const st = await sleeper.getState();
    season = season || Number(st.season);
    week = week || Number(st.week);
  }
  season = Number(season);
  week = Number(week);
  const sched = await schedule.getWeekSchedule(season, week, { live: true });
  const tankWeek = tank01.isConfigured() ? await tank01.getWeekData(season, week).catch(() => null) : null;
  const tankLines = new Map();
  for (const g of tankWeek?.schedule?.games || []) {
    const lines = tankWeek.odds?.[g.gameID]?.lines;
    if (lines) tankLines.set(`${tank01.normTeam(g.away)}@${tank01.normTeam(g.home)}`, lines);
  }
  const now = Date.now();
  const games = [];
  for (const g of sched?.games || []) {
    const home = tank01.normTeam(g.home);
    const away = tank01.normTeam(g.away);
    const key = `${away}@${home}`;
    const tl = tankLines.get(key);
    const eo = g.espnOdds;
    const fpi = await fpiHomeProb(g.espnId);
    let homeProb = null;
    let source = null;
    if (tl?.homeWinProb != null) (homeProb = tl.homeWinProb), (source = `Vegas (${tl.books} books)`);
    else if (eo?.homeML != null && eo?.awayML != null) (homeProb = devig(eo.homeML, eo.awayML)), (source = "Vegas (ESPN)");
    else if ((tl?.homeSpread ?? eo?.homeSpread) != null) (homeProb = probFromSpread(tl?.homeSpread ?? eo.homeSpread)), (source = "spread");
    else if (fpi != null) (homeProb = fpi), (source = "ESPN FPI");
    const homeSpread = tl?.homeSpread ?? eo?.homeSpread ?? null;
    const total = tl?.total ?? eo?.total ?? null;
    const started = g.kickoffMillis != null && g.kickoffMillis <= now;
    if (homeProb != null && !started) snapshot(season, week, key, homeProb, homeSpread, source);
    const open = opening(season, week, key);
    const favorite = homeProb == null ? null : homeProb >= 0.5 ? home : away;
    const underdog = favorite == null ? null : favorite === home ? away : home;
    const dogProb = homeProb == null ? null : Math.min(homeProb, 1 - homeProb);
    const dogProbOpen = open?.home_prob == null || underdog == null ? null : underdog === home ? open.home_prob : 1 - open.home_prob;
    games.push({
      key, home, away, homeName: g.homeName, awayName: g.awayName, espnId: g.espnId,
      kickoff: g.kickoffMillis, kickoffLabel: g.kickoffLabel, state: g.state, statusDetail: g.statusDetail,
      homeScore: g.homeScore, awayScore: g.awayScore, started,
      homeProb, source, fpiHomeProb: fpi, homeSpread, total,
      favorite, underdog, dogProb,
      openHomeProb: open?.home_prob ?? null, openedAt: open?.at ?? null,
      dogShift: dogProb != null && dogProbOpen != null ? dogProb - dogProbOpen : 0,
    });
  }

  // Gemini: one grounded scan per day for games not yet started.
  let gem = null;
  try {
    const todo = games.filter((g) => !g.started && g.favorite).map((g) => ({ key: g.key, favorite: g.favorite, underdog: g.underdog, kickoffLabel: g.kickoffLabel }));
    gem = await gemini.upsetScan(season, week, todo);
  } catch (err) {
    console.warn(`[pickem] Gemini scan failed: ${err.message}`);
  }
  for (const g of games) {
    const gi = gem?.byGame?.[g.key] || null;
    g.gemini = gi;
    const up = upsetPotential({ dogProb: g.dogProb ?? 0, dogShift: g.dogShift, mentions: gi?.upsetMentions });
    g.upsetPotential = up.score;
    g.upsetParts = up.parts;
  }
  games.sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0));
  const last = [...games].reverse().find((g) => g.total != null) || null;
  return {
    season, week, games,
    tiebreaker: last ? { game: last.key, total: Math.round(last.total), kickoffLabel: last.kickoffLabel } : null,
    gemini: { configured: gemini.isConfigured(), at: gem?.at ?? null, sources: gem?.sources ?? [] },
    updatedAt: Date.now(),
  };
}

/* ---------------- per-user recommendations ---------------- */
export function recommend(board, settings) {
  const picks = new Map();
  for (const g of board.games) {
    if (!g.favorite) continue;
    picks.set(g.key, { pick: g.favorite, reason: "favourite", leverage: false });
  }
  if (settings.leverage && settings.leverageCount > 0) {
    const cands = board.games
      .filter((g) => !g.started && g.dogProb != null && g.dogProb >= settings.minDogProb)
      .map((g) => {
        const pubHome = settings.publicPct?.[g.key];
        const publicFav = pubHome != null ? (g.favorite === g.home ? pubHome / 100 : 1 - pubHome / 100) : estPublicFav(1 - g.dogProb);
        const leverage = g.dogProb - (1 - publicFav) + g.upsetPotential / 400;
        return { g, leverage, publicFav };
      })
      .sort((a, b) => b.leverage - a.leverage)
      .slice(0, settings.leverageCount);
    for (const c of cands) {
      picks.set(c.g.key, { pick: c.g.underdog, reason: `weekly leverage: ${Math.round(c.g.dogProb * 100)}% to win, ~${Math.round((1 - c.publicFav) * 100)}% of the pool likely on them`, leverage: true });
    }
  }
  return picks;
}

/** Stores recommendations, flags changes before kickoff, pushes alerts. Returns the per-game rec rows. */
export async function trackRecs(username, board, settings, { notify = true } = {}) {
  const recs = recommend(board, settings);
  const get = db.prepare("SELECT * FROM pickem_recs WHERE username=? AND season=? AND week=? AND game_key=?");
  const ins = db.prepare("INSERT INTO pickem_recs (username, season, week, game_key, pick, kickoff, seen, updated_at) VALUES (?,?,?,?,?,?,1,?)");
  const upd = db.prepare("UPDATE pickem_recs SET prev_pick=pick, pick=?, changed_at=?, seen=0, kickoff=?, updated_at=? WHERE username=? AND season=? AND week=? AND game_key=?");
  const changed = [];
  for (const g of board.games) {
    const r = recs.get(g.key);
    if (!r) continue;
    const row = get.get(username, board.season, board.week, g.key);
    if (!row) ins.run(username, board.season, board.week, g.key, r.pick, g.kickoff, Date.now());
    else if (row.pick !== r.pick && !g.started) {
      upd.run(r.pick, Date.now(), g.kickoff, Date.now(), username, board.season, board.week, g.key);
      changed.push({ g, from: row.pick, to: r.pick });
    }
  }
  if (notify && changed.length && settings.notify && isPushConfigured()) {
    for (const c of changed) {
      await sendPushToUser(username, {
        title: `Pick'em: ${c.g.key} — now ${c.to}`,
        body: `Recommendation changed from ${c.from} to ${c.to} before kickoff (${c.g.kickoffLabel || ""}).`,
      }).catch(() => {});
    }
  }
  const rows = db.prepare("SELECT * FROM pickem_recs WHERE username=? AND season=? AND week=?").all(username, board.season, board.week);
  return { recs, rows: new Map(rows.map((r) => [r.game_key, r])) };
}

export function markSeen(username, season, week, gameKey) {
  if (gameKey) db.prepare("UPDATE pickem_recs SET seen=1 WHERE username=? AND season=? AND week=? AND game_key=?").run(username, season, week, gameKey);
  else db.prepare("UPDATE pickem_recs SET seen=1 WHERE username=? AND season=? AND week=?").run(username, season, week);
}

/** Season record of the stored (final, pre-kickoff) picks vs always taking the favourite, from finished games this week and earlier weeks' boards. */
function record(username, board) {
  const rows = db.prepare("SELECT * FROM pickem_recs WHERE username=? AND season=?").all(username, board.season);
  const res = store.getState(`pickem_results:${board.season}`, {}) || {};
  // Remember results for finished games on this board.
  let changedRes = false;
  for (const g of board.games) {
    if (g.state === "post" && g.homeScore != null && g.awayScore != null) {
      const k = `${board.week}|${g.key}`;
      if (!res[k]) {
        res[k] = { winner: g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : "TIE", favorite: g.favorite };
        changedRes = true;
      }
    }
  }
  if (changedRes) store.setState(`pickem_results:${board.season}`, res);
  let mine = 0, fav = 0, n = 0, weekMine = 0, weekN = 0;
  for (const r of rows) {
    const out = res[`${r.week}|${r.game_key}`];
    if (!out || out.winner === "TIE") continue;
    n++;
    if (r.pick === out.winner) mine++;
    if (out.favorite === out.winner) fav++;
    if (r.week === board.week) {
      weekN++;
      if (r.pick === out.winner) weekMine++;
    }
  }
  return { games: n, correct: mine, favoritesCorrect: fav, weekGames: weekN, weekCorrect: weekMine };
}

export async function getPickem(username) {
  const board = await getBoard();
  const settings = getSettings(username);
  const { recs, rows } = await trackRecs(username, board, settings);
  const now = Date.now();
  const games = board.games.map((g) => {
    const r = recs.get(g.key);
    const row = rows.get(g.key);
    return {
      ...g,
      pick: r?.pick ?? null,
      reason: r?.reason ?? null,
      leverage: r?.leverage ?? false,
      changed: Boolean(row && row.seen === 0 && row.changed_at && (g.kickoff == null || g.kickoff > now)),
      prevPick: row?.prev_pick ?? null,
      changedAt: row?.changed_at ?? null,
    };
  });
  return { ...board, games, settings, record: record(username, board), changedCount: games.filter((g) => g.changed).length };
}

/** Scheduler hook: recompute every active user's recommendations (flags + pushes changes). */
export async function updateAllUsers() {
  let board;
  try {
    board = await getBoard();
  } catch (err) {
    console.warn(`[pickem] board failed: ${err.message}`);
    return;
  }
  for (const st of getAllUserStates()) {
    const u = getUser(st.username);
    if (!u?.active) continue;
    try {
      await trackRecs(st.username, board, getSettings(st.username));
    } catch (err) {
      console.warn(`[pickem] ${st.username}: ${err.message}`);
    }
  }
}
