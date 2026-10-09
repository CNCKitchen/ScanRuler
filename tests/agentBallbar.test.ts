// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { fixture } from './fixtures'
import { run, startHeadless, undoLabels, type Headless } from './commandKit'

/** The ball bar measured through the commands alone, as an agent would: open
 *  the scan, read where it lies, fit a sphere in each end, measure between
 *  them, ask for the report — then undo the dimension. The same reference
 *  figure as tests/ballbar.test.ts: GOM Inspect measures 148.64 mm. */
const FILE = fixture('ballbar.stl')

type Vec3 = [number, number, number]

describe.skipIf(!FILE.exists)('ballbar.stl through the commands', () => {
  let headless: Headless
  beforeAll(async () => {
    headless = await startHeadless()
  })
  afterAll(() => headless?.stop())

  it('fits both balls, measures the centre distance, reports it, and undoes it', async () => {
    const opened = await run<{ scan: { vertices: number; bounds: { min: Vec3; max: Vec3 } } }>('scan.open', {
      bytes: new Uint8Array(readFileSync(FILE.path)),
      name: 'ballbar.stl',
      units: 'mm',
    })
    expect(opened.scan.vertices).toBeGreaterThan(100_000)

    // Where the balls are, from the readout: the bar is the box's long side,
    // a ball in each end — aim a twentieth of the way in from either end,
    // through the middle of the box across it.
    const state = await run<{ scan: { bounds: { min: Vec3; max: Vec3 } }; elements: unknown[] }>('session.state')
    const { min, max } = state.scan.bounds
    const span = [0, 1, 2].map((k) => max[k] - min[k])
    const axis = span.indexOf(Math.max(...span))
    const mid: Vec3 = [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as Vec3
    const toward = (t: number): Vec3 => mid.map((c, k) => (k === axis ? min[k] + t * span[k] : c)) as Vec3

    type Fitted = { element: { id: number; name: string; kind: string; fit: { center: Vec3; radius: number; sigma: number; usedPoints: number } }; seeds: { vertex: number; point: Vec3 }[] }
    const a = await run<Fitted>('element.fit', { kind: 'sphere', at: { point: toward(0.05) } })
    const b = await run<Fitted>('element.fit', { kind: 'sphere', at: { point: toward(0.95) } })
    for (const ball of [a, b]) {
      expect(ball.element.kind).toBe('sphere')
      expect(ball.element.fit.radius * 2).toBeCloseTo(15.92, 1)
      expect(ball.element.fit.sigma).toBeLessThan(0.1)
      expect(ball.element.fit.usedPoints).toBeGreaterThan(5_000)
      expect(ball.seeds[0].vertex).toBeGreaterThanOrEqual(0)
    }
    expect(undoLabels()).toEqual(['Agent: fit sphere', 'Agent: fit sphere'])
    expect(useStore.getState().draft).toBeNull()

    type Measured = { dimension: { id: number; name: string; type: string; value: number; unit: string; display: string } }
    const dim = await run<Measured>('dimension.add', { refs: [a.element.name, b.element.id] })
    expect(dim.dimension.type).toBe('dist-point-point')
    expect(dim.dimension.unit).toBe('mm')
    console.log(`centre distance through the commands: ${dim.dimension.value.toFixed(4)} mm (GOM: 148.64 mm)`)
    expect(Math.abs(dim.dimension.value - 148.64)).toBeLessThan(0.05)
    expect(useStore.getState().dimDraft).toBeNull()

    const json = await run<{ report: { dimensions: { name: string; value: number }[]; elements: { cutoff?: string }[]; traceability: { frame: string } } }>('report.get')
    expect(json.report.dimensions).toHaveLength(1)
    expect(json.report.dimensions[0].value).toBe(dim.dimension.value)
    expect(json.report.elements.every((e) => e.cutoff === '3 sigma cut-off')).toBe(true)
    expect(json.report.traceability.frame).toMatch(/scan’s own/)

    const text = await run<{ text: string }>('report.get', { format: 'text' })
    expect(text.text.startsWith('ScanRuler — ballbar.stl')).toBe(true)
    expect(text.text).toContain(`${dim.dimension.name} (${a.element.name} → ${b.element.name}) — Center distance: ${dim.dimension.display}`)

    const undone = await run<{ undone: string }>('history.undo')
    expect(undone.undone).toBe('Agent: add dimension')
    expect(useStore.getState().dimensions).toHaveLength(0)
    expect(useStore.getState().elements).toHaveLength(2)
  })
})
