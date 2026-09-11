// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { fitConeFromSeed } from '../src/core/fit/fitConeFromSeed'
import { fitCylinderFromSeed } from '../src/core/fit/fitCylinderFromSeed'
import { fitPlaneFromSeed } from '../src/core/fit/fitPlaneFromSeed'
import { fitSphereFromSeed } from '../src/core/fit/fitSphereFromSeed'
import { mulberry32 } from '../src/core/fit/ransac'
import type { MeshGraph } from '../src/core/types'
import { boxMesh, coneMesh, cylinderMesh, gaussian, icosphere } from './helpers'

const SETTINGS = { method: 'gaussian', sigma: 3 } as const

/** The vertex nearest a point — stands in for the user's click. */
function seedNear(g: MeshGraph, x: number, y: number, z: number): number {
  let best = 0
  let bestD = Infinity
  for (let v = 0; v < g.vertexCount; v++) {
    const d =
      (g.positions[v * 3] - x) ** 2 +
      (g.positions[v * 3 + 1] - y) ** 2 +
      (g.positions[v * 3 + 2] - z) ** 2
    if (d < bestD) {
      bestD = d
      best = v
    }
  }
  return best
}

describe('seed-to-sphere pipeline on a synthetic ball mesh', () => {
  it('grows from one vertex to the whole sphere and nails the radius', () => {
    const R = 10
    const mesh = icosphere(5, R, 0.005) // 10,242 vertices
    const graph = buildMeshGraph({ kind: 'indexed', ...mesh })
    const out = fitSphereFromSeed(graph, [0], SETTINGS)
    expect(Math.abs(out.radius - R)).toBeLessThan(0.01)
    expect(Math.hypot(...out.center)).toBeLessThan(0.01)
    expect(out.regionSize).toBeGreaterThan(graph.vertexCount * 0.95)
    expect(out.sigma).toBeLessThan(0.01)
  })
})

describe('seed-to-cylinder pipeline on a synthetic shaft mesh', () => {
  const R = 8
  const LENGTH = 40
  const RADIAL = 64
  const AXIAL = 24
  const mesh = cylinderMesh(R, LENGTH, RADIAL, AXIAL, 0.01)
  const graph = buildMeshGraph({ kind: 'soup', positions: mesh.positions })

  it('grows along the wall without climbing onto the end caps', () => {
    const seed = seedNear(graph, R, 0, 0)
    const out = fitCylinderFromSeed(graph, [seed], SETTINGS)

    expect(Math.abs(out.radius - R)).toBeLessThan(0.01)
    expect(Math.abs(out.axis[2])).toBeGreaterThan(0.9999)
    expect(Math.hypot(out.center[0], out.center[1])).toBeLessThan(0.01)
    expect(out.sigma).toBeLessThan(0.02)
    // A 64-facet ring leaves 5.6° between neighbouring vertices, so a fully
    // wrapped region reads as 360° minus one of those gaps.
    expect(out.coverage).toBeGreaterThan(352)

    // The wall is (AXIAL + 1) rings; the two rims are shared with the caps, so
    // their averaged normals put them out of the region — everything else is
    // in, and nothing from the caps is.
    const wallRings = AXIAL + 1
    expect(out.regionSize).toBeGreaterThan((wallRings - 4) * RADIAL)
    expect(out.regionSize).toBeLessThanOrEqual((wallRings - 2) * RADIAL)
    // Stopping short of the rims also caps the measured length.
    expect(out.length).toBeLessThan(LENGTH)
    expect(out.length).toBeGreaterThan(LENGTH - 4 * (LENGTH / AXIAL))
  })

  it('fails on the flat end cap instead of jumping to the wall', () => {
    const capSeed = seedNear(graph, 0, 0, LENGTH / 2)
    expect(() => fitCylinderFromSeed(graph, [capSeed], SETTINGS)).toThrow(/cylinder/i)
  })
})

describe('seed-to-cone pipeline on a synthetic frustum mesh', () => {
  const R1 = 4
  const R2 = 10
  const LENGTH = 40
  const HALF_ANGLE = (Math.atan((R2 - R1) / LENGTH) * 180) / Math.PI
  const mesh = coneMesh(R1, R2, LENGTH, 64, 24, 0.01)
  const graph = buildMeshGraph({ kind: 'soup', positions: mesh.positions })

  it('grows along the tapered wall without climbing onto the end caps', () => {
    const seed = seedNear(graph, (R1 + R2) / 2, 0, 0)
    const out = fitConeFromSeed(graph, [seed], SETTINGS)

    expect(Math.abs(out.halfAngle - HALF_ANGLE)).toBeLessThan(0.1)
    expect(Math.abs(out.radius - (R1 + R2) / 2)).toBeLessThan(0.05)
    // The axis points the way the radius grows: +Z.
    expect(out.axis[2]).toBeGreaterThan(0.9999)
    expect(Math.hypot(out.center[0], out.center[1])).toBeLessThan(0.02)
    expect(out.sigma).toBeLessThan(0.02)
    expect(out.coverage).toBeGreaterThan(352)
    // Stopping short of the rims caps the measured length and the end radii.
    expect(out.length).toBeLessThan(LENGTH)
    expect(out.length).toBeGreaterThan(LENGTH - 4 * (LENGTH / 24))
    expect(out.radius1).toBeGreaterThan(R1 - 0.05)
    expect(out.radius2).toBeLessThan(R2 + 0.05)
    expect(out.radius1).toBeLessThan(out.radius2)
  })

  it('fails on the flat end cap instead of jumping to the wall', () => {
    const capSeed = seedNear(graph, 0, 0, LENGTH / 2)
    expect(() => fitConeFromSeed(graph, [capSeed], SETTINGS)).toThrow(/cone/i)
  })
})

describe('seed-to-plane pipeline on a synthetic box mesh', () => {
  const SIZE = 40
  const GRID = 20
  const graph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID, 0.02) })

  it('grows across one face and stops at its edges', () => {
    const seed = seedNear(graph, 0, 0, SIZE / 2)
    const out = fitPlaneFromSeed(graph, [seed], SETTINGS)

    expect(Math.abs(out.normal[2])).toBeGreaterThan(0.999)
    // The normal is oriented the way the surface faces, i.e. outward.
    expect(out.normal[2]).toBeGreaterThan(0)
    expect(Math.abs(out.center[2] - SIZE / 2)).toBeLessThan(0.01)
    expect(out.sigma).toBeGreaterThan(0.012)
    expect(out.sigma).toBeLessThan(0.03)

    // One face is (GRID + 1)² vertices, of which the border ring is shared
    // with the neighbouring faces and so is left out.
    expect(out.regionSize).toBeGreaterThan((GRID - 2) ** 2)
    expect(out.regionSize).toBeLessThan((GRID + 1) ** 2)
    expect(2 * out.extentU).toBeLessThan(SIZE)
    expect(2 * out.extentU).toBeGreaterThan(SIZE * 0.8)
  })

  it('measures the same distance between opposite faces from either side', () => {
    const top = fitPlaneFromSeed(graph, [seedNear(graph, 0, 0, SIZE / 2)], SETTINGS)
    const bottom = fitPlaneFromSeed(graph, [seedNear(graph, 0, 0, -SIZE / 2)], SETTINGS)
    const gap = Math.abs(
      (bottom.center[0] - top.center[0]) * top.normal[0] +
        (bottom.center[1] - top.center[1]) * top.normal[1] +
        (bottom.center[2] - top.center[2]) * top.normal[2],
    )
    expect(Math.abs(gap - SIZE)).toBeLessThan(0.01)
    // Opposite faces of a box: normals antiparallel to within a thousandth.
    const align =
      top.normal[0] * bottom.normal[0] +
      top.normal[1] * bottom.normal[1] +
      top.normal[2] * bottom.normal[2]
    expect(align).toBeLessThan(-0.9999)
  })
})

type P3 = [number, number, number]

/** Two triangles per quad into a soup; corners are shared bit-for-bit so the
 *  weld rebuilds the topology. */
function quad(tris: number[], a: P3, b: P3, c: P3, d: P3): void {
  tris.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** A height field z(x, y) over a square grid of pitch `h`, with Gaussian
 *  noise along Z; cells whose corner the field leaves undefined are skipped. */
function heightField(
  half: number,
  h: number,
  zOf: (x: number, y: number) => number | null,
  noise: number,
): Float32Array {
  const rand = mulberry32(7)
  const n = Math.round((2 * half) / h)
  const grid: (P3 | null)[][] = []
  for (let i = 0; i <= n; i++) {
    const row: (P3 | null)[] = []
    for (let j = 0; j <= n; j++) {
      const x = -half + i * h
      const y = -half + j * h
      const z = zOf(x, y)
      row.push(z === null ? null : [x, y, z + gaussian(rand) * noise])
    }
    grid.push(row)
  }
  const tris: number[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1]
      if (a && b && c && d) quad(tris, a, b, c, d)
    }
  }
  return Float32Array.from(tris)
}

/** A surface of revolution about +Z, radius `rOf(z)`, rings `h` apart, with
 *  Gaussian radial noise. Open at both ends. */
function revolve(
  rOf: (z: number) => number,
  zLo: number,
  zHi: number,
  h: number,
  radial: number,
  noise: number,
): Float32Array {
  const rand = mulberry32(9)
  const rings = Math.round((zHi - zLo) / h)
  const grid: P3[][] = []
  for (let j = 0; j <= rings; j++) {
    const z = zLo + j * h
    const row: P3[] = []
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * 2 * Math.PI
      const r = rOf(z) + gaussian(rand) * noise
      row.push([Math.cos(a) * r, Math.sin(a) * r, z])
    }
    grid.push(row)
  }
  const tris: number[] = []
  for (let j = 0; j < rings; j++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial
      quad(tris, grid[j][k], grid[j][k2], grid[j + 1][k2], grid[j + 1][k])
    }
  }
  return Float32Array.from(tris)
}

/** The rounding a scanner leaves at every edge: the surface rolls off over a
 *  radius, and the first ring or two of the roll-off sit close enough to the
 *  surface, at a normal tilted little enough, to pass the growing tests. A
 *  region that keeps them is pulled into the part (a face) or shrunk (a
 *  shaft) by a few microns. The peel takes those rings back off the rim. */
describe('the rounding at an edge stays out of the region', () => {
  const NOISE = 0.01
  const H = 0.25

  it('a face with rounded edges is measured on the flat, not pulled into the part', () => {
    const FLAT = 3 // half-size of the flat top
    const R = 1.5 // rounding radius
    // Rolls off along a quarter circle past the flat; the outer rings sit
    // 0.021 and 0.086 mm below the top, at 10° and 20° — the first is inside
    // a 3.5σ band and the 25° angle, the second is not.
    const top = (x: number, y: number): number | null => {
      const e = Math.hypot(Math.max(0, Math.abs(x) - FLAT), Math.max(0, Math.abs(y) - FLAT))
      if (e >= 0.9 * R) return null
      return -(R - Math.sqrt(R * R - e * e))
    }
    const graph = buildMeshGraph({
      kind: 'soup',
      positions: heightField(FLAT + R, H, top, NOISE),
    })
    const out = fitPlaneFromSeed(graph, [seedNear(graph, 0, 0, 0)], SETTINGS)

    expect(Math.abs(out.normal[2])).toBeGreaterThan(0.9999)
    // Unbiased: the flat is at z = 0 to within the noise on its mean; the
    // first roll-off ring alone would pull it 3 µm into the part.
    expect(Math.abs(out.center[2])).toBeLessThan(0.0015)
    // Nothing of the roll-off is in the region…
    for (let i = 0; i < out.region.length; i++) {
      const v = out.region[i]
      const x = graph.positions[v * 3], y = graph.positions[v * 3 + 1]
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThanOrEqual(FLAT + 1e-6)
    }
    // …and most of the flat still is.
    const flatCount = (2 * FLAT / H + 1) ** 2
    expect(out.regionSize).toBeGreaterThan(0.75 * flatCount)
  })

  it('a shaft with rounded ends is measured on the straight wall', () => {
    const R = 8
    const HALF = 3
    const EDGE = 1.5 // rounding radius at each end
    const rOf = (z: number): number => {
      const e = Math.max(0, Math.abs(z) - (HALF - EDGE))
      return R - (EDGE - Math.sqrt(EDGE * EDGE - e * e))
    }
    // Rings land on the wall's end and every 0.25 mm into the roll-off, the
    // same offsets as the face above.
    const graph = buildMeshGraph({
      kind: 'soup',
      positions: revolve(rOf, -(HALF - EDGE) - 1.25, HALF - EDGE + 1.25, H, 64, NOISE),
    })
    const out = fitCylinderFromSeed(graph, [seedNear(graph, R, 0, 0)], SETTINGS)

    expect(Math.abs(out.axis[2])).toBeGreaterThan(0.9999)
    // The first ring of each roll-off alone would take 2 µm off the radius.
    expect(Math.abs(out.radius - R)).toBeLessThan(0.001)
    for (let i = 0; i < out.region.length; i++) {
      expect(Math.abs(graph.positions[out.region[i] * 3 + 2])).toBeLessThanOrEqual(HALF - EDGE + 1e-6)
    }
    const wallRings = (2 * (HALF - EDGE)) / H + 1
    expect(out.regionSize).toBeGreaterThan(0.75 * wallRings * 64)
    expect(out.coverage).toBeGreaterThan(352)
  })
})
