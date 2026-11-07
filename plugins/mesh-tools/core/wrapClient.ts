// SPDX-License-Identifier: AGPL-3.0-only
// The wrap, run in its own worker (wrapWorker.ts) — or, without a browser,
// in this thread: under the tests the Worker the page would make is the
// mesh worker's stand-in. Cancel terminates the worker; the next wrap makes
// another.

import { WorkerRpc } from '../../../src/core/workerRpc'
import type { WrapRequest, WrapResponse } from './wrapWorker'
import { WrapMemo, type WrapResult, type WrapSettings } from './wrap'

/** What a cancelled wrap rejects with. */
export class WrapCancelled extends Error {
  constructor() {
    super('The wrap was cancelled.')
  }
}

export class WrapClient {
  private rpc: WorkerRpc | null = null
  private nextId = 1
  private listening: { id: number; onProgress: (text: string) => void } | null = null
  private cancelled = new Set<number>()
  /** The field kept between wraps run in this thread. */
  private memo = new WrapMemo()

  /** The wrap of these triangles — the buffers are handed over, not
   *  copied. Progress lines go to `onProgress`. */
  async run(positions: Float32Array, indices: Uint32Array, settings: WrapSettings, onProgress: (text: string) => void): Promise<WrapResult> {
    const requestId = this.nextId++
    if (typeof document === 'undefined') {
      // No page: in this thread, all at once.
      const [{ wrapMesh }, { loadSimplifier }] = await Promise.all([import('./wrap'), import('./reduce')])
      const simplifier = await loadSimplifier()
      if (this.cancelled.delete(requestId)) throw new WrapCancelled()
      return wrapMesh(positions, indices, settings, simplifier, onProgress, undefined, this.memo)
    }
    if (!this.rpc || this.rpc.dead) {
      this.rpc = new WorkerRpc(() => new Worker(new URL('./wrapWorker.ts', import.meta.url), { type: 'module' }), 'Wrap worker', (data) => {
        const msg = data as WrapResponse
        if (msg.type !== 'progress') return false
        if (this.listening?.id === msg.requestId) this.listening.onProgress(msg.text)
        return true
      })
    }
    this.listening = { id: requestId, onProgress }
    const request: WrapRequest = { requestId, type: 'wrap', positions, indices, settings }
    try {
      const answer = await this.rpc.request<WrapResponse>(request, [positions.buffer, indices.buffer])
      if (answer.type !== 'done') throw new Error(answer.type === 'error' ? answer.message : 'The wrap did not come back.')
      return answer.result
    } catch (e) {
      if (this.cancelled.delete(requestId)) throw new WrapCancelled()
      throw e
    } finally {
      if (this.listening?.id === requestId) this.listening = null
    }
  }

  /** Stop the wrap running, if one is: its run rejects with WrapCancelled. */
  cancel(): void {
    const running = this.listening?.id ?? this.nextId - 1
    this.cancelled.add(running)
    if (this.rpc) {
      this.rpc.dispose()
      this.rpc = null
    }
  }

  dispose(): void {
    this.rpc?.dispose()
    this.rpc = null
  }
}
