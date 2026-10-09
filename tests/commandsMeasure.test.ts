// SPDX-License-Identifier: AGPL-3.0-only
// Every command of the session, the scan, the 3D Measure workspace and the
// files: its schema refuses what does not fit, it does what its panel does,
// and it is one undo step (or none, for those that start a new history or
// change nothing). On a 40 mm box and a pair of balls, in the in-process
// worker — see commandKit.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listCommands } from '../src/commands/registry'
import { registerStateSection } from '../src/commands/stateSections'
import { useHistory } from '../src/state/historyStore'
import { useShell } from '../src/state/shellStore'
import { useStore } from '../src/state/store'
import { boxMesh, icosphere } from './helpers'
import { refused, run, soupOf, startHeadless, stlBytes, undoLabels, type Headless } from './commandKit'

type Vec3 = [number, number, number]
interface El { id: number; name: string; kind: string; fit: { center: Vec3; normal?: Vec3; radius?: number } | null; source: { type: string; markedPoints?: number; refs?: number[] }; visible: boolean }

const BOX = stlBytes(boxMesh(40, 40))
const BALLS = (() => {
  const ball = icosphere(3, 5)
  const a = soupOf(ball, [-30, 0, 0])
  const b = soupOf(ball, [30, 0, 0])
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return stlBytes(out)
})()

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

const openBox = () => run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
const elements = () => useStore.getState().elements
const fitFace = async (point: Vec3) => (await run<{ element: El }>('element.fit', { kind: 'plane', at: { point } })).element
const undo = () => run('history.undo')

describe('the command list', () => {
  it('holds the contract’s names', () => {
    const names = listCommands().map((c) => c.name)
    for (const name of [
      'session.state', 'session.reset', 'workspace.set', 'scan.open', 'scan.nearest',
      'element.fit', 'element.fit_marked', 'element.construct', 'element.rename', 'element.remove', 'element.set_visible',
      'dimension.add', 'dimension.set_limit', 'dimension.set_basic', 'dimension.remove',
      'align.datum', 'align.auto', 'align.symmetry', 'align.clear', 'section.cut',
      'deviation.open_reference', 'deviation.align', 'deviation.measure', 'deviation.set_target', 'deviation.settings',
      'thickness.measure', 'thickness.settings',
      'flat.open_image', 'flat.calibrate', 'flat.set_alignment', 'flat.detect_edges', 'flat.fit', 'flat.dimension_add', 'flat.report',
      'report.get', 'export.step', 'export.stl', 'export.cloud', 'export.svg', 'export.dxf', 'export.csv',
      'project.save', 'project.load', 'history.undo', 'history.redo',
    ]) expect(names).toContain(name)
    for (const c of listCommands()) {
      expect(c.description.length, c.name).toBeGreaterThan(40)
      expect(JSON.parse(JSON.stringify(c.input)), c.name).toEqual(c.input)
    }
  })
})

describe('scan', () => {
  beforeEach(async () => {
    await openBox()
  })

  it('scan.open reads the file, starts a new history, and refuses to drop work unasked', async () => {
    expect((await refused('scan.open', { name: 'box.stl' })).code).toBe('invalid_input')
    expect((await refused('scan.open', { bytes: BOX, name: 'box.step' })).code).toBe('failed')
    const opened = await run<{ scan: { vertices: number; triangles: number; bounds: { min: Vec3; max: Vec3 }; units: string } }>('scan.open', { bytes: BOX, name: 'box.stl', units: 'cm', discard: true })
    expect(opened.scan.triangles).toBe(19200)
    expect(opened.scan.units).toBe('cm')
    expect(opened.scan.bounds.max[0]).toBeCloseTo(200)
    expect(undoLabels()).toEqual([])
    await openBox()
    await fitFace([0, 0, 20])
    const e = await refused('scan.open', { bytes: BOX, name: 'box.stl' })
    expect(e.code).toBe('invalid_state')
    expect(e.message).toContain('discard')
  })

  it('scan.nearest snaps a point to the scan and changes nothing', async () => {
    const spot = await run<{ vertex: number; point: Vec3; normal: Vec3; distance: number }>('scan.nearest', { at: { point: [0, 0, 25] } })
    expect(spot.point[2]).toBeCloseTo(20)
    expect(spot.distance).toBeCloseTo(5)
    expect(Math.abs(spot.normal[2])).toBeCloseTo(1, 1)
    const again = await run<{ vertex: number }>('scan.nearest', { at: { vertex: spot.vertex } })
    expect(again.vertex).toBe(spot.vertex)
    expect((await refused('scan.nearest', { at: { vertex: 1e7 } })).code).toBe('invalid_input')
    expect((await refused('scan.nearest', { at: { screen: [10, 10] } })).code).toBe('not_implemented')
    expect((await refused('scan.nearest', { at: { candidate: 1 } })).code).toBe('not_implemented')
    expect(useHistory.getState().past).toHaveLength(0)
  })
})

describe('elements', () => {
  beforeEach(async () => {
    await openBox()
  })

  it('element.fit fits a face as one undo step, and leaves no box open', async () => {
    expect((await refused('element.fit', { kind: 'plane' })).code).toBe('invalid_input')
    expect((await refused('element.fit', { kind: 'blob', at: { vertex: 0 } })).code).toBe('invalid_input')
    expect((await refused('element.fit', { kind: 'plane', at: { screen: [1, 1] } })).code).toBe('not_implemented')
    expect((await refused('element.fit', { kind: 'circle', at: [{ vertex: 0 }] })).code).toBe('invalid_input')
    const top = await fitFace([0, 0, 20])
    expect(top.kind).toBe('plane')
    expect(top.fit!.center[2]).toBeCloseTo(20, 3)
    expect(Math.abs(top.fit!.normal![2])).toBeCloseTo(1, 5)
    expect(useStore.getState().draft).toBeNull()
    expect(useShell.getState().workspace).toBe('elements')
    expect(undoLabels()).toEqual(['Agent: fit plane'])
    await undo()
    expect(elements()).toHaveLength(0)
    await run('history.redo')
    expect(elements().map((e) => e.name)).toEqual([top.name])
  })

  it('element.fit takes a point, a name, a cut-off and an alignment to a coordinate plane', async () => {
    const p = await run<{ element: El }>('element.fit', { kind: 'point', at: { point: [3, 4, 21] } })
    expect(p.element.fit!.center[2]).toBeCloseTo(20)
    const side = await run<{ element: El & { orient?: { ref: number; relation: string } } }>('element.fit', {
      kind: 'plane', at: { point: [20, 0, 0] }, name: 'Datum B', sigma: 2, orient: { to: 'YZ' },
    })
    expect(side.element.name).toBe('Datum B')
    expect(side.element.orient).toEqual({ ref: -2, relation: 'normal' })
    expect(useStore.getState().elements.find((e) => e.name === 'Datum B')!.source).toMatchObject({ settings: { sigma: 2 } })
    expect(undoLabels()).toEqual(['Agent: fit point', 'Agent: fit plane'])
    expect((await refused('element.fit', { kind: 'sphere', at: { point: [0, 0, 20] }, orient: { to: 'XY' } })).code).not.toBe('internal')
  })

  it('element.fit_marked fits exactly the vertices given', async () => {
    const seed = await run<{ vertex: number }>('scan.nearest', { at: { point: [0, 0, 20] } })
    const face = await headless.session.clientRef.current!.flood(seed.vertex, 10)
    const el = (await run<{ element: El }>('element.fit_marked', { kind: 'plane', vertices: [...face] })).element
    expect(el.source.markedPoints).toBe(face.length)
    expect(el.fit!.center[2]).toBeCloseTo(20, 3)
    expect((await refused('element.fit_marked', { kind: 'plane', vertices: [1, 2, 1e8] })).code).toBe('invalid_input')
    expect(undoLabels()).toEqual(['Agent: fit plane to a marked surface'])
  })

  it('element.construct builds from elements and numbers, and measures the centroid off the scan', async () => {
    const top = await fitFace([0, 0, 20])
    const side = await fitFace([20, 0, 0])
    const offset = (await run<{ element: El }>('element.construct', { kind: 'plane', method: 'plane-offset', refs: [top.name], params: { offset: 5 } })).element
    expect(Math.abs(offset.fit!.center[2])).toBeCloseTo(25, 3)
    const edge = (await run<{ element: El }>('element.construct', { kind: 'line', method: 'line-plane-plane', refs: [top.id, side.id] })).element
    expect(edge.source.refs).toEqual([top.id, side.id])
    const coords = (await run<{ element: El }>('element.construct', { kind: 'point', method: 'point-coords', params: [1, 2, 3] })).element
    expect(coords.fit!.center).toEqual([1, 2, 3])
    const centroid = (await run<{ element: El }>('element.construct', { kind: 'point', method: 'point-centroid' })).element
    for (const c of centroid.fit!.center) expect(c).toBeCloseTo(0, 3)
    expect((await refused('element.construct', { kind: 'plane', method: 'plane-offset', refs: [], params: [5] })).code).toBe('invalid_input')
    expect((await refused('element.construct', { kind: 'plane', method: 'fit' })).code).toBe('invalid_input')
    expect((await refused('element.construct', { kind: 'line', method: 'line-axis', refs: [top.id] })).code).toBe('invalid_input')
    expect(undoLabels().slice(-4)).toEqual([
      'Agent: construct plane-offset', 'Agent: construct line-plane-plane', 'Agent: construct point-coords', 'Agent: construct point-centroid',
    ])
    expect(useStore.getState().draft).toBeNull()
  })

  it('element.rename, element.set_visible and element.remove are a step each', async () => {
    const top = await fitFace([0, 0, 20])
    const derived = (await run<{ element: El }>('element.construct', { kind: 'plane', method: 'plane-offset', refs: [top.id], params: [1] })).element
    await run('element.rename', { element: top.id, name: 'Top' })
    expect(elements()[0].name).toBe('Top')
    expect((await refused('element.rename', { element: 'Nope', name: 'x' })).code).toBe('not_found')
    await run('element.set_visible', { element: 'Top', visible: false })
    expect(elements()[0].visible).toBe(false)
    await run('element.set_visible', { all: true, visible: true })
    expect(elements().every((e) => e.visible)).toBe(true)
    const removed = await run<{ removed: { id: number }[] }>('element.remove', { element: 'Top' })
    expect(removed.removed.map((r) => r.id).sort()).toEqual([top.id, derived.id].sort())
    expect(undoLabels().slice(-4)).toEqual(['Agent: rename element', 'Agent: hide elements', 'Agent: show elements', 'Agent: delete element'])
    await undo()
    expect(elements()).toHaveLength(2)
    await undo()
    await undo()
    await undo()
    expect(elements()[0].name).toBe(top.name)
  })
})

describe('dimensions', () => {
  let top: El
  let bottom: El
  let side: El
  beforeEach(async () => {
    await openBox()
    top = await fitFace([0, 0, 20])
    bottom = await fitFace([0, 0, -20])
    side = await fitFace([20, 0, 0])
  })

  it('dimension.add measures between elements, the type following them as clicks do', async () => {
    type D = { dimension: { id: number; name: string; type: string; value: number; unit: string; verdict?: { pass: boolean } } }
    const d = await run<D>('dimension.add', { refs: [top.name, bottom.name], limit: { kind: 'band', nominal: 40, plus: 0.1, minus: 0.1 }, name: 'Height' })
    expect(d.dimension).toMatchObject({ type: 'dist-plane-plane', name: 'Height', unit: 'mm', verdict: { pass: true } })
    expect(d.dimension.value).toBeCloseTo(40, 3)
    expect(useStore.getState().dimDraft).toBeNull()
    expect((await refused('dimension.add', { refs: [top.id, side.id], type: 'dist-plane-plane' })).code).toBe('invalid_input')
    expect((await refused('dimension.add', { refs: [top.id, side.id], type: 'dist-point-point' })).code).toBe('invalid_input')
    expect((await refused('dimension.add', { refs: [top.id], type: 'no-such-type' })).code).toBe('invalid_input')
    const angle = await run<D>('dimension.add', { refs: [top.id, side.id], type: 'angle-plane-plane' })
    expect(angle.dimension.value).toBeCloseTo(90, 3)
    expect(undoLabels().slice(-2)).toEqual(['Agent: add dimension', 'Agent: add dimension'])
    await undo()
    await undo()
    expect(useStore.getState().dimensions).toHaveLength(0)
  })

  it('dimension.set_limit, dimension.set_basic and dimension.remove are a step each', async () => {
    type D = { dimension: { id: number; value: number; limit?: unknown; basic?: number; verdict?: { pass: boolean } } }
    const d = (await run<D>('dimension.add', { refs: [top.id, bottom.id] })).dimension
    const failing = await run<D>('dimension.set_limit', { dimension: d.id, limit: { kind: 'max', max: 39 } })
    expect(failing.dimension.verdict?.pass).toBe(false)
    const cleared = await run<D>('dimension.set_limit', { dimension: d.id, limit: null })
    expect(cleared.dimension.limit).toBeUndefined()
    const angularity = (await run<D>('dimension.add', { refs: [side.id, top.id], type: 'orient-angularity', basic: 90 })).dimension
    const basic = await run<D>('dimension.set_basic', { dimension: angularity.id, basic: 89 })
    expect(basic.dimension.basic).toBe(89)
    await run('dimension.remove', { dimension: d.id })
    expect(useStore.getState().dimensions.map((x) => x.id)).toEqual([angularity.id])
    expect(undoLabels().slice(-6)).toEqual([
      'Agent: add dimension', 'Agent: set limit', 'Agent: set limit', 'Agent: add dimension', 'Agent: set basic angle', 'Agent: delete dimension',
    ])
    await undo()
    expect(useStore.getState().dimensions).toHaveLength(2)
    expect((await refused('dimension.remove', { dimension: 999 })).code).toBe('not_found')
  })
})

describe('alignment', () => {
  beforeEach(async () => {
    await openBox()
  })

  it('align.datum turns the part onto the datums and moves the elements with it; undo puts it back', async () => {
    const top = await fitFace([0, 0, 20])
    const r = await run<{ applied: { rotationDeg: number }; appliedAlignment: unknown }>('align.datum', { primary: { element: top.id }, primaryAxis: 'x+' })
    expect(r.applied.rotationDeg).toBeCloseTo(90, 3)
    const moved = elements()[0].fit as { normal: Vec3; center: Vec3 }
    expect(Math.abs(moved.normal[0])).toBeCloseTo(1, 5)
    expect(useStore.getState().alignDraft).toBeNull()
    expect(undoLabels()).toEqual(['Agent: fit plane', 'Agent: datum alignment'])
    await undo()
    expect(useStore.getState().appliedAlignment).toBeNull()
    expect(Math.abs((elements()[0].fit as { normal: Vec3 }).normal[2])).toBeCloseTo(1, 5)
    expect((await refused('align.datum', {})).code).toBe('invalid_input')
    expect((await refused('align.datum', { primary: { points: [[0, 0, 20], [1, 0, 20]] } })).code).toBe('invalid_input')
  })

  it('align.datum takes points on the scan, and align.clear takes the alignment off', async () => {
    await run('align.datum', { primary: { points: [[-10, -10, -20], [10, -10, -20], [0, 10, -20]] }, origin: { point: [-20, -20, -20] } })
    expect(useStore.getState().appliedAlignment).not.toBeNull()
    const state = await run<{ scan: { bounds: { min: Vec3 } } }>('session.state')
    for (const c of state.scan.bounds.min) expect(c).toBeCloseTo(0, 3)
    await run('align.clear')
    expect(useStore.getState().appliedAlignment).toBeNull()
    expect((await refused('align.clear')).code).toBe('invalid_state')
    expect(undoLabels()).toEqual(['Agent: datum alignment', 'Agent: reset alignment'])
  })

  it('align.auto and align.symmetry apply the pose read off the scan, a step each', async () => {
    const auto = await run<{ note?: string; applied: unknown }>('align.auto')
    expect(auto.note).toMatch(/Read off the scan/)
    expect(useStore.getState().alignDraft).toBeNull()
    const sym = await run<{ note?: string }>('align.symmetry')
    expect(sym.note).toMatch(/Settled on/)
    expect(undoLabels()).toEqual(['Agent: auto-align', 'Agent: symmetry alignment'])
    await undo()
    await undo()
    expect(useStore.getState().appliedAlignment).toBeNull()
  })
})

describe('sections', () => {
  it('section.cut cuts across a coordinate plane or an element, and refuses a plane that misses', async () => {
    await openBox()
    type S = { section: { id: number; name: string; chains: number; plane: { origin: Vec3; normal: Vec3 } } }
    const s = await run<S>('section.cut', { across: 'XY', offset: 5, name: 'Mid cut' })
    expect(s.section).toMatchObject({ name: 'Mid cut' })
    expect(s.section.chains).toBeGreaterThan(0)
    expect(s.section.plane.origin[2]).toBeCloseTo(5)
    expect((await refused('section.cut', { across: 'XY', offset: 50 })).code).toBe('failed')
    expect(useStore.getState().sectionDraft).toBeNull()
    const top = await fitFace([0, 0, 20])
    await run('section.cut', { across: top.id, offset: -10 })
    expect(useStore.getState().sections).toHaveLength(2)
    expect(undoLabels()).toEqual(['Agent: cut section', 'Agent: fit plane', 'Agent: cut section'])
    await undo()
    expect(useStore.getState().sections).toHaveLength(1)
  })

  it('refuses a sphere, which has no direction to cut across', async () => {
    await run('scan.open', { bytes: BALLS, name: 'balls.stl', discard: true })
    const ball = (await run<{ element: El }>('element.fit', { kind: 'sphere', at: { point: [-30, 0, 5] } })).element
    expect((await refused('section.cut', { across: ball.id })).code).toBe('invalid_input')
  })
})

describe('session, report, files and history', () => {
  it('session.state reads out the session; workspace.set shows one', async () => {
    await run('scan.open', { bytes: BALLS, name: 'balls.stl', discard: true })
    await run('element.fit', { kind: 'sphere', at: { point: [-30, 0, 5] } })
    await run('element.fit', { kind: 'sphere', at: { point: [30, 0, 5] } })
    await run('dimension.add', { refs: ['Sphere 1', 'Sphere 2'] })
    const s = await run<{
      app: { name: string; version: string; viewport: boolean }; workspace: string; busy: string | null
      scan: { fileName: string; bounds: { min: Vec3; max: Vec3 } }; elements: El[]; dimensions: { value: number }[]
      hint: unknown; history: { undo: string | null }; open: { element: unknown }
    }>('session.state')
    expect(s.app).toMatchObject({ name: 'ScanRuler', viewport: false })
    expect(s.workspace).toBe('measure')
    expect(s.busy).toBeNull()
    expect(s.scan.fileName).toBe('balls.stl')
    expect(s.scan.bounds.max[0]).toBeCloseTo(35, 1)
    expect(s.elements.map((e) => e.fit!.radius)).toEqual([expect.closeTo(5, 2), expect.closeTo(5, 2)])
    expect(s.dimensions[0].value).toBeCloseTo(60, 2)
    expect(s.hint).toBe('done')
    expect(s.history.undo).toBe('Agent: add dimension')
    expect(s.open.element).toBeNull()
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)

    const off = registerStateSection('demo', () => ({ parts: 3 }))
    try {
      const withPart = await run<{ plugins: Record<string, unknown> }>('session.state')
      expect(withPart.plugins.demo).toEqual({ parts: 3 })
      expect(() => registerStateSection('demo', () => null)).toThrow('Two state sections share the id "demo"')
    } finally {
      off()
    }

    await run('workspace.set', { workspace: 'thickness' })
    expect(useShell.getState().workspace).toBe('thickness')
    await run('workspace.set', { workspace: 'measure' })
    expect(useShell.getState().workspace).toBe('elements')
    expect((await refused('workspace.set', { workspace: 'kitchen' })).code).toBe('invalid_input')
  })

  it('report.get gives the clipboard text and the structured report', async () => {
    await run('scan.open', { bytes: BALLS, name: 'balls.stl', discard: true })
    await run('element.fit', { kind: 'sphere', at: { point: [-30, 0, 5] } })
    await run('element.fit', { kind: 'sphere', at: { point: [30, 0, 5] } })
    await run('dimension.add', { refs: ['Sphere 1', 'Sphere 2'], limit: { kind: 'band', nominal: 60, plus: 0.01, minus: 0.01 } })
    const text = (await run<{ text: string }>('report.get', { format: 'text' })).text
    expect(text).toMatch(/^ScanRuler — balls\.stl\nMethod: Gaussian best-fit/)
    expect(text).toContain('Checked against limits: 1 — 1 pass, 0 fail')
    const json = (await run<{ report: { checks: unknown; scan: { fileName: string }; deviation: unknown; thickness: unknown } }>('report.get', { format: 'json' })).report
    expect(json.checks).toEqual({ checked: 1, passed: 1, failed: 0 })
    expect(json.scan.fileName).toBe('balls.stl')
    expect(json.deviation).toBeNull()
    expect(json.thickness).toBeNull()
    expect((await refused('report.get', { format: 'text', workspace: 'deviation' })).code).toBe('invalid_state')
    expect((await refused('report.get', { format: 'pdf' })).code).toBe('invalid_input')
  })

  it('export.step hands back the STEP file’s bytes; the viewport and browser exports say they need them', async () => {
    await openBox()
    expect((await refused('export.step')).code).toBe('invalid_state')
    await fitFace([0, 0, 20])
    const out = await run<{ file: { name: string; mimeType: string; bytes: Uint8Array } }>('export.step')
    expect(out.file.name).toBe('box-elements.step')
    expect(new TextDecoder().decode(out.file.bytes.subarray(0, 13))).toBe('ISO-10303-21;')
    expect((await refused('export.stl')).code).toBe('unavailable')
    expect((await refused('export.cloud')).code).toBe('unavailable')
    expect((await refused('export.svg')).code).toBe('unavailable')
    expect((await refused('project.save')).code).toBe('unavailable')
    expect((await refused('project.load', { bytes: new Uint8Array(1) })).code).toBe('unavailable')
    expect(undoLabels()).toEqual(['Agent: fit plane'])
  })

  it('history.undo and history.redo say when there is nothing to walk', async () => {
    await openBox()
    expect((await refused('history.undo')).code).toBe('invalid_state')
    expect((await refused('history.redo')).code).toBe('invalid_state')
    await fitFace([0, 0, 20])
    const u = await run<{ undone: string; state: { elements: unknown[] } }>('history.undo')
    expect(u).toMatchObject({ undone: 'Agent: fit plane', state: { elements: [] } })
    const r = await run<{ redone: string }>('history.redo')
    expect(r.redone).toBe('Agent: fit plane')
  })

  it('session.reset closes everything — only when told to drop the work', async () => {
    await openBox()
    await fitFace([0, 0, 20])
    expect((await refused('session.reset')).code).toBe('invalid_state')
    const s = await run<{ scan: unknown; elements: unknown[] }>('session.reset', { discard: true })
    expect(s.scan).toBeNull()
    expect(s.elements).toEqual([])
    expect(useStore.getState().busy).toBe(false)
    expect((await refused('element.fit', { kind: 'plane', at: { vertex: 0 } })).code).toBe('no_scan')
  })
})
