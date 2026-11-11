// SPDX-License-Identifier: AGPL-3.0-only
// The features on a body through the kernel: shell, fillet and chamfer on
// picked edges (and along a tangent chain), a hole, an element extracted as
// a body, a cut by a plane, a mirror, a boolean between bodies — each with
// a volume that is known, a lost pick that fails by name, and the body as
// it stood before a feature kept for editing it.

import { describe, expect, it } from 'vitest'
import { Builder } from '../core/build'
import { bodyFacePlane, islandId, frameMap, frameOnFace, moveProfiles, type ExtrudeFeature, type Feature, type ResolveContext, type RevolveFeature, type SketchFeature, type TrimTool } from '../core/features'
import { coordinatePlaneOffers, describePlaneRef, resolveFeatures, resolvePlaneFrame } from '../core/resolve'
import type { FaceFingerprint } from '../core/topo'
import { ReKernel } from '../core/kernel'
import { findRegions } from '../core/regions'
import { addEntity, addRectangle, emptySketch, type Sketch } from '../core/sketch'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { CylinderFit, PlaneFit, SphereFit, TorusFit } from '../../../src/core/types'
import { NominalSurface } from '../../../src/core/deviation/surface'
import { boxMesh } from '../../../tests/helpers'
import { extrudeAll, rectangleSketch, XY } from './reKit'

const kernelPromise = ReKernel.load()
const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }

/** A rounded rectangle: two long sides joined by semicircular ends, whose
 *  top edges form one tangent chain. */
function slotSketch(id: number, length: number, r: number): SketchFeature {
  const sketch = emptySketch()
  const a = addEntity(sketch, { kind: 'line', a: [0, -r], b: [length, -r] })
  const b = addEntity(sketch, { kind: 'arc', c: [length, 0], r, start: -Math.PI / 2, sweep: Math.PI })
  const c = addEntity(sketch, { kind: 'line', a: [length, r], b: [0, r] })
  const d = addEntity(sketch, { kind: 'arc', c: [0, 0], r, start: Math.PI / 2, sweep: Math.PI })
  void a; void b; void c; void d
  return { id, kind: 'sketch', name: `Sketch ${id}`, plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch, visible: true }
}

const ctx = (elements: ResolveContext['elements'] = []): ResolveContext => ({ sections: [], elements, modelCenter: [0, 0, 0] })

async function build(builder: Builder, features: Feature[], c: ResolveContext = ctx()) {
  const steps = resolveFeatures(features, c, (f) => findRegions(f.sketch))
  const sketches = new Map<number, Sketch>(features.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
  return builder.build(steps, (id) => sketches.get(id))
}

const BOX = 40 * 20 * 10

describe('features on a body', () => {
  it('shells a box with its top opened, the wall from the Thickness map', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const top = first.bodies[0].topology.faces.find((f) => f.fingerprint.dir[2] > 0.9)!.fingerprint
    const result = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'shell', name: 'Shell 1', body: 2, faces: [top], thickness: 1.5, visible: true }])
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    const body = result.bodies[0]
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(BOX - 37 * 17 * 8.5, 3)
    expect(body.faces).toBe(11)
    // The inner faces are the shell's, the outer ones still the extrude's.
    const origins = body.topology.faces.map((f) => f.fingerprint.origin)
    expect(origins.filter((o) => o === 3).length).toBe(5)
    expect(origins.filter((o) => o === 2).length).toBe(6)
    builder.dispose()
  })

  it('shells a box closed when no face is opened: a hollow inside', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const result = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'shell', name: 'Shell 1', body: 2, faces: [], thickness: 1.5, visible: true }])
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    const body = result.bodies[0]
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(BOX - 37 * 17 * 7, 3)
    expect(body.faces).toBe(12)
    const origins = body.topology.faces.map((f) => f.fingerprint.origin)
    expect(origins.filter((o) => o === 3).length).toBe(6)
    expect(origins.filter((o) => o === 2).length).toBe(6)
    // A wall as thick as the body leaves nothing inside, and says so.
    const solid = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'shell', name: 'Shell 1', body: 2, faces: [], thickness: 6, visible: true }])
    expect(solid.results[1].status).toBe('failed')
    builder.dispose()
  })

  it('shells past a round no larger than the wall: round outside as modelled, sharp inside, and says so', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const uprights = first.bodies[0].topology.edges.filter((e) => Math.abs(e.fingerprint.dir[2]) > 0.9).map((e) => e.fingerprint)
    expect(uprights).toHaveLength(4)
    const fillet: Feature = { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: uprights, radius: 2, chain: false, visible: true }
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 10), fillet])
    const top = rounded.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[2] > 0.9)!.fingerprint
    const corners = 4 * (1 - Math.PI / 4) * 4 * 10

    // A wall thinner than the round shells the ordinary way, with no note.
    const thin = await build(builder, [s, extrudeAll(2, s, 0, 10), fillet, { id: 4, kind: 'shell', name: 'Shell 1', body: 2, faces: [top], thickness: 1, visible: true }])
    expect(thin.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(thin.results[2].note).toBeUndefined()

    // A wall of 3 on rounds of 2: the inner rounds have no radius left.
    const thick = await build(builder, [s, extrudeAll(2, s, 0, 10), fillet, { id: 4, kind: 'shell', name: 'Shell 1', body: 2, faces: [top], thickness: 3, visible: true }])
    expect(thick.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(thick.results[2].note).toMatch(/4 rounds no larger than the wall/)
    const body = thick.bodies[0]
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(BOX - corners - 34 * 14 * 7, 2)
    // The outer rounds are still the fillet's, the five inner faces the shell's.
    const faces = body.topology.faces.map((f) => f.fingerprint)
    expect(faces.filter((f) => f.kind === 'cylinder' && f.origin === 3)).toHaveLength(4)
    expect(faces.filter((f) => f.origin === 4)).toHaveLength(5)
    expect(faces.filter((f) => f.origin === 4).every((f) => f.kind === 'plane')).toBe(true)

    // Closed, with no face opened, the same way.
    const closed = await build(builder, [s, extrudeAll(2, s, 0, 10), fillet, { id: 4, kind: 'shell', name: 'Shell 1', body: 2, faces: [], thickness: 2, visible: true }])
    expect(closed.results[2]).toMatchObject({ status: 'ok' })
    expect(closed.results[2].note).toMatch(/left sharp/)
    expect(closed.bodies[0].volume).toBeCloseTo(BOX - corners - 36 * 16 * 6, 2)
    builder.dispose()
  })

  it('fillets a picked edge, and a chamfer takes the same edge by its fingerprint after a rebuild', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const topFront = first.bodies[0].topology.edges.find((e) => Math.abs(e.fingerprint.mid[1]) < 1e-6 && e.fingerprint.mid[2] > 9.9)!.fingerprint
    const filleted = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [topFront], radius: 2, chain: false, visible: true }])
    expect(filleted.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    // A fillet of radius r on an edge of length L removes (1 − π/4) r² L.
    expect(filleted.bodies[0].volume).toBeCloseTo(BOX - (1 - Math.PI / 4) * 4 * 40, 3)
    expect(filleted.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'cylinder')!.fingerprint.origin).toBe(3)

    // The box two millimetres longer: the same edge is found again, and a
    // chamfer of 2 mm takes half of what the fillet took... exactly r²L/2.
    const wider = rectangleSketch(1, 42, 20)
    const chamfered = await build(builder, [wider, extrudeAll(2, wider, 0, 10), { id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges: [topFront], distance: 2, chain: false, visible: true }])
    expect(chamfered.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(chamfered.bodies[0].volume).toBeCloseTo(42 * 20 * 10 - 2 * 42, 3)
    builder.dispose()
  })

  it('rounds a wall in full: two edges at half its width are one half round', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 5)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const tops = first.bodies[0].topology.edges.filter((e) => e.fingerprint.kind === 'line' && e.fingerprint.mid[2] > 9.9 && Math.abs(e.fingerprint.dir[0]) > 0.9).map((e) => e.fingerprint)
    expect(tops).toHaveLength(2)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: tops, radius: 2.5, chain: false, visible: true }])
    expect(rounded.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(rounded.results[1].note).toBeUndefined()
    const body = rounded.bodies[0]
    expect(body.closed).toBe(true)
    // The top a half round of 2.5 over 40: the box less 40·(5·2.5 − π·2.5²/2).
    expect(body.volume).toBeCloseTo(40 * 5 * 10 - 40 * (5 * 2.5 - (Math.PI * 2.5 * 2.5) / 2), 3)
    // No sliver of the top left between the rounds: one half-round face,
    // the fillet's, and the walls still the extrude's.
    expect(body.faces).toBe(6)
    const round = body.topology.faces.filter((f) => f.fingerprint.kind === 'cylinder')
    expect(round).toHaveLength(1)
    expect(round[0].fingerprint.origin).toBe(3)
    expect(body.topology.faces.filter((f) => f.fingerprint.kind === 'plane').every((f) => f.fingerprint.origin === 2)).toBe(true)
    builder.dispose()
  })

  it('rounds a bar’s ends in full into a pill, and chamfers a wall in full into a ridge', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 5)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const upright = first.bodies[0].topology.edges.filter((e) => e.fingerprint.kind === 'line' && Math.abs(e.fingerprint.dir[2]) > 0.9).map((e) => e.fingerprint)
    expect(upright).toHaveLength(4)
    const pill = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: upright, radius: 2.5, chain: false, visible: true }])
    // The result names the four edges the round took, as they were.
    expect(pill.results[1]).toMatchObject({ id: 3, status: 'ok' })
    expect(pill.results[1].edges).toHaveLength(4)
    expect(pill.results[1].edges![0]).toMatchObject({ kind: 'line', length: 10 })
    expect(pill.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(pill.bodies[0].volume).toBeCloseTo((35 * 5 + Math.PI * 2.5 * 2.5) * 10, 3)
    expect(pill.results[1].note).toBeUndefined()
    expect(pill.bodies[0].faces).toBe(6)

    const tops = first.bodies[0].topology.edges.filter((e) => e.fingerprint.kind === 'line' && e.fingerprint.mid[2] > 9.9 && Math.abs(e.fingerprint.dir[0]) > 0.9).map((e) => e.fingerprint)
    const ridge = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'chamfer', name: 'Chamfer 1', body: 2, edges: tops, distance: 2.5, chain: false, visible: true }])
    expect(ridge.results[1]).toMatchObject({ id: 3, status: 'ok' })
    expect(ridge.results[1].edges).toHaveLength(2)
    expect(ridge.bodies[0].volume).toBeCloseTo(40 * 5 * 10 - 40 * 2.5 * 2.5, 1)
    expect(ridge.bodies[0].faces).toBe(7)
    builder.dispose()
  })

  it('runs a fillet round the tangent chain of a slot from one side', async () => {
    const builder = new Builder(await kernelPromise)
    const s = slotSketch(1, 30, 5)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    expect(first.results[0].status).toBe('ok')
    const topSide = first.bodies[0].topology.edges.find((e) => e.fingerprint.kind === 'line' && e.fingerprint.mid[2] > 9.9 && e.fingerprint.mid[1] < 0)!.fingerprint
    const chained = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [topSide], radius: 1, chain: true, visible: true }])
    expect(chained.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    // The whole top rim rounded: a strip of cylinder and torus faces.
    const rounded = chained.bodies[0].topology.faces.filter((f) => f.fingerprint.origin === 3)
    expect(rounded.length).toBeGreaterThanOrEqual(4)
    // The rim all the way round: a strip of r · (1 − π/4) off the whole
    // perimeter, 2 · 30 + 2π · 5.
    expect(chained.bodies[0].volume).toBeCloseTo((30 * 10 + Math.PI * 25) * 10 - (1 - Math.PI / 4) * (60 + 2 * Math.PI * 5), 0)
    builder.dispose()
  })

  it('reports a lost edge by name and builds the rest', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const gone = { kind: 'circle' as const, mid: [7, 10, 10] as [number, number, number], dir: [0, 0, 1] as [number, number, number], length: 18.85, radius: 3, faces: [], origin: 9 }
    const result = await build(builder, [
      s,
      extrudeAll(2, s, 0, 10),
      { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [gone], radius: 1, chain: false, visible: true },
      { id: 4, kind: 'cutPlane', name: 'Cut 1', body: 2, plane: { kind: 'world', axis: 'x', offset: 20 }, keep: -1, visible: true },
    ])
    expect(result.results[1]).toEqual({ id: 3, status: 'failed', message: 'The edge this fillet was on is gone (was: circle Ø6.0 at (7.0, 10.0, 10.0)).' })
    expect(result.results[2].status).toBe('ok')
    expect(result.bodies[0].volume).toBeCloseTo(BOX / 2, 3)
    builder.dispose()
  })

  it('drills a hole along a cylinder element, and a hole along a round face of the body', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const pin: { id: number; fit: CylinderFit } = { id: 10, fit: { kind: 'cylinder', center: [10, 10, 5], axis: [0, 0, 1], radius: 3, length: 10, coverage: 360, ...NO_STATS } }
    const result = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'hole', name: 'Hole 1', body: 2, axis: { kind: 'element', id: 10 }, radius: 3, depth: null, visible: true }], ctx([pin]))
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(result.bodies[0].volume).toBeCloseTo(BOX - Math.PI * 9 * 10, 2)
    // The hole's wall names the hole's own axis: a second hole along it,
    // wider, follows the first.
    const wall = result.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'cylinder')!.fingerprint
    expect(wall.center).toBeDefined()
    expect(Math.hypot(wall.center![0] - 10, wall.center![1] - 10)).toBeLessThan(1e-6)
    const wider = await build(
      builder,
      [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'hole', name: 'Hole 1', body: 2, axis: { kind: 'element', id: 10 }, radius: 3, depth: null, visible: true }, { id: 4, kind: 'hole', name: 'Hole 2', body: 2, axis: { kind: 'face', face: wall }, radius: 4, depth: null, visible: true }],
      ctx([pin]),
    )
    expect(wider.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(wider.bodies[0].volume).toBeCloseTo(BOX - Math.PI * 16 * 10, 2)
    builder.dispose()
  })

  it('extracts a plane as a slab, a cylinder as a pin and a sphere as a ball, joined or on their own', async () => {
    const builder = new Builder(await kernelPromise)
    const plane: { id: number; fit: PlaneFit } = { id: 11, fit: { kind: 'plane', center: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0], extentU: 20, extentV: 10, ...NO_STATS } }
    const pin: { id: number; fit: CylinderFit } = { id: 12, fit: { kind: 'cylinder', center: [0, 0, 4], axis: [0, 0, 1], radius: 2, length: 8, coverage: 360, ...NO_STATS } }
    const ball: { id: number; fit: SphereFit } = { id: 13, fit: { kind: 'sphere', center: [50, 0, 0], radius: 5, ...NO_STATS } }
    const result = await build(
      builder,
      [
        { id: 1, kind: 'extract', name: 'Body 1', element: 11, thickness: 4, op: 'new', visible: true },
        { id: 2, kind: 'extract', name: 'Body 2', element: 12, thickness: 0, op: 'join', target: 1, visible: true },
        { id: 3, kind: 'extract', name: 'Body 3', element: 13, thickness: 0, op: 'new', visible: true },
      ],
      ctx([plane, pin, ball]),
    )
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(result.bodies.length).toBe(2)
    // The slab is 40 × 20 × 4 = 3200; the pin from z = 0 to 8 adds the
    // part above the slab's top at z = 2: 6 mm of π · 4.
    expect(result.bodies[0].volume).toBeCloseTo(3200 + Math.PI * 4 * 6, 1)
    expect(result.bodies[1].volume).toBeCloseTo((4 / 3) * Math.PI * 125, 1)
    expect(result.bodies[1].topology.faces[0].fingerprint.kind).toBe('sphere')
    // Extended in Measure, an element is a body that long: the pin 2 mm
    // further down and 5 mm further up, the slab 10 mm wider on one edge.
    const extended = await build(
      builder,
      [
        { id: 1, kind: 'extract', name: 'Body 1', element: 12, thickness: 0, op: 'new', visible: true },
        { id: 2, kind: 'extract', name: 'Body 2', element: 11, thickness: 4, op: 'new', visible: true },
      ],
      ctx([
        { ...pin, extend: { kind: 'cylinder', start: 2, end: 5 } },
        { ...plane, extend: { kind: 'plane', uMin: 0, uMax: 10, vMin: 0, vMax: 0 } },
      ]),
    )
    expect(extended.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(extended.bodies[0].volume).toBeCloseTo(Math.PI * 4 * 15, 1)
    const caps = extended.bodies[0].topology.faces.filter((f) => f.fingerprint.kind === 'plane').map((f) => f.fingerprint.centroid[2]).sort((a, b) => a - b)
    expect(caps[0]).toBeCloseTo(-2, 6)
    expect(caps[1]).toBeCloseTo(13, 6)
    expect(extended.bodies[1].volume).toBeCloseTo(50 * 20 * 4, 1)
    // Given an assumed Ø in Measure, it is a body that wide, as it is drawn
    // there — extended as well.
    const designed = await build(builder, [{ id: 1, kind: 'extract', name: 'Body 1', element: 12, thickness: 0, op: 'new', visible: true }], ctx([{ ...pin, assumed: 4.5, extend: { kind: 'cylinder', start: 2, end: 5 } }]))
    expect(designed.results[0].status).toBe('ok')
    expect(designed.bodies[0].volume).toBeCloseTo(Math.PI * 2.25 ** 2 * 15, 1)
    // A torus — a fillet's round measured whole — as a ring body.
    const ring: { id: number; fit: TorusFit } = { id: 14, fit: { kind: 'torus', center: [0, 0, 30], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2, tubeCoverage: 360, spineCoverage: 360, ...NO_STATS } }
    const torus = await build(builder, [{ id: 4, kind: 'extract', name: 'Body 4', element: 14, thickness: 0, op: 'new', visible: true }], ctx([ring]))
    expect(torus.results[0].status).toBe('ok')
    expect(torus.bodies[0].closed).toBe(true)
    expect(torus.bodies[0].volume).toBeCloseTo(2 * Math.PI * Math.PI * 10 * 4, 0)
    builder.dispose()
  })

  it('mirrors a body about a plane and joins it, and combines two bodies', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const mirrored = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'mirror', name: 'Mirror 1', body: 2, plane: { kind: 'world', axis: 'z', offset: 0 }, join: true, visible: true }])
    expect(mirrored.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(mirrored.bodies.length).toBe(1)
    expect(mirrored.bodies[0].volume).toBeCloseTo(2 * BOX, 3)
    // Mirrored about its own top face: the same, by a face pick.
    const top = (await build(builder, [s, extrudeAll(2, s, 0, 10)])).bodies[0].topology.faces.find((f) => f.fingerprint.dir[2] > 0.9)!.fingerprint
    const byFace = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'mirror', name: 'Mirror 1', body: 2, plane: { kind: 'face', face: top }, join: true, visible: true }])
    expect(byFace.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(byFace.bodies[0].volume).toBeCloseTo(2 * BOX, 3)

    // Two bodies overlapping by half: joined, cut, intersected.
    const s2 = rectangleSketch(4, 40, 20, [20, 0])
    const base: Feature[] = [s, extrudeAll(2, s, 0, 10), s2, extrudeAll(5, s2, 0, 10)]
    for (const [op, volume] of [['join', 1.5 * BOX], ['cut', BOX / 2], ['intersect', BOX / 2]] as const) {
      const r = await build(builder, [...base, { id: 6, kind: 'boolean', name: 'Combine 1', op, body: 2, tool: 5, visible: true }])
      expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok', 'ok'])
      expect(r.bodies.length).toBe(1)
      expect(r.bodies[0].id).toBe(2)
      expect(r.bodies[0].volume).toBeCloseTo(volume, 3)
    }
    builder.dispose()
  })

  it('patterns a sheet into cutters that stand apart, and splits with all of them at once', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const cutter = emptySketch()
    addEntity(cutter, { kind: 'line', a: [10, -5], b: [10, 25] })
    const sheetSketch: SketchFeature = { id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: cutter, visible: true }
    const features: Feature[] = [
      s,
      extrudeAll(2, s, 0, 10),
      sheetSketch,
      { id: 4, kind: 'sheet', name: 'Sheet 1', sketchId: 3, from: -5, to: 15, visible: true },
      // The sheet at x = 10 and its copy at x = 25.
      { id: 5, kind: 'pattern', name: 'Pattern 1', body: 4, mode: 'linear', axis: { kind: 'world', axis: 'x' }, count: 2, step: 15, visible: true },
      { id: 6, kind: 'split', name: 'Split 1', body: 2, tools: [4], keep: 'largest', tolerance: 0.3, overlap: 0.5, visible: true },
    ]
    const result = await build(builder, features)
    expect(result.results.map((r) => r.status + (r.message ? ':' + r.message : ''))).toEqual(['ok', 'ok', 'ok', 'ok'])
    const sheet = result.bodies.find((b) => b.id === 4)!
    expect(sheet.surface).toBe(true)
    expect(sheet.faces).toBe(2)
    // Cut at 10 and at 25, the 40 mm box is 10, 15 and 15: the largest of
    // three fragments is a 15, which neither sheet alone would leave.
    expect(result.bodies.find((b) => b.id === 2)!.volume).toBeCloseTo(15 * 20 * 10, 3)
    builder.dispose()
  })

  it('never joins a solid to a surface: the step says so by name, and the solid stands as a body of its own', async () => {
    const builder = new Builder(await kernelPromise)
    const cutter = emptySketch()
    addEntity(cutter, { kind: 'line', a: [10, -5], b: [10, 25] })
    const sheetSketch: SketchFeature = { id: 1, kind: 'sketch', name: 'Sketch 1', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: cutter, visible: true }
    const s = rectangleSketch(3, 40, 20)
    const sheet: Feature = { id: 2, kind: 'sheet', name: 'Sheet 1', sketchId: 1, from: -5, to: 15, visible: true }
    const joined = await build(builder, [sheetSketch, sheet, s, extrudeAll(4, s, 0, 10, 'join', 2)])
    expect(joined.results.find((r) => r.id === 4)?.status).toBe('failed')
    expect(joined.results.find((r) => r.id === 4)?.message).toMatch(/Sheet 1 is a surface, not a solid/)
    // The sheet is left as it was.
    expect(joined.bodies.find((b) => b.id === 2)?.surface).toBe(true)
    const alone = await build(builder, [sheetSketch, sheet, s, extrudeAll(4, s, 0, 10)])
    expect(alone.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(alone.bodies.find((b) => b.id === 4)!.volume).toBeCloseTo(40 * 20 * 10, 3)
    // Nor is a surface the tool of a Combine.
    const combined = await build(builder, [sheetSketch, sheet, s, extrudeAll(4, s, 0, 10), { id: 5, kind: 'boolean', name: 'Combine 1', op: 'join', body: 4, tool: 2, visible: true }])
    expect(combined.results.find((r) => r.id === 5)?.message).toMatch(/Sheet 1 is a sheet, and .+ a solid — a solid is combined with solids/)
    builder.dispose()
  })

  it('drops the plug of a pocket: on the scan by area, not by how many triangles its walls are', async () => {
    const builder = new Builder(await kernelPromise)
    // The part as it is: a 40 × 20 plate 4 thick with a 24 × 12 window
    // through it. Built once and meshed, it is the scan.
    const plate = rectangleSketch(1, 40, 20)
    const window = rectangleSketch(3, 24, 12, [8, 4])
    const real = await build(builder, [plate, extrudeAll(2, plate, 0, 4), window, extrudeAll(4, window, -1, 5, 'cut', 2)])
    const mesh = real.bodies[0].mesh
    expect(real.bodies[0].volume).toBeCloseTo(40 * 20 * 4 - 24 * 12 * 4, 3)
    builder.setScan(new NominalSurface(mesh.positions, mesh.indices))
    // Reversed the cutter's way: the plate whole, the window's outline as a
    // sheet through it, split, the fragments on the scan kept. The plug's
    // four walls lie on the scan's — eight triangles of its twelve — but
    // they are 288 mm² of its 864: its roof and floor have no scan on them.
    const features: Feature[] = [plate, extrudeAll(2, plate, 0, 4), window, { id: 4, kind: 'sheet', name: 'Sheet 1', sketchId: 3, from: -1, to: 5, visible: true }, { id: 5, kind: 'split', name: 'Split 1', body: 2, tools: [4], keep: 'scan', tolerance: 0.1, overlap: 0.5, visible: true }]
    const out = await build(builder, features)
    expect(out.results.map((r) => r.status + (r.message ? ':' + r.message : ''))).toEqual(['ok', 'ok', 'ok'])
    expect(out.bodies.find((b) => b.id === 2)!.volume).toBeCloseTo(40 * 20 * 4 - 24 * 12 * 4, 3)
    builder.dispose()
  })

  it('makes a sheet of an open chain, splits a body with it and keeps the fragment on the scan', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    // An open chain: a line across the box at x = 10, drawn on the sketch plane.
    const cutter = emptySketch()
    addEntity(cutter, { kind: 'line', a: [10, -5], b: [10, 25] })
    const sheetSketch: SketchFeature = { id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: cutter, visible: true }
    const features: Feature[] = [
      s,
      extrudeAll(2, s, 0, 10),
      sheetSketch,
      { id: 4, kind: 'sheet', name: 'Sheet 1', sketchId: 3, from: -5, to: 15, visible: true },
      { id: 5, kind: 'split', name: 'Split 1', body: 2, tools: [4], keep: 'largest', tolerance: 0.3, overlap: 0.5, visible: true },
    ]
    const result = await build(builder, features)
    expect(result.results.map((r) => r.status + (r.message ? ':' + r.message : ''))).toEqual(['ok', 'ok', 'ok'])
    // The sheet is a body of its own, a surface; the split kept the
    // larger part, 30 of the 40.
    const sheet = result.bodies.find((b) => b.id === 4)!
    expect(sheet.surface).toBe(true)
    expect(sheet.closed).toBe(false)
    expect(sheet.faces).toBe(1)
    const body = result.bodies.find((b) => b.id === 2)!
    expect(body.surface).toBe(false)
    expect(body.volume).toBeCloseTo(30 * 20 * 10, 3)
    // The export leaves the sheet out.
    expect(builder.exportStep([2, 4]).length).toBeGreaterThan(100)

    // On the scan: a scan of the 10 mm slab alone keeps that fragment.
    const slab = boxMesh(1, 4)
    const positions = new Float32Array(slab.length)
    for (let i = 0; i < slab.length; i += 3) {
      positions[i] = slab[i] * 10 + 5
      positions[i + 1] = slab[i + 1] * 20 + 10
      positions[i + 2] = slab[i + 2] * 10 + 5
    }
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    builder.setScan(new NominalSurface(positions, indices))
    const onScan = await build(builder, [...features.slice(0, 4), { id: 5, kind: 'split', name: 'Split 1', body: 2, tools: [4], keep: 'scan', tolerance: 0.3, overlap: 0.5, visible: true }])
    expect(onScan.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(onScan.bodies.find((b) => b.id === 2)!.volume).toBeCloseTo(10 * 20 * 10, 3)
    builder.setScan(null)
    // Without a scan, "on the scan" falls back to the largest.
    const fallback = await build(builder, [...features.slice(0, 4), { id: 5, kind: 'split', name: 'Split 1', body: 2, tools: [4], keep: 'scan', tolerance: 0.3, overlap: 0.5, visible: true }])
    expect(fallback.bodies.find((b) => b.id === 2)!.volume).toBeCloseTo(30 * 20 * 10, 3)
    // A sheet that does not cross the body fails the split by name.
    const short = emptySketch()
    addEntity(short, { kind: 'line', a: [10, 5], b: [10, 15] })
    const shortSketch: SketchFeature = { ...sheetSketch, sketch: short }
    const missed = await build(builder, [s, extrudeAll(2, s, 0, 10), shortSketch, features[3], features[4]])
    expect(missed.results[2].status).toBe('failed')
    expect(missed.results[2].message).toMatch(/cross the body/)
    builder.dispose()
  })

  it('lofts between two sketches, and patterns a body about an axis and along a line', async () => {
    const builder = new Builder(await kernelPromise)
    const bottom = rectangleSketch(1, 40, 20)
    const top: SketchFeature = { ...rectangleSketch(2, 20, 10, [10, 5]), frame: { ...XY, origin: [0, 0, 30] } }
    const loft = await build(builder, [bottom, top, { id: 3, kind: 'loft', name: 'Loft 1', sketches: [1, 2], ruled: true, op: 'new', visible: true }])
    expect(loft.results.map((r) => r.status)).toEqual(['ok'])
    // A frustum of a rectangular pyramid, 30 tall, 800 at the base and
    // 200 at the top.
    expect(loft.bodies[0].volume).toBeCloseTo((30 / 3) * (800 + 200 + Math.sqrt(800 * 200)), 1)
    expect(loft.bodies[0].closed).toBe(true)

    const s = rectangleSketch(1, 10, 10)
    const ring = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'pattern', name: 'Pattern 1', body: 2, mode: 'circular', axis: { kind: 'element', id: 7 }, count: 4, step: 360, visible: true }], ctx([{ id: 7, fit: { kind: 'line', center: [30, 0, 0], dir: [0, 0, 1], length: 10, ...NO_STATS } }]))
    expect(ring.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    // Four copies standing apart are four bodies: the first keeps the
    // extrude's id, the others take the pattern's.
    expect(ring.bodies.map((b) => b.id)).toEqual([2, 3, islandId(3, 1), islandId(3, 2)])
    for (const b of ring.bodies) expect(b.volume).toBeCloseTo(1000, 3)
    const row = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'pattern', name: 'Pattern 1', body: 2, mode: 'linear', axis: { kind: 'world', axis: 'x' }, count: 3, step: 15, visible: true }])
    expect(row.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(row.bodies.length).toBe(3)
    expect(row.bodies.reduce((v, b) => v + b.volume, 0)).toBeCloseTo(3000, 3)
    // Overlapping copies fuse into one: three cubes every 5 mm are a bar.
    const bar = await build(builder, [s, extrudeAll(2, s, 0, 10), { id: 3, kind: 'pattern', name: 'Pattern 1', body: 2, mode: 'linear', axis: { kind: 'world', axis: 'x' }, count: 3, step: 5, visible: true }])
    expect(bar.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(bar.bodies[0].volume).toBeCloseTo(20 * 10 * 10, 1)
    builder.dispose()
  })

  it('leans the walls of a box about its bottom face, and the leaned walls keep their maker', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const faces = first.bodies[0].topology.faces.map((f) => f.fingerprint)
    const bottom = faces.find((f) => f.dir[2] < -0.9)!
    const right = faces.find((f) => f.dir[0] > 0.9)!
    const left = faces.find((f) => f.dir[0] < -0.9)!
    const draft: Feature = { id: 3, kind: 'draft', name: 'Draft 1', body: 2, neutral: { kind: 'face', face: bottom }, faces: [right, left], angleDeg: 5, visible: true }
    const out = await build(builder, [s, extrudeAll(2, s, 0, 10), draft])
    expect(out.results.find((r) => r.id === 3)?.status).toBe('ok')
    // Each wall leans in by 10·tan 5° at the top: a wedge of half that,
    // 10 high and 20 long, off either side.
    const wedge = 0.5 * 10 * (10 * Math.tan((5 * Math.PI) / 180)) * 20
    expect(out.bodies[0].volume).toBeCloseTo(BOX - 2 * wedge, 3)
    expect(out.bodies[0].closed).toBe(true)
    // The bottom keeps its width; the top is narrower.
    const top = out.bodies[0].topology.faces.find((f) => f.fingerprint.dir[2] > 0.9)!.fingerprint
    expect(top.area).toBeCloseTo((40 - 2 * 10 * Math.tan((5 * Math.PI) / 180)) * 20, 3)
    // The kernel tracks no history for a draft: the faces are traced by
    // what they are, and the leaned walls are still the extrude's.
    expect(out.bodies[0].topology.faces.every((f) => f.fingerprint.origin === 2)).toBe(true)
    // About a plane half way up, the same angle takes half as much each way.
    const mid: Feature = { id: 3, kind: 'draft', name: 'Draft 1', body: 2, neutral: { kind: 'world', axis: 'z', offset: 5 }, faces: [right], angleDeg: 5, visible: true }
    const about = await build(builder, [s, extrudeAll(2, s, 0, 10), mid])
    expect(about.results.find((r) => r.id === 3)?.status).toBe('ok')
    expect(about.bodies[0].volume).toBeCloseTo(BOX, 3)
    // A face square to the pull has nothing to lean about.
    const bad: Feature = { id: 3, kind: 'draft', name: 'Draft 1', body: 2, neutral: { kind: 'face', face: bottom }, faces: [top], angleDeg: 5, visible: true }
    const refused = await build(builder, [s, extrudeAll(2, s, 0, 10), bad])
    expect(refused.results.find((r) => r.id === 3)?.message).toMatch(/lost|gone|square to the pull/)
  })

  it('moves a flat face out and in, and resizes a hole and a boss by their round faces', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const top = first.bodies[0].topology.faces.find((f) => f.fingerprint.dir[2] > 0.9)!.fingerprint
    const move = (offset: number): Feature => ({ id: 3, kind: 'moveFace', name: 'Move face 1', body: 2, faces: [top], offset, visible: true })
    const out = await build(builder, [s, extrudeAll(2, s, 0, 10), move(2.5)])
    expect(out.results.find((r) => r.id === 3)?.status).toBe('ok')
    expect(out.bodies[0].volume).toBeCloseTo(40 * 20 * 12.5, 3)
    // The walls run on as one face each: six faces still.
    expect(out.bodies[0].faces).toBe(6)
    const inward = await build(builder, [s, extrudeAll(2, s, 0, 10), move(-4)])
    expect(inward.bodies[0].volume).toBeCloseTo(40 * 20 * 6, 3)
    expect(inward.bodies[0].faces).toBe(6)
    expect((await build(builder, [s, extrudeAll(2, s, 0, 10), move(0)])).results.find((r) => r.id === 3)?.status).toBe('failed')

    // A plate with a hole through it and a boss on it.
    const hole = emptySketch()
    addEntity(hole, { kind: 'circle', c: [10, 10], r: 3 })
    const holeSketch: SketchFeature = { id: 4, kind: 'sketch', name: 'Sketch 4', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: hole, visible: true }
    const boss = emptySketch()
    addEntity(boss, { kind: 'circle', c: [30, 10], r: 4 })
    const bossSketch: SketchFeature = { id: 6, kind: 'sketch', name: 'Sketch 6', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch: boss, visible: true }
    const base: Feature[] = [s, extrudeAll(2, s, 0, 10), holeSketch, extrudeAll(5, holeSketch, -1, 11, 'cut', 2), bossSketch, extrudeAll(7, bossSketch, 10, 16, 'join', 2)]
    const plate = await build(builder, base)
    const plateVolume = BOX - Math.PI * 9 * 10 + Math.PI * 16 * 6
    expect(plate.bodies[0].volume).toBeCloseTo(plateVolume, 2)
    const rounds = plate.bodies[0].topology.faces.filter((f) => f.fingerprint.kind === 'cylinder').map((f) => f.fingerprint)
    const bore = rounds.find((f) => Math.abs((f.radius ?? 0) - 3) < 1e-6)!
    const pin = rounds.find((f) => Math.abs((f.radius ?? 0) - 4) < 1e-6)!
    const resize = (face: typeof bore, offset: number): Feature => ({ id: 8, kind: 'moveFace', name: 'Move face 1', body: 2, faces: [face], offset, visible: true })
    // The hole bored out to r 3.5, then sleeved to r 2.
    expect((await build(builder, [...base, resize(bore, 0.5)])).bodies[0].volume).toBeCloseTo(plateVolume - Math.PI * (3.5 ** 2 - 9) * 10, 2)
    expect((await build(builder, [...base, resize(bore, -1)])).bodies[0].volume).toBeCloseTo(plateVolume + Math.PI * (9 - 4) * 10, 2)
    // The boss built up to r 5, then turned down to r 3.
    expect((await build(builder, [...base, resize(pin, 1)])).bodies[0].volume).toBeCloseTo(plateVolume + Math.PI * (25 - 16) * 6, 2)
    expect((await build(builder, [...base, resize(pin, -1)])).bodies[0].volume).toBeCloseTo(plateVolume - Math.PI * (16 - 9) * 6, 2)
  })

  it('makes a cylinder fitted in a bore longer and wider by moving its wall and both ends at once', async () => {
    // The scanner saw the top 8 mm of a bore; the cylinder fitted there is
    // extracted, then pushed 0.3 mm out all round and its ends 0.3 mm on —
    // a cutter a touch larger than the bore, to take it out of the scan.
    const builder = new Builder(await kernelPromise)
    const bore: { id: number; fit: CylinderFit } = { id: 12, fit: { kind: 'cylinder', center: [0, 0, 4], axis: [0, 0, 1], radius: 2, length: 8, coverage: 360, ...NO_STATS } }
    const extract: Feature = { id: 1, kind: 'extract', name: 'Body 1', element: 12, thickness: 0, op: 'new', visible: true }
    const first = await build(builder, [extract], ctx([bore]))
    const faces = first.bodies[0].topology.faces.map((f) => f.fingerprint)
    expect(faces.map((f) => f.kind).sort()).toEqual(['cylinder', 'plane', 'plane'])
    const grow: Feature = { id: 2, kind: 'moveFace', name: 'Move face 1', body: 1, faces, offset: 0.3, visible: true }
    const out = await build(builder, [extract, grow], ctx([bore]))
    expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(out.bodies[0].volume).toBeCloseTo(Math.PI * 2.3 ** 2 * 8.6, 3)
    expect(out.bodies[0].faces).toBe(3)
    // Its ends alone: a longer cylinder of the same radius.
    const ends: Feature = { ...grow, faces: faces.filter((f) => f.kind === 'plane'), offset: 6 }
    expect((await build(builder, [extract, ends], ctx([bore]))).bodies[0].volume).toBeCloseTo(Math.PI * 4 * 20, 3)
    builder.dispose()
  })

  it('extrudes to a face, to the next face and to the last, as a boss and as a cut', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const plate = extrudeAll(2, s, 0, 10)
    // A circle drawn 20 mm above the plate, looking up: the plate is behind it.
    const above = (at: [number, number]): SketchFeature => {
      const sketch = emptySketch()
      addEntity(sketch, { kind: 'circle', c: at, r: 4 })
      return { id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 30 }, frame: { ...XY, origin: [0, 0, 30] }, sketch, visible: true }
    }
    const over = above([20, 10])
    const reach = (extent: ExtrudeFeature['extent'], op: ExtrudeFeature['op'], sketch = over): ExtrudeFeature => ({ id: 4, kind: 'extrude', name: 'Extrude 4', sketchId: 3, regions: findRegions(sketch.sketch).map((r) => r.key), extent, op, target: op === 'new' ? undefined : 2, visible: true })
    const disc = Math.PI * 16
    const run = async (extent: ExtrudeFeature['extent'], op: ExtrudeFeature['op'], sketch = over) => build(builder, [s, plate, sketch, reach(extent, op, sketch)])

    // To next, down onto the plate: a pin from the sketch to the plate's top.
    const next = await run({ kind: 'toNext', from: 0, reverse: true }, 'join')
    expect(next.results.find((r) => r.id === 4)?.status).toBe('ok')
    expect(next.bodies[0].volume).toBeCloseTo(BOX + disc * 20, 2)
    // The way the sketch looks there is nothing.
    expect((await run({ kind: 'toNext', from: 0 }, 'join')).results.find((r) => r.id === 4)?.message).toMatch(/reverse the direction/)
    // Half off the plate, nothing stops the half that misses.
    expect((await run({ kind: 'toNext', from: 0, reverse: true }, 'join', above([40, 10]))).results.find((r) => r.id === 4)?.message).toMatch(/does not cover the whole profile/)
    // To last as a boss runs to the plate's far side; as a cut, through it.
    expect((await run({ kind: 'toLast', from: 0, reverse: true }, 'join')).bodies[0].volume).toBeCloseTo(BOX + disc * 20, 2)
    expect((await run({ kind: 'toLast', from: 0, reverse: true }, 'cut')).bodies[0].volume).toBeCloseTo(BOX - disc * 10, 2)
    // To next as a cut goes through the first wall it meets.
    expect((await run({ kind: 'toNext', from: 0, reverse: true }, 'cut')).bodies[0].volume).toBeCloseTo(BOX - disc * 10, 2)
    // A new body to next is measured against every body, and stands on the plate.
    const pin = await run({ kind: 'toNext', from: 0, reverse: true }, 'new')
    expect(pin.bodies.find((b) => b.id === 4)?.volume).toBeCloseTo(disc * 20, 2)
    // Three circles, each to its own next face: three bosses, three holes.
    const three = (() => {
      const sketch = emptySketch()
      for (const x of [8, 20, 32]) addEntity(sketch, { kind: 'circle', c: [x, 10], r: 4 })
      return { ...over, sketch }
    })()
    const bosses = await run({ kind: 'toNext', from: 0, reverse: true }, 'join', three)
    expect(bosses.results.find((r) => r.id === 4)?.status).toBe('ok')
    expect(bosses.bodies).toHaveLength(1)
    expect(bosses.bodies[0].volume).toBeCloseTo(BOX + 3 * disc * 20, 2)
    expect((await run({ kind: 'toNext', from: 0, reverse: true }, 'cut', three)).bodies[0].volume).toBeCloseTo(BOX - 3 * disc * 10, 2)
    // One of them off the plate: refused, and the one named.
    const offEdge = (() => {
      const sketch = emptySketch()
      for (const x of [8, 40]) addEntity(sketch, { kind: 'circle', c: [x, 10], r: 4 })
      return { ...over, sketch }
    })()
    expect((await run({ kind: 'toNext', from: 0, reverse: true }, 'join', offEdge)).results.find((r) => r.id === 4)?.message).toMatch(/^The profile's region about \(40\.00, 10\.00, 30\.00\): The body does not cover the whole profile/)

    // To a face: the plate's top, by its fingerprint.
    const top = next.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[2] > 0.9 && Math.abs(f.fingerprint.centroid[2] - 10) < 1e-6)!.fingerprint
    const toFace = await run({ kind: 'toFace', from: 0, body: 2, face: top }, 'join')
    expect(toFace.results.find((r) => r.id === 4)?.status).toBe('ok')
    expect(toFace.bodies[0].volume).toBeCloseTo(BOX + disc * 20, 2)
    // Reopened, the extrude's ghost is measured against the plate as it
    // stood before the pin — not against the pin it has since become.
    const features = [s, plate, over, reach({ kind: 'toNext', from: 0, reverse: true }, 'join')]
    await build(builder, features)
    const step = resolveFeatures(features, ctx(), (f) => findRegions(f.sketch)).find((x) => x.id === 4)!
    if (step.kind !== 'extrude') throw new Error('not an extrude')
    expect(builder.preview(step, over.sketch).volume).toBeCloseTo(disc * 20, 2)
  })

  it('keeps the body as it stood before a feature, for editing that feature on it', async () => {
    const builder = new Builder(await kernelPromise)
    const s = rectangleSketch(1, 40, 20)
    const first = await build(builder, [s, extrudeAll(2, s, 0, 10)])
    const top = first.bodies[0].topology.faces.find((f) => f.fingerprint.dir[2] > 0.9)!.fingerprint
    const topFront = first.bodies[0].topology.edges.find((e) => Math.abs(e.fingerprint.mid[1]) < 1e-6 && e.fingerprint.mid[2] > 9.9)!.fingerprint
    const features: Feature[] = [
      s,
      extrudeAll(2, s, 0, 10),
      { id: 3, kind: 'fillet', name: 'Fillet 1', body: 2, edges: [topFront], radius: 2, chain: false, visible: true },
      { id: 4, kind: 'shell', name: 'Shell 1', body: 2, faces: [top], thickness: 1, visible: true },
    ]
    const result = await build(builder, features)
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    // Before the shell the body was the filleted box; before the fillet,
    // the plain box — with the edge the fillet took still there.
    const beforeShell = builder.stage(4, 2)!
    expect(beforeShell.topology.faces.length).toBe(7)
    const beforeFillet = builder.stage(3, 2)!
    expect(beforeFillet.topology.faces.length).toBe(6)
    expect(builder.findEdges(2, [topFront], 3)).toHaveProperty('hashes')
    expect(builder.findEdges(2, [topFront])).toHaveProperty('lost')
    expect(builder.stage(3, 99)).toBeNull()
    // A preview of the fillet with a wider radius runs on the plain box.
    const steps = resolveFeatures([s, extrudeAll(2, s, 0, 10), { ...(features[2] as Extract<Feature, { kind: 'fillet' }>), radius: 3 }], ctx(), (f) => findRegions(f.sketch))
    const step = steps[steps.length - 1]
    if (step.kind === 'failed' || step.kind === 'sketch') throw new Error(`not a feature: ${step.kind}`)
    const preview = builder.preview(step, undefined)
    expect(preview.closed).toBe(true)
    expect(preview.volume).toBeCloseTo(BOX - (1 - Math.PI / 4) * 9 * 40, 3)
    builder.dispose()
  })
})

describe('the automatic trim', () => {
  const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }
  /** A plane element facing out of a box's side. */
  const plane = (id: number, center: [number, number, number], normal: [number, number, number]): { id: number; fit: PlaneFit } => {
    const u: [number, number, number] = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
    const v: [number, number, number] = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]]
    return { id, fit: { kind: 'plane', center, normal, basisU: u, basisV: v, extentU: 5, extentV: 5, ...NO_STATS } }
  }
  /** A scan of a 20 mm box as a soup, indexed one corner per index. */
  const boxScan = () => {
    const soup = boxMesh(20, 24)
    const indices = new Uint32Array(soup.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions: soup, indices }
  }
  const trim = (id: number, tools: TrimTool[], tolerance = 0.3): Extract<Feature, { kind: 'trim' }> => ({ id, kind: 'trim', name: `Trim ${id}`, tools, tolerance, overlap: 0.5, visible: true })

  it('closes six measured planes into the box they were measured on, and five into a surface with open edges', async () => {
    const builder = new Builder(await kernelPromise)
    const scan = boxScan()
    builder.setScan(new NominalSurface(scan.positions, scan.indices), scan.positions)
    const planes = [plane(1, [10, 0, 0], [1, 0, 0]), plane(2, [-10, 0, 0], [-1, 0, 0]), plane(3, [0, 10, 0], [0, 1, 0]), plane(4, [0, -10, 0], [0, -1, 0]), plane(5, [0, 0, 10], [0, 0, 1]), plane(6, [0, 0, -10], [0, 0, -1])]
    const all = await build(builder, [trim(7, planes.map((p) => ({ kind: 'element', id: p.id })))], ctx(planes))
    expect(all.results[0].status).toBe('ok')
    expect(all.results[0].trim?.closed).toBe(true)
    expect(all.results[0].trim?.kept).toBe(6)
    const body = all.bodies[0]
    expect(body.surface).toBe(false)
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(8000, 1)
    // The box's own faces, grown past the scan, are among the faces cut
    // and never on it.
    expect(all.results[0].trim!.faces).toBeGreaterThan(6)

    // Five planes: the kept faces do not close. A surface body stands, its
    // four open edges reported for drawing.
    const five = await build(builder, [trim(7, planes.slice(0, 5).map((p) => ({ kind: 'element', id: p.id })))], ctx(planes))
    expect(five.results[0].status).toBe('ok')
    expect(five.results[0].trim?.closed).toBe(false)
    expect(five.results[0].trim?.kept).toBe(5)
    expect(five.results[0].trim?.openEdges.length).toBe(4)
    expect(five.bodies[0].surface).toBe(true)
    // The preview reports the same.
    const preview = builder.preview({ kind: 'trim', id: 9, name: 'Preview', bodies: [], primitives: planes.slice(0, 5).map((p) => ({ kind: 'plane' as const, origin: p.fit.center, normal: p.fit.normal, basisU: p.fit.basisU, basisV: p.fit.basisV })), tolerance: 0.3, overlap: 0.5 }, undefined)
    expect(preview.closed).toBe(false)
    expect(preview.trim?.openEdges.length).toBe(4)
    // A tolerance too tight for the scan keeps nothing, and says so.
    const none = await build(builder, [trim(7, planes.map((p) => ({ kind: 'element', id: p.id })), 1e-9)], ctx(planes.map((p) => ({ ...p, fit: { ...p.fit, center: [p.fit.center[0] * 1.01, p.fit.center[1] * 1.01, p.fit.center[2] * 1.01] as [number, number, number] } }))))
    expect(none.results[0].status).toBe('failed')
    expect(none.results[0].message).toMatch(/lies on the scan/)
    builder.dispose()
  })

  it('keeps two scan-close caps as a surface and marks the joins they cannot share', async () => {
    const builder = new Builder(await kernelPromise)
    try {
      const scan = boxScan()
      builder.setScan(new NominalSurface(scan.positions, scan.indices), scan.positions)
      const planes = [
        plane(1, [10, 0, 0], [1, 0, 0]), plane(2, [-10, 0, 0], [-1, 0, 0]),
        plane(3, [0, 10, 0], [0, 1, 0]), plane(4, [0, -10, 0], [0, -1, 0]),
        plane(5, [0, 0, 10], [0, 0, 1]), plane(6, [0, 0, -10], [0, 0, -1]),
        plane(7, [0, 0, 9.9], [0, 0, 1]),
      ]
      const result = await build(builder, [trim(8, planes.map(({ id }) => ({ kind: 'element', id })))], ctx(planes))
      expect(result.results[0].status).toBe('ok')
      expect(result.bodies[0]).toMatchObject({ surface: true, closed: false })
      expect(builder.check(8, 0.01)?.solids).toBe(0)
      const joins = result.results[0].trim?.nonManifoldEdges ?? []
      expect(joins).toHaveLength(4)
      for (const line of joins) {
        expect(line.length).toBeGreaterThanOrEqual(6)
        for (let i = 2; i < line.length; i += 3) expect(line[i]).toBeCloseTo(9.9, 4)
      }
    } finally {
      builder.dispose()
    }
  })

  it('does not keep a wall fragment below its bottom cutter using nearby floor triangles', async () => {
    const kernel = await kernelPromise
    const builder = new Builder(kernel)
    try {
      const scan = boxScan()
      builder.setScan(new NominalSurface(scan.positions, scan.indices), scan.positions)
      const planes = [
        plane(1, [9.7, 0, 0], [1, 0, 0]), plane(2, [-10, 0, 0], [-1, 0, 0]),
        plane(3, [0, 10, 0], [0, 1, 0]), plane(4, [0, -10, 0], [0, -1, 0]),
        plane(5, [0, 0, 10], [0, 0, 1]), plane(6, [0, 0, -10], [0, 0, -1]),
      ]
      const feature = { ...trim(7, planes.map(({ id }) => ({ kind: 'element', id })), 1), overlap: 0.2 }
      const result = await build(builder, [feature], ctx(planes))
      expect(result.results[0].status).toBe('ok')
      const shape = builder.body(7)!
      const wall = kernel.faces(shape).filter((f) => f.kind === 'plane' && Math.abs(f.centroid[0] - 9.7) < 1e-5 && Math.abs(f.dir[0]) > 0.99)
      expect(wall.length).toBeGreaterThan(0)
      for (const { hash } of wall) {
        const face = kernel.faceCopy(shape, hash)
        try { expect(kernel.bounds(face).min[2]).toBeGreaterThanOrEqual(-10.001) } finally { kernel.release(face) }
      }
    } finally {
      builder.dispose()
    }
  })

  it('keeps the measured wall beyond an unsupported cut when a long fragment dilutes its coverage', async () => {
    const kernel = await kernelPromise
    const builder = new Builder(kernel)
    try {
      const scan = boxScan()
      const positions = new Float32Array(scan.positions.length + 9)
      positions.set(scan.positions)
      positions.set([50, 65, 0, 50, 65, 1, 50, 64, 0], scan.positions.length)
      const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
      builder.setScan(new NominalSurface(positions, indices), positions)
      const region = Uint32Array.from(Array.from(scan.indices).filter((i) => scan.positions[3 * i] === -10))
      const wall: Feature = { id: 10, kind: 'surface', name: 'Left wall', shape: 'plane', region, fit: { net: null, degree: 3, smoothness: 0.01, expandPct: 0 }, visible: true }
      const shortWall: Feature = { ...wall, id: 12, name: 'Left wall on the near side', region: region.filter((i) => positions[3 * i + 1] <= -5) }
      const planes = [
        plane(1, [0, -10, 0], [0, -1, 0]), plane(2, [0, 0, 0], [0, 1, 0]),
        plane(3, [0, 0, -10], [0, 0, -1]), plane(4, [0, 0, 10], [0, 0, 1]),
        plane(5, [0, 59, 0], [0, 1, 0]),
      ]
      for (const fitted of [[shortWall, wall], [wall, shortWall]]) {
        const tools: TrimTool[] = [...fitted.map(({ id }) => ({ kind: 'body' as const, id })), ...planes.map(({ id }) => ({ kind: 'element' as const, id }))]
        const result = await build(builder, [...fitted, { ...trim(11, tools, 0.25), overlap: 0.2 }], ctx(planes))
        expect(result.results[2].trim?.closed).toBe(false)
        const shape = builder.body(11)!
        const faces = kernel.faces(shape).filter((f) => f.kind === 'plane' && Math.abs(f.dir[0]) > 0.99)
        const wallBounds = faces.map(({ hash }) => {
          const face = kernel.faceCopy(shape, hash)
          try { return kernel.bounds(face) } finally { kernel.release(face) }
        })
        const original = kernel.bounds(builder.body(10)!)
        expect(Math.max(...wallBounds.map((b) => b.max[1]))).toBeCloseTo(original.max[1], 4)
        expect(Math.min(...wallBounds.map((b) => b.min[1]))).toBeCloseTo(-10, 3)
      }
    } finally {
      builder.dispose()
    }
  })

  it('closes a fitted surface with the planes round it, and a cylinder element between two planes', async () => {
    const builder = new Builder(await kernelPromise)
    const scan = boxScan()
    builder.setScan(new NominalSurface(scan.positions, scan.indices), scan.positions)
    // The box's top as a fitted surface (its scan vertices with z = 10)
    // and the other five sides as planes.
    const top: number[] = []
    for (let v = 0; v < scan.positions.length / 3; v++) if (Math.abs(scan.positions[v * 3 + 2] - 10) < 1e-6) top.push(v)
    const planes = [plane(1, [10, 0, 0], [1, 0, 0]), plane(2, [-10, 0, 0], [-1, 0, 0]), plane(3, [0, 10, 0], [0, 1, 0]), plane(4, [0, -10, 0], [0, -1, 0]), plane(6, [0, 0, -10], [0, 0, -1])]
    const surface: Feature = { id: 8, kind: 'surface', name: 'Surface 1', region: Uint32Array.from(top), fit: { net: { u: 4, v: 4 }, degree: 3, expandPct: 35, smoothness: 0.01 }, visible: true }
    const out = await build(builder, [surface, trim(9, [{ kind: 'body', id: 8 }, ...planes.map((p) => ({ kind: 'element' as const, id: p.id }))])], ctx(planes))
    expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(out.results[1].trim?.closed).toBe(true)
    const body = out.bodies.find((b) => b.id === 9)!
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(8000, 0)
    // The top face of the solid is the surface's: its maker is the surface
    // feature, the others' the trim's.
    const makers = body.topology.faces.map((f) => f.fingerprint.origin)
    expect(makers.filter((m) => m === 8).length).toBe(1)
    expect(makers.filter((m) => m === 9).length).toBe(5)

    // A cylinder element between two planes, on a scan of that disc.
    const R = 10, H = 12
    const N = 96
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N
      pos.push(R * Math.cos(a), R * Math.sin(a), 0, R * Math.cos(a), R * Math.sin(a), H)
    }
    const c0 = pos.length / 3
    pos.push(0, 0, 0, 0, 0, H)
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N
      idx.push(i * 2, j * 2, j * 2 + 1, i * 2, j * 2 + 1, i * 2 + 1)
      idx.push(c0, j * 2, i * 2, c0 + 1, i * 2 + 1, j * 2 + 1)
    }
    const disc = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
    builder.setScan(new NominalSurface(disc.positions, disc.indices), disc.positions)
    const cyl: { id: number; fit: CylinderFit } = { id: 20, fit: { kind: 'cylinder', center: [0, 0, H / 2], axis: [0, 0, 1], radius: R, length: 4, coverage: 360, ...NO_STATS } }
    const ends = [plane(21, [0, 0, 0], [0, 0, -1]), plane(22, [0, 0, H], [0, 0, 1])]
    const solid = await build(builder, [trim(23, [{ kind: 'element', id: 20 }, ...ends.map((p) => ({ kind: 'element' as const, id: p.id }))], 0.2)], ctx([cyl, ...ends]))
    expect(solid.results[0].status).toBe('ok')
    expect(solid.results[0].trim?.closed).toBe(true)
    // A 96-gon's area against the circle's: within a percent.
    expect(Math.abs(solid.bodies[0].volume - Math.PI * R * R * H) / (Math.PI * R * R * H)).toBeLessThan(0.01)
    builder.dispose()
  })
})

describe('a surface fitted through a region of the scan', () => {
  /** A scan of a cylindrical patch, R = 30, over 30 × 20 mm at 0.5 mm. */
  function cylinderScan(): { positions: Float32Array; indices: Uint32Array; region: Uint32Array } {
    const R = 30
    const nx = 61, ny = 41
    const positions = new Float32Array(nx * ny * 3)
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const x = -15 + i * 0.5, y = -10 + j * 0.5
        positions.set([x, y, Math.sqrt(R * R - x * x) - R], (i * ny + j) * 3)
      }
    }
    const tri: number[] = []
    for (let i = 0; i + 1 < nx; i++) for (let j = 0; j + 1 < ny; j++) tri.push(i * ny + j, (i + 1) * ny + j, (i + 1) * ny + j + 1, i * ny + j, (i + 1) * ny + j + 1, i * ny + j + 1)
    const region = new Uint32Array(nx * ny)
    for (let v = 0; v < region.length; v++) region[v] = v
    return { positions, indices: Uint32Array.from(tri), region }
  }

  it('makes a surface body the kernel holds as one face, lying on the scan, reaching past it', async () => {
    const builder = new Builder(await kernelPromise)
    const scan = cylinderScan()
    builder.setScan(new NominalSurface(scan.positions, scan.indices), scan.positions)
    const surface: Feature = { id: 1, kind: 'surface', name: 'Surface 1', region: scan.region, fit: { net: { u: 8, v: 4 }, degree: 3, expandPct: 35, smoothness: 0.01 }, visible: true }
    const out = await build(builder, [surface])
    expect(out.results[0].status).toBe('ok')
    expect(out.results[0].surface?.rms).toBeLessThan(0.002)
    expect(out.results[0].surface?.net).toEqual({ u: 8, v: 4 })
    const body = out.bodies[0]
    expect(body.surface).toBe(true)
    expect(body.faces).toBe(1)
    // Every vertex of the surface's mesh over the region lies on the cylinder
    // within the fit's residual and the kernel's chord; the mesh reaches
    // past the region by the margin.
    const R = 30
    let worst = 0, xMax = 0
    const p = body.mesh.positions
    for (let i = 0; i < p.length; i += 3) {
      xMax = Math.max(xMax, Math.abs(p[i]))
      if (Math.abs(p[i]) <= 15 && Math.abs(p[i + 1]) <= 10) worst = Math.max(worst, Math.abs(p[i + 2] - (Math.sqrt(R * R - p[i] * p[i]) - R)))
    }
    expect(worst).toBeLessThan(0.02)
    expect(xMax).toBeGreaterThan(15 * 1.3)
    // The preview reports the same fit; a region too small is refused by
    // name before the kernel is asked.
    const preview = builder.preview({ kind: 'surface', id: 9, name: 'Preview', region: scan.region, fit: surface.fit, shape: 'freeform', constrain: { mode: 'auto' }, refs: [], refSurfaces: [] }, undefined)
    expect(preview.surface?.net).toEqual({ u: 8, v: 4 })
    expect(preview.closed).toBe(false)
    const tiny = await build(builder, [{ ...surface, region: scan.region.slice(0, 5) }])
    expect(tiny.results[0].status).toBe('failed')
    expect(tiny.results[0].message).toMatch(/at least/)
    // Without the scan in hand the fit says so.
    builder.setScan(null)
    const gone = await build(builder, [surface])
    expect(gone.results[0].status).toBe('failed')
    expect(gone.results[0].message).toMatch(/scan/)
    builder.dispose()
  })

  it('fits the same patch as a cylinder: an exact face, its axis held to the part’s Y', async () => {
    const builder = new Builder(await kernelPromise)
    const scan = cylinderScan()
    // The patch turned 0.3° about Z: the free axis is that far off Y.
    const c = Math.cos((0.3 * Math.PI) / 180), s = Math.sin((0.3 * Math.PI) / 180)
    const turned = new Float32Array(scan.positions.length)
    for (let i = 0; i < turned.length; i += 3) turned.set([c * scan.positions[i] - s * scan.positions[i + 1], s * scan.positions[i] + c * scan.positions[i + 1], scan.positions[i + 2]], i)
    builder.setScan(new NominalSurface(turned, scan.indices), turned)
    const surface: Feature = { id: 1, kind: 'surface', name: 'Surface 1', region: scan.region, fit: { net: null, degree: 3, expandPct: 35, smoothness: 0.01 }, shape: 'cylinder', visible: true }
    const out = await build(builder, [surface])
    expect(out.results[0].status).toBe('ok')
    const report = out.results[0].surface!
    expect(report.shape).toBe('cylinder')
    expect(report.radius!).toBeCloseTo(30, 1)
    expect(report.relations!.map((r) => `${r.relation} ${r.ref}`)).toContain('along datum:zx')
    const body = out.bodies[0]
    expect(body.surface).toBe(true)
    expect(body.topology.faces).toHaveLength(1)
    const face = body.topology.faces[0].fingerprint
    expect(face.kind).toBe('cylinder')
    expect(Math.abs(face.dir[1])).toBeCloseTo(1, 9)
    expect(face.radius).toBeCloseTo(report.radius!, 6)
    // Free, it is the axis the points have.
    const free = await build(builder, [{ ...surface, constrain: { mode: 'free' } }])
    expect(free.results[0].surface!.relations).toEqual([])
    expect(Math.abs(free.bodies[0].topology.faces[0].fingerprint.dir[1])).toBeLessThan(1 - 1e-6)
    builder.dispose()
  })

  it('six faces of a box scanned 0.3° askew, fitted as planes, trim into a box that is square', async () => {
    const builder = new Builder(await kernelPromise)
    const soup = boxMesh(20, 24)
    const c = Math.cos((0.3 * Math.PI) / 180), s = Math.sin((0.3 * Math.PI) / 180)
    const positions = new Float32Array(soup.length)
    for (let i = 0; i < soup.length; i += 3) positions.set([c * soup[i] - s * soup[i + 1], s * soup[i] + c * soup[i + 1], soup[i + 2]], i)
    const indices = new Uint32Array(soup.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    builder.setScan(new NominalSurface(positions, indices), positions)
    // Each face's region: the soup's corners on that side of the box as it
    // was before it was turned.
    const side = (axis: number, sign: number) => {
      const out: number[] = []
      for (let v = 0; v < soup.length / 3; v++) if (Math.abs(soup[v * 3 + axis] - sign * 10) < 1e-6) out.push(v)
      return Uint32Array.from(out)
    }
    const fit = { net: null, degree: 3, expandPct: 35, smoothness: 0.01 }
    const surfaces: Feature[] = []
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) surfaces.push({ id: surfaces.length + 1, kind: 'surface', name: `Surface ${surfaces.length + 1}`, region: side(axis, sign), fit, shape: 'plane', visible: true })
    const trim: Feature = { id: 9, kind: 'trim', name: 'Trim 1', tools: surfaces.map((f) => ({ kind: 'body' as const, id: f.id })), tolerance: 0.3, overlap: 0.5, visible: true }
    const out = await build(builder, [...surfaces, trim])
    expect(out.results.every((r) => r.status === 'ok')).toBe(true)
    // Every wall was 0.3° off a coordinate plane and is on one now; top and
    // bottom were level already.
    for (const r of out.results.slice(0, 6)) expect(r.surface!.relations!.length).toBeGreaterThan(0)
    expect(out.results[6].trim?.closed).toBe(true)
    const solid = out.bodies.find((b) => b.id === 9)!
    expect(solid.closed).toBe(true)
    expect(solid.topology.faces).toHaveLength(6)
    for (const f of solid.topology.faces) expect(Math.max(...f.fingerprint.dir.map(Math.abs))).toBeCloseTo(1, 9)
    // Square, with each wall at its points' mean distance: the turn took
    // nothing off the box.
    expect(solid.volume).toBeCloseTo(8000, 0)
    // The second wall fitted along X met the first within a millimetre of
    // nothing; it is parallel to it, 20 mm away, not coincident.
    const second = out.results[1].surface!.relations!
    expect(second.some((r) => r.relation === 'on')).toBe(false)
    builder.dispose()
  })
})

describe('where a sketch’s zero is', () => {
  const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9))

  it('is the origin projected onto the plane, whatever the plane is offered through', () => {
    // A coordinate plane at z = 12.5, offered through a part centred far
    // off: the sheet's zero is on the Z axis, its X the part's X.
    const world = resolvePlaneFrame({ kind: 'world', axis: 'z', offset: 12.5 }, { sections: [], elements: [], modelCenter: [100, 200, 300] })!
    near(world.origin, [0, 0, 12.5])
    near(world.basisU, [1, 0, 0])
    near(world.basisV, [0, 1, 0])
    // A plane element fitted on a patch with its own axes: the sheet is
    // not laid out along the patch.
    const fit: PlaneFit = { kind: 'plane', center: [30, 40, 15], normal: [0, 0, 1], basisU: [0, 1, 0], basisV: [-1, 0, 0], extentU: 10, extentV: 10, sigma: 0, usedPoints: 0, regionSize: 0 }
    const plane = resolvePlaneFrame({ kind: 'plane', id: 5 }, { sections: [], elements: [{ id: 5, fit }], modelCenter: [0, 0, 0] })!
    near(plane.origin, [0, 0, 15])
    near(plane.basisU, [1, 0, 0])
    // A section's frame likewise: the sketch shares the plane, not the sheet.
    const section = resolvePlaneFrame({ kind: 'section', id: 2 }, { sections: [{ id: 2, frame: { origin: [5, 5, 5], normal: [1, 0, 0], basisU: [0, 0, 1], basisV: [0, -1, 0] } }], elements: [], modelCenter: [0, 0, 0] })!
    near(section.origin, [5, 0, 0])
    near(section.basisU, [0, 1, 0])
    near(section.basisV, [0, 0, 1])
    // A face of a body: on the face, zero under the origin.
    const top: FaceFingerprint = { kind: 'plane', centroid: [20, 10, 10], dir: [0, 0, 1], area: 800, origin: 2 }
    near(frameOnFace(top)!.origin, [0, 0, 10])
    expect(frameOnFace({ ...top, kind: 'cylinder' })).toBeNull()
    const ref = bodyFacePlane(2, top)!
    expect(ref.kind).toBe('bodyFace')
    expect(ref.body).toBe(2)
    near(resolvePlaneFrame(ref, ctx())!.origin, [0, 0, 10])
    expect(describePlaneRef(ref, { sections: [], elements: [] })).toBe('a face of the body')
  })

  it('offers the coordinate planes at zero once the part is aligned, and through the centre with a scan', () => {
    const unaligned = coordinatePlaneOffers({ centre: [10, 20, 30], atZero: false })
    expect(unaligned.map((o) => o.label)).toEqual(['YZ plane through the centre', 'XZ plane through the centre', 'XY plane through the centre'])
    expect(unaligned.map((o) => o.ref.offset)).toEqual([10, 20, 30])
    // Aligned, the planes themselves come first, the slices through the
    // centre after them; with no scan there is no centre to slice.
    const aligned = coordinatePlaneOffers({ centre: [10, 20, 30], atZero: true })
    expect(aligned.map((o) => o.label)).toEqual(['YZ plane', 'XZ plane', 'XY plane', 'YZ plane through the centre', 'XZ plane through the centre', 'XY plane through the centre'])
    expect(aligned.map((o) => o.ref.offset)).toEqual([0, 0, 0, 10, 20, 30])
    expect(new Set(aligned.map((o) => o.key)).size).toBe(6)
    expect(coordinatePlaneOffers({ centre: null, atZero: true }).map((o) => o.label)).toEqual(['YZ plane', 'XZ plane', 'XY plane'])
  })

  it('carries a sketch on a face into its features, and a revolve’s sketch-line axis with it', () => {
    const top: FaceFingerprint = { kind: 'plane', centroid: [20, 10, 10], dir: [0, 0, 1], area: 800, origin: 2 }
    const ref = bodyFacePlane(2, top)!
    const sketch = emptySketch()
    addRectangle(sketch, [5, 5], [15, 15])
    const line = addEntity(sketch, { kind: 'line', a: [0, 0], b: [0, 30], construction: true })
    const s: SketchFeature = { id: 3, kind: 'sketch', name: 'Sketch 3', plane: ref, frame: ref.frame, sketch, visible: true }
    const pull = extrudeAll(4, s, 0, 5, 'join', 2)
    const turn: RevolveFeature = { id: 5, kind: 'revolve', name: 'Revolve 5', sketchId: 3, regions: findRegions(sketch).map((r) => r.key), axis: { kind: 'sketchLine', entity: line }, angleDeg: 90, op: 'new', visible: true }
    const steps = resolveFeatures([s, pull, turn], ctx(), (f) => findRegions(f.sketch))
    // The sketch is placed on the face first, then built on.
    expect(steps.map((x) => x.kind)).toEqual(['sketch', 'extrude', 'revolve'])
    expect(steps[0].kind === 'sketch' && steps[0].onFace?.body).toBe(2)
    expect(steps[1].kind === 'extrude' && steps[1].onFace?.body).toBe(2)
    expect(steps[1].kind === 'extrude' && steps[1].onFace?.frame.origin).toEqual([0, 0, 10])
    expect(steps[1].kind === 'extrude' && steps[1].regions).toEqual(pull.regions)
    expect(steps[2].kind === 'revolve' && steps[2].onFace?.face).toBe(top)
    expect(steps[2].kind === 'revolve' && steps[2].axisInSketch).toBe(true)
    expect(steps[2].kind === 'revolve' && steps[2].axisLine).toBe(line)
    // A sketch on a coordinate plane carries nothing of the kind, and is
    // not placed — unless a piece of it was projected from the part.
    const plain = resolveFeatures([rectangleSketch(1, 10, 10), extrudeAll(2, rectangleSketch(1, 10, 10), 0, 5)], ctx(), (f) => findRegions(f.sketch))
    expect(plain.map((x) => x.kind)).toEqual(['extrude'])
    expect(plain[0].kind === 'extrude' && plain[0].onFace).toBeUndefined()
    const linked = rectangleSketch(1, 10, 10)
    addEntity(linked.sketch, { kind: 'line', a: [0, 0], b: [10, 0], fixed: true, projected: true, source: { sketch: 7, entity: 1 } })
    expect(resolveFeatures([linked], ctx(), (f) => findRegions(f.sketch)).map((x) => x.kind)).toEqual(['sketch'])
  })

  it('moves lifted profiles from one frame to another, sheet coordinates kept', () => {
    const from: SectionFrame = { origin: [0, 0, 10], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
    // The face turned a quarter about Z and raised: a point's sheet (u, v)
    // is the same, its place in the part is not.
    const to: SectionFrame = { origin: [0, 0, 12], normal: [0, 0, 1], basisU: [0, 1, 0], basisV: [-1, 0, 0] }
    const map = frameMap(from, to)
    near(map.point([5, 0, 10]), [0, 5, 12])
    near(map.dir([1, 0, 0]), [0, 1, 0])
    near(map.dir([0, 0, 1]), [0, 0, 1])
    const moved = moveProfiles([{ outer: [{ kind: 'line', a: [0, 0, 10], b: [5, 0, 10] }, { kind: 'circle', center: [1, 2, 10], normal: [0, 0, 1], radius: 3 }], holes: [] }], map)
    expect(moved[0].outer[0].kind === 'line' && moved[0].outer[0].b.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0, 5, 12])
    expect(moved[0].outer[1].kind === 'circle' && moved[0].outer[1].center.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([-2, 1, 12])
  })
})
