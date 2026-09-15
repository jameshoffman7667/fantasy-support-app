import "dotenv/config";

const FP_BASE = process.env.FANTASYPROS_BASE_URL || "https://api.fantasypros.com/public/v2/json";

/**
 * All FantasyPros calls go through here, and only here. The API key is
 * read from process.env — it never touches client-side code, never gets
 * serialized into a response we send the browser, and never appears in
 * a URL that could show up in server logs (it's a header, not a query
 * param, on purpose).
 */
async function fpFetch(path, { retries = 2 } = {}) {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key || key === "your_key_here") {
    throw new Error(
      "FANTASYPROS_API_KEY is not set. Copy server/.env.example to server/.env and add your real key."
    );
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${FP_BASE}${path}`, {
        headers: { "x-api-key": key, Accept: "application/json" },
      });
      if (res.status === 429 && attempt < retries) {
        // Rate limited — back off and retry rather than failing the whole request.
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`FantasyPros API error ${res.status} on ${path}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw lastErr;
    }
  }
  throw lastErr;
}

/**
 * NOTE ON QUERY PARAMETERS: FantasyPros' public docs page confirms the
 * endpoint paths and the x-api-key auth model, but the full parameter
 * reference lives behind their interactive API explorer at
 * https://api.fantasypros.com/v2/docs — which needs a live key to browse.
 * The params below (season/week/position/scoring) match their published
 * examples. If your account's response shape doesn't match what
 * buildLeague.js expects, check that page first — it's the source of
 * truth, not this file.
 */

export async function getProjections(season, week, { scoring = "PPR" } = {}) {
  const params = new URLSearchParams({ week: String(week), scoring });
  return fpFetch(`/nfl/${season}/projections?${params}`);
}

export async function getConsensusRankings(season, { position, scoring = "PPR", week } = {}) {
  const params = new URLSearchParams({ scoring });
  if (position) params.set("position", position);
  if (week) params.set("week", String(week));
  return fpFetch(`/nfl/${season}/consensus-rankings?${params}`);
}

export async function getPlayers() {
  return fpFetch(`/nfl/players`);
}

export async function getInjuries(season, week) {
  const params = new URLSearchParams({ week: String(week) });
  return fpFetch(`/nfl/${season}/injuries?${params}`);
}
