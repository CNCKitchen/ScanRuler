// SPDX-License-Identifier: AGPL-3.0-only
// The server as an agent starts it, as a process on stdio — and as an agent
// may start it, more than once on one port: Claude Desktop starts one copy
// for its chats and another for its other sessions.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startAgent } from './client.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-test-token-long-enough'

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const start = async (port) =>
  startAgent({
    args: ['--port', String(port)],
    env: { SCANRULER_MCP_TOKEN: TOKEN, SCANRULER_MCP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'scanruler-mcp-')) },
    stderr: 'pipe',
  })

const status = async (agent) => (await agent.call('scanruler_status')).json

/** Ask `check` until it says yes; fails after `ms`. */
async function until(what, check, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('a copy on a port another program holds stays up, lists its tools, and says the port is taken', { timeout: 30_000 }, async () => {
  const holder = createServer()
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const { port } = holder.address()
  let agent
  try {
    agent = await start(port)
    const { tools } = await agent.client.listTools()
    assert.ok(tools.some((t) => t.name === 'scan_open'))
    const said = await until('the copy to say the port is taken', async () => {
      const s = await status(agent)
      return s.server.error ? s : null
    })
    assert.equal(said.connected, false)
    assert.equal(said.server.role, 'none')
    assert.match(said.server.error, new RegExp(`^Port ${port} is taken by another program`))
    assert.match(said.howToConnect, new RegExp(`^Port ${port} is taken by another program`))
  } finally {
    await agent?.close()
    holder.close()
  }
})

test('copies on one port: the second sends its calls through the first, and takes the port over when the first stops', { timeout: 30_000 }, async () => {
  const port = await freePort()
  const pages = []
  let first
  let second
  try {
    first = await start(port)
    await until('the first copy to hold the port', async () => (await status(first)).server.role === 'holder')
    second = await start(port)
    await until('the second copy to relay', async () => (await status(second)).server.role === 'relay')

    pages.push(await fakePage(port, { token: TOKEN, answer: (name) => ({ ran: name, by: 'the first tab' }) }))
    await until('the second copy to hear of the page', async () => (await status(second)).connected)
    assert.deepEqual((await second.call('session_state')).json, { ran: 'session.state', by: 'the first tab' })
    assert.deepEqual((await first.call('session_state')).json, { ran: 'session.state', by: 'the first tab' }, 'the holder still runs its own')

    await first.close()
    first = null
    await until('the second copy to take the port over', async () => (await status(second)).server.role === 'holder')
    // The tab keeps trying, and connects to the copy that has the port now.
    pages.push(await fakePage(port, { token: TOKEN, answer: (name) => ({ ran: name, by: 'the tab again' }) }))
    assert.deepEqual((await second.call('session_state')).json, { ran: 'session.state', by: 'the tab again' })
  } finally {
    for (const page of pages) page.page.close()
    await first?.close()
    await second?.close()
  }
})
