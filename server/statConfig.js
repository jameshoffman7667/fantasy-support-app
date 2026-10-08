import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import { DEFS, publicDefs } from "./statDefs.js";
import { readXlsx, writeXlsx } from "./xlsxLite.js";

/**
 * v4.2: the stats list — which stats the Waivers "All" tab and Analytics → Scouting offer, with their names,
 * categories, type (Projection / Stat / Both / Neither) and positions. It starts from config/stats-config.json
 * (James's spreadsheet of 2026-10-07) and lives in the `stat_config` table; uploading the spreadsheet again
 * replaces every column he changed. IDs tie a row to how the app works the stat out (statDefs.js), so a row
 * with an unknown ID is reported and ignored, and a known ID missing from the upload is switched off (No).
 */
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(DIR, "config", "stats-config.json");

db.exec(`
  CREATE TABLE IF NOT EXISTS stat_config (
    id TEXT PRIMARY KEY, stat TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL, in_dropdown INTEGER NOT NULL,
    positions TEXT, data_from TEXT, notes TEXT, sort_order INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
  );
`);
// v4.3: short column titles for Scouting ("Abbrev" in the spreadsheet)
if (!db.prepare("PRAGMA table_info(stat_config)").all().some((c) => c.name === "abbrev")) db.exec("ALTER TABLE stat_config ADD COLUMN abbrev TEXT");

export const TYPES = ["Projection", "Stat", "Both", "Neither"];
export const HEADERS = ["ID", "Stat", "Abbrev", "Category", "Type", "In drop-down", "Positions", "Data from", "Notes"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** "QB, RB" / "All" → ["QB","RB"] (All = every position). */
export function parsePositions(text) {
  const t = String(text || "").trim();
  if (!t || /^all$/i.test(t)) return [...POSITIONS];
  const list = t.toUpperCase().replace(/D\/ST|\bDST\b/g, "DEF").split(/[,/ ]+/).map((x) => x.trim()).filter((x) => POSITIONS.includes(x));
  return list.length ? [...new Set(list)] : [...POSITIONS];
}

function seed() {
  const have = new Set(db.prepare("SELECT id FROM stat_config").all().map((r) => r.id));
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(SEED, "utf8")).rows || [];
  } catch (err) {
    console.warn(`[statConfig] Couldn't read ${SEED}: ${err.message}`);
  }
  const ins = db.prepare("INSERT INTO stat_config (id, stat, category, type, in_dropdown, positions, data_from, notes, sort_order, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  let added = 0;
  for (const r of rows) {
    if (have.has(r.id) || !DEFS[r.id]) continue;
    ins.run(r.id, r.stat, r.category, TYPES.includes(r.type) ? r.type : "Stat", r.inDropdown ? 1 : 0, r.positions || "All", r.dataFrom || "", r.notes || "", Number(r.order) || 0, Date.now(), "seed");
    added++;
  }
  if (added) console.log(`[statConfig] Seeded ${added} stats from config/stats-config.json.`);
  // v4.3: fill in abbreviations the table doesn't have yet (an upload's own abbreviations are never overwritten)
  const fill = db.prepare("UPDATE stat_config SET abbrev = ? WHERE id = ? AND abbrev IS NULL");
  for (const r of rows) if (r.abbrev) fill.run(r.abbrev, r.id);
}
seed();

const toRow = (r) => ({
  id: r.id,
  stat: r.stat,
  abbrev: r.abbrev || r.stat,
  category: r.category,
  type: r.type,
  inDropdown: Boolean(r.in_dropdown),
  positionsText: r.positions || "All",
  positions: parsePositions(r.positions),
  dataFrom: r.data_from || "",
  notes: r.notes || "",
  order: r.sort_order,
});

export function list() {
  return db.prepare("SELECT * FROM stat_config ORDER BY sort_order, id").all().map(toRow);
}

/** Everything the client needs: rows + per-stat definitions/sources/directions. */
export function forClient() {
  const defs = publicDefs();
  return { rows: list().filter((r) => defs[r.id]), defs, at: db.prepare("SELECT MAX(updated_at) AS at FROM stat_config").get()?.at || null };
}

/**
 * Validates spreadsheet rows (header row first) without saving. Returns { rows, errors, unknown, missing }.
 * Header names are matched case-insensitively and in any order.
 */
export function parseSheetRows(table) {
  const errors = [];
  const header = (table[0] || []).map((h) => String(h ?? "").trim().toLowerCase());
  const col = Object.fromEntries(HEADERS.map((h) => [h, header.indexOf(h.toLowerCase())]));
  for (const h of ["ID", "Stat", "Category", "Type", "In drop-down"]) if (col[h] < 0) errors.push(`Column "${h}" is missing.`);
  if (errors.length) return { rows: [], errors, unknown: [], missing: [] };
  const known = new Set(Object.keys(DEFS));
  const rows = [];
  const unknown = [];
  const seen = new Set();
  table.slice(1).forEach((r, i) => {
    const get = (h) => (col[h] >= 0 ? r[col[h]] : null);
    const id = String(get("ID") ?? "").trim();
    if (!id) return;
    const line = i + 2;
    if (!known.has(id)) return unknown.push(id);
    if (seen.has(id)) return errors.push(`Row ${line}: ${id} appears twice.`);
    seen.add(id);
    const typeRaw = String(get("Type") ?? "").trim();
    const type = TYPES.find((t) => t.toLowerCase() === typeRaw.toLowerCase());
    if (!type) errors.push(`Row ${line} (${id}): Type must be Projection, Stat, Both or Neither — "${typeRaw}".`);
    const yn = String(get("In drop-down") ?? "").trim().toLowerCase();
    if (!["yes", "no", "y", "n", "true", "false"].includes(yn)) errors.push(`Row ${line} (${id}): In drop-down must be Yes or No — "${get("In drop-down")}".`);
    const stat = String(get("Stat") ?? "").trim();
    if (!stat) errors.push(`Row ${line} (${id}): Stat (the name) is empty.`);
    const abbrevCell = col.Abbrev >= 0 ? String(get("Abbrev") ?? "").trim().slice(0, 16) : null;
    rows.push({
      id,
      stat: stat.slice(0, 80),
      abbrev: abbrevCell, // null = the sheet has no Abbrev column (keep what's there); "" = use the name
      category: String(get("Category") ?? "").trim().slice(0, 40) || "General",
      type: type || "Stat",
      inDropdown: ["yes", "y", "true"].includes(yn),
      positions: String(get("Positions") ?? "All").trim().slice(0, 60) || "All",
      dataFrom: String(get("Data from") ?? "").trim().slice(0, 40),
      notes: String(get("Notes") ?? "").trim().slice(0, 200),
      order: rows.length,
    });
  });
  const missing = [...known].filter((id) => !seen.has(id) && list().some((r) => r.id === id));
  return { rows, errors, unknown, missing };
}

/** Imports the spreadsheet (a Buffer). Nothing is saved when there are errors. */
export function importXlsx(buf, username) {
  const sheets = readXlsx(buf);
  const name = Object.keys(sheets).find((n) => n.toLowerCase() === "stats") || Object.keys(sheets)[0];
  if (!name) throw new Error("The workbook has no sheets.");
  const parsed = parseSheetRows(sheets[name]);
  if (parsed.errors.length) return { ok: false, ...parsed, changed: 0 };
  const before = new Map(list().map((r) => [r.id, r]));
  const up = db.prepare(
    "INSERT INTO stat_config (id, stat, abbrev, category, type, in_dropdown, positions, data_from, notes, sort_order, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stat=excluded.stat, abbrev=excluded.abbrev, category=excluded.category, type=excluded.type, in_dropdown=excluded.in_dropdown, positions=excluded.positions, data_from=excluded.data_from, notes=excluded.notes, sort_order=excluded.sort_order, updated_at=excluded.updated_at, updated_by=excluded.updated_by"
  );
  const off = db.prepare("UPDATE stat_config SET in_dropdown = 0, updated_at = ?, updated_by = ? WHERE id = ?");
  let changed = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const r of parsed.rows) {
      const b = before.get(r.id);
      const rawAbbrev = b ? db.prepare("SELECT abbrev FROM stat_config WHERE id = ?").get(r.id)?.abbrev ?? null : null;
      const abbrev = r.abbrev === null ? rawAbbrev : r.abbrev; // "" = use the full name (kept as "", never refilled)
      const same = b && b.stat === r.stat && (rawAbbrev ?? null) === (abbrev ?? null) && b.category === r.category && b.type === r.type && b.inDropdown === r.inDropdown && b.positionsText === r.positions && b.dataFrom === r.dataFrom && b.notes === r.notes && b.order === r.order;
      if (same) continue;
      up.run(r.id, r.stat, abbrev, r.category, r.type, r.inDropdown ? 1 : 0, r.positions, r.dataFrom, r.notes, r.order, now, username || null);
      changed++;
    }
    for (const id of parsed.missing) {
      if (before.get(id)?.inDropdown) {
        off.run(now, username || null, id);
        changed++;
      }
    }
  })();
  return { ok: true, rows: parsed.rows.length, changed, unknown: parsed.unknown, missing: parsed.missing, errors: [] };
}

/** The current list as the spreadsheet James edits (same columns and IDs). */
export function exportXlsx() {
  const rows = list();
  return writeXlsx([
    {
      name: "Stats",
      header: true,
      freeze: true,
      widths: [16, 42, 12, 22, 12, 13, 18, 22, 36],
      lists: [{ col: 4, values: TYPES }, { col: 5, values: ["Yes", "No"] }],
      rows: [HEADERS, ...rows.map((r) => [r.id, r.stat, r.abbrev, r.category, r.type, r.inDropdown ? "Yes" : "No", r.positionsText, r.dataFrom, r.notes])],
    },
    {
      name: "How to use",
      wrap: true,
      widths: [110],
      rows: [
        ["How to use this sheet"],
        ["In drop-down: Yes = offered in the Waivers → All sort list and on Analytics → Scouting; No = left out."],
        ["Type: Projection, Stat, Both or Neither — which side of the Projection / Stats switch offers the stat."],
        ["Stat (the name shown in the app), Abbrev (the short column title on Scouting), Category, Positions, Data from and Notes can be changed too. Row order = order in the drop-downs."],
        ["Don't change the ID column — it's how the app matches each row. Unknown IDs are reported and ignored; a deleted row is switched to No."],
        ["Upload it again from Analytics → Scouting → Stats list."],
      ],
    },
  ]);
}
