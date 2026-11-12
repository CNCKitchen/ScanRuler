// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure commands an agent works the sheet by without seeing it:
// edges named by chain, picks that say where they snapped, a click that
// missed saying where the edge is, notes, changes and removals, the parts on
// an image and the peaks round an outline. App's sheet is stood in for by a
// host of the test's own — a grey image with a disc and a twelve-toothed
// wheel on it, and the edge chains round them — since the commands read the
// sheet only through the host.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EdgeChains } from '../src/core/flat/edges'
import { EdgeIndex } from '../src/core/flat/snap'
import type { FlatHost } from '../src/commands/host'
import { resetStores } from './commandKit'
import { useFlat } from '../src/state/flatStore'
import { useShell } from '../src/state/shellStore'
import { refused, run, startHeadless, undoLabels, type Headless } from './commandKit'

type Vec2 = [number, number]
const W = 1000
const H = 800
const DISC = { c: [300, 400] as Vec2, r: 80 }
const WHEEL = { c: [700, 450] as Vec2, r: 90, tooth: 6, teeth: 12 }
const wheelRadius = (a: number) => WHEEL.r + WHEEL.tooth * Math.cos(WHEEL.teeth * a)

/** The edge chains, in image pixels: a straight edge, the disc's rim, the
 *  wheel's toothed rim and a short stroke off to the side. */
function makeChains(): EdgeChains {
  const runs: Vec2[][] = [
    Array.from({ length: 801 }, (_, i) => [100 + i, 100] as Vec2),
    Array.from({ length: 503 }, (_, i) => {
      const a = (2 * Math.PI * i) / 503
      return [DISC.c[0] + DISC.r * Math.cos(a), DISC.c[1] + DISC.r * Math.sin(a)] as Vec2
    }),
    Array.from({ length: 2000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 2000
      return [WHEEL.c[0] + wheelRadius(a) * Math.cos(a), WHEEL.c[1] + wheelRadius(a) * Math.sin(a)] as Vec2
    }),
    Array.from({ length: 101 }, (_, i) => [950, 600 + i] as Vec2),
  ]
  const offsets = new Uint32Array(runs.length + 1)
  runs.forEach((r, i) => (offsets[i + 1] = offsets[i] + r.length))
  return { points: Float32Array.from(runs.flat(2)), offsets }
}

/** The grey image the chains were found in: dark parts on a white lid, row
 *  0 at the bottom as the sheet lies. */
function makeGray(): Uint8Array {
  const gray = new Uint8Array(W * H).fill(235)
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = c + 0.5
      const y = r + 0.5
      const inDisc = Math.hypot(x - DISC.c[0], y - DISC.c[1]) <= DISC.r
      const a = Math.atan2(y - WHEEL.c[1], x - WHEEL.c[0])
      const inWheel = Math.hypot(x - WHEEL.c[0], y - WHEEL.c[1]) <= wheelRadius(a)
      if (inDisc || inWheel) gray[r * W + c] = 30
    }
  }
  return gray
}

const chains = makeChains()
const index = new EdgeIndex(chains)
const gray = makeGray()

const host: FlatHost = {
  openImage: async () => {},
  closeImage: () => {},
  detectEdges: async () => chains.offsets.length - 1,
  edgeIndex: () => index,
  sheet: () => {
    const px = useFlat.getState().pxPerMm
    return { kind: 'image', bitmap: null, bounds: { min: [0, 0], max: [W / (px?.x ?? 1), H / (px?.y ?? 1)] }, chains }
  },
  gray: () => ({ gray, width: W, height: H }),
  buildSvg: async () => null,
  buildDxf: async () => null,
}

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless({ flat: host })
})
afterAll(() => headless.stop())

beforeEach(() => {
  resetStores()
  useFlat.getState().finishImageLoad('parts.png', W, H, null)
  useFlat.getState().resolveEdges(chains.offsets.length - 1)
})

type Fit = { radius?: number; center?: Vec2; at?: Vec2 }
type E = { element: { id: number; name: string; kind: string; fit: Fit }; picks?: { at: Vec2; chain?: number; moved?: number }[] }

describe('the 2D sheet without seeing it', () => {
  it('flat.edges lists the chains by number, longest first or nearest a place first', async () => {
    type L = { chains: number; matched: number; items: { id: number; length: number; closed: boolean; nearest?: { distance: number }; polyline?: Vec2[] }[] }
    const all = await run<L>('flat.edges')
    expect(all.chains).toBe(4)
    expect(all.items.map((c) => c.id)).toEqual([0, 2, 1, 3])
    expect(all.items.find((c) => c.id === 1)!.closed).toBe(true)
    expect(all.items.find((c) => c.id === 0)!.closed).toBe(false)
    expect(all.items.find((c) => c.id === 1)!.length).toBeCloseTo(2 * Math.PI * DISC.r, -1)

    const near = await run<L>('flat.edges', { near: [383, 400], reach: 50 })
    expect(near.items.map((c) => c.id)).toEqual([1])
    expect(near.items[0].nearest!.distance).toBeCloseTo(3, 1)

    const boxed = await run<L>('flat.edges', { box: { min: [900, 550], max: [1000, 800] }, tolerance: 0.5 })
    expect(boxed.items.map((c) => c.id)).toEqual([3])
    expect(boxed.items[0].polyline).toEqual([[950, 600], [950, 700]])
  })

  it('flat.fit takes whole chains or a box of edge points, by the kind’s edge method', async () => {
    const circle = await run<E>('flat.fit', { kind: 'circle', chains: [1] })
    expect(circle.element.fit.radius).toBeCloseTo(DISC.r, 3)
    const arc = await run<E>('flat.fit', { kind: 'arc', box: { min: [300, 300], max: [400, 500] } })
    expect(arc.element.fit.radius).toBeCloseTo(DISC.r, 3)
    expect((await refused('flat.fit', { kind: 'circle', chains: [9] })).message).toMatch(/no chain 9 — the sheet has 4/)
    expect((await refused('flat.fit', { kind: 'point', chains: [1] })).code).toBe('invalid_input')
    expect(undoLabels()).toEqual(['Agent: fit 2D circle', 'Agent: fit 2D arc'])
  })

  it('flat.curvature tells an edge as straight runs and arcs, and a fitted curve exactly', async () => {
    type St = { kind: string; from: number; to: number; radius?: number; radiusMin?: number; radiusMax?: number }
    type C = { unit: string; window: number; items: { chain: number; closed?: boolean; stretches?: St[]; samples?: { curvature: number }[]; tooShort?: string }[] }
    const read = await run<C>('flat.curvature', { chains: [0, 1, 3], window: 4, step: 50 })
    expect(read.unit).toBe('px')
    expect(read.window).toBe(4)
    const [line, disc, stroke] = read.items
    expect(line.stretches!.map((x) => x.kind)).toEqual(['straight'])
    // A window off each end of the open chain.
    expect(line.stretches![0].from).toBeCloseTo(4, 0)
    expect(line.stretches![0].to).toBeCloseTo(796, 0)
    // The disc's rim stops a step short of its start, and is a loop all the same.
    expect(disc.closed).toBe(true)
    expect(disc.stretches!.map((x) => x.kind)).toEqual(['arc'])
    expect(disc.stretches![0].radius).toBeCloseTo(DISC.r, 0)
    expect(disc.samples!.length).toBeGreaterThan(5)
    expect(stroke.stretches!.map((x) => x.kind)).toEqual(['straight'])

    await run('flat.fit', { kind: 'circle', chains: [1] })
    const exact = await run<{ kind: string; stretches: St[] }>('flat.curvature', { element: 'Circle 1' })
    expect(exact.kind).toBe('circle')
    expect(exact.stretches).toHaveLength(1)
    expect(exact.stretches[0].radiusMin).toBeCloseTo(exact.stretches[0].radiusMax!, 6)
    await run('flat.fit', { kind: 'line', chains: [0] })
    expect((await refused('flat.curvature', { element: 'Line 1' })).message).toMatch(/only an arc, a circle or a spline/)
    expect((await refused('flat.curvature', {})).code).toBe('invalid_input')
    expect((await refused('flat.curvature', { chains: [9] })).message).toMatch(/no chain 9/)
  })

  it('a pick says where it snapped, and stays where it was put with snap off', async () => {
    const snapped = await run<E>('flat.fit', { kind: 'point', points: [[383, 400]] })
    expect(snapped.picks![0].chain).toBe(1)
    expect(snapped.picks![0].moved).toBeCloseTo(3, 1)
    expect(snapped.element.fit.at![0]).toBeCloseTo(380, 1)
    const free = await run<E>('flat.fit', { kind: 'point', points: [[383, 400]], snap: false })
    expect(free.picks![0]).toEqual({ at: [383, 400] })
    // Out of reach, a pick is left alone; with a longer reach it snaps.
    expect((await run<E>('flat.fit', { kind: 'point', points: [[400, 400]] })).picks![0].chain).toBeUndefined()
    expect((await run<E>('flat.fit', { kind: 'point', points: [[400, 400]], reach: 25 })).picks![0].chain).toBe(1)
  })

  it('a click on no edge names the nearest chain and how far it is', async () => {
    const miss = await refused('flat.fit', { kind: 'circle', method: 'flat-circle-seed', points: [[700, 640]] })
    expect(miss.code).toBe('invalid_input')
    expect(miss.message).toMatch(/nearest is chain 2, 9\d(\.\d+)? px away at \[/)
    const hit = await run<E>('flat.fit', { kind: 'circle', method: 'flat-circle-edge', points: [[383, 400]] })
    expect(hit.element.fit.radius).toBeCloseTo(DISC.r, 3)
  })

  it('notes are written, changed and listed; anything on the sheet is renamed, hidden or removed', async () => {
    const note = await run<{ note: { id: number } }>('flat.note_add', { text: '#6-32 UNC × 7.1', at: [300, 500] })
    expect(useFlat.getState().notes).toMatchObject([{ id: note.note.id, text: '#6-32 UNC × 7.1', at: [300, 500] }])
    await run('flat.edit', { note: note.note.id, text: 'M3 × 5.7\nbrass', at: [310, 510] })
    // A note is one line, as the Text tool writes it.
    expect(useFlat.getState().notes[0]).toMatchObject({ text: 'M3 × 5.7 / brass', at: [310, 510] })
    expect((await run<{ text: string }>('flat.report')).text).toMatch(/Notes\n {2}M3 × 5\.7 \/ brass/)

    const disc = (await run<E>('flat.fit', { kind: 'circle', chains: [1] })).element
    const wheel = (await run<E>('flat.fit', { kind: 'circle', chains: [2] })).element
    await run('flat.dimension_add', { refs: [disc.name, wheel.name] })
    await run('flat.edit', { element: disc.name, name: 'Insert 1' })
    await run('flat.edit', { element: 'Insert 1', visible: false })
    expect(useFlat.getState().elements[0]).toMatchObject({ name: 'Insert 1', visible: false })
    expect((await refused('flat.edit', { element: 'Insert 1', note: 1, name: 'x' })).code).toBe('invalid_input')
    // The 3D commands do not reach the sheet, and say where it is.
    expect((await refused('element.remove', { element: 'Insert 1' })).message).toMatch(/on the 2D sheet: flat\.edit and flat\.remove/)

    type R = { removed: string[]; invalidDimensions: string[] }
    expect((await refused('flat.remove', { elements: ['Insert 1', 'Nothing'] })).code).toBe('not_found')
    expect(useFlat.getState().elements).toHaveLength(2)
    const gone = await run<R>('flat.remove', { elements: ['Insert 1'], notes: [note.note.id] })
    expect(gone.removed).toEqual(['Insert 1', `note ${note.note.id}`])
    expect(gone.invalidDimensions).toEqual(['Distance 1'])
    expect(undoLabels().slice(-2)).toEqual(['Agent: change 2D sheet', 'Agent: remove from 2D sheet'])
    await run('history.undo')
    expect(useFlat.getState().elements.map((e) => e.name)).toEqual(['Insert 1', 'Circle 2'])
    expect(useFlat.getState().notes).toHaveLength(1)
  })

  it('flat.objects finds the parts in reading order, with their sizes and outline chains', async () => {
    useFlat.setState({ pxPerMm: { x: 10, y: 10 }, calSource: 'measured' })
    type O = { found: number; dark: boolean; objects: { id: number; area: number; centroid: Vec2; equivalentDiameter: number; feret: { max: number; min: number }; chains: number[] }[] }
    const o = await run<O>('flat.objects')
    expect(o.found).toBe(2)
    expect(o.dark).toBe(true)
    const [disc, wheel] = o.objects
    expect(disc.id).toBe(1)
    expect(disc.centroid[0]).toBeCloseTo(30, 1)
    expect(disc.equivalentDiameter).toBeCloseTo(16, 1)
    expect(disc.feret.max).toBeCloseTo(16, 0)
    expect(disc.chains).toEqual([1])
    expect(wheel.chains).toEqual([2])
    expect(wheel.feret.max).toBeGreaterThan(18.5)
  })

  it('flat.profile counts the teeth round an outline, and marks them for the eye', async () => {
    useFlat.setState({ pxPerMm: { x: 10, y: 10 }, calSource: 'measured' })
    await run('flat.objects')
    // Found at another scale, the parts are found again before an outline
    // is taken from them.
    useFlat.setState({ pxPerMm: { x: 12.5, y: 12.5 } })
    expect((await refused('flat.profile', { object: 2 })).message).toMatch(/flat\.objects first/)
    useFlat.setState({ pxPerMm: { x: 10, y: 10 } })
    type P = { sides: { count: number; pitch: number; diameter?: { peaks: number; valleys: number }; peaks: { angle?: number; at: Vec2 }[] }[]; counts?: string[] }
    const byObject = await run<P>('flat.profile', { object: 2 })
    expect(byObject.sides).toHaveLength(1)
    expect(byObject.sides[0].count).toBe(WHEEL.teeth)
    expect(byObject.sides[0].pitch).toBeCloseTo(30, 0)
    expect(byObject.sides[0].diameter!.peaks).toBeCloseTo(19.2, 0)
    expect(byObject.sides[0].diameter!.valleys).toBeCloseTo(16.8, 0)
    expect(useFlat.getState().counts).toHaveLength(0)
    expect(undoLabels()).toEqual([])

    const byChain = await run<P>('flat.profile', { chains: [2], mark: true })
    expect(byChain.sides[0].count).toBe(WHEEL.teeth)
    expect(byChain.counts).toEqual(['Peaks, chain 2'])
    expect(useFlat.getState().counts[0]).toMatchObject({ name: 'Peaks, chain 2' })
    expect(useFlat.getState().counts[0].picks).toHaveLength(WHEEL.teeth)
    expect(undoLabels()).toEqual(['Agent: mark profile peaks'])

    const axial = await run<P>('flat.profile', { chains: [1], axis: 'axial' })
    expect(axial.sides).toHaveLength(2)
    expect((await refused('flat.profile', { object: 2, chains: [2] })).code).toBe('invalid_input')
  })

  it('session.state says where the sheet lies and what is on it', async () => {
    await run('flat.note_add', { text: 'left', at: [10, 10] })
    type S = { flat: { units: string; sheet: { min: Vec2; max: Vec2; frame: string }; edges: { chains: number }; notes: { text: string }[]; counts: unknown[] } }
    const s = await run<S>('session.state')
    expect(s.flat.units).toBe('px')
    expect(s.flat.sheet).toMatchObject({ min: [0, 0], max: [W, H] })
    expect(s.flat.sheet.frame).toMatch(/bottom-left corner, \+X right, \+Y up/)
    expect(s.flat.edges.chains).toBe(4)
    expect(s.flat.notes).toMatchObject([{ text: 'left' }])
  })

  it('pictures need the browser, and the 3D picture is refused while the sheet has the screen', async () => {
    expect((await refused('flat.render')).code).toBe('unavailable')
    useShell.getState().setWorkspace('flat')
    expect((await refused('view.render')).message).toMatch(/flat\.render pictures the 2D sheet/)
  })
})
