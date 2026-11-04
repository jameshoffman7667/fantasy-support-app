# Pending changes log

Requests are logged here and built only when James sends a build message ("build it", "build P-3", "build everything pending"). IDs are never reused. Statuses: Pending, Blocked, Built (with version), Dropped.

## Pending

### P-4 - BUG: player card dynasty value trend is wrong
Requested: 2026-10-22 (James, screenshot)
Type: patch (bug)        Status: Pending
Notes / questions: Chris Godwin shows value 277 but a trend of down 1,729 (7 days) and down 5,253 (30 days), which is impossible for a 277 value. Code path: server/values.js `parseRaValues` (trend_7d / trend_30d), server/playerCard.js `valuePanel`, client/src/ui/playerCard.jsx (~line 383). Suspect a different unit or scale; cause not confirmed, needs a raw Roster Audit sample for Godwin.

### P-5 - Designed desktop layout (spec audit, 2026-10-22)
Requested: 2026-10-22 (spec audit)
Type: major (James decides)        Status: Blocked
Notes / questions: The app is one `max-w-lg` phone column on every screen size. The spec wants a designed desktop layout (sidebar navigation, multi-column and table views, side-by-side panes, keyboard shortcuts, visible focus). Needs design decisions: sidebar contents, which pages go multi-column first, whether the bottom tabs stay on tablets.

### P-6 - Light and dark mode (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Blocked
Notes / questions: The app is dark only; colours are constants in client/src/ui/theme.js. The spec wants `prefers-color-scheme` with a matching `theme-color`. Question: should light mode be offered at all, or is dark-only accepted?

### P-7 - Security baseline for an app reachable from outside (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor to major (several parts)        Status: Blocked
Notes / questions: The app holds Sleeper tokens and CBS credentials and is reachable through Cloudflare. Today: username + password, per-user sessions, login throttling. Missing against the spec baseline: mandatory TOTP, hashed server-side sessions with an idle timeout (check), CSRF header plus Origin check on writes, password re-entry before sensitive actions, strict CSP (blocked: the UI uses inline styles heavily), Cloudflare Access JWT check, an audit log. Needs James to pick which parts matter.

### P-8 - Split the JavaScript bundle (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Pending
Notes / questions: One JS file over 500 kB (vite warns). Lazy-load heavy pages (Analytics, Commish, Scouting, Game Day).

### P-9 - Data migration safeguards (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Pending
Notes / questions: Migrations are ad hoc (`ALTER TABLE` guards in projectionStore.js and statConfig.js). The spec wants a `schema_version` table, forward-only idempotent migrations in a transaction and a timestamped database copy before a data-changing migration.

### P-10 - Lighthouse PWA audit and signed-in layout checks (spec audit)
Requested: 2026-10-22 (spec audit)
Type: patch (checks)        Status: Pending
Notes / questions: Lighthouse was not run, and only the sign-in screen was checked at phone, tablet and desktop widths because the authoring session has no mock data for the signed-in pages. Run both from a session that has the app's fixtures or a live login.

### P-11 - More "Medium" API preset parameters
Requested: 2026-10-08 (James, "coming later")
Type: patch        Status: Blocked
Notes / questions: James will send more parameters for the Medium preset (server/apiPresets.js `PRESETS.medium`).

### P-12 - Fixed non-root user for the server image (spec audit)
Requested: 2026-10-23 (James, from the deploy review)
Type: patch        Status: Built 4.14.0 (option A: documented only; option B still deferred)
Notes / questions: Today `server/entrypoint.sh` starts as root (under `tini`), runs `chown -R app:app /app/data`, then `su-exec app` runs `node server.js` as uid 100 (confirmed on the server; data on the server is owned 100:101). The spec asks for a fixed non-root `USER 1000:100` with no root step in the entrypoint.
- Option A (chosen for now): keep the pattern and document it in `deploy/RELEASE.md` and the functional spec.
- Option B (only when other changes need it): switch to `USER 1000:100`. Needs the server's data folder re-owned to 1000:100 once, a root step for James, before the first start of that release, plus a data copy first.
(An earlier note here said the image has no `USER` and runs as root; that was wrong: only the entrypoint's first step runs as root.)

### P-20 - BUG: injury statuses lag Sleeper (Carnell Tate shows Questionable, Sleeper says Out)
Requested: 2026-10-31 (James)
Type: patch (bug)        Status: Pending (not built; waiting for a build message)
Notes / questions: Cause (read from the code, not reproduced live): `getPlayers()` in server/sleeper.js caches Sleeper's whole /players/nfl list, where `injury_status` lives, for 24 h in season (`TTL.playersInSeason`), and every status in the app (buildLeague.js mapPlayerStatus, playerCard, drops, injuryOpps, alerts) reads that copy. Proposed fix: in season reuse it 30 min on Thu / Sat / Sun / Mon and 2 h other days, and have the refresh button force a re-read (at most once per 10 min, the list is about 10 MB). Open: Sleeper may itself be slow to move a status, and Tank01's injury list could be a second source; not checked.

### P-21 - Drop options on roster updates: whole team, sorted by value
Requested: 2026-10-31 (James)
Type: minor        Status: Pending (not built; waiting for a build message)
Notes / questions: When a roster update (free agent / waiver add) needs a drop, the drop choices should list the whole team, not only part of it, in reverse order (lowest first) of weekly projected points for redraft leagues and of dynasty value for dynasty leagues. Today the drop dropdown lists the lowest-rostered bench players first (v4.10). My reading, not confirmed: "whole team" includes starters, bench, IR and taxi; "reverse order" = lowest first; keeper leagues count as redraft (decision: keeper and redraft are one type); players with no projection or value go last. Open: should the default pick stay the lowest-rostered bench player, or become the first row of the new order?

### P-22 - Roster fixes: refresh the Current roster 3 s after a confirmed push, recalculate suggestions
Requested: 2026-11-04 (James)
Type: patch (bug)        Status: Pending (not built; waiting for a build message)
Notes / questions: After a roster fix is "confirmed and read back", the Current roster screen should update about 3 seconds later, with the suggested roster moves recalculated from the new roster. Worst on the roster eligibility card at the top of the page. Seen: after pushing the IR move from the bottom of the page a starting RB slot was left empty; a variance for the empty spot appeared but no moves to fill it were recalculated, and eligibility still showed the roster one spot over the limit with a drop suggested. Two guesses, not confirmed: (1) the card was a stale result from before the IR move because the rebuild ran before Sleeper's public roster caught up (sleeper.js reads rosters with a 5 min cache; v4.5.1 has a 5 min "lineup written" overlay for starters only); (2) the over-limit count may include the empty-slot's bench effect. Needs a look at how the roster-limit count treats IR players and empty starter slots. Code to read: RosterPage.jsx PushPanel (onRefresh after push), runComplianceSteps, server buildLeague.js compliance.
Open: should the 3 s refresh also force Sleeper's rosters read fresh (markFreshOnce) so it cannot return the old roster?

### P-23 - Two taps to push roster changes
Requested: 2026-11-04 (James)
Type: minor        Status: Pending (not built; waiting for a build message)
Notes / questions: Today the floating "Review and push to Sleeper" button scrolls to the bottom (RosterPage.jsx pushRef), then Push to Sleeper, then the confirmation: three taps. Wanted, two taps only: if the user is NOT at the bottom, the floating button scrolls to the bottom with the "Send these changes to Sleeper?" dialog already open (tap 2 = the confirm button). If already at the bottom, the user taps Push to Sleeper to open the dialog, then confirms. My reading: "at the bottom" = the push panel is on screen; the floating button hides or stays as it does now there.

## Done

### P-1 - Keep a manual roster swap locked in
Requested: 2026-10-22 (James)
Type: minor        Status: Built 4.13.0
Notes / questions: Roster → Proposed lineup: when James makes a manual (custom) swap, treat it as locked in and re-adjust the suggestions to what is still possible from there. Today custom changes clear when the ticks change.

### P-2 - Open the player card from a suggestion card
Requested: 2026-10-22 (James)
Type: patch        Status: Built 4.13.0
Notes / questions: Tapping a player name on a Roster suggested-change card should open that player's card.

### P-3 - Player card: scroll weekly cards sideways
Requested: 2026-10-22 (James)
Type: minor        Status: Built 4.13.0
Notes / questions: The weekly cards on the player card should scroll sideways to see earlier and later weeks.


### P-13 - Claim failure reason on the claims generator
Requested: 2026-10-26 (James)
Type: patch        Status: Built 4.13.0
Notes / questions: show why a claim failed instead of the refused request (Sleeper's body.errors reason is read before the HTTP status). Cause inferred, not reproduced.

### P-14 - Primetime wording
Requested: 2026-10-26, rules confirmed 2026-10-26 13:34 (James)
Type: minor        Status: Built 4.13.0
Notes / questions: four formats from the user's side; tie uses case 4; negative points kept; "Already lost" when trailing by more than 4 with only the opponent's players left; no text before the Sunday afternoon games end.

### P-15 - Cheer meter row layout
Requested: 2026-10-26 (James)
Type: minor        Status: Built 4.13.0
Notes / questions: big score left of the picture, two stat lines, bundle slides with the name bubble.

### P-16 - Weather: international games and dome icon
Requested: 2026-10-26 (James)
Type: patch        Status: Built 4.13.0
Notes / questions: dome games show an icon and "roof" only; neutral-site games look up their stadium. LAR/LV and DET/GB were most likely domes shown with nothing; not confirmed against live data.

### P-17 - Live colours
Requested: 2026-10-26 (James)
Type: patch        Status: Built 4.13.0
Notes / questions: live text red; live points coloured by pace against the projection (thresholds in decision 198).

### P-18 - CBS pick'em: manual vs auto push
Requested: 2026-10-26 (James)
Type: minor        Status: Built 4.13.0
Notes / questions: auto skips only a pool changed by hand on CBS; manual push overwrites and reports the count. Reading of the request not confirmed. The per-league difference James saw this week was not reproduced (needs the CBS push log).

### P-19 - CBS pick'em: always check an hour before, Tuesday push, remove auto mode
Requested: 2026-10-28 (James)
Type: minor        Status: Built 4.14.0
Notes / questions: checks about 60 min before each kickoff slot and Tuesday 10:00 Toronto, app picks overwrite CBS, unpicked games use the app's pick, auto mode removed, Pause kept (decision 203). Tuesday time was my proposal, not confirmed. Server code syntax-checked only.

### P-0 - Version-tagged images and compose pinning
Requested: 2026-10-22 (offered, then requested as the release flow)
Type: minor        Status: Built in v4.12.0 (release flow, v4.11.1 never tagged)
Notes / questions: `release.yml` builds on version tags only; `deploy/compose.yaml` pins exact versions.
