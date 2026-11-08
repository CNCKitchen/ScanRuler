// SPDX-License-Identifier: AGPL-3.0-only
// An ICP whose passes are paired by helpers in blocks fits exactly as one that pairs them itself:
// the helpers run the same pairRange, and the score is summed in sample order here.
import { describe, expect, it } from 'vitest'
import {
  icpSteps, newPairArrays, pairRange, PAIR_CHUNK, sampleScan,
  type IcpOptions, type IcpPool, type IcpResult, type PairingSession, type ScanSamples,
} from '../src/core/deviation/icp'
import { icp } from '../src/core/deviation/icp'
import { rigidFromTwist, type Rigid } from '../src/core/deviation/rigid'
import { NominalSurface } from '../src/core/deviation/surface'

/** An ellipsoid: positions, outward normals and indices. */
function ellipsoid(a: number, b: number, c: number, nu: number, nv: number, inward = false) {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = []
  for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) {
    const th = (Math.PI * j) / nv, ph = (2 * Math.PI * i) / nu
    const u = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]
    pos.push(a * u[0], b * u[1], c * u[2])
    const n = [u[0] / a, u[1] / b, u[2] / c]
    const len = Math.hypot(n[0], n[1], n[2])
    nrm.push(...n.map((x) => (inward ? -x : x) / len))
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const p = j * nu + i, q = j * nu + ((i + 1) % nu), r = (j + 1) * nu + ((i + 1) % nu), s = (j + 1) * nu + i
    if (inward) idx.push(p, r, q, p, s, r)
    else idx.push(p, q, r, p, r, s)
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx) }
}

/** Helpers stood in for by blocks dealt out in turn, in this thread. */
function fakePool(helpers: number, surface: NominalSurface): IcpPool {
  return {
    session(samples: ScanSamples): PairingSession {
      const arrays = newPairArrays(samples.count)
      const session: PairingSession = {
        arrays,
        complete: false,
        ready: () => true,
        async pair(transform, params) {
          for (let index = 0; index < helpers; index++) {
            for (let c = index; c * PAIR_CHUNK < samples.count; c += helpers) {
              pairRange(surface, samples, transform, params, arrays, c * PAIR_CHUNK, Math.min(samples.count, (c + 1) * PAIR_CHUNK))
            }
          }
          session.complete = true
        },
      }
      return session
    },
  }
}

async function drive(gen: Generator<void | Promise<void>, IcpResult, void>): Promise<IcpResult> {
  let step = gen.next()
  while (!step.done) {
    if (step.value instanceof Promise) await step.value
    step = gen.next()
  }
  return step.value
}

describe('ICP with helpers', () => {
  const reference = ellipsoid(50, 40, 30, 48, 24)
  const surface = new NominalSurface(reference.positions, reference.indices)
  const scan = ellipsoid(50, 40, 30, 120, 60)
  const start: Rigid = rigidFromTwist([0.02, -0.01, 0.015], [1.2, -0.8, 0.5])
  const samples = sampleScan(scan.positions, scan.normals, 3000)

  for (const [name, options] of [
    ['plain', { maxIterations: 12 }],
    ['with a normals test', { maxIterations: 12, minNormalDot: 0.3 }],
    ['with a facing search', { maxIterations: 12, minNormalDot: 0.3, facingSearch: true, maxPairDistance: 8 }],
  ] as [string, IcpOptions][]) {
    for (const helpers of [1, 3]) {
      it(`${name}, ${helpers} helper(s), fits exactly as alone`, async () => {
        const alone = icp(surface, samples, start, options)
        const together = await drive(icpSteps(surface, samples, start, { ...options, pool: fakePool(helpers, surface) }))
        expect(together.iterations).toBe(alone.iterations)
        expect(together.score).toBe(alone.score)
        expect(together.matched).toBe(alone.matched)
        expect(Array.from(together.transform.r)).toEqual(Array.from(alone.transform.r))
        expect(Array.from(together.transform.t)).toEqual(Array.from(alone.transform.t))
      })
    }
  }

  it('a pass that the helpers did not finish is paired here', async () => {
    const broken: IcpPool = {
      session: (s) => {
        const arrays = newPairArrays(s.count)
        return { arrays, complete: false, ready: () => true, pair: async () => {} }
      },
    }
    const alone = icp(surface, samples, start, { maxIterations: 6 })
    const got = await drive(icpSteps(surface, samples, start, { maxIterations: 6, pool: broken }))
    expect(got.score).toBe(alone.score)
    expect(Array.from(got.transform.t)).toEqual(Array.from(alone.transform.t))
  })
})
