// SPDX-License-Identifier: AGPL-3.0-only
// Every request the mesh worker takes is answered, and the queue it holds
// while one awaits is let go exactly when that one is done: a request whose
// answer is lost leaves the page waiting on it, and every request behind it,
// for good — the worker idle all the while.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { boxMesh } from './helpers'
import { stlBytes } from './commandKit'
import { identityRigid } from '../src/core/deviation/rigid'

let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
let replies: WorkerResponse[]
/** What the GPU's nearest-face search and the helpers' deviation map do. */
let gpu: () => Promise<Int32Array | null>
let helpers: () => Float32Array | Promise<Float32Array>

beforeEach(async () => {
  replies = []
  scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  vi.doMock('../src/core/deviation/gpuNearest', () => ({ GPU_MIN_VERTICES: 0, gpuNearestFaces: () => gpu() }))
  vi.doMock('../src/core/deviation/parallel', () => ({ computeDeviationAuto: () => helpers() }))
  await import('../src/core/meshWorker')
  const { workerPlugins } = await import('../src/core/workerPlugins')
  ;(workerPlugins as unknown as unknown[]).push({
    id: 'test-settle',
    async handle(op: string, _payload: unknown, ctx: { drive<T>(s: Generator<void | Promise<void>, T>): Promise<T | null> }) {
      if (op === 'plain') return { result: 'plain' }
      // A computation waiting on helpers that died: the pass it waits on fails.
      function* steps(): Generator<void | Promise<void>, string> {
        yield
        yield Promise.reject(new Error('A helper died.'))
        return 'done'
      }
      return { result: await ctx.drive(steps()) }
    },
  })
})
afterEach(() => {
  vi.doUnmock('../src/core/deviation/gpuNearest')
  vi.doUnmock('../src/core/deviation/parallel')
  vi.unstubAllGlobals()
})

const send = (msg: WorkerRequest) => scope.onmessage!({ data: msg })
const answers = (id: number) => replies.filter((m) => 'requestId' in m && m.requestId === id)
const settled = async (...ids: number[]) => {
  for (let i = 0; i < 200 && ids.some((id) => answers(id).length === 0); i++) await new Promise((r) => setTimeout(r, 10))
}
const buffer = () => {
  const bytes = stlBytes(boxMesh(20, 8))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
const order = () => replies.filter((m) => m.type !== 'progress' && 'requestId' in m).map((m) => (m as { requestId: number }).requestId)

it('answers a driven job whose pass fails, and lets the queue go', async () => {
  send({ type: 'plugin', requestId: 1, plugin: 'test-settle', op: 'drive', payload: null } as WorkerRequest)
  send({ type: 'plugin', requestId: 2, plugin: 'test-settle', op: 'plain', payload: null } as WorkerRequest)
  await settled(1, 2)
  expect(answers(1)).toEqual([{ type: 'error', requestId: 1, message: 'A helper died.' }])
  expect(answers(2)).toEqual([{ type: 'plugin-ok', requestId: 2, result: 'plain' }])
})

async function loadBoth(): Promise<void> {
  send({ type: 'load', requestId: 1, name: 'scan.stl', buffer: buffer(), crease: { mode: 'off', angleDeg: 30 } })
  send({ type: 'load-nominal', requestId: 2, name: 'ref.stl', buffer: buffer() })
  expect(answers(1)[0]?.type).toBe('loaded')
  expect(answers(2)[0]?.type).toBe('nominal-loaded')
}
const identity = identityRigid()

it('holds the queue while helpers measure a map the GPU could not', async () => {
  await loadBoth()
  gpu = () => Promise.resolve(null)
  let finish!: () => void
  helpers = () => new Promise((resolve) => { finish = () => resolve(new Float32Array(8)) })
  send({ type: 'deviate', requestId: 3, transform: identity, facingDeg: null })
  send({ type: 'plugin', requestId: 4, plugin: 'test-settle', op: 'plain', payload: null } as WorkerRequest)
  await new Promise((r) => setTimeout(r, 50))
  // Still measuring: what came after waits its turn.
  expect(answers(4)).toEqual([])
  finish()
  await settled(3, 4)
  expect(order().slice(2)).toEqual([3, 4])
})

it('answers a map whose GPU search fails', async () => {
  await loadBoth()
  gpu = () => Promise.reject(new Error('The GPU went away.'))
  helpers = () => new Float32Array(8)
  send({ type: 'deviate', requestId: 3, transform: identity, facingDeg: null })
  send({ type: 'plugin', requestId: 4, plugin: 'test-settle', op: 'plain', payload: null } as WorkerRequest)
  await settled(3, 4)
  expect(answers(3).map((m) => m.type)).toEqual(['error'])
  expect(answers(4).map((m) => m.type)).toEqual(['plugin-ok'])
})
