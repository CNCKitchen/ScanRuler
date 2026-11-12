// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { alignDatums, alignPairs, datumResidual, flippedAxis, layerCloud, refineLayer, type LayerAlignResult, type LayerCloud } from '../core/layerAlign'
import { datumPose, type DatumSet } from '../core/datums'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { runSteps } from '../../../src/core/deviation/steps'
import { identityRigid, rigidApply, rigidCompose, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { transformFit } from '../../../src/core/alignment'
import { buildPointGraph } from '../../../src/core/geometry/buildPointGraph'
import type { ConeFit, CylinderFit, FitData, PlaneFit, Vec3 } from '../../../src/core/types'
import { applyRigidCloud, blockWithBoreCloud, halves, rigidOf, type Cloud } from '../../../tests/cloudFixtures'

const UNDER = 'Needs two datums on each side — one alone leaves the part free to turn or slide.'
const DEG = Math.PI / 180

// The part in its own frame; the target is the half at +x, the layer the half
// at -x scanned in a frame `TRUE` off, so the pose that lays it on the target
// is TRUE^-1.
const block = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step: 1 })
const [lo, hi] = halves(block, 0, 16)
const TRUE = rigidOf([12, -7, 20], [5, -3, 8])
const POSE = rigidInvert(TRUE)

function surfaceOf(c: Cloud): CloudSurface {
  const g = buildPointGraph({ kind: 'cloud', positions: c.positions, normals: c.normals })
  return new CloudSurface(g.positions, g.normals!, g.spacing)
}
const target = surfaceOf(hi)
const layerPart = applyRigidCloud(lo, TRUE)
const layer: LayerCloud = layerCloud(layerPart.positions, layerPart.normals)

/** Rotation (degrees) and the largest displacement over the layer's points (mm)
 *  between two poses. */
function delta(a: Rigid, b: Rigid, l: LayerCloud = layer): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  let mm = 0
  for (let i = 0; i < l.positions.length; i += 3) {
    rigidApply(a, l.positions[i], l.positions[i + 1], l.positions[i + 2], p)
    rigidApply(b, l.positions[i], l.positions[i + 1], l.positions[i + 2], q)
    mm = Math.max(mm, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return { deg: rigidRotationAngle(rigidCompose(rigidInvert(b), a)) / DEG, mm }
}

/** A point of the part, as the layer sees it and as the target does. */
const pick = (x: number, y: number, z: number) => {
  const l = new Float64Array(3)
  rigidApply(TRUE, x, y, z, l)
  return { layer: [l[0], l[1], l[2]] as Vec3, target: [x, y, z] as Vec3 }
}

function expectRecovered(r: LayerAlignResult, deg: number, mm: number): void {
  const d = delta(r.pose, POSE)
  expect(d.deg, 'rotation off').toBeLessThanOrEqual(deg)
  expect(d.mm, 'displacement off').toBeLessThanOrEqual(mm)
  expect(r.lowOverlap).toBe(false)
}

describe('alignPairs', () => {
  it('recovers the pose from three picks', () => {
    const r = runSteps(alignPairs(target, layer, [pick(-8, -15, 10), pick(5, 15, -10), pick(8, -15, -10)]))
    expectRecovered(r, 0.05, 0.02)
    expect(r.confident).toBe(true)
  })

  it('recovers the pose from four rough picks', () => {
    // Clicks are never exact: each 0.4 mm out.
    const pairs = [pick(-8, -15, 10), pick(5, 15, -10), pick(8, -15, -10), pick(0, 15, 10)]
    pairs.forEach((p, i) => { p.target = [p.target[0] + 0.4 * (i % 2 ? 1 : -1), p.target[1], p.target[2] + 0.4] })
    const r = runSteps(alignPairs(target, layer, pairs))
    expectRecovered(r, 0.05, 0.02)
  })

  it('picks that put the layer off its place: the refine drifts from them, and is never confident', () => {
    // Each pick 3 mm along +y of the point meant: the picks' own pose is
    // 3 mm off, and the refine leaves them to settle where the part fits.
    const pairs = [pick(-8, -15, 10), pick(5, 15, -10), pick(8, -15, -10), pick(0, 15, 10)]
    pairs.forEach((p) => { p.target = [p.target[0], p.target[1] + 3, p.target[2]] })
    const r = runSteps(alignPairs(target, layer, pairs))
    expect(r.drifted).toBe(true)
    expect(r.confident).toBe(false)
    expect(r.drift).toBeGreaterThan(2.5)
    // It fits clearly better than the picks' pose, so that is the pose kept.
    expectRecovered(r, 0.05, 0.02)
  })

  it('picks the refine keeps to: not drifted, the drift reported', () => {
    const r = runSteps(alignPairs(target, layer, [pick(-8, -15, 10), pick(5, 15, -10), pick(8, -15, -10)]))
    expect(r.drifted).toBeUndefined()
    expect(r.drift).toBeLessThan(0.01)
    expect(r.constraint).toBeGreaterThan(0.005)
  })

  it('refuses too few picks and picks in a line', () => {
    expect(() => runSteps(alignPairs(target, layer, [pick(0, -15, 0), pick(5, -15, 0)]))).toThrow('Pick at least three point pairs')
    expect(() => runSteps(alignPairs(target, layer, [pick(0, -15, 0), pick(4, -15, 0), pick(8, -15, 0)]))).toThrow('nearly in a line')
  })
})

describe('datumPose', () => {
  // Datums of the part in its own frame: the -y face and the bore.
  const face: PlaneFit = {
    kind: 'plane', center: [0, -15, 0], normal: [0, -1, 0], basisU: [1, 0, 0], basisV: [0, 0, 1],
    extentU: 4, extentV: 10, sigma: 0, usedPoints: 100, regionSize: 100,
  }
  const bore: CylinderFit = {
    kind: 'cylinder', center: [0, 0, 0], axis: [0, 0, 1], radius: 6, length: 20, coverage: 360,
    sigma: 0, usedPoints: 100, regionSize: 100,
  }
  const side = (m: Rigid, fits: { primary: FitData; secondary?: FitData; origin?: FitData }): DatumSet => ({
    primary: { fit: transformFit(fits.primary, m), axis: 'z+' },
    secondary: fits.secondary ? { fit: transformFit(fits.secondary, m), axis: 'x+' } : null,
    origin: fits.origin ? transformFit(fits.origin, m) : null,
  })

  it('a plane and the bore on both halves recover the pose', () => {
    const pose = datumPose(side(TRUE, { primary: face, secondary: bore }), side(identityRigid(), { primary: face, secondary: bore }))
    if ('refused' in pose) throw new Error(pose.refused)
    const d = delta(pose, POSE)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
  })

  it('alignDatums recovers the pose when the layer bore axis was fitted the other way', () => {
    const flipped: CylinderFit = { ...bore, axis: [0, 0, -1] }
    const layerSet = side(TRUE, { primary: face, secondary: flipped })
    const targetSet = side(identityRigid(), { primary: face, secondary: bore })
    // The bare datum pose is half a turn out.
    const raw = datumPose(layerSet, targetSet)
    if ('refused' in raw) throw new Error(raw.refused)
    expect(delta(raw, POSE).deg).toBeGreaterThan(170)
    const r = runSteps(alignDatums(target, layer, layerSet, targetSet))
    if ('refused' in r) throw new Error(r.refused)
    expectRecovered(r, 0.05, 0.02)
    expect(r.confident).toBe(true)
  })

  it('alignDatums passes the refusal on', () => {
    const one = side(identityRigid(), { primary: face })
    expect(runSteps(alignDatums(target, layer, one, one))).toEqual({ refused: UNDER })
  })

  it('alignDatums refuses two parallel planes', () => {
    const back: PlaneFit = { ...face, center: [0, 15, 0], normal: [0, 1, 0] }
    const s = side(identityRigid(), { primary: face, secondary: back })
    expect(runSteps(alignDatums(target, layer, s, s))).toEqual({ refused: UNDER })
  })

  it('refuses a plane alone, on either side', () => {
    const one = side(identityRigid(), { primary: face })
    const two = side(identityRigid(), { primary: face, secondary: bore })
    expect(datumPose(one, two)).toEqual({ refused: UNDER })
    expect(datumPose(two, one)).toEqual({ refused: UNDER })
  })

  it('refuses two parallel planes', () => {
    const back: PlaneFit = { ...face, center: [0, 15, 0], normal: [0, 1, 0] }
    const s = side(identityRigid(), { primary: face, secondary: back })
    expect(datumPose(s, s)).toEqual({ refused: UNDER })
  })
})

describe('refineLayer', () => {
  it('converges from 30 degrees off', () => {
    // 30 degrees about one axis, and 4 mm out, from the true pose.
    const off = rigidCompose(rigidOf([0, 0, 0], [3, -2, 2]), rigidCompose(rigidOf([30 / Math.sqrt(2), 30 / Math.sqrt(2), 0], [0, 0, 0]), POSE))
    expect(delta(off, POSE).deg).toBeGreaterThan(25)
    const r = runSteps(refineLayer(target, layer, off))
    expectRecovered(r, 0.05, 0.02)
    expect(r.confident).toBe(true)
  })

  it('is never confident from a start nobody chose', () => {
    const r = runSteps(refineLayer(target, layer, POSE, { fromUserGuess: false }))
    expectRecovered(r, 0.05, 0.02)
    expect(r.confident).toBe(false)
  })

  it('flags halves that do not touch as low overlap', () => {
    const [a, b] = halves(block, 0, -12)
    const r = runSteps(refineLayer(surfaceOf(b), layerCloud(a.positions, a.normals), identityRigid()))
    expect(r.matched).toBeLessThan(0.3)
    expect(r.lowOverlap).toBe(true)
    expect(r.confident).toBe(false)
  })

  it('aligns an inch layer onto a millimetre base once scaled', () => {
    const inch = { positions: layerPart.positions.map((v) => v / 25.4), normals: layerPart.normals }
    const scaled = layerCloud(inch.positions, inch.normals, 25.4)
    const start = rigidCompose(rigidOf([4, -3, 2], [1, 1, -1]), POSE)
    const r = runSteps(refineLayer(target, scaled, start))
    const d = delta(r.pose, POSE, scaled)
    expect(d.deg).toBeLessThanOrEqual(0.05)
    expect(d.mm).toBeLessThanOrEqual(0.02)
    expect(r.lowOverlap).toBe(false)
  })
})

describe('cone datums', () => {
  const cone = (halfAngle: number, center: Vec3, radius: number): ConeFit =>
    ({ kind: 'cone', center, axis: [0, 0, 1], halfAngle, radius, radius1: radius, radius2: radius, length: 10 }) as unknown as ConeFit
  const set = (fit: FitData): DatumSet => ({ primary: { fit, axis: 'z+' }, secondary: null, origin: null })

  it('a cone is tried the other way round only when it is near a cylinder', () => {
    expect(flippedAxis({ fit: cone(20, [0, 0, 0], 5), axis: 'z+' })).toBeNull()
    expect(flippedAxis({ fit: cone(-20, [0, 0, 0], 5), axis: 'z+' })).toBeNull()
    const slim = flippedAxis({ fit: cone(0.3, [0, 0, 0], 5), axis: 'z+' })
    expect((slim!.fit as ConeFit).axis).toEqual([-0, -0, -1])
  })

  it('reads a cone gap by its apex, a near-cylindrical one by its axis', () => {
    // Same steep cone, centred at different heights: one apex, no gap.
    expect(datumResidual(set(cone(20, [0, 0, 0], 5)), set(cone(20, [0, 0, 3], 5 + 3 * Math.tan(20 * DEG))), identityRigid())).toBeLessThan(1e-9)
    // Steep, apexes 2 mm apart along the axis.
    expect(datumResidual(set(cone(20, [0, 0, 0], 5)), set(cone(20, [0, 0, 2], 5)), identityRigid())).toBeCloseTo(2, 6)
    // Near a cylinder, 0.01 mm of radius moves the apex by 2 mm: the gap is
    // read across the axis only, here 0.5 mm.
    expect(datumResidual(set(cone(0.3, [0, 0, 0], 5)), set(cone(0.3, [0.5, 0, 4], 5.01)), identityRigid())).toBeCloseTo(0.5, 6)
  })
})
