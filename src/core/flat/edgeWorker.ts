// SPDX-License-Identifier: AGPL-3.0-only
// The edge-detection worker: grayscale in, chains out. Its own worker rather
// than a job on the mesh worker because the two workspaces are independent —
// a thickness measurement must not queue behind an edge sweep. The heavy
// buffers travel by transfer in both directions.

import { detectEdges, type EdgeOptions } from './edges'

export interface EdgeWorkerRequest {
  requestId: number
  gray: Uint8Array
  width: number
  height: number
  options: EdgeOptions
}

export type EdgeWorkerResponse =
  | { type: 'edges'; requestId: number; points: Float32Array; offsets: Uint32Array }
  | { type: 'error'; requestId: number; message: string }

self.onmessage = (ev: MessageEvent<EdgeWorkerRequest>) => {
  const { requestId, gray, width, height, options } = ev.data
  try {
    const chains = detectEdges(gray, width, height, options)
    const msg: EdgeWorkerResponse = {
      type: 'edges',
      requestId,
      points: chains.points,
      offsets: chains.offsets,
    }
    self.postMessage(msg, { transfer: [chains.points.buffer, chains.offsets.buffer] })
  } catch (e) {
    const msg: EdgeWorkerResponse = {
      type: 'error',
      requestId,
      message: e instanceof Error ? e.message : String(e),
    }
    self.postMessage(msg)
  }
}
