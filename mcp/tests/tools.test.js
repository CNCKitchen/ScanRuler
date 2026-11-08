// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SNAPSHOT } from '../src/mcp.js'
import { agentJson, batchedPicture, bytesProperty, imageContent, inputFor, saveFileResult, toolFor, toolName, timingsIn, waitIn, writeNew } from '../src/tools.js'

const command = (name) => SNAPSHOT.find((c) => c.name === name)

test('every command is a tool, dots to underscores, its schema an object', () => {
  const names = SNAPSHOT.map(toolName)
  assert.ok(names.includes('element_fit'))
  assert.ok(names.includes('report_get'))
  assert.equal(new Set(names).size, names.length)
  for (const c of SNAPSHOT) {
    const tool = toolFor(c, { outDir: '/out' })
    assert.equal(tool.inputSchema.type, 'object', c.name)
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, c.name)
    assert.ok(tool.description.length > 40, c.name)
  }
})

test('an answer keeps six significant digits or four decimals, no finer than a millionth, and whole numbers whole', () => {
  assert.equal(
    agentJson({ a: 0.9483828176573491, b: 12.000000000000002, c: 1e-17, d: -3.4e-8, e: 1234567.891, f: 0.0423171, g: [1, 2, 3], h: 123.456789, id: 9007199254740991, s: '0.123456789', n: null }),
    '{"a":0.948383,"b":12,"c":0,"d":0,"e":1234567.891,"f":0.042317,"g":[1,2,3],"h":123.4568,"id":9007199254740991,"s":"0.123456789","n":null}',
  )
})

test('an exact answer keeps every digit', () => {
  assert.equal(agentJson({ a: 0.9483828176573491, h: 123.456789 }, true), '{"a":0.9483828176573491,"h":123.456789}')
})

test('a schema passes through as it is, but for files, and a change takes wait and timings', () => {
  const fit = command('element.fit')
  const { wait, timings, ...rest } = toolFor(fit, { outDir: '/out' }).inputSchema.properties
  assert.deepEqual({ ...toolFor(fit, { outDir: '/out' }).inputSchema, properties: rest }, fit.input)
  assert.equal(wait, waitIn)
  assert.equal(timings, timingsIn)
  assert.equal(toolFor(command('session.state'), { outDir: '/out' }).inputSchema.properties.wait, undefined)
  assert.equal(toolFor(command('session.state'), { outDir: '/out' }).inputSchema.properties.timings, undefined)
  assert.equal(toolFor(command('session.state'), { outDir: '/out' }).annotations.readOnlyHint, true)
  assert.equal(toolFor(fit, { outDir: '/out' }).annotations.readOnlyHint, false)
})

test('a command that takes a file takes a path instead, its name defaulting to the file’s', () => {
  const open = command('scan.open')
  assert.equal(bytesProperty(open), 'bytes')
  const tool = toolFor(open, { outDir: '/out' })
  assert.equal(tool.inputSchema.properties.bytes, undefined)
  assert.equal(tool.inputSchema.properties.path.type, 'string')
  assert.deepEqual(tool.inputSchema.required, ['path'])
  assert.ok(tool.inputSchema.properties.units)
})

test('a command that hands a file back takes where to write it', () => {
  const tool = toolFor(command('export.step'), { outDir: '/out' })
  assert.match(tool.inputSchema.properties.path.description, /\/out/)
  assert.equal(tool.inputSchema.required, undefined)
  assert.equal(tool.annotations.readOnlyHint, false, 'it writes a file')
})

test('the path is read into the bytes, and a returned file written where asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  await writeFile(join(dir, 'part.stl'), Buffer.from([1, 2, 3]))
  const open = command('scan.open')
  const { input, binaryKey } = await inputFor(open, { path: 'part.stl', units: 'mm' }, { cwd: dir })
  assert.equal(binaryKey, 'bytes')
  assert.deepEqual([...input.bytes], [1, 2, 3])
  assert.equal(input.name, 'part.stl')
  assert.equal(input.path, undefined)
  await assert.rejects(inputFor(open, { path: 'missing.stl' }, { cwd: dir }), (e) => e.code === 'invalid_input' && /no such file/.test(e.message))

  const result = { file: { name: 'part-elements.step', mimeType: 'model/step', bytes: new Uint8Array([65, 66]) }, status: 'done' }
  const inDir = await saveFileResult(result, {}, { cwd: dir, outDir: dir })
  assert.deepEqual(inDir.file, { name: 'part-elements.step', mimeType: 'model/step', size: 2, path: join(dir, 'part-elements.step') })
  assert.equal(await readFile(join(dir, 'part-elements.step'), 'utf8'), 'AB')
  const named = await saveFileResult(result, { path: 'out/x.step' }, { cwd: dir, outDir: dir })
  assert.equal(named.file.path, join(dir, 'out', 'x.step'))
  // A folder takes the file under its own name — numbered past the one
  // written there before, never over it; a file path given is replaced.
  const intoFolder = await saveFileResult(result, { path: dir }, { cwd: dir, outDir: '/elsewhere' })
  assert.equal(intoFolder.file.path, join(dir, 'part-elements-2.step'))
  assert.equal((await saveFileResult(result, {}, { cwd: dir, outDir: dir })).file.path, join(dir, 'part-elements-3.step'))
  assert.equal((await saveFileResult(result, { path: 'renders/' }, { cwd: dir, outDir: dir })).file.path, join(dir, 'renders', 'part-elements.step'), 'a path ending in a separator is a folder')
  const other = { file: { ...result.file, bytes: new Uint8Array([67]) } }
  assert.equal((await saveFileResult(other, { path: 'out/x.step' }, { cwd: dir, outDir: dir })).file.path, join(dir, 'out', 'x.step'))
  assert.equal(await readFile(join(dir, 'out', 'x.step'), 'utf8'), 'C')
})

test('pictures written at once each get a file of their own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  const picture = (n) => ({ file: { name: 'part-view.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, n]) } })
  // Ten side by side into the output folder, and ten into a folder path.
  const loose = await Promise.all(Array.from({ length: 10 }, (_, n) => batchedPicture(picture(n), {}, { cwd: dir, outDir: dir })))
  const into = await Promise.all(Array.from({ length: 10 }, (_, n) => saveFileResult(picture(n), { path: dir }, { cwd: dir, outDir: '/elsewhere' })))
  const paths = [...loose, ...into].map((r) => r.file.path)
  assert.equal(new Set(paths).size, 20, paths.join('\n'))
  // Each file holds its own picture.
  for (const [n, r] of loose.entries()) assert.deepEqual([...(await readFile(r.file.path))], [0x89, n])
  for (const [n, r] of into.entries()) assert.deepEqual([...(await readFile(r.file.path))], [0x89, n])
  // writeNew numbers past what is there, whatever wrote it.
  await writeFile(join(dir, 'a.json'), '{}')
  assert.equal(await writeNew(dir, 'a.json', '1'), join(dir, 'a-2.json'))
  assert.equal(await readFile(join(dir, 'a.json'), 'utf8'), '{}', 'the first left as it was')
})

test('a picture comes back as an image, and is written to a file only when asked', async () => {
  const render = command('view.render')
  assert.equal(render.returnsImage, true)
  const tool = toolFor(render, { outDir: '/out' })
  assert.match(tool.description, /comes back as an image/)
  assert.match(tool.inputSchema.properties.path.description, /only shown/)
  assert.equal(tool.annotations.readOnlyHint, true, 'it writes nothing unless asked')
  const { input } = await inputFor(render, { width: 200, path: 'x.png' }, { cwd: '/' })
  assert.deepEqual(input, { width: 200 })

  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const result = { file: { name: 'part-view.png', mimeType: 'image/png', bytes: png }, width: 200, height: 100 }
  const shown = await imageContent(result, {}, { cwd: dir, outDir: dir })
  assert.equal(shown[1].type, 'image')
  assert.equal(shown[1].mimeType, 'image/png')
  assert.deepEqual([...Buffer.from(shown[1].data, 'base64')], [...png])
  assert.deepEqual(JSON.parse(shown[0].text), { file: { name: 'part-view.png', mimeType: 'image/png', size: 4 }, width: 200, height: 100 })
  const saved = await imageContent(result, { path: 'pics' }, { cwd: dir, outDir: '/elsewhere' })
  assert.equal(JSON.parse(saved[0].text).file.path, join(dir, 'pics'))
  assert.deepEqual([...(await readFile(join(dir, 'pics')))], [...png])
  // Written and not shown: the text alone, saying where.
  const quiet = await imageContent(result, { path: 'quiet.png', inline: false }, { cwd: dir, outDir: dir })
  assert.equal(quiet.length, 1)
  assert.equal(JSON.parse(quiet[0].text).file.path, join(dir, 'quiet.png'))
  assert.deepEqual([...(await readFile(join(dir, 'quiet.png')))], [...png])
  // inline: false without a path still shows it — there is nowhere else.
  assert.equal((await imageContent(result, { inline: false }, { cwd: dir, outDir: dir }))[1].type, 'image')
  assert.equal(await imageContent({ file: { name: 'a.step', mimeType: 'model/step', bytes: png } }, {}, { cwd: dir, outDir: dir }), null)
})

test('a picture in a batch, where it cannot be shown, is written to a file all the same', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-'))
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const result = { file: { name: 'part-view.png', mimeType: 'image/png', bytes: png }, width: 200, height: 100 }
  const first = await batchedPicture(result, {}, { cwd: '/elsewhere', outDir: dir })
  assert.deepEqual(first, { file: { name: 'part-view.png', mimeType: 'image/png', size: 4, path: join(dir, 'part-view.png') }, width: 200, height: 100 })
  assert.deepEqual([...(await readFile(first.file.path))], [...png])
  // Numbered past one already there: no render is written over.
  assert.equal((await batchedPicture(result, {}, { cwd: dir, outDir: dir })).file.path, join(dir, 'part-view-2.png'))
  assert.equal((await batchedPicture(result, {}, { cwd: dir, outDir: dir })).file.path, join(dir, 'part-view-3.png'))
  // A path given is where it goes, as a direct call's.
  assert.equal((await batchedPicture(result, { path: 'mine.png' }, { cwd: dir, outDir: '/elsewhere' })).file.path, join(dir, 'mine.png'))
  // No picture, nothing written.
  assert.deepEqual(await batchedPicture({ width: 1 }, {}, { cwd: dir, outDir: dir }), { width: 1 })
})
