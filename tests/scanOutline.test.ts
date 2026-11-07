// SPDX-License-Identifier: AGPL-3.0-only
// An outline traced off a grid of hits and read as a sketch: a rounded
// rectangle as its four corners with their rounds, a slot as two lines and
// two arcs, a disc as one circle, a
// plate with a hole as two loops, the hole marked; and the open rims of a
// mesh walked round in order.
import { describe, expect, it } from 'vitest'
import { loopShape, maskLoops, type MaskGrid } from '../src/core/geometry/outline'
import { rimLoops } from '../src/core/geometry/openEdges'
import { weldTriangleSoup } from '../src/core/geometry/weld'
import { boxMesh } from './helpers'

/** Whether (x, y) lies inside the rectangle 2a × 2b about the origin with
 *  corners rounded to r. */
const inRounded = (x: number, y: number, a: number, b: number, r: number) => {
  const dx = Math.max(Math.abs(x) - (a - r), 0)
  const dy = Math.max(Math.abs(y) - (b - r), 0)
  return Math.abs(x) <= a && Math.abs(y) <= b && Math.hypot(dx, dy) <= r
}

/** A mask over the square ±half at `cell`, set where `inside` holds at the
 *  cell's centre. */
function maskOf(half: number, cell: number, inside: (x: number, y: number) => boolean): { mask: Uint8Array; g: MaskGrid } {
  const cols = Math.ceil((2 * half) / cell)
  const g: MaskGrid = { cols, rows: cols, cell, u0: -half, v0: -half }
  const mask = new Uint8Array(cols * cols)
  for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) mask[r * cols + c] = inside(-half + (c + 0.5) * cell, -half + (r + 0.5) * cell) ? 1 : 0
  return { mask, g }
}

describe('maskLoops and loopShape', () => {
  it('reads a rounded rectangle as four sharp corners, each with its round', () => {
    const { mask, g } = maskOf(30, 0.1, (x, y) => inRounded(x, y, 20, 10, 5))
    const loops = maskLoops(mask, g)
    expect(loops).toHaveLength(1)
    expect(loops[0].hole).toBe(false)
    expect(loops[0].area).toBeCloseTo(40 * 20 - (4 - Math.PI) * 25, -1)
    const shape = loopShape(loops[0].points, 0.2, g.cell)
    expect(shape.circle).toBeUndefined()
    expect(shape.points).toHaveLength(4)
    for (const p of shape.points) {
      expect(Math.abs(Math.abs(p[0]) - 20)).toBeLessThan(0.05)
      expect(Math.abs(Math.abs(p[1]) - 10)).toBeLessThan(0.05)
    }
    expect(shape.rounds).toHaveLength(4)
    for (const r of shape.rounds) {
      expect(r.radius).toBeCloseTo(5, 1)
      expect(Math.abs(Math.abs(r.center[0]) - 15)).toBeLessThan(0.1)
    }
    expect(shape.worst).toBeLessThan(0.2)
  })

  it('keeps sharp corners sharp, with no round', () => {
    const { mask, g } = maskOf(30, 0.1, (x, y) => Math.abs(x) <= 20 && Math.abs(y) <= 10 && !(x > 10 && y > 0 && y > 10 - (x - 10)))
    const shape = loopShape(maskLoops(mask, g)[0].points, 0.2, g.cell)
    expect(shape.rounds).toEqual([])
    // The rectangle with one corner cut off at 45°: five corners.
    expect(shape.points).toHaveLength(5)
  })

  it('reads a slot as two lines and two arcs, the arcs ending where they touch the lines', () => {
    const { mask, g } = maskOf(30, 0.1, (x, y) => inRounded(x, y, 20, 10, 10))
    const shape = loopShape(maskLoops(mask, g)[0].points, 0.2, g.cell)
    expect(shape.rounds).toEqual([])
    expect(shape.arcs.map((a) => Math.round(a.radius * 10) / 10)).toEqual([10, 10])
    expect(shape.points).toHaveLength(4)
    for (const p of shape.points) {
      expect(Math.abs(Math.abs(p[0]) - 10)).toBeLessThan(0.1)
      expect(Math.abs(Math.abs(p[1]) - 10)).toBeLessThan(0.05)
    }
  })

  it('says which way a slot’s half-round ends bulge: each arc’s mid-point out at the end', () => {
    // A slot standing alone, and the same slot as a hole in a plate: either
    // way round, each end's mid lies on the slot's axis at its far end,
    // never at the chord's other side, where its centre is.
    const alone = maskOf(30, 0.1, (x, y) => inRounded(x, y, 20, 6, 6))
    const plate = maskOf(30, 0.1, (x, y) => Math.abs(x) <= 28 && Math.abs(y) <= 12 && !inRounded(x, y, 20, 6, 6))
    for (const [{ mask, g }, k] of [[alone, 0], [plate, 1]] as const) {
      const loop = maskLoops(mask, g)[k]
      expect(loop.hole).toBe(k === 1)
      const shape = loopShape(loop.points, 0.2, g.cell)
      expect(shape.arcs).toHaveLength(2)
      for (const a of shape.arcs) {
        expect(Math.abs(a.center[0])).toBeCloseTo(14, 1)
        expect(Math.abs(a.mid[0])).toBeCloseTo(20, 1)
        expect(Math.sign(a.mid[0])).toBe(Math.sign(a.center[0]))
        expect(a.mid[1]).toBeCloseTo(0, 1)
        // On the arc's circle, halfway between its ends.
        const from = shape.points[a.from]
        const to = shape.points[(a.from + 1) % shape.points.length]
        expect(Math.hypot(a.mid[0] - from[0], a.mid[1] - from[1])).toBeCloseTo(Math.hypot(a.mid[0] - to[0], a.mid[1] - to[1]), 1)
      }
    }
  })

  it('reads a disc as one circle, and a hole in a plate as a loop of its own', () => {
    const disc = maskOf(10, 0.05, (x, y) => Math.hypot(x - 1, y) <= 6)
    const round = loopShape(maskLoops(disc.mask, disc.g)[0].points, 0.1, disc.g.cell)
    expect(round.circle!.radius).toBeCloseTo(6, 1)
    expect(round.circle!.center[0]).toBeCloseTo(1, 1)
    const plate = maskOf(30, 0.1, (x, y) => Math.abs(x) <= 20 && Math.abs(y) <= 10 && Math.hypot(x - 8, y) > 2.5)
    const loops = maskLoops(plate.mask, plate.g)
    expect(loops.map((l) => l.hole)).toEqual([false, true])
    const hole = loopShape(loops[1].points, 0.1, plate.g.cell)
    expect(hole.circle!.radius).toBeCloseTo(2.5, 1)
  })

  it('leaves specks under the least area out, and parts that touch at a corner apart', () => {
    const { mask, g } = maskOf(5, 1, (x, y) => (x < 0 && y < 0) || (x > 0 && y > 0))
    expect(maskLoops(mask, g)).toHaveLength(2)
    expect(maskLoops(mask, g, 100)).toHaveLength(0)
  })
})

describe('rimLoops', () => {
  it('walks the rim of a box without its top round in order, closed', () => {
    const welded = weldTriangleSoup(boxMesh(40, 4))
    const p = welded.positions
    const kept: number[] = []
    for (let t = 0; t + 2 < welded.indices.length; t += 3) {
      const c = [welded.indices[t], welded.indices[t + 1], welded.indices[t + 2]]
      if (c.every((v) => p[v * 3 + 2] > 19.9)) continue
      kept.push(...c)
    }
    const loops = rimLoops(Uint32Array.from(kept))
    expect(loops).toHaveLength(1)
    const [loop] = loops
    expect(loop.closed).toBe(true)
    expect(loop.triangles.length).toBe(loop.vertices.length)
    // One after another, each a step along the rim from the last.
    let length = 0
    for (let i = 0; i < loop.vertices.length; i++) {
      const a = loop.vertices[i] * 3
      const b = loop.vertices[(i + 1) % loop.vertices.length] * 3
      expect(p[a + 2]).toBeCloseTo(20, 5)
      length += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1])
    }
    expect(length).toBeCloseTo(160, 3)
    expect(rimLoops(welded.indices)).toEqual([])
    // Half the triangles wound the other way, as a scan's may be: the
    // same one rim, closed.
    const mixed = Uint32Array.from(kept)
    for (let t = 0; t + 2 < mixed.length; t += 6) [mixed[t + 1], mixed[t + 2]] = [mixed[t + 2], mixed[t + 1]]
    const again = rimLoops(mixed)
    expect(again).toHaveLength(1)
    expect(again[0].closed).toBe(true)
    expect(again[0].vertices.length).toBe(loop.vertices.length)
  })
})
