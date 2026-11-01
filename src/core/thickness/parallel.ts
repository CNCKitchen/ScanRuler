// SPDX-License-Identifier: AGPL-3.0-only
// The wall thickness measurement on every core: the vertices are cut into
// slices that a set of helper workers take as they come free, each helper
// holding its own copy of the scan's tree. Every vertex is measured by the
// same code as without helpers (computeThickness), so the readings are
// identical; only the clock differs.

import { MeshBVH } from 'three-mesh-bvh'
import type { HelperRequest, HelperResponse } from './thicknessHelper'
import type { ThicknessOptions } from './thickness'

/** Below this many vertices the helpers cost more to start than they save. */
const MIN_VERTICES = 20_000
/** Starting helpers costs about a second on a part of 700 000 triangles: the tree is copied to each. A
 *  single ray a vertex is done sooner than that; a cone of rays or a sphere is not. Measured: 720 000
 *  triangles, one ray 1.9 s alone against 2.7 s with helpers; a 6-ray cone 11.2 s against 1.8 s. */
const MIN_RAYS_PER_VERTEX = 4
const MAX_HELPERS = 16
/** Slices a helper is given in turn: enough that a slow stretch of the part (a
 *  cone through a thick region) does not leave the others idle at the end. */
const SLICES_PER_HELPER = 16

/**
 * How many helpers to use for a scan of this many vertices, each costing about
 * `raysPerVertex` rays' work (a sphere counts as eight): none when this is not a
 * browser worker (the headless engine runs the mesh worker in the main thread,
 * with no way to start another), or when there is no gain.
 */
export function helpersFor(vertexCount: number, raysPerVertex: number): number {
  // The DOM lib this project compiles against has no WorkerGlobalScope.
  const scope = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown }
  const isWorker = typeof scope.WorkerGlobalScope === 'function' && globalThis instanceof scope.WorkerGlobalScope
  if (!isWorker || vertexCount < MIN_VERTICES || raysPerVertex < MIN_RAYS_PER_VERTEX) return 0
  // Two cores stay free for the page and this worker, which waits meanwhile.
  const n = Math.min(MAX_HELPERS, (navigator.hardwareConcurrency || 1) - 2)
  return n >= 2 ? n : 0
}

/**
 * Measure thickness at every vertex with `helpers` workers. Rejects if any of
 * them fails, with all of them stopped; the caller can then measure the
 * ordinary way.
 */
export function computeThicknessParallel(
  bvh: MeshBVH,
  positions: Float32Array,
  normals: Float32Array,
  options: ThicknessOptions,
  helpers: number,
  onProgress?: (fraction: number) => void,
): Promise<Float32Array> {
  const count = positions.length / 3
  const out = new Float32Array(count)
  const sliceSize = Math.max(1000, Math.ceil(count / (helpers * SLICES_PER_HELPER)))
  const slices: { from: number; to: number }[] = []
  for (let from = 0; from < count; from += sliceSize) slices.push({ from, to: Math.min(count, from + sliceSize) })
  const tree = MeshBVH.serialize(bvh)

  return new Promise((resolve, reject) => {
    const workers: Worker[] = []
    let next = 0
    let measured = 0
    let settled = false
    const stop = () => {
      for (const w of workers) w.terminate()
      workers.length = 0
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(message))
    }
    const give = (w: Worker) => {
      if (next >= slices.length) return
      const id = next++
      w.postMessage({ type: 'range', id, from: slices[id].from, to: slices[id].to } satisfies HelperRequest)
    }
    for (let i = 0; i < helpers; i++) {
      const w = new Worker(new URL('./thicknessHelper.ts', import.meta.url), { type: 'module' })
      workers.push(w)
      w.onerror = (e) => fail(`A thickness helper failed${e.message ? `: ${e.message}` : '.'}`)
      w.onmessageerror = () => fail('A thickness helper returned an unreadable answer.')
      w.onmessage = ({ data }: MessageEvent<HelperResponse>) => {
        if (settled) return
        if (data.type === 'error') return fail(data.message)
        if (data.type === 'done') {
          const { from, to } = slices[data.id]
          out.set(data.values, from)
          measured += to - from
          onProgress?.(measured / count)
          if (measured >= count) {
            settled = true
            stop()
            resolve(out)
            return
          }
        }
        give(w)
      }
      // Copies, not transfers: this worker keeps its own for the serial path and the next measurement.
      w.postMessage({ type: 'init', bvh: tree, positions, normals, options } satisfies HelperRequest)
    }
  })
}
