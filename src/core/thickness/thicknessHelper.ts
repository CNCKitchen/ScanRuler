// SPDX-License-Identifier: AGPL-3.0-only
// A helper for the wall thickness measurement (see parallel.ts): it is given
// the scan's tree once, then slices of the vertices to measure, and answers
// each with that slice's readings. The arithmetic is computeThickness's own.

import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { computeThickness, type ThicknessOptions } from './thickness'

export type HelperRequest =
  | { type: 'init'; bvh: ReturnType<typeof MeshBVH.serialize>; positions: Float32Array; normals: Float32Array; options: ThicknessOptions }
  | { type: 'range'; id: number; from: number; to: number }

export type HelperResponse =
  | { type: 'ready' }
  | { type: 'done'; id: number; values: Float32Array }
  | { type: 'error'; message: string }

let state: { bvh: MeshBVH; positions: Float32Array; normals: Float32Array; options: ThicknessOptions } | null = null

const send = (message: HelperResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer)

self.onmessage = ({ data }: MessageEvent<HelperRequest>) => {
  try {
    if (data.type === 'init') {
      // The tree was built over the scan's own position array, so it is given
      // the same positions here and takes the reordered index back from the data.
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
      state = { bvh: MeshBVH.deserialize(data.bvh, geometry), positions: data.positions, normals: data.normals, options: data.options }
      send({ type: 'ready' })
      return
    }
    if (!state) throw new Error('A thickness helper was asked for a range before it was set up.')
    const values = computeThickness(state.bvh, state.positions, state.normals, state.options, undefined, { from: data.from, to: data.to })
    send({ type: 'done', id: data.id, values }, [values.buffer])
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
