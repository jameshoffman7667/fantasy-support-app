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
onward (v1, v2, v2.1, v2.2, v2.3, v2.4, v2.5, v2.6, v2.7, v2.8, v2.8.1, v2.9, v3.0, v3.1, v3.2, v3.3, v3.4, v3.5, ...) for future official releases.

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

## v3.5 — trade values, player card, injury rules, Game Day, header menu

**Commit (short):** `v3.5: feat: trade values, player card, Game Day`

**Commit (extended):**
v3.5 adds trade values. Dynasty leagues use Roster Audit (FantasyCalc as fallback); redraft and keeper leagues use FantasyCalc redraft values. Incoming offers show the value change and get a yellow variance when they lose more than 10%; a 10%+ gain shows green. Team strengths come from Roster Audit in dynasty and rest-of-season projections otherwise, and Trade Finder keeps swaps within 10% in value. Opponent ownership leaves best ball out unless switched on and shows each opponent's share of his leagues. The deadline is the end of the week's last game, teams show real names, and a manual refresh re-reads offers.

Tapping a player opens a Sleeper-style card: decimal age, number and bye, ranks, projections, news, game log, team ranks and depth chart, league history, career, and nflverse advanced stats coloured by percentile or fixed thresholds.

Injury opportunities need 5+ projected points before the injury, only promote players below him, and fill two same-position and one WR/TE pickup from his own team first. Game Day has two-wide cards with win %, a first-kickoff baseline and grouped game slots. New header menu and icons; images are amd64 only.

**Details**
- Trade values (`server/values.js`, new): Roster Audit public API (`/rankings/values?format_key=` with sf_ppr / 1qb_ppr / sf_half / 1qb_half / sf_ppr_tep chosen from the league's QB slots, PPR and TE premium; `/picks`; `/players/{id}`; `/trade/calculate`) and FantasyCalc (`/values/current?isDynasty&numQbs&numTeams&ppr`). Dynasty (`settings.type` 2): Roster Audit, FantasyCalc dynasty if Roster Audit doesn't answer. Redraft and keeper: FantasyCalc `redraftValue`. Tables are cached 24 h; the last good copy is used for up to 7 days when a site fails ("yesterday's values" note); a failure is retried after 10 minutes. No Roster Audit credit in the UI (personal app). Optional env: `VALUES_USER_AGENT`, `ROSTER_AUDIT_BASE`, `FANTASYCALC_BASE`.
- Offers (`privateData.js decorateOffers`): both sides valued (players + picks; dynasty picks by year/round and early/mid/late slot from the original owner's strength; redraft ignores picks and says so). Verdict: win at +10% or more (green note), loss at −10% or worse, otherwise about even. New yellow variance "Offer loses trade value" for incoming losses. Dynasty offers also get Roster Audit's own calculator result (we send what you get as side A); the calculator is limited to about 35 calls an hour and cached 6 h, and the saved copy shown while the app starts never calls it.
- Strengths and weaknesses (`tradeTools.js`, new): each position's starting slots plus every flex it can fill; dynasty sums Roster Audit values, redraft/keeper sums rest-of-season points (`rosProjections.js`, new: Sleeper weekly projections from this week to the last fantasy playoff week, league scoring, cached 6 h). Shown as ranks ("2nd of 12"). Old ECR/projection ranking stays as the fallback. Trade Finder: different positions, within 10% in value, ranked by lineup gain; shows both values.
- Trades page: "Owned by opponents elsewhere" leaves best ball leagues out unless the new box is ticked, and shows each opponent's share of his own leagues plus the average. Deadline = end of the deadline week's last game (last kickoff + 3.5 h, or when that game is final), no explanation note. Withdraw warning removed. Roster labels use team names. The refresh button rebuilds with `manual: true`, which re-reads trade offers and claims live (the 30-minute auto refresh doesn't).
- Player card (`playerCard.js`, `nflverseStats.js`, `advancedStats.js`, new; `GET /api/player-card?id=&leagueId=`, league must be tracked): tap a player's photo or name anywhere (Roster, rankings, lineup rows, Waivers, Claims, drops, Injury, Trades, offers, Game Day). Header in team colours: age with one decimal, height, weight, experience, position, team, number, bye. Availability in your leagues. Tabs: Summary (position/overall rank, points per game in the league's scoring, Sleeper trending adds, this week's matchup, last game, 4-week projections, advanced stats, dynasty/trade value with 7/30-day trend, ESPN news), Game log (this and last season, with snap % and weekly rank), Team (6 offence ranks, depth chart with ages, rookies and injury marks), History (league transactions and drafts across previous seasons, career by season with half-PPR/PPR ranks). nflverse files are cached on disk (12 h current season, 30 days older).
- Advanced stats: QB snap share, CPOE, EPA per dropback, pressure rate, bad throw % (+ air yards, time to throw as context); RB snap share, carry share, target share, YPC, rush yards over expected, yards after contact, broken tackles, drop rate (+ stacked boxes); WR/TE snap share, target share, air yards share, targets and yards per route (est.), separation, YAC over expected, drop rate (+ aDOT, cushion). Toggle Percentile (top/bottom third among qualifying players at the position) or Fixed (2025 top/bottom-third cut-offs, recalibrated from real data — several earlier proposed numbers were off); remembered on the device. Routes = offensive snaps × team dropback rate, WR/TE only.
- Bye weeks on roster ranking and waiver cards (`schedule.getSeasonSchedule`).
- Injury opportunities (`injuryOpps.js`): ESPN WR1/WR2/WR3 slots kept; backups are his own slot's backups then players ranked below him (a hurt WR3 never promotes the WR2). Only players projected 5+ points before the injury count (that week's projection if any, else the latest of the previous 3 weeks' stored projections, else season points per game). Pickups: two available same-position players from his team and the best available of the team's top-three WR/TE; other teams only top up when he is on your active roster and his team can't fill it. Injury rows no longer show the status twice.
- Game Day: league cards two wide, "my score (proj) – their score (proj)"; title green/red when your expected final leads/trails by 5% or more of the points both teams still have to score, yellow in between; projections red when below the baseline; live win % (normal approximation, SD 2.3 × √remaining points). Baseline = projected totals at the week's first kickoff (kept up to date until then; the scheduler snapshots 60 minutes before). Players grouped by kickoff slot → game → team, slots collapsible, finished games in a collapsed "Complete" section at the top.
- Header and navigation: Sleeper photo and name top left open a menu (My leagues, League management = the old Edit tracked leagues, Enable alerts, Account settings, Log out); league pictures beside league names; League Management icon = football player outline, Game Day icon = uprights; sync status moved to the bottom of the page.
- Build: Docker images are `linux/amd64` only (QEMU step removed).
- Tests: unit 97 checks (values parsing, verdicts, strength ranks, deadline, injury rules incl. same-team fill and other-team top-ups, win %, advanced-stat colours and CSV parsing), integration 53 checks with mocked Sleeper/ESPN/value sites and real nflverse files (48 with the value sites down), client modules 12 checks (v3.4 lock rules still hold; the new offer variance), Playwright harness over the real client (dashboard, menu, trades, Game Day, card tabs and toggle, waivers, injury, lineup rows: no page errors), eslint no-undef. Not run: vite build, Docker build, anything live.
- Unverified (sites unreachable from the build sandbox): Roster Audit and FantasyCalc responses (parsed defensively; the app falls back to projection ranks), Roster Audit calculator verdict wording, ESPN depth chart and news shapes beyond what was checked, 2.3 win % spread.

---

## v3.4 — Pick'em upset picks and performance, locked players, Roster title

**Commit (short):** `v3.4: feat: upset picks, performance, lock audit`

**Commit (extended):**
v3.4 changes the Pick'em recommendations to differ from Vegas on purpose. Every game is the favourite except the very-high-upset games: always the single highest upset potential, plus up to three more at or above a threshold (default 45), never more than four. Games already started keep their pre-kickoff pick and count toward the cap. The old weekly-leverage mode is replaced. The pick is boxed on the card, green for a favourite and yellow for an underdog, with an updated label.

A new Performance view compares your picks, the app's picks and Vegas against actual results, weekly and for the season. Earlier weeks are back-calculated from ESPN odds where possible (marked as reconstructed), and you can load your own earlier picks game by game.

The merged page is now titled "Roster". Locked players (game kicked off, week not over) no longer get variances, notes or suggested moves that only a move could fix: starter-out, flex order, IR-eligible bench, IR-slot red, zero projection, waiver comparisons, drop candidates, IR proposals, injury play-opportunity notes.

**Details**
- Pick'em (`server/pickem.js`): `recommend(board, settings, stored)` = favourites, except upset picks: the single highest upset potential always (minimum 1), then more only at or above `upsetThreshold` (default 45, Settings), maximum 4 including started games' stored underdog picks. Settings: "Upset picks" switch + threshold; `leverage`, `leverageCount`, `minDogProb` and the pool-% boxes are gone. `storedPicks()` added; the CBS push (`cbs.js finalPicks`) passes it so a push never counts the cap wrongly.
- Card: green box = favourite, yellow box = underdog, around the picked team's side of the win bar and on the label ("App pick" / "Your pick": TEAM (favourite | underdog — upset pick)); your own pick buttons use the same colours.
- Performance: new Pick'em view "Performance" and `GET /api/pickem/performance`. Per week and season: Vegas, app, you, app upset picks, and "on the games you picked: you / app / Vegas". Vegas = favourite on the last line stored before kickoff (hourly snapshots since v2.7); for weeks with none, ESPN's listed odds on the finished game. App = the pick stored before kickoff; for weeks with none, RECONSTRUCTED by applying the upset rule to ESPN odds only (no line movement or articles, so at most one upset pick) and shown with "~". A tick box leaves reconstructed weeks out of the totals. Your picks = picks entered in the app; a drop-down on every finished game loads an earlier pick by hand (uses the existing `/api/pickem/choice`). Results are stored per game (winner, Vegas pick, source) in `pickem_results:{season}`; earlier weeks are fetched from ESPN once.
- Page title: "Roster & Lineup" is now "Roster" (tab, variance report).
- Locked players (new helper `isLocked`/`lockedNames` in `lineup.js`: game kicked off and the week not over; everything reopens after the last game): hidden now: Starter out/doubtful/IR, Flex lock order (either player locked), IR-eligible on bench, Non-IR-eligible player in IR slot (red now only until kickoff), Starter projected for 0, waiver red/yellow comparisons (locked starters and locked bench players are not compared), drop-ranking candidates on Claims, IR move proposals, injury own-player red (P03), play-opportunity (P05) variance and the Roster-page notes for locked players. Not changed: No projection (a data fault, not a move), trades, injury-page notes, My performance records.
- Older "next version" items in the log (dashboard card layout, one-row badges, IR flag with no open slot, Clear-minor bug, Game Day, Pick'em weather and notes, Matchup rankings, Accuracy, trade advice, ROS, expanded report, reconnect speed) were checked against the code and were already delivered in v2.9; nothing to build.
- Tests (mock fetch, sqlite shim for node:sqlite): upset-rule cases (cap, minimum, threshold, off, started games), performance and board with ESPN/Sleeper mocks (14 checks), lock rules in variances/roster changes/lineup (10 checks), client bundle compile. Not run here: the Playwright browser harness (not in the zip), vite build (npm blocked), anything live.
- Unverified: whether ESPN keeps odds on finished games (back-calculated Vegas picks depend on it); the threshold default 45 and "very high" meaning are my picks; the visual layout of the boxes (Tailwind never rendered here).

---

## v3.3 — native CBS auto mode, My performance, fewer API calls

**Commit (short):** `v3.3: feat: CBS auto mode, performance, caching`

**Commit (extended):**
v3.3 replaces the CBS recipe with a native adapter: sign-in, read the
pool's games and picks, and save only the changed picks, with the save
reply used as the read-back. Auto mode still sends once, 60 minutes
before each kickoff slot; it switches itself off if you change a pick
on CBS, and a manual pick in the app asks first. Analytics gains "My
performance": lineup swaps and waiver flags judged against actual points,
weekly and cumulative. Player-card source tags use the Analytics
colours. API calls drop sharply through one central Sleeper cache,
Tue/Wed/Thu week pulls, slower projection pulls with 3-hour and
60-minute pre-kickoff refreshes, 6-hour trade-offer snapshots, shared
live Game Day polling, and no rebuilds for inactive users or off-season.
The client image now builds natively with per-image caching. CBS sign-in
and several details remain unverified against the live site.

**Details**
- CBS: `server/cbsNative.js` (new), `server/cbs.js` (native engine, watchTick, alerts); recipe engine kept under Advanced. Auto-off detection, confirm pop-up, Preview, test login reporting cookie names only.
- Performance: `server/performance.js`, `GET /api/performance`, Analytics "My performance" tab. History starts at the first build with this.
- Reductions: R1, R3, R5, R6, R10-R25 as listed in spec section 8.2l (R2, R4, R7, R8, R9, R26, R27 unchanged or superseded). Note: R1 (5-minute own rosters/matchups cache) overlaps R27; R1 was answered yes later and is what is built.
- Trade news (Gemini) no longer runs when the Trades page opens; the existing button runs it.
- Build: client `--platform=$BUILDPLATFORM`; per-image gha cache; timeout 40 min; package versions 0.0.0. Server arm64 still builds under QEMU.
- Tests: mock-CBS native and recipe tests, performance tests, reduction tests, earlier server regressions, 187 browser checks, all passing. Not run here: vite build (npm blocked), live CBS/Sleeper.

---

## v3.2 — CBS pick'em push

**Commit (short):** `v3.2: feat: CBS pick'em auto-push`

**Commit (extended):**
v3.2 lets you make your own Pick'em picks in the app (tap a team on a
game; the recommendation is used where you haven't chosen) and push them
to your CBS pick'em pools automatically. Account has a new CBS panel:
email and password (stored encrypted, never sent back), pool ids, and a
request recipe built from your browser's network tab (CBS-CAPTURE.md
explains how). CBS's real endpoints are unknown to the app and untested.

Auto-push runs about 60 minutes before each kickoff slot, never sends a
game that has started, retries up to 3 times, and notifies you after
every push, success or failure. Safeguards: off by default, pause
switch, preview that sends nothing, confirm-first manual push, a log,
read-back verification when the recipe has one, and the first run uses
only one test pool until verified or confirmed by you.

**Details**
- New: `server/cbs.js` (encrypted login, cookie session, templating, per-slot scheduler, log table `cbs_push_log`), routes `/api/cbs/*` and `POST /api/pickem/choice`, scheduler hook every 5 minutes, `CBS-CAPTURE.md`.
- Your picks and tiebreaker are saved per week; "final pick" = your choice, else the recommendation.
- Requests are limited to https hosts under cbssports.com (`CBS_ALLOWED_HOSTS` to change).
- Tests: mock-CBS server tests (login, templating, first-run test pool, read-back, failure logging, re-login on 403, auto timing, retry cap) and 183 browser checks pass.
- Unverified: everything about real CBS (endpoints, login flow, anti-bot/CSRF, lock times, terms of use). Never run live.

---

## v3.1 — Account toggles, withdraw offers, waiver lock, injury opportunities

**Commit (short):** `v3.1: feat: toggles, withdraw, injury adds`

**Commit (extended):**
v3.1 adds per-feature switches under Account: Read from Sleeper, plus
separate write permissions for Roster changes (lineup and IR), Waiver
claims, and Trades. With reads off, the private-only parts (trade
offers, League log, pending claims) are hidden.

The Trade page now shows every outgoing offer (only stale ones raise a
red variance) and each outgoing offer has a Withdraw button. Withdraw
is unverified: it calls reject_trade on your own offer and reports
success only if the offer is gone when read back.

A player is unavailable on waivers from his own game's kickoff until
the week's last game ends, and is hidden from Available, injury adds,
proposed claims and the claim simulation.

Variance rules: V05, V09/V10, V16 now clear on the actions agreed, and
a new red rule flags a non-IR-eligible player in an IR slot on game day.
New injury opportunities (depth chart, next two backups, WR/TE
opposite-position add) appear on Waivers, Roster and Injury.

**Details**
- New: `server/injuryOpps.js`; Gemini `injurySentiment`; push marks (`push_marks:{user}:{league}`); routes `POST /api/private/perms` and `/api/private/withdraw-trade`.
- Permissions: legacy "Allow changes" maps to all three write groups on; every push still needs confirm, is logged and read back.
- IR eligibility is read per league from Sleeper settings (setting names unverified); default is Out/IR/PUP only. V07 uses the same rule.
- Injury page: notes only (no variances). Waivers: "Injury adds" section; P02 yellow (clears once viewed), P03 red when your active player is injured (clears when dealt with, or on a waiver push), P04 Questionable yellow. Roster: P05 yellow when you own a backup (clears on a lineup push) plus a replacements note.
- Not included: player-card note edits (awaiting your file). CBS pick'em push is v3.2.
- Tests: 170+ browser checks, server tests (permissions, withdraw, marks, injury opportunities) and rule tests pass against mocks.
- Unverified: withdraw via reject_trade; IR move, claim submit/cancel and pending-claims status word; ESPN depth chart shape and team ids; league IR-flag setting names; Gemini model id; Tailwind layout (never rendered in the harness); the private API has never run live.

---

## v3.0 — Sleeper private access: roster push, trade inbox, League page

**Commit (short):** `v3.0: feat: Sleeper private API, roster push`

**Commit (extended):**
v3.0 adds everything that needs Sleeper's private, undocumented
GraphQL API, all opt-in. Under Account you paste your Sleeper token
(stored encrypted, never sent to the browser) and separately switch on
"Allow changes". Roster and Lineup are now one page: the roster, then
Proposed changes (tick boxes) and Update roster (summary of ticked
changes and a Push to Sleeper button). Lineups are written to your
roster and the matchup leg, then read back.

Trades show offers waiting on you (yellow, never auto-clearing) and your
own stale offers (red), and you can reject an offer from the app. Waiver
claims already queued in Sleeper are hidden from proposals and listed
with Cancel; Push to Sleeper sends one test claim, then the rest. A new
League page shows the settings change log, yellow until cleared.

Every push asks for confirmation and is logged. Moving to IR and claim
submit/cancel are unverified calls and are reported honestly if they
don't take. Old Lineup acknowledgements migrate to the Roster page.

**Details**
- New: `server/sleeperPrivate.js` (client, encrypted token, reads, writes, `private_write_log`), `server/privateData.js` (offers, pending claims, change log, stale rules), `client/src/rosterChanges.js`; routes under `/api/private/*`; `privateInfo` on build and cached responses.
- Proven by the reference project: reject trade, set lineup (needs the matchup-leg write as well). Unverified: IR move, claim submit/cancel, pending-claims read, change log with token. Nothing was run against live Sleeper (not reachable from the build sandbox); tested against a mock, 165 browser checks and server tests passing.
- Spread line movement was NOT rebuilt: Pick'em already snapshots the line hourly and shows movement. Scheduled auto-claiming was not built (manual push only).
- Behaviour changes: Lineup page and its badge are gone (five badges: Roster, Waivers, Trades, Injury, League); Roster page variances now include the lineup rules; weather variance (auto-clearing) now appears on the Roster page.
- League page: the first view lists up to 30 existing log entries as yellow until cleared once.
- Unverified: the Sleeper league link in the claims checklist; page layout (the test harness has no Tailwind).

---

## v2.9 — Waiver pages, trade tools, faster loads (public API)

**Commit (short):** `v2.9: feat: waiver pages, trade tools, speed`

**Commit (extended):**
v2.9 collects every change that needs only public Sleeper data. Waivers
split into Available (top 5 projected and top 5 trending per position,
bid box on every player, $ or % entry) and Claims (grouped by bid, drag
to reorder within a group, edit, delete, add custom claims, reset, FAAB
now vs predicted after, checklist to enter in Sleeper). FAAB bid history
and a 3-day drop summary were added.

Trades gain a Gemini news flag, a reworked Trade Finder, a deadline
countdown and other-league ownership. Game Day gets a league filter,
time slots and for/against chips; Pick'em a weather chip and longer
notes; Analytics Last 4/ROS/Blend matchup ranks and a sortable accuracy
matrix by position.

The dashboard paints from the last saved build and refreshes leagues two
at a time. Variance rules changed: weather and big-gap trades auto-clear
after being seen, waiver flags compare projections with starters and
bench, trending flags are gone, and players with no projection are
flagged. Bug fixes: IR flag, cleared variances reappearing.

**Details**
- New: `client/src/waiverPlan.js`, `server/waiverPlan.js`, `faab.js` history, `transactions.js`, `crossOwnership.js`, `tradeDeadline.js`; routes `/api/waiver-plan`, `/api/leagues/cached`, `/api/trade/advice`; build accepts `trackedIds`.
- Behaviour changes to expect: more "Open bench slot" yellows (bench padding); waiver red/yellow rules changed; trending variance removed; "last 4 sample" option removed (saved value reads as blended); non-fantasy positions no longer recorded in accuracy; acks have a 12 h prune grace.
- Waiver plan validation rejects negative bids rather than clamping them to 0.
- Unverified: equal-bid processing order, ROS, trade deadline source, ownership data, Game Day for/against orientation. Tailwind layout could not be rendered in the test harness; structure was tested, visual layout was not.
- Tests: 117 browser-harness checks, build/acks/dvp/routes server tests, pure waiver and variance tests all pass.

---

## v2.8.1 — Variance report

**Commit (short):** `v2.8.1: feat: variance report, clear minors`

**Commit (extended):**
v2.8.1 adds a Variance report button at three levels: the top of the
main page covers all leagues, each league card and league page covers
that league, and each page covers just that page. The pop-up lists every
yellow and red flag grouped by league, then page, then the rule broken.
Groups start collapsed, with expand-all and collapse-all buttons. Text is
coloured by severity and each heading takes the worst colour beneath it.

Each pop-up has a Clear minor variances button for its scope. Cleared
yellow items stop colouring their rows, page badges and league cards
until something new appears: a different issue, player or injury status,
or a cleared item that turns red. The same issue with a changed number
stays cleared, and red items can't be cleared. Clears are saved per user
on the server so they follow you across devices, and are dropped once
the issue goes away, so a recurrence shows again.

**Details**
- New `client/src/variances.js` (pure: collect, key, apply clears, group, roll up) and `server/varianceAcks.js` (stored in `app_state` as `variance_acks:{user}`).
- Routes: `GET /api/variances/acks`, `POST /api/variances/ack`, `POST /api/variances/prune` (after each build).
- `computeRoster` now records the rule behind each roster flag. Page statuses are derived from the variances, and match v2.8 exactly when nothing is cleared (unit-tested).
- Player Rankings still shows its own live highlights (it re-plans as you drag), so cleared items aren't hidden there.

---

## v2.8 — Matchups, weather, headshots, stat lines

**Commit (short):** `v2.8: feat: matchup ranks, weather, headshots`

**Commit (extended):**
v2.8 makes player cards richer. Each card shows a headshot (Sleeper, then
ESPN, then initials) and the matchup as "NYJ @ MIA". The player's team is
coloured by its offensive rank at his position, the opponent by its
defensive rank against it, on a five-colour red-to-dark-green scale. Cards
also show kickoff, a weather chip for outdoor games, and the projected stat
line from the source behind the projection.

Matchup difficulty is computed in-app from Sleeper's weekly game stats in
each league's scoring: points allowed and scored per game by position,
blended with last season (fading), this season only, or the last 4 games,
with an optional schedule adjustment. A new Analytics view ranks every
defense and offense by position, and tapping a team shows the games behind
its number.

Weather uses Open-Meteo forecasts at kickoff. Significant wind, rain or snow
flags the starter as a minor issue on the Lineup tab, with an hourly pop-up.
Domes are skipped, retractable roofs are never flagged, and the owner can
edit the thresholds. Team logos also appear in Pick'em, Game Day and the
rankings.

**Details**
- New `server/dvp.js` (tables `dvp_stats`, `dvp_weeks`; per-user `dvp_settings:{user}`), `server/weather.js` (stadium table, Open-Meteo, flags; app-wide `weather_settings`), `server/images.js` (disk-cached image proxy under `DATA_DIR/img`).
- Routes: `GET /api/dvp`, `GET /api/dvp/detail`, `GET|POST /api/dvp/settings`, `GET /api/weather`, `GET /api/weather/settings`, `POST /api/weather/settings` (owner), `GET /api/img/:kind/:id`.
- Scheduler: matchup stats load 20 s after start-up and hourly (last season once; this season's finished weeks, re-pulled daily for ~9 days for stat corrections; the current week's finished games hourly).
- `projectionHub.pick` now also returns `projStats` (the chosen source's stat line, before any lean). Built players carry `id`, `matchup`, `weather`, `projStats`; leagues carry `scoringProfile`.
- `schedule.js` keeps ESPN's neutral-site and venue flags. `lineup.js` adds `weatherStarters` (a flagged starter makes an "ok" lineup "minor").
- Unverified from the build sandbox: Open-Meteo and the image CDNs (unreachable from here). All fail soft. The Sleeper stats feed was checked live.
- Change during the build, at James's request: cards show the team and opponent coloured separately by offensive and defensive rank, instead of a single "28th vs WR" label.

---

## v2.7 — Pick'em tab

**Commit (short):** `v2.7: feat: Pick'em tab with upset tracking`

**Commit (extended):**
v2.7 adds a straight-up Pick'em tab. Each game's win probability comes
from the sportsbook moneylines the app already pulls from Tank01, no-vig
and averaged across books, falling back to ESPN's lines, the spread, then
ESPN's FPI, which is also shown as a second opinion.

Each card shows a win bar in the two teams' colours, the recommended
pick, and an upset-potential bar that grows with the underdog's chance,
line movement toward the underdog through the week, and how many public
pick'em articles Gemini finds picking the upset, with a short game note.

Picks default to the favourite for the season prize; an optional weekly
leverage mode swaps in near-coin-flip underdogs the pool is likely to
fade. A recommendation that changes before kickoff gets a red dot on the
card and tab and a push alert. The tab also suggests the tiebreaker total
and tracks the record against always picking favourites.

**Details**
- New `server/pickem.js` (tables `pickem_snapshots`, `pickem_recs`; per-user settings in `app_state`), `server/gemini.js`; routes `GET /api/pickem`, `POST /api/pickem/settings`, `POST /api/pickem/seen`; scheduler recomputes recommendations hourly and after each pre-kickoff refresh (push on change).
- `tank01.js` now also keeps each game's sportsbook lines from the odds response it already fetches (`parseGameLines`); `schedule.js` returns per-game ESPN event ids, odds, status and scores.
- Config: `GEMINI_API_KEY`, `GEMINI_MODEL` (compose files and `.env.example`s).

**Known limitations / what was and wasn't tested**
- Gemini wasn't reachable from the build sandbox: the default model id and live response were not verified (the parser accepts fenced or bare JSON; failures are logged and the tab works without it).
- Pool pick % is estimated from the market unless typed in (CBS hides pool picks until lock). Upset-potential weights are a first cut, to be tuned.
- Push on a changed pick uses the existing Web Push setup; the push path itself wasn't exercised in tests (no VAPID keys in the test environment).
- Tested with mocked APIs: no-vig probabilities, source fallbacks, FPI, tiebreaker, Gemini parsing and daily caching, leverage picks, change detection and dismissal, line-movement upset growth; plus all earlier suites (44 server checks) and 41 browser checks including the Pick'em card, colours and red dots.

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
