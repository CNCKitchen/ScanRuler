// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { meshCentroid } from '../src/core/geometry/centroid'
import { boxMesh, cylinderMesh } from './helpers'

const SIZE = 20
const GRID = 10

const shifted = (soup: Float32Array, d: [number, number, number]) =>
  soup.map((v, i) => v + d[i % 3])

describe('mesh centroid', () => {
  it('finds the centre of a closed box and its volume', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(SIZE, GRID) })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(true)
    expect(c.volumeMm3).toBeCloseTo(SIZE ** 3, 3)
    for (const k of [0, 1, 2]) expect(c.volume![k]).toBeCloseTo(0, 6)
    for (const k of [0, 1, 2]) expect(c.area[k]).toBeCloseTo(0, 6)
  })

  it('follows the part wherever it sits', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: shifted(boxMesh(SIZE, GRID), [50, -30, 7]) })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(true)
    expect(c.volume![0]).toBeCloseTo(50, 4)
    expect(c.volume![1]).toBeCloseTo(-30, 4)
    expect(c.volume![2]).toBeCloseTo(7, 4)
  })

  it('calls a tube open at both ends open (issue 34)', () => {
    // Top and bottom gone: the openings face each other, so the volume reads
    // the same from any origin — but no z-flux passes through the walls.
    const soup = boxMesh(SIZE, GRID)
    const face = GRID * GRID * 2 * 9
    const g = buildMeshGraph({ kind: 'soup', positions: soup.slice(2 * face) })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(false)
    expect(c.volume).toBeNull()
  })

  it('calls a box with its bottom missing open and falls back to the surface centroid', () => {
    // boxMesh lays the faces out top first and bottom second; each face is
    // GRID² quads of two triangles of nine floats.
    const soup = boxMesh(SIZE, GRID)
    const face = GRID * GRID * 2 * 9
    const open = new Float32Array(soup.length - face)
    open.set(soup.subarray(0, face))
    open.set(soup.subarray(2 * face), face)
    const g = buildMeshGraph({ kind: 'soup', positions: open })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(false)
    expect(c.volume).toBeNull()
    // Five faces of six: the surface's centroid rises toward the top.
    expect(c.area[2]).toBeCloseTo(SIZE / 2 / 5, 4)
    expect(c.area[0]).toBeCloseTo(0, 6)
  })

  it('calls a tube open at both ends open, though its two ends cancel', () => {
    // The wall alone: two openings facing opposite ways leave the signed
    // volume the same from every origin.
    const { positions, wallFraction } = cylinderMesh(10, 40, 48, 12)
    const wall = positions.subarray(0, Math.round((positions.length / 9) * wallFraction) * 9)
    const g = buildMeshGraph({ kind: 'soup', positions: wall })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(false)
    expect(c.volume).toBeNull()
  })

  it('still calls the capped cylinder closed', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: cylinderMesh(10, 40, 48, 12).positions })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(true)
    for (const k of [0, 1, 2]) expect(c.volume![k]).toBeCloseTo(0, 4)
  })

  it('lets a pinhole pass', () => {
    // One small triangle of the box's side taken out.
    const soup = boxMesh(SIZE, GRID)
    const g = buildMeshGraph({ kind: 'soup', positions: soup.subarray(9) })
    expect(meshCentroid(g.positions, g.indices).closed).toBe(true)
  })

  it('calls a tube along a body diagonal open', () => {
    // Along (1, 1, 1) the ends miss as much x-, y- as z-flux, so a test of
    // the three fluxes agreeing passed it; each rim's own area does not.
    const { positions, wallFraction } = cylinderMesh(10, 40, 48, 12)
    const wall = positions.slice(0, Math.round((positions.length / 9) * wallFraction) * 9)
    // z turned onto (1, 1, 1) / √3 about the axis z × (1, 1, 1).
    const d = [1, 1, 1].map((v) => v / Math.sqrt(3))
    const u = [-1, 1, 0].map((v) => v / Math.SQRT2)
    const cos = d[2], sin = Math.sqrt(1 - cos * cos)
    for (let i = 0; i < wall.length; i += 3) {
      const p = [wall[i], wall[i + 1], wall[i + 2]]
      const dot = u[0] * p[0] + u[1] * p[1] + u[2] * p[2]
      const x = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]]
      for (let k = 0; k < 3; k++) wall[i + k] = p[k] * cos + x[k] * sin + u[k] * dot * (1 - cos)
    }
    const g = buildMeshGraph({ kind: 'soup', positions: wall })
    const c = meshCentroid(g.positions, g.indices)
    expect(c.closed).toBe(false)
    expect(c.volume).toBeNull()
  })
})
