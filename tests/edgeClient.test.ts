// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EdgeClient } from '../src/core/flat/edgeClient'

/** A stand-in for the edge worker that answers only when told to. */
class FakeWorker {
  static last: FakeWorker
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: unknown = null
  onmessageerror: unknown = null
  sent: { requestId: number }[] = []
  constructor() { FakeWorker.last = this }
  postMessage(message: { requestId: number }) { this.sent.push(message) }
  terminate() {}
  answer(data: unknown) { this.onmessage!({ data }) }
}

beforeEach(() => vi.stubGlobal('Worker', FakeWorker))
afterEach(() => vi.unstubAllGlobals())

const options = {} as Parameters<EdgeClient['detect']>[3]

it('resolves a superseded request that fails to null rather than an error', async () => {
  const client = new EdgeClient()
  const first = client.detect(new Uint8Array(4), 2, 2, options)
  const second = client.detect(new Uint8Array(4), 2, 2, options)
  const worker = FakeWorker.last
  worker.answer({ type: 'error', requestId: worker.sent[0].requestId, message: 'out of memory' })
  await expect(first).resolves.toBeNull()
  worker.answer({ type: 'edges', requestId: worker.sent[1].requestId, points: new Float32Array(0), offsets: new Uint32Array(1) })
  await expect(second).resolves.not.toBeNull()
})

it('still rejects when the latest request fails', async () => {
  const client = new EdgeClient()
  const only = client.detect(new Uint8Array(4), 2, 2, options)
  const worker = FakeWorker.last
  worker.answer({ type: 'error', requestId: worker.sent[0].requestId, message: 'out of memory' })
  await expect(only).rejects.toThrow('out of memory')
})
