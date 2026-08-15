// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { fitCylinderFromSeed } from '../src/core/fit/fitCylinderFromSeed'
import { fitPlaneFromSeed } from '../src/core/fit/fitPlaneFromSeed'
import { fitSphereFromSeed } from '../src/core/fit/fitSphereFromSeed'
import type { MeshGraph } from '../src/core/types'
import { boxMesh, cylinderMesh, icosphere } from './helpers'

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
