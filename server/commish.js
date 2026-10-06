import zlib from "node:zlib";
import { createHash } from "node:crypto";
import db from "./db.js";
import * as sleeper from "./sleeper.js";
import * as store from "./projectionStore.js";
import * as gemini from "./gemini.js";

/**
 * v3.8 — Commish: league charters for the leagues James commissions.
 *
 * A charter is a Google Docs / Drive link shared "Anyone with the link" (read only — preferred) or an uploaded
 * file (PDF, Word .docx, text or Markdown). Gemini reads it once when it's added and builds a dated checklist of
 * commissioner actions; links are re-read each July only when the document changed (at most one Gemini read a
 * day, so a dozen charters spread across the month). Actions can be edited, added, deleted and ticked; yearly
 * ones roll forward a year when ticked; an action tied to a Sleeper setting ticks itself when the League page's
 * settings change log shows that setting being changed. Proposed and approved rule changes are recorded, and
 * Gemini can draft an updated charter in Markdown from the approved ones. A charter follows its league into the
 * next season (Sleeper's previous_league_id).
 *
 * Status per charter (Commish cards, the league's "Commish" box): red if an open action is due within 7 days (or
 * overdue), yellow within 30 days, else ok.
 *
 * UNVERIFIED from the build sandbox: Google's export URLs for shared docs (docs.google.com/.../export?format=txt,
 * drive.google.com/uc?export=download), Gemini's replies, and Sleeper's is_owner flag for commissioners.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS commish_files (
    username TEXT NOT NULL, league_id TEXT NOT NULL, name TEXT, mime TEXT, data BLOB, hash TEXT, at INTEGER,
    PRIMARY KEY (username, league_id)
  );
`);

const KEY = (u, l) => `commish:charter:${u}:${l}`;
const INDEX = (u) => `commish:index:${u}`;
const DAY = 86400e3;
export const MAX_TEXT = 300000;
export const MAX_UPLOAD = 10 * 1024 * 1024;

/* ---------------- documents (pure helpers) ---------------- */
/** Google Docs / Drive share link → a direct download URL. Other http(s) links are fetched as they are. */
export function docLinkToUrl(link) {
  const s = String(link || "").trim();
  let m = s.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return { url: `https://docs.google.com/document/d/${m[1]}/export?format=txt`, kind: "gdoc", id: m[1] };
  m = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([A-Za-z0-9_-]{10,})/);
  if (m) return { url: `https://drive.google.com/uc?export=download&id=${m[1]}`, kind: "gdrive", id: m[1] };
  if (/^https?:\/\/[^\s]+$/i.test(s)) return { url: s, kind: "url", id: null };
  return null;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? all));

/** HTML → readable text (paragraph and line breaks kept). */
export function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Minimal ZIP reader (central directory; stored and deflated entries) → Map(name → Buffer). */
export function unzip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Word .docx → text (paragraphs on their own lines). */
export function docxToText(buf) {
  const files = unzip(buf);
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("no word/document.xml in the file");
  return decodeEntities(
    xml
      .toString("utf8")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const sha = (b) => createHash("sha1").update(b).digest("hex");

/**
 * Turns raw bytes + mime/name into { text } or { pdfBase64 } plus a hash. Throws with a readable message for
 * things it can't read (e.g. a Google sign-in page = the doc isn't shared by link).
 */
export function readDocument(buf, { mime = "", name = "" } = {}) {
  const m = String(mime).toLowerCase();
  const n = String(name).toLowerCase();
  const hash = sha(buf);
  if (m.includes("pdf") || n.endsWith(".pdf") || buf.slice(0, 5).toString("latin1") === "%PDF-") return { pdfBase64: buf.toString("base64"), text: null, hash, kind: "pdf" };
  if (m.includes("officedocument.wordprocessingml") || n.endsWith(".docx") || (buf[0] === 0x50 && buf[1] === 0x4b)) return { text: docxToText(buf).slice(0, MAX_TEXT), pdfBase64: null, hash, kind: "docx" };
  const raw = buf.toString("utf8");
  if (/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(raw) && /<html/i.test(raw)) throw new Error("Google asked for a sign-in — share the document as \"Anyone with the link can view\" and try again.");
  if (m.includes("html") || /^\s*<(!doctype|html)/i.test(raw)) return { text: htmlToText(raw).slice(0, MAX_TEXT), pdfBase64: null, hash, kind: "html" };
  return { text: raw.slice(0, MAX_TEXT), pdfBase64: null, hash, kind: "text" };
}

async function fetchLink(link) {
  const target = docLinkToUrl(link);
  if (!target) throw new Error("That doesn't look like a link.");
  const res = await fetch(target.url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (fantasy-manager charter reader)" } });
  if (!res.ok) throw new Error(`The document couldn't be downloaded (HTTP ${res.status}). Is it shared as "Anyone with the link"?`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_UPLOAD) throw new Error("The document is larger than 10 MB.");
  return readDocument(buf, { mime: res.headers.get?.("content-type") || "", name: "" });
}

/* ---------------- storage ---------------- */
const nowIso = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function listIds(username) {
  return store.getState(INDEX(username), []) || [];
}
function setIndex(username, ids) {
  store.setState(INDEX(username), [...new Set(ids.map(String))]);
}
export function getCharter(username, leagueId) {
  return store.getState(KEY(username, leagueId), null);
}
function saveCharter(username, c) {
  c.updatedAt = Date.now();
  store.setState(KEY(username, c.leagueId), c);
  setIndex(username, [...listIds(username), c.leagueId]);
  return c;
}
export function deleteCharter(username, leagueId) {
  store.setState(KEY(username, leagueId), null);
  setIndex(username, listIds(username).filter((id) => id !== String(leagueId)));
  db.prepare("DELETE FROM commish_files WHERE username = ? AND league_id = ?").run(username, String(leagueId));
}
function saveFile(username, leagueId, { name, mime, buf, hash }) {
  db.prepare("INSERT OR REPLACE INTO commish_files (username, league_id, name, mime, data, hash, at) VALUES (?,?,?,?,?,?,?)").run(username, String(leagueId), name || null, mime || null, buf, hash, Date.now());
}
function getFile(username, leagueId) {
  return db.prepare("SELECT * FROM commish_files WHERE username = ? AND league_id = ?").get(username, String(leagueId)) || null;
}

/* ---------------- actions (pure) ---------------- */
/** Validates and cleans an action list from the client. */
export function cleanActions(list) {
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : null);
  return (Array.isArray(list) ? list : [])
    .slice(0, 100)
    .filter((a) => a && String(a.title || "").trim())
    .map((a) => ({
      id: String(a.id || newId()).slice(0, 40),
      title: String(a.title).trim().slice(0, 80),
      description: String(a.description || "").slice(0, 400),
      due: day(a.due),
      repeat: a.repeat === "yearly" ? "yearly" : null,
      setting: gemini.CHARTER_SETTINGS.includes(a.setting) ? a.setting : null,
      value: a.value == null || a.value === "" ? null : String(a.value).slice(0, 40),
      done: Boolean(a.done),
      doneAt: a.done ? Number(a.doneAt) || Date.now() : null,
      doneBy: a.done ? (a.doneBy === "settings log" ? "settings log" : "you") : null,
      source: ["gemini", "manual", "rule"].includes(a.source) ? a.source : "manual",
    }));
}

const addYear = (d) => {
  if (!d) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y + 1, m - 1, Math.min(dd, m === 2 && dd === 29 ? 28 : dd)));
  return t.toISOString().slice(0, 10);
};

/** A ticked yearly action gets its next-year copy (once). Returns the new list. */
export function rollYearly(actions) {
  const out = [...actions];
  for (const a of actions) {
    if (!a.done || a.repeat !== "yearly" || !a.due) continue;
    const next = addYear(a.due);
    if (out.some((b) => b !== a && b.title === a.title && b.due === next)) continue;
    out.push({ ...a, id: newId(), due: next, done: false, doneAt: null, doneBy: null });
  }
  return out;
}

/** Merge a fresh Gemini checklist into the existing actions: keep yours and done ones; replace open Gemini ones. */
export function mergeChecklist(existing, fresh) {
  const keep = (existing || []).filter((a) => a.source !== "gemini" || a.done);
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const have = new Set(keep.filter((a) => !a.done).map((a) => norm(a.title)));
  const add = (fresh || []).filter((a) => !have.has(norm(a.title))).map((a) => ({ ...a, id: newId(), done: false, doneAt: null, doneBy: null, source: "gemini" }));
  return [...keep, ...add];
}

/** red (due within 7 days or overdue) / yellow (within 30) / ok, and the next due date with every open action on it. */
export function statusOf(actions, today = nowIso()) {
  const open = (actions || []).filter((a) => !a.done && a.due).sort((a, b) => a.due.localeCompare(b.due));
  if (!open.length) return { status: "ok", next: null, overdue: 0 };
  const days = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
  const first = open[0].due;
  const d = days(first);
  return {
    status: d <= 7 ? "red" : d <= 30 ? "yellow" : "ok",
    next: { due: first, inDays: d, items: open.filter((a) => a.due === first).map((a) => a.title) },
    overdue: open.filter((a) => days(a.due) < 0).length,
  };
}

/**
 * Settings-log auto-tick (pure): an open action tied to a setting is done when a log line from the 60 days
 * before its due date onwards shows that setting changing (to its value, when the action names one).
 * logItems: [{ id, at, text }] from the League page ("who: waiver_budget 100 → 200; ...").
 */
export function autoTickFromLog(actions, logItems = []) {
  let changed = false;
  const out = actions.map((a) => {
    if (a.done || !a.setting) return a;
    const from = a.due ? Date.parse(`${a.due}T00:00:00Z`) - 60 * DAY : 0;
    const hit = logItems.find((it) => {
      if (!it?.text || (it.at && it.at < from)) return false;
      const re = new RegExp(`(^|[\\s:;])${a.setting}\\s+[^;]*?→\\s*([^;]+)`, "i");
      const m = it.text.match(re);
      if (!m) return false;
      return a.value == null || String(m[2]).trim().toLowerCase() === String(a.value).trim().toLowerCase();
    });
    if (!hit) return a;
    changed = true;
    return { ...a, done: true, doneAt: hit.at || Date.now(), doneBy: "settings log" };
  });
  return { actions: out, changed };
}

/* ---------------- operations ---------------- */
async function readWithGemini(c, { text, pdfBase64 }) {
  if (!gemini.isConfigured()) {
    c.read = { at: Date.now(), ok: false, error: "No Gemini key set — add actions by hand, or set GEMINI_API_KEY on the server." };
    return c;
  }
  try {
    const out = await gemini.charterChecklist({ leagueName: c.leagueName, season: c.season, today: nowIso(), text, pdfBase64 });
    c.summary = out.summary;
    c.actions = mergeChecklist(c.actions, out.actions);
    c.read = { at: Date.now(), ok: true, error: null, count: out.actions.length };
  } catch (err) {
    c.read = { at: Date.now(), ok: false, error: err.message };
  }
  return c;
}

/** Add or replace a charter's source (link or upload) and read it. */
export async function setSource(username, { leagueId, leagueName, season, link = null, upload = null }) {
  const c = getCharter(username, leagueId) || { leagueId: String(leagueId), leagueName: leagueName || String(leagueId), season: season || null, actions: [], ruleChanges: [], createdAt: Date.now() };
  if (leagueName) c.leagueName = leagueName;
  if (season) c.season = season;
  let doc;
  if (link) {
    doc = await fetchLink(link);
    c.source = { kind: "link", link: String(link).slice(0, 500), docKind: doc.kind, hash: doc.hash, fetchedAt: Date.now() };
  } else if (upload) {
    const buf = Buffer.from(String(upload.base64 || ""), "base64");
    if (!buf.length) throw new Error("The file is empty.");
    if (buf.length > MAX_UPLOAD) throw new Error("The file is larger than 10 MB.");
    doc = readDocument(buf, { mime: upload.mime, name: upload.name });
    saveFile(username, leagueId, { name: upload.name, mime: upload.mime, buf, hash: doc.hash });
    c.source = { kind: "upload", name: String(upload.name || "charter").slice(0, 120), docKind: doc.kind, hash: doc.hash, fetchedAt: Date.now() };
  } else throw new Error("Give a link or a file.");
  c.text = doc.text ? doc.text.slice(0, MAX_TEXT) : null;
  c.isPdf = Boolean(doc.pdfBase64);
  if (doc.pdfBase64 && link) saveFile(username, leagueId, { name: "linked.pdf", mime: "application/pdf", buf: Buffer.from(doc.pdfBase64, "base64"), hash: doc.hash });
  await readWithGemini(c, doc);
  return saveCharter(username, c);
}

function docOf(username, c) {
  if (c.isPdf) {
    const f = getFile(username, c.leagueId);
    return { text: null, pdfBase64: f?.data ? Buffer.from(f.data).toString("base64") : null };
  }
  return { text: c.text, pdfBase64: null };
}

/** Re-read: links are downloaded again; Gemini runs when the document changed (or `force`). */
export async function reread(username, leagueId, { force = false } = {}) {
  const c = getCharter(username, leagueId);
  if (!c) throw new Error("No charter for that league.");
  if (c.source?.kind === "link") {
    const doc = await fetchLink(c.source.link);
    const changed = doc.hash !== c.source.hash;
    c.source = { ...c.source, hash: doc.hash, fetchedAt: Date.now(), docKind: doc.kind };
    c.text = doc.text ? doc.text.slice(0, MAX_TEXT) : null;
    c.isPdf = Boolean(doc.pdfBase64);
    if (doc.pdfBase64) saveFile(username, leagueId, { name: "linked.pdf", mime: "application/pdf", buf: Buffer.from(doc.pdfBase64, "base64"), hash: doc.hash });
    if (changed || force) await readWithGemini(c, doc);
    else c.read = { ...(c.read || {}), checkedAt: Date.now(), unchanged: true };
  } else if (force) await readWithGemini(c, docOf(username, c));
  return saveCharter(username, c);
}

export function saveActions(username, leagueId, actions) {
  const c = getCharter(username, leagueId);
  if (!c) throw new Error("No charter for that league.");
  c.actions = rollYearly(cleanActions(actions));
  return saveCharter(username, c);
}

export function saveRuleChanges(username, leagueId, list) {
  const c = getCharter(username, leagueId);
  if (!c) throw new Error("No charter for that league.");
  c.ruleChanges = (Array.isArray(list) ? list : [])
    .slice(0, 100)
    .filter((r) => r && String(r.text || "").trim())
    .map((r) => ({
      id: String(r.id || newId()).slice(0, 40),
      text: String(r.text).trim().slice(0, 1000),
      status: ["proposed", "approved", "rejected", "applied"].includes(r.status) ? r.status : "proposed",
      createdAt: Number(r.createdAt) || Date.now(),
      decidedAt: r.status && r.status !== "proposed" ? Number(r.decidedAt) || Date.now() : null,
    }));
  return saveCharter(username, c);
}

export async function draftUpdate(username, leagueId) {
  const c = getCharter(username, leagueId);
  if (!c) throw new Error("No charter for that league.");
  const approved = (c.ruleChanges || []).filter((r) => r.status === "approved");
  if (!approved.length) throw new Error("No approved rule changes to write into the charter.");
  // An accepted update that hasn't reached the document yet (same document as when it was accepted) is the base.
  const pending = c.acceptedDraft?.markdown && c.acceptedDraft.sourceHash && c.acceptedDraft.sourceHash === c.source?.hash;
  const base = pending ? { text: c.acceptedDraft.markdown, pdfBase64: null } : docOf(username, c);
  const md = await gemini.charterUpdate({ leagueName: c.leagueName, ...base, approved, today: nowIso() });
  c.draft = { at: Date.now(), markdown: md, ruleIds: approved.map((r) => r.id) };
  return saveCharter(username, c);
}

/** Accept (approved rules → "applied", draft kept as the latest text) or discard the draft. */
export function resolveDraft(username, leagueId, { accept, markdown = null }) {
  const c = getCharter(username, leagueId);
  if (!c?.draft) throw new Error("No draft to resolve.");
  if (accept) {
    const ids = new Set(c.draft.ruleIds || []);
    c.ruleChanges = (c.ruleChanges || []).map((r) => (ids.has(r.id) ? { ...r, status: "applied", decidedAt: Date.now() } : r));
    c.acceptedDraft = { at: Date.now(), markdown: String(markdown ?? c.draft.markdown).slice(0, 200000), sourceHash: c.source?.hash || null };
  }
  c.draft = null;
  return saveCharter(username, c);
}

/** Summaries for the Commish cards and the league "Commish" boxes. Also runs the settings-log auto-tick. */
export function summaries(username) {
  const out = {};
  for (const id of listIds(username)) {
    const c = getCharter(username, id);
    if (!c) continue;
    const snap = store.getState(`private_snapshot:${username}:${id}`, null);
    const items = snap?.log?.items || [];
    if (items.length) {
      const r = autoTickFromLog(c.actions || [], items);
      if (r.changed) {
        c.actions = rollYearly(r.actions);
        saveCharter(username, c);
      }
    }
    const st = statusOf(c.actions || []);
    out[id] = { leagueId: id, leagueName: c.leagueName, season: c.season, ...st, actions: (c.actions || []).filter((a) => !a.done).length, proposed: (c.ruleChanges || []).filter((r) => r.status === "proposed").length, source: c.source?.kind || null, readError: c.read?.ok === false ? c.read.error : null };
  }
  return out;
}

/** The leagues the user could attach a charter to (all his Sleeper leagues this season, commissioner ones first). */
export async function candidateLeagues(username) {
  const st = await sleeper.getState();
  const me = await sleeper.getUser(username);
  if (!me?.user_id) return [];
  const leagues = await sleeper.getUserLeagues(me.user_id, st.season);
  const out = [];
  for (const l of leagues || []) {
    let commish = null;
    try {
      const users = await sleeper.getLeagueUsers(l.league_id);
      commish = Boolean((users || []).find((u) => String(u.user_id) === String(me.user_id))?.is_owner);
    } catch {
      commish = null;
    }
    out.push({ leagueId: String(l.league_id), name: l.name, avatar: l.avatar || null, season: l.season, bestBall: Number(l.settings?.best_ball) === 1, commish, previousLeagueId: l.previous_league_id ? String(l.previous_league_id) : null });
  }
  return out.sort((a, b) => Number(Boolean(b.commish)) - Number(Boolean(a.commish)) || a.name.localeCompare(b.name));
}

/** A charter whose league has a new season's league (previous_league_id) moves to the new id. */
export function followSeasons(username, leagues) {
  const ids = new Set(listIds(username));
  const moved = [];
  for (const l of leagues || []) {
    if (!l.previousLeagueId || !ids.has(l.previousLeagueId) || ids.has(l.leagueId)) continue;
    const c = getCharter(username, l.previousLeagueId);
    if (!c) continue;
    const f = getFile(username, l.previousLeagueId);
    const next = { ...c, leagueId: l.leagueId, leagueName: l.name, season: l.season, previousLeagueIds: [...(c.previousLeagueIds || []), c.leagueId] };
    saveCharter(username, next);
    if (f) saveFile(username, l.leagueId, { name: f.name, mime: f.mime, buf: f.data, hash: f.hash });
    deleteCharter(username, l.previousLeagueId);
    moved.push({ from: l.previousLeagueId, to: l.leagueId });
  }
  return moved;
}

/**
 * July re-reads (scheduler, daily): every linked charter is downloaded once each July; when it changed, Gemini
 * reads it again — at most one Gemini read per day across all users.
 */
export async function julyTick({ users, now = Date.now() } = {}) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const month = Number(parts.find((p) => p.type === "month").value);
  const year = Number(parts.find((p) => p.type === "year").value);
  if (month !== 7) return { skipped: "not July" };
  const dayKey = `commish:july:gemini:${nowIso(now)}`;
  let geminiUsed = store.getState(dayKey, 0) || 0;
  const done = [];
  for (const username of users || []) {
    for (const id of listIds(username)) {
      const c = getCharter(username, id);
      if (!c || c.source?.kind !== "link" || c.julyChecked === year) continue;
      try {
        const doc = await fetchLink(c.source.link);
        const changed = doc.hash !== c.source.hash;
        if (changed && geminiUsed >= 1) continue; // try again tomorrow
        c.source = { ...c.source, hash: doc.hash, fetchedAt: now, docKind: doc.kind };
        c.text = doc.text ? doc.text.slice(0, MAX_TEXT) : null;
        c.isPdf = Boolean(doc.pdfBase64);
        if (doc.pdfBase64) saveFile(username, id, { name: "linked.pdf", mime: "application/pdf", buf: Buffer.from(doc.pdfBase64, "base64"), hash: doc.hash });
        if (changed) {
          geminiUsed++;
          store.setState(dayKey, geminiUsed);
          await readWithGemini(c, doc);
        }
        c.julyChecked = year;
        saveCharter(username, c);
        done.push({ username, leagueId: id, changed });
      } catch (err) {
        console.warn(`[commish] July re-read failed for ${id}: ${err.message}`);
      }
    }
  }
  return { done };
}
