// SPDX-License-Identifier: AGPL-3.0-only
// Wrap's own worker: the mesh in, the wrap out, a line of progress at every
// step between. Its own rather than a job on the mesh worker, so Cancel can
// stop it outright — a worker hears no message in the middle of a loop —
// and the mesh worker, with the scan in it, is not touched. The tiles' work
// it hands to a pool of workers of its own (wrapTileWorker.ts), one for each
// core the machine has to spare; stopping this worker stops them too.

import { reply } from '../../../src/core/workerRpc'
import { loadSimplifier } from './reduce'
import { WrapMemo, wrapMesh, type WrapResult, type WrapSettings } from './wrap'
import { workerPool, type JobWorker, type WrapRunner } from './wrapJobs'

export interface WrapRequest {
  requestId: number
  type: 'wrap'
  positions: Float32Array
  indices: Uint32Array
  settings: WrapSettings
}

export type WrapResponse =
  | { type: 'progress'; requestId: number; text: string }
  | { type: 'done'; requestId: number; result: WrapResult }
  | { type: 'error'; requestId: number; message: string }

/** The most tile workers: each costs about a hundred megabytes — its own
 *  heap, scratch and simplifier — and past this many the wrap is no faster,
 *  the rest of it, done here, being what it waits for. */
const MAX_TILE_WORKERS = 8

/** The field of the last wrap, kept so another Grow by of the same mesh
 *  and gap starts from it. */
const memo = new WrapMemo()

/** The pool, made with the first wrap and kept for the next; made again
 *  after one of its workers failed. */
let pool: WrapRunner | null = null
let poolFailed = false
function tilePool(): WrapRunner {
  if (pool && !poolFailed) return pool
  pool?.dispose()
  poolFailed = false
  const size = Math.max(1, Math.min(MAX_TILE_WORKERS, (self.navigator.hardwareConcurrency || 2) - 1))
  pool = workerPool(size, () => new Worker(new URL('./wrapTileWorker.ts', import.meta.url), { type: 'module' }) as unknown as JobWorker)
  return pool
}

self.onmessage = async (ev: MessageEvent<WrapRequest>) => {
  const { requestId, positions, indices, settings } = ev.data
  try {
    const simplifier = await loadSimplifier()
    const runner = tilePool()
    const result = await wrapMesh(positions, indices, settings, simplifier, (text) => reply({ type: 'progress', requestId, text } satisfies WrapResponse), runner, memo).catch((e) => {
      if (e instanceof Error && /wrap worker/.test(e.message)) poolFailed = true
      throw e
    })
    reply({ type: 'done', requestId, result } satisfies WrapResponse, [result.positions.buffer, result.indices.buffer, result.bridge.buffer])
  } catch (e) {
    reply({ type: 'error', requestId, message: e instanceof Error ? e.message : String(e) } satisfies WrapResponse)
  }
}
