# better-sqlite3 needs native compilation, unlike the rest of this app's
# plain-JS dependencies — hence multi-stage: the build toolchain
# (python3/make/g++) only exists in this stage, not the final image.
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev

# Final stage: just the app + its already-compiled node_modules, no
# compiler toolchain along for the ride.
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV DATA_DIR=/app/data

# The FantasyPros key is NOT set here and should never be baked into the
# image — pass it at `docker run` / compose time (see README / .env.example).

# Runs as a non-root user; the SQLite data directory needs to be owned by
# that user specifically, since it's written to at runtime (not just read).
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app/data
USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
