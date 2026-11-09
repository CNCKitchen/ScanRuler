// SPDX-License-Identifier: AGPL-3.0-only
// A snapped face moved by an edit of what made it: the extrude's distance
// for a cap, the sketch's line for a wall, its circle for a bore — and
// through the kernel, a filleted block whose wall moves with its rounds,
// which moving the face on the body cannot do.

import { describe, expect, it } from 'vitest'
import { Builder } from '../core/build'
import { type ExtrudeFeature, type Feature, type SketchFeature } from '../core/features'
import { resolveFeatures } from '../core/resolve'
import { ReKernel } from '../core/kernel'
import { findRegions } from '../core/regions'
import { addConstraint, addEntity, addRectangle, emptySketch, type Sketch } from '../core/sketch'
import { planMoves, planSnap } from '../core/snapEdit'
import type { FaceFingerprint } from '../core/topo'
import type { SectionFrame } from '../../../src/core/section/frame'
import { XY } from './reKit'

function block(): { sketch: SketchFeature; extrude: ExtrudeFeature } {
  const s = emptySketch()
  addRectangle(s, [0, 0], [40, 20])
  addEntity(s, { kind: 'circle', c: [10, 10], r: 3 })
  const sketch: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: s, visible: true }
  // The rectangle less the circle: the largest region, its hole unpicked.
  const outer = findRegions(s).reduce((a, b) => (b.area > a.area ? b : a))
  const extrude: ExtrudeFeature = { id: 2, kind: 'extrude', name: 'Extrude 1', sketchId: 1, regions: [outer.key], extent: { kind: 'distance', from: 0, to: 10 }, op: 'new', visible: true }
  return { sketch, extrude }
}

const plane = (centroid: [number, number, number], dir: [number, number, number], origin = 2): FaceFingerprint => ({ kind: 'plane', centroid, dir, area: 100, origin })

describe('a snapped face as an edit of what made it', () => {
  it('moves a cap by the extrude’s distance, whichever end and whichever way it faces', () => {
    const { sketch, extrude } = block()
    const top = planSnap([sketch, extrude], plane([20, 10, 10], [0, 0, 1]), 2)
    expect(top.route).toBe('extent')
    if (top.route === 'direct') throw new Error(top.why)
    const e = top.features[1] as ExtrudeFeature
    expect(e.extent).toEqual({ kind: 'distance', from: 0, to: 12 })
    expect(top.text).toMatch(/To 10 → 12 mm/)
    // The bottom faces −Z: out is down, and it is the From that moves.
    const bottom = planSnap([sketch, extrude], plane([20, 10, 0], [0, 0, -1]), 1.5)
    if (bottom.route === 'direct') throw new Error(bottom.why)
    expect((bottom.features[1] as ExtrudeFeature).extent).toEqual({ kind: 'distance', from: -1.5, to: 10 })
    // A symmetric extrude stops being one.
    const sym: ExtrudeFeature = { ...extrude, extent: { kind: 'symmetric', total: 10 } }
    const half = planSnap([sketch, sym], plane([20, 10, 5], [0, 0, 1]), -1)
    if (half.route === 'direct') throw new Error(half.why)
    expect((half.features[1] as ExtrudeFeature).extent).toEqual({ kind: 'distance', from: -5, to: 4 })
  })

  it('lets go of the expression of what it moved, so the next parameter pass keeps the move (issue 34)', () => {
    const { sketch, extrude } = block()
    const linked: ExtrudeFeature = { ...extrude, exprs: { 'extent.to': 'height', 'extent.from': 'floor' } }
    const top = planSnap([sketch, linked], plane([20, 10, 10], [0, 0, 1]), 2)
    if (top.route === 'direct') throw new Error(top.why)
    // The To moved; the From's expression stays.
    expect((top.features[1] as ExtrudeFeature).exprs).toEqual({ 'extent.from': 'floor' })
    // A typed radius with an expression: the value moves, the expression goes.
    const typed = block()
    const id = typed.sketch.sketch.entities.find((e) => e.kind === 'circle')!.id
    addConstraint(typed.sketch.sketch, { kind: 'radius', entity: id, value: 3, expr: 'boreR' })
    const bore: FaceFingerprint = { kind: 'cylinder', centroid: [10, 10, 5], dir: [0, 0, 1], area: 188, radius: 3, center: [10, 10, 5], origin: 2 }
    const resized = planSnap([typed.sketch, typed.extrude], bore, 0.4)
    if (resized.route === 'direct') throw new Error(resized.why)
    const c = (resized.features[0] as SketchFeature).sketch.constraints.find((x) => x.kind === 'radius') as { value: number; expr?: string }
    expect(c.value).toBeCloseTo(3.4, 6)
    expect(c.expr).toBeUndefined()
  })

  it('moves several faces as one edit: both ends of an extrude, or all of them on the body when one does not trace', () => {
    const { sketch, extrude } = block()
    const ends = planMoves([sketch, extrude], [plane([20, 10, 10], [0, 0, 1]), plane([20, 10, 0], [0, 0, -1])], 1)
    if (ends.route === 'direct') throw new Error(ends.why)
    expect((ends.features[1] as ExtrudeFeature).extent).toEqual({ kind: 'distance', from: -1, to: 11 })
    expect(ends.text).toMatch(/To 10 → 11 mm.*From 0 → -1 mm/)
    // One face made by something else: no half measures, all on the body.
    const mixed = planMoves([sketch, extrude], [plane([20, 10, 10], [0, 0, 1]), plane([20, 10, 0], [0, 0, -1], 99)], 1)
    expect(mixed.route).toBe('direct')
    expect(mixed.route === 'direct' && mixed.why).toMatch(/one of them cannot be traced/)
  })

  it('moves a wall by its sketch line, the corners following and the pick of the profile kept', () => {
    const { sketch, extrude } = block()
    const right = planSnap([sketch, extrude], plane([40, 10, 5], [1, 0, 0]), 0.8)
    if (right.route === 'direct') throw new Error(right.why)
    expect(right.route).toBe('sketch')
    const s = (right.features[0] as SketchFeature).sketch
    const xs = s.entities.flatMap((e) => (e.kind === 'line' ? [e.a[0], e.b[0]] : []))
    expect(Math.max(...xs)).toBeCloseTo(40.8, 6)
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    // Still one closed rectangle with its hole, and the extrude still picks it.
    const regions = findRegions(s)
    const outer = regions.reduce((a, b) => (b.area > a.area ? b : a))
    // The hole's area is its polygon's, a hair over the circle's.
    expect(outer.area).toBeCloseTo(40.8 * 20 - Math.PI * 9, 0)
    expect((right.features[1] as ExtrudeFeature).regions).toEqual([outer.key])
    // The helper the move was solved with is gone again.
    expect(s.entities).toHaveLength(5)
    expect(s.constraints).toHaveLength(sketch.sketch.constraints.length)
    // Inward, the far wall.
    const left = planSnap([sketch, extrude], plane([0, 10, 5], [-1, 0, 0]), -0.5)
    if (left.route === 'direct') throw new Error(left.why)
    const lx = (left.features[0] as SketchFeature).sketch.entities.flatMap((e) => (e.kind === 'line' ? [e.a[0], e.b[0]] : []))
    expect(Math.min(...lx)).toBeCloseTo(0.5, 6)
  })

  it('resizes a bore by its circle, and a typed radius reads the new value', () => {
    const { sketch, extrude } = block()
    const bore: FaceFingerprint = { kind: 'cylinder', centroid: [10, 10, 5], dir: [0, 0, 1], area: 188, radius: 3, center: [10, 10, 5], origin: 2 }
    const plan = planSnap([sketch, extrude], bore, 0.4)
    if (plan.route === 'direct') throw new Error(plan.why)
    const circle = (plan.features[0] as SketchFeature).sketch.entities.find((e) => e.kind === 'circle')
    expect(circle?.kind === 'circle' && circle.r).toBeCloseTo(3.4, 6)
    const typed = block()
    const id = typed.sketch.sketch.entities.find((e) => e.kind === 'circle')!.id
    addConstraint(typed.sketch.sketch, { kind: 'radius', entity: id, value: 3 })
    const again = planSnap([typed.sketch, typed.extrude], bore, 0.4)
    if (again.route === 'direct') throw new Error(again.why)
    const c = (again.features[0] as SketchFeature).sketch.constraints.find((x) => x.kind === 'radius')
    expect(c?.kind === 'radius' && c.value).toBeCloseTo(3.4, 6)
  })

  it('traces a revolve’s faces to its section: a shoulder to the line square to the axis, a bore or a rim to the line along it', () => {
    // A stepped ring turned about Z, its section on the ZX plane: u is the
    // radius, v the height. Bore at r = 10, rim at r = 30 up to z = 8, a hub
    // at r = 18 up to z = 20.
    const ZX: SectionFrame = { origin: [0, 0, 0], normal: [0, -1, 0], basisU: [1, 0, 0], basisV: [0, 0, 1] }
    const s = emptySketch()
    const outline: [number, number][] = [[10, 0], [30, 0], [30, 8], [18, 8], [18, 20], [10, 20]]
    const ids = outline.map((a, i) => addEntity(s, { kind: 'line', a, b: outline[(i + 1) % outline.length] }))
    for (let i = 0; i < ids.length; i++) addConstraint(s, { kind: 'coincident', p: { entity: ids[i], at: 'b' }, q: { entity: ids[(i + 1) % ids.length], at: 'a' } })
    const sketch: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'y', offset: 0 }, frame: ZX, sketch: s, visible: true }
    const revolve: Feature = { id: 2, kind: 'revolve', name: 'Revolve 1', sketchId: 1, regions: findRegions(s).map((r) => r.key), axis: { kind: 'world', axis: 'z' }, angleDeg: 360, op: 'new', visible: true }
    const lineAt = (f: Feature[], pick: (a: [number, number], b: [number, number]) => boolean) =>
      (f[0] as SketchFeature).sketch.entities.find((e) => e.kind === 'line' && pick(e.a as [number, number], e.b as [number, number])) as { a: [number, number]; b: [number, number] } | undefined

    // The shoulder at z = 8 — a ring between r = 18 and 30, facing up — is
    // 0.6 mm too low: its line goes up, and the rim and the hub follow.
    const shoulder = planSnap([sketch, revolve], { kind: 'plane', centroid: [0, 0, 8], dir: [0, 0, 1], area: 1800, origin: 2 }, 0.6)
    if (shoulder.route === 'direct') throw new Error(shoulder.why)
    expect(shoulder.route).toBe('sketch')
    const up = lineAt(shoulder.features, (a, b) => Math.abs(a[1] - b[1]) < 1e-6 && Math.min(a[0], b[0]) > 17 && Math.max(a[0], b[0]) < 31)!
    expect(up.a[1]).toBeCloseTo(8.6, 6)
    expect(Math.min(up.a[0], up.b[0])).toBeCloseTo(18, 6)
    expect(shoulder.text).toMatch(/Sketch 1/)

    // The rim, a cylinder of R 30 about Z, reads 30.4 on the scan: the line
    // along the axis at u = 30 moves out.
    const rim = planSnap([sketch, revolve], { kind: 'cylinder', centroid: [0, 0, 4], dir: [0, 0, 1], area: 1500, radius: 30, center: [0, 0, 4], origin: 2 }, 0.4)
    if (rim.route === 'direct') throw new Error(rim.why)
    const out = lineAt(rim.features, (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && a[0] > 29)!
    expect(out.a[0]).toBeCloseTo(30.4, 6)
    expect(rim.text).toMatch(/radius 30 → 30.4 mm/)
    // The bore grows the same way: its line moves away from the axis.
    const bore = planSnap([sketch, revolve], { kind: 'cylinder', centroid: [0, 0, 10], dir: [0, 0, 1], area: 1200, radius: 10, center: [0, 0, 10], origin: 2 }, 0.25)
    if (bore.route === 'direct') throw new Error(bore.why)
    expect(lineAt(bore.features, (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && a[0] < 11)!.a[0]).toBeCloseTo(10.25, 6)
    // The hub and the rim are both cylinders about Z; each finds its own line.
    const hub = planSnap([sketch, revolve], { kind: 'cylinder', centroid: [0, 0, 14], dir: [0, 0, 1], area: 1300, radius: 18, center: [0, 0, 14], origin: 2 }, -0.5)
    if (hub.route === 'direct') throw new Error(hub.why)
    expect(lineAt(hub.features, (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[0] - 17.5) < 1e-3)).toBeDefined()
    // The pick of the profile is kept through the edit.
    expect((rim.features[1] as { regions: string[] }).regions).toHaveLength(1)

    // What does not trace: the flat end of a part turn, and a cone.
    const half: Feature = { ...revolve, angleDeg: 180 }
    expect(planSnap([sketch, half], { kind: 'plane', centroid: [20, 0, 4], dir: [0, -1, 0], area: 300, origin: 2 }, 1)).toMatchObject({ route: 'direct' })
    const cone = planSnap([sketch, revolve], { kind: 'cone', centroid: [0, 0, 4], dir: [0, 0, 1], area: 900, origin: 2 }, 1)
    expect(cone.route === 'direct' && cone.why).toMatch(/cone|leans/)
  })

  it('says why when the move has to be made on the body', () => {
    const { sketch, extrude } = block()
    // A wall held by a dimension across the block.
    const held = block()
    const lines = held.sketch.sketch.entities.filter((e) => e.kind === 'line')
    const leftLine = lines.find((e) => e.kind === 'line' && Math.abs(e.a[0]) < 1e-9 && Math.abs(e.b[0]) < 1e-9)!
    const rightLine = lines.find((e) => e.kind === 'line' && Math.abs(e.a[0] - 40) < 1e-9 && Math.abs(e.b[0] - 40) < 1e-9)!
    held.sketch.sketch.entities = held.sketch.sketch.entities.map((e) => (e.id === leftLine.id ? { ...e, fixed: true } : e))
    addConstraint(held.sketch.sketch, { kind: 'distance', p: { entity: rightLine.id, at: 'a' }, q: { line: leftLine.id }, value: 40 })
    const stuck = planSnap([held.sketch, held.extrude], plane([40, 10, 5], [1, 0, 0]), 0.8)
    expect(stuck.route === 'direct' && stuck.why).toMatch(/holds it where it is/)
    // A face a fillet made, a drafted extrude's wall, a face no line is under.
    expect(planSnap([sketch, extrude, { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [], radius: 1, chain: true, visible: true }], plane([0, 0, 0], [1, 0, 0], 3), 1)).toMatchObject({ route: 'direct' })
    expect(planSnap([sketch, { ...extrude, draftDeg: 3 }], plane([40, 10, 5], [1, 0, 0]), 1)).toMatchObject({ route: 'direct' })
    expect(planSnap([sketch, extrude], plane([25, 10, 5], [1, 0, 0]), 1)).toMatchObject({ route: 'direct' })
    expect(planSnap([sketch, { ...extrude, extent: { kind: 'toPlane', from: 0, plane: { kind: 'world', axis: 'z', offset: 10 } } }], plane([20, 10, 10], [0, 0, 1]), 1)).toMatchObject({ route: 'direct' })
  })

  it('leaves the sketch alone where the moved line would run into another profile', () => {
    // Two blocks apart in one sketch, extruded together: the smaller one's
    // near wall pushed 4 mm into the larger would make the overlap a region
    // no extrude picked — a hole where the two meet.
    const s = emptySketch()
    addRectangle(s, [0, 0], [20, 10])
    addRectangle(s, [22, 0], [32, 10])
    const two: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: s, visible: true }
    const both: ExtrudeFeature = { id: 2, kind: 'extrude', name: 'Extrude 1', sketchId: 1, regions: findRegions(s).map((r) => r.key), extent: { kind: 'distance', from: 0, to: 10 }, op: 'new', visible: true }
    const into = planSnap([two, both], plane([22, 5, 5], [-1, 0, 0]), 4)
    expect(into.route === 'direct' && into.why).toMatch(/run a profile of Sketch 1 into another/)
    // Short of the other block, the line moves.
    expect(planSnap([two, both], plane([22, 5, 5], [-1, 0, 0]), 1).route).toBe('sketch')
  })

  it('carries a filleted block’s rounds with the wall — the body a direct move leaves in pieces', async () => {
    const kernel = await ReKernel.load()
    const builder = new Builder(kernel)
    const build = (features: Feature[]) => {
      const steps = resolveFeatures(features, { sections: [], elements: [], modelCenter: [0, 0, 0] }, (f) => findRegions(f.sketch))
      const sketches = new Map<number, Sketch>(features.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
      return builder.build(steps, (id) => sketches.get(id))
    }
    const s = emptySketch()
    addRectangle(s, [0, 0], [40, 20])
    const sketch: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: s, visible: true }
    const extrude: ExtrudeFeature = { id: 2, kind: 'extrude', name: 'Extrude 1', sketchId: 1, regions: findRegions(s).map((r) => r.key), extent: { kind: 'distance', from: 0, to: 10 }, op: 'new', visible: true }
    const plain = build([sketch, extrude])
    const edge = plain.bodies[0].topology.edges.find((e) => e.fingerprint.kind === 'line' && Math.abs(e.fingerprint.mid[0] - 40) < 1e-6 && Math.abs(e.fingerprint.mid[2] - 10) < 1e-6)!.fingerprint
    const fillet: Feature = { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [edge], radius: 2, chain: true, visible: true }
    const rounded = build([sketch, extrude, fillet])
    const volume = rounded.bodies[0].volume
    // The right wall of the rounded block, as the viewport would hand it over.
    const wall = rounded.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[0] > 0.9)!.fingerprint
    expect(wall.origin).toBe(2)
    const plan = planSnap([sketch, extrude, fillet], wall, 1)
    if (plan.route === 'direct') throw new Error(plan.why)
    const moved = build(plan.features)
    expect(moved.results.every((r) => r.status === 'ok')).toBe(true)
    // One millimetre more of the same rounded section, all along.
    expect(moved.bodies[0].volume).toBeCloseTo(volume + 1 * 20 * 10, 3)
    expect(moved.bodies[0].faces).toBe(rounded.bodies[0].faces)
    builder.dispose()
  })

  it('moves a revolved ring’s rim and its top through the kernel: the faces as the body hands them over', async () => {
    const kernel = await ReKernel.load()
    const builder = new Builder(kernel)
    const build = (features: Feature[]) => {
      const steps = resolveFeatures(features, { sections: [], elements: [], modelCenter: [0, 0, 0] }, (f) => findRegions(f.sketch))
      const sketches = new Map<number, Sketch>(features.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
      return builder.build(steps, (id) => sketches.get(id))
    }
    // A ring from r = 10 to 30, 8 high, turned about Z from its section.
    const ZX: SectionFrame = { origin: [0, 0, 0], normal: [0, -1, 0], basisU: [1, 0, 0], basisV: [0, 0, 1] }
    const s = emptySketch()
    addRectangle(s, [10, 0], [30, 8])
    const sketch: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'y', offset: 0 }, frame: ZX, sketch: s, visible: true }
    const revolve: Feature = { id: 2, kind: 'revolve', name: 'Revolve 1', sketchId: 1, regions: findRegions(s).map((r) => r.key), axis: { kind: 'world', axis: 'z' }, angleDeg: 360, op: 'new', visible: true }
    const ring = build([sketch, revolve])
    expect(ring.bodies[0].volume).toBeCloseTo(Math.PI * (900 - 100) * 8, 2)
    const faces = ring.bodies[0].topology.faces.map((f) => f.fingerprint)
    const rim = faces.find((f) => f.kind === 'cylinder' && Math.abs((f.radius ?? 0) - 30) < 1e-6)!
    expect(rim.origin).toBe(2)
    const wider = planSnap([sketch, revolve], rim, 0.5)
    if (wider.route === 'direct') throw new Error(wider.why)
    expect(build(wider.features).bodies[0].volume).toBeCloseTo(Math.PI * (30.5 ** 2 - 100) * 8, 2)
    const top = faces.find((f) => f.kind === 'plane' && f.dir[2] > 0.9)!
    const taller = planSnap([sketch, revolve], top, 1)
    if (taller.route === 'direct') throw new Error(taller.why)
    expect(build(taller.features).bodies[0].volume).toBeCloseTo(Math.PI * 800 * 9, 2)
    // The bore grows into the ring: less of it is left.
    const bore = faces.find((f) => f.kind === 'cylinder' && Math.abs((f.radius ?? 0) - 10) < 1e-6)!
    const bored = planSnap([sketch, revolve], bore, 2)
    if (bored.route === 'direct') throw new Error(bored.why)
    expect(build(bored.features).bodies[0].volume).toBeCloseTo(Math.PI * (900 - 144) * 8, 2)
    builder.dispose()
  })
})
