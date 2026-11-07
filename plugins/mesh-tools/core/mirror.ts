// SPDX-License-Identifier: AGPL-3.0-only
// Mirror: the part reflected across a plane. Two ways:
//
// - whole — every point taken to its mirror image, a left-hand part made of a
//   right-hand one. A reflection turns the surface inside out, so every
//   triangle is turned over with it and the part still faces out. Nothing is
//   added or taken: each vertex keeps its number, and whatever is marked on
//   the scan by vertex goes with it.
// - symmetric — one side of the part kept and reflected onto the other, which
//   it replaces: a part scanned well on one side only, or one damaged on one
//   side, made whole and symmetric. The part is clipped to the side kept as
//   Cut clips it (core/cut), and the kept side's mirror image joined to it
//   along the plane. A point on the plane is its own mirror image, so the two
//   halves share the rim the plane cut: a closed part stays closed, with no
//   seam. Faces lying in the plane itself — the cap of a part already cut
//   there — are dropped, since the two halves would put two of them back to
//   back. A part wholly on the kept side, the far side empty, gets its mirror
//   image beside it: joined where it touches the plane, a separate piece
//   where it does not.

import type { Vec3 } from '../../../src/core/types'
import { clip, planeSides } from './cut'
import { compactEdit, type EditedMesh } from './edit'

export type MirrorMode = 'whole' | 'symmetric'

export interface MirrorReport {
  mode: MirrorMode
  /** The triangles the mirror image brought — for whole, every one. */
  mirrored: number
  /** Symmetric: triangles of the side replaced taken off whole, those the
   *  plane cut across, and those lying in the plane dropped. Zero for whole. */
  removed: number
  split: number
  inPlane: number
}

/**
 * The mesh mirrored across the plane through `origin` square to `normal`.
 * For `symmetric`, `normal` points to the side replaced, as a cut's points to
 * the side that goes.
 */
export function mirrorMesh(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  origin: Vec3,
  normal: Vec3,
  mode: MirrorMode,
): EditedMesh & { report: MirrorReport } {
  const len = Math.hypot(normal[0], normal[1], normal[2])
  if (!(len > 0)) throw new Error('The mirror plane has no direction.')
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len]
  return mode === 'whole' ? mirrorWhole(positions, indices, vertexCount, origin, n) : mirrorSymmetric(positions, indices, vertexCount, origin, n)
}

/** `p`'s mirror image across the plane through `o` square to unit `n`, from
 *  `src` at `i` into `dst` at `j`. */
function reflectInto(src: ArrayLike<number>, i: number, dst: Float32Array | number[], j: number, o: Vec3, n: Vec3): void {
  const x = src[i], y = src[i + 1], z = src[i + 2]
  const d2 = 2 * ((x - o[0]) * n[0] + (y - o[1]) * n[1] + (z - o[2]) * n[2])
  dst[j] = x - d2 * n[0]
  dst[j + 1] = y - d2 * n[1]
  dst[j + 2] = z - d2 * n[2]
}

function mirrorWhole(positions: Float32Array, indices: Uint32Array, vertexCount: number, o: Vec3, n: Vec3): EditedMesh & { report: MirrorReport } {
  const out = new Float32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) reflectInto(positions, v * 3, out, v * 3, o, n)
  // Turned over, so the mirror image faces out as the part did.
  const tris = indices.slice()
  for (let t = 0; t < tris.length; t += 3) {
    const b = tris[t + 1]
    tris[t + 1] = tris[t + 2]
    tris[t + 2] = b
  }
  const vertexMap = new Int32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) vertexMap[v] = v
  return {
    positions: out,
    indices: tris,
    vertexMap,
    report: { mode: 'whole', mirrored: tris.length / 3, removed: 0, split: 0, inPlane: 0 },
  }
}

function mirrorSymmetric(positions: Float32Array, indices: Uint32Array, vertexCount: number, o: Vec3, n: Vec3): EditedMesh & { report: MirrorReport } {
  const plane = planeSides(positions, indices, vertexCount, o, n)
  const nothingKept = 'Nothing of the part is on the side to keep — keep the other side.'
  if (!plane.anyStays) throw new Error(nothingKept)
  // The side kept, clipped at the plane: every point of the cut snapped onto
  // it, and marked as on it.
  const { out, all, onPlane, removed, split } = clip(positions, indices, vertexCount, plane, false)

  const kept: number[] = []
  let inPlane = 0
  for (let t = 0; t < out.length; t += 3) {
    const a = out[t], b = out[t + 1], c = out[t + 2]
    if (onPlane[a] && onPlane[b] && onPlane[c]) inPlane++
    else kept.push(a, b, c)
  }
  if (kept.length === 0) throw new Error(nothingKept)

  // Each point's mirror image: itself on the plane, so the halves join there;
  // a new point, numbered on after the clip's, everywhere else.
  const total = all.length / 3
  const twin = new Int32Array(total).fill(-1)
  const extra: number[] = []
  for (const v of kept) {
    if (twin[v] >= 0) continue
    if (onPlane[v]) twin[v] = v
    else {
      twin[v] = total + extra.length / 3
      reflectInto(all, v * 3, extra, extra.length, o, n)
    }
  }

  const tris = new Uint32Array(kept.length * 2)
  tris.set(kept)
  // Turned over, as a reflection turns the surface inside out.
  for (let t = 0, k = kept.length; t < kept.length; t += 3, k += 3) {
    tris[k] = twin[kept[t]]
    tris[k + 1] = twin[kept[t + 2]]
    tris[k + 2] = twin[kept[t + 1]]
  }
  const merged = new Float32Array(all.length + extra.length)
  merged.set(all)
  merged.set(extra, all.length)
  const edited = compactEdit(merged, tris, vertexCount)
  return { ...edited, report: { mode: 'symmetric', mirrored: kept.length / 3, removed, split, inPlane } }
}
