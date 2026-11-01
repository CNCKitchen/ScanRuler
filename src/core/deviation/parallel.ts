// SPDX-License-Identifier: AGPL-3.0-only
// The deviation map on every core, when it is worth it. How long a map takes
// depends on the scan, not its size: a scan whose normals agree with the
// reference reads at about two microseconds a point, while one with surfaces
// facing away from it (the inside of a thin wall against a solid reference)
// sends each such point into a second search a hundred times slower. So a few
// small stretches spread over the scan are measured here first (the scan's
// vertices are not in random order: the first thousand are one skin of a wall),
// and only if the rest would take seconds are helpers started — each builds
// the reference's structure itself, which costs about a second on a reference
// of 150 000 triangles. Every point is measured by the same code either way
// (computeDeviation).

import { helpersFor } from '../thickness/parallel'
import { computeDeviation, scanNormalsSign, type DeviationOptions } from './deviation'
import type { DeviationHelperRequest, DeviationHelperResponse } from './deviationHelper'
import type { Rigid } from './rigid'
import type { NominalSurface } from './surface'

/** Stretches measured here before deciding, and how many points in each. */
const PROBES = 8
const PROBE_LENGTH = 500
/** Helpers are started only when what is left would take longer than this: below it
 *  they are slower than just carrying on. Measured on a 150 000 triangle reference. */
const WORTH_MS = 2_500
/** Each helper builds its own copy of the reference; past this it costs more than it saves. */
const MAX_REFERENCE_TRIANGLES = 1_500_000
const SLICES_PER_HELPER = 16

type Span = { from: number; to: number }

/**
 * The deviation map, as `computeDeviation` reads it. The answer is the array itself
 * when it was measured here, and a promise of it only when helpers were started:
 * a request that never leaves this thread is answered in the same turn, as it
 * always was.
 */
export function computeDeviationAuto(
  surface: NominalSurface,
  scanPositions: Float32Array,
  transform: Rigid,
  options: DeviationOptions = {},
): Float32Array | Promise<Float32Array> {
  const { onProgress, directions, normals, maxNormalDeviation = null } = options
  const n = scanPositions.length / 3
  const values = new Float32Array(n)
  const facing = normals && maxNormalDeviation !== null
  // Settled once for the whole scan: the same sign, whichever slice is asked.
  const outward: 1 | -1 = facing ? scanNormalsSign(surface, scanPositions, normals!, transform) : 1

  const measure = (from: number, to: number, report?: (f: number) => void) => {
    values.set(
      computeDeviation(surface, scanPositions, transform, {
        range: { from, to },
        directions: directions?.subarray(from * 3, to * 3),
        normals,
        maxNormalDeviation,
        outward,
        onProgress: report && ((f) => report((from + f * (to - from)) / n)),
      }),
      from,
    )
  }

  // A small scan is simply measured.
  if (n <= PROBES * PROBE_LENGTH * 2) {
    measure(0, n, onProgress)
    onProgress?.(1)
    return values
  }
  const probes: Span[] = []
  const step = Math.floor(n / PROBES)
  for (let k = 0; k < PROBES; k++) probes.push({ from: k * step, to: k * step + PROBE_LENGTH })
  const t0 = performance.now()
  for (const p of probes) measure(p.from, p.to)
  const perPoint = (performance.now() - t0) / (PROBES * PROBE_LENGTH)
  const rest: Span[] = []
  let at = 0
  for (const p of probes) {
    if (p.from > at) rest.push({ from: at, to: p.from })
    at = p.to
  }
  if (at < n) rest.push({ from: at, to: n })
  const left = rest.reduce((sum, s) => sum + (s.to - s.from), 0)

  const projected = perPoint * left
  const helpers = projected > WORTH_MS && surface.triangleCount <= MAX_REFERENCE_TRIANGLES ? helpersFor(n, Infinity) : 0
  const here = () => {
    for (const s of rest) measure(s.from, s.to, onProgress)
    onProgress?.(1)
    return values
  }
  if (helpers === 0) return here()
  return onHelpers(surface, scanPositions, normals ?? null, transform, maxNormalDeviation, outward, helpers, values, directions, rest, n - left, onProgress).then(
    () => {
      onProgress?.(1)
      return values
    },
    (e) => {
      // Helpers that would not start, or died: carry on here, over the whole of what is left.
      console.warn('The deviation helpers failed; measuring here instead.', e)
      return here()
    },
  )
}

/** Measure the `rest` of the scan on `helpers` workers, filling `values` (and `directions`). */
function onHelpers(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  transform: Rigid,
  maxNormalDeviation: number | null,
  outward: 1 | -1,
  helpers: number,
  values: Float32Array,
  directions: Int8Array | undefined,
  rest: Span[],
  already: number,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const n = scanPositions.length / 3
  const sliceSize = Math.max(1000, Math.ceil((n - already) / (helpers * SLICES_PER_HELPER)))
  const slices: Span[] = []
  for (const s of rest) for (let from = s.from; from < s.to; from += sliceSize) slices.push({ from, to: Math.min(s.to, from + sliceSize) })

  return new Promise((resolve, reject) => {
    const workers: Worker[] = []
    let next = 0
    let measured = already
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
      w.postMessage({ type: 'range', id, from: slices[id].from, to: slices[id].to } satisfies DeviationHelperRequest)
    }
    for (let i = 0; i < helpers; i++) {
      const w = new Worker(new URL('./deviationHelper.ts', import.meta.url), { type: 'module' })
      workers.push(w)
      w.onerror = (e) => fail(`A deviation helper failed${e.message ? `: ${e.message}` : '.'}`)
      w.onmessageerror = () => fail('A deviation helper returned an unreadable answer.')
      w.onmessage = ({ data }: MessageEvent<DeviationHelperResponse>) => {
        if (settled) return
        if (data.type === 'error') return fail(data.message)
        if (data.type === 'done') {
          const { from, to } = slices[data.id]
          values.set(data.values, from)
          if (directions && data.directions) directions.set(data.directions, from * 3)
          measured += to - from
          onProgress?.(measured / n)
          if (measured >= n) {
            settled = true
            stop()
            resolve()
            return
          }
        }
        give(w)
      }
      w.postMessage({
        type: 'init',
        referencePositions: surface.positions,
        referenceIndex: surface.index,
        scanPositions,
        scanNormals,
        transform,
        maxNormalDeviation,
        directions: directions !== undefined,
        outward,
      } satisfies DeviationHelperRequest)
    }
  })
}
