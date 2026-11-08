// SPDX-License-Identifier: AGPL-3.0-only
// The sketch's shapes past lines and rectangles: the Equal relation, the
// regular polygon on its construction circle, the pattern that repeats
// pieces with the relations they hold among themselves, and the relations
// a sketch handed in as coordinates is given where its ends meet.

import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../../src/core/flat/types'
import { datumTraces } from '../core/datums'
import { findRegions } from '../core/regions'
import {
  addConstraint,
  addEntity,
  addPolygon,
  addRectangle,
  anchorPoint,
  emptySketch,
  entityOf,
  inferRelations,
  lineLength,
  patternPieces,
  polygonCorners,
  relationTakes,
  type Sketch,
  type SketchCircle,
  type SketchLine,
} from '../core/sketch'
import { solveSketch } from '../core/solver'

const line = (s: Sketch, id: number) => entityOf(s, id) as SketchLine
const near = (a: Vec2, b: Vec2, digits = 6) => {
  expect(a[0]).toBeCloseTo(b[0], digits)
  expect(a[1]).toBeCloseTo(b[1], digits)
}
const traces = datumTraces({ origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })

describe('the Equal relation', () => {
  it('takes two lines, or two round pieces, and nothing mixed', () => {
    const s = emptySketch()
    const l1 = addEntity(s, { kind: 'line', a: [0, 0], b: [10, 0] })
    const l2 = addEntity(s, { kind: 'line', a: [0, 5], b: [4, 5] })
    const c = addEntity(s, { kind: 'circle', c: [20, 0], r: 3 })
    const a = addEntity(s, { kind: 'arc', c: [30, 0], r: 2, start: 0, sweep: 1 })
    const e = (id: number) => entityOf(s, id)!
    expect(relationTakes('equal', [e(l1), e(l2)])).toBe(true)
    expect(relationTakes('equal', [e(c), e(a)])).toBe(true)
    expect(relationTakes('equal', [e(l1), e(c)])).toBe(false)
  })

  it('makes two lines one length, and two circles one radius, a dimension on one driving both', () => {
    const s = emptySketch()
    const l1 = addEntity(s, { kind: 'line', a: [0, 0], b: [10, 0] })
    const l2 = addEntity(s, { kind: 'line', a: [0, 5], b: [4, 5] })
    const c1 = addEntity(s, { kind: 'circle', c: [20, 0], r: 3 })
    const c2 = addEntity(s, { kind: 'circle', c: [30, 0], r: 1 })
    addConstraint(s, { kind: 'equal', a: l1, b: l2 })
    addConstraint(s, { kind: 'equal', a: c1, b: c2 })
    addConstraint(s, { kind: 'length', entity: l1, value: 12 })
    addConstraint(s, { kind: 'radius', entity: c2, value: 2.5 })
    expect(solveSketch(s).ok).toBe(true)
    expect(lineLength(line(s, l2))).toBeCloseTo(12, 5)
    expect((entityOf(s, c1) as SketchCircle).r).toBeCloseTo(2.5, 5)
  })
})

describe('the regular polygon', () => {
  it('puts an inscribed one’s corners on the circle through the corner clicked', () => {
    const corners = polygonCorners([0, 0], [10, 0], 6, 'inscribed')!
    expect(corners).toHaveLength(6)
    near(corners[0], [10, 0])
    for (const c of corners) expect(Math.hypot(c[0], c[1])).toBeCloseTo(10, 9)
  })

  it('sizes a circumscribed one across its flats: the click is the middle of a side', () => {
    const corners = polygonCorners([0, 0], [6.5, 0], 6, 'circumscribed')!
    // A hex 13 across flats: the side clicked runs upright through x = 6.5.
    const right = corners.filter((c) => Math.abs(c[0] - 6.5) < 1e-9)
    expect(right).toHaveLength(2)
    expect(Math.hypot(corners[0][0], corners[0][1])).toBeCloseTo(6.5 / Math.cos(Math.PI / 6), 9)
  })

  it('refuses under three sides or with no size', () => {
    expect(polygonCorners([0, 0], [1, 0], 2, 'inscribed')).toBeNull()
    expect(polygonCorners([0, 0], [0, 0], 6, 'inscribed')).toBeNull()
  })

  it('stays regular as its circle is dimensioned, and closes one region', () => {
    for (const fit of ['inscribed', 'circumscribed'] as const) {
      const s = emptySketch()
      const made = addPolygon(s, [3, 4], [9, 4], 6, fit)!
      addConstraint(s, { kind: 'radius', entity: made.circle, value: 8 })
      const report = solveSketch(s)
      expect(report.ok).toBe(true)
      const sides = made.lines.map((id) => lineLength(line(s, id)))
      const want = fit === 'inscribed' ? 8 : (2 * 8) / Math.sqrt(3)
      for (const l of sides) expect(l).toBeCloseTo(want, 4)
      expect(findRegions(s)).toHaveLength(1)
    }
  })

  it('is fully defined once its centre, its circle and one side’s turn are — and holds nothing twice', () => {
    for (const fit of ['inscribed', 'circumscribed'] as const) {
      for (const sides of [3, 5, 6, 8]) {
        const s = emptySketch()
        const { lines, circle } = addPolygon(s, [0, 0], [5, 0], sides, fit)!
        addConstraint(s, { kind: 'pointOn', p: { entity: circle, at: 'center' }, on: { datum: 'yz' } })
        addConstraint(s, { kind: 'pointOn', p: { entity: circle, at: 'center' }, on: { datum: 'zx' } })
        addConstraint(s, { kind: 'radius', entity: circle, value: 5 })
        const loose = solveSketch(s, { datums: traces })
        expect(loose.ok).toBe(true)
        expect(loose.redundant).toBe(0)
        // The turn is all that is left: a corner on the X axis pins it.
        expect(loose.underConstrained.length).toBeGreaterThan(0)
        addConstraint(s, { kind: 'pointOn', p: { entity: lines[0], at: 'a' }, on: { datum: 'zx' } })
        const pinned = solveSketch(s, { datums: traces })
        expect(pinned.ok, `${fit} ${sides}`).toBe(true)
        expect(pinned.redundant, `${fit} ${sides}`).toBe(0)
        expect(pinned.underConstrained, `${fit} ${sides}`).toEqual([])
      }
    }
  })
})

describe('the sketch pattern', () => {
  it('lays a grid of copies, each with the relations and dimensions of the original', () => {
    const s = emptySketch()
    const rect = addRectangle(s, [0, 0], [4, 2])
    const dim = addConstraint(s, { kind: 'length', entity: rect[0], value: 4, expr: 'w' })
    const copies = patternPieces(s, rect, { kind: 'rectangular', step: [10, 0], count: 3, step2: [0, 5], count2: 2 })
    expect(copies).toHaveLength(5)
    expect(s.entities).toHaveLength(24)
    // Each copy is a rectangle: four corners, four axis relations, its
    // length dimension reading the same expression.
    for (const ids of copies) {
      const own = s.constraints.filter((c) => (c.kind === 'coincident' ? ids.includes(c.p.entity) : 'entity' in c && ids.includes(c.entity)))
      expect(own.filter((c) => c.kind === 'coincident')).toHaveLength(4)
      expect(own.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical')).toHaveLength(4)
      const length = own.find((c) => c.kind === 'length')
      expect(length && 'expr' in length && length.expr).toBe('w')
      expect(length?.id).not.toBe(dim)
    }
    near(line(s, copies[1][0]).a, [20, 0])
    near(line(s, copies[4][0]).a, [20, 5])
    expect(findRegions(s)).toHaveLength(6)
    expect(solveSketch(s).ok).toBe(true)
  })

  it('turns copies round a centre, spreading a full turn evenly', () => {
    const s = emptySketch()
    const hole = addEntity(s, { kind: 'circle', c: [10, 0], r: 1.5 })
    const copies = patternPieces(s, [hole], { kind: 'circular', centre: [0, 0], count: 4, angleDeg: 360 })
    expect(copies).toHaveLength(3)
    near((entityOf(s, copies[0][0]) as SketchCircle).c, [0, 10])
    near((entityOf(s, copies[1][0]) as SketchCircle).c, [-10, 0])
    // An open span puts the last copy at its end.
    const t = emptySketch()
    const p = addEntity(t, { kind: 'point', p: [5, 0] })
    const open = patternPieces(t, [p], { kind: 'circular', centre: [0, 0], count: 3, angleDeg: 90 })
    near(anchorPoint(entityOf(t, open[1][0])!, 'center'), [0, 5])
  })

  it('turns a rectangle round a centre and keeps it a rectangle, square to itself', () => {
    // The copies took the original's horizontal and vertical relations, so
    // a copy turned 120° was pulled level by the solve or conflicted
    // (issue 34). A turn of a quarter swaps them; any other turn holds the
    // copy's sides parallel and square to each other instead.
    const s = emptySketch()
    const rect = addRectangle(s, [20, 0], [30, 4])
    const copies = patternPieces(s, rect, { kind: 'circular', centre: [0, 0], count: 4, angleDeg: 360 })
    const turned = patternPieces(s, rect, { kind: 'circular', centre: [0, 0], count: 3, angleDeg: 360 })
    const before = turned.map((ids) => ids.map((id) => [...line(s, id).a] as Vec2))
    const report = solveSketch(s)
    expect(report.ok).toBe(true)
    expect(report.redundant).toBe(0)
    // Nothing moved: each copy where the pattern put it.
    turned.forEach((ids, k) => ids.forEach((id, i) => near(line(s, id).a, before[k][i])))
    near(line(s, turned[0][0]).a, [20 * Math.cos((2 * Math.PI) / 3), 20 * Math.sin((2 * Math.PI) / 3)])
    for (const ids of turned) {
      const own = s.constraints.filter((c) => ('entity' in c && ids.includes(c.entity)) || ('a' in c && typeof c.a === 'number' && ids.includes(c.a)))
      expect(own.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical')).toHaveLength(0)
      expect(own.filter((c) => c.kind === 'parallel' || c.kind === 'perpendicular')).toHaveLength(3)
    }
    // A quarter turn: the bottom upright, the side level.
    const quarter = copies[0]
    expect(s.constraints.find((c) => c.kind === 'vertical' && c.entity === quarter[0])).toBeTruthy()
    expect(s.constraints.find((c) => c.kind === 'horizontal' && c.entity === quarter[1])).toBeTruthy()
    // Dragged by a corner, a turned copy stays a rectangle: each corner
    // square.
    const sides = turned[1]
    line(s, sides[0]).a = [line(s, sides[0]).a[0] + 0.5, line(s, sides[0]).a[1] - 0.3]
    expect(solveSketch(s).ok).toBe(true)
    const dir = (id: number): Vec2 => {
      const l = line(s, id)
      const d: Vec2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]]
      const n = Math.hypot(d[0], d[1])
      return [d[0] / n, d[1] / n]
    }
    for (let i = 0; i < 4; i++) {
      const [u, v] = [dir(sides[i]), dir(sides[(i + 1) % 4])]
      expect(u[0] * v[0] + u[1] * v[1]).toBeCloseTo(0, 6)
    }
  })

  it('leaves what ties the pieces to the axes or to other pieces with the original', () => {
    const s = emptySketch()
    const other = addEntity(s, { kind: 'line', a: [0, -5], b: [10, -5] })
    const [bottom] = addRectangle(s, [0, 0], [4, 2])
    addConstraint(s, { kind: 'distance', p: { entity: bottom, at: 'a' }, q: { datum: 'yz' }, value: 0 })
    addConstraint(s, { kind: 'parallel', a: bottom, b: other })
    const before = s.constraints.length
    patternPieces(s, s.entities.filter((e) => e.id !== other).map((e) => e.id), { kind: 'rectangular', step: [8, 0], count: 2 })
    // The copy has its rectangle's eight, not the distance or the parallel.
    expect(s.constraints.length - before).toBe(8)
  })
})

describe('relations inferred on a sketch handed in as coordinates', () => {
  it('joins the ends that meet and makes level lines horizontal, once', () => {
    const s = emptySketch()
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 6],
      [3, 9],
    ]
    pts.forEach((p, i) => addEntity(s, { kind: 'line', a: p, b: pts[(i + 1) % pts.length] }))
    expect(inferRelations(s)).toBe(4 + 2)
    expect(s.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(4)
    expect(s.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1)
    expect(s.constraints.filter((c) => c.kind === 'vertical')).toHaveLength(1)
    expect(s.constraints.every((c) => c.inferred)).toBe(true)
    expect(inferRelations(s)).toBe(0)
    expect(solveSketch(s).ok).toBe(true)
  })

  it('does not join what a chain of coincidences joins already, or ends apart', () => {
    const s = emptySketch()
    const a = addEntity(s, { kind: 'line', a: [0, 0], b: [5, 1] })
    const b = addEntity(s, { kind: 'line', a: [5, 1], b: [9, 4] })
    const c = addEntity(s, { kind: 'line', a: [5, 1], b: [1, 7] })
    addConstraint(s, { kind: 'coincident', p: { entity: a, at: 'b' }, q: { entity: b, at: 'a' } })
    addConstraint(s, { kind: 'coincident', p: { entity: b, at: 'a' }, q: { entity: c, at: 'a' } })
    addEntity(s, { kind: 'line', a: [20, 0], b: [20.01, 3] })
    expect(inferRelations(s)).toBe(0)
  })

  it('touches only the pieces named, when it is told which', () => {
    const s = emptySketch()
    addRectangle(s, [0, 0], [4, 4])
    const loose = addEntity(s, { kind: 'line', a: [4, 4], b: [9, 4] })
    const before = s.constraints.length
    expect(inferRelations(s, new Set([loose]))).toBe(2)
    expect(s.constraints.length - before).toBe(2)
  })
})
