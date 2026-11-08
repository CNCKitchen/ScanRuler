// SPDX-License-Identifier: AGPL-3.0-only
// The sketch's spline end to end: the curve handed to the kernel as one
// exact B-spline, the regions it bounds, the solver holding it tangent,
// fitting it to slice points and holding a point on it, a chain fitted as
// one, and the solid an extrude of it makes — with the curve in the STEP.

import { describe, expect, it, vi } from 'vitest'
import type { Vec2 } from '../../../src/core/flat/types'
import { Builder } from '../core/build'
import { moveAnchor } from '../core/drag'
import type { Feature, SketchFeature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { findRegions, loopGeometry } from '../core/regions'
import { resolveFeatures } from '../core/resolve'
import { addConstraint, addEntity, anchorPoint, anchorsOf, emptySketch, entityOf, inferRelations, type Sketch, type SketchSpline } from '../core/sketch'
import { bsplineAt, bsplineSamples, nearestOnSpline, splineAt, splineCurve, splineDirAt, splineEnd, splineOvershoots, splineScatter, splineStretch } from '../core/sketchSpline'
import { solveSketch } from '../core/solver'
import { DEFAULT_FIT_OPTIONS } from '../core/fitOptions'
import { fitChain } from '../state/reSketchDraft'
import { XY } from './reKit'

vi.setConfig({ testTimeout: 180_000 })

const kernelPromise = ReKernel.load()

const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The area a closed curve encloses, by the shoelace over fine samples. */
function areaOf(points: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    s += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(s) / 2
}

/** A closed spline through `n` points round a circle of radius `r`, the
 *  first at `from` radians. */
function ring(n: number, r: number, from = 0): Vec2[] {
  return Array.from({ length: n }, (_, i): Vec2 => [r * Math.cos(from + (2 * Math.PI * i) / n), r * Math.sin(from + (2 * Math.PI * i) / n)])
}

const spline = (s: Sketch, id: number) => entityOf(s, id) as SketchSpline

describe('the spline as the kernel takes it', () => {
  const open = splineCurve({ pts: [[0, 0], [10, 8], [25, 6], [32, -4], [45, 2]] })

  it('a stretch is one cubic B-spline with simple knots, on the curve to a nanometre', () => {
    const b = splineStretch(open, 0.3, 3.6)!
    expect(b.mults[0]).toBe(4)
    expect(b.mults[b.mults.length - 1]).toBe(4)
    expect(b.mults.slice(1, -1).every((m) => m === 1)).toBe(true)
    expect(b.poles.length).toBe(b.knots.length + 2)
    expect(near(b.poles[0], splineAt(open, 0.3))).toBeLessThan(1e-12)
    expect(near(b.poles[b.poles.length - 1], splineAt(open, 3.6))).toBeLessThan(1e-12)
    for (const p of bsplineSamples(b, 400)) expect(nearestOnSpline(open, p as Vec2).dist).toBeLessThan(1e-8)
  })

  it('runs the way it is asked: from t1 back to t0', () => {
    const b = splineStretch(open, 3.6, 0.3)!
    expect(near(b.poles[0], splineAt(open, 3.6))).toBeLessThan(1e-12)
    expect(near(bsplineAt(b, b.knots[b.knots.length - 1]) as Vec2, splineAt(open, 0.3))).toBeLessThan(1e-8)
  })

  it('a closed spline’s stretch runs on over its first point', () => {
    const closed = splineCurve({ pts: ring(5, 20), closed: true })
    const b = splineStretch(closed, 4.5, 5.5)!
    expect(b.mults.slice(1, -1).every((m) => m === 1)).toBe(true)
    expect(near(b.poles[b.poles.length - 1], splineAt(closed, 0.5))).toBeLessThan(1e-12)
    for (const p of bsplineSamples(b, 100)) expect(nearestOnSpline(closed, p as Vec2).dist).toBeLessThan(1e-8)
  })
})

describe('regions a spline bounds', () => {
  it('a closed spline is one region, its outline the curve whole', () => {
    const s = emptySketch()
    const id = addEntity(s, { kind: 'spline', pts: ring(6, 20), closed: true })
    const regions = findRegions(s)
    expect(regions).toHaveLength(1)
    const [r] = regions
    expect(r.outer.pieces).toHaveLength(1)
    expect(Math.abs(r.outer.pieces[0].t1 - r.outer.pieces[0].t0)).toBeCloseTo(6, 9)
    const fine = splineCurve(spline(s, id))
    const exact = areaOf(Array.from({ length: 6000 }, (_, i) => splineAt(fine, (6 * i) / 6000)))
    expect(Math.abs(r.area - exact) / exact).toBeLessThan(2e-3)
    const geo = loopGeometry(r.outer, s)
    expect(geo).toHaveLength(1)
    expect(geo[0].kind).toBe('spline')
  })

  it('an open spline closed by a line is one region of the two', () => {
    const s = emptySketch()
    addEntity(s, { kind: 'spline', pts: [[0, 0], [10, 15], [30, 12], [40, 0]] })
    addEntity(s, { kind: 'line', a: [40, 0], b: [0, 0] })
    const regions = findRegions(s)
    expect(regions).toHaveLength(1)
    const geo = loopGeometry(regions[0].outer, s)
    expect(geo.map((g) => g.kind).sort()).toEqual(['line', 'spline'])
    // End to end, exactly: each piece starts where the one before it ends.
    const ends = geo.map((g) => (g.kind === 'line' ? [g.a, g.b] : g.kind === 'spline' ? [g.poles[0], g.poles[g.poles.length - 1]] : [[0, 0], [0, 0]]))
    for (let i = 0; i < ends.length; i++) expect(near(ends[i][1] as Vec2, ends[(i + 1) % ends.length][0] as Vec2)).toBe(0)
  })

  it('a line across a closed spline splits it in two, the half over its seam one stretch', () => {
    const s = emptySketch()
    // The first fit point at 45°, in the upper half the line leaves.
    addEntity(s, { kind: 'spline', pts: ring(8, 20, Math.PI / 4), closed: true })
    addEntity(s, { kind: 'line', a: [-30, 0], b: [30, 0] })
    const regions = findRegions(s)
    expect(regions).toHaveLength(2)
    const whole = emptySketch()
    addEntity(whole, { kind: 'spline', pts: ring(8, 20, Math.PI / 4), closed: true })
    const total = findRegions(whole)[0].area
    expect(regions[0].area + regions[1].area).toBeCloseTo(total, 6)
    for (const r of regions) {
      const curved = r.outer.pieces.filter((p) => p.entity === 1)
      expect(curved).toHaveLength(1)
      expect(loopGeometry(r.outer, s).map((g) => g.kind).sort()).toEqual(['line', 'spline'])
    }
  })

  it('joins where a line’s end lies on it — a T on the curve', () => {
    const s = emptySketch()
    const sp = addEntity(s, { kind: 'spline', pts: [[0, 0], [20, 10], [40, 0]] })
    const fit = splineCurve(spline(s, sp))
    const on = splineAt(fit, 1.3)
    addEntity(s, { kind: 'line', a: [0, 0], b: [40, 0] })
    addEntity(s, { kind: 'line', a: on, b: [on[0], 0] })
    expect(findRegions(s)).toHaveLength(2)
  })
})

describe('the solver and a spline', () => {
  it('holds a spline tangent to a line where an end of it is joined, and lets go when the relation goes', () => {
    const s = emptySketch()
    const line = addEntity(s, { kind: 'line', a: [0, 0], b: [20, 0], fixed: true })
    const sp = addEntity(s, { kind: 'spline', pts: [[20, 0], [30, 8], [45, 10]] })
    addConstraint(s, { kind: 'coincident', p: { entity: line, at: 'b' }, q: { entity: sp, at: 'a' } })
    const tangent = addConstraint(s, { kind: 'tangent', a: line, b: sp })
    const report = solveSketch(s)
    expect(report.ok).toBe(true)
    const e = spline(s, sp)
    expect(e.startDir).toBeDefined()
    const d = splineDirAt(splineCurve(e), 0)
    expect(Math.abs(d[1])).toBeLessThan(1e-6)
    expect(near(e.pts[0], [20, 0])).toBeLessThan(1e-6)
    s.constraints = s.constraints.filter((c) => c.id !== tangent)
    solveSketch(s)
    expect(spline(s, sp).startDir).toBeUndefined()
  })

  it('holds two splines tangent end to end, and a spline to an arc', () => {
    const s = emptySketch()
    const a = addEntity(s, { kind: 'spline', pts: [[0, 0], [10, 6], [20, 0]] })
    const b = addEntity(s, { kind: 'spline', pts: [[20, 0], [30, 5], [40, 2]] })
    addConstraint(s, { kind: 'coincident', p: { entity: a, at: 'b' }, q: { entity: b, at: 'a' } })
    addConstraint(s, { kind: 'tangent', a, b })
    const arc = addEntity(s, { kind: 'arc', c: [40, 12], r: 10, start: -Math.PI / 2, sweep: Math.PI / 2 })
    addConstraint(s, { kind: 'coincident', p: { entity: b, at: 'b' }, q: { entity: arc, at: 'a' } })
    addConstraint(s, { kind: 'tangent', a: b, b: arc })
    expect(solveSketch(s).ok).toBe(true)
    const ea = splineCurve(spline(s, a))
    const eb = splineCurve(spline(s, b))
    const u = splineDirAt(ea, splineEnd(ea))
    const v = splineDirAt(eb, 0)
    expect(Math.abs(u[0] * v[1] - u[1] * v[0])).toBeLessThan(1e-6)
    const arcNow = entityOf(s, arc)
    if (arcNow?.kind !== 'arc') throw new Error('no arc')
    const radial: Vec2 = [Math.cos(arcNow.start), Math.sin(arcNow.start)]
    const w = splineDirAt(eb, splineEnd(eb))
    expect(Math.abs(radial[0] * w[0] + radial[1] * w[1])).toBeLessThan(1e-6)
  })

  it('pulls a fitted spline onto its slice points — closer than the curve through points on them', () => {
    const points: Vec2[] = Array.from({ length: 201 }, (_, i): Vec2 => [i * 0.2, 10 * Math.sin((i * 0.2) / 10)])
    const xs = [0, 40 / 6, 80 / 6, 20, 160 / 6, 200 / 6, 40]
    // Through seven points on the sine itself, the natural ends miss it by
    // some hundredths; the fit, free to move its points, misses it by less.
    const through = splineScatter({ pts: xs.map((x): Vec2 => [x, 10 * Math.sin(x / 10)]), points })
    const s = emptySketch()
    const sp = addEntity(s, { kind: 'spline', pts: xs.map((x): Vec2 => [x, 10 * Math.sin(x / 10) + 0.7]), points, scatter: 0.01 })
    expect(splineScatter(spline(s, sp))).toBeGreaterThan(0.5)
    const report = solveSketch(s)
    expect(report.ok).toBe(true)
    expect(splineScatter(spline(s, sp))).toBeLessThan(through)
    expect(splineScatter(spline(s, sp))).toBeLessThan(0.05)
  })

  it('holds a point on a spline', () => {
    const s = emptySketch()
    const sp = addEntity(s, { kind: 'spline', pts: [[0, 0], [15, 12], [30, 0]], fixed: true })
    // A hair off the curve, as a point snapped onto it is left.
    const on = splineAt(splineCurve(spline(s, sp)), 0.9)
    const pt = addEntity(s, { kind: 'point', p: [on[0], on[1] + 0.01] })
    addConstraint(s, { kind: 'pointOn', p: { entity: pt, at: 'center' }, on: { curve: sp } })
    expect(solveSketch(s).ok).toBe(true)
    const p = entityOf(s, pt)
    if (p?.kind !== 'point') throw new Error('no point')
    expect(nearestOnSpline(splineCurve(spline(s, sp)), p.p).dist).toBeLessThan(1e-5)
  })

  it('a fit point is a point to drag and to join: the curve bends through it', () => {
    const s = emptySketch()
    const sp = addEntity(s, { kind: 'spline', pts: [[0, 0], [10, 5], [20, 0]] })
    expect(anchorsOf(spline(s, sp))).toEqual(['a', 'b', 'p1'])
    const moved = moveAnchor(spline(s, sp), 'p1', [10, 9])
    expect(anchorPoint(moved, 'p1')).toEqual([10, 9])
    const pt = addEntity(s, { kind: 'point', p: [11, 12], fixed: true })
    addConstraint(s, { kind: 'coincident', p: { entity: sp, at: 'p1' }, q: { entity: pt, at: 'center' } })
    expect(solveSketch(s).ok).toBe(true)
    expect(near(spline(s, sp).pts[1], [11, 12])).toBeLessThan(1e-6)
  })

  it('a drawn spline’s ends are joined where they meet another piece', () => {
    const s = emptySketch()
    addEntity(s, { kind: 'line', a: [0, 0], b: [20, 0] })
    addEntity(s, { kind: 'spline', pts: [[20, 0], [10, 10], [0, 0]] })
    inferRelations(s)
    // Its two ends on the line's — not its fit point between.
    const joins = s.constraints.filter((c) => c.kind === 'coincident')
    expect(joins).toHaveLength(2)
    expect(joins.every((c) => c.kind === 'coincident' && [c.p.at, c.q.at].every((at) => at === 'a' || at === 'b'))).toBe(true)
  })
})

describe('a chain fitted as one spline', () => {
  it('lays a closed spline round a closed chain and settles it onto the points', () => {
    // An ellipse 30 by 18, sampled every degree or so.
    const chain: Vec2[] = Array.from({ length: 360 }, (_, i): Vec2 => [30 * Math.cos((2 * Math.PI * i) / 360), 18 * Math.sin((2 * Math.PI * i) / 360)])
    const s = emptySketch()
    const fitted: Record<number, { order: { id: number }[]; closed: boolean }> = {}
    expect(fitChain(s, fitted as never, 0, chain, null, { ...DEFAULT_FIT_OPTIONS, spline: 8 })).toBeNull()
    const e = s.entities[0]
    expect(e.kind).toBe('spline')
    if (e.kind !== 'spline') return
    expect(e.closed).toBe(true)
    expect(e.pts).toHaveLength(8)
    // Closer than the curve through eight points on the ellipse itself.
    const through = splineScatter({ pts: Array.from({ length: 8 }, (_, i): Vec2 => [30 * Math.cos((2 * Math.PI * i) / 8), 18 * Math.sin((2 * Math.PI * i) / 8)]), closed: true, points: chain })
    solveSketch(s)
    expect(splineScatter(spline(s, e.id))).toBeLessThan(through)
    expect(findRegions(s)).toHaveLength(1)
  })
})

describe('a spline in the part', () => {
  const sketchFeature = (id: number, draw: (s: Sketch) => void): SketchFeature => {
    const sketch = emptySketch()
    draw(sketch)
    return { id, kind: 'sketch', name: `Sketch ${id}`, plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch, visible: true }
  }
  const build = async (features: Feature[]) => {
    const k = await kernelPromise
    const builder = new Builder(k)
    const steps = resolveFeatures(features, { sections: [], elements: [], modelCenter: [0, 0, 0] }, (f) => findRegions(f.sketch))
    const sketches = new Map<number, Sketch>(features.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
    return { k, builder, result: builder.build(steps, (id) => sketches.get(id)) }
  }
  const extrude = (id: number, s: SketchFeature, to: number): Feature => ({ id, kind: 'extrude', name: `Extrude ${id}`, sketchId: s.id, regions: findRegions(s.sketch).map((r) => r.key), extent: { kind: 'distance', from: 0, to }, op: 'new', visible: true })

  it('extrudes a closed spline into a solid of its area, one smooth wall round it', async () => {
    const s = sketchFeature(1, (sk) => addEntity(sk, { kind: 'spline', pts: [[0, 0], [25, -5], [40, 10], [30, 28], [8, 22]], closed: true }))
    const { result } = await build([s, extrude(2, s, 10)])
    expect(result.results.map((r) => [r.id, r.status, r.status === 'ok' ? '' : (r as { message?: string }).message])).toEqual([[2, 'ok', '']])
    const fine = splineCurve(s.sketch.entities[0] as SketchSpline)
    const area = areaOf(Array.from({ length: 20000 }, (_, i) => splineAt(fine, (5 * i) / 20000)))
    expect(result.bodies[0].closed).toBe(true)
    // The kernel integrates a face bounded by a B-spline to a few parts in
    // ten thousand; its edge lies on the curve to nanometres.
    expect(Math.abs(result.bodies[0].volume - area * 10) / (area * 10)).toBeLessThan(1e-3)
    expect(result.bodies[0].faces).toBe(3)
  })

  it('extrudes a spline held tangent to the lines it runs between, and writes it into STEP as a B-spline', async () => {
    const s = sketchFeature(1, (sk) => {
      const base = addEntity(sk, { kind: 'line', a: [0, 0], b: [40, 0] })
      const right = addEntity(sk, { kind: 'line', a: [40, 0], b: [40, 15] })
      const left = addEntity(sk, { kind: 'line', a: [0, 15], b: [0, 0] })
      const top = addEntity(sk, { kind: 'spline', pts: [[40, 15], [28, 25], [12, 20], [0, 15]] })
      addConstraint(sk, { kind: 'coincident', p: { entity: base, at: 'b' }, q: { entity: right, at: 'a' } })
      addConstraint(sk, { kind: 'coincident', p: { entity: right, at: 'b' }, q: { entity: top, at: 'a' } })
      addConstraint(sk, { kind: 'coincident', p: { entity: top, at: 'b' }, q: { entity: left, at: 'a' } })
      addConstraint(sk, { kind: 'coincident', p: { entity: left, at: 'b' }, q: { entity: base, at: 'a' } })
      addConstraint(sk, { kind: 'tangent', a: right, b: top })
      addConstraint(sk, { kind: 'tangent', a: left, b: top })
      expect(solveSketch(sk).ok).toBe(true)
    })
    const { result, builder } = await build([s, extrude(2, s, 12)])
    expect(result.results.map((r) => [r.id, r.status, r.status === 'ok' ? '' : (r as { message?: string }).message])).toEqual([[2, 'ok', '']])
    expect(result.bodies[0].closed).toBe(true)
    expect(result.bodies[0].faces).toBe(6)
    const step = builder.exportStep([result.bodies[0].id])
    expect(step).toMatch(/B_SPLINE_CURVE_WITH_KNOTS/)
  })
})

describe('a spline swinging past its points', () => {
  const spline = (pts: Vec2[], more: Partial<SketchSpline> = {}): SketchSpline => ({ id: 1, kind: 'spline', pts, ...more })

  it('says the bulge past a corner table’s last point, held to run straight down there', () => {
    // A phone's corner as a drawing tables it: the edge at u 84.10.
    const corner: Vec2[] = [[66.8, 0], [71.66, -0.06], [76.42, -1], [80.48, -3.63], [83.1, -7.68], [84.08, -12.44], [84.1, -17.31]]
    const held = splineOvershoots(spline(corner, { startDir: 0, endDir: -Math.PI / 2 }))
    expect(held[0]).toMatchObject({ axis: 'u' })
    expect(held[0].mm).toBeGreaterThan(0.01)
    expect(held[0].at[0]).toBeGreaterThan(84.1)
  })

  it('says a dip under a run of points on one line', () => {
    const barrel: Vec2[] = [[0, -1.56], [0, 0], [0, 1.56], [0.26, 3.32], [0.92, 3.92]]
    const found = splineOvershoots(spline(barrel))
    expect(found.find((o) => o.axis === 'u')?.at[0]).toBeLessThan(-0.01)
  })

  it('says nothing over a crest, nor on points that keep the curve within', () => {
    const arch: Vec2[] = [0, 60, 120, 180].map((d) => [10 * Math.cos((d * Math.PI) / 180), 10 * Math.sin((d * Math.PI) / 180)])
    expect(splineOvershoots(spline(arch))).toEqual([])
    expect(splineOvershoots(spline([[0, 0], [1, 1], [2, 2], [3, 3]]))).toEqual([])
  })
})
