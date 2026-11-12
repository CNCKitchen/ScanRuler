// SPDX-License-Identifier: AGPL-3.0-only
// How long refineLayer takes on real passes, and where it lands: a
// measurement, not a check, so it runs only under SCANRULER_BENCH=1 and
// where the RevoMetro projects are present (read only). Each case prints its
// time and its distance from a reference pose: Revo's own merge for the gear,
// and for the Ruben head the pose auto align settles on, re-refined.
//
//   SCANRULER_BENCH=1 npx vitest run plugins/merge/tests/refineBench.test.ts

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoAlign } from '../core/globalAlign'
import { alignPairs, layerCloud, refineLayer, type LayerAlignResult, type LayerCloud } from '../core/layerAlign'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { oraclePose, scorePose } from '../../../src/core/deviation/poseScore'
import { rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { runSteps } from '../../../src/core/deviation/steps'
import { buildPointGraph, type PointGraph } from '../../../src/core/geometry/buildPointGraph'
import { parsePLY } from '../../../src/core/parsers/ply'
import { revo, type RevoPass } from '../../../tests/revoFixtures'
import type { Vec3 } from '../../../src/core/types'

const BENCH = process.env.SCANRULER_BENCH === '1'
const R = revo()
const RUBEN = process.env.SCANRULER_RUBEN_DIR || 'C:/Users/Jozkah/AppData/Roaming/RevoMetro/Projects/Ruben test/data'
const RUBEN_LAYER = join(RUBEN, 'de0ba0ec-556a-4adc-849f-676b7139de15', 'fuse.ply')
const RUBEN_TARGET = join(RUBEN, '6816dc6a-7784-4a14-8c7f-046ee521bbb5', 'fuse.ply')
const DEG = Math.PI / 180
const out = (line: string) => process.stderr.write(line + '\n')

const load = (file: string): PointGraph => {
  const b = readFileSync(file)
  return buildPointGraph(parsePLY(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
}

function centroid(l: LayerCloud): Float64Array {
  const c = new Float64Array(3)
  const n = l.positions.length / 3
  for (let i = 0; i < l.positions.length; i += 3) for (let a = 0; a < 3; a++) c[a] += l.positions[i + a] / n
  return c
}
function delta(a: Rigid, b: Rigid, c: Float64Array): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  rigidApply(a, c[0], c[1], c[2], p)
  rigidApply(b, c[0], c[1], c[2], q)
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
}
/** `deg` about an axis through the layer's centroid, then `mm` along it,
 *  applied in the layer's frame before `pose`. */
function off(pose: Rigid, axis: Vec3, deg: number, mm: number, c: Float64Array): Rigid {
  const l = Math.hypot(...axis)
  const k: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l]
  const d = rigidFromAxisAngle(k, deg * DEG)
  const rc = new Float64Array(3)
  rigidApply({ r: d.r, t: new Float64Array(3) }, c[0], c[1], c[2], rc)
  for (let a = 0; a < 3; a++) d.t[a] = c[a] - rc[a] + mm * k[a]
  return rigidCompose(pose, d)
}
function timed<T>(f: () => T): [T, number] {
  const t0 = performance.now()
  const r = f()
  return [r, Math.round(performance.now() - t0)]
}
const fmt = (name: string, r: LayerAlignResult, ms: number, d: { deg: number; mm: number }) =>
  `BENCH ${name}: ${ms} ms, ${d.deg.toFixed(4)} deg ${d.mm.toFixed(4)} mm off reference, rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(4)} constraint ${r.constraint.toFixed(4)} confident ${r.confident}${r.drifted ? ' drifted' : ''}`

describe.skipIf(!BENCH || !R.exists)('refine bench: Revo gear', () => {
  it('refines each pass from 5 to 20 degrees off the oracle', () => {
    const g = load(R.pass('0905_02'))
    const target = new CloudSurface(g.positions, g.normals!, g.spacing)
    const starts: Record<string, [number, number][]> = {
      '0905_01': [[5, 5]],
      '0905_03': [[5, 5], [-5, -5], [10, 0], [20, 10]],
      '0905_04': [[5, 5]],
      '0905_05': [[5, 5]],
    }
    for (const [n, list] of Object.entries(starts) as [RevoPass, [number, number][]][]) {
      const l = load(R.pass(n))
      const layer = layerCloud(l.positions, l.normals!)
      const oracle = oraclePose(R.oracle(n))
      const c = centroid(layer)
      const os = scorePose(target, layer, oracle, 3 * g.spacing)
      out(`BENCH gear ${n} oracle: rms ${os.rms.toFixed(4)} matched ${os.matched.toFixed(4)}`)
      for (const [deg, mm] of list) {
        const [r, ms] = timed(() => runSteps(refineLayer(target, layer, off(oracle, [1, 1, 1], deg, mm, c))))
        out(fmt(`gear ${n} ${deg}deg ${mm}mm`, r, ms, delta(r.pose, oracle, c)))
        expect(r.pose).toBeTruthy()
      }
    }
  }, 1_800_000)
})

describe.skipIf(!BENCH || !existsSync(RUBEN_LAYER) || !existsSync(RUBEN_TARGET))('refine bench: Ruben head', () => {
  it('refines the head from auto align and from rough starts', () => {
    const t = load(RUBEN_TARGET)
    const surface = new CloudSurface(t.positions, t.normals!, t.spacing)
    const l = load(RUBEN_LAYER)
    const layer = layerCloud(l.positions, l.normals!)
    const c = centroid(layer)
    const opts = { targetSpacing: t.spacing }
    const [auto, autoMs] = timed(() => runSteps(autoAlign({ surface, positions: t.positions, normals: t.normals!, spacing: t.spacing }, layer, { layerSpacing: l.spacing })))
    const [ref, refMs] = timed(() => runSteps(refineLayer(surface, layer, auto.pose, opts)))
    out(fmt('ruben auto align', auto, autoMs, delta(auto.pose, ref.pose, c)))
    out(fmt('ruben refine at the auto pose', ref, refMs, delta(ref.pose, ref.pose, c)))
    const starts: [string, Vec3, number, number][] = [
      ['3deg 3mm', [1, 1, 1], 3, 3],
      ['8deg 8mm', [1, -1, 0.5], 8, 8],
      ['15deg 10mm', [0.2, 1, -1], 15, 10],
    ]
    for (const [name, axis, deg, mm] of starts) {
      const [r, ms] = timed(() => runSteps(refineLayer(surface, layer, off(ref.pose, axis, deg, mm, c), opts)))
      out(fmt(`ruben refine from ${name}`, r, ms, delta(r.pose, ref.pose, c)))
    }
    // The H1 picks from rubenAlign.test: three bosses where they meet the
    // gasket face and 6 mm below; the refine slides 8.3 mm off them.
    const [r, ms] = timed(() => runSteps(alignPairs(surface, layer, H1, opts)))
    out(fmt('ruben H1 picks', r, ms, delta(r.pose, ref.pose, c)))
    expect(ref.pose).toBeTruthy()
  }, 3_600_000)
})

const H1: { layer: Vec3; target: Vec3 }[] = (() => {
  interface Axis { center: Vec3; axis: Vec3 }
  const PL = { center: [-42.0911, -55.9319, -266.7923] as Vec3, normal: [0.93289, 0.318673, 0.16782] as Vec3 }
  const PT = { center: [52.4024, -37.2242, -366.169] as Vec3, normal: [-0.093605, 0.762061, 0.640703] as Vec3 }
  const L: Axis[] = [
    { center: [-69.2355, -39.8194, -229.042], axis: [0.940986, 0.302346, 0.152095] },
    { center: [-67.6994, -16.8575, -280.5651], axis: [0.944257, 0.286705, 0.161801] },
    { center: [-50.9351, -92.375, -234.3885], axis: [0.943932, 0.30521, 0.125855] },
  ]
  const T: Axis[] = [
    { center: [4.80464, -63.5866, -350.6067], axis: [-0.074183, 0.756197, 0.650125] },
    { center: [52.9153, -41.2463, -369.7724], axis: [-0.090954, 0.740098, 0.66632] },
    { center: [18.8435, -97.9831, -308.596], axis: [-0.060301, 0.770032, 0.635149] },
  ]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const onPlane = (c: Axis, p: { center: Vec3; normal: Vec3 }): Vec3 => {
    const t = dot([p.center[0] - c.center[0], p.center[1] - c.center[1], p.center[2] - c.center[2]], p.normal) / dot(c.axis, p.normal)
    return [c.center[0] + t * c.axis[0], c.center[1] + t * c.axis[1], c.center[2] + t * c.axis[2]]
  }
  return L.flatMap((b, i) => {
    const l = onPlane(b, PL), t = onPlane(T[i], PT)
    const nl = PL.normal, nt = PT.normal
    return [
      { layer: l, target: t },
      { layer: [l[0] - 6 * nl[0], l[1] - 6 * nl[1], l[2] - 6 * nl[2]] as Vec3, target: [t[0] - 6 * nt[0], t[1] - 6 * nt[1], t[2] - 6 * nt[2]] as Vec3 },
    ]
  })
})()
