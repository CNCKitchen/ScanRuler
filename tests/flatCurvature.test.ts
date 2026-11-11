// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  chainCurvature,
  combReach,
  combStrokes,
  curvatureNear,
  curvatureStretches,
  fitCurvature,
  runsDiagonal,
  unshrink,
} from '../src/core/flat/curvature'
import type { EdgeChains } from '../src/core/flat/edges'
import { evalSpline, evalSplineDerivative, evalSplineSecondDerivative, fitSplinePoints } from '../src/core/flat/spline'

/** A seeded Gaussian, so a noisy test is the same every run. */
function noise(seed = 7) {
  let s = seed
  const u = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u())
}

const chainsOf = (...chains: number[][]): EdgeChains => {
  const offsets = [0]
  for (const c of chains) offsets.push(offsets[offsets.length - 1] + c.length / 2)
  return { points: new Float32Array(chains.flat()), offsets: new Uint32Array(offsets) }
}

/** A circle of radius r, counter-clockwise, every `step` mm, its first point
 *  repeated at the end as a section's loop is written. */
function circle(r: number, step: number, cx = 0, cy = 0, sd = 0, clockwise = false): number[] {
  const n = Math.round((2 * Math.PI * r) / step)
  const g = noise()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / n
    out.push(cx + r * Math.cos(a) + sd * g(), cy + r * Math.sin(a) + sd * g())
  }
  out.push(out[0], out[1])
  return out
}

/** A rounded rectangle w × h with corners of radius r, counter-clockwise from
 *  the start of its bottom side, every `step` mm — and the arc length at
 *  which each piece starts. */
function roundedRect(w: number, h: number, r: number, step: number, sd = 0) {
  const g = noise(3)
  const pieces: { len: number; at: (t: number) => [number, number] }[] = []
  const line = (a: [number, number], b: [number, number]) =>
    pieces.push({ len: Math.hypot(b[0] - a[0], b[1] - a[1]), at: (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] })
  const arc = (c: [number, number], a0: number) =>
    pieces.push({ len: (r * Math.PI) / 2, at: (t) => [c[0] + r * Math.cos(a0 + (t * Math.PI) / 2), c[1] + r * Math.sin(a0 + (t * Math.PI) / 2)] })
  const x = w / 2
  const y = h / 2
  line([-x + r, -y], [x - r, -y])
  arc([x - r, -y + r], -Math.PI / 2)
  line([x, -y + r], [x, y - r])
  arc([x - r, y - r], 0)
  line([x - r, y], [-x + r, y])
  arc([-x + r, y - r], Math.PI / 2)
  line([-x, y - r], [-x, -y + r])
  arc([-x + r, -y + r], Math.PI)
  const pts: number[] = []
  const starts: number[] = []
  let s = 0
  for (const p of pieces) {
    starts.push(s)
    s += p.len
    const m = Math.max(1, Math.round(p.len / step))
    for (let i = 0; i < m; i++) {
      const [px, py] = p.at(i / m)
      pts.push(px + sd * g(), py + sd * g())
    }
  }
  pts.push(pts[0], pts[1])
  return { pts, starts }
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

describe('curvature of a chain, smoothed', () => {
  it('reads 1/R round a circle, whatever the window', () => {
    for (const window of [0.5, 2, 6]) {
      const [run] = chainCurvature(chainsOf(circle(5, 0.2)), { window })
      expect(run.closed).toBe(true)
      // Within 1 %: a window as narrow as the chain's own steps reads the
      // corners of the polygon it is.
      for (const k of run.kappa) expect(Math.abs(k - 0.2)).toBeLessThan(0.002)
    }
  })

  it('reads a clockwise circle as turning right, with its teeth still outside', () => {
    const [run] = chainCurvature(chainsOf(circle(5, 0.2, 10, 0, 0, true)), { window: 2 })
    for (const k of run.kappa) expect(k).toBeCloseTo(-0.2, 3)
    const strokes = combStrokes([run], { perCurvature: 10, cap: 100 }, 1)
    for (let i = 0; i < strokes.teeth.length; i += 4) {
      const foot = Math.hypot(strokes.teeth[i] - 10, strokes.teeth[i + 1])
      const tip = Math.hypot(strokes.teeth[i + 2] - 10, strokes.teeth[i + 3])
      expect(tip - foot).toBeCloseTo(2, 2)
    }
  })

  it('reads nothing along a straight line, and leaves a window off each end', () => {
    const line: number[] = []
    for (let x = 0; x <= 50; x += 0.3) line.push(x, 0.5 * x)
    const [run] = chainCurvature(chainsOf(line), { window: 2 })
    expect(run.closed).toBe(false)
    for (const k of run.kappa) expect(Math.abs(k)).toBeLessThan(1e-4)
    const length = Math.hypot(line[line.length - 2], line[line.length - 1])
    expect(run.at[0]).toBeGreaterThanOrEqual(2 - 1e-6)
    expect(run.at[run.at.length - 1]).toBeLessThanOrEqual(length - 2 + 1e-6)
  })

  it('drops a chain too short to read past its ends', () => {
    expect(chainCurvature(chainsOf([0, 0, 1, 0, 2, 0, 3, 0]), { window: 2 })).toEqual([])
  })

  it('puts a fillet between its tangent points: flat, then 1/R, then flat', () => {
    const { pts, starts } = roundedRect(60, 40, 5, 0.25)
    const [run] = chainCurvature(chainsOf(pts), { window: 2 })
    const at = (s: number) => {
      let best = 0
      for (let i = 0; i < run.at.length; i++) if (Math.abs(run.at[i] - s) < Math.abs(run.at[best] - s)) best = i
      return run.kappa[best]
    }
    // Midway along the bottom and round the first corner.
    expect(Math.abs(at(starts[1] / 2))).toBeLessThan(1e-3)
    expect(at((starts[1] + starts[2]) / 2)).toBeCloseTo(0.2, 2)
    // Half the round's curvature is reached at the tangent point, within half
    // a window — the middle of the ramp the smoothing makes of the step.
    let half = NaN
    for (let i = 0; i < run.at.length; i++) {
      if (run.at[i] > starts[1] - 4 && run.kappa[i] > 0.1) {
        half = run.at[i]
        break
      }
    }
    expect(Math.abs(half - starts[1])).toBeLessThan(1)
  })

  it('reads a round under a scan’s scatter within a few percent', () => {
    const { pts, starts } = roundedRect(60, 40, 5, 0.4, 0.03)
    const [run] = chainCurvature(chainsOf(pts), { window: 2 })
    const plateau: number[] = []
    for (let i = 0; i < run.at.length; i++) {
      if (run.at[i] > starts[1] + 2 && run.at[i] < starts[2] - 2) plateau.push(run.kappa[i])
    }
    expect(1 / median(plateau)).toBeGreaterThan(4.8)
    expect(1 / median(plateau)).toBeLessThan(5.2)
  })

  it('reads an image’s chain in millimetres through its scale', () => {
    // A 5 mm circle drawn in pixels at 10 px/mm.
    const px = circle(50, 2)
    const [run] = chainCurvature(chainsOf(px), { window: 2, scale: { x: 0.1, y: 0.1 } })
    for (const k of run.kappa) expect(k).toBeCloseTo(0.2, 3)
    expect(run.points[0]).toBeCloseTo(5, 4)
  })

  it('tells a round from a hollow by the side the material is on', () => {
    // A disc's rim (material inside, outward normals) and a hole's (material
    // outside, normals toward its centre).
    const rim = circle(10, 0.3)
    const hole = circle(3, 0.1, 30, 0)
    const pts = [...rim, ...hole]
    const normals = new Float32Array(pts.length)
    for (let i = 0; i < pts.length / 2; i++) {
      const onHole = i >= rim.length / 2
      const cx = onHole ? 30 : 0
      const dx = pts[i * 2] - cx
      const dy = pts[i * 2 + 1]
      const l = Math.hypot(dx, dy)
      normals[i * 2] = ((onHole ? -1 : 1) * dx) / l
      normals[i * 2 + 1] = ((onHole ? -1 : 1) * dy) / l
    }
    const runs = chainCurvature(chainsOf(rim, hole), { window: 1, normals })
    expect(runs).toHaveLength(2)
    expect([...runs[0].convex!].every((c) => c === 1)).toBe(true)
    expect([...runs[1].convex!].every((c) => c === -1)).toBe(true)
    expect(curvatureNear(runs, [30, 3.05], 0.5)?.convex).toBe(-1)
  })
})

describe('taking the smoothing back', () => {
  it('inverts what a Gaussian does to a circle', () => {
    for (const [r, sigma] of [
      [5, 1],
      [2, 1],
      [10, 3],
    ]) {
      const read = (1 / r) * Math.exp((sigma * sigma) / (2 * r * r))
      expect(unshrink(read, sigma)).toBeCloseTo(1 / r, 9)
      expect(unshrink(-read, sigma)).toBeCloseTo(-1 / r, 9)
    }
    expect(unshrink(0, 1)).toBe(0)
  })
})

describe('curvature of a fitted curve, exact', () => {
  it('reads 1/R on an arc and a circle, nothing on a line', () => {
    const base = { sigma: 0, usedPoints: 0 }
    const runs = fitCurvature(
      [
        { kind: 'line', center: [0, 0], dir: [1, 0], length: 10, ...base },
        { kind: 'arc', center: [0, 0], radius: 4, start: 0, sweep: Math.PI / 2, ...base },
        { kind: 'circle', center: [10, 0], radius: 2, ...base },
      ],
      0.1,
    )
    expect(runs.map((r) => r.source)).toEqual([1, 2])
    expect(runs[0].closed).toBe(false)
    expect(runs[1].closed).toBe(true)
    for (const k of runs[0].kappa) expect(k).toBeCloseTo(0.25, 9)
    for (const k of runs[1].kappa) expect(k).toBeCloseTo(0.5, 9)
    expect(runs[0].at[runs[0].at.length - 1]).toBeCloseTo(2 * Math.PI, 6)
  })

  it('reads a spline’s curvature from its own derivatives', () => {
    const fit = fitSplinePoints(
      [
        [0, 0],
        [10, 6],
        [20, -3],
        [30, 2],
      ],
      [null, null, null, null],
      false,
    )
    // The second derivative against a finite difference of the first.
    for (const u of [0.1, 0.5, 0.9]) {
      const e = 1e-5
      const a = evalSplineDerivative(fit, 1, u - e)
      const b = evalSplineDerivative(fit, 1, u + e)
      const d2 = evalSplineSecondDerivative(fit, 1, u)
      expect(d2[0]).toBeCloseTo((b[0] - a[0]) / (2 * e), 4)
      expect(d2[1]).toBeCloseTo((b[1] - a[1]) / (2 * e), 4)
    }
    const [run] = fitCurvature([fit], 0.01)
    expect(run.exact).toBe(true)
    // Against the turning of the tangent along the curve.
    const i = Math.floor(run.kappa.length / 3)
    const p = evalSpline(fit, 0, 0)
    expect(run.points[0]).toBeCloseTo(p[0], 6)
    const t0 = Math.atan2(-run.normals[i * 2], run.normals[i * 2 + 1])
    const t1 = Math.atan2(-run.normals[i * 2 + 2], run.normals[i * 2 + 3])
    const ds = run.at[i + 1] - run.at[i]
    expect((t1 - t0) / ds).toBeCloseTo((run.kappa[i] + run.kappa[i + 1]) / 2, 4)
    // It bends both ways.
    expect(Math.max(...run.kappa)).toBeGreaterThan(0)
    expect(Math.min(...run.kappa)).toBeLessThan(0)
  })
})

describe('the comb', () => {
  it('draws a tooth every spacing, on the side away from the centre', () => {
    const [run] = fitCurvature([{ kind: 'circle', center: [0, 0], radius: 10, sigma: 0, usedPoints: 0 }], 0.1)
    const reach = { perCurvature: 20, cap: 100 }
    const { teeth, capped, envelopes } = combStrokes([run], reach, 2)
    expect(capped.length).toBe(0)
    expect(teeth.length / 4).toBeCloseTo((2 * Math.PI * 10) / 2, -1)
    for (let i = 0; i < teeth.length; i += 4) {
      expect(Math.hypot(teeth[i + 2], teeth[i + 3])).toBeCloseTo(12, 4)
    }
    expect(envelopes).toHaveLength(1)
    const env = envelopes[0]
    expect(env[0]).toBe(env[env.length - 2])
  })

  it('cuts a corner’s spike short at the cap', () => {
    const [run] = fitCurvature([{ kind: 'arc', center: [0, 0], radius: 0.1, start: 0, sweep: 1, sigma: 0, usedPoints: 0 }], 0.01)
    const { teeth, capped } = combStrokes([run], { perCurvature: 1, cap: 3 }, 0.02)
    expect(teeth.length).toBe(0)
    expect(capped.length).toBeGreaterThan(0)
    for (let i = 0; i < capped.length; i += 4) {
      expect(Math.hypot(capped[i + 2] - capped[i], capped[i + 3] - capped[i + 1])).toBeCloseTo(3, 4)
    }
  })

  it('sizes the teeth to the rounds, not to how long the section is', () => {
    // R 5 rounds: their teeth reach 0.6 of the radius, 3 mm, on a short
    // sheet and on a long one alike.
    for (const w of [60, 600]) {
      const { pts } = roundedRect(w, 40, 5, 0.25)
      const runs = chainCurvature(chainsOf(pts), { window: 2 })
      const d = runsDiagonal(runs)
      expect(d).toBeCloseTo(Math.hypot(w, 40), 0)
      const reach = combReach(runs, d)
      expect(0.2 * reach.perCurvature).toBeCloseTo(3, 0)
      expect(reach.cap / 2.5).toBeCloseTo(3, 0)
      expect(combReach(runs, d, 2).perCurvature).toBeCloseTo(2 * reach.perCurvature, 9)
    }
    // A sheet of gentle bends only: a bend a quarter of the sheet across
    // reaches 5 % of it.
    const [run] = fitCurvature([{ kind: 'arc', center: [0, 0], radius: 50, start: 0, sweep: 0.5, sigma: 0, usedPoints: 0 }], 0.1)
    const d = runsDiagonal([run])
    expect((combReach([run], d).perCurvature * 4) / d).toBeCloseTo(0.05 * d, 6)
  })

  it('fills between the curve and the tips', () => {
    const [run] = fitCurvature([{ kind: 'circle', center: [0, 0], radius: 10, sigma: 0, usedPoints: 0 }], 0.1)
    const { fill } = combStrokes([run], { perCurvature: 20, cap: 100 }, 2)
    expect(fill.length % 6).toBe(0)
    let area = 0
    for (let i = 0; i < fill.length; i += 6) {
      area += Math.abs((fill[i + 2] - fill[i]) * (fill[i + 5] - fill[i + 1]) - (fill[i + 4] - fill[i]) * (fill[i + 3] - fill[i + 1])) / 2
    }
    // The ring from R 10 to R 12.
    expect(area / (Math.PI * (144 - 100))).toBeCloseTo(1, 2)
  })

  it('splits the fill on the curve where it turns the other way', () => {
    // A run along x that bends one way, then the other, from x = 1.5 on.
    const run = {
      points: new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]),
      normals: new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]),
      kappa: new Float32Array([1, 1, -1, -1]),
      at: new Float32Array([0, 1, 2, 3]),
      closed: false,
      exact: true,
      source: 0,
    }
    const { fill } = combStrokes([run], { perCurvature: 1, cap: 10 }, 0.1)
    expect(fill.length / 6).toBe(6)
    // No triangle reaches across the curve, and the two halves meet on it.
    for (let i = 0; i < fill.length; i += 6) {
      const ys = [fill[i + 1], fill[i + 3], fill[i + 5]]
      expect(Math.min(...ys) < -1e-9 && Math.max(...ys) > 1e-9).toBe(false)
    }
    const onCurveAt = [...Array(fill.length / 2).keys()].filter((k) => fill[k * 2 + 1] === 0).map((k) => fill[k * 2])
    expect(onCurveAt).toContain(1.5)
  })
})

describe('the comb in words', () => {
  it('tells a rounded rectangle side by side and round by round', () => {
    const { pts, starts } = roundedRect(60, 40, 5, 0.4, 0.03)
    const [run] = chainCurvature(chainsOf(pts), { window: 2 })
    const stretches = curvatureStretches(run, { minLength: 2 })
    const arcs = stretches.filter((s) => s.kind === 'arc')
    const straights = stretches.filter((s) => s.kind === 'straight')
    expect(arcs).toHaveLength(4)
    expect(straights.length).toBeGreaterThanOrEqual(4)
    for (const a of arcs) {
      expect(a.radius!).toBeGreaterThan(4.6)
      expect(a.radius!).toBeLessThan(5.4)
    }
    // The first round sits about its tangent points.
    expect(arcs[0].from).toBeGreaterThan(starts[1] - 1)
    expect(arcs[0].to).toBeLessThan(starts[2] + 1)
    // The bottom side, straight nearly all the way.
    expect(straights[0].to - straights[0].from).toBeGreaterThan(starts[1] - 4)
  })

  it('reads a radius off the comb where it is pointed at', () => {
    const [run] = fitCurvature([{ kind: 'circle', center: [0, 0], radius: 8, sigma: 0, usedPoints: 0 }], 0.1)
    const r = curvatureNear([run], [0, 8.3], 0.5)
    expect(r?.radius).toBeCloseTo(8, 6)
    expect(r?.exact).toBe(true)
    expect(curvatureNear([run], [0, 20], 0.5)).toBeNull()
  })
})
