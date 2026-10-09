// SPDX-License-Identifier: AGPL-3.0-only
// The last page's commands, kept between runs: listed before a page is back,
// so a client that lists the tools once at its start sees every one the tab
// offers; written when a page connects.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadRemembered, saveRemembered } from '../src/config.js'
import { PageLink } from '../src/link.js'
import { createMcpServer, SNAPSHOT } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'remembered-test-token-of-length'
const extra = { name: 'demo.thing', title: 'A plugin’s thing', description: 'Something a plugin adds to the list of commands.', input: { type: 'object', properties: {} }, readOnly: false, returnsFile: false, returnsImage: false }
const closers = []
after(() => closers.forEach((close) => close()))

test('the kept list is read back, and nothing kept reads as nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  assert.equal(loadRemembered(dir), null)
  saveRemembered([extra], dir)
  assert.deepEqual(loadRemembered(dir), [extra])
})

test('a server lists the last page’s commands before a page connects, and keeps the next page’s', async () => {
  // Kept from an older page: one more command, and one whose input has
  // changed since — the same name, another schema.
  const changed = { ...SNAPSHOT[0], input: { type: 'object', properties: { old: { type: 'string' } } } }
  let kept = [changed, ...SNAPSHOT.slice(1), extra]
  const saved = []
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  closers.push(() => link.close(), () => http.close())
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: tmpdir(),
    outDir: tmpdir(),
    connectHelp: () => 'Pair it.',
    serverInfo: () => ({}),
    pageTimeoutMs: 50,
    remembered: { load: () => kept, save: (commands) => saved.push(commands) },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  let listChanged = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++
  })
  await Promise.all([server.connect(a), client.connect(b)])
  closers.push(() => client.close())

  const listedBefore = (await client.listTools()).tools
  const before = listedBefore.map((t) => t.name)
  assert.ok(before.includes('demo_thing'), 'the kept command is listed with no page')
  assert.equal(before.length, SNAPSHOT.length + 3)
  assert.ok(listedBefore.find((t) => t.name === SNAPSHOT[0].name.replace(/\./g, '_')).inputSchema.properties.old, 'as it was kept')

  const page = await fakePage(http.address().port, { token: TOKEN, commands: SNAPSHOT })
  for (let i = 0; i < 100 && saved.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(saved.length, 1, 'the page’s list is kept')
  assert.equal(saved[0].length, SNAPSHOT.length)
  for (let i = 0; i < 100 && listChanged === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(listChanged, 1, 'the client is told the list changed')
  const listed = (await client.listTools()).tools
  const now = listed.map((t) => t.name)
  assert.ok(!now.includes('demo_thing'), 'the page’s own list replaces the kept one')
  assert.equal(listed.find((t) => t.name === SNAPSHOT[0].name.replace(/\./g, '_')).inputSchema.properties.old, undefined, 'the changed schema is the page’s now')
  page.page.close()
  kept = null
})
