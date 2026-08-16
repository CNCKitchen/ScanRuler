// SPDX-License-Identifier: AGPL-3.0-only
// The hand-marked path: what the user painted is what gets fitted — including
// a patch that region growing would have swept far past.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { fitCylinderOnSelection } from '../src/core/fit/fitCylinderFromSeed'
import { fitPlaneOnSelection } from '../src/core/fit/fitPlaneFromSeed'
import { fitSphereOnSelection } from '../src/core/fit/fitSphereFromSeed'
import { FitError } from '../src/core/fit/errors'
import type { MeshGraph } from '../src/core/types'
import { boxMesh, cylinderMesh, icosphere } from './helpers'

const SETTINGS = { method: 'gaussian', sigma: 3 } as const

/** The vertices a brush stroke would have left behind, stood in for by a
 *  predicate over the scan's own vertices. */
function mark(g: MeshGraph, keep: (x: number, y: number, z: number) => boolean): Uint32Array {
  const out: number[] = []
  for (let v = 0; v < g.vertexCount; v++) {
    if (keep(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2])) out.push(v)
  }
  return Uint32Array.from(out)
}

describe('plane fitted to a marked surface', () => {
  const SIZE = 20
  const graph = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, 20, 0.01) })

  it('measures only the marked half of a face, not the whole face', () => {
    const selection = mark(graph, (x, _y, z) => z > SIZE / 2 - 0.1 && x <= 0.001)
    const out = fitPlaneOnSelection(graph, selection, SETTINGS)

    expect(Math.abs(out.normal[2])).toBeGreaterThan(0.999)
    expect(Math.abs(out.center[2] - SIZE / 2)).toBeLessThan(0.02)
    // Half of the face in x, all of it in y — the marked patch, not the face
    // a grown region would have covered.
    expect(Math.abs(out.center[0] + SIZE / 4)).toBeLessThan(0.3)
    expect(Math.abs(out.center[1])).toBeLessThan(0.3)
    const extents = [out.extentU, out.extentV].sort((a, b) => a - b)
    expect(Math.abs(extents[0] - SIZE / 4)).toBeLessThan(0.3)
    expect(Math.abs(extents[1] - SIZE / 2)).toBeLessThan(0.3)
    expect(out.regionSize).toBe(selection.length)
    expect(out.sigma).toBeLessThan(0.03)
  })

  it('refuses a marking too small to fit anything to', () => {
    const selection = mark(graph, (x, y, z) => z > SIZE / 2 - 0.1 && x > 9 && y > 9)
    expect(selection.length).toBeGreaterThan(0)
    expect(selection.length).toBeLessThan(20)
    expect(() => fitPlaneOnSelection(graph, selection, SETTINGS)).toThrow(FitError)
  })
})

describe('cylinder fitted to a marked surface', () => {
  const R = 8
  const LENGTH = 40
  const graph = buildMeshGraph({
    kind: 'soup',
    positions: cylinderMesh(R, LENGTH, 64, 24, 0.01).positions,
  })

  it('recovers radius and axis from a marked 120-degree band of the wall', () => {
    const selection = mark(graph, (x, y, z) => {
      const rho = Math.hypot(x, y)
      if (Math.abs(rho - R) > 0.2) return false
      if (Math.abs(z) > LENGTH / 4) return false
      return Math.abs(Math.atan2(y, x)) < Math.PI / 3
    })
    const out = fitCylinderOnSelection(graph, selection, SETTINGS)

    expect(Math.abs(out.radius - R)).toBeLessThan(0.02)
    expect(Math.abs(out.axis[2])).toBeGreaterThan(0.999)
    expect(Math.hypot(out.center[0], out.center[1])).toBeLessThan(0.05)
    // The marked band is half the shaft, and reaches ~120° around it.
    expect(Math.abs(out.length - LENGTH / 2)).toBeLessThan(1)
    expect(out.coverage).toBeGreaterThan(110)
    expect(out.coverage).toBeLessThan(130)
    expect(out.regionSize).toBe(selection.length)
  })
})

describe('sphere fitted to a marked surface', () => {
  it('recovers the centre from a marked cap', () => {
    const R = 10
    const graph = buildMeshGraph({ kind: 'indexed', ...icosphere(4, R, 0.005) })
    const selection = mark(graph, (_x, _y, z) => z > R * 0.5)
    const out = fitSphereOnSelection(graph, selection, SETTINGS)

    expect(Math.abs(out.radius - R)).toBeLessThan(0.05)
    expect(Math.hypot(...out.center)).toBeLessThan(0.05)
    expect(out.regionSize).toBe(selection.length)
  })
})
