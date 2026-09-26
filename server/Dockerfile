# better-sqlite3 needs native compilation, unlike the rest of this app's
# plain-JS dependencies — hence multi-stage: the build toolchain
# (python3/make/g++) only exists in this stage, not the final image.
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
# --build-from-source is the important part here, not just the build
# toolchain above: without it, npm can silently fetch a PREBUILT binary
# for standard glibc Linux instead of actually compiling one against
# Alpine's musl libc — which then fails to load at runtime with an ELF
# header / "invalid ELF header" style error the moment db.js tries to
# open the database, before the server ever binds to a port. That
# crash-before-listening is exactly what an "unhealthy, never starts"
# container looks like from the outside.
RUN npm install --omit=dev --build-from-source

# Final stage: just the app + its already-compiled node_modules, no
# compiler toolchain along for the ride.
FROM node:20-alpine
WORKDIR /app
# su-exec: a minimal, Alpine-native equivalent of gosu/sudo, used only
# to drop from root to the "app" user after fixing volume ownership at
# container start (see entrypoint.sh) — not to run the app as root.
RUN apk add --no-cache su-exec
COPY --from=build /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV DATA_DIR=/app/data

# The FantasyPros key is NOT set here and should never be baked into the
# image — pass it at `docker run` / compose time (see README / .env.example).

RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/data \
  && chmod +x entrypoint.sh

# Deliberately NOT switching to USER app here. A build-time chown alone
# doesn't reliably survive a *named Docker volume* being mounted over
# /app/data at container start — depending on Docker version and
# whether the volume already existed from an earlier deploy, the volume
# can come back root-owned regardless of what the image says. The
# container therefore starts as root, entrypoint.sh fixes ownership on
# whatever actually got mounted, then drops to the non-root "app" user
# via su-exec before ever running application code.

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]
