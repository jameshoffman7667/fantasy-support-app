import { cacheGet, cacheSet } from "./db.js";

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
  if (cached && !force) return cached;

  const lines = games.map((g) => `- ${g.key} (favourite: ${g.favorite}, underdog: ${g.underdog}, ${g.kickoffLabel || ""})`).join("\n");
  const prompt = `You are helping with an NFL straight-up pick'em pool for ${season} week ${week}.
Search the web for this week's public pick'em articles, expert picks, and "upset picks" columns.
For EACH game below, count how many distinct articles/experts you found that pick the UNDERDOG to win outright, list up to 3 source names, and write a neutral note (max 70 words, same concise factual style) on injuries, weather, rest or motivation relevant to that game.
Games:
${lines}
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
  return out;
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
  if (cached && !force) return cached;
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
${lines}
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
  return out;
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
  if (cached && !force) return cached;

  const lines = items.map((i) => `- ${i.key}: ${i.name} (${i.pos}, ${i.team})${i.note ? ` — listed ${i.note}` : " — listed Questionable"}`).join("\n");
  const prompt = `You are checking NFL injury news for ${season} week ${week}. Each player below is listed Questionable.
Search the web for the latest practice reports (Wednesday / Thursday / Friday participation) and recent articles or posts from reporters about each player's chances of playing.
For EACH player reply with:
- "flag": "down" if practice participation was downgraded through the week (for example limited then did not practice) or he did not practice at all, or recent reporting trends toward him missing the game; "ok" if he practiced fully or reporting says he is expected to play; "unclear" if you cannot tell.
- "practice": a few words, for example "DNP, DNP, limited" or "unknown".
- "note": max 30 words of what you found. Do not invent news; say "unclear" if you find nothing.
Players:
${lines}
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
  return out;
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
