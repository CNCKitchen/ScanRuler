// SPDX-License-Identifier: AGPL-3.0-only
// Planes given by their geometry (issue 104): through three points — the
// normal by the right hand, or flipped — through a point square to a
// normal, and through a round face's axis; refused on three points in a
// line. Then through the commands, on the kernel: a cube's corner cut off by
// a plane through three points, the tetrahedron it takes exact, a section
// cut on such a plane, a sketch on one.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'
import { radialFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { planeFromNormal, planeThroughAxis, planeThroughPoints } from '../core/planeDefs'
import { ReClient } from '../core/reClient'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('plane geometry', () => {
  it('runs a plane through three points, its normal by the right hand, or the other way flipped', () => {
    const p = planeThroughPoints([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
    if (typeof p === 'string') throw new Error(p)
    close(p.normal, [0, 0, 1])
    close(p.origin, [0, 0, 0])
    const f = planeThroughPoints([[0, 0, 0], [1, 0, 0], [0, 1, 0]], true)
    if (typeof f === 'string') throw new Error(f)
    close(f.normal, [0, 0, -1])
    // The issue's own: through (2.5, 4, 0), (0, 2, 0), (0, 4, 3).
    const q = planeThroughPoints([[2.5, 4, 0], [0, 2, 0], [0, 4, 3]])
    if (typeof q === 'string') throw new Error(q)
    for (const pt of [[2.5, 4, 0], [0, 2, 0], [0, 4, 3]] as Vec3[]) expect(q.normal[0] * (pt[0] - 2.5) + q.normal[1] * (pt[1] - 4) + q.normal[2] * pt[2]).toBeCloseTo(0, 12)
  })

  it('refuses three points on a line, and two that are one', () => {
    expect(planeThroughPoints([[0, 0, 0], [1, 1, 1], [3, 3, 3]])).toMatch(/one line/)
    expect(planeThroughPoints([[0, 0, 0], [0, 0, 0], [3, 3, 3]])).toMatch(/one point/)
    expect(planeFromNormal([0, 0, 0], [0, 0, 0])).toMatch(/no length/)
  })

  it('runs a plane through a point square to a normal of any length', () => {
    const p = planeFromNormal([1, 2, 3], [0, 0, 5])
    if (typeof p === 'string') throw new Error(p)
    close(p.normal, [0, 0, 1])
  })

  it('runs a plane through an axis and a point off it, u out towards the point and v up the axis', () => {
    const made = planeThroughAxis({ origin: [5, 5, 0], dir: [0, 0, -2] }, [5, 9, 7], (a) => radialFrame(a, 0))
    if (typeof made === 'string') throw new Error(made)
    close(made.basisV, [0, 0, 1])
    close(made.basisU, [0, 1, 0])
    close(made.origin, [5, 5, 7])
    close(made.normal, [1, 0, 0])
    expect(planeThroughAxis({ origin: [0, 0, 0], dir: [0, 0, 1] }, [0, 0, 4], (a) => radialFrame(a, 0))).toMatch(/on the axis/)
  })
})

describe('planes by geometry through the commands', () => {
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

  /** A 10 mm cube from the origin, its body's id. */
  const cube = async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Square', plane: 'XY', sketch: { shapes: [{ kind: 'rectangle', from: [0, 0], to: [10, 10] }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Square', regions: 'all', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
    return useReverse.getState().bodies[0].id
  }
  /** The corner at (10, 10, 10) cut off 3 mm along each edge. */
  const corner: Vec3[] = [
    [10, 7, 10],
    [7, 10, 10],
    [10, 10, 7],
  ]

  it('cuts a cube’s corner off by a plane through three points, keeping the side the right-hand normal points to', async () => {
    const body = await cube()
    await run('reverse.feature.add', { feature: { kind: 'cutPlane', body, plane: { kind: 'points', points: corner }, keep: 1 } })
    const r = useReverse.getState()
    const cut = r.features.find((f) => f.kind === 'cutPlane')!
    expect(cut.kind === 'cutPlane' && cut.plane.kind).toBe('fitted')
    // (p2 − p1) × (p3 − p1) points back into the cube: the cube is kept,
    // less the tetrahedron of legs 3 — 27 / 6.
    expect(r.bodies[0].volume).toBeCloseTo(1000 - 4.5, 6)
  })

  it('flipped, the same plane keeps the corner it cut off', async () => {
    const body = await cube()
    await run('reverse.feature.add', { feature: { kind: 'cutPlane', body, plane: { kind: 'points', points: corner, flip: true }, keep: 1 } })
    expect(useReverse.getState().bodies[0].volume).toBeCloseTo(4.5, 6)
  })

  it('refuses three points on a line, with why', async () => {
    const body = await cube()
    const e = await refused('reverse.feature.add', { feature: { kind: 'cutPlane', body, plane: { kind: 'points', points: [[0, 0, 0], [1, 1, 1], [2, 2, 2]] } } })
    expect(e.message).toMatch(/points: The three points lie on one line/)
  })

  it('mirrors a boss about the plane through a bore’s axis and a point off it', async () => {
    // A Ø6 pin standing at (20, 0); the plane through its axis and (20, 5, 0)
    // is x = 20, and a block beside it mirrors across it.
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Pin', plane: 'XY', sketch: { entities: [{ kind: 'circle', c: [20, 0], r: 3 }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Pin', regions: 'all', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
    const pin = useReverse.getState().bodies[0]
    const described = await run<{ bodies: { faceList: { index: number; kind: string }[] }[] }>('reverse.body.describe', { body: pin.id, edges: false })
    const round = described.bodies[0].faceList.find((f) => f.kind === 'cylinder')!
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Block', plane: 'XY', sketch: { shapes: [{ kind: 'rectangle', from: [30, -2], to: [34, 2] }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Block', regions: 'all', extent: { kind: 'distance', from: 0, to: 4 }, op: 'new' } })
    const block = useReverse.getState().bodies.find((b) => b.id !== pin.id)!
    await run('reverse.feature.add', { feature: { kind: 'mirror', body: block.id, plane: { kind: 'faceAxis', body: pin.id, face: round.index, through: [20, 5, 0] }, join: false } })
    const copy = useReverse.getState().bodies.find((b) => b.id !== pin.id && b.id !== block.id && (b.box?.max[0] ?? 0) < 20)
    expect(copy?.box?.min[0]).toBeCloseTo(6, 6)
    expect(copy?.box?.max[0]).toBeCloseTo(10, 6)
    expect(copy?.volume).toBeCloseTo(64, 6)
  })

  it('sections the bodies on one, and sketches on a plane through a point square to a normal', async () => {
    await cube()
    // A mm further in than the corner's cut: a closed triangle, the plane's
    // normal the right hand's, back into the cube.
    const section = await run<{ plane: { normal: Vec3 }; levels: { chains: { closed: boolean; area?: number }[] }[] }>('reverse.body.section', { plane: { kind: 'points', points: corner }, offsets: [1] })
    close(section.plane.normal, [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)], 5)
    expect(section.levels[0].chains).toHaveLength(1)
    expect(section.levels[0].chains[0].closed).toBe(true)
    // The triangle grows with its distance from the corner, √3 + 1 mm.
    const side = 3 * Math.SQRT2 * ((Math.sqrt(3) + 1) / Math.sqrt(3))
    expect(Math.abs(section.levels[0].chains[0].area!)).toBeCloseTo((Math.sqrt(3) / 4) * side * side, 4)
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Tilted', plane: { kind: 'oriented', point: [0, 0, 5], normal: [0, 0, 2] }, sketch: { shapes: [{ kind: 'rectangle', from: [1, 1], to: [3, 3] }] } } })
    const sketch = useReverse.getState().features.find((f) => f.name === 'Tilted')!
    expect(sketch.kind === 'sketch' && sketch.plane.kind).toBe('fitted')
    if (sketch.kind !== 'sketch') return
    close(sketch.frame.normal, [0, 0, 1])
    close(sketch.frame.origin, [0, 0, 5])
  })
})
