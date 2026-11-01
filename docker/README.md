<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Running ScanRuler with Docker

ScanRuler is a static Vite + React + three.js app that runs entirely in the
browser. These files build it into a container and serve it locally, so you can
run it on your laptop without installing Node or the toolchain.

Everything still runs in your browser; the container only serves the static
files. Nothing you load leaves your machine.

## Prerequisites

- Docker with Compose v2 (`docker compose`, not `docker-compose`).

## Production-like (recommended)

Builds the optimized bundle and serves it with nginx.

```bash
docker compose up --build scanruler
```

Then open <http://localhost:8080>.

To run it detached and stop it later:

```bash
docker compose up -d --build scanruler
docker compose down
```

## Development (hot reload)

Runs the Vite dev server with your source bind-mounted, so edits on the host
reload live in the browser.

```bash
docker compose --profile dev up --build dev
```

Then open <http://localhost:5173>. Your working tree is mounted into the
container; `node_modules` stays inside the container (a named volume) so the
host's OS and CPU architecture do not matter.

## Configuration

`VITE_FILES_URL` backs only the short-link file store (`/s/<name>`). The app
opens fine without a real one. To point at your own store:

```bash
# production build (baked in at build time)
VITE_FILES_URL=https://files.example.com/ docker compose up --build scanruler

# or as a build arg directly
docker build --build-arg VITE_FILES_URL=https://files.example.com/ -t scanruler:local .
```

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` (repo root) | Multi-stage: Node 22 builds `dist/`, nginx serves it. |
| `docker-compose.yml` (repo root) | `scanruler` (production) and `dev` (hot reload) services. |
| `docker/nginx.conf` | nginx config: SPA fallback, correct JS/WASM MIME types, gzip. |
| `docker/Dockerfile.dev` | Dev image running the Vite dev server. |
| `.dockerignore` (repo root) | Keeps the build context small. |

## The AI agent (MCP) server

The optional MCP server in [`mcp/`](../mcp/) lets an AI agent on your machine
drive the ScanRuler browser tab. It is not part of this web-app container: it
runs on your host next to your agent (Claude Code, Codex, etc.) and the browser
tab reaches it on `127.0.0.1`. Running it inside Docker would break that
loopback pairing, so install it the normal way — see
[`mcp/README.md`](../mcp/README.md) — for example:

```bash
claude mcp add --scope user scanruler -- npx -y scanruler-mcp@latest
```

## Notes

- The Vite build warns that one chunk is larger than 1500 kB. That is expected
  (the three.js + geometry bundle) and does not affect the build.
- The browser end-to-end tests (`npm run e2e:*`) need a real Chrome and are not
  part of this container; run them on the host per
  [`docs/development.md`](../docs/development.md).
