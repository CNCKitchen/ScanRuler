// SPDX-License-Identifier: AGPL-3.0-only
// The STEP reference is a conversion, and everything measured against it
// inherits the conversion's error. These tests hold it to the two properties
// the deviation map depends on: the mesh is closed (or the signed distance has
// no reliable inside), and it stays inside the chord tolerance it reports.

import { describe, expect, it } from 'vitest'
import { parseSTEP } from '../src/core/parsers/step'
import { cubeStep, cylinderStep, stepBuffer } from './stepFixtures'

function bounds(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k])
      max[k] = Math.max(max[k], positions[i + k])
    }
  }
  return { min, max }
}

/** Edges bounding exactly two triangles, counted on the welded index buffer —
 *  a hole or a crack shows up as a count of one. */
function openEdgeCount(indices: Uint32Array): number {
  const seen = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]
      const b = indices[t + ((e + 1) % 3)]
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
  }
  let open = 0
  for (const n of seen.values()) if (n !== 2) open++
  return open
}

describe('STEP reference import', () => {
  it('reproduces a cube exactly, without subdividing its flat faces', () => {
    const { mesh, info } = parseSTEP(stepBuffer(cubeStep(20)))

    expect(mesh.kind).toBe('indexed')
    expect(info.units).toBe('mm')
    expect(info.warning).toBeNull()
    expect(info.unsound).toBe(false)

    const { min, max } = bounds(mesh.positions)
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(0, 5)
      expect(max[k]).toBeCloseTo(20, 5)
    }

    // A plane is exact at any density, so every vertex must land on one of the
    // six faces — no vertex may float off the surface.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const onFace = [0, 1, 2].some((k) => {
        const v = mesh.positions[i + k]
        return Math.abs(v) < 1e-4 || Math.abs(v - 20) < 1e-4
      })
      expect(onFace).toBe(true)
    }

    expect(openEdgeCount(mesh.indices!)).toBe(0)

    // The tessellation is driven by chord error, not by edge length: six flat
    // faces need a handful of triangles, and the library's length-capped
    // default would spend a quarter of a million on them.
    expect(mesh.indices!.length / 3).toBeLessThan(2000)
  })

  it('holds a cylindrical face inside the chord tolerance it reports', () => {
    const R = 10
    const H = 30
    const { mesh, info } = parseSTEP(stepBuffer(cylinderStep(R, H)))

    expect(info.warning).toBeNull()
    expect(openEdgeCount(mesh.indices!)).toBe(0)

    const { min, max } = bounds(mesh.positions)
    expect(min[2]).toBeCloseTo(0, 4)
    expect(max[2]).toBeCloseTo(H, 4)
    expect(Math.max(-min[0], -min[1], max[0], max[1])).toBeCloseTo(R, 4)

    // Worst case is the middle of a chord, not its ends: an inscribed polygon
    // touches the surface at every vertex whatever its density. Both endpoints
    // strictly between the caps keeps the check on the lateral face.
    const p = mesh.positions
    const idx = mesh.indices!
    let maxSagitta = 0
    let checked = 0
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e] * 3
        const b = idx[t + ((e + 1) % 3)] * 3
        const za = p[a + 2]
        const zb = p[b + 2]
        if (za < 1e-4 || za > H - 1e-4 || zb < 1e-4 || zb > H - 1e-4) continue
        const mx = (p[a] + p[b]) / 2
        const my = (p[a + 1] + p[b + 1]) / 2
        maxSagitta = Math.max(maxSagitta, R - Math.hypot(mx, my))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(maxSagitta).toBeGreaterThan(0)
    expect(maxSagitta).toBeLessThanOrEqual(info.surfaceDeviation * 1.05)
    // And the tolerance is fine enough to disappear under a scan: a tenth of
    // what a good structured-light scanner resolves on a part this size.
    expect(info.surfaceDeviation).toBeLessThanOrEqual(0.01)
  })

  it('refuses a file that is not STEP part 21', () => {
    const notStep = stepBuffer('solid ascii-stl\nfacet normal 0 0 1\n')
    expect(() => parseSTEP(notStep)).toThrow(/ISO-10303-21/)
  })
})
