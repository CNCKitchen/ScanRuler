// SPDX-License-Identifier: AGPL-3.0-only
// Every command of the session, the scan, the 3D Measure workspace and the
// files: its schema refuses what does not fit, it does what its panel does,
// and it is one undo step (or none, for those that start a new history or
// change nothing). On a 40 mm box and a pair of balls, in the in-process
// worker — see commandKit.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sheetPlaneOf, sheetThrough } from '../src/commands/core/section'
import { listCommands } from '../src/commands/registry'
import { parsePlaneName } from '../src/commands/refs'
import { BASE_PLANES } from '../src/core/basePlanes'
import { worldPlaneName } from '../src/core/section/frame'
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
      'session.state', 'session.reset', 'workspace.set', 'scan.open', 'scan.nearest', 'scan.query', 'scan.fit_surface', 'scan.draft',
      'element.fit', 'element.fit_marked', 'element.construct', 'element.rename', 'element.remove', 'element.set_visible',
      'dimension.add', 'dimension.set_limit', 'dimension.set_basic', 'dimension.remove',
      'align.datum', 'align.auto', 'align.symmetry', 'align.clear', 'section.cut', 'section.get',
      'deviation.open_reference', 'deviation.align', 'deviation.measure', 'deviation.set_target', 'deviation.settings', 'deviation.hotspots',
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

  it('scan.draft reads the box’s four sides as walls along Z, square to it', async () => {
    type D = { walls: number; points: number; patches: { draftDeg: number; area: number; facing: Vec3 }[] }
    const r = await run<D>('scan.draft', { pull: [0, 0, 1] })
    expect(r.patches).toHaveLength(4)
    for (const p of r.patches) {
      expect(Math.abs(p.draftDeg)).toBeLessThan(0.2)
      expect(p.area).toBeGreaterThan(1000)
      expect(Math.abs(p.facing[2])).toBeLessThan(1e-3)
    }
    expect((await refused('scan.draft', { pull: [0, 0, 0] })).code).toBe('invalid_input')
  })

  it('scan.fit_surface measures the box’s top as a plane — the simplest that holds — in its own frame', async () => {
    type S = { points: number; frame: { origin: Vec3; normal: Vec3 }; models: Record<string, { rms: number; worst: number; curvature?: { shape: string } }>; best: string }
    const top = await run<S>('scan.fit_surface', { box: { min: [-30, -30, 19.9], max: [30, 30, 20.1] }, normal: { dir: [0, 0, 1] } })
    expect(top.points).toBe(39 * 39)
    expect(top.best).toBe('plane')
    expect(Object.keys(top.models).sort()).toEqual(['bilinear', 'plane', 'quadric'])
    expect(top.models.plane.rms).toBeLessThan(1e-4)
    expect(Math.abs(top.frame.normal[2])).toBeCloseTo(1, 6)
    expect(top.frame.origin[2]).toBeCloseTo(20, 5)
    expect(top.models.quadric.curvature!.shape).toBe('flat')
    const one = await run<S>('scan.fit_surface', { box: { min: [-30, -30, 19.9], max: [30, 30, 20.1] }, model: 'plane' })
    expect(Object.keys(one.models)).toEqual(['plane'])
    expect((one as { best?: string }).best).toBeUndefined()
    expect((await refused('scan.fit_surface', { box: { min: [50, 50, 50], max: [60, 60, 60] } })).code).toBe('invalid_input')
    expect((await refused('scan.fit_surface', {})).code).toBe('invalid_input')
  })

  it('scan.query reads the vertices in a box or a ball, facing a way if asked, thinned to the limit', async () => {
    type Q = { matched: number; returned: number; step: number; bounds: { min: Vec3; max: Vec3 }; centroid: Vec3; meanNormal: Vec3; vertices: number[]; points: Vec3[]; normals: Vec3[] }
    // The top face of the box: a 41 × 41 grid of vertices at z = 20, its
    // rim's normals leaning 45° into the sides — inside the default 30° only
    // the 39 × 39 within the rim face up.
    const top = await run<Q>('scan.query', { box: { min: [-30, -30, 19.9], max: [30, 30, 20.1] }, normal: { dir: [0, 0, 1] } })
    expect(top.matched).toBe(39 * 39)
    expect(top.returned).toBe(top.vertices.length)
    expect(top.step).toBe(2)
    expect(top.returned).toBeGreaterThanOrEqual(700)
    expect(top.returned).toBeLessThanOrEqual(1000)
    expect((await run<Q>('scan.query', { box: { min: [-30, -30, 19.9], max: [30, 30, 20.1] }, normal: { dir: [0, 0, 1], withinDeg: 80 } })).matched).toBe(41 * 41)
    expect(top.centroid[2]).toBeCloseTo(20, 5)
    expect(top.meanNormal[2]).toBeCloseTo(1, 3)
    expect(top.bounds.min[0]).toBeCloseTo(-19, 5)
    expect(top.points).toHaveLength(top.returned)
    expect(top.normals[0][2]).toBeCloseTo(1, 2)
    // Facing the other way, the same box holds nothing of the top face.
    const none = await run<Q>('scan.query', { box: { min: [-30, -30, 19.9], max: [30, 30, 20.1] }, normal: { dir: [0, 0, -1], withinDeg: 10 } })
    expect(none.matched).toBe(0)
    expect(none.points).toEqual([])
    // Every vertex of the box, held to the limit.
    const all = await run<Q>('scan.query', { box: { min: [-21, -21, -21], max: [21, 21, 21] }, limit: 50 })
    expect(all.matched).toBe(useStore.getState().vertexCount)
    expect(all.returned).toBeLessThanOrEqual(50)
    expect(all.step).toBeGreaterThan(1)
    // A ball about a corner: the corner's own vertex and its neighbours on
    // three faces, none further than the radius.
    const corner = await run<Q>('scan.query', { near: { at: [20, 20, 20], radius: 1.5 } })
    expect(corner.returned).toBeGreaterThan(3)
    for (const p of corner.points) expect(Math.hypot(p[0] - 20, p[1] - 20, p[2] - 20)).toBeLessThanOrEqual(1.5 + 1e-6)
    expect(corner.matched).toBe(corner.returned)
    expect((await refused('scan.query', {})).code).toBe('invalid_input')
    expect((await refused('scan.query', { box: { min: [1, 0, 0], max: [0, 1, 1] } })).code).toBe('invalid_input')
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

  it('element.fit holds a sphere’s known diameter, and refuses one on another kind or far off the ball', async () => {
    await run('scan.open', { bytes: BALLS, name: 'balls.stl', discard: true })
    expect((await refused('element.fit', { kind: 'plane', at: { point: [-30, 0, 5] }, knownDiameter: 10 })).code).toBe('invalid_input')
    type Held = El & { fit: { radius: number; held?: { freeDiameter: number; shift: number } }; source: { knownDiameter?: number } }
    const ball = (await run<{ element: Held }>('element.fit', { kind: 'sphere', at: { point: [-30, 0, 5] }, knownDiameter: 10 })).element
    expect(ball.fit.radius).toBe(5)
    expect(ball.fit.held!.freeDiameter).toBeCloseTo(10, 1)
    expect(ball.source.knownDiameter).toBe(10)
    // The element's own: the next new box starts free.
    expect(useStore.getState().settings.knownDiameter).toBeUndefined()
    const free = (await run<{ element: Held }>('element.fit', { kind: 'sphere', at: { point: [30, 0, 5] }, sigma: 2 })).element
    expect(free.fit.held).toBeUndefined()
    expect((await refused('element.fit', { kind: 'sphere', at: { point: [30, 0, 5] }, knownDiameter: 14 })).message).toMatch(/known Ø 14/)
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

  it('answers short — the step, the whole alignment only when it is more, how many elements moved — and whole with detail full', async () => {
    const top = await fitFace([0, 0, 20])
    const first = await run<{ applied: { rotationDeg: number }; appliedAlignment?: unknown; elements: unknown }>('align.datum', { primary: { element: top.id } })
    expect(first.applied.rotationDeg).toBeCloseTo(180, 3)
    expect(first.appliedAlignment).toBeUndefined()
    expect(first.elements).toBe(1)
    const second = await run<{ appliedAlignment?: { rotationDeg: number }; elements: { id: number; fit: unknown }[] }>('align.datum', { origin: { point: [5, 0, 0] }, detail: 'full' })
    expect(second.appliedAlignment?.rotationDeg).toBeCloseTo(180, 3)
    expect(second.elements.map((e) => e.id)).toEqual([top.id])
    expect(second.elements[0].fit).toBeTruthy()
    expect((await run<{ elements: unknown }>('align.clear')).elements).toBe(1)
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
    const auto = await run<{ note?: string; applied: unknown; square: { largest: { axis: string; tiltDeg: number } | null; axes: { axis: string }[] } }>('align.auto', { level: 'largest' })
    expect(auto.note).toMatch(/Read off the scan/)
    // How square it came out: a box's faces all square, the largest exactly.
    expect(auto.note).toMatch(/Squared to its largest face/)
    expect(auto.square.largest!.tiltDeg).toBeLessThan(0.01)
    expect(auto.square.axes.map((a) => a.axis).sort()).toEqual(['x', 'y', 'z'])
    expect(useStore.getState().alignDraft).toBeNull()
    const sym = await run<{ note?: string }>('align.symmetry')
    expect(sym.note).toMatch(/Settled on/)
    expect(undoLabels()).toEqual(['Agent: auto-align', 'Agent: symmetry alignment'])
    await undo()
    await undo()
    expect(useStore.getState().appliedAlignment).toBeNull()
  })
})

describe('coordinate planes by name', () => {
  it('reads every spelling of one as the axis it is square to, and nothing else', () => {
    expect(['XY', 'xy', ' YX plane', 'XY Plane'].map(parsePlaneName)).toEqual(['z', 'z', 'z', 'z'])
    expect(['YZ', 'zy', 'yz plane'].map(parsePlaneName)).toEqual(['x', 'x', 'x'])
    expect(['ZX', 'XZ', 'xz plane', 'ZX plane', 'xz_plane'].map(parsePlaneName)).toEqual(['y', 'y', 'y', 'y', 'y'])
    expect(['XX', 'X', 'XYZ', 'Plane 1', 'plane', ''].map(parsePlaneName)).toEqual([null, null, null, null, null, null])
    // The answers' spelling, which each command takes back.
    expect(parsePlaneName(worldPlaneName('y'))).toBe('y')
    expect(BASE_PLANES.map((p) => p.name)).toEqual(['XY plane', 'YZ plane', 'XZ plane'])
  })

  it('element.construct takes one in a plane’s slot: made a plane element once, taken again after', async () => {
    await openBox()
    type Made = { element: El; made?: { id: number; name: string }[] }
    const first = await run<Made>('element.construct', { kind: 'plane', method: 'plane-offset', refs: ['XY'], params: [5] })
    expect(first.made).toHaveLength(1)
    expect(first.made![0].name).toBe('XY plane')
    expect(first.element.fit!.center[2]).toBeCloseTo(5, 6)
    expect(first.element.source.refs).toEqual([first.made![0].id])
    // "zx plane" is the same one as "XZ"; the XY plane made above is taken
    // again, by its own name too.
    const edge = await run<Made>('element.construct', { kind: 'line', method: 'line-plane-plane', refs: ['zx plane', 'XY'] })
    expect(edge.made!.map((m) => m.name)).toEqual(['XZ plane'])
    expect(edge.element.source.refs?.[1]).toBe(first.made![0].id)
    const again = await run<Made>('element.construct', { kind: 'plane', method: 'plane-offset', refs: ['XY plane'], params: [-2] })
    expect(again.made).toBeUndefined()
    expect(useStore.getState().elements.filter((e) => e.name === 'XY plane')).toHaveLength(1)
    // A coordinate plane in a slot that takes no plane is refused, nothing made.
    const before = useStore.getState().elements.length
    expect((await refused('element.construct', { kind: 'point', method: 'point-midpoint', refs: ['YZ', 'YZ'] })).code).toBe('invalid_input')
    expect(useStore.getState().elements).toHaveLength(before)
    // One undo step takes the construction and the plane made for it.
    await undo()
    await undo()
    expect(useStore.getState().elements.some((e) => e.name === 'XZ plane')).toBe(false)
    expect(useStore.getState().elements.some((e) => e.name === 'XY plane')).toBe(true)
  })

  it('element.construct takes a section in a plane’s slot, by name or id, and in no other', async () => {
    await openBox()
    type S = { section: { id: number } }
    const low = (await run<S>('section.cut', { across: 'XY', offset: 2, name: 'Low cut' })).section
    await run<S>('section.cut', { across: 'XY', offset: 8, name: 'High cut' })
    const mid = (await run<{ element: El }>('element.construct', { kind: 'plane', method: 'plane-midplane', refs: [low.id, 'high cut'] })).element
    expect(mid.fit!.center[2]).toBeCloseTo(5, 6)
    expect(mid.source.refs?.[0]).toBe(low.id)
    expect((await refused('element.construct', { kind: 'line', method: 'line-axis', refs: ['Low cut'] })).code).toBe('invalid_input')
  })

  it('section.cut answers a coordinate plane by a name it takes back, and section.render’s plane takes one', async () => {
    await openBox()
    type S = { section: { id: number; across: unknown; plane: { origin: Vec3; normal: Vec3 } } }
    const s = await run<S>('section.cut', { across: 'zx', offset: 1 })
    expect(s.section.across).toBe('XZ plane')
    const back = await run<S>('section.cut', { across: s.section.across as string, offset: 2 })
    expect(back.section.plane.normal.map((v) => v + 0)).toEqual([0, 1, 0])
    expect(back.section.plane.origin[1]).toBeCloseTo(2)
    // The picture's plane: through the part's centre, as section.cut lays
    // it, on a sketch's sheet — u = Z, v = X, zero at the origin's foot.
    useStore.setState({ modelCenter: [1, 2, 3] })
    const { name, frame } = sheetPlaneOf('ZX')
    expect(name).toBe('XZ plane')
    expect(frame.normal).toEqual([0, 1, 0])
    expect(frame.origin.map((v) => v + 0)).toEqual([0, 2, 0])
    expect(frame.basisU).toEqual([0, 0, 1])
    expect(sheetPlaneOf('xy plane').frame.origin.map((v) => v + 0)).toEqual([0, 0, 3])
    expect(() => sheetPlaneOf('XX')).toThrow(/no element named "XX"/)
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

  it('lays a plane cut for a picture alone on a sketch’s sheet: world coordinates on a coordinate plane', async () => {
    await openBox()
    const { sheet, flat } = await sheetThrough([5, 3, 2], [0, 1, 0], 'Cut')
    expect(flat.length).toBeGreaterThan(0)
    // Zero at the world origin's foot, u = Z, v = X — as a section across
    // ZX has them, and a sketch on that plane.
    expect(sheet.origin.map((v) => v + 0)).toEqual([0, 3, 0])
    expect(sheet.basisU).toEqual([0, 0, 1])
    expect(sheet.basisV.map((v) => v + 0)).toEqual([1, 0, 0])
     // Turned Z up for a side view: X across and Z up, still world
    // coordinates, the scan's cut laid on the turned sheet.
    const up = await sheetThrough([5, 3, 2], [0, 1, 0], 'Cut', 'z')
    expect(up.sheet.basisU.map((v) => v + 0)).toEqual([1, 0, 0])
    expect(up.sheet.basisV.map((v) => v + 0)).toEqual([0, 0, 1])
    for (let i = 0; i < flat.length; i += 2) {
      expect(up.flat[i]).toBeCloseTo(flat[i + 1], 4)
      expect(up.flat[i + 1]).toBeCloseTo(flat[i], 4)
    }
    await expect(sheetThrough([0, 0, 0], [0, 0, 1], 'Cut', 'z')).rejects.toThrow(/no way up/)
  })

  it('section.get hands back the chains as polylines, on the sheet and in the world', async () => {
    await openBox()
    const s = await run<{ section: { id: number } }>('section.cut', { across: 'XY', offset: 5, name: 'Mid cut' })
    type G = { section: { id: number; chains: number }; plane: { origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3 }; step: number; chains: { index: number; closed: boolean; points: number; kept: number; length: number; bounds: { min: [number, number]; max: [number, number] }; sheet?: [number, number][]; world?: Vec3[] }[] }
    const got = await run<G>('section.get', { section: 'Mid cut', space: 'both' })
    expect(got.section.id).toBe(s.section.id)
    expect(got.chains).toHaveLength(got.section.chains)
    expect(got.step).toBe(1)
    const ring = got.chains[0]
    expect(ring.closed).toBe(true)
    expect(ring.kept).toBe(ring.points)
    // The box's outline at z = 5: a 40 mm square.
    expect(ring.length).toBeCloseTo(160, 1)
    expect(ring.bounds.min[0]).toBeCloseTo(-20, 3)
    expect(ring.bounds.max[1]).toBeCloseTo(20, 3)
    expect(ring.sheet).toHaveLength(ring.points)
    expect(ring.world).toHaveLength(ring.points)
    for (const p of ring.world!) expect(p[2]).toBeCloseTo(5, 4)
    // A sheet point is origin + u·basisU + v·basisV.
    const [u, v] = ring.sheet![0]
    const o = got.plane.origin
    const expected = [0, 1, 2].map((k) => o[k] + u * got.plane.basisU[k] + v * got.plane.basisV[k])
    for (let k = 0; k < 3; k++) expect(ring.world![0][k]).toBeCloseTo(expected[k], 3)
    // Thinned to a limit, the ends stay.
    const few = await run<G>('section.get', { section: s.section.id, limit: 10 })
    expect(few.step).toBeGreaterThan(1)
    expect(few.chains[0].kept).toBeLessThanOrEqual(11)
    expect(few.chains[0].sheet![few.chains[0].kept - 1]).toEqual(ring.sheet![ring.points - 1])
    expect(few.chains[0].world).toBeUndefined()
    expect((await refused('section.get', { section: 'Nowhere' })).code).toBe('not_found')
    expect((await refused('section.get', { section: s.section.id, chains: [9] })).code).toBe('not_found')
    expect(useHistory.getState().past).toHaveLength(1)
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
    const u = await run<{ undone: string; state: { elements: unknown[] } }>('history.undo', { detail: 'full' })
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

  it('session.reset says so when starting over fails', async () => {
    await openBox()
    const client = headless.session.clientRef.current!
    const commitImport = client.commitImport
    client.commitImport = async () => { throw new Error('worker gone') }
    try {
      const error = await refused('session.reset', { discard: true })
      expect(error.code).toBe('failed')
      expect(error.message).toMatch(/worker gone/)
    } finally { client.commitImport = commitImport }
  })
})
