// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { meshCentroid } from '../src/core/geometry/centroid'
import { boxMesh } from './helpers'

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
})
