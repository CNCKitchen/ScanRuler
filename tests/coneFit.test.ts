// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  coneResidual,
  fitConeClipped,
  fitConeOnAxis,
  ransacCone,
} from '../src/core/fit/cone'
import { mulberry32 } from '../src/core/fit/ransac'
import type { Cone, Vec3 } from '../src/core/types'
import { allIndices, sampleCone } from './helpers'

const POINT: [number, number, number] = [4, -3, 2]
// Off-axis on purpose, so an axis-aligned bug cannot pass by accident.
const AXIS: Vec3 = [0.4, 0.6, 0.6928]
const R = 6.35
const PHI = (15 * Math.PI) / 180
const LENGTH = 30

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Exact outward normals for points sampled on the cone wall. */
function wallNormals(points: Float32Array, point: Vec3, axis: Vec3, phi: number): Float32Array {
  const d = unit(axis)
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
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
    out[j] = (cos * wx) / l - sin * d[0]
    out[j + 1] = (cos * wy) / l - sin * d[1]
    out[j + 2] = (cos * wz) / l - sin * d[2]
  }
  return out
}

/** Distance from the true axis to the fitted one, measured at the sample's
 *  centre — the number that actually matters for a downstream measurement. */
function axisOffset(c: Cone): number {
  const d: Vec3 = [c.ax, c.ay, c.az]
  const qx = POINT[0] - c.px
  const qy = POINT[1] - c.py
  const qz = POINT[2] - c.pz
  const t = qx * d[0] + qy * d[1] + qz * d[2]
  return Math.hypot(qx - t * d[0], qy - t * d[1], qz - t * d[2])
}

/** The fitted surface radius at the true anchor's axial position. */
function radiusAt(c: Cone): number {
  const t =
    (POINT[0] - c.px) * c.ax + (POINT[1] - c.py) * c.ay + (POINT[2] - c.pz) * c.az
  return c.r + t * Math.tan(c.phi)
}

function tilt(c: Cone): number {
  const a = unit(AXIS)
  const cosine = Math.min(1, Math.abs(c.ax * a[0] + c.ay * a[1] + c.az * a[2]))
  return (Math.acos(cosine) * 180) / Math.PI
}

describe('Gaussian cone fit', () => {
  it('recovers radius, half-angle and axis from a 10-degree-off starting guess', () => {
    const pts = sampleCone(20_000, POINT, AXIS, R, PHI, LENGTH, 0.02)
    const bad = unit([AXIS[0] + 0.18, AXIS[1] - 0.1, AXIS[2]])
    const init = fitConeOnAxis(pts, allIndices(20_000), bad)!
    const fit = fitConeClipped(pts, allIndices(20_000), init, 3)!

    expect(Math.abs(radiusAt(fit.cone) - R)).toBeLessThan(0.005)
    expect(Math.abs(fit.cone.phi - PHI)).toBeLessThan(0.001)
    expect(tilt(fit.cone)).toBeLessThan(0.05)
    expect(axisOffset(fit.cone)).toBeLessThan(0.005)
    expect(fit.sigma).toBeGreaterThan(0.015)
    expect(fit.sigma).toBeLessThan(0.025)
  })

  it('orients the axis toward the growing radius', () => {
    const pts = sampleCone(10_000, POINT, AXIS, R, PHI, LENGTH, 0.01)
    const init = fitConeOnAxis(pts, allIndices(10_000), unit([-AXIS[0], -AXIS[1], -AXIS[2]]))!
    const fit = fitConeClipped(pts, allIndices(10_000), init, 3)!
    const a = unit(AXIS)
    expect(fit.cone.phi).toBeGreaterThan(0)
    expect(fit.cone.ax * a[0] + fit.cone.ay * a[1] + fit.cone.az * a[2]).toBeGreaterThan(0.999)
  })

  it('recovers a 140-degree arc (partially visible cone)', () => {
    const pts = sampleCone(20_000, POINT, AXIS, R, PHI, LENGTH, 0.02, 43, (140 * Math.PI) / 180)
    const init = fitConeOnAxis(pts, allIndices(20_000), unit([AXIS[0] + 0.1, AXIS[1], AXIS[2]]))!
    const fit = fitConeClipped(pts, allIndices(20_000), init, 3)!

    expect(Math.abs(radiusAt(fit.cone) - R)).toBeLessThan(0.05)
    expect(Math.abs(fit.cone.phi - PHI)).toBeLessThan(0.01)
    expect(tilt(fit.cone)).toBeLessThan(0.3)
    expect(axisOffset(fit.cone)).toBeLessThan(0.05)
  })

  it('degrades to a cylinder: zero taper comes back as zero half-angle', () => {
    // A cone fit on cylinder data must not invent a taper.
    const pts = sampleCone(20_000, POINT, AXIS, R, 0, LENGTH, 0.02, 46)
    const init = fitConeOnAxis(pts, allIndices(20_000), AXIS)!
    const fit = fitConeClipped(pts, allIndices(20_000), init, 3)!
    expect(Math.abs(fit.cone.phi)).toBeLessThan(0.002)
    expect(Math.abs(radiusAt(fit.cone) - R)).toBeLessThan(0.01)
  })

  it('sigma clipping sheds sparse gross outliers', () => {
    const pts = sampleCone(20_000, POINT, AXIS, R, PHI, LENGTH, 0.02, 44)
    const normals = wallNormals(pts, POINT, AXIS, PHI)
    const rand = mulberry32(99)
    for (let i = 0; i < 400; i++) {
      const j = ((rand() * 20_000) | 0) * 3
      pts[j] += normals[j] * 0.5
      pts[j + 1] += normals[j + 1] * 0.5
      pts[j + 2] += normals[j + 2] * 0.5
    }
    const init = fitConeOnAxis(pts, allIndices(20_000), AXIS)!
    const clipped = fitConeClipped(pts, allIndices(20_000), init, 3)!
    expect(Math.abs(radiusAt(clipped.cone) - R)).toBeLessThan(0.01)
    expect(clipped.used.length).toBeLessThan(20_000)
  })
})

describe('RANSAC cone estimate', () => {
  it('finds the cone despite 30% structured outliers', () => {
    const wall = sampleCone(3_000, POINT, AXIS, R, PHI, LENGTH, 0.02, 45, (200 * Math.PI) / 180)
    const normals = wallNormals(wall, POINT, AXIS, PHI)
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

    const res = ransacCone(allPts, allN, allIndices(4_300), { seed: 1 })!
    expect(res).toBeTruthy()
    expect(Math.abs(radiusAt(res.cone) - R)).toBeLessThan(0.1)
    expect(Math.abs(res.cone.phi - PHI)).toBeLessThan(0.02)
    expect(tilt(res.cone)).toBeLessThan(1)
    expect(axisOffset(res.cone)).toBeLessThan(0.1)
    // The disc must not have been swept into the consensus set — bar the few
    // of its points that happen to sit on the ring where it crosses the wall.
    const fromDisc = [...res.inliers].filter((i) => i >= 3_000).length
    expect(fromDisc).toBeLessThan(0.03 * res.inliers.length)
  })

  it('rejects a patch with no curvature to work with', () => {
    // A 4-degree sliver of a huge cone is indistinguishable from a plane.
    const sliver = sampleCone(2_000, POINT, AXIS, 500, PHI, 20, 0.02, 8, (4 * Math.PI) / 180)
    const normals = wallNormals(sliver, POINT, AXIS, PHI)
    const res = ransacCone(sliver, normals, allIndices(2_000), { seed: 2 })
    if (res) expect(coneResidual(res.cone, sliver[0], sliver[1], sliver[2])).toBeLessThan(1)
  })
})
