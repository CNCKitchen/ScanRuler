// SPDX-License-Identifier: AGPL-3.0-only
// Acceptance: the Revo merge's point cloud meshed here, measured against
// the mesh Revo made of the same merge. Skipped where the project is absent.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPointGraph } from '../../../src/core/geometry/buildPointGraph'
import { emptyHit, NominalSurface } from '../../../src/core/deviation/surface'
import { parsePLY } from '../../../src/core/parsers/ply'
import { meshCloud } from '../core/meshCloud'
import { revo } from '../../../tests/revoFixtures'

const R = revo()
const load = (path: string): ArrayBuffer => {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
/** Where the two scans overlap: further than this from Revo's mesh is a
 *  part Revo trimmed or filled, not a deviation. */
const OVERLAP_MM = 1

describe.skipIf(!R.exists)('Mesh this cloud on the Revo merge', () => {
  it('lies on Revo’s own mesh of the merge: mean ≤ 0.1 mm, 95 % ≤ 0.3 mm', () => {
    const cloud = parsePLY(load(R.mergeCloud()))
    if (cloud.kind !== 'cloud') throw new Error('Merge_02 cloud did not open as a cloud')
    const spacing = buildPointGraph(cloud).spacing!
    const m = meshCloud(cloud.positions, cloud.normals!, spacing)
    const ref = parsePLY(load(R.mergeMesh()))
    if (ref.kind !== 'indexed') throw new Error('Merge_02 mesh did not open as a mesh')
    const surface = new NominalSurface(ref.positions, ref.indices!)
    const hit = emptyHit()
    const d: number[] = []
    for (let i = 0; i < m.positions.length; i += 3 * 7) {
      if (surface.closest(m.positions[i], m.positions[i + 1], m.positions[i + 2], hit, OVERLAP_MM)) d.push(hit.distance)
    }
    d.sort((a, b) => a - b)
    const mean = d.reduce((a, b) => a + b, 0) / d.length
    const p95 = d[Math.floor(0.95 * (d.length - 1))]
    console.log(`Merge_02: spacing ${spacing.toFixed(3)} mm, ${JSON.stringify(m.report)}, mean ${mean.toFixed(4)} mm, 95 % ${p95.toFixed(4)} mm over ${d.length} samples`)
    expect(d.length).toBeGreaterThan(m.positions.length / 3 / 7 / 2)
    expect(mean).toBeLessThanOrEqual(0.1)
    expect(p95).toBeLessThanOrEqual(0.3)
  }, 600_000)
})
