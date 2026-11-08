// SPDX-License-Identifier: AGPL-3.0-only
// The pairing token: copies started together on a first run agree on one,
// and a config.json that does not parse is kept aside, not overwritten.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

const CONFIG = new URL('../src/config.js', import.meta.url).href

const tokenFrom = (dir) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { loadConfig } = await import(${JSON.stringify(CONFIG)}); process.stdout.write(loadConfig(${JSON.stringify(dir)}).token)`])
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))))
  })

test('copies started together on a first run share one token', async () => {
  for (let round = 0; round < 5; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'scanruler-config-'))
    const tokens = await Promise.all(Array.from({ length: 8 }, () => tokenFrom(dir)))
    const kept = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).token
    assert.deepEqual(new Set(tokens), new Set([kept]), `round ${round}`)
  }
})

test('a config.json that does not parse is kept aside as config.json.bad', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-config-'))
  await writeFile(join(dir, 'config.json'), '{"token": "half-writ')
  const config = loadConfig(dir)
  assert.ok(config.token.length >= 16)
  assert.deepEqual((await readdir(dir)).sort(), ['config.json', 'config.json.bad'])
  assert.equal(await readFile(join(dir, 'config.json.bad'), 'utf8'), '{"token": "half-writ')
})
