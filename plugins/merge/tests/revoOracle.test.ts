// SPDX-License-Identifier: AGPL-3.0-only
// Layer alignment against Revo's own merge of the five passes (the oracle):
// started off the oracle pose, refineLayer must land on it, fitting at least
// as well by scorePose. Skipped, loudly, where the project is absent
// (tests/revoFixtures.ts). The default run does one case; SCANRULER_HEAVY=1
// runs every pass from every start, the identity starts and the composition.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { autoAlign } from '../core/globalAlign'
import { alignPairs, layerCloud, refineLayer, type LayerAlignResult, type LayerCloud } from '../core/layerAlign'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { oraclePose, scorePose } from '../../../src/core/deviation/poseScore'
import { identityRigid, rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { runSteps } from '../../../src/core/deviation/steps'
import { buildPointGraph, type PointGraph } from '../../../src/core/geometry/buildPointGraph'
import { parsePLY } from '../../../src/core/parsers/ply'
import { revo, type RevoPass } from '../../../tests/revoFixtures'
import type { Vec3 } from '../../../src/core/types'

const R = revo()
const HEAVY = process.env.SCANRULER_HEAVY === '1'
const DEG = Math.PI / 180
/** Measurement lines, printed only on the heavy run. */
const log = (line: string) => { if (HEAVY) process.stderr.write(line) }
const PASSES: RevoPass[] = ['0905_01', '0905_03', '0905_04', '0905_05']

const load = (n: RevoPass): PointGraph => {
  const b = readFileSync(R.pass(n))
  return buildPointGraph(parsePLY(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
}
const surfaceOf = (g: PointGraph) => new CloudSurface(g.positions, g.normals!, g.spacing)
const layerOf = (g: PointGraph) => layerCloud(g.positions, g.normals!)

function centroid(l: LayerCloud): Float64Array {
  const c = new Float64Array(3)
  for (let i = 0; i < l.positions.length; i += 3) for (let a = 0; a < 3; a++) c[a] += l.positions[i + a]
  return c.map((v) => v / (l.positions.length / 3))
}

/** Rotation (degrees) between two poses and how far apart they put the
 *  layer's centroid (mm). */
function delta(a: Rigid, b: Rigid, c: Float64Array): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  rigidApply(a, c[0], c[1], c[2], p)
  rigidApply(b, c[0], c[1], c[2], q)
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
}

/** Turns by `deg` about the (1,1,1) diagonal through the layer's own centroid,
 *  then moves `mm` along it: applied before the oracle, in the layer's frame. */
function perturbation(deg: number, mm: number, c: Float64Array): Rigid {
  const k = 1 / Math.sqrt(3)
  const d = rigidFromAxisAngle([k, k, k], deg * DEG)
  const rc = new Float64Array(3)
  rigidApply({ r: d.r, t: new Float64Array(3) }, c[0], c[1], c[2], rc)
  for (let a = 0; a < 3; a++) d.t[a] = c[a] - rc[a] + mm * k
  return d
}

// 0905_01 and 0905_03 carry a feature repeating every 22.5 degrees: from 20 or
// 30 degrees off ICP settles one repeat over (rms 0.10 to 0.11 against the
// oracle's 0.04 and 0.09), which no local refinement can tell from the right
// one. So a 30 degree start must land or say it is not confident.
const STARTS: { name: string; deg: number; mm: number; mayMiss?: boolean }[] = [
  { name: '+5deg+5mm', deg: 5, mm: 5 },
  { name: '-5deg-5mm', deg: -5, mm: -5 },
  { name: '10deg', deg: 10, mm: 0 },
  { name: '30deg', deg: 30, mm: 0, mayMiss: true },
]

describe.skipIf(!R.exists)('Revo oracle', () => {
  let ref: PointGraph
  let target: CloudSurface
  let maxPair: number
  const setup = () => {
    if (target) return
    ref = load('0905_02')
    target = surfaceOf(ref)
    maxPair = 3 * ref.spacing
  }

  /** Refine from oracle o perturbation and hold it to the oracle rule. */
  const check = (n: RevoPass, layer: LayerCloud, start: (typeof STARTS)[number]) => {
    const oracle = oraclePose(R.oracle(n))
    const c = centroid(layer)
    const os = scorePose(target, layer, oracle, maxPair)
    const t0 = performance.now()
    const ours = runSteps(refineLayer(target, layer, rigidCompose(oracle, perturbation(start.deg, start.mm, c))))
    const ms = Math.round(performance.now() - t0)
    const d = delta(ours.pose, oracle, c)
    log(
      `REVO ${n} ${start.name}: rms ${ours.rms.toFixed(4)} (oracle ${os.rms.toFixed(4)}) matched ${ours.matched.toFixed(4)} (oracle ${os.matched.toFixed(4)}) ` +
        `delta ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm confident ${ours.confident} ${ms} ms\n`,
    )
    const landed = ours.rms <= os.rms + 0.005 && ours.matched >= os.matched - 0.01 && d.deg < 1 && d.mm < 1
    if (start.mayMiss && !landed) {
      expect(ours.confident, `${n} ${start.name} missed the oracle and must not be confident`).toBe(false)
      return
    }
    expect(ours.rms, `${n} ${start.name} rms`).toBeLessThanOrEqual(os.rms + 0.005)
    expect(ours.matched, `${n} ${start.name} matched`).toBeGreaterThanOrEqual(os.matched - 0.01)
    expect(d.deg, `${n} ${start.name} rotation off the oracle`).toBeLessThan(1)
    expect(d.mm, `${n} ${start.name} displacement off the oracle`).toBeLessThan(1)
    expect(ours.confident).toBe(true)
  }

  it('lands on the oracle from 5 degrees and 5 mm off', () => {
    setup()
    check('0905_03', layerOf(load('0905_03')), STARTS[0])
  }, 300_000)

  it('four rough picks on 0905_03 land on the oracle', () => {
    setup()
    const layer = layerOf(load('0905_03'))
    const oracle = oraclePose(R.oracle('0905_03'))
    // The layer points furthest along four spread directions, picked on the
    // target where the oracle puts them, each click 0.3 mm out.
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 1]]
    const jitter = [[0.3, -0.3, 0.3], [-0.3, 0.3, 0.3], [0.3, 0.3, -0.3], [-0.3, -0.3, -0.3]]
    const pairs = dirs.map((d, k) => {
      let best = 0, far = -Infinity
      for (let i = 0; i < layer.positions.length; i += 3) {
        const v = d[0] * layer.positions[i] + d[1] * layer.positions[i + 1] + d[2] * layer.positions[i + 2]
        if (v > far) { far = v; best = i }
      }
      const l: Vec3 = [layer.positions[best], layer.positions[best + 1], layer.positions[best + 2]]
      const t = new Float64Array(3)
      rigidApply(oracle, l[0], l[1], l[2], t)
      return { layer: l, target: [t[0] + jitter[k][0], t[1] + jitter[k][1], t[2] + jitter[k][2]] as Vec3 }
    })
    const t0 = performance.now()
    const r = runSteps(alignPairs(target, layer, pairs))
    const d = delta(r.pose, oracle, centroid(layer))
    log(`REVO 0905_03 pairs: rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(4)} delta ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm confident ${r.confident} ${Math.round(performance.now() - t0)} ms\n`)
    expect(r.confident).toBe(true)
    expect(d.deg).toBeLessThan(1)
    expect(d.mm).toBeLessThan(1)
  }, 300_000)

  it.skipIf(!HEAVY)('lands on the oracle from every start, every pass', () => {
    setup()
    for (const n of PASSES) {
      const layer = layerOf(load(n))
      for (const s of STARTS) check(n, layer, s)
    }
  }, 3_600_000)

  it.skipIf(!HEAVY)('from identity is not confident', () => {
    setup()
    for (const n of PASSES) {
      const layer = layerOf(load(n))
      const oracle = oraclePose(R.oracle(n))
      const os = scorePose(target, layer, oracle, maxPair)
      const t0 = performance.now()
      const r: LayerAlignResult = runSteps(refineLayer(target, layer, identityRigid(), { fromUserGuess: false }))
      const d = delta(r.pose, oracle, centroid(layer))
      log(
        `REVO ${n} identity: rms ${r.rms.toFixed(4)} (oracle ${os.rms.toFixed(4)}) matched ${r.matched.toFixed(4)} lowOverlap ${r.lowOverlap} ` +
          `delta ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm confident ${r.confident} ${Math.round(performance.now() - t0)} ms\n`,
      )
      // Overlap and rms cannot tell these apart from a right pose (0905_01 settles
      // 179 degrees off, matching 0.45 at 3 times the oracle's rms), so the one
      // promise is that a start nobody chose is never called confident.
      expect(r.confident, `${n} from identity`).toBe(false)
    }
  }, 3_600_000)

  it.skipIf(!HEAVY)('composition: 01 onto 03 through the oracle agrees with refining it directly', () => {
    setup()
    const g01 = load('0905_01'), g03 = load('0905_03')
    const l01 = layerOf(g01), l03 = layerOf(g03)
    const o01 = oraclePose(R.oracle('0905_01')), o03 = oraclePose(R.oracle('0905_03'))
    const c = centroid(l01)
    // Our own poses onto 0905_02, started on the oracle, composed the same way.
    const ours01 = runSteps(refineLayer(target, l01, o01)).pose
    const ours03 = runSteps(refineLayer(target, l03, o03)).pose
    const t03 = surfaceOf(g03)
    const via = rigidCompose(rigidInvert(o03), o01)
    const t0 = performance.now()
    const r = runSteps(refineLayer(t03, l01, via))
    const ms = Math.round(performance.now() - t0)
    const d = delta(r.pose, via, c)
    const dOurs = delta(r.pose, rigidCompose(rigidInvert(ours03), ours01), c)
    const viaScore = scorePose(t03, l01, via, 3 * g03.spacing)
    log(
      `REVO composition 01->03: rms ${r.rms.toFixed(4)} (oracle composed ${viaScore.rms.toFixed(4)}) matched ${r.matched.toFixed(4)} (oracle composed ${viaScore.matched.toFixed(4)}) ` +
        `delta to oracle composed ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm, to ours composed ${dOurs.deg.toFixed(3)} deg ${dOurs.mm.toFixed(3)} mm confident ${r.confident} ${ms} ms\n`,
    )
    // Direct and composed disagree by about 0.25 mm at the centroid whichever
    // poses are composed (Revo's or ours), and the direct pose fits 03 better
    // than Revo's composition does: the passes are not rigidly consistent to
    // 0.2 mm, so the direct fit is held to the oracle rule instead.
    expect(r.rms).toBeLessThanOrEqual(viaScore.rms + 0.005)
    expect(r.matched).toBeGreaterThanOrEqual(viaScore.matched - 0.01)
    expect(d.deg).toBeLessThan(0.2)
    expect(d.mm).toBeLessThan(1)
    expect(dOurs.deg).toBeLessThan(0.2)
    expect(dOurs.mm).toBeLessThan(1)
  }, 900_000)

  /** Auto align from the identity — no start at all — held to the oracle. */
  const auto = (n: RevoPass) => {
    const layer = layerOf(load(n))
    const oracle = oraclePose(R.oracle(n))
    const os = scorePose(target, layer, oracle, maxPair)
    const t0 = performance.now()
    const c = centroid(layer)
    const inspect = (stage: string, pose: Rigid, s: { rms: number; matched: number; tight: number }) => {
      if (stage === 'coarse') return
      const e = delta(pose, oracle, c)
      log(`  ${stage} rms ${s.rms.toFixed(4)} matched ${s.matched.toFixed(4)} tight ${s.tight.toFixed(4)} off ${e.deg.toFixed(2)} deg ${e.mm.toFixed(2)} mm
`)
    }
    const r = runSteps(autoAlign({ surface: target, positions: ref.positions, normals: ref.normals!, spacing: ref.spacing }, layer, { inspect }))
    const d = delta(r.pose, oracle, centroid(layer))
    log(
      `REVO ${n} auto: rms ${r.rms.toFixed(4)} (oracle ${os.rms.toFixed(4)}) matched ${r.matched.toFixed(4)} (oracle ${os.matched.toFixed(4)}) constraint ${r.constraint.toFixed(4)} ` +
        `hypotheses ${r.hypotheses} ambiguous ${r.ambiguous} delta ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm confident ${r.confident} ${Math.round(performance.now() - t0)} ms
`,
    )
    return { r, d, os }
  }

  // The part repeats every 45 degrees about its axis, and geometry alone
  // does not tell those poses apart: from no start, 0905_03 and 0905_05 fit
  // better 90 and 180 degrees off Revo's pose than at it (rms 0.071 against
  // 0.088, 0.061 against 0.089), and 0905_01 and 0905_04 within 1.3 times its
  // rms 45 degrees off. Revo had its markers. So the promise is: a pose that
  // fits as well as Revo's, a whole number of repeats off it, and never
  // confident unless it is Revo's own.
  it.skipIf(!HEAVY)('auto align from no start lands a whole repeat off the oracle at most, and is never sure of a wrong one', () => {
    setup()
    for (const n of PASSES) {
      const { r, d, os } = auto(n)
      const repeat = Math.abs(d.deg / 45 - Math.round(d.deg / 45)) * 45
      expect.soft(repeat, `${n} auto: not a whole repeat off`).toBeLessThan(1)
      expect.soft(r.rms, `${n} auto rms`).toBeLessThan(1.5 * os.rms)
      expect.soft(r.matched, `${n} auto matched`).toBeGreaterThanOrEqual(os.matched - 0.02)
      if (r.confident) {
        expect.soft(d.deg, `${n} auto: confident off the oracle`).toBeLessThan(1)
        expect.soft(d.mm, `${n} auto: confident off the oracle`).toBeLessThan(1)
      }
    }
  }, 3_600_000)
})
