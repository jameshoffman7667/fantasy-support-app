# Pending changes log

Requests are logged here and built only when James sends a build message ("build it", "build P-3", "build everything pending"). IDs are never reused. Statuses: Pending, Blocked, Built (with version), Dropped.

## Pending

### P-4 - BUG: player card dynasty value trend is wrong
Requested: 2026-10-22 (James, screenshot)
Type: patch (bug)        Status: Pending
Notes / questions: Chris Godwin shows value 277 but a trend of down 1,729 (7 days) and down 5,253 (30 days), which is impossible for a 277 value. Code path: server/values.js `parseRaValues` (trend_7d / trend_30d), server/playerCard.js `valuePanel`, client/src/ui/playerCard.jsx (~line 383). Suspect a different unit or scale; cause not confirmed, needs a raw Roster Audit sample for Godwin.
[stated 2026-11-08] Screenshots from James: app shows value 293 with trend down 614 (7d) and up 110 (30d); Roster Audit's own page shows SF value 290 with down 19 (7d) (1QB value 359, down 48 (7d)). So the value is close but the app's trend numbers are on another scale or from another field; cause still unconfirmed, needs the raw Roster Audit response for Godwin (list row and /players/<id>) to see which field holds the 19. Code: trend7/trend30 are read from trend_7d/trend_30d (server/values.js parseRaValues), detail first, then the list row (server/playerCard.js line 353).

### P-35 - Player card: weekly cards cover the whole season; tap a card for projected vs actual stats
Requested: 2026-11-11 (James)
Type: minor        Status: Pending
Notes / questions: James: the sideways-scrolling weekly cards on the player card (SUMMARY tab, `WeekScroller` in client/src/ui/playerCard.jsx) should include the entire current season, and tapping a game card should show the projected and actual stats for that game.
Today: server/playerCard.js builds `projections` for only currentWeek-4 .. currentWeek+3 (`projWeeks`, line ~427); each card shows PROJ and FINAL points only. Plan: build all weeks 1-18 (byes shown as BYE, the current week still scrolled into view) and make each card a button that opens a detail panel (week, opponent, result, PROJ vs FINAL points, then a stat table: projected / actual per stat column for the player's position).
Actual stats are already stored (`actual_stats`, same source as the GAME LOG tab, so the actual column is safe). What is NOT confirmed: projected stats. `proj_records` keeps projected fantasy points only (proj, adj_proj), not a per-stat line, so weeks the app never tracked have no stored projection and the early-season cards may show a dash for PROJ. A projected stat line would have to come from Sleeper's weekly projection pool (`getWeekProjections`, per-stat), which I have not verified returns past weeks. If it does not, past weeks show projected points only (no stat line) and say so in the panel. Decision for James if he cares: store the projected stat line from now on (small table/column change, additive migration) so future weeks have it.

### P-36 - Drop candidates: bye players use rest-of-season average, yellow text; dynasty leagues sort by dynasty value
Requested: 2026-11-11 (James)
Type: minor        Status: Pending
Notes / questions: Waivers > Drop candidates (client/src/pages/DropCandidates.jsx; sort and `proj` come from the plan's candidate rows, line ~81 shows "Proj x.x"). James: (1) in redraft leagues a player on bye must not show 0 / sort as 0; show and sort by his rest-of-season average weekly projection instead; (2) the projection text and the BYE label for those players are yellow so it stands out; (3) in dynasty leagues sort by dynasty value instead of projected points.
Readings, unconfirmed: "rest of season average" = mean of the remaining non-bye weeks' projected points in the league's scoring (weeks after the current one); the yellow is the app's existing amber/minor colour (`C.minor`), applied to both the "Proj" figure and the "Bye" status; in dynasty leagues the line shows dynasty value in place of Proj, sorted high to low within bench first, then starters (the v4.9 grouping stays); keeper counts as redraft. Open: what a bye player shows if he has no future projections (my default: "No projection", sorted last).

### P-37 - BUG: the app week does not move on after the week's last game
Requested: 2026-11-11 (James: "the app week still isn't updating after the last game of the week is complete"; it was also meant to be fixed by the v4.9 rule "last kickoff + 4 h")
Type: patch (bug)        Status: Pending
Notes / questions: The server side looks right: `advanceWeek` in server/sleeper.js returns week N+1 once now >= the week's latest ESPN kickoff + 4 h (fallback: the first Tuesday 10:00 Toronto at least a day after the app first saw week N). I could not run it against live data, so this is a reading of the code, not a confirmed cause. Likely cause found: the week is pinned by the client and the session.
1. Restore on open: client/src/App.jsx (~line 176) calls `buildAll(sessionId, restoredIds, last?.week ?? undefined)`, i.e. it sends the SAVED week from the cached leagues, and POST /api/leagues/build (server/server.js ~line 462) does `session.week = week` for any integer 1-22. So every app open re-builds the old week and the server's advanced week is never used.
2. `/api/connect` stores `week: state.week` in the session once (line ~417); a session that stays open never moves on, and the client has no timer that asks again after the last game.
3. Smaller: `getWeekSchedule` is cached 15 min; if ESPN lists a rescheduled/flexed game later in the week, "last kickoff" is that game (would delay the move, not skip it).
Proposed fix (not built): the server decides the week (`sleeper.getState().week`, which already includes the +4 h rule). The client sends a week only when James picks a different one by hand in the app (week switcher), never the saved one on restore; the saved week is only used for the cached first paint. While the app is open, re-check the week every few minutes and after the last kickoff + 4 h (cheap `/api/state`-style call), and rebuild when it changes. Add a unit test for advanceWeek (none exists today) and for the restore path.
Open: does the week switcher in the app let James choose another week by hand (so a manual pick must be kept for the session)? My reading: yes, keep a manual pick until the app is reopened or the real week moves past it.
[stated 2026-11-11 09:39] Answer: yes, the week switcher exists and works by hand. Still my reading, unconfirmed: a manual pick is kept until the app is reopened or the real week moves past it.

### P-38 - Waivers Drop candidates / Claim Generator: IR players as drops, user picks the bench player who takes the IR spot
Requested: 2026-11-11 (James)
Type: minor        Status: Pending
Notes / questions: James: if a team's IR spots are full but it has IR-eligible players on the bench, the IR players are drop candidates. Choosing an IR player to drop makes the user pick WHICH bench player moves into IR (so the roster stays compliant). The claim then first swaps the IR players, then processes the claim. When pending claims have used up all the bench-to-IR swaps, the remaining IR players are removed from the drop candidates.
What exists (found in code, not run live): P-26 (v4.16.0) already does this for the Roster page's add flow only (client/src/rosterChanges.js `dropOptions` / `irSwapCandidate`, push order IR out, IR in, drop, add in RosterPage.jsx). There the replacement is picked automatically (the highest-ranked IR-eligible bench player, not already used by another add's swap) and IR players are listed only while such a player exists. The Waivers > Drop candidates page (client/src/pages/DropCandidates.jsx) and the Claim Generator (WaiverPage.jsx) do not list IR players and do not carry an `irSwap`, so this is new work there.
Plan (not built): list IR players on Drop candidates when at least one IR-eligible bench player is still free; ticking one asks which free bench player takes the IR spot (dropdown of IR-eligible bench players not locked and not already chosen by another ticked drop or claim, highest-ranked first as the default); each bench player can be used once across all ticked drops and claims, and once all are used the remaining IR players disappear from the list (and untick if they were ticked); the claim carries the `irSwap`, and the push does IR out, IR in, then the claim with its drop, as on the Roster page. Also reuse the same chooser on the Roster page add flow so both behave the same (replaces P-26's automatic pick).
Readings, unconfirmed: "IR spots full" = no open IR slot, but IR players stay offered whenever a free IR-eligible bench player exists (as P-26); the swap is IR player to bench, chosen bench player to IR, then the drop is the benched IR player; the push is all-or-nothing per claim, using the same three Sleeper calls as the Roster page (IR calls not seen failing live); locked bench players are not eligible.

### P-39 - BUG: after an IR swap the app says the roster is over the limit
Requested: 2026-11-11 (James: "after making an IR swap in the app, it is telling me I'm over the roster limit, possibly related to the bench having an extra player?")
Type: patch (bug)        Status: Pending (cause narrowed down: stale read between the two IR steps; fix not built)
Notes / questions: The same symptom was reported on 2026-11-04 (P-22: eligibility card still 1 over after an IR move) and the v4.15.0 changes (every starting slot counts, post-push read-back overlay) did not cover every case, or this is a different case.
How the check works (client/src/ui/compute.js `rosterCompliance`, server/buildLeague.js): limit = starting slots + the league's BN count; players = filled starters + bench (bench = roster players that are not starters, not in `reserve` and not on taxi). IR and taxi players do not count. A swap that moves X out of IR to the bench and Y from the bench into IR leaves the count unchanged, so a correct read after the swap should not be over unless the roster was already full and only one half of the swap happened (IR out done, IR in not), or the player read is stale.
Candidate causes (read from code, none confirmed): (1) Half a swap: IR out went through and IR in did not (or failed to verify), so X sits on the bench and Y is still there too: the bench has the extra player, as James suspects. (2) Stale read: the confirmed-edit overlay (`sleeper.effectiveRoster`, 5 min) only replaces `reserve`, `taxi` and drops; if Sleeper's public roster lags on the order of seconds to minutes and the overlay was not recorded for a step (read-back not confirmed), the app builds the old IR list against the new bench or the other way round. (3) Only the Roster page's "IR swap with a drop" path (P-26) records `irSwap`; a manual swap from the compliance card or elsewhere may not note both steps in the overlay. (4) Roster limit taken from `roster_positions` BN count: a league whose real limit differs (extra or fewer bench spots in its settings) would show over/under after any move.
[stated 2026-11-11 21:16] James: league The NextFL; the card showed 1 player over (he presumed 14 spots, 15 players); he had already made the moves (Garrett Wilson out of IR, Puka Nacua into IR); Sleeper shows the roster legal.
Checked 2026-11-11 21:20 (League Loom read of Sleeper, then the app's own `rosterCompliance` run on that roster in node): NextFL = 8 starting slots (QB, 2 RB, 2 WR, TE, 2 FLEX) + 6 BN = 14 spots; now Sleeper has 14 players off IR (7 starters with one empty FLEX, 7 on the bench, IR = Stribling + Nacua). The app's rule gives 14 spots, 14 players, 0 over, no issues, so the final state is NOT over. The state that does produce "roster over the limit by 1" (and "1 IR-eligible player is not on IR") is the one between the two steps: Wilson already on the bench and Nacua still on the bench (15 players on the bench side, IR holding only Stribling). So James saw a stale or half-applied read, not a real over-limit and not a wrong bench count (cause 4 is ruled out for this league; the empty FLEX slot is handled correctly).
Most likely cause (still a reading of the code): the page rebuilt from Sleeper's public roster before the IR-in step showed up there, and the short-term correction (`sleeper.effectiveRoster`) had no record of the IR-in step (it is noted only when the read-back confirms the step, and the 5-minute roster cache can serve the in-between read). Fix to build: after a staged push, record BOTH steps' reserve lists in the correction as soon as each call is accepted, force a fresh roster read after the last step (not the 3 s timer on a cached read), and keep the card from judging the roster while a push is still running or not yet read back. Add a test with the exact NextFL numbers (14 vs 15).
[stated 2026-11-11 21:56] James: the warning is gone now, but he refreshed at the time and it did not go away then. So it was not just the 3 s timer: the page kept getting the in-between roster for a while (a few minutes to well under an hour; exact time unknown), and it fixed itself.
What the code shows (server/server.js ~455, server/sleeper.js getRosters/liveWindow, server/sleeperPrivate.js updateReserve): (a) the refresh button only forces a fresh PLAYER-status read (`markPlayersFreshOnce`); it does not force a fresh roster read, so it can be served Sleeper's public roster from the 5-minute cache; (b) for 15 minutes after any push the cache is skipped (`noteWrite`), so right after the push a refresh does read live, but if Sleeper's public roster itself still shows the old IR list, the read is stale anyway; (c) the confirmed-edit correction lasts 5 minutes and is recorded only when Sleeper's response to the IR call lists the exact new reserve, so an unconfirmed IR-in step (or one that lagged) leaves nothing to cover the lag. Either Sleeper's public roster lagged behind its own app for a while, or the second IR call was not recorded. I cannot tell which from here; the app keeps no record of what it read and when.
Fix additions (not built): the refresh button also forces a fresh roster read for the open leagues (cheap, once per press); when the card shows an over-limit or IR issue right after a push, show "Read from Sleeper at HH:MM" and the counts it used (spots, players, IR x of y) so a stale read is obvious; log the raw reserve / players counts the first time a half-swap state is seen, so the next occurrence can be traced.
Needed from James to find it (now mostly answered): which league, the roster counts shown ("over by N", spots, players), which two players were swapped and from which screen, and whether Sleeper itself shows the roster as legal. Then I compare the app's bench/IR lists with Sleeper's raw roster for that league. Not built.

### P-40 - Game Day: TNF tab first, time-based default tab, red/green TNF comparisons, tap a TNF card to swap
Requested: 2026-11-12 (James)
Type: minor        Status: Pending
Notes / questions: James, four parts for Game Day (client/src/pages/GameDay.jsx, client/src/tnf.js):
1. Tab order: TNF all the way to the left (today Cheer meter, Primetime, TNF; becomes TNF, Cheer meter, Primetime).
2. Default tab on open, by time (Toronto = Eastern): TNF from Tuesday 3:00 am until Friday 3:00 am; then Cheer meter until Sunday after the last 4 pm games are done; then Primetime until Tuesday 3:00 am. Today the default is always Cheer meter (`useState("cheer")`). He can still tap any tab.
3. TNF tab colours: a "lowest projected starter" (the 3 non-Thursday starters listed per league) whose projection is below a TNF BENCH player's projection is coloured red; a "highest projected bench" player (bench / IR / taxi list) whose projection is above a TNF STARTING player's projection is coloured green.
4. Tapping a TNF player's position card opens a pop-up with the roster and bench, to pick a player to swap him with.
What exists: the TNF tab lists each league's Thursday-night players (slot box + projection) and, in plain text, the 3 lowest projected starters and 3 highest projected bench / IR / taxi players (the Thursday players are left out of both lists); the "last 4 pm game done" moment already exists on the server (Primetime `stage`: "waiting" until the last Thursday-Sunday afternoon game ends, then "sunday" / "monday", server/gameday.js ~line 143-166).
Readings, unconfirmed: (2) the Sunday switch follows that Primetime stage (it leaves "waiting"), falling back to the clock only if the stage is not known; before the afternoon games end the Cheer meter stays; (3) "TNF bench player" = a Thursday-night player sitting on the bench (not IR / taxi); "TNF starting player" = a Thursday-night starter; the comparison is within the same league, uses the projection shown, and a locked player (his game started) is not coloured as a swap target; red/green use the app's red and green status colours and apply to the name and the projection; (4) the pop-up lists that league's starters and bench with projections; picking one proposes the swap the same way the Roster page's custom swap does (the lineup rules still apply: eligible slots only, locked players disabled), and it is staged for review on the Roster page / pushed with the usual confirm, NOT sent straight to Sleeper; the swap partner can be a starter or a bench player depending on who was tapped (a bench TNF player swaps with a starter, a starting TNF player with a bench player).
[stated 2026-11-12 17:46] Answer: the swaps are staged, and a "Push to Sleeper" button at the bottom of the TNF tab pushes all staged updates (every league) at the same time. Reading, unconfirmed: it uses the existing lineup push and confirm dialog (two taps, read-back, per league result list), only leagues with staged swaps are sent, and the staged swaps are the same ones the Roster page shows as custom swaps.

### P-41 - Waiver variances "Free agent outprojects a starter / bench player": season average for bye and IR players
Requested: 2026-11-12 (James)
Type: minor        Status: Pending
Notes / questions: James: update the waiver "free agent outprojects a starter or bench player" variances to use season averages instead of weekly projections for bye / IR players.
Today (client/src/ui/compute.js `compareToRoster`, `faCanCount`; the same rule drives the waiver card note and the variance): the comparison uses this week's projection only. Your own starters and bench players on bye are LEFT OUT of the comparison (`onBye`, v4.8), so a free agent never "beats" them; a free agent on bye or with any injury designation other than Questionable (Out, Doubtful, IR ...) never beats anyone, and one projected 0 on a bye never counts (v4.4.2). IR players sit in the IR list, not in starters or bench, so they are never compared today.
Readings, unconfirmed (the request is short, so please correct these): (1) "bye / IR players" = the PLAYERS BEING COMPARED. A starter or bench player on bye (and a starter or bench player projected 0 because he is Out) is compared by his season average fantasy points per game in that league's scoring instead of being skipped, and the free agent's weekly projection is compared against it; so a free agent who beats a bye starter's season average gets the variance. (2) A free agent who is on bye or IR/Out himself is also compared by his season average, so a stash that beats your bye or injured player's average shows up (today he can never count). (3) IR players on your own roster are not added to the starter/bench comparison (they cannot play this week); they are only a comparison point if they would be moved into the lineup. (4) "Season average" = this season's average points per game played, from the stats the app already stores (not rest-of-season projections); if a player has no games this season, fall back to his rest-of-season projection average, else leave him out. The note says which basis was used, e.g. "season avg 11.2 vs ...". Dynasty leagues keep comparing by dynasty value (v4.6).
Open question for James: is it the compared roster player (on bye or Out) or the free agent (on bye or IR) that switches to the season average, or both (my reading is both)? And should "season average" mean this season's actual average, or the rest-of-season projected average used for the Drop candidates change (P-36)?

### P-42 - "Clear major variances" button wherever "Clear minor variances" exists, behind a confirmation pop-up
Requested: 2026-11-12 (James)
Type: minor        Status: Pending
Notes / questions: James: add a clear-major-variances button to every place that has a clear-minor-variances button; clearing majors needs a confirmation pop-up.
Where the minor button exists today (found in code): (1) the page header on every league page, `ClearVariancesButton` in client/src/ui/modals.jsx, used once at client/src/App.jsx ~642 with the page's variances; (2) inside the variance report pop-up, "Clear minor variances (N)" in the same file (~line 272). The League page change log also has a "Clear N changes" button (client/src/pages/LeaguePage.jsx ~56); it clears settings-change entries, not variances, so my reading is that it gets no red button.
What exists for majors: a red variance can already be cleared one at a time in the report (v4.6, key = rule + player + `|RED`, comes back next week for week-keyed items, `canClear`/`ackKey` in client/src/variances.js); there is no clear-all for reds. `minorKeys` collects the yellow keys; a matching `majorKeys` (severity major, not cleared, via `ackKey`) would feed the same clear call.
Plan (not built): a red-outlined "Clear major variances (N)" button next to each yellow one, disabled at 0; tapping it opens a pop-up that states how many red variances in this scope will be cleared (page header = this page of this league, report pop-up = the scope it shows), lists them briefly (rule + player), says they stay hidden until they change or the week turns, and has Cancel / "Clear N major variances" (red). Nothing is cleared until the second tap.
Readings, unconfirmed: scope = same as the yellow button beside it; locked or grey (non-clearable) items are not included; a cleared major that gets worse or changes comes back, as for single clears; the clear is saved per user on the server like the minor clears; the pop-up lists up to 8 and says "and N more".

### P-43 - Variance report pop-up: checkboxes on the left, only ticked variances are cleared
Requested: 2026-11-12 (James)
Type: minor        Status: Pending
Notes / questions: James: on the variance clear screen add checkboxes to the left, default checked; only the checked variances clear when pressing the respective "clear variances" button.
Where (found in code): the variance report pop-up, `VarianceReportModal` in client/src/ui/modals.jsx: a tree League > Page > Rule > one row per variance, with "Clear minor variances (N)" at the top (`minorKeys` collects every uncleared minor in the pop-up) and a per-row "Clear it?" confirm for single variances. Today the top button clears ALL uncleared minors in the pop-up.
Plan (not built): a checkbox at the left of every uncleared variance row, ticked by default (including variances that appear later while it is open); the group headers (league, page, rule) get a tri-state checkbox that ticks/unticks everything under them; "Clear minor variances (N)" counts and clears only the ticked minor rows, and P-42's "Clear major variances (N)" button (with its confirmation pop-up) only the ticked major rows; unticked rows stay as they are; N updates live and the button is disabled at 0; already-cleared rows (Show cleared) have no checkbox. The ticks live only while the pop-up is open (reset when reopened).
Readings, unconfirmed: "the variance clear screen" = this report pop-up (the page-header "Clear variances" chip has no list, so it keeps clearing everything of that page); the existing per-row single clear stays; the P-42 confirmation lists only the ticked reds.

### P-11 - More "Medium" API preset parameters
Requested: 2026-10-08 (James, "coming later")
Type: patch        Status: Dropped (James 2026-11-08: scrap for now)
Notes / questions: James will send more parameters for the Medium preset (server/apiPresets.js `PRESETS.medium`).

### P-12 - Fixed non-root user for the server image (spec audit)
Requested: 2026-10-23 (James, from the deploy review)
Type: patch        Status: Built 4.14.0 (option A: documented only; option B still deferred)
Notes / questions: Today `server/entrypoint.sh` starts as root (under `tini`), runs `chown -R app:app /app/data`, then `su-exec app` runs `node server.js` as uid 100 (confirmed on the server; data on the server is owned 100:101). The spec asks for a fixed non-root `USER 1000:100` with no root step in the entrypoint.
- Option A (chosen for now): keep the pattern and document it in `deploy/RELEASE.md` and the functional spec.
- Option B (only when other changes need it): switch to `USER 1000:100`. Needs the server's data folder re-owned to 1000:100 once, a root step for James, before the first start of that release, plus a data copy first.
(An earlier note here said the image has no `USER` and runs as root; that was wrong: only the entrypoint's first step runs as root.)

## Done

### P-26 - Drop lists: IR players only when an IR-eligible player is off IR; dropping an IR player swaps first
Requested: 2026-11-05 (James)
Type: minor        Status: Built 4.16.0
Notes / questions: (1) IR players appear as drop candidates only if the team has IR-eligible players not on IR. (2) If an IR player is picked to be dropped: move that IR player to the bench, put the bench IR-eligible player into the freed IR slot, then drop the selected player, then make the add / waiver claim (push order IR out, IR in, drop, add). [stated 2026-11-05 22:54] If several IR-eligible players are off IR, the HIGHEST-ranked one goes into the IR slot. The drop-list "players leaving IR" logic from P-21 stays.

### P-27 - Player card news: only relevant news
Requested: 2026-11-05 (James)
Type: minor        Status: Built 4.16.0
Notes / questions: most players show no news; some show news that is not about them (example: Derrick Henry). Tighten the matching so news appears only when it is about that player. Built: items must be tagged to the player or name him; cause read from the code, not reproduced live; why most players show none was not changed.

### P-28 - Source pop-ups on news and article summaries
Requested: 2026-11-05 (James)
Type: minor        Status: Built 4.16.0
Notes / questions: wherever sources are listed for news or articles, tapping the summary opens a pop-up with more detail on what was pulled from each source; tapping a source's detail line opens the page it came from. Reading, unconfirmed: applies to player-card news, start/sit, Trending/Ending and any other place that lists sources.

### P-29 - Waiver add lineup follow-up: check schedule
Requested: 2026-11-05 (James)
Type: patch        Status: Built 4.16.0
Notes / questions: the lineup page says it checks every 5 minutes for a waiver add to land, then moves the player into the intended slot. If that 5-minute check is not used for anything else, replace it with a check at 12:30 PM Toronto on every day except Sunday and 1 hour before each kickoff window every day. The 5-minute timer is used for nothing else; it now only asks whether it is one of the check moments. Times read as Toronto time.

### P-30 - Optimal lineup: a manual move is never reversed by a suggestion
Requested: 2026-11-05 (James)
Type: minor (bug-like)        Status: Built 4.16.0
Notes / questions: after a manual roster change on the optimal lineup page, no suggested move may be created or ticked that reverses or overrides it; the player he moved in gets no suggestions until he leaves the screen. Today every manual move that lowers the projection is reversed at once unless he unticks the suggestion. Built on the v4.13.0 lock-in: held players are excluded from every suggestion; tested on the helper only.

### P-31 - Cheer meter: game slot filter in chronological order
Requested: 2026-11-05 (James)
Type: patch        Status: Built 4.16.0
Notes / questions: sort the game slot filter by kickoff time.

### P-20 - BUG: injury statuses lag Sleeper (Carnell Tate shows Questionable, Sleeper says Out)
Requested: 2026-10-31 (James)
Type: patch (bug)        Status: Built 4.15.0
Notes / questions: Cause (read from the code, not reproduced live): `getPlayers()` in server/sleeper.js caches Sleeper's whole /players/nfl list, where `injury_status` lives, for 24 h in season (`TTL.playersInSeason`), and every status in the app (buildLeague.js mapPlayerStatus, playerCard, drops, injuryOpps, alerts) reads that copy. Proposed fix: in season reuse it 30 min on Thu / Sat / Sun / Mon and 2 h other days, and have the refresh button force a re-read (at most once per 10 min, the list is about 10 MB). Added (James, 2026-11-04 09:03): also a scheduled refresh of the player list (and a rebuild of the tracked leagues) every Tuesday at 8:00 Toronto time, because many statuses update then. My reading, unconfirmed: it is a server-side job that re-reads Sleeper's player list at 08:00 Tue regardless of the cache, so the data is warm when he opens the app, using the existing scheduler (server/scheduler.js) and America/Toronto time.
Open: Sleeper may itself be slow to move a status, and Tank01's injury list could be a second source; not checked.

### P-21 - Drop options on roster updates: whole team, sorted by value
Requested: 2026-10-31 (James)
Type: minor        Status: Built 4.15.0
Notes / questions: When a roster update (free agent / waiver add) needs a drop, the drop choices should list the whole team, not only part of it, in reverse order (lowest first) of weekly projected points for redraft leagues and of dynasty value for dynasty leagues. Today the drop dropdown lists the lowest-rostered bench players first (v4.10). My reading, not confirmed: "whole team" includes starters, bench, IR and taxi; "reverse order" = lowest first; keeper leagues count as redraft (decision: keeper and redraft are one type); players with no projection or value go last. Open: should the default pick stay the lowest-rostered bench player, or become the first row of the new order?

### P-22 - Roster fixes: refresh the Current roster 3 s after a confirmed push, recalculate suggestions
Requested: 2026-11-04 (James)
Type: patch (bug)        Status: Built 4.15.0
Notes / questions: After a roster fix is "confirmed and read back", the Current roster screen should update about 3 seconds later, with the suggested roster moves recalculated from the new roster. Worst on the roster eligibility card at the top of the page. Seen: after pushing the IR move from the bottom of the page a starting RB slot was left empty; a variance for the empty spot appeared but no moves to fill it were recalculated, and eligibility still showed the roster one spot over the limit with a drop suggested. Two guesses, not confirmed: (1) the card was a stale result from before the IR move because the rebuild ran before Sleeper's public roster caught up (sleeper.js reads rosters with a 5 min cache; v4.5.1 has a 5 min "lineup written" overlay for starters only); (2) the over-limit count may include the empty-slot's bench effect. Needs a look at how the roster-limit count treats IR players and empty starter slots. Code to read: RosterPage.jsx PushPanel (onRefresh after push), runComplianceSteps, server buildLeague.js compliance.
Decided (James, 2026-11-04): the 3 s refresh should use the same pull that confirmed the push worked (the read-back) to update the roster, not a separate fetch; so the read-back result feeds the rebuild and the recalculated suggestions.

### P-23 - Two taps to push roster changes
Requested: 2026-11-04 (James)
Type: minor        Status: Built 4.15.0
Notes / questions: Today the floating "Review and push to Sleeper" button scrolls to the bottom (RosterPage.jsx pushRef), then Push to Sleeper, then the confirmation: three taps. Wanted, two taps only: if the user is NOT at the bottom, the floating button scrolls to the bottom with the "Send these changes to Sleeper?" dialog already open (tap 2 = the confirm button). If already at the bottom, the user taps Push to Sleeper to open the dialog, then confirms. My reading: "at the bottom" = the push panel is on screen; the floating button hides or stays as it does now there.

### P-24 - Non-IR-eligible player sitting in IR is not flagged
Requested: 2026-11-04 (James)
Type: patch (bug)        Status: Built 4.15.0 (indirectly: fresh statuses from P-20 and the P-22 fix; Montgomery not confirmed)
Notes / questions: One league currently has a player in an IR slot who is not IR eligible, and nothing flags it (Sleeper does not flag it either). My reading: the app's roster eligibility card should flag it and offer the IR-out fix. Checked in code only: eligibility is `irStatusOk(meta.injury_status)` in server/buildLeague.js (IR and PUP always; Out/Doubtful/Sus/NA/DNR/COV only when the league's reserve_allow_* flag is on, default Out + IR + PUP), and it reads the same Sleeper player list that is cached 24 h (see P-20), so a stale status could make an ineligible player look eligible. Update (James, 2026-11-04): the same player causes it in two leagues, David Montgomery in The Human League and Fantasyland; James thinks the stale status (P-20) is the cause. Not confirmed: I have not seen the status the app holds for Montgomery or the one Sleeper shows. Plan: fix P-20 first, then check whether the flag appears; if it does not, look at the league reserve_allow_* flags.

### P-25 - Trade page: "League analysis" tab rename and a new "Trending/Ending" tab
Requested: 2026-11-04 (James)
Type: minor (big; may be split into two builds)        Status: Built 4.15.0
Notes / questions: (1) Rename the Trade page's "Trade" tab to "League analysis" (TradePage.jsx; tabs today are Trade and Value opportunities, data-trade-tab="trade"). (2) New tab "Trending/Ending". The scheduled start/sit article review (Thu 8:00 / Sat 10:00 / Sun 9:00 Toronto, gemini.startSit) would also review articles for trade-for and trade-away candidates. The tab lists trade-for candidates NOT on James's team and trade-away candidates ON his team, each with a checkbox to include or exclude. From the ticked players the app builds potential trades, valued by ROS projection in redraft leagues and dynasty value in dynasty leagues, using team need (both rosters) to pick the players, with the net value always leaning 10% in James's favour. A trade can be levelled with other players from either roster, and James can add or remove players. Each player shows its dynasty value and each trade shows the net value.
My readings, not confirmed: "Trending/Ending" = trending up (trade for) / ending (trade away); one list per league, or one list across leagues with the trade built per league the player is in; "10% in my favour" = value I receive is about 10% above value I give (a target, not a hard cap); redraft value = ROS projected points (rosProjections.js), keeper counts as redraft; "show dynasty value for each player" also in redraft leagues (shown as extra information). Answers (James, 2026-11-05): (1) article sources: both the same sources as the start/sit review and different ones (which extra ones is still open); (2) every opponent in the league; (3) the trade review runs once a week, on Thursday (time not given; my proposal: Thursday 8:00 Toronto, the same slot as the first start/sit run); (4) team need = weak starting slots. Update (James, 2026-11-05 02:28): extra sources = do a general web search for the articles, much like the start of the start/sit list; sources found are added to a saved list over time and searched again on later runs (my reading: a per-app list of source sites kept in the database, shown on Account like the AI sources, which the weekly run visits first before the general search). Thursday 8:00 Toronto confirmed ("ok"). Nothing open except how the saved list is managed (my reading: Claude adds sites automatically; James can remove them). Earlier open questions (now answered): which article sources (the same Gemini start/sit sources, or others); does the app target specific opponents or search every opponent in the league; should the review run on its own schedule or only with the start/sit run; how team need is judged (starting slots vs bench depth vs injuries/bye weeks).

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

### P-32 - Claim Generator: compare with pending claims, duplicates greyed, "Integrate claims"
Requested: 2026-11-07 (James)
Type: minor (large; touches claim generation, the Claim rankings order, push and cancel)        Status: Built 4.17.0
Notes / questions: (1) Claims are re-evaluated from scratch whenever anything changes (new players bid on, new drop candidates, a bid changed, drop or add rankings), overwriting the selections on the Claim Generator. (2) The new claims are compared with the claims already pending in Sleeper: IDENTICAL claim (same add, same drop, same bid) -> the new card is unticked and greyed out but can still be moved in the order; if he changes the order of a duplicate, push by reordering the existing claim through the API if possible, else cancel the existing claims and send them all again in the right order. SAME add, DIFFERENT bid -> note on the card that an existing bid will be updated (update on push if possible, else cancel and re-push that claim). SAME add, DIFFERENT drop -> note on the card that the existing claim will be updated (same update or cancel/re-push). DIFFERENT add, SAME drop -> note on the card that an existing claim has the same drop. (3) When pending claims exist, a button above the existing claims, "Integrate claims" (blue border and blue text, transparent background). Tapping it turns the list into checkboxes on the left and a bid box where the bid value was. The bid box is pre-filled with the old bid, unless the player already has a DIFFERENT bid on the Available page: then show the old bid(s) and the new bid between the name and the bid box and leave the box EMPTY so he must type the value. The button becomes "Confirm updates" (solid blue background, white text). Confirming: for each ticked line, tick its drop player on the Drop candidates page and put a bid of the same value on its pickup player on the Available page, recalculate all claims, and on push cancel the existing claims, confirm they are cancelled, then push the new ones.
[stated 2026-11-07 22:28] Answers: "evaluate from fresh" = IGNORE the existing claims and anything done on the Claim Generator page: work through the steps in order (look at the drop candidates, look at the bids on the available players, make the claims) and only THEN compare with the existing claims. Reordering a greyed-out duplicate within its FAAB amount needs a cancel and re-push; he thinks every update will probably be a cancel and re-push anyway (so: no attempt to edit or reorder in place). Readings, unconfirmed: "identical" includes the bid; the claim order Sleeper uses is the bid (FAAB) so equal bids are ordered by position; v4.8 has cancel_waiver_claim, which is unverified live; re-sending means all claims of that league, in the new order. Not built.

### P-33 - Read-only ticker API for the IPTV Multiview app (token, summary, SSE score events, headshots, health)
Requested: 2026-11-08 (James, handoff file from the Multiview chat)
Type: minor (new read-only endpoints, new token setting; likely a compose change if Multiview should reach the server container directly)        Status: Built 4.17.0
Notes / questions: GET /api/ticker/summary (per league: status pre/live/final, league-name colour green/amber/red + colourBasis, my and opponent points/projected, starters-only players, ?bench=1), GET /api/ticker/stream (SSE `score` events per starter scoring change with per-league before/after totals and leagues[].delta, Last-Event-ID / ?since=, 10 minutes kept, 15 s heartbeat, merge same-poll changes, skip negative/corrections), GET /api/headshot/<playerId> (token, cached, placeholder), GET /api/ticker/health. Auth: dedicated revocable read-only bearer token named "multiview" in settings, never logged, separate from login sessions; no private data in responses. Polled every 15 s during games, so serve from cache. Answers owed to the Multiview chat: colour rule + hex, includeInTicker per league (suggested default on), polling cadence/delay, address from the Multiview container, existing endpoints. See the 2026-11-08 reply. Not built.
Findings (from code, 2026-11-08, corrected after James pointed at Game Day): LEAGUE colour already exists on the Game Day league cards (server/gameday.js matchupOutlook, v3.5): remaining = (my projected - my points) + (opp projected - opp points), each side floored at 0; threshold = 5% of remaining; diff = my expected final - opp expected final; GREEN when diff > 0 and diff >= threshold, RED when diff < 0 and -diff >= threshold, YELLOW otherwise. Before kickoff the projections are the full-week ones (remaining = both projections), after the final remaining is 0 so green = won, red = lost, yellow = tied. Hex (client/src/ui/theme.js): ok/green #3FAE58, minor/yellow #D9A521, major/red #D6533B; the card also shows win % (normal approximation). Separately, a live PLAYER's score is coloured by pace (client/src/livePace.js): green >= 95% of projection x game progress, yellow >= 60%, red below, none under 10% progress. Game Day already stores a per-league include flag (and importance) per user (settings.leagues[id].include in server/gameday.js), so `includeInTicker` should reuse it unless he wants a separate one. Sleeper live matchups are cached 45 s and live stats 90 s (server/sleeper.js); no push from Sleeper, so detection lags Sleeper's own update by up to about 45-90 s (not measured live). The server container listens on 4000 (not published); the client nginx on 5000 -> host CLIENT_PORT proxies /api/ to it. Every /api route is behind the session login today; no token auth, no SSE; /api/gameday already computes the league colour and live totals but per logged-in user. Headshots are already proxied and cached (server/images.js; sources sleepercdn.com then a.espncdn.com).
[stated 2026-11-08 14:00] includeInTicker: yes, a per-league setting (default on).

### P-34 - Ticker summary: slot, kickoffAt, statLine/stats per player (Multiview follow-up)
Requested: 2026-11-08 (James, follow-up file from the Multiview chat)
Type: patch (additive fields on GET /api/ticker/summary; no compose or env change)        Status: Built 4.17.1
Notes / questions: On each players[] entry add (1) `slot` (QB, RB, WR, TE, FLEX, SUPER_FLEX, K, DEF) and `slotOrder` (integer lineup order), (2) `kickoffAt` (ISO UTC of his game, null if unknown), (3) `statLine` short string for live or final games (null before kickoff) or, if only raw stats are available, a `stats` object (passYds, passTd, int, rushAtt, rushYds, rushTd, rec, recYds, recTd, fgm, xpm, sacks) and say which. (4) Confirm league `colour` is the colour to use for team name and score (no `mine.colour`). Also confirm: (a) DEF playerId = team abbreviation and headshot works, (b) stable player order / slotOrder, (c) ticker read by Multiview's server only, so LAN address + token are the only setup. Deliverable back: the version carrying the fields and an updated example response.
Readings from code (2026-11-08, not built): kickoff exists already (Game Day kickoffMillis); slot comes from Sleeper's starters order aligned with the league's roster_positions (needs a small change in gameday.js); live stats are cached 90 s and raw, so `stats` is the likely form, `statLine` only if formatted server-side; DEF ids are team abbreviations and /api/headshot serves the team logo for them (not run live).

### P-5 - Designed desktop layout (spec audit, 2026-10-22)
Requested: 2026-10-22 (spec audit)
Type: major (James decides)        Status: Built 4.18.0
Notes / questions: The app is one `max-w-lg` phone column on every screen size. The spec wants a designed desktop layout (sidebar navigation, multi-column and table views, side-by-side panes, keyboard shortcuts, visible focus). Needs design decisions: sidebar contents, which pages go multi-column first, whether the bottom tabs stay on tablets.
[stated 2026-11-08 15:20] Desktop layout answers: cascade the pages left to right. League management: league cards on the left, the page selection (Roster, Waivers, Trade radar, etc.) for the selected league to their right, page content to the right of that. Game Day: leagues in a left column instead of across the top, page content widened on the right. Pick'em: wider boxes, with the write-up, weather and upset potential moved to the right so rows get shorter. Analytics and Commish: widened a bit. Everything planned for a 16:10 screen; wider screens keep blank sides as now. Phone layout unchanged. My readings, unconfirmed: the breakpoint between phone and desktop is about 1024 px; the bottom tabs stay on phones; max content width about 1600 px centred (16:10 at 1440 to 1600 wide).

### P-6 - Light and dark mode (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Built 4.18.0
Notes / questions: The app is dark only; colours are constants in client/src/ui/theme.js. The spec wants `prefers-color-scheme` with a matching `theme-color`. Question: should light mode be offered at all, or is dark-only accepted?
[stated 2026-11-08 15:19] Defaults accepted: light mode is offered and follows the device's colour scheme (prefers-color-scheme), dark stays the fallback, with a matching theme-color.

### P-7 - Security baseline for an app reachable from outside (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor to major (several parts)        Status: Built 4.18.0
Notes / questions: The app holds Sleeper tokens and CBS credentials and is reachable through Cloudflare. Today: username + password, per-user sessions, login throttling. Missing against the spec baseline: mandatory TOTP, hashed server-side sessions with an idle timeout (check), CSRF header plus Origin check on writes, password re-entry before sensitive actions, strict CSP (blocked: the UI uses inline styles heavily), Cloudflare Access JWT check, an audit log. Needs James to pick which parts matter.
[stated 2026-11-08 15:20] James is fine with the current in-app password login. My reading, unconfirmed: no mandatory TOTP and no password-policy change. Still open: whether to add the CSRF header + Origin check on writes, an idle session timeout and an audit log of sign-ins and pushes, and whether Cloudflare Access sits in front of the app.
[stated 2026-11-08 15:30] Scope: just the audit log. No TOTP, CSRF/Origin check, idle timeout, password re-entry, CSP or Cloudflare Access check. My reading, unconfirmed: the log records sign-ins (success and failure), sign-outs, and every push to Sleeper/CBS and settings/credential change (user, time, action, no secrets), stored in the app's database, shown in Account for the owner, kept 90 days.

### P-8 - Split the JavaScript bundle (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Built 4.18.0
Notes / questions: One JS file over 500 kB (vite warns). Lazy-load heavy pages (Analytics, Commish, Scouting, Game Day).

### P-9 - Data migration safeguards (spec audit)
Requested: 2026-10-22 (spec audit)
Type: minor        Status: Built 4.18.0
Notes / questions: Migrations are ad hoc (`ALTER TABLE` guards in projectionStore.js and statConfig.js). The spec wants a `schema_version` table, forward-only idempotent migrations in a transaction and a timestamped database copy before a data-changing migration.

### P-10 - Lighthouse PWA audit and signed-in layout checks (spec audit)
Requested: 2026-10-22 (spec audit)
Type: patch (checks)        Status: Built 4.18.0
Notes / questions: Lighthouse was not run, and only the sign-in screen was checked at phone, tablet and desktop widths because the authoring session has no mock data for the signed-in pages. Run both from a session that has the app's fixtures or a live login.
