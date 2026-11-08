// SPDX-License-Identifier: AGPL-3.0-only
// Parameters on every number: a cut's and a mirror's plane offset, a loft's
// stations — the plane of each, and the inner ones' wall — and the box a
// surface's region is read in, each driven by an expression handed to
// reverse.feature.update and following the parameter when it changes. A
// kind with no number says so, and so does a mirror on a face. On a curved
// sheet scanned in the in-process worker, the kernel in this thread — as
// reCommands.test.ts runs it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { refused, run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import type { SketchLine } from '../core/sketch'
import { localKernel } from './reLocal'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

type Vec3 = [number, number, number]
interface Body { id: number; name: string; closed: boolean; volume: number; bounds: { min: Vec3; max: Vec3 } }
interface Added { feature: { id: number; name: string }; result: { status: string; message?: string; surface?: { points: number } } | null; routed?: { sketch: { name: string }; exprs: Record<string, string> }[] }

/** A sheet z = 0.004·x² + 0.006·y² over 50 × 40 mm, its vertices 1 mm apart. */
function sheet(): Float32Array {
  const tris: number[] = []
  const at = (x: number, y: number): Vec3 => [x, y, 0.004 * x * x + 0.006 * y * y]
  for (let x = -25; x < 25; x++) for (let y = -20; y < 20; y++) tris.push(...at(x, y), ...at(x + 1, y), ...at(x + 1, y + 1), ...at(x, y), ...at(x + 1, y + 1), ...at(x, y + 1))
  return Float32Array.from(tris)
}

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: stlBytes(sheet()), name: 'sheet.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

const parameter = (name: string, expression: string) => run('reverse.parameter.add', { name, expression })
const rectangle = (name: string, z: number, size: [number, number], center: [number, number] = [0, 0]) =>
  run('reverse.feature.add', { feature: { kind: 'sketch', name, plane: { kind: 'world', axis: 'z', offset: z }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center, size }] } } })
const block = async (name: string, center: [number, number]) => {
  await rectangle(`${name} sketch`, 0, [10, 10], center)
  return run<Added>('reverse.feature.add', { feature: { kind: 'extrude', name, sketchId: `${name} sketch`, extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
}
const bodyOf = async (id: number) => (await run<{ bodies: Body[] }>('reverse.build')).bodies.find((b) => Math.floor(b.id) === id)!

describe('exprs on every kind with numbers', () => {
  it('drives a cut’s plane offset, and follows the parameter', async () => {
    await parameter('z_cut', '3')
    const made = await block('Block', [0, 0])
    const cut = await run<Added>('reverse.feature.add', { feature: { kind: 'cutPlane', name: 'Shoulder', body: made.feature.id, plane: { kind: 'world', axis: 'z', offset: 5 }, keep: -1 } })
    expect(cut.result?.status, cut.result?.message).toBe('ok')
    expect((await bodyOf(made.feature.id)).bounds.max[2]).toBeCloseTo(5, 3)
    const edited = await run<Added>('reverse.feature.update', { feature: 'Shoulder', set: { exprs: { 'plane.offset': 'z_cut + 1' } } })
    expect(edited.result?.status, edited.result?.message).toBe('ok')
    expect((await bodyOf(made.feature.id)).bounds.max[2]).toBeCloseTo(4, 3)
    // By name, as reverse.parameter.add names it.
    await run('reverse.parameter.set', { name: 'z_cut', expression: '6' })
    expect((await bodyOf(made.feature.id)).bounds.max[2]).toBeCloseTo(7, 3)
    const listed = await run<{ plane: { offset: number }; exprs: Record<string, string> }>('reverse.feature.list', { feature: 'Shoulder' })
    expect(listed).toMatchObject({ plane: { offset: 7 }, exprs: { 'plane.offset': 'z_cut + 1' } })
    // offset, as a sketch names its own, is the cut's plane.offset.
    const short = await run<Added>('reverse.feature.update', { feature: 'Shoulder', set: { exprs: { offset: 'z_cut - 1' } } })
    expect(short.result?.status, short.result?.message).toBe('ok')
    expect((await bodyOf(made.feature.id)).bounds.max[2]).toBeCloseTo(5, 3)
    expect(await run('reverse.feature.list', { feature: 'Shoulder' })).toMatchObject({ exprs: { 'plane.offset': 'z_cut - 1' } })
    expect((await refused('reverse.parameter.set', { parameter: 'z_cut', name: 'z_cut', expression: '6' })).message).toMatch(/not both/)
    // A name in the number's place is refused with the way to write it.
    expect((await refused('reverse.feature.add', { feature: { kind: 'cutPlane', body: made.feature.id, plane: { kind: 'world', axis: 'z', offset: 'z_cut' } } })).message).toMatch(/exprs: \{ "plane\.offset": "z_cut" \}/)
  })

  it('drives a mirror’s plane offset, and refuses one on a face', async () => {
    await parameter('mx', '20')
    const made = await block('Lug', [30, 0])
    const mirror = await run<Added>('reverse.feature.add', { feature: { kind: 'mirror', name: 'Mirror', body: made.feature.id, plane: { kind: 'world', axis: 'x', offset: 0 }, join: false } })
    expect(mirror.result?.status, mirror.result?.message).toBe('ok')
    expect((await bodyOf(mirror.feature.id)).bounds.min[0]).toBeCloseTo(-35, 3)
    const edited = await run<Added>('reverse.feature.update', { feature: 'Mirror', set: { exprs: { 'plane.offset': 'mx' } } })
    expect(edited.result?.status, edited.result?.message).toBe('ok')
    // About x = 20: the lug at 25…35 lands at 5…15.
    expect((await bodyOf(mirror.feature.id)).bounds.min[0]).toBeCloseTo(5, 3)
    await run('reverse.parameter.set', { parameter: 'mx', expression: '25' })
    expect((await bodyOf(mirror.feature.id)).bounds.min[0]).toBeCloseTo(15, 3)
    // A face of the body has no offset, and the answer says so.
    const onFace = await run<Added>('reverse.feature.add', { feature: { kind: 'mirror', name: 'On face', body: made.feature.id, plane: { kind: 'face', face: { kind: 'plane', between: [[1, 0, 0]] } }, join: false } })
    expect(onFace.result?.status, onFace.result?.message).toBe('ok')
    expect((await refused('reverse.feature.update', { feature: 'On face', set: { exprs: { 'plane.offset': 'mx' } } })).message).toMatch(/a face of the body, which has no offset/)
  })

  it('drives a loft’s station planes and its inner stations’ wall, written onto the sketches', async () => {
    await parameter('z_top', '12')
    await parameter('wall', '1')
    await rectangle('Foot', 0, [20, 20])
    await rectangle('Head', 10, [12, 12])
    const loft = await run<Added>('reverse.feature.add', { feature: { kind: 'loft', name: 'Boss', sections: [{ sketch: 'Foot' }, { sketch: 'Head' }], exprs: { inner: 'wall' }, op: 'new' } })
    expect(loft.result?.status, loft.result?.message).toBe('ok')
    const side = async (name: string) => {
      const listed = await run<{ sketch: { entities: SketchLine[] }; exprs?: Record<string, string>; inset?: { by: number } }>('reverse.feature.list', { feature: name })
      const us = listed.sketch.entities.filter((e) => e.kind === 'line' && !e.construction).flatMap((e) => [e.a[0], e.b[0]])
      return { width: Math.max(...us) - Math.min(...us), exprs: listed.exprs, inset: listed.inset }
    }
    expect(await side('Boss inner 1')).toMatchObject({ width: expect.closeTo(18, 4), exprs: { inset: 'wall' }, inset: { by: 1 } })

    const edited = await run<Added>('reverse.feature.update', { feature: 'Boss', set: { exprs: { 'sections.1.offset': 'z_top', inner: 'wall * 2' } } })
    expect(edited.result?.status, edited.result?.message).toBe('ok')
    expect(edited.routed!.map((r) => r.sketch.name)).toEqual(['Head', 'Boss inner 2', 'Boss inner 1', 'Boss inner 2'])
    expect((await run<{ plane: { offset: number }; exprs: Record<string, string> }>('reverse.feature.list', { feature: 'Head' })).exprs).toEqual({ offset: 'z_top' })
    expect((await bodyOf(loft.feature.id)).bounds.max[2]).toBeCloseTo(12, 3)
    expect((await side('Boss inner 2')).width).toBeCloseTo(8, 4)

    // The parameters move them: the head up, the inner stations in again
    // from their stations as they stand.
    await run('reverse.parameter.set', { parameter: 'z_top', expression: '15' })
    await run('reverse.parameter.set', { parameter: 'wall', expression: '1.5' })
    expect((await bodyOf(loft.feature.id)).bounds.max[2]).toBeCloseTo(15, 3)
    expect(await side('Boss inner 1')).toMatchObject({ width: expect.closeTo(14, 4), inset: { by: 3 } })
    expect((await side('Boss inner 2')).width).toBeCloseTo(6, 4)
    const inner = useReverse.getState().features.find((f) => f.name === 'Boss inner')!
    expect((await bodyOf(inner.id)).bounds.max[2]).toBeCloseTo(15, 3)
    expect((await refused('reverse.feature.update', { feature: 'Boss', set: { exprs: { 'sections.2.offset': 'z_top' } } })).message).toMatch(/2 sections/)
  })

  it('drives the box a surface’s region is read in: the points read again when it moves', async () => {
    await parameter('bx', '0')
    const facing = { dir: [0, 0, -1], withinDeg: 40 }
    const made = await run<Added>('reverse.feature.add', { feature: { kind: 'surface', name: 'Skin', region: { box: { min: [-25, -20, -1], max: [25, 20, 10] }, normal: facing }, exprs: { 'region.box.max.x': 'bx' } } })
    expect(made.result?.status, made.result?.message).toBe('ok')
    const half = made.result!.surface!.points
    const stored = () => useReverse.getState().features.find((f) => f.id === made.feature.id)!
    expect(stored()).toMatchObject({ regionBox: { box: { max: [0, 20, 10] } }, exprs: { 'region.box.max.x': 'bx' } })
    const edited = await run<Added>('reverse.feature.update', { feature: 'Skin', set: { exprs: { 'region.box.max.x': 'bx + 10' } } })
    expect(edited.result?.status, edited.result?.message).toBe('ok')
    expect(edited.result!.surface!.points).toBeGreaterThan(half * 1.3)
    await run('reverse.parameter.set', { parameter: 'bx', expression: '-10' })
    const s = stored()
    expect(s.kind === 'surface' && s.regionStale).toBeFalsy()
    expect(s.kind === 'surface' && s.region.length).toBe(half)
    expect(useReverse.getState().results[made.feature.id]?.status).toBe('ok')
    // Points given as a list have no box to drive.
    const listed = await run<Added>('reverse.feature.add', { feature: { kind: 'surface', name: 'Listed', region: Array.from({ length: 40 }, (_, i) => i * 7) } })
    expect((await refused('reverse.feature.update', { feature: listed.feature.id, set: { exprs: { 'region.box.max.x': 'bx' } } })).message).toMatch(/not read in a box/)
  })

  it('says a kind without numbers has none', async () => {
    const a = await block('A', [0, 0])
    const b = await block('B', [5, 0])
    await run('reverse.feature.add', { feature: { kind: 'boolean', name: 'Both', op: 'join', body: a.feature.id, tool: b.feature.id } })
    expect((await refused('reverse.feature.update', { feature: 'Both', set: { exprs: { offset: 'z' } } })).message).toMatch(/a boolean has no numbers for an expression to drive/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'boolean', op: 'cut', body: a.feature.id, tool: b.feature.id, exprs: {} } })).message).toMatch(/has no numbers/)
  })
})
