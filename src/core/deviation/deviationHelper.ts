// SPDX-License-Identifier: AGPL-3.0-only
// A helper for the deviation map (see parallel.ts): given the reference and the
// scan once, it builds the reference's own closest-point structure, then
// measures the slices of the scan it is sent and answers each with that
// slice's readings. The arithmetic is computeDeviation's own.

import { computeDeviation } from './deviation'
import type { Rigid } from './rigid'
import { NominalSurface } from './surface'

export interface DeviationSetup {
  type: 'init'
  referencePositions: Float32Array
  referenceIndex: Uint32Array
  scanPositions: Float32Array
  scanNormals: Float32Array | null
  transform: Rigid
  maxNormalDeviation: number | null
  /** Whether the readings' directions are wanted too. */
  directions: boolean
  /** Which way the scan's normals point, settled once by the caller. */
  outward: 1 | -1
}

export type DeviationHelperRequest = DeviationSetup | { type: 'range'; id: number; from: number; to: number }

export type DeviationHelperResponse =
  | { type: 'ready' }
  | { type: 'done'; id: number; values: Float32Array; directions: Int8Array | null }
  | { type: 'error'; message: string }

let state: { surface: NominalSurface; setup: DeviationSetup } | null = null

const send = (message: DeviationHelperResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer)

self.onmessage = ({ data }: MessageEvent<DeviationHelperRequest>) => {
  try {
    if (data.type === 'init') {
      state = { surface: new NominalSurface(data.referencePositions, data.referenceIndex), setup: data }
      send({ type: 'ready' })
      return
    }
    if (!state) throw new Error('A deviation helper was asked for a range before it was set up.')
    const { surface, setup } = state
    const directions = setup.directions ? new Int8Array((data.to - data.from) * 3) : null
    const values = computeDeviation(surface, setup.scanPositions, setup.transform, {
      range: { from: data.from, to: data.to },
      directions: directions ?? undefined,
      normals: setup.scanNormals ?? undefined,
      maxNormalDeviation: setup.maxNormalDeviation,
      outward: setup.outward,
    })
    send({ type: 'done', id: data.id, values, directions }, directions ? [values.buffer, directions.buffer] : [values.buffer])
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
