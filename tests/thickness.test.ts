// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import {
  buildSolidIndex,
  computeThickness,
  DEFAULT_CONE_ANGLE_DEG,
  suggestThicknessScale,
  thicknessScale,
  thicknessStats,
  type ThicknessOptions,
} from '../src/core/thickness/thickness'
import { paintField, RED_CAP_RGB, BLUE_CAP_RGB, UNMEASURED_RGB } from '../src/core/field/colormap'
import { boxMesh } from './helpers'

/** Wall thickness of a soup, measured the way the worker measures it. The
 *  facing test is off unless a case asks for it, so that the ray behaviour
 *  under test is not quietly filtered away. */
function measure(
  positions: Float32Array,
  options: Partial<ThicknessOptions> = {},
): { values: Float32Array; normals: Float32Array; positions: Float32Array } {
  const graph = buildMeshGraph({ kind: 'soup', positions })
  const bvh = buildSolidIndex(graph.positions, graph.indices)
  const values = computeThickness(bvh, graph.positions, graph.normals, {
    method: 'ray',
    coneRays: 0,
    coneAngle: (DEFAULT_CONE_ANGLE_DEG * Math.PI) / 180,
    maxNormalDeviation: null,
    maxThickness: graph.bboxDiag,
    epsilon: graph.bboxDiag * 1e-5,
    ...options,
  })
  return { values, normals: graph.normals, positions: graph.positions }
}

/** Reverse the winding of a triangle soup, so its normals point the other
 *  way — what a cavity's wall looks like inside a solid. */
function flipWinding(soup: Float32Array): Float32Array {
  const out = Float32Array.from(soup)
  for (let t = 0; t < out.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const a = out[t + 3 + k]
      out[t + 3 + k] = out[t + 6 + k]
      out[t + 6 + k] = a
    }
  }
  return out
}

const WEDGE_SLOPE = 0.1

/** Height of the tapered slab below: 8 mm at x = −30, 2 mm at x = +30. */
function wedgeHeight(x: number): number {
  return 8 - WEDGE_SLOPE * (x + 30)
}

/** A tapered slab on a flat base, closed, gridded in both directions so that
 *  the middle of each face has vertices whose normal is the face's own. */
function wedgeMesh(): Float32Array {
  const tris: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    tris.push(...a, ...b, ...c, ...a, ...c, ...d)
  const W = 20
  const ys = [-W, -10, 0, 10, W]
  for (let i = 0; i < 60; i++) {
    const x0 = -30 + i
    const x1 = x0 + 1
    const h0 = wedgeHeight(x0)
    const h1 = wedgeHeight(x1)
    for (let j = 0; j < ys.length - 1; j++) {
      const ya = ys[j]
      const yb = ys[j + 1]
      quad([x0, ya, h0], [x1, ya, h1], [x1, yb, h1], [x0, yb, h0]) // sloping top
      quad([x0, ya, 0], [x0, yb, 0], [x1, yb, 0], [x1, ya, 0]) // flat base
    }
    quad([x0, -W, 0], [x1, -W, 0], [x1, -W, h1], [x0, -W, h0])
    quad([x0, W, 0], [x0, W, h0], [x1, W, h1], [x1, W, 0])
  }
  quad([-30, -W, 0], [-30, -W, wedgeHeight(-30)], [-30, W, wedgeHeight(-30)], [-30, W, 0])
  quad([30, -W, 0], [30, W, 0], [30, W, wedgeHeight(30)], [30, -W, wedgeHeight(30)])
  return Float32Array.from(tris)
}

/** Vertices whose normal points squarely down one axis — away from the edges
 *  and corners of a box, where the welded normal is a blend of two faces and
 *  the ray leaves at 45°. */
function onFlatFaces(normals: Float32Array): number[] {
  const flat: number[] = []
  for (let v = 0; v < normals.length / 3; v++) {
    const nx = Math.abs(normals[v * 3])
    const ny = Math.abs(normals[v * 3 + 1])
    const nz = Math.abs(normals[v * 3 + 2])
    if (Math.max(nx, ny, nz) > 0.999) flat.push(v)
  }
  return flat
}

describe('wall thickness', () => {
  it('measures a solid block across its full width', () => {
    const { values, normals } = measure(boxMesh(20, 6))
    const flat = onFlatFaces(normals)
    expect(flat.length).toBeGreaterThan(100)
    for (const v of flat) expect(values[v]).toBeCloseTo(20, 3)
  })

  it('measures the wall of a hollow box, not the cavity across it', () => {
    // A 20 mm box with a 12 mm cavity: 4 mm of wall all round. The cavity is
    // wound inwards, the way a watertight solid's inner surface is, so both
    // its faces and the outer ones read the same wall.
    const shell = Float32Array.from([...boxMesh(20, 5), ...flipWinding(boxMesh(12, 4))])
    const { values, normals } = measure(shell)
    const flat = onFlatFaces(normals)
    expect(flat.length).toBeGreaterThan(100)
    for (const v of flat) expect(values[v]).toBeCloseTo(4, 3)
  })

  it('leaves a surface with nothing behind it unmeasured', () => {
    // A single triangle on its own: every ray leaves into open space.
    const { values } = measure(boxMesh(20, 4).slice(0, 18))
    for (let v = 0; v < values.length; v++) expect(Number.isNaN(values[v])).toBe(true)
  })

  it('refuses a wall thicker than the search allows for', () => {
    // The block is 20 mm across and the search is told to look 8 mm: there is
    // no wall to find, and none is reported.
    const { values } = measure(boxMesh(20, 4), { maxThickness: 8 })
    for (let v = 0; v < values.length; v++) expect(Number.isNaN(values[v])).toBe(true)
    // Widen it and the same points come back measured.
    const { values: found } = measure(boxMesh(20, 4), { maxThickness: 25 })
    expect(found.some((v) => Math.abs(v - 20) < 1e-3)).toBe(true)
  })

  it('never reads longer with a cone of rays than with one', () => {
    // The cone can only find a shorter way across a wall, never a longer one:
    // the ray down the normal is always among the candidates.
    const soup = boxMesh(20, 5)
    const single = measure(soup)
    const cone = measure(soup, { coneRays: 6 })
    let tighter = 0
    for (let v = 0; v < single.values.length; v++) {
      expect(cone.values[v]).toBeLessThanOrEqual(single.values[v] + 1e-4)
      if (cone.values[v] < single.values[v] - 1e-4) tighter++
    }
    // Left to itself the cone reads short near a convex edge, where a tilted
    // ray reaches the side wall before the far face.
    expect(tighter).toBeGreaterThan(0)
  })

  it('will not let a cone escape through the side of a convex edge', () => {
    // The side wall a tilted ray runs out through is nearly edge-on to it —
    // 68° off, for a ray leaning 22° — so the facing test throws it out and
    // the reading stays the wall the normal crosses. This is what the two
    // parameters are for, and why their defaults belong together.
    const soup = boxMesh(20, 5)
    const facing = measure(soup, {
      coneRays: 6,
      coneAngle: (22 * Math.PI) / 180,
      maxNormalDeviation: (60 * Math.PI) / 180,
    })
    const flat = onFlatFaces(facing.normals)
    expect(flat.length).toBeGreaterThan(50)
    for (const v of flat) expect(facing.values[v]).toBeCloseTo(20, 3)
  })

  it('measures the sphere across the wall, and never wider than the ray', () => {
    const shell = Float32Array.from([...boxMesh(20, 5), ...flipWinding(boxMesh(12, 4))])
    const ray = measure(shell)
    const sphere = measure(shell, { method: 'sphere' })
    const flat = onFlatFaces(sphere.normals)
    expect(flat.length).toBeGreaterThan(50)
    // Squarely across a parallel-faced wall the two agree exactly: the sphere
    // sits mid-wall and touches both faces.
    for (const v of flat) expect(sphere.values[v]).toBeCloseTo(4, 2)
    // And nowhere can it be wider than the ray that placed it.
    for (let v = 0; v < ray.values.length; v++) {
      if (Number.isNaN(ray.values[v])) continue
      expect(sphere.values[v]).toBeLessThanOrEqual(ray.values[v] + 1e-4)
    }
  })

  it('reads the block at its edges, where the ray reads the diagonal', () => {
    // The normal at an edge vertex bisects the two faces, so the ray leaves at
    // 45° and crosses 20·√2 of material. The sphere placed halfway along it is
    // the one inscribed in the block, and reports the block.
    const soup = boxMesh(20, 4)
    const ray = measure(soup)
    const sphere = measure(soup, { method: 'sphere' })
    // The midpoints of the twelve edges: two equal normal components and the
    // third zero, at the middle of the edge they run along — far enough from
    // the corners that only the four faces around the edge can limit anything.
    const edges: number[] = []
    for (let v = 0; v < ray.values.length; v++) {
      const n = [ray.normals[v * 3], ray.normals[v * 3 + 1], ray.normals[v * 3 + 2]]
      const along = n.findIndex((c) => Math.abs(c) < 1e-6)
      if (along < 0 || n.filter((c) => Math.abs(c) > 0.6).length !== 2) continue
      if (Math.abs(ray.positions[v * 3 + along]) < 1e-6) edges.push(v)
    }
    expect(edges.length).toBe(12)
    for (const v of edges) {
      expect(ray.values[v]).toBeCloseTo(20 * Math.SQRT2, 2)
      expect(sphere.values[v]).toBeCloseTo(20, 2)
    }
  })

  it('does not read a wedge as long as a ray does', () => {
    // A tapered slab on a flat base: 8 mm at one end, closing to 2 mm at the
    // other over 60 mm. On the sloping face the normal is not square to the
    // base, so the ray crosses at an angle and reads long. The sphere is not
    // tied to a direction and comes out tighter — both above the true
    // perpendicular wall, which is what these methods can and cannot do.
    const soup = wedgeMesh()
    const ray = measure(soup)
    const sphere = measure(soup, { method: 'sphere' })
    // On the sloping face, well clear of the ends and the sides so that
    // nothing but the base limits the sphere.
    const slope: number[] = []
    for (let v = 0; v < ray.values.length; v++) {
      const x = sphere.positions[v * 3]
      const y = sphere.positions[v * 3 + 1]
      const z = sphere.positions[v * 3 + 2]
      if (Math.abs(x) < 20 && Math.abs(y) < 12 && z > 0.5) slope.push(v)
    }
    expect(slope.length).toBeGreaterThan(20)

    const cosAlpha = Math.cos(Math.atan(WEDGE_SLOPE))
    for (const v of slope) {
      // Height above the base at the point the sphere's centre sits over, which
      // is where it ends up touching.
      const wall = wedgeHeight(sphere.positions[v * 3])
      // The ray crosses at the tilt of the face: wall / cos α, reading long.
      expect(ray.values[v]).toBeCloseTo(wall / cosAlpha, 2)
      // The sphere is not tied to that direction and comes back to the wall
      // square across, which is the answer being asked for.
      expect(sphere.values[v]).toBeCloseTo(wall, 1)
      expect(sphere.values[v]).toBeLessThan(ray.values[v])
    }
  })

  it('counts what falls under the minimum wall, and ignores what was never measured', () => {
    const values = Float32Array.from([0.8, 1.2, 2, NaN, 0.5])
    const stats = thicknessStats(values, 1)
    expect(stats.measured).toBe(4)
    expect(stats.total).toBe(5)
    expect(stats.belowLimit).toBe(2)
    expect(stats.min).toBeCloseTo(0.5)
    expect(stats.max).toBeCloseTo(2)
    expect(stats.mean).toBeCloseTo((0.8 + 1.2 + 2 + 0.5) / 4, 6)
  })

  it('paints thin red and thick blue, the opposite way round to deviation', () => {
    const values = Float32Array.from([0.5, 3.5, 2, NaN])
    const out = new Uint8Array(12)
    paintField(values, thicknessScale(1, 3, null), out)
    // Under the thin end and over the thick end get the caps of the ramp they
    // ran off — red for thin, blue for thick.
    expect(Array.from(out.slice(0, 3))).toEqual([...RED_CAP_RGB])
    expect(Array.from(out.slice(3, 6))).toEqual([...BLUE_CAP_RGB])
    // Mid-scale is the ramp's green, as on any map here.
    expect(Array.from(out.slice(6, 9))).toEqual([0, 200, 0])
    expect(Array.from(out.slice(9, 12))).toEqual([...UNMEASURED_RGB])
  })

  it('fits the scale to the walls, not to a stray ray down the length of the part', () => {
    const values = new Float32Array(1000)
    for (let i = 0; i < 1000; i++) values[i] = 2 + (i % 5) * 0.1
    values[0] = 180
    values[1] = NaN
    const { low, high } = suggestThicknessScale(values)
    expect(low).toBeGreaterThan(1)
    expect(high).toBeLessThan(5)
    expect(high).toBeGreaterThan(low)
  })
})
