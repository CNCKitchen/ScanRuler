# Running ScanRuler in Docker

The image builds the app and serves the static result with nginx, unprivileged
on port 8080. Everything still runs in the browser: scans are never uploaded
to the container.

```bash
docker compose up -d --build      # then open http://localhost:8080
```

or without Compose:

```bash
docker build -t scanruler .
docker run --rm -p 8080:8080 scanruler
```

`SCANRULER_PORT=9000 docker compose up -d` publishes it on another port.

## Options

**Short links.** `/s/<name>` opens a file from a file store (see
[Opening a file from a link](manual.md#opening-a-file-from-a-link)). The image
is built without one, so it does not point into scanruler.com's store; give
your own at build time:

```bash
SCANRULER_FILES_URL=https://files.example.com/ docker compose up -d --build
# or: docker build --build-arg VITE_FILES_URL=https://files.example.com/ -t scanruler .
```

The store has to allow `GET` from your site's origin (CORS). `?open=<url>`
links work without it.

**HTTPS.** Put the container behind your reverse proxy (Caddy, Traefik, nginx)
for TLS; the container itself speaks plain HTTP. `GET /healthz` answers `ok`
for health checks.

## The agent connection

`scanruler-mcp` (see [mcp/README.md](../mcp/README.md)) is the bridge between
an AI agent and the ScanRuler tab in your browser. The agent starts it and
talks to it over stdin/stdout; the tab connects to it on port 7317. It is the
`scanruler-mcp` service in `docker-compose.yml`, which `up` leaves alone — the
agent starts it, in place of `npx`, so no Node is needed:

```bash
docker compose --profile mcp build
```

**Add it to the agent** (Claude Code shown; other agents take the same command
and arguments in their config). Give the compose file's full path, since the
agent starts it from a folder of its own:

```bash
claude mcp add --scope user scanruler -- docker compose \
  -f "$PWD/docker-compose.yml" run --rm -T --service-ports scanruler-mcp
```

`-T` keeps a terminal out of the MCP channel, `--service-ports` publishes the
port — to this computer only (`127.0.0.1:7317`). The pairing token is kept in
the `scanruler-mcp` volume. `~/ScanRuler` is mounted at the same path: it is
where exports land and the only place the server can read files from, so name
files to the agent by their full path inside it. `SCANRULER_FILES` (in your
environment or in `.env`) picks another folder.

**Pair the tab once:**

```bash
docker compose run --rm scanruler-mcp --pair
```

Open the link it prints (or enter the port and token in ScanRuler under
Settings → Agents → Local agent connection), and accept the warning the first
time.

Notes:

- The server cannot open a browser from inside the container, so
  `scanruler_open` fails; open ScanRuler yourself.
- The image does not update itself: `docker compose --profile mcp build` again.
- Only one copy can hold the port. An agent that starts the server twice
  (Claude Desktop does) gets a port error from the second start; the
  copies cannot share the tab as they do when run with `npx`.
- Without compose: `docker build -t scanruler-mcp mcp`, and have the agent run
  `docker run -i --rm --init -p 127.0.0.1:7317:7317 -v scanruler-mcp:/config
  scanruler-mcp --app http://localhost:8080/`, with a folder mounted as above.
- On your own domain, add `--allow-origin https://scanruler.example.com
  --app https://scanruler.example.com/` after the agent's command. Pages on
  `localhost` need nothing extra.
