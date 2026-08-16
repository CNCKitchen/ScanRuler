// SPDX-License-Identifier: AGPL-3.0-only
// The export, read back by a STEP kernel that had no part in writing it.
//
// A B-rep is only correct as a whole: the entity table can be flawless and the
// solid still inside out, or open at a seam nobody looked at. meshStep — the
// importer the deviation workspace tessellates reference CAD with — reports
// exactly that, so the surest test of what we write is to hand it over and
// have it built back into a mesh. A body that comes back closed, the right
// size and with no missing faces is a body CAD can use.

import { describe, expect, it } from 'vitest'
import { buildStepFile, type StepElement } from '../src/core/exportStep'
import { parseSTEP } from '../src/core/parsers/step'
import { stepBuffer } from './stepFixtures'
import type { CylinderFit, PlaneFit, SphereFit } from '../src/core/types'

const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }
const STAMP = '2026-08-16T12:00:00'

const importBack = (elements: StepElement[]) =>
  parseSTEP(stepBuffer(buildStepFile(elements, 'scan.stl', STAMP, 'solids')))

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

/** Edges bounding anything other than two triangles: a hole, a crack, or a
 *  face that came back twice. */
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

describe('what CAD gets back from a solids export', () => {
  it('builds the cylinder into a closed body of the fitted size', () => {
    const fit: CylinderFit = {
      kind: 'cylinder',
      center: [0, 0, 15],
      axis: [0, 0, 1],
      radius: 10,
      length: 30,
      coverage: 360,
      ...NO_STATS,
    }
    const { mesh, info } = importBack([{ name: 'Cylinder 1', fit }])

    expect(info.units).toBe('mm')
    expect(info.warning).toBeNull()
    expect(info.unsound).toBe(false)
    expect(openEdgeCount(mesh.indices!)).toBe(0)

    const { min, max } = bounds(mesh.positions)
    // The lids are flat and exact; the wall is chords inside the true circle,
    // by no more than the tolerance the importer reports.
    expect(min[2]).toBeCloseTo(0, 5)
    expect(max[2]).toBeCloseTo(30, 5)
    for (const k of [0, 1]) {
      expect(max[k]).toBeGreaterThan(10 - info.surfaceDeviation - 1e-6)
      expect(max[k]).toBeLessThanOrEqual(10 + 1e-6)
      expect(min[k]).toBeLessThan(-10 + info.surfaceDeviation + 1e-6)
    }
  })

  it('builds the sphere into a closed ball of the fitted radius', () => {
    const fit: SphereFit = { kind: 'sphere', center: [5, -2, 3], radius: 8, ...NO_STATS }
    const { mesh, info } = importBack([{ name: 'Sphere 1', fit }])

    expect(info.warning).toBeNull()
    expect(info.unsound).toBe(false)
    expect(openEdgeCount(mesh.indices!)).toBe(0)

    // Every vertex on the ball, to the chord tolerance — poles included, which
    // is where a badly seamed sphere comes apart.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(
        mesh.positions[i] - 5,
        mesh.positions[i + 1] + 2,
        mesh.positions[i + 2] - 3,
      )
      expect(Math.abs(r - 8)).toBeLessThan(info.surfaceDeviation + 1e-4)
    }
    const { min, max } = bounds(mesh.positions)
    expect(max[2] - min[2]).toBeGreaterThan(16 - 2 * info.surfaceDeviation)
  })

  it('builds the plane into the patch it was measured on', () => {
    const fit: PlaneFit = {
      kind: 'plane',
      center: [5, 5, 2],
      normal: [0, 0, 1],
      basisU: [1, 0, 0],
      basisV: [0, 1, 0],
      extentU: 7,
      extentV: 3,
      ...NO_STATS,
    }
    const { mesh } = importBack([{ name: 'Plane 1', fit }])

    const { min, max } = bounds(mesh.positions)
    expect(min[0]).toBeCloseTo(-2, 5)
    expect(max[0]).toBeCloseTo(12, 5)
    expect(min[1]).toBeCloseTo(2, 5)
    expect(max[1]).toBeCloseTo(8, 5)
    // A sheet, not a body: it lies in its own plane and has nothing behind it.
    expect(min[2]).toBeCloseTo(2, 5)
    expect(max[2]).toBeCloseTo(2, 5)
  })

  it('builds a whole file of mixed elements without dropping any of it', () => {
    const elements: StepElement[] = [
      {
        name: 'Cylinder 1',
        fit: {
          kind: 'cylinder',
          center: [0, 0, 0],
          axis: [0, 1, 0],
          radius: 3,
          length: 12,
          coverage: 200,
          ...NO_STATS,
        },
      },
      { name: 'Sphere 1', fit: { kind: 'sphere', center: [30, 0, 0], radius: 5, ...NO_STATS } },
      {
        name: 'Plane 1',
        fit: {
          kind: 'plane',
          center: [0, -20, 0],
          normal: [0, 1, 0],
          basisU: [1, 0, 0],
          basisV: [0, 0, 1],
          extentU: 10,
          extentV: 10,
          ...NO_STATS,
        },
      },
      {
        name: 'Line 1',
        fit: { kind: 'line', center: [0, 0, 0], dir: [1, 0, 0], length: 40, ...NO_STATS },
      },
      { name: 'Point 1', fit: { kind: 'point', center: [-10, 0, 0], ...NO_STATS } },
    ]
    const { mesh, info } = importBack(elements)

    expect(info.warning).toBeNull()
    expect(info.unsound).toBe(false)
    // Three bodies, all of them present: the cylinder wall and its two lids,
    // the ball, and the square sheet.
    expect(mesh.indices!.length / 3).toBeGreaterThan(20)
    const { min, max } = bounds(mesh.positions)
    expect(min[0]).toBeCloseTo(-10, 4)
    expect(max[0]).toBeCloseTo(35, 4)
    expect(min[1]).toBeCloseTo(-20, 4)
  })
})
