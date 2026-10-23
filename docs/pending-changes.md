# Pending changes log

Requests are logged here and built only when James sends a build message ("build it", "build P-3", "build everything pending"). IDs are never reused. Statuses: Pending, Blocked, Built (with version), Dropped.

## Pending

### P-1 - Keep a manual roster swap locked in
Requested: 2026-10-22 (James)
Type: minor        Status: Pending
Notes / questions: Roster → Proposed lineup: when James makes a manual (custom) swap, treat it as locked in and re-adjust the suggestions to what is still possible from there. Today custom changes clear when the ticks change.

### P-2 - Open the player card from a suggestion card
Requested: 2026-10-22 (James)
Type: patch        Status: Pending
Notes / questions: Tapping a player name on a Roster suggested-change card should open that player's card.

### P-3 - Player card: scroll weekly cards sideways
Requested: 2026-10-22 (James)
Type: minor        Status: Pending
Notes / questions: The weekly cards on the player card should scroll sideways to see earlier and later weeks.

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

### P-12 - Run the server image as a non-root user (spec audit)
Requested: 2026-10-23 (deploy review)
Type: patch        Status: Pending
Notes / questions: server/Dockerfile has no `USER`, so the server runs as root. The spec asks for a fixed `1000:100`. The data folder on the server (DATA_PATH, appdata-ssd/fantasymanager) is a bind mount, so its ownership must be changed on the server before the image switches user, and the update needs a data copy first. Plan the ownership change with the deploy step; do not ship the image change alone.

## Done

### P-0 - Version-tagged images and compose pinning
Requested: 2026-10-22 (offered, then requested as the release flow)
Type: minor        Status: Built in v4.12.0 (release flow, v4.11.1 never tagged)
Notes / questions: `release.yml` builds on version tags only; `deploy/compose.yaml` pins exact versions.
