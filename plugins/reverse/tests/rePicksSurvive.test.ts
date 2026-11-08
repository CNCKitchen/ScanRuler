// SPDX-License-Identifier: AGPL-3.0-only
// Round 19's V4: picks that survive an edit. A sketch redrawn piece by
// piece — every piece taken out, a polyline with a corner more put in —
// leaves the extrude on it built, its regions taken again as they were
// asked for ("all", "largest", a point inside) or found by place, and the
// rounds and chamfers given by a where query built on the edges the query
// names now: a fifth side's, a seventh's. The queries are kept on the
// feature and run again by the build, on the body as it stands before the
// feature, with no mesh; their fingerprints are the fallback. In the kernel
// in this thread, with no scan — as reBuild.test.ts runs it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { run, refused, startHeadless, type Headless } from '../../../tests/commandKit'
import { collectReversePart, validateFeatureJson } from '../app/projectSection'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import type { EdgeInfo, FaceInfo } from '../core/buildTypes'
import type { Feature } from '../core/features'
import { replaceSketch } from '../core/parameters'
import { pickedProfiles } from '../core/profiles'
import { findRegions, regionByPlace, regionsByPick } from '../core/regions'
import { ReClient } from '../core/reClient'
import { addEntity, emptySketch, type Sketch } from '../core/sketch'
import { matchTolerance } from '../core/topo'
import { livePicks, runStoredWhere, sharpBySurfaces, storedWhere } from '../core/where'
import plugin from '../plugin'
import { useReverse } from '../state/reStore'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 240_000 })

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await session.startKernel()
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

type A = Record<string, any>
const xy = { kind: 'world', axis: 'z', offset: 0 }
const RECTANGLE = [[-10, -5], [10, -5], [10, 5], [-10, 5]]
const PENTAGON = [[-10, -5], [10, -5], [12, 0], [10, 5], [-10, 5]]
const HEPTAGON = [[-10, -5], [4, -5], [10, -5], [12, 0], [10, 5], [-10, 5], [-12, 0]]
/** The prism's top edges and its bottom ones, by a query. */
const TOP = { madeBy: 'Prism', box: { min: [-20, -20, 3.9], max: [20, 20, 4.1] } }
const BOTTOM = { madeBy: 'Prism', box: { min: [-20, -20, -0.1], max: [20, 20, 0.1] } }

const feature = (name: string) => useReverse.getState().features.find((x) => x.name === name) as A
const row = (name: string) => useReverse.getState().results[feature(name).id] as A

/** A closed outline on XY, and the prism on it, 4 mm up. */
async function prism(regions: unknown = [[0, 0]], points: number[][] = RECTANGLE): Promise<void> {
  await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Outline', plane: xy, sketch: { shapes: [{ kind: 'polyline', closed: true, fixed: true, points }] } }, detail: 'none' })
  await run('reverse.feature.add', { feature: { kind: 'extrude', name: 'Prism', sketchId: 'Outline', regions, extent: { kind: 'distance', from: 0, to: 4 }, op: 'new' }, detail: 'none' })
}

/** The outline as the run redrew it: every piece out, a polyline in. */
async function redraw(points: number[][]): Promise<void> {
  const ids = (feature('Outline').sketch.entities as A[]).map((e) => e.id)
  await run('reverse.sketch.edit', { sketch: 'Outline', remove: { pieces: ids }, add: { shapes: [{ kind: 'polyline', closed: true, fixed: true, points }] } })
  await session.settled()
}

describe('a round given by a query, on an outline redrawn', () => {
  it('keeps the prism and its round through a pentagon, and rounds all seven sides of a heptagon', async () => {
    await prism()
    const f = await run<A>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Top round', body: 'Prism', edges: [TOP], radius: 1 } })
    expect(f.result.status).toBe('ok')
    expect(row('Top round').edges).toHaveLength(4)
    // Kept as given: the point the region was picked by, the query with
    // what it found.
    expect(feature('Prism').regionPick.given).toEqual([{ at: [0, 0] }])
    expect(feature('Top round').edgesWhere).toHaveLength(1)
    expect(feature('Top round').edgesWhere[0].where.madeBy).toBe(feature('Prism').id)
    expect(feature('Top round').edgesWhere[0].found).toHaveLength(4)

    await redraw(PENTAGON)
    expect(row('Prism').status, row('Prism').message).toBe('ok')
    expect(row('Top round').status, row('Top round').message).toBe('ok')
    expect(row('Top round').edges).toHaveLength(5)

    await redraw(HEPTAGON)
    expect(row('Prism').status, row('Prism').message).toBe('ok')
    expect(row('Top round').status, row('Top round').message).toBe('ok')
    expect(row('Top round').edges).toHaveLength(7)
    // Seven sides, seven rounds along the top, and nothing said of the
    // picks: the query found them.
    expect(row('Top round').warning ?? '').not.toMatch(/found again|fingerprints/)
    // Edited in its box — the radius alone — it keeps its query.
    await run('reverse.feature.update', { feature: 'Top round', set: { radius: 0.8 } })
    expect(feature('Top round').edgesWhere).toHaveLength(1)
    expect(row('Top round').edges).toHaveLength(7)
  })

  it('runs a sharp query again at the build, with no mesh, and lets a query go when its edges are taken out by hand', async () => {
    await prism('all')
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Top round', body: 'Prism', edges: [{ ...TOP, sharp: true }], radius: 1 } })
    await redraw(PENTAGON)
    expect(row('Top round').status, row('Top round').message).toBe('ok')
    expect(row('Top round').edges).toHaveLength(5)
    // The pick set again by index: the query goes, the edges picked are
    // the feature's from then on.
    await run('reverse.feature.update', { feature: 'Top round', set: { edges: [0] } })
    expect(feature('Top round').edgesWhere).toBeUndefined()
  })

  it('a chamfer and a round given by where, added in one call, survive the outline and the prism edited in one call', async () => {
    await prism('all')
    const added = await run<A>('reverse.feature.add', {
      detail: 'none',
      features: [
        { kind: 'chamfer', name: 'Foot', body: 'Prism', edges: [BOTTOM], distance: 0.5 },
        { kind: 'fillet', name: 'Top round', body: 'Prism', edges: [TOP], radius: 1 },
      ],
    })
    expect(added.added.map((a: A) => a.status)).toEqual(['ok', 'ok'])
    // The outline handed back whole as a pentagon, the chamfer set smaller
    // and the prism's regions asked for again, in one call: each edit finds
    // the part as built before them all, and the build after the last runs
    // the queries on the pentagon.
    const both = await run<A>('reverse.feature.update', {
      features: [
        { feature: 'Outline', set: { sketch: { shapes: [{ kind: 'polyline', closed: true, fixed: true, points: PENTAGON }], constraints: [] } } },
        { feature: 'Foot', set: { distance: 0.4 } },
        { feature: 'Prism', set: { regions: 'all' } },
      ],
    })
    expect(both.stopped).toBeUndefined()
    await session.settled()
    for (const name of ['Prism', 'Foot', 'Top round']) expect(row(name).status, `${name}: ${row(name).message}`).toBe('ok')
    expect(row('Foot').edges).toHaveLength(5)
    expect(row('Top round').edges).toHaveLength(5)
  })

  it('a chamfer and a round given by where, added in calls of their own, survive outline edits in calls of their own', async () => {
    await prism('largest')
    await run('reverse.feature.add', { feature: { kind: 'chamfer', name: 'Foot', body: 'Prism', edges: [BOTTOM], distance: 0.5 } })
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Top round', body: 'Prism', edges: [TOP], radius: 1 } })
    await redraw(PENTAGON)
    await redraw(HEPTAGON)
    for (const name of ['Prism', 'Foot', 'Top round']) expect(row(name).status, `${name}: ${row(name).message}`).toBe('ok')
    expect(row('Foot').edges).toHaveLength(7)
    expect(row('Top round').edges).toHaveLength(7)
    // Saved and opened again, the queries and the region pick go with it.
    const part = collectReversePart()!
    for (const f of part.features) expect(() => validateFeatureJson(f as unknown as Record<string, unknown>)).not.toThrow()
    const saved = JSON.parse(JSON.stringify(part)) as A
    expect(saved.features.find((f: A) => f.name === 'Top round').edgesWhere[0].where.box).toEqual(TOP.box)
    expect(saved.features.find((f: A) => f.name === 'Prism').regionPick.given).toBe('largest')
  })
})

describe('regions picked by key, the sketch remade under them', () => {
  it('finds a key whose pieces were all remade by place, and says so on the row', async () => {
    await prism()
    const key = feature('Prism').regions[0]
    // The pick as keys alone, as the panel makes it.
    await run('reverse.feature.update', { feature: 'Prism', set: { regions: [key] } })
    expect(feature('Prism').regionPick).toBeUndefined()
    await redraw(PENTAGON)
    expect(row('Prism').status, row('Prism').message).toBe('ok')
    expect(feature('Prism').regions[0]).not.toBe(key)
    expect(row('Prism').warning).toMatch(/found again by where it lies/)
  })

  it('names the regions there are when a pick finds none, never “no longer closed” of a closed sketch', async () => {
    await prism()
    const key = feature('Prism').regions[0]
    await run('reverse.feature.update', { feature: 'Prism', set: { regions: [key] } })
    // Far off: nothing lies where the region was.
    await redraw(RECTANGLE.map(([x, y]) => [x + 100, y]))
    expect(row('Prism').status).toBe('failed')
    expect(row('Prism').message).not.toMatch(/no longer closed/)
    expect(row('Prism').message).toMatch(/It has 1 closed region: .*at \[100, 0\]/)
  })
})

describe('several edits in one call', () => {
  it('says which earlier feature took the body away, when a later edit has none to pick on', async () => {
    await prism()
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Top round', body: 'Prism', edges: [TOP], radius: 1 } })
    // The outline opened: the prism has no profile, and its round no body.
    const ids = (feature('Outline').sketch.entities as A[]).map((e) => e.id)
    await run('reverse.sketch.edit', { sketch: 'Outline', remove: { pieces: ids }, add: { shapes: [{ kind: 'polyline', closed: false, fixed: true, points: RECTANGLE }] } })
    await session.settled()
    expect(row('Prism').status).toBe('failed')
    const e = await refused('reverse.feature.update', { feature: 'Top round', set: { edges: [TOP] } })
    expect(e.message).toMatch(/Prism, which makes it, did not build/)
  })
})

describe('a pick found again by its fingerprint after a dimension moved it', () => {
  /** A round on the prism's top edges, picked by index: fingerprints alone. */
  async function topRound(): Promise<void> {
    const d = await run<A>('reverse.body.describe', { body: 'Prism', where: TOP })
    const top = (d.bodies[0].edgeList as A[]).map((x) => x.index)
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Top round', body: 'Prism', edges: top, radius: 1 } })
  }

  it('is not said when the strict look finds it, however far it moved', async () => {
    // 40 × 20: the strict look reaches 4.5 mm; the top edges move 3.
    await prism([[0, 0]], RECTANGLE.map(([x, y]) => [2 * x, 2 * y]))
    await topRound()
    await run('reverse.feature.update', { feature: 'Prism', set: { extent: { kind: 'distance', from: 0, to: 7 } } })
    expect(row('Top round').status, row('Top round').message).toBe('ok')
    expect(row('Top round').warning ?? '').not.toMatch(/found again/)
  })

  it('is said when only the looser look finds it', async () => {
    // 20 × 10: the strict look reaches 2.4 mm; the top edges move 6.
    await prism()
    await topRound()
    expect(row('Top round').warning ?? '').not.toMatch(/found again/)
    await run('reverse.feature.update', { feature: 'Prism', set: { extent: { kind: 'distance', from: 0, to: 10 } } })
    expect(row('Top round').status, row('Top round').message).toBe('ok')
    expect(row('Top round').warning).toMatch(/4 picks found again only loosely.*6\.0 mm off/)
  })
})

describe('a region pick taken as it was given', () => {
  it('names no key of it lost on the row', async () => {
    await prism('all')
    const key = feature('Prism').regions[0]
    const stale = [key, '98.99@40.00,0.00']
    // Keys gone stale under a pick that stands — as on a sketch the build
    // placed anew, its projected pieces taken again.
    const set = (extra: A) =>
      useReverse.setState((st) => ({ features: st.features.map((f) => (f.name === 'Prism' ? ({ ...f, regions: stale, ...extra } as Feature) : f)), buildVersion: st.buildVersion + 1 }))
    set({ regionPick: { given: 'all', keys: stale } })
    await session.settled()
    expect(row('Prism').status, row('Prism').message).toBe('ok')
    expect(row('Prism').warning ?? '').not.toMatch(/Pick the profiles again/)
    // Keys alone: the one lost is said.
    set({ regionPick: undefined })
    await session.settled()
    expect(row('Prism').warning).toMatch(/1 of 2 profiles picked is gone from the sketch/)
  })
})

// ---- the parts without the kernel ---------------------------------------------------------

/** A sketch of one closed polyline, its pieces numbered from `from`. */
function outline(points: number[][], from = 1): Sketch {
  const s = emptySketch()
  s.nextId = from
  const n = points.length
  for (let i = 0; i < n; i++) addEntity(s, { kind: 'line', a: points[i] as [number, number], b: points[(i + 1) % n] as [number, number], fixed: true } as never)
  return s
}

describe('regions taken again as asked', () => {
  it('as given, by place, or not at all', () => {
    const rect = findRegions(outline(RECTANGLE))
    const pent = findRegions(outline(PENTAGON))
    expect(rect).toHaveLength(1)
    expect(regionsByPick('all', pent)).toHaveLength(1)
    expect(regionsByPick('largest', pent)![0].key).toBe(pent[0].key)
    expect(regionsByPick([{ at: [0, 0] }], pent)![0].key).toBe(pent[0].key)
    expect(regionsByPick([{ at: [50, 0] }], pent)).toBeNull()
    expect(regionsByPick('all', [])).toBeNull()
    // The pentagon covers the whole of the rectangle; one far off, none.
    expect(regionByPlace(rect[0], pent)?.key).toBe(pent[0].key)
    expect(regionByPlace(rect[0], findRegions(outline(RECTANGLE.map(([x, y]) => [x + 15, y]))))).toBeNull()
  })

  it('writes the keys anew through replaceSketch, for a pick as given and for keys alone', () => {
    const sketch = { id: 1, kind: 'sketch', name: 'Outline', plane: { kind: 'world', axis: 'z', offset: 0 }, frame: { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }, sketch: outline(RECTANGLE), visible: true } as unknown as Feature
    const key = findRegions(outline(RECTANGLE))[0].key
    const extrude = (extra: A) => ({ id: 2, kind: 'extrude', name: 'Prism', sketchId: 1, regions: [key], extent: { kind: 'distance', from: 0, to: 4 }, draftDeg: 0, op: 'new', visible: true, ...extra }) as unknown as Feature
    // Every piece remade: numbered anew, as the run's edit numbered them.
    const pent = outline(PENTAGON, 10)
    const newKey = findRegions(pent)[0].key
    const [, asGiven] = replaceSketch([sketch, extrude({ regionPick: { given: 'all', keys: [key] } })], 1, pent) as A[]
    expect(asGiven.regions).toEqual([newKey])
    expect(asGiven.regionPick.keys).toEqual([newKey])
    expect(asGiven.regionsByPlace).toBeUndefined()
    const [, byPlace] = replaceSketch([sketch, extrude({})], 1, pent) as A[]
    expect(byPlace.regions).toEqual([newKey])
    expect(byPlace.regionsByPlace).toEqual([newKey])
    // A pick as given that the panel picked over is let go: keys again.
    const [, picked] = replaceSketch([sketch, extrude({ regionPick: { given: 'all', keys: ['9.9@0.00,0.00'] } })], 1, pent) as A[]
    expect(picked.regionsByPlace).toEqual([newKey])
    // Built: a pick that names nothing names the regions there are.
    const far = outline(RECTANGLE.map(([x, y]) => [x + 100, y]), 10)
    const lost = pickedProfiles({ regions: [key] }, { ...(sketch as A), sketch: far } as never, (f) => findRegions(f.sketch))
    expect(lost).toMatch(/None of the profile picked is in Outline as it is now .* It has 1 closed region/)
  })
})

/** A box's faces and edges as a topology: a top, a side, and the edge
 *  between them — in an order of our choosing. */
function topology(order: 'ab' | 'ba'): { faces: FaceInfo[]; edges: EdgeInfo[] } {
  const top: FaceInfo = { hash: 11, fingerprint: { kind: 'plane', centroid: [0, 0, 4], dir: [0, 0, 1], area: 200, origin: 2 } }
  const side: FaceInfo = { hash: 12, fingerprint: { kind: 'plane', centroid: [0, -5, 2], dir: [0, -1, 0], area: 80, origin: 2 } }
  const edge: EdgeInfo = { hash: 21, fingerprint: { kind: 'line', mid: [0, -5, 4], dir: [1, 0, 0], length: 20, faces: [{ kind: 'plane', dir: [0, 0, 1] }, { kind: 'plane', dir: [0, -1, 0] }], origin: 2 }, faces: [11, 12], ends: [[-10, -5, 4], [10, -5, 4]], endTangents: [[1, 0, 0], [1, 0, 0]], polyline: new Float32Array([-10, -5, 4, 0, -5, 4, 10, -5, 4]) }
  return { faces: order === 'ab' ? [top, side] : [side, top], edges: [edge] }
}

describe('queries a feature keeps', () => {
  it('name faces by fingerprint and features by id, and run again on faces numbered otherwise', () => {
    const t = topology('ab')
    const stored = storedWhere({ faces: [0, 1], madeBy: 'Prism' }, t, 'edge', () => 2)
    expect(stored.madeBy).toBe(2)
    expect(stored.faces).toEqual([t.faces[0].fingerprint, t.faces[1].fingerprint])
    const tol = matchTolerance(25)
    expect(runStoredWhere(stored, topology('ba'), { name: 'Prism' }, 'edge', () => null, tol)).toEqual([0])
    // A face it names gone: the query cannot be read there.
    const gone = topology('ab')
    gone.faces = [gone.faces[1]]
    expect(runStoredWhere(stored, gone, { name: 'Prism' }, 'edge', () => null, tol)).toBeNull()
    // Sharp asks how the faces meet, of whoever runs it.
    expect(runStoredWhere({ sharp: true }, t, { name: 'Prism' }, 'edge', () => () => false, tol)).toEqual([])
    expect(runStoredWhere({ sharp: true }, t, { name: 'Prism' }, 'edge', () => null, tol)).toBeNull()
  })

  it('stand while what they found is picked', () => {
    const a = { kind: 'line', mid: [0, 0, 0] }
    const b = { kind: 'line', mid: [1, 0, 0] }
    const c = { kind: 'line', mid: [2, 0, 0] }
    const picks = [{ where: { box: { min: [0, 0, 0], max: [1, 1, 1] } }, found: [a, b] }] as never[]
    expect(livePicks([a, b, c], picks)).toEqual({ live: picks, rest: [c] })
    // b taken out by hand: the query goes, a and c are picked as they are.
    expect(livePicks([a, c], picks)).toEqual({ live: [], rest: [a, c] })
    expect(livePicks([JSON.parse(JSON.stringify(a)), b], picks).live).toHaveLength(1)
    // The panel puts a reopened pick on the edge it finds now: near enough
    // stands for it, each find on a fingerprint of its own.
    const near = (f: A, p: A) => Math.abs(f.mid[0] - p.mid[0]) < 0.3
    const moved = { kind: 'line', mid: [1.2, 0, 0] }
    expect(livePicks([a, moved, c], picks, near as never)).toEqual({ live: picks, rest: [c] })
    expect(livePicks([a, c], picks, near as never).live).toEqual([])
  })

  it('read sharp off the faces’ surfaces, with no mesh', () => {
    const e = topology('ab').edges[0]
    const flat = (n: [number, number, number]) => () => [n, n, n]
    expect(sharpBySurfaces(e, (face) => (face === 11 ? flat([0, 0, 1])() : flat([0, -1, 0])()))).toBe(true)
    // Tangent, a reversed face's normal unturned: not sharp.
    expect(sharpBySurfaces(e, (face) => (face === 11 ? flat([0, 0, 1])() : flat([0, 0, -1])()))).toBe(false)
    // A seam, one face meeting itself: not sharp; an open edge: sharp.
    expect(sharpBySurfaces({ ...e, faces: [11, 11] }, flat([0, 0, 1]))).toBe(false)
    expect(sharpBySurfaces({ ...e, faces: [11] }, flat([0, 0, 1]))).toBe(true)
    // Half a degree off tangent — a profile fitted to points meeting its
    // flat: not sharp at the default degree, sharp asked from a quarter.
    const off = (Math.PI / 180) * 0.5
    const halfDeg = (face: number) => (face === 11 ? flat([0, 0, 1])() : flat([0, Math.sin(off), Math.cos(off)])())
    expect(sharpBySurfaces(e, halfDeg)).toBe(false)
    expect(sharpBySurfaces(e, halfDeg, 0.25)).toBe(true)
  })
})
