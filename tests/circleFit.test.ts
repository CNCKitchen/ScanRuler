// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { circleFromPoints } from '../src/core/fit/circle'
import { transformFit } from '../src/core/alignment'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'
import type { Vec3 } from '../src/core/types'
import { mulberry32 } from '../src/core/fit/ransac'
import { fitCircle2d } from '../src/core/fit/circle2d'

/** Points on a circle of the given pose, optionally perturbed. */
function circlePoints(
  center: Vec3,
  normal: Vec3,
  radius: number,
  angles: number[],
  jitter = 0,
  seed = 7,
): Vec3[] {
  const nl = Math.hypot(...normal)
  const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl]
  // Any basis across the normal.
  const pick: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u: Vec3 = [
    pick[1] * n[2] - pick[2] * n[1],
    pick[2] * n[0] - pick[0] * n[2],
    pick[0] * n[1] - pick[1] * n[0],
  ]
  const ul = Math.hypot(...u)
  u[0] /= ul
  u[1] /= ul
  u[2] /= ul
  const v: Vec3 = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ]
  const rand = mulberry32(seed)
  return angles.map((a) => {
    const r = radius + (jitter ? (rand() - 0.5) * 2 * jitter : 0)
    const h = jitter ? (rand() - 0.5) * 2 * jitter : 0
    return [
      center[0] + r * (Math.cos(a) * u[0] + Math.sin(a) * v[0]) + h * n[0],
      center[1] + r * (Math.cos(a) * u[1] + Math.sin(a) * v[1]) + h * n[1],
      center[2] + r * (Math.cos(a) * u[2] + Math.sin(a) * v[2]) + h * n[2],
    ] as Vec3
  })
}

describe('circleFromPoints', () => {
  it('recovers the exact circle through three points', () => {
    const fit = circleFromPoints(
      circlePoints([10, -4, 2], [0, 0, 1], 6.5, [0.3, 1.9, 4.1]),
    )
    expect(fit.radius).toBeCloseTo(6.5, 9)
    expect(fit.center[0]).toBeCloseTo(10, 9)
    expect(fit.center[1]).toBeCloseTo(-4, 9)
    expect(fit.center[2]).toBeCloseTo(2, 9)
    expect(Math.abs(fit.normal[2])).toBeCloseTo(1, 9)
    expect(fit.sigma).toBeLessThan(1e-9)
    expect(fit.usedPoints).toBe(3)
  })

  it('fits a tilted circle from many noisy points', () => {
    const angles = Array.from({ length: 24 }, (_, i) => (i / 24) * 2 * Math.PI)
    const fit = circleFromPoints(
      circlePoints([3, 8, -5], [1, 2, 2], 12, angles, 0.02),
    )
    expect(fit.radius).toBeCloseTo(12, 1)
    expect(fit.center[0]).toBeCloseTo(3, 1)
    expect(fit.center[1]).toBeCloseTo(8, 1)
    expect(fit.center[2]).toBeCloseTo(-5, 1)
    // Same line as [1,2,2]/3, either way round.
    const d = Math.abs(fit.normal[0] * (1 / 3) + fit.normal[1] * (2 / 3) + fit.normal[2] * (2 / 3))
    expect(d).toBeGreaterThan(0.999)
    expect(fit.sigma).toBeLessThan(0.05)
    expect(fit.sigma).toBeGreaterThan(0)
    // Peak-to-peak of a ±0.02 mm radial jitter.
    expect(fit.formError!).toBeGreaterThan(0.01)
    expect(fit.formError!).toBeLessThan(0.09)
  })

  it('works on a partial arc', () => {
    const angles = Array.from({ length: 9 }, (_, i) => 0.2 + (i / 8) * 1.1)
    const fit = circleFromPoints(circlePoints([0, 0, 0], [0, 1, 0], 40, angles, 0.005))
    expect(fit.radius).toBeCloseTo(40, 0)
  })

  it('refuses fewer than three points', () => {
    expect(() => circleFromPoints([[0, 0, 0], [1, 0, 0]])).toThrow(/three points/)
  })

  it('refuses collinear points', () => {
    expect(() =>
      circleFromPoints([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ]),
    ).toThrow(/line/)
  })

  it('refuses coincident points', () => {
    expect(() =>
      circleFromPoints([
        [1, 2, 3],
        [1, 2, 3],
        [1, 2, 3],
      ]),
    ).toThrow()
  })

  it('orients the normal the same way whatever the pick order', () => {
    const pts = circlePoints([0, 0, 0], [0, 0, -1], 5, [0.1, 2.0, 4.4])
    const a = circleFromPoints(pts)
    const b = circleFromPoints([...pts].reverse())
    expect(a.normal[0]).toBeCloseTo(b.normal[0], 12)
    expect(a.normal[1]).toBeCloseTo(b.normal[1], 12)
    expect(a.normal[2]).toBeCloseTo(b.normal[2], 12)
    // The deterministic flip puts it on the +Z side here.
    expect(a.normal[2]).toBeGreaterThan(0)
  })

  it('moves rigidly with transformFit', () => {
    const fit = circleFromPoints(circlePoints([5, 0, 0], [0, 0, 1], 3, [0, 2, 4]))
    const m = rigidFromAxisAngle([0, 1, 0], Math.PI / 2)
    const moved = transformFit(fit, m)
    if (moved.kind !== 'circle') throw new Error('kind changed')
    expect(moved.radius).toBeCloseTo(3, 9)
    // +Z rotates onto +X around Y.
    expect(Math.abs(moved.normal[0])).toBeCloseTo(1, 6)
  })
})

describe('fitCircle2d', () => {
  it('fits a short arc far from the origin, as image-pixel coordinates are', () => {
    // 40 points over 76° of a radius-30 circle centred at (2480, 230): the
    // kind of arc an edge chain on a 600 dpi scan hands over.
    const n = 40
    const pu = new Float64Array(n)
    const pv = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      pu[i] = 2480 + 30 * Math.cos(i / 30)
      pv[i] = 230 + 30 * Math.sin(i / 30)
    }
    const fit = fitCircle2d(pu, pv)
    expect(fit).not.toBeNull()
    expect(fit!.cu).toBeCloseTo(2480, 6)
    expect(fit!.cv).toBeCloseTo(230, 6)
    expect(fit!.r).toBeCloseTo(30, 6)
  })
})

describe('fitCircle2d on a partial arc', () => {
  // The fixed-point refinement stopped after 100 steps, far short of the
  // best circle on a short arc: a 30° arc of R10 read 9.84 (issue 34).
  /** A `deg` arc of R10 about (100, 50), its points alternately `off`
   *  outside and inside the circle. */
  function zigzagArc(deg: number, off: number, n = 400) {
    const u: number[] = []
    const v: number[] = []
    for (let i = 0; i < n; i++) {
      const t = ((deg * Math.PI) / 180) * (i / (n - 1))
      const r = 10 + (i % 2 === 0 ? off : -off)
      u.push(100 + r * Math.cos(t))
      v.push(50 + r * Math.sin(t))
    }
    return { u, v }
  }

  it('reads the radius of a 30° and a 10° arc whose points scatter evenly about it', () => {
    for (const deg of [30, 10]) {
      const { u, v } = zigzagArc(deg, 0.05)
      const c = fitCircle2d(u, v)!
      expect(c.r, `${deg}°`).toBeCloseTo(10, 2)
      expect(Math.hypot(c.cu - 100, c.cv - 50), `${deg}°`).toBeLessThan(0.01)
    }
  })

  it('stops where the sum of squared distances is least', () => {
    const rand = mulberry32(5)
    const u: number[] = []
    const v: number[] = []
    for (let i = 0; i < 300; i++) {
      const t = (Math.PI / 6) * rand()
      const r = 10 + (rand() - 0.5) * 0.2
      u.push(r * Math.cos(t))
      v.push(r * Math.sin(t))
    }
    const c = fitCircle2d(u, v)!
    // The gradient of Σ(dᵢ − r)²: zero at the least.
    let gr = 0, gu = 0, gv = 0
    for (let i = 0; i < u.length; i++) {
      const d = Math.hypot(u[i] - c.cu, v[i] - c.cv)
      const e = d - c.r
      gr += e
      gu += (e * (u[i] - c.cu)) / d
      gv += (e * (v[i] - c.cv)) / d
    }
    expect(Math.hypot(gr, gu, gv)).toBeLessThan(1e-8)
  })
})
