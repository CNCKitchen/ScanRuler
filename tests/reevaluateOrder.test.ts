// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { evaluateConstruction } from '../src/core/elements/construct'
import type { PlaneFit, Vec3 } from '../src/core/types'
import { reevaluateConstructions, type Element } from '../src/state/elementModel'

const top: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 5],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 10,
  extentV: 10,
  sigma: 0.01,
  usedPoints: 100,
  regionSize: 100,
}

const tilt = (deg: number): Vec3 => [0, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)]

describe('re-evaluating the elements', () => {
  it('aligns an element to a newer constructed plane as it is now, not as it was', () => {
    const datum = (n: Vec3): Element['source'] => ({ type: 'constructed', method: 'plane-coords', refs: [], params: [...n, 0, 0, 0] })
    const stale = evaluateConstruction('plane-coords', [], [0, 0, 1, 0, 0, 0], 50)
    // The measured face (id 1) takes its direction from a datum plane typed
    // in after it (id 2), whose normal has since been turned by a degree.
    const elements: Element[] = [
      {
        id: 1, kind: 'plane', name: 'Plane 1', color: '#fff', status: 'done', visible: true,
        source: { type: 'fitted', seeds: [0], settings: { method: 'gaussian', sigma: 0 } },
        orient: { ref: 2, relation: 'normal' },
        measured: top,
        fit: top,
      },
      { id: 2, kind: 'plane', name: 'Plane 2', color: '#fff', status: 'done', visible: true, source: datum(tilt(1)), fit: stale },
    ]
    const [face, plane] = reevaluateConstructions(elements, 50)
    expect(plane.fit?.kind).toBe('plane')
    expect(face.fit?.kind).toBe('plane')
    if (face.fit?.kind !== 'plane' || plane.fit?.kind !== 'plane') return
    for (const k of [0, 1, 2]) expect(plane.fit.normal[k]).toBeCloseTo(tilt(1)[k], 9)
    for (const k of [0, 1, 2]) expect(face.fit.normal[k]).toBeCloseTo(tilt(1)[k], 9)
    // The order of the list is kept.
    expect([face.id, plane.id]).toEqual([1, 2])
  })
})
