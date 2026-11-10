// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of cleaning a point cloud up: which points belong together
// (pieces), which of them float off the main body, which lie past a plane,
// and the cloud with a set of points taken out. No DOM, no scene: the worker
// runs it, and the tests run it as it is.

import { PointGrid } from '../../../src/core/geometry/pointGrid'
import type { Vec3 } from '../../../src/core/types'

/** Points closer than this many point spacings are one piece. Three bridges
 *  the uneven sampling a hand scanner leaves along a body's edges and in its
 *  shadowed corners, and still leaves a speck floating a few spacings off
 *  the part on its own. */
export const GAP_SPACINGS = 3

/** The cloud cut into pieces: points within `gap` of each other, and every
 *  point reached that way from them, are one piece. */
export interface CloudPieces {
  /** The piece of each point, -1 for a point with no finite position. */
  label: Int32Array
  /** The number of points in each piece. */
  size: Int32Array
  /** The largest piece: the main body. -1 with no points. */
  main: number
}

export function cloudPieces(positions: Float32Array, count: number, gap: number): CloudPieces {
  if (!(gap > 0)) throw new Error('The gap that joins points must be more than zero.')
  const p = positions.subarray(0, count * 3)
  // A cell of the gap itself: a radius query then looks at 27 cells at most.
  const grid = new PointGrid(p, gap)
  const label = new Int32Array(count).fill(-1)
  const sizes: number[] = []
  const queue = new Int32Array(count)
  const near: number[] = []
  for (let seed = 0; seed < count; seed++) {
    if (label[seed] !== -1 || !Number.isFinite(p[3 * seed] + p[3 * seed + 1] + p[3 * seed + 2])) continue
    const id = sizes.length
    let head = 0, tail = 0
    queue[tail++] = seed
    label[seed] = id
    while (head < tail) {
      const i = queue[head++]
      grid.withinRadius(p[3 * i], p[3 * i + 1], p[3 * i + 2], gap, near)
      for (const j of near) {
        if (label[j] !== -1) continue
        label[j] = id
        queue[tail++] = j
      }
    }
    sizes.push(tail)
  }
  const size = Int32Array.from(sizes)
  let main = -1
  for (let k = 0; k < size.length; k++) if (main < 0 || size[k] > size[main]) main = k
  return { label, size, main }
}

/** The pieces that float off the main body, and their points. */
export interface FloatingSurvey {
  /** Every point of a floating piece, ascending. */
  vertices: Uint32Array
  /** Pieces in the cloud, the main body among them. */
  pieces: number
  /** Floating pieces found. */
  floating: number
  /** Points of the main body. */
  mainPoints: number
  /** The largest piece that stays besides the main body, in points — 0 for none. */
  largestKept: number
}

/**
 * The pieces smaller than `percent` of the main body, by point count: 0 finds
 * none, 100 every piece but the main body. A share of the main body rather
 * than a size across, so one slider reads the same on a coin and on a car
 * door: the junk a scanner leaves is a sliver of what it was pointed at.
 */
export function floatingPieces(pieces: CloudPieces, percent: number): FloatingSurvey {
  const { label, size, main } = pieces
  const pct = Math.min(Math.max(Number.isFinite(percent) ? percent : 0, 0), 100)
  const mainPoints = main >= 0 ? size[main] : 0
  const below = (pct / 100) * mainPoints
  const goes = new Uint8Array(size.length)
  let floating = 0, largestKept = 0
  for (let k = 0; k < size.length; k++) {
    if (k === main) continue
    // At 100 every piece but the main body goes, the ones as big as it too.
    if (size[k] < below || pct >= 100) {
      goes[k] = 1
      floating++
    } else if (size[k] > largestKept) largestKept = size[k]
  }
  let n = 0
  for (let i = 0; i < label.length; i++) if (label[i] >= 0 && goes[label[i]]) n++
  const vertices = new Uint32Array(n)
  n = 0
  for (let i = 0; i < label.length; i++) if (label[i] >= 0 && goes[label[i]]) vertices[n++] = i
  return { vertices, pieces: size.length, floating, mainPoints, largestKept }
}

/** The points on the side of the plane through `origin` that `normal` points to. */
export function pastPlane(positions: Float32Array, count: number, origin: Vec3, normal: Vec3): Uint32Array {
  const len = Math.hypot(normal[0], normal[1], normal[2])
  if (!(len > 0)) throw new Error('The plane needs a direction.')
  const nx = normal[0] / len, ny = normal[1] / len, nz = normal[2] / len
  const d = nx * origin[0] + ny * origin[1] + nz * origin[2]
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    if (nx * positions[3 * i] + ny * positions[3 * i + 1] + nz * positions[3 * i + 2] > d) out.push(i)
  }
  return Uint32Array.from(out)
}

/** The cloud without the points `drop` names: each point's new index in
 *  `map`, -1 for one taken out. */
export function withoutPoints(positions: Float32Array, normals: Float32Array, count: number, drop: Uint32Array) {
  const gone = new Uint8Array(count)
  let dropped = 0
  for (const v of drop) {
    if (v < count && !gone[v]) {
      gone[v] = 1
      dropped++
    }
  }
  const kept = count - dropped
  const outP = new Float32Array(kept * 3)
  const outN = new Float32Array(kept * 3)
  const map = new Int32Array(count).fill(-1)
  let k = 0
  for (let i = 0; i < count; i++) {
    if (gone[i]) continue
    map[i] = k
    outP[3 * k] = positions[3 * i]
    outP[3 * k + 1] = positions[3 * i + 1]
    outP[3 * k + 2] = positions[3 * i + 2]
    outN[3 * k] = normals[3 * i]
    outN[3 * k + 1] = normals[3 * i + 1]
    outN[3 * k + 2] = normals[3 * i + 2]
    k++
  }
  return { positions: outP, normals: outN, map, dropped }
}
