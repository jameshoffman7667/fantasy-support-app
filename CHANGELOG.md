# Changelog

All notable changes to this project are logged here, one entry per
delivered version. Every delivered zip gets a version number (`vN`,
also used as the zip's top-level folder name and included at the front
of both commit messages below, so a commit can be cross-referenced back
to its changelog entry at a glance), a commit message split into a
short subject (≤50 characters, for `git commit -m "..."`) and an
extended description (≤200 words, for the commit body, `git commit -m
"<short>" -m "<extended>"`), and an entry here describing what changed
and why — mirroring the short+extended commit split. Both the short and
extended commit messages are also included directly in the chat reply
that delivers the files, not just here. The functional spec and this
changelog are bundled inside the zip itself, alongside a copy of the
changelog kept here in the outputs folder.

**Versioning scheme:** v0.1 through v0.8 are the pre-release
iterations built before the app had a real login system — every
delivery up through the old "v9" was renumbered to this decimal scheme
in retrospect. **v1 is the first official release**, starting with the
delivery that added real authentication. Versions continue from v1
onward (v1, v2, v3, ...) for future official releases.

**A note on v0.1–v0.5 specifically:** these are reconstructed from the
actual conversation/build history rather than from real commit
timestamps, since versioning wasn't introduced until v0.6. A couple of
very closely-related, back-to-back turns are grouped into a single
version entry where that gives a cleaner history than splitting them —
noted individually below. **v0.6–v0.8 predate the short/extended
commit split and the version-number-in-commit-message convention**
(both introduced at v1) and use a single free-form commit-message line
instead. From v0.6 onward, each entry corresponds to exactly one
delivered zip.

---

## v1 — Real in-app login, replacing localStorage with server-side persistence (first official release)

**Commit (short):** `v1: feat(auth): shared-password login + port 5000`

**Commit (extended):**
v1 adds a real login screen gating the app behind a single shared
password (`APP_PASSWORD`), checked with a timing-safe SHA-256
comparison. A correct login issues an opaque session token stored
server-side in a new `web_sessions` SQLite table (30-day expiry) and
set as an HttpOnly, `SameSite=Lax` cookie (`Secure` when served over
HTTPS, detected via `X-Forwarded-Proto`). `/api/connect`,
`/api/leagues/*`, and `/api/faab` now require a valid session;
`/api/health` stays open for the Docker healthcheck. Unset
`APP_PASSWORD` and the server fails closed with a startup warning
rather than letting anyone in.

Persistence moves from the browser to the server: the old
`localStorage` record is gone, replaced by a new `/api/auth/status`
endpoint that returns the server-side `last_session` record when
authenticated, so logging in from any device reconnects to the same
tracked leagues automatically. Logout calls `/api/logout`, which
revokes the token in SQLite rather than just clearing it client-side.

Also changes the client's internal port from 80 to 5000 for
consistency with the published `${CLIENT_PORT}` — `nginx.conf`,
`Dockerfile`, and both compose files updated together, including
Caddy-facing comments.

README rewritten: security note, Caddy `basic_auth` reframed as
optional, persistence write-up, and `APP_PASSWORD` documented
throughout.

---

## v0.8 — Wired into an existing Caddy reverse proxy

**Commit message:** `feat(deploy): attach client to external caddy_net network for reverse-proxy access by container name; docs: Caddyfile + basic_auth guide`

- `client` now joins an external Docker network named `caddy_net`
  (alongside its existing internal `default` network for talking to
  `server`), so a Caddy container already on that network can reverse-proxy
  to it by container name (`client:80`) instead of needing the
  published `${CLIENT_PORT}`. `server` deliberately isn't added to
  `caddy_net` — nothing external ever needs to reach it directly.
- **Real behavioral consequence, not just an addition**: `caddy_net` is
  referenced as `external: true`, so `docker-compose.yml` now fails to
  deploy if that network doesn't already exist on the host, rather than
  silently creating a disconnected network of the same name. Documented
  in README's Option A with the one-line workaround
  (`docker network create caddy_net`) for deploying without Caddy.
- `docker-compose.local-build.yml` (the local-dev/build variant)
  deliberately left unchanged — no `caddy_net` dependency there, so
  local development doesn't require having Caddy set up at all.
- README: new "Deploying behind an existing Caddy reverse proxy"
  section with a working Caddyfile, `basic_auth` setup (confirmed
  current directive name/syntax — `basicauth` was renamed to
  `basic_auth` as of Caddy v2.8.0), and the alternative path for a
  non-dockerized Caddy install.
- Updated the "no login screen" security note now that internet-facing
  deployment is a real, documented path rather than a hypothetical.

---

## v0.7 — Fixed server container failing its healthcheck (never starting)

**Commit message:** `fix(docker): force better-sqlite3 to build from source for musl/Alpine, fix volume ownership at container start via entrypoint script`

Reported symptom: `dependency failed to start: container
fantasy-manager-server is unhealthy`, blocking the client from starting
too (it depends on the server passing its healthcheck).

Two real, plausible causes fixed together rather than guessing at just
one:
- **`better-sqlite3` native binary mismatch**: `npm install` can
  silently fetch a prebuilt binary for standard glibc Linux instead of
  actually compiling against Alpine's musl libc, even with the build
  toolchain present. That binary fails to load the instant the server
  process starts (`db.js` opens the database at import time, before
  the server ever binds to a port), which looks exactly like
  "unhealthy, never starts" from the outside. Fixed by adding
  `--build-from-source` to the Dockerfile's `npm install` step.
- **Named Docker volume ownership**: a build-time `chown` on
  `/app/data` doesn't reliably survive a named volume being mounted
  over it at container start — the volume can come back root-owned
  regardless of what the image specifies, especially if it already
  existed from an earlier deploy attempt. Fixed with a new
  `server/entrypoint.sh`: the container now starts as root, fixes
  `/app/data` ownership on whatever actually got mounted, then drops to
  the non-root `app` user via `su-exec` before running any application
  code.
- Added a defensive try/catch around database initialization in
  `db.js` that names both of the above causes explicitly in the log
  output if it ever fails again, instead of a bare native-module stack
  trace.

**Not independently verified against a live deploy** — this sandbox has
no Docker daemon, same limitation as every other Docker-related change
in this project. If this doesn't resolve it, `docker logs
fantasy-manager-server` showing the actual crash reason is the fastest
path to the real cause.

---

## v0.6 — Corrected projection pipeline + Docker Hub image packaging

**Commit message:** `fix(projections): 3-tier FP-API→scrape→ESPN pipeline with real ID joins via ffb_ids; feat(deploy): publish as Docker Hub images instead of Portainer git-build`

- Rebuilt the projection-matching pipeline into the correct priority
  order: (1) FantasyPros **API** `/projections`, ID-joined via the
  ffb_ids crosswalk's `sleeper_id`/`fantasypros_id` columns against the
  API's own `fpid` field; (2) FantasyPros **scraped pages**, name-fuzzy
  matched, filling whatever the API's free-tier cap missed; (3)
  **ESPN**, ID-joined via `sleeper_id`/`espn_id`, last resort. Removed a
  speculative scraped-row ID-extraction attempt from the previous
  version once it was confirmed scraped data carries no usable ID.
- Converted the deployment model from "Portainer builds from a GitHub
  repo" to "Portainer pulls prebuilt images from Docker Hub." Added a
  GitHub Actions workflow that builds and pushes both images
  (multi-arch: amd64 + arm64) on every push to `main`. The primary
  `docker-compose.yml` now has no build context at all; the old
  build-from-source file is preserved as `docker-compose.local-build.yml`.

**Amended within v0.6** (kept as the same version, per instruction,
rather than bumped to v0.7): default client port changed from 8080 to
5000 (`docker-compose.yml`, `docker-compose.local-build.yml`,
`.env.example`, README); Docker Hub account confirmed as
`mybadreligon` and set as the actual compose default rather than a
placeholder, so a normal Portainer deploy no longer needs
`DOCKERHUB_USER` set at all.

---

## v0.5 — Major feature round: navigation, persistence, database, and a batch of real-data bug fixes

*(Reconstructed from several consecutive, closely-related turns — a
large combined feature request, a follow-up ffb_ids integration ask,
and a subsequent round of "investigate why X is broken" fixes. Grouped
here as one version since they landed together as one coherent state of
the app before the next distinct delivery.)*

**Commit message:** `feat: SQLite persistence, hourly scheduler, FAAB suggestions, breadcrumb+history nav, PWA/Android support; fix: K/DST projections, ESPN kickoff query, non-consequential lineup swaps, waiver position filter, Trade Radar rebuild`

- Roster tab: separate IR and Taxi Squad sections; `SUPERFLEX` relabeled
  `SFLX`; kickoff time shown on every player card.
- Lineup Advice: side-by-side current-vs-optimal comparison with
  per-slot point deltas and `FP`/`E` projection-source tags; later
  fixed so only genuine roster changes (not interchangeable
  same-position reshuffles) are flagged, and so already-played starters
  lock to their actual score.
- Real browser back/forward support and a breadcrumb header
  (`username > League > Tab`), replacing an in-app-only back button.
- Username and tracked-league selection now persist across visits
  (`localStorage`); added Log Out and Edit Tracked Leagues.
- Week selector in the header, rebuilding all tracked leagues for the
  selected week.
- Real local database (SQLite via `better-sqlite3`) replacing
  in-memory-only caches: persistent Injury Watch (a status shows every
  refresh until resolved, Minor once seen before / Major the first
  time), an hourly background refresh for the last-active session, and
  a stale-data fallback if a live rebuild fails.
- Integrated the ffb_ids player-ID crosswalk for a real Sleeper↔ESPN ID
  join (FantasyPros ID-joining came later, in v0.6, once scraped-data
  IDs were confirmed not to exist).
- FAAB bid-percentile suggestions, scoped to tracked leagues only after
  confirming Sleeper's API has no platform-wide league directory.
- PWA installability (manifest, icons, service worker) and a
  step-by-step Android APK packaging guide (`ANDROID_APK.md`).
- Bug fixes from a follow-up investigation round: kickers/defenses were
  never fetched for projections at all (not a matching issue — they
  simply weren't requested); ESPN's schedule endpoint was using the
  wrong query parameter for season year, causing wrong-week kickoff
  times; the lineup optimizer could flag a meaningless swap between two
  equal-projection players at the same position; waivers showed
  K/DST suggestions even for leagues with no such starting slots; Trade
  Radar rebuilt to show every team's strengths/weaknesses (not just the
  user's) with suggestions grouped per opponent.

---

## v0.4 — Portainer/GitHub-ready two-service Docker stack

**Commit message:** `feat(deploy): two-service Compose stack (client+server), nginx-served frontend, Portainer deployment docs`

- Added a client `Dockerfile` (multi-stage: Vite build → served by
  nginx) and `nginx.conf` (proxies `/api/*` to the server container by
  Compose service name).
- Restructured `docker-compose.yml` into a full two-service stack.
- Switched FantasyPros key handling from a local `.env` file to
  Portainer's "Environment variables" field, since a Git-deployed stack
  won't have a `.env` sitting next to it.
- README rewritten around deploying via Portainer's "Add stack from
  Git" flow.

---

## v0.3 — Dockerized the backend

**Commit message:** `feat(deploy): add server Dockerfile and docker-compose for the backend`

- Added `server/Dockerfile` (non-root user, standard patterns) and an
  initial `docker-compose.yml` covering just the server service, ahead
  of the full two-service stack added in v0.4.

---

## v0.2 — Hybrid FantasyPros data sourcing (API + scraping)

**Commit message:** `feat(fantasypros): add robots.txt-compliant scraper as a second projections source alongside the API`

- Added `fantasyProsScrape.js` to pull projections from FantasyPros'
  public website, working around the free-tier API's ~10-player-per-position
  cap on `/projections`. Confirmed `robots.txt` permits crawling those
  pages first, with a 5-second crawl delay enforced in code, an honest
  User-Agent, and hourly caching.
- Investigated and referenced `ffpros` and the wider `ffverse` R
  ecosystem as prior art for this approach.

---

## v0.1 — First real, running app (not a sandboxed preview)

*(Reconstructed from two consecutive turns: the initial full-stack
build, and an immediate fix for a live 400 error discovered right
after — grouped together since the second was really "finishing"
v0.1's FantasyPros integration to actually work, not a separate
feature.)*

**Commit message:** `feat: initial Express+Vite two-app real deployment with live Sleeper + FantasyPros integration`

- Replaced the earlier single-file React artifact/prototype with a real
  two-part project: an Express backend (`server/`, holding the
  FantasyPros API key server-side) and a Vite/React frontend
  (`client/`), talking to each other over HTTP instead of running
  entirely client-side.
- Wired up real Sleeper API calls (username/league/roster lookups) and
  a first real FantasyPros API integration.
- Fixed a live bug found immediately after: FantasyPros'
  `/consensus-rankings` endpoint requires an explicit `position`
  parameter (confirmed via a live 400 response, which also confirmed
  the exact set of valid position values) and returns no per-player
  position field in its response, both of which needed handling.

---

## Pre-versioning history (context, not a numbered version)

Before v0.1, this project went through a functional-specification phase
and an in-chat prototype phase — a single-file React artifact with
mock data, then a version with real (but sandbox-limited) Sleeper API
calls — before "set it up to run for real" produced the first actual
deployable app (v0.1, above). Not numbered since nothing from that
phase persisted into the real app's codebase.
