// SPDX-License-Identifier: AGPL-3.0-only
// Two RevoMetro passes of a cylinder head, in no shared frame: the layer
// (1111_02) onto the target (1111_01). Read only, from the RevoMetro project
// folder; skipped, loudly, where it is absent. SCANRULER_RUBEN_DIR points at
// the project's data folder.
//
// Auto align must land confidently, and the pose it lands on must beat the
// runner-up it tried. The six picked pairs of the near-symmetric bolt pattern
// (two hypotheses of which bosses are which, H1 and H2, as the session that
// found the problem picked them) must each come out at the auto pose or not
// confident: before the drift check, H1's refine slid 8.3 mm along the gasket
// face off every pick and was called confident — onto the very pose auto
// align finds independently, 59 % of the layer on the target against 4 % at
// the picks: the picks were the wrong points, and the drift check now says
// the refine left them. The default run does auto align and H1; the rest
// under SCANRULER_HEAVY=1.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoAlign, type AlignTarget } from '../core/globalAlign'
import { alignPairs, layerCloud, pairResidual, refineLayer, type LayerAlignResult, type LayerCloud } from '../core/layerAlign'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { identityRigid, rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { runSteps } from '../../../src/core/deviation/steps'
import { buildPointGraph, type PointGraph } from '../../../src/core/geometry/buildPointGraph'
import { parsePLY } from '../../../src/core/parsers/ply'
import type { Vec3 } from '../../../src/core/types'

const DIR = process.env.SCANRULER_RUBEN_DIR ?? ''
const LAYER = join(DIR, 'de0ba0ec-556a-4adc-849f-676b7139de15', 'fuse.ply')
const TARGET = join(DIR, '6816dc6a-7784-4a14-8c7f-046ee521bbb5', 'fuse.ply')
const EXISTS = Boolean(DIR) && existsSync(LAYER) && existsSync(TARGET)
if (!EXISTS) {
  console.warn(`\n⚠ Ruben head passes not found under "${DIR}" — their alignment tests are SKIPPED.\n  Set SCANRULER_RUBEN_DIR to the RevoMetro project's data folder to run them.\n`)
}
const HEAVY = process.env.SCANRULER_HEAVY === '1'
const DEG = Math.PI / 180
const log = (line: string) => { if (HEAVY) process.stderr.write(line + '\n') }

const load = (file: string): PointGraph => {
  const b = readFileSync(file)
  return buildPointGraph(parsePLY(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
}

// Fits on each pass, from the session that found the drift: the gasket-face
// plane and the boss axes (centre on the axis, unit axis), mm.
interface Axis { center: Vec3; axis: Vec3 }
interface Plane { center: Vec3; normal: Vec3 }
const PLANE_LAYER: Plane = { center: [-42.0911, -55.9319, -266.7923], normal: [0.93289, 0.318673, 0.16782] }
const PLANE_TARGET: Plane = { center: [52.4024, -37.2242, -366.169], normal: [-0.093605, 0.762061, 0.640703] }
const BOSS_LAYER: Record<string, Axis> = {
  a: { center: [-69.2355, -39.8194, -229.042], axis: [0.940986, 0.302346, 0.152095] },
  b: { center: [-67.6994, -16.8575, -280.5651], axis: [0.944257, 0.286705, 0.161801] },
  c: { center: [-50.9351, -92.375, -234.3885], axis: [0.943932, 0.30521, 0.125855] },
}
const BOSS_TARGET: Record<string, Axis> = {
  A: { center: [52.9153, -41.2463, -369.7724], axis: [-0.090954, 0.740098, 0.66632] },
  C: { center: [74.8009, -95.1116, -303.7692], axis: [-0.111905, 0.768297, 0.630236] },
  D: { center: [18.8435, -97.9831, -308.596], axis: [-0.060301, 0.770032, 0.635149] },
  E: { center: [4.80464, -63.5866, -350.6067], axis: [-0.074183, 0.756197, 0.650125] },
}
const HYPOTHESES: Record<string, [string, string][]> = {
  H1: [['a', 'E'], ['b', 'A'], ['c', 'D']],
  H2: [['a', 'D'], ['b', 'E'], ['c', 'C']],
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** Where a boss's axis meets the plane. */
function onPlane(c: Axis, p: Plane): Vec3 {
  const d: Vec3 = [p.center[0] - c.center[0], p.center[1] - c.center[1], p.center[2] - c.center[2]]
  const t = dot(d, p.normal) / dot(c.axis, p.normal)
  return [c.center[0] + t * c.axis[0], c.center[1] + t * c.axis[1], c.center[2] + t * c.axis[2]]
}
/** The six pairs: each boss where it meets the face, and 6 mm below it. */
function pairsOf(h: string): { layer: Vec3; target: Vec3 }[] {
  return HYPOTHESES[h].flatMap(([b, a]) => {
    const l = onPlane(BOSS_LAYER[b], PLANE_LAYER), t = onPlane(BOSS_TARGET[a], PLANE_TARGET)
    const nl = PLANE_LAYER.normal, nt = PLANE_TARGET.normal
    return [
      { layer: l, target: t },
      { layer: [l[0] - 6 * nl[0], l[1] - 6 * nl[1], l[2] - 6 * nl[2]] as Vec3, target: [t[0] - 6 * nt[0], t[1] - 6 * nt[1], t[2] - 6 * nt[2]] as Vec3 },
    ]
  })
}

function centroid(l: LayerCloud): Vec3 {
  const c: Vec3 = [0, 0, 0]
  const n = l.positions.length / 3
  for (let i = 0; i < l.positions.length; i += 3) for (let a = 0; a < 3; a++) c[a] += l.positions[i + a] / n
  return c
}
function delta(a: Rigid, b: Rigid, c: Vec3): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  rigidApply(a, c[0], c[1], c[2], p)
  rigidApply(b, c[0], c[1], c[2], q)
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
}
const fmt = (r: LayerAlignResult) =>
  `rms ${r.rms.toFixed(4)} matched ${r.matched.toFixed(4)} constraint ${r.constraint.toFixed(4)} drift ${r.drift?.toFixed(3) ?? '-'} drifted ${r.drifted ?? false} confident ${r.confident}`

describe.skipIf(!EXISTS)('Ruben head', () => {
  let target: AlignTarget
  let layer: LayerCloud
  let layerSpacing = 0
  let auto: Rigid | null = null
  const setup = () => {
    if (target) return
    const t = load(TARGET)
    target = { surface: new CloudSurface(t.positions, t.normals!, t.spacing), positions: t.positions, normals: t.normals!, spacing: t.spacing }
    const l = load(LAYER)
    layer = layerCloud(l.positions, l.normals!)
    layerSpacing = l.spacing
    log(`RUBEN target ${t.vertexCount} points spacing ${t.spacing.toFixed(4)}, layer ${l.vertexCount} points spacing ${l.spacing.toFixed(4)}`)
  }

  it('auto align lands confidently, clear of the runner-up', () => {
    setup()
    const t0 = performance.now()
    const tried: string[] = []
    const r = runSteps(autoAlign(target, layer, { layerSpacing, inspect: (stage, _p, s) => tried.push(`  ${stage} rms ${s.rms.toFixed(4)} matched ${s.matched.toFixed(4)} tight ${s.tight.toFixed(4)}`) }))
    const ms = Math.round(performance.now() - t0)
    tried.forEach(log)
    log(`RUBEN auto: ${fmt(r)} ambiguous ${r.ambiguous} hypotheses ${r.hypotheses} ${ms} ms`)
    auto = r.pose
    expect(r.confident).toBe(true)
    expect(r.ambiguous).toBe(false)
    expect(r.matched).toBeGreaterThanOrEqual(0.3)
    // A proper rotation, whatever it is (Horn's closed form never mirrors).
    const m = r.pose.r
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    expect(det).toBeCloseTo(1, 6)
  }, 900_000)

  it.skipIf(!HEAVY)('the auto pose fits better than the mirror-like half turn of it', () => {
    setup()
    if (!auto) auto = runSteps(autoAlign(target, layer, { layerSpacing })).pose
    // The layer turned half a turn about the gasket face's normal through its
    // own centre — the pose a symmetric reading of the face would give — and
    // refined from there: it must fit worse than the auto pose.
    const c = centroid(layer)
    const flip = rigidFromAxisAngle(PLANE_LAYER.normal, Math.PI)
    const rc = new Float64Array(3)
    rigidApply(flip, c[0], c[1], c[2], rc)
    for (let a = 0; a < 3; a++) flip.t[a] = c[a] - rc[a]
    const other = runSteps(refineLayer(target.surface, layer, rigidCompose(auto, flip), { targetSpacing: target.spacing }))
    const mine = runSteps(refineLayer(target.surface, layer, auto, { targetSpacing: target.spacing }))
    log(`RUBEN auto re-refined: ${fmt(mine)}; half turn: ${fmt(other)} off ${delta(other.pose, auto, c).deg.toFixed(2)} deg`)
    expect(mine.rms).toBeLessThan(other.rms)
  }, 900_000)

  for (const h of Object.keys(HYPOTHESES)) {
    // H2's picks start far off, and its refine is the slow kind (45 s).
    it.skipIf(h !== 'H1' && !HEAVY)(`six picks (${h}) land on the auto pose or are not confident`, () => {
      setup()
      if (!auto) auto = runSteps(autoAlign(target, layer, { layerSpacing })).pose
      const pairs = pairsOf(h)
      const t0 = performance.now()
      const r = runSteps(alignPairs(target.surface, layer, pairs, { targetSpacing: target.spacing }))
      const ms = Math.round(performance.now() - t0)
      const c = centroid(layer)
      const d = delta(r.pose, auto, c)
      log(`RUBEN pairs ${h}: ${fmt(r)} picks off ${pairResidual(pairs, r.pose).toFixed(3)} mm, from auto ${d.deg.toFixed(3)} deg ${d.mm.toFixed(3)} mm ${ms} ms`)
      if (r.confident) {
        expect(d.deg).toBeLessThan(1)
        expect(d.mm).toBeLessThan(1)
      }
    }, 900_000)
  }

  it.skipIf(!HEAVY)('a refine from the identity is never confident', () => {
    setup()
    const r = runSteps(refineLayer(target.surface, layer, identityRigid(), { targetSpacing: target.spacing, fromUserGuess: false }))
    log(`RUBEN identity refine: ${fmt(r)}`)
    expect(r.confident).toBe(false)
  }, 900_000)
})
