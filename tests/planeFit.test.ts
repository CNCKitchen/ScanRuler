// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { fitPlaneClipped, fitPlaneTLS, planeResidual, ransacPlane } from '../src/core/fit/plane'
import { mulberry32 } from '../src/core/fit/ransac'
import { allIndices, samplePlane } from './helpers'

const POINT: [number, number, number] = [3, -2, 7]
// Deliberately off-axis, so an axis-aligned bug cannot pass by accident.
const NORMAL: [number, number, number] = [0.3, -0.5, 0.81]
const unitNormal = (): [number, number, number] => {
  const l = Math.hypot(...NORMAL)
  return [NORMAL[0] / l, NORMAL[1] / l, NORMAL[2] / l]
}

describe('Gaussian plane fit', () => {
  it('recovers a noisy plane to micron level', () => {
    const pts = samplePlane(20_000, POINT, NORMAL, 40, 0.02)
    const fit = fitPlaneClipped(pts, allIndices(20_000), 3)!
    expect(fit).toBeTruthy()

    const [nx, ny, nz] = unitNormal()
    const align = Math.abs(fit.plane.nx * nx + fit.plane.ny * ny + fit.plane.nz * nz)
    expect(1 - align).toBeLessThan(1e-6)
    expect(Math.abs(planeResidual(fit.plane, ...POINT))).toBeLessThan(0.002)
    expect(fit.sigma).toBeGreaterThan(0.015)
    expect(fit.sigma).toBeLessThan(0.025)
  })

  it('refuses a collinear point set', () => {
    const pts = new Float32Array(30 * 3)
    for (let i = 0; i < 30; i++) {
      pts[i * 3] = i * 0.5
      pts[i * 3 + 1] = i * 0.25
      pts[i * 3 + 2] = -i * 0.1
    }
    expect(fitPlaneTLS(pts, allIndices(30))).toBeNull()
  })

  it('sigma clipping sheds sparse gross outliers', () => {
    const pts = samplePlane(20_000, POINT, NORMAL, 40, 0.02, 44)
    const [nx, ny, nz] = unitNormal()
    // Lift 2% of the points 0.5 mm off the surface — dust / spikes.
    const rand = mulberry32(99)
    for (let i = 0; i < 400; i++) {
      const j = ((rand() * 20_000) | 0) * 3
      pts[j] += nx * 0.5
      pts[j + 1] += ny * 0.5
      pts[j + 2] += nz * 0.5
    }
    const all = fitPlaneClipped(pts, allIndices(20_000), 0)!
    const clipped = fitPlaneClipped(pts, allIndices(20_000), 3)!
    expect(clipped.used.length).toBeLessThan(20_000)
    expect(clipped.sigma).toBeLessThan(all.sigma / 3)
    expect(Math.abs(planeResidual(clipped.plane, ...POINT))).toBeLessThan(0.005)
  })
})

describe('RANSAC plane estimate', () => {
  it('locks onto the clicked face when the patch straddles an edge', () => {
    // 3,000 points on the wanted face, 2,000 on a perpendicular neighbour —
    // a plain least-squares plane would tilt into the corner between them.
    const face = samplePlane(3_000, [0, 0, 0], [0, 0, 1], 20, 0.02, 45)
    const side = samplePlane(2_000, [10, 0, 5], [1, 0, 0], 10, 0.02, 46)
    const all = new Float32Array(face.length + side.length)
    all.set(face)
    all.set(side, face.length)

    const res = ransacPlane(all, allIndices(5_000), { seed: 3 })!
    expect(res).toBeTruthy()
    expect(Math.abs(res.plane.nz)).toBeGreaterThan(0.9999)
    expect(Math.abs(res.plane.d)).toBeLessThan(0.005)
    expect(res.sigma).toBeLessThan(0.05)
  })
})
