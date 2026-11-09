// SPDX-License-Identifier: AGPL-3.0-only
// Merge: the session's base scan plus extra passes ("layers"), each carrying
// the pose that puts it in the shown frame, written out as one point cloud.
//
// Per point: position' = scale * (toFile o pose)(p), normal' = the rotation
// part of toFile o pose applied to n, renormalised (a rigid map moves a
// normal by its rotation only; a uniform scale does not tilt it).
//
// Scale order: the app applies a file's scale on LOAD, first (meshWorker
// scaleToMm), and the alignment acts on the already-scaled coordinates
// (scanScale.scaleRigid keeps R and multiplies t by s), so shown = A(s * raw).
// This function scales AFTER the rigid map, as specified, so `toFile` must
// carry the shown frame into the frame whose coordinates `scale` multiplies.
// To stay in the already-scaled file frame, pass toFile = A^-1 and scale = 1.
//
// Dedupe (in output units, i.e. after scale): a layer point is dropped when a
// point kept BEFORE this layer (base or earlier layer) is within `dedupe`.
// The index over kept points is built once per layer, so points of one layer
// are never deduped against each other. Base points are never dropped or
// replaced. When the nearest kept point is from an EARLIER LAYER the two
// compete: whichever normal makes the smaller angle with the mean normal of
// the kept points within 2 * dedupe stays (the new point overwrites the kept
// one in place when it wins). A kept point is replaced at most once per layer.
//
// Pure numerics: no DOM, no Three.js.

import { PointKdTree } from '../../../src/core/geometry/pointKdTree'
import { rigidCompose, type Rigid } from '../../../src/core/deviation/rigid'

export interface MergeInput {
  /** The session scan as WorkerContext.scan() holds it: shown frame, one vertex per original. */
  base: { positions: Float32Array; normals: Float32Array }
  layers: { positions: Float32Array; normals: Float32Array; pose: Rigid }[]
  /** Shown frame → base file frame: inverse of the applied alignment. */
  toFile: Rigid
  /** Scale baked into the output (the base's ScanPart scale). */
  scale: number
  dedupe: number | null
}

export interface MergeOutput {
  positions: Float32Array
  normals: Float32Array
  /** base graph vertex → merged index: identity prefix. */
  baseMap: Int32Array
  dropped: number
}

/** Point i of the source, mapped, into slot `slot` of outP/outN. */
function mapInto(
  m: Rigid, scale: number, srcP: Float32Array, srcN: Float32Array, i: number,
  outP: Float32Array, outN: Float32Array, slot: number,
): void {
  const r = m.r, t = m.t
  const x = srcP[3 * i], y = srcP[3 * i + 1], z = srcP[3 * i + 2]
  outP[3 * slot] = (r[0] * x + r[1] * y + r[2] * z + t[0]) * scale
  outP[3 * slot + 1] = (r[3] * x + r[4] * y + r[5] * z + t[1]) * scale
  outP[3 * slot + 2] = (r[6] * x + r[7] * y + r[8] * z + t[2]) * scale
  const nx = srcN[3 * i], ny = srcN[3 * i + 1], nz = srcN[3 * i + 2]
  const a = r[0] * nx + r[1] * ny + r[2] * nz
  const b = r[3] * nx + r[4] * ny + r[5] * nz
  const c = r[6] * nx + r[7] * ny + r[8] * nz
  const len = Math.hypot(a, b, c)
  const k = len > 1e-20 ? 1 / len : 0
  outN[3 * slot] = a * k
  outN[3 * slot + 1] = b * k
  outN[3 * slot + 2] = c * k
}

export function mergeLayers(input: MergeInput): MergeOutput {
  const { base, layers, toFile, scale, dedupe } = input
  const baseCount = base.positions.length / 3
  let cap = baseCount
  for (const l of layers) cap += l.positions.length / 3
  const outP = new Float32Array(cap * 3)
  const outN = new Float32Array(cap * 3)
  const baseMap = new Int32Array(baseCount)

  for (let i = 0; i < baseCount; i++) {
    baseMap[i] = i
    mapInto(toFile, scale, base.positions, base.normals, i, outP, outN, i)
  }
  let kept = baseCount
  let dropped = 0
  const reach = dedupe !== null && dedupe > 0 ? dedupe : 0
  const nearby: number[] = []
  const cp = new Float32Array(3), cn = new Float32Array(3)

  for (const layer of layers) {
    const m = rigidCompose(toFile, layer.pose)
    const count = layer.positions.length / 3
    if (reach === 0 || kept === 0) {
      for (let i = 0; i < count; i++) mapInto(m, scale, layer.positions, layer.normals, i, outP, outN, kept++)
      continue
    }
    // Static over what was kept before this layer.
    const before = kept
    const tree = new PointKdTree(outP.subarray(0, 3 * before))
    const replaced = new Uint8Array(before)
    for (let i = 0; i < count; i++) {
      mapInto(m, scale, layer.positions, layer.normals, i, cp, cn, 0)
      const near = tree.nearest(cp[0], cp[1], cp[2], reach)
      if (near < 0) {
        outP.set(cp, 3 * kept)
        outN.set(cn, 3 * kept)
        kept++
        continue
      }
      dropped++
      if (near < baseCount || replaced[near]) continue
      tree.withinRadius(outP[3 * near], outP[3 * near + 1], outP[3 * near + 2], 2 * reach, nearby)
      let mx = 0, my = 0, mz = 0
      for (const j of nearby) { mx += outN[3 * j]; my += outN[3 * j + 1]; mz += outN[3 * j + 2] }
      if (!(Math.hypot(mx, my, mz) > 1e-12)) continue
      // Same mean for both, so comparing dots compares angles.
      const keptDot = outN[3 * near] * mx + outN[3 * near + 1] * my + outN[3 * near + 2] * mz
      const newDot = cn[0] * mx + cn[1] * my + cn[2] * mz
      if (newDot > keptDot) {
        outP.set(cp, 3 * near)
        outN.set(cn, 3 * near)
        replaced[near] = 1
      }
    }
  }
  return { positions: outP.slice(0, 3 * kept), normals: outN.slice(0, 3 * kept), baseMap, dropped }
}
