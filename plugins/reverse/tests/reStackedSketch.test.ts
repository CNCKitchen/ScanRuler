// SPDX-License-Identifier: AGPL-3.0-only
// Stacked sketches that line up, end to end in the in-process worker: a
// plate of two levels fitted into one sketch (fit.level), the walls it has
// through both drawn once and the lower level's own landing on them
// (fit.share); a T-junction that stays on its piece when a dimension
// shortens it, and a pick that grew said on its row; a pad sketched on
// the deck's face, its outline projected and the pad's fit landing on it;
// and sketch pieces handed in without an id.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { refused, run, soupOf, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { densify, prism } from '../../../tests/shellMesh'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import type { SketchFeature } from '../core/features'
import type { SketchLine } from '../core/sketch'
import { localKernel } from './reLocal'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

type Vec2 = [number, number]

/** The walls of a block standing on the rectangle lo…hi from z0 to z1 —
 *  walls only: a cut across them is all a section reads. */
const walls = (lo: Vec2, hi: Vec2, z0: number, z1: number) =>
  soupOf(
    prism(
      densify([lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]], 0.25),
      z1 - z0,
      0.004,
    ),
    [0, 0, z0],
  )

/** Two parts side by side. At y 0…10 a plate of two levels: z 0…3 out to
 *  x 30 (the wing), z 3…5 to x 20 (the deck). At y 20…30 a deck z 0…5 to
 *  x 20 with a pad z 5…7 on it to x 8, flush with the deck on three sides. */
const SCAN = (() => {
  const parts = [walls([0, 0], [30, 10], 0, 3), walls([0, 0], [20, 10], 3, 5), walls([0, 20], [20, 30], 0, 5), walls([0, 20], [8, 30], 5, 7)]
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
})()

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: stlBytes(SCAN), name: 'stacked.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

interface Fitted { chain: number; level?: number; part?: number; reaches?: { start?: number; end?: number }; closed?: boolean; pieces?: { id: number; kind: string }[]; drawn?: true }
interface Junction { run: number; end: { piece: number; at: string }; on: number; at: Vec2; held: 'end' | 'on'; collinear?: true }
interface Answer {
  feature: { id: number; name: string }
  result: { status: string; message?: string; warning?: string } | null
  fitted?: Fitted[]
  shared?: { piece: number; points: number; offMm: { mean: number; max: number }; level: number }[]
  junctions?: Junction[]
  projected?: { id: number; kind: string; from: string }[]
  regions?: { at: Vec2; area: number }[]
  offPiece?: { constraint: number; piece: number; at: string; on: number; mm: number }[]
  warnings?: { feature: number; name: string; warning: string }[]
  moved?: { count: number; pieces?: { id: number; mm: number }[] }
  ids?: number[]
  bodies: { changed?: { id: number; name: string }[] }
}

const sketchNamed = (name: string) => useReverse.getState().features.find((f): f is SketchFeature => f.kind === 'sketch' && f.name === name)!
const lines = (name: string) => sketchNamed(name).sketch.entities.filter((e): e is SketchLine => e.kind === 'line')
/** The line of a sketch lying along v = y (along u) or u = x (along v), within 0.2 mm. */
const lineAt = (name: string, along: 'u' | 'v', at: number) => lines(name).find((l) => (along === 'u' ? Math.abs(l.a[1] - at) < 0.2 && Math.abs(l.b[1] - at) < 0.2 : Math.abs(l.a[0] - at) < 0.2 && Math.abs(l.b[0] - at) < 0.2))!.id

/** Two lines of one sketch lying along each other a hair apart — a wall
 *  drawn twice. */
function drawnTwice(ls: readonly SketchLine[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < ls.length; i++)
    for (let j = i + 1; j < ls.length; j++) {
      const [l, m] = [ls[i], ls[j]]
      const d: Vec2 = [m.b[0] - m.a[0], m.b[1] - m.a[1]]
      const len = Math.hypot(d[0], d[1])
      const off = (p: Vec2) => Math.abs((p[1] - m.a[1]) * d[0] - (p[0] - m.a[0]) * d[1]) / len
      const along = (p: Vec2) => ((p[0] - m.a[0]) * d[0] + (p[1] - m.a[1]) * d[1]) / len
      const [s0, s1] = [along(l.a), along(l.b)].sort((a, b) => a - b)
      const overlap = Math.min(s1, len) - Math.max(s0, 0)
      if (off(l.a) < 0.2 && off(l.b) < 0.2 && overlap > 0.5 && (off(l.a) > 1e-6 || off(l.b) > 1e-6)) out.push([l.id, m.id])
    }
  return out
}

describe('levels in one sketch (fit.level), the walls drawn once (fit.share)', () => {
  it('fits the wing’s level into the deck’s sketch: its walls through both levels shared, its own landing on the deck’s corners', async () => {
    const deck = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Plan', plane: { kind: 'world', axis: 'z', offset: 4 }, sketch: { fit: { chains: { at: [10, 5] } } } } })
    expect(deck.fitted![0].pieces).toHaveLength(4)
    expect(deck.shared).toBeUndefined()
    const wing = await run<Answer>('reverse.sketch.edit', { sketch: 'Plan', add: { fit: { chains: { at: [10, 5] }, level: -2 } } })
    // The deck's bottom, top and left wall took the wing level's points.
    const [bottom, top, left] = [lineAt('Plan', 'u', 0), lineAt('Plan', 'u', 10), lineAt('Plan', 'v', 0)]
    expect(wing.shared!.map((s) => s.piece).sort()).toEqual([bottom, top, left].sort())
    for (const s of wing.shared!) {
      expect(s.level).toBe(-2)
      expect(s.offMm.max).toBeLessThan(0.05)
    }
    // One run, the wing's three walls, from the deck's bottom to its top.
    expect(wing.fitted).toHaveLength(1)
    expect(wing.fitted![0]).toMatchObject({ level: -2, part: 0, closed: false })
    expect([wing.fitted![0].reaches!.start, wing.fitted![0].reaches!.end].sort()).toEqual([bottom, top].sort())
    expect(wing.fitted![0].pieces!.map((p) => p.kind)).toEqual(['line', 'line', 'line'])
    // Its ends on the deck's corners, the wing's bottom and top carrying
    // the deck's on in line.
    expect(wing.junctions).toHaveLength(2)
    for (const j of wing.junctions!) {
      expect(j).toMatchObject({ run: 0, held: 'end', collinear: true })
      expect(j.at[0]).toBeCloseTo(20, 1)
    }
    expect(wing.regions!.map((r) => Math.round(r.area)).sort((a, b) => a - b)).toEqual([100, 200])
    expect(lines('Plan')).toHaveLength(7)
    expect(drawnTwice(lines('Plan'))).toEqual([])
    expect(wing.offPiece).toBeUndefined()
    // Fitted again with no sharing, every wall comes twice.
    const twice = await run<Answer>('reverse.sketch.edit', { sketch: 'Plan', add: { fit: { chains: { at: [10, 5] }, level: -2, share: 0 } } })
    expect(twice.shared).toBeUndefined()
    expect(drawnTwice(lines('Plan')).length).toBeGreaterThan(0)
  })

  it('fits the deck’s level into the wing’s sketch (route 1, the lowest level first): its own wall a T-junction held within the wing’s, which a dimension cannot pull off', async () => {
    await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Base', plane: { kind: 'world', axis: 'z', offset: 2 }, sketch: { fit: { chains: { at: [10, 5] } } } } })
    const upper = await run<Answer>('reverse.sketch.edit', { sketch: 'Base', add: { fit: { chains: { at: [10, 5] }, level: 2 } } })
    expect(upper.fitted).toHaveLength(1)
    expect(upper.fitted![0].pieces).toHaveLength(1)
    const divider = upper.fitted![0].pieces![0].id
    expect(upper.junctions!.map((j) => j.held)).toEqual(['on', 'on'])
    const [bottom, top] = [lineAt('Base', 'u', 0), lineAt('Base', 'u', 10)]
    expect(upper.junctions!.map((j) => j.on).sort()).toEqual([bottom, top].sort())
    expect(upper.regions!.map((r) => Math.round(r.area)).sort((a, b) => a - b)).toEqual([100, 200])
    const pointOns = () => sketchNamed('Base').sketch.constraints.filter((c) => c.kind === 'pointOn')
    expect(pointOns().every((c) => c.kind === 'pointOn' && c.bounded)).toBe(true)
    // The bottom shortened to 15: the divider's foot stays on it.
    const short = await run<Answer>('reverse.sketch.edit', { sketch: 'Base', add: { constraints: [{ kind: 'length', entity: bottom, value: 15 }] } })
    expect(short.offPiece).toBeUndefined()
    const b = lines('Base').find((l) => l.id === bottom)!
    const foot = lines('Base').find((l) => l.id === divider)!
    const footAt = Math.abs(foot.a[1] - b.a[1]) < Math.abs(foot.b[1] - b.a[1]) ? foot.a : foot.b
    expect(footAt[0]).toBeLessThanOrEqual(Math.max(b.a[0], b.b[0]) + 1e-3)
    expect(footAt[0]).toBeGreaterThanOrEqual(Math.min(b.a[0], b.b[0]) - 1e-3)
    // The same junctions as plain pointOns: the dimension pulls the foot
    // past the bottom's end onto its line, and offPiece says how far.
    const held = sketchNamed('Base').sketch.constraints.filter((c) => c.kind === 'pointOn')
    const plain = held.map((c) => ({ kind: 'pointOn', p: (c as { p: unknown }).p, on: (c as { on: unknown }).on }))
    await run<Answer>('reverse.sketch.edit', { sketch: 'Base', remove: { constraints: held.map((c) => c.id) }, add: { constraints: plain } })
    const length = sketchNamed('Base').sketch.constraints.find((c) => c.kind === 'length')!
    const shorter = await run<Answer>('reverse.sketch.edit', { sketch: 'Base', remove: { constraints: [length.id] }, add: { constraints: [{ kind: 'length', entity: bottom, value: 12 }] } })
    expect(shorter.offPiece!.some((o) => o.piece === divider && o.on === bottom && o.mm > 1)).toBe(true)
  })

  it('says of a pick that took in another’s, in the edit’s answer and on the row: a junction came apart', async () => {
    await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Base', plane: { kind: 'world', axis: 'z', offset: 2 }, sketch: { fit: { chains: { at: [10, 5] } } } } })
    const upper = await run<Answer>('reverse.sketch.edit', { sketch: 'Base', add: { fit: { chains: { at: [10, 5] }, level: 2 } } })
    const divider = upper.fitted![0].pieces![0].id
    const made = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Upper', sketchId: 'Base', regions: [{ at: [10, 5] }], extent: { kind: 'distance', from: -2, to: 3 }, op: 'new' } })
    expect(made.result?.status, made.result?.message).toBe('ok')
    const wing = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Wing', sketchId: 'Base', regions: [{ at: [25, 5] }], extent: { kind: 'distance', from: -2, to: 1 }, op: 'new' } })
    expect(wing.result?.status, wing.result?.message).toBe('ok')
    // The divider's foot let go of the bottom and lifted off it: the two
    // regions run into one, and Upper's row says it took in Wing's.
    const bottom = lineAt('Base', 'u', 0)
    const foot = sketchNamed('Base').sketch.constraints.find((c) => c.kind === 'pointOn' && c.p.entity === divider && 'line' in c.on && c.on.line === bottom)!
    const at = (foot as { p: { at: string } }).p.at
    const apart = await run<Answer>('reverse.sketch.edit', { sketch: 'Base', remove: { constraints: [foot.id] }, add: { constraints: [{ kind: 'distance', p: { entity: divider, at }, q: { line: bottom }, value: 0.5 }] } })
    expect(apart.regions).toHaveLength(1)
    const upperRow = apart.warnings!.find((w) => w.name === 'Upper')!
    expect(upperRow.warning).toMatch(/Upper’s region at .* now takes in Wing’s \(Upper \d+\.\d \+ Wing \d+\.\d mm²\): a junction came apart/)
    // The row itself, from the build: two features on one region.
    expect(useReverse.getState().results[made.feature.id]?.warning).toMatch(/Upper picks the same region of its sketch as Wing \(at .*, \d+\.\d mm²\): if two regions ran into one, a junction came apart/)
  })
})

describe('one profile picked twice on purpose', () => {
  it('says nothing of a junction when two cuts ask for the region alike', async () => {
    await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Bar section', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [10, 10], fixed: true }] } } })
    await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Bar', sketchId: 'Bar section', extent: { kind: 'distance', from: 0, to: 40 }, op: 'new' } })
    await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Hole', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'circle', center: [0, 0], radius: 1.5, fixed: true }] } } })
    // The same hole at each end of the bar: one region, picked alike.
    const near = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Hole near', sketchId: 'Hole', regions: 'all', op: 'cut', target: 'Bar', extent: { kind: 'distance', from: -1, to: 10 } } })
    const far = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Hole far', sketchId: 'Hole', regions: 'all', op: 'cut', target: 'Bar', extent: { kind: 'distance', from: 30, to: 41 } } })
    for (const made of [near, far]) {
      expect(made.result?.status, made.result?.message).toBe('ok')
      expect(useReverse.getState().results[made.feature.id]?.warning).toBeUndefined()
    }
  })
})

describe('stacked on a face: its outline projected, the fit landing on it', () => {
  it('starts a sketch on the deck’s top with the face’s outline, and the pad’s fit adds only its own wall, ending on the deck’s', async () => {
    await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Deck plan', plane: { kind: 'world', axis: 'z', offset: 2 }, sketch: { fit: { chains: { at: [10, 25] } } } } })
    const deck = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Deck', sketchId: 'Deck plan', extent: { kind: 'distance', from: 0, to: 3 }, op: 'new' } })
    expect(deck.result?.status, deck.result?.message).toBe('ok')
    const body = deck.bodies.changed![0]
    const top = { kind: 'bodyFace', body: body.id, face: { between: [[0, 0, 1]] } }
    // Without a level the cut is 0.25 mm into the deck, as before: the
    // deck's own outline, every wall of it the projected outline's.
    const plain = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'On deck', plane: top, sketch: { fit: { chains: { at: [10, 25] } } } } })
    expect(plain.projected!.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line'])
    expect(plain.fitted!.every((f) => f.drawn)).toBe(true)
    // At level 0.25, out of the face: the pad.
    const pad = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Pad plan', plane: top, sketch: { fit: { level: 0.25 } } } })
    expect(pad.projected).toHaveLength(4)
    const outline = new Set(pad.projected!.map((p) => p.id))
    expect(pad.shared!.every((s) => outline.has(s.piece))).toBe(true)
    expect(pad.fitted).toHaveLength(1)
    expect(pad.fitted![0].pieces).toHaveLength(1)
    expect(pad.junctions).toHaveLength(2)
    for (const j of pad.junctions!) {
      expect(j.held).toBe('on')
      expect(outline.has(j.on)).toBe(true)
      expect(j.at[0]).toBeCloseTo(8, 1)
    }
    expect(pad.junctions!.map((j) => j.at[1]).sort((x, y) => x - y)).toEqual([expect.closeTo(20, 3), expect.closeTo(30, 3)])
    expect(pad.regions!.map((r) => Math.round(r.area)).sort((a, b) => a - b)).toEqual([80, 120])
    // project: false starts empty, as a sketch on a face did before.
    const empty = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Bare', plane: top, sketch: { project: false, entities: [{ id: 1, kind: 'circle', c: [5, 25], r: 1 }] } } })
    expect(empty.projected).toBeUndefined()
    expect(sketchNamed('Bare').sketch.entities).toHaveLength(1)
  })
})

describe('sketch pieces handed in without an id', () => {
  it('gives them the next free ids and lists them, and says whose an id is when it clashes', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Ids', plane: 'XY', sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [10, 6] }] } } })
    const s = sketchNamed('Ids').sketch
    const free = s.nextId
    const added = await run<Answer>('reverse.sketch.edit', { sketch: 'Ids', add: { entities: [{ kind: 'circle', c: [0, 0], r: 1 }, { kind: 'line', a: [-2, 0], b: [2, 0], construction: true }] } })
    expect(added.ids).toEqual([free, free + 1])
    expect(sketchNamed('Ids').sketch.entities.find((e) => e.id === free)?.kind).toBe('circle')
    // The run's clash: an id a relation holds is given a free one, the
    // relation given with it following (round 19) — an id a piece holds
    // stays refused, and so, once moved up past the free ones, does an id
    // the same call's own relation holds.
    const relation = s.constraints[0].id
    const next = sketchNamed('Ids').sketch.nextId
    const moved = await run<Answer & { renumbered?: Record<string, number> }>('reverse.sketch.edit', { sketch: 'Ids', add: { entities: [{ id: relation, kind: 'circle', c: [3, 0], r: 0.5 }], constraints: [{ kind: 'radius', entity: relation, value: 0.75 }] } })
    expect(moved.renumbered).toEqual({ [String(relation)]: next })
    const circle = sketchNamed('Ids').sketch.entities.find((e) => e.id === next) as { kind: string; r: number }
    expect(circle).toMatchObject({ kind: 'circle', r: expect.closeTo(0.75, 9) })
    expect(sketchNamed('Ids').sketch.constraints.find((c) => c.id === relation)).toEqual(s.constraints[0])
    expect((await refused('reverse.sketch.edit', { sketch: 'Ids', add: { entities: [{ id: free, kind: 'point', p: [3, 0] }] } })).message).toMatch(new RegExp(`Two pieces share the id ${free}`))
    const own = await refused('reverse.sketch.edit', { sketch: 'Ids', add: { entities: [{ id: 50, kind: 'circle', c: [3, 0], r: 0.5 }], constraints: [{ id: 50, kind: 'radius', entity: free, value: 1 }] } })
    expect(own.message).toMatch(/the id 50 is taken by a relation or a dimension given with it/)
    expect(own.message).toMatch(/Ids from 51 up are free/)
  })
})
