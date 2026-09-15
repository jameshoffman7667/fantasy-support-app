import "dotenv/config";
import express from "express";
import cors from "cors";
import * as sleeper from "./sleeper.js";
import { buildFullLeague } from "./buildLeague.js";

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store: connect once, keep the built league list around
// so refresh can diff against it for Injury Watch. Fine for personal use
// on one machine; swap for a real session store if you deploy this for
// multiple people.
const sessions = new Map(); // sessionId -> { userId, leaguesRaw, week, builtLeagues }

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
    sessions.set(sessionId, { userId: user.user_id, leaguesRaw, week: state.week, builtLeagues: [] });
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

// Step 2: build (or rebuild, on refresh) the selected leagues with real
// Sleeper + real FantasyPros data merged in.
app.post("/api/leagues/build", async (req, res) => {
  const { sessionId, leagueIds } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Unknown session — connect again." });
  if (!Array.isArray(leagueIds) || leagueIds.length === 0) {
    return res.status(400).json({ error: "leagueIds must be a non-empty array." });
  }

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
      } catch (err) {
        built.push({ id: leagueSummary.league_id, name: leagueSummary.name, error: err.message });
      }
    }
    session.builtLeagues = built.filter((l) => !l.error);
    res.json({ leagues: built, week: session.week });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't build leagues." });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fantasy manager server listening on http://localhost:${PORT}`);
  if (!process.env.FANTASYPROS_API_KEY || process.env.FANTASYPROS_API_KEY === "your_key_here") {
    console.warn("⚠️  FANTASYPROS_API_KEY is not set — copy server/.env.example to server/.env and add your key.");
  }
});
