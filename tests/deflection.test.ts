// SPDX-License-Identifier: AGPL-3.0-only
// The deviation map played as motion. What has to hold is that each reading,
// times the direction written down with it, is exactly the scan point's offset
// off the ideal surface — whichever side of it the point is on, and whatever
// pose the scan was fitted in — because the animation takes that offset away
// to draw the ideal shape and multiplies it to draw the exaggerated one. A
// direction off by its sign would play the whole part inside out.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { NominalSurface, emptyHit } from '../src/core/deviation/surface'
import { computeDeviation } from '../src/core/deviation/deviation'
import { computeElementDeviation } from '../src/core/deviation/elementField'
import {
  deflectionFactor,
  deflectionStartPhase,
  deflectionVectors,
  MAX_DEFLECTION_SCALE,
  suggestDeflectionScale,
  writeDirection,
} from '../src/core/deviation/deflection'
import { rigidApply, rigidFromAxisAngle, rigidInvert } from '../src/core/deviation/rigid'
import type { PlaneFit, Vec3 } from '../src/core/types'
import { boxMesh } from './helpers'

/** Reading times direction, decoded the way the shader decodes it. */
function offsetOf(values: Float32Array, directions: Int8Array, v: number): Vec3 {
  return [
    (values[v] * directions[v * 3]) / 127,
    (values[v] * directions[v * 3 + 1]) / 127,
    (values[v] * directions[v * 3 + 2]) / 127,
  ]
}

describe('writeDirection', () => {
  it('stores a unit vector a byte per component, whatever length it came in at', () => {
    const out = new Int8Array(6)
    writeDirection(out, 0, 0, 0, -3)
    writeDirection(out, 1, 2, 2, 0)
    expect([...out.subarray(0, 3)]).toEqual([0, 0, -127])
    expect([...out.subarray(3)]).toEqual([90, 90, 0])
  })

  it('leaves a zero vector zero rather than inventing a direction', () => {
    const out = new Int8Array(3).fill(5)
    writeDirection(out, 0, 0, 0, 0)
    expect([...out]).toEqual([0, 0, 0])
  })
})

describe('directions of a reference map', () => {
  const size = 20
  const graph = buildMeshGraph({ kind: 'soup', positions: boxMesh(size, 8) })
  const surface = new NominalSurface(graph.positions, graph.indices)

  // Points in the reference's frame: proud of the top face, sunk into it, off
  // a vertical edge (where the closest point is on the edge and the line to it
  // runs diagonally), and lying exactly on a side face.
  const nominalPoints: Vec3[] = [
    [1, 2, 10.3],
    [-3, 1, 9.8],
    [10.2, 10.2, 3],
    [3, -10, 2],
  ]
  // The scan stands in a frame of its own, fitted onto the reference by a
  // turn and a shift — the directions must come back in the scan's frame.
  const fit = rigidFromAxisAngle([0.3, -0.5, 0.8], 0.9)
  fit.t[0] = 4
  fit.t[1] = -7
  fit.t[2] = 2.5
  const toScan = rigidInvert(fit)
  const scan = new Float32Array(nominalPoints.length * 3)
  const p = new Float64Array(3)
  nominalPoints.forEach(([x, y, z], i) => {
    rigidApply(toScan, x, y, z, p)
    scan.set(p, i * 3)
  })
  const directions = new Int8Array(scan.length)
  const values = computeDeviation(surface, scan, fit, { directions })

  it('measures the same map with or without them', () => {
    expect([...values]).toEqual([...computeDeviation(surface, scan, fit)])
    expect(values[0]).toBeCloseTo(0.3, 5)
    expect(values[1]).toBeCloseTo(-0.2, 5)
  })

  it('puts every point back on the reference when its offset is taken away', () => {
    const hit = emptyHit()
    for (let v = 0; v < nominalPoints.length; v++) {
      const [ox, oy, oz] = offsetOf(values, directions, v)
      rigidApply(fit, scan[v * 3] - ox, scan[v * 3 + 1] - oy, scan[v * 3 + 2] - oz, p)
      expect(surface.closest(p[0], p[1], p[2], hit)).toBe(true)
      // A byte per component is good to half a degree: a few microns here.
      expect(hit.distance).toBeLessThan(0.005)
    }
  })

  it('points out of the reference on both sides of it', () => {
    // Top face: outward is +Z in the reference's frame, for the point proud of
    // it and the point sunk into it alike — the sign is the reading's.
    const out = new Float64Array(3)
    const r = fit.r
    for (const v of [0, 1]) {
      const [dx, dy, dz] = [directions[v * 3], directions[v * 3 + 1], directions[v * 3 + 2]]
      out[0] = r[0] * dx + r[1] * dy + r[2] * dz
      out[1] = r[3] * dx + r[4] * dy + r[5] * dz
      out[2] = r[6] * dx + r[7] * dy + r[8] * dz
      expect(out[2] / 127).toBeGreaterThan(0.99)
    }
  })

  it('takes a point lying on the surface along the face it lies on', () => {
    expect(Math.abs(values[3])).toBeLessThan(1e-6)
    const r = fit.r
    const [dx, dy, dz] = [directions[9], directions[10], directions[11]]
    // Into the reference's frame: the side face at y = -10 faces -Y.
    expect((r[3] * dx + r[4] * dy + r[5] * dz) / 127).toBeLessThan(-0.99)
  })
})

describe('directions of an element map', () => {
  const plane: PlaneFit = {
    kind: 'plane',
    sigma: 0,
    usedPoints: 0,
    regionSize: 0,
    center: [0, 0, 0],
    normal: [0, 0, 1],
    basisU: [1, 0, 0],
    basisV: [0, 1, 0],
    extentU: 10,
    extentV: 10,
  }

  it('runs out of the element on the material side, so the offset is exact', () => {
    // The underside of a plate whose top the plane was fitted to the wrong way
    // up: the material is on the far side, and the scan faces -Z.
    const positions = new Float32Array([1, 1, -0.2, 2, 2, 0.1, 30, 0, 0])
    const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1])
    const directions = new Int8Array(positions.length)
    const values = computeElementDeviation(plane, positions, normals, {
      side: -1,
      maxNormalDeviation: Math.PI / 3,
      directions,
    })
    expect(values[0]).toBeCloseTo(0.2, 6)
    expect(offsetOf(values, directions, 0)[2]).toBeCloseTo(-0.2, 6)
    expect(values[1]).toBeCloseTo(-0.1, 6)
    expect(offsetOf(values, directions, 1)[2]).toBeCloseTo(0.1, 6)
    // Outside the plane as drawn: no reading, and no direction either.
    expect(values[2]).toBeNaN()
    expect([...directions.subarray(6)]).toEqual([0, 0, 0])
  })
})

describe('deflectionVectors', () => {
  const FAR = { limit: 10, maxDistance: 1 }

  it('moves what is measured, and nothing past the search distance', () => {
    const values = new Float32Array([0.5, NaN, 2, -0.25])
    const directions = new Int8Array([127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, -127])
    // (+ 0 folds the -0 a negative reading times a zero component makes.)
    const v = Array.from(deflectionVectors(values, directions, FAR), (x) => x + 0)
    expect(v.slice(0, 3)).toEqual([0.5, 0, 0])
    // No reading, and a reading past the search distance, stay put.
    expect(v.slice(3, 9)).toEqual([0, 0, 0, 0, 0, 0])
    expect(v.slice(9)).toEqual([0, 0, 0.25])
  })

  it('moves a reading past the end of the colour scale only as far as the end', () => {
    const values = new Float32Array([0.6, -0.9, 0.1])
    const directions = new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127])
    const v = deflectionVectors(values, directions, { limit: 0.2, maxDistance: 1 })
    expect(v[2]).toBeCloseTo(0.2, 6)
    expect(v[5]).toBeCloseTo(-0.2, 6)
    expect(v[8]).toBeCloseTo(0.1, 6)
  })

  /** A flat w × w plate of points 1 mm apart in the z = 0 plane. */
  function plate(w: number, z = 0): Float32Array {
    const p = new Float32Array(w * w * 3)
    for (let i = 0; i < w * w; i++) p.set([i % w, Math.floor(i / w), z], i * 3)
    return p
  }
  const along = (n: number, axis: 0 | 1 | 2, sign = 1) => {
    const d = new Int8Array(n * 3)
    for (let v = 0; v < n; v++) d[v * 3 + axis] = 127 * sign
    return d
  }

  it('leaves an offset shared by the whole surface exactly as it is', () => {
    const values = new Float32Array(49).fill(0.3)
    const v = deflectionVectors(values, along(49, 2), { ...FAR, positions: plate(7), smoothing: 2 })
    for (let i = 0; i < 49; i++) expect(v[i * 3 + 2]).toBeCloseTo(0.3, 5)
  })

  it('keeps a warp — a plate tilting up along its length — as it is', () => {
    const w = 31
    const positions = plate(w)
    const values = new Float32Array(w * w)
    for (let i = 0; i < w * w; i++) values[i] = 0.01 * positions[i * 3]
    const v = deflectionVectors(values, along(w * w, 2), { ...FAR, positions, smoothing: 3 })
    // Away from the rim, where the average is all one side.
    for (let i = 0; i < w * w; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1]
      if (x < 6 || x > w - 7 || y < 6 || y > w - 7) continue
      expect(v[i * 3 + 2]).toBeCloseTo(0.01 * x, 3)
    }
  })

  it('takes out a lone spike rather than drawing it fifty times over', () => {
    const values = new Float32Array(21 * 21)
    const centre = 10 * 21 + 10
    values[centre] = 0.5
    const v = deflectionVectors(values, along(21 * 21, 2), { ...FAR, positions: plate(21), smoothing: 3 })
    expect(v[centre * 3 + 2]).toBeLessThan(0.05)
    // Spread, not lost: what is left of it sits around where it was.
    expect(v[(centre + 1) * 3 + 2]).toBeGreaterThan(0)
  })

  it('neither moves an unmeasured point nor lets it hold its neighbours back', () => {
    const values = new Float32Array(49).fill(0.3)
    values[24] = NaN
    const v = deflectionVectors(values, along(49, 2), { ...FAR, positions: plate(7), smoothing: 2 })
    expect(v[24 * 3 + 2]).toBe(0)
    expect(v[25 * 3 + 2]).toBeCloseTo(0.3, 5)
  })

  it('moves both faces of a thin wall together, the way a bent wall moves', () => {
    // A wall 1 mm thick in x: its outer face 0.2 proud, its inner face 0.1
    // shy — both of them displaced towards +x, by different amounts.
    const outer = plate(9, 1)
    const inner = plate(9, 0)
    const positions = new Float32Array(2 * 81 * 3)
    for (let i = 0; i < 81; i++) {
      // Stand the plates up: their z becomes x.
      positions.set([outer[i * 3 + 2], outer[i * 3], outer[i * 3 + 1]], i * 3)
      positions.set([inner[i * 3 + 2], inner[i * 3], inner[i * 3 + 1]], (81 + i) * 3)
    }
    const values = new Float32Array(162)
    values.fill(0.2, 0, 81)
    values.fill(-0.1, 81)
    const directions = new Int8Array(162 * 3)
    for (let i = 0; i < 81; i++) {
      directions[i * 3] = 127 // out of the outer face
      directions[(81 + i) * 3] = -127 // out of the inner face
    }
    const v = deflectionVectors(values, directions, { ...FAR, positions, smoothing: 3 })
    // Both the same way, near enough the same distance — about the 0.15 mm
    // the wall's middle has moved — rather than 0.2 out and 0.1 in.
    const centre = 4 * 9 + 4
    const out = v[centre * 3]
    const into = v[(81 + centre) * 3]
    expect(Math.abs(out - 0.15)).toBeLessThan(0.02)
    expect(Math.abs(into - 0.15)).toBeLessThan(0.02)
  })
})

describe('suggestDeflectionScale', () => {
  it('moves the end of the colour scale a twentieth of the part', () => {
    expect(suggestDeflectionScale(0.1, 100)).toBe(50)
    // Rounded down to a figure worth typing.
    expect(suggestDeflectionScale(0.07, 100)).toBe(60)
  })

  it('stays within its bounds', () => {
    expect(suggestDeflectionScale(0, 100)).toBe(1)
    expect(suggestDeflectionScale(2, 10)).toBe(1)
    expect(suggestDeflectionScale(1e-9, 100)).toBe(MAX_DEFLECTION_SCALE)
  })
})

describe('the loop', () => {
  it('goes from the ideal shape to the full scale and back', () => {
    expect(deflectionFactor(0, 20)).toBeCloseTo(0, 12)
    expect(deflectionFactor(0.5, 20)).toBeCloseTo(20, 12)
    expect(deflectionFactor(1, 20)).toBeCloseTo(0, 12)
    expect(deflectionFactor(3.5, 20)).toBeCloseTo(20, 9)
  })

  it('starts from the scan as measured', () => {
    for (const scale of [1.5, 2, 20, 1000]) {
      expect(deflectionFactor(deflectionStartPhase(scale), scale)).toBeCloseTo(1, 9)
    }
    // A scale that never reaches the scan as measured starts at its top.
    expect(deflectionFactor(deflectionStartPhase(0.5), 0.5)).toBeCloseTo(0.5, 12)
  })
})
