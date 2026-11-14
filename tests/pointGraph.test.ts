// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedMesh } from '../src/core/types'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { buildPointGraph, cloudSpacing, spacingCell } from '../src/core/geometry/buildPointGraph'
import { isCloud } from '../src/core/geometry/cloud'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { planeCloud, writePlyCloud, type Cloud } from './cloudFixtures'

const asParsed = (c: Cloud): ParsedMesh => ({ kind: 'cloud', positions: c.positions, normals: c.normals })
const neighbours = (g: { adjOffsets: Uint32Array; adjList: Uint32Array }, i: number): number[] =>
  Array.from(g.adjList.subarray(g.adjOffsets[i], g.adjOffsets[i + 1]))

describe('buildPointGraph', () => {
  it('adjacency is symmetric', () => {
    const g = buildPointGraph(asParsed(planeCloud({ size: 10, step: 1, noise: 0.1, seed: 3, denseHalf: true })))
    for (let i = 0; i < g.vertexCount; i++) {
      for (const j of neighbours(g, i)) expect(neighbours(g, j)).toContain(i)
    }
  })

  it('k is capped at 12', () => {
    // A uniform grid at spacing 0.1: the 2.5-spacing radius holds 20 other
    // points about an inner point, more than the 12 each asks for.
    const g = buildPointGraph(asParsed(planeCloud({ size: 6, step: 0.1 })))
    const p = g.positions
    const radius = 2.5 * g.spacing
    let capped = 0
    for (let i = 0; i < g.vertexCount; i++) {
      const row = neighbours(g, i)
      // Each point asks for at most 12; symmetrising adds only the ones that
      // asked for it, never an unbounded number on a uniform grid.
      expect(row.length).toBeLessThanOrEqual(24)
      let within = 0
      for (let j = 0; j < g.vertexCount; j++) {
        if (j !== i && Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]) <= radius) within++
      }
      if (within > 12 && row.length < within) capped++
    }
    // The cap bit: inner points are linked to fewer than all in their radius.
    expect(capped).toBeGreaterThan(g.vertexCount / 2)
  })

  it('no row holds its own point or the same neighbour twice', () => {
    for (const c of [planeCloud({ size: 6, step: 0.1 }), planeCloud({ size: 10, step: 1, noise: 0.3, seed: 5, denseHalf: true })]) {
      const g = buildPointGraph(asParsed(c))
      for (let i = 0; i < g.vertexCount; i++) {
        const row = neighbours(g, i)
        expect(row).not.toContain(i)
        expect(new Set(row).size).toBe(row.length)
      }
    }
  })

  it('measures the spacing of a near-1D cloud on a grid fine enough for it', () => {
    // 200 000 points along a line, 0.01 apart, a hair off it: on a grid of
    // bboxDiag / cbrt(n) cells each cell held about 3 400 of them.
    const n = 200_000
    const positions = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
      positions[3 * i] = i * 0.01
      positions[3 * i + 1] = (i % 7) * 1e-4
    }
    expect(cloudSpacing(positions)).toBeCloseTo(0.01, 4)
    const cell = spacingCell(n * 0.01, 6e-4, 0, n)
    expect(cell).toBeLessThan(0.03) // a few points a cell
    // A cloud filling its box still gets no more cells than points.
    const box = spacingCell(10, 10, 10, 1000)
    expect((Math.floor(10 / box) + 1) ** 3).toBeLessThanOrEqual(1000)
    expect(box).toBeLessThan((1.5 * 10) / 9) // within a coarsening step of the finest that fits
  })

  it('spacing of a 1 mm grid is 1 ± 0.01', () => {
    const g = buildPointGraph(asParsed(planeCloud({ size: 20, step: 1 })))
    expect(g.spacing).toBeGreaterThan(0.99)
    expect(g.spacing).toBeLessThan(1.01)
    expect(g.triangleCount).toBe(0)
    expect(g.indices.length).toBe(0)
  })

  it('exact duplicates collapse and spacing stays > 0', () => {
    const c = planeCloud({ size: 4, step: 1 })
    const n = c.positions.length / 3
    const positions = new Float32Array(c.positions.length + 6)
    const normals = new Float32Array(c.normals.length + 6)
    positions.set(c.positions)
    normals.set(c.normals)
    positions.set(c.positions.subarray(0, 3), c.positions.length)
    normals.set(c.normals.subarray(0, 3), c.normals.length)
    positions.set(c.positions.subarray(3, 6), c.positions.length + 3)
    normals.set(c.normals.subarray(3, 6), c.normals.length + 3)
    const g = buildPointGraph({ kind: 'cloud', positions, normals })
    expect(g.vertexCount).toBe(n)
    expect(g.vertexMap.length).toBe(n + 2)
    expect(g.vertexMap[n]).toBe(g.vertexMap[0])
    expect(g.vertexMap[n + 1]).toBe(g.vertexMap[1])
    expect(g.spacing).toBeGreaterThan(0)
    expect(Math.abs(g.spacing - 1)).toBeLessThan(0.01)
  })

  it('a cloud of only one repeated point builds with a positive spacing', () => {
    const g = buildPointGraph({
      kind: 'cloud',
      positions: Float32Array.from([1, 2, 3, 1, 2, 3]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1]),
    })
    expect(g.vertexCount).toBe(1)
    expect(g.spacing).toBeGreaterThan(0)
  })

  it('NaN points dropped', () => {
    const c = planeCloud({ size: 3, step: 1 })
    c.positions[3] = NaN
    const n = c.positions.length / 3
    const g = buildPointGraph(asParsed(c))
    expect(g.vertexCount).toBe(n - 1)
    expect(g.vertexMap[1]).toBe(-1)
    expect(g.vertexMap[0]).toBe(0)
    expect(g.vertexMap[2]).toBe(1)
  })

  it('zero-length normals dropped like NaN points', () => {
    const c = planeCloud({ size: 3, step: 1 })
    c.normals.fill(0, 6, 9)
    const n = c.positions.length / 3
    const g = buildPointGraph(asParsed(c))
    expect(g.vertexCount).toBe(n - 1)
    expect(g.vertexMap[2]).toBe(-1)
  })

  it('normals normalised, not re-oriented', () => {
    const g = buildPointGraph({
      kind: 'cloud',
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, -3, 0, 0, 2, 0, 0, 0.5]),
    })
    expect(Array.from(g.normals)).toEqual([0, 0, -1, 0, 0, 1, 0, 0, 1])
  })

  it('a 1-point and a collinear cloud build without throwing', () => {
    const one = buildPointGraph({ kind: 'cloud', positions: Float32Array.from([1, 2, 3]), normals: Float32Array.from([0, 0, 1]) })
    expect(one.vertexCount).toBe(1)
    expect(one.spacing).toBeGreaterThan(0)
    expect(neighbours(one, 0)).toEqual([])
    const p: number[] = []
    const n: number[] = []
    for (let i = 0; i < 50; i++) { p.push(i, 0, 0); n.push(0, 0, 1) }
    const line = buildPointGraph({ kind: 'cloud', positions: Float32Array.from(p), normals: Float32Array.from(n) })
    expect(line.vertexCount).toBe(50)
    expect(Math.abs(line.spacing - 1)).toBeLessThan(0.01)
    expect(neighbours(line, 10).sort((a, b) => a - b)).toEqual([8, 9, 11, 12])
  })

  it('isCloud true for cloud, false for a mesh graph', () => {
    expect(isCloud(buildPointGraph(asParsed(planeCloud({ size: 2, step: 1 }))))).toBe(true)
    const mesh = buildMeshGraph({
      kind: 'indexed',
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    })
    expect(isCloud(mesh)).toBe(false)
  })
})

describe('worker load of a cloud', () => {
  let replies: WorkerResponse[]
  let scope: { onmessage: ((e: { data: WorkerRequest }) => void) | null; postMessage: (m: WorkerResponse) => void }
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('worker load of a cloud PLY replies kind cloud, triangleCount 0, wireSlots length = vertexCount', () => {
    const c = planeCloud({ size: 5, step: 1 })
    const buffer = writePlyCloud(c, 'binary_little_endian')
    replies.length = 0
    scope.onmessage!({ data: { type: 'load', requestId: 1, name: 'cloud.ply', buffer, crease: { mode: 'on', angleDeg: 30 } } })
    const r = replies.at(-1)!
    if (r.type !== 'loaded') throw new Error(JSON.stringify(r))
    expect(r.kind).toBe('cloud')
    expect(r.triangleCount).toBe(0)
    expect(r.vertexCount).toBe(c.positions.length / 3)
    expect(r.wireSlots.length).toBe(r.vertexCount)
    expect(r.indices.length).toBe(0)
    expect(r.copyOf.length).toBe(0)
    expect(Math.abs((r.spacing ?? 0) - 1)).toBeLessThan(0.01)
  })
})
