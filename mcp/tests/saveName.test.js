// SPDX-License-Identifier: AGPL-3.0-only
// A returned file's name comes from the page and may hold characters this
// computer's file system does not take in a name: a colon, on Windows,
// writes the bytes to a hidden stream and leaves an empty file behind.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { saveFileResult } from '../src/tools.js'

test('a name with a colon or other reserved characters is written as a plain file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-name-'))
  const saved = await saveFileResult({ file: { name: 'Bracket v2: final?.stl', bytes: new Uint8Array([1, 2, 3, 4]) } }, {}, { cwd: dir, outDir: dir })
  assert.deepEqual(await readdir(dir), ['Bracket v2_ final_.stl'])
  assert.equal(saved.file.path, join(dir, 'Bracket v2_ final_.stl'))
  assert.equal((await stat(saved.file.path)).size, 4)
})

test('a reserved device name is not written as one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-name-'))
  await saveFileResult({ file: { name: 'CON.stl', bytes: new Uint8Array([1]) } }, {}, { cwd: dir, outDir: dir })
  assert.deepEqual(await readdir(dir), ['_CON.stl'])
})
