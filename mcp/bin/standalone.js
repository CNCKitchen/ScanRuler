// SPDX-License-Identifier: AGPL-3.0-only
// The entry of the single-executable build (scripts/bundle-agent.mjs). Launched by a person, with no arguments in a terminal, it starts the background server and opens the app in the browser; `start`, `open`, `status` and `stop` manage that server. Launched by an agent (stdio is a pipe) it is the MCP server: relaying through the background server to the open tab when one runs, otherwise running ScanRuler headless in the engine/ folder beside the executable. It skips the launcher (bin/scanruler-mcp.js) because a release of this build is replaced by downloading the next one, never by the npm updater.
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { openInBrowser } from '../src/browser.js'
import { pairingLink, start, status, stop } from '../src/daemon.js'
import { DEFAULT_PORT, main } from '../src/main.js'
import { NO_UPDATE_ENV } from '../src/update.js'

process.env[NO_UPDATE_ENV] = '1'
const here = dirname(process.execPath)
const appDir = join(here, 'app')
const engineFile = join(here, 'engine', 'engine.mjs')
const COMMANDS = new Set(['start', 'open', 'status', 'stop'])
const args = process.argv.slice(2)

/** The port from `--port`, SCANRULER_MCP_PORT or the default, as main() reads it. */
const portOf = (argv) => Number(parseArgs({ args: argv, options: { port: { type: 'string' } }, strict: false }).values.port ?? process.env.SCANRULER_MCP_PORT ?? DEFAULT_PORT)

const say = (line) => process.stdout.write(`${line}\n`)

async function command(name, argv) {
  const port = portOf(argv)
  if (name === 'status') {
    const state = await status({ port })
    say(state.running ? `Running: http://127.0.0.1:${state.port}/ (process ${state.pid}, ${state.version})` : `Not running (port ${port}).`)
    return state.running ? 0 : 1
  }
  if (name === 'stop') {
    say((await stop()) ? 'Stopped.' : 'Not running.')
    return 0
  }
  const started = await start({ executable: process.execPath, args: ['--serve', appDir], port })
  say(`${started.started ? 'Started' : 'Already running'}: http://127.0.0.1:${started.port}/ (process ${started.pid})`)
  if (name === 'open' && !(await openInBrowser(pairingLink(started.port)))) say(`Could not open a browser. Open ${pairingLink(started.port)} yourself.`)
  return 0
}

const [first, ...rest] = args
const name = COMMANDS.has(first) ? first : first === undefined && process.stdin.isTTY ? 'open' : undefined
if (name !== undefined) {
  command(name, rest).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[scanruler] ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
} else {
  const ownMode = args.some((arg) => arg === '--engine' || arg.startsWith('--engine=') || arg === '--headless' || arg === '--daemon')
  const run = async () => {
    if (!ownMode && !(await status({ port: portOf(args) })).running) args.unshift('--engine', engineFile)
    await main(args)
  }
  run().catch((error) => {
    process.stderr.write(`[scanruler-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
