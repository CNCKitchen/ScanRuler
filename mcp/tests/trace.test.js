// SPDX-License-Identifier: AGPL-3.0-only
// The call trace: a line per call on every path a call takes — a page tool
// called directly, the server's own tools, each entry of a batch, a change
// answered at once and finished later, the compact list's batch of one and
// scanruler_tools — with the tab's hidden state, and arguments only when
// asked for.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PageLink } from '../src/link.js'
import { createMcpServer } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { createTrace } from '../src/trace.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-trace-tests'
const obj = (properties = {}) => ({ type: 'object', properties, additionalProperties: false })
const COMMANDS = [
  { name: 'session.state', title: 'Read the session', description: 'The session.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.read', title: 'Read', description: 'Reads.', input: obj({ q: { type: 'string' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.change', title: 'Change', description: 'Changes.', input: obj({ n: { type: 'number' }, fail: { type: 'boolean' }, ms: { type: 'number' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'view.render', title: 'Picture', description: 'A picture.', input: obj(), readOnly: true, returnsFile: true, returnsImage: true },
  { name: 'history.checkpoint', title: 'Mark', description: 'Marks.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'history.restore', title: 'Back', description: 'Restores.', input: obj({ checkpoint: { type: 'string' } }), readOnly: false, returnsFile: false, returnsImage: false },
]

async function serve({ tools = 'full', args = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-trace-'))
  const trace = createTrace(dir, { args })
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const server = createMcpServer({ link, version: '0.0.0', cwd: dir, outDir: dir, connectHelp: () => 'Pair it.', serverInfo: () => ({}), pageTimeoutMs: 50, tools, trace })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { page } = await fakePage(http.address().port, {
    token: TOKEN,
    commands: COMMANDS,
    answer: async (name, input) => {
      if (name === 'session.state') return { busy: null, running: null }
      if (name === 'demo.read') return { read: input.q ?? '' }
      if (name === 'history.checkpoint') return { checkpoint: 'cp0' }
      if (name === 'history.restore') return { undone: [] }
      if (name === 'view.render') return { file: { name: 'v.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, width: 4, height: 1 }
      if (name === 'demo.change') {
        if (input.ms) await new Promise((r) => setTimeout(r, input.ms))
        if (input.fail) throw { code: 'invalid_state', message: 'Not now.' }
        return { n: input.n }
      }
      throw { code: 'unknown_command', message: name }
    },
  })
  const call = async (name, input = {}) => {
    const r = await client.callTool({ name, arguments: input })
    return { error: r.isError === true, text: r.content[0].text }
  }
  const lines = async () => {
    const [file] = await readdir(dir)
    assert.equal(join(dir, file), trace.file, 'one file, the one the trace names')
    return (await readFile(trace.file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  }
  const close = async () => {
    await client.close()
    link.close()
    http.close()
  }
  return { client, call, page, lines, close, link }
}

const until = async (check, ms = 5_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out.')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('every call path gets its line: direct, own, batch entries, queued jobs, the list and the tab hidden', async () => {
  const s = await serve()
  try {
    await s.call('scanruler_wait', { timeoutSeconds: 5 })
    await s.client.listTools()
    await s.call('demo_read', { q: 'a secret path' })
    await s.call('demo_change', { n: 1 })
    await s.call('demo_change', { fail: true })
    await s.call('view_render')
    await s.call('scanruler_batch', { calls: [{ tool: 'demo_read', arguments: { q: 'x' } }, { tool: 'demo_change', arguments: { fail: true } }, { tool: 'demo_read' }] })
    const queued = JSON.parse((await s.call('demo_change', { n: 2, ms: 150, wait: false })).text)
    s.page.ws.send(JSON.stringify({ event: 'visibility', hidden: true }))
    await until(() => s.link.page?.hidden === true)
    await s.call('scanruler_wait', { for: 'job', job: queued.job })
    await s.call('no_such_tool')

    const lines = await s.lines()
    const start = lines[0]
    assert.equal(start.ev, 'start')
    assert.equal(start.backend, 'page')
    assert.equal(start.tools, 'full')
    const list = lines.find((l) => l.ev === 'list')
    assert.equal(list.tools, COMMANDS.length + 7)
    assert.ok(list.bytes > 500)

    const calls = lines.filter((l) => l.ev === 'call')
    assert.deepEqual(
      calls.map((l) => l.tool),
      ['scanruler_wait', 'demo_read', 'demo_change', 'demo_change', 'view_render', 'scanruler_batch', 'demo_change', 'scanruler_wait', 'no_such_tool'],
    )
    assert.deepEqual(calls.map((l) => l.call), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const l of calls) {
      assert.equal(typeof l.t, 'number')
      assert.ok(l.ms >= 0)
      assert.ok(l.in >= 2 && l.out > 0)
      assert.equal(l.args, undefined, 'no arguments without --trace-args')
    }
    const [wait, read, changed, refused, picture, batch, queuedCall, waitJob, unknown] = calls
    assert.equal(wait.wait, 'page')
    assert.deepEqual(read.hidden, [false, false])
    assert.equal(read.in, JSON.stringify({ q: 'a secret path' }).length)
    assert.equal(read.error, null)
    assert.match(changed.job, /^j\d+-[0-9a-f]{4}$/)
    assert.equal(changed.queued, undefined)
    assert.equal(refused.error, 'invalid_state')
    assert.equal(picture.images, 1)
    assert.equal(batch.calls, 3)
    assert.equal(batch.error, null, 'a batch stopped part way is answered, not refused')
    assert.equal(queuedCall.queued, true)
    assert.equal(queuedCall.job, queued.job)
    assert.ok(queuedCall.ms < 150, 'answered at once')
    assert.equal(waitJob.wait, 'job')
    assert.equal(waitJob.running, 1, 'the queued change was running when the wait came')
    assert.deepEqual(waitJob.hidden, [true, true])
    assert.equal(unknown.error, 'unknown_command')

    const entries = lines.filter((l) => l.ev === 'entry')
    assert.deepEqual(entries.map((l) => [l.call, l.index, l.tool, l.error]), [
      [batch.call, 0, 'demo_read', null],
      [batch.call, 1, 'demo_change', 'invalid_state'],
    ])
    const job = lines.find((l) => l.ev === 'job')
    assert.equal(job.job, queued.job)
    assert.equal(job.call, queuedCall.call)
    assert.equal(job.tool, 'demo_change')
    assert.ok(job.ms >= 140)
    assert.equal(job.error, null)
    const shown = lines.find((l) => l.ev === 'visibility')
    assert.equal(shown.hidden, true)
  } finally {
    await s.close()
  }
})

test('compact: a batch of one and scanruler_tools are traced, a queued batch too, arguments kept when asked', async () => {
  const s = await serve({ tools: 'compact', args: true })
  try {
    await s.call('scanruler_wait', { timeoutSeconds: 5 })
    await s.call('scanruler_tools')
    await s.call('scanruler_tools', { names: ['demo_change'] })
    await s.call('scanruler_batch', { calls: [{ tool: 'demo_read', arguments: { q: 'p' } }] })
    const queued = JSON.parse((await s.call('scanruler_batch', { calls: [{ tool: 'demo_change', arguments: { n: 3, ms: 50 } }], wait: false })).text)
    await s.call('scanruler_wait', { for: 'job', job: queued.job })
    const lines = await s.lines()
    assert.equal(lines[0].tools, 'compact')
    assert.equal(lines[0].args, true)
    const calls = lines.filter((l) => l.ev === 'call')
    assert.deepEqual(calls.map((l) => l.tool), ['scanruler_wait', 'scanruler_tools', 'scanruler_tools', 'scanruler_batch', 'scanruler_batch', 'scanruler_wait'])
    assert.deepEqual(calls[2].args, { names: ['demo_change'] })
    const entries = lines.filter((l) => l.ev === 'entry')
    assert.deepEqual(entries.map((l) => [l.call, l.index, l.tool]), [
      [calls[3].call, 0, 'demo_read'],
      [calls[4].call, 0, 'demo_change'],
    ])
    assert.deepEqual(entries[0].args, { q: 'p' })
    assert.equal(calls[4].queued, true)
    const job = lines.find((l) => l.ev === 'job')
    assert.equal(job.tool, 'scanruler_batch')
    assert.equal(job.call, calls[4].call)
  } finally {
    await s.close()
  }
})

test('the pairing token is not written to a trace, though the help on connecting gives it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-trace-'))
  const trace = createTrace(dir, { args: true, secrets: [TOKEN] })
  trace.write({ ev: 'call', tool: 'demo_read', args: { q: TOKEN }, head: `unavailable: No ScanRuler page is connected. Enter port 7317 and token ${TOKEN}.` })
  const written = await readFile(trace.file, 'utf8')
  assert.equal(written.includes(TOKEN), false)
  assert.match(JSON.parse(written).head, /and token \[redacted\]\.$/)
})

test('no trace without a directory', () => {
  assert.equal(createTrace(''), null)
  assert.equal(createTrace(undefined), null)
})
