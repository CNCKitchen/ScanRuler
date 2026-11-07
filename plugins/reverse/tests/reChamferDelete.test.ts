// SPDX-License-Identifier: AGPL-3.0-only
// A chamfer by two distances or by a distance and an angle, its reference
// face the one the edges share or, flipped, the other; faces deleted and
// healed over — a round, a bore, a blind hole, every round of a block — with
// what one click on a face takes; and the boxes of all three at the store,
// a fillet's edges at a varying radius among them.

import { beforeEach, describe, expect, it } from 'vitest'
import { Builder, type BuiltBody, type EdgeInfo, type FaceInfo } from '../core/build'
import { angledAsk, faceAngle, referenceFaces } from '../core/chamferSides'
import { deleteFaceGroup, edgeJoins } from '../core/faceGroup'
import type { Feature, SketchFeature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { addEntity, emptySketch } from '../core/sketch'
import { featureDraftReady, featureOfDraft, filletModeSwitch, useReverse } from '../state/reStore'
import { build, extrudeAll, rectangleSketch, XY } from './reKit'

const kernelPromise = ReKernel.load()

/** A block 10 on a side, from the origin. */
const block = () => {
  const s = rectangleSketch(1, 10, 10)
  return [s, extrudeAll(2, s, 0, 10)] as Feature[]
}

const plane = (b: BuiltBody, dir: [number, number, number]) => b.topology.faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir.every((v, i) => Math.abs(v - dir[i]) < 1e-6))!
const topEdges = (b: BuiltBody) => b.topology.edges.filter((e) => e.fingerprint.kind === 'line' && Math.abs(e.fingerprint.mid[2] - 10) < 1e-6)
const frontTop = (b: BuiltBody) => topEdges(b).find((e) => Math.abs(e.fingerprint.mid[1]) < 1e-6)!

describe('the sides of a chamfer', () => {
  it('reads the angle the faces meet at off their normals, for an edge out of the body and one into it', () => {
    expect((faceAngle([[0, 0, 1], [1, 0, 0]]) * 180) / Math.PI).toBeCloseTo(90, 9)
    // A hexagon's edge: the normals 60° apart.
    expect((faceAngle([[1, 0, 0], [0.5, Math.sqrt(3) / 2, 0]]) * 180) / Math.PI).toBeCloseTo(120, 9)
  })

  it('asks the kernel, measuring from its first face, for the chamfer wanted on the reference face', () => {
    const square: [[number, number, number], [number, number, number]] = [[0, 0, 1], [0, -1, 0]]
    const two = { mode: 'twoDistances' as const, distance: 1, distance2: 2 }
    expect(angledAsk(two, true, square)).toEqual({ distance: 1, angleDeg: expect.closeTo((Math.atan(2) * 180) / Math.PI, 9) })
    expect(angledAsk(two, false, square)).toEqual({ distance: 2, angleDeg: expect.closeTo((Math.atan(0.5) * 180) / Math.PI, 9) })
    const angled = { mode: 'distanceAngle' as const, distance: 1, angleDeg: 30 }
    expect(angledAsk(angled, true, square)).toEqual({ distance: 1, angleDeg: expect.closeTo(30, 9) })
    // From the other face: its setback tan 30°, its angle what is left.
    const other = angledAsk(angled, false, square) as { distance: number; angleDeg: number }
    expect(other.distance).toBeCloseTo(Math.tan(Math.PI / 6), 9)
    expect(other.angleDeg).toBeCloseTo(60, 9)
    // Sized down for a diagnosis, the distances alike.
    expect((angledAsk(two, false, square, 0.5) as { distance: number }).distance).toBeCloseTo(1, 9)
    // A sharp wedge: the long side's angle on the short one's face is past
    // what the kernel takes.
    const wedge: [[number, number, number], [number, number, number]] = [[0, 1, 0], [Math.sin(Math.PI / 3), -0.5, 0]]
    expect(angledAsk({ mode: 'twoDistances', distance: 1, distance2: 3 }, true, wedge)).toMatch(/under 90°/)
  })

  it('takes the face most of the edges share as their reference, and the other one flipped', () => {
    // A rim: four edges, the top (1) shared by all — whichever the kernel
    // lists first.
    const rim: [number, number][] = [[1, 2], [3, 1], [1, 4], [5, 1]]
    expect(referenceFaces(rim, false)).toEqual([1, 1, 1, 1])
    expect(referenceFaces(rim, true)).toEqual([2, 3, 4, 5])
    // One edge alone: the kernel's first.
    expect(referenceFaces([[7, 8]], false)).toEqual([7])
  })
})

describe('a chamfer by two distances or by a distance and an angle', () => {
  it('cuts one face back by the first distance and the other by the second, and swaps them flipped', async () => {
    const builder = new Builder(await kernelPromise)
    const plain = (await build(builder, block())).bodies[0]
    const edge = frontTop(plain).fingerprint
    const chamfer = (flip: boolean): Feature => ({ id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges: [edge], distance: 1, chain: true, mode: 'twoDistances', distance2: 2, ...(flip ? { flip } : {}), visible: true })
    const once = await build(builder, [...block(), chamfer(false)])
    expect(once.results.at(-1)?.status, once.results.at(-1)?.message).toBe('ok')
    const b = once.bodies[0]
    expect(b.volume).toBeCloseTo(1000 - 0.5 * 1 * 2 * 10, 6)
    const areas = [plane(b, [0, 0, 1]).fingerprint.area, plane(b, [0, -1, 0]).fingerprint.area]
    expect([...areas].sort()).toEqual([expect.closeTo(80, 6), expect.closeTo(90, 6)])
    const flipped = (await build(builder, [...block(), chamfer(true)])).bodies[0]
    expect(plane(flipped, [0, 0, 1]).fingerprint.area).toBeCloseTo(areas[1], 6)
    expect(plane(flipped, [0, -1, 0]).fingerprint.area).toBeCloseTo(areas[0], 6)
    builder.dispose()
  })

  it('chamfers a rim from the top it shares, its corners met as one chamfer', async () => {
    const builder = new Builder(await kernelPromise)
    const plain = (await build(builder, block())).bodies[0]
    const edges = topEdges(plain).map((e) => e.fingerprint)
    expect(edges).toHaveLength(4)
    const out = await build(builder, [...block(), { id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges, distance: 1, chain: false, mode: 'twoDistances', distance2: 2, visible: true }])
    expect(out.results.at(-1)?.status, out.results.at(-1)?.message).toBe('ok')
    const b = out.bodies[0]
    // 1 in from every side on the top, 2 down every side.
    expect(plane(b, [0, 0, 1]).fingerprint.area).toBeCloseTo(8 * 8, 6)
    for (const side of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as [number, number, number][]) expect(plane(b, side).fingerprint.area).toBeCloseTo(10 * 8, 6)
    // The four strips less the corners counted twice: ∫ (40w − 4w²) 2 dw.
    expect(b.volume).toBeCloseTo(1000 - 2 * (20 - 4 / 3), 6)
    builder.dispose()
  })

  it('stands at its angle to the reference face — the top, or each side flipped', async () => {
    const builder = new Builder(await kernelPromise)
    const plain = (await build(builder, block())).bodies[0]
    const edges = topEdges(plain).map((e) => e.fingerprint)
    const at = (flip: boolean): Feature => ({ id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges, distance: 1, chain: false, mode: 'distanceAngle', angleDeg: 30, ...(flip ? { flip } : {}), visible: true })
    const t = Math.tan(Math.PI / 6)
    const onTop = await build(builder, [...block(), at(false)])
    expect(onTop.results.at(-1)?.status, onTop.results.at(-1)?.message).toBe('ok')
    expect(plane(onTop.bodies[0], [0, 0, 1]).fingerprint.area).toBeCloseTo(8 * 8, 6)
    expect(plane(onTop.bodies[0], [1, 0, 0]).fingerprint.area).toBeCloseTo(10 * (10 - t), 6)
    const onSides = await build(builder, [...block(), at(true)])
    expect(onSides.results.at(-1)?.status, onSides.results.at(-1)?.message).toBe('ok')
    expect(plane(onSides.bodies[0], [0, 0, 1]).fingerprint.area).toBeCloseTo((10 - 2 * t) ** 2, 6)
    expect(plane(onSides.bodies[0], [1, 0, 0]).fingerprint.area).toBeCloseTo(10 * 9, 6)
    builder.dispose()
  })

  it('refuses an angle of 90° or more, and a second distance of none', async () => {
    const builder = new Builder(await kernelPromise)
    const edge = frontTop((await build(builder, block())).bodies[0]).fingerprint
    const steep = await build(builder, [...block(), { id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges: [edge], distance: 1, chain: true, mode: 'distanceAngle', angleDeg: 90, visible: true }])
    expect(steep.results.at(-1)?.message).toMatch(/between 0° and 90°/)
    const none = await build(builder, [...block(), { id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges: [edge], distance: 1, chain: true, mode: 'twoDistances', visible: true }])
    expect(none.results.at(-1)?.message).toMatch(/second distance/)
    builder.dispose()
  })
})

/** What a click on a face takes, read off the built body as the panel
 *  reads it. */
const groupAt = (b: BuiltBody, face: FaceInfo, tangent = true): FaceInfo[] => {
  const joins = edgeJoins(b.mesh, b.topology)
  return deleteFaceGroup(b.topology, face.hash, (e) => joins.get(e), tangent).map((h) => b.topology.faces.find((f) => f.hash === h)!)
}

const deleting = (faces: readonly FaceInfo[]): Feature => ({ id: 9, kind: 'deleteFace', name: 'Delete face 1', body: 2, faces: faces.map((f) => f.fingerprint), visible: true })

describe('faces deleted and healed over', () => {
  it('takes a round off a block, the faces either side run on to the corner', async () => {
    const builder = new Builder(await kernelPromise)
    const edge = frontTop((await build(builder, block())).bodies[0]).fingerprint
    const rounded = [...block(), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [edge], radius: 2, chain: true, visible: true } as Feature]
    const r = (await build(builder, rounded)).bodies[0]
    expect(r.volume).toBeLessThan(1000 - 0.5)
    const round = r.topology.faces.find((f) => f.fingerprint.kind === 'cylinder')!
    expect(groupAt(r, round).map((f) => f.hash)).toEqual([round.hash])
    const out = await build(builder, [...rounded, deleting([round])])
    expect(out.results.at(-1)?.status, out.results.at(-1)?.message).toBe('ok')
    expect(out.bodies[0].volume).toBeCloseTo(1000, 6)
    expect(out.bodies[0].faces).toBe(6)
    builder.dispose()
  })

  it('takes a bore off whole from a click on its wall, and a blind hole with its floor', async () => {
    const builder = new Builder(await kernelPromise)
    const holed = (from: number): Feature[] => {
      const pin = emptySketch()
      addEntity(pin, { kind: 'circle', c: [5, 5], r: 2 })
      const bore: SketchFeature = { id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: pin, visible: true }
      return [...block(), bore, extrudeAll(4, bore, from, 11, 'cut', 2)]
    }
    for (const from of [-1, 5]) {
      const b = (await build(builder, holed(from))).bodies[0]
      expect(b.volume).toBeCloseTo(1000 - Math.PI * 4 * (10 - Math.max(0, from)), 3)
      const wall = b.topology.faces.find((f) => f.fingerprint.kind === 'cylinder')!
      const taken = groupAt(b, wall)
      // The whole wall, its halves if it is split; a blind hole's floor.
      expect(taken.filter((f) => f.fingerprint.kind === 'cylinder').length).toBe(b.topology.faces.filter((f) => f.fingerprint.kind === 'cylinder').length)
      expect(taken.some((f) => f.fingerprint.kind === 'plane')).toBe(from > 0)
      const out = await build(builder, [...holed(from), deleting(taken)])
      expect(out.results.at(-1)?.status, out.results.at(-1)?.message).toBe('ok')
      expect(out.bodies[0].volume).toBeCloseTo(1000, 6)
    }
    builder.dispose()
  })

  it('takes a boss off from a click on its wall — the round at its foot and its top with it', async () => {
    const builder = new Builder(await kernelPromise)
    const plate = rectangleSketch(1, 10, 10)
    const pin = emptySketch()
    addEntity(pin, { kind: 'circle', c: [5, 5], r: 2 })
    const boss: SketchFeature = { id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: pin, visible: true }
    const made: Feature[] = [plate, extrudeAll(2, plate, 0, 5), boss, extrudeAll(4, boss, 5, 10, 'join', 2)]
    const foot = (await build(builder, made)).bodies[0].topology.edges.find((e) => e.fingerprint.kind === 'circle' && Math.abs(e.fingerprint.mid[2] - 5) < 1e-6)!
    const rounded = [...made, { id: 5, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [foot.fingerprint], radius: 1, chain: true, visible: true } as Feature]
    const r = (await build(builder, rounded)).bodies[0]
    const wall = r.topology.faces.find((f) => f.fingerprint.kind === 'cylinder')!
    const taken = groupAt(r, wall)
    expect(taken.some((f) => f.fingerprint.kind === 'torus')).toBe(true)
    expect(taken.some((f) => f.fingerprint.kind === 'plane' && Math.abs(f.fingerprint.centroid[2] - 10) < 1e-6)).toBe(true)
    // The plate's top, which the round runs into, stays.
    expect(taken.some((f) => f.fingerprint.kind === 'plane' && Math.abs(f.fingerprint.centroid[2] - 5) < 1e-6)).toBe(false)
    const out = await build(builder, [...rounded, deleting(taken)])
    expect(out.results.at(-1)?.status, out.results.at(-1)?.message).toBe('ok')
    expect(out.bodies[0].volume).toBeCloseTo(500, 6)
    builder.dispose()
  })

  it('takes every round of a block from a click on one, the flats left, and heals the block sharp', async () => {
    const builder = new Builder(await kernelPromise)
    const plain = (await build(builder, block())).bodies[0]
    const all = plain.topology.edges.map((e) => e.fingerprint)
    expect(all).toHaveLength(12)
    const rounded = [...block(), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: all, radius: 1, chain: true, visible: true } as Feature]
    const r = (await build(builder, rounded)).bodies[0]
    const rounds = r.topology.faces.filter((f) => f.fingerprint.kind !== 'plane')
    const one = rounds.find((f) => f.fingerprint.kind === 'cylinder')!
    const taken = groupAt(r, one)
    expect(new Set(taken.map((f) => f.hash))).toEqual(new Set(rounds.map((f) => f.hash)))
    // Off, the click takes the one round.
    expect(groupAt(r, one, false).map((f) => f.hash)).toEqual([one.hash])
    const out = await build(builder, [...rounded, deleting(taken)])
    expect(out.results.at(-1)?.status, out.results.at(-1)?.message).toBe('ok')
    expect(out.bodies[0].volume).toBeCloseTo(1000, 4)
    builder.dispose()
  })

  it('says so when a face cannot be healed over, and names a face that is gone', async () => {
    const builder = new Builder(await kernelPromise)
    const b = (await build(builder, block())).bodies[0]
    const top = plane(b, [0, 0, 1])
    const missing = await build(builder, [...block(), { ...deleting([top]), faces: [{ ...top.fingerprint, centroid: [50, 50, 50] }] } as Feature])
    expect(missing.results.at(-1)?.message).toMatch(/is gone/)
    const none = await build(builder, [...block(), { ...deleting([]), faces: [] } as Feature])
    expect(none.results.at(-1)?.message).toMatch(/Pick the faces/)
    builder.dispose()
  })
})

const edge = (hash: number): EdgeInfo => ({ hash, fingerprint: { kind: 'line', mid: [5, 0, 10], dir: [1, 0, 0], length: 10, faces: [{ kind: 'plane', dir: [0, -1, 0] }, { kind: 'plane', dir: [0, 0, 1] }], origin: 2 }, faces: [], ends: [[0, 0, 10], [10, 0, 10]], endTangents: [[1, 0, 0], [1, 0, 0]], polyline: new Float32Array(0) })
const face = (hash: number, kind: 'plane' | 'cylinder' = 'plane'): FaceInfo => ({ hash, fingerprint: { kind, centroid: [0, 0, hash], dir: [0, 0, 1], area: 10, origin: 2 } })

describe('the boxes at the store', () => {
  beforeEach(() => {
    useReverse.getState().reset()
    useReverse.setState({ bodies: [{ id: 2, name: 'Extrude 1', visible: true, volume: 1, faces: 6, closed: true, triangles: 12 }], nextFeatureId: 3, nextOfKind: {} })
  })

  it('takes edges clicked at a varying radius in Variable, each starting as the last, and carries the picks between the modes', () => {
    const re = useReverse.getState
    re().startFeature('fillet', { body: 2, edges: [edge(11)], radius: 2 })
    let d = re().featureDraft as Extract<NonNullable<ReturnType<typeof re>['featureDraft']>, { kind: 'fillet' }>
    // To Variable: the edge picked goes from the one radius at both ends.
    re().setFeatureDraft(filletModeSwitch(d, 'variable'))
    d = re().featureDraft as typeof d
    expect(d.mode).toBe('variable')
    expect(d.edges).toEqual([])
    expect(d.variable?.map((v) => [v.edge.hash, v.radius])).toEqual([[11, [2, 2]]])
    re().setFeatureDraft({ variable: [{ ...d.variable![0], radius: [1, 3] }] })
    re().toggleDraftEdge(2, edge(12))
    d = re().featureDraft as typeof d
    expect(d.variable?.map((v) => [v.edge.hash, v.radius])).toEqual([[11, [1, 3]], [12, [1, 3]]])
    // A picked one clicked again is let go.
    re().toggleDraftEdge(2, edge(11))
    d = re().featureDraft as typeof d
    expect(d.variable?.map((v) => v.edge.hash)).toEqual([12])
    const f = featureOfDraft(d, 3, 'Fillet 1')
    expect(f).toMatchObject({ kind: 'fillet', edges: [], variable: [{ radius: [1, 3] }] })
    // Not ready with a radius of none at an end.
    expect(featureDraftReady({ ...d, variable: [{ ...d.variable![0], radius: [0, 3] }] })).toBe(false)
    // Back to Constant: the edges at the first one's start radius.
    re().setFeatureDraft(filletModeSwitch(d, 'constant'))
    d = re().featureDraft as typeof d
    expect([d.mode, d.edges.map((e) => e.hash), d.variable, d.radius]).toEqual(['constant', [12], undefined, 1])
    // Committed and reopened on its varying edges alone: Variable.
    re().setFeatureDraft(filletModeSwitch(d, 'variable'))
    expect(re().commitFeature()).toBe(3)
    re().editFeature(3)
    d = re().featureDraft as typeof d
    expect([d.mode, d.variable?.length]).toEqual(['variable', 1])
  })

  it('starts an edge picked where a listed one ends at that one’s radius there', () => {
    const re = useReverse.getState
    const at = (hash: number, a: [number, number, number], b: [number, number, number]): EdgeInfo => ({ ...edge(hash), ends: [a, b] })
    re().startFeature('fillet', { body: 2, edges: [at(11, [0, 0, 10], [10, 0, 10])], radius: 2 })
    let d = re().featureDraft as Extract<NonNullable<ReturnType<typeof re>['featureDraft']>, { kind: 'fillet' }>
    re().setFeatureDraft(filletModeSwitch(d, 'variable'))
    d = re().featureDraft as typeof d
    re().setFeatureDraft({ variable: [{ ...d.variable![0], radius: [1, 3] }] })
    // On from its end, back to its start, and one apart: the radius where
    // each meets a listed edge, at both its ends; the last's apart.
    re().toggleDraftEdge(2, at(12, [10, 0, 10], [10, 10, 10]))
    re().toggleDraftEdge(2, at(13, [0, 10, 10], [0, 0, 10]))
    re().toggleDraftEdge(2, at(14, [50, 0, 0], [60, 0, 0]))
    d = re().featureDraft as typeof d
    expect(d.variable?.map((v) => [v.edge.hash, v.radius])).toEqual([[11, [1, 3]], [12, [3, 3]], [13, [1, 1]], [14, [1, 1]]])
  })

  it('keeps a chamfer’s second number for its mode alone, and flips it only with one', () => {
    const re = useReverse.getState
    re().startFeature('chamfer', { body: 2, edges: [edge(11)] })
    type Chamfer = Extract<NonNullable<ReturnType<typeof re>['featureDraft']>, { kind: 'chamfer' }>
    const d = re().featureDraft as Chamfer
    expect([d.mode, d.angleDeg, d.flip]).toEqual(['equal', 45, false])
    const equal = featureOfDraft({ ...d, flip: true, distance2: 3 }, 3, 'Chamfer 1')!
    expect(equal).not.toHaveProperty('mode')
    expect(equal).not.toHaveProperty('flip')
    expect(equal).not.toHaveProperty('distance2')
    expect(featureOfDraft({ ...d, mode: 'twoDistances', distance2: 3, flip: true }, 3, 'Chamfer 1')).toMatchObject({ mode: 'twoDistances', distance2: 3, flip: true })
    const angled = featureOfDraft({ ...d, mode: 'distanceAngle', angleDeg: 30 }, 3, 'Chamfer 1')!
    expect(angled).toMatchObject({ mode: 'distanceAngle', angleDeg: 30 })
    expect(angled).not.toHaveProperty('distance2')
    expect(featureDraftReady({ ...d, mode: 'distanceAngle', angleDeg: 90 })).toBe(false)
    // Reopened as it was saved.
    re().setFeatureDraft({ mode: 'twoDistances', distance2: 3, flip: true })
    expect(re().commitFeature()).toBe(3)
    re().editFeature(3)
    expect(re().featureDraft).toMatchObject({ mode: 'twoDistances', distance: 1, distance2: 3, flip: true })
  })

  it('takes what a click on a face takes for a delete, and lets all of it go on a second click', () => {
    const re = useReverse.getState
    re().startFeature('deleteFace')
    expect(re().featureDraft).toMatchObject({ kind: 'deleteFace', body: 2, faces: [], tangent: true })
    re().toggleDraftFace(2, face(5, 'cylinder'), [face(5, 'cylinder'), face(6, 'cylinder'), face(7)])
    expect((re().featureDraft as { faces: FaceInfo[] }).faces.map((f) => f.hash)).toEqual([5, 6, 7])
    re().toggleDraftFace(2, face(8))
    expect((re().featureDraft as { faces: FaceInfo[] }).faces.map((f) => f.hash)).toEqual([5, 6, 7, 8])
    re().toggleDraftFace(2, face(6, 'cylinder'), [face(6, 'cylinder'), face(5, 'cylinder'), face(7)])
    expect((re().featureDraft as { faces: FaceInfo[] }).faces.map((f) => f.hash)).toEqual([8])
    expect(featureOfDraft(re().featureDraft!, 3, 'Delete face 1')).toMatchObject({ kind: 'deleteFace', body: 2, faces: [{ centroid: [0, 0, 8] }] })
    expect(re().commitFeature()).toBe(3)
    expect(re().features.at(-1)?.name).toBe('Delete face 1')
  })
})
