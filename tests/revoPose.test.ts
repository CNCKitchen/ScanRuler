// SPDX-License-Identifier: AGPL-3.0-only
// Revo's pose convention and what alignment recovers on the real passes.
// Skipped, loudly, where the project is absent (tests/revoFixtures.ts); heavy,
// so each test states its own timeout. Numbers it logs are the ones the
// LOW_OVERLAP and CONFIDENT_RMS_SPACINGS choices in src/core/deviation/poseScore.ts rest on.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CloudSurface } from '../src/core/deviation/cloudSurface'
import { icp, sampleScan } from '../src/core/deviation/icp'
import { oraclePose, poseConfidence, scorePose } from '../src/core/deviation/poseScore'
import { identityRigid, rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../src/core/deviation/rigid'
import { buildPointGraph, type PointGraph } from '../src/core/geometry/buildPointGraph'
import { parsePLY } from '../src/core/parsers/ply'
import { revo, type RevoPass } from './revoFixtures'

const R = revo()
const load = (n: RevoPass): PointGraph => {
  const b = readFileSync(R.pass(n))
  return buildPointGraph(parsePLY(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
}
const DEG = Math.PI / 180

describe.skipIf(!R.exists)('Revo pose', () => {
  let ref: PointGraph
  let target: CloudSurface
  let maxPair: number
  const setup = () => {
    if (target) return
    ref = load('0905_02')
    target = new CloudSurface(ref.positions, ref.normals, ref.spacing!)
    maxPair = 3 * ref.spacing!
    console.log(`0905_02: ${ref.vertexCount} points, spacing ${ref.spacing}, maxPair ${maxPair}`)
  }

  it('pose convention: the matrix as given maps the pass into 0905_02', () => {
    setup()
    const pass = load('0905_03')
    const m = oraclePose(R.oracle('0905_03'))
    const fwd = scorePose(target, pass, m, maxPair)
    const inv = scorePose(target, pass, rigidInvert(m), maxPair)
    console.log(`0905_03 forward rms ${fwd.rms} matched ${fwd.matched}; inverse rms ${inv.rms} matched ${inv.matched}`)
    expect(fwd.matched).toBeGreaterThanOrEqual(0.3)
    expect(inv.matched).toBeLessThan(0.05)
  }, 600_000)

  it('oracle scores are confident', () => {
    setup()
    const self = scorePose(target, ref, oraclePose(R.oracle('0905_02')), maxPair)
    console.log(`oracle 0905_02 (self): rms ${self.rms} matched ${self.matched}`)
    for (const n of ['0905_01', '0905_03', '0905_04', '0905_05'] as RevoPass[]) {
      const s = scorePose(target, load(n), oraclePose(R.oracle(n)), maxPair)
      console.log(`oracle ${n}: rms ${s.rms} matched ${s.matched}`)
      expect(poseConfidence(s, ref.spacing!)).toEqual({ lowOverlap: false, confident: true })
    }
  }, 900_000)

  it.skipIf(process.env.SCANRULER_HEAVY !== '1')('ICP from perturbed oracle and from identity', () => {
    setup()
    // 25 k samples first, then 200 k from where they ended. Pairs reach 30 mm
    // (6 x the perturbation) and must face the same way.
    const run = (n: RevoPass, name: string, start: Rigid, pass: PointGraph, oracle: Rigid, centroid: Float64Array, mustBeRight: boolean) => {
      let at = start
      for (const count of [25_000, 200_000]) {
        const t0 = performance.now()
        const r = icp(target, sampleScan(pass.positions, pass.normals, count), at, {
          maxIterations: 40, maxPairDistance: 30, minNormalDot: 0.5,
        })
        at = r.transform
        const s = scorePose(target, pass, at, maxPair)
        const conf = poseConfidence(s, ref.spacing!)
        const { deg, mm } = delta(at, oracle, centroid)
        process.stderr.write(`ICP ${n} ${name} ${count}: iters ${r.iterations} rms ${s.rms} matched ${s.matched} confident ${conf.confident} delta ${deg.toFixed(3)} deg ${mm.toFixed(3)} mm (${Math.round(performance.now() - t0)} ms)
`)
        if (count === 200_000) {
          const right = deg <= 1 && mm <= 1
          if (mustBeRight) {
            expect(conf.confident, `${n} ${name} confident`).toBe(true)
            expect(right, `${n} ${name} within 1 deg / 1 mm of the oracle`).toBe(true)
          } else {
            expect(!conf.confident || right, `${n} ${name}: confident only when right`).toBe(true)
          }
        }
      }
    }
    // Rotation and centroid displacement of a pose against the oracle.
    const delta = (at: Rigid, oracle: Rigid, centroid: Float64Array) => {
      const a = new Float64Array(3), b = new Float64Array(3)
      rigidApply(at, centroid[0], centroid[1], centroid[2], a)
      rigidApply(oracle, centroid[0], centroid[1], centroid[2], b)
      return { deg: rigidRotationAngle(rigidCompose(rigidInvert(oracle), at)) / DEG, mm: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }
    }
    for (const n of ['0905_01', '0905_03', '0905_04', '0905_05'] as RevoPass[]) {
      const pass = load(n)
      const o = oraclePose(R.oracle(n))
      // The pass's centroid in the target frame: the perturbation turns about it.
      let cx = 0, cy = 0, cz = 0
      const k = pass.positions.length / 3
      for (let i = 0; i < pass.positions.length; i += 3) { cx += pass.positions[i]; cy += pass.positions[i + 1]; cz += pass.positions[i + 2] }
      const own = Float64Array.from([cx / k, cy / k, cz / k])
      const c = new Float64Array(3)
      for (let a = 0; a < 3; a++) c[a] = (o.r[a * 3] * cx + o.r[a * 3 + 1] * cy + o.r[a * 3 + 2] * cz) / k + o.t[a]
      for (const sign of [1, -1]) {
        const d = rigidFromAxisAngle([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], sign * 5 * DEG)
        for (let a = 0; a < 3; a++) d.t[a] = c[a] - (d.r[a * 3] * c[0] + d.r[a * 3 + 1] * c[1] + d.r[a * 3 + 2] * c[2]) + (sign * 5) / Math.sqrt(3)
        run(n, sign > 0 ? '+5deg+5mm' : '-5deg-5mm', rigidCompose(d, o), pass, o, own, true)
      }
      run(n, 'identity', identityRigid(), pass, o, own, false)
      console.log(`${n} oracle rotation ${rigidRotationAngle(o) / DEG} deg`)
    }
  }, 3_600_000)
})
