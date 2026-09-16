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

### New in this round: accounts remember you, and a week selector

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

### The one data-quality caveat worth understanding

Sleeper and FantasyPros share no player ID through either the API or
the scraped pages. Players are matched by **normalized name + position**
(`server/matching.js`). A rare name collision, a very recent trade, or —
now — a scrape-parsing edge case can miss a match; when that happens
`proj`/`ecr` come back `null` and the UI shows an explicit warning
naming the player, rather than silently showing a wrong number.

### Other things to know

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
  requests/day**. Now that projections are scraped instead of pulled
  through the API, each league build only costs 4 API calls (one
  `/consensus-rankings` per position) rather than 5 — a little more
  headroom than before, though `/consensus-rankings` itself isn't
  affected by the scraping change. `server/fantasyPros.js` still caches
  every API response for 10 minutes, shared across all your tracked
  leagues. A 429 gets one automatic retry with backoff before it
  surfaces as an error.
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
docker-compose.yml    Both services; reads FANTASYPROS_API_KEY from
                       Portainer's env vars or a root .env
.env.example           Template for local `docker compose up` (skip if using Portainer)
server/
  server.js             Express app + routes
  sleeper.js             Sleeper API client (no auth needed)
  fantasyPros.js          FantasyPros API client (uses your key, server-only) — now just consensus-rankings
  fantasyProsScrape.js     FantasyPros projections scraper (robots.txt-compliant, replaces the truncated API endpoint)
  schedule.js             ESPN kickoff-time/bye-week client (unofficial endpoint)
  matching.js             Name-based cross-source player matching
  buildLeague.js          Merges everything into the shape the UI renders
  Dockerfile              Builds the server image
  .env.example            Template for native `npm run dev` (Option C)
client/
  src/App.jsx            The UI (dashboard, league overview, 5 tabs)
  src/api.js              Calls our own backend, never external APIs directly
  Dockerfile              Multi-stage: vite build -> nginx serves it
  nginx.conf               Proxies /api to the server container by service name
  vite.config.js           Proxies /api to localhost:4000 (dev only, Option C)
```

## A note on how far this was actually tested

I don't have a Docker daemon, a Portainer instance, or network access in
the sandbox I write code in — so nothing here has actually been built,
deployed, or run against a live network. What I did check: both
Dockerfiles follow standard patterns (non-root user on the server,
multi-stage build on the client), the nginx proxy target matches the
compose service name exactly (`server`, not `localhost`), and every
JS/JSX file parses cleanly. The realistic failure modes on a first real
deploy: a Node/Alpine version quirk with a dependency, or Portainer's
compose parser being stricter/older than what's used here (the syntax
is intentionally plain — no newer Compose spec features — to minimize
that risk). If the build fails, paste me the Portainer build log and
I'll fix it.

**The FantasyPros scraper specifically** (`fantasyProsScrape.js`) is the
least-verified piece in the whole project — I confirmed the URL
pattern, query params, and that a real FPTS-column table exists on
those pages via page-reading tools that render cleaned text rather than
raw HTML, so the actual parsing selectors are best-effort, not
confirmed against real markup. It logs a sample parsed row to the
server console on first run specifically so a mismatch is visible
immediately rather than silently returning nothing. If projections come
back empty or obviously wrong after a real deploy, that log line plus
the actual page HTML (browser dev tools) is exactly what I'd need to
fix it correctly instead of guessing again.
