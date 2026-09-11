// SPDX-License-Identifier: AGPL-3.0-only
// Tolerances and limits in the store: named by their characteristic, kept
// with their limit and basic angle through an edit, and seated by viewport
// clicks without ever leaving their family.
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { evaluateDimensions } from '../src/core/dimensions'
import type { CylinderFit, PlaneFit, Vec3 } from '../src/core/types'

const store = () => useStore.getState()

const measured = { sigma: 0.002, usedPoints: 1000, regionSize: 1100, formError: 0.02 }

function planeFit(center: Vec3, normal: Vec3 = [0, 0, 1]): PlaneFit {
  const basisU: Vec3 = Math.abs(normal[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1]
  return { kind: 'plane', center, normal, basisU, basisV: [0, 1, 0], extentU: 10, extentV: 10, ...measured }
}

function cylinderFit(center: Vec3, axis: Vec3): CylinderFit {
  return { kind: 'cylinder', center, axis, radius: 5, length: 40, coverage: 360, ...measured }
}

/** A fitted element, the way the worker's result lands in the store. */
function fitted(fit: PlaneFit | CylinderFit): number {
  store().startDraft(fit.kind)
  store().resolveDraft({ ...fit, region: new Uint32Array(0) })
  const id = store().commitDraft()
  if (id === null) throw new Error(`${fit.kind} was not created`)
  return id
}

const dimension = (id: number) => store().dimensions.find((d) => d.id === id)!

beforeEach(() => {
  store().beginLoad('test.stl')
  store().finishLoad(0, 0, 100, [0, 0, 0])
})

describe('tolerances in the store', () => {
  it('names a tolerance by its characteristic and keeps its limit', () => {
    const base = fitted(planeFit([0, 0, 0]))
    const top = fitted(planeFit([0, 0, 20]))
    store().startDimension('form-flatness')
    store().setDimensionRef(0, base)
    store().setDimensionLimit({ kind: 'max', max: 0.05 })
    store().commitDimension()
    store().startDimension('form-flatness')
    store().setDimensionRef(0, top)
    store().commitDimension()
    store().startDimension('dist-plane-plane')
    store().setDimensionRef(0, top)
    store().setDimensionRef(1, base)
    store().commitDimension()
    expect(store().dimensions.map((d) => d.name)).toEqual(['Flatness 1', 'Flatness 2', 'Distance 1'])
    expect(store().dimensions[0].limit).toEqual({ kind: 'max', max: 0.05 })
    expect(store().dimensions[1].limit).toBeUndefined()
    const rows = evaluateDimensions(store().dimensions, store().elements)
    expect(rows[0].verdict?.pass).toBe(true)
    expect(rows[1].verdict).toBeUndefined()
  })

  it('re-opens with the limit and the basic angle, and writes them back changed', () => {
    const base = fitted(planeFit([0, 0, 0]))
    const face = fitted(planeFit([0, 0, 10], [Math.sin(0.5), 0, Math.cos(0.5)]))
    store().startDimension('orient-angularity')
    store().setDimensionRef(0, face)
    store().setDimensionRef(1, base)
    store().setDimensionBasic(30)
    store().setDimensionLimit({ kind: 'max', max: 0.1 })
    store().commitDimension()
    const id = store().dimensions[0].id
    expect(dimension(id)).toMatchObject({ name: 'Angularity 1', basic: 30, limit: { kind: 'max', max: 0.1 } })

    store().editDimension(id)
    expect(store().dimDraft).toMatchObject({ editId: id, basic: 30, limit: { kind: 'max', max: 0.1 } })
    store().setDimensionLimit(undefined)
    store().setDimensionBasic(45)
    store().commitDimension()
    expect(dimension(id).limit).toBeUndefined()
    expect(dimension(id).basic).toBe(45)
    expect(dimension(id).name).toBe('Angularity 1')
  })

  it('takes the next name of its new kind when the type changes under an edit', () => {
    const base = fitted(planeFit([0, 0, 0]))
    const top = fitted(planeFit([0, 0, 20]))
    store().startDimension('form-flatness')
    store().setDimensionRef(0, top)
    store().commitDimension()
    const id = store().dimensions[0].id
    store().editDimension(id)
    store().setDimensionType('orient-parallelism')
    store().setDimensionRef(0, top)
    store().setDimensionRef(1, base)
    store().commitDimension()
    expect(dimension(id).name).toBe('Parallelism 1')
    expect(dimension(id).type).toBe('orient-parallelism')
  })

  it('drops a limit when the type changes unit, and keeps it otherwise', () => {
    const a = fitted(cylinderFit([0, 0, 0], [0, 0, 1]))
    const b = fitted(cylinderFit([10, 0, 0], [0, 0, 1]))
    store().startDimension('dist-axis-axis')
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().setDimensionLimit({ kind: 'band', nominal: 10, plus: 0.1, minus: 0.1 })
    store().setDimensionType('angle-axis-axis')
    expect(store().dimDraft?.limit).toBeUndefined()
    // Same slots, so the references survive the switch.
    expect(store().dimDraft?.refs).toEqual([a, b])
    store().setDimensionLimit({ kind: 'band', nominal: 0, plus: 0.5, minus: 0.5 })
    store().setDimensionType('angle-axis-plane')
    expect(store().dimDraft?.limit).toEqual({ kind: 'band', nominal: 0, plus: 0.5, minus: 0.5 })
  })

  it('seats viewport clicks inside the family the draft is in', () => {
    const base = fitted(planeFit([0, 0, 0]))
    const top = fitted(planeFit([0, 0, 20]))
    const bore = fitted(cylinderFit([0, 0, 10], [0, 0, 1]))
    store().startDimension('form-flatness')
    store().selectDimensionElement(top)
    expect(store().dimDraft).toMatchObject({ type: 'form-flatness', refs: [top] })
    store().selectDimensionElement(base)
    expect(store().dimDraft).toMatchObject({ type: 'orient-parallelism', refs: [top, base] })
    // A third click replaces the datum, the feature stays.
    store().selectDimensionElement(bore)
    expect(store().dimDraft).toMatchObject({ type: 'orient-parallelism', refs: [top, bore] })
    // A click on a chosen element takes it out again.
    store().selectDimensionElement(top)
    expect(store().dimDraft).toMatchObject({ type: 'orient-parallelism', refs: [null, bore] })
    store().cancelDimension()

    store().startDimension('dist-point-point')
    store().selectDimensionElement(top)
    store().selectDimensionElement(base)
    expect(store().dimDraft).toMatchObject({ type: 'dist-plane-plane', refs: [top, base] })
  })

  it('shows and hides each family on its own', () => {
    const base = fitted(planeFit([0, 0, 0]))
    const top = fitted(planeFit([0, 0, 20]))
    store().startDimension('form-flatness')
    store().setDimensionRef(0, base)
    store().commitDimension()
    store().startDimension('dist-plane-plane')
    store().setDimensionRef(0, top)
    store().setDimensionRef(1, base)
    store().commitDimension()
    store().setAllDimensionsVisible(false, 'tolerance')
    expect(store().dimensions.map((d) => d.visible)).toEqual([false, true])
    store().setAllDimensionsVisible(false)
    expect(store().dimensions.map((d) => d.visible)).toEqual([false, false])
  })
})
