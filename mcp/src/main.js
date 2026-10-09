// SPDX-License-Identifier: AGPL-3.0-only
// scanruler-mcp: an MCP server on stdio for an agent (Claude Code, Claude
// Desktop, Cursor …), and a WebSocket server on 127.0.0.1 for the ScanRuler
// page. The agent's tool calls go to the page and run there, in front of the
// user; the scan goes from this computer to the browser on it and nowhere
// else. Everything this prints goes to stderr — stdout is the MCP channel.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configDir, loadConfig, loadRemembered, saveRemembered } from './config.js'
import { originAllowed } from './link.js'
import { createMcpServer } from './mcp.js'
import { SharedLink } from './relay.js'
import { httpServer } from './serve.js'

export const DEFAULT_PORT = 7317
export const HOSTED_APP = 'https://scanruler.com/'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const HELP = `scanruler-mcp ${VERSION} — drive ScanRuler from an AI agent

Usage: scanruler-mcp [options]

  --port <n>             the port the ScanRuler page connects to (default ${DEFAULT_PORT})
  --out <dir>            where exported files go when a tool call names no path
                         (default: the folder the agent starts this in)
  --serve <dir>          also serve a built ScanRuler from <dir> at http://127.0.0.1:<port>/
  --allow-origin <url>   let a ScanRuler page from another origin connect (repeatable)
  --app <url>            the ScanRuler address the pairing link opens (default ${HOSTED_APP})
  --pair                 print the pairing token and link, and exit
  --help                 this

The pairing token is made on the first run and kept in ${join2(configDir(), 'config.json')};
SCANRULER_MCP_TOKEN overrides it. In ScanRuler: Settings → Agents → Local agent
connection, with the port and the token — or open the pairing link once.
`

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
      pair: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  })
  if (values.help) {
    process.stderr.write(HELP)
    return
  }
  const port = Number(values.port ?? process.env.SCANRULER_MCP_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port ${values.port} is not a port.`)
  const config = loadConfig()
  const token = process.env.SCANRULER_MCP_TOKEN || config.token
  const app = values.app ?? (values.serve ? `http://127.0.0.1:${port}/` : HOSTED_APP)
  const pairing = `${app.replace(/#.*$/, '')}#agent=${port}:${token}`
  const connectHelp = () =>
    `Open ScanRuler — ${app} — in Chrome or Edge and either open this pairing link once: ${pairing} — or in ScanRuler go to Settings → Agents, switch on "Local agent connection", and enter port ${port} and token ${token}.`
  if (values.pair) {
    process.stdout.write(`Port:  ${port}\nToken: ${token}\nLink:  ${pairing}\n`)
    return
  }

  const cwd = process.cwd()
  const outDir = values.out ? (values.out.match(/^([A-Za-z]:)?[\\/]/) ? values.out : `${cwd}/${values.out}`) : cwd
  const origins = values['allow-origin'] ?? []
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
    serverInfo: () => ({ name: 'scanruler-mcp', version: VERSION, port, role: link.role, outDir, config: config.file, ...(link.error ? { error: link.error } : {}) }),
    remembered: { load: () => loadRemembered(), save: (commands) => saveRemembered(commands) },
  })
  const transport = new StdioServerTransport()
  server.onclose = () => {
    link.close()
    process.exit(0)
  }
  await server.connect(transport)
  log(`Ready. ${connectHelp()}`)
}
