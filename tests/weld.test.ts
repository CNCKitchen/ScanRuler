// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { weldTriangleSoup } from '../src/core/geometry/weld'

describe('triangle soup welding', () => {
  it.each([0, 1, 2])('joins signed zero on coordinate %s without changing the input', (axis) => {
    const soup = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1)
    soup[9 + axis] = -0
    const { positions, indices } = weldTriangleSoup(soup)
    expect(positions.length / 3).toBe(4)
    expect(Array.from(indices)).toEqual([0, 1, 2, 0, 2, 3])
    expect(Object.is(soup[9 + axis], -0)).toBe(true)
  })

  it('joins a positive zero to a negative zero encountered first', () => {
    const soup = Float32Array.of(-0, -0, -0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1)
    const { positions, indices } = weldTriangleSoup(soup)
    expect(positions.length / 3).toBe(4)
    expect(Array.from(indices)).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('keeps distinct nonzero coordinates separate', () => {
    const soup = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1e-10, 0, 0, 0, 1, 0, 0, 0, 1)
    expect(weldTriangleSoup(soup).positions.length / 3).toBe(5)
  })
})
