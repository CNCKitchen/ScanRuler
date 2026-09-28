// SPDX-License-Identifier: AGPL-3.0-only
// A sample part: an L-shaped bracket, made here rather than shipped as a
// file.
//
// A sample wants a part whose answer is obvious — one profile, drawn out
// straight — and which behaves like a scan: dense, closed, shared vertices,
// and lying in the frame askew, the way a part lies on a turntable, so an
// alignment has something to do. An L does that better than a cube: its end
// face gives a slice that is visibly the part's profile, and a fit has an
// inside corner to find. It is built of millimetre cells, the
// boundary faces of the cells emitted as quads over vertices shared by
// their integer corner, which makes the mesh watertight by construction.

import type { Rigid } from '../deviation/rigid'
import { rigidApplyToPoints } from '../deviation/rigid'

/** The file name the sample loads under — what the guide keys on. */
export const SAMPLE_PART_NAME = 'sample-bracket.stl'

/** The L's profile, millimetres: a 40 × 30 outline with legs 12 thick. */
export const SAMPLE_WIDTH = 40
export const SAMPLE_HEIGHT = 30
export const SAMPLE_LEG = 12
/** How far the profile is extruded. */
export const SAMPLE_DEPTH = 20

/** The volume of the sample, for a check on what is modelled from it. */
export const SAMPLE_VOLUME = (SAMPLE_WIDTH * SAMPLE_LEG + SAMPLE_LEG * (SAMPLE_HEIGHT - SAMPLE_LEG)) * SAMPLE_DEPTH

function inside(x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= SAMPLE_WIDTH || y >= SAMPLE_HEIGHT || z >= SAMPLE_DEPTH) return false
  return y < SAMPLE_LEG || x < SAMPLE_LEG
}

/** The pose the sample is left in: turned 14° about a skew axis and moved
 *  off the origin — a scanner's frame, nobody's datum. */
export function samplePose(): Rigid {
  const axis = [0.36, 0.48, 0.8]
  const a = (14 * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  const [x, y, z] = axis
  // Row-major rotation about a unit axis (Rodrigues).
  const r = Float64Array.from([
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ])
  return { r, t: Float64Array.from([18, -7, 25]) }
}

/** The sample as a mesh, in its skew pose unless `posed` is false. */
export function buildSamplePart(posed = true): { positions: Float32Array; indices: Uint32Array } {
  const nx = SAMPLE_WIDTH + 1
  const ny = SAMPLE_HEIGHT + 1
  const ids = new Map<number, number>()
  const xyz: number[] = []
  const tri: number[] = []
  const vertex = (x: number, y: number, z: number): number => {
    const key = (z * ny + y) * nx + x
    let id = ids.get(key)
    if (id === undefined) {
      id = xyz.length / 3
      ids.set(key, id)
      xyz.push(x, y, z)
    }
    return id
  }
  /** A unit quad at a cell's face, its corners wound to face along +axis
   *  when `positive`, the other way otherwise. */
  const quad = (o: [number, number, number], u: [number, number, number], v: [number, number, number], positive: boolean) => {
    const a = vertex(o[0], o[1], o[2])
    const b = vertex(o[0] + u[0], o[1] + u[1], o[2] + u[2])
    const c = vertex(o[0] + u[0] + v[0], o[1] + u[1] + v[1], o[2] + u[2] + v[2])
    const d = vertex(o[0] + v[0], o[1] + v[1], o[2] + v[2])
    if (positive) tri.push(a, b, c, a, c, d)
    else tri.push(a, c, b, a, d, c)
  }
  for (let z = 0; z < SAMPLE_DEPTH; z++) {
    for (let y = 0; y < SAMPLE_HEIGHT; y++) {
      for (let x = 0; x < SAMPLE_WIDTH; x++) {
        if (!inside(x, y, z)) continue
        // u × v is the +axis in each case, so `positive` is the outward side.
        if (!inside(x + 1, y, z)) quad([x + 1, y, z], [0, 1, 0], [0, 0, 1], true)
        if (!inside(x - 1, y, z)) quad([x, y, z], [0, 1, 0], [0, 0, 1], false)
        if (!inside(x, y + 1, z)) quad([x, y + 1, z], [0, 0, 1], [1, 0, 0], true)
        if (!inside(x, y - 1, z)) quad([x, y, z], [0, 0, 1], [1, 0, 0], false)
        if (!inside(x, y, z + 1)) quad([x, y, z + 1], [1, 0, 0], [0, 1, 0], true)
        if (!inside(x, y, z - 1)) quad([x, y, z], [1, 0, 0], [0, 1, 0], false)
      }
    }
  }
  const positions = Float32Array.from(xyz)
  if (posed) rigidApplyToPoints(samplePose(), positions)
  return { positions, indices: Uint32Array.from(tri) }
}
