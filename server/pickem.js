import db, { cacheGet, cacheSet, getAllUserStates, getUser } from "./db.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as tank01 from "./tank01.js";
import * as gemini from "./gemini.js";
import * as weather from "./weather.js";
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
 * v3.4: the app's picks differ from Vegas on purpose. Every game is the
 * favourite EXCEPT the very-high-upset-potential games, picked as underdogs:
 * always the single highest (at least 1), plus up to 3 more whose upset
 * potential is at or above a threshold (default 45), at most 4 in all.
 * Games already started keep the pick stored before kickoff and count toward
 * the cap. (The v2.7 "weekly leverage" mode is replaced by this.)
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

export const UPSET_MIN = 1;
export const UPSET_MAX = 4;
export const DEFAULT_SETTINGS = { upsets: true, upsetThreshold: 45, notify: true, publicPct: {} };
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
    upsets: input.upsets == null ? cur.upsets !== false : Boolean(input.upsets),
    upsetThreshold: Math.round(n(input.upsetThreshold ?? cur.upsetThreshold, 45, 20, 90)),
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
  // v2.9: each game's forecast (flagged yellow in the app when it's bad). Open-Meteo, cached by weather.js.
  const wx = await weather.getWeekWeather(season, week, sched).catch((err) => {
    console.warn(`[pickem] Weather unavailable: ${err.message}`);
    return null;
  });
  for (const g of games) {
    g.weather = wx?.byTeam?.[g.home] || null;
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
/**
 * v3.4: favourites everywhere, except the very-high-upset games (see the header).
 * `stored` = Map(gameKey -> pick stored before kickoff) so started games keep
 * their pick and count toward the cap of 4.
 */
export function recommend(board, settings, stored = new Map()) {
  const picks = new Map();
  let lockedUpsets = 0;
  for (const g of board.games) {
    if (!g.favorite) continue;
    if (g.started && stored.has(g.key)) {
      const p = stored.get(g.key);
      const up = p === g.underdog;
      if (up) lockedUpsets++;
      picks.set(g.key, { pick: p, favorite: g.favorite, upset: up, reason: up ? "underdog pick made before kickoff" : "favourite" });
      continue;
    }
    picks.set(g.key, { pick: g.favorite, favorite: g.favorite, upset: false, reason: "favourite" });
  }
  if (settings.upsets !== false) {
    const cands = board.games
      .filter((g) => !g.started && g.favorite && g.underdog && g.dogProb != null)
      .sort((a, b) => (b.upsetPotential ?? 0) - (a.upsetPotential ?? 0) || b.dogProb - a.dogProb);
    const thr = settings.upsetThreshold ?? DEFAULT_SETTINGS.upsetThreshold;
    const room = Math.max(0, UPSET_MAX - lockedUpsets);
    const chosen = [];
    for (const g of cands) {
      if (chosen.length >= room) break;
      const needed = lockedUpsets + chosen.length < UPSET_MIN; // always at least one
      if (needed || (g.upsetPotential ?? 0) >= thr) chosen.push(g);
    }
    for (const g of chosen) {
      picks.set(g.key, {
        pick: g.underdog, favorite: g.favorite, upset: true,
        reason: `upset pick: ${g.underdog} ${Math.round(g.dogProb * 100)}% to win, upset potential ${g.upsetPotential}/100`,
      });
    }
  }
  return picks;
}

/** Picks stored before kickoff for a week (Map gameKey -> pick); started games keep these. */
export function storedPicks(username, season, week) {
  const rows = db.prepare("SELECT game_key, pick FROM pickem_recs WHERE username=? AND season=? AND week=?").all(username, season, week);
  return new Map(rows.map((r) => [r.game_key, r.pick]));
}

/** Stores recommendations, flags changes before kickoff, pushes alerts. Returns the per-game rec rows. */
export async function trackRecs(username, board, settings, { notify = true } = {}) {
  const recs = recommend(board, settings, storedPicks(username, board.season, board.week));
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

/** v3.2: the user's own pick per game (overrides the recommendation) and tiebreaker, per week. */
const choiceKey = (u, season, week) => `pickem_choices:${u}:${season}:${week}`;
export function getChoices(username, season, week) {
  return store.getState(choiceKey(username, season, week), null) || { games: {}, tiebreaker: null };
}
export function saveChoice(username, season, week, { gameKey, pick, tiebreaker }) {
  const cur = getChoices(username, season, week);
  cur.games = { ...(cur.games || {}) };
  if (gameKey) {
    const m = /^([A-Z]{2,4})@([A-Z]{2,4})$/.exec(String(gameKey));
    if (!m) throw new Error("Unknown game.");
    if (pick == null || pick === "") delete cur.games[gameKey];
    else if (pick === m[1] || pick === m[2]) cur.games[gameKey] = pick;
    else throw new Error("That team isn't playing in this game.");
  }
  if (tiebreaker !== undefined) cur.tiebreaker = tiebreaker === "" || tiebreaker == null ? null : Math.max(0, Math.min(200, Math.round(Number(tiebreaker)) || 0));
  store.setState(choiceKey(username, season, week), cur);
  return cur;
}

export function markSeen(username, season, week, gameKey) {
  if (gameKey) db.prepare("UPDATE pickem_recs SET seen=1 WHERE username=? AND season=? AND week=? AND game_key=?").run(username, season, week, gameKey);
  else db.prepare("UPDATE pickem_recs SET seen=1 WHERE username=? AND season=? AND week=?").run(username, season, week);
}

/* ---------------- results + performance (v3.4) ---------------- */
const resultsKey = (season) => `pickem_results:${season}`;
const doneKey = (season) => `pickem_weeks_done:${season}`;

/** Vegas pick = the favourite on the last line stored before kickoff; falls back to the favourite given. */
function vegasPickFor(season, week, key, kickoff, fallbackFav) {
  const row = kickoff
    ? db.prepare("SELECT home_prob FROM pickem_snapshots WHERE season=? AND week=? AND game_key=? AND home_prob IS NOT NULL AND at<? ORDER BY at DESC LIMIT 1").get(season, week, key, kickoff)
    : db.prepare("SELECT home_prob FROM pickem_snapshots WHERE season=? AND week=? AND game_key=? AND home_prob IS NOT NULL ORDER BY at DESC LIMIT 1").get(season, week, key);
  if (!row) return { pick: fallbackFav || null, from: fallbackFav ? "line at final" : null };
  const [away, home] = key.split("@");
  return { pick: row.home_prob >= 0.5 ? home : away, from: "stored line" };
}

/** Favourite from whatever odds ESPN still lists on a finished game (spread first, then moneylines). */
function espnFavourite(g) {
  const o = g.espnOdds;
  if (!o) return null;
  if (o.homeML != null && o.awayML != null) {
    const p = devig(o.homeML, o.awayML);
    if (p != null) return { fav: p >= 0.5 ? g.home : g.away, dogProb: Math.min(p, 1 - p) };
  }
  if (o.homeSpread != null && o.homeSpread !== 0) {
    const p = probFromSpread(o.homeSpread);
    return { fav: o.homeSpread < 0 ? g.home : g.away, dogProb: Math.min(p, 1 - p) };
  }
  return null;
}

/** Remember finished games on a board (winner, Vegas favourite, upset chance). Returns the updated results object. */
function recordResults(board) {
  const res = store.getState(resultsKey(board.season), {}) || {};
  let changed = false;
  for (const g of board.games) {
    if (g.state === "post" && g.homeScore != null && g.awayScore != null) {
      const k = `${board.week}|${g.key}`;
      const winner = g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : "TIE";
      if (!res[k] || !res[k].vegas) {
        const v = vegasPickFor(board.season, board.week, g.key, g.kickoff, g.favorite);
        res[k] = { ...(res[k] || {}), winner, favorite: g.favorite, vegas: v.pick, vegasFrom: v.from, dogProb: g.dogProb ?? null, home: g.home, away: g.away, kickoff: g.kickoff };
        changed = true;
      }
    }
  }
  if (changed) store.setState(resultsKey(board.season), res);
  return res;
}

/** Fill a finished past week from ESPN's scoreboard (winner + whatever odds ESPN still lists). Once, then stored. */
async function backfillWeek(season, week) {
  const done = store.getState(doneKey(season), []) || [];
  if (done.includes(week)) return;
  const sched = await schedule.getWeekSchedule(season, week);
  const games = sched?.games || [];
  if (!games.length) return;
  const res = store.getState(resultsKey(season), {}) || {};
  let allPost = true;
  for (const g of games) {
    if (g.state !== "post") {
      allPost = false;
      continue;
    }
    const home = tank01.normTeam(g.home);
    const away = tank01.normTeam(g.away);
    const key = `${away}@${home}`;
    const k = `${week}|${key}`;
    if (res[k]?.vegas) continue;
    if (g.homeScore == null || g.awayScore == null) continue;
    const winner = g.homeScore > g.awayScore ? home : g.awayScore > g.homeScore ? away : "TIE";
    const v = vegasPickFor(season, week, key, g.kickoffMillis, null);
    const ef = v.pick ? null : espnFavourite({ ...g, home, away });
    res[k] = {
      winner, favorite: v.pick || ef?.fav || null, vegas: v.pick || ef?.fav || null,
      vegasFrom: v.pick ? v.from : ef ? "ESPN odds (back-calculated)" : null,
      dogProb: ef?.dogProb ?? null, home, away, kickoff: g.kickoffMillis,
    };
  }
  store.setState(resultsKey(season), res);
  if (allPost) store.setState(doneKey(season), [...done, week]);
}

/** Season record of the stored (final, pre-kickoff) picks vs always taking the favourite. */
function record(username, board) {
  const rows = db.prepare("SELECT * FROM pickem_recs WHERE username=? AND season=?").all(username, board.season);
  const res = recordResults(board);
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

const tally = () => ({ n: 0, correct: 0 });
const add = (t, pick, winner) => {
  if (!pick) return;
  t.n++;
  if (pick === winner) t.correct++;
};

/**
 * You vs the app vs Vegas vs the actual result, per week and for the season.
 * - Vegas: favourite on the last stored line before kickoff (else ESPN's listed odds for back-calculated weeks).
 * - App: the pick stored before kickoff; where none was stored (weeks before v2.7 tracking), RECONSTRUCTED
 *   by applying the current upset rule to ESPN odds only (no line movement or article data, so at most one upset pick).
 * - You: picks entered in the app (or loaded by hand per game below).
 */
export async function getPerformance(username) {
  const st = await sleeper.getState();
  const season = Number(st.season);
  const curWeek = Number(st.week);
  const settings = getSettings(username);
  // current week from the live board, earlier weeks from ESPN once
  try {
    recordResults(await getBoard({ season, week: curWeek }));
  } catch (e) {
    console.warn(`[pickem] performance: current board failed: ${e.message}`);
  }
  for (let w = 1; w < curWeek; w++) {
    try {
      await backfillWeek(season, w);
    } catch (e) {
      console.warn(`[pickem] performance: week ${w} backfill failed: ${e.message}`);
    }
  }
  const res = store.getState(resultsKey(season), {}) || {};
  const recRows = db.prepare("SELECT week, game_key, pick FROM pickem_recs WHERE username=? AND season=?").all(username, season);
  const recBy = new Map(recRows.map((r) => [`${r.week}|${r.game_key}`, r.pick]));
  const weeks = [];
  const season_ = { vegas: tally(), app: tally(), mine: tally(), appUpsets: tally(), mineUpsets: tally(), same: { n: 0, mine: 0, app: 0, vegas: 0 } };
  for (let w = 1; w <= curWeek; w++) {
    const keys = Object.keys(res).filter((k) => k.startsWith(`${w}|`));
    if (!keys.length) continue;
    const entries = keys.map((k) => ({ key: k.split("|")[1], ...res[k] }));
    // reconstruct the app rule for games with no stored pick
    const recon = recommend(
      {
        games: entries.map((e) => {
          const dog = e.favorite ? (e.favorite === e.home ? e.away : e.home) : null;
          const up = e.dogProb != null ? upsetPotential({ dogProb: e.dogProb, dogShift: 0, mentions: 0 }).score : 0;
          return { key: e.key, home: e.home, away: e.away, favorite: e.favorite, underdog: dog, dogProb: e.dogProb, upsetPotential: up, started: false };
        }),
      },
      settings
    );
    const choices = getChoices(username, season, w).games || {};
    const wk = { week: w, vegas: tally(), app: tally(), mine: tally(), appUpsets: tally(), mineUpsets: tally(), same: { n: 0, mine: 0, app: 0, vegas: 0 }, games: [], appFrom: { stored: 0, reconstructed: 0 } };
    for (const e of entries.sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0))) {
      const stored = recBy.get(`${w}|${e.key}`) || null;
      const rc = e.favorite ? recon.get(e.key) : null;
      const app = stored || (rc?.pick ?? null);
      const appFrom = stored ? "stored" : app ? "reconstructed" : null;
      if (appFrom) wk.appFrom[appFrom]++;
      const mine = choices[e.key] || null;
      const tie = e.winner === "TIE";
      if (!tie) {
        add(wk.vegas, e.vegas, e.winner);
        add(wk.app, app, e.winner);
        add(wk.mine, mine, e.winner);
        if (app && e.vegas && app !== e.vegas) add(wk.appUpsets, app, e.winner);
        if (mine && e.vegas && mine !== e.vegas) add(wk.mineUpsets, mine, e.winner);
        if (mine && e.vegas && app) {
          wk.same.n++;
          if (mine === e.winner) wk.same.mine++;
          if (app === e.winner) wk.same.app++;
          if (e.vegas === e.winner) wk.same.vegas++;
        }
      }
      wk.games.push({
        key: e.key, away: e.away, home: e.home, winner: e.winner, vegas: e.vegas || null, vegasFrom: e.vegasFrom || null,
        app, appFrom, appUpset: Boolean(app && e.vegas && app !== e.vegas), mine,
      });
    }
    wk.appSource = wk.appFrom.stored && wk.appFrom.reconstructed ? "mixed" : wk.appFrom.reconstructed ? "reconstructed" : wk.appFrom.stored ? "stored" : "none";
    weeks.push(wk);
    for (const k of ["vegas", "app", "mine", "appUpsets", "mineUpsets"]) {
      season_[k].n += wk[k].n;
      season_[k].correct += wk[k].correct;
    }
    for (const k of ["n", "mine", "app", "vegas"]) season_.same[k] += wk.same[k];
  }
  return { season, week: curWeek, weeks, season_total: season_, note: "App picks marked reconstructed use ESPN odds only (no line movement or article data), so they can differ from what the app would really have shown." };
}

export async function getPickem(username) {
  const board = await getBoard();
  const settings = getSettings(username);
  const { recs, rows } = await trackRecs(username, board, settings);
  const now = Date.now();
  const choices = getChoices(username, board.season, board.week);
  const games = board.games.map((g) => {
    const r = recs.get(g.key);
    const row = rows.get(g.key);
    return {
      ...g,
      pick: r?.pick ?? null,
      chosen: choices.games?.[g.key] ?? null,
      final: choices.games?.[g.key] ?? r?.pick ?? null,
      reason: r?.reason ?? null,
      upset: r?.upset ?? false,
      pickKind: r?.pick == null ? null : r.pick === g.underdog ? "underdog" : "favourite",
      changed: Boolean(row && row.seen === 0 && row.changed_at && (g.kickoff == null || g.kickoff > now)),
      prevPick: row?.prev_pick ?? null,
      changedAt: row?.changed_at ?? null,
    };
  });
  return { ...board, games, settings, choices: { tiebreaker: choices.tiebreaker ?? null }, record: record(username, board), changedCount: games.filter((g) => g.changed).length };
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
