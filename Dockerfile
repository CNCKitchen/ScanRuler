# SPDX-License-Identifier: AGPL-3.0-only
# ScanRuler as a container: the static Vite build (dist/) served by nginx,
# running unprivileged on port 8080. The app runs entirely in the browser;
# the container only hands out files. See docs/docker.md.
#
#   docker build -t scanruler .
#   docker run --rm -p 8080:8080 scanruler

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# The file store short links (/s/<name>) open from. Empty by default, so a
# self-hosted build does not point into the scanruler.com store. Taken out of
# the tracked .env, since Vite lets an empty value there stand.
ARG VITE_FILES_URL=""
RUN sed -i '/^VITE_FILES_URL=/d' .env \
 && if [ -n "$VITE_FILES_URL" ]; then printf 'VITE_FILES_URL=%s\n' "$VITE_FILES_URL" >> .env; fi \
 && npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
