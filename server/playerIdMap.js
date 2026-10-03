import * as store from "./projectionStore.js";

/**
 * https://github.com/mayscopeland/ffb_ids — a community-maintained CSV
 * crosswalk of NFL player IDs across Sleeper, ESPN, FantasyPros, Yahoo,
 * CBS, NFL.com, and others. Confirmed via the repo's README (fetched
 * directly) to include Sleeper, ESPN, and FantasyPros among its columns.
 *
 * NOT CONFIRMED: the exact header text for each column (e.g. "sleeper_id"
 * vs "sleeperId" vs "sleeper") — GitHub's raw-file path was blocked by
 * this environment's fetch tool specifically (robots-disallowed), so the
 * actual header row was never directly inspected while writing this.
 * That's a tool-specific restriction, not a real access issue — a plain
 * server-side fetch() to raw.githubusercontent.com (a public CDN, no
 * robots.txt enforcement in Node's fetch) is a completely standard,
 * widely-used pattern (pip/npm installs, CI scripts, etc. hit it
 * constantly). To handle the unverified header names honestly, the
 * columns are discovered dynamically at parse time by fuzzy-matching
 * header text (contains "sleeper", "espn", "fantasypros"/"fp", "name")
 * rather than hardcoded, and the discovered mapping is logged once on
 * first load so a mismatch is immediately visible rather than silently
 * returning an empty crosswalk.
 */
const CSV_URL = "https://raw.githubusercontent.com/mayscopeland/ffb_ids/main/player_ids.csv";

let _loggedColumns = false;

/** Minimal CSV parser respecting quoted fields (names can contain commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findColumn(headers, matchers) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const m of matchers) {
    const idx = lower.findIndex((h) => h === m);
    if (idx >= 0) return idx;
  }
  for (const m of matchers) {
    const idx = lower.findIndex((h) => h.includes(m));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * v2.5: the crosswalk now lives in the app's own SQLite table
 * (projectionStore.js `crosswalk`). ffb_ids seeds it weekly — merging new
 * players and filling blanks, never overwriting IDs the app has learned
 * itself (Tank01 IDs, name-matched ESPN IDs).
 */
const SEED_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
let seeding = null;

async function seedFromFfbIds() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`ffb_ids CSV fetch error ${res.status}`);
  const rows = parseCsv(await res.text());
  if (rows.length < 2) return 0;
  const headers = rows[0];
  const col = {
    sleeper: findColumn(headers, ["sleeper_id", "sleeperid", "sleeper"]),
    espn: findColumn(headers, ["espn_id", "espnid", "espn"]),
    fantasypros: findColumn(headers, ["fantasypros_id", "fantasyprosid", "fp_id", "fantasypros", "fpid"]),
    name: findColumn(headers, ["name", "player_name", "player"]),
  };
  if (!_loggedColumns) {
    console.log("[playerIdMap] Discovered columns:", { headers, resolved: col });
    _loggedColumns = true;
  }
  if (col.sleeper === -1) {
    console.warn("[playerIdMap] Couldn't find a sleeper ID column in ffb_ids — seed skipped.");
    return 0;
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const sleeperId = r[col.sleeper]?.trim();
    if (!sleeperId) continue;
    // Keep EVERY column (other sites' IDs — Yahoo, CBS, NFL.com, MFL, PFR,
    // etc.) so they're on hand if the app ever pulls from those sites.
    const allIds = {};
    headers.forEach((h, idx) => {
      const v = r[idx]?.trim();
      if (h && v) allIds[h.trim()] = v;
    });
    out.push({
      allIds,
      sleeperId,
      espnId: col.espn >= 0 ? r[col.espn]?.trim() || null : null,
      fantasyprosId: col.fantasypros >= 0 ? r[col.fantasypros]?.trim() || null : null,
      name: col.name >= 0 ? r[col.name]?.trim() || null : null,
    });
  }
  store.mergeSeedRows(out);
  store.setState("crosswalk_seeded_at", Date.now());
  console.log(`[playerIdMap] Crosswalk seeded/merged from ffb_ids: ${out.length} rows, ${headers.length} ID columns kept (table now ${store.crosswalkCount()}).`);
  return out.length;
}

/** Re-seeds from ffb_ids when the table is empty or the last seed is over a week old. */
export async function ensureCrosswalk() {
  const last = store.getState("crosswalk_seeded_at", 0);
  if (store.crosswalkCount() > 0 && Date.now() - last < SEED_EVERY_MS) return;
  if (!seeding) {
    seeding = seedFromFfbIds()
      .catch((err) => console.warn(`[playerIdMap] Crosswalk seed failed (using the local table as-is): ${err.message}`))
      .finally(() => {
        seeding = null;
      });
  }
  await seeding;
}

/** Returns { espnId, fantasyprosId, tank01Id, name } or null if this Sleeper player isn't in the crosswalk. */
export async function lookupBySleeperId(sleeperId) {
  await ensureCrosswalk();
  const row = store.getCrosswalk(sleeperId);
  if (!row) return null;
  return { espnId: row.espn_id, fantasyprosId: row.fantasypros_id, tank01Id: row.tank01_id, name: row.name };
}
