// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { meshCentroid } from '../../../src/core/geometry/centroid'
import { boundaryLoops, halfEdges } from '../core/boundary'
import { cutMesh, cutPreview } from '../core/cut'
import { compactEdit, composeVertexMaps, markedTriangles, summarizeCopyDeviation } from '../core/edit'
import { flipTriangles } from '../core/flip'
import { tetraVolume6 } from '../../../src/core/geometry/centroid'
import { defaultHoleSize, fillHoles, surveyHoles } from '../core/fillHoles'
import { withoutTriangles } from '../core/pieces'
import { defaultSmoothLimit, defaultSmoothSize, meanEdgeLength, smoothMesh } from '../core/smooth'
import type { MeshGraph } from '../../../src/core/types'
import { boxMesh, icosphere } from '../../../tests/helpers'

// Kernel builds and real-scan fits run long, and longer on a slow machine.
vi.setConfig({ testTimeout: 180_000 })

const box = (size = 10, grid = 4, noise = 0): MeshGraph => buildMeshGraph({ kind: 'soup', positions: boxMesh(size, grid, noise) })

/** The mesh without the triangles `drop` says, as a graph again. */
function without(g: { positions: Float32Array; indices: Uint32Array; vertexCount: number }, drop: (cx: number, cy: number, cz: number) => boolean) {
  const mask = new Uint8Array(g.indices.length / 3)
  for (let t = 0; t < mask.length; t++) {
    let cx = 0, cy = 0, cz = 0
    for (let k = 0; k < 3; k++) {
      const v = g.indices[t * 3 + k] * 3
      cx += g.positions[v] / 3
      cy += g.positions[v + 1] / 3
      cz += g.positions[v + 2] / 3
    }
    mask[t] = drop(cx, cy, cz) ? 1 : 0
  }
  const kept = withoutTriangles(g.positions, g.indices, g.vertexCount, mask)
  return { positions: kept.positions, indices: kept.indices, vertexCount: kept.positions.length / 3 }
}

/** Every open edge of the mesh, counted — zero for a closed one. */
function openEdges(indices: Uint32Array, vertexCount: number): number {
  const he = halfEdges(indices, vertexCount)
  let open = 0
  for (let a = 0; a < vertexCount; a++) {
    for (let h = he.offsets[a]; h < he.offsets[a + 1]; h++) {
      const b = he.to[h]
      let back = false
      for (let k = he.offsets[b]; k < he.offsets[b + 1]; k++) if (he.to[k] === a) back = true
      if (!back) open++
    }
  }
  return open
}

/** A tube standing on the XY plane, wound outward: outer radius R, bore r,
 *  height h, m segments round and `rings` bands up. */
function tube(R: number, r: number, h: number, m = 32, rings = 6): { positions: Float32Array; indices: Uint32Array; vertexCount: number } {
  const pos: number[] = []
  const idx: number[] = []
  const at = (radius: number, i: number, z: number) => {
    const a = (2 * Math.PI * i) / m
    pos.push(radius * Math.cos(a), radius * Math.sin(a), z)
    return pos.length / 3 - 1
  }
  const outer: number[][] = []
  const inner: number[][] = []
  for (let k = 0; k <= rings; k++) {
    const z = (h * k) / rings
    outer.push(Array.from({ length: m }, (_, i) => at(R, i, z)))
    inner.push(Array.from({ length: m }, (_, i) => at(r, i, z)))
  }
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m
      // Outer wall faces out, the bore's wall faces into the bore.
      idx.push(outer[k][i], outer[k][j], outer[k + 1][j], outer[k][i], outer[k + 1][j], outer[k + 1][i])
      idx.push(inner[k][i], inner[k + 1][j], inner[k][j], inner[k][i], inner[k + 1][i], inner[k + 1][j])
    }
  }
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    // Top ring faces up, bottom ring down.
    idx.push(outer[rings][i], outer[rings][j], inner[rings][j], outer[rings][i], inner[rings][j], inner[rings][i])
    idx.push(outer[0][i], inner[0][j], outer[0][j], outer[0][i], inner[0][i], inner[0][j])
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), vertexCount: pos.length / 3 }
}

describe('the rims of a mesh', () => {
  it('finds none on a closed mesh, and one loop round a hole, walked the way the triangles walk it', () => {
    const closed = box()
    expect(boundaryLoops(closed.indices, closed.vertexCount).loops).toHaveLength(0)

    // The top face taken off: one rim, 4 × 4 edges round.
    const open = without(box(), (_x, _y, z) => z > 4.99)
    const { loops, stray } = boundaryLoops(open.indices, open.vertexCount)
    expect(stray).toBe(0)
    expect(loops).toHaveLength(1)
    expect(loops[0].vertices).toHaveLength(16)
    // Each rim edge is had by one triangle, in the loop's direction, with
    // the opposite corner as its third.
    const loop = loops[0]
    for (let i = 0; i < loop.vertices.length; i++) {
      const a = loop.vertices[i]
      const b = loop.vertices[(i + 1) % loop.vertices.length]
      let found = 0
      for (let t = 0; t < open.indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          if (open.indices[t + k] === a && open.indices[t + ((k + 1) % 3)] === b) {
            found++
            expect(open.indices[t + ((k + 2) % 3)]).toBe(loop.opposite[i])
          }
        }
      }
      expect(found).toBe(1)
    }
  })
})

describe('cutting with a plane', () => {
  it('takes off the side the normal points to and closes the part flat', () => {
    const g = box(10, 4)
    const cut = cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 1], [0, 0, 1], true)
    expect(cut.report.capped).toBe(1)
    expect(cut.report.open).toBe(0)
    expect(cut.report.removed).toBeGreaterThan(0)
    const n = cut.positions.length / 3
    for (let v = 0; v < n; v++) expect(cut.positions[v * 3 + 2]).toBeLessThanOrEqual(1 + 1e-5)
    expect(openEdges(cut.indices, n)).toBe(0)
    // A closed box 10 × 10 × 6, facing out: the volume says so.
    const c = meshCentroid(cut.positions, cut.indices)
    expect(c.closed).toBe(true)
    expect(c.volumeMm3).toBeCloseTo(600, 3)
    expect(c.volume![2]).toBeCloseTo(-2, 4)
  })

  it('keeps every old vertex it keeps under its new number, in order', () => {
    const g = box(10, 4)
    const cut = cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 1], [0, 0, 1], true)
    let last = -1
    for (let v = 0; v < g.vertexCount; v++) {
      const w = cut.vertexMap[v]
      if (g.positions[v * 3 + 2] > 1) {
        expect(w).toBe(-1)
        continue
      }
      expect(w).toBeGreaterThan(last)
      last = w
      for (let k = 0; k < 3; k++) expect(cut.positions[w * 3 + k]).toBeCloseTo(g.positions[v * 3 + k], 5)
    }
  })

  it('closes a tube cut across with a ring, the bore left open', () => {
    const t = tube(10, 6, 20)
    const cut = cutMesh(t.positions, t.indices, t.vertexCount, [0, 0, 10.5], [0, 0, 1], true)
    expect(cut.report.capped).toBe(1)
    const n = cut.positions.length / 3
    expect(openEdges(cut.indices, n)).toBe(0)
    const c = meshCentroid(cut.positions, cut.indices)
    expect(c.closed).toBe(true)
    // The 32-gon ring's area times the height kept.
    const ring = 0.5 * 32 * Math.sin((2 * Math.PI) / 32) * (100 - 36)
    expect(c.volumeMm3).toBeCloseTo(ring * 10.5, 1)
  })

  it('leaves the rim open without a cap, and says where it could not close', () => {
    const g = box(10, 4)
    const bare = cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 1], [0, 0, 1], false)
    expect(bare.report.capped).toBe(0)
    expect(boundaryLoops(bare.indices, bare.positions.length / 3).loops).toHaveLength(1)

    // A box open at the side the cut crosses: the rim is a stretch, not a loop.
    const open = without(box(10, 4), (x) => x > 4.99)
    const cut = cutMesh(open.positions, open.indices, open.vertexCount, [0, 0, 1], [0, 0, 1], true)
    expect(cut.report.capped).toBe(0)
    expect(cut.report.open).toBe(1)
  })

  it('bridges a hole in the wall at the cut, so the face still closes, and leaves the rest of it to fill', () => {
    // A hole 2.5 mm across in the +X wall, the plane through the middle of it.
    const holed = without(box(10, 8), (x, y, z) => x > 4.99 && Math.abs(y) < 1.3 && Math.abs(z - 1) < 1.3)
    const cut = cutMesh(holed.positions, holed.indices, holed.vertexCount, [0, 0, 1], [0, 0, 1], true)
    expect(cut.report).toMatchObject({ capped: 1, bridged: 1, open: 0 })
    const n = cut.positions.length / 3
    const rims = boundaryLoops(cut.indices, n).loops
    expect(rims).toHaveLength(1)
    const filled = fillHoles(cut.positions, cut.indices, n, 5, 'flat')
    expect(openEdges(filled.indices, filled.positions.length / 3)).toBe(0)
    const c = meshCentroid(filled.positions, filled.indices)
    expect(c.closed).toBe(true)
    expect(c.volumeMm3).toBeCloseTo(600, 0)
  })

  it('previews the cap the cut will make, and what of the cut it leaves open', () => {
    const g = box(10, 4)
    const p = cutPreview(g.positions, g.indices, g.vertexCount, [0, 0, 1], [0, 0, 1])
    expect(p).toMatchObject({ cuts: true, capped: 1, openStretches: 0, bridged: 0 })
    let area = 0
    for (let t = 0; t < p.cap.length; t += 9) {
      const u = [0, 1, 2].map((k) => p.cap[t + 3 + k] - p.cap[t + k])
      const v = [0, 1, 2].map((k) => p.cap[t + 6 + k] - p.cap[t + k])
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2
      for (let k = 0; k < 3; k++) expect(p.cap[t + k * 3 + 2]).toBeCloseTo(1, 5)
    }
    expect(area).toBeCloseTo(100, 3)
    expect(p.cap.length / 9).toBe(cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 1], [0, 0, 1], true).report.capTriangles)

    // A box without one wall is open across the plane: nothing closes, and
    // the rim is handed back to be drawn.
    const open = without(box(10, 4), (_x, y) => y > 4.99)
    const q = cutPreview(open.positions, open.indices, open.vertexCount, [0, 0, 1], [0, 0, 1])
    expect(q).toMatchObject({ cuts: true, capped: 0, openStretches: 1 })
    expect(q.cap.length).toBe(0)
    expect(q.open.length).toBeGreaterThan(0)

    expect(cutPreview(g.positions, g.indices, g.vertexCount, [0, 0, 20], [0, 0, 1]).cuts).toBe(false)
  })

  it('refuses a plane that takes nothing, or everything', () => {
    const g = box(10, 4)
    expect(() => cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, 20], [0, 0, 1], true)).toThrow(/cuts nothing/)
    expect(() => cutMesh(g.positions, g.indices, g.vertexCount, [0, 0, -20], [0, 0, 1], true)).toThrow(/Nothing of the scan/)
  })

  it.each([-20, 20])('transfers an empty preview when the plane at Z %s does not cross the scan', (z) => {
    const g = box()
    const preview = cutPreview(g.positions, g.indices, g.vertexCount, [0, 0, z], [0, 0, 1])
    const received = structuredClone(preview, { transfer: [preview.cap.buffer, preview.open.buffer] })
    expect(received.cuts).toBe(false)
    expect(received.cap).toHaveLength(0)
    expect(received.open).toHaveLength(0)
  })
})

describe('filling holes', () => {
  /** A ball of radius 10 with a cap cut off its top, 7 across. */
  const holedBall = () => {
    const s = icosphere(4, 10)
    return without({ ...s, vertexCount: s.positions.length / 3 }, (_x, _y, z) => z > 9.3)
  }

  it('starts at a twentieth of the part, on 1-2-5 steps', () => {
    expect(defaultHoleSize(170)).toBe(10)
    expect(defaultHoleSize(300)).toBe(20)
  })

  it('finds the holes under the size and leaves the larger rims open', () => {
    const g = holedBall()
    const small = surveyHoles(g.positions, g.indices, g.vertexCount, 5)
    expect(small.survey).toMatchObject({ rims: 1, holes: 0 })
    expect(small.survey.smallestOpen).toBeGreaterThan(6)
    const large = surveyHoles(g.positions, g.indices, g.vertexCount, 10)
    expect(large.survey).toMatchObject({ rims: 1, holes: 1 })
    expect(large.marks.centres).toHaveLength(3)
    expect(large.marks.holes.length).toBeGreaterThan(0)
    expect(() => fillHoles(g.positions, g.indices, g.vertexCount, 5, 'curved')).toThrow(/No hole/)
  })

  it('closes a hole in a ball with a patch that carries the ball across it', () => {
    const g = holedBall()
    const filled = fillHoles(g.positions, g.indices, g.vertexCount, 10, 'curved')
    expect(filled.report).toMatchObject({ filled: 1, failed: 0, left: 0 })
    const n = filled.positions.length / 3
    expect(openEdges(filled.indices, n)).toBe(0)
    // The patch is refined to the ball's density and bulges out with it.
    expect(filled.report.vertices).toBeGreaterThan(5)
    let top = 0
    for (let v = g.vertexCount; v < n; v++) {
      const r = Math.hypot(filled.positions[v * 3], filled.positions[v * 3 + 1], filled.positions[v * 3 + 2])
      expect(r).toBeGreaterThan(9.3)
      expect(r).toBeLessThan(10.3)
      top = Math.max(top, filled.positions[v * 3 + 2])
    }
    expect(top).toBeGreaterThan(9.7)
    // Closed and facing out, it holds the ball's volume.
    const c = meshCentroid(filled.positions, filled.indices)
    expect(c.closed).toBe(true)
    expect(c.volumeMm3).toBeGreaterThan(0.98 * (4 / 3) * Math.PI * 1000)
    // The scan's own vertices are untouched and keep their numbers.
    for (let v = 0; v < g.vertexCount; v++) {
      expect(filled.vertexMap[v]).toBe(v)
      for (let k = 0; k < 3; k++) expect(filled.positions[v * 3 + k]).toBe(g.positions[v * 3 + k])
    }
  })

  it('lays a flat patch across a hole in a flat face', () => {
    const g = without(box(10, 8), (x, y, z) => z > 4.99 && Math.abs(x) < 2.4 && Math.abs(y) < 2.4)
    for (const mode of ['flat', 'curved'] as const) {
      const filled = fillHoles(g.positions, g.indices, g.vertexCount, 8, mode)
      expect(filled.report.filled).toBe(1)
      const n = filled.positions.length / 3
      expect(openEdges(filled.indices, n)).toBe(0)
      for (let v = g.vertexCount; v < n; v++) expect(filled.positions[v * 3 + 2]).toBeCloseTo(5, 3)
      const c = meshCentroid(filled.positions, filled.indices)
      expect(c.volumeMm3).toBeCloseTo(1000, 2)
    }
  })

  it('fills only the hole whose ring was clicked', () => {
    const g = without(box(20, 20), (x, y, z) => z > 9.99 && (Math.hypot(x - 5, y) < 1.6 || Math.hypot(x + 5, y) < 1.6))
    const before = surveyHoles(g.positions, g.indices, g.vertexCount, 5)
    expect(before.survey.holes).toBe(2)
    const c = before.marks.centres
    const filled = fillHoles(g.positions, g.indices, g.vertexCount, 5, 'flat', undefined, [c[0], c[1], c[2]])
    expect(filled.report.filled).toBe(1)
    const after = surveyHoles(filled.positions, filled.indices, filled.positions.length / 3, 5)
    expect(after.survey.holes).toBe(1)
    // The one left is the other one.
    expect(Math.hypot(after.marks.centres[0] - c[3], after.marks.centres[1] - c[4])).toBeLessThan(1e-4)
  })

  it('fills a long rim by laying it flat', () => {
    // A 64-gon hole in a finely meshed face, with more rim than the search
    // takes on.
    const g = without(box(40, 160), (x, y, z) => z > 19.99 && Math.hypot(x, y) < 12)
    const holes = surveyHoles(g.positions, g.indices, g.vertexCount, 30)
    expect(holes.survey.holes).toBe(1)
    const filled = fillHoles(g.positions, g.indices, g.vertexCount, 30, 'curved')
    expect(filled.report).toMatchObject({ filled: 1, failed: 0 })
    const n = filled.positions.length / 3
    expect(openEdges(filled.indices, n)).toBe(0)
    for (let v = g.vertexCount; v < n; v++) expect(filled.positions[v * 3 + 2]).toBeCloseTo(20, 2)
  })
})

/** A square sheet of `n` × `n` cells `step` apart, its height `z(x, y)`. */
function sheet(n: number, step: number, z: (x: number, y: number) => number) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3)
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3
      positions.set([i * step, j * step, z(i * step, j * step)], k)
    }
  }
  const idx: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i
      idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1)
    }
  }
  return { positions, indices: Uint32Array.from(idx), vertexCount: (n + 1) * (n + 1) }
}

describe('smoothing', () => {
  it('starts at the orange peel of a scan, its limit well past the scatter of a good one', () => {
    expect(defaultSmoothSize(250)).toBe(2)
    expect(defaultSmoothSize(100)).toBe(1)
    // A coarse mesh: a patch needs a few of its edges to have points to fit.
    expect(defaultSmoothSize(100, 0.6)).toBe(2)
    expect(defaultSmoothLimit(170)).toBe(0.2)
    const g = box(10, 20)
    expect(meanEdgeLength(g.positions, g.indices)).toBeCloseTo((0.5 + 0.5 + Math.SQRT1_2) / 3, 3)
  })

  it('takes out bumps smaller than the size and leaves the shape larger than it', () => {
    const n = 120
    const step = 0.25
    // The height's RMS over the middle, away from the sheet's rim.
    const rms = (p: Float32Array) => {
      let sq = 0
      let count = 0
      for (let j = 20; j <= n - 20; j++) {
        for (let i = 20; i <= n - 20; i++) {
          sq += p[(j * (n + 1) + i) * 3 + 2] ** 2
          count++
        }
      }
      return Math.sqrt(sq / count)
    }
    const wave = (length: number) =>
      sheet(n, step, (x, y) => 0.05 * Math.sin((2 * Math.PI * x) / length) * Math.sin((2 * Math.PI * y) / length))
    const fine = wave(1)
    const smoothedFine = smoothMesh(fine.positions, fine.indices, fine.vertexCount, { size: 1, limit: 1, keepEdges: true })
    expect(rms(smoothedFine.positions)).toBeLessThan(rms(fine.positions) * 0.05)
    const broad = wave(8)
    const smoothedBroad = smoothMesh(broad.positions, broad.indices, broad.vertexCount, { size: 1, limit: 1, keepEdges: true })
    expect(rms(smoothedBroad.positions)).toBeGreaterThan(rms(broad.positions) * 0.9)
  })

  it('does not shrink a sphere', () => {
    const r = 5
    const ball = icosphere(5, r, 0.01)
    const n = ball.positions.length / 3
    const s = smoothMesh(ball.positions, ball.indices, n, { size: 1, limit: 0.1, keepEdges: true })
    const spread = (p: Float32Array) => {
      let mean = 0
      let sq = 0
      for (let v = 0; v < n; v++) {
        const d = Math.hypot(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])
        mean += d / n
        sq += (d - r) ** 2 / n
      }
      return { mean, rms: Math.sqrt(sq) }
    }
    const after = spread(s.positions)
    expect(Math.abs(after.mean - r)).toBeLessThan(0.002)
    expect(after.rms).toBeLessThan(spread(ball.positions).rms / 2)
  })

  it('takes the scatter out of a face, never moves a vertex past the limit, and keeps the edges', () => {
    const noisy = box(10, 20, 0.02)
    const limit = 0.05
    const s = smoothMesh(noisy.positions, noisy.indices, noisy.vertexCount, { size: 1.5, limit, keepEdges: true })
    const rmsTop = (p: Float32Array) => {
      let sq = 0
      let n = 0
      for (let v = 0; v < noisy.vertexCount; v++) {
        const x = noisy.positions[v * 3], y = noisy.positions[v * 3 + 1], z = noisy.positions[v * 3 + 2]
        if (Math.abs(x) > 4.9 || Math.abs(y) > 4.9 || z < 4.8) continue
        sq += (p[v * 3 + 2] - 5) ** 2
        n++
      }
      return Math.sqrt(sq / n)
    }
    expect(rmsTop(s.positions)).toBeLessThan(rmsTop(noisy.positions) / 2)
    for (let v = 0; v < noisy.vertexCount; v++) {
      const d = Math.hypot(
        s.positions[v * 3] - noisy.positions[v * 3],
        s.positions[v * 3 + 1] - noisy.positions[v * 3 + 1],
        s.positions[v * 3 + 2] - noisy.positions[v * 3 + 2],
      )
      expect(d).toBeLessThanOrEqual(limit + 1e-6)
      // The box's edges are sharp, and left as they were.
      const onEdge = [0, 1, 2].filter((k) => Math.abs(Math.abs(noisy.positions[v * 3 + k]) - 5) < 0.1).length >= 2
      if (onEdge) expect(d).toBe(0)
    }
    expect(s.report.maxMove).toBeLessThanOrEqual(limit + 1e-6)
    expect(s.report.held).toBeGreaterThan(0)
    expect(Array.from(s.vertexMap)).toEqual(Array.from({ length: noisy.vertexCount }, (_, v) => v))
  })

  it('keeps a ridge sharp with the edges kept, and rounds it without', () => {
    const ridge = sheet(80, 0.25, (x) => -Math.abs(x - 10))
    const top = (40 * 81 + 40) * 3 + 2
    const kept = smoothMesh(ridge.positions, ridge.indices, ridge.vertexCount, { size: 1, limit: 1, keepEdges: true })
    expect(kept.positions[top]).toBeCloseTo(0, 6)
    const rounded = smoothMesh(ridge.positions, ridge.indices, ridge.vertexCount, { size: 1, limit: 1, keepEdges: false })
    expect(rounded.positions[top]).toBeLessThan(-0.05)
  })

  it('smooths a marked region alone, fading out to nothing at its edge', () => {
    let seed = 3
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04
    const n = 80
    const noisy = sheet(n, 0.25, () => noise())
    const at = (i: number, j: number) => j * (n + 1) + i
    // A band across the middle: x from 5 to 15 mm.
    const region: number[] = []
    for (let j = 0; j <= n; j++) for (let i = 20; i <= 60; i++) region.push(at(i, j))
    const s = smoothMesh(noisy.positions, noisy.indices, noisy.vertexCount, {
      size: 1,
      limit: 1,
      keepEdges: false,
      region: Uint32Array.from(region),
    })
    expect(s.report.region).toBe(region.length)
    const z = (p: Float32Array, i: number, j: number) => p[at(i, j) * 3 + 2]
    let outside = 0
    let core = 0
    let coreBefore = 0
    let edge = 0
    let edgeBefore = 0
    for (let j = 10; j <= n - 10; j++) {
      for (const i of [0, 10, 19, 61, 70]) outside = Math.max(outside, Math.abs(z(s.positions, i, j) - z(noisy.positions, i, j)))
      for (let i = 36; i <= 44; i++) {
        core += z(s.positions, i, j) ** 2
        coreBefore += z(noisy.positions, i, j) ** 2
      }
      edge += Math.abs(z(s.positions, 20, j) - z(noisy.positions, 20, j))
      edgeBefore += Math.abs(z(noisy.positions, 20, j))
    }
    expect(outside).toBe(0)
    expect(Math.sqrt(core)).toBeLessThan(Math.sqrt(coreBefore) * 0.3)
    // The row at the edge, a quarter of the size in, moves by a small share
    // of its scatter.
    expect(edge).toBeLessThan(edgeBefore * 0.3)
    expect(() => smoothMesh(noisy.positions, noisy.indices, noisy.vertexCount, { size: 1, limit: 1, keepEdges: false, region: new Uint32Array(0) })).toThrow(/Nothing is marked/)
  })

  it('does not pull an open border in along the surface', () => {
    const open = without(box(10, 8, 0.02), (_x, _y, z) => z > 4.99)
    const s = smoothMesh(open.positions, open.indices, open.vertexCount, { size: 2, limit: 0.05, keepEdges: false })
    const rim = boundaryLoops(open.indices, open.vertexCount).loops[0].vertices
    for (const v of rim) expect(Math.abs(s.positions[v * 3 + 2] - open.positions[v * 3 + 2])).toBeLessThan(0.01)
  })
})

describe('the marked surface', () => {
  it('takes the triangles with all three corners marked', () => {
    const g = box(10, 4)
    const top: number[] = []
    for (let v = 0; v < g.vertexCount; v++) if (g.positions[v * 3 + 2] > 4.99) top.push(v)
    const { mask, count } = markedTriangles(g.indices, Uint32Array.from(top), g.vertexCount)
    expect(count).toBe(4 * 4 * 2)
    const kept = withoutTriangles(g.positions, g.indices, g.vertexCount, mask)
    expect(boundaryLoops(kept.indices, kept.positions.length / 3).loops).toHaveLength(1)
  })

  it('compacts an edit onto the vertices it uses, old ones first in order', () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 9, 9, 9])
    const edited = compactEdit(positions, Uint32Array.from([0, 3, 4, 3, 1, 4]), 4)
    expect(Array.from(edited.vertexMap)).toEqual([0, 1, -1, 2])
    expect(Array.from(edited.indices)).toEqual([0, 2, 3, 2, 1, 3])
    expect(Array.from(edited.positions.slice(9))).toEqual([9, 9, 9])
  })
})

describe('flipping normals', () => {
  /** The volume the winding encloses — negative for a closed mesh turned
   *  inside-out. */
  const volume = (positions: Float32Array, indices: Uint32Array) => {
    let six = 0
    for (let t = 0; t < indices.length; t += 3) six += tetraVolume6(positions, indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3)
    return six / 6
  }

  it('turns every triangle over, nothing moved and every vertex its own number', () => {
    const g = box(10, 4)
    const before = g.indices.slice()
    const f = flipTriangles(g.positions, g.indices, g.vertexCount)
    expect(f.flipped).toBe(g.triangleCount)
    expect(volume(g.positions, g.indices)).toBeCloseTo(1000, 3)
    expect(volume(f.positions, f.indices)).toBeCloseTo(-1000, 3)
    expect(Array.from(f.positions)).toEqual(Array.from(g.positions))
    expect(Array.from(f.vertexMap)).toEqual(Array.from({ length: g.vertexCount }, (_, v) => v))
    // Each triangle on the same corners, wound the other way; the mesh the
    // worker holds untouched.
    for (let t = 0; t < before.length; t += 3) {
      expect([f.indices[t], f.indices[t + 1], f.indices[t + 2]]).toEqual([before[t], before[t + 2], before[t + 1]])
    }
    expect(Array.from(g.indices)).toEqual(Array.from(before))
    // Twice is as it was.
    expect(Array.from(flipTriangles(f.positions, f.indices, g.vertexCount).indices)).toEqual(Array.from(before))
  })

  it('turns over only the marked triangles', () => {
    const g = box(10, 4)
    const top: number[] = []
    for (let v = 0; v < g.vertexCount; v++) if (g.positions[v * 3 + 2] > 4.99) top.push(v)
    const { mask, count } = markedTriangles(g.indices, Uint32Array.from(top), g.vertexCount)
    const f = flipTriangles(g.positions, g.indices, g.vertexCount, mask)
    expect(f.flipped).toBe(count)
    for (let t = 0; t < mask.length; t++) {
      const same = f.indices[t * 3 + 1] === g.indices[t * 3 + 1]
      expect(same).toBe(!mask[t])
    }
    // The top's normals point down now, every other face's as they were.
    const n = buildMeshGraph({ kind: 'indexed', positions: f.positions, indices: f.indices, keepWinding: true }).normals
    const centre = top.find((v) => Math.abs(g.positions[v * 3]) < 1e-6 && Math.abs(g.positions[v * 3 + 1]) < 1e-6)!
    expect(n[centre * 3 + 2]).toBeCloseTo(-1, 6)
  })
})

describe('the edited copy', () => {
  it('carries the scan\'s vertices through one edit after another', () => {
    // The first edit took vertex 1; the second took the copy's vertex 0 — the
    // scan's 0 — and moved the rest down.
    const first = Int32Array.from([0, -1, 1, 2])
    const second = Int32Array.from([-1, 0, 1, 2])
    expect(Array.from(composeVertexMaps(first, second))).toEqual([-1, -1, 0, 1])
  })

  it('sums its distance from the scan up, leaving out what an edit made', () => {
    const values = Float32Array.from([0.01, -0.02, 0.005, NaN, NaN, 0])
    const stats = summarizeCopyDeviation(values)
    expect(stats).toMatchObject({ measured: 4, added: 2 })
    expect(stats.maxAbs).toBeCloseTo(0.02, 6)
    expect(stats.rms).toBeCloseTo(Math.sqrt((0.01 ** 2 + 0.02 ** 2 + 0.005 ** 2) / 4), 6)
    expect(stats.range).toBe(0.02)
    // Nothing moved at all: the range still has a width to draw over.
    expect(summarizeCopyDeviation(new Float32Array(3)).range).toBe(0.001)
  })
})
