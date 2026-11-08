// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerRpc } from '../src/core/workerRpc'
import { MeshWorkerClient } from '../src/core/workerClient'
import { unreadableSource } from '../src/core/sourceFile'
import { EdgeClient } from '../src/core/flat/edgeClient'
import { tick } from './helpers'
import { useTaskActivity } from '../src/state/taskActivity'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: { requestId: number; type?: string }[] = []
  terminated = false
  postMessage(message: { requestId: number; type?: string }): void { this.messages.push(message) }
  terminate(): void { this.terminated = true }
  constructor() { FakeWorker.instances.push(this) }
  answer(type = 'ok'): void { this.onmessage?.({ data: { type, requestId: this.messages.at(-1)!.requestId } }) }
  crash(): void { this.onerror?.({ message: 'test failure', preventDefault() {} }) }
}
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; useTaskActivity.setState({ tasks: {} }) })

describe('worker lifecycle', () => {
  it('reports queued work, numeric progress and independent completion across workers', async () => {
    const worker = new FakeWorker(), other = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Mesh worker', (data) => (data as { type: string }).type === 'progress')
    const second = new WorkerRpc(() => other as unknown as Worker, 'CAD worker')
    const one = rpc.request({ requestId: 1 })
    const two = second.request({ requestId: 1 })
    expect(Object.values(useTaskActivity.getState().tasks)).toHaveLength(2)
    worker.onmessage!({ data: { type: 'progress', text: 'Measuring', fraction: 0.42 } })
    expect(Object.values(useTaskActivity.getState().tasks)).toContainEqual({ text: 'Measuring', percent: 42 })
    worker.onmessage!({ data: { type: 'progress', text: 'Finalizing' } })
    expect(Object.values(useTaskActivity.getState().tasks)).toContainEqual({ text: 'Finalizing', percent: null })
    worker.answer()
    await one
    expect(Object.values(useTaskActivity.getState().tasks)).toEqual([{ text: 'CAD worker', percent: null }])
    other.answer()
    await two
    expect(useTaskActivity.getState().tasks).toEqual({})
    rpc.dispose()
    second.dispose()
  })

  it('keeps timed-out worker work visible until its late reply or termination', async () => {
    const worker = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    await expect(rpc.request({ requestId: 1 }, [], 5)).rejects.toThrow('did not answer')
    expect(Object.values(useTaskActivity.getState().tasks)).toHaveLength(1)
    worker.answer()
    expect(useTaskActivity.getState().tasks).toEqual({})
    rpc.dispose()
  })

  it('does not settle a request on progress when the worker has no custom event handler', async () => {
    const worker = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    let settled = false
    const pending = rpc.request({ requestId: 1 }).then(() => { settled = true })
    worker.onmessage!({ data: { requestId: 1, type: 'progress', text: 'Preparing', percent: 20 } })
    await tick()
    expect(settled).toBe(false)
    expect(Object.values(useTaskActivity.getState().tasks)).toEqual([{ text: 'Preparing', percent: 20 }])
    worker.answer()
    await pending
    expect(useTaskActivity.getState().tasks).toEqual({})
    rpc.dispose()
  })
  it('rejects every pending job on a crash and rejects future jobs until restarted', async () => {
    const worker = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    const first = expect(rpc.request({ requestId: 1 })).rejects.toThrow('test failure')
    const second = expect(rpc.request({ requestId: 2 })).rejects.toThrow('test failure')
    worker.crash()
    await Promise.all([first, second])
    expect(worker.terminated).toBe(true)
    expect(useTaskActivity.getState().tasks).toEqual({})
    await expect(rpc.request({ requestId: 3 })).rejects.toThrow('unavailable')
  })
  it('settles unreadable replies and cleans up synchronous clone failures', async () => {
    const worker = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    const unreadable = expect(rpc.request({ requestId: 1 })).rejects.toThrow('unreadable')
    worker.onmessageerror!()
    await unreadable
    rpc.restart()
    worker.postMessage = () => { throw new Error('cannot clone') }
    await expect(rpc.request({ requestId: 2 })).rejects.toThrow('cannot clone')
    expect(useTaskActivity.getState().tasks).toEqual({})
    rpc.dispose()
  })
  it('restores the mesh before retrying a measurement, sharing one recovery between callers', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new MeshWorkerClient()
    client.restoreState = () => ({ scan: { name: 'scan.obj', file: new Blob([new Uint8Array([1])]), crease: { mode: 'off', angleDeg: 30 }, transform: null }, nominal: null })
    FakeWorker.instances[0].crash()
    const one = client.centroid()
    const two = client.curvature()
    await tick()
    const replacement = FakeWorker.instances[1]
    expect(FakeWorker.instances).toHaveLength(2)
    expect(replacement.messages.map((m) => m.type)).toEqual(['load'])
    replacement.answer('loaded')
    await tick()
    expect(replacement.messages.map((m) => m.type)).toEqual(['load', 'centroid', 'curvature'])
    for (const message of replacement.messages.slice(1)) replacement.onmessage!({ data: { type: `${message.type}-ok`, requestId: message.requestId, result: {}, values: new Float32Array(0) } })
    await Promise.all([one, two])
  })
  it('says the scan can no longer be read when a restart finds its file changed on disk', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new MeshWorkerClient()
    class Gone extends File {
      override arrayBuffer(): Promise<ArrayBuffer> { return Promise.reject(new DOMException('gone', 'NotReadableError')) }
    }
    client.restoreState = () => ({ scan: { name: 'big.ply', file: new Gone([new Uint8Array([1])], 'big.ply'), crease: { mode: 'off', angleDeg: 30 }, transform: null }, nominal: null })
    FakeWorker.instances[0].crash()
    await expect(client.centroid()).rejects.toThrow(unreadableSource('big.ply'))
    // Nothing reached the new worker.
    expect(FakeWorker.instances[1].messages).toEqual([])
  })
  it('puts a plugin’s own models back after the scan, before the request that found the worker gone', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new MeshWorkerClient()
    client.restoreState = () => ({ scan: { name: 'scan.obj', file: new Blob([new Uint8Array([1])]), crease: { mode: 'off', angleDeg: 30 }, transform: null }, nominal: null })
    const stop = client.onRestore(async (channel) => {
      const id = await channel.loadStaged('copy.ply', new Uint8Array([2]), { mode: 'off', angleDeg: 30 }, null)
      await channel.call('plugin-x', 'adopt', { staged: id })
    })
    FakeWorker.instances[0].crash()
    const centroid = client.centroid()
    await tick()
    const replacement = FakeWorker.instances[1]
    const step = async (type: string) => {
      replacement.answer(type)
      await tick()
    }
    await step('loaded')
    await step('loaded')
    await step('plugin-ok')
    const sent = replacement.messages as { type?: string; staged?: boolean; plugin?: string; op?: string }[]
    expect(sent.map((m) => m.type)).toEqual(['load', 'load', 'plugin', 'centroid'])
    expect(sent[1].staged).toBe(true)
    expect([sent[2].plugin, sent[2].op]).toEqual(['plugin-x', 'adopt'])
    replacement.onmessage!({ data: { type: 'centroid-ok', requestId: replacement.messages[3].requestId, result: {} } })
    await centroid
    stop()
  })
  it('lets edge detection retry with a new worker after failure', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new EdgeClient()
    const failed = expect(client.detect(new Uint8Array(4), 2, 2, { sensitivity: 0.5 })).rejects.toThrow('test failure')
    FakeWorker.instances[0].crash()
    await failed
    const retry = client.detect(new Uint8Array(4), 2, 2, { sensitivity: 0.5 })
    FakeWorker.instances[1].onmessage!({ data: { requestId: 2, type: 'edges', points: new Float32Array(0), offsets: new Uint32Array(0) } })
    expect(await retry).not.toBeNull()
    client.dispose()
  })
})
