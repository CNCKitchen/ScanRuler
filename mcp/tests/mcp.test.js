// SPDX-License-Identifier: AGPL-3.0-only
// The MCP server end to end, with a real MCP client over an in-memory
// transport and a fake page on a real socket.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { PageLink } from '../src/link.js'
import { createMcpServer, SNAPSHOT } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'another-test-token-of-length'
let link
let http
let port
let client
let dir
let listChanged = 0
// What scanruler_open's opening of the browser does, set by a test.
let opener = async () => false

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  link = new PageLink({ token: TOKEN })
  http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = http.address().port
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: dir,
    outDir: dir,
    connectHelp: () => 'Open ScanRuler and pair it.',
    serverInfo: () => ({ port }),
    pageTimeoutMs: 50,
    openPage: () => opener(),
    openGraceMs: 50,
    openWaitMs: 5_000,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0.0.0' })
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++
  })
  await Promise.all([server.connect(a), client.connect(b)])
})
after(async () => {
  await client.close()
  link.close()
  http.close()
})

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content[0].text
  return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text), images: r.content.filter((c) => c.type === 'image') }
}

test('before a page connects: the app’s tools are listed, status says how to connect, calls say no page', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('scanruler_status'))
  assert.ok(names.includes('scanruler_wait'))
  assert.ok(names.includes('scanruler_open'))
  assert.ok(names.includes('scan_open'))
  assert.equal(tools.length, SNAPSHOT.length + 3)
  const status = await call('scanruler_status')
  assert.equal(status.json.connected, false)
  assert.equal(status.json.howToConnect, 'Open ScanRuler and pair it.')
  const refused = await call('session_state')
  assert.equal(refused.error, true)
  assert.match(refused.text, /^unavailable: No ScanRuler page is connected; scanruler_open opens one\. Open ScanRuler/)
  const waited = await call('scanruler_wait', { timeoutSeconds: 0.05 })
  assert.equal(waited.json.connected, false)
})

test('with a page: tools run on it — files read from paths and written to paths — and its own tools are listed', async () => {
  await writeFile(join(dir, 'ballbar.stl'), Buffer.alloc(84))
  const extra = { name: 'demo.thing', title: 'A plugin’s thing', description: 'Something a plugin adds to the list of commands.', input: { type: 'object', properties: {} }, readOnly: false, returnsFile: false }
  const page = await fakePage(port, {
    token: TOKEN,
    commands: [...SNAPSHOT, extra],
    answer: (name, input) => {
      if (name === 'scan.open') return { scan: { fileName: input.name, bytes: input.bytes.byteLength } }
      if (name === 'export.step') return { file: { name: 'ballbar-elements.step', mimeType: 'model/step', bytes: new TextEncoder().encode('ISO-10303-21;') }, status: 'ok' }
      if (name === 'session.state') return { busy: null, running: null }
      if (name === 'view.render') return { file: { name: 'ballbar-view.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, width: input.width ?? 640, height: 480 }
      throw { code: 'invalid_input', message: `${name} refused.` }
    },
  })
  const status = await call('scanruler_wait', { for: 'idle', timeoutSeconds: 5 })
  assert.equal(status.json.connected, true)
  assert.equal(status.json.page.version, '0.0.0-test')
  assert.equal(status.json.howToConnect, undefined)

  const opened = await call('scan_open', { path: 'ballbar.stl', units: 'mm' })
  assert.deepEqual(opened.json, { scan: { fileName: 'ballbar.stl', bytes: 84 } })
  const run = page.page.runs.find((r) => r.name === 'scan.open')
  assert.equal(run.input.path, undefined, 'the page gets the bytes, not the path')

  const exported = await call('export_step', { path: 'out' })
  assert.equal(exported.json.file.path, join(dir, 'out'))
  assert.equal(await readFile(join(dir, 'out'), 'utf8'), 'ISO-10303-21;')

  const pictured = await call('view_render', { width: 640 })
  assert.equal(pictured.images.length, 1)
  assert.equal(pictured.images[0].mimeType, 'image/png')
  assert.equal(Buffer.from(pictured.images[0].data, 'base64').subarray(1, 4).toString(), 'PNG')
  assert.deepEqual(pictured.json, { file: { name: 'ballbar-view.png', mimeType: 'image/png', size: 4 }, width: 640, height: 480 })
  assert.equal(page.page.runs.find((r) => r.name === 'view.render').input.path, undefined)

  const refused = await call('element_fit', { kind: 'sphere', at: { vertex: 1 } })
  assert.equal(refused.error, true)
  assert.equal(refused.text, 'invalid_input: element.fit refused.')

  assert.ok(listChanged >= 1, 'the client is told the list changed')
  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'demo_thing'))
  page.page.close()
})

test('scanruler_open opens the paired page when none comes back by itself, and leaves a connected one be', async () => {
  for (let i = 0; link.connected && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(link.connected, false)

  const failed = await call('scanruler_open')
  assert.equal(failed.json.connected, false)
  assert.equal(failed.json.opened, false)
  assert.equal(failed.json.howToConnect, 'Open ScanRuler and pair it.')

  let opens = 0
  let page
  opener = async () => {
    opens++
    // The browser opening the pairing link, and the page in it connecting.
    setTimeout(() => {
      page = fakePage(port, { token: TOKEN })
    }, 20)
    return true
  }
  const opened = await call('scanruler_open')
  assert.equal(opened.json.connected, true)
  assert.equal(opened.json.opened, true)
  assert.equal(opens, 1)

  const again = await call('scanruler_open')
  assert.equal(again.json.connected, true)
  assert.equal(again.json.opened, false)
  assert.equal(opens, 1, 'a connected page is not opened a second time')
  ;(await page).page.close()
  opener = async () => false
})
