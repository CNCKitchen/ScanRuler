// SPDX-License-Identifier: AGPL-3.0-only
// scanruler-mcp: an MCP server on stdio for an agent (Claude Code, Claude
// Desktop, Cursor …), and a WebSocket server on 127.0.0.1 for the ScanRuler
// page. The agent's tool calls go to the page and run there, in front of the
// user; the scan goes from this computer to the browser on it and nowhere
// else. Everything this prints goes to stderr — stdout is the MCP channel.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { format, parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openInBrowser } from './browser.js'
import { configDir, loadConfig, loadFolders, loadLastProject, loadRemembered, saveFolders, saveLastProject, saveRemembered } from './config.js'
import { CHECKOUT_ENGINE, EngineLink, loadEngine } from './engine.js'
import { originAllowed, originOf } from './link.js'
import { ANSWER_WITHIN_MS, createMcpServer, parseToolMode } from './mcp.js'
import { SharedLink } from './relay.js'
import { createTrace } from './trace.js'
import { httpServer } from './serve.js'
import { NO_UPDATE_ENV, startUpdates, watchParent } from './update.js'

const DEFAULT_PORT = 7317
const HOSTED_APP = 'https://scanruler.com/'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const HELP = `scanruler-mcp ${VERSION} — drive ScanRuler from an AI agent

Usage: scanruler-mcp [options]

  --port <n>             the port the ScanRuler page connects to (default ${DEFAULT_PORT})
  --out <dir>            where exported files go when a tool call names no path
                         (default: the folder the agent starts this in)
  --serve <dir>          also serve a built ScanRuler from <dir> at http://127.0.0.1:<port>/
  --allow-origin <url>   let a ScanRuler page from another origin connect (repeatable)
  --app <url>            the ScanRuler address the pairing link opens (default ${HOSTED_APP})
  --engine <file>        run ScanRuler headless in this process, from an engine built
                         with "npm run build:engine" (SCANRULER_ENGINE) — no browser,
                         no page: modelling and files only
  --headless             the same, with the engine built in the ScanRuler checkout
                         this server is part of
  --tools <mode>         full (the default) lists each of ScanRuler's commands as a tool;
                         compact lists the server's own and the commands that return a
                         picture, the rest read through scanruler_tools and run through
                         scanruler_batch — for a small context window; or namespaces,
                         comma-separated — the part of a tool's name before its first
                         underscore — to list alone (scan,element,view) or, each with a
                         leading -, to leave out (-flat,-thickness,-dimension): the
                         server's own tools either way, the rest as full lists them,
                         for an agent whose task stays in one or two workspaces
  --trace <dir>          write a line per tool call — tool, ms, bytes each way, error,
                         whether the tab was hidden — to a new file in <dir>, for
                         measuring a run (scripts/trace-summary.mjs in the ScanRuler
                         repository sums it up); off by default
  --trace-args           with --trace, also write each call's arguments and the head of its answer (otherwise
                         only their size)
  --answer-within <s>    hold a call at most this many seconds (default ${ANSWER_WITHIN_MS / 1000}): a change,
                         a batch or a long read still running then answers with its job
                         and runs on, and scanruler_wait waits no longer — under the
                         minute a client or a bridge may cut a call at; 0 holds a call
                         to its end
  --no-update            do not keep this server current (${NO_UPDATE_ENV}=1)
  --pair                 print the pairing token and link, and exit
  --version              print this server's version, and exit
  --help                 this

Once a day, in the background, the server asks npm's registry for its latest
version; when there is a newer one, npm fetches it, and the next start runs it
in this one's place. Not for a copy run from a git checkout, a version pinned
in the agent's config (scanruler-mcp@0.4.0), or with --no-update.

The pairing token is made on the first run and kept in ${join2(configDir(), 'config.json')};
SCANRULER_MCP_TOKEN overrides it. SCANRULER_MCP_PORT, SCANRULER_MCP_TOOLS,
SCANRULER_MCP_TRACE and SCANRULER_MCP_ANSWER_WITHIN stand in for --port, --tools,
--trace and --answer-within. The agent's scanruler_open tool opens ScanRuler
in the default browser, paired. By hand: open the pairing link once, or in
ScanRuler go to Settings → Agents → Local agent connection and enter the port
and the token.
`

/** ScanRuler run in this process from the engine at `file`, in place of
 *  the page — no port, no pairing. */
async function headless(file, { cwd, outDir, tools, trace, answerWithinMs, updates }) {
  // stdout is the MCP channel, the transport's alone: whatever else writes
  // to it — the app's logging, the kernel's own reports — goes to stderr.
  const stdout = process.stdout
  const write = stdout.write.bind(stdout)
  const channel = { write, once: (event, listener) => stdout.once(event, listener) }
  stdout.write = (...args) => process.stderr.write(...args)
  for (const name of ['log', 'info', 'warn', 'debug']) console[name] = (...args) => process.stderr.write(`${format(...args)}\n`)
  const engine = await loadEngine(file)
  const link = new EngineLink(engine, file)
  log(`Running ScanRuler ${engine.version} headless from ${file}, with ${link.page.commands.length} commands.`)
  const server = createMcpServer({
    link,
    version: VERSION,
    cwd,
    outDir,
    connectHelp: () => 'This server runs ScanRuler headless, in its own process; no page connects to it.',
    serverInfo: () => ({ name: 'scanruler-mcp', version: VERSION, ...updates.info(), backend: 'headless', engine: file, tools, outDir, ...(trace ? { trace: trace.file } : {}) }),
    remembered: null,
    tools,
    log,
    trace,
    answerWithinMs,
  })
  server.onclose = () => {
    link.close()
    process.exit(0)
  }
  await server.connect(new StdioServerTransport(process.stdin, channel))
  log('Ready, headless.')
}

function join2(a, b) {
  return `${a}${a.includes('\\') ? '\\' : '/'}${b}`
}

const log = (line) => process.stderr.write(`[scanruler-mcp] ${line}\n`)

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      out: { type: 'string' },
      serve: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true },
      app: { type: 'string' },
      engine: { type: 'string' },
      headless: { type: 'boolean' },
      tools: { type: 'string' },
      trace: { type: 'string' },
      'trace-args': { type: 'boolean' },
      'answer-within': { type: 'string' },
      'no-update': { type: 'boolean' },
      pair: { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  })
  if (values.help) {
    process.stderr.write(HELP)
    return
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  const port = Number(values.port ?? process.env.SCANRULER_MCP_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port ${values.port} is not a port.`)
  // full, compact, or namespaces; refused here when mixed or empty, kept
  // as given for the status to report.
  const tools = parseToolMode(values.tools ?? (process.env.SCANRULER_MCP_TOOLS || 'full'), values.tools === undefined ? 'SCANRULER_MCP_TOOLS' : '--tools').text
  const within = values['answer-within'] ?? process.env.SCANRULER_MCP_ANSWER_WITHIN
  const answerWithinMs = within === undefined || within === '' ? ANSWER_WITHIN_MS : Number(within) * 1000
  if (!Number.isFinite(answerWithinMs) || answerWithinMs < 0) {
    throw new Error(`${values['answer-within'] === undefined ? 'SCANRULER_MCP_ANSWER_WITHIN' : '--answer-within'} ${within} is not a number of seconds.`)
  }
  const config = loadConfig()
  const token = process.env.SCANRULER_MCP_TOKEN || config.token
  const app = values.app ?? (values.serve ? `http://127.0.0.1:${port}/` : HOSTED_APP)
  const pairing = `${app.replace(/#.*$/, '')}#agent=${port}:${token}`
  const connectHelp = () =>
    `Open ScanRuler — ${app} — in Chrome, Edge or Firefox and either open this pairing link once: ${pairing} — or in ScanRuler go to Settings → Agents, switch on "Local agent connection", and enter port ${port} and token ${token}. The first time, ScanRuler warns that what the agent reads goes to the agent and its model, and connects only once the warning is accepted.`
  if (values.pair) {
    process.stdout.write(`Port:  ${port}\nToken: ${token}\nLink:  ${pairing}\n`)
    return
  }

  // Kept current in the background (update.js); a copy handed to stops
  // with the launcher that started it.
  const updates = startUpdates({ version: VERSION, argv })
  watchParent()
  const cwd = process.cwd()
  const outDir = values.out ? (values.out.match(/^([A-Za-z]:)?[\\/]/) ? values.out : `${cwd}/${values.out}`) : cwd
  const traceDir = values.trace ?? process.env.SCANRULER_MCP_TRACE
  const trace = traceDir ? createTrace(resolve(cwd, traceDir), { args: values['trace-args'] === true }) : null
  if (trace) log(`Tracing every call to ${trace.file}${trace.args ? ', arguments too' : ''}.`)
  const engineFile = values.engine ?? process.env.SCANRULER_ENGINE ?? (values.headless ? CHECKOUT_ENGINE : null)
  if (engineFile) return headless(resolve(cwd, engineFile), { cwd, outDir, tools, trace, answerWithinMs, updates })
  const origins = (values['allow-origin'] ?? []).map((url) => {
    // A value that is no URL would silently never match, so it is refused.
    const origin = originOf(url)
    if (!origin) throw new Error(`--allow-origin ${url} is not a URL.`)
    return origin
  })
  const http = httpServer({ serve: values.serve, allowOrigin: (origin) => originAllowed(origin, origins), version: VERSION })
  // The port, or — when another copy holds it — the relay through that one.
  const link = new SharedLink({ http, port, token, version: VERSION, origins, log })
  link.on('role', (role) =>
    log(role === 'holder'
      ? `Listening for the ScanRuler page on ws://127.0.0.1:${port}/${values.serve ? `, serving ${values.serve} at http://127.0.0.1:${port}/` : ''}.`
      : `Port ${port} is held by another scanruler-mcp; this one sends its calls through it.`),
  )
  link.start()

  const server = createMcpServer({
    link,
    version: VERSION,
    cwd,
    outDir,
    connectHelp: () => (link.error ? `${link.error} ` : '') + connectHelp(),
    serverInfo: () => ({ name: 'scanruler-mcp', version: VERSION, ...updates.info(), port, role: link.role, ...(link.role === 'relay' ? { holder: { version: link.holderVersion ?? null } } : {}), tools, outDir, config: config.file, ...(trace ? { trace: trace.file } : {}), ...(link.error ? { error: link.error } : {}) }),
    remembered: { load: () => loadRemembered(), save: (commands) => saveRemembered(commands) },
    folderStore: { load: () => loadFolders(), save: (folders) => saveFolders(folders), loadProject: () => loadLastProject(), saveProject: (project) => saveLastProject(project) },
    openPage: () => openInBrowser(pairing),
    tools,
    log,
    trace,
    answerWithinMs,
  })
  const transport = new StdioServerTransport()
  server.onclose = () => {
    link.close()
    process.exit(0)
  }
  await server.connect(transport)
  log(`Ready. ${connectHelp()}`)
}
