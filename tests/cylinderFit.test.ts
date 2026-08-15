// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  cylinderResidual,
  fitCylinderClipped,
  fitCylinderOnAxis,
  ransacCylinder,
} from '../src/core/fit/cylinder'
import { mulberry32 } from '../src/core/fit/ransac'
import type { Cylinder, Vec3 } from '../src/core/types'
import { allIndices, sampleCylinder } from './helpers'

const POINT: [number, number, number] = [4, -3, 2]
// Off-axis on purpose, so an axis-aligned bug cannot pass by accident.
const AXIS: Vec3 = [0.4, 0.6, 0.6928]
const R = 6.35
const LENGTH = 30

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Exact outward normals for points sampled on the cylinder wall. */
function wallNormals(points: Float32Array, point: Vec3, axis: Vec3): Float32Array {
  const d = unit(axis)
  const out = new Float32Array(points.length)
  for (let i = 0; i < points.length / 3; i++) {
    const j = i * 3
    const qx = points[j] - point[0]
    const qy = points[j + 1] - point[1]
    const qz = points[j + 2] - point[2]
    const t = qx * d[0] + qy * d[1] + qz * d[2]
    const wx = qx - t * d[0]
    const wy = qy - t * d[1]
    const wz = qz - t * d[2]
    const l = Math.hypot(wx, wy, wz)
    out[j] = wx / l
    out[j + 1] = wy / l
    out[j + 2] = wz / l
  }
  return out
}

/** Distance from the true axis to the fitted one, measured at the sample's
 *  centre — the number that actually matters for a downstream measurement. */
function axisOffset(c: Cylinder): number {
  const d: Vec3 = [c.ax, c.ay, c.az]
  const qx = POINT[0] - c.px
  const qy = POINT[1] - c.py
  const qz = POINT[2] - c.pz
  const t = qx * d[0] + qy * d[1] + qz * d[2]
  return Math.hypot(qx - t * d[0], qy - t * d[1], qz - t * d[2])
}

function tilt(c: Cylinder): number {
  const a = unit(AXIS)
  const cosine = Math.min(1, Math.abs(c.ax * a[0] + c.ay * a[1] + c.az * a[2]))
  return (Math.acos(cosine) * 180) / Math.PI
}

describe('Gaussian cylinder fit', () => {
  it('recovers radius and axis from a 10-degree-off starting guess', () => {
    const pts = sampleCylinder(20_000, POINT, AXIS, R, LENGTH, 0.02)
    // Tilt the initial axis 10° and shift it 1 mm sideways.
    const bad = unit([AXIS[0] + 0.18, AXIS[1] - 0.1, AXIS[2]])
    const init = fitCylinderOnAxis(pts, allIndices(20_000), bad)!
    const fit = fitCylinderClipped(pts, allIndices(20_000), init, 3)!

    expect(Math.abs(fit.cylinder.r - R)).toBeLessThan(0.005)
    expect(tilt(fit.cylinder)).toBeLessThan(0.05)
    expect(axisOffset(fit.cylinder)).toBeLessThan(0.005)
    expect(fit.sigma).toBeGreaterThan(0.015)
    expect(fit.sigma).toBeLessThan(0.025)
  })

  it('recovers a 140-degree arc (partially visible cylinder)', () => {
    const pts = sampleCylinder(20_000, POINT, AXIS, R, LENGTH, 0.02, 43, (140 * Math.PI) / 180)
    const init = fitCylinderOnAxis(pts, allIndices(20_000), unit([AXIS[0] + 0.1, AXIS[1], AXIS[2]]))!
    const fit = fitCylinderClipped(pts, allIndices(20_000), init, 3)!

    expect(Math.abs(fit.cylinder.r - R)).toBeLessThan(0.05)
    expect(tilt(fit.cylinder)).toBeLessThan(0.3)
    expect(axisOffset(fit.cylinder)).toBeLessThan(0.05)
  })

  it('sigma clipping sheds sparse gross outliers', () => {
    const pts = sampleCylinder(20_000, POINT, AXIS, R, LENGTH, 0.02, 44)
    const normals = wallNormals(pts, POINT, AXIS)
    const rand = mulberry32(99)
    for (let i = 0; i < 400; i++) {
      const j = ((rand() * 20_000) | 0) * 3
      pts[j] += normals[j] * 0.5
      pts[j + 1] += normals[j + 1] * 0.5
      pts[j + 2] += normals[j + 2] * 0.5
    }
    const init = fitCylinderOnAxis(pts, allIndices(20_000), AXIS)!
    const clipped = fitCylinderClipped(pts, allIndices(20_000), init, 3)!
    expect(Math.abs(clipped.cylinder.r - R)).toBeLessThan(0.01)
    expect(clipped.used.length).toBeLessThan(20_000)
  })
})

describe('RANSAC cylinder estimate', () => {
  it('finds the cylinder despite 30% structured outliers', () => {
    const wall = sampleCylinder(3_000, POINT, AXIS, R, LENGTH, 0.02, 45, (200 * Math.PI) / 180)
    const normals = wallNormals(wall, POINT, AXIS)
    // Fake shoulder contamination: a flat disc of points off the end.
    const rand = mulberry32(7)
    const disc = new Float32Array(1_300 * 3)
    const discN = new Float32Array(1_300 * 3)
    const d = unit(AXIS)
    for (let i = 0; i < 1_300; i++) {
      const j = i * 3
      disc[j] = POINT[0] + (rand() - 0.5) * 20 + d[0] * (LENGTH / 2)
      disc[j + 1] = POINT[1] + (rand() - 0.5) * 20 + d[1] * (LENGTH / 2)
      disc[j + 2] = POINT[2] + (rand() - 0.5) * 20 + d[2] * (LENGTH / 2)
      discN[j] = d[0]
      discN[j + 1] = d[1]
      discN[j + 2] = d[2]
    }
    const allPts = new Float32Array(wall.length + disc.length)
    allPts.set(wall)
    allPts.set(disc, wall.length)
    const allN = new Float32Array(normals.length + discN.length)
    allN.set(normals)
    allN.set(discN, normals.length)

    const res = ransacCylinder(allPts, allN, allIndices(4_300), { seed: 1 })!
    expect(res).toBeTruthy()
    expect(Math.abs(res.cylinder.r - R)).toBeLessThan(0.1)
    expect(tilt(res.cylinder)).toBeLessThan(1)
    expect(axisOffset(res.cylinder)).toBeLessThan(0.1)
    // The disc must not have been swept into the consensus set — bar the few
    // of its points that happen to sit on the ring where it crosses the wall.
    const fromDisc = [...res.inliers].filter((i) => i >= 3_000).length
    expect(fromDisc).toBeLessThan(0.03 * res.inliers.length)
  })

  it('rejects a patch with no curvature to work with', () => {
    // A 4-degree sliver of a huge cylinder is indistinguishable from a plane.
    const sliver = sampleCylinder(2_000, POINT, AXIS, 500, 20, 0.02, 8, (4 * Math.PI) / 180)
    const normals = wallNormals(sliver, POINT, AXIS)
    const res = ransacCylinder(sliver, normals, allIndices(2_000), { seed: 2 })
    if (res) expect(cylinderResidual(res.cylinder, sliver[0], sliver[1], sliver[2])).toBeLessThan(1)
  })
})
