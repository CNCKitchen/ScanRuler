// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  AlignmentError,
  computeDatumAlignment,
  describeRigid,
  fitFromAlignPicks,
  manualRigid,
  transformFit,
} from '../src/core/alignment'
import { alignmentPreview, type AlignDraft } from '../src/state/store'
import { rigidCompose, rigidInvert, rigidRotationAngle } from '../src/core/deviation/rigid'
import { orthoBasis } from '../src/core/fit/linalg'
import { normalize } from '../src/core/vec'
import type { CylinderFit, PlaneFit, PointFit, SphereFit, Vec3 } from '../src/core/types'

const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }

function planeFit(center: Vec3, normal: Vec3): PlaneFit {
  const n = normalize(normal)!
  const [u, v] = orthoBasis(n)
  return { kind: 'plane', center, normal: n, basisU: u, basisV: v, extentU: 5, extentV: 5, ...NO_STATS }
}

function cylinderFit(center: Vec3, axis: Vec3, radius = 4): CylinderFit {
  return { kind: 'cylinder', center, axis: normalize(axis)!, radius, length: 20, coverage: 360, ...NO_STATS }
}

function pointFit(center: Vec3): PointFit {
  return { kind: 'point', center, ...NO_STATS }
}

function sphereFit(center: Vec3, radius = 3): SphereFit {
  return { kind: 'sphere', center, radius, ...NO_STATS }
}

// Deliberately off-axis datums, so an axis-aligned bug cannot pass by accident.
const TILTED: Vec3 = [0.3, -0.5, 0.81]
const SKEWED: Vec3 = [0.9, 0.35, 0.1]

describe('computeDatumAlignment', () => {
  it('levels a plane onto +Z and zeroes its coordinate', () => {
    const p = planeFit([12, -3, 7], TILTED)
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, null, null)
    const moved = transformFit(p, m) as PlaneFit
    expect(moved.normal[0]).toBeCloseTo(0, 9)
    expect(moved.normal[1]).toBeCloseTo(0, 9)
    expect(moved.normal[2]).toBeCloseTo(1, 9)
    expect(moved.center[2]).toBeCloseTo(0, 9)
  })

  it('respects the sign of the chosen axis', () => {
    const p = planeFit([1, 2, 3], TILTED)
    const m = computeDatumAlignment({ fit: p, axis: 'y-' }, null, null)
    const moved = transformFit(p, m) as PlaneFit
    expect(moved.normal[1]).toBeCloseTo(-1, 9)
    expect(moved.center[1]).toBeCloseTo(0, 9)
  })

  it('puts a primary cylinder onto the global axis line', () => {
    const c = cylinderFit([5, 6, 7], SKEWED)
    const m = computeDatumAlignment({ fit: c, axis: 'z+' }, null, null)
    const moved = transformFit(c, m) as CylinderFit
    expect(moved.axis[2]).toBeCloseTo(1, 9)
    expect(moved.center[0]).toBeCloseTo(0, 9)
    expect(moved.center[1]).toBeCloseTo(0, 9)
    expect(moved.radius).toBe(c.radius)
    expect(moved.length).toBe(c.length)
  })

  it('clocks the rotation with a secondary datum', () => {
    const p = planeFit([0, 0, 10], TILTED)
    const c = cylinderFit([20, 5, 12], SKEWED)
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, { fit: c, axis: 'x+' }, null)
    const movedPlane = transformFit(p, m) as PlaneFit
    const movedCyl = transformFit(c, m) as CylinderFit
    // The primary still wins exactly…
    expect(movedPlane.normal[2]).toBeCloseTo(1, 9)
    expect(movedPlane.center[2]).toBeCloseTo(0, 9)
    // …and the secondary's projected direction lands in the XZ plane, X first.
    expect(movedCyl.axis[1]).toBeCloseTo(0, 9)
    expect(movedCyl.axis[0]).toBeGreaterThan(0)
    // The secondary axis owns the Y zero the plane left open.
    expect(movedCyl.center[1]).toBeCloseTo(0, 9)
  })

  it('sets the origin from a point for every coordinate the datums left open', () => {
    const p = planeFit([0, 0, 10], TILTED)
    const o = sphereFit([25, -8, 11])
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, null, o)
    const movedO = transformFit(o, m) as SphereFit
    const movedP = transformFit(p, m) as PlaneFit
    // The plane keeps Z; the sphere centre zeroes X and Y.
    expect(movedP.center[2]).toBeCloseTo(0, 9)
    expect(movedO.center[0]).toBeCloseTo(0, 9)
    expect(movedO.center[1]).toBeCloseTo(0, 9)
  })

  it('a lone origin point moves to the exact origin', () => {
    const c = cylinderFit([5, 6, 7], SKEWED)
    const o = pointFit([9, 9, 9])
    const m = computeDatumAlignment({ fit: c, axis: 'x+' }, null, o)
    const moved = transformFit(o, m) as PointFit
    // Cylinder → X axis owns Y and Z; the point sets the remaining X.
    expect(moved.center[0]).toBeCloseTo(0, 9)
  })

  it('is rigid: distances and angles survive', () => {
    const p = planeFit([12, -3, 7], TILTED)
    const a = pointFit([1, 2, 3])
    const b = pointFit([-4, 6, 2])
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, null, null)
    const ma = transformFit(a, m) as PointFit
    const mb = transformFit(b, m) as PointFit
    const before = Math.hypot(...([0, 1, 2].map((i) => a.center[i] - b.center[i]) as Vec3))
    const after = Math.hypot(...([0, 1, 2].map((i) => ma.center[i] - mb.center[i]) as Vec3))
    expect(after).toBeCloseTo(before, 9)
  })

  it('refuses parallel datum directions', () => {
    const p = planeFit([0, 0, 0], TILTED)
    const c = cylinderFit([5, 5, 5], TILTED)
    expect(() =>
      computeDatumAlignment({ fit: p, axis: 'z+' }, { fit: c, axis: 'x+' }, null),
    ).toThrow(AlignmentError)
  })

  it('refuses a secondary datum on the same axis letter', () => {
    const p = planeFit([0, 0, 0], TILTED)
    const c = cylinderFit([5, 5, 5], SKEWED)
    expect(() =>
      computeDatumAlignment({ fit: p, axis: 'z+' }, { fit: c, axis: 'z-' }, null),
    ).toThrow(AlignmentError)
  })

  it('handles an antiparallel primary (180° flip)', () => {
    const p = planeFit([0, 0, 5], [0, 0, -1])
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, null, null)
    const moved = transformFit(p, m) as PlaneFit
    expect(moved.normal[2]).toBeCloseTo(1, 9)
    expect(describeRigid(m).rotationDeg).toBeCloseTo(180, 6)
  })

  it('accepts picked points in any slot — full mix and match', () => {
    // Three points spanning the XY plane at z = 4, tilted slightly.
    const primary = fitFromAlignPicks('primary', [[0, 0, 4], [10, 0, 5], [0, 10, 4.5]], 100)!
    const secondary = fitFromAlignPicks('secondary', [[0, 0, 4], [10, 2, 5]], 100)!
    const origin = fitFromAlignPicks('origin', [[3, 3, 4]], 100)!
    expect(primary.kind).toBe('plane')
    expect(secondary.kind).toBe('line')
    expect(origin.kind).toBe('point')

    const m = computeDatumAlignment(
      { fit: primary, axis: 'z+' },
      { fit: secondary, axis: 'x+' },
      origin,
    )
    const movedPlane = transformFit(primary, m)
    const movedOrigin = transformFit(origin, m)
    expect(movedPlane.kind === 'plane' && Math.abs(movedPlane.normal[2])).toBeCloseTo(1, 9)
    expect(movedPlane.center[2]).toBeCloseTo(0, 9)
    // Plane owns Z, secondary line owns what it can, the point the rest.
    expect(Math.abs(movedOrigin.center[0])).toBeLessThan(1e-9)
  })

  it('picked points return null while incomplete and reject degenerate sets', () => {
    expect(fitFromAlignPicks('primary', [[0, 0, 0], [1, 0, 0]], 100)).toBeNull()
    expect(fitFromAlignPicks('origin', [], 100)).toBeNull()
    expect(() => fitFromAlignPicks('primary', [[0, 0, 0], [1, 1, 1], [2, 2, 2]], 100)).toThrow(
      AlignmentError,
    )
    expect(() => fitFromAlignPicks('secondary', [[1, 1, 1], [1, 1, 1]], 100)).toThrow(
      AlignmentError,
    )
  })

  it('manual move / rotate: turns about the origin X→Y→Z, then moves', () => {
    // Pure move.
    const moved = transformFit(pointFit([1, 2, 3]), manualRigid([10, -5, 2], [0, 0, 0]))
    expect(moved.center[0]).toBeCloseTo(11, 12)
    expect(moved.center[1]).toBeCloseTo(-3, 12)
    expect(moved.center[2]).toBeCloseTo(5, 12)

    // 90° about Z carries +X onto +Y (right-handed).
    const turned = transformFit(pointFit([1, 0, 0]), manualRigid([0, 0, 0], [0, 0, 90]))
    expect(turned.center[0]).toBeCloseTo(0, 12)
    expect(turned.center[1]).toBeCloseTo(1, 12)

    // Order: X first, then Z. (0,1,0) → Rx90 → (0,0,1), unchanged by Rz.
    const both = transformFit(pointFit([0, 1, 0]), manualRigid([0, 0, 0], [90, 0, 90]))
    expect(both.center[2]).toBeCloseTo(1, 12)
    expect(Math.hypot(both.center[0], both.center[1])).toBeLessThan(1e-12)

    const zero = manualRigid([0, 0, 0], [0, 0, 0])
    expect(describeRigid(zero).rotationDeg).toBeCloseTo(0, 12)
    expect(describeRigid(zero).translation).toBeCloseTo(0, 12)
  })

  it('previews live from picked points, and follows the axis they point along', () => {
    // A tilted triangle of points, the way three clicks on a face arrive.
    const draft: AlignDraft = {
      primary: null,
      primaryPicks: [[0, 0, 4], [10, 0, 5], [0, 10, 4.5]],
      primaryAxis: 'z+',
      secondary: null,
      secondaryPicks: [],
      secondaryAxis: 'x+',
      origin: null,
      originPicks: [],
      pickSlot: 'primary',
    }
    const shown = alignmentPreview(draft, [], 100)
    expect(shown.error).toBeNull()
    const levelled = transformFit(
      fitFromAlignPicks('primary', draft.primaryPicks, 100)!,
      shown.preview!.rigid,
    )
    expect(levelled.kind === 'plane' && levelled.normal[2]).toBeCloseTo(1, 9)
    expect(shown.preview!.rotationDeg).toBeGreaterThan(0)

    // The same picks pointing along −Y instead: the preview follows the choice.
    const sideways = alignmentPreview({ ...draft, primaryAxis: 'y-' }, [], 100)
    const turned = transformFit(
      fitFromAlignPicks('primary', draft.primaryPicks, 100)!,
      sideways.preview!.rigid,
    )
    expect(turned.kind === 'plane' && turned.normal[1]).toBeCloseTo(-1, 9)
  })

  it('preview stays quiet until the levelling slot is filled, and reports its own errors', () => {
    const empty: AlignDraft = {
      primary: null,
      primaryPicks: [[0, 0, 0], [1, 0, 0]],
      primaryAxis: 'z+',
      secondary: null,
      secondaryPicks: [],
      secondaryAxis: 'x+',
      origin: null,
      originPicks: [],
      pickSlot: 'primary',
    }
    // Two of three points: nothing to show yet, and nothing wrong either.
    expect(alignmentPreview(empty, [], 100)).toEqual({ preview: null, error: null })

    // Collinear picks are a message for the operator, not an exception.
    const bad = alignmentPreview(
      { ...empty, primaryPicks: [[0, 0, 0], [1, 1, 1], [2, 2, 2]] },
      [],
      100,
    )
    expect(bad.preview).toBeNull()
    expect(bad.error).toMatch(/line/)
  })

  it('reset via the inverse composes to the identity', () => {
    const p = planeFit([12, -3, 7], TILTED)
    const c = cylinderFit([20, 5, 12], SKEWED)
    const m = computeDatumAlignment({ fit: p, axis: 'z+' }, { fit: c, axis: 'x+' }, null)
    const roundTrip = rigidCompose(rigidInvert(m), m)
    expect(rigidRotationAngle(roundTrip)).toBeLessThan(1e-12)
    expect(Math.hypot(roundTrip.t[0], roundTrip.t[1], roundTrip.t[2])).toBeLessThan(1e-9)
  })
})
