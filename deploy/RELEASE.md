# Release v4.12.1
Image: mybadreligon/fantasy-manager-server:4.12.1 and mybadreligon/fantasy-manager-client:4.12.1   (built by the v4.12.1 tag workflow; also 4.11, latest, sha-)
Short: Health check: 30 s start period
Long: /healthz stays public and returns only {status, version} (version = image tag), reading only the local database. The image and deploy/compose.yaml health checks now use a 30 s start period. No app behaviour change.
Release commit: the main commit that contains this file (git log -1 -- deploy/RELEASE.md)        Tag pushed from authoring session: no (James or Claude Code pushes it)
Type: patch (health check start period; v4.12.0 and v4.11.1 were never tagged, their changes ship here)
Update: later
Port: client container 5000 -> host CLIENT_PORT (default 5000; image fixed; register plan says 8042, not moved yet). Server 4000 internal only.   Exception: container 5000 -> host CLIENT_PORT, image fixed
Public hostname: fantasymanager.hoffmanhouse.ca        Needs Caddy route: no (unchanged)
New or changed env vars: none. Start-up now exits if OWNER_USERNAME is missing, or OWNER_PASSWORD is missing before the owner account exists.
Data: /app/data in the server container (named volume fantasy-manager-data, or DATA_PATH); migration: none
Resources: unchanged
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"4.12.1"}, public, local database only; image and deploy/compose.yaml: wget on 127.0.0.1, interval 30s, timeout 5s, start period 30s, 3 retries. The server stops cleanly on SIGTERM (tini + handler).
Verify after deploy: both containers healthy (docker inspect shows the 30 s start period); `docker exec fantasy-manager-server wget -qO- http://127.0.0.1:4000/healthz` prints {"status":"ok","version":"4.12.1"}; the site loads and a league page shows real data; `docker stop fantasy-manager-server` exits 0 within a few seconds (not 137); Account shows Install app (or says it is installed)
PWA: offline page, update bar, Install button and manifest screenshots added; checked in Chromium on the sign-in screen only (320, 390, 540, 768, 1280, 1440 px: no sideways scroll; service worker active; offline page shown with the server stopped). Lighthouse not run. Cloudflare Access bypass for manifest, sw.js, offline.html and icons: needed if Access protects the hostname
Docker build: not run (no Docker daemon in the authoring session); server run with node, client built with vite; the first image build is the v4.12.1 tag workflow
Rollback: previous image tag latest as of v4.11 (digest pinned by the server's update procedure); data restore needed: no
Known issues: no designed desktop layout (single phone column), dark only, no security baseline for external access (TOTP, step-up, CSP, audit log), one 500 kB+ JS bundle, ad-hoc data migrations; all logged in docs/pending-changes.md (P-5 to P-10)
Backup tier: small/critical (SQLite; stop the container during a copy)

## Update field
`Update:` is fixed and always `now` or `later`. It is `now` only when James says "build, push and update" for this release; otherwise `later`.
- later: publish the tag and image only. Do not touch the server.
- now: after the image exists, deploy it (plan first, approval first).

## Tag commands (James or Claude Code, once main has this commit)
git fetch origin && git log --oneline -1 origin/main
git tag -a v4.12.1 <release commit> -m "Health check: 30 s start period" -m "/healthz stays public and returns only {status, version} (version = image tag), reading only the local database. The image and deploy/compose.yaml health checks now use a 30 s start period. No app behaviour change."
git push origin v4.12.1
Repo secrets DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must exist. Watch the `release` run in Actions; if a step fails, fix with the next patch version, never move the tag.
