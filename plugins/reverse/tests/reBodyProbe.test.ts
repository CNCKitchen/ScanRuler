// SPDX-License-Identifier: AGPL-3.0-only
// A part built from a drawing checked against it with no scan open:
// reverse.body.section cuts it at a plane into the kernel's own lines and
// arcs, reverse.body.probe reads a width along a ray, a thickness, and how
// far a point lies off the skin and on which side. A plate 84.10 × 117.80 ×
// 11.30 with R8 corners in plan.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../../src/state/store'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import plugin from '../plugin'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

type Vec3 = [number, number, number]
interface Face { index: number; kind: string; madeBy: { id: number; name: string | null } }
interface Piece { id: number; kind: string; a?: number[]; b?: number[]; length: number; center?: number[]; radius?: number; sweep?: number; world: Record<string, number[]>; face?: Face }
interface Chain { body: { id: number; name: string }; index: number; closed: boolean; area?: number; length: number; bounds: { min: number[]; max: number[] }; size: number[]; pieces: Piece[] }
interface Section { read: string; plane: { normal: Vec3 }; levels: { offset?: number; chains: Chain[]; missed?: string }[] }
interface Hit { t: number; at: Vec3; way: string; face: Face | null }
interface Probe {
  points?: { at: Vec3; distance: number; side: string; nearest: Vec3; face: Face }[]
  rays?: { hits: Hit[]; span: { from: number; to: number; length: number } | null; material: number; startsInside?: boolean }[]
}

const W = 84.1
const L = 117.8
const T = 11.3
const R = 8

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

/** The plate: a rectangle about the origin on XY, its corners rounded,
 *  extruded from 0 to T. */
async function plate() {
  await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Plate', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [W, L], radius: R }] } } })
  await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Plate', extent: { kind: 'distance', from: 0, to: T }, op: 'new' } })
}

describe('a part checked against its drawing, with no scan', () => {
  it('cuts the plate at mid-height into four lines and four R8 arcs, exactly', async () => {
    expect(useStore.getState().fileName).toBeFalsy()
    await plate()
    const cut = await run<Section>('reverse.body.section', { plane: 'XY', offsets: [T / 2, 50] })
    expect(cut.read).toMatch(/exact/)
    expect(cut.levels.map((l) => l.offset)).toEqual([T / 2, 50])
    expect(cut.levels[1]).toMatchObject({ chains: [], missed: expect.any(String) })
    const [chain, ...more] = cut.levels[0].chains
    expect(more).toEqual([])
    expect(chain.closed).toBe(true)
    const area = W * L - (4 - Math.PI) * R * R
    expect(Math.abs(chain.area! - area) / area).toBeLessThan(1e-3)
    expect(chain.length).toBeCloseTo(2 * (W - 2 * R) + 2 * (L - 2 * R) + 2 * Math.PI * R, 3)
    expect(chain.size[0]).toBeCloseTo(W, 4)
    expect(chain.size[1]).toBeCloseTo(L, 4)
    const lines = chain.pieces.filter((p) => p.kind === 'line')
    const arcs = chain.pieces.filter((p) => p.kind === 'arc')
    expect(lines).toHaveLength(4)
    expect(arcs).toHaveLength(4)
    expect(lines.map((p) => p.length).sort((a, b) => a - b)).toEqual([expect.closeTo(W - 2 * R, 4), expect.closeTo(W - 2 * R, 4), expect.closeTo(L - 2 * R, 4), expect.closeTo(L - 2 * R, 4)])
    for (const a of arcs) {
      expect(a.radius).toBeCloseTo(R, 5)
      // A quarter turn, counter-clockwise round a closed chain that runs so.
      expect(a.sweep).toBeCloseTo(Math.PI / 2, 5)
      expect(Math.abs(a.center![0])).toBeCloseTo(W / 2 - R, 4)
      expect(Math.abs(a.center![1])).toBeCloseTo(L / 2 - R, 4)
      expect(a.world.center[2]).toBeCloseTo(T / 2, 6)
      expect(a.face?.kind).toBe('cylinder')
    }
    for (const l of lines) expect(l.face?.kind).toBe('plane')
    // End to end: each piece starts where the one before it ends.
    chain.pieces.forEach((p, i) => {
      const before = chain.pieces[(i + chain.pieces.length - 1) % chain.pieces.length]
      expect(Math.hypot(p.world.a[0] - before.world.b[0], p.world.a[1] - before.world.b[1])).toBeLessThan(1e-4)
    })
    // Without offsets, the plane as given: a face of the body, cut where it lies.
    const atTop = await run<Section>('reverse.body.section', { plane: { kind: 'world', axis: 'z', offset: 3 } })
    expect(atTop.levels).toHaveLength(1)
    expect(atTop.levels[0].chains[0].area).toBeCloseTo(chain.area!, 4)
  })

  it('reads a width along a ray, a thickness, and points either side of the skin', async () => {
    expect(useStore.getState().fileName).toBeFalsy()
    await plate()
    const c = [W / 2 - R, L / 2 - R]
    const out = await run<Probe>('reverse.body.probe', {
      rays: [
        { from: [-100, -30, 5], dir: [2, 0, 0] },
        { from: [30, -50, 50], dir: [0, 0, -1] },
        { from: [0, 0, 5], dir: [0, 1, 0] },
      ],
      points: [
        [W / 2 + 1, 0, 5],
        [0, 0, 4],
        [c[0] + (R + 1) * Math.SQRT1_2, c[1] + (R + 1) * Math.SQRT1_2, 5],
      ],
    })
    const [across, down, fromInside] = out.rays!
    expect(across.span!.length).toBeCloseTo(W, 3)
    expect(across.material).toBeCloseTo(W, 3)
    expect(across.hits.map((h) => h.way)).toEqual(['enter', 'leave'])
    expect(across.hits.map((h) => h.face?.kind)).toEqual(['plane', 'plane'])
    expect(across.hits[0].at[0]).toBeCloseTo(-W / 2, 4)
    expect(down.span!.length).toBeCloseTo(T, 4)
    expect(down.hits[0].t).toBeCloseTo(50 - T, 4)
    expect(fromInside.startsInside).toBe(true)
    expect(fromInside.hits.map((h) => h.way)).toEqual(['leave'])
    expect(fromInside.span).toMatchObject({ from: 0, length: expect.closeTo(L / 2, 4) })

    const [outside, inside, offCorner] = out.points!
    expect(outside).toMatchObject({ side: 'outside', distance: expect.closeTo(1, 6), face: { kind: 'plane' } })
    expect(outside.nearest[0]).toBeCloseTo(W / 2, 6)
    expect(inside.side).toBe('inside')
    expect(inside.distance).toBeCloseTo(-4, 6)
    expect(inside.nearest[2]).toBeCloseTo(0, 6)
    expect(offCorner).toMatchObject({ side: 'outside', distance: expect.closeTo(1, 6), face: { kind: 'cylinder' } })
  })

  it('gives a hole as a whole circle, and a ray across it its material short of its span', async () => {
    await plate()
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Hole', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 5 }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Hole', extent: { kind: 'distance', from: -1, to: T + 1 }, op: 'cut' } })
    const cut = await run<Section>('reverse.body.section', { plane: 'XY', offsets: [T / 2] })
    const hole = cut.levels[0].chains.find((c) => c.pieces.length === 1)!
    expect(hole).toMatchObject({ closed: true, area: expect.closeTo(Math.PI * 25, 4) })
    expect(hole.pieces[0]).toMatchObject({ kind: 'circle', radius: expect.closeTo(5, 6), center: [expect.closeTo(0, 6), expect.closeTo(0, 6)], face: { kind: 'cylinder' } })
    const out = await run<Probe>('reverse.body.probe', { rays: [{ from: [-100, 0, 5], dir: [1, 0, 0] }], points: [[1, 0, 5]] })
    const [ray] = out.rays!
    expect(ray.hits.map((h) => h.way)).toEqual(['enter', 'leave', 'enter', 'leave'])
    expect(ray.hits.map((h) => h.face?.kind)).toEqual(['plane', 'cylinder', 'cylinder', 'plane'])
    expect(ray.span!.length).toBeCloseTo(W, 4)
    expect(ray.material).toBeCloseTo(W - 10, 4)
    // In the hole, 4 off its wall: outside the solid.
    expect(out.points![0]).toMatchObject({ side: 'outside', distance: expect.closeTo(4, 6), face: { kind: 'cylinder' } })
  })

  it('takes a flat face of the body as the plane, and refuses no points and no rays', async () => {
    await plate()
    const described = await run<{ bodies: { faceList: { index: number; kind: string; normal?: number[]; centroid: number[] }[] }[] }>('reverse.body.describe', { edges: false })
    const top = described.bodies[0].faceList.find((f) => f.kind === 'plane' && f.centroid[2] > T - 1e-6)!
    const cut = await run<Section>('reverse.body.section', { plane: { kind: 'bodyFace', body: 'Solid 1', face: top.index }, offsets: [-T / 2] })
    expect(cut.levels[0].chains[0].area).toBeCloseTo(W * L - (4 - Math.PI) * R * R, 3)
    expect((await refused('reverse.body.probe', {})).code).toBe('invalid_input')
    expect((await refused('reverse.body.probe', { rays: [{ from: [0, 0, 0], dir: [0, 0, 0] }] })).code).toBe('invalid_input')
  })
})
