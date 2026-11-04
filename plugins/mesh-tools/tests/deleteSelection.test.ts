// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { rigidApplyToPoints, rigidFromTwist } from '../../../src/core/deviation/rigid'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { scanRender } from '../../../src/core/geometry/crease'
import { parsePLY } from '../../../src/core/parsers/ply'
import { boxMesh } from '../../../tests/helpers'
import { deletionMask } from '../core/deleteSelection'
import { withoutTriangles } from '../core/pieces'
import { buildBinaryPly } from '../core/plyWriter'

const faces = (p: Float32Array, idx: Uint32Array, mask?: Uint8Array) => {
  const out: string[] = []
  for (let t = 0; t < idx.length / 3; t++) {
    if (mask?.[t]) continue
    const corners = Array.from(idx.subarray(t * 3, t * 3 + 3), (v) => Array.from(p.subarray(v * 3, v * 3 + 3)).join(','))
    const rotations = corners.map((_, k) => [...corners.slice(k), ...corners.slice(0, k)].join(';'))
    out.push(rotations.sort()[0])
  }
  return out.sort()
}

describe('preview-to-worker face identity', () => {
  it.each([false, true])('preserves every unselected face after real BVH reordering, crease splitting and PLY reload (aligned: %s)', (aligned) => {
    const g = buildMeshGraph({ kind: 'soup', positions: boxMesh(20, 16, 0.1) })
    if (aligned) rigidApplyToPoints(rigidFromTwist([0.2, -0.4, 0.3], [12, -5, 8]), g.positions)
    const originalPositions = g.positions.slice(), originalIndices = g.indices.slice()
    const render = scanRender(g, { mode: 'on', angleDeg: 5 })
    expect(render.copyOf.length).toBeGreaterThan(0)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(render.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(render.indices, 1))
    new MeshBVH(geometry)
    const own = render.positions.length / 3 - render.copyOf.length
    const preview = {
      positions: render.positions.subarray(0, own * 3),
      indices: Uint32Array.from(render.indices, (v) => v < own ? v : render.copyOf[v - own]),
    }
    expect(preview.indices).not.toEqual(g.indices)
    const triangles = Uint32Array.from({ length: g.triangleCount / 7 | 0 }, (_, k) => k * 7)
    const selection = new Uint8Array(g.triangleCount)
    for (const t of triangles) selection[t] = 1
    const expected = faces(preview.positions, preview.indices, selection)
    const naive = withoutTriangles(g.positions, g.indices, g.vertexCount, selection)
    expect(faces(naive.positions, naive.indices)).not.toEqual(expected)
    const mask = deletionMask(g.positions, g.indices, preview, triangles)
    const result = withoutTriangles(g.positions, g.indices, g.vertexCount, mask)
    expect(faces(result.positions, result.indices)).toEqual(expected)
    const loaded = buildMeshGraph(parsePLY(buildBinaryPly(result.positions, result.indices, 'deletion').slice().buffer))
    expect(faces(loaded.positions, loaded.indices)).toEqual(expected)
    // A second edit targets the reloaded copy, not the original scan.
    const reversed = new Uint32Array(loaded.indices.length)
    for (let t = 0; t < loaded.triangleCount; t++) reversed.set(loaded.indices.subarray(t * 3, t * 3 + 3), (loaded.triangleCount - 1 - t) * 3)
    const next = deletionMask(loaded.positions, loaded.indices, { positions: loaded.positions, indices: reversed }, new Uint32Array([0, 2, 9]))
    expect(Array.from(next.keys()).filter((t) => next[t])).toEqual([loaded.triangleCount - 10, loaded.triangleCount - 3, loaded.triangleCount - 1])
    expect(g.positions).toEqual(originalPositions)
    expect(g.indices).toEqual(originalIndices)
    geometry.dispose()
  })

  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  it('rejects changed coordinates, winding, connectivity, counts and invalid selection IDs', () => {
    const moved = positions.slice()
    moved[0] = 0.01
    for (const preview of [
      { positions: moved, indices },
      { positions, indices: new Uint32Array([0, 2, 1, 0, 2, 3]) },
      { positions, indices: new Uint32Array([0, 1, 3, 0, 2, 3]) },
      { positions, indices: indices.subarray(0, 3) },
    ]) expect(() => deletionMask(positions, indices, preview, new Uint32Array([0]))).toThrow('no longer matches')
    expect(() => deletionMask(positions, indices, { positions, indices }, new Uint32Array([2]))).toThrow('no triangle')
  })
  it('allows cyclic rotations without reversing orientation', () => {
    expect(deletionMask(positions, indices, { positions, indices: new Uint32Array([2, 3, 0, 1, 2, 0]) }, new Uint32Array([0]))).toEqual(new Uint8Array([0, 1]))
  })
  it('refuses ambiguous partial duplicate selection, but allows selecting all duplicates', () => {
    const duplicates = new Uint32Array([0, 1, 2, 1, 2, 0, 0, 2, 3])
    const preview = { positions, indices: duplicates }
    expect(() => deletionMask(positions, duplicates, preview, new Uint32Array([0]))).toThrow('ambiguous')
    expect(deletionMask(positions, duplicates, preview, new Uint32Array([0, 1]))).toEqual(new Uint8Array([1, 1, 0]))
  })
})
