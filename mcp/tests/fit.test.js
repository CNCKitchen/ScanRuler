// SPDX-License-Identifier: AGPL-3.0-only
// Answers that fit an agent's context: one past the cap written whole to a
// file and named — in scanruler-work in the folder the scan open now came
// from, else the server's own — in a call, a batch and a job's wait, the notes for the
// agent kept in its brief; the status listing the jobs running and the
// newest few, however many were kept, and the time here; and a scan path
// that is not there answered with the names near it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PageLink } from '../src/link.js'
import { ANSWER_CAP, createMcpServer, localTime } from '../src/mcp.js'
import { nearNames } from '../src/tools.js'
import { httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-fit-tests'
const obj = (properties = {}) => ({ type: 'object', properties, additionalProperties: false })
const COMMANDS = [
  { name: 'session.state', title: 'Read the session', description: 'The session.', input: obj(), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.points', title: 'Points', description: 'Reads n points.', input: obj({ n: { type: 'number' }, notes: { type: 'boolean' }, nested: { type: 'boolean' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'demo.change', title: 'Change', description: 'Changes.', input: obj({ n: { type: 'number' }, points: { type: 'number' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'scan.open', title: 'Open a scan', description: 'Opens one.', input: obj({ bytes: { type: 'string', format: 'binary' }, name: { type: 'string' }, discard: { type: 'boolean' } }), readOnly: false, returnsFile: false, returnsImage: false },
  { name: 'project.save', title: 'Save the project', description: 'Saves it.', input: obj(), readOnly: true, returnsFile: true, returnsImage: false },
  { name: 'guide.read', title: 'Read a guide', description: 'Reads one.', input: obj({ topic: { type: 'string' }, chars: { type: 'number' } }), readOnly: true, returnsFile: false, returnsImage: false },
  { name: 'view.render', title: 'Picture the view', description: 'Pictures it.', input: obj({ view: { type: 'string' } }), readOnly: true, returnsFile: false, returnsImage: true },
]
/** The pictures view.render gives, a byte of their own each, the first the slower. */
const VIEWS = { front: [0x89, 0x50, 1], top: [0x89, 0x50, 2] }
/** n points, as a read with every point in it answers: ~30 characters each. */
const points = (n) => Array.from({ length: n }, (_, i) => [i + 0.123456, -i - 0.654321, 2 * i + 0.5])
/** The notes an answer carries for the agent, as a workspace's commands give them. */
const NOTES = { open: 2, new: [7], read: 'note.list { note } reads one.' }

let dir
let link
let http
let client
let page
/** The scan the page holds — what scan.open opened, or one opened by hand. */
let held = 'top_scan_aligned.stl'

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-fit-'))
  link = new PageLink({ token: TOKEN })
  http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  // As the server says of itself when run from npm.
  const serverInfo = () => ({ name: 'scanruler-mcp', version: '0.4.0', port: 7317, role: 'holder', tools: 'full', outDir: dir, config: join(dir, 'config.json') })
  const server = createMcpServer({ link, version: '0.4.0', cwd: dir, outDir: dir, connectHelp: () => 'Pair it.', serverInfo, pageTimeoutMs: 50 })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  ;({ page } = await fakePage(http.address().port, {
    token: TOKEN,
    commands: COMMANDS,
    answer: async (name, input) => {
      if (name === 'session.state') return { busy: null, running: null, scan: { fileName: held }, project: { name: 'Scooter head', unsaved: true, holds: { elements: 4, features: 30 } } }
      if (name === 'demo.points') return { matched: input.n, returned: input.n, from: 'a box', points: points(input.n), ...(input.notes ? { notes: NOTES } : {}), ...(input.nested ? { part: { bodies: 3, names: 'x'.repeat(300), notes: NOTES } } : {}) }
      if (name === 'demo.change') return { n: input.n, ...(input.points ? { points: points(input.points) } : {}) }
      if (name === 'scan.open') {
        // A scan the page cannot read: refused, after the session was let go.
        if (input.name === 'broken.stl') throw { code: 'failed', message: 'The scan could not be read.' }
        held = input.name
        return { scan: { fileName: input.name } }
      }
      if (name === 'project.save') return { file: { name: 'Scooter head.scanruler', mimeType: 'application/zip', bytes: new Uint8Array([0x50, 0x4b]) } }
      if (name === 'guide.read') return { guides: [{ topic: input.topic, text: 'g'.repeat(input.chars) }] }
      if (name === 'view.render') {
        await new Promise((r) => setTimeout(r, input.view === 'front' ? 80 : 10))
        return { file: { name: 'part-view.png', mimeType: 'image/png', bytes: new Uint8Array(VIEWS[input.view]) }, view: input.view }
      }
      throw { code: 'unknown_command', message: name }
    },
  }))
})
after(async () => {
  await client.close()
  page.close()
  link.close()
  http.close()
})

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content[0].text
  return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text) }
}

test('an answer within the cap comes whole; one past it is written to a file and named', async () => {
  const small = await call('demo_points', { n: 10 })
  assert.equal(small.json.points.length, 10)
  const big = await call('demo_points', { n: 5000 })
  assert.ok(big.text.length < 2_000, `${big.text.length} characters`)
  assert.equal(big.json.truncated, true)
  assert.deepEqual(big.json.keys, ['matched', 'returned', 'from', 'points'])
  assert.deepEqual(big.json.brief, { matched: 5000, returned: 5000, from: 'a box' })
  assert.ok(big.json.bytes > ANSWER_CAP)
  assert.ok(big.json.file.startsWith(dir) && big.json.file.endsWith('.json'))
  assert.match(big.json.note, /written whole to file/)
  // No scan opened from a folder yet: the server's own, and the note says so.
  assert.match(big.json.note, /the server's output folder: the scan open now was not opened from a folder through this server.$/)
  const whole = JSON.parse(await readFile(big.json.file, 'utf8'))
  assert.equal(whole.points.length, 5000)
  // As the answer would have given them: six significant digits.
  assert.deepEqual(whole.points[1], [1.12346, -1.65432, 2.5])
  // A second one is not written over the first.
  const again = await call('demo_points', { n: 5000 })
  assert.notEqual(again.json.file, big.json.file)
})

test('scanruler_read gives a spilled answer back in parts, each within the cap — from the server’s own folder, with no scan’s folder known', async () => {
  const big = await call('demo_points', { n: 5000 })
  assert.match(big.json.note, /scanruler_read \{ path: file \}/)
  let whole = ''
  let offset = 0
  let parts = 0
  for (;;) {
    const part = await call('scanruler_read', { path: big.json.file, offset })
    assert.equal(part.error, false, part.text)
    assert.ok(part.text.length <= ANSWER_CAP, `${part.text.length} characters`)
    assert.equal(part.json.offset, offset)
    assert.equal(part.json.size, big.json.bytes)
    whole += part.json.text
    parts++
    if (part.json.nextOffset === undefined) break
    assert.ok(part.json.nextOffset > offset)
    offset = part.json.nextOffset
  }
  assert.ok(parts > 1, `${parts} parts`)
  assert.equal(whole, await readFile(big.json.file, 'utf8'))
  assert.equal(JSON.parse(whole).points.length, 5000)
  // Any other file there is not read: the server's folder is no scan's.
  await writeFile(join(dir, 'beside-the-spill.json'), '{}')
  const other = await call('scanruler_read', { path: join(dir, 'beside-the-spill.json') })
  assert.equal(other.error, true)
  assert.match(other.text, /^invalid_state: .*scan_open/)
})

test('a batch caps each result, and the whole when many together are past the cap', async () => {
  const one = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: { n: 5000 } }, { tool: 'demo_points', arguments: { n: 3 } }] })
  assert.equal(one.json.results[0].result.truncated, true)
  assert.equal(one.json.results[1].result.points.length, 3)
  // Twenty reads of 1000 points: each under the cap, all together past it.
  const many = await call('scanruler_batch', { calls: Array.from({ length: 20 }, () => ({ tool: 'demo_points', arguments: { n: 1000 } })) })
  assert.equal(many.json.truncated, true)
  assert.equal(many.json.brief.ran, 20)
  assert.equal(many.json.brief.of, 20)
  assert.ok(many.text.length < 2_000)
  const whole = JSON.parse(await readFile(many.json.file, 'utf8'))
  assert.equal(whole.results.length, 20)
  assert.equal(whole.results[19].result.points.length, 1000)
})

test('a job’s answer read by scanruler_wait is capped the same', async () => {
  const queued = await call('demo_change', { n: 1, points: 5000, wait: false })
  const answer = await call('scanruler_wait', { for: 'job', job: queued.json.job, timeoutSeconds: 5 })
  assert.equal(answer.json.state, 'done')
  assert.equal(answer.json.result.truncated, true)
  assert.ok(answer.text.length < 2_000)
})

test('the status lists the jobs running and the newest five, and stays small after fifty', async () => {
  for (let n = 0; n < 60; n++) await call('demo_change', { n })
  const status = await call('scanruler_status')
  assert.equal(status.json.jobs.length, 5)
  assert.equal(status.json.jobsMore, 45, 'the fifty kept, less the five listed')
  assert.deepEqual(status.json.jobs.map((j) => j.state), ['done', 'done', 'done', 'done', 'done'])
  assert.ok(status.text.length < 1_500, `${status.text.length} characters`)
  // wait { idle } says the state and what finished — not the status again.
  const idle = await call('scanruler_wait', { for: 'idle', timeoutSeconds: 5 })
  assert.deepEqual(Object.keys(idle.json).sort(), ['connected', 'finished', 'state'])
  assert.equal(idle.json.state, 'idle')
})

test('a scan path that is not there is answered with the names near it', async () => {
  const folder = join(dir, 'reverseengineer', '10_scooterHead')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'top_scan_aligned.stl'), Buffer.alloc(84))
  await writeFile(join(folder, 'top-scan-aligned.ply'), Buffer.alloc(10))
  await writeFile(join(folder, 'notes.md'), 'n')
  // A file name a letter and a separator off: the near names in its folder.
  const typo = await call('scan_open', { path: join(folder, 'top scan_alligned.stl') })
  assert.equal(typo.error, true)
  assert.match(typo.text, /there is no such file\. Near it: /)
  assert.ok(typo.text.includes(join(folder, 'top_scan_aligned.stl')))
  assert.ok(!typo.text.includes('notes.md'))
  // A folder off: the near folder, with the rest of the path where it is in it.
  const near = await nearNames(join(dir, 'reverseengineer', '10_scooter_head', 'top_scan_aligned.stl'))
  assert.equal(near.folder, join(dir, 'reverseengineer'))
  assert.equal(near.missing, '10_scooter_head')
  assert.deepEqual(near.near, [join(folder, 'top_scan_aligned.stl')])
  // Nothing near: the folder that is there is named.
  const none = await call('scan_open', { path: join(dir, 'reverseengineer', 'fan', 'wheel.stl') })
  assert.match(none.text, /reverseengineer is there, with nothing in it named like fan\./)
  // At most five, the nearest first.
  for (const n of ['a1.stl', 'a2.stl', 'a3.stl', 'a4.stl', 'a5.stl', 'a6.stl', 'ab.stl']) await writeFile(join(folder, n), 'x')
  const many = await nearNames(join(folder, 'a.stl'))
  assert.equal(many.near.length, 5)
})

test('a guide answers up to 70 k characters before it spills, and its spill says to read it by section; other answers keep the cap', async () => {
  const both = await call('guide_read', { topic: 'model', chars: 62_000 })
  assert.equal(both.json.truncated, undefined, 'two guides read together arrive whole')
  assert.equal(both.json.guides[0].text.length, 62_000)
  const huge = await call('guide_read', { topic: 'model', chars: 75_000 })
  assert.equal(huge.json.truncated, true)
  assert.match(huge.json.note, /past the 70 k an answer carries.*one section at a time \(section, by its heading/)
  // Anything else spills past the cap, and says fields and limit.
  const points = await call('demo_points', { n: 1600 })
  assert.equal(points.json.truncated, true)
  assert.match(points.json.note, /past the 40 k.*\(fields, limit\)/)
  // A batch with a guide in it answers as long.
  const batch = await call('scanruler_batch', { calls: [{ tool: 'guide_read', arguments: { topic: 'model', chars: 60_000 } }] })
  assert.equal(batch.json.truncated, undefined)
  assert.equal(batch.json.results[0].result.guides[0].text.length, 60_000)
})

test('two pictures asked at once each come back as their own, in files of their own', async () => {
  const shots = join(dir, 'shots')
  await mkdir(shots, { recursive: true })
  const render = (view) => client.callTool({ name: 'view_render', arguments: { view, path: shots, inline: false } })
  const [front, top] = (await Promise.all([render('front'), render('top')])).map((r) => JSON.parse(r.content[0].text))
  assert.equal(front.view, 'front')
  assert.equal(top.view, 'top')
  assert.notEqual(front.file.path, top.file.path)
  assert.deepEqual([...(await readFile(front.file.path))], VIEWS.front)
  assert.deepEqual([...(await readFile(top.file.path))], VIEWS.top)
  // Shown too, each its own picture.
  const shown = await Promise.all(['front', 'top'].map((view) => client.callTool({ name: 'view_render', arguments: { view } })))
  assert.deepEqual(shown.map((r) => [...Buffer.from(r.content[1].data, 'base64')]), [VIEWS.front, VIEWS.top])
  // A folder path again: numbered past the two there, never over them.
  const again = JSON.parse((await render('front')).content[0].text)
  assert.ok(![front.file.path, top.file.path].includes(again.file.path), again.file.path)
  assert.deepEqual([...(await readFile(top.file.path))], VIEWS.top)
})

test('the notes for the agent are kept in a spilled answer’s brief — at its top or a level down — and at a batch’s top', async () => {
  const big = await call('demo_points', { n: 5000, notes: true, nested: true })
  assert.equal(big.json.truncated, true)
  assert.deepEqual(big.json.brief, { matched: 5000, returned: 5000, from: 'a box', notes: NOTES, part: { notes: NOTES } })
  // A batch: the last call's notes at the top, whole or spilled.
  const batch = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: { n: 3, notes: true } }, { tool: 'demo_points', arguments: { n: 3 } }] })
  assert.deepEqual(batch.json.notes, NOTES)
  const none = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: { n: 3 } }] })
  assert.equal(none.json.notes, undefined)
  const spilledCall = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: { n: 5000, notes: true } }] })
  assert.equal(spilledCall.json.results[0].result.truncated, true)
  assert.deepEqual(spilledCall.json.notes, NOTES)
  // Many together past the cap: the batch's brief keeps them.
  const many = await call('scanruler_batch', { calls: Array.from({ length: 20 }, (_, i) => ({ tool: 'demo_points', arguments: { n: 1000, notes: i === 3 } })) })
  assert.equal(many.json.truncated, true)
  assert.deepEqual(many.json.brief.notes, NOTES)
})

test('the status says the time here, local, with its offset', async () => {
  const before = Math.floor(Date.now() / 1000) * 1000
  const status = await call('scanruler_status')
  const now = status.json.server.now
  assert.match(now, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  const at = Date.parse(now)
  assert.ok(at >= before && at <= Date.now(), `${now} is now`)
  // The offset is this computer's own: the time read back is the instant.
  const d = new Date(2026, 9, 23, 18, 4, 5)
  assert.ok(localTime(d).startsWith('2026-10-23T18:04:05'))
  assert.equal(Date.parse(localTime(d)), d.getTime())
  const winter = new Date(2026, 0, 2, 3, 4, 5)
  assert.equal(Date.parse(localTime(winter)), winter.getTime())
})

test('once a scan is opened from a folder, a spilled answer and a batch’s picture go into scanruler-work there, and the answer says so', async () => {
  const folder = join(dir, 'reverseengineer', '13_rumblePack')
  const work = join(folder, 'scanruler-work')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'pak.stl'), Buffer.alloc(84))
  const opened = await call('scan_open', { path: join(folder, 'pak.stl') })
  assert.equal(opened.error, false, opened.text)
  const big = await call('demo_points', { n: 5000 })
  assert.equal(big.json.truncated, true)
  assert.equal(dirname(big.json.file), work)
  assert.ok(big.json.note.endsWith(`It is in ${work}, scanruler-work in the folder the scan open now was opened from.`), big.json.note)
  assert.equal(JSON.parse(await readFile(big.json.file, 'utf8')).points.length, 5000)
  // In a batch, the same; and a picture without a path is written there,
  // the result naming the folder — not among the person's files beside
  // the scan.
  const batch = await call('scanruler_batch', { calls: [{ tool: 'demo_points', arguments: { n: 5000 } }, { tool: 'view_render', arguments: { view: 'top' } }] })
  assert.equal(dirname(batch.json.results[0].result.file), work)
  const picture = batch.json.results[1].result.file.path
  assert.equal(dirname(picture), work)
  assert.equal(batch.json.results[1].result.file.folder, work)
  assert.deepEqual([...(await readFile(picture))], VIEWS.top)
  // scanruler_files lists it under the scan's folder.
  const listed = await call('scanruler_files', { path: 'scanruler-work' })
  assert.equal(listed.error, false, listed.text)
  assert.ok(JSON.stringify(listed.json).includes(basename(picture)), listed.text)
  // A path given still wins.
  const shots = join(dir, 'shots-asked')
  const asked = await call('scanruler_batch', { calls: [{ tool: 'view_render', arguments: { view: 'front', path: `${shots}/` } }] })
  assert.equal(dirname(asked.json.results[0].result.file.path), shots)
})

test('scanruler_read reads text under the scan’s folder, by the rule scanruler_files keeps, cut on a character and within the cap however its text escapes', async () => {
  const folder = join(dir, 'reverseengineer', '14_reader')
  await mkdir(join(folder, 'report'), { recursive: true })
  await writeFile(join(folder, 'reader.stl'), Buffer.alloc(84))
  assert.equal((await call('scan_open', { path: join(folder, 'reader.stl') })).error, false)
  const read = async (args) => (await call('scanruler_read', args))
  await writeFile(join(folder, 'report', 'notes.md'), '# Sigma\n\nRMS 0.067 mm\n')
  // Relative and absolute, a folder under it; a whole small file has no nextOffset.
  assert.deepEqual((await read({ path: 'report/notes.md' })).json, { text: '# Sigma\n\nRMS 0.067 mm\n', offset: 0, size: 22 })
  assert.equal((await read({ path: join(folder, 'report', 'notes.md') })).json.size, 22)
  // In parts, by limit; past its end, nothing.
  assert.deepEqual((await read({ path: 'report/notes.md', limit: 7 })).json, { text: '# Sigma', offset: 0, nextOffset: 7, size: 22 })
  assert.deepEqual((await read({ path: 'report/notes.md', offset: 9, limit: 3 })).json, { text: 'RMS', offset: 9, nextOffset: 12, size: 22 })
  assert.deepEqual((await read({ path: 'report/notes.md', offset: 100 })).json, { text: '', offset: 22, size: 22 })
  // Another folder scanruler_status lists is read too; one it does not, not.
  const earlier = (await call('scanruler_status')).json.folders.find((f) => f !== folder)
  await writeFile(join(earlier, 'earlier.txt'), 'kept')
  assert.equal((await read({ path: join(earlier, 'earlier.txt') })).json.text, 'kept')
  for (const [path, why] of [
    ['../escape.md', /^invalid_input: path: "\.\."/],
    [join(tmpdir(), 'elsewhere.md'), /^invalid_input: path: .* is outside the folders/],
    ['reader.stl', /^invalid_input: path: only \.md, \.txt, \.csv, \.json, \.jsonl files are read, as text — not "\.stl"/],
    ['shot.png', /not "\.png"/],
    ['part.step', /not "\.step"/],
    ['LICENSE', /not "no extension"/],
    ['missing.md', /^not_found: .*there is no such file/],
  ]) {
    const refused = await read({ path })
    assert.equal(refused.error, true, path)
    assert.match(refused.text, why)
  }
  for (const args of [{ path: 'report/notes.md', offset: -1 }, { path: 'report/notes.md', limit: 0 }, {}]) assert.equal((await read(args)).error, true, JSON.stringify(args))
  // A name that says text over bytes that are not.
  await writeFile(join(folder, 'pretend.txt'), Buffer.from([0x48, 0xff, 0xfe, 0x00]))
  assert.match((await read({ path: 'pretend.txt' })).text, /^invalid_input: .*does not read as UTF-8 text/)

  // One, two, three and four bytes a character, and every read of them cut
  // somewhere: nothing lost, nothing split, whatever the limit or the offset.
  const mixed = 'aé€😀'.repeat(50)
  await writeFile(join(folder, 'mixed.txt'), mixed)
  const size = Buffer.byteLength(mixed, 'utf8')
  for (const limit of [1, 2, 3, 5, 7, 64]) {
    let whole = ''
    let offset = 0
    for (;;) {
      const part = (await read({ path: 'mixed.txt', offset, limit })).json
      whole += part.text
      if (part.nextOffset === undefined) break
      assert.ok(part.nextOffset > offset, `limit ${limit} at ${offset}`)
      offset = part.nextOffset
    }
    assert.equal(whole, mixed, `limit ${limit}`)
  }
  // An offset inside a character starts at the next: é is at 1 and 2.
  assert.deepEqual((await read({ path: 'mixed.txt', offset: 2, limit: 3 })).json, { text: '€', offset: 3, nextOffset: 6, size })

  // Text that doubles as JSON, past the cap: the answer, not the text, is what fits.
  const quoted = '"\\'.repeat(ANSWER_CAP)
  await writeFile(join(folder, 'quoted.json'), quoted)
  let whole = ''
  let offset = 0
  for (;;) {
    const part = await read({ path: 'quoted.json', offset })
    assert.ok(part.text.length <= ANSWER_CAP, `${part.text.length} characters`)
    whole += part.json.text
    if (part.json.nextOffset === undefined) break
    offset = part.json.nextOffset
  }
  assert.equal(whole, quoted)
})

test('a spilled answer goes to the folder of the scan open now — never to the one the replaced session was saved into, nor one a scan opened by hand has left', async () => {
  const before = join(dir, 'reverseengineer', '15_clamp')
  const part = join(dir, 'reverseengineer', '16_lamp')
  await mkdir(before, { recursive: true })
  await mkdir(part, { recursive: true })
  await writeFile(join(part, 'broken.stl'), Buffer.alloc(84))
  await writeFile(join(part, 'Mesh.stl'), Buffer.alloc(84))
  const spillFolder = async () => dirname((await call('demo_points', { n: 5000 })).json.file)
  // The person opened the previous part's scan in the tab by hand: not the
  // one this server opened, so not its folder.
  held = 'Mesh.stl'
  assert.equal(await spillFolder(), dir)
  const batch = await call('scanruler_batch', { calls: [{ tool: 'view_render', arguments: { view: 'top' } }] })
  assert.equal(dirname(batch.json.results[0].result.file.path), dir)
  // That session saved into the previous part's folder, and the scan that
  // was to replace it refused: the latest of the folders is the saved one's,
  // and still not where a spill goes.
  const failed = await call('scan_open', { path: join(part, 'broken.stl'), saveTo: join(before, 'before.scanruler') })
  assert.equal(failed.error, true, failed.text)
  assert.equal((await call('scanruler_status')).json.folders[0], before)
  const big = await call('demo_points', { n: 5000 })
  assert.equal(dirname(big.json.file), dir)
  assert.match(big.json.note, /the scan open now was not opened from a folder through this server\.$/)
  // The part's scan opened from its folder: there, in scanruler-work.
  const opened = await call('scan_open', { path: join(part, 'Mesh.stl') })
  assert.equal(opened.error, false, opened.text)
  assert.equal(await spillFolder(), join(part, 'scanruler-work'))
})
