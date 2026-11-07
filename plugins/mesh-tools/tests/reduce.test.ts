// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { NominalSurface } from '../../../src/core/deviation/surface'
import { parseSTL } from '../../../src/core/parsers/stl'
import { colormapById, paintField, UNMEASURED_RGB } from '../../../src/core/field/colormap'
import {
  compactMesh,
  defaultTolerance,
  HELD_SHARE,
  loadSimplifier,
  reduceMesh,
  reductionScale,
  type ReduceSettings,
} from '../core/reduce'
import { defaultMinPiece, surveyPieces, withoutTriangles } from '../core/pieces'
import type { MeshGraph } from '../../../src/core/types'
import { boxMesh, icosphere } from '../../../tests/helpers'
import { fixture } from '../../../tests/fixtures'

let simplifier: Awaited<ReturnType<typeof loadSimplifier>>
beforeAll(async () => {
  simplifier = await loadSimplifier()
})

/** Reduce a graph the way the worker does, with the scan's surface built on
 *  demand the way the worker builds it. */
function reduce(graph: MeshGraph, settings: Partial<ReduceSettings> = {}) {
  let surface: NominalSurface | null = null
  return reduceMesh(
    simplifier,
    graph,
    { tolerance: 0.05, maxTriangles: 1_000_000, ...settings },
    () => (surface ??= new NominalSurface(graph.positions, graph.indices)),
  )
}

/** A noisy ball — a small synthetic scan: curved everywhere, so the
 *  tolerance is what decides how far it reduces. */
function ball(noise = 0.01): MeshGraph {
  const { positions, indices } = icosphere(5, 20, noise)
  return buildMeshGraph({ kind: 'indexed', positions, indices })
}

describe('the defaults for a part', () => {
  it('start the tolerance at about a four-thousandth of the part, on 1-2-5 steps', () => {
    expect(defaultTolerance(166.5)).toBe(0.05)
    expect(defaultTolerance(231.7)).toBe(0.1)
    expect(defaultTolerance(40)).toBe(0.01)
    expect(defaultTolerance(1500)).toBe(0.5)
  })

  it('never land on a float crumb', () => {
    for (const d of [3, 17, 42.5, 99, 250, 777, 4000]) {
      for (const v of [defaultTolerance(d)]) {
        expect(String(v)).toMatch(/^\d+(\.\d{1,6})?$/)
      }
    }
  })
})

describe('compactMesh', () => {
  it('keeps only the vertices the triangles use, renumbered in order of use', () => {
    const positions = Float32Array.from([0, 0, 0, 9, 9, 9, 1, 0, 0, 0, 1, 0])
    const { positions: p, indices } = compactMesh(positions, Uint32Array.from([3, 0, 2]))
    expect(Array.from(indices)).toEqual([0, 1, 2])
    expect(Array.from(p)).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 0])
  })
})

describe('reducing a scan', () => {
  it('holds the tolerance on 99.9 % of the scan, both ways, with far fewer triangles', () => {
    const graph = ball()
    const { report, positions, indices, deviation } = reduce(graph, { tolerance: 0.05 })
    expect(report.held).toBe(true)
    expect(report.p999).toBeLessThanOrEqual(0.05)
    expect(report.backP999).toBeLessThanOrEqual(0.05)
    expect(report.within / report.measured).toBeGreaterThanOrEqual(HELD_SHARE)
    expect(report.triangles).toBeLessThan(graph.triangleCount / 4)
    expect(report.triangles).toBe(indices.length / 3)
    expect(report.vertices).toBe(positions.length / 3)
    // A deviation for every scan vertex, and it is the one reported.
    expect(deviation.length).toBe(graph.vertexCount)
    let worst = 0
    for (const d of deviation) worst = Math.max(worst, Math.abs(d))
    expect(worst).toBeCloseTo(report.max, 5)
  })

  it('gives fewer triangles to a looser tolerance', () => {
    const graph = ball()
    const tight = reduce(graph, { tolerance: 0.02 }).report
    const loose = reduce(graph, { tolerance: 0.2 }).report
    expect(tight.held && loose.held).toBe(true)
    expect(loose.triangles).toBeLessThan(tight.triangles)
  })

  it('reduces a flat face to a couple of triangles', () => {
    // A box, each face a 20 × 20 grid: 2400 triangles that describe 12.
    const graph = buildMeshGraph({ kind: 'soup', positions: boxMesh(10, 20) })
    const { report } = reduce(graph, { tolerance: 0.01 })
    expect(report.held).toBe(true)
    expect(report.triangles).toBeLessThanOrEqual(12)
    expect(report.max).toBeLessThan(1e-4)
  })

  it('pins the scan where the plain reduction strays, and only there', () => {
    // A tolerance under the scatter the simplifier averages away needs pins
    // to hold; the pins are a small share of the scan.
    const graph = ball(0.02)
    const { report } = reduce(graph, { tolerance: 0.03 })
    expect(report.held).toBe(true)
    expect(report.pinned).toBeGreaterThan(0)
    expect(report.pinned).toBeLessThan(graph.vertexCount * 0.05)
    expect(report.passes).toBeGreaterThan(1)
  })

  it('reduces past the tolerance to meet a triangle limit, and says so', () => {
    const graph = ball()
    const free = reduce(graph, { tolerance: 0.02 }).report
    const { report } = reduce(graph, { tolerance: 0.02, maxTriangles: Math.floor(free.triangles / 4) })
    expect(report.capped).toBe(true)
    expect(report.triangles).toBeLessThanOrEqual(Math.floor(free.triangles / 4))
    expect(report.held).toBe(false)
    expect(report.p999).toBeGreaterThan(0.02)
  })

  it('leaves a limit alone when the tolerance already needs fewer', () => {
    const graph = ball()
    const { report } = reduce(graph, { tolerance: 0.1, maxTriangles: 100_000 })
    expect(report.capped).toBe(false)
    expect(report.held).toBe(true)
  })

  it('measures every vertex a triangle uses, and leaves one no triangle uses unmeasured', () => {
    const { positions, indices } = icosphere(5, 20, 0.01)
    // One more vertex, far off and in no triangle — what a PLY may carry.
    const withOrphan = new Float32Array(positions.length + 3)
    withOrphan.set(positions)
    withOrphan.set([100, 0, 0], positions.length)
    const graph = buildMeshGraph({ kind: 'indexed', positions: withOrphan, indices })
    const { report, deviation } = reduce(graph, { tolerance: 0.05 })
    expect(report.measured).toBe(graph.vertexCount - 1)
    expect(deviation[graph.vertexCount - 1]).toBeNaN()
    expect(report.held).toBe(true)
  })

  it('says where each scan vertex went, in order, for the result to become the edited copy', () => {
    const graph = ball()
    const { report, positions, indices, vertexMap } = reduce(graph, { tolerance: 0.05 })
    expect(vertexMap.length).toBe(graph.vertexCount)
    const kept = Array.from(vertexMap).filter((w) => w >= 0)
    // Every vertex of the result is a scan vertex, once, and ascending lists
    // stay ascending through the map.
    expect(kept).toEqual(Array.from({ length: report.vertices }, (_, i) => i))
    expect(positions.length / 3).toBe(report.vertices)
    expect(Math.max(...indices)).toBe(report.vertices - 1)
  })

  it('refuses a tolerance of nothing, and a limit of no triangles', () => {
    const graph = ball()
    expect(() => reduce(graph, { tolerance: 0 })).toThrow(/more than zero/)
    expect(() => reduce(graph, { maxTriangles: 0 })).toThrow(/at least one/)
  })

  it('leaves the scan it was given untouched', () => {
    const graph = ball()
    const positions = graph.positions.slice()
    const indices = graph.indices.slice()
    reduce(graph, { tolerance: 0.05 })
    expect(graph.positions).toEqual(positions)
    expect(graph.indices).toEqual(indices)
  })
})

describe('the reduction map', () => {
  it('reads to the tolerance either side, capped past it, bare where nothing was measured', () => {
    const scale = reductionScale(0.05)
    const out = new Uint8Array(4 * 3)
    const jet = colormapById('jet')
    paintField(Float32Array.from([0, 0.08, -0.08, NaN]), scale, jet, out)
    expect(Array.from(out.subarray(3, 6))).toEqual([...jet.over])
    expect(Array.from(out.subarray(6, 9))).toEqual([...jet.under])
    expect(Array.from(out.subarray(9, 12))).toEqual([...UNMEASURED_RGB])
    // Zero is the middle of the ramp: green.
    expect(out[1]).toBeGreaterThan(out[0])
    expect(out[1]).toBeGreaterThan(out[2])
  })
})

const BALLBAR = fixture('ballbar.stl')

describe.skipIf(!BALLBAR.exists)('ballbar.stl reduction', () => {
  it('reduces a real scan to a few thousand triangles within 0.05 mm', () => {
    const buf = readFileSync(BALLBAR.path)
    const scan = buildMeshGraph(parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)))
    // The way it is meant to go: the debris the scanner left floating taken
    // off first, with Remove islands.
    const survey = surveyPieces(scan.positions, scan.indices, scan.vertexCount, defaultMinPiece(scan.bboxDiag))
    expect(survey.islands).toBeGreaterThan(0)
    const kept = withoutTriangles(scan.positions, scan.indices, scan.vertexCount, survey.islandMask)
    const graph = buildMeshGraph({ kind: 'indexed', positions: kept.positions, indices: kept.indices })
    const { report } = reduce(graph, { tolerance: 0.05, maxTriangles: 50_000 })
    console.log(
      `ballbar: ${report.inputTriangles} → ${report.triangles} triangles, 99.9 % within ${report.p999.toFixed(3)} mm, ` +
        `max ${report.max.toFixed(3)}, back ${report.backP999.toFixed(3)}, ${report.passes} passes, ${report.pinned} pinned`,
    )
    expect(report.held).toBe(true)
    expect(report.triangles).toBeLessThan(8000)
    // With the debris gone, so is the worst of the deviation it carried.
    expect(report.max).toBeLessThan(0.2)
  })
})
