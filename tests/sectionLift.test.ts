// SPDX-License-Identifier: AGPL-3.0-only
// A section's sheet stood back up in the part: sheet millimetres along the
// frame's in-plane axes become points, lines, circles and arcs in the
// cutting plane, the residuals come along, and the stroke that draws each
// one runs where the geometry says.
import { describe, expect, it } from 'vitest'
import type { SectionFrame } from '../src/core/section/frame'
import {
  isFullTurn,
  liftDir,
  liftFlatFit,
  liftPoint,
  sectionStroke,
  type ArcGeometry,
} from '../src/core/section/lift'
import type { FlatArcFit, FlatCircleFit, FlatLineFit, FlatPointFit } from '../src/core/flat/types'
import type { Vec3 } from '../src/core/types'

// A plane at x = 10 seen along +X: the sheet's U is world Y, its V world Z.
const tilted: SectionFrame = {
  origin: [10, 0, 5],
  normal: [1, 0, 0],
  basisU: [0, 1, 0],
  basisV: [0, 0, 1],
}

const near = (a: Vec3 | number[], b: Vec3 | number[], tol = 1e-9) => {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], -Math.log10(tol))
}

describe('lifting sheet geometry through the frame', () => {
  it('a sheet point is origin + u·U + v·V', () => {
    near(liftPoint(tilted, [2, 3]), [10, 2, 8])
    near(liftDir(tilted, [0, 1]), [0, 0, 1])
  })

  it('a point keeps its residuals and gains no region', () => {
    const fit: FlatPointFit = { kind: 'point', at: [1, -1], sigma: 0.02, usedPoints: 1 }
    const g = liftFlatFit(tilted, fit)
    expect(g.kind).toBe('point')
    near(g.center, [10, 1, 4])
    expect(g.sigma).toBe(0.02)
    expect(g.usedPoints).toBe(1)
    expect(g.regionSize).toBe(0)
    expect('formError' in g).toBe(false)
  })

  it('a line lies in the plane along its lifted direction, at its measured length', () => {
    const fit: FlatLineFit = {
      kind: 'line',
      center: [0, 2],
      dir: [1, 0],
      length: 8,
      sigma: 0.01,
      usedPoints: 40,
      formError: 0.05,
    }
    const g = liftFlatFit(tilted, fit)
    if (g.kind !== 'line') throw new Error('expected a line')
    near(g.center, [10, 0, 7])
    near(g.dir, [0, 1, 0])
    expect(g.length).toBe(8)
    expect(g.formError).toBe(0.05)
    const stroke = sectionStroke(g)!
    near(stroke, [10, -4, 7, 10, 4, 7])
  })

  it('a circle takes the cutting plane for its own', () => {
    const fit: FlatCircleFit = { kind: 'circle', center: [1, 2], radius: 4, sigma: 0, usedPoints: 12 }
    const g = liftFlatFit(tilted, fit)
    if (g.kind !== 'circle') throw new Error('expected a circle')
    near(g.center, [10, 1, 7])
    near(g.normal, [1, 0, 0])
    expect(g.radius).toBe(4)
    const stroke = sectionStroke(g, 8)!
    // A closed ring: nine vertices for eight segments, ends coincident, every
    // vertex at the radius and in the plane x = 10.
    expect(stroke.length).toBe(9 * 3)
    near(stroke.slice(0, 3), stroke.slice(-3))
    for (let i = 0; i < 9; i++) {
      expect(stroke[i * 3]).toBeCloseTo(10, 9)
      expect(Math.hypot(stroke[i * 3 + 1] - 1, stroke[i * 3 + 2] - 7)).toBeCloseTo(4, 9)
    }
  })

  it('an arc keeps its angles, counted from +U towards +V', () => {
    const fit: FlatArcFit = {
      kind: 'arc',
      center: [0, 0],
      radius: 2,
      start: 0,
      sweep: Math.PI / 2,
      sigma: 0,
      usedPoints: 5,
    }
    const g = liftFlatFit(tilted, fit) as ArcGeometry
    expect(g.kind).toBe('arc')
    near(g.basisU, [0, 1, 0])
    expect(g.start).toBe(0)
    expect(g.sweep).toBeCloseTo(Math.PI / 2, 12)
    const stroke = sectionStroke(g, 8)!
    // A quarter of eight segments is two: three vertices from +U round to +V.
    expect(stroke.length).toBe(3 * 3)
    near(stroke.slice(0, 3), [10, 2, 5])
    near(stroke.slice(-3), [10, 0, 7])
    // Never fewer than two segments, however small the sweep.
    expect(sectionStroke({ ...g, sweep: 0.01 }, 8)!.length).toBe(3 * 3)
  })

  it('a point has no stroke, and a full sweep is a circle', () => {
    expect(sectionStroke({ kind: 'point', center: [0, 0, 0], sigma: 0, usedPoints: 0, regionSize: 0 })).toBeNull()
    expect(isFullTurn(2 * Math.PI)).toBe(true)
    expect(isFullTurn(2 * Math.PI - 1e-9)).toBe(true)
    expect(isFullTurn(Math.PI)).toBe(false)
  })
})
