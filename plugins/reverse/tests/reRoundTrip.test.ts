// SPDX-License-Identifier: AGPL-3.0-only
// A STEP read-back that says where (round 14, Q2) and slivers on every
// boolean (Q10). A boss whose circle touches the curved front of the base
// at one tangent point, extruded and joined, leaves a line in the front
// face where the two only touched — a body the kernel's check passes, a
// STEP file a strict reader may not close. Verify, body.check's round trip
// and its "find" walk name the place, the faces and the step that made it;
// the audit lists it as a contact. A body open along four edges (an open
// box) and a cut leaving a wall of no thickness (four faces at one edge)
// read back with their free and non-manifold edges. Three overlapping
// blocks whose tops lie 0.005 mm apart leave risers a sliver wide, which
// each join names and body.check lists as narrow. On a 40 mm box scanned,
// the kernel in this thread — as reCheckVoids.test.ts runs it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../../../tests/helpers'
import { run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReKernel, type Shape } from '../core/kernel'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import plugin from '../plugin'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

type Vec3 = [number, number, number]
interface Brief { result: { status: string; message?: string; warning?: string } | null; bodies: { changed?: { id: number; name: string }[] } }
interface FaceRow { index: number | null; madeBy?: { id: number; name: string | null } }
interface EdgeRow { at: Vec3; length: number; kind: string; meet: number; in: string; faces: FaceRow[] }
interface Trip { ok: boolean; problems?: string[]; closed?: boolean; freeEdges?: EdgeRow[]; freeEdgeCount?: number }
interface Checked {
  id: number
  ok: boolean
  problems?: string[]
  warnings?: string[]
  narrow: (FaceRow & { width: number; area: number; centroid: Vec3 })[]
  tiny: unknown[]
  edges: { free: number; nonManifold: number; contacts: number }
  contacts?: { at: Vec3; faces: FaceRow[]; repair: string }[]
  roundTrip?: Trip
  find?: { step: { id: number; name: string | null } | null; before: { id: number; name: string | null } | null; checked: number; of: number; done: boolean; roundTrip?: Trip }
}

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: stlBytes(boxMesh(40, 40)), name: 'box.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

const plane = (z: number) => ({ kind: 'world', axis: 'z', offset: z })

async function sketch(name: string, z: number, entities: unknown[]) {
  await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name, plane: plane(z), sketch: { entities } } })
}

async function extrude(name: string, sketchId: string, to: number, op: 'new' | 'join' | 'cut', from = 0) {
  const r = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name, sketchId, regions: 'all', extent: { kind: 'distance', from, to }, op } })
  expect(r.result?.status, r.result?.message).toBe('ok')
  return r
}

/** The base: a D 40 mm across, its straight back on y = −10 and its front
 *  an arc through (0, 20) — a circle about (0, −5/3) of radius 65/3 —
 *  5 mm tall. */
async function base() {
  const c: [number, number] = [0, -5 / 3]
  const r = 65 / 3
  const start = Math.atan2(-10 - c[1], 20)
  await sketch('Base sketch', 0, [
    { id: 1, kind: 'arc', c, r, start, sweep: Math.PI - 2 * start },
    { id: 2, kind: 'line', a: [-20, -10], b: [20, -10] },
  ])
  const made = await extrude('Base', 'Base sketch', 5, 'new')
  return made.bodies.changed![0]
}

describe('a STEP read-back that says where', () => {
  it('names the tangent touch of a joined boss in verify, the round trip and its find walk', async () => {
    const body = await base()
    // The boss: a circle of R6 inside the front, touching its arc at
    // (0, 20) — the hinge boss of the bracket, the round there gone —
    // standing from z 2 to 8.
    await sketch('Boss sketch', 2, [{ id: 1, kind: 'circle', c: [0, 14], r: 6 }])
    await extrude('Boss', 'Boss sketch', 6, 'join')
    // A hole after it, elsewhere, so the walk has a step past the boss.
    await sketch('Hole sketch', 0, [{ id: 1, kind: 'circle', c: [-10, -3], r: 2 }])
    await extrude('Hole', 'Hole sketch', 5, 'cut')

    const plain = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: body.id, audit: true })).bodies[0]
    // The kernel's check passes it; the line where the two only touched is
    // a contact, a warning, with the faces and their makers.
    expect(plain.edges).toEqual({ free: 0, nonManifold: 0, contacts: 1 })
    expect(plain.warnings?.join(' ')).toMatch(/1 tangent contact .*the first at \(0, 20, 3\.5\).*made by Base/)
    expect(plain.contacts).toHaveLength(1)
    expect(plain.contacts![0].at.map((v) => Math.round(v * 10) / 10)).toEqual([0, 20, 3.5])
    expect(plain.contacts![0].faces.map((f) => f.madeBy?.name)).toEqual(['Base'])
    expect(plain.contacts![0].repair).toMatch(/cross the other clearly/)
    expect(plain.roundTrip).toBeUndefined()

    // Verify, as the export writes it: the edge, in the body (OCCT's
    // reader drops it), named with its face and maker.
    type Step = { verify: { ok: boolean; problems: string[]; bodies: { freeEdges: EdgeRow[]; freeEdgeCount: number }[] } }
    const step = await run<Step>('reverse.export.step', { bodies: [body.id], verify: true })
    expect(step.verify.ok).toBe(false)
    expect(step.verify.bodies[0].freeEdgeCount).toBe(1)
    const edge = step.verify.bodies[0].freeEdges[0]
    expect(edge).toMatchObject({ kind: 'inside', meet: 1, in: 'body' })
    expect(edge.at.map((v) => Math.round(v * 10) / 10)).toEqual([0, 20, 3.5])
    expect(edge.faces[0].madeBy?.name).toBe('Base')
    expect(step.verify.problems.join(' ')).toMatch(/1 edge that does not join two faces .* the first at \(0, 20, 3\.5\) \(face \d+, made by Base\): an edge inside its one face/)

    // The round trip says the same without a file.
    const tripped = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: body.id, roundTrip: true })).bodies[0]
    expect(tripped.roundTrip?.ok).toBe(false)
    expect(tripped.roundTrip?.freeEdges?.[0]).toMatchObject({ kind: 'inside', in: 'body' })
    expect(tripped.ok).toBe(false)
    expect(tripped.problems?.join(' ')).toMatch(/Written as STEP and read back, it does not hold/)

    // Before the boss the body comes back whole; the find walk names the
    // boss as the step that made the first body that does not.
    const before = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: body.id, before: 'Boss', roundTrip: true })).bodies[0]
    expect(before.roundTrip?.ok).toBe(true)
    const found = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: body.id, roundTrip: 'find' })).bodies[0]
    expect(found.find?.done).toBe(true)
    expect(found.find?.step?.name).toBe('Boss')
    expect(found.find?.before?.name).toBe('Hole')
    expect(found.find?.checked).toBe(2)
    expect(found.find?.roundTrip?.freeEdges?.[0].faces[0].madeBy?.name).toBe('Base')
    expect(found.problems?.join(' ')).toMatch(/is Boss's result \(the input of Hole\)/)
  })

  it('reads a boss that crosses the front clearly back whole, with nothing to say', async () => {
    const body = await base()
    await sketch('Boss sketch', 2, [{ id: 1, kind: 'circle', c: [0, 14], r: 6.05 }])
    await extrude('Boss', 'Boss sketch', 6, 'join')
    const c = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: body.id, roundTrip: 'find' })).bodies[0]
    expect(c.edges).toEqual({ free: 0, nonManifold: 0, contacts: 0 })
    expect(c.roundTrip?.ok).toBe(true)
    expect(c.roundTrip?.freeEdges).toEqual([])
    expect(c.find).toMatchObject({ step: null, done: true })
    expect(c.ok).toBe(true)
  })

  it('refuses a find walk before a feature', async () => {
    const body = await base()
    await sketch('Boss sketch', 2, [{ id: 1, kind: 'circle', c: [0, 14], r: 6 }])
    await extrude('Boss', 'Boss sketch', 6, 'join')
    await expect(run('reverse.body.check', { body: body.id, before: 'Boss', roundTrip: 'find' })).rejects.toThrow(/walks the whole build/)
  })
})

describe('free and non-manifold edges, read back', () => {
  const kernelPromise = ReKernel.load()

  it('lists an open box’s four free edges, each matched to the body’s edge and faces', async () => {
    const k = await kernelPromise
    const box = k.box([0, 0, 0], [10, 10, 10])
    const top = k.faces(box).find((f) => f.kind === 'plane' && f.centroid[2] > 9.99)!
    const faces = k.faceHashes(box).filter((h) => h !== top.hash).map((h) => k.faceCopy(box, h))
    const { shape: open } = k.sewSheet(faces, 1e-6)
    const check = k.verifyStep(k.exportStep([open]), [open])
    expect(check.ok).toBe(false)
    const b = check.bodies[0]
    expect(b.closed).toBe(false)
    expect(b.freeEdgeCount).toBe(4)
    expect(b.freeEdges.map((e) => e.kind)).toEqual(['free', 'free', 'free', 'free'])
    for (const e of b.freeEdges) {
      expect(e.at[2]).toBeCloseTo(10, 6)
      expect(e.length).toBeCloseTo(10, 6)
      expect(e.in).toBe('file')
      // The open shell's own edge: one face of it beside it.
      expect(e.near).toHaveLength(1)
    }
    expect(check.problems[0]).toMatch(/reads back as no closed solid — 4 edges not joining two faces, the first at \(/)
    expect(check.problems.some((p) => /4 edges that do not join two faces .*an edge with one face, a hole in the skin/.test(p))).toBe(true)
    k.release(box, open, ...faces)
  })

  it('lists the edge where a tangent hole leaves a wall of no thickness: four faces meet there', async () => {
    const k = await kernelPromise
    const Z: Vec3 = [0, 0, 1]
    const d = k.face({ outer: [{ kind: 'line', a: [-20, -10, 0], b: [20, -10, 0] }, { kind: 'arc', a: [20, -10, 0], m: [0, 20, 0], b: [-20, -10, 0] }], holes: [] })
    const solid = k.extrude(d, Z, 0, 5)
    const disc = k.face({ outer: [{ kind: 'circle', center: [0, 14, 0], normal: Z, radius: 6 }], holes: [] })
    const pin = k.extrude(disc, Z, -1, 6)
    const holed: Shape = k.cutTracked(solid, pin).shape
    expect(k.isClosedSolid(holed)).toBe(true)
    const odd = k.oddEdges(holed)
    expect(odd.counts.nonManifold).toBe(1)
    const check = k.verifyStep(k.exportStep([holed]), [holed])
    const e = check.bodies[0].freeEdges[0]
    expect(e).toMatchObject({ kind: 'nonManifold', faces: 4, in: 'file' })
    expect(e.at.map((v) => Math.round(v * 10) / 10)).toEqual([0, 20, 2.5])
    expect(e.near.length).toBeGreaterThanOrEqual(2)
    expect(check.problems.join(' ')).toMatch(/4 faces meet at one edge/)
    k.release(d, solid, disc, pin, holed)
  })

  it('finds nothing odd in a rounded block: a smooth round’s edges are tangent, not contacts', async () => {
    const k = await kernelPromise
    const box = k.box([0, 0, 0], [10, 10, 10])
    const rounded = k.filletTracked(box, k.edges(box, 0.1).map((e) => e.hash), 1).shape
    const cyl = k.extrude(k.face({ outer: [{ kind: 'circle', center: [0, 0, 0], normal: [0, 0, 1], radius: 3 }], holes: [] }), [0, 0, 1], 0, 4)
    for (const s of [rounded, cyl]) {
      const odd = k.oddEdges(s, { knife: true })
      expect(odd.counts).toEqual({ free: 0, inside: 0, nonManifold: 0, knife: 0 })
      expect(k.verifyStep(k.exportStep([s]), [s]).ok).toBe(true)
    }
    k.release(box, rounded, cyl)
  })
})

describe('slivers on every boolean', () => {
  /** A block of its own sketch on z = 0, x from x0 to x1, 10 deep, `top` tall. */
  async function block(name: string, x0: number, x1: number, top: number, op: 'new' | 'join') {
    await sketch(`${name} sketch`, 0, [{ id: 1, kind: 'line', a: [x0, 0], b: [x1, 0] }, { id: 2, kind: 'line', a: [x1, 0], b: [x1, 10] }, { id: 3, kind: 'line', a: [x1, 10], b: [x0, 10] }, { id: 4, kind: 'line', a: [x0, 10], b: [x0, 0] }])
    return extrude(name, `${name} sketch`, top, op)
  }

  it('says so on each join of three overlapping pieces that leave a sliver, and body.check names the narrow faces', async () => {
    const a = await block('Root A', 0, 10, 10, 'new')
    const b = await block('Root B', 5, 15, 10.005, 'join')
    expect(b.result?.warning).toMatch(/^The join left 1 sliver face, under 0\.01 mm wide: 0\.005 mm wide at \(5\.00, 5\.00, 10\.00\) — two faces a hair apart/)
    const c = await block('Root C', 12, 20, 10, 'join')
    expect(c.result?.warning).toMatch(/The join left 1 sliver face, under 0\.01 mm wide: 0\.005 mm wide at \(15\.00, 5\.00, 10\.00\)/)
    const checked = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: a.bodies.changed![0].id })).bodies[0]
    // Each riser is 0.005 × 10 mm: 0.05 mm², over tiny's area, under the
    // narrow width.
    expect(checked.tiny).toEqual([])
    expect(checked.narrow).toHaveLength(2)
    expect(checked.narrow.map((f) => f.width)).toEqual([0.005, 0.005])
    // Each riser was made by the block standing above its neighbour's top.
    expect(checked.narrow.every((f) => f.index !== null && f.madeBy?.name === 'Root B')).toBe(true)
    expect(checked.ok).toBe(false)
    expect(checked.problems?.join(' ')).toMatch(/2 faces under 0\.01 mm wide/)
  })

  it('plays a combine of two plain blocks a hair apart again fuzzy, and the sliver goes', async () => {
    const a = await block('Left', 0, 10, 10, 'new')
    const b = await block('Right', 5, 15, 10.0004, 'new')
    const joined = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', op: 'join', body: a.bodies.changed![0].id, tool: b.bodies.changed![0].id } })
    expect(joined.result?.status, joined.result?.message).toBe('ok')
    expect(joined.result?.warning).toMatch(/^The combine was played again fuzzy: the first result left 1 sliver face, under 0\.01 mm wide\./)
    const checked = (await run<{ bodies: Checked[] }>('reverse.body.check', { body: a.bodies.changed![0].id })).bodies[0]
    expect(checked.narrow).toEqual([])
  })

  it('leaves a clean join alone: no sliver, no word', async () => {
    await block('One', 0, 10, 10, 'new')
    const two = await block('Two', 5, 15, 12, 'join')
    expect(two.result?.warning).toBeUndefined()
  })
})
