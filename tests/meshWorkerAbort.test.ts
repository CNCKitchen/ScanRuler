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

/** A plugin whose request drives a long computation, as Merge's alignment
 *  does — `stopped` when Stop reached it — or answers at once, with `plain`. */
async function addDriver(): Promise<{ runs: () => number; gate: (p: Promise<void>) => void }> {
  const { workerPlugins } = await import('../src/core/workerPlugins')
  let runs = 0
  let before: Promise<void> | null = null
  ;(workerPlugins as unknown as unknown[]).push({
    id: 'test-drive',
    async handle(op: string, _payload: unknown, ctx: { drive<T>(s: Generator<undefined, T>): Promise<T | null> }) {
      if (op === 'plain') return { result: 'plain' }
      if (before) await before
      function* steps(): Generator<undefined, string> {
        runs++
        for (let i = 0; i < 5; i++) yield
        return 'done'
      }
      const r = await ctx.drive(steps())
      return { result: r ?? { stopped: true } }
    },
  })
  return { runs: () => runs, gate: (p) => { before = p } }
}

const settled = async (...ids: number[]) => {
  for (let i = 0; i < 300 && ids.some((id) => answers(id).length === 0); i++) await new Promise((r) => setTimeout(r, 10))
}

it('stops a plugin job that is still waiting in the queue when Stop is pressed', async () => {
  const driver = await addDriver()
  send({ type: 'plugin', requestId: 1, plugin: 'test-hold', op: 'x', payload: null } as WorkerRequest)
  send({ type: 'plugin', requestId: 2, plugin: 'test-drive', op: 'long', payload: null } as WorkerRequest)
  send({ type: 'plugin', requestId: 3, plugin: 'test-drive', op: 'plain', payload: null } as WorkerRequest)
  send({ type: 'align-abort' })
  // Sent after Stop: runs as ever.
  send({ type: 'plugin', requestId: 4, plugin: 'test-drive', op: 'long', payload: null } as WorkerRequest)
  release()
  await settled(1, 2, 3, 4)
  expect(answers(2)).toEqual([{ type: 'plugin-ok', requestId: 2, result: { stopped: true } }])
  // What does not drive still has its turn, in order.
  expect(answers(3)).toEqual([{ type: 'plugin-ok', requestId: 3, result: 'plain' }])
  expect(answers(4)).toEqual([{ type: 'plugin-ok', requestId: 4, result: 'done' }])
  expect(driver.runs()).toBe(1)
  const order = replies.filter((m) => m.type === 'plugin-ok').map((m) => (m as { requestId: number }).requestId)
  expect(order).toEqual([1, 2, 3, 4])
})

it('stops a plugin job held in its wait before it drives', async () => {
  const driver = await addDriver()
  let open!: () => void
  driver.gate(new Promise<void>((r) => { open = r }))
  send({ type: 'plugin', requestId: 1, plugin: 'test-drive', op: 'long', payload: null } as WorkerRequest)
  send({ type: 'align-abort' })
  open()
  await settled(1)
  expect(answers(1)).toEqual([{ type: 'plugin-ok', requestId: 1, result: { stopped: true } }])
  expect(driver.runs()).toBe(0)
  // The next one is not stopped by the Stop before it.
  driver.gate(Promise.resolve())
  send({ type: 'plugin', requestId: 2, plugin: 'test-drive', op: 'long', payload: null } as WorkerRequest)
  await settled(2)
  expect(answers(2)).toEqual([{ type: 'plugin-ok', requestId: 2, result: 'done' }])
})
