// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import type { Vec3 } from '../../../src/core/types'
import { buildAdjacency } from '../../../src/core/geometry/adjacency'
import { NominalSurface, emptyHit } from '../../../src/core/deviation/surface'
import { bridgeGap } from '../core/bridge'
import { adjustBridgePoints } from '../core/bridgePoints'
import { boundaryLoops } from '../core/boundary'
import { bridgeFixture } from './bridgeFixture'

function subject(g = bridgeFixture()) {
  const adjacency = buildAdjacency(g.indices, g.vertexCount)
  let surface: NominalSurface | undefined
  const surfaceOf = () => surface ??= new NominalSurface(g.positions, g.indices)
  return { mesh: { ...g, adjOffsets: adjacency.offsets, adjList: adjacency.list }, surfaceOf }
}

describe('adjusting bridge guide points', () => {
  for (const curvature of [0, 0.01]) {
    it(`moves guides on ${curvature ? 'curved' : 'flat'} scan surface and applies exactly the checked full-bend shape`, () => {
      const g = bridgeFixture(curvature)
      const { mesh, surfaceOf } = subject(g)
      const points: Vec3[] = g.points.map(([x, y, z], i) => [x, i === 1 || i === 4 ? -2 : y, z])
      const settings = { points, width: 1.5 }
      const before = JSON.stringify(settings)
      const oldPositions = g.positions.slice(), oldIndices = g.indices.slice()
      expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, settings)).toThrow('too much bending')
      const adjusted = adjustBridgePoints(mesh, settings, surfaceOf)
      expect(adjusted.moved).toContain(1)
      expect(adjusted.moved).toContain(4)
      expect(adjusted.moved).not.toContain(2)
      expect(adjusted.moved).not.toContain(3)
      expect(adjusted.points[2]).toEqual(points[2])
      expect(adjusted.points[3]).toEqual(points[3])
      const surface = surfaceOf()
      for (const i of adjusted.moved) {
        expect(surface.closest(...adjusted.points[i], emptyHit(), 1e-6)).toBe(true)
        const anchor = new Vector3(...points[i < 3 ? 2 : 3])
        const side = i < 3 ? points.slice(0, 3) : points.slice(3)
        const limit = Math.max(...side.map((p) => new Vector3(...p).distanceTo(anchor))) / 2
        expect(new Vector3(...points[i]).distanceTo(new Vector3(...adjusted.points[i]))).toBeLessThanOrEqual(limit)
      }
      const applied = bridgeGap(g.positions, g.indices, g.vertexCount, { ...settings, points: adjusted.points, bend: 1 })
      expect(applied.positions).toEqual(adjusted.result.positions)
      expect(applied.indices).toEqual(adjusted.result.indices)
      expect(applied.report.width).toBe(1.5)
      expect(applied.report.snap).toBeCloseTo(0, 6)
      expect(boundaryLoops(applied.indices, applied.positions.length / 3).loops).toHaveLength(2)
      expect(applied.positions.slice(0, g.positions.length)).toEqual(g.positions)
      expect(g.positions).toEqual(oldPositions)
      expect(g.indices).toEqual(oldIndices)
      expect(JSON.stringify(settings)).toBe(before)
    })
  }

  it('only adjusts the implicated side when the other side is already valid', () => {
    const g = bridgeFixture()
    const { mesh, surfaceOf } = subject(g)
    const points: Vec3[] = g.points.map(([x, y, z], i) => [x, i === 1 ? -2 : y, z])
    const adjusted = adjustBridgePoints(mesh, { points, width: 1.5 }, surfaceOf)
    expect(adjusted.moved).toEqual([1])
    expect(adjusted.points.slice(3)).toEqual(points.slice(3))
  })

  for (const [first, second] of [[3, 2], [4, 4], [5, 3], [3, 7]]) {
    it(`supports ${first}+${second} guides without moving the two inner points`, () => {
      const g = bridgeFixture()
      const { mesh, surfaceOf } = subject(g)
      const xs = [
        ...Array.from({ length: first }, (_, i) => -11 + 8 * i / (first - 1)),
        ...Array.from({ length: second }, (_, i) => 3 + 8 * i / (second - 1)),
      ]
      const points: Vec3[] = xs.map((x, i) => {
        const t = i / (first - 1)
        return [x, i < first ? 4 - 32 * t * (1 - t) : 4, 0]
      })
      expect(() => bridgeGap(g.positions, g.indices, g.vertexCount, { points, firstSideCount: first, width: 1.5 })).toThrow('too much bending')
      const adjusted = adjustBridgePoints(mesh, { points, firstSideCount: first, width: 1.5 }, surfaceOf)
      expect(adjusted.moved.length).toBeGreaterThan(0)
      expect(adjusted.points[first - 1]).toEqual(points[first - 1])
      expect(adjusted.points[first]).toEqual(points[first])
      expect(adjusted.moved.every((i) => i < first - 1)).toBe(true)
    })
  }

  it('keeps already-valid guides unchanged without preparing a surface', () => {
    const g = bridgeFixture(0.01)
    const { mesh } = subject(g)
    const surfaceOf = vi.fn(() => new NominalSurface(g.positions, g.indices))
    const adjusted = adjustBridgePoints(mesh, { points: g.points, width: 1.5 }, surfaceOf)
    expect(adjusted.moved).toEqual([])
    expect(adjusted.points).toEqual(g.points)
    expect(surfaceOf).not.toHaveBeenCalled()
  })

  it('does not attempt to correct ordering, missing picks or unsupported attachment errors', () => {
    const g = bridgeFixture()
    const { mesh } = subject(g)
    const surfaceOf = vi.fn(() => new NominalSurface(g.positions, g.indices))
    expect(() => adjustBridgePoints(mesh, { points: g.points.slice(0, 3), width: 1.5 }, surfaceOf)).toThrow('at least two')
    const points = g.points.map((p): Vec3 => [...p])
    points[0] = points[1]
    expect(() => adjustBridgePoints(mesh, { points, width: 1.5 }, surfaceOf)).toThrow('order')
    expect(() => adjustBridgePoints(mesh, { points: g.points, width: 0.001 }, surfaceOf)).toThrow()
    expect(surfaceOf).not.toHaveBeenCalled()
  })

  it('fails atomically when surface guides cannot clear an obstruction', () => {
    const g = bridgeFixture()
    const positions = Float32Array.from([...g.positions, 0, -30, -10, 0, 30, -10, 0, 0, 50])
    const indices = Uint32Array.from([...g.indices, g.vertexCount, g.vertexCount + 1, g.vertexCount + 2])
    const { mesh, surfaceOf } = subject({ ...g, positions, indices, vertexCount: g.vertexCount + 3 })
    const points: Vec3[] = g.points.map(([x, y, z], i) => [x, i === 1 || i === 4 ? -2 : y, z])
    const before = JSON.stringify(points)
    expect(() => adjustBridgePoints(mesh, { points, width: 1.5 }, surfaceOf)).toThrow('found no valid bridge')
    expect(JSON.stringify(points)).toBe(before)
    expect(mesh.positions).toEqual(positions)
    expect(mesh.indices).toEqual(indices)
  })

  it('rejects off-surface guide points rather than inventing scan coverage', () => {
    const g = bridgeFixture()
    const { mesh, surfaceOf } = subject(g)
    const points: Vec3[] = g.points.map(([x, y], i) => [x, i === 1 ? -2 : y, i === 1 ? 0.01 : 0])
    expect(() => adjustBridgePoints(mesh, { points, width: 1.5 }, surfaceOf)).toThrow('not on the current scan')
  })

  it('rejects projection onto a nearby disconnected sheet with the same facing', () => {
    const g = bridgeFixture(0.01)
    const positions = Float32Array.from([...g.positions, ...g.positions.map((value, i) => i % 3 === 2 ? value - 0.0001 : value)])
    const indices = Uint32Array.from([...g.indices, ...g.indices.map((v) => v + g.vertexCount)])
    const { mesh, surfaceOf } = subject({ ...g, positions, indices, vertexCount: g.vertexCount * 2 })
    const points: Vec3[] = g.points.map(([x, y, z], i) => [x, i === 1 ? -2 : y, z])
    const before = JSON.stringify(points)
    expect(() => adjustBridgePoints(mesh, { points, width: 1.5 }, surfaceOf)).toThrow('found no valid bridge')
    expect(JSON.stringify(points)).toBe(before)
  })

  it('does not silently hide a surface-query failure', () => {
    const g = bridgeFixture()
    const { mesh } = subject(g)
    const points: Vec3[] = g.points.map(([x, y, z], i) => [x, i === 1 ? -2 : y, z])
    expect(() => adjustBridgePoints(mesh, { points, width: 1.5 },
      () => { throw new Error('Surface unavailable') })).toThrow('Surface unavailable')
  })
})
