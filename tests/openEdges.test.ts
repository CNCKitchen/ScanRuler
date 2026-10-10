// SPDX-License-Identifier: AGPL-3.0-only
// Where a mesh is open — the rims of its gaps, placed — and the STEP
// conversion's verdict that names the faces it lost and says where the gaps
// they left lie.
import { describe, expect, it } from 'vitest'
import { meshGaps } from '../src/core/geometry/openEdges'
import { describeConversion } from '../src/core/parsers/step'
import { weldTriangleSoup } from '../src/core/geometry/weld'
import { boxMesh } from './helpers'

type Vec3 = [number, number, number]

/** The 40 mm box welded, with every triangle whose corners all lie on a
 *  face taken out — a gap where that face was. */
function boxWithout(face: (p: Vec3) => boolean): { positions: Float32Array; indices: Uint32Array } {
  const welded = weldTriangleSoup(boxMesh(40, 4))
  const p = welded.positions
  const at = (v: number): Vec3 => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]
  const kept: number[] = []
  for (let t = 0; t + 2 < welded.indices.length; t += 3) {
    const corners = [welded.indices[t], welded.indices[t + 1], welded.indices[t + 2]]
    if (corners.every((v) => face(at(v)))) continue
    kept.push(...corners)
  }
  return { positions: p, indices: Uint32Array.from(kept) }
}

describe('meshGaps', () => {
  it('finds nothing on a closed box', () => {
    const welded = weldTriangleSoup(boxMesh(40, 4))
    expect(meshGaps(welded.positions, welded.indices)).toEqual([])
  })

  it('places a gap at the middle of the face that is missing, largest first', () => {
    const open = boxWithout((p) => p[2] > 19.9)
    const gaps = meshGaps(open.positions, open.indices)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].at[0]).toBeCloseTo(0, 5)
    expect(gaps[0].at[1]).toBeCloseTo(0, 5)
    expect(gaps[0].at[2]).toBeCloseTo(20, 5)
    // The rim of a 40 mm face: four edges of four segments each.
    expect(gaps[0].edges).toBe(16)
    expect(gaps[0].size).toBeCloseTo(Math.hypot(40, 40), 5)
    // Two faces gone, on opposite sides, their rims apart: two gaps. (Two
    // faces side by side would share a rim and be the one gap they are.)
    const two = boxWithout((p) => p[2] > 19.9 || p[2] < -19.9)
    const both = meshGaps(two.positions, two.indices, 5)
    expect(both).toHaveLength(2)
    expect(both[0].edges).toBeGreaterThanOrEqual(both[1].edges)
    expect(meshGaps(two.positions, two.indices, 1)).toHaveLength(1)
  })
})

describe('describeConversion', () => {
  const clean = { ok: true, openEdges: 0, nonManifoldEdges: 0, facesDropped: 0, facesSkipped: 0, warnings: [] }

  it('has nothing to say of a clean conversion', () => {
    expect(describeConversion(clean)).toEqual({ warning: null, unsound: false })
  })

  it('names the faces that were lost by their entity ids and says where the gaps lie', () => {
    const open = boxWithout((p) => p[2] > 19.9)
    const verdict = describeConversion(
      {
        ok: false,
        openEdges: 16,
        nonManifoldEdges: 0,
        facesDropped: 0,
        facesSkipped: 2,
        warnings: [
          { code: 'face-unsupported-surface', severity: 'error', faceId: 1234, detail: 'offset surface' },
          { code: 'face-untriangulated', severity: 'error', faceId: 1250, detail: '' },
          { code: 'heuristic-fill', severity: 'warning', faceId: 9, detail: '' },
        ],
      },
      open,
    )
    expect(verdict.unsound).toBe(true)
    expect(verdict.faces).toEqual([
      { id: 1234, problem: 'a surface kind the converter does not handle' },
      { id: 1250, problem: 'a face no mesher could triangulate' },
    ])
    expect(verdict.gaps).toHaveLength(1)
    expect(verdict.gaps![0].at[2]).toBeCloseTo(20, 5)
    expect(verdict.warning).toContain('2 surfaces could not be converted: #1234 (a surface kind the converter does not handle), #1250 (a face no mesher could triangulate)')
    expect(verdict.warning).toContain('16 open edges')
    expect(verdict.warning).toMatch(/The gap lies at \(0, 0, 20\), 56\.57 mm across\./)
  })

  it('says so without a mesh to place the gaps on, and of a repaired face', () => {
    const verdict = describeConversion({ ...clean, ok: false, facesDropped: 1, warnings: [{ code: 'face-dropped', severity: 'error', detail: '' }] })
    expect(verdict.warning).toContain('1 surface could not be converted: one (a malformed face record, dropped)')
    expect(verdict.gaps).toBeUndefined()
    const repaired = describeConversion({ ...clean, ok: false, warnings: [{ code: 'heuristic-fill', severity: 'warning', faceId: 3, detail: '' }] })
    expect(repaired.unsound).toBe(false)
    expect(repaired.warning).toMatch(/rebuilt heuristically/)
  })
})
