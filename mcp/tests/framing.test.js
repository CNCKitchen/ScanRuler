// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decoder, encode } from '../src/framing.js'

test('a message without bytes is one JSON frame', () => {
  const frames = encode({ id: 1, method: 'run', name: 'session.state', input: {} })
  assert.equal(frames.length, 1)
  assert.deepEqual(JSON.parse(frames[0]), { id: 1, method: 'run', name: 'session.state', input: {} })
})

test('bytes leave the JSON and follow it as a binary frame', () => {
  const bytes = new Uint8Array([1, 2, 3, 250])
  const message = { id: 2, method: 'run', name: 'scan.open', input: { name: 'a.stl', bytes } }
  const [head, body] = encode(message, 'input.bytes')
  assert.deepEqual(JSON.parse(head), { id: 2, method: 'run', name: 'scan.open', input: { name: 'a.stl', bytes: { size: 4 } }, binary: 'input.bytes' })
  assert.equal(body, bytes, 'the bytes are sent as they are, not copied')
  assert.equal(message.input.bytes, bytes, 'the message itself is left alone')
})

test('the decoder puts the bytes back where they were', () => {
  const got = []
  const feed = decoder((m) => got.push(m))
  const result = { file: { name: 'x.step', mimeType: 'model/step', bytes: new Uint8Array([9, 8, 7]) } }
  const [head, body] = encode({ id: 3, result }, 'result.file.bytes')
  feed(head)
  assert.equal(got.length, 0, 'nothing until the bytes are in')
  feed(body)
  assert.deepEqual(got, [{ id: 3, result }])
  feed(JSON.stringify({ event: 'progress', id: 3, text: 'Reading file…' }))
  assert.equal(got.length, 2)
})

test('the decoder refuses frames out of order', () => {
  const feed = decoder(() => {})
  assert.throws(() => feed(new Uint8Array([1])), /no message announced/)
  feed(JSON.stringify({ id: 1, binary: 'input.bytes' }))
  assert.throws(() => feed('{}'), /Expected the bytes/)
  assert.throws(() => decoder(() => {})('[1,2]') ?? null, /JSON object/)
  assert.throws(() => encode({ input: {} }, 'input.bytes'), /No bytes at input\.bytes/)
})
