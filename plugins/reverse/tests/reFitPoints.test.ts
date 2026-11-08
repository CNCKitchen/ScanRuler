// SPDX-License-Identifier: AGPL-3.0-only
// A sketch fitted to points typed in from a drawing, with no scan open: the
// corner of a phone given as seven points in a table, fitted as three
// tangent arcs that keep within the phone's width; a straight run into an
// arc; a fit landing tangent on the sides drawn already; and the fit's
// options that read the scan refused beside the points.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Vec2 } from '../../../src/core/flat/types'
import { useStore } from '../../../src/state/store'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import type { SketchFeature } from '../core/features'
import { ReClient } from '../core/reClient'
import { entityOf, entityPolyline, type SketchArc } from '../core/sketch'
import plugin from '../plugin'
import { useReverse } from '../state/reStore'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

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

interface Fitted {
  chain: number
  closed: boolean
  points: number
  pieces: { id: number; kind: string; r?: number }[]
  maxDeviation: number
  deviations: { point: number; mm: number }[]
  overshoot: false | { mm: number; side: string; at: Vec2 }
  heldAlong?: { end: string; side: string }[]
}
interface Junction {
  run: number
  end: { piece: number; at: string }
  on: number
  held: string
  tangent?: true
  constraints?: number[]
}
interface Answer {
  fitted: Fitted[]
  junctions?: Junction[]
  solve?: { ok: boolean }
}

/** Detail A of the drawing: a corner of the 84.10 wide phone, [u, v] mm. */
const DETAIL_A: Vec2[] = [
  [66.8, 0],
  [71.66, -0.06],
  [76.42, -1.0],
  [80.48, -3.63],
  [83.1, -7.68],
  [84.08, -12.44],
  [84.1, -17.31],
]

/** Along v = 0 to u = 20, then a quarter round of R10 about (20, 10): six
 *  points. */
const BEND: Vec2[] = [[0, 0], [10, 0], [20, 0], ...[30, 60, 90].map((deg): Vec2 => [20 + 10 * Math.sin((deg * Math.PI) / 180), 10 - 10 * Math.cos((deg * Math.PI) / 180)])]

const sketchNamed = (name: string) => useReverse.getState().features.find((f): f is SketchFeature => f.kind === 'sketch' && f.name === name)!

/** The furthest any piece of the sketch runs along +u. */
const mostU = (name: string, ids: number[]) => Math.max(...ids.flatMap((id) => entityPolyline(entityOf(sketchNamed(name).sketch, id)!, 3600).map((p) => p[0])))

/** Whether the sketch holds two pieces tangent. */
const tangent = (name: string, a: number, b: number) => sketchNamed(name).sketch.constraints.some((c) => c.kind === 'tangent' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))

describe('a sketch fitted to typed points', () => {
  it('fits Detail A as three tangent arcs within 0.08 of every point, none past the phone’s width — with no scan open', async () => {
    expect(useStore.getState().fileName).toBeFalsy()
    const out = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Corner', plane: { kind: 'world', axis: 'z' }, sketch: { fit: { points: DETAIL_A, arcs: 3 } } } })
    const f = out.fitted[0]
    expect(f.pieces.map((p) => p.kind)).toEqual(['arc', 'arc', 'arc'])
    expect(f.points).toBe(7)
    expect(f.maxDeviation).toBeLessThanOrEqual(0.08)
    expect(f.deviations).toHaveLength(7)
    expect(f.deviations[0].mm).toBe(f.maxDeviation)
    for (let i = 1; i < f.deviations.length; i++) expect(f.deviations[i].mm).toBeLessThanOrEqual(f.deviations[i - 1].mm)
    // Tangent where they meet, and nothing past u = 84.10.
    const ids = f.pieces.map((p) => p.id)
    expect(tangent('Corner', ids[0], ids[1])).toBe(true)
    expect(tangent('Corner', ids[1], ids[2])).toBe(true)
    expect(mostU('Corner', ids)).toBeLessThanOrEqual(84.1 + 0.01)
    expect(f.overshoot).toBe(false)
    // The ends meet the phone's flat sides: held along them.
    expect(f.heldAlong).toEqual(expect.arrayContaining([{ end: 'end', side: 'u+' }]))
    // The radii the answer gives are the sketch's.
    const arcs = ids.map((id) => entityOf(sketchNamed('Corner').sketch, id) as SketchArc)
    f.pieces.forEach((p, i) => expect(p.r).toBeCloseTo(arcs[i].r, 3))
    // The middle arc is the corner's round: about the hand fit's R12.
    expect(arcs[1].r).toBeGreaterThan(11)
    expect(arcs[1].r).toBeLessThan(13)
  })

  it('fits a sparse straight run into a round as a line and a tangent arc', async () => {
    const out = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Bend', plane: { kind: 'world', axis: 'z' }, sketch: { fit: { points: BEND } } } })
    const f = out.fitted[0]
    expect(f.pieces.map((p) => p.kind)).toEqual(['line', 'arc'])
    expect(f.pieces[1].r).toBeCloseTo(10, 1)
    expect(f.maxDeviation).toBeLessThan(0.01)
    expect(tangent('Bend', f.pieces[0].id, f.pieces[1].id)).toBe(true)
    expect(f.overshoot).toBe(false)
  })

  it('lands on the sides drawn already: joined and held tangent there', async () => {
    await run('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Phone',
        plane: { kind: 'world', axis: 'z' },
        sketch: {
          entities: [
            { id: 1, kind: 'line', a: [0, 0], b: [66.8, 0] },
            { id: 2, kind: 'line', a: [84.1, -17.31], b: [84.1, -60] },
          ],
        },
      },
    })
    const out = await run<Answer>('reverse.sketch.edit', { sketch: 'Phone', add: { fit: { points: [DETAIL_A], arcs: 3 } } })
    const f = out.fitted[0]
    expect(f.pieces.map((p) => p.kind)).toEqual(['arc', 'arc', 'arc'])
    expect(out.junctions?.map((j) => [j.on, j.held, j.tangent])).toEqual([
      [1, 'end', true],
      [2, 'end', true],
    ])
    const ids = f.pieces.map((p) => p.id)
    expect(tangent('Phone', 1, ids[0])).toBe(true)
    expect(tangent('Phone', ids[2], 2)).toBe(true)
    expect(f.maxDeviation).toBeLessThanOrEqual(0.08)
    expect(mostU('Phone', ids)).toBeLessThanOrEqual(84.1 + 0.01)
    expect(out.solve?.ok).toBe(true)
  })

  it('fits several chains, and a loop closed on its first point', async () => {
    const ring = Array.from({ length: 6 }, (_, k): Vec2 => [40 + 5 * Math.cos((k * Math.PI) / 3), 5 * Math.sin((k * Math.PI) / 3)])
    const out = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Two', plane: { kind: 'world', axis: 'z' }, sketch: { fit: { points: [BEND, [...ring, ring[0]]] } } } })
    expect(out.fitted.map((f) => [f.chain, f.closed])).toEqual([
      [0, false],
      [1, true],
    ])
    expect(out.fitted[0].pieces.map((p) => p.kind)).toEqual(['line', 'arc'])
    expect(out.fitted[1].pieces.map((p) => p.kind)).toEqual(['circle'])
    expect(out.fitted[1].pieces[0].r).toBeCloseTo(5, 3)
    expect(out.fitted[1].maxDeviation).toBeLessThan(1e-3)
  })

  it('refuses what reads the scan’s cut beside the points', async () => {
    const add = (fit: Record<string, unknown>) => refused('reverse.feature.add', { feature: { kind: 'sketch', name: 'No', plane: { kind: 'world', axis: 'z' }, sketch: { fit } } })
    expect((await add({ points: DETAIL_A, level: 2 })).message).toMatch(/fit\.points is fitted in place of the scan’s cut, and level reads the cut — leave it out/)
    expect((await add({ points: DETAIL_A, chains: 'largest', within: { min: [0, 0], max: [1, 1] } })).message).toMatch(/chains, within read the cut .* list of lists/)
    expect((await add({ closed: true })).message).toMatch(/fit\.closed goes with fit\.points/)
    expect((await add({ points: [[0, 0], [0, 0], [1, 1]] })).message).toMatch(/points 0 and 1 are one point/)
    expect(useReverse.getState().features).toHaveLength(0)
  })
})
