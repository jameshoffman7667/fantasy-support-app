# Release v4.12.0
Image: mybadreligon/fantasy-manager-server:4.12.0 and mybadreligon/fantasy-manager-client:4.12.0   (built by the v4.12.0 tag workflow; also 4.11, latest, sha-)
Short: Spec audit: healthz, clean stop, PWA, tests
Long: Adds /healthz and clean SIGTERM shutdown (tini), fail-fast owner config, offline page, update prompt, Install button, security headers, npm test, docs/ layout and a pending log. Desktop layout and security baseline are logged, not built.
Release commit: the main commit that contains this file (git log -1 -- deploy/RELEASE.md)        Tag pushed from authoring session: no (James or Claude Code pushes it)
Type: minor (new /healthz endpoint, Install button, PWA behaviour; v4.11.1 was never tagged, its release-flow changes ship here)
Update: later
Port: client container 5000 -> host CLIENT_PORT (default 5000; image fixed; register plan says 8042, not moved yet). Server 4000 internal only.   Exception: container 5000 -> host CLIENT_PORT, image fixed
Public hostname: fantasymanager.hoffmanhouse.ca        Needs Caddy route: no (unchanged)
New or changed env vars: none. Start-up now exits if OWNER_USERNAME is missing, or OWNER_PASSWORD is missing before the owner account exists.
Data: /app/data in the server container (named volume fantasy-manager-data, or DATA_PATH); migration: none
Resources: unchanged
Healthcheck: GET /healthz on $PORT -> 200 {status, version}; the image and deploy/compose.yaml use wget on 127.0.0.1. The server stops cleanly on SIGTERM (tini + handler).
Verify after deploy: both containers healthy; the site loads and a league page shows real data; `docker stop fantasy-manager-server` exits 0 within a few seconds (not 137); `docker exec fantasy-manager-server wget -qO- http://127.0.0.1:4000/healthz` shows version 4.12.0; Account shows Install app (or says it is installed)
PWA: offline page, update bar, Install button and manifest screenshots added; checked in Chromium on the sign-in screen only (320, 390, 540, 768, 1280, 1440 px: no sideways scroll; service worker active; offline page shown with the server stopped). Lighthouse not run. Cloudflare Access bypass for manifest, sw.js, offline.html and icons: needed if Access protects the hostname
Docker build: not run (no Docker daemon in the authoring session); server run with node, client built with vite; the first image build is the v4.12.0 tag workflow
Rollback: previous image tag latest as of v4.11 (digest pinned by the server's update procedure); data restore needed: no
Known issues: no designed desktop layout (single phone column), dark only, no security baseline for external access (TOTP, step-up, CSP, audit log), one 500 kB+ JS bundle, ad-hoc data migrations; all logged in docs/pending-changes.md (P-5 to P-10)
Backup tier: small/critical (SQLite; stop the container during a copy)

## Update field
`Update:` is fixed and always `now` or `later`. It is `now` only when James says "build, push and update" for this release; otherwise `later`.
- later: publish the tag and image only. Do not touch the server.
- now: after the image exists, deploy it (plan first, approval first).

## Tag commands (James or Claude Code, once main has this commit)
git fetch origin && git log --oneline -1 origin/main
git tag -a v4.12.0 <release commit> -m "Spec audit: healthz, clean stop, PWA, tests" -m "Adds /healthz and clean SIGTERM shutdown (tini), fail-fast owner config, offline page, update prompt, Install button, security headers, npm test, docs/ layout and a pending log. Desktop layout and security baseline are logged, not built."
git push origin v4.12.0
Repo secrets DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must exist. Watch the `release` run in Actions; if a step fails, fix with the next patch version, never move the tag.
