// SPDX-License-Identifier: AGPL-3.0-only
// The picture tools are marked read-only, so a client may run them without
// asking: a path they are given never replaces a file that is there.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { imageContent } from '../src/tools.js'

test('a picture is not written over a file that is there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-pic-'))
  const target = join(dir, 'notes.txt')
  await writeFile(target, 'keep me')
  const result = { file: { name: 'view.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]) } }
  await assert.rejects(imageContent(result, { path: target }, { cwd: dir, outDir: dir }), { code: 'invalid_input' })
  assert.equal(await readFile(target, 'utf8'), 'keep me')
  // A new path is written as before.
  const fresh = await imageContent(result, { path: 'new.png', inline: false }, { cwd: dir, outDir: dir })
  assert.match(fresh[0].text, /new\.png/)
})
