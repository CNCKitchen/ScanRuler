// SPDX-License-Identifier: AGPL-3.0-only
// The commands that read the scan and tell the agent where: a section's
// outline fitted to lines and arcs, a sketch drawn from it, the comparison
// by face and by worst spot, a body checked and exported as STL, edges
// found by a query and listed by the round that took them, a feature
// edited on a body a later join took in, a shell that says where the
// wall does not fit, slots and rounded rectangles, and several features in
// one call; the comparison's patches, picks by a query, a feature
// inserted after another, the scan sliced at several heights, a thread
// read off a bore, and what a round that fails says. On a 40 mm box
// scanned in the in-process worker, the kernel in this thread — as
// reCommands.test.ts runs it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginToggleKeys, viewToggles } from '../../../src/commands/viewToggles'
import { useHistory } from '../../../src/state/historyStore'
import { usePrefs } from '../../../src/state/prefsStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { boxMesh, coneMesh } from '../../../tests/helpers'
import { refused, run, startHeadless, stlBytes, undoLabels, type Headless } from '../../../tests/commandKit'
import { collectReversePart } from '../app/projectSection'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
// After the plugin, as the app loads it: the commands sit in an import cycle.
import { continuesTrack } from '../app/reSectionCommands'
import { resetReverse } from './reReset'

// Kernel builds and real-scan fits run long, and longer on a slow machine.
vi.setConfig({ testTimeout: 180_000 })

type Vec3 = [number, number, number]
type Vec2 = [number, number]
interface Body { id: number; name: string; closed: boolean; volume: number; bounds: { min: Vec3; max: Vec3; size: Vec3 } }
interface Changed { count: number; changed?: Body[]; removed?: { id: number; name: string }[] }
interface Brief {
  feature: { id: number; name: string; kind: string; status: string }
  result: { status: string; message?: string; edges?: { kind: string; mid: Vec3; length: number; radius?: number }[] } | null
  bodies: Changed
  failed?: unknown[]
  solve?: { ok: boolean; underConstrained: number[] }
  regions?: { at: Vec2; area: number }[]
  shapes?: { index: number; kind: string; sides?: number[]; ends?: number[]; rounds?: number[] }[]
  fitted?: { chain: number; closed: boolean; pieces: { id: number; kind: string }[] }[]
}
interface Face { index: number; kind: string; normal?: Vec3; area: number; centroid: Vec3; fingerprint?: unknown; madeBy: { id: number; name: string | null } }
interface Edge { index: number; kind: string; length: number; mid: Vec3; faces: number[]; fingerprint?: unknown }
interface Described { bodies: { id: number; name: string; before?: { id: number; name: string }; matched: { faces: number; edges?: number }; of: { faces: number; edges?: number }; faceList: Face[]; edgeList?: Edge[] }[] }

const BOX = stlBytes(boxMesh(40, 40))

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

/** A rectangle on the XY plane at `z`, `size` across about the origin. */
const plateSketch = (name: string, z: number, size: number) => ({
  kind: 'sketch',
  name,
  plane: { kind: 'world', axis: 'z', offset: z },
  sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [size, size], fixed: true }] },
})

/** The rectangle extruded `height` up from its plane, a body of its own. */
const extrude = (sketch: string, height: number, name?: string) => ({ kind: 'extrude', ...(name ? { name } : {}), sketchId: sketch, regions: 'all', extent: { kind: 'distance', from: 0, to: height }, op: 'new' })

/** A box body `size` across, its bottom at `z`. */
async function boxBody(size: number, z: number, height = size) {
  await run<Brief>('reverse.feature.add', { feature: plateSketch(`Plate ${size}`, z, size) })
  const made = await run<Brief>('reverse.feature.add', { feature: extrude(`Plate ${size}`, height) })
  expect(made.result?.status, made.result?.message).toBe('ok')
  return made.bodies.changed![0]
}

const describeBody = (input: Record<string, unknown>) => run<Described>('reverse.body.describe', input)

describe('the scan read for the model', () => {
  it('reverse.section.fit cuts a section’s outline into the lines it is, with their lengths and angles', async () => {
    const sec = await run<{ section: { id: number } }>('section.cut', { across: 'XY', offset: 5, name: 'Mid' })
    type Fit = { chains: { index: number; closed: boolean; points: number; pieces: { kind: string; length?: number; angleDeg?: number; leanDeg?: number; a: Vec2; b: Vec2; world: { a: Vec3 } }[] }[] }
    const fit = await run<Fit>('reverse.section.fit', { section: 'Mid' })
    expect(fit.chains).toHaveLength(1)
    const chain = fit.chains[0]
    expect(chain.closed).toBe(true)
    expect(chain.pieces).toHaveLength(4)
    for (const p of chain.pieces) {
      expect(p.kind).toBe('line')
      expect(p.length).toBeCloseTo(40, 0)
      expect(p.leanDeg).toBeLessThan(0.5)
      expect(p.world.a[2]).toBeCloseTo(5, 3)
    }
    expect(chain.pieces.map((p) => Math.round(p.angleDeg!)).sort()).toEqual([0, 0, 90, 90])
    // A sketch on the section counts from the world origin's foot: the
    // sheet's [u, v] plus sketch.add is X and Y, as on the XY plane.
    const add = (fit as unknown as { sketch: { add: Vec2 } }).sketch.add
    for (const p of chain.pieces) {
      expect(p.a[0] + add[0]).toBeCloseTo(p.world.a[0], 5)
      expect(p.a[1] + add[1]).toBeCloseTo(p.world.a[1], 5)
    }
    expect((await refused('reverse.section.fit', { section: sec.section.id, chains: [3] })).code).toBe('not_found')
    expect((await refused('reverse.section.fit', { section: 'Nowhere' })).code).toBe('not_found')
    expect(useHistory.getState().past).toHaveLength(1)
  })

  it('a sketch fitted to a section builds the part the section was cut from', async () => {
    // A hair above the bottom face: on the face itself there is nothing
    // to cut, the plane lying in the face's own triangles.
    await run('section.cut', { across: 'XY', offset: -19, name: 'Bottom' })
    const sketch = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Outline', plane: { kind: 'section', id: useStore.getState().sections[0].id }, sketch: { fit: {} } } })
    expect(sketch.fitted).toHaveLength(1)
    expect(sketch.fitted![0].closed).toBe(true)
    expect(sketch.fitted![0].pieces.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line'])
    expect(sketch.regions).toHaveLength(1)
    expect(sketch.regions![0].area).toBeCloseTo(1600, -1)
    const body = await run<Brief>('reverse.feature.add', { feature: extrude('Outline', 39) })
    expect(body.result?.status, body.result?.message).toBe('ok')
    expect(body.bodies.changed![0].volume).toBeCloseTo(62_400, -3)
    // A sketch with pieces drawn on top of the fit: the fitted ids first.
    const more = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Outline and hole', plane: { kind: 'section', id: useStore.getState().sections[0].id }, sketch: { fit: { detail: 0.5 }, entities: [{ id: 20, kind: 'circle', c: [0, 0], r: 3 }] } } })
    expect(more.fitted![0].pieces.length).toBe(4)
    expect(more.regions).toHaveLength(2)
    // A sketch on a coordinate plane is fitted to the scan cut there.
    const cut = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Cut at 5', plane: { kind: 'world', axis: 'z', offset: 5 }, sketch: { fit: { chains: [0] } } } })
    expect(cut.fitted![0].pieces).toHaveLength(4)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 5 }, sketch: { fit: { chains: [4] } } } })).code).toBe('invalid_input')
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 50 }, sketch: { fit: {} } } })).code).toBe('invalid_input')
    // The outline fitted onto a sketch that is there already.
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Later', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { entities: [{ id: 50, kind: 'circle', c: [0, 0], r: 2 }] } } })
    const edited = await run<Brief>('reverse.sketch.edit', { sketch: 'Later', add: { fit: {} } })
    expect(edited.fitted![0].pieces).toHaveLength(4)
    expect(edited.regions).toHaveLength(2)
  })

  it('reverse.body.compare says where the scan lies off the bodies, by face and by feature', async () => {
    type Compare = {
      read: number; within: number; rms: number; outside: number; inside: number; p95: number
      worst: { at: Vec3; deviation: number; body: { id: number; name: string }; face: { index: number; kind: string; madeBy: { id: number; name: string } } | null }[]
      faces: { body: { id: number }; face: { index: number; madeBy: { name: string } } | null; read: number; within: number; mean: number; rms: number; outside: number; inside: number }[]
      byFeature: { id: number; name: string | null; faces: number; read: number; rms: number; outside: number; inside: number }[]
    }
    // The scan's own box, modelled: nothing off anywhere.
    const same = await boxBody(40, -20)
    const close = await run<Compare>('reverse.body.compare', { bodies: [same.id], range: 0.1 })
    expect(close.read).toBeGreaterThan(5000)
    expect(close.within).toBe(close.read)
    expect(close.rms).toBeLessThan(1e-3)
    expect(close.worst.length).toBeGreaterThan(0)
    expect(Math.abs(close.worst[0].deviation)).toBeLessThan(1e-3)
    expect(close.faces.length).toBe(6)
    expect(close.byFeature).toHaveLength(1)
    expect(close.byFeature[0].name).toBe('Extrude 1')
    // A box 2 mm narrower: the scan stands 1 mm outside its two side faces,
    // and the worst spots say so, with the face and the feature by name.
    await run('reverse.feature.update', { feature: 'Plate 40', set: { sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [38, 40], fixed: true }] } } })
    const off = await run<Compare>('reverse.body.compare', { range: 0.1, spots: 4, faces: 3 })
    expect(off.outside).toBeCloseTo(1, 2)
    expect(off.p95).toBeCloseTo(1, 1)
    expect(off.worst).toHaveLength(4)
    expect(Math.abs(Math.abs(off.worst[0].at[0]) - 20)).toBeLessThan(1e-3)
    expect(off.worst[0].deviation).toBeCloseTo(1, 2)
    expect(off.worst[0].face?.kind).toBe('plane')
    expect(off.worst[0].face?.madeBy.name).toBe('Extrude 1')
    // No two spots within a reach of each other.
    for (let i = 1; i < off.worst.length; i++) expect(Math.hypot(...([0, 1, 2].map((k) => off.worst[i].at[k] - off.worst[0].at[k]) as Vec3))).toBeGreaterThanOrEqual(1)
    expect(off.faces).toHaveLength(3)
    expect(off.faces[0].outside).toBeCloseTo(1, 2)
    expect(off.faces[0].face).not.toBeNull()
    expect(off.faces[0].read).toBeGreaterThan(0)
    expect(off.byFeature[0].outside).toBeCloseTo(1, 2)
    // The loop's answer: the figures and where, without spots and faces.
    type Score = Record<string, unknown> & { withinShare: number; read: number; within: number; patches: Record<string, unknown>[]; byFeature: unknown[]; far: { inside: { count: number; largest: unknown[] } } }
    const score = await run<Score>('reverse.body.compare', { range: 0.1, detail: 'score' })
    expect(score.read).toBe(off.read)
    expect(score.withinShare).toBeCloseTo(off.within / off.read, 3)
    expect(score.worst).toBeUndefined()
    expect(score.faces).toBeUndefined()
    expect(score.bodies).toBeUndefined()
    expect(score.patches.length).toBeGreaterThan(0)
    expect(score.patches.length).toBeLessThanOrEqual(5)
    for (const p of score.patches) expect(p.vertex === undefined && p.side === undefined && p.body === undefined).toBe(true)
    expect(score.byFeature.length).toBeLessThanOrEqual(3)
    expect(score.far.inside.largest.length).toBeLessThanOrEqual(2)
    expect((await refused('reverse.body.compare', { detail: 'score', feature: 'Extrude 1' })).code).toBe('invalid_input')
    expect(useHistory.getState().past).toHaveLength(3)
  })

  it('reverse.body.compare tells the scan past the reach of every body, by side', async () => {
    type FarPatch = { centroid: Vec3; box: { min: Vec3; max: Vec3 }; area: number; count: number; mean: number; extreme: number; side: string; at: Vec3; vertex: number; vertices: number[]; body: { id: number; name: string } | null; face: { index: number; kind: string } | null }
    type Side = { count: number; found: number; patches: FarPatch[] }
    type Compare = { read: number; far?: { reach: number; count: number; share: number; inside: Side; outside: Side } }
    // A body half as big again as the scan: the scan's whole skin lies
    // 10 mm inside it, which no reading within reach would ever show —
    // the field is empty and reads as nothing off.
    const big = await boxBody(60, -30)
    const c = await run<Compare>('reverse.body.compare', { bodies: [big.id], range: 0.1, patchVertices: true })
    expect(c.read).toBe(0)
    expect(c.far?.reach).toBe(25)
    expect(c.far!.inside.count).toBeGreaterThan(5000)
    expect(c.far!.outside.count).toBe(0)
    expect(c.far!.count).toBe(c.far!.inside.count)
    expect(c.far!.share).toBeCloseTo(1, 2)
    // The scan is one closed skin: one patch, deep inside, on the body.
    expect(c.far!.inside.found).toBeGreaterThanOrEqual(1)
    expect(c.far!.inside.patches.length).toBeGreaterThanOrEqual(1)
    const p = c.far!.inside.patches[0]
    expect(p.side).toBe('inside')
    expect(p.extreme).toBeCloseTo(-10, 1)
    expect(p.count).toBeGreaterThan(5000)
    expect(p.body?.id).toBe(big.id)
    expect(p.face?.kind).toBe('plane')
    expect(p.vertices.length).toBeGreaterThan(0)
    expect(p.box.max[0] - p.box.min[0]).toBeCloseTo(40, 0)
    // A body half the size: the scan stands 10 mm and more outside it.
    const small = await boxBody(20, -10)
    const o = await run<Compare>('reverse.body.compare', { bodies: [small.id], range: 0.1 })
    expect(o.read).toBe(0)
    expect(o.far!.inside.count).toBe(0)
    expect(o.far!.outside.count).toBeGreaterThan(5000)
    expect(o.far!.outside.patches[0].side).toBe('outside')
    expect(o.far!.outside.patches[0].extreme).toBeGreaterThanOrEqual(10)
    expect(o.far!.outside.patches[0].body?.id).toBe(small.id)
    // The scan's own box: nothing far. Not asked for: not there.
    const same = await boxBody(40, -20)
    const s = await run<Compare>('reverse.body.compare', { bodies: [same.id], range: 0.1 })
    expect(s.read).toBeGreaterThan(5000)
    expect(s.far!.count).toBe(0)
    expect(s.far!.inside.patches).toEqual([])
    expect((await run<Compare>('reverse.body.compare', { bodies: [big.id], range: 0.1, far: 0 })).far).toBeUndefined()
    // Beyond the far reach a vertex counts as outside, with no body to name.
    const short = await run<Compare>('reverse.body.compare', { bodies: [big.id], range: 0.1, far: 5 })
    expect(short.far!.reach).toBe(5)
    expect(short.far!.inside.count).toBe(0)
    expect(short.far!.outside.count).toBe(c.far!.count)
    expect(short.far!.outside.patches[0].body).toBeNull()
  })
})

describe('bodies looked over, exported and described', () => {
  it('reverse.body.check passes a box and names the faces under an area', async () => {
    const body = await boxBody(20, 0)
    type Check = { bodies: { id: number; ok: boolean; valid: boolean; closed: boolean; solids: number; volume: number; faces: number; tiny: { index: number | null; area: number; kind?: string }[]; untessellated: unknown[]; problems?: string[] }[] }
    const fine = await run<Check>('reverse.body.check')
    expect(fine.bodies).toHaveLength(1)
    expect(fine.bodies[0]).toMatchObject({ id: body.id, ok: true, valid: true, closed: true, solids: 1, faces: 6, tiny: [], untessellated: [] })
    expect(fine.bodies[0].volume).toBeCloseTo(8000, 3)
    expect(fine.bodies[0].problems).toBeUndefined()
    const strict = await run<Check>('reverse.body.check', { body: body.id, tinyArea: 500 })
    expect(strict.bodies[0].ok).toBe(false)
    expect(strict.bodies[0].tiny).toHaveLength(6)
    expect(strict.bodies[0].tiny[0]).toMatchObject({ kind: 'plane' })
    expect(strict.bodies[0].tiny[0].area).toBeCloseTo(400, 3)
    expect(strict.bodies[0].problems![0]).toMatch(/6 faces under 500 mm²/)
    expect((await refused('reverse.body.check', { body: 'Nothing' })).code).toBe('not_found')
  })

  it('reverse.export.stl writes the bodies as one binary STL to a chord', async () => {
    const body = await boxBody(20, 0)
    type Stl = { file: { name: string; mimeType: string; bytes: Uint8Array }; triangles: number; chord: number; bodies: { id: number }[] }
    const out = await run<Stl>('reverse.export.stl')
    expect(out.bodies).toEqual([{ id: body.id, name: 'Solid 1' }])
    expect(out.file.mimeType).toBe('model/stl')
    expect(out.file.name).toBe('box-body.stl')
    expect(out.triangles).toBe(12)
    expect(out.file.bytes.byteLength).toBe(84 + 50 * out.triangles)
    expect(out.chord).toBe(0.02)
    expect((await refused('reverse.export.stl', { bodies: ['Nobody'] })).code).toBe('not_found')
  })

  it('reverse.export.stl meshes as finely as the resolution says, the angle holding a small part, and says when a part is too small to be in millimetres (issue 89)', async () => {
    type Stl = { triangles: number; chord: number; angleDeg: number; note?: string }
    // A cylinder Ø20 × 10: its curve is what the resolution shows on.
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Round', plane: 'XY', sketch: { entities: [{ kind: 'circle', c: [0, 0], r: 10 }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Round', regions: 'all', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
    const counts: number[] = []
    for (const resolution of ['draft', 'normal', 'fine', 'finest']) counts.push((await run<Stl>('reverse.export.stl', { resolution })).triangles)
    for (let i = 1; i < counts.length; i++) expect(counts[i], String(counts)).toBeGreaterThan(counts[i - 1])
    const normal = await run<Stl>('reverse.export.stl')
    expect(normal).toMatchObject({ chord: 0.02, triangles: counts[1] })
    expect(normal.angleDeg).toBeCloseTo(5.73, 2)
    expect(normal.note).toBeUndefined()
  })

  it('reverse.export.stl says when a part is too small to be in millimetres, its facets set by the angle (issue 89)', async () => {
    type Stl = { triangles: number; note?: string }
    // Ø1 × 0.5, 1.5 mm across — a 1.5 m part scanned in metres and read as
    // millimetres: a chord is coarse against it, the angle sets its facets,
    // and it says so.
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Speck', plane: 'XY', sketch: { entities: [{ kind: 'circle', c: [0, 0], r: 0.5 }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Speck', regions: 'all', extent: { kind: 'distance', from: 0, to: 0.5 }, op: 'new' } })
    const tiny = await run<Stl>('reverse.export.stl', { resolution: 'fine' })
    expect(tiny.triangles).toBeGreaterThan((await run<Stl>('reverse.export.stl', { resolution: 'draft' })).triangles)
    expect(tiny.note).toMatch(/most likely in metres/)
  })

  it('reverse.body.describe finds edges and faces by a query, and lists them short', async () => {
    const body = await boxBody(20, 0)
    const all = await describeBody({ body: body.id })
    expect(all.bodies[0].of).toEqual({ faces: 6, edges: 12 })
    expect(all.bodies[0].matched).toEqual({ faces: 6, edges: 12 })
    // No fingerprints unless asked for: a pick by index needs none.
    expect(all.bodies[0].faceList[0].fingerprint).toBeUndefined()
    expect(all.bodies[0].edgeList![0].fingerprint).toBeUndefined()
    // The edges round the top: the four bounding the face that faces up.
    const top = await describeBody({ body: body.id, where: { between: [[0, 0, 1]] }, fingerprints: true })
    expect(top.bodies[0].matched).toEqual({ faces: 1, edges: 4 })
    expect(top.bodies[0].faceList[0].normal![2]).toBeCloseTo(1, 6)
    expect(top.bodies[0].faceList[0].fingerprint).toBeDefined()
    expect(top.bodies[0].edgeList![0].fingerprint).toBeDefined()
    for (const e of top.bodies[0].edgeList!) expect(e.mid[2]).toBeCloseTo(20, 6)
    // The one edge between the top and the +X side.
    const corner = await describeBody({ body: body.id, where: { between: [[0, 0, 1], [1, 0, 0]] }, edges: true })
    expect(corner.bodies[0].matched.edges).toBe(1)
    expect(corner.bodies[0].edgeList![0].mid).toEqual([10, 0, 20])
    // Near a corner point, inside a box, by length, by the feature that made them.
    const near = await describeBody({ body: body.id, where: { near: { at: [10, 10, 20], radius: 11 } } })
    expect(near.bodies[0].matched.edges).toBe(3)
    const low = await describeBody({ body: body.id, where: { box: { min: [-11, -11, -1], max: [11, 11, 1] } }, limit: 2 })
    expect(low.bodies[0].matched).toEqual({ faces: 1, edges: 4 })
    expect(low.bodies[0].edgeList).toHaveLength(2)
    expect((await describeBody({ body: body.id, where: { minLength: 21 } })).bodies[0].matched.edges).toBe(0)
    expect((await describeBody({ body: body.id, where: { madeBy: 'Extrude 1' } })).bodies[0].matched).toEqual({ faces: 6, edges: 12 })
    expect((await describeBody({ body: body.id, where: { kind: 'cylinder' } })).bodies[0].matched.faces).toBe(0)
  })

  it('a fillet lists the edges it rounded — the chain round the top with chain, the one edge without', async () => {
    const body = await boxBody(20, 0)
    const top = await describeBody({ body: body.id, where: { between: [[0, 0, 1], [1, 0, 0]] } })
    const edge = top.bodies[0].edgeList![0].index
    const one = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [edge], radius: 2, chain: false } })
    expect(one.result?.status, one.result?.message).toBe('ok')
    expect(one.result?.edges).toHaveLength(1)
    expect(one.result?.edges![0]).toMatchObject({ kind: 'line', length: 20 })
    expect(one.result?.edges![0].mid).toEqual([10, 0, 20])
    await run('reverse.feature.remove', { feature: 'Fillet 1' })
    // The whole top loop is one tangent chain only once its corners are
    // round; the four sharp edges stay four with chain on.
    const chained = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [edge], radius: 2, chain: true } })
    expect(chained.result?.status).toBe('ok')
    expect(chained.result?.edges).toHaveLength(1)
    const four = await describeBody({ body: body.id, where: { between: [[0, 0, 1]] }, fingerprints: false })
    const loop = four.bodies[0].edgeList!.map((e) => e.index)
    expect(loop).toHaveLength(4)
    const all = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: loop, radius: 1 } })
    expect(all.result?.status, all.result?.message).toBe('ok')
    expect(all.result?.edges!.length).toBeGreaterThanOrEqual(4)
  })

  it('a feature on a body a later join took in is still edited and described as it saw the body', async () => {
    const a = await boxBody(20, 0)
    const b = await boxBody(10, 20, 10)
    const chamferedEdge = (await describeBody({ body: b.id, where: { between: [[0, 0, 1], [1, 0, 0]] } })).bodies[0].edgeList![0].index
    const chamfer = await run<Brief>('reverse.feature.add', { feature: { kind: 'chamfer', body: b.id, edges: [chamferedEdge], distance: 1, chain: false } })
    expect(chamfer.result?.status, chamfer.result?.message).toBe('ok')
    const joined = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', op: 'join', body: a.id, tool: b.id } })
    expect(joined.result?.status, joined.result?.message).toBe('ok')
    expect(joined.bodies.removed).toEqual([{ id: b.id, name: 'Solid 2' }])
    // The chamfer's body is gone from the list — and its feature still edits.
    const wider = await run<Brief>('reverse.feature.update', { feature: chamfer.feature.id, set: { distance: 2 } })
    expect(wider.result?.status, wider.result?.message).toBe('ok')
    expect(wider.feature.status).toBe('ok')
    // Its edges by index, on the body as it stood before the chamfer.
    const before = await describeBody({ before: chamfer.feature.id, fingerprints: false })
    expect(before.bodies[0].before).toEqual({ id: chamfer.feature.id, name: 'Chamfer 1' })
    expect(before.bodies[0].id).toBe(b.id)
    expect(before.bodies[0].of).toEqual({ faces: 6, edges: 12 })
    const other = before.bodies[0].edgeList!.find((e) => e.mid[2] > 29 && e.mid[0] < -4)!
    const moved = await run<Brief>('reverse.feature.update', { feature: chamfer.feature.id, set: { edges: [other.index] } })
    expect(moved.result?.status, moved.result?.message).toBe('ok')
    expect(moved.result?.edges![0].mid[0]).toBeCloseTo(-5, 6)
    // The feature that made a body kept nothing before it; a sketch works
    // on no body at all.
    expect((await refused('reverse.body.describe', { before: 'Extrude 1', body: a.id })).code).toBe('not_found')
    expect((await refused('reverse.body.describe', { before: 'Plate 20' })).code).toBe('invalid_input')
  })

  it('a feature that kept no stage, on a body a later join took in, is edited by anything but an index', async () => {
    const a = await boxBody(20, 0)
    const b = await boxBody(10, 20, 10)
    // A cut suppressed, and a chamfer too large to build: neither leaves
    // the part as it stood before it.
    const cut = await run<Brief>('reverse.feature.add', { feature: { kind: 'cutPlane', name: 'Side off', body: b.id, plane: { kind: 'world', axis: 'x', offset: 4 }, keep: -1 } })
    expect(cut.result?.status, cut.result?.message).toBe('ok')
    await run<Brief>('reverse.feature.update', { feature: 'Side off', set: { suppressed: true } })
    // An edge the cut leaves, so the chamfer builds once it is smaller.
    const edge = (await describeBody({ body: b.id, where: { between: [[0, 0, 1], [-1, 0, 0]] } })).bodies[0].edgeList![0].index
    const chamfer = await run<Brief>('reverse.feature.add', { feature: { kind: 'chamfer', name: 'Too big', body: b.id, edges: [edge], distance: 12, chain: false } })
    expect(chamfer.result?.status).toBe('failed')
    const joined = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', op: 'join', body: a.id, tool: b.id } })
    expect(joined.result?.status, joined.result?.message).toBe('ok')
    // Built again, a rename, a number: no stage needed.
    const back = await run<Brief>('reverse.feature.update', { feature: 'Side off', set: { suppressed: false } })
    expect(back.feature.status).toBe('ok')
    expect(useReverse.getState().features.find((f) => f.name === 'Side off')?.suppressed).toBeFalsy()
    expect((await run<Brief>('reverse.feature.update', { feature: 'Side off', set: { name: 'Lid cut' } })).feature.name).toBe('Lid cut')
    // A feature that failed keeps the body it was given: new edges by
    // index on the failed chamfer are read on it, and describe's before
    // shows it.
    const was = await describeBody({ before: 'Too big', fingerprints: false })
    expect(was.bodies[0].of).toEqual({ faces: 6, edges: 12 })
    const repicked = await run<Brief>('reverse.feature.update', { feature: 'Too big', set: { edges: [edge] } })
    expect(repicked.result?.status).toBe('failed')
    const smaller = await run<Brief>('reverse.feature.update', { feature: 'Too big', set: { distance: 1 } })
    expect(smaller.result?.status, smaller.result?.message).toBe('ok')
  })

  it('a shell that does not fit says where the body is too thin', async () => {
    await run<Brief>('reverse.feature.add', { feature: plateSketch('Thin', 0, 20) })
    const plate = await run<Brief>('reverse.feature.add', { feature: extrude('Thin', 1.5) })
    const shell = await run<Brief>('reverse.feature.add', { feature: { kind: 'shell', body: plate.bodies.changed![0].id, faces: [], thickness: 1 } })
    expect(shell.result?.status).toBe('failed')
    expect(shell.result?.message).toMatch(/thinner than two walls \(2 mm\) at \(/)
    expect(shell.result?.message).toMatch(/1\.5 mm thick/)
    expect(shell.result?.message).toMatch(/marked red on the part/)
  })
})

describe('sketch shapes and several features at once', () => {
  it('draws a slot and a rounded rectangle, closed and tangent', async () => {
    const slot = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Slot', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'slot', id: 1, from: [-10, 0], to: [10, 0], width: 6, fixed: true }] } },
    })
    expect(slot.solve?.ok).toBe(true)
    expect(slot.shapes![0]).toMatchObject({ kind: 'slot', sides: [1, 3], ends: [2, 4] })
    expect(slot.regions).toHaveLength(1)
    expect(slot.regions![0].area).toBeCloseTo(20 * 6 + Math.PI * 9, 1)
    const turned = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Turned slot', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'slot', id: 1, center: [0, 0], length: 20, width: 6, angleDeg: 90, fixed: true }] } },
    })
    expect(turned.regions![0].area).toBeCloseTo(20 * 6 + Math.PI * 9, 1)
    const rounded = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Rounded', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, from: [0, 0], to: [20, 10], radius: 2, fixed: true }] } },
    })
    expect(rounded.solve?.ok).toBe(true)
    expect(rounded.shapes![0]).toMatchObject({ kind: 'rectangle', sides: [1, 2, 3, 4] })
    expect(rounded.shapes![0].rounds).toHaveLength(4)
    expect(rounded.regions![0].area).toBeCloseTo(200 - (4 - Math.PI) * 4, 1)
    const e = await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', from: [0, 0], to: [20, 10], radius: 8 }] } } })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toMatch(/do not round at 8 mm/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'slot', width: 4 }] } } })).code).toBe('invalid_input')
  })

  it('rounds a rectangle up to half its shorter side — fixed, it still solves; at half, a slot — and builds it without a kink', async () => {
    type Check = { bodies: { ok: boolean; kinks?: unknown[]; warnings?: string[] }[] }
    const small = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Key', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [5.9, 2.55], radius: 1.25, fixed: true }] } },
    })
    expect(small.solve?.ok).toBe(true)
    expect(small.shapes![0].rounds).toHaveLength(4)
    expect(small.regions![0].area).toBeCloseTo(5.9 * 2.55 - (4 - Math.PI) * 1.25 ** 2, 1)
    const key = await run<Brief>('reverse.feature.add', { feature: extrude('Key', 1) })
    expect(key.result?.status, key.result?.message).toBe('ok')
    // Not fixed, and sized by dimensions the solve has to move it to.
    const free = await run<Brief>('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Free key',
        plane: { kind: 'world', axis: 'z', offset: 5 },
        sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [5.9, 2.55], radius: 1.25 }], constraints: [{ kind: 'length', entity: 1, value: 3.6 }, { kind: 'length', entity: 2, value: 0.2 }] },
      },
    })
    expect(free.solve?.ok).toBe(true)
    const freeKey = await run<Brief>('reverse.feature.add', { feature: extrude('Free key', 1) })
    expect(freeKey.result?.status, freeKey.result?.message).toBe('ok')
    for (const body of [key.bodies.changed![0], freeKey.bodies.changed![0]]) {
      const check = await run<Check>('reverse.body.check', { body: body.id, kinkDeg: 5, audit: true })
      expect(check.bodies[0].kinks ?? [], JSON.stringify(check.bodies[0].warnings)).toEqual([])
    }
    // At half the shorter side: a slot along the longer one, its round
    // dimensioned; square, a circle; past half, refused with the most.
    const slot = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Slotted', plane: { kind: 'world', axis: 'z', offset: 10 }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [5.9, 2.55], radius: 1.275, angleDeg: 90 }] } },
    })
    expect(slot.solve?.ok).toBe(true)
    expect(slot.shapes![0]).toMatchObject({ kind: 'rectangle', sides: [1, 3], ends: [2, 4] })
    expect(slot.regions![0].area).toBeCloseTo((5.9 - 2.55) * 2.55 + Math.PI * 1.275 ** 2, 1)
    const held = await run<{ sketch: { constraints: { kind: string; value?: number }[] } }>('reverse.feature.list', { feature: 'Slotted' })
    expect(held.sketch.constraints.find((c) => c.kind === 'radius')?.value).toBe(1.275)
    const round = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Round', plane: { kind: 'world', axis: 'z', offset: 12 }, sketch: { shapes: [{ kind: 'rectangle', from: [0, 0], to: [4, 4], radius: 2 }] } } })
    expect(round.regions![0].area).toBeCloseTo(Math.PI * 4, 1)
    const e = await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [5.9, 2.55], radius: 1.3 }] } } })
    expect(e.message).toMatch(/1\.275 mm, is the most/)
  })

  it('takes a shape’s points in the world, and reverse.plane.describe reads one onto the sheet', async () => {
    // A section lying across X, through x = 3: its sketch frame starts at
    // the world origin's foot, u and v as the sketch rule lays them.
    type Plane = { origin: Vec3; basisU: Vec3; basisV: Vec3; point: { at: Vec2; above: number } }
    const plane = { kind: 'world', axis: 'x', offset: 3 }
    const read = await run<Plane>('reverse.plane.describe', { plane, point: [5, 4, 7] })
    const d = [5 - read.origin[0], 4 - read.origin[1], 7 - read.origin[2]]
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    expect(read.point.at[0]).toBeCloseTo(dot(d, read.basisU), 9)
    expect(read.point.at[1]).toBeCloseTo(dot(d, read.basisV), 9)
    expect(read.point.above).toBeCloseTo(2, 9)
    // The same point as a rectangle's centre, in the world: drawn where
    // the sheet has it; a sheet point with world, or a world one without,
    // is refused.
    const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'On X', plane, sketch: { shapes: [{ kind: 'rectangle', center: [5, 4, 7], size: [2, 2], world: true, fixed: true }] } } })
    expect(made.regions![0].at[0]).toBeCloseTo(read.point.at[0], 6)
    expect(made.regions![0].at[1]).toBeCloseTo(read.point.at[1], 6)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane, sketch: { shapes: [{ kind: 'polyline', points: [[0, 0], [1, 0]], world: true }] } } })).message).toMatch(/\[x, y, z\]/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane, sketch: { shapes: [{ kind: 'polyline', points: [[0, 0, 0], [1, 0, 0]] }] } } })).message).toMatch(/world: true/)
    // A region picked by a bare point.
    const cut = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'On X', regions: [read.point.at], extent: { kind: 'distance', from: 0, to: 2 }, op: 'new' } })
    expect(cut.result?.status, cut.result?.message).toBe('ok')
    expect(cut.bodies.changed![0].volume).toBeCloseTo(8, 6)
  })

  it('reverse.feature.list shows a number an expression drives to twelve digits, the expression exact', async () => {
    await run<Brief>('reverse.feature.add', { feature: plateSketch('Tail', 0, 10) })
    await run<Brief>('reverse.feature.add', { feature: { ...extrude('Tail', 1), name: 'Tailed', exprs: { 'extent.to': '0.1 + 0.2' } } })
    type Row = { name: string; value?: number; exprs?: Record<string, string> }
    const rows = await run<{ features: Row[] }>('reverse.feature.list')
    const row = rows.features.find((f) => f.name === 'Tailed')!
    expect(row.value).toBe(0.3)
    expect(row.exprs).toEqual({ 'extent.to': '0.1 + 0.2' })
    const whole = await run<{ extent: { to: number }; exprs: Record<string, string> }>('reverse.feature.list', { feature: 'Tailed' })
    expect(whole.extent.to).toBe(0.3)
    expect(whole.exprs['extent.to']).toBe('0.1 + 0.2')
    // The stored number is the expression's own, tail and all.
    expect((useReverse.getState().features.find((f) => f.name === 'Tailed') as unknown as { extent: { to: number } }).extent.to).toBe(0.1 + 0.2)
  })

  it('reverse.feature.add takes several features in order, and says where it stopped', async () => {
    type Many = { added: Brief[]; stopped?: { index: number; kind: string; code: string; message: string } }
    const both = await run<Many>('reverse.feature.add', { features: [plateSketch('Base', 0, 20), extrude('Base', 5, 'Slab')] })
    expect(both.added).toHaveLength(2)
    expect(both.stopped).toBeUndefined()
    expect(both.added[1].feature.name).toBe('Slab')
    expect(both.added[1].bodies.changed![0].volume).toBeCloseTo(2000, 3)
    const stopped = await run<Many>('reverse.feature.add', { features: [plateSketch('Second', 10, 10), extrude('Nowhere', 5), extrude('Second', 5)] })
    expect(stopped.added).toHaveLength(1)
    expect(stopped.stopped).toMatchObject({ index: 1, kind: 'extrude', code: 'not_found', kept: ['Second'] })
    expect(useReverse.getState().features.map((f) => f.name)).toEqual(['Base', 'Slab', 'Second'])
    expect((await refused('reverse.feature.add', {})).code).toBe('invalid_input')
    expect((await refused('reverse.feature.add', { feature: plateSketch('X', 0, 1), features: [] })).code).toBe('invalid_input')
  })

  it('reverse.feature.rollback answers with the bar, and the rows only when asked', async () => {
    await boxBody(20, 0)
    type Rolled = { rollback: { at: number; of: number }; features: { id: number; name: string; status: string; sketch?: unknown }[]; bodies: { id: number; name: string }[] }
    // The bar moved: a state looked up, the sketch above it no step at all.
    expect(await run<Rolled>('reverse.feature.rollback', { to: 1 })).toEqual({ rollback: { at: 1, of: 2 }, steps: { recomputed: 0, restored: 0, played: [] } })
    const back = await run<Rolled>('reverse.feature.rollback', { to: 1, detail: 'full' })
    expect(back.features.map((f) => f.status)).toEqual(['ok', 'rolled back'])
    expect(back.features[0].sketch).toBeUndefined()
    expect(back.bodies).toEqual([])
    const forward = await run<Rolled>('reverse.feature.rollback', { to: null, detail: 'full' })
    expect(forward.rollback).toEqual({ at: 2, of: 2 })
    expect(forward.bodies).toHaveLength(1)
  })

  it('lists the features as rows, one whole, and answers a change with its id and status alone on detail none', async () => {
    await boxBody(20, 0)
    type Row = { id: number; name: string; kind: string; status: string; sketch?: unknown }
    const rows = await run<{ features: Row[]; rollback: { at: number } }>('reverse.feature.list')
    expect(rows.features.map((f) => [f.kind, f.status])).toEqual([['sketch', 'ok'], ['extrude', 'ok']])
    expect(rows.features[0].sketch).toBeUndefined()
    expect(rows.rollback.at).toBe(2)
    expect((await run<{ features: Row[] }>('reverse.feature.list', { detail: 'full' })).features[0].sketch).toBeDefined()
    expect((await run<Row>('reverse.feature.list', { feature: 'Plate 20' })).sketch).toBeDefined()
    expect((await run<Row>('reverse.feature.list', { feature: 'Plate 20', detail: 'brief' })).sketch).toBeUndefined()

    const bar = { at: 3, of: 3 }
    const added = await run<Record<string, unknown>>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Round', body: 'Solid 1', edges: [{ between: [[0, 0, 1]] }], radius: 1 }, detail: 'none' })
    // Each change says what its build played: the round's step, on the
    // extrude's kept; and what its picks landed on, at every detail.
    expect(added).toEqual({ id: 3, status: 'ok', rollback: bar, picked: [expect.objectContaining({ where: true })], steps: { recomputed: 1, restored: 1, played: [{ feature: 'Round', ms: expect.any(Number) }] } })
    expect(await run('reverse.feature.update', { feature: 'Round', set: { radius: 30 }, detail: 'none' })).toMatchObject({ id: 3, status: 'failed', rollback: bar, failed: [{ id: 3, name: 'Round' }] })
    expect(await run('reverse.feature.update', { feature: 'Round', set: { radius: 2 }, detail: 'none' })).toEqual({ id: 3, status: 'ok', rollback: bar, steps: { recomputed: 1, restored: 1, played: [{ feature: 'Round', ms: expect.any(Number) }] } })
    // Several, and inserted further up: each id and status, the bar once.
    const many = await run<Record<string, unknown>>('reverse.feature.add', {
      features: [
        { kind: 'chamfer', name: 'Bevel', body: 'Solid 1', edges: [{ between: [[0, 0, -1]] }], distance: 0.5 },
        { kind: 'fillet', name: 'Too big', body: 'Solid 1', edges: [{ between: [[1, 0, 0], [0, 1, 0]] }], radius: 50 },
      ],
      after: 'Extrude 1',
      detail: 'none',
    })
    expect(many).toMatchObject({ added: [{ id: 4, status: 'ok' }, { id: 5, status: 'failed' }], rollback: { at: 5, of: 5 }, failed: [{ id: 5 }] })
    expect(Object.keys(many).sort()).toEqual(['added', 'failed', 'rollback', 'steps'])
    // The last feature removed: the part before it, a state looked up — and,
    // since it had failed, the removal to be said in the chat.
    expect(await run('reverse.feature.remove', { feature: 'Too big', detail: 'none' })).toEqual({
      id: 5,
      status: 'removed',
      rollback: { at: 4, of: 4 },
      steps: { recomputed: 0, restored: 3, played: [] },
      removedAfterFailing: { name: 'Too big', kind: 'fillet', radius: expect.any(Number), message: expect.stringContaining('does not round'), at: expect.any(String), say: expect.stringContaining('say so in the chat') },
    })
  })

  it('suppresses the rounds for a draft of the part, and builds them again as they were', async () => {
    const box = await boxBody(20, 0)
    const volume = async () => (await run<{ bodies: Body[] }>('reverse.build')).bodies[0].volume
    const bevel = await run<Brief>('reverse.feature.add', { feature: { kind: 'chamfer', name: 'Bevel', body: box.name, edges: [{ between: [[0, 0, 1]] }], distance: 1 } })
    expect(bevel.result?.status, bevel.result?.message).toBe('ok')
    // Rounded where the bevel meets the top: edges the bevel made.
    const round = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Round', body: box.name, edges: [{ madeBy: 'Bevel', between: [[0, 0, 1]] }], radius: 0.3 } })
    expect(round.result?.status, round.result?.message).toBe('ok')
    const finished = await volume()
    expect(finished).toBeLessThan(8000 - 1)

    // Draft mode: both out, the box as it was extruded.
    type Switched = { switched: { id: number; name: string }[]; already?: number; rollback: { at: number }; failed?: { name: string; message: string }[] }
    const off = await run<Switched>('reverse.feature.suppress', { kinds: ['fillet', 'chamfer'] })
    expect(off.switched.map((f) => f.name)).toEqual(['Bevel', 'Round'])
    expect(off.failed).toBeUndefined()
    expect(await volume()).toBeCloseTo(8000, 3)
    const rows = await run<{ features: { name: string; status: string }[] }>('reverse.feature.list')
    expect(rows.features.map((f) => f.status)).toEqual(['ok', 'ok', 'suppressed', 'suppressed'])
    expect((await run<Switched>('reverse.feature.suppress', { features: ['Round'] })).already).toBe(1)
    // Back as they were — nothing picked again.
    expect((await run<Switched>('reverse.feature.suppress', { kinds: ['fillet', 'chamfer'], on: false })).switched).toHaveLength(2)
    expect(await volume()).toBeCloseTo(finished, 6)

    // The bevel alone out: the round on its edges fails as it would
    // without it, and comes back with it — undone.
    const alone = await run<{ status: string; failed?: { name: string; message: string }[] }>('reverse.feature.update', { feature: 'Bevel', set: { suppressed: true }, detail: 'none' })
    expect(alone.status).toBe('suppressed')
    expect(alone.failed).toEqual([{ id: 4, name: 'Round', message: expect.stringContaining('is gone') }])
    expect(undoLabels()).toContain('Agent: edit Bevel')
    await run('history.undo')
    expect(await volume()).toBeCloseTo(finished, 6)
    expect(useReverse.getState().features.some((f) => f.suppressed)).toBe(false)

    // Saved with the project.
    await run('reverse.feature.suppress', { features: ['Round'] })
    expect(collectReversePart()!.features.find((f) => f.name === 'Round')!.suppressed).toBe(true)
  })

  it('rounds an edge at a radius varying from one end to the other, beside edges at one radius', async () => {
    const box = await boxBody(20, 0)
    type Ends = { bodies: { edgeList: { index: number; kind: string; ends: [Vec3, Vec3] }[] }[] }
    // The top edge along X at y = −10, as describe lists its ends.
    const front = { kind: 'line', between: [[0, 0, 1], [0, -1, 0]] }
    const edge = (await run<Ends>('reverse.body.describe', { body: box.name, where: front })).bodies[0].edgeList[0]
    const [start, end] = edge.ends
    const varying = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Swell', body: box.name, edges: [{ edge: front, radius: [1, 3] }] } })
    expect(varying.result?.status, varying.result?.message).toBe('ok')
    // The top face now ends where the round begins: 1 in from the edge at
    // its first end, 3 at its other — the band it lost 2 wide on average.
    const top = (await describeBody({ body: box.name, edges: false, where: { kind: 'plane', between: [[0, 0, 1]] } })).bodies[0].faceList[0]
    expect(top.area).toBeCloseTo(400 - 20 * 2, 3)
    const rim = (await run<Ends>('reverse.body.describe', { body: box.name, where: { between: [[0, 0, 1]], madeBy: 'Swell' } })).bodies[0].edgeList.find((e) => e.kind !== 'line')!
    const off = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    const nearStart = rim.ends.reduce((a, b) => (off(b, start) < off(a, start) ? b : a))
    expect(off(nearStart, start)).toBeCloseTo(1, 4)
    expect(off(rim.ends.find((p) => p !== nearStart)!, end)).toBeCloseTo(3, 4)
    // Beside a plain edge at its own radius, in one feature, kept by the list.
    const both = await run<Brief>('reverse.feature.update', { feature: 'Swell', set: { edges: [{ kind: 'line', between: [[1, 0, 0], [0, 1, 0]] }, { edge: front, radius: [2, 1] }], radius: 1.5 } })
    expect(both.result?.status, both.result?.message).toBe('ok')
    const listed = await run<{ edges: unknown[]; radius: number; variable: { radius: number[] }[] }>('reverse.feature.list', { feature: 'Swell' })
    expect(listed.edges).toHaveLength(1)
    expect(listed.variable.map((v) => v.radius)).toEqual([[2, 1]])
    expect((await refused('reverse.feature.add', { feature: { kind: 'fillet', body: box.name, edges: [{ kind: 'line', between: [[-1, 0, 0], [0, 1, 0]] }] } })).message).toMatch(/radius: the edges given plainly need one/)
  })

  it('sweeps a profile along a path of an arc and a line — a rim that follows a curve — and writes it to STEP', async () => {
    // The path on XY: a quarter round of 20 from (20, 0) to (0, 20), then
    // 10 straight on — the arc's end and the line's start one point.
    await run('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Rim path', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'arc', c: [0, 0], r: 20, start: 0, sweep: Math.PI / 2 }, { id: 2, kind: 'line', a: [0, 20], b: [-10, 20] }] } },
    })
    // The section where the path starts, at (20, 0, 0) leaving along +Y: on
    // the XZ plane (u = Z, v = X), a round of 2 about the path.
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Rim section', plane: { kind: 'world', axis: 'y' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 20], r: 2 }] } } })
    const rim = await run<Brief>('reverse.feature.add', { feature: { kind: 'sweep', name: 'Rim', profile: 'Rim section', path: 'Rim path', op: 'new' } })
    expect(rim.result?.status, rim.result?.message).toBe('ok')
    // The section's middle rides the path: its area times the path's length.
    const length = (Math.PI / 2) * 20 + 10
    expect(rim.bodies.changed![0].volume).toBeCloseTo(Math.PI * 4 * length, 2)
    // From the section in the y = 0 plane to the line's end at x = −10.
    expect(rim.bodies.changed![0].bounds.min).toEqual([expect.closeTo(-10, 3), expect.closeTo(0, 3), expect.closeTo(-2, 3)])
    expect(rim.bodies.changed![0].bounds.max).toEqual([expect.closeTo(22, 3), expect.closeTo(22, 3), expect.closeTo(2, 3)])
    const step = await run<{ file: { bytes: Uint8Array } }>('reverse.export.step')
    expect(new TextDecoder().decode(step.file.bytes)).toContain('MANIFOLD_SOLID_BREP')

    // A section on a plane along the path, not across it: refused, the angle said.
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Askew', plane: { kind: 'world', axis: 'x', offset: 20 }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 2 }] } } })
    const askew = await run<Brief>('reverse.feature.add', { feature: { kind: 'sweep', profile: 'Askew', path: 'Rim path', op: 'new' } })
    expect(askew.result).toMatchObject({ status: 'failed', message: expect.stringContaining('90.0° off square to the path') })
    expect((await refused('reverse.feature.add', { feature: { kind: 'sweep', profile: 'Rim section' } })).code).toBe('invalid_input')
  })

  it('names the ends that miss each other when a sketch closes no region', async () => {
    type Open = { regions: unknown[]; open?: { piece: number; end: string; nearest: { piece: number; end: string } | null; gap: number | null }[] }
    // A square whose last side stops `miss` short of where it started.
    const square = (name: string, miss: number) => ({
      kind: 'sketch',
      name,
      plane: { kind: 'world', axis: 'z' },
      sketch: {
        entities: [
          { id: 1, kind: 'line', a: [0, 0], b: [10, 0] },
          { id: 2, kind: 'line', a: [10, 0], b: [10, 10] },
          { id: 3, kind: 'line', a: [10, 10], b: [0, 10] },
          { id: 4, kind: 'line', a: [0, 10], b: [0, miss] },
        ],
      },
    })
    const missed = await run<Open>('reverse.feature.add', { feature: square('Missed', 0.08) })
    expect(missed.regions).toEqual([])
    expect(missed.open).toEqual([
      { piece: 1, end: 'a', nearest: { piece: 4, end: 'b' }, gap: 0.08 },
      { piece: 4, end: 'b', nearest: { piece: 1, end: 'a' }, gap: 0.08 },
    ])
    // A gap under 0.05 mm is never meant: the end is moved onto the other.
    const snapped = await run<Open & { snapped?: unknown[] }>('reverse.feature.add', { feature: square('Snapped', 0.005) })
    expect(snapped.regions).toHaveLength(1)
    expect(snapped.snapped).toEqual([{ piece: 4, at: 'b', to: { piece: 1, at: 'a' }, by: 0.005 }])
    // A micron closes: regions are found across two — and infer joins it.
    const closed = await run<Open>('reverse.feature.add', { feature: square('Closed', 0.001) })
    expect(closed.regions).toHaveLength(1)
    expect(closed.open).toBeUndefined()
    // An open chain on purpose — a path — has its two ends named too.
    const path = await run<Open>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Path', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'polyline', id: 1, points: [[0, 0], [5, 0], [5, 5]] }] } } })
    expect(path.open?.map((o) => [o.piece, o.end])).toEqual([[1, 'a'], [2, 'b']])
  })

  it('picks an edge by the two faces either side of it, by their index', async () => {
    const box = await boxBody(20, 0)
    const listed = (await describeBody({ body: box.name, edges: false })).bodies[0].faceList
    const top = listed.find((f) => f.kind === 'plane' && f.normal![2] > 0.99)!.index
    const side = listed.find((f) => f.kind === 'plane' && f.normal![0] > 0.99)!.index
    // describe takes it as a query: the two faces, and the one edge.
    const between = (await describeBody({ body: box.name, where: { faces: [top, side] } })).bodies[0]
    expect(between.faceList.map((f) => f.index).sort()).toEqual([top, side].sort())
    expect(between.edgeList).toHaveLength(1)
    expect(between.edgeList![0].faces.sort()).toEqual([top, side].sort())
    // One face: the edges round it.
    expect((await describeBody({ body: box.name, where: { faces: [top] } })).bodies[0].edgeList).toHaveLength(4)
    // A round on that edge, picked so: built, a quarter-round's worth gone.
    const round = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: box.name, edges: [{ faces: [top, side] }], radius: 1, chain: false } })
    expect(round.result?.status, round.result?.message).toBe('ok')
    expect(round.bodies.changed![0].volume).toBeCloseTo(8000 - (1 - Math.PI / 4) * 20, 6)
    expect((await refused('reverse.body.describe', { body: box.name, where: { faces: [top, 99] } })).message).toMatch(/has no face 99/)
  })

  it('describes the frame a sketch on a plane takes, before any sketch is made', async () => {
    type Frame = { plane: string; origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3; words: string }
    const frame = (plane: Record<string, unknown>) => run<Frame>('reverse.plane.describe', { plane })
    expect(await frame({ kind: 'world', axis: 'z' })).toMatchObject({ origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0], words: expect.stringMatching(/^u runs \+X; v runs \+Y; the normal points \+Z/) })
    // As the sketch's own description has them: on YZ u is Y, on XZ u is Z.
    expect(await frame({ kind: 'world', axis: 'x', offset: 3 })).toMatchObject({ origin: [3, 0, 0], basisU: [0, 1, 0], basisV: [0, 0, 1] })
    expect(await frame({ kind: 'world', axis: 'y' })).toMatchObject({ basisU: [0, 0, 1], basisV: [1, 0, 0] })
    // A body's face, offset: the frame a sketch made there is given.
    const box = await boxBody(20, 0)
    const top = { kind: 'bodyFace', body: box.name, face: { kind: 'plane', between: [[0, 0, 1]] }, offset: 2 }
    const described = await frame(top)
    expect(described.normal).toEqual([0, 0, 1])
    expect(described.origin[2]).toBeCloseTo(22, 6)
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'On top', plane: top, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 1 }] } } })
    const made = await run<{ frame: Frame }>('reverse.feature.list', { feature: 'On top' })
    for (const k of ['origin', 'normal', 'basisU', 'basisV'] as const) expect(described[k]).toEqual(made.frame[k].map((c) => expect.closeTo(c, 4)))
    expect((await refused('reverse.plane.describe', { plane: { kind: 'world', axis: 'w' } })).code).toBe('invalid_input')
  })

  it('extrudes a level sketch along a direction of its own — an oblique prism, a taper leaning about it', async () => {
    await run<Brief>('reverse.feature.add', { feature: plateSketch('Base', 0, 10) })
    const d: Vec3 = [0.2, 0, 1]
    const n = Math.hypot(...d)
    const up = 10 / n
    type Full = { feature: { direction: Vec3 }; result: { status: string; message?: string } | null; bodies: Body[] }
    const leaning = await run<Full>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Lean', sketchId: 'Base', regions: 'all', extent: { kind: 'distance', from: 0, to: 10 }, direction: d, op: 'new' }, detail: 'full' })
    expect(leaning.result?.status, leaning.result?.message).toBe('ok')
    expect(leaning.feature.direction.map((c) => c * n)).toEqual(d.map((c) => expect.closeTo(c, 9)))
    const body = leaning.bodies[0]
    // Ten along the direction: as high as that over the plane, the base
    // the square still, the top moved over by the lean.
    expect(body.volume).toBeCloseTo(100 * up, 3)
    expect(body.bounds.min).toEqual([expect.closeTo(-5, 6), expect.closeTo(-5, 6), expect.closeTo(0, 6)])
    expect(body.bounds.max).toEqual([expect.closeTo(5 + 2 / n, 6), expect.closeTo(5, 6), expect.closeTo(up, 6)])
    const topOf = async () => (await describeBody({ body: body.id, edges: false, where: { kind: 'plane', between: [[0, 0, 1]], box: { min: [-20, -20, 1], max: [20, 20, 20] } } })).bodies[0].faceList[0]
    const top = await topOf()
    expect(top.area).toBeCloseTo(100, 6)
    expect(top.centroid).toEqual([expect.closeTo(2 / n, 6), expect.closeTo(0, 6), expect.closeTo(up, 6)])

    // Tapered 5° in: the top smaller, and every side leaning 5° off the
    // direction — about it, not about the plane's normal.
    const tapered = await run<Brief>('reverse.feature.update', { feature: 'Lean', set: { draftDeg: 5 } })
    expect(tapered.result?.status, tapered.result?.message).toBe('ok')
    expect((await topOf()).area).toBeLessThan(100 * 0.75)
    const sides = (await describeBody({ body: body.id, edges: false, where: { kind: 'plane', box: { min: [-20, -20, 1], max: [20, 20, up - 1] } } })).bodies[0].faceList
    expect(sides).toHaveLength(4)
    for (const f of sides) expect((f.normal![0] * d[0] + f.normal![1] * d[1] + f.normal![2] * d[2]) / n).toBeCloseTo(Math.sin((5 * Math.PI) / 180), 6)

    // Back to the plane's normal: the straight block.
    const straight = await run<Brief>('reverse.feature.update', { feature: 'Lean', set: { direction: null, draftDeg: 0 } })
    expect(straight.bodies.changed![0].volume).toBeCloseTo(1000, 6)
    // A direction in the plane sweeps nothing, and says so.
    const flat = await run<Brief>('reverse.feature.update', { feature: 'Lean', set: { direction: [1, 0, 0] } })
    expect(flat.result).toMatchObject({ status: 'failed', message: expect.stringContaining('along the sketch plane') })
  })

  it('offers the scan, the map, the bodies and the sketches as view toggles while its workspace is on screen, and the notes while the agent link is on', () => {
    expect(pluginToggleKeys().map((t) => t.key)).toEqual(['scan', 'map', 'bodies', 'sketches', 'notes'])
    useShell.getState().setWorkspace('reverse')
    try {
      const now = viewToggles([])
      expect([...now.keys()]).toEqual(['scan', 'map', 'bodies', 'sketches'])
      // With no viewport, nothing to put away: they read as shown.
      expect(now.get('sketches')!.shown()).toBe(true)
      usePrefs.setState({ agentLink: true })
      expect([...viewToggles([]).keys()]).toEqual(['scan', 'map', 'bodies', 'sketches', 'notes'])
      usePrefs.setState({ agentLink: false })
      expect(now.get('scan')!.shown()).toBe(true)
      now.get('scan')!.show(false)
      expect(useReverse.getState().scanHidden).toBe(true)
      now.get('scan')!.show(true)
      // The bodies put away stay in the model: their eyes are not touched,
      // and the key reads as off. Shown again with every eye shut, the
      // eyes open.
      useReverse.setState({ bodies: [{ id: 1, name: 'Solid 1', visible: true, closed: true, volume: 1, faces: 6, triangles: 12 } as never] })
      expect(now.get('bodies')!.shown()).toBe(true)
      now.get('bodies')!.show(false)
      expect(useReverse.getState().bodiesHidden).toBe(true)
      expect(useReverse.getState().bodies[0].visible).toBe(true)
      expect(now.get('bodies')!.shown()).toBe(false)
      now.get('bodies')!.show(true)
      expect(useReverse.getState().bodiesHidden).toBe(false)
      useReverse.getState().setAllBodiesVisible(false)
      expect(now.get('bodies')!.shown()).toBe(false)
      now.get('bodies')!.show(true)
      expect(useReverse.getState().bodies[0].visible).toBe(true)
      expect(now.get('map')!.shown()).toBe(false)
      now.get('map')!.show(true)
      expect(useReverse.getState().bodyMap).toBe(true)
      now.get('map')!.show(false)
    } finally {
      useShell.getState().setWorkspace('elements')
    }
    expect(viewToggles([]).size).toBe(0)
  })
})

/** A block `2 · half` square with a threaded bore through it about the z
 *  axis, as a closed triangle soup: the bore's radius a triangle wave of
 *  the helix's phase between `rLow` and `rHigh`. Closed, so the normals
 *  the loader settles on face out of the material — into the bore. */
function boreSoup(rLow: number, rHigh: number, pitch: number, length: number, half = 10, angles = 72, rows = 160): Float32Array {
  const grid: Vec3[][] = []
  for (let j = 0; j < rows; j++) {
    const z = -length / 2 + (length * j) / (rows - 1)
    const row: Vec3[] = []
    for (let k = 0; k < angles; k++) {
      const th = (k / angles) * 2 * Math.PI
      const phase = (z - (pitch * th) / (2 * Math.PI)) / pitch
      const t = phase - Math.floor(phase)
      const r = rLow + (rHigh - rLow) * (t < 0.5 ? t * 2 : 2 - t * 2)
      row.push([r * Math.cos(th), r * Math.sin(th), z])
    }
    grid.push(row)
  }
  const tris: number[] = []
  const tri = (a: Vec3, b: Vec3, c: Vec3) => tris.push(...a, ...b, ...c)
  for (let j = 0; j + 1 < rows; j++)
    for (let k = 0; k < angles; k++) {
      const k2 = (k + 1) % angles
      const a = grid[j][k], b = grid[j][k2], c = grid[j + 1][k2], d = grid[j + 1][k]
      tri(a, d, c)
      tri(a, c, b)
    }
  // The caps: from the bore's rim out to the square, and the four sides.
  const square = (k: number, z: number): Vec3 => {
    const th = (k / angles) * 2 * Math.PI
    const s = half / Math.max(Math.abs(Math.cos(th)), Math.abs(Math.sin(th)))
    return [s * Math.cos(th), s * Math.sin(th), z]
  }
  const zTop = length / 2
  for (let k = 0; k < angles; k++) {
    const k2 = (k + 1) % angles
    const top = grid[rows - 1], bottom = grid[0]
    tri(top[k], square(k, zTop), square(k2, zTop))
    tri(top[k], square(k2, zTop), top[k2])
    tri(bottom[k], square(k2, -zTop), square(k, -zTop))
    tri(bottom[k], bottom[k2], square(k2, -zTop))
  }
  const h = half
  const sides: [Vec3, Vec3, Vec3, Vec3][] = [
    [[h, -h, -zTop], [h, h, -zTop], [h, h, zTop], [h, -h, zTop]],
    [[-h, h, -zTop], [-h, -h, -zTop], [-h, -h, zTop], [-h, h, zTop]],
    [[h, h, -zTop], [-h, h, -zTop], [-h, h, zTop], [h, h, zTop]],
    [[-h, -h, -zTop], [h, -h, -zTop], [h, -h, zTop], [-h, -h, zTop]],
  ]
  for (const [a, b, c, d] of sides) {
    tri(a, b, c)
    tri(a, c, d)
  }
  return Float32Array.from(tris)
}

describe('where the scan lies off, picks by a query, and a feature inserted', () => {
  it('reverse.body.compare gathers the scan over tolerance into patches, each on one face', async () => {
    type Patch = { centroid: Vec3; box: { min: Vec3; max: Vec3 }; area: number; count: number; mean: number; extreme: number; side: string; at: Vec3; vertex: number; vertices: number[]; body: { id: number; name: string }; face: { index: number; kind: string; madeBy: { name: string } } | null }
    type Compare = { patches: Patch[]; patchesFound: number; over: number; tolerance: number; spacing?: number }
    await run<Brief>('reverse.feature.add', { feature: plateSketch('Narrow', -20, 40) })
    await run('reverse.feature.update', { feature: 'Narrow', set: { sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [38, 40], fixed: true }] } } })
    const body = await run<Brief>('reverse.feature.add', { feature: extrude('Narrow', 40) })
    expect(body.result?.status, body.result?.message).toBe('ok')
    const c = await run<Compare>('reverse.body.compare', { range: 0.1, patches: 4, patchVertices: true })
    expect(c.tolerance).toBe(0.1)
    expect(c.over).toBeGreaterThan(800)
    expect(c.patchesFound).toBeGreaterThanOrEqual(2)
    expect(c.patches).toHaveLength(Math.min(4, c.patchesFound))
    // The two largest: the scan's sides, a millimetre outside the body's.
    const sides = c.patches.slice(0, 2)
    for (const p of sides) {
      expect(p.side).toBe('outside')
      expect(p.extreme).toBeCloseTo(1, 2)
      expect(Math.abs(p.centroid[0])).toBeCloseTo(20, 0)
      expect(p.area).toBeGreaterThan(1000)
      expect(p.count).toBeGreaterThan(300)
      expect(p.face?.kind).toBe('plane')
      expect(p.face?.madeBy.name).toBe('Extrude 1')
      expect(p.vertices.length).toBeGreaterThan(0)
      expect(p.box.max[1] - p.box.min[1]).toBeGreaterThan(30)
    }
    expect(sides[0].centroid[0] * sides[1].centroid[0]).toBeLessThan(0)
    expect(sides[0].face?.index).not.toBe(sides[1].face?.index)
    // The scan's grid is a millimetre.
    expect(c.spacing).toBeCloseTo(1, 1)
    expect((await run<Compare>('reverse.body.compare', { range: 0.1, patches: 0 })).patches).toEqual([])
    const loose = await run<Compare>('reverse.body.compare', { range: 0.1, tolerance: 1.5 })
    expect(loose.over).toBe(0)
    expect(loose.patches).toEqual([])
    // One side against the other, each of its own region: two calls.
    type Region = Compare & { read: number; box: { min: Vec3; max: Vec3 } }
    const right = await run<Region>('reverse.body.compare', { range: 0.1, patches: 4, within: { min: [0.5, -30, -30], max: [30, 30, 30] } })
    const left = await run<Region>('reverse.body.compare', { range: 0.1, patches: 4, within: { min: [-30, -30, -30], max: [-0.5, 30, 30] } })
    expect(right.box).toEqual({ min: [0.5, -30, -30], max: [30, 30, 30] })
    expect(right.patches.length).toBeGreaterThan(0)
    expect(right.patches.every((p) => p.centroid[0] > 0)).toBe(true)
    expect(left.patches.every((p) => p.centroid[0] < 0)).toBe(true)
    expect(right.patches[0].extreme).toBeCloseTo(1, 2)
    const all = await run<Region>('reverse.body.compare', { range: 0.1 })
    expect(right.read).toBeLessThan(all.read)
    expect(right.read + left.read).toBeLessThanOrEqual(all.read)
  })

  it('clears every feature in one undo step', async () => {
    await boxBody(20, 0)
    await run('reverse.feature.rollback', { to: 1 })
    expect(await run('reverse.feature.clear')).toEqual({ removed: 2, rollback: { at: 0, of: 0 } })
    expect(useReverse.getState().bodies).toHaveLength(0)
    expect(undoLabels().at(-1)).toBe('Agent: remove every feature')
    await run('history.undo')
    await run('reverse.build')
    expect(useReverse.getState().features.length + useReverse.getState().rolledBack.length).toBe(2)
  })

  it('a fillet, a chamfer and a shell take their edges and faces by a query', async () => {
    const body = await boxBody(20, 0)
    const top = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [{ between: [[0, 0, 1]] }], radius: 1 } })
    expect(top.result?.status, top.result?.message).toBe('ok')
    expect(top.result?.edges).toHaveLength(4)
    const one = await run<Brief>('reverse.feature.add', { feature: { kind: 'chamfer', body: body.id, edges: [{ between: [[0, 0, -1], [1, 0, 0]] }, { between: [[0, 0, -1], [-1, 0, 0]] }], distance: 0.5, chain: false } })
    expect(one.result?.status, one.result?.message).toBe('ok')
    expect(one.result?.edges).toHaveLength(2)
    const shell = await run<Brief>('reverse.feature.add', { feature: { kind: 'shell', body: body.id, faces: [{ between: [[0, 1, 0]], kind: 'plane' }], thickness: 0.4 } })
    expect(shell.result?.status, shell.result?.message).toBe('ok')
    // Nothing answers; an empty query; a query where one is wanted.
    const none = await refused('reverse.feature.add', { feature: { kind: 'chamfer', body: body.id, edges: [{ kind: 'circle', minLength: 100 }], distance: 0.5 } })
    expect(none.code).toBe('not_found')
    expect(none.message).toMatch(/No edge of Solid 1 answers/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'chamfer', body: body.id, edges: [{}], distance: 0.5 } })).code).toBe('invalid_input')
    const many = await refused('reverse.feature.add', { feature: { kind: 'hole', body: body.id, axis: { kind: 'point', face: { kind: 'plane' } }, radius: 1 } })
    expect(many.code).toBe('invalid_input')
    expect(many.message).toMatch(/faces of Solid 1 answer/)
    expect(useReverse.getState().features.map((f) => f.kind)).toEqual(['sketch', 'extrude', 'fillet', 'chamfer', 'shell'])
  })

  it('reverse.feature.add { after } inserts a feature further up the list, the ones below rebuilt on it', async () => {
    const body = await boxBody(20, 0)
    const fillet = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [{ between: [[0, 0, 1]] }], radius: 1 } })
    expect(fillet.result?.status).toBe('ok')
    type Inserted = Brief & { insertedAfter: { id: number; name: string }; rollback: { at: number; of: number } }
    const ins = await run<Inserted>('reverse.feature.add', { after: 'Extrude 1', feature: { kind: 'chamfer', body: body.id, edges: [{ between: [[0, 0, -1]] }], distance: 1, chain: false } })
    expect(ins.insertedAfter).toEqual({ id: body.id, name: 'Extrude 1' })
    expect(ins.rollback).toEqual({ at: 4, of: 4 })
    expect(ins.result?.status, ins.result?.message).toBe('ok')
    expect(ins.result?.edges).toHaveLength(4)
    expect(ins.failed).toBeUndefined()
    expect(useReverse.getState().features.map((f) => f.name)).toEqual(['Plate 20', 'Extrude 1', 'Chamfer 1', 'Fillet 1'])
    expect(useReverse.getState().rolledBack).toEqual([])
    const built = await run<{ features: { name: string; result: { status: string } | null }[] }>('reverse.build')
    expect(built.features.map((f) => f.result?.status ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(ins.bodies.changed).toHaveLength(1)
    // One undo step for the whole insertion.
    expect(useHistory.getState().past).toHaveLength(4)
    await run('history.undo')
    expect(useReverse.getState().features.map((f) => f.name)).toEqual(['Plate 20', 'Extrude 1', 'Fillet 1'])
    expect((await refused('reverse.feature.add', { after: 'Nowhere', feature: { kind: 'chamfer', body: body.id, edges: [0], distance: 1 } })).code).toBe('not_found')
    // Several, inserted in order.
    const two = await run<Inserted & { added: Brief[] }>('reverse.feature.add', { after: 'Plate 20', features: [plateSketch('Inner', 0, 10), extrude('Inner', 5, 'Inner block')] })
    expect(two.added).toHaveLength(2)
    expect(useReverse.getState().features.map((f) => f.name)).toEqual(['Plate 20', 'Inner', 'Inner block', 'Extrude 1', 'Fillet 1'])
  })

  it('a round that fails beside a shallow crease names the crease', async () => {
    const t = 20 + 10 * Math.tan((2 * Math.PI) / 180)
    // On the ZX plane u = Z, v = X: the +X end upright to Z 10, then leaning
    // out 2° — a drafted band on an upright end.
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Side', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'polyline', points: [[0, 0], [0, 20], [10, 20], [20, t], [20, 0]], closed: true }] } } })
    const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Side', regions: 'all', extent: { kind: 'symmetric', total: 10 }, op: 'new' } })
    expect(made.result?.status, made.result?.message).toBe('ok')
    const lean: Vec3 = [Math.cos(Math.PI / 90), 0, -Math.sin(Math.PI / 90)]
    // A round down the +Y side of the end, larger than the 10 mm wide end.
    const f = await run<Brief>('reverse.feature.add', {
      feature: { kind: 'fillet', body: made.bodies.changed![0].id, edges: [{ between: [[1, 0, 0], [0, 1, 0]] }, { between: [lean, [0, 1, 0]] }], radius: 11 },
    })
    expect(f.result?.status).toBe('failed')
    expect(f.result?.message).toMatch(/a crease of 2° between two flat faces at \(20\.0, [-\d.]+, 10\.0\)/)
  })

  it('a round that fails names the tangent chain it rounds as one, and the face too small beside it', async () => {
    const body = await boxBody(20, 0)
    const corner = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [{ between: [[1, 0, 0], [0, 1, 0]] }], radius: 2, chain: false } })
    expect(corner.result?.status, corner.result?.message).toBe('ok')
    // The top edge along the +X side is tangent to the corner's arc and the
    // +Y side's top edge: a chain of three, which the kernel rounds as one.
    // (The round's own axis stands up too, so the box keeps the query to
    // the top edge and off the seam between the side and the round.)
    const chain = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [{ between: [[0, 0, 1], [1, 0, 0]], box: { min: [-11, -11, 19], max: [11, 11, 21] } }], radius: 21 } })
    expect(chain.result?.status).toBe('failed')
    expect(chain.result?.message).toMatch(/^The chain of 3 tangent edges does not round at 21 mm/)
    expect(chain.result?.message).toMatch(/rounds a tangent chain as one/)
    expect(chain.result?.message).toMatch(/drawn red on the part/)
    await run('reverse.feature.remove', { feature: chain.feature.id })
    // A sharp edge on its own, the old wording.
    const alone = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: body.id, edges: [{ between: [[0, 0, 1], [-1, 0, 0]] }], radius: 21, chain: false } })
    expect(alone.result?.status).toBe('failed')
    expect(alone.result?.message).toMatch(/^The edge does not round at 21 mm — drawn red on the part\. It rounds at up to/)
    await run('reverse.feature.remove', { feature: alone.feature.id })
    // The face too small beside an edge is named: on a second box, a step
    // 0.05 wide and 0.1 deep cut along the top's +Y rim leaves a wall of
    // 1 mm² under the top's new edge, which a 1 mm round cannot run down.
    const small = await boxBody(10, 30)
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Step', plane: { kind: 'world', axis: 'z', offset: 40 }, sketch: { shapes: [{ kind: 'rectangle', id: 1, from: [-5, 4.95], to: [5, 5], fixed: true }] } } })
    const step = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Step', regions: 'all', extent: { kind: 'distance', from: 0, to: -0.1 }, op: 'cut' } })
    expect(step.result?.status, step.result?.message).toBe('ok')
    const sliver = await run<Brief>('reverse.feature.add', { feature: { kind: 'fillet', body: small.id, edges: [{ between: [[0, 0, 1], [0, 1, 0]], box: { min: [-6, 4, 39.95], max: [6, 4.99, 40.05] } }], radius: 1, chain: false } })
    expect(sliver.result?.status).toBe('failed')
    expect(sliver.result?.message).toMatch(/^The edge does not round at 1 mm/)
    expect(sliver.result?.message).toMatch(/Beside it: a plane of 1 mm² at \(/)
    expect(sliver.result?.message).toMatch(/reverse\.body\.check lists such faces/)
  })
})

describe('the scan sliced at several heights, and a thread read off it', () => {
  it('reverse.section.stack sums up each cut and follows a chain through the heights', async () => {
    type Stack = {
      plane: { origin: Vec3; normal: Vec3 }
      offsets: number[]
      levels: { offset: number; chains: { index: number; closed: boolean; area: number | null; size: Vec2; centroid: Vec2; circle?: { radius: number }; pieces?: { kind: string }[] }[] }[]
      tracks: { id: number; levels: { offset: number; chain: number }[]; trend: { levels: number; centre: { tiltDeg: number; axis?: Vec3 }; size: { draftDeg: [number, number]; perMm: Vec2 }; radius?: { perMm: number; taperDeg: number }; round?: { radius: number; rms: number } } | null }[]
    }
    const st = await run<Stack>('reverse.section.stack', { plane: { kind: 'world', axis: 'z' }, offsets: [10, -10, 0], pieces: true })
    expect(st.offsets).toEqual([-10, 0, 10])
    expect(st.levels).toHaveLength(3)
    for (const l of st.levels) {
      expect(l.chains).toHaveLength(1)
      expect(l.chains[0].closed).toBe(true)
      expect(l.chains[0].area).toBeCloseTo(1600, -1)
      expect(l.chains[0].size[0]).toBeCloseTo(40, 1)
      expect(l.chains[0].pieces?.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line'])
    }
    expect(st.tracks).toHaveLength(1)
    expect(st.tracks[0].levels.map((l) => l.offset)).toEqual([-10, 0, 10])
    expect(st.tracks[0].trend?.levels).toBe(3)
    expect(Math.abs(st.tracks[0].trend!.centre.tiltDeg)).toBeLessThan(0.5)
    expect(Math.abs(st.tracks[0].trend!.size.draftDeg[0])).toBeLessThan(0.5)
    expect(st.tracks[0].trend!.centre.axis![2]).toBeCloseTo(1, 3)
    // Only what lies in a box; the summaries alone, as by default; a plane
    // that is not there.
    expect((await run<Stack>('reverse.section.stack', { plane: { kind: 'world', axis: 'z' }, offsets: [0], within: { min: [50, 50, -1], max: [60, 60, 1] } })).levels[0].chains).toEqual([])
    const bare = await run<Stack>('reverse.section.stack', { plane: { kind: 'world', axis: 'x' }, offsets: [0, 5] })
    expect(bare.levels[0].chains[0].pieces).toBeUndefined()
    expect((await refused('reverse.section.stack', { plane: { kind: 'plane', id: 99 }, offsets: [0] })).code).toBe('not_found')
    expect((await refused('reverse.section.stack', { plane: { kind: 'nothing' }, offsets: [0] })).code).toBe('invalid_input')
    expect(useHistory.getState().past).toHaveLength(0)
  })

  it('starts a new track where a chain changes size, opens or closes', async () => {
    // A 20 mm block on a 40 mm one, their centres in line: near centres
    // alone would make the two one track.
    const small = boxMesh(20, 20)
    for (let i = 2; i < small.length; i += 3) small[i] += 30
    const soup = new Float32Array([...boxMesh(40, 20), ...small])
    await run('scan.open', { bytes: stlBytes(soup), name: 'step.stl', discard: true })
    try {
      type Stack = { levels: { chains: { size: Vec2 }[] }[]; tracks: { levels: { offset: number }[] }[] }
      const st = await run<Stack>('reverse.section.stack', { plane: { kind: 'world', axis: 'z' }, offsets: [5, 10, 25, 30] })
      expect(st.levels.map((l) => l.chains.length)).toEqual([1, 1, 1, 1])
      expect(st.tracks.map((t) => t.levels.map((l) => l.offset))).toEqual([[5, 10], [25, 30]])
    } finally {
      await run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
    }
    const ring = { closed: true, size: [4, 4] as Vec2, area: 16 }
    expect(continuesTrack(ring, { closed: true, size: [4.5, 4.4], area: 19 })).toBe(true)
    expect(continuesTrack(ring, { closed: false, size: [4, 4], area: null })).toBe(false)
    expect(continuesTrack(ring, { closed: true, size: [6, 4], area: 24 })).toBe(false)
    // A sliver a hair wide may double its width.
    expect(continuesTrack({ closed: false, size: [30, 0.05], area: null }, { closed: false, size: [30, 0.1], area: null })).toBe(true)
  })

  it('reads a cone’s taper off a stack of circles', async () => {
    await run('scan.open', { bytes: stlBytes(coneMesh(10, 14, 20).positions), name: 'cone.stl', discard: true })
    try {
      type Stack = { levels: { chains: { circle?: { radius: number } }[] }[]; tracks: { trend: { radius?: { perMm: number; taperDeg: number }; size: { draftDeg: [number, number] }; centre: { tiltDeg: number } } | null }[] }
      const st = await run<Stack>('reverse.section.stack', { plane: { kind: 'world', axis: 'z' }, offsets: [-6, -3, 0, 3, 6], pieces: false })
      expect(st.levels.every((l) => l.chains.length === 1 && l.chains[0].circle)).toBe(true)
      expect(st.levels[0].chains[0].circle!.radius).toBeCloseTo(10.8, 0)
      expect(st.tracks).toHaveLength(1)
      const t = st.tracks[0].trend!
      expect(t.radius?.perMm).toBeCloseTo(0.2, 2)
      expect(t.radius?.taperDeg).toBeCloseTo(11.31, 0)
      expect(t.size.draftDeg[0]).toBeCloseTo(11.31, 0)
      expect(Math.abs(t.centre.tiltDeg)).toBeLessThan(0.5)
    } finally {
      await run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
    }
  })

  it('reverse.thread.read finds an M6×1 in a bore, along an axis given and along a body’s face', async () => {
    // A block with a bore of M6×1's crests and root, 8 mm long, about the z axis.
    await run('scan.open', { bytes: stlBytes(boreSoup(2.459, 3, 1, 8)), name: 'bore.stl', discard: true })
    try {
      type Read = { thread: boolean; internal: boolean | null; pitch: number | null; strength: number; minor: number; major: number; leftHanded: boolean | null; points: number; windows: { pitch: number | null }[]; agree: number; run?: { faces: number[] }; candidates: { designation: string }[]; suggested: { designation: string; size: string; standard: string } | null; feature?: Record<string, unknown>; note: string; body?: { name: string }; face?: { index: number } }
      const r = await run<Read>('reverse.thread.read', { axis: { kind: 'line', origin: [0, 0, 0], dir: [0, 0, 1], radius: 2.75, length: 8 } })
      expect(r.thread).toBe(true)
      expect(r.internal).toBe(true)
      expect(Math.abs(r.pitch! - 1)).toBeLessThan(0.04)
      expect(r.minor).toBeCloseTo(4.92, 0)
      expect(r.major).toBeCloseTo(6, 0)
      expect(r.leftHanded).toBe(false)
      expect(r.suggested?.designation).toBe('M6×1')
      expect(r.feature).toBeUndefined()
      expect(r.note).toMatch(/repeats every/)
      // The pitch read window by window; the profile only when asked.
      expect(r.windows.length).toBeGreaterThan(1)
      expect(r.agree).toBeGreaterThan(1)
      expect(r).not.toHaveProperty('profile')
      const looked = await run<Read & { profile: { z: number; r: number }[] }>('reverse.thread.read', { axis: { kind: 'line', origin: [0, 0, 0], dir: [0, 0, 1], radius: 2.75, length: 8 }, profile: true })
      expect(looked.profile.length).toBeGreaterThan(50)
      // Along the face of a body modelled through the bore: the thread
      // comes back ready to add.
      await run<Brief>('reverse.feature.add', { feature: plateSketch('Block', -4, 20) })
      const block = await run<Brief>('reverse.feature.add', { feature: extrude('Block', 8) })
      const hole = await run<Brief>('reverse.feature.add', { feature: { kind: 'hole', body: block.bodies.changed![0].id, axis: { kind: 'point', face: { between: [[0, 0, 1]] } }, radius: 2.75, depth: null } })
      expect(hole.result?.status, hole.result?.message).toBe('ok')
      const f = await run<Read>('reverse.thread.read', { axis: { kind: 'face', body: 'Solid 1', face: { kind: 'cylinder' } }, standard: 'any' })
      expect(f.body?.name).toBe('Solid 1')
      expect(f.suggested?.designation).toBe('M6×1')
      expect(f.feature).toMatchObject({ kind: 'thread', body: 'Solid 1', standard: 'metric', size: 'M6', chamfer: true })
      const added = await run<Brief>('reverse.feature.add', { feature: f.feature })
      expect(added.result?.status, added.result?.message).toBe('ok')



      // A plain bore reads no thread; an axis that misses the scan is refused.
      expect((await refused('reverse.thread.read', { axis: { kind: 'line', origin: [50, 50, 0], dir: [0, 0, 1], radius: 2.75, length: 8 } })).code).toBe('failed')
      expect((await refused('reverse.thread.read', { axis: { kind: 'element', id: 99 } })).code).toBe('not_found')
    } finally {
      await run('scan.open', { bytes: BOX, name: 'box.stl', discard: true })
    }
  })
})

describe('design intent as evidence, the audit, and projection', () => {
  type Piece = { id: number; kind: string; residual: { rms: number; max: number; points: number } | null; sigma: { angleDeg?: number; offset?: number } | null; nominal: { length?: { measured: number; nominal: number; off: number }; angleDeg?: { nominal: number } } }
  type Cand = { kind: string; pieces: number[]; off: number; unit: string; sigma: number | null; sigmas: number | null; constraints: Record<string, unknown>[]; what?: string }
  type Cands = { sketch: { name: string }; net: { angleDeg: number; mm: number }; pieces: Piece[]; candidates: Cand[] }
  type Row = { at: Vec3; off: number; unit: string; axis?: string; note: string; repair: string; faces: { index: number; kind: string; madeBy: { name: string | null }; trace?: { feature: { name: string }; sketch?: { name: string }; piece?: { id: number; kind: string }; role: string; end?: string } }[]; edges: { index: number }[] }
  type Check = { bodies: { ok: boolean; clean?: boolean; steps?: Row[]; shortEdges?: Row[]; nearAxis?: Row[]; nearParallel?: Row[]; kinks?: Row[]; warnings?: string[] }[] }
  type Made = Brief & { projected?: { id: number; kind: string; from: string }[]; skipped?: number; moved?: { count: number; pieces: { id: number; mm: number }[] }; solve?: { ok: boolean; underConstrained: number[]; fit?: { rms: number; max: number; worst: { piece: number } } } }

  it('reverse.section.fit carries each piece’s evidence and the relations the pieces nearly have', async () => {
    await run('section.cut', { across: 'XY', offset: 5, name: 'Mid' })
    type Fit = { chains: { pieces: Piece[]; candidates?: Cand[] }[] }
    const fit = await run<Fit>('reverse.section.fit', { section: 'Mid' })
    const chain = fit.chains[0]
    expect(chain.pieces.map((p) => p.id)).toEqual([1, 2, 3, 4])
    for (const p of chain.pieces) {
      expect(p.residual!.points).toBeGreaterThan(3)
      expect(p.residual!.rms).toBeLessThan(0.5)
      expect(p.sigma!.angleDeg).toBeGreaterThan(0)
      expect(p.nominal.length!.nominal).toBe(40)
      expect([0, 90, 180]).toContain(p.nominal.angleDeg!.nominal)
    }
    const cs = chain.candidates!
    // Every side is level or upright, so that is offered — and nothing
    // between the sides, which those relations say already — the sides
    // are equal, and a box squared to the axes mirrors across the part's
    // planes.
    expect(cs.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical')).toHaveLength(4)
    expect(cs.filter((c) => c.kind === 'parallel' || c.kind === 'perpendicular')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'equal' && c.what === 'length').length).toBeGreaterThanOrEqual(4)
    expect(cs.some((c) => c.kind === 'symmetric')).toBe(true)
    for (const c of cs) {
      expect(c.off).toBeLessThanOrEqual(c.unit === 'deg' ? 5 : 1)
      expect(c.constraints.length).toBeGreaterThan(0)
    }
    const bare = await run<Fit>('reverse.section.fit', { section: 'Mid', candidates: false })
    expect(bare.chains[0].candidates).toBeUndefined()
    // Brief: per piece its kind, its ends in the world and its rms alone.
    type BriefPiece = { id: number; kind: string; world: { a: Vec3; b: Vec3 }; rms: number }
    const brief = await run<{ chains: { closed: boolean; pieces: BriefPiece[]; candidates?: Cand[] }[] }>('reverse.section.fit', { section: 'Mid', brief: true })
    expect(brief.chains[0].candidates).toBeUndefined()
    expect(brief.chains[0].closed).toBe(true)
    expect(brief.chains[0].pieces.map((p) => Object.keys(p).sort())).toEqual(Array(4).fill(['id', 'kind', 'rms', 'world']))
    for (const p of brief.chains[0].pieces) {
      expect(p.world.a[2]).toBeCloseTo(5, 3)
      expect(p.rms).toBeLessThan(0.5)
    }
    const few = await run<Fit>('reverse.section.fit', { section: 'Mid', limit: 2 })
    expect(few.chains[0].candidates).toHaveLength(2)
    // Within a box over the top side, only that side is fitted, each run of
    // the chain in it a chain of its own.
    type Run = { index: number; run?: number; pieces: { a: [number, number]; b: [number, number] }[]; error?: string }
    const top = await run<{ chains: Run[] }>('reverse.section.fit', { section: 'Mid', within: { min: [-25, 15], max: [25, 25] }, candidates: false })
    expect(top.chains.length).toBeGreaterThan(0)
    for (const c of top.chains) {
      expect(c.run).toBeDefined()
      for (const p of c.pieces) expect(Math.min(p.a[1], p.b[1])).toBeGreaterThan(14)
    }
    // Asked for as two arcs, a square comes out two arcs — and their
    // residuals say it is none.
    type ArcRun = { pieces: { kind: string; residual: { rms: number } }[] }
    const arcs = await run<{ chains: ArcRun[] }>('reverse.section.fit', { section: 'Mid', arcs: 2, candidates: false })
    expect(arcs.chains[0].pieces.map((p) => p.kind)).toEqual(['arc', 'arc'])
    expect(Math.max(...arcs.chains[0].pieces.map((p) => p.residual.rms))).toBeGreaterThan(0.5)
  })

  it('reverse.sketch.candidates reads a sketch, and a relation taken says what it cost', async () => {
    await run<Brief>('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Lean',
        plane: { kind: 'world', axis: 'z', offset: 0 },
        sketch: {
          entities: [
            { id: 1, kind: 'line', a: [0, 0], b: [20, 0] },
            { id: 2, kind: 'line', a: [20, 0], b: [20.1, 20] },
            { id: 3, kind: 'line', a: [20.1, 20], b: [0, 20] },
            { id: 4, kind: 'line', a: [0, 20], b: [0, 0] },
          ],
        },
      },
    })
    const read = await run<Cands>('reverse.sketch.candidates', { sketch: 'Lean' })
    expect(read.net).toEqual({ angleDeg: 5, mm: 1 })
    expect(read.pieces).toHaveLength(4)
    // Drawn pieces have no points: no residual, no sigma — the candidates
    // still come, by the figure alone.
    expect(read.pieces[1]).toMatchObject({ id: 2, residual: null, sigma: null })
    const upright = read.candidates.find((c) => c.kind === 'vertical' && c.pieces[0] === 2)!
    expect(upright.off).toBeCloseTo(0.2865, 3)
    expect(upright.sigmas).toBeNull()
    expect(upright.constraints).toEqual([{ kind: 'vertical', entity: 2 }])
    // The level lines are held level already (inferred), and not offered.
    expect(read.candidates.some((c) => c.kind === 'horizontal' && c.pieces[0] === 1)).toBe(false)
    const one = await run<Cands>('reverse.sketch.candidates', { sketch: 'Lean', pieces: [2] })
    expect(one.pieces).toHaveLength(1)
    expect(one.candidates.every((c) => c.pieces.includes(2))).toBe(true)
    expect((await refused('reverse.sketch.candidates', { sketch: 'Lean', pieces: [9] })).code).toBe('not_found')
    expect((await refused('reverse.sketch.candidates', { sketch: 'Nowhere' })).code).toBe('not_found')
    // The relation taken: the edit says which pieces moved, and how far.
    const edited = await run<Made>('reverse.sketch.edit', { sketch: 'Lean', add: { constraints: upright.constraints } })
    expect(edited.solve?.ok).toBe(true)
    expect(edited.moved).toBeDefined()
    expect(edited.moved!.pieces.map((p) => p.id)).toContain(2)
    expect(edited.moved!.pieces[0].mm).toBeGreaterThan(0.01)
    expect(edited.moved!.pieces[0].mm).toBeLessThan(0.2)
    const again = await run<Cands>('reverse.sketch.candidates', { sketch: 'Lean' })
    expect(again.candidates.some((c) => c.kind === 'vertical' && c.pieces[0] === 2)).toBe(false)
    // On a sketch fitted to the scan the pieces carry their points: the
    // evidence is there, and so is what a relation costs the fit.
    await run('section.cut', { across: 'XY', offset: 5, name: 'Mid' })
    const fitted = await run<Made>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Fitted', plane: { kind: 'section', id: useStore.getState().sections[0].id }, sketch: { fit: {} } } })
    expect(fitted.solve?.fit).toBeDefined()
    expect(fitted.solve!.fit!.rms).toBeLessThan(0.5)
    expect(fitted.solve!.fit!.max).toBeGreaterThanOrEqual(fitted.solve!.fit!.rms)
    const evidence = await run<Cands>('reverse.sketch.candidates', { sketch: 'Fitted' })
    expect(evidence.pieces.every((p) => p.residual !== null && p.sigma !== null)).toBe(true)
    const level = evidence.candidates.find((c) => c.kind === 'horizontal')!
    expect(level.sigma).toBeGreaterThan(0)
    expect(typeof level.sigmas).toBe('number')
    const held = await run<Made>('reverse.sketch.edit', { sketch: 'Fitted', add: { constraints: level.constraints } })
    expect(held.solve?.fit?.rms).toBeLessThan(0.5)
  })

  it('reverse.body.check looks the topology over: a step between two heights, short edges, a wall off upright traced to its line', async () => {
    // A 20 mm box, and a 10 mm one joined up through its top, standing
    // 0.05 mm proud: two tops a step apart, four edges 0.05 mm long.
    await boxBody(20, 0, 10)
    await run<Brief>('reverse.feature.add', { feature: plateSketch('Plate 10', 0, 10) })
    const joined = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Proud', sketchId: 'Plate 10', regions: 'all', extent: { kind: 'distance', from: 0, to: 10.05 }, op: 'join' } })
    expect(joined.result?.status, joined.result?.message).toBe('ok')
    const stepped = joined.bodies.changed![0].id
    const checked = (await run<Check>('reverse.body.check', { body: stepped, audit: 'full' })).bodies[0]
    expect(checked.ok).toBe(true)
    expect(checked.clean).toBe(false)
    expect(checked.steps).toHaveLength(1)
    expect(checked.steps![0].off).toBeCloseTo(0.05, 4)
    expect(checked.steps![0].unit).toBe('mm')
    expect(checked.steps![0].faces.map((f) => f.trace?.role)).toEqual(['cap', 'cap'])
    expect(checked.steps![0].repair).toMatch(/end 0.05 mm apart/)
    expect(checked.shortEdges).toHaveLength(4)
    expect(checked.shortEdges![0].off).toBeCloseTo(0.05, 4)
    expect(checked.nearAxis).toBeUndefined()
    expect(checked.kinks).toBeUndefined()
    expect(checked.warnings!.some((w) => /a step apart/.test(w))).toBe(true)
    // The nets decide what is listed; without the audit there is no verdict.
    const strict = (await run<Check>('reverse.body.check', { body: stepped, stepMm: 0.01, shortEdge: 0.01, audit: true })).bodies[0]
    expect(strict.steps).toBeUndefined()
    expect(strict.shortEdges).toBeUndefined()
    expect(strict.clean).toBe(true)
    const none = (await run<Check>('reverse.body.check', { body: stepped, audit: false })).bodies[0]
    expect(none.clean).toBeUndefined()
    expect(none.steps).toBeUndefined()
    // A wall a third of a degree off upright: named, with the sketch line
    // behind it and where the relation goes.
    await run<Brief>('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Lean',
        plane: { kind: 'world', axis: 'z', offset: 20 },
        sketch: {
          entities: [
            { id: 1, kind: 'line', a: [30, 0], b: [50, 0] },
            { id: 2, kind: 'line', a: [50, 0], b: [50.1, 20] },
            { id: 3, kind: 'line', a: [50.1, 20], b: [30, 20] },
            { id: 4, kind: 'line', a: [30, 20], b: [30, 0] },
          ],
        },
      },
    })
    const lean = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Leaning', sketchId: 'Lean', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
    expect(lean.result?.status, lean.result?.message).toBe('ok')
    const audited = (await run<Check>('reverse.body.check', { body: lean.bodies.changed![0].id, audit: 'full' })).bodies[0]
    expect(audited.nearAxis).toHaveLength(1)
    const wall = audited.nearAxis![0]
    expect(wall.off).toBeCloseTo(0.2865, 3)
    expect(wall.axis).toBe('x')
    expect(wall.faces[0].trace).toMatchObject({ feature: { name: 'Leaning' }, sketch: { name: 'Lean' }, piece: { id: 2, kind: 'line' }, role: 'wall' })
    expect(wall.repair).toMatch(/line 2 of Lean leans 0\.2865°/)
    expect(audited.nearParallel).toHaveLength(1)
    expect(audited.nearParallel![0].repair).toMatch(/parallel relation between line [24] of Lean and line [24] of Lean/)
    expect(audited.warnings!.join(' ')).toMatch(/off x/)
    // Leaning 0.29° over its 20 mm, the wall moves 0.1 mm: under T/2 at a
    // T of 0.5, left out and counted; at 0.1 listed. Brief by default, the
    // faces without trace in the lists.
    type Leaned = Check['bodies'][number] & { underHalfT?: number; counts?: Record<string, number>; findings?: string[] }
    const leanId = lean.bodies.changed![0].id
    const loose = (await run<{ bodies: Leaned[] }>('reverse.body.check', { body: leanId, tolerance: 0.5, audit: true })).bodies[0]
    expect(loose.nearAxis).toBeUndefined()
    expect(loose.nearParallel).toBeUndefined()
    expect(loose.underHalfT).toBe(2)
    const tight = (await run<{ bodies: Leaned[] }>('reverse.body.check', { body: leanId, tolerance: 0.1, audit: true })).bodies[0]
    expect(tight.nearAxis).toHaveLength(1)
    expect(tight.underHalfT).toBeUndefined()
    expect(tight.nearAxis![0].faces[0].trace).toBeUndefined()
    expect(tight.nearAxis![0].repair).toMatch(/line 2 of Lean leans/)
    const brief = (await run<{ bodies: Leaned[] }>('reverse.body.check', { body: leanId })).bodies[0]
    expect(brief.nearAxis).toBeUndefined()
    expect(brief.counts).toMatchObject({ nearAxis: 1, nearParallel: 1 })
    expect(brief.findings!.some((l) => l.startsWith('nearAxis '))).toBe(true)
  })

  it('a sketch projects a face’s outline, an edge by a query and another sketch’s piece', async () => {
    const box = await boxBody(20, 0, 10)
    const top = await run<Made>('reverse.feature.add', { feature: { kind: 'sketch', name: 'On top', plane: { kind: 'bodyFace', body: box.id, face: { between: [[0, 0, 1]] } }, sketch: { project: [{ body: box.id, face: { between: [[0, 0, 1]] } }] } } })
    expect(top.projected).toHaveLength(4)
    expect(top.projected!.map((p) => p.id)).toEqual([1, 2, 3, 4])
    expect(top.projected!.every((p) => p.kind === 'line' && p.from === `the outline of a face of ${box.name}`)).toBe(true)
    expect(top.skipped).toBeUndefined()
    expect(top.regions).toHaveLength(1)
    expect(top.regions![0].area).toBeCloseTo(400, 3)
    // The projected outline closes a profile: extruded, it grows the box.
    const grown = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Up', sketchId: 'On top', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'join' } })
    expect(grown.result?.status, grown.result?.message).toBe('ok')
    expect(grown.bodies.changed![0].volume).toBeCloseTo(6000, 0)
    // The pieces come back projected, with the edge each follows.
    const listed = await run<{ features: { name: string; sketch?: { entities: { id: number; projected?: boolean; source?: unknown }[] } }[] }>('reverse.feature.list', { detail: 'full' })
    const stored = listed.features.find((f) => f.name === 'On top')!.sketch!.entities
    expect(stored).toHaveLength(4)
    expect(stored.every((e) => e.projected && e.source)).toBe(true)
    // An edge by a query, and another sketch's piece, into a sketch that
    // is there — the ids after the sketch's own.
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Side', plane: { kind: 'world', axis: 'y', offset: -10 }, sketch: { entities: [{ id: 1, kind: 'circle', c: [5, 5], r: 1 }] } } })
    const edited = await run<Made>('reverse.sketch.edit', { sketch: 'Side', add: { project: [{ body: box.id, edge: { between: [[0, 0, 1], [0, -1, 0]] } }, { sketch: 'Plate 20', pieces: [1] }] } })
    expect(edited.projected).toHaveLength(2)
    expect(edited.projected![0]).toMatchObject({ kind: 'line', from: `an edge of ${box.name}` })
    expect(edited.projected![1]).toMatchObject({ kind: 'line', from: 'piece 1 of Plate 20' })
    expect(edited.projected![0].id).toBeGreaterThan(1)
    expect(edited.projected![1].id).toBe(edited.projected![0].id + 1)
    // Refused: a sketch into itself, and a piece that is not there.
    expect((await refused('reverse.sketch.edit', { sketch: 'Side', add: { project: [{ sketch: 'Side' }] } })).code).toBe('invalid_input')
    expect((await refused('reverse.sketch.edit', { sketch: 'Side', add: { project: [{ sketch: 'Plate 20', pieces: [99] }] } })).code).toBe('invalid_input')
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { project: [{ body: 'Nobody', face: 0 }] } } })).code).toBe('not_found')
  })

  it('reverse.body.describe finds round faces by radius, and the largest first', async () => {
    await boxBody(20, 0, 10)
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Disc', plane: { kind: 'world', axis: 'z', offset: 10 }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 3 }] } } })
    const boss = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Boss', sketchId: 'Disc', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'join' } })
    expect(boss.result?.status, boss.result?.message).toBe('ok')
    const id = boss.bodies.changed![0].id
    const byRadius = await describeBody({ body: id, where: { radius: 3 }, fingerprints: false })
    expect(byRadius.bodies[0].matched).toEqual({ faces: 1, edges: 2 })
    expect(byRadius.bodies[0].faceList[0]).toMatchObject({ kind: 'cylinder' })
    expect((await describeBody({ body: id, where: { diameter: 6, sizeWithin: 0.001 }, edges: false })).bodies[0].matched.faces).toBe(1)
    expect((await describeBody({ body: id, where: { radius: 4 } })).bodies[0].matched).toEqual({ faces: 0, edges: 0 })
    const largest = await describeBody({ body: id, sort: 'largest', limit: 1, fingerprints: false })
    expect(largest.bodies[0].faceList).toHaveLength(1)
    expect(largest.bodies[0].faceList[0].area).toBeCloseTo(400, 3)
    expect(largest.bodies[0].edgeList![0].length).toBeCloseTo(20, 3)
    const smallest = await describeBody({ body: id, sort: 'smallest', limit: 1, edges: false })
    expect(smallest.bodies[0].faceList[0].kind).toBe('plane')
    expect(smallest.bodies[0].faceList[0].area).toBeCloseTo(Math.PI * 9, 2)
  })
})

