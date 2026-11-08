// SPDX-License-Identifier: AGPL-3.0-only
// A helper for the alignment (see icpPool.ts): builds the reference's own
// closest-point structure, then, for each pass, pairs the blocks of samples it is
// dealt and writes what it found into the memory it shares with the pool. The
// arithmetic is pairRange's own.

import { PAIR_CHUNK, pairRange, type PairArrays, type PairParams } from './icp'
import type { Rigid } from './rigid'
import { NominalSurface } from './surface'

export type IcpHelperRequest =
  | { type: 'init'; referencePositions: Float32Array; referenceIndex: Uint32Array }
  | { type: 'session'; id: number; xyz: Float64Array; normals: Float64Array | null; arrays: PairArrays }
  | { type: 'pair'; pass: number; session: number; transform: Rigid; params: PairParams; of: number; index: number }

export type IcpHelperResponse = { type: 'ready' } | { type: 'paired'; pass: number } | { type: 'error'; message: string }

let surface: NominalSurface | null = null
const sessions = new Map<number, { xyz: Float64Array; normals: Float64Array | null; arrays: PairArrays }>()

const send = (message: IcpHelperResponse) => (self as unknown as Worker).postMessage(message)

self.onmessage = ({ data }: MessageEvent<IcpHelperRequest>) => {
  try {
    if (data.type === 'init') {
      surface = new NominalSurface(data.referencePositions, data.referenceIndex)
      send({ type: 'ready' })
    } else if (data.type === 'session') {
      sessions.set(data.id, data)
    } else {
      const s = sessions.get(data.session)
      if (!surface || !s) throw new Error('An alignment helper was asked for a pass before it was set up.')
      const n = s.xyz.length / 3
      for (let c = data.index; c * PAIR_CHUNK < n; c += data.of) {
        pairRange(surface, s, data.transform, data.params, s.arrays, c * PAIR_CHUNK, Math.min(n, (c + 1) * PAIR_CHUNK))
      }
      send({ type: 'paired', pass: data.pass })
    }
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
