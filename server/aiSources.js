import * as store from "./projectionStore.js";

/**
 * v4.3: the web sources behind each Gemini feature — which ones it used (counted over its runs), which ones the
 * owner added as preferred, and which ones he removed.
 *
 * Gemini's Google Search grounding can't be locked to a list of sites, so:
 *   added    named in the prompt as the sources to start with (a strong hint, not a guarantee)
 *   removed  named in the prompt as sources not to use, AND filtered out of every result afterwards — the
 *            source names on each item, the grounding links, and an item whose only sources were removed
 *            (for the features that count sources per item). Filtering happens when results are read, so a
 *            removal applies at once, even to results already cached.
 * Charter and best-ball reading use only the uploaded document, so they have no web sources.
 */
export const FEATURES = {
  hype: { label: "Waiver research (Hype Train)", perItem: true, autoPrefer: true },
  startsit: { label: "Start / sit (Roster page)", perItem: true, autoPrefer: true },
  upsets: { label: "Pick'em upset scan", perItem: true, autoPrefer: false },
  trade: { label: "Trade news check", perItem: false, autoPrefer: false },
  injury: { label: "Injury news (Questionable players)", perItem: false, autoPrefer: false },
};
const cfgKey = (f) => `ai_sources:${f}`;
const seenKey = (f) => `ai_sources_seen:${f}`;
const MAX_LIST = 40;

/** "https://www.espn.com/x" / "ESPN.com" / " r/fantasyfootball " → comparable text. Pure. */
export function normSource(s) {
  let t = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  // a domain with a path → just the domain; "r/fantasyfootball" stays as it is
  const slash = t.indexOf("/");
  if (slash > 0 && t.slice(0, slash).includes(".")) t = t.slice(0, slash);
  return t.trim();
}
/** Compact form for matching: no spaces or punctuation, no .com/.net… ("Bad Site" ≈ "badsite.com"). Pure. */
const compact = (s) => normSource(s).replace(/\.(com|net|org|io|co|ca|us|uk|tv)$/, "").replace(/[^a-z0-9/]/g, "");
/** Does a source name (or link) match a removed term? Substring either way, 3+ characters. Pure. */
export function matches(term, name) {
  const t = compact(term);
  const n = compact(name);
  if (t.length < 3 || n.length < 3) return t === n && t.length > 0;
  return n.includes(t) || t.includes(n);
}

export function getConfig(feature) {
  const c = store.getState(cfgKey(feature), null) || {};
  return { added: Array.isArray(c.added) ? c.added : [], removed: Array.isArray(c.removed) ? c.removed : [] };
}
/** Add or remove a source (or undo either). action: "add" | "remove" | "unadd" | "unremove". */
export function update(feature, action, source) {
  if (!FEATURES[feature]) throw new Error("Unknown feature.");
  const s = String(source || "").trim().slice(0, 80);
  if (s.length < 2) throw new Error("Enter a site or account name.");
  const c = getConfig(feature);
  const same = (x) => normSource(x) === normSource(s);
  if (action === "add") {
    c.added = [...c.added.filter((x) => !same(x)), s].slice(-MAX_LIST);
    c.removed = c.removed.filter((x) => !same(x));
  } else if (action === "remove") {
    c.removed = [...c.removed.filter((x) => !same(x)), s].slice(-MAX_LIST);
    c.added = c.added.filter((x) => !same(x));
  } else if (action === "unadd") c.added = c.added.filter((x) => !same(x));
  else if (action === "unremove") c.removed = c.removed.filter((x) => !same(x));
  else throw new Error("Unknown action.");
  store.setState(cfgKey(feature), c);
  return c;
}

/** Sources seen: [{ name, n }] (most used first) plus the last run's time and list. */
export function getSeen(feature) {
  const s = store.getState(seenKey(feature), null) || {};
  return { counts: Array.isArray(s.counts) ? s.counts : [], lastAt: s.lastAt || null, last: Array.isArray(s.last) ? s.last : [] };
}
const isLink = (n) => /^https?:/i.test(n) || /vertexaisearch|grounding-api/i.test(n);
/** Names a run cited: per-item source names + grounding titles. Pure. */
export function namesOf(out) {
  const names = [];
  const push = (x) => {
    const n = String(x || "").trim().replace(/^www\./i, "").slice(0, 60);
    if (n && !isLink(n)) names.push(n);
  };
  for (const p of out?.players || []) for (const s of p.sources || []) push(s);
  for (const p of Object.values(out?.byId || {})) for (const s of p?.sources || []) push(s);
  for (const g of Object.values(out?.byGame || {})) for (const s of g?.sources || []) push(s);
  for (const s of out?.sources || []) push(s?.title);
  return names;
}
/** Counts this run's sources into the feature's tally (kept 60 days). */
export function recordRun(feature, out) {
  const prev = getSeen(feature);
  const counts = new Map(prev.counts.map((x) => [normSource(x.name), { name: x.name, n: Number(x.n) || 1 }]));
  const last = [];
  for (const name of namesOf(out)) {
    const k = normSource(name);
    if (!k) continue;
    const e = counts.get(k) || { name, n: 0 };
    e.n += 1;
    counts.set(k, e);
    if (!last.some((x) => normSource(x) === k)) last.push(name);
  }
  const next = { counts: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 60), lastAt: Date.now(), last: last.slice(0, 40) };
  store.setState(seenKey(feature), next);
  return next;
}

/** The prompt lines for a feature: preferred (added + most used, minus removed) and not to use. */
export function promptHints(feature) {
  const f = FEATURES[feature];
  if (!f) return "";
  const { added, removed } = getConfig(feature);
  const auto = f.autoPrefer ? getSeen(feature).counts.map((x) => x.name).filter((n) => !removed.some((r) => matches(r, n))).slice(0, 12) : [];
  const prefer = [...added, ...auto.filter((n) => !added.some((a) => normSource(a) === normSource(n)))].slice(0, 20);
  const lines = [];
  if (prefer.length) lines.push(`Start with these sources: ${prefer.join(", ")}. Then look for others.`);
  if (removed.length) lines.push(`Do NOT use or cite these sources: ${removed.join(", ")}.`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/**
 * A result with the removed sources taken out (read time, so removals apply to cached results too). Pure apart
 * from reading the config. Shapes: hype { players[] }, startsit { byId{} }, upsets { byGame{} }, all { sources[] }.
 */
export function applyRemovals(feature, out, removed = getConfig(feature).removed) {
  if (!out || !removed.length) return out;
  const gone = (name) => removed.some((r) => matches(r, name));
  const keepSources = (list) => (Array.isArray(list) ? list.filter((s) => !gone(s)) : list);
  const res = { ...out };
  if (Array.isArray(out.sources)) res.sources = out.sources.filter((s) => !gone(s?.title || "") && !gone(s?.uri || ""));
  if (Array.isArray(out.players)) {
    res.players = out.players
      .map((p) => {
        const before = (p.sources || []).length;
        const sources = keepSources(p.sources || []);
        const lost = before - sources.length;
        return { ...p, sources, mentions: Math.max(0, (Number(p.mentions) || 0) - lost) };
      })
      .filter((p) => !((p.sources || []).length === 0 && p.mentions === 0));
  }
  if (out.byId && typeof out.byId === "object") {
    res.byId = {};
    for (const [id, r] of Object.entries(out.byId)) {
      if (!r) continue;
      const before = (r.sources || []).length;
      const sources = keepSources(r.sources || []);
      if (before && !sources.length) continue; // every source behind this verdict was removed
      res.byId[id] = { ...r, sources };
    }
  }
  if (out.byGame && typeof out.byGame === "object") {
    res.byGame = {};
    for (const [k, g] of Object.entries(out.byGame)) {
      const before = (g?.sources || []).length;
      const sources = keepSources(g?.sources || []);
      res.byGame[k] = { ...g, sources, upsetMentions: Math.max(0, (Number(g?.upsetMentions) || 0) - (before - sources.length)) };
    }
  }
  return res;
}

/** Everything the Account page shows. */
export function overview() {
  return Object.entries(FEATURES).map(([key, f]) => {
    const c = getConfig(key);
    const s = getSeen(key);
    return { key, label: f.label, perItem: f.perItem, added: c.added, removed: c.removed, lastAt: s.lastAt, last: s.last, counts: s.counts.slice(0, 30) };
  });
}
