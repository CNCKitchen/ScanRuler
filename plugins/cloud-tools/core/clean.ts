// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of cleaning a point cloud up: which points belong together
// (pieces), which of them float off the main body, which lie past a plane,
// and the cloud with a set of points taken out. No DOM, no scene: the worker
// runs it, and the tests run it as it is.

import { PointGrid } from '../../../src/core/geometry/pointGrid'
import { RadiusGrid } from '../../../src/core/geometry/radiusGrid'
import type { Vec3 } from '../../../src/core/types'

/** Points closer than this many point spacings are always one piece. */
export const GAP_SPACINGS = 3

/** The gap also reaches this many times the 99th percentile of the distance
 *  from a point to its nearest neighbour. The spacing is a median, so on a
 *  dense, unevenly sampled scan a gap of three spacings is shorter than the
 *  step between points over the sparse tenth of the surface: the statuette
 *  (5 M points, one connected mesh, median 0.108 mm, p99 3.2 spacings) fell
 *  into 101 k "pieces" and 5.8 % of it was marked as floating. Twice the p99
 *  joins it (0.017 % marked: the mesh's own loose vertices) and lucy (14 M,
 *  0.34 % -> 0.06 %), leaves an evenly sampled RevoMetro pass as it was
 *  (p99 1.4 spacings, so three spacings still rules), and still finds the
 *  real junk around a hand-scanned cylinder head (35 k points at 1 %). */
export const GAP_TAIL = 2

/** The gap never reaches past this many spacings, whatever the tail says:
 *  a cloud with more than a hundredth of its points loose would otherwise
 *  join its own dust. */
export const GAP_MAX_SPACINGS = 10

/** Points whose nearest neighbour is measured for the gap, at most. */
const GAP_SAMPLE = 50_000

/** The gap that joins a cloud's points into pieces: three spacings, or twice
 *  the 99th percentile nearest-neighbour distance (from a sample) where that
 *  is longer, at most GAP_MAX_SPACINGS. */
export function joinGap(positions: Float32Array, count: number, spacing: number): number {
  if (!(spacing > 0)) throw new Error('The cloud\'s point spacing must be more than zero.')
  const p = positions.subarray(0, count * 3)
  const reach = (GAP_MAX_SPACINGS / GAP_TAIL) * spacing
  const grid = new PointGrid(p, GAP_SPACINGS * spacing)
  const step = Math.max(1, Math.floor(count / GAP_SAMPLE))
  const one = new Int32Array(1)
  const dists: number[] = []
  for (let i = 0; i < count; i += step) {
    if (!Number.isFinite(p[3 * i] + p[3 * i + 1] + p[3 * i + 2])) continue
    // Nothing within reach: count it at the reach, so loose points push the
    // tail up only as far as the cap.
    if (grid.kNearest(i, 1, reach, one) === 0) { dists.push(reach); continue }
    const j = one[0]
    dists.push(Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]))
  }
  let tail = 0
  if (dists.length > 0) {
    dists.sort((a, b) => a - b)
    tail = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.99))]
  }
  return Math.min(Math.max(GAP_SPACINGS * spacing, GAP_TAIL * tail), GAP_MAX_SPACINGS * spacing)
}

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
  // Every pair of points within the gap joined once, on cells of the gap
  // taken in space order: a search outward from each point in the order the
  // file gives them reads all over memory on a cloud stored in no order, and
  // a dense grid over a scan's mostly empty box has cells several gaps wide.
  const { label, count: pieces } = new RadiusGrid(positions.subarray(0, count * 3), gap).pieces()
  const size = new Int32Array(pieces)
  for (let i = 0; i < count; i++) if (label[i] >= 0) size[label[i]]++
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
