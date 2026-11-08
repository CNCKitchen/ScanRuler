// SPDX-License-Identifier: AGPL-3.0-only
// A measured cone as a trim tool reaches along its axis past the trim's box,
// but no further than its apex. The end toward the apex was cut off where
// the radius reaches nothing by dividing by the slope of the wrong sign, so
// it ran out to the reach with a radius past zero: the wrong cone, apex on
// either end (issue 34).

import { describe, expect, it, vi } from 'vitest'
import { Builder } from '../core/build'
import type { TrimPrimitive } from '../core/features'
import { ReKernel, type Shape } from '../core/kernel'

vi.setConfig({ testTimeout: 120_000 })

const kernelPromise = ReKernel.load()

describe('a cone as a trim tool', () => {
  it('stops a hair short of its apex, whichever end the apex is at', async () => {
    const k = await kernelPromise
    const builder = new Builder(k)
    const tool = (p: TrimPrimitive, diagonal: number) => (builder as unknown as { trimPrimitive(p: TrimPrimitive, d: number): Shape }).trimPrimitive(p, diagonal)
    // R5 at z −5 to R10 at z 5: the apex at z −15. Turned round, at z 15.
    for (const [r1, r2, apex] of [[5, 10, -15], [10, 5, 15]]) {
      const shape = tool({ kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1], radius1: r1, radius2: r2, length: 10 }, 100)
      const b = k.bounds(shape)
      const tip = apex < 0 ? b.min[2] : b.max[2]
      const far = apex < 0 ? b.max[2] : b.min[2]
      expect(Math.abs(tip - apex), `apex at ${apex}`).toBeLessThan(0.01)
      // The wide end out at the reach, 1.5 diagonals.
      expect(Math.abs(far), `apex at ${apex}`).toBeCloseTo(150, 6)
      // As wide there as the cone is: 0.5 mm a mm from the apex.
      expect(b.max[0], `apex at ${apex}`).toBeCloseTo(0.5 * (150 + 15), 3)
      k.release(shape)
    }
    builder.dispose()
  })
})
