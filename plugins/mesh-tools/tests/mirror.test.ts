// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { meshCentroid, tetraVolume6 } from '../../../src/core/geometry/centroid'
import { halfEdges } from '../core/boundary'
import { cutMesh } from '../core/cut'
import { mirrorMesh } from '../core/mirror'
import type { Vec3 } from '../../../src/core/types'
import { boxMesh, icosphere } from '../../../tests/helpers'

/** A closed box `size` across, its middle at `at`, welded. */
function box(size: number, at: Vec3 = [0, 0, 0], grid = 4) {
  const soup = boxMesh(size, grid)
  for (let i = 0; i < soup.length; i++) soup[i] += at[i % 3]
  return buildMeshGraph({ kind: 'soup', positions: soup })
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

/** The volume the mesh encloses, signed by its winding: positive facing
 *  out. */
function signedVolume(m: { positions: Float32Array; indices: Uint32Array }): number {
  let six = 0
  for (let t = 0; t < m.indices.length; t += 3) six += tetraVolume6(m.positions, m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3)
  return six / 6
}

function bounds(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i])
    max[i % 3] = Math.max(max[i % 3], positions[i])
  }
  return { min, max }
}

describe('mirroring the whole part', () => {
  it('takes every point to its mirror image and keeps the part facing out', () => {
    const g = box(10, [20, 3, 0])
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], [1, 0, 0], 'whole')
    expect(m.report).toMatchObject({ mode: 'whole', mirrored: g.triangleCount, removed: 0 })
    const b = bounds(m.positions)
    expect(b.min[0]).toBeCloseTo(-25, 4)
    expect(b.max[0]).toBeCloseTo(-15, 4)
    expect(b.min[1]).toBeCloseTo(-2, 4)
    // Still a closed box facing out: a positive volume, the same one.
    const c = meshCentroid(m.positions, m.indices)
    expect(c.closed).toBe(true)
    expect(signedVolume(m)).toBeCloseTo(1000, 2)
    expect(c.volume![0]).toBeCloseTo(-20, 3)
  })

  it('keeps every vertex under its own number', () => {
    const g = box(10, [2, 0, 0])
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], [1, 0, 0], 'whole')
    expect(m.indices.length).toBe(g.indices.length)
    for (let v = 0; v < g.vertexCount; v++) {
      expect(m.vertexMap[v]).toBe(v)
      expect(m.positions[v * 3]).toBeCloseTo(-g.positions[v * 3], 5)
      expect(m.positions[v * 3 + 1]).toBeCloseTo(g.positions[v * 3 + 1], 5)
    }
  })

  it('mirrors across a slanted plane', () => {
    const g = box(10, [10, 0, 0])
    const n: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], n, 'whole')
    // Across the plane x = −y the middle at (10, 0) goes to (0, −10).
    const c = meshCentroid(m.positions, m.indices)
    expect(signedVolume(m)).toBeCloseTo(1000, 2)
    expect(c.volume![0]).toBeCloseTo(0, 3)
    expect(c.volume![1]).toBeCloseTo(-10, 3)
  })
})

describe('making a part symmetric', () => {
  it('replaces the side the normal points to with the mirror image of the other, joined along the plane', () => {
    // A box from x −5 to 5, mirrored about x = 2: the side kept runs from
    // −5 to 2, and the part from −5 to 9.
    const g = box(10)
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [2, 0, 0], [1, 0, 0], 'symmetric')
    expect(m.report.mode).toBe('symmetric')
    expect(m.report.removed).toBeGreaterThan(0)
    expect(m.report.split).toBeGreaterThan(0)
    const n = m.positions.length / 3
    expect(edgeFaults(m.indices, n)).toEqual({ open: 0, overfull: 0 })
    const b = bounds(m.positions)
    expect(b.min[0]).toBeCloseTo(-5, 4)
    expect(b.max[0]).toBeCloseTo(9, 4)
    const c = meshCentroid(m.positions, m.indices)
    expect(c.closed).toBe(true)
    expect(signedVolume(m)).toBeCloseTo(1400, 2)
    expect(c.volume![0]).toBeCloseTo(2, 3)
  })

  it('keeps the old vertices of the side kept under their numbers, in order', () => {
    const g = box(10)
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [2, 0, 0], [1, 0, 0], 'symmetric')
    let last = -1
    for (let v = 0; v < g.vertexCount; v++) {
      const w = m.vertexMap[v]
      if (g.positions[v * 3] > 2) {
        expect(w).toBe(-1)
        continue
      }
      expect(w).toBeGreaterThan(last)
      last = w
      for (let k = 0; k < 3; k++) expect(m.positions[w * 3 + k]).toBeCloseTo(g.positions[v * 3 + k], 5)
    }
  })

  it('drops the cap of a part already cut on the plane, rather than doubling it', () => {
    const g = box(10)
    const half = cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], [1, 0, 0], true)
    expect(half.report.capped).toBe(1)
    const vertexCount = half.positions.length / 3
    const m = mirrorMesh(half.positions, half.indices, vertexCount, [0, 0, 0], [1, 0, 0], 'symmetric')
    expect(m.report.inPlane).toBe(half.report.capTriangles)
    expect(edgeFaults(m.indices, m.positions.length / 3)).toEqual({ open: 0, overfull: 0 })
    const c = meshCentroid(m.positions, m.indices)
    expect(c.closed).toBe(true)
    expect(signedVolume(m)).toBeCloseTo(1000, 2)
  })

  it('stays closed through triangles the plane cuts at a slant', () => {
    const s = icosphere(3, 5)
    const g = buildMeshGraph({ kind: 'indexed', positions: s.positions, indices: s.indices })
    const n: Vec3 = [0.6, 0.48, 0.64]
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [0.3, -0.2, 0.1], n, 'symmetric')
    expect(m.report.split).toBeGreaterThan(0)
    expect(edgeFaults(m.indices, m.positions.length / 3)).toEqual({ open: 0, overfull: 0 })
    expect(meshCentroid(m.positions, m.indices).closed).toBe(true)
    expect(signedVolume(m)).toBeGreaterThan(0)
  })

  it('puts the mirror image beside a part wholly on the side kept', () => {
    const g = box(10, [-20, 0, 0])
    const m = mirrorMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], [1, 0, 0], 'symmetric')
    expect(m.report.removed).toBe(0)
    const c = meshCentroid(m.positions, m.indices)
    expect(signedVolume(m)).toBeCloseTo(2000, 2)
    expect(c.volume![0]).toBeCloseTo(0, 3)
  })

  it('refuses when nothing of the part is on the side to keep', () => {
    const g = box(10, [20, 0, 0])
    expect(() => mirrorMesh(g.positions, g.indices, g.vertexCount, [0, 0, 0], [1, 0, 0], 'symmetric')).toThrow(/keep the other side/)
  })
})
