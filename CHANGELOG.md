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
onward (v1, v2, v2.1, v2.2, v2.3, v2.4, v2.5, v2.6, ...) for future official releases.

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

## v2.6 — Tabs, Game Day, lineup lock-out, real source status

**Commit (short):** `v2.6: feat: tabs, Game Day, lineup lock-out`

**Commit (extended):**
v2.6 reorganises the app into three tabs: League Management (the
existing screens), Game Day, and Analytics (accuracy dashboard, leans
and the owner backfill).

Game Day shows who to cheer for and against across every tracked league.
Your starters count for you and your opponent's starters against you,
each weighted by a per-league importance such as dues. Each player's lean
is for-weight over total weight, drawn as one line per player from cheer
for (left) through balanced to cheer against (right). The band ratio, an
optional close-matchup weighting with its margin and floor, and per-league
include toggles are settings. Live points and game status refresh every
minute from Sleeper and ESPN, with no Tank01 calls.

Players whose game has kicked off are no longer recommended anywhere;
started starters stay locked. The header now shows what projections
actually came from, per source, and Tank01 data age, replacing fixed
text.

**Details**
- New `server/gameday.js` + `GET /api/gameday`, `GET/POST /api/gameday/settings` (per user, stored in `app_state`). `schedule.js` now carries game state/status/score and has a 60-second "live" mode.
- `buildLeague.js`: players get `started` (kickoff passed); started starters lock, started bench/free agents leave the candidate pool. `lineup.js`: same rule for Player Rankings, best-lineup and yellow checks (`hasStarted`).
- `GET /api/status/sources` + `projectionHub.getLastSummary()` + `tank01.weekStatus()` feed the header line. `tank01.parseProjections` accepts list/array responses too.
- UI: tab bar; Game Day screen (league score cards, filters, cheer-for/against lines, settings); Accuracy moved to Analytics.

**Known limitations / what was and wasn't tested**
- The "all projections show as Sleeper" report is not resolved — the new header status should show which source is missing; the server log lines requested earlier are still needed.
- Game Day's projected final for games in progress uses the larger of points so far and the projection (rough). Uses Sleeper `matchups` starters; median/bye weeks show a note instead of an opponent.
- Game status depends on ESPN's scoreboard; kickoff times decide the lineup lock.
- Tested with mocked APIs: Game Day maths (200 for vs 2×100 against = balanced, ratio bands, ratio change, close-matchup factor, excluded league), lineup lock-out (client and server), plus all earlier suites (44 server checks) and 34 browser checks including tabs, Game Day layout order, filters and settings save.

---

## v2.5 — Lean calibration, accuracy dashboard, own crosswalk, history backfill

**Commit (short):** `v2.5: feat: leans, accuracy dashboard, backfill`

**Commit (extended):**
v2.5 levels the projection sources against Vegas and starts measuring
them. For each scoring profile (reception points, TE premium, passing-TD
points), each non-Vegas source's per-position lean is Vegas points over
source points for players with both, across a rolling 4 weeks, with an
8-player minimum and a 0.8-1.2 cap. Players without props get their
source times that factor, shown on the card.

Every source's projection is now recorded per player per week, frozen at
kickoff, and compared with Sleeper actual stats. A new Accuracy screen
shows bias, average miss, RMSE, SD, correlation and rank correlation by
source, position and scoring, plus leans and a weekly trend.

The app keeps its own player-ID crosswalk: Tank01's player list is the
primary Sleeper/ESPN/Tank01 link source, and the full ffb_ids table is
still loaded with every site's IDs for future use. An owner
backfill fills 2026 to date and 2025 from free sources; Tank01 props and
projections follow in two batches 40 days apart, resuming at month-end
until the API rejects.

**Details**
- New: `projectionHub.js` (all sources per player, leans, recording, picking), `projectionStore.js` (tables `crosswalk`, `scoring_profiles`, `proj_records`, `actual_stats`, `actual_weeks`, `backfill_items`, `app_state`), `actuals.js`, `accuracy.js`, `backfill.js`.
- `buildLeague.js` now takes projections from the hub; `playerIdMap.js` reads the local crosswalk. Crosswalk sources: Tank01's weekly player list (primary links; also its CBS/Yahoo/Rotowire/FantasyPros IDs) and the full ffb_ids CSV weekly (every ID column kept in `ext_ids`); precedence Tank01 > ffb_ids > name match.
- Routes: `GET /api/accuracy` (any user), `GET/POST /api/admin/backfill` (owner). Scheduler: hourly actuals update; backfill batch 2 / month-end checks every 5 minutes; the pre-kickoff refresh also recomputes and re-records all sources.
- Tank01, verified live this round (4 test calls): odds for finished games are served (closing lines); a gameID odds query returns a single object; positive odds come without "+"; Tank01 playerID = ESPN ID; player info has `sleeperBotID`; projection field names; archived projections via `archiveSeason` (back to 2023); `getNFLGamesForWeek?week=all` returns a whole season in one call. The odds parser was fixed for the single-object response.
- UI: Dashboard → Accuracy screen (table, average-miss-by-week chart, lean table, owner backfill panel); source tags show the lean factor.

**Known limitations / what was and wasn't tested**
- Backfilled Sleeper/ESPN projections are whatever those sources kept and may include post-kickoff edits; backfilled weeks are flagged.
- If two leagues share a scoring profile but differ elsewhere (e.g. bonuses), the last league built writes that profile's records.
- Leans need overlapping Vegas players; until a few weeks of props exist (or the backfill runs) most factors show "—" (no adjustment).
- Actuals are fetched once per finished week; later stat corrections aren't re-pulled.
- Tested with mocked APIs: lean maths (ratio, pooling, clamp, window, DEF), frozen rows, accuracy metrics, same-players filter, crosswalk precedence, a full backfill (call counts, ordering, batch 2 scheduling at +40 days, idempotent rerun), stop-on-rejection and resume, plus the existing server (44) and browser (28) checks.

---

## v2.4 — Vegas prop projections (Tank01) and pre-kickoff refresh

**Commit (short):** `v2.4: feat: Vegas prop projections, pre-kickoff`

**Commit (extended):**
v2.4 adds Vegas prop-based projections using the Tank01 handoff
methodology. When a player has a full prop set for their position, the
lines become his projected stats; anytime-TD odds are converted to
expected TDs (implied probability / 1.18, then -ln(1-p)), and everything
is scored with the league's own settings. Players without a full prop
set use Tank01's projection, then Sleeper, then ESPN. Cards are tagged
VEGAS, TANK01, SLEEPER or ESPN.

tank01.js needs an optional TANK01_API_KEY. Calls are bounded by
freshness rules (schedule and projections daily, odds per game daily
Wed-Sun, player list weekly), about 450-500 a month, with a hard monthly
cap that falls back to Sleeper/ESPN.

Projections still refresh hourly, and now also about 60 minutes before
each kickoff slot: Sleeper and ESPN are re-pulled past the cache, Tank01
projections and that slot's props are refreshed, and every user's
leagues are rebuilt.

**Details**
- New `server/tank01.js`: quota-bounded fetchers (pacing, monthly counter, 429 back-off), defensive parsers for schedule / odds / projections / player list, `propsStatLine()` (full-prop-set rules per position, TD split, K kicking points), Sleeper-ID join via the Tank01 player list with name + position + team fallback.
- `buildLeague.js`: projection order Vegas → Tank01 → Sleeper → ESPN; per-league log line with counts for each.
- `scheduler.js`: pre-kickoff check every 5 minutes; fires once per kickoff slot 45–60 minutes before kickoff.
- Sleeper/ESPN `getWeekProjections()` accept `{ force: true }`.
- Config: `TANK01_API_KEY`, optional `TANK01_MONTHLY_LIMIT` (1000) and `TANK01_RESERVE` (50) in both compose files and `.env.example`s.

**Known limitations / what was and wasn't tested**
- No live Tank01 call was possible while building (the Tank01 connection wasn't available), so the odds, projections and player-list response shapes come from the handoff and Tank01's documented fields; parsers are defensive and each endpoint's first raw response is logged. Whether the player list carries Sleeper IDs is unconfirmed — if not, matching falls back to name + team (the handoff's method, 1/208 miss).
- Prop lines are used as expected values (they're closer to medians). The 1.18 TD vig factor was calibrated against Tank01's own TD projections.
- Odds aren't fetched Mon–Tue except the pre-kickoff pull, so Monday-night props come from Sunday's pull plus the pre-kickoff refresh.
- Tested with mocked APIs: odds-to-TD maths, full/partial prop rules, quota cap, no odds after kickoff, daily caching, forced-pull de-duplication, a league build using all four sources, the pre-kickoff trigger firing once per slot, plus the existing server (44) and browser (23) checks.

---

## v2.3 — Sleeper projections first, ESPN fallback

**Commit (short):** `v2.3: feat: Sleeper projections, ESPN fallback`

**Commit (extended):**
v2.3 makes Sleeper's own weekly projections feed the primary
projection source, after v2.2's ESPN-only build still left players
without projections.

sleeperProjections.js makes one cached request per week to the feed the
Sleeper app uses, covering QB, RB, WR, TE, K and DEF. Rows are keyed by
Sleeper player ID, so no name or cross-site ID matching is needed. Each
league's points are computed from the projected stats times that
league's own scoring settings, so custom scoring is exact, with position
reception bonuses and defense points/yards-allowed tiers added when not
explicit. Placeholder values are ignored, a browser User-Agent is sent,
and api.sleeper.app is tried if api.sleeper.com refuses.

ESPN stays as the fallback for anyone Sleeper has no projection for.
Cards are tagged SLEEPER or ESPN, and each build logs how many players
got each source or none.

**Details**
- New `server/sleeperProjections.js`: `getWeekProjections()` (one request, hourly cache, `api.sleeper.com` then `api.sleeper.app`, browser User-Agent, drops `adp_*` and ≥999 placeholders), `scoreStats()` (Σ stat × scoring setting, `bonus_rec_rb/wr/te`, `pts_allow_*` / `yds_allow_*` tiers from projected points/yards allowed, preset `pts_*` totals only if nothing overlaps), `lookupProjection()`.
- `buildLeague.js`: Sleeper → ESPN → none, with a per-league log line of the counts; warning text "No Sleeper or ESPN projection for: …".
- UI tag `SLEEPER` / `ESPN` / `FINAL`.

**Known limitations / what was and wasn't tested**
- Sleeper's feed is unofficial. Live sample rows (QB, WR, K, DEF) were inspected through a page reader; a full week's response was never fetched end to end, because Sleeper and ESPN are both blocked from the build sandbox. Check the `[sleeperProjections]` and `[buildLeague] … projections — Sleeper: X, ESPN fallback: Y, none: Z` log lines after deploying.
- Kicker/defense points can differ slightly where a league scores something the projection doesn't break out.
- Tested with mocked responses: scoring maths for QB/WR/TE/K/DEF, placeholder filtering, the 403 → backup-URL path, a full league build mixing Sleeper and ESPN sources with no warnings, plus the existing server (44) and browser (23) checks.

---

## v2.2 — ESPN-only weekly projections

**Commit (short):** `v2.2: feat: ESPN-only weekly projections`

**Commit (extended):**
v2.2 makes ESPN the only projection source, fixing most players having
no projection. FantasyPros' free API and its logged-out projection pages
both stop at about 10 players per position, and the old ESPN fallback hit
an endpoint that returns season-total NFL stats, not weekly fantasy
projections, so everyone else came back blank.

espnProjections.js now makes one cached request per week to ESPN's
fantasy player feed (leaguedefaults/3, kona_player_info, no login),
covering QB, RB, WR, TE, K and D/ST. Players are matched by crosswalk
ESPN ID, then name and position, and defenses by team. ESPN's PPR totals
are adjusted to each league's points per reception, TE premium and
points per passing TD.

The FantasyPros scraper, its cheerio dependency and the /projections API
call are removed; FantasyPros remains for expert consensus rankings. The
UI source tag now reads ESPN.

**Details**
- New `server/espnProjections.js`: `getWeekProjections(season, week)` (one request, hourly cache, logs player counts + one sample), `lookupProjection()` (ESPN ID → name+position → team for D/ST), `adjustForScoring()` (rec, `bonus_rec_te`, `pass_td`).
- `buildLeague.js` uses it for every projection (roster, waivers, Trade Finder); warning text now "No ESPN projection for: …".
- Removed `server/fantasyProsScrape.js`, `cheerio`, and `fantasyPros.getProjections()`. FantasyPros API calls per build drop by one.
- UI: projection source tag shows `ESPN` instead of `FP`/`E`; header reads "Sleeper + ESPN projections (live)".

**Known limitations / what was and wasn't tested**
- ESPN is blocked from the build sandbox, so only a 3-player live sample was inspected. Full pool size, K/D/ST coverage, the PPR default (third-party report) and the stat IDs for receptions (`53`) and passing TDs (`4`) (community maps) are unverified. Check the server log line `[espnProjections] … N players from ESPN, M with a weekly projection` after deploying.
- Scoring settings other than reception/TE-premium/passing-TD use ESPN defaults.
- Tested with mocked ESPN/Sleeper responses: unit tests for parsing, matching and scoring, plus a full league build (all six players projected, no warnings), and the 44 existing server checks.

---

## v2.1 — Per-user login with roles, Player Rankings, SQLite WAL fallback

**Commit (short):** `v2.1: feat: per-user login, rankings, WAL fix`

**Commit (extended):**
v2.1 replaces the shared APP_PASSWORD with per-user login (Sleeper
username + scrypt-hashed password), owner/guest roles, and an owner-only
admin screen to add users, reset passwords, change roles, and revoke
access immediately. The owner comes from OWNER_USERNAME/OWNER_PASSWORD
(forced change on first login). Users change their own password only
with the current one. Tracked leagues, push alerts and background
refresh are now per user.

The Lineup tab gains Player Rankings: every roster player (starter,
bench, IR, taxi - labelled) as a drag-to-reorder card by projected
points, free agents in a separate section. The order overrides the
suggested lineup; yellow flags a better projected lineup, red a
projection of exactly 0.

Fixes the SQLITE_IOERR_SHMSIZE crash on volumes that can't do WAL
(falls back WAL > exclusive WAL > DELETE; DB_JOURNAL_MODE override) and
SUPER_FLEX slots never being filled. Upgrade: sessions reset once,
re-enable push alerts.

**Details**
- **Login/roles:** Sleeper username + password; `owner`/`guest`. `OWNER_USERNAME` + `OWNER_PASSWORD` create the owner on first start (forced change at first login). Owner screen: add user, reset password (temp, shown once), make owner/guest, revoke/restore, remove. Env owner can't be demoted/revoked/removed; `OWNER_FORCE_RESET=true` is the recovery path. Revocation ends sessions on the next request.
- **Player Rankings:** Lineup tab → Player Rankings. Drag handle or ↑/↓ keys; saved per user per league; "Reset to suggested order". Yellow/red highlights as above.
- **DB fix:** `server/db.js` tries WAL, then WAL with exclusive locking, then DELETE journal, logs which it used, and honours `DB_JOURNAL_MODE`.
- **Bug fix:** SUPER_FLEX slots were keyed wrongly in `buildLeague.js` and could go unfilled.
- **Removed:** `APP_PASSWORD` (compose files, `.env.example`, README updated).

**Upgrade notes:** replace `APP_PASSWORD` with `OWNER_USERNAME` and `OWNER_PASSWORD`; everyone is logged out once; push subscriptions are dropped (re-enable alerts per user); the previous tracked-league selection carries over to the user with that username.

**Known limitations / what was and wasn't tested**
- The real SQLite WAL failure (`SQLITE_IOERR_SHMSIZE`) could not be reproduced here, so the fallback path is untested against the actual failure; the server was tested with Node's built-in SQLite standing in for better-sqlite3.
- Server flows (login, roles, admin, throttling, rankings, push, migration) passed 44 in-process checks; the client was exercised in headless Chromium with a mocked API using mouse input. Touch dragging on a real phone is untested.
- Login throttling is per username, so a named account can be briefly locked by someone guessing.
- Free agents can't be dragged. IR/taxi players are never started by the suggested lineup; ranking one into a slot is honoured but flagged "needs a roster move".

---

## v2 — Season Outlook, real Trade Finder, nflverse usage data, pre-kickoff push alerts

**Commit (short):** `v2: feat: season odds, trade finder, usage, push`

**Commit (extended):**
v2 integrates everything queued in the pending-changes log since v1. A
new Season Outlook tab runs a 3,000-trial Monte Carlo simulation
(`server/simulate.js`) using each team's season-to-date scoring average
against the real remaining Sleeper schedule to produce playoff and
championship odds, avoiding a full per-player projection re-run that
would risk FantasyPros' rate limit. The Trade tab gains a real Trade
Finder: 1-for-1 swaps against every rival roster, filtered to
same-position players within a 20-rank ECR "fairness" tolerance who
project more points, ranked by gain (`buildLeague.js`). Roster/Waiver
cards now show snap%/targets/carries badges from nflverse's free public
data (`server/nflverseUsage.js`), name-matched for the prior week.

Pre-kickoff push alerts ship via real Web Push (VAPID, `server/push.js`,
a new `push_subscriptions` table, service-worker handlers, a dashboard
toggle): the hourly scheduler now fires a notification when a starter
is designated Out/IR/PUP within ~26 hours of kickoff, or a bench option
clearly outscores a starter, deduplicated per condition.

Deliberate, documented scope reduction from the original "Android APK
with push notifications" idea: Web Push through the existing PWA, not a
native app with Firebase Cloud Messaging (packaging, signing, Play
Store review). `ANDROID_APK.md`'s Trusted Web Activity path to an
installable APK is unaffected and works with these alerts unchanged.

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
