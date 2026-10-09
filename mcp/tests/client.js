// SPDX-License-Identifier: AGPL-3.0-only
// An MCP client that starts this server over stdio, the way Claude Code,
// Claude Desktop and Cursor start it — for the app's browser check
// (scripts/e2e-agent.mjs), which cannot reach this package's dependencies
// from outside it.
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const BIN = fileURLToPath(new URL('../bin/scanruler-mcp.js', import.meta.url))

/** Start `scanruler-mcp <args>` with `env` added, and connect to it. Returns
 *  the client and `call(name, args)`, which gives `{ error, text, json,
 *  images }` — `images` the image blocks, `{ data, mimeType }`, a picture
 *  came back in. */
export async function startAgent({ args = [], env = {}, stderr = 'inherit' } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    env: { ...process.env, ...env },
    stderr,
  })
  const client = new Client({ name: 'scanruler-e2e', version: '1.0.0' })
  await client.connect(transport)
  const call = async (name, input = {}) => {
    const r = await client.callTool({ name, arguments: input }, undefined, { timeout: 300_000 })
    const text = r.content?.[0]?.text ?? ''
    let json = null
    if (!r.isError) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { error: r.isError === true, text, json, images: (r.content ?? []).filter((c) => c.type === 'image') }
  }
  return { client, call, close: () => client.close() }
}
