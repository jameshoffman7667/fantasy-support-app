# Functional Specification: Multi-League Fantasy Manager

*See CHANGELOG.md (in the app package) for version-by-version
history — this document itself is versioned via git, not a filename suffix.*

*This document describes the app as actually built, not just as
originally planned — it's been updated after every major round of
implementation rather than kept as a historical planning artifact.*

## 1. Overview

A self-hosted companion app for fantasy football managers who run
multiple leagues simultaneously. It ingests league/roster data from
**Sleeper**, weekly player projections built from **Vegas player props** and
**Tank01's projections** (v2.4, optional API key), then **Sleeper's own
projections feed** and **ESPN's fantasy feed** as fallbacks, expert rankings from **FantasyPros**, kickoff times and bye weeks
from **ESPN's schedule feed**, and a cross-platform player-ID crosswalk
from the community **ffb_ids** dataset — then surfaces a single "health
check" view per league so the user can quickly see which leagues need
action before lineup lock.

**Core concept:** Every actionable area of league management (roster
construction, lineup optimality, waiver wire, trades, injuries) is
reduced to a traffic-light status (Green / Yellow / Red) so the user can
triage across many leagues at a glance instead of opening each league
individually.

---

## 2. Architecture

Two containers, deployed together via Docker Compose (and installable
as a single Portainer stack from a GitHub repo):

- **`server`** (Express/Node) — the only place the FantasyPros API key
  lives. Every external call (Sleeper, FantasyPros, ESPN, the ID
  crosswalk) happens here, never from the browser. Holds a local
  **SQLite database** (`better-sqlite3`) for:
  - a generic response cache (shared across all tracked leagues),
  - persistent Injury Watch state (which player+status combinations
    have already been shown),
  - a per-user built-league cache (for instant-ish loads and as a
    fallback if a live rebuild fails),
  - the last-active session (username + tracked leagues + week), used
    by the background scheduler and, as of v1, also read on login to
    restore the same tracked leagues on any device,
  - **login sessions** (v1): opaque session tokens issued at login,
    each with an expiry, checked on every protected API route.
  - An **hourly background refresh** re-builds the last-active user's
    tracked leagues even when nobody has the app open, so data is warm
    rather than cold on next visit.
- **`client`** (React, built to static files, served by nginx) — talks
  only to the `server` container's `/api/*` routes, never to Sleeper/
  FantasyPros/ESPN directly. This also sidesteps any browser CORS
  restrictions those services might impose.

The SQLite file is mounted as a named Docker volume so it survives
redeploys, not just in-container restarts.

---

## 3. Data Sources

| Source | Data Pulled | Notes |
|---|---|---|
| Sleeper API | User's leagues, rosters (incl. IR and taxi squad), league users/team names, league settings, player directory, trending adds, waiver transactions | Public, no auth token — username-based lookup only |
| FantasyPros API | Expert Consensus Rankings (ECR), called once per position (QB/RB/WR/TE) since the endpoint has no "all positions" option | Uses the user's API key, server-side only |
| ESPN scoreboard (unofficial) | Kickoff times per game, which teams are playing (for bye-week detection) | No auth needed; unofficial/undocumented, could change without notice |
| Tank01 NFL API via RapidAPI (v2.4; optional `TANK01_API_KEY`) | **Vegas player props** (per game, `getNFLBettingOdds` with `playerProps=true`) → props-based projections for players with a full prop set; **Tank01 weekly projections** (`getNFLProjections`) for the rest; schedule (`getNFLGamesForWeek`) for gameIDs; player list (`getNFLPlayerList`) for the Sleeper-ID join | Free tier 1,000 calls/month; app budgets ~450–500 via freshness rules (schedule & projections daily, odds daily Wed–Sun per game, player list weekly, plus one pull per game ~60 min before kickoff) with a hard monthly cap (`TANK01_MONTHLY_LIMIT` − `TANK01_RESERVE`). Methodology from project doc `tank01-props-handoff.md` |
| Sleeper projections feed (unofficial; v2.3) | **Third-tier weekly projections** (primary in v2.3) — QB/RB/WR/TE/K/DEF, one request per week (`api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=…`, browser User-Agent, `api.sleeper.app/projections` as backup), cached hourly | No auth. Keyed by Sleeper player_id (no matching). Raw projected stats share Sleeper's scoring-settings keys, so league points = Σ stat × setting (custom scoring exact), plus position reception bonuses and DEF points/yards-allowed tiers when not explicit. Placeholders (≥999) ignored. Data supplied by Rotowire per the feed's `company` field |
| ESPN fantasy player feed (unofficial; v2.2) | **Fallback weekly projections** (sole source in v2.2) — QB/RB/WR/TE/K/D/ST, one request per week (`leaguedefaults/3?view=kona_player_info&scoringPeriodId=N`, `X-Fantasy-Filter` limit 3000), cached hourly | No auth. ESPN's default (PPR) totals, adjusted per league for points per reception, TE premium and points per passing TD. Matched by crosswalk ESPN ID, then name + position, D/ST by team. Replaced the FantasyPros API/scrape tiers, which both stop at ~10 players per position, and an ESPN per-athlete endpoint that returned season stats, not projections |
| ffb_ids crosswalk (community CSV) | Cross-platform player IDs (Sleeper/ESPN/FantasyPros/Yahoo/CBS/NFL.com) | Gives a real ID join for ESPN projections; FantasyPros ECR matching is name-based |
| nflverse public CSV releases (v2) | Snap share (`snapPct`) and weekly usage stats (`targets`, `carries`) for the most recently completed week | Community data, name-matched (not ID-joined); column names discovered/logged defensively at runtime rather than hardcoded, since a live response wasn't confirmed while building this |

**Refresh cadence (as implemented):**
- Client-side automatic refresh every 30 minutes while the app is open in a tab.
- Manual refresh button, available on every screen.
- Server-side hourly background refresh for every active user's tracked leagues (sequentially), independent of whether the app is open anywhere.

---

## 4. Login / Onboarding / Session Persistence

*Per-user login replaced the v1/v2 shared password in v2.1.*

1. **Per-user login**: users log in with their **Sleeper username and a
   password**. Only accounts defined in the app's `users` table can log
   in. Usernames are case-insensitive (stored lowercased). Passwords are
   stored as salted scrypt hashes (min. 8 characters). A correct login
   issues an opaque random session token stored server-side in SQLite
   (tied to the username) and set as an HttpOnly, SameSite=Lax cookie
   (`Secure` when served over HTTPS, detected via `X-Forwarded-Proto`),
   valid 30 days. Every request re-checks the users table, so revoking or
   removing a user ends their access on their very next request. Failed
   logins are throttled per username (10 per 15 minutes; per username
   rather than IP because the proxy chain makes client IPs unreliable).
2. **Roles**: `owner` and `guest`. The first owner is named by the
   `OWNER_USERNAME` env var and is created at startup with
   `OWNER_PASSWORD`, flagged to change it at first login. That env owner
   can't be demoted, revoked or removed from inside the app.
   `OWNER_FORCE_RESET=true` (one restart) resets the owner's password for
   recovery. `APP_PASSWORD` is no longer read.
3. **Owner administration** (Account → Manage users, owner-only): add a
   user (Sleeper username — checked against Sleeper when reachable — role,
   optional temporary password, otherwise one is generated and shown
   once), reset a password (temporary, shown once, forces a change at next
   login, ends that user's sessions), promote/demote owner/guest, revoke
   or restore access (revoking ends sessions and push alerts immediately),
   and remove a user (two-step confirm; deletes their saved state). An
   owner can't modify their own role/access (anti-lockout) but can reset
   their own password.
4. **Changing your own password** (Account): requires the current
   password; signs out the user's other devices. Temporary passwords
   (new users, owner resets) force a password change before anything else
   in the app is reachable (server returns `must_change_password`).
5. Once logged in, the app connects to the **user's own** Sleeper account
   (the login username *is* the Sleeper username — no separate connect
   step, and nobody can view another user's Sleeper leagues through
   their login).
6. App pulls all leagues for that user_id for the current season and
   presents a checklist; the user selects which to track.
7. **Tracked leagues and week persist server-side per user** (`user_state`
   table; carried over from the old single `last_session` record at
   upgrade). Logging in from any device reconnects automatically.
8. **Log out** revokes the session server-side. If the server reports the
   session is gone (logged out elsewhere, access revoked) the app returns
   to the login screen.
9. **Edit tracked leagues** re-pulls the Sleeper league list and lets the
   selection change without logging out.

---

## 5. Navigation Structure

```
Your Leagues (Dashboard)
 └─ League Overview (tap league name)
     ├─ Roster Optimization
     ├─ Lineup Advice
     ├─ Waiver Management
     ├─ Trade Radar (incl. Trade Finder — real 1-for-1 swaps)
     ├─ Injury Watch
     └─ Season Outlook (v2 — playoff/championship odds)
```

Season Outlook is fetched on demand when opened (like the FAAB panel),
not derived from the main league build, so it has no pass/fail status
indicator on the Dashboard or League Overview screens the way the other
five tabs do — it appears there as a separate "Outlook" button/card
instead of a colored status badge.

- Tapping a **league name** → League Overview page.
- Tapping a **status indicator** next to a league → deep-links directly into that sub-tab for that league.
- **Breadcrumb header** on every screen: `Sleeper username > League Name > Sub-tab name`. Every level but the current one is clickable — this replaced an earlier back-button-only pattern.
- **Browser back/forward buttons work** — real `history.pushState`/`popstate` integration, not just an in-app control.
- **Week selector** in the header (available on the dashboard, league overview, and every tab) — changing it rebuilds every tracked league for that week (fresh roster-for-week + projections/ECR for that week).

---

## 6. Main Dashboard

Vertical list, one row per tracked league:

`[League Name]                    [Your team name in that league]`
`                                   ●R  ●L  ●W  ●T  ●I`

- `●R`/`●L`/`●W`/`●T`/`●I` = Roster / Lineup / Waiver / Trade / Injury status.
- Each indicator: 🟢 Green (OK) / 🟡 Yellow (minor variance) / 🔴 Red (major variance) / ⚪ Grey (no data available for that tab).
- **Week and scoring format are intentionally not shown here** (they're on the League Overview screen instead) — the card shows the user's team name in that league in their place, which is more immediately identifying across many tracked leagues than a scoring format string.
- "Edit tracked leagues" and "Log out" controls live at the top of this screen.

---

## 7. League Overview Page

Reached by tapping the league name. Shows:
- League name, current week, scoring type, and lock-time context.
- Any data-quality warnings for that league (e.g., "couldn't match to FantasyPros: X, Y" or "showing cached data, a live refresh just failed").
- One summary card per sub-tab showing its status + a one-line plain-English summary.
- Tapping a card goes to that sub-tab.

---

## 8. Sub-Tabs

### 8.1 Roster Optimization

**Purpose:** Verify the *currently set* starting lineup is structurally sound.

**Displays:** Starting Lineup, Bench, IR, and Taxi Squad as separate sections (IR and Taxi only render if non-empty — unlike Bench, there's no "empty slot" concept exposed for them by Sleeper's API). Every player card shows real kickoff time (or "On bye" / "Kickoff time unavailable"), plus a usage badge (v2 — snap %/targets/carries from nflverse) when that player was matched by name for the prior completed week.

**Major variance (🔴):**
- Empty starting roster slot.
- Starter with any injury designation other than "Questionable."
- Bye-week player in the starting lineup.
- A FLEX or **SFLX** (superflex — relabeled from "SUPERFLEX" for card-width reasons) starter whose game locks *before* a starter in a strict positional slot of the same eligibility. Both players are flagged, with a swap recommendation.

**Minor variance (🟡):**
- Starter with "Questionable" designation.
- IR-eligible player sitting on a bench slot instead of an empty IR slot.
- Empty bench slot.

---

### 8.2 Lineup Advice

**Purpose:** Compare the current starting lineup against a computed optimal lineup.

**Displays:** **Side-by-side current vs. optimal**, per slot — not just a summary total. Current-column and optimal-column are shown together for every slot; when they differ, the current (to-be-dropped) player is highlighted red and the optimal (suggested) player highlighted green, with the point swing shown per slot. Each player card shows a small `VEGAS`/`TANK01`/`SLEEPER`/`ESPN`/`FINAL` tag in the bottom corner indicating which source the projection came from (v2.4 priority: Vegas props → Tank01 → Sleeper → ESPN) or that it's a locked-in actual result.

A player is only ever shown as "changed" if they're genuinely entering or leaving the starting lineup — not merely reassigned between two interchangeable slots of the same eligibility (e.g. two WRs with equal projections swapping WR1/WR2 has zero effect on the total and is not flagged). The optimal *set* of players is computed first; the display then keeps any player who's in both the current and optimal sets in their current slot, and only reassigns slots actually vacated by a real drop.

Once a starter's kickoff time has passed and Sleeper reports a scored result for them, their value locks to that actual score (tagged `FINAL`) and that slot can no longer be recommended away — the optimizer treats it as settled and only continues optimizing the remaining not-yet-played slots.

The optimal lineup is computed by a **greedy slot-filling algorithm** (strict positions filled first from the highest-projected eligible player, then FLEX/SFLX slots from what's left) — a strong heuristic, not a proven globally-optimal solve, and can include waiver-available players, clearly noted as "requires a waiver claim."

**Variance thresholds (total point delta, optimal − current):**
- 🟢 Green: 0 pt delta
- 🟡 Yellow: > 0 and < 5 pt delta
- 🔴 Red: ≥ 5 pt delta

### 8.2a Player Rankings (v2.1)

**Purpose:** let the user override the suggested lineup with their own player order.

A **Player Rankings** button on the Lineup tab opens a card list of every player on the user's roster — starters, bench, IR and taxi (each labelled) — sorted by projected points, highest first. **Free agents** (labelled) appear in a separate section at the bottom; they aren't draggable (they aren't on the roster) and exist to show whether a pickup would beat the lineup.

Each roster card has a drag handle (pointer events, edge auto-scroll while dragging) and an arrow-key alternative (focus the handle, ↑/↓). The order saves automatically per user, per league, and **replaces the suggested lineup**: rank order is priority — strict positional slots fill first from the highest-ranked eligible player, then FLEX / SUPER_FLEX / REC_FLEX / WRRB_FLEX slots. Already-played starters stay locked to their actual score. "Reset to suggested order" deletes the saved ranking. Players added since the order was saved slot in by projection; players no longer on the roster drop out.

**Highlights:** 🟡 yellow on any player involved in an improving swap when a better projected lineup exists than the one the ranking produces (best possible = starters + bench + free agents); 🔴 red on a player projected for **exactly 0** (a missing projection is not 0, and a finished game's actual 0 isn't flagged). Zero-projected starters also set the Lineup status badge to Major.

**IR/taxi behaviour:** the default (suggested) lineup never starts IR/taxi players. If the user ranks one into a starting slot, the ranking is honoured but flagged "needs a roster move before they can start".

---

### 8.2b Projection sources and refresh (v2.4)

**Priority per player:** (1) **Vegas props** — used only when the player has a full prop set for their position (QB: pass yds, pass TDs, INTs, rush yds, anytime TD; RB: rush yds or rush+rec − rec yds, rec yds, receptions, anytime TD; WR/TE: rec yds, receptions, anytime TD; K: kicking points). Lines are taken as the expected stat; anytime-TD odds → implied probability ÷ 1.18 → expected TDs = −ln(1 − p); QB anytime TD = rushing TD; RB/WR/TE TDs split rush/receiving by Tank01's projected split or a position default (RB 80% rush, WR 5%, TE 0%); fumbles 0. (2) **Tank01 projection** for anyone without a full prop set (stat line scored per league; K/DEF preset totals). (3) **Sleeper**. (4) **ESPN**. Every stat line is scored with the league's own scoring settings.

**Refresh:** hourly league rebuilds (1-hour projection caches), plus a pre-kickoff refresh ~60 minutes before each kickoff slot that bypasses the caches (Sleeper, ESPN, Tank01 projections, and props for that slot's games) and rebuilds every user's leagues. Tank01 calls follow the quota rules in Section 3.

---

### 8.2c Lean calibration, accuracy dashboard, history backfill (v2.5)

**Lean calibration:** for each scoring profile (points per reception, TE premium, points per passing TD — computed in the league's own scoring) and each non-Vegas source × position, factor = Σ Vegas ÷ Σ source over player-weeks with both, rolling 4 weeks incl. current; min 8 overlaps (else the source's all-positions factor, else none); clamp 0.8–1.2; DEF never adjusted. Players without Vegas props get their first source × factor (shown on the card as "×f").

**Accuracy dashboard** (Dashboard → Accuracy, all logged-in users, read-only): per source × position: n, bias, average miss, RMSE, SD of error, correlation, within-position rank correlation, % within ±3/±5; average miss by week chart; current lean factors; filters for season, scoring profile, position, week range; "same players only" and "lean-adjusted" toggles. Projections are frozen at each player's kickoff; actuals from Sleeper's weekly stats, scored with the profile's settings; a projected player with no stat line counts as 0; projections under 0.5 pts are excluded.

**Crosswalk:** local SQLite table keyed by Sleeper ID. Tank01's weekly player list is the primary source for Sleeper ↔ Tank01/ESPN links; the ffb_ids CSV is loaded in full weekly (every site's ID column kept in `ext_ids` for future use) and fills gaps; Tank01's other-site IDs are kept too; name matches last. Method recorded; precedence Tank01 > ffb_ids > name.

**Backfill** (owner button): free sources for 2026-to-date and 2025; Tank01 batch 1 (2026-to-date, 2025 wk 18–9), batch 2 (2025 wk 8–1) automatically 40 days later; month-end continuation until the API rejects; per-call progress tracking.

---

### 8.3 Waiver Management

**Purpose:** Surface top available (non-rostered-by-anyone-in-the-league) players, ranked by FantasyPros ECR and Sleeper trending-add status.

**Displays:** Available players with projection (with its source tag), ECR rank, trending status, and a usage badge (v2 — see 8.1) when matched. Filtered against **every roster in the league**, not just the user's own, and against each league's actual starting positions — a league with no K or DEF/DST starting slot never shows kicker/defense waiver candidates, since they'd be irrelevant noise.

**Variance logic** — unchanged from original design:
- 🟢 Green: neither trending nor rank-worthy.
- 🟡 Yellow: exactly one of trending / rank-threshold is true.
- 🔴 Red: both are true.

**Cross-league flag:** if the same player is available in more than one tracked league, that's shown so a hot pickup isn't missed in a league checked less often.

**FAAB Suggestions panel** (new): on-demand bid guidance per available player, computed from recent winning waiver bids **in the user's tracked leagues only** — pulling FAAB data platform-wide across all Sleeper leagues was evaluated and found infeasible (Sleeper's API has no way to browse/search leagues you don't already know the ID of). Shows a 70th- and 95th-percentile suggested bid (as a dollar amount, using that league's own budget), pooled by position when there's a large-enough sample and falling back to the overall tracked-league bid distribution otherwise. Explicitly framed as a directional guide, not a statistical confidence interval, given how small the realistic sample size is.

---

### 8.4 Trade Radar

**Purpose:** Show every team's positional strengths and weaknesses across the league, then suggest mutually beneficial trades between the user and each opposing team.

**Displays:** The user's own strengths/weaknesses first, then every other team in the league, each with its own strengths/weaknesses and — grouped directly underneath — any suggested trades with that specific team. A team with no viable suggestion still shows its strengths/weaknesses, with a plain note that no mutually beneficial swap was found, rather than being omitted.

**Methodology:** "Strength" and "weakness" are computed from **average FantasyPros ECR by position** across each roster (lower average rank = stronger at that position) — a rest-of-season-oriented signal by nature (ECR is a consensus ranking, not a single week's performance), though not literal rest-of-season point totals, which this app doesn't fetch. A suggestion requires a real two-way fit: a position where the user is weak and the other team is strong, paired with a position where the user is strong and that same team is weak — not a one-sided ask.

**Variance logic:**
- 🟢 Green: no suggestions surfaced across any opposing team.
- 🟡/🔴: scaled by the size of the ECR gap at the position being targeted.

This is a **heuristic based on positional depth**, not a dedicated trade-value model — FantasyPros doesn't publish one through this API.

---

### 8.4a Trade Finder — real 1-for-1 swaps (v2)

**Purpose:** Unlike Trade Radar above (position-level strength/weakness), Trade Finder proposes concrete, named-player swaps.

**Methodology:** For each player in the user's starting lineup, scans every rival roster for same-position players whose FantasyPros ECR is within a **20-rank fairness tolerance** of the user's player (a proxy for "close enough a rival could plausibly accept," not a negotiated trade-value model) and who project **more points** than the player being given up. To bound FantasyPros/ESPN API call volume, only the 3 closest-ECR candidates per position per rival are resolved to full point projections. Results are ranked by projected-points gain to the user's starting lineup, capped at 10 shown.

**Display:** "Give [player] · Get [player] from [rival team]" cards with the projected point gain, shown above the existing Trade Radar section on the same tab.

---

### 8.5 Injury Watch

**Purpose:** Track every rostered player's injury/status designation, independent of whether they're currently starting.

**Persistence model (changed from the original "since last check" diff design):** a currently-injured player is shown on **every** refresh, not just the refresh where the status first changed. Severity reflects whether the app has shown that *exact* status for that player before:
- 🟡 Minor: this status has been seen before (still tracked, not new information).
- 🔴 Major: first time this exact status has appeared.
- A player's tracking record clears once they're healthy again, so a *future* re-injury with the same status (e.g., "Questionable" again, weeks later) is correctly treated as new rather than still "seen" from months earlier.

This state lives in the server's SQLite database, not an in-memory diff — it survives restarts.

---

### 8.6 Season Outlook (v2)

**Purpose:** Rest-of-season playoff and championship odds per team, so the user can see where a league actually stands beyond the current week's record.

**Methodology:** A Monte Carlo simulation (3,000 trials per league, computed fresh on demand — not cached, not part of the main league build). Each team's per-game scoring mean is its **season-to-date scoring average** (total points for ÷ games played), not a full per-player rest-of-season projection re-run — deliberately, to avoid resolving FantasyPros/ESPN projections for every player on every roster in the league (a real rate-limit risk) for a number that is fundamentally a rough estimate either way. Each simulated week draws a Gaussian-distributed score per team (mean = that team's average, a fixed coefficient of variation) against the **real remaining Sleeper schedule** for that league, standings are computed from simulated wins, and the top N teams (from `settings.playoff_teams`, default 6) enter a seeded single-elimination bracket with byes (from `settings.playoff_week_start`, default week 15) to determine a simulated champion.

**Display:** Every team's current record, simulated average projected wins, playoff-odds percentage, and championship-odds percentage, sorted by championship odds — with the user's own team visually distinguished.

**Caveat:** `settings.playoff_teams`/`settings.playoff_week_start` field names and the generic bye-seeded bracket logic are built from Sleeper's documented schema, not confirmed against a live response in this environment; sane defaults are used if either field is missing.

---

## 8b. Pre-Kickoff Push Alerts (v2)

**Purpose:** Notify the user, via a real system push notification (not just an in-app banner), ahead of lineup lock when action may be needed.

**Mechanism:** Real Web Push (VAPID keypair, `web-push` npm package server-side; a `push`/`notificationclick` event pair in the existing PWA service worker client-side). The dashboard's "Enable alerts" toggle requests browser notification permission, subscribes via the Push API, and registers the subscription with the server (`push_subscriptions` SQLite table). The existing hourly background scheduler additionally scans every tracked league on each refresh and sends a push to all subscribed devices when either:
- a starter carries an "Out"/"IR"/"PUP" designation within roughly 26 hours of their kickoff, or
- a bench/waiver option projects at least 3 points higher than a starter in the same slot, and that slot hasn't locked yet.

Each alert is deduplicated (won't re-fire for the same player+condition) using the existing generic cache table as dedup storage.

**Scoping note:** this satisfies the underlying need ("get notified about lineup problems without opening the app") via the app's existing installable-PWA path, not a native Android app using Firebase Cloud Messaging. A true native wrapper (packaging, signing, Play Store review) is materially more work and wasn't attempted this round — see `ANDROID_APK.md` for the (separate, already-documented) path to wrapping this PWA as a side-loadable Android APK via Trusted Web Activity, inside which these push alerts continue to work unchanged.

**Caveat:** Sleeper's `injury_status` field is the official injury *report*, not a live gameday-inactive feed — the closest available proxy for "ruled out," not a guarantee.

---

## 9. Refresh Behavior

- **Manual:** refresh button on every screen.
- **Client-side automatic:** every 30 minutes while the app is open in a tab.
- **Server-side background:** hourly, for the last-active user's tracked leagues specifically (not a general multi-user warm cache) — keeps data warm even when the app isn't open anywhere.
- **Week changes** trigger a full rebuild for that week (not just a display filter) — fresh roster-for-week, fresh projections/ECR for that week.
- **Resilience:** if a live rebuild fails for a league, the last successfully cached version is served instead of an error screen, clearly marked as stale.

---

## 10. Known Limitations & Data-Quality Notes

Collected here since they cut across multiple sections:

- **Per-user login (v2.1)** is the baseline protection (see Section 4). Throttling is per username, so someone can briefly lock a *named* account by guessing wrong passwords; it clears itself after 15 minutes. Reverse-proxy `basic_auth` or a VPN remain optional extra layers.
- **Vegas/Tank01 projections (v2.4)** depend on an optional RapidAPI key and the free tier's 1,000 calls/month; response shapes were taken from the handoff and parsed defensively, not verified by a live call while building; props cover mostly fantasy-relevant players, so deeper players use Tank01/Sleeper; the 1.18 anytime-TD vig factor was calibrated against Tank01's own TD projections, so the TD component isn't fully independent of Tank01. **Sleeper projections (v2.3)** come from an unofficial feed — undocumented; the old `/v1/projections` path is reported empty and `api.sleeper.com` reportedly needs a browser User-Agent. Kicker/defense totals may differ slightly where a league scores something the projection doesn't break out. Each build logs how many players got Sleeper, ESPN-fallback, or no projection. **ESPN fallback projections**, from ESPN's unofficial fantasy feed. That `leaguedefaults/3` is PPR comes from third-party testing, and the reception (`53`) and passing-TD (`4`) stat IDs used for the per-league scoring adjustment come from community ESPN stat maps — neither verified directly. Other scoring differences (bonuses, return yards, unusual K/D/ST scoring) use ESPN's defaults, so totals can differ from Sleeper's for heavily customised leagues. A third-party report suggests ESPN QB projections for future weeks are less reliable than current-week. The server logs player counts and a sample player per fetch. **FantasyPros ECR matching** is name-based (team abbreviation for defenses).
- **ESPN's schedule and projections endpoints are unofficial/undocumented** — could change without notice. A real bug was found and partially fixed here: the season-year query parameter was wrong, and even after correcting it, live testing suggested a caching layer may still return a different week than requested. Mitigated with a cache-busting parameter and explicit logged validation, but not fully re-verified — check server logs for a week-mismatch warning if kickoff times still look wrong. Both degrade gracefully (missing kickoff time / no projection, with a warning) rather than breaking the build.
- **The ffb_ids crosswalk's exact column headers were never directly verified** (a research-tool limitation, not a real access restriction) — columns are discovered dynamically at runtime and logged on first load. The presence of a `fantasyprosId` column specifically was confirmed by direct inspection.
- **FAAB suggestions are scoped to tracked leagues only**, not platform-wide, and are statistically a directional guide (percentile of recent winning bids) rather than a true per-player confidence interval, given realistic sample sizes.
- **Trade Radar uses average ECR, not literal rest-of-season point totals**, as its "team strength" signal — a reasonable proxy, but a real distinction if exact ROS point projections are wanted later (would need a separate, currently-unbuilt fetch).
- **FantasyPros' free/personal API tier is rate-limited** (~50 requests/day) — mitigated by the SQLite-backed cache, but a real constraint if tracking many leagues with frequent manual refreshes.
- **Sleeper-connection session state is in-memory per server process**; a restart forgets active Sleeper sessions (the client's auto-reconnect, now driven by server-side last-session data, papers over this from the user's side). The SQLite-backed pieces (cache, injury history, last-session record, and now login sessions) do survive restarts.
- **The internal client port changed from 80 to 5000** in this version, to match the externally-published port — a minor operational detail (nginx now listens on 5000 inside the container), not a behavior change, but relevant if you have an existing Caddyfile or firewall rule referencing `client:80` directly.
- **Season Outlook (v2) uses season-to-date scoring averages, not per-player rest-of-season projections**, as each team's simulated mean — a deliberate accuracy/API-cost tradeoff, not an oversight (see Section 8.6).
- **Trade Finder (v2)'s 20-rank ECR "fairness tolerance" is a heuristic**, not a modeled trade-value negotiation — it filters out obviously lopsided offers, it doesn't guarantee a rival would accept what passes the filter.
- **nflverse usage data (v2) is name-matched, not ID-joined**, and its exact CSV column names were not confirmed against a live response while building this — column names are discovered and logged at runtime instead of hardcoded blind.
- **Push alerts (v2) require a secure context (HTTPS or localhost)** — the Push API is browser-enforced this way; this is already satisfied by the documented Caddy reverse-proxy deployment path.
- **Push alerts (v2.1) are per user and need re-enabling once after the v2→v2.1 upgrade** (old subscriptions had no owner and are dropped). Push alerts are Web Push through the PWA, not a native Android app with Firebase Cloud Messaging** — see Section 8b's scoping note. `ANDROID_APK.md`'s Trusted Web Activity path remains the documented option for an installable Android app; push alerts work inside that wrapper too.

---

## 10a. Installability (PWA + Android)

- **Chrome/PWA installable**: real web manifest, generated icon set (192/512/maskable), and a service worker using a stale-while-revalidate strategy for the app shell — `/api/*` is explicitly never cached, since served-stale roster/lineup/injury data would be actively misleading for this kind of app, not just a minor inconvenience.
- **Android**: no native rewrite. `ANDROID_APK.md` documents packaging the PWA as a Trusted Web Activity (a thin wrapper that opens the site full-screen) via either PWABuilder (web-based, no local tooling) or Google's Bubblewrap CLI (scriptable/repeatable). Requires the deployment to sit behind a real HTTPS domain, and a Digital Asset Links file (`.well-known/assetlinks.json`) proving domain ownership — a placeholder for that file's location already exists in the client's static assets.

---

## 11. Confirmed Decisions Log

1. **Flex/superflex lock-order rule:** flag both the early-locking starter and the later-kicking positional-slot starter, with a swap recommendation.
2. **Waiver variance rule:** trending-or-rank-worthy = Yellow, both = Red.
3. **Bye-week starters:** Major variance.
4. **Refresh:** manual + 30-min client auto-refresh + hourly server background refresh.
5. **Cross-league comparison:** in scope for Waiver Management's availability flag.
6. **Auth:** Sleeper username-based linking (no OAuth, since Sleeper doesn't offer one), layered behind a real app-level login — a shared password in v1/v2, **per-user Sleeper-username + password login with owner/guest roles from v2.1** (see Section 4).
7. **Additional tabs:** Trade Radar and Injury Watch are core, not optional.
8. **Deployment:** two-container Docker Compose stack, installable via Portainer from a GitHub repo, with a local SQLite database (not an external DB service) for persistence.
9. **Demo/mock data mode:** removed entirely — the app is real-data-only.
10. **Navigation:** breadcrumb header + real browser history, replacing an earlier back-button-only design.
11. **Injury Watch persistence:** changed from a "since last refresh" diff to a persistent "seen before vs. new" model, stored in SQLite.
12. **Lineup Advice presentation:** changed from a flat optimal-lineup list to a side-by-side current-vs-optimal comparison with per-slot deltas, later refined so only genuine adds/drops are flagged (not interchangeable same-position reshuffles).
13. **Projection sourcing:** *(superseded by 30)* FantasyPros first, ESPN as an explicit, visibly-tagged fallback, actual results as a third and final override once a player has played — never silently blended.
14. **FAAB suggestions:** built against tracked leagues only after confirming platform-wide Sleeper data isn't accessible via the public API; framed statistically as a directional guide, not a confidence interval.
15. **FantasyPros projections specifically:** *(superseded by 30)* scraped from the public website (robots.txt-compliant) rather than pulled from the API, after confirming the API's free tier truncates that endpoint to ~10 players/position — and, this round, expanded to include K/DST, which had been missing entirely.
16. **Trade Radar scope:** rebuilt to cover every team in the league (not just the user's), grouping suggestions by opponent, after confirming the original single-suggestion design didn't match the intended methodology.
17. **Installability:** PWA support (manifest + service worker) added, plus a documented path to a side-loadable Android APK via Trusted Web Activity — no native app codebase introduced.
18. **App-level login (v1):** a single shared password, opaque server-side session tokens in SQLite (not signed/JWT cookies), chosen specifically so logout can revoke a session server-side rather than merely forgetting it client-side. Timing-safe password comparison via fixed-length SHA-256 digests rather than comparing raw strings or padded buffers.
19. **Cross-device persistence (v1):** the previous per-browser `localStorage` record (username + tracked leagues) was replaced with a server-side `last_session` record tied to login, so it now follows the person across devices instead of the browser.
20. **Internal client port (v1):** changed from 80 to 5000 to match the externally-published port, for consistency rather than any functional need.
21. **Season Outlook methodology (v2):** season-to-date scoring average as each team's simulated per-game mean, chosen specifically to avoid re-resolving FantasyPros/ESPN projections for every player on every roster (a real free-tier rate-limit risk) for a number that is a rough estimate either way.
22. **Trade Finder scope (v2):** built as a genuine addition alongside Trade Radar rather than a replacement for it, since they answer different questions (named-player swap opportunities vs. team-level positional strength/weakness).
23. **Usage-data source (v2):** nflverse's free public CSV releases chosen over a paid usage-stats API, matched by normalized player name (no confirmed shared ID with Sleeper/FantasyPros for this specific data source).
24. **"Android APK with push notifications" idea (v2):** implemented as real Web Push through the existing installable PWA rather than a native Android app with Firebase Cloud Messaging — a deliberate scope reduction given the added complexity (packaging, code signing, Play Store review) of a true native wrapper, documented explicitly rather than silently substituted. The previously-documented Trusted Web Activity path (`ANDROID_APK.md`) for wrapping this PWA as an Android APK is unaffected and compatible with these push alerts.
25. **Pre-kickoff alert triggers (v2):** an injury-status change to Out/IR/PUP within ~26 hours of kickoff, or a bench option projecting 3+ points above a starter in the same slot — chosen as concrete, checkable conditions rather than a vaguer "something changed" alert, using Sleeper's official injury-report field as the closest available proxy for "ruled out" (not a live gameday-inactive feed).
26. **Per-user login (v2.1):** owner defined by `OWNER_USERNAME`; owner manages users in-app; revocation immediate; own-password changes require the current password; `APP_PASSWORD` retired.
27. **Player Rankings (v2.1):** user's drag order overrides the suggested lineup; free agents shown but not rankable; IR/taxi honoured-but-flagged in a custom ranking.
28. **SQLite journal mode (v2.1):** try WAL, then WAL with exclusive locking, then DELETE journal, so volumes that can't do WAL shared memory (`SQLITE_IOERR_SHMSIZE`) no longer crash the server; `DB_JOURNAL_MODE` overrides.
29. **Superflex slot fix (v2.1):** `SUPER_FLEX` (Sleeper) slots are now recognised as flex-eligible incl. QB; previously they could be left unfilled by the optimizer.
30. **ESPN-only projections (v2.2):** all projections from ESPN's weekly fantasy feed, adjusted to each league's reception/TE-premium/passing-TD scoring; FantasyPros projections (API and scrape) removed after both proved capped at ~10 players per position. FantasyPros kept for ECR. Actual scores still override once a player has played.
31. **Sleeper-first projections (v2.3):** Sleeper's own weekly projections (keyed by Sleeper player ID, scored with each league's exact settings) are the primary source after v2.2's ESPN-only build still left players blank; ESPN kept as fallback. Paid APIs considered and not adopted: GridIron Data, Fantasy Nerds, Tank01 (noted as best paid backup), Fantasy Football Analytics.
32. **Vegas prop-based projections (v2.4):** props-implied stat lines (Tank01 handoff methodology) are the first projection source for players with a full prop set, Tank01's projection for others, then Sleeper and ESPN. Tank01 calls are budgeted under the free tier.
33. **Refresh timing (v2.4):** hourly rebuilds plus a forced projection pull ~60 minutes before each kickoff slot (James first asked for daily + 90 min, then chose hourly + 60 min).
34. **Lean calibration (v2.5):** multiplicative, ratio of sums, 4-week rolling, per scoring profile (league scoring), min 8 / pooled fallback, 0.8–1.2 clamp — chosen over a flat point offset because a source's lean scales with volume.
35. **Accuracy tracking (v2.5):** all sources recorded every week (not just the one shown), frozen at kickoff, compared with Sleeper actual stats; dashboard visible to all users.
36. **Own crosswalk table (v2.5):** kept (rather than relying on Tank01 alone) as the cache of all matches; Tank01's player list is the primary link source; the full ffb_ids table (all sites' IDs) is still loaded for future use and as a fallback.
37. **History backfill (v2.5):** 2026-to-date + 2025 wk 9–18 first, 2025 wk 1–8 forty days later, month-end continuation until rejected (James is on the free Tank01 plan, no card).
