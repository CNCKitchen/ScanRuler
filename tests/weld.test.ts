// SPDX-License-Identifier: AGPL-3.0-only
// Welding an STL's triangle soup: −0.0 and 0.0 are one coordinate, though
// their bits differ (issue 34).
import { describe, expect, it } from 'vitest'
import { weldTriangleSoup } from '../src/core/geometry/weld'

describe('weldTriangleSoup', () => {
  it('welds a corner written once as 0.0 and once as −0.0', () => {
    // Two triangles sharing the edge from (0,0,0) to (1,0,0); the second
    // writes its zeros negative, as some exporters do.
    const soup = Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      -0, -0, -0, 0, -1, 0, 1, -0, 0,
    ])
    const { positions, indices } = weldTriangleSoup(soup)
    expect(positions.length / 3).toBe(4)
    expect(indices[0]).toBe(indices[3])
    expect(indices[1]).toBe(indices[5])
    // The kept zeros are positive.
    expect(Object.is(positions[0], 0)).toBe(true)
  })

  it('still keeps apart points that differ', () => {
    const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1e-6, 1, 0, 0, 0, 1, 0])
    expect(weldTriangleSoup(soup).positions.length / 3).toBe(4)
  })
})
