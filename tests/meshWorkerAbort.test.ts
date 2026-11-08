// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { boxMesh } from './helpers'
import { stlBytes } from './commandKit'

let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
let replies: WorkerResponse[]
let release: () => void

beforeEach(async () => {
  replies = []
  scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('../src/core/meshWorker')
  // A plugin request that awaits, as a library loading does: it holds the
  // queue, so the fit sent after it waits there.
  const { workerPlugins } = await import('../src/core/workerPlugins')
  ;(workerPlugins as unknown as unknown[]).push({
    id: 'test-hold',
    handle: () => new Promise((resolve) => { release = () => resolve({ result: 'held' }) }),
  })
})
afterEach(() => vi.unstubAllGlobals())

const send = (msg: WorkerRequest) => scope.onmessage!({ data: msg })
const answers = (id: number) => replies.filter((m) => 'requestId' in m && m.requestId === id && m.type !== 'align-progress')
const buffer = () => {
  const bytes = stlBytes(boxMesh(20, 8))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

it('stops a fit that is still waiting in the queue when Stop is pressed', async () => {
  send({ type: 'load', requestId: 1, name: 'scan.stl', buffer: buffer(), crease: { mode: 'off', angleDeg: 30 } })
  send({ type: 'load-nominal', requestId: 2, name: 'ref.stl', buffer: buffer() })
  expect(answers(1)[0]?.type).toBe('loaded')
  expect(answers(2)[0]?.type).toBe('nominal-loaded')
  send({ type: 'plugin', requestId: 3, plugin: 'test-hold', op: 'x', payload: null } as WorkerRequest)
  send({ type: 'align', requestId: 4, mode: 'auto' })
  send({ type: 'align-abort' })
  release()
  for (let i = 0; i < 600 && answers(4).length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  expect(answers(4).map((m) => m.type)).toEqual(['align-stopped'])
})
