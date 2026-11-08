# Release v4.17.0
Update: now
Image: mybadreligon/fantasy-manager-server:4.17.0 and mybadreligon/fantasy-manager-client:4.17.0   (built by the v4.17.0 tag workflow; also 4.11, latest, sha-)
Short: v4.17.0 Claim compare, Multiview ticker API
Long: v4.17.0: Claim Generator compares fresh claims with queued ones (duplicates greyed, update notes, Integrate claims, cancel then re-push) and a read-only ticker API with its own token for the IPTV Multiview app.
Release commit: the main commit that contains this file (git log -1 -- deploy/RELEASE.md)        Tag pushed by hand: no (the release workflow creates the tag from the push to main)
Type: minor (Claim Generator comparison and cancel/re-push, read-only ticker API and token; no migration)
Runs as: the entrypoint starts as root, chowns /app/data, then runs the server as uid 100; on the home server the data folder is owned 100:101.
Port: client container 5000 -> host CLIENT_PORT (default 5000; image fixed; register plan says 8042, not moved yet). Server 4000 internal only.   Exception: container 5000 -> host CLIENT_PORT, image fixed
Public hostname: fantasymanager.hoffmanhouse.ca        Needs Caddy route: no (unchanged)
New or changed env vars: none. Start-up now exits if OWNER_USERNAME is missing, or OWNER_PASSWORD is missing before the owner account exists.
Data: /app/data in the server container. On the server it is a bind mount: DATA_PATH in the stack .env points at appdata-ssd/fantasymanager. Back up with the stack stopped (SQLite WAL: .db, -wal and -shm together). Migration: none
Resources: unchanged
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"4.17.0"}, public, local database only; image and deploy/compose.yaml: wget on 127.0.0.1, interval 30s, timeout 5s, start period 30s, 3 retries. The server stops cleanly on SIGTERM (tini + handler).
Verify after deploy: both containers healthy (docker inspect shows the 30 s start period); `docker exec fantasy-manager-server wget -qO- http://127.0.0.1:4000/healthz` prints {"status":"ok","version":"4.17.0"}; the site loads and a league page shows real data; `docker stop fantasy-manager-server` exits 0 within a few seconds (not 137); Account shows Install app (or says it is installed)
PWA: offline page, update bar, Install button and manifest screenshots added; checked in Chromium on the sign-in screen only (320, 390, 540, 768, 1280, 1440 px: no sideways scroll; service worker active; offline page shown with the server stopped). Lighthouse not run. Cloudflare Access bypass for manifest, sw.js, offline.html and icons: needed if Access protects the hostname
Docker build: not run (no Docker daemon in the authoring session); client bundled with esbuild in a browser harness, server files syntax-checked with node --check; the image build and its tag/label verify step are the release workflow run this push starts
Rollback: set IMAGE_TAG back to 4.15.0 (the version running now; 4.16.0 was never deployed). Claude Code also records the pinned digests before updating. Data restore needed: no (no migration; the new ticker token is a small settings entry that older versions ignore)
Known issues: the claim comparison, cancel-then-push and the ticker API were only unit-tested and built, not run against Sleeper or Multiview (Sleeper's cancel call has not been seen to work live); the nginx stream setting lives in the client image; no designed desktop layout (single phone column), dark only, no security baseline for external access (TOTP, step-up, CSP, audit log), one 500 kB+ JS bundle, ad-hoc data migrations; all logged in docs/pending-changes.md (P-5 to P-10); P-4 (dynasty value trend) still open
Backup tier: small/critical (SQLite; stop the container during a copy)

## Update field
`Update:` is fixed and always `now` or `later`. It is `now` only when James says "build, push and update" for this release; otherwise `later`.
- later: publish the tag and image only. Do not touch the server.
- now: after the image exists, deploy it (plan first, approval first).

## Stack notes (how the server actually runs this)
- The server stack is the repo's `docker-compose.yml` with `IMAGE_TAG` in the stack's `.env` (currently `4.15.0` after the last update). The version change is one `.env` line: `IMAGE_TAG=4.17.0`. `deploy/compose.yaml` is the reference with the same services; it is not a drop-in file.
- Compose edits beyond the tag (show them as a diff, do not hide them in "change only the tag"):
  1. server `healthcheck`: `test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:$${PORT}/healthz >/dev/null || exit 1"]`, `interval: 30s`, `timeout: 5s`, `start_period: 30s`, `retries: 3` (replaces the node fetch of `/api/health` on localhost).
  2. server `stop_grace_period: 15s`.
  3. Optional: json-file log limits (`max-size: 10m`, `max-file: "3"`) as in `deploy/compose.yaml`.
  The external `caddy_net` network in the repo's `docker-compose.yml` is not in `deploy/compose.yaml`; leave the stack's networks as they are.
- User and data ownership (decision: option A, see P-12): the container's entrypoint chowns as root, then drops to uid 100 (`su-exec app`) to run `node server.js`; only `tini` and `entrypoint.sh` run as root. The data folder on the server (`DATA_PATH`) is owned 100:101. The spec's fixed `USER 1000:100` is not used yet; switching to it needs a one-time root re-own of that folder to 1000:100 before the first start of that release.
- Restart check: `docker stop fantasy-manager-server` briefly takes the app down, so do it as part of the restart (the container should exit 0 in a few seconds, not 137), not as a separate step.

## How this release goes out
A release is "commit and push main" with a new `VERSION`. The `release` workflow (Actions tab) validates, builds and pushes both images (X.Y.Z, X.Y, latest), verifies the tags and labels, then runs `gh release create vX.Y.Z --target $GITHUB_SHA`, which also creates the tag. Do not push the tag by hand. If a step fails, fix it and release the next patch version (the tag is only created at the very end, so a failed run leaves none).
Fallback only (the workflow itself is broken): `git tag -a vX.Y.Z <commit> -m "<short>" -m "<long>"` then `git push origin vX.Y.Z` runs the same pipeline; it refuses a version that already has a release.
Repo secrets DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must exist.
