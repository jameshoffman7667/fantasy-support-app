# Release v4.11.1
Image: mybadreligon/fantasy-manager-server:4.11.1 and mybadreligon/fantasy-manager-client:4.11.1   (built by the v4.11.1 tag workflow; also 4.11, latest, sha-)
Short: Switch to tag-based release flow
Long: Images now build only when a vX.Y.Z tag is pushed: server and client get X.Y.Z, X.Y and latest tags, then a GitHub release is created. Dockhand deploy job removed. Adds VERSION, deploy/RELEASE.md (Update: now|later) and deploy/compose.yaml.
Release commit: the main commit that contains this file (git log -1 -- deploy/RELEASE.md)        Tag pushed from authoring session: no (James or Claude Code pushes it)
Type: patch (release process only; no app code change; the old decimal v4.11 is 4.11.0)
Update: later
Port: client container 5000 -> host CLIENT_PORT (default 5000; image fixed; register plan says 8042, not moved yet). Server 4000 internal only.   Exception: container 5000 -> host CLIENT_PORT, image fixed
Public hostname: fantasymanager.hoffmanhouse.ca        Needs Caddy route: no (unchanged)
New or changed env vars: none
Data: /app/data in the server container (named volume fantasy-manager-data, or DATA_PATH); migration: none
Resources: unchanged
Healthcheck: server GET /api/health on $PORT (not /healthz) -> 200; deploy/compose.yaml uses 127.0.0.1
Verify after deploy: containers healthy; the site loads and a league page shows real data; the server log shows v4.11 behaviour unchanged (no app code changed)
PWA: unchanged, not re-checked in this release (no UI change)
Docker build: not run locally (CI only); the first build is the v4.11.1 tag workflow
Rollback: previous image tag latest as of v4.11 (digest pinned by the server's update procedure); data restore needed: no
Known issues: server stops with exit 137 (SIGTERM not handled); no /healthz or version endpoint; docs/ layout, in-repo pending-changes log and the full spec audit not done in this release
Backup tier: small/critical (SQLite; stop the container during a copy)

## Update field
`Update:` is fixed and always `now` or `later`. It is `now` only when James says "build, push and update" for this release; otherwise `later`.
- later: publish the tag and image only. Do not touch the server.
- now: after the image exists, deploy it (plan first, approval first).

## Tag commands (James or Claude Code, once main has this commit)
git fetch origin && git log --oneline -1 origin/main
git tag -a v4.11.1 <release commit> -m "Switch to tag-based release flow" -m "<Long from CHANGELOG.md>"
git push origin v4.11.1
Repo secrets DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must exist. Watch the `release` run in Actions; if a step fails, fix with the next patch version, never move the tag.
