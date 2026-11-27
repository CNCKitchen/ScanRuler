// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { tetraVolume6 } from '../../../src/core/geometry/centroid'
import { halfEdges } from '../core/boundary'
import { cutOutline, stretchMesh, unstretch, type StretchSettings } from '../core/stretch'
import type { Vec3 } from '../../../src/core/types'
import { boxMesh, icosphere } from '../../../tests/helpers'

/** A closed box `size` across, its middle at the origin, welded. */
function box(size: number, grid = 4) {
  return buildMeshGraph({ kind: 'soup', positions: boxMesh(size, grid) })
}

/**
 * A U standing on its base, closed and welded: 30 wide in X, 10 deep in Y,
 * the base up to Z 5 and the legs — X 0 to 10 and 20 to 30 — up to Z 20.
 * Its sides are single quads from Z 5 to 20, so a band across the legs has
 * to cut them.
 */
function uPart() {
  const outline: [number, number][] = [
    [0, 0], [30, 0], [30, 5], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20], [0, 5],
  ]
  const caps: [number, number][][] = [
    [[0, 0], [30, 0], [30, 5], [20, 5], [10, 5], [0, 5]],
    [[0, 5], [10, 5], [10, 20], [0, 20]],
    [[20, 5], [30, 5], [30, 20], [20, 20]],
  ]
  const soup: number[] = []
  const tri = (a: Vec3, b: Vec3, c: Vec3) => soup.push(...a, ...b, ...c)
  // The outline runs anticlockwise seen from −Y looking along +Y... so the
  // front cap (Y 0) faces −Y wound clockwise from there; the back the other
  // way round.
  for (const poly of caps) {
    for (let k = 1; k + 1 < poly.length; k++) {
      const [a, b, c] = [poly[0], poly[k], poly[k + 1]]
      tri([a[0], 0, a[1]], [c[0], 0, c[1]], [b[0], 0, b[1]])
      tri([a[0], 10, a[1]], [b[0], 10, b[1]], [c[0], 10, c[1]])
    }
  }
  for (let i = 0; i < outline.length; i++) {
    const [p, q] = [outline[i], outline[(i + 1) % outline.length]]
    tri([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], 10, q[1]])
    tri([p[0], 0, p[1]], [q[0], 10, q[1]], [p[0], 10, p[1]])
  }
  const g = buildMeshGraph({ kind: 'soup', positions: new Float32Array(soup) })
  // Wound outward whichever way the loops above came out.
  if (signedVolume(g) < 0) {
    for (let t = 0; t < g.indices.length; t += 3) {
      const b = g.indices[t + 1]
      g.indices[t + 1] = g.indices[t + 2]
      g.indices[t + 2] = b
    }
  }
  return g
}

/** Edges with a triangle on one side only, and edges with more than two —
 *  both zero for a closed, manifold mesh. */
function edgeFaults(indices: Uint32Array, vertexCount: number): { open: number; overfull: number } {
  const he = halfEdges(indices, vertexCount)
  let open = 0
  let overfull = 0
  for (let a = 0; a < vertexCount; a++) {
    for (let h = he.offsets[a]; h < he.offsets[a + 1]; h++) {
      const b = he.to[h]
      let back = 0
      for (let k = he.offsets[b]; k < he.offsets[b + 1]; k++) if (he.to[k] === a) back++
      if (back === 0) open++
      if (back > 1) overfull++
    }
  }
  return { open, overfull }
}

function signedVolume(m: { positions: Float32Array; indices: Uint32Array }): number {
  let six = 0
  for (let t = 0; t < m.indices.length; t += 3) six += tetraVolume6(m.positions, m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3)
  return six / 6
}

/** The furthest the triangles' corners reach along an axis, over those with
 *  a corner in the box given by `where`. */
function reach(m: { positions: Float32Array; indices: Uint32Array }, axis: number, where: (p: Vec3) => boolean = () => true) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < m.indices.length; i++) {
    const v = m.indices[i] * 3
    const p: Vec3 = [m.positions[v], m.positions[v + 1], m.positions[v + 2]]
    if (!where(p)) continue
    min = Math.min(min, p[axis])
    max = Math.max(max, p[axis])
  }
  return { min, max }
}

const along = (dir: Vec3, rest: Partial<StretchSettings> = {}): StretchSettings => ({
  origin: [0, 0, 0],
  dir,
  at: 0,
  amount: 3,
  ...rest,
})

const closed = (r: { indices: Uint32Array; positions: Float32Array }) => edgeFaults(r.indices, r.positions.length / 3)

describe('lengthening: the cut’s section put in', () => {
  it('moves what is past the cut out and fills the gap with the section, the part closed and facing out', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0]))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    // The cross-section is 10 × 10: three more of it.
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) + 300, 3)
    expect(reach(r, 0)).toEqual({ min: -5, max: 8 })
    expect(r.report).toMatchObject({ at: 0, amount: 3, extent: { min: -5, max: 5 }, newExtent: { min: -5, max: 8 }, piece: false })
    expect(r.report.added).toBeGreaterThan(0)
    expect(r.slab.filter((s) => s === 2).length).toBe(r.report.added)
  })

  it('keeps every vertex under its own number: short of the cut where it was, past it moved by the amount alone', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 1 }))
    expect(Array.from(r.vertexMap)).toEqual(Array.from({ length: g.vertexCount }, (_, v) => v))
    for (let v = 0; v < g.vertexCount; v++) {
      const x = g.positions[v * 3]
      // A vertex on the cut stays; its copy moves.
      expect(r.positions[v * 3]).toBeCloseTo(x <= 1 ? x : x + 3, 5)
      expect(r.positions[v * 3 + 1]).toBe(g.positions[v * 3 + 1])
    }
  })

  it('with nothing to put in, leaves the part as it was, split at the cut', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 1, amount: 0 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g), 6)
    expect(r.report.added).toBe(0)
    expect(r.report.split).toBeGreaterThan(0)
  })

  it('stretches along any direction, the part still closed and facing out', () => {
    const s = icosphere(3, 10)
    const g = buildMeshGraph({ kind: 'indexed', positions: s.positions, indices: s.indices })
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 2, 2], { at: 1, amount: 4 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeGreaterThan(signedVolume(g))
    const { extent, newExtent } = r.report
    expect(newExtent.max - newExtent.min).toBeCloseTo(extent.max - extent.min + 4, 4)
  })

  it('cuts through the middle of the part to start, at a figure a person would type', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([0, 0, 1], { at: null }))
    expect(r.report.at).toBe(0)
    expect(r.report.centre?.[2]).toBeCloseTo(0, 6)
  })

  it('refuses a cut off the part', () => {
    const g = box(10)
    expect(() => stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 6 }))).toThrow(/off the part/)
  })

  it('outlines the cut on the part — and where the section put in ends', () => {
    const g = box(10)
    const around = (rim: Float32Array, x: number) => {
      let sum = 0
      for (let i = 0; i < rim.length; i += 6) {
        if (Math.abs(rim[i] - x) > 1e-6) continue
        sum += Math.hypot(rim[i + 3] - rim[i], rim[i + 4] - rim[i + 1], rim[i + 5] - rim[i + 2])
      }
      return sum
    }
    const still = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 1, amount: 0 }))
    expect(around(still.rim, 1)).toBeCloseTo(40, 4)
    const put = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 1, amount: 3 }))
    expect(around(put.rim, 1)).toBeCloseTo(40, 4)
    expect(around(put.rim, 4)).toBeCloseTo(40, 4)
  })

  it('takes a point back to where it was before the stretch', () => {
    expect(unstretch(9, 3, 1, 4)).toBe(5)
    expect(unstretch(2.5, 2, 1, 4)).toBe(1)
    expect(unstretch(-3, 0, 1, 4)).toBe(-3)
    expect(unstretch(2, 3, 1, -4)).toBe(6)
  })
})

describe('shortening: a slab taken out past the cut', () => {
  it('takes the slab out and closes the part up, the rims joined', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 0, amount: -2 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) - 200, 3)
    expect(reach(r, 0)).toEqual({ min: -5, max: 3 })
    // Every vertex short of the cut is still there under its number.
    for (let v = 0; v < g.vertexCount; v++) if (g.positions[v * 3] < -0.1) expect(r.vertexMap[v]).toBeGreaterThanOrEqual(0)
  })

  it('leaves a flat step where the section is not the same at both ends', () => {
    // Along X the U is tall, low across its base, then tall again: a slab
    // from 8 to 12 spans the step at 10.
    const g = uPart()
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 8, amount: -4 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    // 8 to 10 is 20 tall, 10 to 12 is 5, and 10 deep.
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) - 500, 2)
    expect(reach(r, 0).max).toBeCloseTo(26, 4)
  })

  it('closes up off the mesh’s grid, and on a round part cut askew', () => {
    const g = box(10)
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 0.7, amount: -1.6 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) - 160, 3)
    const s = icosphere(3, 10)
    const ball = buildMeshGraph({ kind: 'indexed', positions: s.positions, indices: s.indices })
    const b = stretchMesh(ball.positions, ball.indices, ball.vertexCount, along([1, 2, 2], { at: 1, amount: -3 }))
    expect(closed(b)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(b)).toBeLessThan(signedVolume(ball))
    expect(b.report.newExtent.max - b.report.newExtent.min).toBeCloseTo(b.report.extent.max - b.report.extent.min - 3, 4)
  })

  it('refuses to take out all there is past the cut', () => {
    const g = box(10)
    expect(() => stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { at: 0, amount: -5 }))).toThrow(/everything past the cut/)
  })
})

describe('stretching one piece alone', () => {
  it('stretches both legs of a U when the whole part is stretched', () => {
    const g = uPart()
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([0, 0, 1], { at: 10, amount: 6 }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    // Each leg's cross-section is 10 × 10.
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) + 1200, 2)
    expect(reach(r, 2, (p) => p[0] < 10.5).max).toBeCloseTo(26, 4)
    expect(reach(r, 2, (p) => p[0] > 19.5).max).toBeCloseTo(26, 4)
  })

  it('stretches only the leg picked, the other left as it was', () => {
    const g = uPart()
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([0, 0, 1], { at: 10, amount: 6, piece: [5, 5, 15] }))
    expect(r.report.piece).toBe(true)
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) + 600, 2)
    expect(reach(r, 2, (p) => p[0] < 10.5).max).toBeCloseTo(26, 4)
    expect(reach(r, 2, (p) => p[0] > 19.5).max).toBeCloseTo(20, 4)
  })

  it('keeps a face lying in the cut out of the piece — the base between the legs joins nothing', () => {
    const g = uPart()
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([0, 0, 1], { at: 5, amount: 6, piece: [25, 5, 12] }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(reach(r, 2, (p) => p[0] > 19.5 && p[2] > 5.5).max).toBeCloseTo(26, 4)
    expect(reach(r, 2, (p) => p[0] < 10.5 && p[2] > 5.5).max).toBeCloseTo(20, 4)
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) + 600, 2)
  })

  it('shortens one leg alone', () => {
    const g = uPart()
    const r = stretchMesh(g.positions, g.indices, g.vertexCount, along([0, 0, 1], { at: 10, amount: -4, piece: [5, 5, 15] }))
    expect(closed(r)).toEqual({ open: 0, overfull: 0 })
    expect(signedVolume(r)).toBeCloseTo(signedVolume(g) - 400, 2)
    expect(reach(r, 2, (p) => p[0] < 9.5).max).toBeCloseTo(16, 4)
    expect(reach(r, 2, (p) => p[0] > 20.5).max).toBeCloseTo(20, 4)
  })
})

describe('the outline that follows a dragged cut', () => {
  it('is the cross-section where the plane meets the mesh, with its middle', () => {
    const g = box(10)
    const { segments, centre } = cutOutline(g.positions, g.indices, [0, 0, 0], [1, 0, 0], 1.3)
    let sum = 0
    for (let i = 0; i < segments.length; i += 6) {
      expect(segments[i]).toBeCloseTo(1.3, 5)
      sum += Math.hypot(segments[i + 3] - segments[i], segments[i + 4] - segments[i + 1], segments[i + 5] - segments[i + 2])
    }
    expect(sum).toBeCloseTo(40, 4)
    expect(centre![0]).toBeCloseTo(1.3, 5)
    expect(cutOutline(g.positions, g.indices, [0, 0, 0], [1, 0, 0], 9).centre).toBeNull()
  })
})

describe('the pieces past the cut', () => {
  it('counts them: one for a box, two for a U cut across its legs, one cut along its base', () => {
    const g = box(10)
    expect(stretchMesh(g.positions, g.indices, g.vertexCount, along([1, 0, 0], { amount: 0 })).report.pieces).toBe(1)
    const u = uPart()
    expect(stretchMesh(u.positions, u.indices, u.vertexCount, along([0, 0, 1], { at: 10, amount: 0 })).report.pieces).toBe(2)
    // Cut at the top of the base: the face between the legs lies in the cut
    // and joins nothing.
    expect(stretchMesh(u.positions, u.indices, u.vertexCount, along([0, 0, 1], { at: 5, amount: 0 })).report.pieces).toBe(2)
    expect(stretchMesh(u.positions, u.indices, u.vertexCount, along([1, 0, 0], { at: 5, amount: 0 })).report.pieces).toBe(1)
  })
})
