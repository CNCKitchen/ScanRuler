# scanruler-mcp

Drive [ScanRuler](https://scanruler.com/), the browser tool for measuring 3D
scans, from an AI agent. This is a [Model Context Protocol](https://modelcontextprotocol.io)
server: the agent starts it and calls its tools; the ScanRuler tab open in
your browser connects to it over `127.0.0.1` and runs each call there, in
front of you. Every step the agent takes is one step of the tab's undo
history, so you can take any of it back.

Nothing goes anywhere but your own computer: the scan travels from your disk
to your browser through this server, as it does when you open it yourself.
What the agent reads — the figures, the report — goes to the agent's model
provider, like everything else it reads.

## Setting up

You need Node.js 20 or newer, and ScanRuler open in Chrome, Edge or Firefox.

### 1. Add the server to your agent

**Claude Code**

```bash
claude mcp add scanruler -- npx scanruler-mcp
```

Add `--scope user` to have it in every project. Exports the agent makes land
in the folder Claude Code was started in, unless the agent names a path.

**Claude Desktop** — Settings → Developer → Edit Config, then in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "scanruler": {
      "command": "npx",
      "args": ["scanruler-mcp", "--out", "/Users/you/Documents/ScanRuler"]
    }
  }
}
```

Claude Desktop starts servers in a folder of its own, so give `--out` a folder
for the exports, and name files to the agent by their full path. Quit Claude
Desktop after saving — File → Exit; closing the window leaves it running —
and start it again. It starts the server twice, for its chats and for its
Cowork and Code sessions; the copy that starts first holds the port and the
tab connects to it, and the other sends its calls through that one — see
*Several agents* below.

**Cursor** — `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all:

```json
{
  "mcpServers": {
    "scanruler": {
      "command": "npx",
      "args": ["scanruler-mcp"]
    }
  }
}
```

**From a clone of the ScanRuler repository**, before the package is on npm or
to try a change: run `npm --prefix mcp ci` once, then use
`node /path/to/scanruler/mcp/bin/scanruler-mcp.js` where the examples say
`npx scanruler-mcp` — in Claude Code,
`claude mcp add scanruler -- node /path/to/scanruler/mcp/bin/scanruler-mcp.js`.

### 2. Pair the ScanRuler tab with it

```bash
npx scanruler-mcp --pair
```

prints the port, the pairing token and a link. Open the link once in the
browser you use ScanRuler in — it switches the connection on with both — or
in ScanRuler go to ⚙ **Settings → Agents**, switch on **Local agent
connection**, and enter the port and the token. The token is made on the
first run and kept in your config folder (`%APPDATA%\scanruler-mcp` on
Windows, `~/Library/Application Support/scanruler-mcp` on macOS,
`~/.config/scanruler-mcp` elsewhere), so this is done once. You can also just
ask the agent: its `scanruler_status` tool hands out the same link.

A chip in ScanRuler's top bar says where the connection stands: **listening**
while the agent's server is not running, **connected**, or **turned away**
(a wrong token, or another tab connected already — the server takes one tab
at a time).

### Several agents

Any number of copies of the server can share the tab. The first to start
holds the port and the tab's connection; one that finds the port taken
connects to that one, with the same token, and sends its calls through it.
When the copy holding the port stops, another takes the port over, and the
tab — which keeps trying — connects to it within ten seconds.
`scanruler_status` says which this copy is (`server.role`: `holder`,
`relay`, or `none` with `server.error` saying why). Copies with different
tokens cannot share a port: give them the same `SCANRULER_MCP_TOKEN`, or
each its own `--port`. Changes from several agents run one after another in
the tab, each one step of the same undo history.

**Chrome and Edge** ask, the first time, whether scanruler.com may reach
"apps and services on this device". Allow it — that is this server. If you
denied it, allow *Local network access* for the site in the site settings
(the icon left of the address) and reload. **Firefox** asks the same.
**Safari** does not let a page from the web reach the computer it runs on at
all; use `--serve` below.

### Serving the app yourself

```bash
npx scanruler-mcp --serve /path/to/scanruler/dist
```

serves a built ScanRuler (`npm run build` in a clone) at
`http://127.0.0.1:7317/` from the same port the tab connects to — for Safari,
for working offline, and for the open-source build. A page from there needs
no browser permission, and `--pair` then gives a link to it.

## Options

| Option | |
|---|---|
| `--port <n>` | The port the tab connects to; 7317 unless given. Also `SCANRULER_MCP_PORT`. |
| `--out <dir>` | Where exports go when a tool call names no path; the folder the server was started in otherwise. |
| `--serve <dir>` | Also serve a built ScanRuler from `<dir>`. |
| `--allow-origin <url>` | Let a ScanRuler tab from another address connect — a self-hosted copy. Repeatable. scanruler.com and any page on this computer are always allowed. |
| `--app <url>` | The ScanRuler address the pairing link opens. |
| `--pair` | Print the port, the token and the pairing link, and exit. |
| `--help` | The options. |

`SCANRULER_MCP_TOKEN` overrides the stored token; `SCANRULER_MCP_CONFIG_DIR`
moves the config folder.

## Tools

Every command the ScanRuler tab offers is a tool, its name with dots turned
into underscores — `scan_open`, `element_fit`, `dimension_add`,
`report_get`, `history_undo` and the rest; their descriptions say what each
needs and returns. The list is the tab's while one is connected — a build
with more commands lists more. Before a tab is there it is the list of the
last tab that connected, which the server keeps in its config folder
(`tools.json`), or, the first time, the app's own; a client that lists the
tools once, when it starts, sees them all that way, and one that listens is
told when the list changes. Two more are the server's: `scanruler_status`
(is a tab connected, which version, how to pair one) and `scanruler_wait`
(until a tab is connected, or also idle).

- **Places on the scan** are `{ "point": [x, y, z] }` in millimetres — the
  scan vertex nearest it is taken — or `{ "vertex": n }`.
- **Files are paths.** `scan_open`, `deviation_open_reference`,
  `flat_open_image` and `project_load` take `path`, a file on this computer;
  the server reads it and streams it to the tab. The exports and
  `project_save` take an optional `path` — a file, or a folder for the name
  ScanRuler gives it — and the server writes the file there and returns where.
- **Pictures.** `view_render` comes back as an image the agent sees — the
  3D view as the tab shows it, after `view_set` has turned it if asked — and
  is written to a file only when the call gives `path`.
- **Results** are the session as the tab holds it afterwards, as JSON, in
  millimetres and degrees. A refusal comes back as an error with a code —
  `no_scan`, `busy`, `invalid_input`, `invalid_state` (something open in a
  panel is in the way), `not_found`, `failed`, `unavailable`.

A session might go: `scanruler_status`, `scan_open`, `session_state` (the
scan's bounding box says where the part lies), `element_fit` twice,
`dimension_add`, `report_get`, `view_render`.

## How it works

The tab connects to `ws://127.0.0.1:<port>/`. Before that, a tab from the web
fetches `http://127.0.0.1:<port>/scanruler-mcp`, which is what has Chrome and
Edge ask for the permission a WebSocket alone never asks for. The server lets
in a tab from scanruler.com, from this computer, or from an `--allow-origin`
address, that presents the pairing token — one tab at a time — and, beside
it, other copies of itself that present the token, whose requests it passes
to the tab (`src/relay.js`). Messages are
JSON; a file travels as a binary frame right after the JSON that announces it,
never as base64 (`src/framing.js`, and `src/commands/framing.ts` in the app).
Everything the server logs goes to stderr; stdout is the MCP channel.

## Development

```bash
npm ci
npm test        # node --test: framing, tool generation, the link, an MCP client end to end
```

The app's browser check `node scripts/e2e-agent.mjs` (from the repository
root, against a running dev server) drives the whole path with the SDK's own
MCP client. `src/commands.json` is the app's command list as of this version,
for listing the tools before a tab connects; the app's test
`tests/mcpCommands.test.ts` keeps it current
(`UPDATE_MCP_COMMANDS=1 npx vitest run tests/mcpCommands.test.ts`).

## Licence

AGPL-3.0-only, as ScanRuler — see [LICENSE](LICENSE).
