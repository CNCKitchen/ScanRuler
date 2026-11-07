// SPDX-License-Identifier: AGPL-3.0-only
// What the third fan's run asked of the answers: a feature removed after
// failing and made needless by a built one; a failure told in full once, and
// its list of places grouped; undo's answer in brief; a taper through its
// sketch plane, lines end to end and a far move said; near sketches said
// once; an edge-only query listing edges; offsets on a coordinate plane
// counted from the world's zero. The kernel runs in this thread.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sheetPlaneOf } from '../../../src/commands/core/section'
import { refused, run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { boxMesh } from '../../../tests/helpers'
import { useStore } from '../../../src/state/store'
import { planVerdict, usePlan } from '../app/rePlan'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { lineMiddle } from '../app/reReadout'
import { openEnds } from '../core/corners'
import { listFailing, faceMiddle } from '../core/diagnose'
import { volumeOff } from '../core/kernel'
import { curveMoved } from '../core/project'
import { ReClient } from '../core/reClient'
import { collinearPieces } from '../core/sketchNearMiss'
import plugin from '../plugin'
import { localKernel } from './reLocal'

vi.setConfig({ testTimeout: 180_000 })

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: stlBytes(boxMesh(40, 40)), name: 'box-round22.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})

const plate = { kind: 'sketch', name: 'Plate', plane: { kind: 'world', axis: 'z', offset: -20 }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [40, 40], fixed: true }] } }
const block = { kind: 'extrude', name: 'Block', sketchId: 'Plate', regions: 'all', extent: { kind: 'distance', from: 0, to: 40 }, op: 'new' }

describe('a feature replaced', () => {
  it('clears the verdict only for a built feature, and a round only for a round', async () => {
    await run('reverse.plan.set', { archetype: 'machined', regions: [{ name: 'Body' }], target: { withinT: 90 } })
    await run('reverse.feature.add', { feature: plate })
    await run('reverse.feature.add', { feature: block })
    await run('reverse.plan.tick', { region: 'Body', feature: 'Block' })
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Nose roots', body: 'Block', edges: [0], radius: 60 } })
    await run('reverse.feature.remove', { feature: 'Nose roots' })
    expect(planVerdict(session, { withinT: 95 })).toMatchObject({ met: false, unbuilt: ['Nose roots'] })

    // Not a round, nothing built in its place, nothing of that name.
    const notRound = await refused('reverse.plan.replace', { removed: 'Nose roots', by: 'Block', reason: 'one piece now' })
    expect(notRound.code).toBe('invalid_input')
    expect(notRound.message).toMatch(/Block an extrude/)
    expect((await refused('reverse.plan.replace', { removed: 'Nothing', by: 'Block', reason: 'x' })).code).toBe('not_found')
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Failing', body: 'Block', edges: [1], radius: 60 } })
    expect((await refused('reverse.plan.replace', { removed: 'Nose roots', by: 'Failing', reason: 'x' })).code).toBe('invalid_state')
    await run('reverse.feature.remove', { feature: 'Failing' })
    expect(planVerdict(session, { withinT: 95 })).toMatchObject({ met: false, unbuilt: ['Nose roots', 'Failing'] })

    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Roots', body: 'Block', edges: [0], radius: 1 } })
    const said = await run<{ unbuilt: string[] }>('reverse.plan.replace', { removed: 'Nose roots', by: 'Roots', reason: 'the blade is one piece now' })
    expect(said.unbuilt).toEqual(['Failing'])
    await run('reverse.plan.replace', { removed: 'Failing', by: 'Roots', reason: 'tried on the wrong edge' })

    const v = planVerdict(session, { withinT: 95 })!
    expect(v.met).toBe(true)
    expect(v.removed).toEqual([
      expect.objectContaining({ name: 'Nose roots', replaced: { by: 'Roots', reason: 'the blade is one piece now' } }),
      expect.objectContaining({ name: 'Failing', replaced: { by: 'Roots', reason: 'tried on the wrong edge' } }),
    ])
    expect(v.next).toMatch(/^target met, every region done or skipped; 2 removed after failing \(Nose roots, Failing\), each replaced/)

    // Gone, the replacement stands for nothing: owed again.
    await run('reverse.feature.remove', { feature: 'Roots' })
    expect(planVerdict(session, { withinT: 95 })).toMatchObject({ met: false, unbuilt: ['Nose roots', 'Failing'] })
  })

  it('repeats a failure by its first sentence, each name once, and nothing once built again', async () => {
    const long = `24 of the 56 chains do not round: ${'the chain at (1, 2, 3), '.repeat(30)}and more. Then more still.`
    usePlan.setState({ removed: [
      { name: 'Twice', kind: 'fillet', message: long, at: 'a' },
      { name: 'Twice', kind: 'fillet', message: 'The edge does not round at 2 mm. It rounds at 1 mm.', at: 'b' },
      { name: 'Long', kind: 'fillet', message: 'x'.repeat(1000), at: 'c' },
      { name: 'Block', kind: 'extrude', message: 'failed once', at: 'd' },
    ] })
    const v = planVerdict(session, { withinT: 95 })!
    expect(v.removed).toEqual([
      { name: 'Twice', kind: 'fillet', at: 'b', times: 2, message: 'The edge does not round at 2 mm.' },
      expect.objectContaining({ name: 'Long', message: `${'x'.repeat(240)}…` }),
    ])
    usePlan.setState({ removed: [] })
  })
})

describe('a failure told', () => {
  it('lists up to three places, and groups more by what lies either side', () => {
    const c = (at: string, between: string) => ({ words: `the chain at ${at} between ${between}`, at, between })
    expect(listFailing([c('(1)', 'A'), c('(2)', 'B')], 'chains')).toBe('the chain at (1) between A, the chain at (2) between B')
    const many = [c('(1)', 'A'), c('(2)', 'A'), c('(3)', 'A'), c('(4)', 'B'), c('(5)', 'C'), c('(6)', 'D'), c('(7)', 'E'), c('(8)', 'E')]
    const said = listFailing(many, 'chains')
    expect(said).toBe('3 chains between A, the first at (1); 2 chains between E, the first at (7); the chain at (4) between B; the chain at (5) between C; and 1 more')
    expect(said.length).toBeLessThan(200)
  })

  it('names a straight edge’s middle, which its two points do not hold', () => {
    expect(lineMiddle(Float32Array.from([0, 0, 0, 0, 0, 10]))).toEqual([0, 0, 5])
    expect(lineMiddle(Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]))).toEqual([1, 0, 0])
  })

  it('places a face of no area by its edges, not at the origin', () => {
    const edges = [{ hash: 1, faceHashes: [7], mid: [10, 0, 4] }, { hash: 2, faceHashes: [7, 8], mid: [20, 0, 6] }, { hash: 3, faceHashes: [8], mid: [90, 90, 90] }] as never
    expect(faceMiddle({ hash: 7, area: 0, centroid: [0, 0, 0] }, edges)).toEqual([15, 0, 5])
    expect(faceMiddle({ hash: 7, area: 5, centroid: [1, 2, 3] }, edges)).toEqual([1, 2, 3])
  })

  it('in full once, then by its first sentence; the row leaves it to the result', async () => {
    const added = await run<{ feature: { status: string; message?: string }; result: { message: string }; failed: { message: string; said?: string }[] }>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Too big', body: 'Block', edges: [0], radius: 60 } })
    expect(added.feature.status).toBe('failed')
    expect(added.feature.message).toBeUndefined()
    expect(added.result.message.length).toBeGreaterThan(40)
    expect(added.failed[0].said).toMatch(/in full before/)
    const next = await run<{ failed: { message: string; said?: string }[] }>('reverse.parameter.add', { name: 'w', expression: '3' })
    expect(next.failed[0].said).toMatch(/in full before/)
    expect(next.failed[0].message.length).toBeLessThanOrEqual(201)
    const list = await run<{ features: { name: string; message?: string }[] }>('reverse.feature.list', {})
    expect(list.features.find((f) => f.name === 'Too big')?.message).toBe(added.result.message)
    await run('reverse.feature.remove', { feature: 'Too big' })
    await run('reverse.parameter.remove', { parameter: 'w' })
    usePlan.setState({ removed: [] })
  })
})

describe('undo', () => {
  it('answers in brief by default, and the session with detail full', async () => {
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Undo me', body: 'Block', edges: [2], radius: 1 } })
    const brief = await run<Record<string, unknown> & { after: { plugins: { reverse: { features: number; bodies: string[] } } } }>('history.undo')
    expect(brief.undone).toBe('Agent: add fillet “Undo me”')
    expect(brief.state).toBeUndefined()
    expect(brief.after.plugins.reverse).toMatchObject({ features: 2 })
    expect(brief.after.plugins.reverse.bodies).toHaveLength(1)
    expect(JSON.stringify(brief).length).toBeLessThan(600)
    const full = await run<Record<string, unknown>>('history.redo', { detail: 'full' })
    expect(full.redone).toBe('Agent: add fillet “Undo me”')
    expect(full.state).toBeDefined()
    // Settled by the time it answers, the part as the step left it.
    expect(brief.after).not.toHaveProperty('held')
    await run('history.undo')
  })
})

describe('warned of what was likely meant otherwise', () => {
  it('a taper through the sketch plane, once for its shape', async () => {
    const through = { kind: 'extrude', name: 'Through', sketchId: 'Plate', regions: 'all', extent: { kind: 'distance', from: -2, to: 2 }, draftDeg: 1, op: 'new' }
    const first = await run<{ draftBothWays?: string }>('reverse.feature.add', { feature: through })
    expect(first.draftBothWays).toMatch(/two faces meeting at that plane/)
    const again = await run<{ draftBothWays?: string }>('reverse.feature.update', { feature: 'Through', set: { name: 'Through 2' } })
    expect(again.draftBothWays).toBeUndefined()
    const changed = await run<{ draftBothWays?: string }>('reverse.feature.update', { feature: 'Through 2', set: { extent: { kind: 'distance', from: -3, to: 3 } } })
    expect(changed.draftBothWays).toBeDefined()
    const oneWay = await run<{ draftBothWays?: string }>('reverse.feature.update', { feature: 'Through 2', set: { extent: { kind: 'distance', from: 0, to: 3 } } })
    expect(oneWay.draftBothWays).toBeUndefined()
    await run('reverse.feature.remove', { feature: 'Through 2' })
  })

  it('at detail none too, one feature or several: said once, and not lost on the way', async () => {
    const plan = (name: string) => ({ kind: 'sketch', name, plane: { kind: 'world', axis: 'z', offset: 40 }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [10, 3], fixed: true }] } })
    const tapered = (name: string, sketchId: string) => ({ kind: 'extrude', name, sketchId, regions: 'all', extent: { kind: 'distance', from: -2, to: 2 }, draftDeg: 2, op: 'new' })
    const many = await run<{ added: { draftBothWays?: string }[] }>('reverse.feature.add', { detail: 'none', features: [plan('Bar'), tapered('Tapered', 'Bar')] })
    expect(many.added[1].draftBothWays).toMatch(/two faces meeting at that plane/)
    await run('reverse.feature.add', { feature: plan('Bar 2') })
    const one = await run<{ draftBothWays?: string }>('reverse.feature.add', { detail: 'none', feature: tapered('Tapered 2', 'Bar 2') })
    expect(one.draftBothWays).toMatch(/two faces meeting at that plane/)
    const split = { kind: 'sketch', name: 'Split none', plane: { kind: 'world', axis: 'z', offset: 50 }, sketch: { entities: [{ kind: 'line', id: 1, a: [0, 0], b: [5, 0] }, { kind: 'line', id: 2, a: [5, 0], b: [9, 0] }] } }
    const lines = await run<{ added: { collinearPieces?: unknown }[] }>('reverse.feature.add', { detail: 'none', features: [split] })
    expect(lines.added[0].collinearPieces).toEqual([{ pieces: [1, 2], at: [5, 0] }])
    for (const name of ['Split none', 'Tapered 2', 'Bar 2', 'Tapered', 'Bar']) await run('reverse.feature.remove', { feature: name })
  })

  it('names another open end as the nearest, not a joined one, unless it all but reaches it', () => {
    const line = (id: number, a: number[], b: number[]) => ({ kind: 'line', id, a, b })
    const sketch = (...entities: unknown[]) => ({ entities }) as never
    expect(openEnds(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [9, 0]))).map((o) => [o.piece, o.end, o.nearest, o.gap])).toEqual([
      [1, 'a', { piece: 2, end: 'b' }, 9],
      [2, 'b', { piece: 1, end: 'a' }, 9],
    ])
    // One open end beside a corner two others share: a near miss, and no other way to name it.
    const miss = openEnds(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [5, 5]), line(3, [5.2, 0], [9, -3])))
    expect(miss.find((o) => o.piece === 3 && o.end === 'a')?.nearest).toEqual({ piece: 1, end: 'b' })
  })

  it('lines end to end, not those with a third piece at the join, nor a fold', () => {
    const line = (id: number, a: number[], b: number[]) => ({ kind: 'line', id, a, b })
    const sketch = (...entities: unknown[]) => ({ entities, constraints: [], nextId: 99 }) as never
    expect(collinearPieces(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [9, 0])))).toEqual([{ pieces: [1, 2], at: [5, 0] }])
    expect(collinearPieces(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [9, 0]), line(3, [5, 0], [5, 4])))).toEqual([])
    expect(collinearPieces(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [1, 0])))).toEqual([])
    expect(collinearPieces(sketch(line(1, [0, 0], [5, 0]), line(2, [5, 0], [9, 1])))).toEqual([])
  })

  it('reads a piece trimmed along itself as not moved, and one pulled off its line as moved', () => {
    expect(curveMoved({ kind: 'line', id: 1, a: [0, 0], b: [10, 0] } as never, { kind: 'line', id: 1, a: [2, 0], b: [10, 0] } as never)).toBeCloseTo(0)
    expect(curveMoved({ kind: 'line', id: 1, a: [0, 0], b: [10, 0] } as never, { kind: 'line', id: 1, a: [0, 3], b: [10, 0] } as never)).toBeCloseTo(3)
    expect(curveMoved({ kind: 'arc', id: 1, c: [0, 0], r: 5, start: 0, sweep: 1 } as never, { kind: 'arc', id: 1, c: [0, 0], r: 5, start: 0.3, sweep: 0.5 } as never)).toBeCloseTo(0)
    expect(curveMoved({ kind: 'arc', id: 1, c: [0, 0], r: 5, start: 0, sweep: 1 } as never, { kind: 'arc', id: 1, c: [3, 0], r: 6, start: 0, sweep: 1 } as never)).toBeCloseTo(4)
    // A near-flat arc opened up from R115.6 to R119.9 through the same ends:
    // the centre travels 4.3 mm, the curve under 0.05.
    const flat = (r: number) => {
      const half = Math.asin(10 / r)
      return { kind: 'arc', id: 1, c: [0, -Math.sqrt(r * r - 100)], r, start: Math.PI / 2 - half, sweep: 2 * half } as never
    }
    expect(curveMoved(flat(115.6), flat(119.9))).toBeLessThan(0.05)
  })

  it('a piece moved far by what an edit added', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Drawn', plane: { kind: 'world', axis: 'z', offset: 30 }, sketch: { entities: [{ kind: 'line', id: 1, a: [0, 0], b: [10, 3] }] } } })
    const named = await run<{ movedFar?: unknown }>('reverse.sketch.edit', { sketch: 'Drawn', name: 'Drawn' })
    expect(named.movedFar).toBeUndefined()
    const pulled = await run<{ movedFar?: { pieces: { id: number; offCurveMm: number }[]; say: string } }>('reverse.sketch.edit', { sketch: 'Drawn', add: { constraints: [{ kind: 'vertical', entity: 1 }] } })
    expect(pulled.movedFar?.pieces[0].id).toBe(1)
    expect(pulled.movedFar?.pieces[0].offCurveMm).toBeCloseTo(1.4367, 3)
    expect(pulled.movedFar?.say).toMatch(/own line or circle.*history\.undo/)
    await run('reverse.feature.remove', { feature: 'Drawn' })
  })
})

describe('a query only edges answer', () => {
  it('lists the edges and says so', async () => {
    const d = await run<{ bodies: { facesLeftOut?: string; faceList: unknown[]; edgeList: unknown[]; matched: { faces: number; edges: number } }[] }>('reverse.body.describe', { body: 'Block', where: { sides: { madeBy: ['Block', 'Block'] } } })
    expect(d.bodies[0].facesLeftOut).toMatch(/^sides picks edges/)
    expect(d.bodies[0].faceList).toEqual([])
    expect(d.bodies[0].matched.edges).toBeGreaterThan(0)
  })
})

describe('section offsets', () => {
  it('on a coordinate plane count from the world’s zero; alone it lies through the part', () => {
    const was = useStore.getState().modelCenter
    useStore.setState({ modelCenter: [1, 2, 14] })
    expect(sheetPlaneOf('XY', true).frame.origin).toEqual([0, 0, 0])
    expect(sheetPlaneOf('XY').frame.origin).toEqual([0, 0, 14])
    useStore.setState({ modelCenter: was })
  })
})

describe('the STEP volume line', () => {
  it('says the share and the limit', () => {
    expect(volumeOff('A', [88551, 88691], false)?.text).toBe('A reads back 140 mm³ off its volume (0.16 %, over the 0.1 % the kernel’s numeric integration accounts for).'.replace('’', "'"))
    expect(volumeOff('A', [88551, 88611], false)).toMatchObject({ problem: false })
    expect(volumeOff('A', [1000, 1000.4], true)?.text).toMatch(/\(0\.040 %\), the surfaces off too\.$/)
  })
})
