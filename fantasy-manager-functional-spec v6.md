# Functional Specification: Multi-League Fantasy Manager

*This document describes the app as actually built, not just as
originally planned — it's been updated after every major round of
implementation rather than kept as a historical planning artifact.*

## 1. Overview

A self-hosted companion app for fantasy football managers who run
multiple leagues simultaneously. It ingests league/roster data from
**Sleeper**, player projections and rankings from **FantasyPros**, a
fallback projection source from **ESPN**, kickoff times and bye weeks
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
    by the background scheduler.
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
| FantasyPros website (scraped) | Weekly player projections | The API's `/projections` endpoint caps at ~10 players/position on the free tier; scraping the public projections pages instead gets the full list. Robots.txt-compliant (5s crawl delay, honest User-Agent, hourly cache) |
| ESPN scoreboard (unofficial) | Kickoff times per game, which teams are playing (for bye-week detection) | No auth needed; unofficial/undocumented, could change without notice |
| ESPN per-athlete projections (unofficial) | Fallback projection source when FantasyPros has nothing for a player | Used only as a gap-fill, not a primary source |
| ffb_ids crosswalk (community CSV) | Cross-platform player IDs (Sleeper/ESPN/FantasyPros/Yahoo/CBS/NFL.com) | Gives a real ID join for ESPN lookups; FantasyPros matching is still name-based since no confirmed ID field exists in its responses to join against |

**Refresh cadence (as implemented):**
- Client-side automatic refresh every 30 minutes while the app is open in a tab.
- Manual refresh button, available on every screen.
- Server-side hourly background refresh for the last-active user's tracked leagues, independent of whether the app is open anywhere.

---

## 4. Onboarding / Session Persistence

1. User connects via Sleeper username (no OAuth exists for Sleeper —
   this is a public username→user_id lookup, not a credentialed login).
2. App pulls all leagues associated with that user_id for the current
   season and presents a checklist.
3. User selects which leagues to track.
4. **Username and tracked-league selection persist in the browser**
   (`localStorage`) — reopening the app automatically reconnects without
   re-entering anything.
5. **Log out** (dashboard) clears the saved state and returns to the
   connect screen.
6. **Edit tracked leagues** (dashboard) re-pulls the current Sleeper
   league list and lets the selection change without logging out —
   also transparently recovers if the server's in-memory session was
   lost to a restart.

---

## 5. Navigation Structure

```
Your Leagues (Dashboard)
 └─ League Overview (tap league name)
     ├─ Roster Optimization
     ├─ Lineup Advice
     ├─ Waiver Management
     ├─ Trade Radar
     └─ Injury Watch
```

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

**Displays:** Starting Lineup, Bench, IR, and Taxi Squad as separate sections (IR and Taxi only render if non-empty — unlike Bench, there's no "empty slot" concept exposed for them by Sleeper's API). Every player card shows real kickoff time (or "On bye" / "Kickoff time unavailable").

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

**Displays:** **Side-by-side current vs. optimal**, per slot — not just a summary total. Current-column and optimal-column are shown together for every slot; when they differ, the current (to-be-dropped) player is highlighted red and the optimal (suggested) player highlighted green, with the point swing shown per slot. Each player card shows a small `FP`/`E`/`FINAL` tag in the bottom corner indicating whether its value came from FantasyPros, the ESPN fallback, or a locked-in actual result.

A player is only ever shown as "changed" if they're genuinely entering or leaving the starting lineup — not merely reassigned between two interchangeable slots of the same eligibility (e.g. two WRs with equal projections swapping WR1/WR2 has zero effect on the total and is not flagged). The optimal *set* of players is computed first; the display then keeps any player who's in both the current and optimal sets in their current slot, and only reassigns slots actually vacated by a real drop.

Once a starter's kickoff time has passed and Sleeper reports a scored result for them, their value locks to that actual score (tagged `FINAL`) and that slot can no longer be recommended away — the optimizer treats it as settled and only continues optimizing the remaining not-yet-played slots.

The optimal lineup is computed by a **greedy slot-filling algorithm** (strict positions filled first from the highest-projected eligible player, then FLEX/SFLX slots from what's left) — a strong heuristic, not a proven globally-optimal solve, and can include waiver-available players, clearly noted as "requires a waiver claim."

**Variance thresholds (total point delta, optimal − current):**
- 🟢 Green: 0 pt delta
- 🟡 Yellow: > 0 and < 5 pt delta
- 🔴 Red: ≥ 5 pt delta

---

### 8.3 Waiver Management

**Purpose:** Surface top available (non-rostered-by-anyone-in-the-league) players, ranked by FantasyPros ECR and Sleeper trending-add status.

**Displays:** Available players with projection (with `FP`/`E` source tag), ECR rank, and trending status. Filtered against **every roster in the league**, not just the user's own, and against each league's actual starting positions — a league with no K or DEF/DST starting slot never shows kicker/defense waiver candidates, since they'd be irrelevant noise.

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

### 8.5 Injury Watch

**Purpose:** Track every rostered player's injury/status designation, independent of whether they're currently starting.

**Persistence model (changed from the original "since last check" diff design):** a currently-injured player is shown on **every** refresh, not just the refresh where the status first changed. Severity reflects whether the app has shown that *exact* status for that player before:
- 🟡 Minor: this status has been seen before (still tracked, not new information).
- 🔴 Major: first time this exact status has appeared.
- A player's tracking record clears once they're healthy again, so a *future* re-injury with the same status (e.g., "Questionable" again, weeks later) is correctly treated as new rather than still "seen" from months earlier.

This state lives in the server's SQLite database, not an in-memory diff — it survives restarts.

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

- **No login/auth screen on the app itself.** Anyone who can reach the deployed instance can connect any Sleeper username and consume the FantasyPros API quota. Acceptable for "runs on my home server for me"; something to add (reverse-proxy auth, a VPN like Tailscale) before exposing this more broadly.
- **FantasyPros matching is name-based first**, with a best-effort ID-join attempted via the ffb_ids crosswalk's confirmed `fantasyprosId` column — but only works if the scraped page's markup actually carries a matching ID, which wasn't confirmed while building this. Name matching (with a team-abbreviation fallback for defenses specifically) covers the rest. A rare name collision, a very recent trade, or a scrape-parsing edge case can still miss a match; when that happens the UI shows an explicit warning rather than a silently wrong number.
- **K and DST were previously missing from projections entirely** (not fetched at all, regardless of matching quality) — fixed; both positions are now fetched, with a Sleeper `DEF` → FantasyPros `DST` position-name translation since the two platforms spell defenses differently.
- **ESPN's schedule and projections endpoints are unofficial/undocumented** — could change without notice. A real bug was found and partially fixed here: the season-year query parameter was wrong, and even after correcting it, live testing suggested a caching layer may still return a different week than requested. Mitigated with a cache-busting parameter and explicit logged validation, but not fully re-verified — check server logs for a week-mismatch warning if kickoff times still look wrong. Both endpoints degrade gracefully (missing kickoff time / no fallback projection) rather than breaking the build.
- **The ffb_ids crosswalk's exact column headers were never directly verified** (a research-tool limitation, not a real access restriction) — columns are discovered dynamically at runtime and logged on first load. The presence of a `fantasyprosId` column specifically was confirmed by direct inspection.
- **FAAB suggestions are scoped to tracked leagues only**, not platform-wide, and are statistically a directional guide (percentile of recent winning bids) rather than a true per-player confidence interval, given realistic sample sizes.
- **Trade Radar uses average ECR, not literal rest-of-season point totals**, as its "team strength" signal — a reasonable proxy, but a real distinction if exact ROS point projections are wanted later (would need a separate, currently-unbuilt fetch).
- **FantasyPros' free/personal API tier is rate-limited** (~50 requests/day) — mitigated by the SQLite-backed cache, but a real constraint if tracking many leagues with frequent manual refreshes.
- **Session state is in-memory per server process**; a restart forgets active sessions (the client's auto-reconnect papers over this from the user's side). The SQLite-backed pieces (cache, injury history, last-session record for the scheduler) do survive restarts.

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
6. **Auth:** Sleeper username-based linking, no OAuth, no app-level login (see Known Limitations).
7. **Additional tabs:** Trade Radar and Injury Watch are core, not optional.
8. **Deployment:** two-container Docker Compose stack, installable via Portainer from a GitHub repo, with a local SQLite database (not an external DB service) for persistence.
9. **Demo/mock data mode:** removed entirely — the app is real-data-only.
10. **Navigation:** breadcrumb header + real browser history, replacing an earlier back-button-only design.
11. **Injury Watch persistence:** changed from a "since last refresh" diff to a persistent "seen before vs. new" model, stored in SQLite.
12. **Lineup Advice presentation:** changed from a flat optimal-lineup list to a side-by-side current-vs-optimal comparison with per-slot deltas, later refined so only genuine adds/drops are flagged (not interchangeable same-position reshuffles).
13. **Projection sourcing:** FantasyPros first, ESPN as an explicit, visibly-tagged fallback, actual results as a third and final override once a player has played — never silently blended.
14. **FAAB suggestions:** built against tracked leagues only after confirming platform-wide Sleeper data isn't accessible via the public API; framed statistically as a directional guide, not a confidence interval.
15. **FantasyPros projections specifically:** scraped from the public website (robots.txt-compliant) rather than pulled from the API, after confirming the API's free tier truncates that endpoint to ~10 players/position — and, this round, expanded to include K/DST, which had been missing entirely.
16. **Trade Radar scope:** rebuilt to cover every team in the league (not just the user's), grouping suggestions by opponent, after confirming the original single-suggestion design didn't match the intended methodology.
17. **Installability:** PWA support (manifest + service worker) added, plus a documented path to a side-loadable Android APK via Trusted Web Activity — no native app codebase introduced.
