#!/bin/sh
set -e

# Runs as root (see Dockerfile comment on why USER app isn't set
# earlier). Fixes ownership on whatever actually got mounted at
# /app/data — a build-time chown in the Dockerfile only covers the
# directory as it existed inside the image, not a named Docker volume
# mounted on top of it at container start, which can come back
# root-owned regardless of what the image specified.
chown -R app:app /app/data

# Drop from root to the unprivileged "app" user for everything after
# this point — su-exec replaces this shell process rather than forking,
# so "app" ends up as PID 1, same as if USER app had been set directly.
exec su-exec app "$@"
