# Fantasy Manager — real Sleeper + FantasyPros app

*Current version: v7 — see [CHANGELOG.md](./CHANGELOG.md) for what
changed in this and every prior version.*

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

## What's new in this round (projection pipeline fix + Docker Hub packaging)

- **Projection pipeline corrected to a proper 3-tier waterfall**, per
  direct correction: (1) FantasyPros **API** `/projections` first,
  matched via a real ID join (crosswalk `sleeper_id`/`fantasyprosId` →
  API's own `fpid` field) — capped at ~10 players/position on the free
  tier, but real IDs where it has data; (2) FantasyPros **scraped
  pages**, name-fuzzy-matched, filling whatever tier 1's cap left out —
  confirmed scraped rows carry no usable ID, so the speculative
  data-attribute extraction added last round (which never had that
  confirmation) has been removed rather than left as false hope; (3)
  **ESPN**, ID-joined via the crosswalk's `espnId` column, only for
  whatever both FantasyPros tiers still miss. Previously tiers 1 and 2
  were reversed in priority and tier 1 wasn't ID-joined at all.
- **Docker Hub image packaging.** `docker-compose.yml` is now the
  prebuilt-image version (no `build:` key at all — Portainer just pulls),
  with the old build-from-source file preserved as
  `docker-compose.local-build.yml` for local dev. A new GitHub Actions
  workflow (`.github/workflows/docker-publish.yml`) builds and pushes
  both images, multi-arch (amd64 + arm64), on every push to `main`.

## What's new from the previous round

- **Real root cause found for missing K/DST projections**: those two
  positions were never even fetched (only QB/RB/WR/TE were requested at
  all). Fixed, plus a `DEF`→`DST` position-name translator (Sleeper and
  FantasyPros spell defenses differently) and a team-abbreviation
  fallback match for defenses specifically, since name-matching a
  defense is inherently less reliable than a skill player.
- **Real ID join added for ESPN** via the ffb_ids crosswalk's `espnId`
  column — replaces fuzzy name-matching for any player the crosswalk
  covers. Attempted (best-effort, unconfirmed) for FantasyPros too, by
  trying to extract a row ID from the scraped page's markup — logs
  whether it actually found one.
- **ESPN kickoff-time bug fixed**: the season-year query param was
  wrong (`year=` instead of the confirmed-correct `dates=`), and even
  after fixing that, a live test still showed the endpoint returning a
  different week than requested — strongly suggesting a caching layer
  in front of it. Added a cache-busting param and explicit
  request-vs-response week validation, logged loudly if it's ever still
  wrong, since this couldn't be fully re-verified from here.
- **Lineup Advice no longer flags non-consequential swaps.** Previously,
  two interchangeable players with equal projections could get flagged
  as a "recommended change" just because the solver's internal fill
  order assigned them to each other's slots — same total score, no real
  difference. Now a player is only shown as changed if they're actually
  entering or leaving the starting lineup.
- **Waivers filters out K/DST for leagues that don't start those
  positions.**
- **Trade Radar rebuilt** to show every team's strengths/weaknesses (not
  just yours), with suggested trades grouped under each opposing team —
  matching the intended design of "identify weaknesses per team, then
  suggest a mutually beneficial swap." Uses average ECR by position as
  the "team strength" signal (rest-of-season-oriented by nature) rather
  than literal rest-of-season point totals, which aren't currently
  fetched — see the Trade Radar section below for the honest scope note.
- **PWA installability**: real manifest, generated icons, and a
  stale-while-revalidate service worker that deliberately never caches
  `/api/*`.
- **`ANDROID_APK.md`**: step-by-step guide to packaging this as a
  side-loadable Android APK via a Trusted Web Activity (PWABuilder or
  Google's Bubblewrap CLI) — no native rewrite needed.

## What's new from two rounds ago (bug fixes + PWA/Android)

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

## Publishing images to Docker Hub (GitHub → Docker Hub, end to end)

Do this once before deploying via Option A below. Docker Hub account
for this project: **mybadreligon** — already the default in
`docker-compose.yml`, so nothing to fill in for a normal deploy; this
section is about *publishing* new images, not consuming them.

**1. Push the repo to GitHub**, if it isn't already — `docker-compose.yml`
needs to sit at the repo root, alongside `server/` and `client/`, exactly
as this package is structured.

**2. One-time GitHub setup** — in the repo's **Settings → Secrets and
variables → Actions**, add two repository secrets:
- `DOCKERHUB_USERNAME` = `mybadreligon`
- `DOCKERHUB_TOKEN` — a Docker Hub **access token**, not the account
  password (create one at hub.docker.com → Account Settings → Security
  → New Access Token, **Read & Write** scope, then paste it here)

**3. Push to `main`.** `.github/workflows/docker-publish.yml` picks it
up automatically and builds + pushes both images, multi-arch
(`linux/amd64` + `linux/arm64`, covering both typical VPS/desktop hosts
and Raspberry-Pi-class home servers). Watch the **Actions** tab for
progress — a few minutes later,
`docker.io/mybadreligon/fantasy-manager-server:latest` and
`fantasy-manager-client:latest` exist and are ready to pull.

**4. Deploy** — that's Option A below: point Portainer at
`docker-compose.yml` and it pulls those two images directly. No build
step happens on the Portainer host at all; all the building already
happened in GitHub Actions at step 3.

**Manual publish** (skip GitHub Actions, push from your own machine
instead):
```bash
docker login
docker build -t mybadreligon/fantasy-manager-server:latest ./server
docker push mybadreligon/fantasy-manager-server:latest
docker build -t mybadreligon/fantasy-manager-client:latest ./client
docker push mybadreligon/fantasy-manager-client:latest
```
For multi-arch manually, use `docker buildx build --platform
linux/amd64,linux/arm64 -t ... --push ./server` (and same for `./client`)
instead of the plain `docker build`/`docker push` pair.

---

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

## Option A — Deploy via Portainer, pulling prebuilt images (recommended)

No repo checkout needed on the Portainer host at all — this pulls
already-built images from Docker Hub rather than building from source,
which is faster and sidesteps needing a compiler toolchain (for
`better-sqlite3`'s native module) on the deployment host.

**1. Publish the images first** — see the section above, if you haven't.

**2. In Portainer:** Stacks → **Add stack**. Either:
- **Web editor**: paste the contents of this repo's `docker-compose.yml`
  directly in, or
- **Repository**: point at your GitHub repo with Compose path
  `docker-compose.yml` — Portainer will read the file (which has no
  `build:` key) and pull the named images rather than building anything.

**3. Environment variables section (same form):** add
```
FANTASYPROS_API_KEY = <your real key>
```
That's the only one you actually need to set — `DOCKERHUB_USER` already
defaults to `mybadreligon` in the compose file itself. Optionally also
set `SERVER_PORT` / `CLIENT_PORT` if the defaults (4000 / 5000) collide
with something else already running on that host, or `IMAGE_TAG` to pin
a specific build instead of always tracking `:latest`.

**4. Deploy the stack.** Portainer pulls both images and starts them —
no build step on this host at all.

**5. Open `http://<your-server-host>:5000`** (or whatever `CLIENT_PORT`
you set). That's the app.

**To update:** push new commits (which re-triggers the GitHub Actions
build, publishing fresh `:latest` images), then use Portainer's "Pull
and redeploy" action on the stack — it re-pulls the images and restarts
the containers. No rebuild happens on the Portainer host either way.

---

## Option B — Build from source instead of pulling (local dev, or if you'd rather build on the host)

```bash
cp .env.example .env
# open .env and paste your real key in place of "your_key_here"
docker compose -f docker-compose.local-build.yml up --build
```
Open `http://localhost:5000`. Stop with `Ctrl+C`, or `docker compose -f
docker-compose.local-build.yml down`. This is also what Portainer would
use if you point it at `docker-compose.local-build.yml` instead of the
default `docker-compose.yml` — same setup as before this round's change,
kept around for anyone who prefers building over pulling.

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
| Roster Optimization | Fully real, including flex lock-order and bye-week checks, IR/taxi sections, and kickoff times on every card. Kickoff/bye accuracy depends on the ESPN schedule endpoint behaving — see the caveat below, since this round found (and partially fixed) a real bug there. |
| Lineup Advice | Real side-by-side current-vs-optimal comparison. A player is only flagged as changed if they're actually entering or leaving the lineup — an earlier version could flag a meaningless reshuffle between two equal-projection players at the same position, which is fixed now. Kickoff-passed players lock to their actual score and can't be re-suggested away. |
| Waiver Management | Real. Sleeper trending-adds, filtered against every roster in the league (not just yours) and against each league's actual starting positions (no K/DST suggestions for leagues that don't start them), cross-referenced with real FantasyPros ECR. Includes on-demand FAAB bid suggestions — see the caveats section for what those numbers actually mean statistically. |
| Trade Radar | Rebuilt this round: shows every team's strengths/weaknesses (not just yours), with suggested trades grouped under each opposing team. Uses average ECR by position as the "team strength" signal — a rest-of-season-oriented signal by nature, but not literal rest-of-season point totals, which aren't fetched anywhere in this app yet. |
| Injury Watch | Persists: a currently-injured player shows up every refresh (not just when the status first changed), Minor once you've seen that exact status before, Major the first time — tracked in SQLite, survives restarts. |

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

**A real, only-partially-resolved bug found this round:** game times
were coming back wrong for many players. Root cause #1, fixed with
confidence: the season-year query param was `year=YYYY`, which the
endpoint silently ignores — the confirmed-correct param (cross-checked
against multiple independent sources) is `dates=YYYY`. Root cause #2,
fixed but **not fully verified**: even after correcting the param, a
live test still returned a different week's games than requested,
pointing at a caching layer sitting in front of ESPN's endpoint (several
third-party projects reference this exact issue, with "append a
cache-busting value" as the known workaround). Both fixes are applied —
a cache-busting nonce on every request, and explicit validation that
compares the response's own `week.number` against what was actually
requested, logged loudly if they don't match. **If kickoff times still
look wrong after deploying this, check the server logs for that warning
first** — it'll say plainly if ESPN is still returning the wrong week,
which is the fastest way to tell "still broken" from "actually fixed."

### Player ID matching / projection pipeline (Sleeper ↔ FantasyPros ↔ ESPN)

Corrected this round to a proper 3-tier waterfall, cheapest/most-reliable
first — **this replaces an earlier, wrongly-ordered version** that tried
scraping before the API and attempted an ID join against scraped data
that turned out not to carry one:

1. **FantasyPros API `/projections`** — one call covers every position
   at once. Capped at roughly the top 10 players/position on the free
   tier, but its response carries a real `fpid` per player (confirmed
   field), which is a genuine ID join against the ffb_ids crosswalk's
   `fantasyprosId` column — confirmed to exist by direct inspection of
   that CSV, not guessed at. Whoever the free tier actually covers gets
   matched this way, reliably.
2. **FantasyPros scraped pages** (`server/fantasyProsScrape.js`) — fills
   whatever tier 1's cap left out, via **name-fuzzy-matching only**.
   Confirmed that scraped rows carry no usable ID to join against the
   crosswalk with (a speculative attempt at extracting one from a
   `data-*` attribute was added last round without that confirmation,
   and has been removed now that it's confirmed not to apply — no
   point leaving dead-end code that looks like it might be doing
   something it isn't). `/consensus-rankings` (ECR) has no equivalent
   cap and stays entirely on the API, unaffected by any of this.
3. **ESPN** (`server/espnProjections.js`) — real ID join via the
   crosswalk's `espnId` column, tried only for whatever both
   FantasyPros tiers still miss.
4. **Team-abbreviation matching**, defenses only, layered into tiers 1
   and 2 as a fallback before falling through to the next tier — more
   reliable than name-matching a defense, which is a genuinely
   different kind of "name" (a city/mascot pair, formatted differently
   across sources) than a person's name.

If a player still shows no projection after all tiers, that's either a
genuine data gap (not enough of a season yet, or a very recent roster
move no source has caught up on) or a real mismatch worth checking the
server logs for — not a silent, unexplained miss.

**What I checked before building this scraper tier, not after:**
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

**What's best-effort, not confirmed:** the exact table markup for tier
2. The tools used to research this render pages as cleaned text, not
raw HTML, so the parser targets the table containing an "FPTS" header
and pulls name/team/points heuristically rather than against verified
CSS selectors. It logs one sample parsed row to the server console on
first real run — check that against what's actually on
`fantasypros.com/nfl/projections/qb.php` if tier-2 projections come
back empty or wrong.

**Practical tradeoffs of the scrape tier specifically vs. a pure API
approach:**
- **Slower on a cold cache.** With the 5-second crawl delay honestly
  enforced, the first tier-2 fetch after the hourly cache expires takes
  20+ seconds (4 positions × 5s, plus page-load time) before that
  league build response comes back. Cached requests within the hour are
  instant, same as before.
- **More brittle.** A page-layout change on FantasyPros' end breaks this
  silently (parses to empty/wrong data) where an API contract usually
  wouldn't. One position failing to parse doesn't take down the other
  three, but it's worth spot-checking output occasionally.

**On the crosswalk's column headers specifically:** never directly
verified either — GitHub's raw-file path was robots-disallowed for the
research tools used here, so the header row was never actually read
while writing the parser. It discovers columns dynamically at runtime
instead (fuzzy-matches header text containing
"sleeper"/"espn"/"fantasypros"/"name") and logs what it found on first
load — check the server console if the crosswalk seems to be returning
nothing.

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

### Trade Radar: what "team strength" actually means here

Rebuilt this round to show every team's strengths/weaknesses, not just
yours, with suggestions grouped under each opposing team — matching the
requested design of "identify weaknesses per team, then suggest a swap
that helps both sides." One thing worth being precise about: "strength"
and "weakness" are computed from **average FantasyPros ECR by
position** across each roster (lower rank number = stronger), not from
literal rest-of-season point projections. ECR is a reasonable
rest-of-season-oriented proxy — it's a consensus of expert rankings,
not a single week's snapshot — but it's not the same thing as summing
projected points across the rest of the season, which this app doesn't
fetch anywhere today. A dedicated ROS-points fetch would be a real,
separate addition if that distinction matters for how you use this tab.

A team's strengths/weaknesses list only includes positions with at
least one ECR-matched player — a team with poor matching coverage at a
position (see the player-ID matching section above) will show fewer
entries there, not zero-value ones.

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
  requests/day**. Each league build now costs 5 API calls again (4x
  `/consensus-rankings`, one per position, plus 1x `/projections` — back
  up from 4 after this round's fix restored `/projections` to the
  pipeline as tier 1, for the real ID join it enables). Scraping (tier 2)
  doesn't count against this quota at all. `server/fantasyPros.js`
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
.github/workflows/
  docker-publish.yml    Builds + pushes both images to Docker Hub (multi-arch) on push to main
docker-compose.yml      PRIMARY: pulls prebuilt Docker Hub images, no build context — Portainer just pulls
docker-compose.local-build.yml  Builds from source instead — local dev, or build-on-host if preferred
.env.example           Template for local `docker compose up` (skip if using Portainer)
server/
  server.js             Express app + routes (+ FAAB endpoint)
  sleeper.js             Sleeper API client (no auth needed)
  fantasyPros.js          FantasyPros API client (uses your key, server-only) — tier 1 projections + consensus-rankings
  fantasyProsScrape.js     FantasyPros projections scraper — tier 2, fills the API's per-position cap
  espnProjections.js       ESPN projections fallback — tier 3, last resort
  schedule.js             ESPN kickoff-time/bye-week client (unofficial endpoint)
  playerIdMap.js          ffb_ids ID crosswalk (Sleeper/ESPN/FantasyPros/etc)
  matching.js             Name-based cross-source player matching (tiers 2 and the ECR pipeline)
  buildLeague.js          Merges everything into the shape the UI renders
  db.js                   SQLite: generic cache, persistent injury tracking, session/build cache
  scheduler.js             Hourly background refresh for the last-active user's leagues
  faab.js                  FAAB bid-percentile suggestions (tracked leagues only — see caveats)
  Dockerfile              Multi-stage: compiles better-sqlite3, final image has no compiler toolchain
  .env.example            Template for native `npm run dev` (Option C)
client/
  src/App.jsx            The UI (breadcrumb nav, dashboard, league overview, 5 tabs)
  src/api.js              Calls our own backend, never external APIs directly
  public/manifest.webmanifest  PWA manifest (installable in Chrome)
  public/sw.js             Service worker (app-shell caching; never caches /api/*)
  public/icons/            Generated app icons (192/512/maskable/apple-touch)
  public/.well-known/      Placeholder for Android's assetlinks.json — see ANDROID_APK.md
  Dockerfile              Multi-stage: vite build -> nginx serves it
  nginx.conf               Proxies /api to the server container by service name; correct manifest content-type
  vite.config.js           Proxies /api to localhost:4000 (dev only, Option C)
ANDROID_APK.md          Step-by-step: package this as a side-loadable Android APK (TWA, no native rewrite)
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
1. **The ESPN schedule cache-busting fix** — the actual root cause (a
   caching layer, most likely) was inferred from a live test result and
   third-party bug reports referencing the same symptom, not directly
   confirmed. This is the one most likely to still need another pass —
   the server log warning it now prints if the response week doesn't
   match the request is the fastest way to know either way.
2. **`espnProjections.js`** — the endpoint's existence is confirmed, the
   exact JSON field names for a fantasy-points value are not. Logs raw
   response keys on first use.
3. **The FantasyPros row-ID extraction** (`fantasyProsScrape.js`) — added
   this round to try a real ID join against the crosswalk's confirmed
   `fantasyprosId` column, but whether the scraped page's markup
   actually carries an ID to extract was never confirmed. Logs whether
   it found one on the first row.
4. **`playerIdMap.js`** — the CSV's column headers were never directly
   read (GitHub's raw-file path was robots-blocked for my research
   tools specifically); columns are discovered by fuzzy-matching header
   text at runtime instead, and logged on first load. (The
   `fantasyprosId` column's *existence* was confirmed by direct
   inspection this round — just not its exact header spelling.)
5. **`fantasyProsScrape.js`**'s table markup generally — targeted
   heuristically, not against confirmed raw HTML. Logs a sample parsed
   row on first run.

This round's cross-module export re-check (same method that caught the
`getLeagueUsers` bug last time) came back clean — every function called
across `buildLeague.js`, `server.js`, `scheduler.js`, and `faab.js`
matches a real export this time.

All three fail soft: a wrong guess returns `null`/empty rather than a
plausible-looking wrong number, and the app degrades (that player just
shows "no projection") rather than breaking.
