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
