// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerRpc } from '../src/core/workerRpc'
import { MeshWorkerClient } from '../src/core/workerClient'
import { EdgeClient } from '../src/core/flat/edgeClient'

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
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = [] })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('worker lifecycle', () => {
  it('rejects every pending job on a crash and rejects future jobs until restarted', async () => {
    const worker = new FakeWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    const first = expect(rpc.request({ requestId: 1 })).rejects.toThrow('test failure')
    const second = expect(rpc.request({ requestId: 2 })).rejects.toThrow('test failure')
    worker.crash()
    await Promise.all([first, second])
    expect(worker.terminated).toBe(true)
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
    rpc.dispose()
  })
  it('restores the mesh before retrying a measurement, sharing one recovery between callers', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new MeshWorkerClient()
    client.restoreState = () => ({ scan: { name: 'scan.obj', bytes: new Uint8Array([1]), crease: 'off', transform: null }, nominal: null })
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
  it('puts a plugin’s own models back after the scan, before the request that found the worker gone', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new MeshWorkerClient()
    client.restoreState = () => ({ scan: { name: 'scan.obj', bytes: new Uint8Array([1]), crease: 'off', transform: null }, nominal: null })
    const stop = client.onRestore(async (channel) => {
      const id = await channel.loadStaged('copy.ply', new Uint8Array([2]), 'off', null)
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
