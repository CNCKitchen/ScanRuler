// SPDX-License-Identifier: AGPL-3.0-only
// The deviation as volumes on boxes: a block the scan has and the reference
// lacks found as missing, of about its volume; one the reference has and the
// scan lacks as excess; a scan open at the bottom unsure there without the
// patch and clean with it — the patch taken only where the scan has a
// hole, not over a block the scan lacks or the mouth of a hole the part has; a scan wound inside out read the same; the patch
// gathered from the map's pieces and cut into short triangles, the same
// surface.

import { describe, expect, it } from 'vitest'
import { identityRigid, rigidFromAxisAngle } from '../src/core/deviation/rigid'
import { compact, noScanPatchOf, volumeDeviation, type VolumeMesh } from '../src/core/deviation/volume'
import { meshArea, subdivideForMap } from '../src/core/deviation/onReference'
import { WindingTree } from '../src/core/deviation/winding'

/** A box's faces cut into quads about `step` across, wound outward; `skip`
 *  leaves faces out (0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z). */
function box(min: number[], max: number[], step = 1, skip: number[] = []): VolumeMesh {
  const positions: number[] = []
  const indices: number[] = []
  const d = [0, 1, 2].map((k) => max[k] - min[k])
  // Each face as its fixed axis, side, and the two axes it runs along, u × v
  // outward.
  const faces: [number, number, number, number][] = [
    [0, 0, 2, 1], [0, 1, 1, 2], [1, 0, 0, 2], [1, 1, 2, 0], [2, 0, 1, 0], [2, 1, 0, 1],
  ]
  faces.forEach(([axis, side, u, v], f) => {
    if (skip.includes(f)) return
    const nu = Math.max(1, Math.round(d[u] / step)), nv = Math.max(1, Math.round(d[v] / step))
    const base = positions.length / 3
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const p = [0, 0, 0]
        p[axis] = side ? max[axis] : min[axis]
        p[u] = min[u] + (d[u] * i) / nu
        p[v] = min[v] + (d[v] * j) / nv
        positions.push(...p)
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = base + i * (nv + 1) + j, b = a + nv + 1
        indices.push(a, b, b + 1, a, b + 1, a + 1)
      }
    }
  })
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function join(...meshes: VolumeMesh[]): VolumeMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const m of meshes) {
    const base = positions.length / 3
    positions.push(...m.positions)
    for (const i of m.indices) indices.push(base + i)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function flipped(m: VolumeMesh): VolumeMesh {
  const indices = m.indices.slice()
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]]
  return { positions: m.positions, indices }
}

const part = box([0, 0, 0], [20, 20, 20])

describe('the deviation as volumes', () => {
  it('finds a block the reference lacks as missing, and one the scan lacks as excess', () => {
    // A 6 × 6 × 4 block on top, sunk 1 mm in: 144 mm³ outside the part.
    const block = box([7, 7, 19], [13, 13, 24])
    const missing = volumeDeviation({ reference: part, scan: join(part, block), toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(missing.regions[0].kind).toBe('missing')
    expect(missing.regions[0].volume).toBeGreaterThan(144 * 0.85)
    expect(missing.regions[0].volume).toBeLessThan(144 * 1.15)
    expect(missing.regions[0].maxDepth).toBeGreaterThan(1.5)
    expect(missing.regions[0].thickness).toBeGreaterThan(2.5)
    expect(missing.totals.excess.volume).toBeLessThan(5)
    const excess = volumeDeviation({ reference: join(part, block), scan: part, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(excess.regions[0].kind).toBe('excess')
    expect(excess.regions[0].volume).toBeGreaterThan(144 * 0.85)
    expect(excess.regions[0].volume).toBeLessThan(144 * 1.15)
    // The block's faces have no scan behind them, so the map offers them
    // as patch; they close no opening of the scan's, and are not taken.
    const offered = box([7, 7, 20], [13, 13, 24], 1, [4])
    const patched = volumeDeviation({ reference: join(part, block), scan: part, noScanPatch: offered, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(patched.patch.kept).toBe(0)
    expect(patched.regions[0].kind).toBe('excess')
    expect(patched.regions[0].volume).toBeGreaterThan(144 * 0.85)
    const all = volumeDeviation({ reference: join(part, block), scan: part, noScanPatch: offered, patchRule: 'all', toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(all.totals.excess.volume).toBeLessThan(144 * 0.85)
  })

  it('reads a hole in the reference from the columns beside it, and says so: no lump up the grid over it', () => {
    // 4 × 4 mm of the top left out: the columns there go in and never out.
    const kept: number[] = []
    for (let t = 0; t < part.indices.length; t += 3) {
      const [a, b, c] = [part.indices[t] * 3, part.indices[t + 1] * 3, part.indices[t + 2] * 3]
      const mid = [0, 1, 2].map((k) => (part.positions[a + k] + part.positions[b + k] + part.positions[c + k]) / 3)
      if (mid[2] === 20 && mid[0] > 8 && mid[0] < 12 && mid[1] > 8 && mid[1] < 12) continue
      kept.push(part.indices[t], part.indices[t + 1], part.indices[t + 2])
    }
    const holed = { positions: part.positions, indices: Uint32Array.from(kept) }
    const v = volumeDeviation({ reference: holed, scan: part, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(v.referenceOpen!.columns).toBeGreaterThan(200)
    expect(v.referenceOpen!.box.min[0]).toBeGreaterThan(7)
    expect(v.referenceOpen!.box.max[0]).toBeLessThan(13)
    expect(v.totals.excess.volume).toBeLessThan(1)
    expect(v.totals.missing.volume).toBeLessThan(1)
    expect(volumeDeviation({ reference: part, scan: part, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 }).referenceOpen).toBeNull()
  })

  it('reads a scan open at the bottom as unsure there, and clean with the patch', () => {
    const open = box([0, 0, 0], [20, 20, 20], 1, [4])
    const bare = volumeDeviation({ reference: part, scan: open, farPatch: false, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(bare.totals.unsure.volume).toBeGreaterThan(50)
    const bottom = box([0, 0, 0], [20, 20, 20], 1, [0, 1, 2, 3, 5])
    const patched = volumeDeviation({ reference: part, scan: open, noScanPatch: bottom, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(patched.totals.unsure.volume + patched.totals.excess.volume + patched.totals.missing.volume).toBeLessThan(5)
    expect(patched.patch.kept).toBeGreaterThan(0)
    // With no map, the reference far from any scan is offered: the bottom's
    // middle, and the rims take the rest of it.
    const own = volumeDeviation({ reference: part, scan: open, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(own.totals.unsure.volume + own.totals.excess.volume + own.totals.missing.volume).toBeLessThan(5)
  })

  it('does not patch over a hole the part has whose wall the scan saw but never joined to its mouth', () => {
    // A Ø6 hole through the part: the faces round its mouths cut away, its
    // wall added on its own, wound into the hole — the rims at the mouths
    // are creases the scan left open, not holes in it.
    const fine = box([0, 0, 0], [20, 20, 20], 0.5)
    const inHole = (x: number, y: number) => Math.hypot(x - 10, y - 10) < 3
    const kept: number[] = []
    for (let t = 0; t < fine.indices.length; t += 3) {
      const c = [0, 1].map((k) => (fine.positions[fine.indices[t] * 3 + k] + fine.positions[fine.indices[t + 1] * 3 + k] + fine.positions[fine.indices[t + 2] * 3 + k]) / 3)
      if (!inHole(c[0], c[1])) kept.push(fine.indices[t], fine.indices[t + 1], fine.indices[t + 2])
    }
    const wall: number[] = [], wallIdx: number[] = []
    const seg = 48
    for (let s2 = 0; s2 <= seg; s2++) {
      const a = (2 * Math.PI * s2) / seg
      wall.push(10 + 3 * Math.cos(a), 10 + 3 * Math.sin(a), 0, 10 + 3 * Math.cos(a), 10 + 3 * Math.sin(a), 20)
    }
    // Wound with its normals into the hole: out of the material.
    for (let s2 = 0; s2 < seg; s2++) wallIdx.push(2 * s2, 2 * s2 + 1, 2 * s2 + 3, 2 * s2, 2 * s2 + 3, 2 * s2 + 2)
    const scan = join({ positions: fine.positions, indices: Uint32Array.from(kept) }, { positions: Float32Array.from(wall), indices: Uint32Array.from(wallIdx) })
    // What the map offers: the reference's faces over the mouths.
    const samples = subdivideForMap(part.positions, part.indices, null, 0.25)
    const values = new Float32Array(samples.positions.length / 3)
    for (let v = 0; v < values.length; v++) if (inHole(samples.positions[v * 3], samples.positions[v * 3 + 1])) values[v] = NaN
    const offered = noScanPatchOf(part, samples, values)
    const r = volumeDeviation({ reference: part, scan, noScanPatch: offered, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(r.patch.rimsProbed).toBeGreaterThan(0)
    expect(r.patch.rimsOpen).toBe(0)
    expect(r.patch.borderAlongRims).toBe(0)
    expect(r.patch.kept).toBe(0)
    const hole = Math.PI * 9 * 20
    expect(r.totals.excess.volume).toBeGreaterThan(hole * 0.8)
    expect(r.totals.excess.volume).toBeLessThan(hole * 1.1)
    // With no map the mouths are offered for standing far from any scan,
    // and refused the same way.
    const own = volumeDeviation({ reference: part, scan, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(own.patch.offered).toBeGreaterThan(0)
    expect(own.totals.excess.volume).toBeGreaterThan(hole * 0.8)
    expect(own.totals.excess.volume).toBeLessThan(hole * 1.1)
    // The plan's first rule patches the mouths and loses most of it.
    const all = volumeDeviation({ reference: part, scan, noScanPatch: offered, patchRule: 'all', toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    expect(all.totals.excess.volume).toBeLessThan(r.totals.excess.volume)
  })

  it('reads a scan wound inside out, in a frame of its own, the same', () => {
    const block = box([7, 7, 19], [13, 13, 24])
    // The scan stands turned and moved; toReference takes it back.
    const move = rigidFromAxisAngle([1, 2, 3], 0.7)
    move.t.set([5, -3, 2])
    const scan = flipped(join(part, block))
    const back = { r: move.r, t: move.t }
    const inv = { r: Float64Array.from([move.r[0], move.r[3], move.r[6], move.r[1], move.r[4], move.r[7], move.r[2], move.r[5], move.r[8]]), t: new Float64Array(3) }
    for (let k = 0; k < 3; k++) inv.t[k] = -(inv.r[k * 3] * move.t[0] + inv.r[k * 3 + 1] * move.t[1] + inv.r[k * 3 + 2] * move.t[2])
    const moved = new Float32Array(scan.positions.length)
    for (let v = 0; v < moved.length; v += 3) {
      for (let k = 0; k < 3; k++) moved[v + k] = inv.r[k * 3] * scan.positions[v] + inv.r[k * 3 + 1] * scan.positions[v + 1] + inv.r[k * 3 + 2] * scan.positions[v + 2] + inv.t[k]
    }
    const r = volumeDeviation({ reference: part, scan: { positions: moved, indices: scan.indices }, toReference: back, tolerance: 0.1, cell: 0.25 })
    expect(r.scanSign).toBe(-1)
    expect(r.regions[0].kind).toBe('missing')
    expect(r.regions[0].volume).toBeGreaterThan(144 * 0.85)
    expect(r.regions[0].volume).toBeLessThan(144 * 1.15)
  })

  it('gathers the patch from the map, and cuts slivers short without changing the surface', () => {
    // A slab whose top was never scanned: its top's pieces all read as no
    // scan, a side's half of them.
    const slab = box([0, 0, 0], [40, 2, 2], 40)
    const samples = subdivideForMap(slab.positions, slab.indices, null, 0.5)
    const values = new Float32Array(samples.positions.length / 3)
    for (let v = 0; v < values.length; v++) if (samples.positions[v * 3 + 2] > 1.99 || (samples.positions[v * 3 + 1] < 0.01 && samples.positions[v * 3] < 20)) values[v] = NaN
    const patch = noScanPatchOf(slab, samples, values)
    // The top whole (two reference triangles), the side by its pieces.
    expect(meshArea(patch.positions, patch.indices)).toBeGreaterThan(80 + 40 * 0.9)
    const short = compact(patch, 1)
    expect(meshArea(short.positions, short.indices)).toBeCloseTo(meshArea(patch.positions, patch.indices), 3)
    const before = new WindingTree(patch.positions, patch.indices), after = new WindingTree(short.positions, short.indices)
    for (const p of [[10, 1, 1], [30, 1, 3], [5, -1, 1]]) expect(after.exact(p[0], p[1], p[2])).toBeCloseTo(before.exact(p[0], p[1], p[2]), 5)
  })
})

describe('the reference triangle a region names', () => {
  it('is the reference’s own triangle nearest the region’s deepest point', () => {
    const block = box([7, 7, 19], [13, 13, 24])
    const v = volumeDeviation({ reference: join(part, block), scan: part, toReference: identityRigid(), tolerance: 0.1, cell: 0.25 })
    const ref = join(part, block)
    expect(v.regions.length).toBeGreaterThan(0)
    for (const r of v.regions) {
      const t = r.referenceTriangle
      expect(t).toBeGreaterThanOrEqual(0)
      // The nearest of every triangle, by the distance to its corners'
      // plane clamped to the triangle — checked here against all of them.
      const dist = (f: number) => {
        const P = [0, 1, 2].map((k) => [0, 1, 2].map((c) => ref.positions[ref.indices[f * 3 + k] * 3 + c]))
        // Sample the triangle finely: enough to rank them on a 1 mm grid.
        let best = Infinity
        for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20 - i; j++) {
          const a = i / 20, b = j / 20, c = 1 - a - b
          const q = [0, 1, 2].map((k) => a * P[0][k] + b * P[1][k] + c * P[2][k])
          best = Math.min(best, Math.hypot(q[0] - r.deepest[0], q[1] - r.deepest[1], q[2] - r.deepest[2]))
        }
        return best
      }
      let least = Infinity
      for (let f = 0; f < ref.indices.length / 3; f++) least = Math.min(least, dist(f))
      expect(dist(t)).toBeLessThan(least + 0.06)
    }
  })
})
