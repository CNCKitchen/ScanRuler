// SPDX-License-Identifier: AGPL-3.0-only
// The answer limit: no call held past it, for a client or a bridge that cuts
// a call at a minute. A change, a batch or a long read still running there
// answers with its job; scanruler_wait waits no longer than it either; and
// a copy of the server started afresh reads a job of the copy before it from
// the page's record (session.recent). A long export queued still writes its
// file, a queued picture comes with its job's answer, and the note at the
// limit says when the tab is hidden. A fake page that keeps that record as
// the app does, behind a real MCP client, with a limit of a fraction of a
// second.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PageLink } from '../src/link.js'
import { createMcpServer } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-limit-tests'
const LIMIT_MS = 250
const obj = (properties = {}) => ({ type: 'object', properties, additionalProperties: false })
const COMMANDS = [
  { name: 'session.state', title: 'Read the session', description: 'The session.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'session.recent', title: 'What recent jobs did', description: 'The record.', input: obj({ job: { type: 'string' }, limit: { type: 'integer' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.update', title: 'Update', description: 'Updates.', input: obj({ n: { type: 'number' }, ms: { type: 'number' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'demo.compare', title: 'Compare', description: 'Compares, slowly.', input: obj({ ms: { type: 'number' } }), readOnly: true, long: true, returnsFile: false, returnsImage: false },
  { name: 'demo.export', title: 'Export', description: 'Exports, slowly.', input: obj({ ms: { type: 'number' } }), readOnly: true, long: true, returnsFile: true, returnsImage: false },
  { name: 'demo.review', title: 'Review', description: 'Reviews, slowly.', input: obj({ ms: { type: 'number' } }), readOnly: true, long: true, returnsFile: false, returnsImage: true },
  { name: 'history.checkpoint', title: 'Mark the history', description: 'Marks.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'history.restore', title: 'Back to a mark', description: 'Restores.', input: obj({ checkpoint: { type: 'string' } }), readOnly: false, returnsFile: false, returnsImage: false },
]

/** The file demo.export hands back, and the picture demo.review does. */
const EXPORTED = 'ISO-10303-21;'
const PICTURE = [0x89, 0x50, 0x4e, 0x47]

/** The page's record of the runs made under a job, oldest first — the
 *  page outlives the server copies, so it is the test's, not a copy's. */
const record = []
let running = 0
const answer = async (name, input, _progress, message) => {
  const entry = message.job ? { job: message.job, name, state: 'running', started: new Date().toISOString(), ms: null } : null
  if (entry) record.push(entry)
  const since = Date.now()
  const done = (result) => {
    if (entry) Object.assign(entry, { state: 'done', ms: Date.now() - since, result })
    return result
  }
  if (name === 'session.state') return { busy: null, running: running > 0 ? 'demo.update' : null }
  if (name === 'session.recent') return { outcomes: record.filter((o) => input.job === undefined || o.job === input.job).reverse().slice(0, input.limit ?? 20) }
  if (name === 'history.checkpoint') return done({ checkpoint: 'cp1' })
  if (name === 'demo.update' || name === 'demo.compare') {
    running++
    await new Promise((r) => setTimeout(r, input.ms ?? 30))
    running--
    return done(name === 'demo.update' ? { n: input.n } : { rms: 0.1 })
  }
  if (name === 'demo.export' || name === 'demo.review') {
    await new Promise((r) => setTimeout(r, input.ms ?? 30))
    if (entry) Object.assign(entry, { state: 'done', ms: Date.now() - since, result: { file: { bytes: '4 bytes' }, of: name } })
    return name === 'demo.export'
      ? { file: { name: 'part-body.step', mimeType: 'model/step', bytes: new TextEncoder().encode(EXPORTED) }, status: 'One body.' }
      : { file: { name: 'part-review.png', mimeType: 'image/png', bytes: new Uint8Array(PICTURE) }, rms: 0.1 }
  }
  throw { code: 'unknown_command', message: name }
}

const closers = []
after(async () => {
  for (const close of closers.reverse()) await close()
})

/** A copy of the server on its own port, the fake page connected to it. */
async function copy({ answerWithinMs = LIMIT_MS, answers = answer } = {}) {
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const server = createMcpServer({ link, version: '0.0.0', cwd: '.', outDir: '.', connectHelp: () => 'Pair it.', serverInfo: () => ({}), pageTimeoutMs: 50, answerWithinMs })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { page } = await fakePage(http.address().port, { token: TOKEN, commands: COMMANDS, answer: answers })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await client.close()
    page.close()
    link.close()
    http.close()
  }
  closers.push(close)
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content[0].text
    return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text), images: r.content.filter((c) => c.type === 'image') }
  }
  return { client, call, page, close, link }
}

/** scanruler_wait for a job, called again while it says running. */
async function waitFor(call, job) {
  for (let i = 0; i < 100; i++) {
    const r = await call('scanruler_wait', { for: 'job', job })
    if (r.error || r.json.state !== 'running') return r
  }
  throw new Error(`${job} still running`)
}

test('a 15-update batch answers queued at the limit, scanruler_wait finds it, and a copy started afresh finds it again through session.recent', async () => {
  const first = await copy()
  const calls = Array.from({ length: 15 }, (_, n) => ({ tool: 'demo_update', arguments: { n, ms: 40 } }))
  const started = Date.now()
  const queued = await first.call('scanruler_batch', { calls })
  const took = Date.now() - started
  assert.equal(queued.json.queued, true)
  assert.equal(queued.json.tool, 'scanruler_batch')
  assert.equal(queued.json.after, LIMIT_MS / 1000)
  assert.match(queued.json.note, /scanruler_wait/)
  assert.ok(took >= LIMIT_MS - 20 && took < LIMIT_MS + 400, `answered after ${took} ms`)
  assert.match(queued.json.job, /^j\d+-[0-9a-f]{4}$/)

  // scanruler_wait is held no longer than the limit either: running, then
  // asked again, the batch's answer.
  const at = Date.now()
  const still = await first.call('scanruler_wait', { for: 'job', job: queued.json.job, timeoutSeconds: 60 })
  assert.equal(still.json.state, 'running')
  assert.ok(Date.now() - at < LIMIT_MS + 400)
  const done = await waitFor(first.call, queued.json.job)
  assert.equal(done.json.state, 'done')
  assert.equal(done.json.result.ran, 15)
  assert.deepEqual(done.json.result.results.map((r) => r.result.n), [...Array(15).keys()])
  assert.ok(first.page.runs.filter((m) => m.name === 'demo.update').every((m) => m.job === queued.json.job), 'each call sent under the batch’s job')
  await first.close()

  // A copy started afresh knows no such job; the page does.
  const second = await copy()
  const status = await second.call('scanruler_status')
  assert.equal(status.json.jobs, undefined)
  assert.equal(status.json.server.answerWithin, LIMIT_MS / 1000)
  const found = await second.call('scanruler_wait', { for: 'job', job: queued.json.job })
  assert.equal(found.error, false, found.text)
  assert.equal(found.json.job, queued.json.job)
  assert.equal(found.json.state, 'ended')
  assert.match(found.json.from, /^the page \(session\.recent\): this server copy, started at .* did not start j/)
  assert.deepEqual(found.json.calls.map((c) => c.tool), ['history_checkpoint', ...Array(15).fill('demo_update')])
  assert.ok(found.json.calls.every((c) => c.state === 'done'))
  assert.deepEqual(found.json.calls.at(-1).result, { n: 14 })
  // A job neither knows is not found.
  const missing = await second.call('scanruler_wait', { for: 'job', job: 'j9-ffff' })
  assert.equal(missing.error, true)
  assert.match(missing.text, /^not_found: There is no job "j9-ffff"/)
  // The new copy's own jobs are not the old one's.
  const mine = await second.call('demo_update', { n: 99, ms: 5 })
  assert.equal(mine.json.n, 99)
  assert.notEqual((await second.call('scanruler_status')).json.jobs[0].job, queued.json.job)
  await second.close()
})

test('a single change past the limit answers queued, and a copy started afresh says it is running while it runs', async () => {
  const first = await copy()
  const queued = await first.call('demo_update', { n: 1, ms: 700 })
  assert.equal(queued.json.queued, true)
  assert.equal(queued.json.tool, 'demo_update')
  await first.close()
  const second = await copy()
  const running = await second.call('scanruler_wait', { for: 'job', job: queued.json.job })
  assert.equal(running.json.state, 'running')
  assert.equal(running.json.tool, 'demo_update')
  const done = await waitFor(second.call, queued.json.job)
  assert.equal(done.json.state, 'done')
  assert.deepEqual(done.json.result, { n: 1 })
  // Quick ones answer as they always did.
  assert.deepEqual((await second.call('demo_update', { n: 2, ms: 5 })).json, { n: 2 })
  await second.close()
})

test('a long read takes wait and runs as a job; the idle wait is held to the limit too', async () => {
  const one = await copy()
  const tools = (await one.client.listTools()).tools
  assert.ok(tools.find((t) => t.name === 'demo_compare').inputSchema.properties.wait, 'a long read takes wait')
  assert.equal(tools.find((t) => t.name === 'demo_compare').inputSchema.properties.timings, undefined)
  assert.equal(tools.find((t) => t.name === 'session_state').inputSchema.properties.wait, undefined, 'a quick read does not')
  const queued = await one.call('demo_compare', { ms: 400, wait: false })
  assert.equal(queued.json.queued, true)
  for (let i = 0; i < 100 && !one.page.runs.some((m) => m.name === 'demo.compare'); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(one.page.runs.find((m) => m.name === 'demo.compare').job, queued.json.job)
  assert.deepEqual(one.page.runs.find((m) => m.name === 'demo.compare').input, { ms: 400 }, 'wait is the server’s')
  const at = Date.now()
  const idle = await one.call('scanruler_wait', { for: 'idle', timeoutSeconds: 30 })
  assert.equal(idle.json.state, 'running')
  assert.ok(Date.now() - at < LIMIT_MS + 600)
  assert.deepEqual((await waitFor(one.call, queued.json.job)).json.result, { rms: 0.1 })
  const later = await one.call('scanruler_wait', { for: 'idle' })
  assert.equal(later.json.state, 'idle')
  // Past the limit without wait: false, queued all the same.
  assert.equal((await one.call('demo_compare', { ms: 500 })).json.queued, true)
  await one.close()
})

test('a long export takes wait, answers queued at once or at the limit, and still writes its file to path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-limit-'))
  const one = await copy()
  const schema = (await one.client.listTools()).tools.find((t) => t.name === 'demo_export').inputSchema
  assert.ok(schema.properties.wait, 'a long export takes wait')
  assert.ok(schema.properties.path, 'and its path as before')
  const queued = await one.call('demo_export', { ms: 400, path: join(dir, 'asked.step'), wait: false })
  assert.deepEqual(Object.keys(queued.json).sort(), ['job', 'queued', 'tool'])
  assert.equal(queued.json.queued, true)
  const done = await waitFor(one.call, queued.json.job)
  assert.equal(done.json.state, 'done')
  assert.equal(done.json.result.file.path, join(dir, 'asked.step'))
  assert.equal(done.json.result.status, 'One body.')
  assert.equal(await readFile(join(dir, 'asked.step'), 'utf8'), EXPORTED)
  assert.deepEqual(one.page.runs.find((m) => m.name === 'demo.export').input, { ms: 400 }, 'path and wait are the server’s')
  // Past the limit without wait: false, the same, into a folder.
  const late = await one.call('demo_export', { ms: LIMIT_MS + 200, path: `${dir}/late/` })
  assert.equal(late.json.queued, true)
  assert.equal(late.json.after, LIMIT_MS / 1000)
  const landed = await waitFor(one.call, late.json.job)
  assert.equal(landed.json.result.file.path, join(dir, 'late', 'part-body.step'))
  assert.equal(await readFile(landed.json.result.file.path, 'utf8'), EXPORTED)
  // Quick, it answers as it did.
  assert.equal((await one.call('demo_export', { ms: 5, path: join(dir, 'quick.step') })).json.file.path, join(dir, 'quick.step'))
  await one.close()
})

test('a job’s picture comes with its answer through scanruler_wait, but not with idle, and a copy started afresh says it has none', async () => {
  const first = await copy()
  // Called directly, as the job's answer is to match.
  const direct = await first.call('demo_review', { ms: 5 })
  assert.deepEqual([...Buffer.from(direct.images[0].data, 'base64')], PICTURE)
  const queued = await first.call('demo_review', { ms: LIMIT_MS + 150 })
  assert.equal(queued.json.queued, true)
  assert.deepEqual(queued.images, [])
  const done = await waitFor(first.call, queued.json.job)
  assert.equal(done.json.state, 'done')
  assert.equal(done.json.result.rms, direct.json.rms)
  assert.deepEqual(done.json.result.file, direct.json.file)
  assert.equal(done.images.length, 1)
  assert.equal(done.images[0].mimeType, 'image/png')
  assert.deepEqual([...Buffer.from(done.images[0].data, 'base64')], PICTURE)
  // Still running, none; and idle lists the job without it.
  const again = await first.call('demo_review', { ms: 200, wait: false })
  const running = await first.call('scanruler_wait', { for: 'job', job: again.json.job, timeoutSeconds: 0.02 })
  assert.equal(running.json.state, 'running')
  assert.deepEqual(running.images, [])
  const idle = await first.call('scanruler_wait', { for: 'idle', timeoutSeconds: 5 })
  assert.deepEqual(idle.images, [])
  assert.ok(idle.json.finished.some((j) => j.job === again.json.job))
  await first.close()

  const second = await copy()
  const kept = await second.call('scanruler_wait', { for: 'job', job: queued.json.job })
  assert.equal(kept.json.state, 'done')
  assert.deepEqual(kept.images, [])
  assert.match(kept.json.from, /no picture or file it gave\.$/)
  await second.close()
})

test('the note at the limit says the tab is hidden, while it is, and no more', async () => {
  const one = await copy()
  const shown = await one.call('demo_compare', { ms: LIMIT_MS + 100 })
  assert.match(shown.json.note, /^Still running after 0\.25 s, and running on\. scanruler_wait/)
  one.page.ws.send(JSON.stringify({ event: 'visibility', hidden: true }))
  for (let i = 0; i < 100 && !(await one.call('scanruler_status')).json.page.hidden; i++) await new Promise((r) => setTimeout(r, 10))
  const hidden = await one.call('demo_compare', { ms: LIMIT_MS + 100 })
  assert.match(hidden.json.note, /^Still running after 0\.25 s, and running on; the ScanRuler tab is hidden\. scanruler_wait/)
  // Only on the slow path: a queued answer and a quick one say nothing of it.
  assert.equal((await one.call('demo_compare', { ms: 5, wait: false })).json.note, undefined)
  assert.equal((await one.call('demo_compare', { ms: 5 })).json.note, undefined)
  await one.close()
})

test('--answer-within 0 holds a call to its end', async () => {
  const one = await copy({ answerWithinMs: 0 })
  assert.deepEqual((await one.call('demo_update', { n: 3, ms: LIMIT_MS + 100 })).json, { n: 3 })
  assert.equal((await one.call('scanruler_status')).json.server.answerWithin, null)
  await one.close()
})

test('an answer limit or a wait too long for a timer still waits, as does a wait with a timeout that is not a number', async () => {
  const one = await copy({ answerWithinMs: 1e10 })
  assert.deepEqual((await one.call('demo_update', { n: 4, ms: 150 })).json, { n: 4 }, 'not queued at once')
  await one.close()
  const two = await copy({ answerWithinMs: 0 })
  for (const timeoutSeconds of [1e10, 'soon', -1]) {
    const { job } = (await two.call('demo_update', { n: 5, ms: 150, wait: false })).json
    const waited = await two.call('scanruler_wait', { for: 'job', job, timeoutSeconds })
    assert.equal(waited.json.state, 'done', `timeoutSeconds ${timeoutSeconds}`)
  }
  await two.close()
})

test('a page that never answers: a read, a wait for idle and a wait for a job of another copy answer within the limit, and nothing is left waiting', async () => {
  const one = await copy({ answerWithinMs: 300, answers: () => new Promise(() => {}) })
  for (const [name, args] of [
    ['session_state', {}],
    ['scanruler_wait', { for: 'idle', timeoutSeconds: 1 }],
    ['scanruler_wait', { for: 'job', job: 'j9-zzzz', timeoutSeconds: 1 }],
  ]) {
    const at = Date.now()
    const r = await Promise.race([one.call(name, args), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000))])
    assert.notEqual(r, 'still waiting', `${name} ${JSON.stringify(args)}`)
    assert.ok(Date.now() - at < 1000, `${name} answered after ${Date.now() - at} ms`)
  }
  assert.equal(one.link.pending.size, 0)
  await one.close()
})
