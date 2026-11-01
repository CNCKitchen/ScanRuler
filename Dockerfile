# SPDX-License-Identifier: AGPL-3.0-only
# ScanRuler is a static Vite + React + three.js app. This image builds the
# production bundle with Node, then serves the static `dist/` with nginx.
# It is a self-contained way to run the app locally on your laptop.

# ---- Stage 1: build the static site ----------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install dependencies first so the layer is cached unless the lockfile moves.
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the rest of the source and build the production bundle to /app/dist.
# The build runs `tsc --noEmit && vite build` (see package.json).
COPY . .

# VITE_FILES_URL only backs the short-link store (/s/<name>); the app opens
# fine without a real one. Override at build time if you host your own:
#   docker build --build-arg VITE_FILES_URL=https://files.example.com/ .
ARG VITE_FILES_URL=https://files.scanruler.com/
ENV VITE_FILES_URL=${VITE_FILES_URL}

RUN npm run build

# ---- Stage 2: serve it ------------------------------------------------------
FROM nginx:1.27-alpine AS serve

# Static output only; no Node or source in the final image.
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
# nginx:alpine already runs `nginx -g 'daemon off;'` as its default command.
