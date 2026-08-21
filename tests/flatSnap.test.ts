// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { EdgeIndex } from '../src/core/flat/snap'

/** Three chains: a horizontal run, a vertical run far away, and a short one
 *  crossing a cell boundary. */
function chains() {
  const pts: number[] = []
  const offsets = [0]
  for (let i = 0; i < 100; i++) pts.push(10 + i, 50)
  offsets.push(pts.length / 2)
  for (let i = 0; i < 40; i++) pts.push(300, 100 + i)
  offsets.push(pts.length / 2)
  for (let i = 0; i < 5; i++) pts.push(30 + i, 200)
  offsets.push(pts.length / 2)
  return { points: new Float32Array(pts), offsets: new Uint32Array(offsets) }
}

describe('EdgeIndex', () => {
  const index = new EdgeIndex(chains())

  it('snaps to the nearest edge point within the radius, and to nothing beyond it', () => {
    expect(index.nearest(52.4, 53, 10)).toEqual([52, 50])
    expect(index.nearest(52.4, 80, 10)).toBeNull()
  })

  it('hands over the whole chain a click lands on', () => {
    const chain = index.chainNear(300.4, 120, 5)!
    expect(chain).toHaveLength(40)
    expect(chain[0]).toEqual([300, 100])
    expect(chain[39]).toEqual([300, 139])
    // The last chain, which has no chain after it.
    expect(index.chainNear(32, 201, 5)).toHaveLength(5)
    // The first, from its first point.
    expect(index.chainNear(10, 50, 1)).toHaveLength(100)
    expect(index.chainNear(150, 150, 5)).toBeNull()
  })

  it('gathers every point inside a box and nothing outside it', () => {
    const inBox = index.inBox(20, 40, 40, 60)
    expect(inBox).toHaveLength(21)
    expect(inBox.every(([x, y]) => x >= 20 && x <= 40 && y === 50)).toBe(true)
  })
})
