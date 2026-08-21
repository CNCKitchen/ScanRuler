// SPDX-License-Identifier: AGPL-3.0-only
// Aligning an element to a reference plane: the rotation that takes a fit's
// direction onto its designed relation, the warning once the measurement is
// too far from it, and what the store does with it — the alignment has to
// follow the reference plane, survive a re-fit and an edit, and come off
// cleanly when the reference goes.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ORIENT_TOLERANCE_DEG,
  OrientError,
  orientFit,
  relationLabel,
} from '../src/core/elements/orient'
import { buildSummary } from '../src/core/summary'
import { blockedRefs, useStore } from '../src/state/store'
import { acuteAngle, dot, len, sub } from '../src/core/vec'
import type {
  CircleFit,
  CylinderFit,
  FitData,
  FitOutput,
  LineFit,
  PlaneFit,
  Vec3,
} from '../src/core/types'

const STATS = {
  sigma: 0.002,
  usedPoints: 100,
  regionSize: 120,
  formError: 0.01,
}

/** A unit vector a small angle off +z, tilted towards +x. */
function tilted(deg: number): Vec3 {
  const a = (deg * Math.PI) / 180
  return [Math.sin(a), 0, Math.cos(a)]
}

const base: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 20,
  extentV: 20,
  ...STATS,
}

/** A plane 0.4° off parallel to the base, 10 mm above it. */
const top: PlaneFit = {
  ...base,
  center: [3, 4, 10],
  normal: tilted(0.4),
  basisU: [Math.cos((0.4 * Math.PI) / 180), 0, -Math.sin((0.4 * Math.PI) / 180)],
  extentU: 7,
  extentV: 3,
}

const bore: CylinderFit = {
  kind: 'cylinder',
  center: [5, 5, 5],
  axis: tilted(0.3),
  radius: 4,
  length: 10,
  coverage: 360,
  ...STATS,
}

describe('aligning a fit to a reference plane', () => {
  it('turns a plane parallel to the reference, about its own centre', () => {
    const { fit, deviationDeg, warning } = orientFit(top, base, 'normal')
    expect(fit.kind).toBe('plane')
    if (fit.kind !== 'plane') return
    expect(fit.normal).toEqual([0, 0, 1])
    expect(fit.center).toEqual(top.center)
    expect(deviationDeg).toBeCloseTo(0.4, 6)
    expect(warning).toBeNull()
    // The in-plane basis followed the normal and is still orthonormal to it.
    expect(Math.abs(dot(fit.basisU, fit.normal))).toBeLessThan(1e-9)
    expect(Math.abs(dot(fit.basisV, fit.normal))).toBeLessThan(1e-9)
    expect(Math.abs(dot(fit.basisU, fit.basisV))).toBeLessThan(1e-9)
    expect(len(fit.basisU)).toBeCloseTo(1, 9)
    // Nothing measured changed.
    expect(fit.extentU).toBe(7)
    expect(fit.sigma).toBe(STATS.sigma)
    expect(fit.formError).toBe(STATS.formError)
  })

  it('keeps the side a plane faces: a normal pointing down aligns downwards', () => {
    const down: PlaneFit = {
      ...top,
      normal: [-top.normal[0], 0, -top.normal[2]],
    }
    const { fit } = orientFit(down, base, 'normal')
    if (fit.kind !== 'plane') throw new Error()
    expect(fit.normal).toEqual([-0, -0, -1])
  })

  it('stands a cylinder perpendicular to the reference', () => {
    const { fit, deviationDeg } = orientFit(bore, base, 'normal')
    if (fit.kind !== 'cylinder') throw new Error()
    expect(fit.axis).toEqual([0, 0, 1])
    expect(fit.center).toEqual(bore.center)
    expect(fit.radius).toBe(4)
    expect(fit.length).toBe(10)
    expect(deviationDeg).toBeCloseTo(0.3, 6)
  })

  it('lays an axis into the plane for the in-plane relation', () => {
    // A shaft nearly along x, nodding 0.5° up out of the base plane.
    const a = (0.5 * Math.PI) / 180
    const shaft: CylinderFit = { ...bore, axis: [Math.cos(a), 0, Math.sin(a)] }
    const { fit, deviationDeg } = orientFit(shaft, base, 'inPlane')
    if (fit.kind !== 'cylinder') throw new Error()
    expect(fit.axis[0]).toBeCloseTo(1, 9)
    expect(fit.axis[2]).toBeCloseTo(0, 12)
    expect(deviationDeg).toBeCloseTo(0.5, 6)
  })

  it('turns a line and a circle the same way', () => {
    const line: LineFit = {
      kind: 'line',
      center: [1, 1, 1],
      dir: tilted(1),
      length: 30,
      ...STATS,
    }
    const circle: CircleFit = {
      kind: 'circle',
      center: [2, 2, 2],
      normal: tilted(1),
      radius: 6,
      ...STATS,
    }
    const l = orientFit(line, base, 'normal').fit
    const c = orientFit(circle, base, 'normal').fit
    if (l.kind !== 'line' || c.kind !== 'circle') throw new Error()
    expect(l.dir).toEqual([0, 0, 1])
    expect(l.center).toEqual([1, 1, 1])
    expect(c.normal).toEqual([0, 0, 1])
    expect(c.radius).toBe(6)
  })

  it('works against a reference that is not axis-aligned', () => {
    const ref: PlaneFit = {
      ...base,
      normal: [0.6, 0, 0.8],
      basisU: [0.8, 0, -0.6],
    }
    const { fit } = orientFit(top, ref, 'normal')
    if (fit.kind !== 'plane') throw new Error()
    expect(acuteAngle(fit.normal, ref.normal)).toBeCloseTo(0, 9)
    expect(len(sub(fit.center, top.center))).toBeLessThan(1e-12)
  })

  it('leaves points and spheres alone — they have no direction', () => {
    const sphere: FitData = {
      kind: 'sphere',
      center: [1, 2, 3],
      radius: 3,
      ...STATS,
    }
    expect(orientFit(sphere, base, 'normal').fit).toBe(sphere)
  })

  it('warns past the tolerance but still aligns', () => {
    const skewed: PlaneFit = {
      ...top,
      normal: tilted(ORIENT_TOLERANCE_DEG + 1),
    }
    const { fit, deviationDeg, warning } = orientFit(skewed, base, 'normal')
    if (fit.kind !== 'plane') throw new Error()
    expect(fit.normal).toEqual([0, 0, 1])
    expect(deviationDeg).toBeCloseTo(ORIENT_TOLERANCE_DEG + 1, 6)
    expect(warning).toMatch(/3\.00° off/)
    expect(
      orientFit({ ...top, normal: tilted(ORIENT_TOLERANCE_DEG - 0.01) }, base, 'normal').warning,
    ).toBeNull()
  })

  it('refuses the in-plane relation for a direction standing on the plane', () => {
    expect(() => orientFit({ ...bore, axis: [0, 0, 1] }, base, 'inPlane')).toThrow(OrientError)
  })

  it('names the relations from the element’s point of view', () => {
    expect(relationLabel('plane', 'normal')).toBe('Parallel to it')
    expect(relationLabel('plane', 'inPlane')).toBe('Perpendicular to it')
    expect(relationLabel('cylinder', 'normal')).toBe('Perpendicular to it')
    expect(relationLabel('cylinder', 'inPlane')).toBe('Parallel to it')
    expect(relationLabel('circle', 'normal')).toBe('Parallel to it')
  })
})

describe('an aligned element in the store', () => {
  const store = () => useStore.getState()
  const asOutput = (fit: FitData): FitOutput => ({
    ...fit,
    region: new Uint32Array([1, 2, 3]),
  })
  const elementById = (id: number) => store().elements.find((e) => e.id === id)!

  function fitted(fit: FitData, orientTo?: number): number {
    store().startDraft(fit.kind)
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(fit))
    if (orientTo !== undefined) store().setDraftOrientRef(orientTo)
    const id = store().commitDraft()
    if (id === null) throw new Error('not created')
    return id
  }

  beforeEach(() => {
    store().beginLoad('test.stl')
    store().finishLoad(0, 0, 100, [0, 0, 0])
  })

  it('commits the aligned geometry and keeps the measurement beside it', () => {
    const ref = fitted(base)
    const id = fitted(bore, ref)
    const el = elementById(id)
    expect(el.orient).toEqual({ ref, relation: 'normal' })
    expect(el.fit?.kind === 'cylinder' && el.fit.axis).toEqual([0, 0, 1])
    expect(el.measured).toEqual(bore)
  })

  it('ignores a reference that is not a plane', () => {
    const ref = fitted(base)
    const other = fitted(bore)
    store().startDraft('plane')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(top))
    store().setDraftOrientRef(other)
    expect(store().draft?.orient).toBeUndefined()
    store().setDraftOrientRef(ref)
    expect(store().draft?.orient?.ref).toBe(ref)
    store().setDraftOrientRef(null)
    expect(store().draft?.orient).toBeUndefined()
  })

  it('follows the reference plane when that is re-fitted', () => {
    const ref = fitted(base)
    const id = fitted(top, ref)
    // The base plane re-fits 1° over — the top face goes with it.
    store().resolveFit(ref, asOutput({ ...base, normal: tilted(1) }))
    const f = elementById(id).fit
    if (f?.kind !== 'plane') throw new Error()
    expect(acuteAngle(f.normal, tilted(1))).toBeCloseTo(0, 9)
    expect(elementById(id).measured).toEqual(top)
  })

  it('re-applies itself after the element’s own re-fit', () => {
    const ref = fitted(base)
    const id = fitted(bore, ref)
    store().resolveFit(id, asOutput({ ...bore, axis: tilted(0.8), radius: 4.01 }))
    const el = elementById(id)
    expect(el.fit?.kind === 'cylinder' && el.fit.axis).toEqual([0, 0, 1])
    expect(el.fit?.kind === 'cylinder' && el.fit.radius).toBe(4.01)
    expect(el.measured?.kind === 'cylinder' && el.measured.axis).toEqual(tilted(0.8))
  })

  it('re-opens on the measurement with the alignment still chosen', () => {
    const ref = fitted(base)
    const id = fitted(bore, ref)
    store().editElement(id)
    expect(store().draft?.fit).toEqual(bore)
    expect(store().draft?.orient).toEqual({ ref, relation: 'normal' })
    store().setDraftOrientRelation('inPlane')
    store().setDraftOrientRef(null)
    store().commitDraft()
    const el = elementById(id)
    expect(el.orient).toBeUndefined()
    expect(el.measured).toBeUndefined()
    expect(el.fit).toEqual(bore)
  })

  it('falls back to the measurement when the reference plane is deleted', () => {
    const ref = fitted(base)
    const id = fitted(bore, ref)
    store().removeElement(ref)
    const el = elementById(id)
    expect(el).toBeDefined()
    expect(el.orient).toBeUndefined()
    expect(el.fit).toEqual(bore)
  })

  it('closes no loops: a plane cannot be aligned to one aligned to it', () => {
    const a = fitted(base)
    const b = fitted(top, a)
    store().editElement(a)
    expect(blockedRefs(a, store().elements).has(b)).toBe(true)
    store().setDraftOrientRef(b)
    expect(store().draft?.orient).toBeUndefined()
    store().cancelDraft()
  })

  it('rides through a datum alignment as a whole', () => {
    const ref = fitted(base)
    const id = fitted(bore, ref)
    // Quarter turn about x: z becomes y.
    store().applyAlignment({
      r: new Float64Array([1, 0, 0, 0, 0, -1, 0, 1, 0]),
      t: new Float64Array([0, 0, 0]),
    })
    const el = elementById(id)
    const refFit = elementById(ref).fit
    if (el.fit?.kind !== 'cylinder' || refFit?.kind !== 'plane' || el.measured?.kind !== 'cylinder')
      throw new Error()
    expect(acuteAngle(el.fit.axis, refFit.normal)).toBeCloseTo(0, 9)
    expect(acuteAngle(el.measured.axis, refFit.normal)).toBeCloseTo(0.3, 6)
  })

  it('is reported in the summary with how far off the measurement was', () => {
    const ref = fitted(base)
    fitted(bore, ref)
    const text = buildSummary('t.stl', store().settings, store().elements, [])
    expect(text).toMatch(/aligned perpendicular to Plane 1, measured 0\.300° off/)
  })
})
