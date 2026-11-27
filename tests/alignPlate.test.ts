// SPDX-License-Identifier: AGPL-3.0-only
// A plate out of CAD aligned to the same plate out of CAD. Its two faces are
// most of its surface and seat exactly in a pass or two; the median distance
// was then nothing, the outlier cut closed to its floor, and the rim — all
// that says where the plate lies in its own plane — was cut to the last
// point. The fit stopped up to a millimetre out and reported a residual of
// nothing.
import { describe, expect, it } from 'vitest'
import { autoAlign } from '../src/core/deviation/align'
import { icp, sampleScan } from '../src/core/deviation/icp'
import { rigidApply, rigidCompose, rigidFromAxisAngle, rigidRotate, type Rigid } from '../src/core/deviation/rigid'
import { emptyHit, NominalSurface } from '../src/core/deviation/surface'

const HALF = [30, 45, 3]

/** The plate as a reference: twelve triangles wound outward. */
function plate(): NominalSurface {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = (i >> k) & 1 ? HALF[k] : -HALF[k]
  const faces = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return new NominalSurface(positions, Uint32Array.from(faces))
}

/** The plate as a CAD file opened in a scan's place gives it: points exactly
 *  on every face, each with the face's normal, moved by `pose` — a millimetre
 *  apart, and half that over one corner of the two faces, the way a
 *  tessellation is finer where the part has more to it. The points' middle
 *  is then not the plate's, so the principal axes start the fit off-centre
 *  in the plate's plane with the faces already seated. */
function plateScan(pose: Rigid): { positions: Float32Array; normals: Float32Array } {
  const pts: number[] = []
  const nrm: number[] = []
  for (let k = 0; k < 3; k++) {
    const a = (k + 1) % 3, b = (k + 2) % 3
    for (const side of [-1, 1]) {
      const add = (u: number, v: number) => {
        const p = [0, 0, 0], n = [0, 0, 0]
        p[k] = side * HALF[k]
        p[a] = u
        p[b] = v
        n[k] = side
        pts.push(...p)
        nrm.push(...n)
      }
      for (let u = -HALF[a]; u <= HALF[a]; u++) for (let v = -HALF[b]; v <= HALF[b]; v++) add(u, v)
      if (k === 2) for (let u = 0.5; u < HALF[a]; u += 0.5) for (let v = 0.5; v < HALF[b]; v += 0.5) add(u, v)
    }
  }
  const positions = new Float32Array(pts.length)
  const normals = new Float32Array(nrm.length)
  const out = new Float64Array(3)
  for (let v = 0; v < pts.length; v += 3) {
    rigidApply(pose, pts[v], pts[v + 1], pts[v + 2], out)
    positions.set(out, v)
    rigidRotate(pose, nrm[v], nrm[v + 1], nrm[v + 2], out)
    normals.set(out, v)
  }
  return { positions, normals }
}

/** The furthest any point of the scan lies from the reference under `fit`. */
function worst(surface: NominalSurface, fit: Rigid, scan: Float32Array): number {
  const hit = emptyHit()
  const p = new Float64Array(3)
  let far = 0
  for (let v = 0; v < scan.length; v += 3) {
    rigidApply(fit, scan[v], scan[v + 1], scan[v + 2], p)
    surface.closest(p[0], p[1], p[2], hit)
    far = Math.max(far, hit.distance)
  }
  return far
}

describe('a plate out of CAD on the same plate out of CAD', () => {
  const reference = plate()
  const shift = (x: number, y: number, z: number): Rigid => ({ r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([x, y, z]) })

  it('lands the rim, not only the faces', () => {
    // Lying any way at all: the start comes from the principal axes.
    const scan = plateScan(rigidCompose(shift(40, -25, 12), rigidFromAxisAngle([0.5, 0.3, 0.81], (35 * Math.PI) / 180)))
    const fit = autoAlign(reference, scan.positions, scan.normals)
    // Every point back on the plate — the rim's too, which stood a
    // millimetre and more off while the faces read zero.
    expect(worst(reference, fit.transform, scan.positions)).toBeLessThan(1e-3)
    expect(fit.matched).toBeGreaterThan(0.95 * fit.sampled)
  })

  it('moves a plate that lies in its plane already, slid and turned in it', () => {
    // Two files that share the plate's plane and nothing else: the faces
    // read zero before the first pass.
    const scan = plateScan(rigidCompose(shift(1.2, -0.8, 0), rigidFromAxisAngle([0, 0, 1], (2 * Math.PI) / 180)))
    const samples = sampleScan(scan.positions, scan.normals, 25_000)
    const fit = icp(reference, samples, shift(0, 0, 0), { maxIterations: 70, rejectMedianFactor: 3, minNormalDot: 0.3 })
    expect(fit.converged).toBe(true)
    expect(worst(reference, fit.transform, scan.positions)).toBeLessThan(1e-3)
    expect(fit.matched).toBeGreaterThan(0.95 * fit.sampled)
  })
})
