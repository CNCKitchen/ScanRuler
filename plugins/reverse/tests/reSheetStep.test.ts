// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { NominalSurface } from '../../../src/core/deviation/surface'
import { Builder } from '../core/build'
import type { Feature } from '../core/features'
import { rectangleLoop, ReKernel } from '../core/kernel'
import { findRegions } from '../core/regions'
import { addEntity } from '../core/sketch'
import { DEFAULT_SURFACE_FIT } from '../core/surfaceFit'
import { build, extrudeAll, rectangleSketch, sketchOf } from './reKit'

const kernelPromise = ReKernel.load()

async function fixture() {
  const kernel = await kernelPromise
  const builder = new Builder(kernel)
  const points: number[] = []
  const indices: number[] = []
  for (let y = 0; y <= 12; y++) for (let x = 0; x <= 20; x++) {
    points.push(100 + x, -50 + y, 8 + x * x / 500 + y * y / 700)
    if (x < 20 && y < 12) {
      const a = y * 21 + x
      indices.push(a, a + 1, a + 22, a, a + 22, a + 21)
    }
  }
  const positions = Float32Array.from(points)
  builder.setScan(new NominalSurface(positions, Uint32Array.from(indices)), positions)
  const surface: Feature = {
    id: 1, kind: 'surface', name: 'Fitted roof', visible: true,
    region: Uint32Array.from({ length: points.length / 3 }, (_, i) => i),
    fit: { ...DEFAULT_SURFACE_FIT, net: { u: 6, v: 6 }, expandPct: 0, normal: [0, 0, 1] },
  }
  const outline = rectangleSketch(2, 14, 8, [103, -48])
  addEntity(outline.sketch, { kind: 'circle', c: [110, -44], r: 1 })
  const regions = findRegions(outline.sketch).sort((a, b) => b.area - a.area)
  const prism = { ...extrudeAll(3, outline, -20, 20), regions: [regions[0].key] }
  const solidSketch = rectangleSketch(5, 4, 3, [140, 0])
  const cutterSketch = sketchOf(7, (s) => { addEntity(s, { kind: 'line', a: [0, 0], b: [5, 0] }) })
  const out = await build(builder, [
    surface, outline, prism,
    { id: 4, kind: 'boolean', name: 'Trim roof', op: 'intersect', body: 1, tool: 3, keep: true, visible: true },
    solidSketch, extrudeAll(6, solidSketch, 0, 2),
    cutterSketch, { id: 8, kind: 'sheet', name: 'Cutting sheet', sketchId: 7, from: -2, to: 2, visible: true },
  ])
  expect(out.results.every((r) => r.status === 'ok')).toBe(true)
  expect(out.bodies.find((b) => b.id === 1)).toMatchObject({ surface: true, faces: 1 })
  return { builder, kernel }
}

describe('opt-in open-sheet STEP export', () => {
  it('does not import an all-sheet export for solid-gap mending, but still verifies explicitly', async () => {
    const kernel = await kernelPromise
    const face = kernel.face({ outer: rectangleLoop([10, 20, 30], [1, 0, 0], [0, 1, 0], 0.004, 0.003), holes: [] })
    const readBack = vi.spyOn(kernel, 'readBackEdges')
    try {
      const { text, mended } = kernel.exportStepMended([face], [{ name: 'Tiny sheet' }], [true])
      expect(mended).toEqual([])
      expect(readBack).not.toHaveBeenCalled()
      expect(kernel.verifyStep(text, [face], { sheets: [true] })).toMatchObject({ ok: true, parts: 1, bodies: [{ sheet: true, closed: false, faces: [1, 1] }] })
    } finally {
      readBack.mockRestore()
      kernel.release(face)
    }
  })

  it('keeps fitted sheets and cutters excluded by default, with the remaining label aligned', async () => {
    const { builder, kernel } = await fixture()
    try {
      const text = builder.exportStep([1, 6, 8], [{ name: 'Roof' }, { name: 'Solid' }, { name: 'Cutter' }])
      expect(kernel.readStepNames(text)).toEqual(['Solid'])
      expect(builder.verifyStep([1, 6, 8], text)).toMatchObject({ ok: true, parts: 1 })
      expect(() => builder.exportStep([1])).toThrow(/no body to write/)
    } finally {
      builder.dispose()
    }
  })

  it('reads back a trimmed single-face fitted sheet, preserving its opening and frame', async () => {
    const { builder, kernel } = await fixture()
    try {
      const { text } = builder.exportStepMended([1], [{ name: 'Roof', color: '#123456' }], true)
      expect(kernel.readStepNames(text)).toEqual(['Roof'])
      expect(text).toContain('B_SPLINE_SURFACE')
      const check = builder.verifyStep([1], text, true)
      expect(check.problems).toEqual([])
      expect(check).toMatchObject({ ok: true, parts: 1 })
      expect(check.bodies[0]).toMatchObject({ sheet: true, closed: false, faces: [1, 1] })
      expect(check.bodies[0].gap.max).toBeLessThan(0.001)
      expect(check.bodies[0].freeEdgeCount).toBe(0)
      expect(check.loops.wrong).toEqual([])
      expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)')
      const back = kernel.importStep(text)
      try {
        expect(kernel.surfaceArea(back)).toBeCloseTo(builder.check(1, 0.01)!.area, 5)
        const cuts = kernel.sectionPolylines(back, [110, 0, 0], [1, 0, 0], 0.01)
        const ranges = cuts.map((cut) => {
          const ys = Array.from(cut).filter((_, i) => i % 3 === 1)
          return [Math.min(...ys), Math.max(...ys)]
        }).sort((a, b) => a[0] - b[0])
        expect(ranges).toHaveLength(2)
        for (const [i, expected] of [[-48, -45], [-43, -40]].entries()) {
          expect(ranges[i][0]).toBeCloseTo(expected[0], 3)
          expect(ranges[i][1]).toBeCloseTo(expected[1], 3)
        }
      } finally {
        kernel.release(back)
      }
    } finally {
      builder.dispose()
    }
  })

  it('reads mixed solids, cutting sheets and fitted sheets in their selected order', async () => {
    const { builder, kernel } = await fixture()
    try {
      const text = builder.exportStep([8, 6, 1], [{ name: 'Cutter' }, { name: 'Solid' }, { name: 'Roof' }], true)
      expect(kernel.readStepNames(text)).toEqual(['Cutter', 'Solid', 'Roof'])
      const check = builder.verifyStep([8, 6, 1], text, true)
      expect(check.problems).toEqual([])
      expect(check.parts).toBe(3)
      expect(check.bodies.map((b) => b.closed)).toEqual([false, true, false])
      expect(check.bodies.map((b) => b.faces)).toEqual([[1, 1], [6, 6], [1, 1]])
    } finally {
      builder.dispose()
    }
  })
})
