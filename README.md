# Fantasy Manager — real Sleeper + FantasyPros app

A running (not preview-sandboxed) multi-league fantasy manager, packaged
as two containers:

- **`server`** — Express backend. The only place your FantasyPros API
  key ever lives. Talks to Sleeper and FantasyPros, merges the results.
- **`client`** — the React UI, built to static files and served by
  nginx, which proxies `/api/*` to the server container over Docker's
  internal network.

Deployable three ways: Portainer from a GitHub repo (no terminal needed
once it's pushed), plain `docker compose` locally, or running each side
with Node/Vite directly for active development. All three are covered
below.

## What's new in this round

A large batch of changes, roughly in order of how much they change the architecture:

- **A real local database.** `server/db.js` (SQLite via `better-sqlite3`)
  replaces the in-memory-only caches from earlier rounds. It survives
  container restarts/redeploys (backed by a named Docker volume — see
  `docker-compose.yml`), and adds three things that weren't possible
  before: an **hourly background refresh** (`server/scheduler.js`) that
  keeps your last-connected leagues warm even if nobody has the app
  open, a **stale-data fallback** (if a live rebuild fails, the last
  good cached version is served instead of an error, clearly marked as
  stale), and **persistent Injury Watch** (see below).
- **Injury Watch now persists.** Previously it only showed a change
  since the last refresh, then forgot it. Now a currently-injured player
  shows up every time — Minor once you've seen that exact status before,
  Major the first time — using SQLite to remember what's been seen, not
  an in-memory diff.
- **A real player-ID crosswalk.** `server/playerIdMap.js` pulls the
  [ffb_ids](https://github.com/mayscopeland/ffb_ids) community dataset
  (Sleeper/ESPN/FantasyPros/Yahoo/CBS/NFL.com IDs) and uses it for a real
  ID join between Sleeper and ESPN — replacing fuzzy name-matching for
  any player in the crosswalk. FantasyPros still goes through name
  matching (see the caveats section — no confirmed ID field to join on
  there), but the crosswalk's canonical name is tried as a second
  candidate alongside Sleeper's name.
- **ESPN as a projections fallback.** Where FantasyPros has nothing for
  a player (scrape miss, free-tier gap, name mismatch), `server/espnProjections.js`
  now tries ESPN's public per-athlete projections endpoint before giving
  up. Lineup Advice and Waivers show a small `FP`/`E` tag in the bottom
  corner of each player card indicating which source it came from.
- **Taxi squad support**, shown as its own section on the Roster tab,
  alongside a similarly new IR section (previously IR players were
  fetched but never actually displayed anywhere).
- **`SUPER_FLEX` now displays as `SFLX`** everywhere a slot label shows up.
- **Lineup Advice is now a real side-by-side comparison** — current
  lineup and optimal lineup shown together per slot, changed players
  highlighted (red = drop, green = the suggested replacement), with the
  point swing shown per slot, not just as one lump total.
- **Kickoff time now shows on every Roster tab player card**, not just
  used internally for the lock-order check.
- **Browser back/forward now works.** Real `history.pushState`/`popstate`
  integration — previously every "back" action was an in-app button with
  no relationship to the browser's own history stack.
- **Breadcrumb navigation replaces the back button** — `username >
  League Name > Sub-tab name` in the header, every level but the current
  one clickable.
- **Accounts stay logged in across visits** (this was actually already
  true from the previous round — see below for what's genuinely new
  here): **Log out** and **Edit tracked leagues** are both on the
  dashboard now.
- **Dashboard cards show your team name** in that league instead of week
  number/scoring format (which are still visible on the league-overview
  screen, just not repeated on every card).
- **FAAB bid suggestions** — a new panel on the Waivers tab. Read the
  caveats section below before trusting these; the honest short version
  is "directional guide from a small sample," not "confidence interval."

## Why a backend at all?

1. **Your FantasyPros key can't live in client-side code.** Anyone who
   opens dev tools on a page can read every request it makes, including
   headers. It has to sit in a server process instead.
2. **It sidesteps CORS entirely.** Server-to-server calls aren't subject
   to the browser's cross-origin restrictions that blocked an earlier,
   client-only version of this from reaching `api.sleeper.app` directly.

## Get a FantasyPros API key

`https://secure.fantasypros.com/api-keys/request` — a free tier exists
for building/prototyping. Keep it out of chat, commits, and the image —
see the security note near the bottom.

---

## Option A — Deploy via Portainer from GitHub (no terminal)

**1. Push this folder to a GitHub repo** — `docker-compose.yml` needs to
sit at the repo root, alongside the `server/` and `client/` folders,
exactly as it's structured here. `.gitignore` already excludes
`node_modules`, `.env`, and `dist` — you don't need to touch those.

**2. In Portainer:** Stacks → **Add stack** → **Repository** build
method.
- Repository URL: your repo's URL
- Repository reference: `refs/heads/main` (or whichever branch)
- Compose path: `docker-compose.yml` (default, since it's at the root)
- If the repo is private, Portainer needs Git credentials configured
  under Settings → Registries or entered directly on this form,
  depending on your Portainer version.

**3. Environment variables section (same form):** add
```
FANTASYPROS_API_KEY = <your real key>
```
This is the key step that replaces the `.env` file — Portainer stores it
and injects it at deploy time. Optionally also set `SERVER_PORT` /
`CLIENT_PORT` if the defaults (4000 / 8080) collide with something else
already running on that host.

**4. Deploy the stack.** Portainer clones the repo and builds both
images. First build takes a couple minutes (pulling `node:20-alpine` and
`nginx:alpine`, running `npm install` in each); rebuilds after that are
faster.

**5. Open `http://<your-server-host>:8080`** (or whatever `CLIENT_PORT`
you set). That's the app.

**To update after pushing new commits:** Portainer's stack page has a
"Pull and redeploy" action (exact wording varies by version) — no need
to re-enter the environment variables, Portainer keeps them.

---

## Option B — `docker compose` locally, no Portainer

```bash
cp .env.example .env
# open .env and paste your real key in place of "your_key_here"
docker compose up --build
```
Open `http://localhost:8080`. Stop with `Ctrl+C`, or `docker compose down`.

---

## Option C — Node/Vite directly, no Docker (for active development)

```bash
# terminal 1
cd server
npm install
cp .env.example .env   # paste your real key in
npm run dev

# terminal 2
cd client
npm install
npm run dev
```
Open the URL Vite prints (typically `http://localhost:5173`). Vite's dev
server proxies `/api` to `http://localhost:4000` — see
`client/vite.config.js`.

---

## Security note before you expose this beyond localhost

**There's no login screen.** Anyone who can reach the client's port can
type in any Sleeper username and pull data through your FantasyPros key
and quota — there's nothing here stopping them. That's a fine tradeoff
for "runs on my home server, on my LAN, for me" (the situation this
Portainer setup is built for), but if you're port-forwarding this to the
open internet, put it behind something with auth first — a reverse
proxy with basic auth (Caddy, Traefik, nginx) or a VPN like Tailscale
are both reasonable, low-effort options. I haven't built either in —
say the word if you want one added.

## What's actually real vs. a known gap

| Tab | Status |
|---|---|
| Roster Optimization | Fully real now, including flex lock-order and bye-week checks — kickoff times and byes come from ESPN's public (unofficial) scoreboard endpoint, cross-referenced by team. See the ESPN caveat below. |
| Lineup Advice | Real. Server computes an optimal lineup from your actual roster + real FantasyPros projections, via a greedy slot-filling algorithm (strict positions first, then FLEX/SUPERFLEX from what's left). A strong heuristic, not a proven-optimal solver. |
| Waiver Management | Real. Sleeper trending-adds, filtered against every roster in the league (not just yours), cross-referenced with real FantasyPros ECR for the rank-threshold half of the severity rule. |
| Trade Radar | Real, but a heuristic: flags a position where your average rostered ECR is weak and a league-mate shows real depth there — not a dedicated trade-value model (FantasyPros doesn't publish one via this API). Needs at least 3 ECR-matched players at a position on both sides of a comparison to surface anything, so it depends on ECR coverage being decent. |
| Injury Watch | Real. Diffs each refresh against the previous snapshot (held in server memory) so it only flags genuine status changes. Refreshes on the manual button **and automatically every 30 minutes** while the app is open in a tab, matching the functional spec's normal-cadence interval. |

### Accounts remember you, and a week selector (from a previous round)

- **Persistence**: your Sleeper username and which leagues you're tracking are saved in the browser (`localStorage`) after you connect. Reopening the app reconnects automatically — no re-entering anything. This is safe here specifically because this is a real deployed app, not a sandboxed preview; nothing sensitive (no API key, no session token) is stored this way.
- **Log out** (on the dashboard) clears that saved state and returns you to the connect screen.
- **Edit tracked leagues** (also on the dashboard) re-pulls your current Sleeper league list and lets you change your selection without logging out — handles the case where the server restarted and forgot your session, transparently.
- **Week dropdown** in the header, available on the dashboard, league overview, and every tab — changing it rebuilds every tracked league for that week (fresh Sleeper roster-for-week + FantasyPros projections/ECR for that week).

### ESPN schedule integration (kickoff times + bye weeks)

`server/schedule.js` calls ESPN's scoreboard endpoint
(`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`) — this
is **unofficial and undocumented**, confirmed working live against the
real 2026 season during development, but Google/ESPN could change or
remove it without notice. If it ever starts failing, `buildLeague.js`
degrades gracefully: kickoff times show as "unavailable" and bye
detection just doesn't run for that league, rather than the whole build
failing. A small `TEAM_ALIASES` map handles the couple of team
abbreviations Sleeper and ESPN don't spell identically (e.g.
Washington) — it isn't exhaustive by construction, so a genuine new
mismatch just results in "kickoff time unavailable" for that team's
players, not a crash.

### Projections: scraped, not pulled from the API (as of this round)

`/consensus-rankings` (ECR) still goes through FantasyPros' API — it's
not capped the way `/projections` is. But `/projections` was capped at
roughly the top 10 players per position on the free tier, which is why
most bench/waiver players had no projection at all. `server/fantasyProsScrape.js`
now scrapes FantasyPros' public projections pages
(`fantasypros.com/nfl/projections/{qb,rb,wr,te}.php`) instead, which show
the full list.

**What I checked before building this, not after:**
- `fantasypros.com/robots.txt` explicitly *allows* crawling
  `/nfl/projections/` (it only disallows `/ranker/`, `/ajax/`, `/api/`,
  `/json/`, `/xml/`), with a `Crawl-delay: 5` — enforced in code, not
  just documented.
- There's prior art: `ffpros`, an actively-maintained R package under
  the [ffverse](https://ffverse.com) project, scrapes these exact same
  pages the same way, and is one of several ffverse packages worth
  knowing about — `ffscrapr` (multi-platform league API client, the
  same job `sleeper.js` does but for MFL/Fleaflicker/ESPN too),
  `ffsimulator` (bootstrap-resampling season simulations over
  historical ADP + play-by-play + FantasyPros data), and
  `ffopportunity` (an xgboost expected-fantasy-points model on
  nflverse play-by-play). All R, not directly reusable in this Node
  stack, but `ffsimulator` in particular is a reasonable reference if a
  future "season outlook" feature is ever worth adding here.

**What's genuinely unresolved:** `robots.txt` governs crawler etiquette,
not a legal license — FantasyPros' actual Terms of Use may separately
restrict automated access even to pages `robots.txt` permits crawling
(common on sites that also sell a paid API for the same data). This
wasn't glossed over; it's a real tradeoff, and part of why the ECR data
stays on the official API rather than also being scraped.

**What's best-effort, not confirmed:** the exact table markup. The
tools used to research this render pages as cleaned text, not raw HTML,
so the parser targets the table containing an "FPTS" header and pulls
name/team/points heuristically rather than against verified CSS
selectors. It logs one sample parsed row to the server console on first
real run — check that against what's actually on
`fantasypros.com/nfl/projections/qb.php` if projections come back empty
or wrong.

**Practical tradeoffs of scraping vs. the API:**
- **Slower on a cold cache.** With the 5-second crawl delay honestly
  enforced, the first projections fetch after the hourly cache expires
  takes 20+ seconds (4 positions × 5s, plus page-load time) before that
  league build response comes back. Cached requests within the hour are
  instant, same as before.
- **More brittle.** A page-layout change on FantasyPros' end breaks this
  silently (parses to empty/wrong data) where an API contract usually
  wouldn't. One position failing to parse doesn't take down the other
  three, but it's worth spot-checking output occasionally.

### Player-ID matching: a real crosswalk now, not just name-guessing

`server/playerIdMap.js` pulls a community-maintained CSV
([ffb_ids](https://github.com/mayscopeland/ffb_ids)) mapping Sleeper,
ESPN, FantasyPros, Yahoo, CBS, and NFL.com IDs for the same players. Two
honest caveats about it:

- **The exact CSV column headers were never directly verified.** GitHub's
  raw-file path was robots-disallowed for the tool used to research this,
  so the header row was never actually read while writing the parser. It
  discovers columns dynamically at runtime instead (fuzzy-matches header
  text containing "sleeper"/"espn"/"fantasypros"/"name") and logs what it
  found on first load — check the server console if the crosswalk seems
  to be returning nothing.
- **It gives a real ID join for ESPN, not for FantasyPros.** The
  crosswalk has a `fantasyprosId` column, but neither FantasyPros' scraped
  projections pages nor the `/consensus-rankings` API response (confirmed
  shape: `rank_ecr`, `player_name`, `player_team_id`, `tier`) expose an ID
  field to join it against. So FantasyPros matching is still name-based —
  the crosswalk just adds its canonical name as a second candidate
  alongside Sleeper's, which helps with some spelling differences but
  isn't a full fix. ESPN, by contrast, gets looked up by the crosswalk's
  `espnId` directly wherever it's available, which is meaningfully more
  reliable than the 20,000-athlete name index it falls back to otherwise.

### ESPN as a projections fallback — least-verified piece in the app

`server/espnProjections.js` is called only when FantasyPros has nothing
for a player. The endpoint (`sports.core.api.espn.com/.../athletes/{id}/projections`)
is confirmed to exist and need no auth, cross-referenced across multiple
independent community API-documentation sources — but the exact JSON
field names for a fantasy-points total were **not** directly confirmed
(no tool available while building this could return raw JSON from it).
The parser tries several plausible shapes based on ESPN's general API
conventions and returns `null` — not a guess — if none match. It logs
the raw response's top-level keys to the server console on first use
specifically so a shape mismatch is obvious immediately. If projections
tagged `E` look wrong or are always absent, that log line is the place
to start.

### FAAB suggestions — read this before trusting the numbers

The original idea was bid data "across all 2026 Sleeper leagues." That's
not achievable: Sleeper's API (confirmed against their own docs and five
independent third-party wrappers) has no way to browse or search leagues
platform-wide — every endpoint needs a league ID you already have.
`server/faab.js` only ever sees bids in the leagues *this app is
tracking*, which is a real, meaningful scope reduction from what was
originally asked for.

That has a statistical consequence worth being direct about: with maybe
a few dozen winning bids total across a couple of tracked leagues,
there's usually zero or one data point for any *specific* player —
nowhere near enough for genuine "70%/95% confidence of winning this
exact player." What's actually computed is the 70th/95th percentile of
**all recent winning bids as a % of budget**, grouped by position when
there's a big enough sample (10+) and falling back to the overall
distribution otherwise. Read a suggestion as "bids around this level
tend to win, for players like this one" — a directional reference point,
not a confidence interval on one player. The panel's own copy says this
too, not just this README.

### Persistent Injury Watch and the local database

Previously, Injury Watch only showed a status *change* since the last
refresh, then forgot about it. Now `server/db.js` (SQLite) remembers
which player+status combinations have already been shown, so a
currently-injured player appears on every refresh — Minor once seen
before, Major the first time — until they're healthy again, at which
point their record clears so a *future* re-injury with the same status
is correctly treated as new. This, the generic response cache, and the
hourly background refresh (`server/scheduler.js`) all live in the same
SQLite file, mounted as a named Docker volume so it survives redeploys,
not just restarts.

### Other things to know

- **SQLite needs native compilation.** `better-sqlite3` isn't a pure-JS
  package, so `server/Dockerfile` is now multi-stage: a build stage with
  `python3`/`make`/`g++` compiles it, and the final image doesn't carry
  that toolchain. If a Portainer build fails at the `npm install` step,
  a Node/Alpine ABI mismatch here is the most likely cause — check the
  build log for node-gyp errors specifically.
- **The hourly background refresh only tracks one user** — whoever most
  recently ran `/api/leagues/build` (recorded in SQLite's `last_session`
  table). That matches what was actually asked for ("the last logged-in
  user's team-specific data"), not a general multi-user warm-cache
  system. If multiple people use the same deployment, only the most
  recent one's leagues get proactively refreshed in the background;
  everyone still gets on-demand builds when they open the app.
- **Session storage is in-memory**, per running `server` container.
  Restarting/redeploying it forgets active sessions — the client's
  auto-reconnect (see above) papers over this from the user's side, but
  it does mean every reconnect creates a fresh session server-side; old
  ones aren't actively cleaned up. Fine for personal use over normal
  usage patterns; worth adding a TTL/eviction if this ever runs for a
  long time with many users. Would need Redis or a DB before scaling to
  multiple replicas regardless.
- **FantasyPros query parameters**: endpoint paths and `x-api-key` auth
  are confirmed from FantasyPros' public docs page. The full parameter
  reference lives behind their interactive API explorer (needs a live
  key). If your account's response shape doesn't match what
  `buildLeague.js` expects, that explorer is the source of truth to
  check — not this README.
- **Rate limits**: FantasyPros' free/personal API tier is roughly **50
  requests/day**. Each league build costs 4 API calls (one
  `/consensus-rankings` per position) — projections are scraped, not
  API calls, so they don't count against this. `server/fantasyPros.js`
  caches every API response for 10 minutes via SQLite, shared across all
  your tracked leagues. A 429 gets one automatic retry with backoff
  before it surfaces as an error.
- **`/consensus-rankings` has no "all positions" option** — confirmed
  via a live 400 response, which is also how the exact valid position
  values got confirmed (`QB, RB, WR, TE, K, OP, FLX, DST, IDP, DL, LB,
  DB, TK, TQB, TRB, TWR, TTE, TOL, HC, P`). `buildLeague.js` calls it
  once per position the app actually needs (QB/RB/WR/TE) and merges the
  results — that's also why each player record gets tagged with the
  position it was fetched under rather than trusting a position field in
  the response, since the confirmed response shape (`rank_ecr`,
  `player_name`, `player_team_id`, `tier`) doesn't include one.

## Project layout

```
docker-compose.yml    Both services + a named volume for the SQLite DB;
                       reads FANTASYPROS_API_KEY from Portainer's env vars or a root .env
.env.example           Template for local `docker compose up` (skip if using Portainer)
server/
  server.js             Express app + routes (+ FAAB endpoint)
  sleeper.js             Sleeper API client (no auth needed)
  fantasyPros.js          FantasyPros API client (uses your key, server-only) — now just consensus-rankings
  fantasyProsScrape.js     FantasyPros projections scraper (robots.txt-compliant, replaces the truncated API endpoint)
  espnProjections.js       ESPN projections fallback for players FantasyPros has nothing for
  schedule.js             ESPN kickoff-time/bye-week client (unofficial endpoint)
  playerIdMap.js          ffb_ids ID crosswalk (Sleeper/ESPN/FantasyPros/etc)
  matching.js             Name-based cross-source player matching
  buildLeague.js          Merges everything into the shape the UI renders
  db.js                   SQLite: generic cache, persistent injury tracking, session/build cache
  scheduler.js             Hourly background refresh for the last-active user's leagues
  faab.js                  FAAB bid-percentile suggestions (tracked leagues only — see caveats)
  Dockerfile              Multi-stage: compiles better-sqlite3, final image has no compiler toolchain
  .env.example            Template for native `npm run dev` (Option C)
client/
  src/App.jsx            The UI (breadcrumb nav, dashboard, league overview, 5 tabs)
  src/api.js              Calls our own backend, never external APIs directly
  Dockerfile              Multi-stage: vite build -> nginx serves it
  nginx.conf               Proxies /api to the server container by service name
  vite.config.js           Proxies /api to localhost:4000 (dev only, Option C)
```

## A note on how far this was actually tested

I don't have a Docker daemon, a Portainer instance, or network access in
the sandbox I write code in — so nothing here has actually been built,
deployed, or run against a live network. What I did do: every JS/JSX
file parses cleanly (checked with both `node --check` and a `tsc` JSX
pass), and — specifically because syntax checks can't catch a function
that's called but never defined — I cross-referenced every cross-module
function call against that module's actual exports by hand. That caught
a real bug: `buildLeague.js` called `sleeper.getLeagueUsers()` (needed
for team names) but that function had been dropped from `sleeper.js` in
an earlier rewrite and never re-added. It's fixed now, but it's a good
illustration of this project's actual test ceiling — logical/runtime
correctness beyond "does it parse" is unverified until it runs for real.
If something throws on first deploy, the server console log is the
fastest path to a fix; paste it here.

**Newest, least-verified pieces**, roughly in order of how much I'd
double-check first:
1. **`espnProjections.js`** — the endpoint's existence is confirmed, the
   exact JSON field names for a fantasy-points value are not. Logs raw
   response keys on first use.
2. **`playerIdMap.js`** — the CSV's column headers were never directly
   read (GitHub's raw-file path was robots-blocked for my research
   tools specifically); columns are discovered by fuzzy-matching header
   text at runtime instead, and logged on first load.
3. **`fantasyProsScrape.js`** (from a previous round, still the same
   caveat) — table markup targeted heuristically, not against confirmed
   raw HTML. Logs a sample parsed row on first run.

All three fail soft: a wrong guess returns `null`/empty rather than a
plausible-looking wrong number, and the app degrades (that player just
shows "no projection") rather than breaking.
