// SPDX-License-Identifier: AGPL-3.0-only
// A closed network with a T-junction in it closes: counted by side, its
// T-side (one side, two curves) made the count come out short, and it was
// sewn as a sheet with no volume (issue 34).
import { describe, expect, it } from 'vitest'
import { networkCloses } from '../core/networkBody'
import type { NetworkFitResult } from '../core/networkFit'

type Fit = Pick<NetworkFitResult, 'patches' | 'shared'>
const side = (...curves: number[]) => ({ edges: curves.map((curve) => ({ curve, forward: true })), poles: new Float64Array(0), single: curves.length === 1 })
const patch = (...sides: ReturnType<typeof side>[]) => ({ sides }) as unknown as Fit['patches'][number]
const shared = (curve: number, a: number, b: number) => ({ curve, patches: [a, b] as [number, number], gap: 0, angle: 0, crease: false })

describe('networkCloses', () => {
  it('counts a T-junction side by its curves', () => {
    // Patch 0's side is curves 1 and 2; patches 1 and 2 each have one of
    // them as a whole side. Every curve used twice: closed.
    const fit: Fit = {
      patches: [patch(side(1, 2), side(3)), patch(side(1), side(4)), patch(side(2), side(3, 4))],
      shared: [shared(1, 0, 1), shared(2, 0, 2), shared(3, 0, 2), shared(4, 1, 2)],
    }
    expect(networkCloses(fit)).toBe(true)
  })

  it('stays open with a curve that only one patch has', () => {
    const fit: Fit = { patches: [patch(side(1), side(2)), patch(side(1), side(3))], shared: [shared(1, 0, 1)] }
    expect(networkCloses(fit)).toBe(false)
  })
})
