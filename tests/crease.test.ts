// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import {
  coplanarShare,
  creaseAngleOf,
  creaseBudget,
  creaseFor,
  creaseSetting,
  looksTessellated,
  scanRender,
  splitCreases,
  type CreaseSplit,
} from '../src/core/geometry/crease'
import { wireConflicts, wireSlots } from '../src/core/geometry/wireSlots'
import type { MeshGraph } from '../src/core/types'
import { boxMesh, cylinderMesh, icosphere } from './helpers'

/** A welded graph and its corner slots, as the worker hands them on. */
function welded(positions: Float32Array): { graph: MeshGraph; slots: Uint8Array } {
  const graph = buildMeshGraph({ kind: 'soup', positions })
  return { graph, slots: wireSlots(graph.adjOffsets, graph.adjList, graph.vertexCount) }
}

function indexed(positions: Float32Array, indices: Uint32Array): { graph: MeshGraph; slots: Uint8Array } {
  const graph = buildMeshGraph({ kind: 'indexed', positions, indices })
  return { graph, slots: wireSlots(graph.adjOffsets, graph.adjList, graph.vertexCount) }
}

function split(g: { graph: MeshGraph; slots: Uint8Array }): CreaseSplit {
  const s = splitCreases(g.graph.positions, g.graph.indices, g.slots)
  if (!s) throw new Error('split refused')
  return s
}

const unit = (n: Float32Array, v: number): [number, number, number] => [
  n[v * 3],
  n[v * 3 + 1],
  n[v * 3 + 2],
]

/** The unit normal of a triangle as wound. */
function faceNormal(p: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ab = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]]
  const ac = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]]
  const n = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ]
  const l = Math.hypot(n[0], n[1], n[2])
  return [n[0] / l, n[1] / l, n[2] / l]
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('crease split', () => {
  it('parts a cube at its corners and edges, each side with its own normal', () => {
    const g = welded(boxMesh(10, 4))
    const s = split(g)
    const n = g.graph.vertexCount
    // Corners meet three faces (two copies each), edge vertices two (one
    // copy), face interiors stay whole: 8·2 + 12·3·1.
    expect(s.copyOf.length).toBe(8 * 2 + 12 * 3)
    expect(s.positions.length / 3).toBe(n + s.copyOf.length)
    expect(s.indices.length).toBe(g.graph.indices.length)
    // Every corner of every triangle now wears exactly that triangle's normal.
    for (let t = 0; t < s.indices.length; t += 3) {
      const [a, b, c] = [s.indices[t], s.indices[t + 1], s.indices[t + 2]]
      const fn = faceNormal(s.positions, a, b, c)
      for (const v of [a, b, c]) expect(dot(unit(s.normals, v), fn)).toBeCloseTo(1, 6)
    }
    // A copy sits exactly where its vertex does and wears its corner slot.
    for (let k = 0; k < s.copyOf.length; k++) {
      const v = s.copyOf[k], d = n + k
      expect(v).toBeLessThan(n)
      expect([s.positions[d * 3], s.positions[d * 3 + 1], s.positions[d * 3 + 2]]).toEqual([
        s.positions[v * 3],
        s.positions[v * 3 + 1],
        s.positions[v * 3 + 2],
      ])
      expect(s.wireSlots[d]).toBe(g.slots[v])
    }
    // The mesh's own vertices are untouched, in their order.
    expect(s.positions.subarray(0, n * 3)).toEqual(g.graph.positions)
    // And the mesh mode still draws every edge.
    expect(wireConflicts(s.indices, s.wireSlots)).toBe(0)
  })

  it('leaves a smooth surface alone', () => {
    const { positions, indices } = icosphere(4, 10)
    const g = indexed(positions, indices)
    const s = split(g)
    expect(s.copyOf.length).toBe(0)
    expect(s.normals).toEqual(g.graph.normals)
    expect(s.indices).toEqual(g.graph.indices)
  })

  it('parts a cylinder only along its rims, keeping the wall smooth', () => {
    const radial = 48
    const g = welded(cylinderMesh(5, 20, radial, 6).positions)
    const s = split(g)
    // Each rim vertex is on the wall and on a cap: one copy each, 2 rims.
    expect(s.copyOf.length).toBe(2 * radial)
    const n = g.graph.vertexCount
    // Every copy is a cap normal or a wall normal — never a blend.
    for (let k = 0; k < s.copyOf.length; k++) {
      const [x, y, z] = unit(s.normals, n + k)
      const axial = Math.abs(z)
      const radialN = Math.hypot(x, y)
      expect(Math.max(axial, radialN)).toBeCloseTo(1, 3)
    }
    // Wall triangles keep smooth shading: each corner's normal is radial,
    // and neighbouring corners around the wall differ by one facet.
    for (let t = 0; t < s.indices.length; t += 3) {
      const fn = faceNormal(s.positions, s.indices[t], s.indices[t + 1], s.indices[t + 2])
      if (Math.abs(fn[2]) > 0.5) continue // a cap
      for (const v of [s.indices[t], s.indices[t + 1], s.indices[t + 2]]) {
        const nv = unit(s.normals, v)
        expect(Math.abs(nv[2])).toBeLessThan(1e-6)
        expect(dot(nv, fn)).toBeGreaterThan(Math.cos((2 * Math.PI) / radial))
      }
    }
  })

  it('refuses a split past the budget', () => {
    const g = welded(boxMesh(10, 4))
    expect(splitCreases(g.graph.positions, g.graph.indices, g.slots, 30, 10)).toBeNull()
    expect(splitCreases(g.graph.positions, g.graph.indices, g.slots, 30, 52)).not.toBeNull()
  })

  it('bounds the budget at doubling the mesh, and lets a small one through whole', () => {
    expect(creaseBudget(100)).toBe(250_000)
    expect(creaseBudget(2_000_000)).toBe(2_000_000)
  })
})

describe('telling a tessellation from a scan', () => {
  it('sees the coplanar triangles of a CAD box', () => {
    const g = welded(boxMesh(10, 4))
    // Inside each face every edge is flat; only the twelve cube edges are not.
    expect(coplanarShare(g.graph.positions, g.graph.indices)).toBeGreaterThan(0.8)
    expect(looksTessellated(g.graph.positions, g.graph.indices)).toBe(true)
  })

  it('sees no flats on a noisy scan of the same box, nor on a ball', () => {
    const g = welded(boxMesh(10, 20, 0.02))
    expect(coplanarShare(g.graph.positions, g.graph.indices)).toBeLessThan(0.05)
    expect(looksTessellated(g.graph.positions, g.graph.indices)).toBe(false)
    const ball = icosphere(4, 10)
    expect(coplanarShare(ball.positions, ball.indices)).toBe(0)
  })

  it('under Auto splits the box and leaves the scan alone; On and Off do as told', () => {
    const cad = welded(boxMesh(10, 4))
    const scan = welded(boxMesh(10, 20, 0.05))
    const auto = creaseFor('auto', cad.graph.positions, cad.graph.indices, cad.slots)
    expect(auto.split).not.toBeNull()
    expect(auto.report).toEqual({ added: 8 * 2 + 12 * 3, skipped: null })
    const kept = creaseFor('auto', scan.graph.positions, scan.graph.indices, scan.slots)
    expect(kept.split).toBeNull()
    expect(kept.report).toEqual({ added: 0, skipped: 'scan' })
    const forced = creaseFor('on', scan.graph.positions, scan.graph.indices, scan.slots)
    expect(forced.split).not.toBeNull()
    expect(forced.report.skipped).toBeNull()
    const off = creaseFor('off', cad.graph.positions, cad.graph.indices, cad.slots)
    expect(off.split).toBeNull()
    expect(off.report).toEqual({ added: 0, skipped: 'off' })
  })
})

describe('the angle an edge is sharp from', () => {
  // A scan of a box: noise tips its triangles some degrees against each
  // other everywhere, its own edges stand at 90°. Twelve edges of 19 inner
  // vertices, each parted once, and eight corners, each into three.
  const edges = 12 * 19 + 8 * 2

  it('splits a scan’s own edges and leaves its noise smooth from an angle the noise does not reach', () => {
    const scan = welded(boxMesh(10, 20, 0.05))
    const at = (deg: number) => creaseFor('on', scan.graph.positions, scan.graph.indices, scan.slots, deg).report.added
    expect(at(60)).toBe(edges)
    expect(at(30)).toBeGreaterThanOrEqual(edges)
    // Well past the box's own edges nothing is sharp.
    expect(at(120)).toBe(0)
  })

  it('lays the scan out at the angle asked for', () => {
    const scan = welded(boxMesh(10, 20, 0.05))
    const r = scanRender(scan.graph, creaseSetting({ creaseMode: 'on', creaseAngle: 60 }))
    expect(r.copyOf.length).toBe(edges)
    expect(r.positions.length).toBe((scan.graph.vertexCount + edges) * 3)
    expect(r.crease).toEqual({ added: edges, skipped: null })
    const off = scanRender(scan.graph, { mode: 'off', angleDeg: 60 })
    expect(off.copyOf.length).toBe(0)
    expect(off.indices).toEqual(scan.graph.indices)
  })

  it('takes a stored angle in range, and the default for anything that is not one', () => {
    expect(creaseAngleOf(null)).toBe(30)
    expect(creaseAngleOf('')).toBe(30)
    expect(creaseAngleOf('abc')).toBe(30)
    expect(creaseAngleOf('45')).toBe(45)
    expect(creaseAngleOf(60)).toBe(60)
    expect(creaseAngleOf(1)).toBe(5)
    expect(creaseAngleOf(500)).toBe(120)
  })
})
