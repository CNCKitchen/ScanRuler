// SPDX-License-Identifier: AGPL-3.0-only
// Steps between features: two plan sketches 0.07 mm apart, said at the
// join that makes the step (the build's stepsBetween, worded with the
// pieces traced) and at the sketch that draws the wall again
// (sketchNearMiss); a round drawn twice on nearly one axis; a profile whose
// round starts just off the deck, and one that dips through it; and the
// audit's steps, a line a pair of features, those between features first,
// the hairlines a line of their own.

import { describe, expect, it } from 'vitest'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { auditBody } from '../core/audit'
import { Builder } from '../core/build'
import type { EdgeInfo, FaceInfo, FeatureResult } from '../core/buildTypes'
import type { ExtrudeFeature, Feature, SketchFeature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { addEntity, addRectangle, arcThrough, emptySketch, type Sketch } from '../core/sketch'
import { nearMissFix, sketchNearMisses } from '../core/sketchNearMiss'
import { stepPairs } from '../core/stepsBetween'
import { stepLines, stepsAnswer, stepsWarning, withStepsSaid } from '../core/stepWords'
import { build, extrudeAll, XY } from './reKit'

const kernelPromise = ReKernel.load()

/** A sketch of its own name on a plane level with XY at `z`. */
function plan(id: number, name: string, z: number, draw: (s: Sketch) => void): SketchFeature {
  const sketch = emptySketch()
  draw(sketch)
  return { id, kind: 'sketch', name, plane: { kind: 'world', axis: 'z', offset: z }, frame: { ...XY, origin: [0, 0, z] }, sketch, visible: true }
}

/** The XZ plane: u is Z, v is X; extruded along +Y. */
const XZ: SectionFrame = { origin: [0, 0, 0], normal: [0, 1, 0], basisU: [0, 0, 1], basisV: [1, 0, 0] }

function onXZ(id: number, name: string, draw: (s: Sketch) => void): SketchFeature {
  const sketch = emptySketch()
  draw(sketch)
  return { id, kind: 'sketch', name, plane: { kind: 'world', axis: 'y', offset: 0 }, frame: XZ, sketch, visible: true }
}

const named = (f: ExtrudeFeature, name: string): ExtrudeFeature => ({ ...f, name })

const resultOf = (results: readonly FeatureResult[], id: number) => results.find((r) => r.id === id)!

/** Lengths as the page shows them in millimetres, for stepLines. */
const places = (mm: number, p: number) => String(Math.round(mm * 10 ** p) / 10 ** p)
const SHOW = { len: (mm: number, p: number) => `${places(mm, p)} mm`, bare: places }

/** Two plans 0.07 mm apart: Upper's x 10.91 wall from z 0 to 4.35, Wing's
 *  x 10.98 wall from there to z 5.2 — the same wall, fitted twice. */
function twoPlans(): { features: Feature[]; upper: SketchFeature; wing: SketchFeature } {
  const upper = plan(1, 'Plan upper', 0, (s) => addRectangle(s, [0, 0], [10.91, 8]))
  const wing = plan(3, 'Plan wing', 4.35, (s) => addRectangle(s, [0, 0], [10.98, 8]))
  return { upper, wing, features: [upper, named(extrudeAll(2, upper, 0, 4.35, 'new'), 'Upper'), wing, named(extrudeAll(4, wing, 0, 0.85, 'join'), 'Wing')] }
}

describe('steps between features, said at the join', () => {
  it('says the wall drawn twice in two plans on the join’s row, the pieces traced', async () => {
    const { features } = twoPlans()
    const r = await build(new Builder(await kernelPromise), features)
    expect(resultOf(r.results, 2).stepsBetween).toBeUndefined()
    const steps = resultOf(r.results, 4).stepsBetween!
    expect(steps).toHaveLength(1)
    expect(steps[0].form).toBe('flat')
    expect(steps[0].off).toBeCloseTo(0.07, 6)
    // The join's own face first, then the one it found.
    expect(steps[0].faces.map((f) => f.origin)).toEqual([4, 2])
    // Where: the 0.07 mm strip between the two walls.
    expect(steps[0].at[0]).toBeCloseTo(10.945, 3)
    expect(steps[0].at[2]).toBeCloseTo(4.35, 3)
    const words = stepsWarning(steps, features)
    expect(words).toMatch(/^A step between features: Wing's wall \(x 10\.98, line \d+ of Plan wing\) stands 0\.07 mm off Upper's \(x 10\.91, line \d+ of Plan upper\): one wall drawn twice — fit Plan wing's level into Plan upper \(fit\.level\), or project line (\d+) \(project: \[\{ sketch: "Plan upper", pieces: \[\1\] \}\]\) into Plan wing in its place\.$/)
    // On the row, after what the build warned of; and in the answer.
    const said = withStepsSaid(r.results, features)
    expect(resultOf(said, 4).warning).toBe(words)
    expect(resultOf(said, 4).ownWarning).toBeUndefined()
    expect(resultOf(r.results, 4).warning).toBeUndefined()
    // In the join's box, short, the agent's sentence on hover.
    expect(stepLines(steps, features, SHOW)).toEqual({ lines: [{ text: "Wing's wall stands 0.07 mm off Upper's (x 10.91) — one wall drawn twice.", full: words.replace(/^A step between features: /, '') }], more: 0, hairs: 0 })
    const answer = stepsAnswer(steps, features)
    expect(answer.stepsBetweenFound).toBeUndefined()
    expect(answer.stepsBetween).toEqual([
      expect.objectContaining({ form: 'flat', offMm: 0.07, face: expect.objectContaining({ feature: 'Wing', sketch: 'Plan wing', role: 'wall', place: 'x 10.98' }), other: expect.objectContaining({ feature: 'Upper', sketch: 'Plan upper', role: 'wall', place: 'x 10.91' }) }),
    ])
  })

  it('says nothing where the plans line up', async () => {
    const upper = plan(1, 'Plan upper', 0, (s) => addRectangle(s, [0, 0], [10.91, 8]))
    const wing = plan(3, 'Plan wing', 4.35, (s) => addRectangle(s, [0, 0], [10.91, 8]))
    const features = [upper, named(extrudeAll(2, upper, 0, 4.35, 'new'), 'Upper'), wing, named(extrudeAll(4, wing, 0, 0.85, 'join'), 'Wing')]
    const r = await build(new Builder(await kernelPromise), features)
    expect(resultOf(r.results, 4).stepsBetween).toBeUndefined()
    // A real step, past the net, is the part's.
    const tall = plan(3, 'Plan wing', 4.35, (s) => addRectangle(s, [0, 0], [11.5, 8]))
    const r2 = await build(new Builder(await kernelPromise), [upper, named(extrudeAll(2, upper, 0, 4.35, 'new'), 'Upper'), tall, named(extrudeAll(4, tall, 0, 0.85, 'join'), 'Wing')])
    expect(resultOf(r2.results, 4).stepsBetween).toBeUndefined()
  })

  it('says it of a Combine too: the tool’s faces against the body’s', async () => {
    const { upper, wing } = twoPlans()
    const features: Feature[] = [upper, named(extrudeAll(2, upper, 0, 4.35, 'new'), 'Upper'), wing, named(extrudeAll(4, wing, 0, 0.85, 'new'), 'Wing'), { id: 5, kind: 'boolean', name: 'Combine', op: 'join', body: 2, tool: 4, visible: true } as Feature]
    const r = await build(new Builder(await kernelPromise), features)
    expect(resultOf(r.results, 4).stepsBetween).toBeUndefined()
    const steps = resultOf(r.results, 5).stepsBetween!
    expect(steps).toHaveLength(1)
    expect(steps[0].faces.map((f) => f.origin)).toEqual([4, 2])
    expect(stepsWarning(steps, features)).toMatch(/Wing's wall \(x 10\.98, line \d+ of Plan wing\) stands 0\.07 mm off Upper's/)
  })

  it('says a round drawn twice on nearly one axis', async () => {
    const low = plan(1, 'Plan low', 0, (s) => addEntity(s, { kind: 'circle', c: [0, 0], r: 5 }))
    const high = plan(3, 'Plan high', 5, (s) => addEntity(s, { kind: 'circle', c: [0.01, 0], r: 5.05 }))
    const features = [low, named(extrudeAll(2, low, 0, 5, 'new'), 'Boss low'), high, named(extrudeAll(4, high, 0, 3, 'join'), 'Boss high')]
    const r = await build(new Builder(await kernelPromise), features)
    const steps = resultOf(r.results, 4).stepsBetween!
    const round = steps.find((s) => s.form === 'round')!
    expect(round).toBeDefined()
    expect(round.off).toBeCloseTo(0.06, 4)
    expect(round.radii![0]).toBeCloseTo(5.05, 6)
    expect(round.radii![1]).toBeCloseTo(5, 6)
    expect(round.axisOff).toBeCloseTo(0.01, 6)
    expect(stepsWarning([round], features)).toMatch(/Boss high's round \(R5\.05, circle \d+ of Plan high\) runs 0\.06 mm off Boss low's \(R5, circle \d+ of Plan low\), axes 0\.01 mm apart: one round drawn twice — fit Plan high's level into Plan low \(fit\.level\), or project circle \d+/)
  })

  it('says a round whose profile starts just off the deck, and one that dips through it', async () => {
    const deck = plan(1, 'Deck plan', 0, (s) => addRectangle(s, [0, 0], [20, 10]))
    // The ridge's profile on XZ ([z, x]): up the side at x 2 to z 5.1, an
    // arc over to x 8, down, and back along z 4 inside the deck.
    const ridge = onXZ(3, 'Ridge profile', (s) => {
      const arc = arcThrough([5.1, 2], [5.1, 8], [7, 5])!
      addEntity(s, { kind: 'line', a: [4, 2], b: [5.1, 2] })
      addEntity(s, { kind: 'arc', c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep })
      addEntity(s, { kind: 'line', a: [5.1, 8], b: [4, 8] })
      addEntity(s, { kind: 'line', a: [4, 8], b: [4, 2] })
    })
    const features = [deck, named(extrudeAll(2, deck, 0, 5, 'new'), 'Deck'), ridge, named(extrudeAll(4, ridge, 0, 10, 'join'), 'Ridge')]
    const r = await build(new Builder(await kernelPromise), features)
    const foot = resultOf(r.results, 4).stepsBetween!.find((s) => s.form === 'foot')!
    expect(foot).toBeDefined()
    expect(foot.off).toBeCloseTo(0.1, 6)
    // A round starting off the face at both its ends is one line in the
    // box, with both places.
    const otherEnd = { ...foot, faces: foot.faces.map((f) => (f.kind === 'plane' ? { ...f, centroid: [f.centroid[0], f.centroid[1], 7] as Vec3 } : f)) as typeof foot.faces }
    const both = stepLines([foot, otherEnd], features, SHOW)
    expect(both.lines.map((l) => l.text)).toEqual([expect.stringMatching(/^Ridge \(R[\d.]+\) starts 0\.1 mm off Deck \(z 5, z 7\) — end it on the face, or clearly off it\.$/)])
    expect(both.lines[0].full.split('\n')).toHaveLength(2)
    expect(stepsWarning([foot], features)).toMatch(/^A step between features: Ridge's round \(R[\d.]+, arc \d+ of Ridge profile\) starts 0\.1 mm off Deck's face \(z 5\): a profile that nearly starts on that face — hold its end on the face \(project the face’s edge into Ridge profile and put the end on it\), or let it start clearly off it\.$/)

    // A rod lying on the deck, R2, its axis 1.95 above the top: it dips
    // 0.05 mm through it, meeting it at 12.8° where it was meant to touch.
    const rod = onXZ(3, 'Rod profile', (s) => addEntity(s, { kind: 'circle', c: [6.95, 10], r: 2 }))
    const withRod = [deck, named(extrudeAll(2, deck, 0, 5, 'new'), 'Deck'), rod, named(extrudeAll(4, rod, 2, 8, 'join'), 'Rod')]
    const r2 = await build(new Builder(await kernelPromise), withRod)
    const tangent = resultOf(r2.results, 4).stepsBetween!.find((s) => s.form === 'tangent')!
    expect(tangent).toBeDefined()
    expect(tangent.off).toBeCloseTo(0.05, 6)
    expect(tangent.creaseDeg).toBeCloseTo((Math.acos(1.95 / 2) * 180) / Math.PI, 3)
    expect(stepsWarning([tangent], withRod)).toMatch(/Rod's round \(R2, circle \d+ of Rod profile\) dips 0\.05 mm through Deck's face \(z 5\), meeting it at 12\.8°: a round meant to touch that face/)
  })
})

describe('near misses between sketches, at the sketch', () => {
  it('names the wall the second plan draws 0.07 mm off the first’s, and the fix', () => {
    const { upper, wing } = twoPlans()
    const { misses, found } = sketchNearMisses(wing, [upper, wing])
    const x = (s: SketchFeature, at: number) => s.sketch.entities.find((e) => e.kind === 'line' && Math.abs(e.a[0] - at) < 1e-9 && Math.abs(e.b[0] - at) < 1e-9)!.id
    expect(found).toBe(1)
    expect(misses).toEqual([{ piece: x(wing, 10.98), sketch: 'Plan upper', other: x(upper, 10.91), offMm: 0.07 }])
    const fix = nearMissFix(wing, misses, [upper, wing])
    expect(fix).toContain(`remove: { pieces: [${x(wing, 10.98)}] }, add: { project: [{ sketch: "Plan upper", pieces: [${x(upper, 10.91)}] }] }`)
    expect(fix).toContain('reverse.sketch.edit { sketch: "Plan upper", add: { fit: { level: 4.35 } } }')
    // The first plan, made first, has no other to miss; lined up, none.
    expect(sketchNearMisses(upper, [upper]).found).toBe(0)
    const lined = plan(3, 'Plan wing', 4.35, (s) => addRectangle(s, [0, 0], [10.91, 8]))
    expect(sketchNearMisses(lined, [upper, lined]).found).toBe(0)
    // A plane that is not parallel is not compared.
    const side: SketchFeature = { ...wing, frame: XZ }
    expect(sketchNearMisses(side, [upper, side]).found).toBe(0)
  })

  it('compares only planes the extrudes can bring together', () => {
    // Upper extruded 0 to 4.35 meets the wing's plane at 4.35.
    const { upper, wing, features } = twoPlans()
    expect(sketchNearMisses(wing, [upper, wing], features).found).toBe(1)
    // A slot drawn the same on the far end of the part, 117 mm away, with
    // the near one extruded 0.45 out and the far one not extruded yet.
    const slot = (s: Sketch) => addRectangle(s, [0, 0], [10.88, 2.67])
    const near = plan(1, 'Buttons', 0, slot)
    const far = plan(3, 'USB-C', -117.3, (s) => addRectangle(s, [0, 0], [10.9, 2.67]))
    const made: Feature[] = [near, named(extrudeAll(2, near, 0, 0.45, 'join'), 'Buttons out'), far]
    expect(sketchNearMisses(far, [near, far]).found).toBe(1)
    expect(sketchNearMisses(far, [near, far], made).found).toBe(0)
    // With nothing built on it yet, a sketch is its plane alone: 15 mm
    // off, it is not compared — a glass outline just drawn above a barrel
    // extruded ±4.5. Its own extrude, once there, brings it near.
    const close = plan(3, 'Close', -15, (s) => addRectangle(s, [0, 0], [10.9, 2.67]))
    expect(sketchNearMisses(close, [near, close], [near, made[1], close]).found).toBe(0)
    expect(sketchNearMisses(close, [near, close], [near, made[1], close, named(extrudeAll(4, close, 0, 15), 'Close out')]).found).toBe(1)
    // Revolved, it is taken to reach 20 mm.
    const revolve = { id: 4, kind: 'revolve', name: 'Turned', sketchId: 3, visible: true } as unknown as Feature
    expect(sketchNearMisses(close, [near, close], [near, made[1], close, revolve]).found).toBe(1)
  })

  it('names a round drawn twice, and leaves a construction piece out', () => {
    const low = plan(1, 'Plan low', 0, (s) => {
      addEntity(s, { kind: 'circle', c: [0, 0], r: 5 })
      addEntity(s, { kind: 'line', a: [-6, 0.05], b: [6, 0.05], construction: true })
    })
    const high = plan(3, 'Plan high', 5, (s) => {
      addEntity(s, { kind: 'arc', c: [0.01, 0], r: 5.05, start: 0, sweep: Math.PI })
      addEntity(s, { kind: 'line', a: [-6, 0], b: [6, 0] })
    })
    const { misses } = sketchNearMisses(high, [low, high])
    expect(misses).toHaveLength(1)
    expect(misses[0]).toMatchObject({ piece: 1, sketch: 'Plan low', other: 1 })
    expect(misses[0].offMm).toBeCloseTo(0.06, 6)
  })
})

// ---- the audit's steps, on faces written out ---------------------------------------

/** A flat face facing `dir`, `at` along it, with no edges: its extent not
 *  known, it meets every other. */
const flat = (hash: number, origin: number, dir: Vec3, at: number): FaceInfo => ({ hash, fingerprint: { kind: 'plane', centroid: [dir[0] * at, dir[1] * at, dir[2] * at], dir, area: 10, origin } })

describe('the audit’s steps, a line a pair of features', () => {
  it('puts the steps between features first, each pair once with its count and widest, the hairlines a line of their own', () => {
    // Directions 5° apart, so only the faces meant to pair do.
    let k = 0
    const dir = (): Vec3 => {
      const a = (k++ * 5 * Math.PI) / 180
      return [Math.cos(a), Math.sin(a), 0]
    }
    const faces: FaceInfo[] = []
    let hash = 1
    const pair = (a: number, b: number, gap: number) => {
      const d = dir()
      faces.push(flat(hash++, a, d, 20), flat(hash++, b, d, 20 + gap))
    }
    // Within Upper (2): one step of 0.2.
    pair(2, 2, 0.2)
    // Upper (2) and Wing (4): three wall steps, 0.04–0.07.
    pair(2, 4, 0.04)
    pair(2, 4, 0.07)
    pair(4, 2, 0.05)
    // Upper (2) and Nose (6): thirteen hairlines.
    for (let i = 0; i < 13; i++) pair(2, 6, 0.0002 + i * 1e-5)
    const { findings, stepsBetweenFeatures } = auditBody(faces, [], {})
    expect(stepsBetweenFeatures).toBe(16)
    const steps = findings.filter((f) => f.kind === 'step')
    expect(steps.map((f) => [f.between, f.count, f.hair ?? false])).toEqual([
      [[2, 4], 3, false],
      [[2, 6], 13, true],
      [[2, 2], 1, false],
    ])
    expect(steps[0].off).toBe(0.07)
    expect(steps[0].note).toMatch(/^3 steps between the faces of two features, the widest 0\.07 mm: two flat faces of two features facing one way lie 0\.07 mm apart — a wall or a height drawn twice, in two sketches — a step of 0\.07 mm at \([^)]*\): meant\?/)
    expect(steps[1].off).toBeCloseTo(0.00032, 8)
    expect(steps[1].note).toMatch(/^13 hairline steps under 0\.001 mm between the faces of two features, the widest 0\.00032 mm/)
    // A step at the ask is asked about up to half the tolerance.
    expect(steps[2].note).not.toMatch(/meant\?/)
    const asked = auditBody(faces, [], { tolerance: 0.5 }).findings.filter((f) => f.kind === 'step')
    expect(asked[2].note).toMatch(/a step of 0\.2 mm at \([^)]*\): meant\?/)
    // A cap of lines, a line a pair: the hairlines no longer crowd the
    // wall steps out.
    expect(auditBody(faces, [], { limit: 1 }).findings.filter((f) => f.kind === 'step').map((f) => f.between)).toEqual([[2, 4]])
  })

  it('leaves out two faces a step apart that do not meet, and two rounds side by side', () => {
    // Two tops facing up 0.05 apart, 10 mm from each other across: their
    // edges say so.
    const top = (hash: number, origin: number, x0: number, z: number): FaceInfo => ({ hash, fingerprint: { kind: 'plane', centroid: [x0 + 2, 2, z], dir: [0, 0, 1], area: 16, origin } })
    const ring = (hash: number, x0: number, z: number): EdgeInfo[] =>
      [
        [[x0, 0, z], [x0 + 4, 0, z]],
        [[x0 + 4, 0, z], [x0 + 4, 4, z]],
        [[x0 + 4, 4, z], [x0, 4, z]],
        [[x0, 4, z], [x0, 0, z]],
      ].map(([a, b], i) => ({ hash: hash * 100 + i, fingerprint: { kind: 'line', mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z], dir: [1, 0, 0], length: 4, faces: [], origin: 0 }, faces: [hash], ends: [a as Vec3, b as Vec3], endTangents: [[1, 0, 0], [1, 0, 0]], polyline: new Float32Array(0) }))
    const apart = [top(1, 2, 0, 5), top(2, 4, 14, 5.05)]
    expect(stepPairs(apart, [...ring(1, 0, 5), ...ring(2, 14, 5.05)])).toEqual([])
    const beside = [top(1, 2, 0, 5), top(2, 4, 4, 5.05)]
    expect(stepPairs(beside, [...ring(1, 0, 5), ...ring(2, 4, 5.05)])).toHaveLength(1)
    // A boss R5 over z 0–10 and a bore R4.9 over the same: a tube's wall,
    // not a round drawn twice.
    const cyl = (hash: number, origin: number, r: number): FaceInfo => ({ hash, fingerprint: { kind: 'cylinder', centroid: [0, 0, 5], dir: [0, 0, 1], area: 2 * Math.PI * r * 10, radius: r, center: [0, 0, 0], origin } })
    const circle = (hash: number, r: number, z: number): EdgeInfo => ({ hash, fingerprint: { kind: 'circle', mid: [r, 0, z], dir: [0, 0, 1], length: 2 * Math.PI * r, radius: r, faces: [], origin: 0 }, faces: [hash > 100 ? 2 : 1], ends: [[r, 0, z], [r, 0, z]], endTangents: [[0, 1, 0], [0, 1, 0]], polyline: new Float32Array([r, 0, z, 0, r, z, -r, 0, z, 0, -r, z]) })
    const tube = [cyl(1, 2, 5), cyl(2, 4, 4.9)]
    expect(stepPairs(tube, [circle(1, 5, 0), circle(2, 5, 10), circle(101, 4.9, 0), circle(102, 4.9, 10)])).toEqual([])
    // The same two stacked, end to end: one round drawn twice.
    const stacked = [cyl(1, 2, 5), { ...cyl(2, 4, 4.9), fingerprint: { ...cyl(2, 4, 4.9).fingerprint, centroid: [0, 0, 15] as Vec3 } }]
    const found = stepPairs(stacked, [circle(1, 5, 0), circle(2, 5, 10), circle(101, 4.9, 10), circle(102, 4.9, 20)])
    expect(found.map((p) => p.form)).toEqual(['round'])
    expect(found[0].off).toBeCloseTo(0.1, 9)
  })
})
