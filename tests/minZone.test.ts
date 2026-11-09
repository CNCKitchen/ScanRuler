// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../src/core/fit/ransac'
import { minimumZone } from '../src/core/fit/minZone'
import { fitPlaneClipped } from '../src/core/fit/plane'
import { fitSphereClipped } from '../src/core/fit/sphere'
import { fitCylinderClipped } from '../src/core/fit/cylinder'
import type { CircleFit, Plane, PlaneFit, Vec3 } from '../src/core/types'
import { circleFromPoints, withCircleZone } from '../src/core/fit/circle'
import { evaluateFlatPicks } from '../src/core/flat/construct'
import { liftFlatFit } from '../src/core/section/lift'
import { scaleFit } from '../src/core/scanScale'
import { evaluateTolerance } from '../src/core/tolerances'

const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i)
/** The point of a plane n·p = d nearest the origin, and its normal. */
const planeShape = (p: Plane) => ({ kind: 'plane' as const, center: [p.nx * p.d, p.ny * p.d, p.nz * p.d] as Vec3, normal: [p.nx, p.ny, p.nz] as Vec3 })

describe('the minimum zone', () => {
  it('is the height of a step on a flat face, where the best fit tilts toward it', () => {
    // A 20 mm square at z = 0 and a strip along one side raised by 0.05:
    // at x = 10 the face holds points at both heights, so no tilt does
    // better than 0.05; the least-squares plane leans toward the strip.
    const pts: number[] = []
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) pts.push(-10 + i * 0.5, -10 + j * 0.5, 0)
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 40; j++) pts.push(6 + i * 0.5, -10 + j * 0.5, 0.05)
    const points = Float32Array.from(pts)
    const fit = fitPlaneClipped(points, all(points.length / 3), 0)!
    expect(fit.span).toBeGreaterThan(0.055)
    const zone = minimumZone(points, planeShape(fit.plane))!
    expect(zone.start).toBeCloseTo(fit.span, 6)
    expect(zone.width).toBeCloseTo(0.05, 5)
  })

  it('finds the narrowest tilt of a noisy face, as a search over every tilt does', () => {
    const rand = mulberry32(17)
    const pts: number[] = []
    for (let k = 0; k < 3000; k++) {
      const x = (rand() - 0.5) * 30
      const y = (rand() - 0.5) * 20
      // A slight twist the best fit cannot follow, and noise.
      pts.push(x, y, 0.002 * x * y / 30 + (rand() - 0.5) * 0.02 + (x > 12 && y > 6 ? 0.03 : 0))
    }
    const points = Float32Array.from(pts)
    const fit = fitPlaneClipped(points, all(points.length / 3), 0)!
    const zone = minimumZone(points, planeShape(fit.plane))!
    // A brute search over z − a·x − b·y for the narrowest range.
    let brute = Infinity
    for (let a = -0.004; a <= 0.004; a += 0.00005) {
      for (let b = -0.004; b <= 0.004; b += 0.00005) {
        let lo = Infinity
        let hi = -Infinity
        for (let i = 0; i < points.length; i += 3) {
          const r = (points[i + 2] - a * points[i] - b * points[i + 1]) / Math.hypot(1, a, b)
          if (r < lo) lo = r
          if (r > hi) hi = r
        }
        brute = Math.min(brute, hi - lo)
      }
    }
    expect(zone.width).toBeLessThan(zone.start)
    expect(zone.width).toBeLessThanOrEqual(brute + 2e-5)
  })

  it('is the depth of a two-layer patch on a sphere, where the best fit moves toward it', () => {
    const rand = mulberry32(5)
    const pts: number[] = []
    const R = 10
    const at = (r: number, th: number, ph: number) =>
      pts.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
    for (let k = 0; k < 4000; k++) at(R, Math.acos(rand()), rand() * 2 * Math.PI)
    // A patch near the pole holding points at R and at R + 0.04.
    for (let k = 0; k < 600; k++) {
      const th = rand() * 0.3
      const ph = rand() * 2 * Math.PI
      at(R + 0.04, th, ph)
      at(R, th, ph)
    }
    const points = Float32Array.from(pts)
    const fit = fitSphereClipped(points, all(points.length / 3), 0)!
    expect(fit.span).toBeGreaterThan(0.0405)
    const s = fit.sphere
    const zone = minimumZone(points, { kind: 'sphere', center: [s.cx, s.cy, s.cz] })!
    expect(zone.width).toBeCloseTo(0.04, 4)
  })

  it('is the depth of a two-layer stripe on a bore, where the best fit moves toward it', () => {
    const rand = mulberry32(9)
    const pts: number[] = []
    const R = 8
    for (let k = 0; k < 4000; k++) {
      const a = rand() * 2 * Math.PI
      pts.push(R * Math.cos(a), R * Math.sin(a), (rand() - 0.5) * 30)
    }
    for (let k = 0; k < 800; k++) {
      const a = (rand() - 0.5) * 0.6
      const z = (rand() - 0.5) * 30
      pts.push((R + 0.03) * Math.cos(a), (R + 0.03) * Math.sin(a), z)
      pts.push(R * Math.cos(a), R * Math.sin(a), z)
    }
    const points = Float32Array.from(pts)
    const fit = fitCylinderClipped(points, all(points.length / 3), { px: 0.01, py: 0, pz: 0, ax: 0, ay: 0.001, az: 1, r: R }, 0)!
    expect(fit.span).toBeGreaterThan(0.0305)
    const c = fit.cylinder
    const zone = minimumZone(points, { kind: 'cylinder', center: [c.px, c.py, c.pz], axis: [c.ax, c.ay, c.az] })!
    expect(zone.width).toBeCloseTo(0.03, 4)
  })

  it('has nothing to say about three points', () => {
    expect(minimumZone(new Float32Array(9), { kind: 'sphere', center: [0, 0, 0] })).toBeNull()
  })

  it('is what a form tolerance reads, with the points; the best fit’s peak to peak without', () => {
    const pts: number[] = []
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) pts.push(-10 + i * 0.5, -10 + j * 0.5, 0)
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 40; j++) pts.push(6 + i * 0.5, -10 + j * 0.5, 0.05)
    const points = Float32Array.from(pts)
    const fit = fitPlaneClipped(points, all(points.length / 3), 0)!
    const shape = planeShape(fit.plane)
    const plane: PlaneFit = {
      kind: 'plane', center: shape.center, normal: shape.normal, basisU: [1, 0, 0], basisV: [0, 1, 0], extentU: 10, extentV: 10,
      sigma: fit.sigma, usedPoints: points.length / 3, regionSize: points.length / 3, formError: fit.span,
    }
    const zoned = evaluateTolerance('form-flatness', [plane], { surfaces: [points] })
    expect(zoned.raw).toBeCloseTo(0.05, 5)
    expect(zoned.detail).toMatch(/^Minimum zone/)
    const bare = evaluateTolerance('form-flatness', [plane])
    expect(bare.raw).toBeCloseTo(fit.span, 9)
    expect(bare.detail).toMatch(/^Peak to peak/)
  })

  it('is a picked circle’s circularity, taken as the circle is fitted', () => {
    // Around R 10 in a tilted plane, and an arc of it twice over, at R and
    // at R + 0.04: no centre does better than 0.04, and the best fit moves
    // toward the doubled arc.
    const n: Vec3 = [0, Math.sin(0.3), Math.cos(0.3)]
    const [u, v] = [[1, 0, 0] as Vec3, [0, Math.cos(0.3), -Math.sin(0.3)] as Vec3]
    const at = (r: number, a: number): Vec3 => [0, 1, 2].map((k) => 5 + r * (Math.cos(a) * u[k] + Math.sin(a) * v[k])) as Vec3
    const picks: Vec3[] = []
    for (let i = 0; i < 24; i++) picks.push(at(10, (i / 24) * 2 * Math.PI))
    for (let i = 0; i < 12; i++) picks.push(at(10.04, -0.4 + (i / 11) * 0.8), at(10, -0.4 + (i / 11) * 0.8))
    const fit = withCircleZone(circleFromPoints(picks), picks)
    expect(fit.normal[1] * n[1] + fit.normal[2] * n[2]).toBeCloseTo(1, 6)
    expect(fit.formError!).toBeGreaterThan(0.0405)
    expect(fit.zoneWidth!).toBeCloseTo(0.04, 5)
    const value = evaluateTolerance('form-circularity', [fit])
    expect(value.raw).toBeCloseTo(0.04, 5)
    expect(value.detail).toMatch(/^Minimum zone · 48 points/)
  })

  it('comes with a circle off a section’s sheet into the part, and scales with it', () => {
    const pts: [number, number][] = []
    for (let i = 0; i < 24; i++) pts.push([10 * Math.cos((i / 24) * 2 * Math.PI), 10 * Math.sin((i / 24) * 2 * Math.PI)])
    for (let i = 0; i < 12; i++) {
      const a = -0.4 + (i / 11) * 0.8
      pts.push([10.04 * Math.cos(a), 10.04 * Math.sin(a)], [10 * Math.cos(a), 10 * Math.sin(a)])
    }
    const flat = evaluateFlatPicks('flat-circle-pick', pts)
    if (flat.kind !== 'circle') throw new Error('not a circle')
    expect(flat.zoneWidth!).toBeCloseTo(0.04, 5)
    const lifted = liftFlatFit({ origin: [0, 0, 3], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }, flat)
    expect(lifted.zoneWidth).toBe(flat.zoneWidth)
    expect(scaleFit(lifted as CircleFit, 25.4).zoneWidth!).toBeCloseTo(flat.zoneWidth! * 25.4, 9)
  })
})
