// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAdjacency } from '../src/core/geometry/adjacency'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { WIRE_SLOT_COUNT, wireConflicts, wireSlots } from '../src/core/geometry/wireSlots'
import { parseSTL } from '../src/core/parsers/stl'
import { fixture } from './fixtures'
import { icosphere } from './helpers'

/** The mesh mode draws every edge of a triangle only if its three corners sit
 *  in three different slots. These pin that the colouring delivers that on
 *  the meshes that matter, and stays within the eight slots the shader has. */
describe('wire slots', () => {
  it('gives every triangle of a closed mesh three distinct corners', () => {
    const { positions, indices } = icosphere(4, 10)
    const vertexCount = positions.length / 3
    const { offsets, list } = buildAdjacency(indices, vertexCount)
    const slots = wireSlots(offsets, list, vertexCount)
    expect(slots.length).toBe(vertexCount)
    for (const s of slots) expect(s).toBeLessThan(WIRE_SLOT_COUNT)
    expect(wireConflicts(indices, slots)).toBe(0)
  })

  it('copes with an odd fan, where three colours would not do', () => {
    // A hub with seven spokes: around an odd ring, alternating two colours
    // meets itself, so at least one more is needed somewhere.
    const n = 7
    const tris: number[] = []
    for (let i = 0; i < n; i++) tris.push(0, 1 + i, 1 + ((i + 1) % n))
    const indices = Uint32Array.from(tris)
    const { offsets, list } = buildAdjacency(indices, n + 1)
    const slots = wireSlots(offsets, list, n + 1)
    expect(wireConflicts(indices, slots)).toBe(0)
  })

  it('shares a slot rather than failing when all eight are taken', () => {
    // Eight mutually adjacent vertices take all eight slots; a ninth joined
    // to every one of them has nowhere to go and must still get a slot.
    const k = WIRE_SLOT_COUNT
    const adj: number[][] = []
    for (let v = 0; v <= k; v++) adj.push([])
    for (let a = 0; a <= k; a++) {
      for (let b = 0; b <= k; b++) if (a !== b) adj[a].push(b)
    }
    const offsets = new Uint32Array(k + 2)
    for (let v = 0; v <= k; v++) offsets[v + 1] = offsets[v] + adj[v].length
    const list = Uint32Array.from(adj.flat())
    const slots = wireSlots(offsets, list, k + 1)
    for (let v = 0; v < k; v++) expect(slots[v]).toBe(v)
    expect(slots[k]).toBeLessThan(k)
  })

  const FILE = fixture('ballbar.stl')
  it.skipIf(!FILE.exists)('colours a real scan without a single conflict', () => {
    const buf = readFileSync(FILE.path)
    const parsed = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const graph = buildMeshGraph(parsed)
    const t0 = performance.now()
    const slots = wireSlots(graph.adjOffsets, graph.adjList, graph.vertexCount)
    const ms = performance.now() - t0
    console.log(
      `ballbar: ${graph.triangleCount} triangles coloured in ${ms.toFixed(0)} ms, ` +
        `${new Set(slots).size} slots used`,
    )
    expect(wireConflicts(graph.indices, slots)).toBe(0)
  })
})
