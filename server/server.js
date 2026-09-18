import "dotenv/config";
import express from "express";
import cors from "cors";
import * as sleeper from "./sleeper.js";
import { buildFullLeague } from "./buildLeague.js";
import { getFaabSuggestions } from "./faab.js";
import { setLastSession, getBuiltLeague, setBuiltLeague } from "./db.js";
import { startScheduler } from "./scheduler.js";

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store: connect once, keep the built league list around
// so refresh can diff against it. Fine for personal use on one machine;
// swap for a real session store if you deploy this for multiple people.
// (The SQLite layer in db.js is separate from this — that's what
// actually survives a restart; this Map is just per-process request state.)
const sessions = new Map(); // sessionId -> { userId, username, leaguesRaw, week, builtLeagues, trackedLeagueIds }

function newSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, fantasyProsKeySet: Boolean(process.env.FANTASYPROS_API_KEY && process.env.FANTASYPROS_API_KEY !== "your_key_here") });
});

// Step 1: username -> Sleeper user + their leagues for the current season.
app.get("/api/connect", async (req, res) => {
  const username = String(req.query.username || "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });
  try {
    const user = await sleeper.getUser(username);
    if (!user) return res.status(404).json({ error: "No Sleeper user found with that username." });
    const state = await sleeper.getState();
    const leaguesRaw = await sleeper.getUserLeagues(user.user_id, state.season);
    if (leaguesRaw.length === 0) {
      return res.status(404).json({ error: "That account has no leagues for the current season." });
    }
    const sessionId = newSessionId();
    sessions.set(sessionId, { userId: user.user_id, username, leaguesRaw, week: state.week, builtLeagues: [], trackedLeagueIds: [] });
    res.json({
      sessionId,
      user: { user_id: user.user_id, display_name: user.display_name },
      week: state.week,
      leagues: leaguesRaw.map((l) => ({ league_id: l.league_id, name: l.name, season: l.season })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't reach Sleeper." });
  }
});

// Step 2: build (or rebuild, on refresh, or on a week change) the
// selected leagues with real Sleeper + real FantasyPros/ESPN data merged in.
app.post("/api/leagues/build", async (req, res) => {
  const { sessionId, leagueIds, week } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Unknown session — connect again." });
  if (!Array.isArray(leagueIds) || leagueIds.length === 0) {
    return res.status(400).json({ error: "leagueIds must be a non-empty array." });
  }

  if (Number.isInteger(week) && week >= 1 && week <= 22) {
    session.week = week;
  }
  session.trackedLeagueIds = leagueIds;

  try {
    const chosen = session.leaguesRaw.filter((l) => leagueIds.includes(l.league_id));
    const trending = await sleeper.getTrendingAdds(60, 24);
    const built = [];
    // Sequential, not Promise.all — FantasyPros' free/personal tiers have
    // modest rate limits, and this keeps errors attributable to one league
    // instead of Promise.all's all-or-nothing rejection.
    for (const leagueSummary of chosen) {
      try {
        const league = await buildFullLeague(session.userId, leagueSummary, session.week, trending, session.builtLeagues);
        built.push(league);
        setBuiltLeague(session.username, leagueSummary.league_id, league);
      } catch (err) {
        // A live build failing doesn't have to mean an empty screen —
        // if the background scheduler (or a previous successful build)
        // left a cached copy in SQLite, serve that instead, clearly
        // marked as stale, rather than just an error card.
        const cached = getBuiltLeague(session.username, leagueSummary.league_id);
        if (cached) {
          built.push({ ...cached.data, stale: true, staleUpdatedAt: cached.updatedAt, dataWarnings: [`Showing cached data from ${new Date(cached.updatedAt).toLocaleString()} — a fresh build just failed: ${err.message}`, ...(cached.data.dataWarnings || [])] });
        } else {
          built.push({ id: leagueSummary.league_id, name: leagueSummary.name, error: err.message });
        }
      }
    }
    session.builtLeagues = built.filter((l) => !l.error);
    setLastSession(session.username, leagueIds, session.week);
    res.json({ leagues: built, week: session.week });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't build leagues." });
  }
});

// FAAB suggestions for one league's current waiver pool, using bid
// history pooled across every currently-tracked league (see faab.js for
// why "all Sleeper leagues" isn't achievable, and what the percentiles
// below actually mean statistically).
app.post("/api/faab", async (req, res) => {
  const { sessionId, leagueId } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Unknown session — connect again." });

  const targetLeague = session.builtLeagues.find((l) => l.id === leagueId);
  if (!targetLeague) return res.status(400).json({ error: "That league hasn't been built yet — refresh the dashboard first." });

  try {
    const trackedIds = session.trackedLeagueIds.length ? session.trackedLeagueIds : [leagueId];
    const fullLeagues = await Promise.all(
      trackedIds.map((id) => sleeper.getLeague(id).catch(() => null))
    );
    const sleeperPlayers = await sleeper.getPlayers();
    const result = await getFaabSuggestions(
      targetLeague.freeAgents || [],
      fullLeagues.filter(Boolean),
      sleeperPlayers,
      session.week
    );
    const thisLeague = fullLeagues.find((l) => l?.league_id === leagueId);
    res.json({ ...result, budget: thisLeague?.settings?.waiver_budget ?? null });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't compute FAAB suggestions." });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fantasy manager server listening on http://localhost:${PORT}`);
  if (!process.env.FANTASYPROS_API_KEY || process.env.FANTASYPROS_API_KEY === "your_key_here") {
    console.warn("⚠️  FANTASYPROS_API_KEY is not set — copy server/.env.example to server/.env and add your key.");
  }
  startScheduler();
});
