// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { bridgeGap, BridgeGuidanceError, reduceBridgeBend } from '../core/bridge'
import { boundaryLoops } from '../core/boundary'
import { closedness } from '../core/boolean'
import { fillHoles, surveyHoles } from '../core/fillHoles'
import { bridgeFixture } from './bridgeFixture'
import type { Vec3 } from '../../../src/core/types'

describe('bridging an open bay', () => {
  it('reduces excessive bow to a fully validated bridge, preserving guides, width and attachments', () => {
    const g = bridgeFixture()
    const points: Vec3[] = [-11, -7, -3, 3, 7, 11].map((x, i) => [x, i === 1 || i === 4 ? -2 : 4, 0])
    const settings = { points, width: 1.5 }
    const before = JSON.stringify(settings)
    expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, settings)).toThrow('too much bending')
    const corrected = reduceBridgeBend(g.positions, g.indices, g.vertexCount, settings)
    expect(corrected.bend).toBeGreaterThan(0)
    expect(corrected.bend).toBeLessThan(1)
    const applied = bridgeGap(g.positions, g.indices, g.vertexCount, { ...settings, bend: corrected.bend })
    expect(applied.positions).toEqual(corrected.result.positions)
    expect(applied.indices).toEqual(corrected.result.indices)
    expect(applied.positions.slice(0, g.positions.length)).toEqual(g.positions)
    expect(applied.report.width).toBe(1.5)
    expect(applied.report.snap).toBe(0)
    expect(boundaryLoops(applied.indices, applied.positions.length / 3).loops).toHaveLength(2)
    expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { ...settings, bend: corrected.bend + 1 / 512 })).toThrow()
    expect(JSON.stringify(settings)).toBe(before)
  })

  it('does not alter valid bow or attempt to repair ordering by reducing bend', () => {
    const g = bridgeFixture(0.01)
    const settings = { points: g.points, width: 1.5 }
    expect(reduceBridgeBend(g.positions, g.indices, g.vertexCount, settings).bend).toBe(1)
    for (const bend of [-1, 1.1, NaN, Infinity]) expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { ...settings, bend })).toThrow('bend')
    const points = g.points.map((p) => [...p] as Vec3)
    points[0] = points[1]
    expect(() => reduceBridgeBend(g.positions, g.indices, g.vertexCount, { ...settings, points })).toThrow('order')
  })

  it('reports when no reduced-bend candidate clears an obstruction and leaves inputs untouched', () => {
    const g = bridgeFixture()
    const positions = Float32Array.from([...g.positions, 0, -30, -10, 0, 30, -10, 0, 0, 50])
    const indices = Uint32Array.from([...g.indices, g.vertexCount, g.vertexCount + 1, g.vertexCount + 2])
    const points: Vec3[] = [-11, -7, -3, 3, 7, 11].map((x, i) => [x, i === 1 || i === 4 ? -2 : 4, 0])
    const old = positions.slice()
    expect(() => reduceBridgeBend(positions, indices, g.vertexCount + 3, { points, width: 1.5 })).toThrow('found no valid bridge')
    expect(positions).toEqual(old)
  })
  it('identifies out-of-order guides without guessing an automatic movement', () => {
    const g = bridgeFixture()
    const points = g.points.map((p) => [...p] as Vec3)
    points[0] = [-6, 4, 0]
    try {
      bridgeGap(g.positions, g.indices, g.vertexCount, { points, width: 1.5 })
      expect.fail('Expected ordering guidance')
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeGuidanceError)
      if (!(error instanceof BridgeGuidanceError)) throw error
      expect(error.guidance.points).toEqual([0, 1])
      expect(error.guidance.message).toContain('points 1 and 2')
      expect(error.guidance.targets).toBeUndefined()
    }
  })

  it('targets only the inner point that exceeds the rim snap limit', () => {
    const g = bridgeFixture()
    const points = g.points.map((p) => [...p] as Vec3)
    points[2] = [-5, 4, 0]
    try {
      bridgeGap(g.positions, g.indices, g.vertexCount, { points, width: 0.5 })
      expect.fail('Expected attachment guidance')
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeGuidanceError)
      if (!(error instanceof BridgeGuidanceError)) throw error
      expect(error.guidance.points).toEqual([2])
      expect(error.guidance.targets).toEqual([{ index: 2, point: [-3, 4, 0] }])
    }
  })
  for (const curvature of [0, 0.01]) {
    it(`stitches a ${curvature ? 'curved' : 'flat'} bridge, preserves the scan, and leaves a fillable hole`, () => {
      const g = bridgeFixture(curvature)
      const oldPositions = g.positions.slice(), oldIndices = g.indices.slice()
      const result = bridgeGap(g.positions, g.indices, g.vertexCount, { points: g.points, width: 1.5 })
      expect(result.positions.slice(0, g.positions.length)).toEqual(g.positions)
      expect(result.indices.slice(0, g.indices.length)).toEqual(g.indices)
      expect(g.positions).toEqual(oldPositions)
      expect(g.indices).toEqual(oldIndices)
      expect(Array.from(result.vertexMap)).toEqual(Array.from({ length: g.vertexCount }, (_, i) => i))
      const count = result.positions.length / 3
      expect(boundaryLoops(g.indices, g.vertexCount).loops).toHaveLength(1)
      expect(boundaryLoops(result.indices, count)).toMatchObject({ stray: 0, loops: expect.any(Array) })
      expect(boundaryLoops(result.indices, count).loops).toHaveLength(2)
      expect(closedness(result.indices, count).bad).toBe(0)
      expect(result.report.width).toBe(1.5)
      expect(result.report.snap).toBeLessThan(1e-6)
      expect(result.report.triangles).toBeGreaterThan(0)
      for (let i = g.vertexCount; i < count; i++) {
        const x = result.positions[i * 3], z = result.positions[i * 3 + 2]
        expect(z).toBeCloseTo(curvature * x * x, 5)
      }
      const holes = surveyHoles(result.positions, result.indices, count, 10)
      expect(holes.survey.holes).toBe(1)
      const filled = fillHoles(result.positions, result.indices, count, 10, 'curved', undefined, [0, 1, 0])
      expect(filled.report.filled).toBe(1)
      expect(boundaryLoops(filled.indices, filled.positions.length / 3).loops).toHaveLength(1)
      expect(closedness(filled.indices, filled.positions.length / 3).bad).toBe(0)
    })
  }

  it('stitches differing boundary edge counts without T-junctions', () => {
    const g = bridgeFixture(0, 2)
    const result = bridgeGap(g.positions, g.indices, g.vertexCount, { points: g.points, width: 3 })
    const count = result.positions.length / 3
    expect(boundaryLoops(result.indices, count).loops).toHaveLength(2)
    expect(boundaryLoops(result.indices, count).stray).toBe(0)
    expect(closedness(result.indices, count).bad).toBe(0)
    expect(surveyHoles(result.positions, result.indices, count, 10).survey.holes).toBe(1)
  })

  it('rejects invalid width, points, ordering and overlapping attachments without changing anything', () => {
    const g = bridgeFixture()
    const run = (points = g.points, width = 1.5) => bridgeGap(g.positions, g.indices, g.vertexCount, { points, width })
    for (const width of [0, -1, Infinity, NaN]) expect(() => run(g.points, width)).toThrow(/width/)
    expect(() => run(g.points.slice(0, 3))).toThrow(/at least two/)
    expect(() => run(g.points.map((p, i) => i === 0 ? [NaN, 0, 0] : p))).toThrow(/finite/)
    expect(() => run([...g.points].reverse().map((p, i, a) => i === 1 ? a[0] : p))).toThrow(/order/)
    expect(() => run(g.points, 15)).toThrow(/overlap|wide|width/)
    expect(boundaryLoops(g.indices, g.vertexCount).loops).toHaveLength(1)
  })

  for (let firstSideCount = 2; firstSideCount <= 8; firstSideCount++) {
    for (let secondSideCount = 2; firstSideCount + secondSideCount <= 10; secondSideCount++) {
      for (const curvature of [0, 0.01]) {
        it(`supports ${firstSideCount}+${secondSideCount} ${curvature ? 'curved' : 'flat'} samples and keeps a fillable hole`, () => {
          const g = bridgeFixture(curvature)
          const xs = [
            ...Array.from({ length: firstSideCount }, (_, i) => -11 + 8 * i / (firstSideCount - 1)),
            ...Array.from({ length: secondSideCount }, (_, i) => 3 + 8 * i / (secondSideCount - 1)),
          ]
          const points: Vec3[] = xs.map((x) => [x, 4, curvature * x * x])
          const result = bridgeGap(g.positions, g.indices, g.vertexCount, { points, firstSideCount, width: 1.5 })
          const count = result.positions.length / 3
          expect(result.positions.slice(0, g.positions.length)).toEqual(g.positions)
          expect(result.indices.slice(0, g.indices.length)).toEqual(g.indices)
          expect(boundaryLoops(result.indices, count).loops).toHaveLength(2)
          expect(closedness(result.indices, count).bad).toBe(0)
          expect(surveyHoles(result.positions, result.indices, count, 10).survey.holes).toBe(1)
          if (firstSideCount >= 3 && secondSideCount >= 3) {
            for (let i = g.vertexCount; i < count; i++) {
              const x = result.positions[i * 3]
              expect(result.positions[i * 3 + 2]).toBeCloseTo(curvature * x * x, 5)
            }
          }
        })
      }
    }
  }

  it('rejects invalid side counts and totals', () => {
    const g = bridgeFixture()
    for (const firstSideCount of [0, 1, 2.5, 5, 6, NaN, Infinity]) {
      expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { points: g.points, firstSideCount, width: 1.5 })).toThrow(/at least two/)
    }
    expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, {
      points: [...g.points, ...g.points], firstSideCount: 6, width: 1.5,
    })).toThrow(/ten total/)
  })

  it('uses the additional samples rather than ignoring them', () => {
    const g = bridgeFixture(0.01)
    const points: Vec3[] = [-11, -9, -7, -5, -3, 3, 5, 7, 9, 11].map((x) => [x, 4, 0.01 * x * x])
    const before = bridgeGap(g.positions, g.indices, g.vertexCount, { points, firstSideCount: 5, width: 1.5 })
    const changed: Vec3[] = points.map((p, i) => i === 0 ? [p[0], p[1], p[2] + 0.05] : [...p])
    const after = bridgeGap(g.positions, g.indices, g.vertexCount, { points: changed, firstSideCount: 5, width: 1.5 })
    expect(after.positions).not.toEqual(before.positions)
  })

  it('rejects picks too far from the rim and attachments on separate pieces', () => {
    const g = bridgeFixture()
    const away = g.points.map(([x, y, z]) => [x, y, z + 100] as [number, number, number])
    expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { points: away, width: 1 })).toThrow(/far/)
    const indices = Uint32Array.from(Array.from(g.indices).filter((_, i) => {
      const start = i - i % 3
      return ![0, 1, 2].some((j) => g.positions[g.indices[start + j] * 3 + 1] < 0)
    }))
    expect(() => bridgeGap(g.positions, indices, g.vertexCount, { points: g.points, width: 1.5 })).toThrow(/same open rim/)
  })

  it('rejects a bridge that crosses another scanned surface', () => {
    const g = bridgeFixture()
    const positions = new Float32Array(g.positions.length + 9)
    positions.set(g.positions)
    positions.set([0, 2, -1, 0, 6, -1, 0, 4, 1], g.positions.length)
    const indices = Uint32Array.from([...g.indices, g.vertexCount, g.vertexCount + 1, g.vertexCount + 2])
    expect(() => bridgeGap(positions, indices, g.vertexCount + 3, { points: g.points, width: 1.5 })).toThrow(/intersects existing/)
  })
})
