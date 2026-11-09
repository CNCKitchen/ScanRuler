// SPDX-License-Identifier: AGPL-3.0-only
// Acceptance on the real scanner passes of the Revo project: each opens as a
// point cloud with every point its header promises, opening and graph building
// stay inside budgets measured on this machine, and the normals of two passes
// agree where Revo's own merge overlaps them. Skipped, loudly, where the
// project is absent (see tests/revoFixtures.ts); heavy by nature, so each test
// states its own timeout.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePLY } from '../src/core/parsers/ply'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { PointGrid } from '../src/core/geometry/pointGrid'
import type { ParsedMesh } from '../src/core/types'
import { revo, type RevoPass } from './revoFixtures'

const R = revo()
const PASSES: RevoPass[] = ['0905_01', '0905_02', '0905_03', '0905_04', '0905_05']

// ---- budgets: measured on this machine on 2026-11-09, never loosened --------
// Each budget is 1.5 x the measured median. Do not raise them; make the code
// faster, or explain why in the commit that moves one.
//
// Reference (not asserted): parsePLY + buildMeshGraph of Merge_02/model_mesh.ply
// (1,556,313 vertices, 3,112,873 faces) took 500 ms, i.e. 0.32 us a vertex. A
// cloud's open does more per vertex (the neighbour search), so opening 0905_02
// measured 4.6 x the mesh's per-vertex time, not 1.5 x it: the budgets below are
// therefore on the cloud's own measurements, as the design spec asks.
/** parsePLY + buildPointGraph of 0905_02 (757,473 points): median of 6 runs. */
const OPEN_MS_MEASURED = 1140
const OPEN_BUDGET_MS = 1.5 * OPEN_MS_MEASURED
/** buildPointGraph of all five passes joined (3,014,681 points): median of 4. */
const BUILD_MS_MEASURED = 5700
const BUILD_BUDGET_MS = 1.5 * BUILD_MS_MEASURED

const load = (path: string): ArrayBuffer => {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** The vertex count a PLY's header declares. */
function headerCount(path: string): number {
  const head = readFileSync(path).subarray(0, 2048).toString('latin1')
  const m = /element vertex (\d+)/.exec(head)
  if (!m) throw new Error(`${path} declares no vertices`)
  return Number(m[1])
}

describe.skipIf(!R.exists)('Revo point clouds', () => {
  for (const n of PASSES) {
    it(`${n} opens as a cloud with every point of its header`, () => {
      const parsed = parsePLY(load(R.pass(n)))
      const count = headerCount(R.pass(n))
      expect(parsed.kind).toBe('cloud')
      expect(parsed.positions.length).toBe(3 * count)
      expect(parsed.normals!.length).toBe(3 * count)
      const g = buildPointGraph(parsed)
      expect(g.triangleCount).toBe(0)
      expect(g.vertexCount).toBe(count)
      expect(g.spacing!).toBeGreaterThan(0)
    }, 120_000)
  }

  it('0905_02 opens within its time budget', () => {
    const bytes = load(R.pass('0905_02'))
    const t = performance.now()
    const g = buildPointGraph(parsePLY(bytes))
    // Reading the file from disk is not the open: only parse + graph is timed.
    const ms = performance.now() - t
    expect(g.vertexCount).toBe(headerCount(R.pass('0905_02')))
    expect(ms).toBeLessThanOrEqual(OPEN_BUDGET_MS)
  }, 120_000)

  it('the graph of all five passes (~3.0 M points) builds within its budget', () => {
    const parts = PASSES.map((n) => parsePLY(load(R.pass(n))))
    const total = parts.reduce((s, p) => s + p.positions.length, 0)
    const positions = new Float32Array(total)
    const normals = new Float32Array(total)
    let o = 0
    for (const p of parts) {
      positions.set(p.positions, o)
      normals.set(p.normals!, o)
      o += p.positions.length
    }
    const t = performance.now()
    const g = buildPointGraph({ kind: 'cloud', positions, normals })
    const ms = performance.now() - t
    expect(g.vertexCount).toBe(total / 3)
    expect(ms).toBeLessThanOrEqual(BUILD_BUDGET_MS)
  }, 300_000)

  it("0905_03's normals agree with 0905_02's where Revo's merge overlaps them", () => {
    const a = parsePLY(load(R.pass('0905_02')))
    const b = parsePLY(load(R.pass('0905_03')))
    const spacing = buildPointGraph(a).spacing!
    const grid = new PointGrid(a.positions, spacing)

    // Measured 2026-11-09: forward 65,969 pairs, 99.99 % agree; inverse none.
    // Revo's pose maps a pass into the merge frame (0905_02 is the identity),
    // but which way the 16 numbers act is only settled in Task 16's convention
    // test, so both are tried and the one that lands 0905_03 on 0905_02 — the
    // larger overlap — is used.
    const m = R.oracle('0905_03')
    const forward = rigidOf(m)
    const results = [forward, invert(forward)].map((pose) => overlap(a, b, grid, pose, 2 * spacing))
    const best = results[0].pairs >= results[1].pairs ? results[0] : results[1]
    expect(best.pairs).toBeGreaterThan(1000)
    expect(best.agree / best.pairs).toBeGreaterThanOrEqual(0.95)
  }, 120_000)
})

interface Pose {
  r: number[]
  t: number[]
}

/** A row-major 4x4 as a rotation and a translation (at [3, 7, 11]). */
function rigidOf(m: number[]): Pose {
  return { r: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], t: [m[3], m[7], m[11]] }
}

function invert(p: Pose): Pose {
  const r = [p.r[0], p.r[3], p.r[6], p.r[1], p.r[4], p.r[7], p.r[2], p.r[5], p.r[8]]
  const t = [0, 1, 2].map((i) => -(r[3 * i] * p.t[0] + r[3 * i + 1] * p.t[1] + r[3 * i + 2] * p.t[2]))
  return { r, t }
}

/** Every 10th point of `b`, posed, that has a point of `a` within `radius`:
 *  how many there are, and for how many the two normals point within 90 deg. */
function overlap(a: ParsedMesh, b: ParsedMesh, grid: PointGrid, pose: Pose, radius: number): { pairs: number; agree: number } {
  const { r, t } = pose
  let pairs = 0
  let agree = 0
  for (let i = 0; i < b.positions.length / 3; i += 10) {
    const x = b.positions[3 * i], y = b.positions[3 * i + 1], z = b.positions[3 * i + 2]
    const px = r[0] * x + r[1] * y + r[2] * z + t[0]
    const py = r[3] * x + r[4] * y + r[5] * z + t[1]
    const pz = r[6] * x + r[7] * y + r[8] * z + t[2]
    const j = grid.nearest(px, py, pz, radius)
    if (j < 0) continue
    const nx = b.normals![3 * i], ny = b.normals![3 * i + 1], nz = b.normals![3 * i + 2]
    const qx = r[0] * nx + r[1] * ny + r[2] * nz
    const qy = r[3] * nx + r[4] * ny + r[5] * nz
    const qz = r[6] * nx + r[7] * ny + r[8] * nz
    pairs++
    if (qx * a.normals![3 * j] + qy * a.normals![3 * j + 1] + qz * a.normals![3 * j + 2] > 0) agree++
  }
  return { pairs, agree }
}
