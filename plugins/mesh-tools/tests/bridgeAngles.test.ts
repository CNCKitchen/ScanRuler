// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { Triangle, Vector3 } from 'three'
import { bridgeGap } from '../core/bridge'
import { boundaryLoops } from '../core/boundary'
import { closedness } from '../core/boolean'
import { fillHoles, surveyHoles } from '../core/fillHoles'
import { angledBridgeFixture } from './bridgeFixture'

describe('bridging oblique uneven rims', () => {
  for (const curvature of [0, 0.005]) for (const [first, second] of [[3, 3], [2, 4], [4, 3], [3, 7]]) for (const reversed of [false, true]) {
    it(`stitches ${first}+${second} ${curvature ? 'curved' : 'flat'} guides ${reversed ? 'in reverse' : 'forward'} without flattening the bow`, () => {
      const g = angledBridgeFixture(curvature, first, second, reversed)
      const settings = { points: g.points, firstSideCount: g.firstSideCount, width: 3, bend: 1 }
      const before = JSON.stringify(settings)
      const positions = g.positions.slice(), indices = g.indices.slice()
      const result = bridgeGap(g.positions, g.indices, g.vertexCount, settings)
      expect(JSON.stringify(settings)).toBe(before)
      expect(g.positions).toEqual(positions)
      expect(g.indices).toEqual(indices)
      expect(result.positions.slice(0, g.positions.length)).toEqual(g.positions)
      expect(result.indices.slice(0, g.indices.length)).toEqual(g.indices)
      const count = result.positions.length / 3
      expect(boundaryLoops(result.indices, count)).toMatchObject({ stray: 0 })
      expect(boundaryLoops(result.indices, count).loops).toHaveLength(2)
      expect(closedness(result.indices, count).bad).toBe(0)
      expect(result.report.width).toBe(3)
      const tri = new Triangle()
      for (let i = g.indices.length; i < result.indices.length; i += 3) {
        tri.a.fromArray(result.positions, result.indices[i] * 3)
        tri.b.fromArray(result.positions, result.indices[i + 1] * 3)
        tri.c.fromArray(result.positions, result.indices[i + 2] * 3)
        expect(tri.getArea()).toBeGreaterThan(1e-8)
        expect(tri.getNormal(new Vector3()).z).toBeGreaterThan(0.8)
      }
      const a = g.points[g.firstSideCount - 1], b = g.points[g.firstSideCount]
      const low = Math.min(a[0], b[0]), high = Math.max(a[0], b[0])
      const middle: Vector3[] = []
      for (let i = g.vertexCount; i < count; i++) {
        const p = new Vector3().fromArray(result.positions, i * 3)
        if (p.x > low + (high - low) * 0.35 && p.x < low + (high - low) * 0.65) middle.push(p)
      }
      expect(middle.length).toBeGreaterThan(0)
      // The picked slopes create a deliberate upward arch, not a straight strip.
      expect(Math.max(...middle.map((p) => p.y))).toBeGreaterThan(4.5)
      const holes = surveyHoles(result.positions, result.indices, count, 15)
      expect(holes.survey.holes).toBe(1)
      const filled = fillHoles(result.positions, result.indices, count, 15, 'curved', undefined, [0, 1, 0])
      expect(filled.report.filled).toBe(1)
      expect(closedness(filled.indices, filled.positions.length / 3).bad).toBe(0)
    })
  }

  it('covers guides more than 45 degrees away from perpendicular at both rims', () => {
    const g = angledBridgeFixture()
    const angle = (outer: number, inner: number) => {
      const guide = new Vector3(...g.points[inner]).sub(new Vector3(...g.points[outer])).normalize()
      const rim = new Vector3(
        (inner === 2 ? -1 : 1) * 0.5 * (Math.sin(10) - Math.sin(6)), 2, 0,
      ).normalize()
      return Math.asin(Math.abs(guide.dot(rim))) * 180 / Math.PI
    }
    expect(angle(1, 2)).toBeGreaterThan(45)
    expect(angle(4, 3)).toBeGreaterThan(45)
    expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { points: g.points, width: 3 })).not.toThrow()
  })

  it('still rejects actual surface intersections after repairing inverted diagonals', () => {
    const g = angledBridgeFixture()
    const positions = Float32Array.from([...g.positions, 0, -30, -10, 0, 30, -10, 0, 0, 50])
    const indices = Uint32Array.from([...g.indices, g.vertexCount, g.vertexCount + 1, g.vertexCount + 2])
    expect(() => bridgeGap(positions, indices, g.vertexCount + 3, { points: g.points, width: 3 })).toThrow('intersects existing')
    expect(g.positions.length).toBe(positions.length - 9)
  })
})
