// SPDX-License-Identifier: AGPL-3.0-only
// A copy that finds the port taken connects to what holds it as a peer. A
// scanruler-mcp answers at once, taking it in or turning it away; what holds
// the port and never answers, or answers something else, is another program
// — it must not leave the copy waiting for ever, nor read as a refusal.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { PageLink } from '../src/link.js'
import { PeerLink } from '../src/relay.js'
import { httpServer } from '../src/serve.js'

/** A WebSocket server on a free port that does `onConnection` with each socket. */
async function server(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => wss.once('listening', resolve))
  wss.on('connection', onConnection)
  return { port: wss.address().port, close: () => new Promise((resolve) => wss.close(resolve)) }
}

test('a holder that never answers is given up on, as another program', async () => {
  const silent = await server(() => {})
  try {
    const started = Date.now()
    const outcome = await new PeerLink({ port: silent.port, token: 't', welcomeMs: 200 }).connect()
    assert.deepEqual(outcome, { error: 'It did not answer.' })
    assert.ok(Date.now() - started < 2000)
  } finally {
    await silent.close()
  }
})

test('a first message that is neither welcome nor refused is not a refusal', async () => {
  const other = await server((ws) => ws.send(JSON.stringify({ hello: 'something else' })))
  try {
    const outcome = await new PeerLink({ port: other.port, token: 't', welcomeMs: 2000 }).connect()
    assert.deepEqual(outcome, { error: 'It did not answer as a scanruler-mcp.' })
  } finally {
    await other.close()
  }
})

test('a scanruler-mcp with another token still turns the copy away by name', async () => {
  const link = new PageLink({ token: 'right', version: '1.0.0' })
  const http = httpServer({})
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  try {
    const outcome = await new PeerLink({ port: http.address().port, token: 'wrong', welcomeMs: 2000 }).connect()
    assert.equal(typeof outcome.refused, 'string')
    assert.equal(outcome.error, undefined)
  } finally {
    link.close()
    http.close()
  }
})
