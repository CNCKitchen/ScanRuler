// SPDX-License-Identifier: AGPL-3.0-only
// An open scan wound inside-out still aligns: every pair failed the facing
// test, and the fit reported "Aligned" over 0 points (issue 34).
import { describe, expect, it } from 'vitest'
import { autoAlign } from '../src/core/deviation/align'
import { rigidApply, rigidCompose, rigidFromAxisAngle, type Rigid } from '../src/core/deviation/rigid'
import { NominalSurface } from '../src/core/deviation/surface'

/** A closed box from `min` to `max`, twelve triangles wound outward. */
function box(min: number[], max: number[]): NominalSurface {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0]
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1]
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2]
  }
  const faces = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return new NominalSurface(positions, Uint32Array.from(faces))
}

/** Points on the top, the front and the right side of the box, with normals
 *  `sign` × outward, moved by `pose`. */
function openScan(sign: 1 | -1, pose: Rigid): { positions: Float32Array; normals: Float32Array } {
  const pts: number[] = []
  const nrm: number[] = []
  const add = (p: number[], n: number[]) => {
    pts.push(...p)
    nrm.push(...n.map((v) => v * sign))
  }
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 20; j++) {
      add([-20 + i, -10 + j, 5], [0, 0, 1])
      if (j <= 10) add([-20 + i, -10, -5 + j], [0, -1, 0])
    }
  }
  for (let j = 0; j <= 20; j++) for (let k = 0; k <= 10; k++) add([20, -10 + j, -5 + k], [1, 0, 0])
  const positions = new Float32Array(pts.length)
  const normals = new Float32Array(nrm.length)
  const p = new Float64Array(3)
  for (let v = 0; v < pts.length; v += 3) {
    rigidApply(pose, pts[v], pts[v + 1], pts[v + 2], p)
    positions.set(p, v)
    // Rotation only, for the normal.
    const o = new Float64Array(3)
    rigidApply(pose, 0, 0, 0, o)
    rigidApply(pose, nrm[v], nrm[v + 1], nrm[v + 2], p)
    normals.set([p[0] - o[0], p[1] - o[1], p[2] - o[2]], v)
  }
  return { positions, normals }
}

describe('aligning an inside-out open scan', () => {
  const reference = box([-20, -10, -5], [20, 10, 5])
  // Turned 3° about a slanted axis and moved 0.8 mm: the identity start is close.
  const turn = rigidFromAxisAngle([0.3, 0.5, 0.81], (3 * Math.PI) / 180)
  const pose: Rigid = rigidCompose({ r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([0.5, -0.4, 0.5]) }, turn)

  const residual = (fit: Rigid, scan: Float32Array): number => {
    // The fit carries the scan onto the box: each point back on its face,
    // on average (a point on an edge can settle on either face).
    let sum = 0
    const p = new Float64Array(3)
    for (let v = 0; v < scan.length; v += 3) {
      rigidApply(fit, scan[v], scan[v + 1], scan[v + 2], p)
      const d = Math.min(Math.abs(Math.abs(p[0]) - 20), Math.abs(Math.abs(p[1]) - 10), Math.abs(Math.abs(p[2]) - 5))
      sum += d
    }
    return sum / (scan.length / 3)
  }

  it('matches points and lands the scan on the part, wound either way', () => {
    for (const sign of [1, -1] as const) {
      const scan = openScan(sign, pose)
      const r = autoAlign(reference, scan.positions, scan.normals)
      expect(r.matched).toBeGreaterThan(r.sampled / 2)
      // From about 1 mm out to a few hundredths.
      expect(residual(r.transform, scan.positions)).toBeLessThan(0.05)
    }
  })
})
