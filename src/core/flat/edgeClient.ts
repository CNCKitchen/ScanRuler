// SPDX-License-Identifier: AGPL-3.0-only
// Promise wrapper around the edge worker, with the one policy detail that
// matters here: only the latest request counts. A sensitivity slider fires
// detections faster than a big scan computes them, and a stale result landing
// after a newer one would put the wrong edges on screen — so anything but the
// newest request resolves to null and is thrown away.

import type { EdgeChains, EdgeOptions } from './edges'
import type { EdgeWorkerRequest, EdgeWorkerResponse } from './edgeWorker'

export class EdgeClient {
  private worker: Worker
  private nextId = 1
  private latest = 0
  private pending = new Map<number, (chains: EdgeChains | null) => void>()

  constructor() {
    this.worker = new Worker(new URL('./edgeWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<EdgeWorkerResponse>) => {
      const msg = ev.data
      const resolve = this.pending.get(msg.requestId)
      if (!resolve) return
      this.pending.delete(msg.requestId)
      if (msg.type === 'error' || msg.requestId !== this.latest) {
        resolve(null)
        return
      }
      resolve({ points: msg.points, offsets: msg.offsets })
    }
  }

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
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.worker.postMessage(msg, [gray.buffer])
    })
  }

  dispose(): void {
    this.worker.terminate()
    for (const resolve of this.pending.values()) resolve(null)
    this.pending.clear()
  }
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
