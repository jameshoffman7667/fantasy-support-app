import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import db from "./db.js";

/**
 * v2.5: pulls actual stat lines for finished weeks (Sleeper weekly stats)
 * for every player who has a recorded projection that week. Stored raw and
 * scored per scoring profile when the accuracy dashboard asks.
 */
function idsRecorded(season, week) {
  return new Set(db.prepare("SELECT DISTINCT player_id FROM proj_records WHERE season = ? AND week = ?").all(Number(season), Number(week)).map((r) => r.player_id));
}

export async function fetchActuals(season, week) {
  const data = await sleeper.getWeekStats(season, week);
  const want = idsRecorded(season, week);
  const out = {};
  for (const [id, stats] of Object.entries(data || {})) {
    if (id.startsWith("TEAM_") || !want.has(id) || !stats) continue;
    const clean = {};
    for (const [k, v] of Object.entries(stats)) {
      const n = Number(v);
      if (Number.isFinite(n)) clean[k] = n;
    }
    out[id] = clean;
  }
  store.saveActuals(season, week, out);
  console.log(`[actuals] ${season} week ${week}: stored actual stats for ${Object.keys(out).length} of ${want.size} projected players.`);
  return Object.keys(out).length;
}

/** Fetches actuals for every recorded week that has finished and has none yet. */
export async function updateActuals() {
  const st = await sleeper.getState();
  const curSeason = Number(st.season);
  const curWeek = Number(st.week);
  for (const { season, week } of store.weeksNeedingActuals()) {
    const finished = season < curSeason || (season === curSeason && week < curWeek);
    if (!finished) continue;
    try {
      await fetchActuals(season, week);
    } catch (err) {
      console.warn(`[actuals] ${season} week ${week}: ${err.message}`);
    }
  }
}
