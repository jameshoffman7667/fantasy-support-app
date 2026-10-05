# Stage 1: build the static bundle.
# --platform=$BUILDPLATFORM runs this stage NATIVELY on the CI runner (amd64) even when the
# target image is arm64: the output is plain static files (HTML/JS/CSS), identical on every
# architecture, so there is no reason to build it under slow QEMU emulation. Only the small
# nginx stage below is produced per-architecture.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: serve it with nginx — small final image, no Node runtime needed
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5000
