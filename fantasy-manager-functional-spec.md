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
- **Breadcrumb header** on every screen: `Sleeper username > League Name > Sub-tab name`. Every level but the current one is clickable — this replaced an earlier back-button-only pattern. (v3.5: the Sleeper photo and name at the top left open the user menu — My leagues, League management, Enable alerts, Account settings, Log out.)
- **Player card (v3.5):** tapping a player's photo or name anywhere opens his card (Section 8.2n).
- **Bottom tabs (v3.8):** League Management, Game Day, Pick'em, Analytics and Commish (Section 8.2q).
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
- "Edit tracked leagues" and "Log out" controls live at the top of this screen. (v3.5: moved into the user menu as "League management" and "Log out"; each league shows its picture left of its name.)

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
*(v3.0: Roster and Lineup are one page — see 8.2i. 8.1 and 8.2 describe the two halves.)*

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

### 8.2d Tabs, Game Day and lineup lock-out (v2.6)

**Tabs:** League Management (existing screens), Game Day, Analytics (accuracy dashboard, leans, owner backfill).

**Game Day:** per tracked league this week, the user's starters count for (+importance) and the matchup opponent's starters against. Per player F, A, lean = F/(F+A); one line per player positioned left (for) → middle (balanced) → right (against); bands by an editable ratio (default 2: for if F ≥ 2A, against if A ≥ 2F). Per-league importance + include toggle; optional close-matchup weighting (within close margin % → 1, else max(floor, margin/close-margin); defaults 20%, 0.25) from live points + remaining projections. Shows each league's live score and projected final, each player's game status, live points/projection, and per-league for/against chips. Polls every 60 s; no Tank01 calls.

**Lineup lock-out:** a player whose game has kicked off is excluded from all recommendations; started starters stay locked ("Game has started — locked").

**Header status:** real per-source projection counts and Tank01 data age instead of fixed text.

---

### 8.2e Pick'em (v2.7)

Straight-up pick'em tab. Win probability: Tank01 no-vig moneylines (avg of books) → ESPN moneylines → spread (Normal, σ 13.5) → ESPN FPI; FPI shown as a second opinion. Card: team-coloured win bar, pick, upset-potential bar (dog win chance ≤30 + line move toward dog since first weekly snapshot ≤30 + Gemini upset mentions ≤40), Gemini note. Default pick = favourite; v2.7's optional weekly leverage was replaced in v3.4 by upset picks (section 8.2m). Recommendation changes before kickoff → red dot (card + tab) until tapped, plus push notification if enabled. Tiebreaker = Vegas total of the last game. Record vs always-favourite baseline. Snapshots hourly; Gemini daily; no extra Tank01 calls. Spread mode not built (no line-based pools yet).

---

### 8.2f Matchups, weather, headshots, stat lines (v2.8)
- **Player cards** (Player Rankings; compact on Lineup rows) show:
  - a headshot (Sleeper → ESPN → initials; logo for DEF);
  - the matchup as `[TEAM] @/vs [OPP]`. TEAM is coloured by its offensive rank at the player's position, OPP by its defensive rank against that position. Tapping either opens that team's sample;
  - kickoff time;
  - a weather chip for outdoor games (tap for the hourly pop-up);
  - the projected stat line from the projection's own source (ESPN: rec and pass TD only).
- **Weather** (Open-Meteo, kickoff hour + 3):
  - Flag when wind ≥ 15 mph or gusts ≥ 25, rain likely (≥ 60% and ≥ 0.02"/hr) or heavy (≥ 0.1"/hr), or snow ≥ 0.1". The owner can edit these app-wide.
  - A flagged, not-yet-started starter makes the Lineup tab **minor** and shows the reason.
  - Domes: none. Retractable roofs: forecast plus "roof may be closed", never flagged. Neutral site: none.
- **Matchup difficulty**:
  - Built from Sleeper weekly game stats (team + opponent per row), scored per league scoring profile.
  - Loaded: last season once; this season's finished weeks, with corrections for ~9 days; the current week's finished games hourly.
  - Samples: Blended (last season's games share a combined weight of 3 games, fading to 0 between this season's games 4 and 14), This season, Last 4 games.
  - Optional schedule adjustment: additive, SRS-style, iterated jointly with offense ratings.
  - Ranks 1–32 in 5 colour tiers of ~6–7 teams, from the player's point of view (red → dark green).
- **Analytics → Matchup rankings**: defense-vs-position and offense-by-position tables with the sample and adjust controls (saved per user; they drive the card colours). Tapping a team opens its games, opponents, points, opponent average, adjusted points and weights.

### 8.2g Variance report (v2.8.1)
- **Buttons and scope:**
  - Top of the dashboard: all leagues, all pages.
  - Each league card and the league overview: one league, every page.
  - Each page (Roster, Lineup, Waivers, Trades, Injury): that page.
- **Pop-up:**
  - Grouped league → page → rule broken → items.
  - Collapsible; default collapsed; Expand all / Collapse all.
  - Text coloured by severity; each group rolls up to its worst colour.
- **Rules:**
  - Roster: empty starting slot, starter on bye, starter out/doubtful/IR, questionable starter, flex lock order, open bench slot, IR-eligible on bench.
  - Lineup: starter projected 0, optimal lineup better / lineup differs from your ranking (minor < 5 pts, major ≥ 5), better lineup than your ranking, weather.
  - Waivers: top-ranked and trending (major), top-ranked, trending.
  - Trades: trade opportunity.
  - Injury: new injury status (major), injury status seen before (minor).
- **Clear minor variances:**
  - Acknowledges the visible minor items in the pop-up's scope, per user, server-side.
  - Cleared minors no longer colour rows, page badges or league cards.
  - Any new variance colours them again: a new key, i.e. league + page + rule + subject, and the week for roster/lineup, ignoring numbers. So does a cleared item escalating to major.
  - Majors can't be cleared.
  - Clears for issues that no longer exist are pruned after each build.

### 8.2h v2.9 — public-API release (waiver pages, trades, variance rules, speed)
Everything here uses only public Sleeper data (plus the existing Tank01 / ESPN / FantasyPros / Gemini / Open-Meteo sources). Anything needing a Sleeper login token is v3.0.

- **League card / dashboard:** restructured card layout; IR players no longer trigger "IR-eligible on bench" once on IR (IR flag fix); a cleared variance no longer re-colours the card after a rebuild (cleared-variance bug fix).
- **Speed:** the dashboard paints instantly from the last saved build (`GET /api/leagues/cached`, no Sleeper calls), then rebuilds leagues progressively (2 at a time) and swaps each in as it finishes. A week-keyed client cache avoids rebuilding on tab switches.
- **Game Day:** league filter; games grouped into kickoff time slots; for-league chips left, against-league chips right (interpretation not yet confirmed by James).
- **Pick'em:** weather chip on outdoor games; longer Gemini news notes.
- **Analytics - matchup rankings:** Last 4 and ROS windows, sortable columns, a Blend toggle (replaces the old "last 4 sample" option; saved last-4 settings are read as blended).
- **Analytics - accuracy:** position toggles (QB/RB/WR/TE/K/DEF only; other positions are no longer recorded), info pop-up, sortable table, source x position matrix.
- **Variance report:** opens expanded by default.
- **Variance rules (changed):**
  - Weather variance (V14) is auto-clearing: shown on the first visit to the page, acknowledged once the page has been viewed and left; returns only if it goes away and comes back.
  - Waivers are judged by projection, not ECR/trending: red = a free agent is projected above a current starter at that position (V15); yellow = projected above a bench player at the same position (V16). The trending-add variance is removed (V17).
  - Trades: big-gap opportunities are yellow and auto-clearing; small gaps are listed but not flagged (V18/V19).
  - Lineup: yellow "No projection for player" for starters and bench (N01; bench included for troubleshooting).
  - Acks keep a 12-hour grace before an absent key is pruned, so a brief data hiccup doesn't resurrect cleared items.
- **Waivers - two pages:**
  - *Available:* top 5 projected and top 5 trending per position, grouped by position and sorted by projection. Every player has a bid box (a value including 0 adds the claim to the plan). A $ / % toggle changes how bids are typed; bids are stored in whole dollars.
  - *Claims:* generated claims grouped by bid amount (highest first). Within a group, order follows the dropped player's priority; new claims go to the bottom; a drag handle reorders within a group only. Bids and drops are editable, claims deletable, custom claims addable, "Reset to defaults" clears manual changes. A "claims to enter in Sleeper" checklist lists the claims in order (the app can't push in v2.9).
  - *Budget:* shows current FAAB and the predicted FAAB after your claims, as dollars and percent. The prediction takes claims highest bid first, uses a dropped player once, limits no-drop claims to open bench spots, and respects the remaining budget. It covers YOUR claims only; the equal-bid processing order is an assumption.
  - *Claim generation:* the k-th highest bid gets a "no drop" claim (only if open spots exist) plus the first max(0, k - open spots) willing drops, in drop-priority order.
  - The plan (bids, drop ranking, edits, deletions, custom claims, order, entry mode) is saved per user per league (`/api/waiver-plan`).
  - FAAB bid history for each player and a 3-day drop summary appear on the page.
- **Trades:** Gemini news flag per partner player (cached 3 h); Trade Finder reworked (sell from strength, buy at weakness, never the same position, value gap <= 20, net gain over the replaced starter); trade deadline countdown; players on your roster that opponents own in their other leagues are highlighted. Trade values use ECR when >= 60% of rostered players match, else a projection-rank fallback scaled to position depths.
- **Unverified assumptions:** ROS windows, the trade deadline source, other-league ownership, Game Day for/against orientation, and equal-bid waiver order.

### 8.2i v3.0 — Sleeper private access, merged Roster page, League page
**Release rule:** v3.0 = anything needing Sleeper's private GraphQL API (even read-only) plus write-back. Everything is opt-in; with no token the app is v2.9.

- **Private access (Account → Sleeper access):** the user pastes their Sleeper token; it is verified with a read-only `me` call and stored encrypted (AES-256-GCM, key from `SESSION_SECRET` or a generated secret). The token is never returned to the browser. A separate **Allow changes** switch (default off) gates every write; each write also needs an explicit confirm from the UI, uses the roster id from the server's own build (never the client's), is logged (`private_write_log`), and is verified by reading back where possible.
- **Honesty about the API:** undocumented, may change, Sleeper's terms arguably restrict it. Proven (by the reference project's author): `reject_trade`, `roster_update_starters`, `update_matchup_leg`. Unverified: `roster_update_reserve`, `submit_waiver_claim`, `cancel_waiver_claim`, the pending-claims read (assumes `status:"pending"`; the statuses seen are returned for diagnosis), `league_event_logs` with a token. Sleeper rejecting a token is reported as 409 (not 401) so it never looks like an app logout.
- **Roster & Lineup page (merged):** the roster view on top; below it two tabs.
  - *Proposed changes:* one tick-box row per recommended change: lineup swaps (from the lineup advice) and IR moves (IR-eligible bench players, only while IR slots are open). A swap that needs another swap (the better player currently starts elsewhere) ticks it too, and unticking undoes dependants. Changes that can't be pushed (free agent, or on IR/taxi) are listed with the reason and can't be ticked. Weather warnings show at the top; the full Lineup view and Player Rankings are under "Show lineup details".
  - *Update roster:* summary of the ticked changes and the **Push to Sleeper** button (confirm step, then results per call). The lineup is sent as the full slot-order array ("0" = empty), written to the roster **and** the matchup leg (roster-only writes don't change what scores), then the leg is read back.
- **Variance pages:** Roster and Lineup are one page `roster` (label "Roster & Lineup"), keys `leagueId|W<week>|roster|rule|subject`. Older acknowledgements stored under `lineup` are read as `roster` (migration on read, add and prune). Page badges are five: Roster, Waivers, Trades, Injury, League.
- **Trade offers:** an incoming offer waiting on you is yellow variance N03 and does **not** auto-clear. An outgoing offer of yours that has gone stale is red N02: offseason (Sleeper season type off/pre) older than 7 days; in season, any player in the offer has a game today (US Eastern date) or one already kicked off this week. Reject (proven mutation) is confirm-first and the result must report `rejected`.
- **Waivers:** claims already queued in Sleeper are removed from the proposed list (match = same added player and same dropped player or none), listed under "Already queued" with Cancel, and counted in the FAAB prediction. Push to Sleeper sends ONE test claim first; after a claim has been read back successfully (from the write log) the whole ordered list is sent, stopping at the first claim Sleeper doesn't confirm. The checklist fallback stays. Auto-claiming on a schedule was **not** built; manual push only.
- **League page:** the settings change log (`league_event_logs`): who changed which setting, old → new. Each unseen entry is a minor variance `League|Settings change|log <id>`; the badge is yellow until cleared (per user, same acknowledgement store as variances; clear button on the page). The first view shows the whole fetched history (up to 30 entries) until cleared once.
- **Server data flow:** per-user private data (trade offers, pending claims, change log) is attached to each build response and saved as a per-user snapshot; the instant cached view serves the snapshot with no Sleeper call. A failed private read is reported in `privateInfo` and never fails the build.
- **Line movement (not built):** Pick'em already snapshots the spread/probability hourly (`pickem_snapshots`) and shows line movement per game, so Sleeper's `scores` feed was not added.
- **Unverified:** Sleeper league link in the claims checklist (`https://sleeper.com/leagues/{id}`), IR push, claim push, claim read-back status word, the whole private API against live Sleeper, and visual layout (Tailwind couldn't render in the test harness).

### 8.2j v3.1 — Account toggles, withdraw, waiver lock, rule edits, injury opportunities
- **Account toggles:** four checkboxes under Account → Sleeper access: *Read from Sleeper*, *Roster changes* (lineup + IR moves), *Waiver claims* (submit + cancel), *Trades* (reject + withdraw). Reads default on, writes default off. A v3.0 "Allow changes" record maps to all three write groups on. Each write is guarded by its own group, then confirm, audit log and read-back. With reads off the server makes no private calls and the client hides trade offers, the League log and pending claims (badges show "No data").
- **Trades:** all outgoing offers are shown; only stale ones (N02, red) are variances. Each outgoing offer has **Withdraw** (confirm-first). Mutation is UNVERIFIED: `reject_trade` on your own offer, then proposed trades are read back; success only if the offer is gone.
- **Waiver lock:** a player is unavailable from his own game's kickoff until the week is over (no games left, all `post`, or each started >4.5 h ago). Locked players are hidden from Available, injury adds, proposed claims and the simulation; the drop summary says "Locked until week ends". No schedule data → nobody is locked.
- **Push marks:** a successful push stores marks per user and league. Lineup push: V09/V10 (gaps ≥5) stay quiet while the gap ≤ pushed gap + 1; P05 keys quieted. Waiver push: V16, P03, P04 keys quieted (ignored after 7 days; a new qualifying player flags again).
- **Rule edits:** V05 Questionable starter clears after kickoff and returns after the week's last game if still statused. New red rule: a player in an IR slot who is not IR-eligible, from his game day until his game ends. IR eligibility from league settings (reserve_allow_out/doubtful/sus/na/dnr/cov — names unverified); default Out/IR/PUP only.
- **Injury opportunities:** relevant slots QB1 (QB1–2 superflex), RB1–2, WR1–3, TE1; K/DST injury flag only. Triggers Out/IR/PUP/Sus/Doubtful; Questionable only with a Gemini news downgrade/no practice, trending-down signal or a trending backup (yellow only). Next two backups per injured player; WR/TE injuries add the top available player at the other position (WR↔TE). Depth chart from ESPN (unverified shape; per-team fallback to Sleeper `depth_chart_order`). Injury page: notes only. Waivers: "Injury adds" with available (not locked) players — P02 yellow (clears once viewed), P03 red if on your active roster (clears when dealt with or on waiver push), P04 yellow Questionable. Roster: P05 yellow when you own a backup, plus a replacements note on your injured players.
- **Unverified:** see CHANGELOG v3.1.

### 8.2k v3.2 — CBS pick'em push
- **Own picks:** on each unstarted game on the Pick'em screen the user can tap a team (tap again to return to the recommendation). Stored per user per week (`pickem_choices:{user}:{season}:{week}`) with an optional tiebreaker total. Final pick = own choice else recommendation.
- **CBS account (Account → CBS pick'em push):** email + password encrypted with the same AES-256-GCM key as the Sleeper token; never returned to the browser. Pools are entered as ids (one per line). Switches: Auto-push (off by default), Pause, Notify after every push.
- **Recipe:** CBS's URLs/fields are unknown, so a per-user JSON recipe (login, submit, optional games lookup and read-back, team map) holds them; placeholders `{{email}}`, `{{password}}`, `{{csrf}}`, `{{poolId}}`, `{{season}}`, `{{week}}`, `{{gameId}}`, `{{pick}}`, `{{tiebreaker}}` etc. Only https hosts under cbssports.com (env `CBS_ALLOWED_HOSTS`). Cookie session kept in memory 20 minutes; one re-login on 401/403. See CBS-CAPTURE.md.
- **Timing:** scheduler tick every 5 minutes; for each kickoff slot starting within 60 minutes (and more than 2 minutes away) the slot's games are sent to every enabled pool; up to 3 attempts, 10 minutes apart. Games that have started are never sent. Same picks go to all pools.
- **Safeguards:** opt-in; pause; preview (dry run) sends nothing and masks the password; manual push needs confirm; `cbs_push_log` records every attempt (mode, pool, games, sent, verified, detail); read-back compares the saved picks when configured, otherwise the log says "sent, not verified"; first real run uses only the test pool (first enabled, or `testPoolId`) until a push is read back as matching or the user confirms "I checked it".
- **Notifications:** a push notification after every auto or manual push (success or failure) when the user's alerts are on.
- **Unverified:** every CBS-specific detail; assumed lock = kickoff.

### 8.2l v3.3 — native CBS auto mode, My performance, fewer API calls
- **CBS engine (`server/cbsNative.js`, `server/cbs.js`):** default engine "native". Sign-in is CBS's Next.js server action (POST to cbssports.com/login with a `next-action` id; success = `"isAuth":true`); if the saved id isn't recognised the app reads CBS's JS chunks for `createServerReference("<hex>", …, "login")` candidates, tries up to 3 and saves the working one. Picks site `picks.cbssports.com/graphql` (persisted queries): read `FootballPickemManagerPicksPage`, save `FootballPickemManagerSavePicksMutation`; the save reply echoes every saved pick and is the read-back. Pools are entered as picks-page URLs (poolId + entryId parsed). Only changed picks on unstarted, unlocked games are sent. Cookie names only are ever reported.
- **Auto mode:** one push about 60 minutes before each kickoff slot (unchanged timing). `watchTick` (about every 30 minutes per user while auto is on and games remain) compares CBS to the last snapshot; a difference on an unstarted game or the tiebreaker switches auto OFF (`cbs_alert`, notification). Manual pick in the app with auto on → confirm pop-up → auto off → pick saved. Re-enabling re-baselines. First run still uses one test pool.
- **My performance (Analytics tab, `server/performance.js`, `GET /api/performance`):** snapshots of lineup suggestions and flagged waiver free agents are recorded on each league build when decision-relevant content changes (table `perf_snapshots`). Lineup judged per slot against the standing suggestion at the slot's last unlocked moment: followed or not, points effect, projection-vs-actual gap and whether the app was right. Waivers: a free agent flagged as outprojecting a starter/bench player is judged from the first flagged week to the latest scored week against the player added or kept. Actual points = stat lines scored with the league profile. Totals, cumulative trend lines, weekly report. History starts from the first build including this; report cached 10 minutes.
- **Player cards:** projection source tags use the Analytics colours; the ESPN stat-line note is removed.
- **API-call reductions (central cache in `server/sleeper.js`):** user id 30 days, refreshed at login/reconnect (R14); /state/nfl pulled at server start and Tue/Wed/Thu 05:00 America/Toronto (R15); user leagues 30 days (R16); league settings and league users 7 days (R17/R18); transactions: current round 6 hours, rounds at least 2 behind the current week permanent (R19; one round more cautious than "finished weeks" because late waiver results may still land in the last round); other managers' leagues and rosters weekly (R20); players dictionary daily in season, weekly offseason (R21); matchup-difficulty data loaded Tue/Thu after 05:00 Toronto (R22); Sleeper and ESPN projections cached 6 hours with forced pulls 3 hours and 60 minutes before each kickoff slot (R23); private trade offers and pending claims 6-hour snapshot with the stale flag recomputed per page load, snapshot dropped after any push of yours (R24); league change log weekly (R25); own rosters/matchups 5 minutes, skipped within 15 minutes of a kickoff and for 15 minutes after a push (R1); trending adds 1 hour (R3); Game Day: one shared 45-second Sleeper matchup look per league and the live scoreboard only while a game is on (R5); actuals checked twice daily (R6); FantasyPros cache 60 minutes (R10); the trade-news Gemini check no longer starts when the page opens (cached result only; the button runs it) (R11); background rebuilds skip users inactive 14 days (last login or last app use) (R12) and stop in the offseason after the first warm-up (R13).
- **Build speed:** client image builds natively (`--platform=$BUILDPLATFORM`), per-image GitHub Actions cache, 40-minute timeout, package.json versions fixed at 0.0.0.
- **Unverified:** scripted CBS sign-in (reCAPTCHA), cookie hand-off to the picks host, sign-in id discovery, CBS behaviour on saving a locked game, persisted-hash stability; the performance feature against live data; R19's treatment of the last finished round.

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

This is a **heuristic based on positional depth**, not a dedicated trade-value model — FantasyPros doesn't publish one through this API. **v3.5:** strength is now Roster Audit values (dynasty) or rest-of-season projected points (redraft/keeper), with offers valued by Roster Audit / FantasyCalc — see Section 8.2n. ECR remains the fallback when no values or projections are available.

---

### 8.4a Trade Finder — real 1-for-1 swaps (v2)

**Purpose:** Unlike Trade Radar above (position-level strength/weakness), Trade Finder proposes concrete, named-player swaps.

**Methodology:** For each player in the user's starting lineup, scans every rival roster for same-position players whose FantasyPros ECR is within a **20-rank fairness tolerance** of the user's player (a proxy for "close enough a rival could plausibly accept," not a negotiated trade-value model) and who project **more points** than the player being given up. To bound FantasyPros/ESPN API call volume, only the 3 closest-ECR candidates per position per rival are resolved to full point projections. Results are ranked by projected-points gain to the user's starting lineup, capped at 10 shown.

**Display:** "Give [player] · Get [player] from [rival team]" cards with the projected point gain, shown above the existing Trade Radar section on the same tab. **v3.5:** the fairness check is trade value within 10% (the league's value table) instead of the ECR tolerance, and the two values are shown.

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

### 8.2m v3.4 — Pick'em upset picks and performance, locked players, Roster title

**Upset picks.** The app's picks are favourites except upset picks: the game with the highest upset potential is always an underdog pick (minimum 1); further games are underdog picks only when their upset potential is at or above the threshold (Settings, default 45); at most 4 in all. Games that have started keep the pick stored before kickoff and count toward the 4. An "Upset picks" switch turns this off (all favourites). The pick that counts (yours if chosen, else the app's) gets a coloured box on its side of the win bar and on the label: green = favourite, yellow = underdog.

**Performance (Pick'em → Performance).** Per week and season: Vegas (favourite on the last stored line before kickoff; ESPN's listed odds for weeks with no stored line), the app (stored pre-kickoff pick; otherwise reconstructed from ESPN odds with the same rule, marked "~", excluded by a tick box), you (picks entered in the app; a per-game drop-down loads earlier picks by hand), app upset picks, and on the games you picked: you vs app vs Vegas. Ties excluded. Results are stored per game once final.

**Locked players.** A player whose game has kicked off, while the week isn't over, gets no variance, note or suggested move that only a move could fix (see CHANGELOG v3.4 for the list). Everything reopens after the week's last game.

**Page title.** The merged Roster & Lineup page is titled "Roster".

---

### 8.2n v3.5 — trade values, player card, injury rules, Game Day, header menu

**Trade values.** Each league gets one value table: dynasty (`settings.type` 2) uses Roster Audit (format from the league's QB slots, PPR and TE premium), falling back to FantasyCalc dynasty; redraft and keeper (treated the same) use FantasyCalc redraft values. Tables refresh daily; when a site fails the last good copy is used for up to 7 days and the Trades page says so.

**Offers.** Every incoming and outgoing offer shows "you get X, you give Y" in value and the % change. Incoming offers that lose 10% or more are a yellow variance ("Offer loses trade value"); a gain of 10% or more is shown in green (not a variance). Dynasty offers also show Roster Audit's trade-calculator result (what you get = side A). Redraft values ignore draft picks and say so; dynasty picks are valued by year, round and an early/mid/late slot guessed from the original owner's strength (weakest third = early).

**Strengths and weaknesses.** Per team and position: the sum over the position's starting slots plus each flex it can fill. Dynasty: Roster Audit values. Redraft/keeper: rest-of-season points (Sleeper weekly projections from this week to the last fantasy playoff week, league scoring). Shown as ranks ("2nd of 12"), top/bottom third, at most two each. Trade Finder: give a player at a strong position for a different-position player, within 10% in value, ranked by projected lineup gain.

**Trades page.** Opponent ownership excludes best ball leagues unless ticked and shows each opponent's share of his own leagues (and the average). Deadline = end of the last game of the deadline week. Team names are real roster names. A manual refresh re-reads offers and claims live.

**Player card.** Tapping a player's photo or name opens a pop-up modelled on Sleeper's card. Header: name, position, team, number, bye, age (one decimal), height, weight, experience, injury, and availability in every tracked league. Tabs: SUMMARY (position and overall rank, points per game in the league's scoring, trending adds, this week, last game, 4 weeks of projection vs final, advanced stats, dynasty/trade value with trend, news), GAME LOG (this and last season: fantasy points, snap %, weekly rank, stat columns per position), TEAM (team offence ranks out of 32, depth chart with ages, rookie and injury marks), HISTORY (this league's transactions and drafts, following previous seasons; career by season with half-PPR and PPR ranks). The league on screen (or, on Game Day, the league where you cheer for him) is the context.

**Advanced stats.** Season to date from nflverse (weekly stats, team stats, snap counts, PFR advanced stats, Next Gen Stats). Colouring toggle (remembered per device): Percentile = rank among qualifying players at the position (top third green, middle yellow, bottom red; QB 50+ dropbacks, RB 20+ carries or 10+ targets, WR 10+ targets, TE 8+); Fixed = the 2025 top-third / bottom-third cut-offs. Context metrics are uncoloured. Routes are estimated (offensive snaps × team dropback rate), WR/TE only, labelled "est.".

**Bye weeks** appear on roster ranking and waiver cards and in the card header.

**Injury opportunities.** ESPN's separate WR1/WR2/WR3 slots are kept; the next players are his own slot's backups, then players ranked below him — never a player above him. Only players projected 5+ points before the injury count (that week's projection, else the latest stored one from the previous 3 weeks, else season points per game). Pickups: up to two available same-position players and the best available of the top three at the other of WR/TE, all from his team; other teams' best available players are added only when he is on your active roster and his team can't fill it.

**Game Day.** League cards two wide: "my score (my projection) – their score (their projection)". Title green when the expected final leads by at least 5% of the points both teams still have to score, red when it trails by that much, yellow otherwise; projections red when below the baseline (projected totals at the week's first kickoff); live win % on each card. Players grouped by kickoff slot, then game, then team; slots collapse; finished games sit in a "Complete" section at the top, collapsed.

**Header.** Top left: Sleeper photo and name; tapping opens the menu (My leagues, League management, Enable alerts, Account settings, Log out). League pictures sit left of league names. Icons: League Management = football player outline, Game Day = goal posts. The sync status line is at the bottom of the page.

---

### 8.2o v3.6 — Roster tabs, Pick'em logo cards, page files

**Roster page.** Two tabs. *Current lineup*: starters, bench (open slots included), IR and taxi as rich rows — slot box in Sleeper position colours, photo, name, position, team, bye, injury, matchup chip (offence vs defence colours), kickoff, weather, implied team totals, live/final score, Vegas prop lines, projected stat line, actual stat line once his game starts, usage, and projected points (or live/final points with the projection underneath); rule and injury-opportunity notes on each row. At the bottom, *Suggested changes* with tick boxes and "Accept all": lineup changes (free-agent ones listed but not tickable), flex timing swaps and IR moves. *Proposed lineup*: the lineup with the accepted changes applied (changes highlighted, benched players marked), current vs proposed points, and Push to Sleeper.

**Flex timing swap.** A flex-type starter (FLEX, SFLX, W/R, W/T) whose game kicks off before a starter at his own position in a positional slot is swapped with the latest such starter, so the flex keeps the later game. Never involves a locked player or a slot that a pushable lineup change uses.

**Pick'em card.** Logos at both ends of the win bar; tap to pick (tap again to return to the app's pick). Logo outlines: app pick dashed and semi-transparent, your pick solid; green = favourite, yellow = underdog. Team and home/away above each logo; "Favourite (−x)" / "Underdog (+x)" below. Weather above the bar, game status below the card. After the game, ✓ on the winner and ✕ on the loser. Card border: green/red/grey while the pick that counts leads, trails or is level.

**Code layout.** The client is split into `src/ui/*` and `src/pages/*`; `App.jsx` is the shell.

---

### 8.2p v3.7 — FAAB database, opponent bid report, waiver simulator

**FAAB database.** The app stores every FAAB waiver claim with a bid — won or lost — from the tracked leagues (all weeks) and, with the opponent report on, from the opponents' other leagues of the same type (dynasty vs redraft/keeper; best ball never), current and previous week. Collection runs 2 hours before each tracked league's waivers process (and on demand); the league's own claims are re-read 30 minutes after waivers. The waiver time is derived from the league settings (shown as an estimate) and can be set per league.

**Opponents tab (Waivers).** Switch for the opponent collection; waiver time and next collection; players bid on elsewhere this week by this league's opponents (available here first) with each bid's team, $, % of budget and result; each opponent's habits (claims, won/lost, median / top-quarter / max bid %, aggressiveness vs the database, positions, FAAB left in this league); tap for that manager's actual claims.

**Waiver simulator (Claims page).** Monte Carlo of your claims in processing order against likely rival bids from the database (his own bids in other leagues this week, else his position's winning bids this season), scaled to this league's bidding level and capped by opponents' remaining FAAB. Per claim: win chance, likely top rival bid, teams able to outbid; overall expected wins and spend.

**Claims form.** "Player to add" = searchable top 10 per position by this week's projection, shown "Name (QB - DAL)"; drop = Auto (from the willing-to-drop ranking), None, then the bench lowest projection first.

**League-type waivers.** Dynasty: value, age, rookie flag, "Dynasty stashes". Redraft/keeper: rest-of-season points. Sort toggle.

---

### 8.2q v3.8 — Commish (charters) and best ball

**Commish tab.** A fifth bottom tab (after Analytics) with two sub-tabs, Charters and Best Ball. A red dot on the tab means some charter has an action due within a week.

**Charters.** One charter per league, for any of the user's Sleeper leagues this season (the picker lists commissioner leagues first, marked ★, from Sleeper's `is_owner`). Source: a Google Docs / Drive link shared "Anyone with the link can view" (preferred; read only — the app never writes to the document) or an uploaded PDF, Word (.docx), text or Markdown file up to 10 MB. Gemini reads the charter when it is added and returns a short summary and a checklist of commissioner actions for the next 12 months: title, description, due date, yearly or one-off, and — when the action changes one of a fixed list of Sleeper settings (FAAB budget, adds locked, trade deadline, playoff start, playoff teams, waiver type, daily waivers, keepers, taxi slots, IR slots, draft rounds) — that setting and its new value. Without a Gemini key, charters are stored and actions are entered by hand.

**Actions.** Editable (title, details, due date, every year), addable, deletable and tickable; done ones are listed collapsed. A ticked yearly action creates next year's copy. An open action tied to a setting ticks itself ("seen in the settings log") when the League page's settings change log shows that setting changing — to the stated value, if any — from 60 days before its due date. Re-reading the charter replaces only the open actions that came from it.

**Status.** Red: an open action due within 7 days or overdue. Yellow: due within 30 days. Otherwise no colour. Each charter card shows the next due date with every action due that day, open and overdue counts, proposed rule changes and read problems; cards are sorted by next due date. A tracked league with a charter shows a "Commish" badge on its dashboard card in the same colours, opening the charter.

**Rule changes.** Recorded as proposed, then approved or rejected (undoable), or deleted. With approved changes, Gemini drafts the updated charter in Markdown (affected sections changed in place, a dated "Changes" section at the end); the commissioner edits it, copies it into the document, then accepts it (the changes become "written into the charter") or discards it. Until the document itself changes, a further draft builds on the last accepted text.

**Re-reading and seasons.** "Read again" on demand. Each July every linked charter is downloaded once; Gemini reads it again only if it changed, at most one Gemini read per day across users. Uploaded files are re-read only on demand. When a league renews (the new league's `previous_league_id` is the old one) its charter moves to the new league.

**Best Ball.** A card per best ball league of the user's this season, opening a leaderboard of every team: rank, team name, username, avatar, total, payout for paid places. Default stat: Max points for (Sleeper's season `ppts`); alternatively Points for. Settings per league: combine up to 5 other best ball leagues into one leaderboard; hero multiplier (1–10×) with a hero player chosen per team from his roster; weeks from/to; entry fee and payouts by place as % of the pot (pot = entry fee × teams). With a hero or week rule, totals are recomputed week by week from Sleeper's matchups: the hero's points multiplied, then the best possible lineup for the league's starting slots found exactly, summed over the weeks; the hero bonus shows on the row. Rules can be written in plain words; Gemini turns them into these fields for the commissioner to check and save.

**Evidence export.** A CSV with every team's counted lineup per week (league, week, team, username, slot, player, id, position, points, multiplier, counted, final / current week), then one line per team with the sum of its counted slots, Sleeper's figure and the leaderboard value.

### 8.2r v3.9 — Waiver categories, research notes, quick navigation, Tuesday week

**Available page.** Under the Available tab header: the position filter (All, QB, RB, WR, TE, FLEX) and the $ / % entry switch; then the category tabs Hype Train, Spot Start, ROS, Stashes, Trending, Handcuff. With All, each position shows its first 5 and the players are sorted together by the category's number (not grouped by position); a single position shows 15; FLEX shows 25 across RB, WR and TE. Only players who can be claimed in that league are listed.

**Categories.** Hype Train — players recommended by this week's waiver articles, Reddit posts and X posts (redraft and dynasty), most mentions first. Spot Start — this week's projection (healthy, not on bye). ROS — rest-of-season projected points. Stashes — dynasty / stash recommendations from the research first, then the best dynasty values. Trending — Sleeper's most-added players (24 h). Handcuff — backups of injured starters (the injury-opportunity adds).

**Notes on every card.** If the research mentions a player, his card (in any list) shows the source count and names, spot / rest of season / stash, and the sources' argument in one sentence. If he fills in for an injured starter, the card says for whom. FAAB suggested bids (70% / 95% of winning bids) load automatically and sit on each card; there is no separate FAAB section.

**Research.** One grounded Gemini search (`GEMINI_API_KEY`) over the last 7 days of redraft and dynasty waiver articles, Reddit posts in r/fantasyfootball and r/DynastyFF, and analysts' X posts — posts only, not comments or replies. Cached 12 hours per week (v4.1: a week, on a schedule — see 8.2s), started in the background by a league build (never awaited) or on demand with "Research again".

**Navigation.** The league name and page name in the header are drop-downs (other leagues keep the current page; "League overview"; every page of the league). A tab strip under the League Management header lists Overview, Roster, Waivers, Trades, Injury, League, Outlook, with a dot where a page has open variances.

**Week.** The app moves to the next week on Tuesday at 10:00 (Toronto) instead of waiting for Sleeper, then follows Sleeper again once it moves on; claims and trades are filed under Sleeper's own week.

### 8.2s v4.1 — Claims push, Drops, free-agent search, roster warnings

**Claims push.** Pending claims are read under Sleeper's week, the next week and the app's week (a claim made after Tuesday's week change is filed under the coming week); if the roster-filtered read is empty the league-wide list is filtered to the user's roster. A claim Sleeper returns with a transaction id is "sent"; it is "confirmed" once read back. The first push sends one claim; once a claim is confirmed — by the read-back or by the user tapping "I can see it in Sleeper" — every ticked claim is sent.

**Claims page.** Drops: rostered % (ESPN), projection, injury designation, next matchup with difficulty; least-rostered first by default; the user's dragged order is kept. Proposed claims: tick boxes, Select all, Clear all (also on Drops; two taps). Every player name opens his card.

**Available page.** A search box above the position filters finds any free agent in the league and adds a claim on him. "Available elsewhere" opens the other leagues where he can be claimed, with FAAB left / budget and a bid box (or Add claim) that adds him to that league's Claims page. Warnings: an IR-eligible player not on IR while an IR slot is empty; an ineligible roster (too many players, or a non-IR-eligible player in IR) — claims may fail.

**Beats a starter / bench player.** Next game only: locked players on either side are skipped. A free agent with a designation other than Questionable, or Questionable and projected 0, never counts — for the card note and both variances.

**Pages.** Yellow "Clear variances" left of "Variance report — this page". League tabs look like the dashboard's status boxes. The page name in the header is plain text; the league name keeps its drop-down. An open bench spot links to Waivers.

**Research schedule.** Tuesday and Wednesday ~8:00 and ~16:00 Toronto for the coming week; kept for the week; previously found outlets are named in the next search.

**Deploy.** Optional Dockhand webhook after both images are pushed.

### 8.2t v4.2 — Waivers "All" tab, Analytics → Scouting, stats table

**Stats list.** A spreadsheet-managed list of 75 stats (ID, name, category, type Projection/Stat/Both/Neither, in the drop-downs Yes/No, positions, data from, notes). Downloaded and uploaded from Analytics → Scouting; an upload replaces every column changed; IDs are fixed.

**All tab (Waivers → Available, default).** Every free agent in the league. Search bar on top with a filters-and-sort button: Projection/Stats; Category → Stat (filtered by category, position and type) with ascending/descending; Season; Week / Season (Season, Season average, a week). The chosen value is shown on each card; more load on scroll.

**Scouting (Analytics).** Same pickers, multi-select; position filter; player search with preview and multi-select (Clear inside). Table of the chosen stats for all players (20 + Load more) or the picked ones. Column pop-up: definition, source, Min/Max, sort, sort bands (suggested good/OK/poor per position, editable), Clear. Multi-level sort: bands first in level order, then values in level order. Clear all at the top; last setup kept; named bookmarks.

**Time rules.** Several seasons/weeks combine; Season average divides counting stats by games with snaps; rates stay whole-period values. Stats that exist only today are blank for any past time and not selectable then.

**Stats table.** The server keeps weekly stat and projection lines (Sleeper + nflverse), loaded on first use.

---

### 8.2u v4.3 — Start/sit signals, AI sources, Scouting abbreviations

**Start/sit (Roster page).** Gemini (Google Search grounding) reads this week's start/sit articles, rankings columns and posts for rostered players that haven't started, in batches of 40. For each it reports start and sit vote counts, a summary and sources. The verdict is derived from the counts: start share ≥ 2/3 strong start, ≤ 1/3 strong sit, otherwise mixed; unmentioned players get no icon. Shown under the score on each card: green traffic light, yield sign, STOP sign. Tapping opens the verdict, counts, summary, sources and a note that it reads the coverage and doesn't make the call. A strip at the top of the lineup shows the three icons, when the articles were read, and "Read again". Results are fresh for 12 hours (8-day cache); a failed run backs off one hour. Scheduled forced re-reads: Thu 8:00, Sat 10:00, Sun 9:00 (Toronto), once per slot.

**AI sources (Account).** For hype, start/sit, upsets, trade news and injury news: sources used (counted per run), Added (preferred) and Removed. Added are named in the prompt as starting points; removed are named as "do not use" and filtered from every result at read time (source names, grounding links, and any item whose only sources were removed). Only the owner changes them. Grounding can't be restricted to a list of sites, so added is a hint, not a guarantee.

**Abbreviations.** Scouting headers use the stat's abbreviation; the full name is in the column pop-up and tooltip. The stats spreadsheet has an Abbrev column (blank = full name; a sheet without the column keeps existing ones).

---

### 8.2v v4.4 — Scouting sort and colours, bench options, custom swaps, Auto mode

**Scouting header taps.** A tap sorts. A column that isn't a sort level becomes the BOTTOM level, descending; a column that already is one cycles descending → ascending → off (off removes just that level), also inside a multi-level sort. Press-and-hold (about half a second, touch or mouse), right-click, a ⋮ button shown while the mouse is over the header, or Shift+Enter / the menu key open the column pop-up (definition, source, Min/Max, sort, bands). "Clear this stat" closes the pop-up.

**Conditional formatting.** A button beside Bookmarks and Clear cycles Colours off → Band → Gradient. Band: each cell is tinted by its sort band (Good green, OK yellow, Poor red; unnamed bands by place, flipped when low is better; no bands = no colour). Gradient: red through yellow to green from the worst to the best value of that column over every player matching the filters (lower-is-better stats flip); blanks stay uncoloured. Default Band (the earlier behaviour). Saved with the last setup and bookmarks.

**Bench option on waiver suggestions (Roster → Current lineup).** When a suggested change puts a free agent in a slot, the best bench player eligible for the slot who is not locked and is projected for more points than the player in the slot is offered as a second suggestion for the same slot ("Bench option — X has to be added from Waivers first"). The two are alternatives: ticking one unticks the other.

**Custom swaps (Roster → Proposed lineup).** Tapping a position box (a starting slot, BN or TAXI) opens a list. Starting slot: starters who fit both ways (they trade places) and bench players who fit the slot, best projection first; IR players are listed greyed (needs a roster move first); taxi players are listed greyed ("Taxi players can only be moved to the bench"); locked players are left out. Bench box: the starters this player could replace. Taxi box: only "Move to the bench". Custom changes are applied after the ticked suggestions, go through the same review-and-push step, and are undone with "Undo custom" or when a suggestion is ticked or unticked. A taxi → bench move is pushed as a roster_update_taxi call (unverified).

**Auto mode (Waivers page, per league, every type except best ball).** A check box with a pause-all box. Each roster check (the hourly background refresh): an empty IR spot is filled by an IR-eligible bench player, an empty taxi spot by a bench player the league's taxi rule allows (rookies up to taxi_years, or anyone when taxi_allow_vets; no rule found = nobody is moved), best trade value first. One hour before the league's waivers process (once per waiver run, FAAB leagues only): every empty bench spot gets a $0 claim with no drop — trending free agents first (by trend count), then trade value; QB/RB/WR/TE only, not Out/IR/PUP/Suspended/Doubtful, not started; at most 5 claims; pending claims count as filled spots. Claims go only to the bench. Needs "Roster changes" / "Waiver claims" on; with a switch off the step is skipped and logged. A failed move isn't retried for a day. Every action is logged on the Waivers page and sent as a push notification.

### 8.2w v4.4.1 — Nav-bar layering, free agent / waiver adds from Roster suggestions, API call presets

**Layering.** The top bar is the highest sticky layer (z-30) so its drop-downs always cover page content. The Roster page's Current lineup / Proposed lineup tab bar sticks directly below the top bar: the bar publishes its height as the CSS variable --topbar-h and the tabs use it as their sticky offset.

**Selectable free agent / waiver suggestions (supersedes the "blocked — add him on Waivers first" text of 8.2v).** A suggestion whose better player is not on the roster is an "add" change. Ticking it (directly, by Accept all, or through a cascade) opens a pop-up: Free agent (add now) or On waivers (claim); the FAAB bid (waivers, FAAB leagues only, capped at the remaining budget; priority leagues have none); and the player to drop — required when no bench spot is empty (counting other adds already planned), optional otherwise. Drop candidates are bench, IR and taxi players who are not locked plus the starter being replaced, weakest projection first. Cancelling the pop-up unticks the suggestion. The bench option for the same slot is an alternative to the add. On Proposed lineup the player shows in the slot tagged "added from FA / waivers". Pushing sends the other changes as before and, for each add, POST /api/private/add-move: both "Waiver claims" and "Roster changes" must be on; the server re-checks the add (not already on the roster, the slot still holds the player being replaced, drop on the roster and not locked, roster not full without a drop), submits the claim (no drop = no drop field) and stores a pending lineup move.

**Pending lineup moves (server/pendingMoves.js).** Checked every 5 minutes (a plain free agent add is also checked straight away). For a waiver claim the check starts at the league's estimated waiver time; it gives up 12 hours after the run (free agent: 12 hours after the next waiver run). Each check reads the roster live; once the player is on it the league is rebuilt and the move is made only if: he is on the bench, the slot still holds the player being replaced (or the replaced player was dropped and the slot is empty), neither game has started. The lineup is sent as the full starters array with the player in the slot (same call as a lineup push, read back). A move that cannot be made is removed and a notification says why; the claim itself is left in Sleeper. Waiting moves are listed on Current lineup with Cancel lineup move (the claim stays; cancel it on the Waivers page).

**API call presets (Account, app-wide; only the owner changes it).** A preset is a named bundle of parameters (server/apiPresets.js). Minimal = the v3.3 reductions R1, R3, R5, R6, R10-R25 (8.2l) as they run — they apply under every preset. Medium (default) = Minimal plus freshOnOpen: when the app is opened (or returned to after 5+ minutes away) the build reads own rosters, matchups and trending adds live instead of from the 5-minute / 1-hour caches, so the free-agent pool is re-worked from current rosters; at most once a minute per league. More Medium parameters are expected later.

**Unverified:** that Sleeper accepts a claim on a plain free agent and lands him at once (otherwise he lands at the next waiver run — the move waits for him either way); how Sleeper treats a claim whose drop is also the replaced starter.

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
- **Server-side background (v3.3):** hourly rebuild for each active user's tracked leagues (skips users inactive 14 days; stops in the offseason after the first run); most Sleeper data now comes from the central cache described in 8.2l.
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
- **Trade values (v3.5) come from Roster Audit and FantasyCalc, neither reachable from the build sandbox** — responses are parsed defensively, and if neither answers the Trades page falls back to rest-of-season projections or ECR and says so. Roster Audit's calculator is limited to about 35 calls an hour. Rest-of-season points are Sleeper's weekly projections summed; weeks Sleeper hasn't projected yet are missing from the sum (shown as weeks loaded).
- **Player card data (v3.5):** nflverse publishes weekly stats a day or two after games, so the card's season stats can lag; routes run are estimated (no in-season participation data); ESPN's news feed is unofficial. The fixed colour cut-offs are last season's distribution, not a scouting standard.
- **FantasyPros' free/personal API tier is rate-limited** (~50 requests/day) — mitigated by the SQLite-backed cache, but a real constraint if tracking many leagues with frequent manual refreshes.
- **Sleeper-connection session state is in-memory per server process**; a restart forgets active Sleeper sessions (the client's auto-reconnect, now driven by server-side last-session data, papers over this from the user's side). The SQLite-backed pieces (cache, injury history, last-session record, and now login sessions) do survive restarts.
- **The internal client port changed from 80 to 5000** in this version, to match the externally-published port — a minor operational detail (nginx now listens on 5000 inside the container), not a behavior change, but relevant if you have an existing Caddyfile or firewall rule referencing `client:80` directly.
- **Season Outlook (v2) uses season-to-date scoring averages, not per-player rest-of-season projections**, as each team's simulated mean — a deliberate accuracy/API-cost tradeoff, not an oversight (see Section 8.6).
- **Trade Finder (v2)'s 20-rank ECR "fairness tolerance" is a heuristic**, not a modeled trade-value negotiation — it filters out obviously lopsided offers, it doesn't guarantee a rival would accept what passes the filter.
- **nflverse usage data (v2) is name-matched, not ID-joined**, and its exact CSV column names were not confirmed against a live response while building this — column names are discovered and logged at runtime instead of hardcoded blind.
- **Push alerts (v2) require a secure context (HTTPS or localhost)** — the Push API is browser-enforced this way; this is already satisfied by the documented Caddy reverse-proxy deployment path.
- **Push alerts (v2.1) are per user and need re-enabling once after the v2→v2.1 upgrade** (old subscriptions had no owner and are dropped). Push alerts are Web Push through the PWA, not a native Android app with Firebase Cloud Messaging** — see Section 8b's scoping note. Since v4.0 that Trusted Web Activity path is a ready-made Android app (`android/`, built by GitHub Actions; `ANDROID_APK.md`); push alerts work inside it as the app's own notifications.

---

## 10a. Installability (PWA + Android)

- **Chrome/PWA installable**: real web manifest, generated icon set (192/512/maskable), and a service worker using a stale-while-revalidate strategy for the app shell — `/api/*` is explicitly never cached, since served-stale roster/lineup/injury data would be actively misleading for this kind of app, not just a minor inconvenience.
- **Android**: no native rewrite. The PWA ships as a Trusted Web Activity (a thin wrapper that opens the site full-screen in Chrome's engine). Requires the deployment to sit behind a real HTTPS domain and a Digital Asset Links file (`.well-known/assetlinks.json`) proving the site and the app belong together.
- **Android app project (v4.0).** `android/` holds the TWA project, based on the Android template of Google's Bubblewrap 1.25 with `androidbrowserhelper` 2.6.2: package `ca.hoffmanhouse.fantasymanager`, site from `android/gradle.properties` (`twaHost`, overridable by the repository variable `ANDROID_HOST`), names "Fantasy Manager" / launcher "Fantasy Mgr", Android 7+ (minSdk 24, target 36), portrait, colours #10171A (status bar, navigation bar, splash), notification delegation (web push shows as the app's notifications; Android 13+ permission requested through the app), links to the site open in the app (verified App Link), Custom Tab fallback without a TWA-capable browser. Images: legacy launcher icon from the web icon, adaptive icon (logo in the 66 dp safe zone on #10171A) with an Android 13 themed (monochrome) layer, splash logo, white notification silhouette — generated by `android/tools/make-icons.py`.
- **APK build (v4.0).** `.github/workflows/android-apk.yml` builds a release APK on demand and on pushes that change `android/`. It is signed with the owner's keystore (repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, optional alias/key password), version code = the run number, version name 1.0.<run>. The APK is published as `fantasy-manager.apk` on the "Android app" release (tag `android-latest`) and as a 30-day artifact, and the run summary prints `ANDROID_APP_PACKAGE` / `ANDROID_APP_SHA256`. Without the secrets, a manual run fails with the reason and a push only warns. Pushes that only change Android files no longer rebuild the Docker images.
- **Asset links (v4.0).** The server serves `/.well-known/assetlinks.json` (public, no login, 5-minute cache) from `ANDROID_APP_SHA256` (one or more SHA-256 fingerprints, any common format, incl. keytool's "SHA256: …" line) and `ANDROID_APP_PACKAGE` (default `ca.hoffmanhouse.fantasymanager`); 404 when unset. nginx forwards that path to the server. `/api/health` reports `androidAppLinks`.

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
38. **Tabs (v2.6):** League Management / Game Day / Analytics.
39. **Game Day weighting (v2.6):** ratio-based (lean = F/(F+A)) rather than additive, adjustable band ratio, optional close-matchup weighting, per-league importance (e.g. dues).
40. **Lineup lock-out (v2.6):** kickoff time, not reported points, decides when a player can no longer be recommended.
41. **Pick'em (v2.7):** market-driven straight-up picks; Gemini used only to count public upset picks and summarise news, not to choose picks; weekly-leverage underdogs optional; changes flagged and pushed.
42. **Matchup difficulty (v2.8):** computed in-app from Sleeper game stats rather than bought; blended with last season (≈3 games, fading), optional schedule adjustment, 5 colour tiers.
43. **Matchup display (v2.8):** cards show `[team] @/vs [opp]`, the team coloured by offensive rank and the opponent by defensive rank (kept separate rather than one combined rank), per James.
44. **Weather (v2.8):** Open-Meteo, outdoor only, owner-editable thresholds; a flag is a minor heads-up, not a swap recommendation; retractable roofs never flagged.
45. **Variance report (v2.8.1):** clearing applies to minors only and also clears the colours (badges/cards), not just the report; a variance's identity ignores changing numbers; clears follow the user across devices; a cleared minor that escalates or any new variance restores the colour.
46. **Waiver pages (v2.9):** Available and Claims are separate pages; bids are whole dollars with a display-only $/% toggle; claims grouped by bid, dragged only within a group; prediction models only the user's own claims.
47. **Variance semantics (v2.9):** "seen" = page viewed and then left; auto-clearing minors (weather, big-gap trades) show once; incoming trade offers (v3.0) never auto-clear; waiver flags use projection vs starters/bench; trending variance removed; N01 includes bench players.
48. **Release split (v2.9/v3.0):** v2.9 = public Sleeper API only; v3.0 = anything needing the private token (even read-only) plus write-back.
49. **Speed (v2.9):** cached-first dashboard, progressive 2-at-a-time league builds.
50. **Private API is opt-in (v3.0):** token pasted by the user, encrypted at rest, never sent to the browser; reading and writing are separate switches; every push is confirm-first, logged and read back; honest "not confirmed" when Sleeper's answer doesn't verify.
51. **Roster + Lineup merged (v3.0):** one page with Proposed changes (tick boxes) and Update roster (summary + push) tabs; badge count stays five with League added; old `lineup` acknowledgements migrate to `roster`.
52. **Stale offers (v3.0):** red for your own offers only; offseason >7 days, in season a game today/already played for any involved player; incoming offers are yellow and never auto-clear.
53. **Waiver push (v3.0):** a single test claim first, then the rest once one is read back; queued claims are hidden from proposals; manual push only (no scheduled auto-claim).
54. **League page (v3.0):** settings log entries are minor variances, yellow until cleared per user.
55. **Line movement (v3.0):** not rebuilt — Pick'em's hourly snapshots already track it.
56. **Write toggles (v3.1):** reads plus three write groups (roster = lineup+IR, claims, trades); reads off hides private-only parts.
57. **Outgoing offers (v3.1):** all shown, variance only if stale; Withdraw via `reject_trade` + read-back (unverified).
58. **Waiver lock (v3.1):** unavailable from his kickoff until the week's last game ends; hidden everywhere.
59. **Push marks (v3.1):** lineup push quiets V09/V10/P05 (gap +1 tolerance); waiver push quiets V16/P03/P04.
60. **Injury opportunities (v3.1):** next two backups, WR↔TE opposite add, Questionable only with a signal and only yellow; Injury page notes only.
61. **IR-slot rule (v3.1):** red for a non-IR-eligible player in an IR slot, game day until his game ends; eligibility per league, default Out/IR/PUP.
62. **CBS push (v3.2):** email + password stored encrypted; direct HTTP via a user-supplied recipe; same picks to all pools; per-game lock; auto-push 60 minutes before each slot; notify on every push; opt-in, pause, log, read-back, one test pool on first run, never after kickoff.
63. **Upset picks (v3.4):** app picks = favourites except 1–4 underdog picks by upset potential (always the top one, others at ≥ threshold 45); started games keep stored picks; replaces weekly leverage.
64. **Pick'em performance (v3.4):** you vs app vs Vegas vs results; earlier weeks reconstructed from ESPN odds where no data was stored (marked); your earlier picks loadable by hand.
65. **Locked players (v3.4):** locked = game kicked off and week not over; no variances, notes or suggested moves that need a move to fix; reopens after the last game.
66. **Trade values (v3.5):** dynasty = Roster Audit (FantasyCalc fallback); redraft and keeper are one type and use FantasyCalc redraft values; no Roster Audit credit shown (personal app).
67. **Offer verdict (v3.5):** an incoming offer losing 10%+ of value is a yellow variance; winning by 10%+ is a green note, not a variance.
68. **Team strength (v3.5):** dynasty by Roster Audit values, redraft/keeper by rest-of-season projections (sum of Sleeper weekly projections); trade fairness within 10%.
69. **Opponent ownership (v3.5):** best ball excluded unless switched on; shown as a share of each opponent's leagues.
70. **Trade deadline (v3.5):** the end of the last game of the deadline week; no explanation text.
71. **Player card (v3.5):** Sleeper-style pop-up from any player; advanced stats with a Percentile/Fixed colouring toggle; estimated routes allowed for WR/TE, labelled "est.".
72. **Injury opportunities (v3.5):** only players projected 5+ before the injury (last projection before the status change, league scoring; fallback season PPG); never promote a player ranked above the injured one; pickups 2 same-position + 1 WR/TE from the same team, other teams only for your own active player when the team can't fill it.
73. **Game Day (v3.5):** colour threshold = 5% of both teams' remaining projected points; baseline = projected totals at the week's first kickoff; live win % on each card.
74. **Header (v3.5):** user menu under the Sleeper photo/name holds League management (the old Edit tracked leagues), alerts, account settings and log out.
75. **Images (v3.5):** amd64 only (the server is a Linux Intel PC).
76. **Roster tabs (v3.6):** "Current lineup" (rich rows with notes, suggested-change tick boxes and Accept all at the bottom) and "Proposed lineup" (accepted changes applied, Push to Sleeper) replace Proposed changes / Update roster.
77. **Timing swaps (v3.6):** flex lock-order problems are fixed by a pushable swap with the latest-kickoff starter at the flex player's position.
78. **Roster card content (v3.6):** everything the old cards had plus implied team totals, live/final scores, prop lines and actual stat lines; projected and actual points side by side.
79. **Pick'em card (v3.6):** tap a logo to pick; outlines only (app dashed + semi-transparent, yours solid; green favourite, yellow underdog); card border follows your pick, else the app's.
80. **Page files (v3.6):** App.jsx split into ui/ and pages/ modules, no behaviour change.
81. **FAAB database (v3.7):** own database of won AND lost bids; no outside source (FAAB Lab, FAABFAX, Faabtastic) has a usable API.
82. **Opponent report (v3.7):** opponents' bids in their other leagues of the same type, never best ball; the whole feature can be switched off; collection per league 2 hours before its waivers.
83. **Claims per user (v3.7):** tap a manager to see their actual claims.
84. **Simulator (v3.7):** win % per claim with budget caps and opponents' habits (league bidding level), bids shown as % of budget.
85. **Add / drop lists (v3.7):** add = top 10 per position, contains search, "Name (QB - DAL)", sorted by weekly projection; drop = Auto (default), None, then bench lowest projection first.
86. **League-type waivers (v3.7):** dynasty value/age/stashes vs rest-of-season points.
87. **Waiver time (v3.7):** read from league settings as an estimate, editable per league.
88. **Commish tab (v3.8):** a fifth bottom tab holding Charters and Best Ball.
89. **Charter sources (v3.8):** Google link sharing preferred (read only), upload as the alternative; any of the user's Sleeper leagues, commissioner leagues listed first.
90. **Charter reading (v3.8):** Gemini reads on add; links re-read each July only when changed; actions repeat yearly; charters follow the league into the next season.
91. **Auto-tick (v3.8):** setting-linked actions tick themselves from the League page's settings change log.
92. **Charter status (v3.8):** yellow when an action is due within a month, red within a week; card shows the next date and every action due that day; the same colours on the league's dashboard "Commish" box.
93. **Charter updates (v3.8):** Gemini drafts Markdown from approved rule changes to accept, modify or reject; the user pastes it back into the document.
94. **Best ball leaderboards (v3.8):** Max PF by default with usernames, pot and payouts; optional combined leagues, hero multipliers and week ranges; rules entered in plain words via Gemini; the data behind every total exportable as CSV evidence.
95. **Available categories (v3.9):** Hype Train, Spot Start, ROS, Stashes, Trending, Handcuff; position filter and $/% on top; All = 5 per position sorted together, a position = 15, FLEX = 25.
96. **Waiver research (v3.9):** Gemini synthesises waiver articles, Reddit posts and X posts (not comments), redraft and dynasty; research and injury notes appear on every card a player is on.
97. **FAAB suggestions (v3.9):** on each card, loaded automatically; no separate section.
98. **Navigation (v3.9):** league and page names are drop-downs; team pages as tabs under League Management.
99. **Week change (v3.9):** Tuesday 10:00 Toronto time.
100. **Android app (v4.0):** a dedicated APK as a Trusted Web Activity of the live site (not a WebView or native rewrite), built and signed by GitHub Actions with the owner's own key, side-loaded from a GitHub release; web updates never need a new APK.
101. **Asset links (v4.0):** served by the server from environment variables (set in Portainer), not a committed static file.
102. **Claim pushes (v4.1):** read back under both possible weeks; a claim Sleeper accepted is "sent" even unconfirmed; the user can confirm he sees it in Sleeper to unlock batch pushes.
103. **Drops (v4.1):** least-rostered first by default, the user's own order kept once he rearranges; rostered %, projection, designation and next matchup shown.
104. **Claim selection (v4.1):** tick boxes with Select all; Clear all on claims and on drops.
105. **Free-agent search and Available elsewhere (v4.1):** any free agent can be searched and claimed; a player available in other leagues opens a pop-up with each league's FAAB and a bid box that adds him to that league's claims.
106. **Designation rule (v4.1):** a free agent other than Questionable, or Questionable projected 0, never beats a starter or bench player (note and variances).
107. **Next game only (v4.1):** locked games on either side are not compared.
108. **Roster warnings (v4.1):** IR-eligible player not on IR with an empty IR slot; ineligible roster means claims may fail.
109. **Page chrome (v4.1):** yellow Clear variances button; league tabs styled as status boxes; plain last crumb; open bench spot links to Waivers.
110. **Research schedule (v4.1):** Tuesday and Wednesday ~8:00 and ~16:00 Toronto, remembering previous sources.
111. **Auto-deploy (v4.1):** Dockhand Git stack webhook after both images push, URL and secret from GitHub secrets.
112. **Stats list (v4.2):** managed in James's spreadsheet; re-uploads replace every changed column; IDs fixed; missing rows switched off.
113. **All tab (v4.2):** first and default Available tab; search on top; one sort stat with direction; projection or stat, season, Season / Season average / week.
114. **Category → Stat (v4.2):** the Stat drop-down is filtered by Category, position and the Projection/Stats type.
115. **Current-only stats (v4.2):** blank for past seasons/weeks and not selectable while such a time filter is on.
116. **Scouting (v4.2):** every active player at the chosen positions with his status in the tracked leagues; multi-select pickers; several seasons/weeks combined.
117. **Sorting (v4.2):** levels in the order set; banded columns sort by band first (level order), then by value (level order); suggested bands per position from the card thresholds or thirds.
118. **Saving (v4.2):** last setup kept per user, plus named bookmarks.
119. **Stats table (v4.2):** own SQLite table of weekly stat and projection lines.
120. **Start/sit verdict (v4.3):** derived from vote counts (start share ≥ 2/3 start, ≤ 1/3 sit, else mixed), not from Gemini's label.
121. **Start/sit timing (v4.3):** background on first load, 12 h freshness, Thu/Sat/Sun scheduled re-reads, one-hour back-off after a failure.
122. **AI sources (v4.3):** added = preferred hint; removed = "do not use" plus read-time filtering. Owner edits; everyone can view.
123. **Abbreviations (v4.3):** per-stat Abbrev column in the stats list; full name in pop-up and tooltip.
124. **Header tap (v4.4):** a tap sorts (new column = bottom level descending; existing level cycles desc → asc → off); hold, right-click, ⋮ or Shift+Enter open the pop-up.
125. **Colours (v4.4):** None / Band / Gradient button; gradient scale over all players matching the filters; default Band.
126. **Bench option (v4.4):** offered whenever a suggestion is a waiver add and a bench player beats the starter; alternatives exclude each other.
127. **Custom swaps (v4.4):** position box opens a list sorted by projection; locked players left out; taxi players only to the bench; IR players shown disabled.
128. **Custom changes are cleared (v4.4)** when a suggestion is ticked or unticked, so they never rest on a lineup that changed.
129. **Auto mode scope (v4.4):** every league type except best ball; claims only in FAAB leagues; claims only to the bench; never drops.
130. **Auto mode timing (v4.4):** moves at each hourly roster check; claims one hour before the league's waivers process.
131. **Auto mode safety (v4.4):** own check box per league, pause-all, log and notifications, 5-claim cap, failed moves not retried for a day.
132. **Selectable adds (v4.4.1):** free agent / waiver suggestions can be ticked; a pop-up chooses free agent vs waivers, the bid and the drop; the add is sent as a claim.
133. **Lineup move follows the add (v4.4.1):** stored as a pending move, made only once the player is on the roster and the slot still fits; dropped with a notification otherwise; cancellable.
134. **Preset scope (v4.4.1):** API presets are app-wide, owner-only; Minimal = the v3.3 reductions; Medium (default) = Minimal + live rosters/free agents on every app open (once a minute per league).
135. **Header layering (v4.4.1):** the top bar is above page content; Roster tabs stick just below it.
