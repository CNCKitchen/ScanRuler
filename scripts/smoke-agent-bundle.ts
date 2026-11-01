// SPDX-License-Identifier: AGPL-3.0-only
// Start the bundled agent executable (npm run bundle:agent) as an MCP client does, over stdio, and have it do real work in the engine it ships with: report its status as headless and connected, then add a parameter and read it back. Fails loudly if the executable, the engine beside it or the CAD kernel's WebAssembly does not load.
//
//   npm run smoke:agent

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** What a tool call's reply holds: its first text block. */
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

const client = new Client({ name: 'scanruler-bundle-smoke', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: exe, args: [], stderr: 'inherit' }))
const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content: unknown = reply.content
  const text = Array.isArray(content) && isText(content[0]) ? content[0].text : ''
  if (reply.isError === true) throw new Error(`${name} failed: ${text}`)
  const parsed: unknown = JSON.parse(text)
  return parsed
}

const status = await call('scanruler_status')
if (at(status, 'backend') !== 'headless' || at(status, 'connected') !== true) throw new Error(`expected a connected headless backend, got ${JSON.stringify({ backend: at(status, 'backend'), connected: at(status, 'connected') })}`)
const added = await call('reverse_parameter_add', { name: 'l1', expression: '12' })
if (at(added, 'parameter', 'value') !== 12) throw new Error(`expected l1 = 12, got ${JSON.stringify(at(added, 'parameter'))}`)
const listed = await call('reverse_parameter_list')
if (!JSON.stringify(listed).includes('"l1"')) throw new Error('the parameter added is not in the list')
await client.close()
console.log(`PASS: ${exe} ran headless, added a parameter and read it back`)
