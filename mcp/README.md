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
provider, like everything else it reads. The server's one request of its own
asks npm, once a day, for its latest version (see *Staying current*).

## Setting up

You need [Node.js](https://nodejs.org/) 22 or newer, and Chrome, Edge or
Firefox.

### 1. Add the server to your agent

**Claude Code**

```bash
claude mcp add --scope user scanruler -- npx -y scanruler-mcp@latest
```

`--scope user` has it in every project; leave it out for this one only.
Exports the agent makes land in the folder Claude Code was started in,
unless the agent names a path.

**Codex** — the CLI, the IDE extension and the app share one setting:

```bash
codex mcp add scanruler -- npx -y scanruler-mcp@latest
```

or, in `~/.codex/config.toml`, with room for the first start (npx fetches the
package) and for long calls — Codex gives a server 10 seconds to start and a
call 60 unless told otherwise:

```toml
[mcp_servers.scanruler]
command = "npx"
args = ["-y", "scanruler-mcp@latest"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

**Claude Desktop** — Settings → Developer → Edit Config, then in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "scanruler": {
      "command": "npx",
      "args": ["-y", "scanruler-mcp@latest", "--out", "/Users/you/Documents/ScanRuler"]
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
      "args": ["-y", "scanruler-mcp@latest"]
    }
  }
}
```

**From a clone of the ScanRuler repository**, to try a change: run
`npm --prefix mcp ci` once, then use
`node /path/to/scanruler/mcp/bin/scanruler-mcp.js` where the examples say
`npx -y scanruler-mcp@latest` — in Claude Code,
`claude mcp add scanruler -- node /path/to/scanruler/mcp/bin/scanruler-mcp.js`.

### 2. Let the agent open ScanRuler

Ask the agent for something in ScanRuler — or just *"Connect to ScanRuler"*.
With no tab connected, it calls `scanruler_open`, which opens ScanRuler in
your default browser with the pairing in its address: the tab switches the
connection on with this server's port and token, and connects. The first
time, ScanRuler warns that what the agent reads goes to the agent and its model,
not only this computer, and connects once you accept. Then **Chrome and Edge**
ask whether scanruler.com may access "apps and services on this device" — allow
it, that is this server. **Firefox** asks the same. The tab keeps the pairing,
so this is done once per browser.

When the default browser is not the one you use ScanRuler in, or the agent
runs somewhere it cannot open one, pair by hand:

```bash
npx -y scanruler-mcp@latest --pair
```

prints the port, the pairing token and a link. Open the link once in the
browser you use ScanRuler in, or in ScanRuler go to ⚙ **Settings → Agents**,
switch on **Local agent connection**, and enter the port and the token. The
token is made on the first run and kept in your config folder
(`%APPDATA%\scanruler-mcp` on Windows,
`~/Library/Application Support/scanruler-mcp` on macOS,
`$XDG_CONFIG_HOME/scanruler-mcp` elsewhere, `~/.config/scanruler-mcp`
without it). `scanruler_status` hands out the same
link.

A chip in ScanRuler's top bar says where the connection stands: **listening**
while the agent's server is not running, **connected**, or **turned away**
(a wrong token, or another tab connected already — the server takes one tab
at a time). If you denied the browser's question, allow *Local network
access* for the site in the site settings (the icon left of the address) and
reload. **Safari** does not let a page from the web reach the computer it
runs on at all; use `--serve` below.

### Staying current

With `@latest` in the setting, npx asks npm for the newest version at every
start and fetches it when there is one, so quitting the app and opening it
again updates the server. Offline, npx starts the copy it has; on a network
that turns connections away rather than having none, it tries for about a
minute first. (npm 9.7 and newer treat a bare `scanruler-mcp` the same way.)

The server also keeps itself current — for a setting without `@latest` on an
older npm, or a copy installed with `npm install -g`. Once a day, in the
background, it asks npm's registry (registry.npmjs.org, or the one npm is set
to) for its latest version: that one request, given 2 seconds. When there is
a newer one, npm fetches it into its cache, and the next start runs it in
place of the old copy, without waiting on the network. What it found is kept
in `update.json` in the config folder, and `scanruler_status` says it:
`server.version`, `server.latest`, and `server.handedOffFrom` when an older
copy started this one. A version pinned in the setting
(`scanruler-mcp@0.4.0`) is left as it is, and so is a copy run from a clone
of the repository. To turn it off: `--no-update`, or
`SCANRULER_MCP_NO_UPDATE=1`.

When ScanRuler shows **Your ScanRuler connector is out of date**, the server
your app starts is older than the page needs: ask your agent to update it, with
the sentence the banner gives you to paste, or change the setting to the
`@latest` line it shows. Then quit the app completely — not just its window —
and open it again.

### Several agents

Any number of copies of the server can share the tab. The first to start
holds the port and the tab's connection; one that finds the port taken
connects to that one, with the same token, and sends its calls through it.
When the copy holding the port stops, another takes the port over, and the
tab — which keeps trying — connects to it within ten seconds.
`scanruler_status` says which this copy is (`server.role`: `holder`,
`relay` — with the holding copy's version as `server.holder.version` —, or
`none` with `server.error` saying why). The page judges the copy holding
its connection: when that one is out of date, a relaying copy's status says
so, and quitting the app that started it lets a current copy take over. Copies with different
tokens cannot share a port: give them the same `SCANRULER_MCP_TOKEN`, or
each its own `--port`. Changes from several agents run one after another in
the tab, each one step of the same undo history.

### Serving the app yourself

```bash
npx -y scanruler-mcp@latest --serve /path/to/scanruler/dist
```

serves a built ScanRuler (`npm run build` in a clone) at
`http://127.0.0.1:7317/` from the same port the tab connects to — for Safari,
for working offline, and for your own build. A page from there needs
no browser permission, and `--pair` then gives a link to it.

### Without a browser (headless)

```bash
npm run build:engine                       # in a clone of ScanRuler
npx -y scanruler-mcp@latest --engine /path/to/scanruler/dist-engine/engine.mjs
```

runs ScanRuler itself inside the server, with no browser and no tab: the
engine is a build of the app for Node, `dist-engine/engine.mjs`, which the
server loads from where it is and names nothing in. `--headless` takes the
engine built in the checkout the server is part of; `SCANRULER_ENGINE` gives
a path as `--engine` does. There is no scan, no viewport and nobody
watching, so only the commands that run without a page are tools —
`session_state` and `history_undo`/`history_redo` in the app itself, and
whatever a build of ScanRuler marks to run so; a tool that needs the page
(`view_render`, `scan_open` …) answers `unavailable`, naming the page mode.
Files still go by `path`. The server's instructions say it runs headless,
`scanruler_status` says `backend: "headless"` and where the engine is, and
`scanruler_open` has nothing to open. Each server is a session of its own —
an agent's subagents can each start one and work side by side, sharing
nothing — and what the app logs goes to stderr with the server's own lines.
`--tools compact` works headless too: the server's own tools are listed, and
the engine's are read through `scanruler_tools` and run through
`scanruler_batch` (see *Small local models*).
### Small local models

Listed in full, every command the tab offers is a tool of its own: over a
hundred tools and 50k tokens of schema, all read before the conversation starts. A
frontier model takes that in its stride. A local model with a 128k window
runs out of room within a few tool rounds, and picks less reliably among so
many. For such a model, start the server with `--tools compact` (or set
`SCANRULER_MCP_TOOLS=compact`). It then lists about a dozen tools, a few
thousand tokens: the server's six, `scanruler_tools`, and the tab's tools
that return a picture — `view_render`, `section_render`, `flat_render` and
`scan_heightmap`.

- `scanruler_tools` with no arguments lists the tab's tools, a name and a
  line each, about 1.5k tokens for a hundred. With `names` it gives those
  tools' full definitions, as the full list has them, up to 20 at a time.
  Names it does not know come back in `unknown`.
- The model runs the tools through `scanruler_batch`, one call as a batch of
  one. A refused call comes back with the tab's error code and what was
  wrong, so the model can try again with corrected arguments. A client that
  lets the model call a tool it was not given can call them directly too.
- The tools that return a picture are listed so the model calls them
  directly and sees the picture. In a batch a picture is not shown: it is
  written to a file, the call's `path` or a new file in `scanruler-work` in
  the open scan's folder (the output folder, `--out`, while no scan or
  project was opened from one), and the call's result names it and the
  folder. A tab that connects with
  another picture tool has the client list the tools again.

**LM Studio**: add `--tools` and `compact` to the server's arguments as two
separate entries. In `mcp.json`:

```json
{
  "mcpServers": {
    "scanruler": {
      "command": "npx",
      "args": ["-y", "scanruler-mcp@latest", "--tools", "compact"]
    }
  }
}
```

**Codex** with a local model:

```bash
codex mcp add scanruler -- npx -y scanruler-mcp@latest --tools compact
```

or `args = ["-y", "scanruler-mcp@latest", "--tools", "compact"]` in
`~/.codex/config.toml`.

### Fewer tools

An agent whose task stays in one or two workspaces carries the tools of
every other in each turn. `--tools` also takes namespaces — the part of a
tool's name before its first underscore: `scan`, `section`, `view`,
`element`, `align`, `deviation`, `flat`, `thickness`, `dimension`, `export`,
`session`, `guide`, `project`, `history`, `report`, `workspace`, and what a
connected tab adds. Written with a leading `-` each, they are the namespaces
to leave out: `--tools=-flat,-thickness,-dimension` (with the `=`: a value
starting with a dash is refused otherwise) lists everything but the
2D sheet, the wall thickness and the dimension tools. Written plain, they are
the namespaces to list: `--tools scan,element,view,session,guide` and nothing
else. The two forms do not mix, and the server's own tools (`scanruler_*`)
are listed either way, every listed command a tool of its own as in `full`.
The list is fixed when the server starts and never changes mid-chat, so
give it to the agent whose work is known — in the agent's config, or
`SCANRULER_MCP_TOOLS=-flat,-thickness,-dimension`. A tool left out is
unknown to the client: it is not listed, and a call to it by name answers
`unknown_command`. A namespace the tab does not have is accepted — a tab
may add one — and the server says so on its stderr when a tab connects.

## Options

| Option | |
|---|---|
| `--port <n>` | The port the tab connects to; 7317 unless given. Also `SCANRULER_MCP_PORT`. |
| `--out <dir>` | Where exports go when a tool call names no path; the folder the server was started in otherwise. |
| `--serve <dir>` | Also serve a built ScanRuler from `<dir>`. |
| `--allow-origin <url>` | Let a ScanRuler tab from another address connect — a self-hosted copy. Repeatable. scanruler.com and any page on this computer are always allowed. |
| `--app <url>` | The ScanRuler address the pairing link opens. |
| `--engine <file>` | Run ScanRuler headless in the server, from an engine built with `npm run build:engine` — no tab. Also `SCANRULER_ENGINE`. |
| `--headless` | The same, with the engine built in the checkout the server is part of. |
| `--tools <mode>` | `full`, the default: every command the tab offers is a tool. `compact`: the server's own and the tab's tools that return a picture; the rest are read through `scanruler_tools` and run through `scanruler_batch` — see *Small local models*. Or namespaces, comma-separated — the part of a tool's name before its first underscore: `scan,element,view` lists those alone, `-flat,-thickness,-dimension` all but those, the server's own tools either way — see *Fewer tools*. Also `SCANRULER_MCP_TOOLS`. |
| `--trace <dir>` | Write a line per tool call — tool, ms, bytes each way, error, whether the tab was hidden — into a new file in `<dir>`, for measuring a run; off unless given. `scripts/trace-summary.mjs` in the ScanRuler repository sums a run up. Also `SCANRULER_MCP_TRACE`. |
| `--trace-args` | With `--trace`, each call's arguments too; otherwise only their size. |
| `--answer-within <s>` | Hold a call at most this many seconds, 45 unless given: a change, a batch or a long read still running then answers `{ queued: true, job, after }` and runs on, and `scanruler_wait` waits no longer either. A client, or a bridge between it and this computer, may cut a call at a minute; a cut call says nothing. `0` holds every call to its end. Also `SCANRULER_MCP_ANSWER_WITHIN`. |
| `--no-update` | Do not keep the server current (see *Staying current*). Also `SCANRULER_MCP_NO_UPDATE=1`. |
| `--pair` | Print the port, the token and the pairing link, and exit. |
| `--version` | Print the server's version, and exit. |
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
told when the list changes. Seven more are the server's: `scanruler_status`
(is a tab connected, which version, how to pair one, what the tab's
session holds — its scan, project, unsaved changes and work counted — the
time on this computer with its offset from UTC (`server.now`), and,
when the client's list is out of date, which tools were added, removed or
changed since and which page it came from),
`scanruler_open` (open ScanRuler in the default browser, paired, and wait
for it), `scanruler_wait` (until a tab is connected, or also idle),
`scanruler_batch` (several of the tab's tools in one call, in order — a run
of `scan_nearest` or `element_fit` calls — each answer in its place, stopped
at the first refused unless told to go on), `scanruler_write` (a text
file — `.md`, `.txt`, `.csv` or `.json`, a report say — written in the folder
the server last opened a scan or a project from, and nowhere else: not into
hidden folders, and not as a file agents and tools take instructions or
settings from, such as `CLAUDE.md`, `AGENTS.md` or `package.json`) and
`scanruler_files` (that folder's files — name, size, kind — newest first), `scanruler_read` (a text file there, or an answer too long to carry wherever it was written, in parts: `{ text, offset, nextOffset, size }`, in bytes).
The folders are kept beside `tools.json` (`folders.json`), so a server
started afresh still writes and lists there, and `scanruler_status` lists
them. With `--tools compact` only the tab's tools that return a picture are
listed; the rest are read through an eighth of the server's own,
`scanruler_tools` — see *Small local models*. With `--tools` and a list of
namespaces, only the tab's tools of those namespaces, or all but those — see
*Fewer tools*.

- **Places on the scan** are `{ "point": [x, y, z] }` in millimetres — the
  scan vertex nearest it is taken — or `{ "vertex": n }`. `scan_query` reads
  the scan's own points: the vertices in a box or about a point, with their
  normals, facing a way if asked; `section_get` a section's cut as
  polylines, on the sheet and in the world.
- **Files are paths.** `scan_open`, `deviation_open_reference`,
  `flat_open_image` and `project_load` take `path`, a file on this computer;
  the server reads it and streams it to the tab. The exports and
  `project_save` take an optional `path` — a file, or a folder for the name
  ScanRuler gives it — and the server writes the file there and returns where.
  `scan_open` and `project_load` take a folder too, and open the one mesh,
  or the one `.scanruler`, in it; with none or several the answer lists what
  is there.
  A tool that replaces the session (`scan_open`, `project_load`,
  `session_reset`) takes `saveTo`: the session is saved as a project file
  there first, then replaced — one call to keep what a tab someone left
  holds.
- **Arguments from a file.** `{ "$file": path }` anywhere in a tool's
  arguments — an object of that one key — is replaced by the JSON the file
  holds: a long list of stations a script wrote need not pass through the
  conversation.
- **Relative paths** — a batch's `file`, `$file`, a file to open, an
  output's `path` — are taken from the open scan's folder, or from the folder
  the server was started in while no scan is open; `scanruler_status` gives
  both (`server.relativeTo`, `server.cwd`). A picture or file written into a
  folder is numbered past one already there (`-2`, `-3`), never written over.
- **Long answers.** An answer past what one carries (40 k characters; a
  guide 90 k — several guides asked for together come while they fit about
  80 k, the rest named in `next`) is written whole to a JSON file in
  `scanruler-work` in the open scan's folder — the server's own files, apart
  from the person's, where an agent that may only read there can open it —
  in the output folder (`--out`) while the scan open now was not opened from
  a folder through this server. The answer says
  `truncated: true`, the `file`, its short fields and the person's notes,
  and its `note` says which folder it went to and how to ask for less — by
  the command's own fields, as the command says it (a guide a section at a
  time).
- **Strings of JSON.** A client that sends a large nested value as a string
  — a batch's `calls`, a call in it, or a call's `arguments` — has it read as
  the JSON it holds; one that is not JSON is refused saying so, with nothing
  run.
- **A tab that reloaded.** A tab says who it is each time it loads. When a
  tab that held work comes back as another — reloaded by the person, by the
  dev server after an edit, or unloaded by the browser — the next answer
  says so (`pageReloaded`), with the project file last opened or saved here,
  which `scanruler_status` gives too (`lastProject`, kept in
  `folders.json`). A tab older than the app it came from, which could not
  load a part of it, answers `stale_page`, and the status says so from then
  on (`page.stale`): save the project before the tab is reloaded.
- **Pictures.** `view_render` comes back as an image the agent sees — the
  3D view as the tab shows it, after `view_set` has turned it if asked — and
  is written to a file only when the call gives `path`. `show` puts the
  scan, the reference, the sections, the elements or the labels away for
  the picture (`{ "scan": false }` shows what was built on the scan on its
  own; a workspace adds keys of its own, which `view_set` lists), and
  `frame` looks at a box or a place closely. `flat_render` is the 2D sheet's:
  drawn as the sheet lies, with a grid ruled in millimetres and its values
  at the margins, and a `map` from picture pixels to sheet places, so a
  place read off the picture goes straight back as a place to click.
  `section_render` pictures a section — or any plane, cut for the picture
  alone — on its own sheet in millimetres: the scan's cut as points, what
  the workspaces draw over it (a model's cut, a sketch's pieces with their
  ids), and every point further than the tolerance from the model in red,
  counted in the answer with the box round them.
- **The 2D sheet** takes places as `[x, y]` in its own millimetres (pixels
  before any scale), origin at the image's bottom-left corner, y up. An edge
  is named by its chain number — `flat_edges` lists them, `flat_render`
  writes them beside the edges, `flat_fit` takes them as `chains` — and a
  pick answers where it snapped. `flat_objects` finds the separate parts on
  an image and measures them; `flat_profile` reads an outline round a centre
  or along an axis and counts its peaks — a knurl's teeth, say.
- **Batches stand or fall whole.** `scanruler_batch` stops at the first
  refused call — the answer names `failed: { index, tool, error }`. When
  that call is a change, `rollback` (the default) undoes what the calls
  before it changed, once the tab is idle: `undone` lists the steps taken
  back, newest first (`history_checkpoint` and `history_restore` do the same
  by hand across several calls). A refused read — a `section_get` of a
  section that is not there — undoes nothing, and `kept` says what came
  before it stands. A call refused `busy` (the tab working out something of
  its own) is run again once, when the tab is idle, and says
  `retried: "busy"`. `timings:
  true` gives each call its `ms`, the batch its `total_ms`, and a change's
  build the steps it played with their milliseconds (`result.steps.played`;
  otherwise only how many it played and took up from a state held). The
  notes left for the agent (`notes`), when a call answers with them, are
  repeated at the batch's top as the last call gave them.
- **Long changes.** Every tool that changes the session takes `wait`, and
  so does a read the tab marks long (a comparison over whole bodies, say);
  `wait: false` answers at once with `{ queued: true, job }` while the call
  runs on, a batch too, and `scanruler_wait { for: "job", job }` gives its
  answer when it is done. Still running at the answer limit
  (`--answer-within`, 45 s), a call answers the same way with `after`, its
  seconds; `scanruler_wait` waits no longer than that either and answers
  `state: "running"` — call it again. The server keeps every change as a
  job, so a call the client stopped waiting for keeps running and keeps its
  answer: `scanruler_status` lists the latest jobs, running, done or failed.
  The tab keeps a record of the commands run under each job too
  (`session_recent`, the last hundred), so a server started afresh — whose
  own jobs are gone — still answers `scanruler_wait` for a job of the copy
  before it, from that record (`from` says so).
  `scanruler_wait { for: "idle" }` waits for the changes still running too,
  and answers `finished`: every change done or failed since it last said —
  a failed one with its error, a batch with the call it stopped at — each
  once, so a run of `wait: false` changes is read back in one call, and
  `state`: `idle`, or `running` when the limit came first. A
  change called on its own takes `timings: true` as well: its answer adds
  the call's `ms` and the steps its build played. The tab answers what only
  reads — `session_state` — while a change runs.
- **A hidden tab.** A tab in the background, a covered or minimised window
  or a locked screen is hidden to the browser, which then draws no frames
  and slows timers to once a minute. Changes still run, and the waits a
  command makes — for the session to settle, for the screen to follow —
  look again on every change the session's stores see and draw their own
  frames, so pictures still come. `scanruler_status` says `page.hidden`,
  with a note: a browser that unloads background tabs (Chrome's Memory
  Saver) may close it — keep the site among those always kept active.
- **Results** are the session as the tab holds it afterwards, as JSON, in
  millimetres and degrees, every number that is not whole kept to six
  significant digits — except in an answer whose numbers are handed back
  as inputs (a plane's frame, say), which keeps every digit. A refusal comes back as an error with a code —
  `no_scan`, `busy`, `invalid_input`, `invalid_state` (something open in a
  panel is in the way), `not_found`, `failed`, `unavailable`.

A session might go: `scanruler_status`, `scanruler_open` if no tab is
connected, `scan_open`, `session_state` (the scan's bounding box says where
the part lies), `element_fit` twice, `dimension_add`, `report_get`,
`view_render`.

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
