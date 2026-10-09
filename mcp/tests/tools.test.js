// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SNAPSHOT } from '../src/mcp.js'
import { bytesProperty, imageContent, inputFor, saveFileResult, toolFor, toolName } from '../src/tools.js'

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

test('a schema passes through as it is, but for files', () => {
  const fit = command('element.fit')
  assert.deepEqual(toolFor(fit, { outDir: '/out' }).inputSchema, fit.input)
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
  const intoFolder = await saveFileResult(result, { path: dir }, { cwd: dir, outDir: '/elsewhere' })
  assert.equal(intoFolder.file.path, join(dir, 'part-elements.step'))
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
  assert.equal(await imageContent({ file: { name: 'a.step', mimeType: 'model/step', bytes: png } }, {}, { cwd: dir, outDir: dir }), null)
})
