// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { ambiguityOf, autoAlign, findRunnerUp, fpfhSteps, pairFeatures, voxelThin, CLEAR_MARGIN, FPFH_BINS, MIN_TIGHT, type AlignTarget, type Ranked } from '../core/globalAlign'
import { layerCloud, poseConstraint, refineLayer, MIN_CONSTRAINT, type LayerCloud } from '../core/layerAlign'
import type { Vec3 } from '../../../src/core/types'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { runSteps } from '../../../src/core/deviation/steps'
import { rigidApply, rigidCompose, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { buildPointGraph } from '../../../src/core/geometry/buildPointGraph'
import { applyRigidCloud, blockWithBoreCloud, halves, planeCloud, rigidOf, sphereCloud, type Cloud } from '../../../tests/cloudFixtures'

const DEG = Math.PI / 180
const VERBOSE = process.env.SCANRULER_HEAVY === '1'
const log = (line: string) => { if (VERBOSE) process.stderr.write(line + '\n') }

/** Clouds joined, as one. */
function join(...cs: Cloud[]): Cloud {
  const len = cs.reduce((n, c) => n + c.positions.length, 0)
  const p = new Float32Array(len), n = new Float32Array(len)
  let o = 0
  for (const c of cs) { p.set(c.positions, o); n.set(c.normals, o); o += c.positions.length }
  return { positions: p, normals: n }
}

/** The points of `c` that `keep` passes. */
function filter(c: Cloud, keep: (x: number, y: number, z: number, nz: number) => boolean): Cloud {
  const p: number[] = [], n: number[] = []
  for (let i = 0; i < c.positions.length; i += 3) {
    if (!keep(c.positions[i], c.positions[i + 1], c.positions[i + 2], c.normals[i + 2])) continue
    p.push(c.positions[i], c.positions[i + 1], c.positions[i + 2])
    n.push(c.normals[i], c.normals[i + 1], c.normals[i + 2])
  }
  return { positions: Float32Array.from(p), normals: Float32Array.from(n) }
}

/** A block with a bore, and on its top two smaller bored blocks, both on the
 *  +y side: the block alone turned half a turn about any axis is itself, so
 *  its halves would fit each other's place as well as their own; with both
 *  blocks to one side every half turn puts them where the target has none. */
function part(): Cloud {
  const base = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step: 1 })
  const tops = [
    { size: [14, 14, 22] as Vec3, bore: 3, at: [-6, 6] },
    { size: [8, 8, 16] as Vec3, bore: 1.5, at: [11, 9] },
  ]
  // The faces where they meet are inside the part.
  const inFoot = (x: number, y: number) =>
    tops.some((t) => Math.abs(x - t.at[0]) < t.size[0] / 2 + 0.5 && Math.abs(y - t.at[1]) < t.size[1] / 2 + 0.5)
  return join(
    filter(base, (x, y, z, nz) => !(z > 9.5 && nz > 0.5 && inFoot(x, y))),
    ...tops.map((t) =>
      filter(
        applyRigidCloud(blockWithBoreCloud({ size: t.size, boreRadius: t.bore, step: 1 }), rigidOf([0, 0, 0], [t.at[0], t.at[1], 10 + t.size[2] / 2])),
        (_x, _y, z, nz) => !(z < 10.5 && nz < -0.5),
      ),
    ),
  )
}

function surfaceOf(c: Cloud): AlignTarget {
  const g = buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })
  return { surface: new CloudSurface(g.positions, g.normals!, g.spacing), positions: g.positions, normals: g.normals!, spacing: g.spacing }
}

function delta(a: Rigid, b: Rigid, l: LayerCloud): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  let mm = 0
  for (let i = 0; i < l.positions.length; i += 3) {
    rigidApply(a, l.positions[i], l.positions[i + 1], l.positions[i + 2], p)
    rigidApply(b, l.positions[i], l.positions[i + 1], l.positions[i + 2], q)
    mm = Math.max(mm, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm }
}

const whole = part()
const [lo, hi] = halves(whole, 0, 32)
const target = surfaceOf(hi)

describe('FPFH', () => {
  /** The three bins a pair lands in: alpha, phi, theta, each 0…10. */
  const bins = (p: number[], n: number[], q: number[], m: number[]) => {
    const h = new Float32Array(FPFH_BINS)
    const ok = pairFeatures(p[0], p[1], p[2], n[0], n[1], n[2], q[0], q[1], q[2], m[0], m[1], m[2], h, 0)
    if (!ok) return null
    return [0, 1, 2].map((s) => Array.from(h.slice(11 * s, 11 * s + 11)).findIndex((v) => v === 1))
  }

  it('bins a pair as worked by hand', () => {
    // Two points of one plane, normals alike: alpha = v·n = 0, phi = u·d = 0,
    // theta = atan2(0, 1) = 0 — the middle bin (5 of 0…10) of each.
    expect(bins([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1])).toEqual([5, 5, 5])
    // The second normal turned 90 degrees to point along v = u × d = +y:
    // alpha = 1 (last bin), phi = 0, theta = atan2(w·m, u·m) = atan2(0, 0) = 0.
    expect(bins([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0])).toEqual([10, 5, 5])
    // Turned 180 degrees, facing back: alpha = 0, phi = 0, theta = pi (last bin).
    expect(bins([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, -1])).toEqual([5, 5, 10])
    // The line at 45 degrees, both normals 45 degrees off it (a tie keeps the
    // first point as source): u = +z, d = (1, 0, 1)/√2, v = +y, w = −x, m = +x:
    // alpha = 0 → 5, phi = 1/√2 → floor(0.854 · 11) = 9,
    // theta = atan2(−1, 0) = −pi/2 → floor(0.25 · 11) = 2.
    expect(bins([0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0])).toEqual([5, 9, 2])
    // A pair whose normal lies along the line has no frame.
    expect(bins([0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0])).toBeNull()
  })

  it('a point is described the same however the cloud is turned', () => {
    // A synthetic grid ties distances and angles exactly, which float rounding
    // then breaks one way or the other; a scan never does. So the part is
    // jittered a little first, and the radius kept off the grid's distances.
    const t = voxelThin(whole.positions, whole.normals, 1.2)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
    for (let i = 0; i < t.positions.length; i++) t.positions[i] += 0.05 * rand()
    const moved = applyRigidCloud({ positions: t.positions, normals: t.normals }, rigidOf([70, -130, 35], [40, -12, 300]))
    const a = runSteps(fpfhSteps(t, 5.3))
    const b = runSteps(fpfhSteps({ ...moved, count: t.count }, 5.3))
    const diffs: number[] = []
    for (let i = 0; i < t.count; i++) {
      if (!a.valid[i]) continue
      expect(b.valid[i]).toBe(1)
      let d = 0
      for (let k = 0; k < FPFH_BINS; k++) d += Math.abs(a.features[i * FPFH_BINS + k] - b.features[i * FPFH_BINS + k])
      diffs.push(d)
    }
    diffs.sort((x, y) => x - y)
    expect(diffs.length).toBeGreaterThan(t.count / 2)
    // L1 over 33 bins summing to 300; a feature on a bin edge may still move.
    log(`FPFH invariance: median ${diffs[diffs.length >> 1].toExponential(2)} p95 ${diffs[Math.floor(diffs.length * 0.95)].toFixed(3)} p99 ${diffs[Math.floor(diffs.length * 0.99)].toFixed(3)} max ${diffs[diffs.length - 1].toFixed(3)}`)
    // The tail is the tie in the source choice on two parallel normals (the
    // flat faces), which rounding settles either way and which turns phi's
    // sign: a few points, never the bulk.
    expect(diffs[Math.floor(diffs.length * 0.95)]).toBeLessThan(1)
    expect(diffs[Math.floor(diffs.length * 0.99)]).toBeLessThan(6)
    expect(diffs[diffs.length >> 1]).toBeLessThan(1e-3)
  })
})

describe('autoAlign', () => {
  const cases: { name: string; rot: [number, number, number]; t: [number, number, number] }[] = [
    { name: 'small turn', rot: [12, -7, 20], t: [5, -3, 8] },
    { name: 'half a turn about z', rot: [0, 0, 180], t: [-40, 25, 3] },
    { name: 'upside down', rot: [180, 30, 0], t: [100, 0, -60] },
    { name: 'arbitrary', rot: [-150, 65, 110], t: [-15, 80, 12] },
  ]
  for (const c of cases) {
    it(`recovers ${c.name}`, () => {
      const TRUE = rigidOf(c.rot, c.t)
      const moved = applyRigidCloud(lo, TRUE)
      const layer = layerCloud(moved.positions, moved.normals)
      const t0 = performance.now()
      const r = runSteps(autoAlign(target, layer, { inspect: (st, p, s) => log(`  ${st} rms ${s.rms.toFixed(4)} matched ${s.matched.toFixed(3)} tight ${s.tight.toFixed(3)} off ${delta(p, rigidInvert(TRUE), layer).deg.toFixed(1)} deg`) }))
      const d = delta(r.pose, rigidInvert(TRUE), layer)
      log(`AUTO ${c.name}: rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(3)} constraint ${r.constraint.toFixed(4)} hyp ${r.hypotheses} ambiguous ${r.ambiguous} delta ${d.deg.toFixed(4)} deg ${d.mm.toFixed(4)} mm ${Math.round(performance.now() - t0)} ms`)
      expect(d.deg).toBeLessThan(0.1)
      expect(d.mm).toBeLessThan(0.05)
      expect(r.confident).toBe(true)
      expect(r.ambiguous).toBe(false)
    }, 60_000)
  }

  it('a sphere fits every way: ambiguous, never confident', () => {
    const s = sphereCloud({ radius: 20, step: 1, noise: 0.05 })
    const t = surfaceOf(s)
    const moved = applyRigidCloud(s, rigidOf([30, 40, 50], [10, 0, 0]))
    const r = runSteps(autoAlign(t, layerCloud(moved.positions, moved.normals)))
    log(`AUTO sphere: rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(3)} constraint ${r.constraint.toFixed(4)} hyp ${r.hypotheses} ambiguous ${r.ambiguous}`)
    expect(r.confident).toBe(false)
    expect(r.ambiguous).toBe(true)
  }, 60_000)
})

describe('constraint', () => {
  it('a plane with a slight bump lets a refine slide: not confident', () => {
    // A wide flat face carrying one low, broad dome: the overlap is almost all
    // plane, the true pose 6 mm along it from the start.
    const flat = planeCloud({ size: 80, step: 1 })
    const p = flat.positions, n = flat.normals
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i] - 10, p[i + 1] + 5)
      if (r < 8) {
        const h = 0.05 * (1 + Math.cos((Math.PI * r) / 8))
        const dh = (-0.05 * Math.PI / 8) * Math.sin((Math.PI * r) / 8)
        p[i + 2] = h
        const gx = r > 0 ? (dh * (p[i] - 10)) / r : 0, gy = r > 0 ? (dh * (p[i + 1] + 5)) / r : 0
        const l = Math.hypot(gx, gy, 1)
        n[i] = -gx / l; n[i + 1] = -gy / l; n[i + 2] = 1 / l
      }
    }
    const t = surfaceOf(flat)
    const layer = layerCloud(flat.positions, flat.normals)
    const truth = poseConstraint(t.surface, { positions: layer.sample, normals: layer.sampleNormals }, rigidOf([0, 0, 0], [0, 0, 0]), 3 * t.spacing)
    const r = runSteps(refineLayer(t.surface, layer, rigidOf([0, 0, 2], [6, 0, 0])))
    log(`PLANE constraint at truth ${truth.toExponential(3)}, refined ${r.constraint.toExponential(3)} rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(3)} confident ${r.confident}`)
    expect(truth).toBeLessThan(MIN_CONSTRAINT)
    expect(r.confident).toBe(false)
  }, 60_000)

  it('the part is constrained at its true pose', () => {
    const layer = layerCloud(lo.positions, lo.normals)
    const c = poseConstraint(target.surface, { positions: layer.sample, normals: layer.sampleNormals }, rigidOf([0, 0, 0], [0, 0, 0]), 3 * target.spacing)
    log(`PART constraint ${c.toFixed(4)}`)
    expect(c).toBeGreaterThan(MIN_CONSTRAINT)
  })
})

describe('ambiguityOf', () => {
  const r = (tight: number, over: Partial<Ranked> = {}): Ranked => ({
    pose: { r: new Float64Array(9), t: new Float64Array(3) }, rms: 0.05, matched: 0.6, lowOverlap: false, constraint: 0.2, confident: true, tight, ...over,
  })
  it('a best with no rival left is clear; one the search could not settle is not', () => {
    expect(ambiguityOf(r(0.5), null)).toBe(false)
    expect(ambiguityOf(r(0.5), 'unresolved')).toBe(true)
  })
  it('needs the best confident and finding enough', () => {
    expect(ambiguityOf(r(0.5, { confident: false }), null)).toBe(true)
    expect(ambiguityOf(r(MIN_TIGHT / 2), null)).toBe(true)
    // 0 against 0: nothing to tell them apart by.
    expect(ambiguityOf(r(0), r(0, { confident: false }))).toBe(true)
    expect(ambiguityOf(r(Number.NaN), null)).toBe(true)
    expect(ambiguityOf(r(0.5), r(Number.NaN, { confident: false }))).toBe(true)
  })
  it('the runner-up must trail by more than the margin', () => {
    const edge = 0.5 / (1 + CLEAR_MARGIN)
    expect(ambiguityOf(r(0.5), r(0.5, { confident: false }))).toBe(true)
    expect(ambiguityOf(r(0.5), r(edge, { confident: false }))).toBe(true) // strictly more
    expect(ambiguityOf(r(0.5), r(edge * 0.99, { confident: false }))).toBe(false)
  })
  it('a confident runner-up fitting as closely is a rival whatever the shares', () => {
    expect(ambiguityOf(r(0.5), r(0.2, { rms: 0.055, matched: 0.59 }))).toBe(true)
    expect(ambiguityOf(r(0.5), r(0.2, { rms: 0.09, matched: 0.59 }))).toBe(false)
  })
})

describe('findRunnerUp', () => {
  const pose = (x: number) => ({ r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([x, 0, 0]) })
  const first: Ranked = { pose: pose(0), rms: 0.05, matched: 0.6, lowOverlap: false, constraint: 0.2, confident: true, tight: 0.5 }
  const apart = (a: Rigid, b: Rigid) => Math.abs(a.t[0] - b.t[0]) > 1
  const run = (rest: { pose: Rigid; quality: number }[], settlesOn: (p: Rigid) => Rigid) => {
    let refines = 0
    const refine = function* (p: Rigid) {
      refines++
      yield
      return { ...first, pose: settlesOn(p), tight: 0.4 }
    }
    return { out: runSteps(findRunnerUp(first, rest, refine, apart)), refines: () => refines }
  }
  it('every try settling back on the best, with poses left worth trying: unresolved, never "no rival"', () => {
    const { out, refines } = run([5, 10, 15, 20].map((x) => ({ pose: pose(x), quality: 0.45 })), () => pose(0))
    expect(out).toBe('unresolved')
    expect(refines()).toBe(2)
  })
  it('one far behind is the runner-up as it stands, unrefined', () => {
    const { out, refines } = run([{ pose: pose(5), quality: 0.01 }], (p) => p)
    expect(out).not.toBeNull()
    expect(out).not.toBe('unresolved')
    expect((out as Ranked).tight).toBe(0.01)
    expect(refines()).toBe(0)
  })
  it('none apart from the best: no runner-up', () => {
    expect(run([{ pose: pose(0.5), quality: 0.45 }], (p) => p).out).toBeNull()
  })
  it('one that refines apart is the runner-up', () => {
    const { out } = run([{ pose: pose(5), quality: 0.45 }], (p) => p)
    expect((out as Ranked).pose.t[0]).toBe(5)
  })
})
