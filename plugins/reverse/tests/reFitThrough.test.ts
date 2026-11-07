// SPDX-License-Identifier: AGPL-3.0-only
// A thin sheet's holes fitted seen through (fit.through): two 0.3 mm
// plates 10 mm apart, one above the other as a cage's top and bottom, each
// with a slot of half-round ends — the slots apart, so looking through
// both sees neither. The band about each plate sees that plate's slot
// alone, a depth handed in reaches the other's, and the slot comes out two
// lines and two arcs of its own radius. The scan in the in-process worker,
// the kernel in this thread — as reCommandsScan.test.ts runs it.

import * as THREE from 'three'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { refused, run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import type { SketchFeature } from '../core/features'
import { maskChains } from '../core/seeThrough'
import { useReverse } from '../state/reStore'
import { localKernel } from './reLocal'
import plugin from '../plugin'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

type Vec2 = [number, number]

/** A 40 × 30 plate 0.3 thick, its top at z, with a slot along x: centred
 *  at c, `length` between its ends' centres, radius r. */
function slottedPlate(z: number, c: Vec2, length: number, r: number): Float32Array {
  const plate = new THREE.Shape()
  plate.moveTo(-20, -15)
  plate.lineTo(20, -15)
  plate.lineTo(20, 15)
  plate.lineTo(-20, 15)
  plate.closePath()
  const slot = new THREE.Path()
  slot.moveTo(c[0] - length / 2, c[1] - r)
  slot.lineTo(c[0] + length / 2, c[1] - r)
  slot.absarc(c[0] + length / 2, c[1], r, -Math.PI / 2, Math.PI / 2, false)
  slot.lineTo(c[0] - length / 2, c[1] + r)
  slot.absarc(c[0] - length / 2, c[1], r, Math.PI / 2, (3 * Math.PI) / 2, false)
  plate.holes.push(slot)
  const g = new THREE.ExtrudeGeometry(plate, { depth: 0.3, bevelEnabled: false, curveSegments: 48 })
  g.translate(0, 0, z - 0.3)
  const soup = (g.index ? g.toNonIndexed() : g).getAttribute('position').array as Float32Array
  return Float32Array.from(soup)
}

const TOP_SLOT: Vec2 = [-8, 0]
const BOTTOM_SLOT: Vec2 = [8, 6]

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

interface Fitted { chain: number; hole?: boolean; closed?: boolean; pieces?: { id: number; kind: string }[] }
interface Answer { feature: { id: number }; fitted?: Fitted[]; through?: { depth: [number, number]; cell: number; loops: number; holes: number; skipped?: number; note?: string } }

/** The fitted chain that is a hole: its pieces' kinds, its arcs' radii and
 *  centres, read off the sketch made. */
function holeOf(a: Answer) {
  const holes = (a.fitted ?? []).filter((f) => f.hole)
  expect(holes).toHaveLength(1)
  const f = useReverse.getState().features.find((x) => x.id === a.feature.id) as SketchFeature
  const pieces = holes[0].pieces!.map((p) => f.sketch.entities.find((e) => e.id === p.id)!)
  const arcs = pieces.flatMap((e) => (e.kind === 'arc' ? [e] : []))
  return { kinds: pieces.map((e) => e.kind).sort(), radii: arcs.map((e) => e.r), centres: arcs.map((e) => e.c) }
}

describe('a sketch fitted to a thin sheet seen through (fit.through)', () => {
  beforeAll(async () => {
    plugin.install?.()
    headless = await startHeadless()
    session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
    stops.push(installReverseSession(session), session.watch())
    const top = slottedPlate(0, TOP_SLOT, 12, 2)
    const bottom = slottedPlate(-10, BOTTOM_SLOT, 8, 1.5)
    const soup = new Float32Array(top.length + bottom.length)
    soup.set(top)
    soup.set(bottom, top.length)
    await run('scan.open', { bytes: stlBytes(soup), name: 'cage.stl', discard: true })
  }, 120_000)
  afterAll(() => {
    for (const stop of stops) stop()
    headless.stop()
  })
  beforeEach(resetReverse)

  it('sees the top plate’s slot in the band about its plane, not the bottom’s', async () => {
    const a = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Top', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: true, tolerance: 0.2 } } } })
    expect(a.through).toMatchObject({ depth: [-1.5, 1.5], cell: 0.1, loops: 2, holes: 1 })
    expect(a.fitted).toHaveLength(2)
    expect(a.fitted![0]).toMatchObject({ chain: 0, closed: true })
    expect(a.fitted![0].hole).toBe(false)
    const slot = holeOf(a)
    expect(slot.kinds).toEqual(['arc', 'arc', 'line', 'line'])
    for (const r of slot.radii) expect(r).toBeCloseTo(2, 1)
    const xs = slot.centres.map((c) => c[0]).sort((p, q) => p - q)
    expect(xs[0]).toBeCloseTo(TOP_SLOT[0] - 6, 1)
    expect(xs[1]).toBeCloseTo(TOP_SLOT[0] + 6, 1)
    for (const c of slot.centres) expect(c[1]).toBeCloseTo(TOP_SLOT[1], 1)
    // Relations taken as the cut's fit takes them, the gaps joined first.
    const b = await run<Answer & { accept?: { accepted: unknown[] } }>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Held', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: true, tolerance: 0.2, closeGaps: 0.5, chains: { at: TOP_SLOT }, accept: { sigmas: 2 } } } } })
    expect(b.fitted).toHaveLength(1)
    expect(b.fitted![0].hole).toBe(true)
    expect(b.accept?.accepted.length).toBeGreaterThan(0)
  })

  it('reaches the bottom plate with a depth handed in, and on its own plane', async () => {
    const a = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Bottom', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: { depth: [-11, -9] }, tolerance: 0.2, chains: { at: BOTTOM_SLOT } } } } })
    expect(a.through?.depth).toEqual([-11, -9])
    expect(a.fitted).toHaveLength(1)
    const slot = holeOf(a)
    expect(slot.kinds).toEqual(['arc', 'arc', 'line', 'line'])
    for (const r of slot.radii) expect(r).toBeCloseTo(1.5, 1)
    // The level moves the band with it.
    const b = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Level', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: true, level: -10, tolerance: 0.2, chains: { at: BOTTOM_SLOT } } } } })
    expect(b.through?.depth).toEqual([-11.5, -8.5])
    expect(holeOf(b).radii.every((r) => Math.abs(r - 1.5) < 0.05)).toBe(true)
  })

  it('reads the same loops without a sketch (reverse.section.fit)', async () => {
    await run('section.cut', { across: 'XY', offset: -10.15, name: 'Floor' })
    const a = await run<{ chains: { hole?: boolean; closed?: boolean; pieces?: { kind: string; radius?: number }[] }[]; through?: { depth: [number, number]; holes: number } }>('reverse.section.fit', { section: 'Floor', through: true, tolerance: 0.2, brief: true })
    expect(a.through).toMatchObject({ depth: [-1.5, 1.5], holes: 1 })
    const slot = a.chains.filter((c) => c.hole)
    expect(slot).toHaveLength(1)
    expect(slot[0].pieces!.map((p) => p.kind).sort()).toEqual(['arc', 'arc', 'line', 'line'])
    for (const p of slot[0].pieces!) if (p.kind === 'arc') expect(p.radius).toBeCloseTo(1.5, 1)
  })

  it('keeps to within, and refuses what reads a side or the cut beside it', async () => {
    const a = await run<Answer>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Boxed', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: true, tolerance: 0.2, within: { min: [-17, -5], max: [1, 5] } } } } })
    expect(a.through?.loops).toBe(1)
    expect(a.fitted?.map((f) => f.hole)).toEqual([true])
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: true, skin: 'outer' } } } })).message).toMatch(/skin and facing/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: { depth: [-1, 1] }, level: 1 } } } })).message).toMatch(/leave level out/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'sketch', plane: { kind: 'world', axis: 'z', offset: 0 }, sketch: { fit: { through: { depth: [5, 9] } } } } })).message).toMatch(/no scan lies 5…9/)
  })
})

describe('a see-through mask as chains', () => {
  it('leaves specks out and counts them, and says which loops are holes', () => {
    // 20 × 20 cells set, a 6 × 6 hole in them, and a lone cell beside.
    const cols = 30
    const rows = 24
    const mask = new Uint8Array(cols * rows)
    for (let r = 2; r < 22; r++) for (let c = 2; c < 22; c++) mask[r * cols + c] = 1
    for (let r = 9; r < 15; r++) for (let c = 9; c < 15; c++) mask[r * cols + c] = 0
    mask[5 * cols + 26] = 1
    const seen = maskChains(mask, { cols, rows, cell: 0.5, u0: 0, v0: 0 })
    expect(seen.chains).toHaveLength(2)
    expect(seen.holes).toEqual([false, true])
    expect(seen.skipped).toBe(1)
    // Closed back onto its first point.
    for (const c of seen.chains) expect(c[c.length - 1]).toEqual(c[0])
  })
})
