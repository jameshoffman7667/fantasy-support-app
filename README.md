# Fantasy Manager — real Sleeper + FantasyPros app

*Current version: v2 — see [CHANGELOG.md](./CHANGELOG.md) for what
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

## What's new in v2 (Season Outlook, real Trade Finder, usage data, push alerts)

- **Season Outlook tab**: rest-of-season Monte Carlo simulation (3,000
  trials/league) producing playoff odds and championship odds per team,
  using each team's season-to-date scoring average against the real
  remaining Sleeper schedule. See [`server/simulate.js`](./server/simulate.js)
  for the exact methodology and its documented limitations — it's a
  defensible proxy, not full per-player rest-of-season projections (that
  would mean resolving FantasyPros/ESPN projections for every player on
  every roster in the league, which risks the free-tier rate limit for a
  number that's a rough estimate either way).
- **Trade Finder reworked to real player-level swaps.** The old Trade
  Radar (position-level strength/weakness) is still there, but there's
  now a genuine 1-for-1 swap finder: it scans every rival roster for
  same-position players whose ECR is within 20 ranks of a player in your
  starting lineup (a fairness proxy — "close enough a rival might accept
  it," not a trade-value model) and who project more points than what
  you'd give up, ranked by projected gain. Bounded to the 3 closest ECR
  candidates per position per rival to control FantasyPros API call
  volume.
- **Usage-data badges** (snap %, targets, carries) on Roster and Waiver
  player cards, sourced from nflverse's free public CSV releases (not
  independently verified against a live response in this environment —
  see [`server/nflverseUsage.js`](./server/nflverseUsage.js) for the
  column-name discovery/logging this relies on). Shown only when a
  player's usage data actually matched by name; no placeholder otherwise.
- **Pre-kickoff push alerts**, via real Web Push (VAPID) through the
  existing PWA service worker — not a native app. An "Enable alerts"
  toggle on the dashboard requests browser notification permission and
  subscribes; the background scheduler then pushes a notification when
  a starter picks up an Out/IR/PUP designation within ~26 hours of
  kickoff, or when a bench/waiver option projects at least 3 points
  higher than a starter at the same slot, deduplicated so you're not
  re-alerted for the same thing. Requires `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` to be set (see `.env.example`) —
  without them the app runs fine, alerts are just disabled.
  - **Scoping note on the original "Android APK with push notifications"
    idea**: this round delivers that as Web Push through the app's
    existing installable-PWA path, not a native Android app with Firebase
    Cloud Messaging. A true native wrapper (packaging, code signing, Play
    Store review) is a materially bigger, separate undertaking and wasn't
    attempted here. If you do wrap this app as an Android APK via the TWA
    route in [`ANDROID_APK.md`](./ANDROID_APK.md), these push alerts keep
    working inside that wrapper too, since it's the same underlying PWA.
  - Sleeper's `injury_status` field is the official injury *report*, not
    a live gameday-inactive feed — it's the closest available signal for
    "ruled out," not a guarantee a player won't play or that no one else
    got ruled out that Sleeper hasn't reflected yet.

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

**Prerequisite as of this version:** `docker-compose.yml` attaches
`client` to an external Docker network named `caddy_net` (see the Caddy
section above) — that network must already exist on the host before
this stack deploys, or the deploy fails outright rather than silently
skipping it. If you're not using the Caddy setup yet but still want to
deploy this file as-is, create an empty network of the same name first:
`docker network create caddy_net` — it's a harmless no-op without a
Caddy container actually attached to it.

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
OWNER_USERNAME = <your Sleeper username>
OWNER_PASSWORD = <a first password, 8+ characters>
```
Those are the ones you actually need to set — `DOCKERHUB_USER`
already defaults to `mybadreligon` in the compose file itself. On first
start the owner account is created with `OWNER_PASSWORD` and you're asked
to choose your own at first login. Skipping these doesn't leave the app
open; it fails closed instead, so nobody can log in until they're set.
(`APP_PASSWORD` from v1/v2 is no longer used — remove it.) Optionally also set
`SERVER_PORT` / `CLIENT_PORT` if the defaults (4000 / 5000) collide with
something else already running on that host, or `IMAGE_TAG` to pin a
specific build instead of always tracking `:latest`.

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

**There's a real per-user login.** People log in with their Sleeper
username and a password. Passwords are stored as salted scrypt hashes;
sessions are opaque cookies stored in SQLite, re-checked on every request
so the owner revoking someone ends their access immediately. Only users
the owner has added can log in; nobody can pull data through your
FantasyPros key without an account. **Set `OWNER_USERNAME` and
`OWNER_PASSWORD` before you deploy**; if they're unset the server logs a
warning at startup and nobody can log in (fails closed). Roles: **owner**
(manage users, reset passwords, change roles, revoke/restore/remove access)
and **guest** (use the app, change their own password). Anyone can change
their own password but must enter the current one. Lost the owner
password? Set `OWNER_FORCE_RESET=true` for one restart (with
`OWNER_PASSWORD`) to reset it.

Login attempts are throttled per username (10 failures / 15 minutes) — per
username rather than per IP because behind nginx + Caddy the real client IP
isn't reliable. The side effect is that someone can briefly lock a named
account by guessing; it clears itself.

That's already enough to put this on the open internet. Two more layers
are still worth knowing about if you want them:
- **Caddy `basic_auth`** in front of the app as well — a second gate
  before a request even reaches the login screen. Now optional/redundant
  given the in-app login, but still a reasonable belt-and-suspenders
  choice if you're already comfortable managing Caddy auth. Covered
  below.
- **A VPN like Tailscale** instead of public exposure at all — the
  simplest option if you'd rather not expose a port to the internet in
  the first place.

## Deploying behind an existing Caddy reverse proxy

If you already run Caddy for other self-hosted services, `client`
(the only container anything external ever needs to reach — its own
nginx already proxies `/api/*` to `server` internally, same as always)
joins a **pre-existing external Docker network** called `caddy_net`
that your Caddy container is also on, so Caddy can reach it by container
name instead of a published host port.

**1. This network must already exist** — if you don't already have one
from your Caddy setup, create it once: `docker network create caddy_net`,
and make sure your Caddy container is also attached to it. `docker-compose.yml`
references it as `external: true`, meaning Compose looks it up rather
than creating it — deploying without it existing first will fail
loudly at startup rather than silently create a second, disconnected
network of the same name.

**2. Caddyfile:**
```
fantasy.yourdomain.com {
    reverse_proxy client:5000
}
```
`client:5000` — the container's internal nginx port on the shared Docker
network (matches the externally-published `${CLIENT_PORT}` too, as of
this version, but Caddy talks to it by container name here regardless).

**3. Optional extra layer** — the app already has its own login screen
(see the security note above), but if you'd rather also gate it at the
reverse proxy:
```
fantasy.yourdomain.com {
    basic_auth {
        yourusername <bcrypt-hash>
    }
    reverse_proxy client:5000
}
```
Generate the hash with `caddy hash-password` (or `docker exec -it
<your-caddy-container> caddy hash-password` if Caddy's dockerized too)
— it prompts for a password and prints the bcrypt hash to paste in.

**Running Caddy elsewhere** (natively on the host, or on a different
machine on your network) instead of in Docker? Skip the `caddy_net`
network entirely and just point Caddy at the published port instead:
`reverse_proxy localhost:5000` (or the Docker host's LAN IP).

**Side benefit:** a real HTTPS domain is exactly what `ANDROID_APK.md`
needed as a prerequisite for the Trusted Web Activity path — this
unlocks that too, if you want a side-loadable APK later.

## What's actually real vs. a known gap

| Tab | Status |
|---|---|
| Roster Optimization | Fully real, including flex lock-order and bye-week checks, IR/taxi sections, and kickoff times on every card. Kickoff/bye accuracy depends on the ESPN schedule endpoint behaving — see the caveat below, since this round found (and partially fixed) a real bug there. |
| Lineup Advice | Real side-by-side current-vs-optimal comparison. A player is only flagged as changed if they're actually entering or leaving the lineup — an earlier version could flag a meaningless reshuffle between two equal-projection players at the same position, which is fixed now. Kickoff-passed players lock to their actual score and can't be re-suggested away. |
| Waiver Management | Real. Sleeper trending-adds, filtered against every roster in the league (not just yours) and against each league's actual starting positions (no K/DST suggestions for leagues that don't start them), cross-referenced with real FantasyPros ECR. Includes on-demand FAAB bid suggestions — see the caveats section for what those numbers actually mean statistically. |
| Trade Radar | Rebuilt this round: shows every team's strengths/weaknesses (not just yours), with suggested trades grouped under each opposing team. Uses average ECR by position as the "team strength" signal — a rest-of-season-oriented signal by nature, but not literal rest-of-season point totals, which aren't fetched anywhere in this app yet. |
| Injury Watch | Persists: a currently-injured player shows up every refresh (not just when the status first changed), Minor once you've seen that exact status before, Major the first time — tracked in SQLite, survives restarts. |

### Login, cross-device persistence, and a week selector

- **Login (v2.1)**: per-user — Sleeper username + password, owner/guest roles, owner-managed users (Account → Manage users) — see the security note above. Logging in sets an HttpOnly session cookie backed by a SQLite-stored token, valid for 30 days. Push alerts and background refresh are per user.
- **Player Rankings (v2.1)**: Lineup tab → Player Rankings lists every roster player (starters, bench, IR, taxi — labelled) by projected points, free agents in a separate section below. Drag the handle (or use arrow keys) to reorder; your order replaces the suggested lineup for that league. Yellow = a better projected lineup exists; red = projected for exactly 0.
- **Persistence**: which leagues you're tracking is saved **server-side** per user, tied to being logged in rather than to one browser. Log in from any device and it reconnects automatically to the same leagues, right where you left off — no re-entering anything, and no per-device setup.
- **Log out** (on the dashboard) revokes the session cookie server-side and returns you to the login screen.
- **Edit tracked leagues** (also on the dashboard) re-pulls your current Sleeper league list and lets you change your selection without logging out — handles the case where the server restarted and forgot your in-memory session, transparently.
- **Week dropdown** in the header, available on the dashboard, league overview, and every tab — changing it rebuilds every tracked league for that week (fresh Sleeper roster-for-week + Sleeper/ESPN projections and FantasyPros ECR for that week).

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

### v3.3 additions
CBS auto mode now signs in and saves picks directly (no recipe needed; see CBS-CAPTURE.md), switches itself off if you change a pick on CBS, and asks before a manual pick turns it off. Analytics has a new "My performance" tab. Sleeper/other API calls are cached much more (details in the changelog). The GitHub image build is faster.

### v3.2 additions
Pick'em picks can be chosen in the app and pushed to your CBS pools about an hour before each kickoff slot. Set it up under Account → CBS pick'em push; read CBS-CAPTURE.md first. Off by default; untested against real CBS.

### v3.1 additions
Account → Sleeper access now has four switches: Read from Sleeper, Roster changes, Waiver claims, Trades. Outgoing trade offers all show, with a Withdraw button (unverified; it uses reject_trade and reads back). Players are unavailable on waivers from their kickoff until the week's last game ends. Injury opportunities (depth chart, next two backups) appear on Waivers, Roster and Injury. See CHANGELOG v3.1 for the unverified items.

### Sleeper private access, roster push, trade offers, League page (v3.0)

Everything in this section is **optional and off until you turn it on**. Without a token the app behaves exactly as v2.9.

**What it is.** v3.0 can talk to Sleeper's *private, undocumented* GraphQL API (`https://sleeper.app/graphql`) using your Sleeper login token. It can change or disappear without notice, and Sleeper's terms (automated means, reverse engineering) arguably cover it. No ban reports were found, but there is no guarantee. The query and mutation shapes come from a community reference (Filip-Kin/sleeper-graphql). Proven by that project's author: reject trade, set lineup. **Not proven:** move to IR, submit/cancel waiver claim, the pending-claims read, and the settings log read with a token. This sandbox could not reach sleeper.app, so all of it is tested against a mock only. Nothing is reported as successful unless Sleeper's answer or a read-back confirms it.

**Setup (Account → Sleeper access).** Paste the `token` value from Sleeper's website (browser developer tools → Application → Local storage → sleeper.com). It is verified with a read-only call, stored **encrypted** (AES-256-GCM, key from the `SESSION_SECRET` environment variable — set it to a long random string; if it isn't set a key is generated and kept in the same database file as the token, which protects much less) and never sent back to the browser. A second switch, **Allow changes**, is off by default; reading works without it, any push needs it. Every push shows exactly what it will send and needs a second click, and is logged (Account shows the recent log).

**What uses it**
- Roster & Lineup page (Roster and Lineup merged): roster at the top, then **Proposed changes** (tick boxes) and **Update roster** (summary of ticked changes + *Push to Sleeper*). The lineup is written to your roster *and* this week's matchup leg, then the leg is read back. Moving a player to IR is an untested call.
- Trades: offers waiting on you (yellow, never auto-clear), your own stale offers (red), and *Reject this offer*.
- Waivers → Claims: claims already queued in Sleeper are hidden from the proposals and listed with Cancel; *Push to Sleeper* sends a single test claim first, then the rest once one has been read back. The checklist stays as a fallback.
- League page: settings change log; yellow until you clear it.

**Stale offers.** Offseason: older than 7 days. In season: any player in the offer has a game today (US Eastern date) or one that already kicked off this week.

**Line movement.** Not rebuilt: Pick'em already snapshots the spread hourly and shows "line moved" per game.

### Variance report and clearing minor variances (v2.8.1)

A **Variance report** button opens a pop-up listing every yellow (minor)
and red (major) flag in its scope. The button shows how many variances
are open and is coloured by the worst one.

- **Top of the main page:** all leagues, all pages.
- **Each league card** ("Report") **and the league page:** every page for that league.
- **Each page** (Roster, Lineup Advice, Waivers, Trade Radar, Injury Watch): that page only.

The pop-up groups variances by league, then page, then the rule broken
(e.g. "Questionable starter", "Flex lock order", "Weather", "Trending
add"). The items sit under each rule.

- Every group starts collapsed. There are Expand all and Collapse all
  buttons, and each group opens on its own.
- Text is coloured by severity, and each heading takes the worst colour
  beneath it.

**Clear minor variances** clears the yellow items in that pop-up's scope.
Red items can't be cleared.

- A cleared item stops colouring its row, its page badge and the league card.
- Anything new turns yellow or red again: a different issue, player or
  injury status, or a cleared item that turns red (e.g. a lineup gap
  growing past 5 points).
- The same issue with a different number stays cleared (e.g. a 3.2 vs
  4.1 point gap, 18 vs 22 mph wind).
- Clears are saved per user on the server (`variance_acks:{user}`), so
  they carry across devices.
- After each refresh, clears for issues that have gone away are dropped,
  so if the issue comes back later it shows again.
- Roster and lineup issues are tied to the week. Waiver, trade and injury
  issues are not.
- Cleared items can be shown again in the pop-up ("Show N cleared").

### Matchups, weather, headshots and stat lines (v2.8)

**Player cards** (Player Rankings, and the compact Lineup rows) now show:

- **Headshot**: Sleeper's CDN by Sleeper ID, else ESPN's by the ESPN ID in
  the crosswalk, else the player's initials. Team defenses show the logo.
  Images go through the server (`/api/img/player/:id`, `/api/img/team/:abbr`)
  and are cached on disk under `DATA_DIR/img` (30 days; misses are retried
  after a day).
- **Matchup**: `[NYJ] @ [MIA]` (`vs` at home), with kickoff time. The
  player's team is coloured by its **offensive** rank at his position, and
  the opponent by its **defensive** rank against that position. Tap either
  team to see the games behind its rank.
- **Weather** (outdoor stadiums only): temperature, wind and rain chance at
  kickoff. Tap it for the hour-by-hour forecast around kickoff (temp and
  feels-like, wind and gusts and direction, precipitation chance, amount
  and type), the stadium and roof type, and why the game was or wasn't
  flagged.
- **Projected stat line** from whichever source produced the projection:
  Vegas props, Tank01 or Sleeper give a full line; ESPN gives receptions
  and pass TDs only.

**Weather flags.** Forecasts come from Open-Meteo (free, no key) for the
kickoff hour and the 3 hours after it. A game is flagged when sustained
wind ≥ 15 mph or gusts ≥ 25, rain is likely (≥ 60% and ≥ 0.02"/hr), heavy
(≥ 0.1"/hr) or snow totals ≥ 0.1". A flagged starter makes the Lineup tab
**minor** (yellow) and the reason is shown. Domes get no forecast.
Retractable roofs (ARI, ATL, DAL, HOU, IND) show the forecast with "roof
may be closed" and are never flagged. Neutral-site games get no forecast.
The owner can change the thresholds under Analytics → Matchup rankings.
The stadium table includes Buffalo's new Highmark Stadium.

**Matchup difficulty** is built in-app from Sleeper's weekly game stats
(`api.sleeper.com/stats/nfl/{season}/{week}`). Each row carries the
player's team and opponent, so fantasy points per game can be totalled
by offense × defense × position in each league's own scoring.

- **Positions:** QB/RB/WR/TE/K. For DEF, the defense column ranks
  offenses by the points opposing D/STs score against them.
- **Loading:** last season (weeks 1–18) is loaded once. This season's
  finished weeks are loaded, then re-pulled daily for about 9 days to pick
  up stat corrections. The current week's finished games are refreshed
  hourly.
- **Samples:**
  - **Blended** (default): this season plus last season. Last season's
    games together count as 3 games until a team has 4 games this season,
    then fade to zero by game 14.
  - **This season only.**
  - **Last 4 games.**
- **Schedule adjusted** (SRS-style, additive, iterated): a defense's figure
  becomes the average of (points allowed − how far that offense usually
  runs above or below league average at the position), solved together
  with the offensive ratings. A blowout by an offense that does that to
  everyone counts less, and vice versa.
- **Five colour tiers**, about 6–7 teams each, from the player's point of
  view: red, orange, yellow, yellow-green, dark green. Defensive rank 1 =
  allows the fewest points (red). Offensive rank 1 = scores the most
  (dark green).
- **Analytics → Matchup rankings** shows the defense and offense tables by
  position with the sample selector and the Schedule adjusted toggle. Tap a
  team for its games, opponents, points, opponent average and adjusted
  points. These choices are saved per user and also colour the cards.

**Unverified from the build sandbox:** the sandbox can't reach Open-Meteo
or the Sleeper/ESPN image CDNs, so those requests follow the documented or
commonly used URL patterns and fail soft (no forecast, initials).
Sleeper's stats feed was checked live (2026 weeks 1–3, 2025 week 10).

### Pick'em tab (v2.7)

Straight-up pick'em recommendations (built for a CBS pool: no confidence
points, weekly + season prizes, 40–50 entrants). Tab: **Pick'em**.

- **Win probability per game:** Tank01 sportsbook moneylines (no-vig,
  averaged across books — taken from the odds the app already pulls, no
  extra Tank01 calls), else ESPN's listed moneylines, else the spread
  (margin ~ Normal(−spread, 13.5)), else ESPN FPI. ESPN's FPI is always
  shown as a second opinion (free).
- **Card:** a win-percentage bar in the two teams' colours (alternate
  colour when they clash or are near-black), the pick, spread/source, an
  **upset potential** bar (0–100 = underdog's win chance up to 30 + line
  movement toward the underdog since the week's first snapshot up to 30 +
  Gemini article mentions up to 40), and Gemini's short game note.
- **Picks (v3.4):** the favourite in every game except 1–4 **upset
  picks** (underdogs with the highest upset potential: always the top
  one, more only at or above the Settings threshold). A green box marks a
  favourite pick, a yellow box an underdog pick. The **Performance** view
  compares you, the app and Vegas against actual results.
- **Changes:** if a recommendation changes before that game's kickoff, a
  red dot shows on the card and on the Pick'em tab until tapped, and — if
  push alerts are enabled — a notification is sent.
- **Tiebreaker:** the Vegas over/under for the week's last game.
- **Record:** your recommended picks vs "always the favourite", season and
  week.
- **Gemini (optional, `GEMINI_API_KEY`, `GEMINI_MODEL`):** one grounded
  Google Search call a day (cached 20 h) reads public pick'em and
  upset-pick articles and counts how many pick each underdog. Free tier:
  Gemini 3.5 Flash-Lite, 5,000 grounded requests/month; Google may use
  free-tier content to improve its products. The default model id
  `gemini-3.5-flash-lite` couldn't be verified from the build sandbox —
  check Google AI Studio and override `GEMINI_MODEL` if needed.

### Tabs, Game Day, lineup lock-out, source status (v2.6)

**Tabs:** League Management (leagues, lineup, waivers, trades, account),
**Game Day**, and **Analytics** (the accuracy dashboard, lean factors and
the owner's history backfill — moved off the dashboard).

**Game Day** (`server/gameday.js`, `GET /api/gameday`): for this week,
across every tracked league, your starters count *for* you and your
matchup opponent's starters count *against* you, each weighted by the
league's **importance** (dues or any relative number, set per league in
Game Day → Settings, with an include toggle). Per player F = Σ for-weights,
A = Σ against-weights, lean = F ÷ (F + A). One line per player, placed
left (cheer for) to right (cheer against); "for" if F ≥ ratio × A,
"against" if A ≥ ratio × F, else balanced — the ratio (default 2) is a
setting. Optional **close-matchup weighting**: a league within the close
margin (default 20%) counts fully, a blowout drops toward the minimum
(default 0.25), using live points plus remaining projections. Live
points/status refresh every 60 s while the tab is open (Sleeper matchups +
ESPN scoreboard, no Tank01 calls). Filters by game slot and category.

**Lineup lock-out:** once a player's game has kicked off he's out of every
recommendation — starters stay locked in their slot; bench, IR/taxi and
free agents whose game has started can't be suggested (suggested lineup,
Player Rankings, the yellow "better lineup" check, swap alerts).
Previously only starters with Sleeper-reported points were locked.

**Header status:** the old fixed "Vegas + Tank01/Sleeper/ESPN (live)" text
is replaced with what the projections actually came from (players per
source), whether a Tank01 key is set, and when Tank01 data was last pulled
(`GET /api/status/sources`). Tank01's week-wide projections parser also
now accepts list-format responses.

### Lean calibration, accuracy tracking and history backfill (v2.5)

**Lean calibration.** Players with Vegas props are used to measure how
each other source (Tank01, Sleeper, ESPN) runs against Vegas, per
position, in each league's own scoring: factor = Σ Vegas points ÷ Σ
source points over every player-week that has both, across the last 4
weeks (current week included). Positions with fewer than 8 overlaps use
the source's all-positions factor; fewer than that, no adjustment.
Factors are capped at 0.8–1.2. A player without Vegas props gets his
first available source × that factor; cards show it, e.g. `SLEEPER ×1.08`.
DEF has no props, so it's never adjusted. Leans are kept per **scoring
profile** — points per reception, TE premium and points per passing TD —
so leagues with identical settings share a sample. (The 1.18 TD vig was
calibrated against Tank01, so Tank01's factor is partly circular on TDs.)

**Accuracy tracking.** Every source's projection for every player it can
identify is recorded each week, raw and lean-adjusted, per scoring
profile (`server/projectionHub.js`, table `proj_records`). Rows keep
updating until the player's kickoff, then freeze. Actual stat lines come
from Sleeper's weekly stats once a week finishes (`server/actuals.js`) and
are scored with the same code. Dashboard → **Accuracy** (all users): bias,
average miss, RMSE, SD of error, correlation, within-position rank
correlation, % within ±3/±5 pts, by source × position, for any season /
scoring profile / week range, plus average miss by week, "same players
only" and raw-vs-adjusted toggles, and the current lean factors.

**Local player-ID crosswalk.** Table `crosswalk`, keyed by Sleeper ID.
Tank01's weekly player list (one call) is the primary source for the
Sleeper ↔ Tank01/ESPN links — Tank01's playerID is the ESPN player ID and
its list carries each player's Sleeper ID (verified live). The ffb_ids
GitHub CSV is still loaded in full every week: every one of its ID columns
(Yahoo, CBS, NFL.com, PFR, etc.) is kept per player in `ext_ids`, ready for
other sites later, and it fills any link Tank01 lacks. Tank01's own
other-site IDs (CBS, Yahoo, Rotowire, FantasyPros…) are kept too. Name
matches fill whatever's left. Each link stores how it was made, and a
weaker match never overwrites a stronger one (Tank01 > ffb_ids > name).

**History backfill (owner, Accuracy screen → "Backfill history").**
- Free (no Tank01 calls): Sleeper + ESPN projections and actual scores for
  concluded 2026 weeks and all of 2025.
- Tank01 batch 1: concluded 2026 games (newest first), then 2025 weeks
  18→9 — ~230 calls (one schedule call per season, one projections call
  per week, one odds call per game). Batch 2: 2025 weeks 8→1, ~140 calls,
  starts automatically 40 days after batch 1 completes.
- Month-end: on the last day of each month after 11 pm Eastern, any
  unfinished due batch continues until Tank01 rejects a call (free plan:
  rejected, not billed). Each call is tracked in `backfill_items`; nothing
  is fetched twice and every run resumes where the last stopped.
- Tank01 serves closing lines for finished games (verified live).
  Historical Sleeper/ESPN numbers are whatever those sources kept (some may
  have been edited after kickoff); backfilled weeks are flagged on the
  dashboard.

### Projections (v2.4: Vegas props → Tank01 → Sleeper → ESPN)

Each player's projection comes from the first source that has one:

1. **Vegas props** (`server/tank01.js`, needs `TANK01_API_KEY`) — when a
   player has a full set of prop lines for their position, those lines
   are the projected stats: QB passing yards, passing TDs, interceptions,
   rushing yards and anytime TD; RB rushing yards (or rush+rec yards minus
   receiving yards), receiving yards, receptions and anytime TD; WR/TE
   receiving yards, receptions and anytime TD; K kicking points. Anytime-TD
   odds become expected TDs as in the Tank01 handoff: implied probability
   ÷ 1.18 (vig), then −ln(1 − p). A QB's anytime TD counts as rushing;
   RB/WR/TE TDs are split rush/receiving by Tank01's projected split (or a
   position default). Fumbles are 0 — no fumble props exist. Scored with
   the league's own settings. Tag `VEGAS`.
2. **Tank01's projection** — anyone without a full prop set. Stat line
   scored with the league's settings; kickers and defenses use Tank01's
   preset total for the league's reception setting. Tag `TANK01`.
3. **Sleeper's projection** (v2.3's source), scored per league. Tag `SLEEPER`.
4. **ESPN** (v2.2's source). Tag `ESPN`.

Without a Tank01 key the app simply starts at step 3.

**Tank01 quota** (free tier 1,000 calls/month, shared with anything else on
the key). Calls are bounded by freshness rules, not by how often leagues
rebuild: schedule once a day, player list (for the Sleeper-ID join) once a
week, projections once a day, odds one call per game per day Wed–Sun
(Eastern) and never after kickoff, plus one forced pull per game ~60 min
before kickoff. That's roughly 450–500 calls a month. A monthly counter
stops all Tank01 calls `TANK01_RESERVE` (default 50) short of
`TANK01_MONTHLY_LIMIT` (default 1000), and a 429 pauses Tank01 for 10
minutes — both fall back to Sleeper/ESPN.

**Refresh timing (v2.4):** leagues still rebuild hourly (projection caches
last an hour). Additionally, ~60 minutes before each kickoff slot (TNF,
Sunday early/late/night, MNF…) the server re-pulls Sleeper and ESPN
projections bypassing the cache, refreshes Tank01 projections and the
props for that slot's games, then rebuilds every user's leagues.

**Not verified:** Tank01 response shapes were taken from the handoff and
written defensively; no live call was possible while building. The
server logs the first raw response of each Tank01 endpoint and, per
build, `[buildLeague] <league> week N projections — Vegas: …, Tank01: …,
Sleeper: …, ESPN: …, none: …`. If Vegas stays at 0 on a Wednesday–Sunday,
paste the `[tank01] First getNFLBettingOdds response sample` line.

#### Sleeper and ESPN details

**Primary: Sleeper's own projections feed** (`server/sleeperProjections.js`)
— the numbers the Sleeper app shows (supplied to Sleeper by Rotowire). One
request per week to `api.sleeper.com/projections/nfl/{season}/{week}`
covers QB, RB, WR, TE, K and DEF, cached for an hour. Rows are keyed by
Sleeper player ID, so there's no name matching to miss on, and they carry
raw projected stats using the same names as a league's scoring settings.
Each league's points are computed as stat × that league's points for it,
so custom scoring comes out right. Reception bonuses by position (e.g. TE
premium) and points/yards-allowed tiers for defenses are added when the
stat line doesn't spell them out. Cards are tagged `SLEEPER`.

**Fallback: ESPN** (`server/espnProjections.js`, the v2.2 source) for any
player Sleeper has no projection for, tagged `ESPN`, adjusted for
reception / TE-premium / passing-TD scoring only.

**Caveats:** Sleeper's feed is unofficial and undocumented. Other projects
report the older `/v1/projections` path now returns empty data (not used)
and that `api.sleeper.com` refuses requests without a browser-style
User-Agent (one is sent; `api.sleeper.app/projections` is tried as a
backup). Placeholder values (999/1000) are ignored. Kicker and defense
scoring may differ slightly from Sleeper's where a league scores
something the projection doesn't break out (e.g. FG-distance bonuses).

**Checking it after deploy:** each build logs
`[buildLeague] <league> week N projections — Sleeper: X, ESPN fallback: Y, none: Z`,
plus a line from each source with how many players it returned.

FantasyPros is still used for **expert consensus rankings (ECR)** —
waiver flags, Trade Radar and Trade Finder — via the official API.

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

### Trade Finder, Season Outlook, usage data, and push alerts (v2)

- **Trade Finder** (the "Trade Finder — 1-for-1 Swaps" section on the
  Trade tab) is separate from the Trade Radar above — it deals in actual
  named players, not position-level strength/weakness. The 20-rank ECR
  "fairness tolerance" is a heuristic, not a negotiated trade-value
  model; it exists to filter out offers no rival would plausibly accept
  ("my worst bench guy for their All-Pro"), not to guarantee a rival
  *will* accept what passes the filter.
- **Season Outlook**'s odds are recomputed fresh on every visit to the
  tab (not cached, not part of the main league build), so opening it
  costs one extra request plus 3,000 simulated trials server-side —
  noticeable but not slow. It reads `settings.playoff_teams` /
  `settings.playoff_week_start` from Sleeper's league object and falls
  back to 6 teams / week 15 if either is missing, since these exact
  field names weren't confirmed against a live Sleeper response in this
  environment.
- **Usage badges** only appear when nflverse's data matched a player by
  normalized name for the *previous* completed week (there's no
  in-progress-week usage data to pull yet) — a badge's absence means "no
  match," not "zero usage."
- **Push alerts require HTTPS in production** (the Push API is a
  secure-context feature) — this already works with the Caddy reverse
  proxy setup described later in this README, and `localhost` is exempt
  during local dev. If "Enable alerts" fails with a permission or
  registration error while testing over plain HTTP on a LAN IP, that's
  the browser enforcing this, not a bug in this app.

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
  requests/day**. Each league build costs one `/consensus-rankings`
  call per position (v2.2 dropped the `/projections` call — projections
  come from ESPN, which has no key or quota). `server/fantasyPros.js`
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
docker-compose.yml      PRIMARY: pulls prebuilt Docker Hub images, no build context — Portainer just pulls. Requires an external `caddy_net` Docker network to already exist (see Caddy section).
docker-compose.local-build.yml  Builds from source instead — local dev, or build-on-host if preferred
.env.example           Template for local `docker compose up` (skip if using Portainer)
server/
  server.js             Express app + routes (+ FAAB endpoint)
  sleeper.js             Sleeper API client (no auth needed)
  fantasyPros.js          FantasyPros API client (uses your key, server-only) — consensus rankings (ECR) only
  tank01.js                Tank01 (RapidAPI): Vegas props + Tank01 projections, quota-bounded (v2.4)
  projectionHub.js         All sources per player, lean factors, recording (v2.5)
  projectionStore.js       v2.5 tables: crosswalk, scoring profiles, projection records, actuals, backfill items
  actuals.js               Actual weekly stats from Sleeper for scoring accuracy (v2.5)
  accuracy.js              Accuracy metrics for the dashboard (v2.5)
  backfill.js              History backfill: free sources + Tank01 batches (v2.5)
  gameday.js               Game Day cheer for/against across leagues (v2.6)
  pickem.js                Pick'em board, recommendations, change tracking, record (v2.7)
  gemini.js                Gemini grounded article scan for upset picks (v2.7)
  dvp.js                   Matchup difficulty: Sleeper game stats, defense/offense rankings by position (v2.8)
  weather.js               Stadium table + Open-Meteo forecasts + weather flags (v2.8)
  images.js                Cached headshot/logo proxy (v2.8)
  varianceAcks.js          Per-user cleared minor variances for the variance report (v2.8.1)
  sleeperProjections.js    Sleeper's weekly projections, scored per league — third source (v2.4)
  espnProjections.js       ESPN weekly fantasy projections — last fallback
  schedule.js             ESPN kickoff-time/bye-week client (unofficial endpoint)
  playerIdMap.js          ffb_ids ID crosswalk (Sleeper/ESPN/FantasyPros/etc)
  matching.js             Name-based cross-source player matching (FantasyPros ECR)
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
2. **`tank01.js` (v2.4)** — the props and projections response shapes
   come from the handoff; v2.5 verified the odds, schedule, player-info and
   per-player projection shapes with live calls. The week-wide projections
   wrapper is still unverified; the first raw response of each endpoint is
   logged.
2b. **`sleeperProjections.js` (v2.3)** — unofficial feed; live samples of
   QB/WR/K/DEF rows were inspected through a page reader, but a full
   week's response was never fetched end to end from here. Logs row
   counts and one sample row on each fresh fetch.
3. **`espnProjections.js` (v2.2, now fallback)** — endpoint and field names checked
   against a live sample; the PPR default and the reception/passing-TD
   stat IDs used for scoring adjustment are from third-party sources.
   Logs player counts and one sample player on each fresh fetch.
4. **`playerIdMap.js`** — the CSV's column headers were never directly
   read (GitHub's raw-file path was robots-blocked for my research
   tools specifically); columns are discovered by fuzzy-matching header
   text at runtime instead, and logged on first load. (The
   `fantasyprosId` column's *existence* was confirmed by direct
   inspection this round — just not its exact header spelling.)

This round's cross-module export re-check (same method that caught the
`getLeagueUsers` bug last time) came back clean — every function called
across `buildLeague.js`, `server.js`, `scheduler.js`, and `faab.js`
matches a real export this time.

All three fail soft: a wrong guess returns `null`/empty rather than a
plausible-looking wrong number, and the app degrades (that player just
shows "no projection") rather than breaking.
