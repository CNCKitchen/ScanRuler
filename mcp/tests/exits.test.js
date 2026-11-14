// SPDX-License-Identifier: AGPL-3.0-only
// A server that stops says why on stderr first, and what need not stop it —
// a rejection nobody handled, a long message from the agent, an error on a
// port it holds — does not.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { guardExits } from '../src/exits.js'
import { SharedLink } from '../src/relay.js'
import { httpServer } from '../src/serve.js'
import { startAgent } from './client.js'

const TOKEN = 'a-test-token-long-enough'
const BIN = fileURLToPath(new URL('../bin/scanruler-mcp.js', import.meta.url))

/** A process as guardExits watches it, and what it said and how it exited. */
function fakeProcess() {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  const lines = []
  const exits = []
  const stop = guardExits({ log: (line) => lines.push(line), proc, exit: (code) => exits.push(code) })
  return { proc, lines, exits, stop }
}

test('a rejection nobody handled is said, and the process runs on', () => {
  const { proc, lines, exits } = fakeProcess()
  proc.emit('unhandledRejection', new Error('a loose end'))
  assert.deepEqual(exits, [])
  assert.match(lines.join('\n'), /A rejection nobody handled, running on: Error: a loose end/)
})

test('an uncaught exception is said, with its stack, before the process ends with code 1', () => {
  const { proc, lines, exits } = fakeProcess()
  proc.emit('uncaughtException', new TypeError('broke'), 'uncaughtException')
  assert.deepEqual(exits, [1])
  assert.match(lines[0], /^Stopping \(exit code 1\): an uncaught exception: TypeError: broke\n\s+at /)
})

test('stdout closing is the agent gone; stderr closing is heard and silences the log', () => {
  const out = fakeProcess()
  out.proc.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  assert.deepEqual(out.exits, [0])
  assert.match(out.lines[0], /stdout, the MCP channel, failed — the agent has gone \(EPIPE\)/)

  const err = fakeProcess()
  assert.doesNotThrow(() => err.proc.stderr.emit('error', new Error('write EPIPE')))
  err.proc.emit('unhandledRejection', new Error('unheard'))
  assert.deepEqual(err.lines, [])
  assert.deepEqual(err.exits, [])
})

test('a signal, a deliberate stop and any other exit are each said once', () => {
  const signalled = fakeProcess()
  signalled.proc.emit('SIGTERM')
  assert.deepEqual(signalled.exits, [143])
  assert.deepEqual(signalled.lines, ['Stopping (exit code 143): SIGTERM received.'])
  signalled.proc.emit('exit', 143)
  assert.equal(signalled.lines.length, 1, 'the exit after a stop is not said again')

  const stopped = fakeProcess()
  stopped.stop('the agent closed the MCP channel.', 0)
  assert.deepEqual(stopped.lines, ['Stopping (exit code 0): the agent closed the MCP channel.'])

  const other = fakeProcess()
  other.proc.emit('exit', 3)
  assert.deepEqual(other.lines, ['Exiting with code 3.'])
})

test('an error on the port once it is held keeps it held, and is not taken for a failed listen', { timeout: 10_000 }, async () => {
  const http = httpServer({})
  const lines = []
  const link = new SharedLink({ http, port: 0, token: TOKEN, log: (line) => lines.push(line), retryMs: 20 })
  try {
    link.start()
    await new Promise((resolve) => link.once('role', resolve))
    assert.equal(link.role, 'holder')
    // What a server emits when it cannot take a connection in. Before, the
    // retry listened again on the listening server, which throws in a timer.
    http.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(link.role, 'holder')
    assert.equal(link.error, null)
    assert.match(lines.join('\n'), /accept EMFILE/)
    assert.doesNotThrow(() => link.start(), 'starting a link that holds its port is nothing')
  } finally {
    link.close()
  }
})

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const env = async () => ({ SCANRULER_MCP_TOKEN: TOKEN, SCANRULER_MCP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'scanruler-mcp-')), SCANRULER_MCP_NO_UPDATE: '1' })

test('the server, its stdin closed by the agent, says so before it stops', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [BIN, '--port', String(await freePort())], { env: { ...process.env, ...(await env()) }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no Ready: ${stderr}`)), 20_000)
    child.stderr.on('data', () => {
      if (/Ready\./.test(stderr)) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  child.stdin.end()
  const code = await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(code, 0)
  assert.match(stderr, /stdin ended: the agent has gone\./)
  assert.match(stderr, /Stopping \(exit code 0\): the agent closed the MCP channel\./)
})

test('a message from the agent past the SDK’s 10 MB is answered, not the end of the session', { timeout: 60_000 }, async () => {
  const agent = await startAgent({ args: ['--port', String(await freePort())], env: await env(), stderr: 'pipe' })
  let closed = false
  agent.client.onclose = () => {
    closed = true
  }
  try {
    // An argument the tool does not take: refused, but answered.
    const long = await agent.client.callTool({ name: 'scanruler_status', arguments: { note: 'x'.repeat(12 * 1024 ** 2) } })
    assert.ok(Array.isArray(long.content))
    const after = await agent.call('scanruler_status')
    assert.equal(after.error, false)
    assert.equal(closed, false)
  } finally {
    await agent.close()
  }
})
