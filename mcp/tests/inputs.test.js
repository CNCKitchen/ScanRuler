// SPDX-License-Identifier: AGPL-3.0-only
// Inputs as clients send them, and a page that is not what it was: a batch's
// calls, or a call's arguments, given as a string of JSON; a long answer's
// spill saying what the command itself says to ask for; a page that came
// back empty from a reload, told on the next answer with the project last
// opened or saved here; and a page older than its app (stale_page) kept in
// the status.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadFolders, loadLastProject, saveFolders, saveLastProject } from '../src/config.js'
import { PageLink } from '../src/link.js'
import { callsGiven, createMcpServer, localTime } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-inputs-tests'
const obj = (properties = {}) => ({ type: 'object', properties, additionalProperties: false })
const COMMANDS = [
  { name: 'session.state', title: 'Read the session', description: 'The session.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.points', title: 'Points', description: 'Reads n points.', input: obj({ n: { type: 'number' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.long', title: 'Long', description: 'Answers long.', input: obj({ n: { type: 'number' } }), readOnly: true, returnsFile: false, returnsImage: false, askForLess: 'one part at a time (part, a dotted path)' },
  { name: 'demo.change', title: 'Change', description: 'Changes.', input: obj({ n: { type: 'number' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'demo.scan', title: 'Needs a scan', description: 'Refused.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'guide.read', title: 'Read a guide', description: 'Reads one.', input: obj({ topic: { type: 'string' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'project.load', title: 'Open a project', description: 'Opens one.', input: obj({ bytes: { type: 'string', format: 'binary' }, name: { type: 'string' }, discard: { type: 'boolean' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'project.save', title: 'Save the project', description: 'Saves it.', input: obj(), readOnly: true, returnsFile: true, returnsImage: false },
]
const STALE = 'This tab is older than the app it came from (rebuilt since) — save the project (project_save), then ask the person to reload; the work is lost on reload otherwise.'

let dir
let store
let link
let http
let client
let page
/** What the page's session.state answers now. */
let state = { busy: null, running: null, scan: null, project: { holds: {} } }

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-inputs-'))
  store = join(dir, 'config')
  link = new PageLink({ token: TOKEN })
  http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: dir,
    outDir: dir,
    connectHelp: () => 'Pair it.',
    serverInfo: () => ({}),
    pageTimeoutMs: 50,
    answerCap: 5_000,
    folderStore: { load: () => loadFolders(store), save: (folders) => saveFolders(folders, store), loadProject: () => loadLastProject(store), saveProject: (p) => saveLastProject(p, store) },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  page = await connect({ pageId: 'page-a', since: '2026-10-24T13:54:00.000Z' })
})
after(async () => {
  await client.close()
  page?.close()
  link.close()
  http.close()
})

/** A page connected with `hello` — its pageId and since — the last one
 *  gone first. */
async function connect(hello) {
  if (page) {
    page.close()
    for (let i = 0; link.connected && i < 200; i++) await new Promise((r) => setTimeout(r, 10))
  }
  const { page: next } = await fakePage(http.address().port, {
    token: TOKEN,
    commands: COMMANDS,
    hello,
    answer: async (name, input) => {
      if (name === 'session.state') return state
      if (name === 'demo.points') return { matched: input.n }
      if (name === 'demo.long') return { rows: Array.from({ length: input.n }, (_, i) => `row ${i}`) }
      if (name === 'demo.change') return { n: input.n }
      if (name === 'demo.scan') throw { code: 'no_scan', message: 'Open a scan first.' }
      if (name === 'guide.read') throw { code: 'stale_page', message: STALE }
      if (name === 'project.load') return { project: input.name }
      if (name === 'project.save') return { file: { name: 'joycon.scanruler', mimeType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) } }
      throw { code: 'unknown_command', message: name }
    },
  })
  return next
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content[0].text
  return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text) }
}

test('a batch’s calls given as a string of JSON run; a string that is not JSON says so, not “give at least one call”', async () => {
  const ran = await call('scanruler_batch', { calls: JSON.stringify([{ tool: 'demo_points', arguments: { n: 2 } }, { tool: 'demo_points', arguments: { n: 3 } }]) })
  assert.equal(ran.error, false, ran.text)
  assert.deepEqual(ran.json.results.map((r) => r.result.matched), [2, 3])
  // Under "calls", as a file holds them, too.
  const under = await call('scanruler_batch', { calls: JSON.stringify({ calls: [{ tool: 'demo_points', arguments: { n: 4 } }] }) })
  assert.equal(under.json.results[0].result.matched, 4)
  const broken = await call('scanruler_batch', { calls: '[{ "tool": "demo_points", "arguments": { "n": 2 } }' })
  assert.equal(broken.error, true)
  assert.match(broken.text, /^invalid_input: calls came as a string that is not JSON \(/)
  assert.doesNotMatch(broken.text, /give at least one call/)
  const notAList = await call('scanruler_batch', { calls: '"demo_points"' })
  assert.match(notAList.text, /^invalid_input: calls came as a string whose JSON is not a list of calls/)
  // As before: no calls at all, or something that is no list.
  assert.match((await call('scanruler_batch', { calls: [] })).text, /give at least one call/)
})

test('a call’s arguments, or a call, given as a string of JSON are read as that JSON; one that is not JSON refuses the batch with nothing run', async () => {
  const ran = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: '{ "n": 7 }' }, JSON.stringify({ tool: 'demo_points', arguments: { n: 8 } }), { tool: 'demo_points', arguments: '' }] })
  assert.equal(ran.error, false, ran.text)
  assert.deepEqual(ran.json.results.map((r) => r.result.matched), [7, 8, undefined])
  const before = page.runs.length
  const broken = await call('scanruler_batch', { calls: [{ tool: 'demo_change', arguments: { n: 1 } }, { tool: 'demo_change', arguments: '{ n: 2 }' }] })
  assert.equal(broken.error, true)
  assert.match(broken.text, /^invalid_input: calls\[1\]\.arguments \(demo_change\) came as a string that is not JSON \(.*\) — give them as an object, \{\} for none\. Nothing was run\.$/)
  assert.equal(page.runs.length, before)
  assert.match((await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: '[1, 2]' }] })).text, /calls\[0\]\.arguments \(demo_points\) came as a string whose JSON is not an object/)
  // The function on its own: a list as it was, anything else no calls.
  assert.deepEqual(callsGiven([{ tool: 'a' }]), { calls: [{ tool: 'a' }] })
  assert.deepEqual(callsGiven(undefined), { calls: [] })
  assert.deepEqual(callsGiven({ tool: 'a' }), { calls: [] })
})

test('a long answer’s spill says what the command itself says to ask for', async () => {
  const long = await call('demo_long', { n: 2_000 })
  assert.equal(long.json.truncated, true)
  assert.match(long.json.note, /ask for less next time \(one part at a time \(part, a dotted path\)\)/)
  // In a batch the same; a command that says nothing gets the server's own
  // word (guide.read's, for a page from before askForLess: fit.test.js).
  const batched = await call('scanruler_batch', { calls: [{ tool: 'demo_long', arguments: { n: 2_000 } }] })
  assert.equal(batched.json.results[0].result.truncated, true)
  assert.match(batched.json.results[0].result.note, /one part at a time/)
  const plain = await call('demo_points', { n: 'x'.repeat(6_000) })
  assert.match(plain.json.note, /ask for less next time \(fields, limit\)/)
})

test('a page that came back empty is told on the next answer — when it reloaded, and the project last opened or saved here — once', async () => {
  const file = join(dir, '14_joycon_01-datums.scanruler')
  await writeFile(file, Buffer.alloc(4))
  const loaded = await call('project_load', { path: file, discard: true })
  assert.equal(loaded.error, false, loaded.text)
  const status = (await call('scanruler_status')).json
  assert.equal(status.lastProject, file)
  assert.equal(status.page.since, '2026-10-24T13:54:00.000Z')
  // Kept with the folders, for a copy started afresh.
  assert.equal(loadLastProject(store), file)
  assert.deepEqual(loadFolders(store), [dir])

  // The page reconnects as itself: nothing to say.
  page = await connect({ pageId: 'page-a', since: '2026-10-24T13:54:00.000Z' })
  assert.equal((await call('demo_points', { n: 1 })).json.pageReloaded, undefined)

  // It reloads: another name, nothing in it.
  page = await connect({ pageId: 'page-b', since: '2026-10-24T14:08:00.000Z' })
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10))
  const next = await call('demo_points', { n: 1 })
  const at = localTime(new Date('2026-10-24T14:08:00.000Z')).slice(11, 16)
  assert.equal(next.json.pageReloaded, `The ScanRuler page reloaded at ${at} and holds nothing now: what the page held before is gone, unless it was saved. The last project opened or saved here was ${file} (project_load opens it).`)
  assert.equal(next.json.matched, 1)
  assert.deepEqual(Object.keys(next.json), ['pageReloaded', 'matched'])
  assert.equal((await call('demo_points', { n: 1 })).json.pageReloaded, undefined, 'said once')

  // A page that held nothing reloads unremarked; one that did is told on a
  // refusal too — after its message — with the project saved since.
  page = await connect({ pageId: 'page-c', since: '2026-10-24T14:10:00.000Z' })
  assert.equal((await call('demo_points', { n: 1 })).json.pageReloaded, undefined)
  const saved = await call('project_save', { path: join(dir, 'joycon-r2.scanruler') })
  assert.equal(saved.error, false, saved.text)
  await call('demo_change', { n: 1 })
  page = await connect({ pageId: 'page-d', since: '2026-10-24T14:20:00.000Z' })
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10))
  const refused = await call('demo_scan')
  assert.equal(refused.error, true)
  assert.match(refused.text, /^no_scan: Open a scan first\. — The ScanRuler page reloaded at \d\d:\d\d and holds nothing now: .*joycon-r2\.scanruler \(project_load opens it\)\.$/)
})

test('a page older than its app: a stale_page answer, or the page’s own word, puts page.stale in the status', async () => {
  page = await connect({ pageId: 'page-e', since: '2026-10-24T14:30:00.000Z' })
  assert.equal((await call('scanruler_status')).json.page.stale, undefined)
  const read = await call('guide_read', { topic: 'model' })
  assert.equal(read.error, true)
  assert.match(read.text, /^stale_page: This tab is older than the app/)
  const status = (await call('scanruler_status')).json
  assert.equal(status.page.stale, true)
  assert.equal(status.page.staleNote, STALE)

  // A new page is not stale — until its session says it is.
  page = await connect({ pageId: 'page-f', since: '2026-10-24T14:40:00.000Z' })
  assert.equal((await call('scanruler_status')).json.page.stale, undefined)
  state = { ...state, stale: { since: '2026-10-24T14:41:00.000Z', note: 'this tab is older than the app it came from' } }
  const said = (await call('scanruler_status')).json
  assert.equal(said.page.stale, true)
  assert.equal(said.page.staleNote, 'this tab is older than the app it came from')
})

test('the last project kept beside folders that cannot be read leaves them, not an empty list', async () => {
  const kept = await mkdtemp(join(tmpdir(), 'scanruler-mcp-folders-'))
  // Half of what another copy was writing, as a read in the middle of it saw.
  await writeFile(join(kept, 'folders.json'), '{"saved":"2026-10-24T14:41:00.000Z","folders":["C:\\\\scans\\\\a",')
  saveLastProject('C:\\scans\\a\\p.scanruler', kept)
  assert.equal(loadFolders(kept), null, 'not written over with no folders')
  saveFolders(['C:\\scans\\a'], kept)
  saveLastProject('C:\\scans\\a\\p.scanruler', kept)
  assert.deepEqual(loadFolders(kept), ['C:\\scans\\a'])
  assert.equal(loadLastProject(kept), 'C:\\scans\\a\\p.scanruler')
})
