// SPDX-License-Identifier: AGPL-3.0-only
// Promise wrapper around the edge worker, with the one policy detail that
// matters here: only the latest request counts. A sensitivity slider fires
// detections faster than a big scan computes them, and a stale result landing
// after a newer one would put the wrong edges on screen — so anything but the
// newest request resolves to null and is thrown away.

import { WorkerRpc } from '../workerRpc'
import type { EdgeChains, EdgeOptions } from './edges'
import type { EdgeWorkerRequest, EdgeWorkerResponse } from './edgeWorker'

export class EdgeClient {
  private rpc = new WorkerRpc(() => new Worker(new URL('./edgeWorker.ts', import.meta.url), { type: 'module' }), 'Edge worker')
  private nextId = 1
  private latest = 0

  /** Detect edges on a grayscale image. The buffer is transferred — hand in a
   *  copy if the caller still needs it. Resolves null when a newer request
   *  has superseded this one (or the worker failed). */
  detect(
    gray: Uint8Array,
    width: number,
    height: number,
    options: EdgeOptions,
  ): Promise<EdgeChains | null> {
    const requestId = this.nextId++
    this.latest = requestId
    const msg: EdgeWorkerRequest = { requestId, gray, width, height, options }
    if (this.rpc.dead) this.rpc.restart()
    return this.rpc.request<EdgeWorkerResponse>(msg, [gray.buffer]).then((answer) => {
      if (requestId !== this.latest || answer.type === 'error') return null
      return { points: answer.points, offsets: answer.offsets }
    })
  }

  dispose(): void { this.rpc.dispose() }

}

/** Grayscale (Rec. 601) off a decoded bitmap, for the worker. Main-thread on
 *  purpose: drawImage into a canvas is the fast native path to the pixels. */
export function grayscaleOf(bitmap: ImageBitmap): { gray: Uint8Array; width: number; height: number } {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  const gray = new Uint8Array(bitmap.width * bitmap.height)
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4
    gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
  }
  return { gray, width: bitmap.width, height: bitmap.height }
}
