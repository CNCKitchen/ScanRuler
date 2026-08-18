// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import type { ParsedMesh } from '../src/core/types'

const TETRA_POSITIONS = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
/** Outward winding: every face normal points away from the enclosed volume. */
const TETRA_OUTWARD = Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
/** Same faces, each reversed — an inside-out export. */
const TETRA_INWARD = Uint32Array.from([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2])

/** Six times the signed volume enclosed by the winding — positive when the
 *  triangles wind outward. */
function signedVolume6(positions: Float32Array, indices: Uint32Array): number {
  let vol6 = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return vol6
}

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

  it('reverses the winding along with the normals', () => {
    // The viewer renders double-sided, where three.js takes the lit side from
    // the winding (gl_FrontFacing), not from the normal attribute. If only the
    // normals were flipped, an inside-out scan would render unlit everywhere.
    const mesh: ParsedMesh = { kind: 'indexed', positions: TETRA_POSITIONS, indices: TETRA_INWARD }
    const graph = buildMeshGraph(mesh)
    expect(signedVolume6(graph.positions, graph.indices)).toBeGreaterThan(0)
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
