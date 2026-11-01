// SPDX-License-Identifier: AGPL-3.0-only
// The MCP server end to end, with a real MCP client over an in-memory
// transport and a fake page on a real socket.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { PageLink } from '../src/link.js'
import { createMcpServer, parseToolMode, SNAPSHOT } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { toolFor, toolName } from '../src/tools.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'another-test-token-of-length'
let link
let http
let port
let client
let close
let dir
let listChanged = 0
// What scanruler_open's opening of the browser does, set by a test.
let opener = async () => false

/** A server on a link and a port of its own, and a client connected to it. */
async function serve(options = {}) {
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: dir,
    outDir: dir,
    connectHelp: () => 'Open ScanRuler and pair it.',
    serverInfo: () => ({ port }),
    pageTimeoutMs: 50,
    ...options,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const close = async () => {
    await client.close()
    link.close()
    http.close()
  }
  return { link, http, port, client, close }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  ;({ link, http, port, client, close } = await serve({ openPage: () => opener(), openGraceMs: 50, openWaitMs: 5_000 }))
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++
  })
})
after(() => close())

const call = async (name, args = {}, on = client) => {
  const r = await on.callTool({ name, arguments: args })
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
  assert.equal(tools.length, SNAPSHOT.length + 7)
  assert.ok(!names.includes('scanruler_tools'), 'listed in full, the tools need no catalogue')
  assert.equal((await call('scanruler_tools')).text, 'unknown_command: There is no tool scanruler_tools.')
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
      if (name === 'scan.nearest') return { vertex: 1234567, point: [0.9483828176573491, 12.000000000000002, -1.2e-17], normal: [0, -0.7071067811865476, 0.7071067811865475] }
      if (name === 'view.render') return { file: { name: 'ballbar-view.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, width: input.width ?? 640, height: 480 }
      throw { code: 'invalid_input', message: `${name} refused.` }
    },
  })
  const status = await call('scanruler_wait', { timeoutSeconds: 5 })
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

  // Numbers come back to six significant digits; whole ones as they are.
  const near = await call('scan_nearest', { point: [1, 12, 0] })
  assert.equal(near.text, '{"vertex":1234567,"point":[0.948383,12,0],"normal":[0,-0.707107,0.707107]}')

  const refused = await call('element_fit', { kind: 'sphere', at: { vertex: 1 } })
  assert.equal(refused.error, true)
  assert.equal(refused.text, 'invalid_input: element.fit refused.')

  // Several tools in one call, in order; a refusal stops the rest unless
  // told otherwise, and the server's own tools are not batched.
  const batch = await call('scanruler_batch', { calls: [{ tool: 'session_state' }, { tool: 'view_render', arguments: { width: 320 } }, { tool: 'element_fit', arguments: { kind: 'sphere', at: { vertex: 1 } } }, { tool: 'session_state' }] })
  assert.equal(batch.error, false)
  assert.equal(batch.json.ran, 3)
  assert.equal(batch.json.of, 4)
  assert.equal(batch.json.stopped, 2)
  assert.deepEqual(batch.json.results[0], { tool: 'session_state', ok: true, result: { busy: null, running: null } })
  assert.equal(batch.json.results[1].ok, true)
  assert.equal(batch.json.results[1].result.width, 320, 'a picture gives its text in a batch')
  assert.equal(batch.images.length, 0)
  // ... and, with no path given, is written to the output folder, the
  // text saying where — a second one beside the first, not over it.
  const first = batch.json.results[1].result.file
  assert.deepEqual(first, { name: 'ballbar-view.png', mimeType: 'image/png', size: 4, path: join(dir, 'ballbar-view.png') })
  assert.equal((await readFile(first.path)).subarray(1, 4).toString(), 'PNG')
  const two = await call('scanruler_batch', { calls: [{ tool: 'view_render', arguments: {} }, { tool: 'view_render', arguments: { path: 'kept.png' } }] })
  assert.equal(two.images.length, 0)
  assert.equal(two.json.results[0].result.file.path, join(dir, 'ballbar-view-2.png'))
  assert.equal(two.json.results[1].result.file.path, join(dir, 'kept.png'), 'a path given is where it goes')
  assert.equal((await readFile(join(dir, 'kept.png'))).subarray(1, 4).toString(), 'PNG')
  assert.deepEqual(batch.json.results[2], { tool: 'element_fit', ok: false, error: { code: 'invalid_input', message: 'element.fit refused.' } })
  const all = await call('scanruler_batch', { stopOnError: false, calls: [{ tool: 'element_fit', arguments: {} }, { tool: 'no_such_tool' }, { tool: 'scanruler_status' }, { tool: 'session_state' }] })
  assert.equal(all.json.ran, 4)
  assert.equal(all.json.stopped, undefined)
  assert.equal(all.json.results[1].error.code, 'unknown_command')
  assert.equal(all.json.results[2].error.code, 'invalid_input')
  assert.equal(all.json.results[3].ok, true)
  assert.equal((await call('scanruler_batch', { calls: [] })).error, true)
  // A run a script wrote, read from its file: by the command's own name too.
  await writeFile(join(dir, 'calls.json'), JSON.stringify({ steps: [{ name: 'session.state', input: {} }, { tool: 'session_state' }] }))
  const fromFile = await call('scanruler_batch', { file: 'calls.json' })
  assert.equal(fromFile.error, false)
  assert.equal(fromFile.json.ran, 2)
  assert.deepEqual(fromFile.json.results.map((r) => r.tool), ['session_state', 'session_state'])
  assert.equal((await call('scanruler_batch', { file: 'no-such.json' })).error, true)
  assert.equal((await call('scanruler_batch', { file: 'calls.json', calls: [{ tool: 'session_state' }] })).error, true)

  assert.ok(listChanged >= 1, 'the client is told the list changed')
  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'demo_thing'))
  assert.ok(tools.some((t) => t.name === 'scanruler_batch'))
  page.page.close()
})

test('a session someone left: the status says what it holds, scan_open with saveTo keeps it, and a report goes beside the scan', async () => {
  const own = await serve()
  const on = (name, args) => call(name, args, own.client)
  const folder = join(dir, 'sigma')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'sigma.stl'), Buffer.alloc(84))
  let held = true
  const page = await fakePage(own.port, {
    token: TOKEN,
    answer: (name, input) => {
      if (name === 'session.state') return { busy: null, running: null, scan: held ? { fileName: 'other.stl' } : null, project: { name: held ? 'Their housing' : null, unsaved: held, holds: held ? { features: 12, notes: 3 } : {} } }
      if (name === 'project.save') {
        if (!held) throw { code: 'failed', message: 'There is nothing to save yet — no scan, image or work.' }
        return { file: { name: 'Their housing.scanruler', mimeType: 'application/zip', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) }, status: 'Project saved.' }
      }
      if (name === 'scan.open') {
        if (held && !input.discard) throw { code: 'invalid_state', message: 'The session holds 12 features.' }
        held = false
        return { scan: { fileName: input.name } }
      }
      throw { code: 'invalid_input', message: `${name} refused.` }
    },
  })
  try {
    assert.equal((await on('scanruler_wait', { timeoutSeconds: 5 })).json.connected, true)
    const before = await on('scanruler_status')
    assert.deepEqual(before.json.session, { scan: 'other.stl', project: 'Their housing', unsaved: true, features: 12, notes: 3 })

    // Nowhere to write a report yet: no scan was opened from a folder.
    const early = await on('scanruler_write', { path: 'report.md', text: '# Sigma' })
    assert.equal(early.error, true)
    assert.match(early.text, /^invalid_state: .*scan_open/)

    const schema = (await own.client.listTools()).tools.find((t) => t.name === 'scan_open').inputSchema
    assert.ok(schema.properties.saveTo, 'a tool that replaces the session takes saveTo')
    const opened = await on('scan_open', { path: join(folder, 'sigma.stl'), saveTo: join(dir, 'kept') })
    assert.equal(opened.error, false, opened.text)
    assert.equal(opened.json.savedTo, join(dir, 'kept'))
    assert.deepEqual([...(await readFile(join(dir, 'kept')))], [0x50, 0x4b, 3, 4], 'the project as it was')
    const runs = page.page.runs.map((r) => r.name)
    assert.deepEqual(runs.slice(runs.indexOf('project.save')), ['project.save', 'scan.open'], 'saved, then opened')
    assert.equal(page.page.runs.find((r) => r.name === 'scan.open').input.discard, true)
    assert.equal(page.page.runs.find((r) => r.name === 'scan.open').input.saveTo, undefined, 'the page is not told the path')
    assert.deepEqual((await on('scanruler_status')).json.session, { scan: null, unsaved: false })

    // With nothing to save, the open goes on.
    const again = await on('scan_open', { path: join(folder, 'sigma.stl'), saveTo: join(dir, 'empty.scanruler') })
    assert.equal(again.json.savedTo, null)

    // The report, beside the scan — and nowhere else.
    const wrote = await on('scanruler_write', { path: 'report.md', text: '# Sigma\n\nRMS 0.067 mm' })
    assert.deepEqual(wrote.json, { path: join(folder, 'report.md'), size: 21 })
    assert.equal(await readFile(join(folder, 'report.md'), 'utf8'), '# Sigma\n\nRMS 0.067 mm')
    assert.equal((await on('scanruler_write', { path: 'out/readings.csv', text: 'a,b' })).json.path, join(folder, 'out', 'readings.csv'), 'a folder under it')
    assert.equal((await on('scanruler_write', { path: join(dir, 'beside-the-project.txt'), text: 'x' })).error, false, 'the folder a project was saved into')
    for (const [path, why] of [['report.exe', /only \.md/], ['../escape.md', /"\.\."/], [join(tmpdir(), 'elsewhere.md'), /outside/], ['.claude/settings.json', /hidden/], [join(folder, '.github', 'notes.md'), /hidden/], ['CLAUDE.md', /instructions/], ['sub/package.json', /settings/]]) {
      const refused = await on('scanruler_write', { path, text: 'x' })
      assert.equal(refused.error, true, path)
      assert.match(refused.text, why)
    }
  } finally {
    page.page.close()
    await own.close()
  }
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

const OWN = ['scanruler_batch', 'scanruler_files', 'scanruler_open', 'scanruler_read', 'scanruler_status', 'scanruler_tools', 'scanruler_wait', 'scanruler_write']
/** The tools listed in compact mode beside the server's own: the commands
 *  that return a picture, by their flag. */
const pictures = (commands) => commands.filter((c) => c.returnsImage).map(toolName)

test('compact: the eight and the picture tools listed, the rest read through scanruler_tools as the full list would give them', async () => {
  const compact = await serve({ tools: 'compact' })
  const on = (name, args) => call(name, args, compact.client)
  try {
    const full = (await client.listTools()).tools
    const { tools } = await compact.client.listTools()
    const shown = pictures(SNAPSHOT)
    assert.ok(shown.length > 0, 'the app has commands that return a picture')
    assert.deepEqual(tools.map((t) => t.name).sort(), [...OWN, ...shown].sort(), 'each picture command, and nothing else beyond the eight')
    for (const name of shown) assert.deepEqual(tools.find((t) => t.name === name), full.find((t) => t.name === name), `${name} as the full list gives it`)

    // The list: every command, a line each.
    const list = await on('scanruler_tools')
    assert.equal(list.json.count, SNAPSHOT.length)
    assert.deepEqual(Object.keys(list.json.tools), SNAPSHOT.map(toolName))
    for (const c of SNAPSHOT) assert.equal(list.json.tools[toolName(c)], c.title, c.name)

    // Definitions, the full list's own — its paths in place of bytes, its
    // folder for exports — and names it does not know set apart.
    const names = ['scan_open', 'export_step', 'view_render', 'element_fit']
    const read = await on('scanruler_tools', { names: [...names, 'no_such_tool', 'element.fit'] })
    assert.equal(read.error, false)
    assert.deepEqual(read.json.tools, names.map((name) => full.find((t) => t.name === name)))
    assert.deepEqual(read.json.unknown, ['no_such_tool', 'element.fit'])
    assert.deepEqual((await on('scanruler_tools', { names: ['nothing_here'] })).json, { tools: [], unknown: ['nothing_here'] })
    assert.deepEqual((await on('scanruler_tools', { names: 'scan_open, element_fit' })).json.tools.map((t) => t.name), ['scan_open', 'element_fit'], 'a string of names is read as a list')
    const many = await on('scanruler_tools', { names: SNAPSHOT.map(toolName) })
    assert.equal(many.error, true)
    assert.match(many.text, /^invalid_input: names: at most 20 at a time/)

    // A page's tool is not listed, but runs when called.
    const refused = await on('session_state')
    assert.match(refused.text, /^unavailable: /)
  } finally {
    await compact.close()
  }
})

test('compact: the list follows the page that connects, and its tools run in a batch or called directly', async () => {
  const compact = await serve({ tools: 'compact' })
  const on = (name, args) => call(name, args, compact.client)
  let changed = 0
  compact.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++
  })
  const extra = { name: 'demo.thing', description: 'Something a plugin adds. It has no title of its own.', input: { type: 'object', properties: {} }, readOnly: false, returnsFile: false, returnsImage: false }
  let page
  try {
    assert.equal((await on('scanruler_tools')).json.tools.demo_thing, undefined)
    page = await fakePage(compact.port, { token: TOKEN, commands: [...SNAPSHOT, extra], answer: (name) => ({ ran: name }) })
    assert.equal((await on('scanruler_wait', { timeoutSeconds: 5 })).json.connected, true)

    const list = await on('scanruler_tools')
    assert.deepEqual(Object.keys(list.json.tools), [...SNAPSHOT, extra].map(toolName), 'every command the page lists')
    assert.equal(list.json.tools.demo_thing, 'Something a plugin adds.', 'untitled, the first sentence')
    assert.deepEqual((await on('scanruler_tools', { names: ['demo_thing'] })).json.tools, [JSON.parse(JSON.stringify(toolFor(extra, { outDir: dir })))])
    assert.equal((await compact.client.listTools()).tools.length, OWN.length + pictures(SNAPSHOT).length, 'a command with no picture stays unlisted')
    assert.equal(changed, 0, 'and so the list is not said to have changed')

    const batch = await on('scanruler_batch', { calls: [{ tool: 'demo_thing' }, { tool: 'scanruler_tools' }] })
    assert.deepEqual(batch.json.results[0], { tool: 'demo_thing', ok: true, result: { ran: 'demo.thing' } })
    assert.equal(batch.json.results[1].error.code, 'invalid_input', 'the server’s own are not batched')
    assert.deepEqual((await on('session_state')).json, { ran: 'session.state' }, 'a direct call to a tool not listed')
  } finally {
    ;(await page)?.page.close()
    await compact.close()
  }
})

test('compact: a page with a new picture command has the client list the tools again, and shows the picture called directly', async () => {
  const compact = await serve({ tools: 'compact' })
  const on = (name, args) => call(name, args, compact.client)
  let changed = 0
  compact.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++
  })
  const picture = { name: 'demo.picture', title: 'Picture a thing', description: 'A picture a plugin adds to the list of commands.', input: { type: 'object', properties: {} }, readOnly: true, returnsFile: false, returnsImage: true }
  let page
  try {
    assert.ok(!(await compact.client.listTools()).tools.some((t) => t.name === 'demo_picture'))
    page = await fakePage(compact.port, {
      token: TOKEN,
      commands: [...SNAPSHOT, picture],
      answer: (name) => ({ ran: name, file: { name: 'thing.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } }),
    })
    for (let i = 0; i < 100 && changed === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(changed, 1, 'the client is told the list changed')
    const { tools } = await compact.client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), [...OWN, ...pictures([...SNAPSHOT, picture])].sort())

    const shown = await on('demo_picture')
    assert.equal(shown.images.length, 1, 'called directly, the picture is shown')
    assert.equal(shown.json.ran, 'demo.picture')
    const batched = await on('scanruler_batch', { calls: [{ tool: 'demo_picture' }] })
    assert.equal(batched.images.length, 0)
    assert.deepEqual(batched.json.results[0].result, { ran: 'demo.picture', file: { name: 'thing.png', mimeType: 'image/png', size: 4, path: join(dir, 'thing.png') } }, 'in a batch, its text, and the picture in a file')
  } finally {
    ;(await page)?.page.close()
    await compact.close()
  }
})

/** The server's own tools in full mode and with namespaces: the eight but
 *  scanruler_tools, which only compact adds. */
const SEVEN = OWN.filter((n) => n !== 'scanruler_tools')
const namespaceOf = (name) => name.split('_')[0]
/** A command a page adds, in a namespace of its own. */
const DEMO = { name: 'demo.thing', description: 'Something a plugin adds.', input: { type: 'object', properties: {} }, readOnly: false, returnsFile: false, returnsImage: false }

test('namespaces listed: only those, beside the server’s seven; a tool left out is unknown, and a namespace no page has is said at its connection', async () => {
  const lines = []
  const some = await serve({ tools: 'scan,view,nothing', log: (line) => lines.push(line) })
  const on = (name, args) => call(name, args, some.client)
  let page
  try {
    const full = (await client.listTools()).tools
    const { tools } = await some.client.listTools()
    const expected = [...SEVEN, ...SNAPSHOT.map(toolName).filter((n) => ['scan', 'view'].includes(namespaceOf(n)))]
    assert.ok(expected.length > SEVEN.length + 1, 'the app has scan and view commands')
    assert.deepEqual(tools.map((t) => t.name).sort(), expected.sort())
    for (const t of tools.filter((t) => !SEVEN.includes(t.name))) assert.deepEqual(t, full.find((f) => f.name === t.name), `${t.name} as the full list gives it`)
    assert.ok(!tools.some((t) => t.name === 'scanruler_tools'), 'no scanruler_tools: each listed command is its own tool')

    // Left out, a tool is unknown — called directly or in a batch — while
    // a listed one needs only the page.
    const refused = await on('element_fit', { point: [0, 0, 0] })
    assert.match(refused.text, /^unknown_command: There is no tool element_fit here: this server was started with --tools scan,view,nothing, which leaves the element_ tools out\./)
    assert.match((await on('session_state')).text, /^unknown_command: /)
    assert.match((await on('scan_query')).text, /^unavailable: /)
    const batch = await on('scanruler_batch', { stopOnError: false, calls: [{ tool: 'element_fit' }, { tool: 'no_such_tool' }] })
    assert.equal(batch.json.results[0].error.code, 'unknown_command')
    assert.match(batch.json.results[0].error.message, /leaves the element_ tools out/)
    assert.equal(batch.json.results[1].error.code, 'unknown_command')

    // A page with a namespace of its own: not listed, and the entry that
    // matches none of the page's namespaces named once on connection.
    assert.deepEqual(lines, [], 'nothing said before a page')
    page = await fakePage(some.port, { token: TOKEN, commands: [...SNAPSHOT, DEMO], answer: (name) => ({ ran: name }) })
    assert.equal((await on('scanruler_wait', { timeoutSeconds: 5 })).json.connected, true)
    assert.ok(!(await some.client.listTools()).tools.some((t) => t.name === 'demo_thing'))
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.match(lines[0], /^--tools scan,view,nothing: no tool of the page \(ScanRuler 0\.0\.0-test\) is in nothing; its namespaces are align, demo, deviation, /)
    assert.match((await on('demo_thing')).text, /^unknown_command: /)
    assert.deepEqual((await on('scan_query', { point: [0, 0, 0] })).json, { ran: 'scan.query' }, 'a listed tool runs on the page')
  } finally {
    ;(await page)?.page.close()
    await some.close()
  }
})

test('namespaces left out: all but those, a page’s own namespace among them, and the status reports the list as given', async () => {
  const lines = []
  const most = await serve({ tools: '-flat,-thickness', log: (line) => lines.push(line), serverInfo: () => ({ tools: '-flat,-thickness' }) })
  const on = (name, args) => call(name, args, most.client)
  let changed = 0
  most.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++
  })
  let page
  try {
    const { tools } = await most.client.listTools()
    const kept = SNAPSHOT.map(toolName).filter((n) => !['flat', 'thickness'].includes(namespaceOf(n)))
    assert.ok(kept.length < SNAPSHOT.length, 'the app has flat and thickness commands')
    assert.deepEqual(tools.map((t) => t.name).sort(), [...SEVEN, ...kept].sort())
    assert.equal((await on('scanruler_status')).json.server.tools, '-flat,-thickness')
    assert.match((await on('flat_render')).text, /^unknown_command: There is no tool flat_render here: this server was started with --tools -flat,-thickness, which leaves the flat_ tools out\./)

    page = await fakePage(most.port, { token: TOKEN, commands: [...SNAPSHOT, DEMO], answer: (name) => ({ ran: name }) })
    assert.equal((await on('scanruler_wait', { timeoutSeconds: 5 })).json.connected, true)
    for (let i = 0; i < 100 && changed === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(changed, 1, 'a page with a new namespace has the client list the tools again')
    assert.ok((await most.client.listTools()).tools.some((t) => t.name === 'demo_thing'), 'the page’s own namespace is listed, not being left out')
    assert.deepEqual((await on('demo_thing')).json, { ran: 'demo.thing' })
    assert.match((await on('thickness_measure')).text, /^unknown_command: /)
    assert.deepEqual(lines, [], 'every namespace left out is one the page has')
  } finally {
    ;(await page)?.page.close()
    await most.close()
  }
})

test('namespaces: a list that mixes the two forms, or is empty, is refused; full and compact stay as they are', () => {
  assert.throws(() => parseToolMode('scan,-flat'), /^Error: --tools scan,-flat mixes namespaces to list \(scan\) with namespaces to leave out \(-flat\): give one form/)
  assert.throws(() => parseToolMode('', 'SCANRULER_MCP_TOOLS'), /^Error: SCANRULER_MCP_TOOLS is empty: give full, compact, namespaces to list \(scan,view\) or namespaces to leave out \(-flat,-thickness\)\./)
  assert.throws(() => parseToolMode('scan,,view'), /^Error: --tools scan,,view: "" is no namespace/)
  assert.throws(() => parseToolMode('-'), /"-" is no namespace/)
  assert.throws(() => createMcpServer({ link: new PageLink({ token: TOKEN }), version: '0.0.0', cwd: dir, outDir: dir, connectHelp: () => '', serverInfo: () => ({}), tools: 'scan,-flat' }), /mixes namespaces/)
  for (const [mode, compact] of [['full', false], ['compact', true]]) {
    const { text, compact: isCompact, named, lists } = parseToolMode(mode)
    assert.deepEqual([text, isCompact, named, lists('flat')], [mode, compact, null, true], mode)
  }
  const only = parseToolMode(' scan, view ')
  assert.deepEqual([...only.named], ['scan', 'view'])
  assert.equal(only.text, 'scan, view', 'the mode is reported as given, trimmed at its ends')
  assert.deepEqual([only.lists('scan'), only.lists('view'), only.lists('flat')], [true, true, false])
  const but = parseToolMode('-flat,-thickness')
  assert.deepEqual([but.lists('scan'), but.lists('flat'), but.lists('thickness'), but.lists('demo')], [true, false, false, true])
})
