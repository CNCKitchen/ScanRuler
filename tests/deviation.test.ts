// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { mulberry32 } from '../src/core/fit/ransac'
import { absoluteOrientation } from '../src/core/deviation/absoluteOrientation'
import { NominalSurface, emptyHit } from '../src/core/deviation/surface'
import {
  deviationScale,
  deviationStats,
  MAX_AUTO_RANGE,
  suggestRange,
} from '../src/core/deviation/deviation'
import { fieldHistogram, niceCeil, niceFloor } from '../src/core/field/stats'
import {
  jet,
  paintField,
  quantize,
  UNMEASURED_RGB,
  RED_CAP_RGB,
  BLUE_CAP_RGB,
} from '../src/core/field/colormap'
import {
  identityRigid,
  rigidApply,
  rigidCompose,
  rigidDisagreement,
  rigidFromAxisAngle,
  rigidInvert,
  reorthonormalize,
} from '../src/core/deviation/rigid'
import { boxMesh } from './helpers'
import type { Vec3 } from '../src/core/types'

function randomRigid(rand: () => number, shift: number) {
  const axis: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]
  const m = rigidFromAxisAngle(axis, (rand() - 0.5) * 2 * Math.PI)
  m.t[0] = (rand() - 0.5) * 2 * shift
  m.t[1] = (rand() - 0.5) * 2 * shift
  m.t[2] = (rand() - 0.5) * 2 * shift
  return m
}

describe('rigid transforms', () => {
  it('inverts and composes to the identity', () => {
    const rand = mulberry32(3)
    for (let i = 0; i < 20; i++) {
      const m = randomRigid(rand, 50)
      const back = rigidCompose(rigidInvert(m), m)
      expect(rigidDisagreement(back, identityRigid(), [0, 0, 0], 100)).toBeLessThan(1e-9)
    }
  })

  it('keeps an accumulated rotation orthonormal', () => {
    const rand = mulberry32(9)
    let m = identityRigid()
    for (let i = 0; i < 500; i++) m = rigidCompose(randomRigid(rand, 1), m)
    const r = reorthonormalize(m).r
    // RᵀR must be the identity, or the transform is quietly scaling the part.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = r[i] * r[j] + r[3 + i] * r[3 + j] + r[6 + i] * r[6 + j]
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 12)
      }
    }
  })
})

describe('absolute orientation', () => {
  it('recovers a known transform from exact point pairs', () => {
    const rand = mulberry32(11)
    for (let trial = 0; trial < 25; trial++) {
      const truth = randomRigid(rand, 80)
      const source: Vec3[] = []
      const target: Vec3[] = []
      const p = new Float64Array(3)
      for (let i = 0; i < 5; i++) {
        const s: Vec3 = [rand() * 100 - 50, rand() * 100 - 50, rand() * 100 - 50]
        rigidApply(truth, s[0], s[1], s[2], p)
        source.push(s)
        target.push([p[0], p[1], p[2]])
      }
      const solved = absoluteOrientation(source, target)!
      expect(solved.rms).toBeLessThan(1e-9)
      expect(rigidDisagreement(solved.transform, truth, [0, 0, 0], 100)).toBeLessThan(1e-8)
    }
  })

  it('never answers with a reflection', () => {
    // Mirrored targets have no rigid solution; the fit must stay a rotation
    // (det +1) and simply fit badly, rather than flipping the part.
    const source: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]]
    const target: Vec3[] = source.map((s) => [s[0], s[1], -s[2]])
    const r = absoluteOrientation(source, target)!.transform.r
    const det =
      r[0] * (r[4] * r[8] - r[5] * r[7]) -
      r[1] * (r[3] * r[8] - r[5] * r[6]) +
      r[2] * (r[3] * r[7] - r[4] * r[6])
    expect(det).toBeCloseTo(1, 10)
  })

  it('flags three points strung out along a line', () => {
    const collinear = absoluteOrientation(
      [[0, 0, 0], [10, 0, 0], [20, 0, 0]],
      [[0, 0, 0], [0, 10, 0], [0, 20, 0]],
    )!
    expect(collinear.conditioning).toBeLessThan(0.02)

    const spread = absoluteOrientation(
      [[0, 0, 0], [10, 0, 0], [0, 8, 0]],
      [[0, 0, 0], [0, 10, 0], [-8, 0, 0]],
    )!
    expect(spread.conditioning).toBeGreaterThan(0.2)
  })

  it('refuses fewer than three pairs', () => {
    expect(absoluteOrientation([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toBeNull()
  })
})

/** Exact signed distance to an axis-aligned box centred on the origin. */
function boxSdf(p: Vec3, h: number): number {
  const qx = Math.abs(p[0]) - h
  const qy = Math.abs(p[1]) - h
  const qz = Math.abs(p[2]) - h
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0))
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0)
  return outside + inside
}

describe('signed distance to the nominal', () => {
  const size = 20
  const graph = buildMeshGraph({ kind: 'soup', positions: boxMesh(size, 8) })
  const surface = new NominalSurface(graph.positions, graph.indices)

  it('agrees with the analytic box, inside and out', () => {
    const rand = mulberry32(17)
    const hit = emptyHit()
    let worst = 0
    for (let i = 0; i < 4000; i++) {
      const p: Vec3 = [
        (rand() - 0.5) * size * 1.6,
        (rand() - 0.5) * size * 1.6,
        (rand() - 0.5) * size * 1.6,
      ]
      expect(surface.closest(p[0], p[1], p[2], hit)).toBe(true)
      worst = Math.max(worst, Math.abs(hit.signed - boxSdf(p, size / 2)))
    }
    expect(worst).toBeLessThan(1e-3)
  })

  it('gets the sign right on the edges and corners, where a face normal cannot', () => {
    // Points hugging the box surface, biased onto its edges and corners — the
    // only places where signing by the nearest face's own normal goes wrong.
    const rand = mulberry32(23)
    const h = size / 2
    const hit = emptyHit()
    let checked = 0
    for (let i = 0; i < 6000; i++) {
      // Start on an edge or a corner, then step a little off it.
      const pick = () => (rand() < 0.5 ? -h : h)
      const along = () => (rand() * 2 - 1) * h
      const corner = rand() < 0.35
      const base: Vec3 = corner
        ? [pick(), pick(), pick()]
        : rand() < 0.34
          ? [along(), pick(), pick()]
          : rand() < 0.5
            ? [pick(), along(), pick()]
            : [pick(), pick(), along()]
      const eps = (rand() - 0.5) * 0.4
      const p: Vec3 = [
        base[0] + eps * (rand() - 0.5),
        base[1] + eps * (rand() - 0.5),
        base[2] + eps * (rand() - 0.5),
      ]
      const truth = boxSdf(p, h)
      if (Math.abs(truth) < 1e-6) continue
      checked++
      surface.closest(p[0], p[1], p[2], hit)
      expect(Math.sign(hit.signed)).toBe(Math.sign(truth))
      expect(hit.signed).toBeCloseTo(truth, 3)
    }
    expect(checked).toBeGreaterThan(4000)
  })

  it('reports no hit past the search cap', () => {
    const hit = emptyHit()
    expect(surface.closest(1000, 0, 0, hit, 5)).toBe(false)
    expect(surface.closest(1000, 0, 0, hit)).toBe(true)
  })
})

describe('scale and statistics', () => {
  it('rounds a range to something a person would have picked', () => {
    expect(niceCeil(0.61)).toBeCloseTo(0.8)
    expect(niceCeil(0.42)).toBeCloseTo(0.5)
    expect(niceCeil(1.05)).toBeCloseTo(1.2)
    expect(niceCeil(0.0031)).toBeCloseTo(0.004)
  })

  it('rounds the low end of a scale the other way', () => {
    expect(niceFloor(0.61)).toBeCloseTo(0.6)
    expect(niceFloor(0.42)).toBeCloseTo(0.4)
    expect(niceFloor(1.05)).toBeCloseTo(1)
    expect(niceFloor(2.9)).toBeCloseTo(2.5)
    expect(niceFloor(0)).toBe(0)
  })

  it('ignores the far tail when suggesting a range', () => {
    // 1000 points at ±0.1 plus a lone 9 mm spike: scaling to the spike would
    // flatten the part to a single colour.
    const values = new Float32Array(1001)
    for (let i = 0; i < 1000; i++) values[i] = i % 2 ? 0.1 : -0.1
    values[1000] = 9
    expect(suggestRange(values, 100)).toBeLessThan(1)
  })

  it('never opens the scale wider than a millimetre on its own', () => {
    // A third of the surface standing 6 mm proud — a boss on the datum plane an
    // element map is measured against, or a fixture in a reference map. The 95th
    // percentile lands on it, and a ±6 mm scale would render the deviation that
    // actually matters, a few hundredths, as one shade of green. The cap keeps
    // the reading legible and the dark end caps say the rest is off-scale.
    const values = new Float32Array(900)
    for (let i = 0; i < 600; i++) values[i] = i % 2 ? 0.03 : -0.03
    for (let i = 600; i < 900; i++) values[i] = 6
    expect(suggestRange(values, 100)).toBe(MAX_AUTO_RANGE)
    expect(MAX_AUTO_RANGE).toBe(1)
    // Below the cap the suggestion is still the tool's own, to whatever
    // precision the part deserves.
    const tight = new Float32Array(100).fill(0.04)
    expect(suggestRange(tight, 100)).toBeLessThan(0.1)
  })

  it('counts only what the search distance matched', () => {
    const values = Float32Array.from([0.1, -0.2, 5, -6, 0.05])
    const stats = deviationStats(values, 1, 0.15)
    expect(stats.measured).toBe(3)
    expect(stats.total).toBe(5)
    expect(stats.min).toBeCloseTo(-0.2)
    expect(stats.max).toBeCloseTo(0.1)
    expect(stats.withinTolerance).toBe(2)
    expect(stats.rms).toBeCloseTo(Math.sqrt((0.01 + 0.04 + 0.0025) / 3), 6)
  })

  it('folds out-of-range deviation into the end bins', () => {
    // Bins span [−1, −0.5), [−0.5, 0), [0, 0.5), [0.5, 1]; the ±5 outliers are
    // capped into the two ends rather than dropped, so the counts still add up.
    const values = Float32Array.from([-5, -0.5, 0, 0.5, 5])
    const h = fieldHistogram(values, -1, 1, -100, 100, 4)
    expect(Array.from(h.bins)).toEqual([1, 1, 1, 2])
    expect(h.bins.reduce((a: number, b: number) => a + b, 0)).toBe(5)
  })
})

describe('the colour ramp', () => {
  it('puts a saturated green on nominal and the primaries at the ends', () => {
    const c: [number, number, number] = [0, 0, 0]
    jet(0.5, c)
    expect(c[1]).toBeGreaterThan(150)
    expect(c[0]).toBeLessThan(40)
    expect(c[2]).toBeLessThan(40)
    jet(0, c)
    expect(c).toEqual([0, 0, 255])
    jet(1, c)
    expect(c).toEqual([255, 0, 0])
  })

  it('is symmetric about zero', () => {
    const lo: [number, number, number] = [0, 0, 0]
    const hi: [number, number, number] = [0, 0, 0]
    for (let i = 0; i <= 10; i++) {
      jet(0.5 - i / 20, lo)
      jet(0.5 + i / 20, hi)
      // Mirrored: the blue leg's blue matches the red leg's red, and so on.
      expect(lo[2]).toBe(hi[0])
      expect(lo[1]).toBe(hi[1])
    }
  })

  it('snaps to band centres', () => {
    expect(quantize(0.01, 4)).toBeCloseTo(0.125)
    expect(quantize(0.99, 4)).toBeCloseTo(0.875)
    expect(quantize(0.5, 4)).toBeCloseTo(0.625)
  })

  it('separates in range, off scale, and unmatched', () => {
    const values = Float32Array.from([0, 2, -2, 50, NaN])
    const out = new Uint8Array(15)
    paintField(values, deviationScale(1, 10, null), out)
    expect(Array.from(out.slice(0, 3))).toEqual([0, 200, 0])
    expect(Array.from(out.slice(3, 6))).toEqual([...RED_CAP_RGB])
    expect(Array.from(out.slice(6, 9))).toEqual([...BLUE_CAP_RGB])
    expect(Array.from(out.slice(9, 12))).toEqual([...UNMEASURED_RGB])
    // A vertex the search never reached is not a measurement either.
    expect(Array.from(out.slice(12, 15))).toEqual([...UNMEASURED_RGB])
  })
})

describe('nice numbers are exact decimals', () => {
  it('never carries binary-float crumbs into the scale', () => {
    for (const x of [0.55, 0.61, 0.0031, 0.12, 2.9, 33, 0.07, 1.05, 450]) {
      for (const v of [niceCeil(x), niceFloor(x)]) {
        expect(String(v)).toBe(String(Number(v.toPrecision(12))))
      }
    }
    expect(niceFloor(0.61)).toBe(0.6)
    expect(niceCeil(0.55)).toBe(0.6)
    expect(niceFloor(33)).toBe(30)
  })
})
