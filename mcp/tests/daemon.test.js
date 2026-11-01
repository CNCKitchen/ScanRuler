// SPDX-License-Identifier: AGPL-3.0-only
// The background server (src/daemon.js): the record of it, finding it again, starting it detached, ending it, and the real process run with --daemon.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { announce, clearState, pairingLink, probe, readState, start, STATE_FILE, status, stop, writeState } from '../src/daemon.js'

const BIN = fileURLToPath(new URL('../bin/scanruler-mcp.js', import.meta.url))
const tempDir = () => mkdtemp(join(tmpdir(), 'scanruler-daemon-'))
const noSleep = async () => {}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('the record round-trips, and anything that is not a record reads as none', async () => {
  const dir = await tempDir()
  assert.equal(readState(dir), null)
  writeState({ pid: 12, port: 7317, version: '1.2.3' }, dir)
  assert.deepEqual(readState(dir), { pid: 12, port: 7317, version: '1.2.3' })
  writeFileSync(join(dir, STATE_FILE), '{"pid":"x"}')
  assert.equal(readState(dir), null)
  writeFileSync(join(dir, STATE_FILE), 'not json')
  assert.equal(readState(dir), null)
  clearState(dir)
  assert.equal(readState(dir), null)
})

test('a recorded server that no longer answers is not running, and its record is cleared', async () => {
  const dir = await tempDir()
  writeState({ pid: 12, port: 7317, version: '1.2.3' }, dir)
  assert.deepEqual(await status({ port: 7317, dir, probeImpl: async () => false }), { running: false, port: 7317 })
  assert.equal(readState(dir), null)
  writeState({ pid: 12, port: 7317, version: '1.2.3' }, dir)
  assert.deepEqual(await status({ port: 7317, dir, probeImpl: async () => true }), { running: true, pid: 12, port: 7317, version: '1.2.3' })
})

test('probe is true only for a scanruler-mcp hello', async () => {
  assert.equal(await probe(1, async () => ({ json: async () => ({ server: 'scanruler-mcp', version: '1' }) })), true)
  assert.equal(await probe(1, async () => ({ json: async () => ({ server: 'other' }) })), false)
  assert.equal(await probe(1, async () => ({ json: async () => null })), false)
  assert.equal(await probe(1, async () => { throw new Error('refused') }), false)
})

test('start spawns a detached copy with --daemon, waits for its port, and does not spawn again while one answers', async () => {
  const dir = await tempDir()
  let answers = false
  const spawned = []
  const spawnImpl = (executable, argv, options) => {
    spawned.push({ executable, argv, options })
    return { unref() { answers = true } }
  }
  const probeImpl = async () => answers
  const first = await start({ executable: '/bin/scanruler', leading: ['server.cjs'], args: ['--serve', '/app'], env: { ELECTRON_RUN_AS_NODE: '1' }, port: 7317, dir, spawnImpl, probeImpl, sleep: noSleep })
  assert.equal(first.started, true)
  assert.equal(spawned.length, 1)
  assert.deepEqual(spawned[0].argv, ['server.cjs', '--daemon', '--port', '7317', '--serve', '/app'])
  assert.deepEqual(spawned[0].options.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(spawned[0].options.detached, true)
  assert.equal(spawned[0].options.stdio, 'ignore')
  writeState({ pid: 5, port: 7317, version: '1' }, dir)
  const second = await start({ executable: '/bin/scanruler', port: 7317, dir, spawnImpl, probeImpl, sleep: noSleep })
  assert.equal(second.started, false)
  assert.equal(spawned.length, 1)
})

test('start says so when the port never answers', async () => {
  const dir = await tempDir()
  await assert.rejects(start({ executable: 'x', port: 7317, dir, spawnImpl: () => ({ unref() {} }), probeImpl: async () => false, sleep: noSleep }), /did not answer on port 7317/)
})

test('stop ends the recorded process and clears the record; with none it says so', async () => {
  const dir = await tempDir()
  assert.equal(await stop({ dir }), false)
  writeState({ pid: 77, port: 7317, version: '1' }, dir)
  let up = true
  const killed = []
  const kill = (pid, signal) => {
    killed.push([pid, signal])
    up = false
  }
  assert.equal(await stop({ dir, kill, probeImpl: async () => up, sleep: noSleep }), true)
  assert.deepEqual(killed, [[77, 'SIGTERM']])
  assert.equal(readState(dir), null)
})

test('stop treats a process already gone as stopped, and refuses when the port still answers', async () => {
  const dir = await tempDir()
  writeState({ pid: 77, port: 7317, version: '1' }, dir)
  const gone = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  }
  assert.equal(await stop({ dir, kill: gone, probeImpl: async () => false, sleep: noSleep }), true)
  writeState({ pid: 77, port: 7317, version: '1' }, dir)
  await assert.rejects(stop({ dir, kill: () => {}, probeImpl: async () => true, sleep: noSleep }), /still answering on port 7317/)
})

test('announce records the process and removes the record when it is told to end', async () => {
  const dir = await tempDir()
  const handlers = {}
  let exited
  announce({ port: 7317, version: '1.2.3', dir, pid: 41, onSignal: (signal, handler) => { handlers[signal] = handler }, exit: (code) => { exited = code } })
  assert.deepEqual(readState(dir), { pid: 41, port: 7317, version: '1.2.3' })
  handlers.SIGTERM()
  assert.equal(readState(dir), null)
  assert.equal(exited, 0)
})

test('the pairing link carries the port and the configured token', async () => {
  const dir = await tempDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ token: 'a-token-of-sixteen-or-more' }))
  assert.equal(pairingLink(7317, dir), 'http://127.0.0.1:7317/#agent=7317:a-token-of-sixteen-or-more')
})

test('the real process run with --daemon serves the app, records itself, and a second one ends rather than take the port', async () => {
  const dir = await tempDir()
  const app = await tempDir()
  writeFileSync(join(app, 'index.html'), '<title>ScanRuler</title>')
  const port = await freePort()
  const env = { ...process.env, SCANRULER_MCP_CONFIG_DIR: dir, SCANRULER_MCP_NO_UPDATE: '1' }
  const run = () => spawn(process.execPath, [BIN, '--daemon', '--port', String(port), '--serve', app], { env, stdio: 'ignore' })
  const first = run()
  try {
    for (let i = 0; i < 100 && !(await probe(port)); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await probe(port), true)
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /ScanRuler/)
    assert.equal(readState(dir)?.pid, first.pid)
    const second = run()
    const code = await new Promise((resolve) => second.once('exit', resolve))
    assert.equal(code, 0)
    assert.equal(readState(dir)?.pid, first.pid)
  } finally {
    const ended = new Promise((resolve) => first.once('exit', resolve))
    first.kill('SIGTERM')
    await ended
  }
  assert.equal(readState(dir), null)
})
