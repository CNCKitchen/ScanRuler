// SPDX-License-Identifier: AGPL-3.0-only
// Two outlines drawn along one line — the bottoms of two rectangles both
// put on the same datum, which the solver leaves a hair apart — and a side
// that ends a hair short of the line it was meant to meet. What a sketch
// looks like after a few coincidences were solved, and what an extrude of
// one of its faces must not carry: a sliver a hair high and millimetres
// long along the shared line, lifted into a face of nothing.

import { describe, expect, it } from 'vitest'
import { findRegions, parseRegionKey, pointInPolygon } from '../core/regions'
import { addEntity, addRectangle, emptySketch, type Sketch } from '../core/sketch'

/** The sketch of a saved project that showed the sliver: the bracket's
 *  outline and its lip, both bottoms on the ZX datum — 0.00108 and 0.00110
 *  after the solve — the lip's left side starting on its own bottom, a
 *  hair above the outline's. */
function bracketSketch(): Sketch {
  const s = emptySketch()
  const y0 = 0.00108020343438141
  const y1 = 0.0011037711701751174
  addEntity(s, { kind: 'line', a: [-48.5432687675767, y0], b: [46.50914663649533, y0] })
  addEntity(s, { kind: 'line', a: [46.50914663649533, y0], b: [46.50914663649533, 9.404793781024047] })
  addEntity(s, { kind: 'line', a: [46.50914663649533, 9.404793781024047], b: [-48.5432687675767, 9.404793781024047] })
  addEntity(s, { kind: 'line', a: [-48.5432687675767, 9.404793781024047], b: [-48.5432687675767, y0] })
  addEntity(s, { kind: 'line', a: [42.32181529337595, y1], b: [48.33926773071289, y1] })
  addEntity(s, { kind: 'line', a: [48.33926773071289, y1], b: [48.33926773071289, 14.157892227172852] })
  addEntity(s, { kind: 'line', a: [48.33926773071289, 14.157892227172852], b: [42.32181529337595, 14.157892227172852] })
  addEntity(s, { kind: 'line', a: [42.32181529337595, 14.157892227172852], b: [42.32181529337595, y1] })
  return s
}

/** The shortest side of a loop as sampled. */
function shortestSide(polygon: readonly [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    best = Math.min(best, Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  return best
}

describe('two outlines along one line', () => {
  it('leaves no sliver where one bottom runs on past the other a hair off it', () => {
    const regions = findRegions(bracketSketch())
    // The outline left of the lip, the overlap, and the lip's L beyond the
    // outline: three faces, none with a side shorter than a millimetre.
    expect(regions).toHaveLength(3)
    expect(regions.map((r) => r.outer.polygon.length).sort()).toEqual([4, 4, 6])
    for (const r of regions) {
      expect(shortestSide(r.outer.polygon)).toBeGreaterThan(1)
      expect(r.holes).toHaveLength(0)
    }
    // The face left of the lip is bounded by the outline's three sides and
    // the lip's left side — not by the lip's bottom, which it never runs
    // along.
    const left = regions.find((r) => pointInPolygon([0, 5], r.outer.polygon))!
    expect(parseRegionKey(left.key)?.ids).toEqual([1, 3, 4, 8])
    expect(left.area).toBeCloseTo((42.32181529337595 + 48.5432687675767) * (9.404793781024047 - 0.00108), 2)
    // The lip's bottom lies on the outline's bottom exactly, not a hair
    // above it: every corner is at one of the drawing's three heights.
    const heights = [0.00108020343438141, 9.404793781024047, 14.157892227172852]
    for (const r of regions) for (const [, y] of r.outer.polygon) expect(Math.min(...heights.map((h) => Math.abs(y - h)))).toBeLessThan(1e-12)
    // Nothing of the drawing is lost to the split: the faces tile the union
    // of the two rectangles.
    const total = regions.reduce((sum, r) => sum + r.area, 0)
    const outline = (46.50914663649533 + 48.5432687675767) * (9.404793781024047 - 0.00108)
    const lipBeside = (48.33926773071289 - 46.50914663649533) * (9.404793781024047 - 0.0011)
    const lipTop = (48.33926773071289 - 42.32181529337595) * (14.157892227172852 - 9.404793781024047)
    expect(total).toBeCloseTo(outline + lipBeside + lipTop, 2)
  })

  it('keeps a T-junction a hair short of the line it meets, and the region on either side', () => {
    const s = emptySketch()
    addRectangle(s, [0, 0], [40, 20])
    // A divider from the bottom up, starting a hair above the bottom line.
    addEntity(s, { kind: 'line', a: [15, 0.00002], b: [15, 20] })
    const regions = findRegions(s)
    expect(regions).toHaveLength(2)
    for (const r of regions) {
      expect(r.outer.polygon).toHaveLength(4)
      expect(shortestSide(r.outer.polygon)).toBeGreaterThan(1)
    }
    expect(regions.reduce((sum, r) => sum + r.area, 0)).toBeCloseTo(800, 3)
  })

  it('keeps sides of one outline that meet end to end at a shallow bend apart', () => {
    // An outline round a curve kept as straight sides - a mesh's cut along a
    // spline face, as read off a CAD-exported STL. Some sides turn by a few
    // tenths of a degree, so a shorter side's far end lies within SNAP of
    // the longer one's line; taken onto that line, it parted from the side
    // after it, and the outline bounded nothing.
    const top: [number, number][] = [
      [-1.7695086248876635, 17.867300506251173], [-1.8290865930367382, 17.891050578042854], [-1.917863, 17.897537],
      [-2.77935015, 17.784015953333334], [-3.2940009233333334, 17.69293251], [-3.579473376666667, 17.64042503],
      [-4.372297913333333, 17.460849323333335], [-5.156204446666666, 17.245654293333335], [-5.929595483333333, 16.99527904],
    ]
    const corners: [number, number][] = [...top, [-5.929595483333333, 10], [-1.7695086248876635, 10]]
    const s = emptySketch()
    corners.forEach((a, i) => addEntity(s, { kind: 'line', a, b: corners[(i + 1) % corners.length] }))
    const regions = findRegions(s)
    expect(regions).toHaveLength(1)
    expect(regions[0].outer.polygon).toHaveLength(corners.length)
  })

  it('treats two sides drawn over each other as one', () => {
    const s = emptySketch()
    addRectangle(s, [0, 0], [20, 10])
    // A second rectangle sharing the first's right side exactly.
    addRectangle(s, [20, 0], [30, 10])
    const regions = findRegions(s)
    expect(regions).toHaveLength(2)
    expect(regions.map((r) => r.outer.polygon.length)).toEqual([4, 4])
    expect(regions.reduce((sum, r) => sum + r.area, 0)).toBeCloseTo(300, 6)
  })
})

describe('ends a hair apart across the vertex grid (issue 34)', () => {
  it('meet: the corner closes and the triangle is a region', () => {
    // The closing line ends 1.6 µm short of the first line's start, within
    // the 2 µm the graph snaps by — but two 1 µm cells over, where the old
    // grid never looked.
    const s = emptySketch()
    addEntity(s, { kind: 'line', a: [0, 0], b: [10, 0] })
    addEntity(s, { kind: 'line', a: [10, 0], b: [5, 8] })
    addEntity(s, { kind: 'line', a: [5, 8], b: [-0.0016, 0] })
    expect(findRegions(s)).toHaveLength(1)
  })
})
