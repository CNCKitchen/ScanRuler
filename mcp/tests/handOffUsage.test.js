// SPDX-License-Identifier: AGPL-3.0-only
// A copy handed to that stops on its arguments — a bad --port — started
// well: it exits with the usage code, and the launcher passes that on
// without marking the version failed or running itself in its place.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runHandOff } from '../src/update.js'

const BIN = fileURLToPath(new URL('../bin/scanruler-mcp.js', import.meta.url))

test('the server exits with code 2 when it refuses its arguments', () => {
  const ran = spawnSync(process.execPath, [BIN, '--port', 'not-a-port'], { env: { ...process.env, SCANRULER_MCP_NO_UPDATE: '1' }, encoding: 'utf8' })
  assert.equal(ran.status, 2, ran.stderr)
  assert.match(ran.stderr, /--port not-a-port is not a port/)
})

test('a copy that exits with the usage code at once is not marked failed', async () => {
  const marked = []
  const child = new EventEmitter()
  child.kill = () => {}
  const out = runHandOff({ plan: { bin: '/x', version: '0.4.1' }, argv: ['--port', 'x'], version: '0.4.0', env: {}, now: () => 0, spawnFn: () => child, markFailed: (v) => marked.push(v) })
  child.emit('exit', 2, null)
  assert.deepEqual(await out, { code: 2 })
  assert.deepEqual(marked, [])
})
