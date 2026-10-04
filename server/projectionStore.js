import db from "./db.js";

/**
 * v2.5 SQLite tables for projection tracking, lean calibration, the local
 * player-ID crosswalk and the history backfill.
 */
db.exec(`
  -- Local crosswalk: seeded from ffb_ids, extended as players get matched.
  -- *_method records how an ID was learned, so a weaker match never
  -- overwrites a stronger one.
  CREATE TABLE IF NOT EXISTS crosswalk (
    sleeper_id TEXT PRIMARY KEY,
    name TEXT,
    pos TEXT,
    team TEXT,
    espn_id TEXT,
    espn_method TEXT,
    fantasypros_id TEXT,
    tank01_id TEXT,
    tank01_method TEXT,
    -- Every other site's ID we know for this player, as JSON:
    -- { "ffb_ids": { <every column of the ffb_ids CSV> }, "tank01": { espnID, cbsPlayerID, yahooPlayerID, rotoWirePlayerID, fantasyProsPlayerID, ... } }
    ext_ids TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS crosswalk_tank01 ON crosswalk (tank01_id);
  CREATE INDEX IF NOT EXISTS crosswalk_espn ON crosswalk (espn_id);

  -- Scoring profiles: the settings that change projections most (points per
  -- reception, TE premium, points per passing TD). Leagues with the same
  -- profile share lean samples. settings_json keeps one league's full
  -- scoring settings so actual stats can be scored the same way.
  CREATE TABLE IF NOT EXISTS scoring_profiles (
    profile TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Every source's projection per player per week per profile, raw and
  -- lean-adjusted. Rows keep updating until the player's kickoff, then
  -- freeze — so a past week holds what you'd have set your lineup on.
  CREATE TABLE IF NOT EXISTS proj_records (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    source TEXT NOT NULL,
    profile TEXT NOT NULL,
    pos TEXT,
    proj REAL NOT NULL,
    adj_proj REAL,
    kickoff INTEGER,
    backfill INTEGER NOT NULL DEFAULT 0,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (season, week, player_id, source, profile)
  );
  CREATE INDEX IF NOT EXISTS proj_records_week ON proj_records (profile, season, week);

  -- Actual stat lines (Sleeper weekly stats), scored per profile on demand.
  CREATE TABLE IF NOT EXISTS actual_stats (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id)
  );
  CREATE TABLE IF NOT EXISTS actual_weeks (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    players INTEGER NOT NULL,
    PRIMARY KEY (season, week)
  );

  -- Backfill work items and their status.
  CREATE TABLE IF NOT EXISTS backfill_items (
    item TEXT PRIMARY KEY,
    batch INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Column added after the table first shipped — add it to existing databases.
if (!db.prepare("PRAGMA table_info(crosswalk)").all().some((c) => c.name === "ext_ids")) {
  db.exec("ALTER TABLE crosswalk ADD COLUMN ext_ids TEXT");
}

/* ---------------- app state ---------------- */
export function getState(key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setState(key, value) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

/* ---------------- crosswalk ---------------- */
// Tank01's player list is the primary source for the Sleeper <-> ESPN/Tank01
// links (rank 4); ffb_ids fills anything it lacks (3); name matches are last.
const METHOD_RANK = { tank01: 4, tank01_sleeper_id: 4, ffb_ids: 3, espn_id: 2, name_pos_team: 1, name_pos: 1 };
const WEAK_METHODS = "('name_pos', 'name_pos_team', 'espn_id')";

function mergeExt(existingJson, source, ids) {
  let ext = {};
  try {
    ext = existingJson ? JSON.parse(existingJson) : {};
  } catch {
    ext = {};
  }
  const clean = {};
  for (const [k, v] of Object.entries(ids || {})) if (v != null && String(v).trim() !== "") clean[k] = String(v).trim();
  ext[source] = { ...(ext[source] || {}), ...clean };
  return JSON.stringify(ext);
}
export function externalIds(sleeperId) {
  const row = getCrosswalk(sleeperId);
  try {
    return row?.ext_ids ? JSON.parse(row.ext_ids) : {};
  } catch {
    return {};
  }
}

export function crosswalkCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM crosswalk").get().n;
}
export function getCrosswalk(sleeperId) {
  return db.prepare("SELECT * FROM crosswalk WHERE sleeper_id = ?").get(String(sleeperId)) || null;
}
export function allCrosswalk() {
  return db.prepare("SELECT * FROM crosswalk").all();
}
/**
 * Seed/merge from ffb_ids: adds new rows, stores EVERY column of the CSV
 * under ext_ids.ffb_ids, fills a blank or weakly-matched ESPN/FantasyPros
 * ID, and never touches Tank01 IDs or Tank01-supplied links.
 */
export function mergeSeedRows(rows) {
  const now = Date.now();
  const get = db.prepare("SELECT ext_ids FROM crosswalk WHERE sleeper_id = ?");
  const stmt = db.prepare(`
    INSERT INTO crosswalk (sleeper_id, name, espn_id, espn_method, fantasypros_id, ext_ids, updated_at)
    VALUES (@sleeper_id, @name, @espn_id, CASE WHEN @espn_id IS NULL THEN NULL ELSE 'ffb_ids' END, @fantasypros_id, @ext_ids, @now)
    ON CONFLICT(sleeper_id) DO UPDATE SET
      name = COALESCE(crosswalk.name, excluded.name),
      espn_id = CASE WHEN excluded.espn_id IS NOT NULL AND (crosswalk.espn_id IS NULL OR crosswalk.espn_method IN ${WEAK_METHODS}) THEN excluded.espn_id ELSE crosswalk.espn_id END,
      espn_method = CASE WHEN excluded.espn_id IS NOT NULL AND (crosswalk.espn_id IS NULL OR crosswalk.espn_method IN ${WEAK_METHODS}) THEN 'ffb_ids' ELSE crosswalk.espn_method END,
      fantasypros_id = COALESCE(crosswalk.fantasypros_id, excluded.fantasypros_id),
      ext_ids = excluded.ext_ids,
      updated_at = @now
  `);
  const tx = db.transaction((list) => {
    for (const r of list) {
      const sid = String(r.sleeperId);
      const ext = mergeExt(get.get(sid)?.ext_ids, "ffb_ids", r.allIds);
      stmt.run({ sleeper_id: sid, name: r.name || null, espn_id: r.espnId || null, fantasypros_id: r.fantasyprosId || null, ext_ids: ext, now });
    }
  });
  tx(rows);
}

/**
 * Seed/merge from Tank01's player list — the primary source for the
 * Sleeper <-> Tank01/ESPN links. Tank01's playerID is the ESPN player ID.
 * players: [{ sleeperId, tank01Id, espnId, fantasyprosId, name, pos, team, ids }]
 */
export function mergeTank01Players(players) {
  const now = Date.now();
  const get = db.prepare("SELECT ext_ids FROM crosswalk WHERE sleeper_id = ?");
  const stmt = db.prepare(`
    INSERT INTO crosswalk (sleeper_id, name, pos, team, espn_id, espn_method, fantasypros_id, tank01_id, tank01_method, ext_ids, updated_at)
    VALUES (@sid, @name, @pos, @team, @espn, CASE WHEN @espn IS NULL THEN NULL ELSE 'tank01' END, @fp, @tid, 'tank01_sleeper_id', @ext, @now)
    ON CONFLICT(sleeper_id) DO UPDATE SET
      name = COALESCE(crosswalk.name, excluded.name),
      pos = COALESCE(excluded.pos, crosswalk.pos),
      team = COALESCE(excluded.team, crosswalk.team),
      espn_id = COALESCE(excluded.espn_id, crosswalk.espn_id),
      espn_method = CASE WHEN excluded.espn_id IS NOT NULL THEN 'tank01' ELSE crosswalk.espn_method END,
      fantasypros_id = COALESCE(crosswalk.fantasypros_id, excluded.fantasypros_id),
      tank01_id = excluded.tank01_id,
      tank01_method = 'tank01_sleeper_id',
      ext_ids = excluded.ext_ids,
      updated_at = @now
  `);
  const tx = db.transaction((list) => {
    for (const p of list) {
      if (!p.sleeperId || !p.tank01Id) continue;
      const sid = String(p.sleeperId);
      stmt.run({ sid, name: p.name || null, pos: p.pos || null, team: p.team || null, espn: p.espnId ? String(p.espnId) : null, fp: p.fantasyprosId ? String(p.fantasyprosId) : null, tid: String(p.tank01Id), ext: mergeExt(get.get(sid)?.ext_ids, "tank01", p.ids), now });
    }
  });
  tx(players);
}

/** Records a learned ID unless an equal-or-stronger match is already stored. */
export function learnId(sleeperId, kind, id, method, meta = {}) {
  if (!sleeperId || !id) return false;
  const col = kind === "tank01" ? "tank01" : "espn";
  const row = getCrosswalk(sleeperId);
  if (row && row[`${col}_id`] && (METHOD_RANK[row[`${col}_method`]] || 0) >= (METHOD_RANK[method] || 0)) return false;
  if (row && row[`${col}_id`] === String(id)) return false;
  db.prepare(`
    INSERT INTO crosswalk (sleeper_id, name, pos, team, ${col}_id, ${col}_method, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sleeper_id) DO UPDATE SET ${col}_id = excluded.${col}_id, ${col}_method = excluded.${col}_method,
      name = COALESCE(crosswalk.name, excluded.name), pos = COALESCE(excluded.pos, crosswalk.pos), team = COALESCE(excluded.team, crosswalk.team),
      updated_at = excluded.updated_at
  `).run(String(sleeperId), meta.name || null, meta.pos || null, meta.team || null, String(id), method, Date.now());
  return true;
}

/* ---------------- scoring profiles ---------------- */
export function profileOf(settings = {}) {
  const rec = Number(settings.rec ?? 0);
  const te = Number(settings.bonus_rec_te ?? 0);
  const ptd = Number(settings.pass_td ?? 4);
  return { key: `rec${rec}|te${te}|ptd${ptd}`, label: `${rec === 1 ? "Full PPR" : rec === 0.5 ? "Half PPR" : rec === 0 ? "Standard" : `${rec} PPR`}${te ? ` +${te} TE` : ""}, ${ptd}-pt pass TD` };
}
export function rememberProfile(settings) {
  const p = profileOf(settings);
  db.prepare("INSERT INTO scoring_profiles (profile, settings_json, label, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(profile) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at").run(
    p.key, JSON.stringify(settings || {}), p.label, Date.now()
  );
  return p;
}
export function listProfiles() {
  return db.prepare("SELECT profile, label, settings_json FROM scoring_profiles ORDER BY profile").all().map((r) => ({ ...r, settings: JSON.parse(r.settings_json) }));
}

/* ---------------- projection records ---------------- */
/**
 * Upserts rows. A row whose stored kickoff has passed is frozen (never
 * overwritten) unless `allowFrozen` (backfill) is set.
 */
// v2.9: only fantasy positions are recorded for accuracy (QB/RB/WR/TE/K/DEF).
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
export function recordProjections(rows, { allowFrozen = false } = {}) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO proj_records (season, week, player_id, source, profile, pos, proj, adj_proj, kickoff, backfill, recorded_at)
    VALUES (@season, @week, @player_id, @source, @profile, @pos, @proj, @adj_proj, @kickoff, @backfill, @now)
    ON CONFLICT(season, week, player_id, source, profile) DO UPDATE SET
      pos = excluded.pos, proj = excluded.proj, adj_proj = excluded.adj_proj, kickoff = excluded.kickoff,
      backfill = excluded.backfill, recorded_at = excluded.recorded_at
    WHERE @allow = 1 OR proj_records.kickoff IS NULL OR proj_records.kickoff > @now
  `);
  const tx = db.transaction((list) => {
    for (const r of list) if (FANTASY_POS.has(r.pos)) stmt.run({ ...r, adj_proj: r.adj_proj ?? null, kickoff: r.kickoff ?? null, backfill: r.backfill ? 1 : 0, now, allow: allowFrozen ? 1 : 0 });
  });
  tx(rows);
}
export function projRows({ profile, season, weeks, source, pos } = {}) {
  const where = ["1 = 1"];
  const args = [];
  if (profile) (where.push("profile = ?"), args.push(profile));
  if (season) (where.push("season = ?"), args.push(Number(season)));
  if (weeks?.length) where.push(`week IN (${weeks.map(Number).join(",")})`);
  if (source) (where.push("source = ?"), args.push(source));
  if (pos) (where.push("pos = ?"), args.push(pos));
  return db.prepare(`SELECT * FROM proj_records WHERE ${where.join(" AND ")}`).all(...args);
}
export function recordedWeeks() {
  return db.prepare("SELECT season, week, profile, COUNT(*) AS n, MAX(backfill) AS backfill FROM proj_records GROUP BY season, week, profile ORDER BY season, week").all();
}

/* ---------------- actuals ---------------- */
export function saveActuals(season, week, statsById) {
  const stmt = db.prepare("INSERT INTO actual_stats (season, week, player_id, stats_json) VALUES (?, ?, ?, ?) ON CONFLICT(season, week, player_id) DO UPDATE SET stats_json = excluded.stats_json");
  const tx = db.transaction(() => {
    let n = 0;
    for (const [id, stats] of Object.entries(statsById)) {
      stmt.run(Number(season), Number(week), String(id), JSON.stringify(stats));
      n++;
    }
    db.prepare("INSERT INTO actual_weeks (season, week, fetched_at, players) VALUES (?, ?, ?, ?) ON CONFLICT(season, week) DO UPDATE SET fetched_at = excluded.fetched_at, players = excluded.players").run(
      Number(season), Number(week), Date.now(), n
    );
  });
  tx();
}
export function actualWeek(season, week) {
  return db.prepare("SELECT * FROM actual_weeks WHERE season = ? AND week = ?").get(Number(season), Number(week)) || null;
}
export function actualsFor(season, weeks) {
  if (!weeks?.length) return [];
  return db.prepare(`SELECT * FROM actual_stats WHERE season = ? AND week IN (${weeks.map(Number).join(",")})`).all(Number(season));
}
export function weeksNeedingActuals() {
  return db.prepare(`
    SELECT DISTINCT p.season, p.week FROM proj_records p
    LEFT JOIN actual_weeks a ON a.season = p.season AND a.week = p.week
    WHERE a.season IS NULL ORDER BY p.season, p.week
  `).all();
}

/* ---------------- backfill items ---------------- */
export function setItem(item, batch, status, note = null) {
  db.prepare("INSERT INTO backfill_items (item, batch, status, note, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(item) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at").run(
    item, batch, status, note, Date.now()
  );
}
export function getItem(item) {
  return db.prepare("SELECT * FROM backfill_items WHERE item = ?").get(item) || null;
}
export function itemSummary() {
  return db.prepare("SELECT batch, status, COUNT(*) AS n FROM backfill_items GROUP BY batch, status ORDER BY batch, status").all();
}
