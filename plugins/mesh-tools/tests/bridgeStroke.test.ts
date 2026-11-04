// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { bridgeStrokePoints, type BridgeStrokeSample } from '../core/bridgeStroke'

const stroke = (): BridgeStrokeSample[] => Array.from({ length: 101 }, (_, i) => {
  const x = i - 50
  return { distance: i * 2, point: Math.abs(x) < 5 ? null : [x, 4, x * x * 0.01] }
})

describe('drawn bridge reference points', () => {
  for (let first = 2; first <= 8; first++) {
    for (let second = 2; first + second <= 10; second++) {
      it(`samples ${first}+${second} actual hits in crossing order`, () => {
        const samples = stroke()
        const points = bridgeStrokePoints(samples, first, second)
        expect(points).toHaveLength(first + second)
        expect(points[0]).toEqual([-50, 4, 25])
        expect(points[first - 1]).toEqual([-5, 4, 0.25])
        expect(points[first]).toEqual([5, 4, 0.25])
        expect(points[points.length - 1]).toEqual([50, 4, 25])
        points.forEach((point, i) => {
          expect(samples.some((sample) => sample.point?.every((v, j) => v === point[j]))).toBe(true)
          if (i) expect(point[0]).toBeGreaterThan(points[i - 1][0])
        })
      })
    }
  }
  it('handles a reversed crossing without changing its surface profile', () => {
    const samples = stroke().reverse().map((sample, i) => ({ ...sample, distance: i * 2 }))
    const points = bridgeStrokePoints(samples, 2, 3)
    expect(points.map((p) => p[0])).toEqual([50, 5, -5, -27, -50])
  })
  it('requires surface at both ends and exactly one visible gap', () => {
    expect(() => bridgeStrokePoints([], 3, 3)).toThrow('Start and finish')
    expect(() => bridgeStrokePoints(stroke().slice(50), 3, 3)).toThrow('Start and finish')
    expect(() => bridgeStrokePoints(stroke().slice(0, 51), 3, 3)).toThrow('Start and finish')
    expect(() => bridgeStrokePoints(stroke().filter((s) => s.point), 3, 3)).toThrow('visible gap')
    const multiple = stroke()
    multiple[80].point = null
    expect(() => bridgeStrokePoints(multiple, 3, 3)).toThrow('more than one')
  })
  it('rejects short surface traces rather than making up extra points', () => {
    expect(() => bridgeStrokePoints(stroke().slice(44), 3, 3)).toThrow('Extend the line')
    const compressed = stroke().map((sample) => ({ ...sample, distance: sample.distance / 10 }))
    expect(() => bridgeStrokePoints(compressed, 2, 2)).toThrow('Extend the line')
    expect(() => bridgeStrokePoints(stroke(), 1, 3)).toThrow('two points')
    expect(() => bridgeStrokePoints(stroke(), 3, 8)).toThrow('ten total')
    expect(() => bridgeStrokePoints(Array.from({ length: 4096 }, () => stroke()[0]), 3, 3)).toThrow('too long')
  })
  it('accepts the exact coverage thresholds and rejects traces just below them', () => {
    expect(bridgeStrokePoints(stroke().slice(39, 62), 3, 3)).toHaveLength(6)
    expect(() => bridgeStrokePoints(stroke().slice(40, 62), 3, 3)).toThrow('Extend the line')
    expect(bridgeStrokePoints(stroke().slice(31, 70), 8, 2)).toHaveLength(10)
    expect(() => bridgeStrokePoints(stroke().slice(32, 70), 8, 2)).toThrow('Extend the line')
  })
})
