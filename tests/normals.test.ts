// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import type { ParsedMesh } from '../src/core/types'

const TETRA_POSITIONS = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
/** Outward winding: every face normal points away from the enclosed volume. */
const TETRA_OUTWARD = Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
/** Same faces, each reversed — an inside-out export. */
const TETRA_INWARD = Uint32Array.from([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2])

function apexNormalZ(indices: Uint32Array): number {
  const mesh: ParsedMesh = { kind: 'indexed', positions: TETRA_POSITIONS, indices }
  const graph = buildMeshGraph(mesh)
  // Vertex 3 sits at the +z apex, so its outward normal must have positive z.
  return graph.normals[3 * 3 + 2]
}

describe('scan normal orientation', () => {
  it('keeps a correctly wound closed mesh as it is', () => {
    expect(apexNormalZ(TETRA_OUTWARD)).toBeGreaterThan(0)
  })

  it('flips the normals of an inside-out closed mesh', () => {
    expect(apexNormalZ(TETRA_INWARD)).toBeGreaterThan(0)
  })

  it('leaves an open sheet exactly as wound', () => {
    // A flat quad wound so its normals face -z. There is no enclosed volume,
    // so there is nothing to decide by — the winding stands.
    const mesh: ParsedMesh = {
      kind: 'indexed',
      positions: Float32Array.from([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 2, 1, 3]),
    }
    const graph = buildMeshGraph(mesh)
    for (let v = 0; v < 4; v++) expect(graph.normals[v * 3 + 2]).toBeLessThan(0)
  })
})
