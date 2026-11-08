// SPDX-License-Identifier: AGPL-3.0-only
// The server as an agent starts it, as a process on stdio — and as an agent
// may start it, more than once on one port: Claude Desktop starts one copy
// for its chats and another for its other sessions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT } from '../src/mcp.js'
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

test('--tools compact, or SCANRULER_MCP_TOOLS, lists the server’s own eight and the picture tools; a mixed or an empty list is refused', { timeout: 30_000 }, async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  const env = { SCANRULER_MCP_TOKEN: TOKEN, SCANRULER_MCP_CONFIG_DIR: configDir }
  for (const how of [{ args: ['--tools', 'compact'] }, { env: { SCANRULER_MCP_TOOLS: 'compact' } }]) {
    const agent = await startAgent({ args: ['--port', String(await freePort()), ...(how.args ?? [])], env: { ...env, ...how.env }, stderr: 'pipe' })
    try {
      const { tools } = await agent.client.listTools()
      assert.equal(tools.length, 8 + SNAPSHOT.filter((c) => c.returnsImage).length, JSON.stringify(how))
      assert.ok(tools.some((t) => t.name === 'scanruler_tools'))
      assert.equal((await status(agent)).server.tools, 'compact')
    } finally {
      await agent.close()
    }
  }
  const bin = fileURLToPath(new URL('../bin/scanruler-mcp.js', import.meta.url))
  const mixed = spawnSync(process.execPath, [bin, '--tools', 'scan,-flat'], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(mixed.status, 2)
  assert.match(mixed.stderr, /--tools scan,-flat mixes namespaces to list \(scan\) with namespaces to leave out \(-flat\)/)
  const empty = spawnSync(process.execPath, [bin, '--tools', ''], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(empty.status, 2)
  assert.match(empty.stderr, /--tools is empty: give full, compact, namespaces to list/)
  const bad = spawnSync(process.execPath, [bin], { env: { ...process.env, ...env, SCANRULER_MCP_TOOLS: 'scan,,view' }, encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /SCANRULER_MCP_TOOLS scan,,view: "" is no namespace/)
})

test('--tools with namespaces lists those, or all but those, beside the server’s own seven, and reports the list as given', { timeout: 30_000 }, async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  const env = { SCANRULER_MCP_TOKEN: TOKEN, SCANRULER_MCP_CONFIG_DIR: configDir }
  const namespace = (name) => name.split('_')[0]
  for (const how of [
    { args: ['--tools', 'scan,view'], keep: (ns) => ['scan', 'view'].includes(ns) },
    { env: { SCANRULER_MCP_TOOLS: '-flat,-thickness' }, keep: (ns) => !['flat', 'thickness'].includes(ns) },
  ]) {
    const agent = await startAgent({ args: ['--port', String(await freePort()), ...(how.args ?? [])], env: { ...env, ...how.env }, stderr: 'pipe' })
    try {
      const { tools } = await agent.client.listTools()
      const expected = ['scanruler_batch', 'scanruler_files', 'scanruler_open', 'scanruler_read', 'scanruler_status', 'scanruler_wait', 'scanruler_write', ...SNAPSHOT.map((c) => c.name.replace(/\./g, '_')).filter((n) => how.keep(namespace(n)))]
      assert.deepEqual(tools.map((t) => t.name).sort(), expected.sort(), JSON.stringify(how.args ?? how.env))
      assert.equal((await status(agent)).server.tools, how.args ? how.args[1] : how.env.SCANRULER_MCP_TOOLS)
    } finally {
      await agent.close()
    }
  }
})
