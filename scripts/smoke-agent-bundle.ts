// SPDX-License-Identifier: AGPL-3.0-only
// Exercise the bundled executable (npm run bundle:agent) the two ways it is used, in a config directory and on a port of its own. As an agent starts it, over stdio: it reports itself headless and connected, adds a parameter and reads it back. As a person manages it: start the background server, fetch the app it serves, see it running, let an agent's stdio copy relay through it, stop it, see it gone. Fails loudly if the executable, the engine or app beside it, or the CAD kernel's WebAssembly does not load.
//
//   npm run smoke:agent

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A stdio copy decides whether it holds the port or relays through the holder after its first look at the port, so its status says role "none" until then; a few seconds without a decision is a wedged link, not a slow one. */
const ROLE_SETTLE_TIMEOUT_MS = 10_000
const ROLE_SETTLE_POLL_MS = 200

const root = fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(join(root, 'mcp', 'node_modules', '@modelcontextprotocol'))) {
  console.error('FATAL: the MCP server has no dependencies yet. Run npm --prefix mcp ci.')
  process.exit(1)
}
const { Client } = await import('../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')
const { StdioClientTransport } = await import('../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')

const exe = join(root, 'dist-agent', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'scanruler-agent.exe' : 'scanruler-agent')
if (!existsSync(exe)) {
  console.error(`FATAL: ${exe} does not exist. Run npm run bundle:agent first.`)
  process.exit(1)
}

/** A tool call's reply holds its answer in a text block. */
function isText(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
}

/** The value at `path` in a parsed JSON answer, or undefined where the answer has no such member. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

/** A port nobody holds: the OS hands one out when asked for port 0, and it is given back at once. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the probe server has no port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

const port = await freePort()
const configDir = await mkdtemp(join(tmpdir(), 'scanruler-smoke-'))
const env = { ...process.env, SCANRULER_MCP_CONFIG_DIR: configDir, SCANRULER_MCP_PORT: String(port) }

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`)
  console.log(`PASS: ${what}`)
}

interface Managed {
  readonly code: number
  readonly stdout: string
}

/** Runs a management command of the executable; its exit code and output, whatever the code. */
async function manage(...args: string[]): Promise<Managed> {
  try {
    const { stdout } = await run(exe, args, { env, timeout: 60_000 })
    return { code: 0, stdout }
  } catch (error) {
    const code = at(error, 'code')
    const stdout = at(error, 'stdout')
    return { code: typeof code === 'number' ? code : -1, stdout: typeof stdout === 'string' ? stdout : '' }
  }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>

/** An agent's stdio copy of the server, calling tools and ending. */
async function asAgent<T>(work: (call: Call) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'scanruler-bundle-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: exe, args: [], env, stderr: 'inherit' }))
  const call: Call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const content: unknown = reply.content
    const text = Array.isArray(content) && isText(content[0]) ? content[0].text : ''
    if (reply.isError === true) throw new Error(`${name} failed: ${text}`)
    const parsed: unknown = JSON.parse(text)
    return parsed
  }
  try {
    return await work(call)
  } finally {
    await client.close()
  }
}

try {
  await asAgent(async (call) => {
    const status = await call('scanruler_status')
    check(at(status, 'backend') === 'headless' && at(status, 'connected') === true, 'an agent with no background server runs ScanRuler headless')
    const added = await call('reverse_parameter_add', { name: 'l1', expression: '12' })
    check(at(added, 'parameter', 'value') === 12, 'the headless engine adds a parameter')
    check(JSON.stringify(await call('reverse_parameter_list')).includes('"l1"'), 'and reads it back')
  })

  check((await manage('status')).code === 1, 'status says not running before a start')
  const started = await manage('start')
  check(started.code === 0 && started.stdout.includes('Started'), `start brings the background server up on port ${port}`)
  const page = await fetch(`http://127.0.0.1:${port}/`)
  check(page.ok && (await page.text()).includes('<title>ScanRuler'), 'the background server serves the app')
  check((await manage('start')).stdout.includes('Already running'), 'a second start finds it instead of starting another')
  check((await manage('status')).code === 0, 'status says running')
  await asAgent(async (call) => {
    let status = await call('scanruler_status')
    for (let waited = 0; at(status, 'server', 'role') === 'none' && waited < ROLE_SETTLE_TIMEOUT_MS; waited += ROLE_SETTLE_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, ROLE_SETTLE_POLL_MS))
      status = await call('scanruler_status')
    }
    check(at(status, 'backend') === 'page' && at(status, 'server', 'role') === 'relay', 'an agent started while it runs relays through it to the open tab')
  })
  check((await manage('stop')).stdout.includes('Stopped'), 'stop ends it')
  check((await manage('status')).code === 1, 'status says not running after the stop')
  console.log(`PASS: ${exe}`)
} finally {
  await manage('stop')
  await rm(configDir, { recursive: true, force: true })
}
