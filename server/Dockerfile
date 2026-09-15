# Plain JS, no bundler/transpile step for the server, so a single stage
# is enough — no benefit to multi-stage here.
FROM node:20-alpine

WORKDIR /app

# Copied separately from the rest of the source so `npm install` only
# re-runs (and re-downloads) when package.json actually changes, not on
# every source edit.
COPY package.json ./
# No package-lock.json is checked in yet (never ran `npm install` with
# network access to generate one). If you add one later, switch this to
# `npm ci --omit=dev` for reproducible, faster installs.
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4000

# The FantasyPros key is NOT set here and should never be baked into the
# image — pass it at `docker run` / compose time (see README / .env.example).
# Baking a secret into an image layer means anyone with the image has it,
# even after you "remove" it in a later layer.

# Runs as a non-root user rather than the image's default root.
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
