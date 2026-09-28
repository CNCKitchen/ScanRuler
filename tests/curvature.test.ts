// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { curvatureRange, meanCurvature } from '../src/core/geometry/curvature'
import { boxMesh, cylinderMesh, icosphere } from './helpers'

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

describe('mean curvature per vertex', () => {
  it('reads 1/R on a ball, convex positive, without smoothing', () => {
    const ball = icosphere(4, 10)
    const g = buildMeshGraph({ kind: 'indexed', positions: ball.positions, indices: ball.indices })
    const h = meanCurvature(g, 0)
    for (let v = 0; v < g.vertexCount; v++) expect(h[v]).toBeCloseTo(0.1, 2)
  })

  it('reads 1/2R on a cylinder wall and nothing on its caps', () => {
    const { positions } = cylinderMesh(5, 30, 64, 24)
    const g = buildMeshGraph({ kind: 'soup', positions })
    const h = meanCurvature(g, 0)
    const wall: number[] = []
    const cap: number[] = []
    for (let v = 0; v < g.vertexCount; v++) {
      const x = g.positions[v * 3], y = g.positions[v * 3 + 1], z = g.positions[v * 3 + 2]
      const r = Math.hypot(x, y)
      if (Math.abs(z) < 13 && Math.abs(r - 5) < 1e-3) wall.push(h[v])
      if (Math.abs(Math.abs(z) - 15) < 1e-3 && r < 4) cap.push(h[v])
    }
    expect(wall.length).toBeGreaterThan(100)
    for (const k of wall) expect(k).toBeCloseTo(0.1, 2)
    for (const k of cap) expect(Math.abs(k)).toBeLessThan(1e-6)
  })

  it('is negative inside a hollow: the same ball with its normals turned in', () => {
    const ball = icosphere(3, 10)
    const g = buildMeshGraph({ kind: 'indexed', positions: ball.positions, indices: ball.indices })
    for (let i = 0; i < g.normals.length; i++) g.normals[i] = -g.normals[i]
    const h = meanCurvature(g, 0)
    expect(h[0]).toBeCloseTo(-0.1, 2)
  })

  it('finds a noisy ball under its noise once smoothed, and not before', () => {
    // 0.02 mm of scatter on edges of about 0.7 mm: the raw reading is thrown
    // by more than the ball's own 0.1 /mm, the smoothed one is not.
    const ball = icosphere(5, 10, 0.02)
    const g = buildMeshGraph({ kind: 'indexed', positions: ball.positions, indices: ball.indices })
    const raw = Array.from(meanCurvature(g, 0))
    const smooth = Array.from(meanCurvature(g))
    const spread = (xs: number[]) => median(xs.map((x) => Math.abs(x - 0.1)))
    expect(spread(raw)).toBeGreaterThan(0.03)
    expect(spread(smooth)).toBeLessThan(0.01)
    expect(median(smooth)).toBeCloseTo(0.1, 2)
  })

  it('leaves the rim of an open surface unread', () => {
    // A flat square of four triangles round a middle vertex: the middle is
    // inside, the four corners are rim.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 0])
    const indices = new Uint32Array([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4])
    const g = buildMeshGraph({ kind: 'indexed', positions, indices })
    const h = meanCurvature(g, 2)
    expect(h[4]).toBeCloseTo(0, 9)
    for (let v = 0; v < 4; v++) expect(Number.isNaN(h[v])).toBe(true)
  })

  it('scales a block of flats by the part, not by its noise', () => {
    const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(40, 20, 0.005) })
    const h = meanCurvature(g)
    const size = 40 * Math.sqrt(3)
    expect(curvatureRange(h, size)).toBeGreaterThanOrEqual(2 / size)
    // A ball's own curvature is what nine vertices in ten stay under.
    const ball = icosphere(4, 10)
    const b = buildMeshGraph({ kind: 'indexed', positions: ball.positions, indices: ball.indices })
    expect(curvatureRange(meanCurvature(b), 20)).toBeCloseTo(0.1, 2)
  })
})
