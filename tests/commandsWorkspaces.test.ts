// SPDX-License-Identifier: AGPL-3.0-only
// The deviation, wall thickness and 2D Measure commands: each refuses what
// does not fit, does what its panel does, and is one undo step — or none,
// where it starts a new history or changes nothing the history keeps. In the
// in-process worker, with no viewport and no browser (see commandKit.ts):
// what needs either says so.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDeviation } from '../src/state/deviationStore'
import { useFlat } from '../src/state/flatStore'
import { useThickness } from '../src/state/thicknessStore'
import { useShell } from '../src/state/shellStore'
import { boxMesh } from './helpers'
import { refused, run, startHeadless, stlBytes, undoLabels, type Headless } from './commandKit'

type Vec2 = [number, number]
const BOX = stlBytes(boxMesh(40, 40))

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

const openBox = () => run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
const undo = () => run('history.undo')

describe('deviation', () => {
  beforeEach(async () => {
    await openBox()
  })

  it('deviation.open_reference opens the reference part and starts a new history', async () => {
    expect((await refused('deviation.open_reference', { bytes: BOX })).code).toBe('invalid_input')
    expect((await refused('deviation.align')).code).toBe('invalid_state')
    const r = await run<{ deviation: { reference: { fileName: string; triangles: number } } }>('deviation.open_reference', { bytes: BOX, name: 'nominal.stl' })
    expect(r.deviation.reference).toMatchObject({ fileName: 'nominal.stl', triangles: 19200 })
    expect(useShell.getState().workspace).toBe('deviation')
    expect(undoLabels()).toEqual([])
  })

  it('deviation.align best-fits the scan onto the reference and maps it, as one step', async () => {
    await run('deviation.open_reference', { bytes: BOX, name: 'nominal.stl' })
    type A = { deviation: { align: { rms: number; matched: number; source: string }; map: string; stats: { measured: number; max: number } } }
    const a = await run<A>('deviation.align')
    expect(a.deviation.align.source).toBe('auto')
    expect(a.deviation.align.rms).toBeLessThan(0.01)
    expect(a.deviation.map).toBe('ready')
    expect(a.deviation.stats.measured).toBeGreaterThan(1000)
    expect(Math.abs(a.deviation.stats.max)).toBeLessThan(0.01)
    expect(undoLabels()).toEqual(['Agent: best-fit alignment'])
    await undo()
    expect(useDeviation.getState().align).toBeNull()
  })

  it('deviation.align starts from point pairs, or refines on a marked surface', async () => {
    await run('deviation.open_reference', { bytes: BOX, name: 'nominal.stl' })
    expect((await refused('deviation.align', { mode: 'local', vertices: [1, 2, 3] })).code).toBe('invalid_state')
    const corners: [number, number, number][] = [[20, 20, 20], [-20, 20, 20], [20, -20, 20], [20, 20, -20]]
    type A = { deviation: { align: { rms: number; source: string } } }
    const p = await run<A>('deviation.align', { mode: 'points', pairs: corners.map((c) => ({ scan: c, reference: c })) })
    expect(p.deviation.align.source).toBe('points')
    expect(p.deviation.align.rms).toBeLessThan(0.01)
    const seed = await run<{ vertex: number }>('scan.nearest', { at: { point: [0, 0, 20] } })
    const top = await headless.session.clientRef.current!.flood(seed.vertex, 10)
    expect((await refused('deviation.align', { mode: 'local' })).code).toBe('invalid_input')
    const l = await run<A>('deviation.align', { mode: 'local', vertices: [...top], searchDistance: 1 })
    expect(l.deviation.align.source).toBe('local')
    expect(undoLabels()).toEqual(['Agent: best-fit alignment', 'Agent: local fine fit'])
  })

  it('deviation.measure, deviation.settings and the text report', async () => {
    await run('deviation.open_reference', { bytes: BOX, name: 'nominal.stl' })
    expect((await refused('deviation.measure')).code).toBe('invalid_state')
    await run('deviation.align')
    type M = { deviation: { stats: { measured: number; tolerance: number }; settings: { tolerance: number; facingDeg: number | null } } }
    const m = await run<M>('deviation.measure')
    expect(m.deviation.stats.measured).toBeGreaterThan(1000)
    const s = await run<M>('deviation.settings', { tolerance: 0.05, facingDeg: 45 })
    expect(s.deviation.settings).toMatchObject({ tolerance: 0.05, facingDeg: 45 })
    expect(s.deviation.stats.tolerance).toBe(0.05)
    expect((await refused('deviation.settings', { tolerance: -1 })).code).toBe('invalid_input')
    expect(undoLabels().slice(-1)).toEqual(['Agent: deviation settings'])
    await undo()
    expect(useDeviation.getState().tolerance).not.toBe(0.05)
    const text = (await run<{ text: string }>('report.get', { format: 'text', workspace: 'deviation' })).text
    expect(text.startsWith('ScanRuler — deviation from nominal')).toBe(true)
    expect(text).toContain('Reference: nominal.stl')
  })

  it('deviation.hotspots gathers what lies over tolerance into patches', async () => {
    expect((await refused('deviation.hotspots')).code).toBe('invalid_state')
    // A reference a tenth taller than the scan: the scan's top and bottom
    // lie 2 mm inside it, its sides on it.
    const slab = boxMesh(40, 40).map((v, i) => (i % 3 === 2 ? v * 1.1 : v))
    await run('deviation.open_reference', { bytes: stlBytes(slab), name: 'slab.stl' })
    await run('deviation.align')
    type V3 = [number, number, number]
    type H = { source: string; tolerance: number; over: number; found: number; spacing: number; patches: { centroid: V3; box: { min: V3; max: V3 }; area: number; count: number; mean: number; extreme: number; side: string; at: V3; vertex: number; vertices: number[]; onReference?: { centroid: V3; at: V3 } }[] }
    const h = await run<H>('deviation.hotspots', { tolerance: 0.5 })
    expect(h.source).toBe('reference')
    expect(h.tolerance).toBe(0.5)
    expect(h.found).toBe(2)
    expect(h.patches).toHaveLength(2)
    // The scan's grid is a millimetre.
    expect(h.spacing).toBeCloseTo(1, 1)
    for (const p of h.patches) {
      expect(p.side).toBe('inside')
      expect(Math.abs(p.extreme)).toBeCloseTo(2, 1)
      expect(Math.abs(p.centroid[2])).toBeCloseTo(20, 0)
      expect(Math.abs(p.box.min[2] - p.box.max[2])).toBeLessThan(1e-3)
      expect(p.count).toBeGreaterThan(300)
      expect(p.area).toBeGreaterThan(1000)
      expect(p.vertices.length).toBeGreaterThan(0)
      expect(p.vertices).toContain(p.vertex)
      expect(p.onReference).toBeDefined()
    }
    expect(h.patches[0].centroid[2] * h.patches[1].centroid[2]).toBeLessThan(0)
    expect(h.over).toBeGreaterThanOrEqual(h.patches[0].count + h.patches[1].count)
    const none = await run<H>('deviation.hotspots', { tolerance: 3 })
    expect(none.patches).toEqual([])
    expect(none.over).toBe(0)
    expect((await refused('deviation.hotspots', { patches: 0 })).code).toBe('invalid_input')
  })

  it('deviation.set_target needs the viewport the element map is measured on', async () => {
    await run('element.fit', { kind: 'plane', at: { point: [0, 0, 20] } })
    expect((await refused('deviation.set_target', { element: 'Plane 1' })).code).toBe('unavailable')
    expect((await refused('deviation.set_target', {})).code).toBe('invalid_input')
  })
})

describe('wall thickness', () => {
  beforeEach(async () => {
    await openBox()
  })

  it('thickness.measure measures the walls, its settings one step with it', async () => {
    type T = { thickness: { status: string; stats: { measured: number; mean: number }; settings: { method: string; maxThickness: number } } }
    const t = await run<T>('thickness.measure', { method: 'ray', maxThickness: 60 })
    expect(t.thickness.status).toBe('ready')
    expect(t.thickness.settings).toMatchObject({ method: 'ray', maxThickness: 60 })
    expect(t.thickness.stats.measured).toBeGreaterThan(1000)
    expect(t.thickness.stats.mean).toBeGreaterThan(30)
    expect(useShell.getState().workspace).toBe('thickness')
    expect(undoLabels()).toEqual(['Agent: measure wall thickness'])
    // Measured again as it stands, nothing the history keeps changes.
    await run('thickness.measure')
    expect(undoLabels()).toEqual(['Agent: measure wall thickness'])
    const text = (await run<{ text: string }>('report.get', { format: 'text', workspace: 'thickness' })).text
    expect(text.startsWith('ScanRuler — wall thickness')).toBe(true)
    expect((await refused('thickness.measure', { method: 'cone' })).code).toBe('invalid_input')
  })

  it('thickness.settings is a step of its own', async () => {
    await run('thickness.settings', { limit: 2.5, low: 1, high: 50 })
    expect(useThickness.getState().limit).toBe(2.5)
    expect(undoLabels()).toEqual(['Agent: wall thickness settings'])
    await undo()
    expect(useThickness.getState().limit).not.toBe(2.5)
  })
})

describe('2D Measure', () => {
  // An image on the sheet, as opening one leaves it — the store holds only
  // its name and size; the pixels are App's, and nothing here reads them.
  const openSheet = () => useFlat.getState().finishImageLoad('sheet.png', 2000, 1000, null)

  it('flat commands that need the browser say so, and refuse an empty sheet', async () => {
    expect((await refused('flat.open_image', { bytes: new Uint8Array(4), name: 'a.png' })).code).toBe('unavailable')
    expect((await refused('flat.detect_edges')).code).toBe('unavailable')
    expect((await refused('flat.fit', { kind: 'line', points: [[0, 0], [1, 1]] })).code).toBe('invalid_state')
    expect((await refused('export.svg')).code).toBe('unavailable')
    expect((await refused('export.csv')).code).toBe('invalid_state')
  })

  it('calibrates, aligns, fits, dimensions and reports, a step each', async () => {
    openSheet()
    const circle = (cx: number, cy: number, r: number): Vec2[] =>
      [0, 1, 2, 3, 4, 5].map((i) => [cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3)] as Vec2)

    expect((await refused('flat.calibrate', { mode: 'distance', points: [[0, 0]], mm: 10 })).code).toBe('invalid_input')
    const cal = await run<{ calibration: { source: string; pxPerMm: { x: number } } }>('flat.calibrate', { mode: 'distance', points: [[100, 100], [600, 100]], mm: 50 })
    expect(cal.calibration.source).toBe('measured')
    expect(cal.calibration.pxPerMm.x).toBeCloseTo(10)
    // From here on the sheet reads in millimetres.
    await run('flat.set_alignment', { origin: [10, 10], xAxis: [60, 10] })
    expect(useFlat.getState().datum).not.toBeNull()
    type E = { element: { id: number; name: string; kind: string; fit: { radius?: number } } }
    const line = (await run<E>('flat.fit', { kind: 'line', points: [[10, 20], [60, 20]], name: 'Base' })).element
    expect(line).toMatchObject({ kind: 'line', name: 'Base' })
    const hole = (await run<E>('flat.fit', { kind: 'circle', points: circle(100, 50, 10) })).element
    expect(hole.fit.radius).toBeCloseTo(10, 3)
    expect((await refused('flat.fit', { kind: 'circle', method: 'flat-line-pick', points: [[0, 0]] })).code).toBe('invalid_input')
    const dim = await run<{ report: string }>('flat.dimension_add', { refs: [hole.name, 'Base'], name: 'Hole height' })
    expect(dim.report).toContain(`${hole.name} → Base — Distance to line: 30.000 mm`)
    expect(useFlat.getState().dimensions.map((d) => d.name)).toEqual(['Hole height'])
    expect((await refused('flat.dimension_add', { refs: ['Base', 'Base'], type: 'flat-dist-point-point' })).code).toBe('invalid_input')
    expect(useFlat.getState().draft).toBeNull()
    expect(useFlat.getState().dimDraft).toBeNull()
    expect(useFlat.getState().tool.kind).toBe('none')

    const report = await run<{ text: string }>('flat.report')
    expect(report.text).toMatch(/30\.000 mm/)
    const csv = await run<{ file: { name: string; bytes: Uint8Array } }>('export.csv')
    expect(csv.file.name).toBe('sheet-measurements.csv')
    expect(new TextDecoder().decode(csv.file.bytes)).toMatch(/30\.0+/)
    expect(undoLabels()).toEqual(['Agent: calibrate', 'Agent: align sheet', 'Agent: fit 2D line', 'Agent: fit 2D circle', 'Agent: add 2D dimension'])
    await undo()
    expect(useFlat.getState().dimensions).toHaveLength(0)
  })
})
