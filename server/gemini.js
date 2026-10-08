import { cacheGet, cacheSet } from "./db.js";
import * as ai from "./aiSources.js"; // v4.3: sources per feature (preferred / removed), counted per run

/**
 * v2.7: Gemini (Google AI) with Grounding with Google Search, used ONLY to
 * read this week's public pick'em / upset-pick articles and summarise them —
 * never to make the picks. Optional: needs GEMINI_API_KEY.
 *
 * Free tier (checked 2026-10-03 on ai.google.dev pricing): Gemini 3.5
 * Flash-Lite is free; Grounding with Google Search has 5,000 free requests
 * per month, then $14 per 1,000. On the free tier Google may use the content
 * to improve its products. This app makes about one call a day in-season
 * (cached 20 hours), so ~30 a month.
 *
 * NOT VERIFIED from the build sandbox (Google's API isn't reachable there):
 * the exact model id (GEMINI_MODEL, default "gemini-3.5-flash-lite" — check
 * Google AI Studio's model list and override if it differs) and the
 * response shape beyond the standard candidates[0].content.parts[].text.
 */
const MODEL = () => process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const TTL = 20 * 60 * 60 * 1000;

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * games: [{ key: "NYJ@BUF", favorite, underdog, kickoffLabel }]
 * Returns { at, byGame: { key: { upsetMentions, sources: [..], note } }, sources: [{title, uri}] } or null.
 */
export async function upsetScan(season, week, games, { force = false } = {}) {
  if (!isConfigured() || !games.length) return null;
  const cacheKey = `gemini:upsets:v2:${season}:${week}`; // v2: notes are about twice as long as before
  const cached = cacheGet(cacheKey);
  if (cached && !force) return ai.applyRemovals("upsets", cached);

  const lines = games.map((g) => `- ${g.key} (favourite: ${g.favorite}, underdog: ${g.underdog}, ${g.kickoffLabel || ""})`).join("\n");
  const prompt = `You are helping with an NFL straight-up pick'em pool for ${season} week ${week}.
Search the web for this week's public pick'em articles, expert picks, and "upset picks" columns.
For EACH game below, count how many distinct articles/experts you found that pick the UNDERDOG to win outright, list up to 3 source names, and write a neutral note (max 70 words, same concise factual style) on injuries, weather, rest or motivation relevant to that game.
Games:
${lines}${ai.promptHints("upsets")}
Reply with ONLY a JSON array, no prose: [{"game":"AWAY@HOME","upsetMentions":0,"sources":["..."],"note":"..."}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
  const arr = extractJson(text);
  if (!Array.isArray(arr)) {
    console.warn("[gemini] Couldn't read a JSON array from the response:", text.slice(0, 400));
    return null;
  }
  const byGame = {};
  for (const r of arr) {
    if (!r?.game) continue;
    byGame[String(r.game).toUpperCase().replace(/\s+/g, "")] = {
      upsetMentions: Math.max(0, Number(r.upsetMentions) || 0),
      sources: Array.isArray(r.sources) ? r.sources.slice(0, 3).map(String) : [],
      note: r.note ? String(r.note).slice(0, 600) : null,
    };
  }
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 12);
  const out = { at: Date.now(), model: MODEL(), byGame, sources };
  console.log(`[gemini] Upset scan for ${season} wk${week}: ${Object.keys(byGame).length} games, ${sources.length} grounding sources.`);
  cacheSet(cacheKey, out, TTL);
  ai.recordRun("upsets", out);
  return ai.applyRemovals("upsets", out);
}

/**
 * v2.9: a grounded news check for the swaps Trade Finder suggests — injuries,
 * role / depth-chart changes, suspensions, trades — so a suggestion that the
 * numbers like but the news doesn't gets a flag. Like the upset scan it only
 * READS the news; it never changes the numbers or proposes trades.
 *
 * items: [{ key, give: {name,pos,team}, get: {name,pos,team} }]
 * Returns { at, model, byKey: { [key]: { flag: "ok"|"caution"|"avoid", note } }, sources } or null.
 * One call covers the whole list (cached 3 hours per list), so opening the
 * Trades page costs at most a few grounded requests a day.
 * Unverified from the build sandbox: model id and response shape (see top).
 */
const TRADE_TTL = 3 * 60 * 60 * 1000;
export async function tradeNews(season, week, items, { force = false, cacheOnly = false } = {}) {
  if (!isConfigured() || !items?.length) return null;
  const listKey = items.map((i) => i.key).sort().join("~");
  let h = 0;
  for (const ch of listKey) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const cacheKey = `gemini:trade:${season}:${week}:${h}`;
  const cached = cacheGet(cacheKey);
  if (cached && !force) return ai.applyRemovals("trade", cached);
  if (cacheOnly && !force) return null; // v3.3 (R11): opening the page never starts a Gemini search by itself

  const who = (p) => `${p.name} (${p.pos}${p.team ? `, ${p.team}` : ""})`;
  const lines = items.map((i) => `- ${i.key}: I would GIVE ${who(i.give)} and GET ${who(i.get)}`).join("\n");
  const prompt = `You are checking NFL fantasy football trade ideas for ${season} week ${week}.
Search the web for the latest news (last ~7 days) on each player involved: injuries or practice status, snap-count or depth-chart changes, suspensions, trades, coaching-staff comments.
For EACH idea below reply with a flag and a note (max 40 words):
- "avoid": news clearly argues against it (the player I'd GET is hurt, losing his job or suspended; or the player I'd GIVE has news that raises his value).
- "caution": something worth knowing but not decisive.
- "ok": nothing relevant found.
Do not suggest other trades. Do not invent news; if you find nothing, say "ok" with a short note saying so.
Ideas:
${lines}${ai.promptHints("trade")}
Reply with ONLY a JSON array, no prose: [{"key":"<the key before the colon>","flag":"ok","note":"..."}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
  const arr = extractJson(text);
  if (!Array.isArray(arr)) {
    console.warn("[gemini] Trade news: couldn't read a JSON array:", text.slice(0, 400));
    return null;
  }
  const byKey = {};
  for (const r of arr) {
    if (!r?.key) continue;
    const flag = ["ok", "caution", "avoid"].includes(r.flag) ? r.flag : "ok";
    byKey[String(r.key)] = { flag, note: r.note ? String(r.note).slice(0, 300) : null };
  }
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 12);
  const out = { at: Date.now(), model: MODEL(), byKey, sources };
  console.log(`[gemini] Trade news for ${season} wk${week}: ${Object.keys(byKey).length}/${items.length} ideas, ${sources.length} sources.`);
  cacheSet(cacheKey, out, TRADE_TTL);
  ai.recordRun("trade", out);
  return ai.applyRemovals("trade", out);
}

/**
 * v3.1: news check for Questionable players at relevant depth-chart slots (injury opportunities).
 * Reads practice participation through the week (a downgrade, or no practice at all), and the tone
 * of recent articles / posts. It only READS news; it never decides anything by itself — the caller
 * combines this with whether the backup is trending on Sleeper.
 *
 * items: [{ key, name, pos, team, note }]
 * Returns { at, model, byKey: { [key]: { flag: "down"|"ok"|"unclear", practice, note } }, sources } or null.
 * One call covers the whole list; cached 3 hours per list.
 */
export async function injurySentiment(season, week, items, { force = false } = {}) {
  if (!isConfigured() || !items?.length) return null;
  const listKey = items.map((i) => i.key).sort().join("~");
  let h = 0;
  for (const ch of listKey) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const cacheKey = `gemini:injsent:${season}:${week}:${h}`;
  const cached = cacheGet(cacheKey);
  if (cached && !force) return ai.applyRemovals("injury", cached);

  const lines = items.map((i) => `- ${i.key}: ${i.name} (${i.pos}, ${i.team})${i.note ? ` — listed ${i.note}` : " — listed Questionable"}`).join("\n");
  const prompt = `You are checking NFL injury news for ${season} week ${week}. Each player below is listed Questionable.
Search the web for the latest practice reports (Wednesday / Thursday / Friday participation) and recent articles or posts from reporters about each player's chances of playing.
For EACH player reply with:
- "flag": "down" if practice participation was downgraded through the week (for example limited then did not practice) or he did not practice at all, or recent reporting trends toward him missing the game; "ok" if he practiced fully or reporting says he is expected to play; "unclear" if you cannot tell.
- "practice": a few words, for example "DNP, DNP, limited" or "unknown".
- "note": max 30 words of what you found. Do not invent news; say "unclear" if you find nothing.
Players:
${lines}${ai.promptHints("injury")}
Reply with ONLY a JSON array, no prose: [{"key":"<the key before the colon>","flag":"unclear","practice":"unknown","note":"..."}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
  const arr = extractJson(text);
  if (!Array.isArray(arr)) {
    console.warn("[gemini] Injury sentiment: couldn't read a JSON array:", text.slice(0, 400));
    return null;
  }
  const byKey = {};
  for (const r of arr) {
    if (!r?.key) continue;
    byKey[String(r.key)] = { flag: ["down", "ok", "unclear"].includes(r.flag) ? r.flag : "unclear", practice: r.practice ? String(r.practice).slice(0, 80) : null, note: r.note ? String(r.note).slice(0, 240) : null };
  }
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 12);
  const out = { at: Date.now(), model: MODEL(), byKey, sources };
  console.log(`[gemini] Injury sentiment ${season} wk${week}: ${Object.keys(byKey).length}/${items.length} players, ${sources.length} sources.`);
  cacheSet(cacheKey, out, TRADE_TTL);
  ai.recordRun("injury", out);
  return ai.applyRemovals("injury", out);
}

/* ---------------- v3.8: Commish (charters) and best ball rules ---------------- */
/**
 * Plain generation (no web search). `parts` = Gemini content parts (text and/or inline PDF). With `json`, asks for a
 * JSON reply. Returns the reply text. Same key and model as everything else here; UNVERIFIED from the sandbox.
 */
async function generate(parts, { json = false } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts }], ...(json ? { generationConfig: { responseMimeType: "application/json" } } : {}) }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return (body?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
}
function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text.slice(Math.min(...["{", "["].map((c) => (text.indexOf(c) < 0 ? Infinity : text.indexOf(c)))), Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")) + 1);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
const docParts = (text, pdfBase64) => (pdfBase64 ? [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] : [{ text: `CHARTER:\n${String(text || "").slice(0, 120000)}` }]);
export const CHARTER_SETTINGS = ["waiver_budget", "disable_adds", "trade_deadline", "playoff_week_start", "playoff_teams", "waiver_type", "daily_waivers", "max_keepers", "taxi_slots", "reserve_slots", "draft_rounds"];

/**
 * A commissioner's checklist from a league charter: dated actions for the next 12 months.
 * Returns { summary, actions: [{ title, description, due: "YYYY-MM-DD", repeat: "yearly"|null, setting|null, value|null }] }.
 */
export async function charterChecklist({ leagueName, season, today, text, pdfBase64 }) {
  if (!isConfigured()) throw new Error("No Gemini key set (GEMINI_API_KEY).");
  const prompt = `You help the commissioner of a Sleeper fantasy football league ("${leagueName}", ${season} season) run it by the league's charter.
Today is ${today}. Read the charter and list every recurring or one-off ACTION the commissioner must take in the next 12 months — for example: reset FAAB budgets, collect dues, pay out winnings, lock/unlock waivers or adds, set or check the trade deadline, keeper/taxi deadlines, roster compliance checks, schedule the draft, run polls on proposed rule changes.
For each action give: a short title (max 60 characters), a description (max 200 characters, quoting the charter's rule when useful), a due date as YYYY-MM-DD (the next time it is due after today; estimate from NFL calendar context when the charter gives only a week or month), "repeat": "yearly" for actions that happen every season else null, and "setting": the Sleeper league setting the action changes if it is one of ${CHARTER_SETTINGS.join(", ")} (else null), with "value" the new value when the charter states it (else null).
Also give a 2-sentence summary of the charter.
Reply with ONLY JSON: {"summary":"...","actions":[{"title":"...","description":"...","due":"YYYY-MM-DD","repeat":"yearly","setting":null,"value":null}]}`;
  const out = parseJsonLoose(await generate([{ text: prompt }, ...docParts(text, pdfBase64)], { json: true }));
  if (!out || !Array.isArray(out.actions)) throw new Error("Gemini didn't return a checklist.");
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : null);
  return {
    summary: out.summary ? String(out.summary).slice(0, 600) : null,
    actions: out.actions
      .filter((a) => a && a.title)
      .slice(0, 40)
      .map((a) => ({
        title: String(a.title).slice(0, 80),
        description: a.description ? String(a.description).slice(0, 300) : "",
        due: day(a.due),
        repeat: a.repeat === "yearly" ? "yearly" : null,
        setting: CHARTER_SETTINGS.includes(a.setting) ? a.setting : null,
        value: a.value == null ? null : String(a.value).slice(0, 40),
      })),
  };
}

/** A charter update in Markdown that adds the approved rule changes (the commissioner reviews it). */
export async function charterUpdate({ leagueName, text, pdfBase64, approved, today = new Date().toISOString().slice(0, 10) }) {
  if (!isConfigured()) throw new Error("No Gemini key set (GEMINI_API_KEY).");
  const list = approved.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
  const prompt = `You maintain the charter of the fantasy football league "${leagueName}". The members approved these rule changes:
${list}
Rewrite the charter so it includes them: change the affected sections in place, keep everything else as it is, keep the existing structure and tone, and add a short "Changes" section at the end listing what changed, dated ${today}. Reply with ONLY the full updated charter in Markdown.`;
  const md = await generate([{ text: prompt }, ...docParts(text, pdfBase64)]);
  const fenced = md.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : md).trim().slice(0, 200000);
}

/**
 * Best ball scoring rules from the commissioner's own words.
 * Returns { metric: "maxPF"|"PF", combineWith: [league names], heroMultiplier: number|null, weeksFrom, weeksTo,
 *           entryFee: number|null, payouts: [{ place, pct }], notes }.
 */
export async function bestBallRules({ prompt, leagueName, otherLeagues = [] }) {
  if (!isConfigured()) throw new Error("No Gemini key set (GEMINI_API_KEY).");
  const ask = `A fantasy football best ball league ("${leagueName}") has these leaderboard rules, written by its commissioner:
"""${String(prompt).slice(0, 4000)}"""
Other best ball leagues the commissioner has: ${otherLeagues.map((l) => `"${l}"`).join(", ") || "none"}.
Turn the rules into JSON: "metric": "maxPF" (max points for / best ball points, the default) or "PF"; "combineWith": names of the other leagues whose teams share this leaderboard (only from the list above); "heroMultiplier": the multiplier applied to each manager's hero player's points (e.g. 2) or null; "weeksFrom"/"weeksTo": the weeks that count (numbers or null); "entryFee": dollars per team or null; "payouts": [{"place":1,"pct":60},...] of the total pot (empty if not stated); "notes": anything that can't be expressed in these fields (max 300 characters).
Reply with ONLY the JSON object.`;
  const out = parseJsonLoose(await generate([{ text: ask }], { json: true }));
  if (!out || typeof out !== "object") throw new Error("Gemini didn't return rules.");
  const n = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    metric: out.metric === "PF" ? "PF" : "maxPF",
    combineWith: Array.isArray(out.combineWith) ? out.combineWith.map(String).slice(0, 5) : [],
    heroMultiplier: n(out.heroMultiplier),
    weeksFrom: n(out.weeksFrom),
    weeksTo: n(out.weeksTo),
    entryFee: n(out.entryFee),
    payouts: Array.isArray(out.payouts) ? out.payouts.map((p) => ({ place: n(p?.place), pct: n(p?.pct) })).filter((p) => p.place && p.pct != null).slice(0, 10) : [],
    notes: out.notes ? String(out.notes).slice(0, 300) : null,
  };
}

/* ---------------- v3.9: waiver research ("Hype Train") ---------------- */
/**
 * One grounded search a week-half: this week's waiver-wire add articles (redraft AND dynasty), Reddit posts
 * (r/fantasyfootball, r/DynastyFF — posts, not comments) and X/Twitter posts by fantasy analysts (posts, not
 * replies). Gemini lists every recommended player with how many distinct sources recommend him, the source names,
 * whether he's a one-week spot start, a rest-of-season add or a stash (dynasty / long-term), and a one-line summary
 * of the argument. "mentions" is Gemini's count of what its search found, not an exhaustive census.
 * Returns { at, model, players: [{ name, pos, team, mentions, sources, kind, dynasty, note }], sources } or null.
 * Cached 12 hours per week. Unverified from the build sandbox: model id and response shape (see top).
 */
// v4.1: the research runs on a schedule (Tue + Wed ~8:00 and ~16:00 Toronto, scheduler.js), so a result is kept for the
// whole week instead of 12 hours; a build still starts one in the background if there is none for the week.
const HYPE_TTL = 8 * 24 * 60 * 60 * 1000;
// v4.1: the outlets / accounts the last runs found are remembered (60 days) and named in the next search, so Gemini
// starts from places known to publish waiver pieces instead of rediscovering them every time.
const HYPE_SOURCES_KEY = "gemini:waiverhype:sources:v1";
export function rememberSources(prev = [], out) {
  const count = new Map((Array.isArray(prev) ? prev : []).map((x) => [x.name, { name: x.name, n: Number(x.n) || 1 }]));
  const add = (name) => {
    const n = String(name || "").trim().replace(/^www\./, "").slice(0, 60);
    if (!n || /^https?:/i.test(n) || /vertexaisearch|grounding-api/i.test(n)) return;
    const e = count.get(n) || { name: n, n: 0 };
    e.n += 1;
    count.set(n, e);
  };
  for (const p of out?.players || []) for (const src of p.sources || []) add(src);
  for (const s of out?.sources || []) add(s.title);
  return [...count.values()].sort((a, b) => b.n - a.n).slice(0, 25);
}
const hypeInFlight = new Map();
export const hypeCacheKey = (season, week) => `gemini:waiverhype:v1:${season}:${week}`;

export function parseHype(arr) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(arr) ? arr : []) {
    if (!r?.name) continue;
    const pos = String(r.pos || r.position || "").toUpperCase().replace("DST", "DEF").replace("D/ST", "DEF");
    const key = `${String(r.name).toLowerCase()}|${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = ["spot", "ros", "stash"].includes(r.kind) ? r.kind : "ros";
    out.push({
      name: String(r.name).slice(0, 60),
      pos: ["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos) ? pos : null,
      team: r.team ? String(r.team).toUpperCase().slice(0, 4) : null,
      mentions: Math.max(1, Math.min(50, Math.round(Number(r.mentions) || 1))),
      sources: Array.isArray(r.sources) ? r.sources.slice(0, 5).map((s) => String(s).slice(0, 60)) : [],
      kind,
      dynasty: Boolean(r.dynasty) || kind === "stash",
      note: r.note ? String(r.note).slice(0, 240) : null,
    });
  }
  return out.sort((a, b) => b.mentions - a.mentions);
}

export async function waiverHype(season, week, { force = false, cacheOnly = false } = {}) {
  if (!isConfigured()) return null;
  const cacheKey = hypeCacheKey(season, week);
  const cached = cacheGet(cacheKey);
  if (cached && !force) return ai.applyRemovals("hype", cached);
  if (cacheOnly && !force) return null;
  if (hypeInFlight.has(cacheKey)) return hypeInFlight.get(cacheKey);
  const run = (async () => {
    // v4.3: preferred / removed sources from Account → AI sources (the most used ones are preferred automatically)
    migrateHypeSources();
    const prompt = `You are researching the fantasy football waiver wire for the ${season} NFL season, week ${week}. Use pieces published in the last 7 days.${ai.promptHints("hype")}
Search for:
1. Redraft waiver-wire "top adds" / pickups articles (e.g. FantasyPros, ESPN, Yahoo, CBS Sports, NFL.com, PFF, Rotoballer, The Athletic, 4for4, Fantasy Footballers).
2. Dynasty waiver-wire and stash articles (e.g. Dynasty Nerds, Dynasty League Football, KeepTradeCut, FantasyPros dynasty, PFF dynasty).
3. Reddit POSTS in r/fantasyfootball and r/DynastyFF about waiver adds (posts only, not comments).
4. X/Twitter POSTS by fantasy football analysts about waiver adds (posts only, not replies).
List every player recommended as a pickup (up to 60). For each: "mentions" = how many distinct articles/posts you found recommending him; "sources" = up to 4 outlet or account names; "kind" = "spot" (a one-week streamer or spot start), "ros" (should help for the rest of the season) or "stash" (longer-term: dynasty, rookies, handcuffs, injured players returning); "dynasty" = true if the recommendation came from dynasty coverage; "note" = the sources' argument in one sentence (max 30 words: role change, injury ahead of him, usage, schedule...).
Do not invent players or sources. Reply with ONLY a JSON array, no prose:
[{"name":"Full Name","pos":"WR","team":"NYJ","mentions":3,"sources":["FantasyPros","r/fantasyfootball"],"kind":"ros","dynasty":false,"note":"..."}]`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const cand = json?.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
    const arr = extractJson(text);
    if (!Array.isArray(arr)) {
      console.warn("[gemini] Waiver research: couldn't read a JSON array:", text.slice(0, 400));
      return null;
    }
    const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 20);
    const out = { at: Date.now(), model: MODEL(), players: parseHype(arr), sources };
    console.log(`[gemini] Waiver research ${season} wk${week}: ${out.players.length} players, ${sources.length} sources.`);
    cacheSet(cacheKey, out, HYPE_TTL);
    ai.recordRun("hype", out);
    return out;
  })();
  hypeInFlight.set(cacheKey, run);
  try {
    return ai.applyRemovals("hype", await run);
  } finally {
    hypeInFlight.delete(cacheKey);
  }
}
// v4.3: the v4.1 remembered-sources list moves into the AI sources tally (once).
function migrateHypeSources() {
  const old = cacheGet(HYPE_SOURCES_KEY);
  if (!old?.length || ai.getSeen("hype").counts.length) return;
  ai.recordRun("hype", { players: [{ sources: old.flatMap((x) => Array.from({ length: Math.min(5, Number(x.n) || 1) }, () => x.name)) }] });
}

/* ---------------- v4.3: start / sit ---------------- */
/**
 * One grounded search per batch of players (up to 40): this week's start/sit articles, rankings columns and expert
 * advice (last 7 days). For each player the sources discuss: how many say start and how many say sit, a verdict —
 * "start" (clear majority start), "sit" (clear majority sit) or "mixed" — a short summary of the arguments, and the
 * source names. Players nobody discusses are left out (no icon). Results are merged into one cache per week, keyed
 * by Sleeper id, so the scheduled runs and the Roster page's "research" button add to each other.
 * players: [{ id, name, pos, team }]. Returns { at, byId: { id: { verdict, start, sit, summary, sources, at } }, sources }.
 */
const SS_TTL = 8 * 24 * 60 * 60 * 1000;
const SS_FRESH = 12 * 60 * 60 * 1000;
export const startSitKey = (season, week) => `gemini:startsit:v1:${season}:${week}`;
const ssInFlight = new Map();
const ssPending = new Set(); // ids being researched right now (parallel league builds share them)
let ssFailUntil = 0; // after a failure, background runs wait an hour (a button press still tries)
const normName = (n) => String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.'`]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Gemini's rows → { id: result } for the players asked about (matched by name + position). Pure. */
export function parseStartSit(arr, players, at = Date.now()) {
  const byKey = new Map();
  for (const p of players) {
    byKey.set(`${normName(p.name)}|${p.pos}`, p.id);
    if (!byKey.has(`${normName(p.name)}|`)) byKey.set(`${normName(p.name)}|`, p.id);
  }
  const out = {};
  for (const r of Array.isArray(arr) ? arr : []) {
    if (!r?.name) continue;
    const pos = String(r.pos || "").toUpperCase().replace("DST", "DEF").replace("D/ST", "DEF");
    const id = byKey.get(`${normName(r.name)}|${pos}`) || byKey.get(`${normName(r.name)}|`);
    if (!id) continue;
    const start = Math.max(0, Math.round(Number(r.startVotes) || 0));
    const sit = Math.max(0, Math.round(Number(r.sitVotes) || 0));
    if (start + sit === 0) continue;
    let verdict = ["start", "mixed", "sit"].includes(r.verdict) ? r.verdict : null;
    // the counts decide when Gemini's label disagrees with them: 2/3 or more one way = clear
    const share = start / (start + sit);
    const byCount = share >= 2 / 3 ? "start" : share <= 1 / 3 ? "sit" : "mixed";
    if (!verdict || verdict !== byCount) verdict = byCount;
    out[id] = { verdict, start, sit, summary: r.summary ? String(r.summary).slice(0, 500) : null, sources: Array.isArray(r.sources) ? r.sources.slice(0, 5).map((s) => String(s).slice(0, 60)) : [], at };
  }
  return out;
}

export function startSitCached(season, week) {
  const c = cacheGet(startSitKey(season, week));
  return c ? ai.applyRemovals("startsit", c) : null;
}

/** Researches the players not looked at in the last 12 hours (all of them with force). */
export async function startSit(season, week, players, { force = false } = {}) {
  if (!isConfigured() || !players?.length) return startSitCached(season, week);
  if (!force && Date.now() < ssFailUntil) return startSitCached(season, week);
  const key = startSitKey(season, week);
  const have = cacheGet(key) || { at: null, byId: {}, checked: {}, sources: [] };
  const now = Date.now();
  const todo = players.filter((p) => !ssPending.has(p.id) && (force || !have.checked?.[p.id] || now - have.checked[p.id] > SS_FRESH));
  if (!todo.length) return ai.applyRemovals("startsit", have);
  const flight = `${key}:${todo.map((p) => p.id).sort().join(",")}`;
  if (ssInFlight.has(flight)) return ssInFlight.get(flight);
  for (const p of todo) ssPending.add(p.id);
  const run = (async () => {
    const found = {};
    const checked = {};
    const removedIds = [];
    let newSources = [];
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      const lines = batch.map((p) => `- ${p.name} (${p.pos}${p.team ? `, ${p.team}` : ""})`).join("\n");
      const prompt = `You are researching fantasy football start/sit advice for the ${season} NFL season, week ${week}. Use pieces published in the last 7 days: start/sit articles, weekly rankings columns, "starts and sits" lists, expert advice on sites, Reddit posts and analysts' X posts (posts, not comments).${ai.promptHints("startsit")}
For EACH player below that at least one source discusses for week ${week}: "startVotes" = how many distinct sources say start him, "sitVotes" = how many say sit him, "verdict" = "start" when the sources clearly favour starting, "sit" when they clearly favour sitting, "mixed" otherwise; "summary" = the arguments on both sides in at most 60 words (matchup, role, injuries, weather); "sources" = up to 4 source names.
Leave out any player you find no start/sit advice for. Do not invent sources.
Players:
${lines}
Reply with ONLY a JSON array, no prose: [{"name":"Full Name","pos":"WR","team":"NYJ","startVotes":3,"sitVotes":1,"verdict":"start","summary":"...","sources":["FantasyPros","ESPN"]}]`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const cand = json?.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
      const arr = extractJson(text);
      if (!Array.isArray(arr)) {
        console.warn("[gemini] Start/sit: couldn't read a JSON array:", text.slice(0, 400));
        continue;
      }
      const got = parseStartSit(arr, batch);
      const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 20);
      for (const p of batch) {
        checked[p.id] = Date.now();
        if (got[p.id]) found[p.id] = got[p.id];
        else if (force) removedIds.push(p.id);
      }
      newSources = [...sources, ...newSources];
      ai.recordRun("startsit", { byId: got, sources });
      console.log(`[gemini] Start/sit ${season} wk${week}: ${Object.keys(got).length}/${batch.length} players discussed, ${sources.length} sources.`);
    }
    // merge into whatever is cached NOW (another league's run may have finished meanwhile)
    const latest = cacheGet(key) || { at: null, byId: {}, checked: {}, sources: [] };
    const byId = { ...latest.byId, ...found };
    for (const id of removedIds) delete byId[id];
    const merged = {
      at: Date.now(),
      byId,
      checked: { ...(latest.checked || {}), ...checked },
      sources: [...newSources, ...(latest.sources || [])].filter((x, j, all) => all.findIndex((y) => y.uri === x.uri) === j).slice(0, 40),
    };
    cacheSet(key, merged, SS_TTL);
    return ai.applyRemovals("startsit", merged);
  })();
  ssInFlight.set(flight, run);
  try {
    return await run;
  } catch (err) {
    ssFailUntil = Date.now() + 3600e3;
    throw err;
  } finally {
    ssInFlight.delete(flight);
    for (const p of todo) ssPending.delete(p.id);
  }
}
