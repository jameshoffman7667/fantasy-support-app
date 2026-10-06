import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * v3.5 — nflverse's free data releases (github.com/nflverse/nflverse-data), for the player card's game log,
 * career table, team ranks and advanced stats. Verified reachable and current for 2026 while building v3.5.
 *
 * Files are downloaded as needed, kept on disk under DATA_DIR/nflverse (so a restart doesn't re-download), and
 * parsed into slim rows (only the columns the app uses). Current-season files are refreshed after 12 hours,
 * earlier seasons after 30 days, the players file after 7 days. A failed download falls back to the copy on
 * disk, however old.
 */
const REL = process.env.NFLVERSE_BASE || "https://github.com/nflverse/nflverse-data/releases/download";
const DATA_DIR = process.env.DATA_DIR || "./data";
const CACHE_DIR = path.join(DATA_DIR, "nflverse");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** RFC 4180 CSV → array of row arrays (quoted fields may hold commas, quotes and newlines). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inQuotes) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // copy a run of plain characters at once
      let j = i;
      while (j < n && text.charCodeAt(j) !== 34) j++;
      field += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 34) {
      inQuotes = true;
      i++;
    } else if (c === 44) {
      row.push(field);
      field = "";
      i++;
    } else if (c === 10 || c === 13) {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    } else {
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 44 || d === 10 || d === 13 || d === 34) break;
        j++;
      }
      field += text.slice(i, j);
      i = j;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const num = (v) => {
  if (v === undefined || v === null || v === "" || v === "NA") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** CSV text → objects with only `columns` ({ name: 'num'|'str' }). */
export function parseCsv(text, columns) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0];
  const idx = Object.entries(columns).map(([name, type]) => [name, header.indexOf(name), type]).filter(([, i]) => i !== -1);
  const out = new Array(rows.length - 1);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const o = {};
    for (const [name, i, type] of idx) o[name] = type === "num" ? num(row[i]) : row[i] === "NA" ? "" : row[i] ?? "";
    out[r - 1] = o;
  }
  return out;
}

let fetchImpl = (...a) => fetch(...a);
export function _setFetchForTests(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
  memo.clear();
}

/** Text of one release file, from disk when fresh enough, else downloaded (gzip handled). */
async function fileText(relPath, ttlMs) {
  const local = path.join(CACHE_DIR, relPath.replace(/\//g, "__").replace(/\.gz$/, ""));
  let stat = null;
  try {
    stat = fs.statSync(local);
  } catch {
    stat = null;
  }
  if (stat && Date.now() - stat.mtimeMs < ttlMs) return fs.readFileSync(local, "utf8");
  try {
    const res = await fetchImpl(`${REL}/${relPath}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (relPath.endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
    const text = buf.toString("utf8");
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(local, text);
    } catch (err) {
      console.warn(`[nflverse] couldn't save ${relPath}: ${err.message}`);
    }
    return text;
  } catch (err) {
    if (stat) {
      console.warn(`[nflverse] ${relPath}: ${err.message} — using the copy from ${new Date(stat.mtimeMs).toISOString()}`);
      return fs.readFileSync(local, "utf8");
    }
    throw err;
  }
}

const memo = new Map(); // key -> { at, ttl, promise }
function memoized(key, ttlMs, loader) {
  const m = memo.get(key);
  if (m && Date.now() - m.at < ttlMs) return m.promise;
  const promise = loader().catch((err) => {
    memo.delete(key);
    throw err;
  });
  memo.set(key, { at: Date.now(), promise });
  return promise;
}

const ttlFor = (season, currentSeason) => (Number(season) >= Number(currentSeason) ? 12 * HOUR : 30 * DAY);

const WEEKLY_COLS = {
  player_id: "str", player_display_name: "str", position: "str", season: "num", week: "num", season_type: "str", game_id: "str", team: "str", opponent_team: "str",
  completions: "num", attempts: "num", passing_yards: "num", passing_tds: "num", passing_interceptions: "num", sacks_suffered: "num",
  passing_air_yards: "num", passing_epa: "num", passing_cpoe: "num", passing_2pt_conversions: "num",
  carries: "num", rushing_yards: "num", rushing_tds: "num", rushing_fumbles_lost: "num", rushing_epa: "num", rushing_2pt_conversions: "num",
  receptions: "num", targets: "num", receiving_yards: "num", receiving_tds: "num", receiving_fumbles_lost: "num", receiving_air_yards: "num",
  receiving_yards_after_catch: "num", receiving_epa: "num", receiving_2pt_conversions: "num", target_share: "num", air_yards_share: "num", wopr: "num", racr: "num",
  sack_fumbles_lost: "num", special_teams_tds: "num", fg_made: "num", fg_att: "num", pat_made: "num", pat_att: "num",
  fantasy_points: "num", fantasy_points_ppr: "num",
};
export function weekly(season, currentSeason = season) {
  return memoized(`weekly:${season}`, ttlFor(season, currentSeason), async () =>
    parseCsv(await fileText(`stats_player/stats_player_week_${season}.csv`, ttlFor(season, currentSeason)), WEEKLY_COLS).filter((r) => r.season_type === "REG")
  );
}

const SEASON_COLS = {
  player_id: "str", player_display_name: "str", position: "str", season: "num", recent_team: "str", games: "num",
  completions: "num", attempts: "num", passing_yards: "num", passing_tds: "num", passing_interceptions: "num",
  carries: "num", rushing_yards: "num", rushing_tds: "num", receptions: "num", targets: "num", receiving_yards: "num", receiving_tds: "num",
  fg_made: "num", fg_att: "num", fantasy_points: "num", fantasy_points_ppr: "num",
};
export function seasonTotals(season, currentSeason) {
  return memoized(`season:${season}`, 30 * DAY, async () => parseCsv(await fileText(`stats_player/stats_player_reg_${season}.csv`, ttlFor(season, currentSeason)), SEASON_COLS));
}

const TEAM_COLS = {
  season: "num", week: "num", team: "str", season_type: "str", opponent_team: "str", attempts: "num", completions: "num", sacks_suffered: "num",
  passing_yards: "num", passing_tds: "num", passing_air_yards: "num", carries: "num", rushing_yards: "num", rushing_tds: "num",
  targets: "num", receptions: "num", receiving_yards: "num", receiving_air_yards: "num",
};
export function teamWeekly(season, currentSeason = season) {
  return memoized(`team:${season}`, ttlFor(season, currentSeason), async () =>
    parseCsv(await fileText(`stats_team/stats_team_week_${season}.csv`, ttlFor(season, currentSeason)), TEAM_COLS).filter((r) => !r.season_type || r.season_type === "REG")
  );
}

const SNAP_COLS = { pfr_player_id: "str", player: "str", position: "str", team: "str", week: "num", game_type: "str", offense_snaps: "num", offense_pct: "num" };
export function snaps(season, currentSeason = season) {
  return memoized(`snaps:${season}`, ttlFor(season, currentSeason), async () =>
    parseCsv(await fileText(`snap_counts/snap_counts_${season}.csv`, ttlFor(season, currentSeason)), SNAP_COLS).filter((r) => !r.game_type || r.game_type === "REG")
  );
}

const PFR_COLS = {
  rec: { pfr_player_id: "str", week: "num", game_type: "str", team: "str", receiving_broken_tackles: "num", receiving_drop: "num", receiving_drop_pct: "num", receiving_int: "num", receiving_rat: "num" },
  rush: { pfr_player_id: "str", week: "num", game_type: "str", team: "str", carries: "num", rushing_yards_before_contact: "num", rushing_yards_after_contact: "num", rushing_broken_tackles: "num" },
  pass: { pfr_player_id: "str", week: "num", game_type: "str", team: "str", passing_drops: "num", passing_bad_throws: "num", times_sacked: "num", times_blitzed: "num", times_hurried: "num", times_hit: "num", times_pressured: "num" },
};
export function pfr(kind, season, currentSeason = season) {
  return memoized(`pfr:${kind}:${season}`, ttlFor(season, currentSeason), async () =>
    parseCsv(await fileText(`pfr_advstats/advstats_week_${kind}_${season}.csv`, ttlFor(season, currentSeason)), PFR_COLS[kind]).filter((r) => !r.game_type || r.game_type === "REG")
  );
}

const NGS_COLS = {
  receiving: { season: "num", season_type: "str", week: "num", player_gsis_id: "str", player_position: "str", team_abbr: "str", avg_cushion: "num", avg_separation: "num", avg_intended_air_yards: "num", percent_share_of_intended_air_yards: "num", targets: "num", avg_yac_above_expectation: "num" },
  rushing: { season: "num", season_type: "str", week: "num", player_gsis_id: "str", player_position: "str", team_abbr: "str", efficiency: "num", percent_attempts_gte_eight_defenders: "num", avg_time_to_los: "num", rush_attempts: "num", rush_yards_over_expected_per_att: "num", rush_pct_over_expected: "num" },
  passing: { season: "num", season_type: "str", week: "num", player_gsis_id: "str", player_position: "str", team_abbr: "str", avg_time_to_throw: "num", avg_intended_air_yards: "num", aggressiveness: "num", attempts: "num", completion_percentage_above_expectation: "num" },
};
/** Next Gen Stats rows for one season (week 0 = season to date). One file holds every season. */
export function ngs(kind, season) {
  return memoized(`ngs:${kind}:${season}`, 12 * HOUR, async () =>
    parseCsv(await fileText(`nextgen_stats/ngs_${kind}.csv.gz`, 12 * HOUR), NGS_COLS[kind]).filter((r) => r.season === Number(season) && (!r.season_type || r.season_type === "REG"))
  );
}

const PLAYER_COLS = {
  gsis_id: "str", display_name: "str", position: "str", birth_date: "str", height: "num", weight: "num", jersey_number: "num", college_name: "str",
  rookie_season: "num", last_season: "num", latest_team: "str", years_of_experience: "num", draft_year: "num", draft_round: "num", draft_pick: "num", draft_team: "str",
  pfr_id: "str", espn_id: "str", headshot: "str", status: "str",
};
/** nflverse player directory: { byGsis: Map, byEspn: Map } (players active since 2010). */
export function players() {
  return memoized("players", 7 * DAY, async () => {
    const rows = parseCsv(await fileText("players/players.csv", 7 * DAY), PLAYER_COLS).filter((r) => r.gsis_id && (r.last_season == null || r.last_season >= 2010));
    const byGsis = new Map();
    const byEspn = new Map();
    for (const r of rows) {
      byGsis.set(r.gsis_id, r);
      if (r.espn_id) byEspn.set(String(r.espn_id).replace(/\.0$/, ""), r);
    }
    return { byGsis, byEspn };
  });
}
