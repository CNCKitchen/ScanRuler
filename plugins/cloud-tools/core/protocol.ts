// SPDX-License-Identifier: AGPL-3.0-only
// What the Cloud Tools workspace asks of the mesh worker, and what comes
// back — the operations its part of the worker answers (see ../worker.ts).
// Points are the scan's vertices as the worker holds them: in the frame
// shown, millimetres.

import type { Rigid } from '../../../src/core/deviation/rigid'
import type { Vec3 } from '../../../src/core/types'
import type { FloatingSurvey } from './clean'

/** The plugin's id, which its worker part answers to. */
export const CLOUD_TOOLS = 'cloud-tools'

export interface CloudToolsOps {
  /** The pieces smaller than `percent` of the main body (core/clean.ts). The
   *  pieces are worked out once per scan; a new percentage only sorts them. */
  floating: { payload: { percent: number }; result: FloatingSurvey }
  /** The points past the plane through `origin`, on the side `normal` points to. */
  'past-plane': { payload: { origin: Vec3; normal: Vec3 }; result: { vertices: Uint32Array } }
  /** The scan without `vertices`, carried by `toFile` into the file's frame
   *  — the swap puts the alignment back on. `map`: each vertex's index in
   *  what comes back, -1 for one taken out. */
  remove: {
    payload: { vertices: Uint32Array; toFile: Rigid }
    result: { positions: Float32Array; normals: Float32Array; map: Int32Array; dropped: number }
  }
}
