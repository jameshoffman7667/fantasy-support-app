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
  const cacheKey = `gemini:upsets:${season}:${week}`;
  const cached = cacheGet(cacheKey);
  if (cached && !force) return cached;

  const lines = games.map((g) => `- ${g.key} (favourite: ${g.favorite}, underdog: ${g.underdog}, ${g.kickoffLabel || ""})`).join("\n");
  const prompt = `You are helping with an NFL straight-up pick'em pool for ${season} week ${week}.
Search the web for this week's public pick'em articles, expert picks, and "upset picks" columns.
For EACH game below, count how many distinct articles/experts you found that pick the UNDERDOG to win outright, list up to 3 source names, and write a neutral note (max 35 words) on injuries, weather, rest or motivation relevant to that game.
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
      note: r.note ? String(r.note).slice(0, 300) : null,
    };
  }
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter((s) => s.uri).slice(0, 12);
  const out = { at: Date.now(), model: MODEL(), byGame, sources };
  console.log(`[gemini] Upset scan for ${season} wk${week}: ${Object.keys(byGame).length} games, ${sources.length} grounding sources.`);
  cacheSet(cacheKey, out, TTL);
  return out;
}
