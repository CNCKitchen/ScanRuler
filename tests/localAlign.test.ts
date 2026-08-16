// SPDX-License-Identifier: AGPL-3.0-only
// The local best fit: the second pass, run on surface the user has marked as
// genuinely being the part. What it has to prove is not that it converges —
// the same ICP does that for the global fit — but that leaving surface out
// changes the answer in the right direction, and that a fit which cannot see
// enough of the part says so instead of producing a plausible pose.

import { describe, expect, it } from 'vitest'
import { alignLocal, MIN_LOCAL_POINTS } from '../src/core/deviation/align'
import { NominalSurface } from '../src/core/deviation/surface'
import {
  identityRigid,
  rigidApply,
  rigidFromAxisAngle,
  rigidInvert,
  type Rigid,
} from '../src/core/deviation/rigid'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { boxMesh } from './helpers'
import type { Vec3 } from '../src/core/types'

const SIZE = 40
const GRID = 16
/** Half a millimetre of developer spray, on the three faces the scanner saw.
 *  Sprayed surface is the case the local fit exists for, and it has to be a
 *  fair share of the part: a thin coat on one face out of six is thrown out by
 *  ICP's own outlier rejection, which is exactly why that case never gets
 *  reported as a problem. What ruins a fit is contamination too widespread to
 *  read as an outlier. */
const PAINT = 0.5

/** The furthest any point of the part ends up from where the other transform
 *  would have put it, in mm. */
function poseError(a: Rigid, b: Rigid, positions: Float32Array): number {
  const pa = new Float64Array(3)
  const pb = new Float64Array(3)
  let worst = 0
  for (let v = 0; v < positions.length; v += 3) {
    rigidApply(a, positions[v], positions[v + 1], positions[v + 2], pa)
    rigidApply(b, positions[v], positions[v + 1], positions[v + 2], pb)
    worst = Math.max(worst, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]))
  }
  return worst
}

function moved(positions: Float32Array, pose: Rigid): Float32Array {
  const out = new Float32Array(positions.length)
  const p = new Float64Array(3)
  for (let v = 0; v < positions.length; v += 3) {
    rigidApply(pose, positions[v], positions[v + 1], positions[v + 2], p)
    out[v] = p[0]
    out[v + 1] = p[1]
    out[v + 2] = p[2]
  }
  return out
}

function rotated(normals: Float32Array, pose: Rigid): Float32Array {
  const out = new Float32Array(normals.length)
  const r = pose.r
  for (let v = 0; v < normals.length; v += 3) {
    const x = normals[v], y = normals[v + 1], z = normals[v + 2]
    out[v] = r[0] * x + r[1] * y + r[2] * z
    out[v + 1] = r[3] * x + r[4] * y + r[5] * z
    out[v + 2] = r[6] * x + r[7] * y + r[8] * z
  }
  return out
}

/** Every vertex of the scan, as the marking would hand them over. */
function allVertices(count: number): Uint32Array {
  return Uint32Array.from({ length: count }, (_, i) => i)
}

const nominalGraph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID) })
const surface = new NominalSurface(nominalGraph.positions, nominalGraph.indices)

// The scan: the same cube, with the +X, +Y and +Z faces standing PAINT proud
// of nominal. Nothing else is wrong with it.
const scanGraph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID) })
const half = SIZE / 2
const clean: number[] = []
const painted: number[] = []
for (let v = 0; v < scanGraph.vertexCount; v++) {
  let coated = false
  for (let axis = 0; axis < 3; axis++) {
    if (scanGraph.positions[v * 3 + axis] > half - 1e-6) {
      scanGraph.positions[v * 3 + axis] += PAINT
      coated = true
    }
  }
  ;(coated ? painted : clean).push(v)
}
const cleanVertices = Uint32Array.from(clean)

describe('local best fit', () => {
  it('recovers the true pose from the unpainted faces, where the whole scan cannot', () => {
    // A small pose error of the sort a global fit leaves behind, and the same
    // starting point for both fits: the identity, which is wrong by exactly
    // that pose.
    const pose = rigidFromAxisAngle([0.3, 1, 0.2] as Vec3, 0.004)
    pose.t[0] = 0.2
    pose.t[1] = -0.15
    pose.t[2] = 0.1
    const positions = moved(scanGraph.positions, pose)
    const normals = rotated(scanGraph.normals, pose)
    const truth = rigidInvert(pose)

    const local = alignLocal(surface, positions, normals, cleanVertices, identityRigid(), {
      maxDistance: 1,
    })
    const whole = alignLocal(
      surface,
      positions,
      normals,
      allVertices(scanGraph.vertexCount),
      identityRigid(),
      { maxDistance: 1 },
    )

    const localError = poseError(local.transform, truth, positions)
    const wholeError = poseError(whole.transform, truth, positions)
    console.log(
      `marked faces: ${localError.toFixed(4)} mm from truth (rms ${local.rms.toFixed(4)}), ` +
        `whole scan: ${wholeError.toFixed(4)} mm (rms ${whole.rms.toFixed(4)})`,
    )

    expect(local.source).toBe('local')
    expect(local.selected).toBe(cleanVertices.length)
    expect(local.underconstrained).toBe(false)
    // The marked faces are the part, so the fit on them is the truth.
    expect(localError).toBeLessThan(0.02)
    // Including the sprayed faces has to cost something: the fit splits the
    // difference between a face half a millimetre out and the one opposite it,
    // which is a quarter of a millimetre on each of the three axes.
    expect(wholeError).toBeGreaterThan(PAINT / 2)
    expect(localError).toBeLessThan(wholeError / 10)
  })

  it('flags a selection that faces one way as under-constrained', () => {
    const fit = (vertices: number[]) =>
      alignLocal(
        surface,
        nominalGraph.positions,
        nominalGraph.normals,
        Uint32Array.from(vertices),
        identityRigid(),
        { maxDistance: 1 },
      )

    // One face of the cube fixes the distance across itself and leaves the
    // part free to slide in the other two directions; add a second face at a
    // right angle to it and there is nothing left to slide along.
    //
    // The face interior, not the face: a vertex on the edge of a cube carries
    // the average of the two normals meeting there, and on a mesh this coarse
    // there are enough of them to look like a second direction. A marked patch
    // of a real scan is interior almost everywhere.
    const onFace = (v: number, axis: number) => {
      const p = nominalGraph.positions
      if (p[v * 3 + axis] <= half - 1e-6) return false
      for (let other = 0; other < 3; other++) {
        if (other !== axis && Math.abs(p[v * 3 + other]) > half - 1e-6) return false
      }
      return true
    }
    const oneFace: number[] = []
    const twoFaces: number[] = []
    for (let v = 0; v < nominalGraph.vertexCount; v++) {
      if (onFace(v, 0)) oneFace.push(v)
      if (onFace(v, 0) || onFace(v, 1)) twoFaces.push(v)
    }
    expect(fit(oneFace).underconstrained).toBe(true)
    expect(fit(twoFaces).underconstrained).toBe(false)
  })

  it('refuses a selection too small to place a part with', () => {
    expect(() =>
      alignLocal(
        surface,
        scanGraph.positions,
        scanGraph.normals,
        cleanVertices.slice(0, MIN_LOCAL_POINTS - 1),
        identityRigid(),
        { maxDistance: 1 },
      ),
    ).toThrow(/at least 50 marked points/i)
  })

  it('refuses rather than snapping when nothing is within the search distance', () => {
    // The marked face lifted clear of the reference by more than the gate: a
    // fit that answered here would have found something that is not the
    // surface it was marked on.
    const away = identityRigid()
    away.t[2] = 3
    const positions = moved(nominalGraph.positions, away)
    const normals = rotated(nominalGraph.normals, away)
    const top: number[] = []
    for (let v = 0; v < nominalGraph.vertexCount; v++) {
      if (nominalGraph.positions[v * 3 + 2] > half - 1e-6) top.push(v)
    }
    const lifted = Uint32Array.from(top)
    expect(() =>
      alignLocal(surface, positions, normals, lifted, identityRigid(), { maxDistance: 1 }),
    ).toThrow(/within 1 mm/i)
    // With room to reach, the same selection fits.
    expect(
      alignLocal(surface, positions, normals, lifted, identityRigid(), { maxDistance: 6 }).matched,
    ).toBeGreaterThan(0)
  })
})
