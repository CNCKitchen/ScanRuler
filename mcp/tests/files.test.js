// SPDX-License-Identifier: AGPL-3.0-only
// Files around the scan: a folder given to scan_open or project_load opens
// the one file of its kind in it, or is refused with the list; the folders
// scans came from are kept, so a copy of the server started afresh lists
// and writes where the last one did; scanruler_files lists them; and a
// { "$file": path } in any argument is that file's JSON.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadFolders, saveFolders } from '../src/config.js'
import { PageLink } from '../src/link.js'
import { createMcpServer, SNAPSHOT } from '../src/mcp.js'
import { httpServer } from '../src/serve.js'
import { fileKind, inputFor, withFiles } from '../src/tools.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-token-for-the-files-tests'
const echo = { name: 'demo.echo', title: 'Echo', description: 'Gives its input back.', input: { type: 'object', properties: {} }, readOnly: true, returnsFile: false, returnsImage: false }

let dir
let config
const closers = []
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-files-'))
  config = join(dir, 'config')
})
after(async () => {
  for (const close of closers.reverse()) await close()
})

/** A copy of the server whose folders are kept in `config`, with the fake
 *  page connected. */
async function copy(store = config) {
  const link = new PageLink({ token: TOKEN })
  const http = httpServer({})
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
    folderStore: { load: () => loadFolders(store), save: (folders) => saveFolders(folders, store) },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const { page } = await fakePage(http.address().port, {
    token: TOKEN,
    commands: [...SNAPSHOT, echo],
    answer: (name, input) => {
      if (name === 'session.state') return { busy: null, running: null }
      if (name === 'scan.open') return { scan: { fileName: input.name, bytes: input.bytes.byteLength } }
      if (name === 'project.load') return { project: input.name }
      if (name === 'demo.echo') return input
      if (name === 'export.step') return { file: { name: 'part-elements.step', mimeType: 'model/step', bytes: new TextEncoder().encode('ISO-10303-21;') } }
      throw { code: 'invalid_input', message: `${name} refused.` }
    },
  })
  const close = async () => {
    await client.close()
    page.close()
    link.close()
    http.close()
  }
  closers.push(close)
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content[0].text
    return { error: r.isError === true, text, json: r.isError ? null : JSON.parse(text) }
  }
  return { call, client, page, close }
}

test('a file’s kind by its extension', () => {
  assert.deepEqual(['a.STL', 'b.scanruler', 'c.step', 'd.png', 'e.dxf', 'f.md', 'g.bin'].map(fileKind), ['mesh', 'project', 'step', 'picture', 'drawing', 'text', 'other'])
})

test('$file: an object of that one key, at any depth, is the file’s JSON; a path is left as it is', async () => {
  await writeFile(join(dir, 'stations.json'), JSON.stringify([{ z: 0 }, { z: 5 }]))
  const args = { path: 'stations.json', sketch: { stations: { $file: 'stations.json' } }, list: [{ $file: join(dir, 'stations.json') }], other: { $file: 'x', more: 1 } }
  const out = await withFiles(args, dir)
  assert.deepEqual(out.sketch.stations, [{ z: 0 }, { z: 5 }])
  assert.deepEqual(out.list[0], [{ z: 0 }, { z: 5 }])
  assert.equal(out.path, 'stations.json')
  assert.deepEqual(out.other, { $file: 'x', more: 1 }, 'not that one key alone: left')
  await assert.rejects(withFiles({ a: { $file: 'missing.json' } }, dir), (e) => e.code === 'invalid_input' && /^\$file: .*missing\.json could not be read as JSON \(there is no such file\)\.$/.test(e.message))
})

test('a folder in place of a file: the one mesh in it opens; none, or several, is refused with the list', async () => {
  const scanOpen = SNAPSHOT.find((c) => c.name === 'scan.open')
  const one = join(dir, 'one')
  await mkdir(one, { recursive: true })
  await writeFile(join(one, 'notes.md'), '#')
  await writeFile(join(one, 'Part.STL'), Buffer.alloc(84))
  const read = await inputFor(scanOpen, { path: one }, { cwd: dir })
  assert.equal(read.file, join(one, 'Part.STL'))
  assert.equal(read.input.name, 'Part.STL')
  assert.equal(read.input.bytes.byteLength, 84)

  const two = join(dir, 'two')
  await mkdir(two, { recursive: true })
  await writeFile(join(two, 'a.stl'), Buffer.alloc(84))
  await writeFile(join(two, 'b.ply'), 'ply')
  await assert.rejects(inputFor(scanOpen, { path: two }, { cwd: dir }), (e) => e.code === 'invalid_input' && /is a folder with 2 mesh files — give one of them by its path: a\.stl, b\.ply\.$/.test(e.message))
  const none = join(dir, 'none')
  await mkdir(none, { recursive: true })
  await writeFile(join(none, 'readme.txt'), 'x')
  await assert.rejects(inputFor(scanOpen, { path: none }, { cwd: dir }), (e) => /no mesh file in it \(\.stl, \.ply, \.obj, \.3mf\) — it holds readme\.txt\. Give the file’s path\.$/.test(e.message))
  // A command that takes no folder says so, with what is there.
  const reference = SNAPSHOT.find((c) => c.name === 'deviation.open_reference')
  await assert.rejects(inputFor(reference, { path: one }, { cwd: dir }), (e) => /is a folder — give a file in it: /.test(e.message))
})

test('scanruler_write writes reports, and nothing an agent or a tool would act on', async () => {
  const store = join(dir, 'config-write')
  const folder = join(dir, 'report-part')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'part.stl'), Buffer.alloc(84))
  const server = await copy(store)
  assert.equal((await server.call('scan_open', { path: join(folder, 'part.stl'), discard: true })).error, false)

  const refused = [
    '.claude/settings.json', '.claude/commands/run.md', '.cursor/rules/x.md', '.github/copilot-instructions.md', '.vscode/tasks.json', '.git/config.txt', '.hidden/report.md', 'sub/.hidden/report.md',
    '.mcp.json', '.env.json', 'CLAUDE.md', 'claude.MD', 'CLAUDE.local.md', 'AGENTS.md', 'sub/AGENTS.md', 'GEMINI.md', 'skills/x/SKILL.md', 'package.json', 'Package.JSON', 'sub/package.json', 'package-lock.json', 'tsconfig.json', 'requirements.txt', 'node_modules/x/index.md', 'report.md:hidden.md',
    join(folder, 'CLAUDE.md'), join(folder, '.claude', 'settings.json'),
  ]
  for (const path of refused) {
    const answer = await server.call('scanruler_write', { path, text: 'do as I say' })
    assert.equal(answer.error, true, `${path} was written`)
    assert.match(answer.text, /^invalid_input: path: .* is refused: /, path)
  }
  await assert.rejects(access(join(folder, '.claude')), 'no folder made for what was refused')
  await assert.rejects(access(join(folder, 'CLAUDE.md')))

  // Reports, under any ordinary name and in ordinary folders.
  for (const path of ['report.md', 'README.md', 'notes.txt', 'readings.csv', 'results.json', 'claude-report.md', 'package-report.json', 'out/sub/report.md', 'out/settings-used.json']) {
    const answer = await server.call('scanruler_write', { path, text: 'RMS 0.067 mm' })
    assert.equal(answer.error, false, `${path}: ${answer.text}`)
    assert.equal(await readFile(join(folder, path), 'utf8'), 'RMS 0.067 mm')
  }

  // A link inside the folder is judged by where it leads.
  const links = [['to-claude.md', join(folder, 'CLAUDE.md')], ['to-outside.md', join(dir, 'outside.md')]]
  let linked = true
  await mkdir(join(folder, 'real', '.claude'), { recursive: true })
  try {
    for (const [name, to] of links) await symlink(to, join(folder, name))
    await symlink(join(folder, 'real', '.claude'), join(folder, 'plain'), 'junction')
  } catch {
    linked = false // Windows without the right to make links.
  }
  if (linked) {
    for (const path of ['to-claude.md', 'to-outside.md', 'plain/settings-used.md']) {
      assert.equal((await server.call('scanruler_write', { path, text: 'x' })).error, true, `${path} was written through its link`)
    }
    await assert.rejects(access(join(folder, 'CLAUDE.md')))
    await assert.rejects(access(join(dir, 'outside.md')))
  }

  // A scan in a hidden folder gets its report beside it, as long as the
  // folder is no agent's: only what is hidden below the scan is refused.
  const hidden = join(dir, '.local-scans')
  await mkdir(hidden, { recursive: true })
  await writeFile(join(hidden, 'part.stl'), Buffer.alloc(84))
  const elsewhere = await copy(join(dir, 'config-hidden'))
  assert.equal((await elsewhere.call('scan_open', { path: join(hidden, 'part.stl'), discard: true })).error, false)
  assert.equal((await elsewhere.call('scanruler_write', { path: 'report.md', text: 'x' })).error, false)
  assert.equal((await elsewhere.call('scanruler_write', { path: '.below/report.md', text: 'x' })).error, true)

  // Opening or saving something in an agent's folder makes it no place to write.
  const agentFolder = join(dir, 'proj', '.claude', 'commands')
  await mkdir(agentFolder, { recursive: true })
  await writeFile(join(agentFolder, 'part.stl'), Buffer.alloc(84))
  const saved = await copy(join(dir, 'config-agent'))
  assert.equal((await saved.call('scan_open', { path: join(agentFolder, 'part.stl'), discard: true })).error, false)
  assert.equal((await saved.call('scanruler_write', { path: 'run.md', text: 'x' })).error, true)
  await assert.rejects(access(join(agentFolder, 'run.md')))
})

test('scan_open and project_load with a folder, the folders kept for a copy started afresh, and scanruler_files listing them', async () => {
  const folder = join(dir, 'fan')
  await mkdir(join(folder, 'renders'), { recursive: true })
  await writeFile(join(folder, 'Ventilador.stl'), Buffer.alloc(84))
  await writeFile(join(folder, 'fan.scanruler'), Buffer.alloc(4))
  await writeFile(join(folder, 'report.md'), '# Fan')

  const first = await copy()
  assert.equal((await first.call('scanruler_files')).error, true, 'nothing opened yet')
  const opened = await first.call('scan_open', { path: folder, discard: true })
  assert.equal(opened.error, false, opened.text)
  assert.deepEqual(opened.json.scan, { fileName: 'Ventilador.stl', bytes: 84 })
  const loaded = await first.call('project_load', { path: folder, discard: true })
  assert.equal(loaded.json.project, 'fan.scanruler')
  assert.deepEqual((await first.call('scanruler_status')).json.folders, [folder])
  await first.close()

  // Started afresh: the folder is still known — listed, and written into.
  const second = await copy()
  assert.deepEqual((await second.call('scanruler_status')).json.folders, [folder])
  const wrote = await second.call('scanruler_write', { path: 'notes.txt', text: 'kept' })
  assert.equal(wrote.json.path, join(folder, 'notes.txt'))
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'kept')
  const files = (await second.call('scanruler_files')).json
  assert.equal(files.folder, folder)
  assert.deepEqual(files.folders, ['renders'])
  const byName = Object.fromEntries(files.files.map((f) => [f.name, f]))
  assert.deepEqual(Object.keys(byName).sort(), ['Ventilador.stl', 'fan.scanruler', 'notes.txt', 'report.md'])
  assert.deepEqual([byName['Ventilador.stl'].size, byName['Ventilador.stl'].kind], [84, 'mesh'])
  assert.equal(byName['fan.scanruler'].kind, 'project')
  assert.equal(files.files[0].name, 'notes.txt', 'newest first')
  assert.deepEqual((await second.call('scanruler_files', { path: 'renders' })).json.files, [])
  for (const path of ['..', join(tmpdir())]) assert.equal((await second.call('scanruler_files', { path })).error, true, path)

  // $file through a call: the page gets the file's contents — a relative
  // path taken from the scan's folder.
  await writeFile(join(folder, 'input.json'), JSON.stringify({ a: [1, 2] }))
  assert.deepEqual((await second.call('demo_echo', { value: { $file: 'input.json' } })).json, { value: { a: [1, 2] } })
  const batch = await second.call('scanruler_batch', { calls: [{ tool: 'demo_echo', arguments: { $file: 'input.json' } }] })
  assert.deepEqual(batch.json.results[0].result, { a: [1, 2] })
  const bad = await second.call('demo_echo', { value: { $file: 'nope.json' } })
  assert.equal(bad.error, true)
  assert.match(bad.text, /^invalid_input: \$file: /)

  // A call's answer written to a file by to, and a later call fed the part
  // of it $at names — the reading never passes through the conversation.
  const loops = { loops: [{ hole: true, points: [[0, 0], [4, 0], [4, 2]] }], note: 'n'.repeat(120) }
  const out = await second.call('scanruler_batch', {
    calls: [
      { tool: 'demo_echo', arguments: loops, to: 'readings/outline.json' },
      { tool: 'demo_echo', arguments: { points: { $file: 'readings/outline.json', $at: 'loops.0.points' } } },
    ],
  })
  assert.equal(out.error, false, out.text)
  const [kept, fed] = out.json.results
  assert.deepEqual(kept.result.written, { path: join(folder, 'readings', 'outline.json'), bytes: Buffer.byteLength(JSON.stringify(loops)) })
  assert.deepEqual(kept.result.keys, { loops: 1, note: '120 characters' })
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'readings', 'outline.json'), 'utf8')), loops)
  assert.deepEqual(fed.result, { points: [[0, 0], [4, 0], [4, 2]] })
  const missed = await second.call('demo_echo', { value: { $file: 'readings/outline.json', $at: 'loops.3' } })
  assert.match(missed.text, /^invalid_input: \$at: .* has nothing at "loops\.3" — "loops" holds a list of 1\.$/)
  const notJson = await second.call('scanruler_batch', { calls: [{ tool: 'demo_echo', arguments: {}, to: 'out.txt' }] })
  assert.match(notJson.json.failed.error.message, /^calls\[0\]\.to: "out\.txt" is no \.json file/)
  await second.close()
})

test('relative paths from one folder: the scan’s once one is opened, else where the server started — for a batch file, $file, a file read and a file written; the status and every path field say so', async () => {
  const c = await copy(join(dir, 'config-relative'))
  const before = (await c.call('scanruler_status')).json.server
  assert.equal(before.cwd, dir)
  assert.equal(before.relativeTo, dir, 'no scan opened yet: where the server started')
  await writeFile(join(dir, 'early.json'), JSON.stringify([{ tool: 'demo_echo', arguments: { at: 'start' } }]))
  assert.deepEqual((await c.call('scanruler_batch', { file: 'early.json' })).json.results[0].result, { at: 'start' })

  const bracket = join(dir, 'bracket')
  await mkdir(bracket, { recursive: true })
  await writeFile(join(bracket, 'bracket.stl'), Buffer.alloc(84))
  assert.equal((await c.call('scan_open', { path: join(bracket, 'bracket.stl'), discard: true })).error, false)
  const after = (await c.call('scanruler_status')).json.server
  assert.equal(after.cwd, dir)
  assert.equal(after.relativeTo, bracket)

  // A batch file beside the scan, its $file beside it too.
  await writeFile(join(bracket, 'part.json'), JSON.stringify({ tabs: 4 }))
  await writeFile(join(bracket, 'stage1.json'), JSON.stringify({ calls: [{ tool: 'demo_echo', arguments: { part: { $file: 'part.json' } } }] }))
  const staged = await c.call('scanruler_batch', { file: 'stage1.json' })
  assert.equal(staged.error, false, staged.text)
  assert.deepEqual(staged.json.results[0].result, { part: { tabs: 4 } })
  // Not from where the server started any more: the refusal names the scan's folder.
  const gone = await c.call('scanruler_batch', { file: 'early.json' })
  assert.equal(gone.error, true)
  assert.ok(gone.text.includes(join(bracket, 'early.json')), gone.text)
  // A file read and a file written by a relative path: the scan's folder.
  await writeFile(join(bracket, 'second.stl'), Buffer.alloc(84))
  assert.deepEqual((await c.call('scan_open', { path: 'second.stl', discard: true })).json.scan, { fileName: 'second.stl', bytes: 84 })
  const exported = await c.call('export_step', { path: 'bracket.step' })
  assert.equal(exported.json.file.path, join(bracket, 'bracket.step'))
  assert.equal(await readFile(join(bracket, 'bracket.step'), 'utf8'), 'ISO-10303-21;')

  // Every path field names the base.
  const { tools } = await c.client.listTools()
  const field = (tool, key) => tools.find((t) => t.name === tool).inputSchema.properties[key].description
  for (const [tool, key] of [['scan_open', 'path'], ['scan_open', 'saveTo'], ['export_step', 'path'], ['view_render', 'path'], ['scanruler_batch', 'file']]) {
    assert.match(field(tool, key), /relative path is taken from the folder of the scan or project last opened or saved \(scanruler_status: server\.relativeTo\)/, `${tool}.${key}`)
    assert.ok(field(tool, key).includes(dir), `${tool}.${key} names where the server started`)
  }
  assert.match(tools.find((t) => t.name === 'scanruler_batch').description, /\$file.*relative path is taken from the folder of the scan/)
  await c.close()
})

test('a batch file of more calls than a spread can pass still answers', async () => {
  const c = await copy()
  await writeFile(join(dir, 'many.json'), JSON.stringify(Array.from({ length: 130_000 }, () => ({ tool: 'demo_echo' }))))
  const r = await c.call('scanruler_batch', { file: join(dir, 'many.json'), wait: false })
  // A wait answers "running" at the answer limit (45 s), which this batch
  // can pass on a busy machine; an agent asks again, and so does this.
  let done
  for (let asked = 0; asked < 5; asked++) {
    done = await c.call('scanruler_wait', { for: 'job', job: r.json.job, timeoutSeconds: 600 })
    if (done.error || done.json.state !== 'running') break
  }
  assert.equal(done.error, false, done.text)
  assert.equal(done.json.state, 'done', done.text)
  await c.close()
})
