// SPDX-License-Identifier: AGPL-3.0-only
// The workspace through its commands alone, as an agent drives it: a
// parameter, a sketch written out and dimensioned with it, a revolve, an M3
// thread on the pin — then the parameter changed, the part rebuilt longer,
// and the change undone. The kernel runs in this thread through the worker's
// own service (core/reLocal), the app's session headless as the app's
// command tests run it (tests/commandKit.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { listCommands, runCommand } from '../../../src/commands/registry'
import { SCHEMA_BUDGET, schemaWeight, validate } from '../../../src/commands/schema'
import { useStore } from '../../../src/state/store'
import { refused, run, startHeadless, undoLabels, type Headless } from '../../../tests/commandKit'
import { collectReversePart } from '../app/projectSection'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import { useReverse } from '../state/reStore'
import { FEATURE_EXAMPLES, FEATURE_IN, FEATURE_KINDS, featureOf } from '../app/reSchemas'
import plugin from '../plugin'
import { resetReverse } from './reReset'

// Kernel builds and real-scan fits run long, and longer on a slow machine.
vi.setConfig({ testTimeout: 180_000 })

type Vec3 = [number, number, number]
interface Body { id: number; name: string; closed: boolean; volume: number; bounds: { min: Vec3; max: Vec3; size: Vec3 } }
interface Face { index: number; kind: string; radius?: number; diameter?: number; side?: string; length?: number; fingerprint: unknown }
interface Answer { feature: { id: number; name: string; kind: string }; result: { status: string; message?: string } | null; bodies: Body[]; failed?: unknown[]; solve?: { ok: boolean; underConstrained: number[] }; regions?: { key: string }[] }
/** What a change answers by default: the bodies it touched. */
interface Changed { count: number; changed?: Body[]; removed?: { id: number; name: string }[] }
interface Brief { feature: { id: number; name: string; kind: string; status: string }; result: { status: string; message?: string } | null; bodies: Changed; failed?: unknown[]; solve?: { ok: boolean; underConstrained: number[]; redundant: number }; regions?: { at: [number, number]; area: number }[]; shapes?: { index: number; kind: string; sides?: number[]; lines?: number[]; circle?: number; center?: number }[]; patterns?: { copies: number[][] }[]; inferred?: number; removed?: { pieces: number; constraints: number } }

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

/** The pin's half-profile on the YZ plane — u is Y, v is Z: a rectangle
 *  from the Z axis out to the radius, as long as `length` reads, its
 *  bottom on the XY plane and its inner side on the axis. */
const pinSketch = (length: string, radius = 1.5) => ({
  kind: 'sketch',
  name: 'Pin profile',
  plane: { kind: 'world', axis: 'x' },
  sketch: {
    entities: [
      { id: 1, kind: 'line', a: [0, 0], b: [radius, 0] },
      { id: 2, kind: 'line', a: [radius, 0], b: [radius, 10] },
      { id: 3, kind: 'line', a: [radius, 10], b: [0, 10] },
      { id: 4, kind: 'line', a: [0, 10], b: [0, 0] },
    ],
    constraints: [
      { kind: 'coincident', p: { entity: 1, at: 'b' }, q: { entity: 2, at: 'a' } },
      { kind: 'coincident', p: { entity: 2, at: 'b' }, q: { entity: 3, at: 'a' } },
      { kind: 'coincident', p: { entity: 3, at: 'b' }, q: { entity: 4, at: 'a' } },
      { kind: 'coincident', p: { entity: 4, at: 'b' }, q: { entity: 1, at: 'a' } },
      { kind: 'horizontal', entity: 1 },
      { kind: 'horizontal', entity: 3 },
      { kind: 'vertical', entity: 2 },
      { kind: 'collinear', line: 4, on: { datum: 'zx' } },
      { kind: 'collinear', line: 1, on: { datum: 'xy' } },
      { kind: 'length', entity: 1, value: radius },
      { kind: 'length', entity: 2, expr: length },
    ],
  },
})

/** A pin of the parameter's length, revolved about its inner side. */
async function pin(length = 'l1') {
  const sketch = await run<Brief>('reverse.feature.add', { feature: pinSketch(length) })
  const revolve = await run<Brief>('reverse.feature.add', { feature: { kind: 'revolve', sketchId: 'Pin profile', axis: { kind: 'sketchLine', entity: 4 }, op: 'new' } })
  return { sketch, revolve }
}

const describeBody = async (body: number | string) => (await run<{ bodies: (Body & { faceList: Face[] })[] }>('reverse.body.describe', { body, edges: false })).bodies[0]

describe('an M3 pin modelled through the commands', () => {
  it('takes a parameter, a sketch dimensioned by it, a revolve and a thread; follows the parameter; undoes it', async () => {
    const param = await run<{ parameter: { name: string; value: number; unit: string } }>('reverse.parameter.add', { name: 'l1', expression: '12' })
    expect(param.parameter).toMatchObject({ name: 'l1', value: 12, unit: 'mm' })

    const { sketch, revolve } = await pin()
    expect(sketch.solve).toMatchObject({ ok: true, underConstrained: [] })
    expect(sketch.regions).toHaveLength(1)
    expect(sketch.feature.kind).toBe('sketch')
    expect(revolve.result?.status).toBe('ok')
    // The answer has the body the revolve made, and no more.
    expect(revolve.bodies.count).toBe(1)
    expect(revolve.bodies.changed).toHaveLength(1)
    const body = revolve.bodies.changed![0]
    expect(body.closed).toBe(true)
    expect(body.volume).toBeCloseTo(Math.PI * 1.5 ** 2 * 12, 1)
    expect(body.bounds.size[2]).toBeCloseTo(12, 6)
    expect(body.bounds.min[2]).toBeCloseTo(0, 6)

    // The round face, as body.describe lists it: a boss of Ø3, 12 long.
    const described = await describeBody(body.id)
    const round = described.faceList.find((f) => f.kind === 'cylinder')!
    expect(round).toMatchObject({ diameter: 3, side: 'boss' })
    expect(round.length).toBeCloseTo(12, 6)

    const thread = await run<Answer>('reverse.feature.add', { feature: { kind: 'thread', body: body.name, face: round.index, size: 'M3' }, detail: 'full' })
    expect(thread.result?.status, thread.result?.message).toBe('ok')
    expect(thread.feature).toMatchObject({ kind: 'thread', standard: 'metric', diameter: 3, pitch: 0.5, length: null })
    expect(thread.failed).toBeUndefined()
    const threaded = thread.bodies[0]
    expect(threaded.closed).toBe(true)
    expect(threaded.volume).toBeLessThan(body.volume)
    expect(threaded.bounds.size[2]).toBeCloseTo(12, 3)

    // The parameter changed: the sketch solved again on it, the part rebuilt
    // 8 mm longer, the thread found again on the longer face.
    const set = await run<{ parameter: { value: number }; changed: string[]; bodies: Changed; failed?: unknown[] }>('reverse.parameter.set', { parameter: 'l1', expression: '20' })
    expect(set.parameter.value).toBe(20)
    expect(set.changed).toContain('Pin profile')
    expect(set.failed).toBeUndefined()
    expect(set.bodies.changed![0].bounds.size[2]).toBeCloseTo(20, 3)
    expect(set.bodies.changed![0].bounds.size[2] - threaded.bounds.size[2]).toBeCloseTo(8, 3)
    const built = await run<{ features: { name: string; status: string }[] }>('reverse.build')
    expect(built.features.map((f) => [f.name, f.status])).toEqual([
      ['Pin profile', 'ok'],
      ['Revolve 1', 'ok'],
      ['Thread 1', 'ok'],
    ])

    // One undo step each, named for the agent; nothing left open.
    expect(undoLabels()).toEqual(['Agent: add parameter l1', 'Agent: add sketch “Pin profile”', 'Agent: add revolve', 'Agent: add thread', 'Agent: set l1 = 20'])
    const r = useReverse.getState()
    expect([r.sketchDraft, r.extrudeDraft, r.revolveDraft, r.featureDraft]).toEqual([null, null, null, null])

    // The session's readout has the workspace's part.
    const state = await run<{ busy: string | null; plugins: { reverse: { ready: boolean; build: string; parameters: { name: string; value: number }[]; features: { name: string; status: string }[]; bodies: Body[] } } }>('session.state')
    expect(state.busy).toBeNull()
    expect(state.plugins.reverse).toMatchObject({ ready: true, build: 'built', parameters: [{ name: 'l1', value: 20 }] })
    expect(state.plugins.reverse.features.map((f) => f.status)).toEqual(['ok', 'ok', 'ok'])

    // history.undo puts l1 back, and the part follows.
    const undone = await run<{ undone: string }>('history.undo')
    expect(undone.undone).toBe('Agent: set l1 = 20')
    expect(useReverse.getState().parameters[0]).toMatchObject({ name: 'l1', expression: '12' })
    const back = await run<{ bodies: Body[] }>('reverse.build')
    expect(back.bodies[0].bounds.size[2]).toBeCloseTo(12, 3)

    // And the body as STEP.
    const step = await run<{ file: { name: string; mimeType: string; bytes: Uint8Array } }>('reverse.export.step')
    expect(step.file.name).toBe('model-body.step')
    expect(new TextDecoder().decode(step.file.bytes.subarray(0, 13))).toBe('ISO-10303-21;')
    expect((step as { verify?: unknown }).verify).toBeUndefined()

    // Read back and checked against the body, when asked.
    type Verified = { status: string; verify: { ok: boolean; problems: string[]; parts: number; bodies: { name: string; faces: [number, number]; volume: [number, number]; closed: boolean; gap: { max: number } }[]; loops: { read: number; of: number; wrong?: unknown[] } } }
    const checked = await run<Verified>('reverse.export.step', { verify: true })
    expect(checked.verify.problems).toEqual([])
    expect(checked.verify.ok).toBe(true)
    expect(checked.verify.parts).toBe(1)
    expect(checked.verify.bodies[0].closed).toBe(true)
    expect(checked.verify.bodies[0].faces[1]).toBe(checked.verify.bodies[0].faces[0])
    expect(checked.verify.bodies[0].volume[1]).toBeCloseTo(checked.verify.bodies[0].volume[0], 3)
    expect(checked.verify.bodies[0].gap.max).toBeLessThan(1e-3)
    expect(checked.verify.loops.wrong).toBeUndefined()
    expect(checked.status).toMatch(/Read back and checked: it holds\.$/)
  })
})

describe('parameters, several at once', () => {
  it('adds them as one step, a later one reading an earlier, and answers with what changed, not the table', async () => {
    await run('reverse.parameter.add', { name: 'd', expression: '3' })
    const added = await run<{ parameters: { name: string; value: number; comment?: string }[]; parameter?: unknown }>('reverse.parameter.add', {
      parameters: [{ name: 'head', expression: '1.8 * d' }, { name: 'l1', expression: 'head + 10', comment: 'the pin' }],
    })
    expect(added.parameter).toBeUndefined()
    expect(added.parameters.map((p) => p.name)).toEqual(['head', 'l1'])
    expect(added.parameters[0].value).toBeCloseTo(5.4, 9)
    expect(added.parameters[1]).toMatchObject({ comment: 'the pin' })
    expect(added.parameters[1].value).toBeCloseTo(15.4, 9)
    expect(undoLabels()).toEqual(['Agent: add parameter d', 'Agent: add 2 parameters'])

    // One refused, none added — and said which.
    const clash = await refused('reverse.parameter.add', { parameters: [{ name: 'w', expression: '2' }, { name: 'head', expression: '1' }] })
    expect(clash.message).toMatch(/^parameters\[1\] “head”/)
    expect((await refused('reverse.parameter.add', { parameters: [{ name: 'w', expression: 'v * 2' }, { name: 'v', expression: '1' }] })).message).toMatch(/parameters\[0\]/)
    expect((await refused('reverse.parameter.add', { name: 'w' })).code).toBe('invalid_input')
    expect((await refused('reverse.parameter.add', { parameters: [{ name: 'w', expression: '1', colour: 'red' }] })).message).toMatch(/input\.parameters\[0\]\.colour: not a known field/)
    expect((await refused('reverse.parameter.add', { name: 'w', expression: '1', parameters: [{ name: 'v', expression: '2' }] })).code).toBe('invalid_input')
    expect(useReverse.getState().parameters.map((p) => p.name)).toEqual(['d', 'head', 'l1'])

    // A change answers with the parameter and those whose value followed it.
    const set = await run<{ parameter: { name: string; value: number }; parameters?: unknown; followed: { name: string; value: number }[] }>('reverse.parameter.set', { parameter: 'd', expression: '4' })
    expect(set.parameter).toMatchObject({ name: 'd', value: 4 })
    expect(set.parameters).toBeUndefined()
    expect(set.followed.map((p) => p.name)).toEqual(['head', 'l1'])
    expect(set.followed[1].value).toBeCloseTo(17.2, 9)
    expect(await run('reverse.parameter.remove', { parameter: 'l1' })).toEqual({ removed: { id: expect.any(Number), name: 'l1' }, left: 2 })
  })
})

describe('the commands hold to the panel’s rules', () => {
  it('refuses what does not fit, leaving no box open and no undo step', async () => {
    await run('reverse.parameter.add', { name: 'l1', expression: '12' })
    expect((await refused('reverse.parameter.add', { name: 'l1', expression: '3' })).code).toBe('invalid_input')
    expect((await refused('reverse.parameter.add', { name: 'mm', expression: '3' })).message).toMatch(/word the expressions keep/)
    expect((await refused('reverse.parameter.add', { name: 'w', expression: 'nope + 1' })).code).toBe('invalid_input')
    expect((await refused('reverse.parameter.set', { parameter: 'l1', expression: '10 deg' })).code).toBe('invalid_input')

    // A constraint naming a piece the sketch has not got, or a point a piece
    // has not got — a line has its ends; an arc its ends and its centre.
    const bad = pinSketch('l1')
    bad.sketch.constraints.push({ kind: 'length', entity: 9, value: 3 })
    expect((await refused('reverse.feature.add', { feature: bad })).message).toMatch(/there is no piece 9/)
    const middle = pinSketch('l1')
    middle.sketch.constraints.push({ kind: 'pointOn', p: { entity: 2, at: 'center' }, on: { datum: 'xy' } } as never)
    expect((await refused('reverse.feature.add', { feature: middle })).message).toMatch(/a line has no point “center” — it has a, b/)
    // Dimensions that contradict each other do not solve.
    const tight = pinSketch('l1')
    tight.sketch.constraints.push({ kind: 'length', entity: 4, value: 7 })
    expect((await refused('reverse.feature.add', { feature: tight })).code).toBe('failed')
    // An expression that does not evaluate.
    expect((await refused('reverse.feature.add', { feature: pinSketch('l2 * 2') })).message).toMatch(/l2/)
    // A field the schema does not have.
    expect((await refused('reverse.feature.add', { feature: { ...pinSketch('l1'), colour: 'red' } })).code).toBe('invalid_input')

    const r = useReverse.getState()
    expect([r.sketchDraft, r.extrudeDraft, r.revolveDraft, r.featureDraft]).toEqual([null, null, null, null])
    expect(r.features).toHaveLength(0)
    expect(undoLabels()).toEqual(['Agent: add parameter l1'])
  })

  it('keeps what others are made on, picks regions by point, and edits features as the panel does', async () => {
    await run('reverse.parameter.add', { name: 'l1', expression: '12' })
    await pin()
    expect((await refused('reverse.feature.remove', { feature: 'Pin profile' })).message).toMatch(/used by Revolve 1/)
    expect((await refused('reverse.parameter.remove', { parameter: 'l1' })).code).toBe('invalid_state')

    // An arc's centre is a point a constraint may name: a dome centred on
    // the axis.
    const dome = await run<Brief>('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Dome',
        plane: { kind: 'world', axis: 'y' },
        sketch: {
          entities: [
            { id: 1, kind: 'arc', c: [0.1, 0], r: 3, start: 0, sweep: Math.PI / 2 },
            { id: 2, kind: 'line', a: [0, 3], b: [0, 0] },
            { id: 3, kind: 'line', a: [0, 0], b: [3, 0] },
          ],
          constraints: [
            { kind: 'coincident', p: { entity: 1, at: 'b' }, q: { entity: 2, at: 'a' } },
            { kind: 'coincident', p: { entity: 2, at: 'b' }, q: { entity: 3, at: 'a' } },
            { kind: 'coincident', p: { entity: 3, at: 'b' }, q: { entity: 1, at: 'a' } },
            { kind: 'coincident', p: { entity: 1, at: 'center' }, q: { entity: 2, at: 'b' } },
            { kind: 'radius', entity: 1, value: 3 },
          ],
        },
      },
    })
    expect(dome.solve?.ok).toBe(true)
    expect(dome.regions).toHaveLength(1)

    // Two regions — a ring — need saying which.
    const ring = {
      kind: 'sketch',
      name: 'Ring',
      plane: { kind: 'world', axis: 'z', offset: 12 },
      sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 4 }, { id: 2, kind: 'circle', c: [0, 0], r: 2.5 }] },
    }
    const made = await run<Brief>('reverse.feature.add', { feature: ring })
    expect(made.regions).toHaveLength(2)
    expect((await refused('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Ring', extent: { kind: 'distance', from: 0, to: 2 } } })).message).toMatch(/2 closed regions/)
    const collar = await run<Answer>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Collar', sketchId: 'Ring', regions: [{ at: [3.2, 0] }], extent: { kind: 'distance', from: 0, to: 2 }, exprs: { 'extent.to': 'l1 / 6' }, op: 'new' }, detail: 'full' })
    expect(collar.result?.status).toBe('ok')
    expect(collar.feature).toMatchObject({ name: 'Collar', extent: { kind: 'distance', from: 0, to: 2 }, exprs: { 'extent.to': 'l1 / 6' } })
    expect(collar.bodies.map((b) => b.name)).toEqual(['Solid 1', 'Solid 2'])
    const collarBody = collar.bodies[1]
    expect(collarBody.volume).toBeCloseTo(Math.PI * (4 ** 2 - 2.5 ** 2) * 2, 1)

    // A number typed over a field's expression lets it go; the revolve's
    // angle edited; the sketch's dimension made an expression.
    const edited = await run<Answer & { feature: { exprs?: unknown; extent: { to: number } } }>('reverse.feature.update', { feature: 'Collar', set: { extent: { kind: 'distance', from: 0, to: 3 } }, detail: 'full' })
    expect(edited.feature.extent.to).toBe(3)
    expect(edited.feature.exprs).toBeUndefined()
    const half = await run<Answer & { feature: { angleDeg: number } }>('reverse.feature.update', { feature: 'Revolve 1', set: { angleDeg: 180 }, detail: 'full' })
    expect(half.feature.angleDeg).toBe(180)
    expect(half.bodies[0].volume).toBeCloseTo((Math.PI * 1.5 ** 2 * 12) / 2, 1)
    const listed = await run<{ sketch: { entities: unknown[]; constraints: { id: number; kind: string; expr?: string }[] } }>('reverse.feature.list', { feature: 'Pin profile' })
    const widened = listed.sketch.constraints.map((c) => (c.kind === 'length' && !c.expr ? { ...c, value: undefined, expr: 'l1 / 6' } : c))
    const resketched = await run<Brief>('reverse.feature.update', { feature: 'Pin profile', set: { sketch: { entities: listed.sketch.entities, constraints: widened } } })
    expect(resketched.solve?.ok).toBe(true)
    // Brief: the revolve's body changed; the collar's did not.
    expect(resketched.bodies.count).toBe(2)
    expect(resketched.bodies.changed!.map((b) => b.name)).toEqual(['Solid 1'])
    expect(resketched.bodies.changed![0].volume).toBeCloseTo((Math.PI * 2 ** 2 * 12) / 2, 1)

    // The rollback bar, and a feature below it edited: the bar put past
    // it, the edit made, the bar at the end again and the rest built on it.
    const rolled = await run<{ rollback: { at: number; of: number } }>('reverse.feature.rollback', { after: 'Revolve 1' })
    expect(rolled.rollback).toEqual({ at: 2, of: 5 })
    const below = await run<Brief & { rollback: { at: number; of: number } }>('reverse.feature.update', { feature: 'Collar', set: { extent: { kind: 'distance', from: 0, to: 4 } } })
    expect(below.result?.status, below.result?.message).toBe('ok')
    expect(below.rollback).toEqual({ at: 5, of: 5 })
    expect(below.bodies.changed!.find((b) => b.name === 'Solid 2')!.volume).toBeCloseTo(Math.PI * (4 ** 2 - 2.5 ** 2) * 4, 1)
    expect((await run<{ rollback: { at: number } }>('reverse.feature.rollback', { to: null })).rollback.at).toBe(5)

    expect(undoLabels()).toEqual([
      'Agent: add parameter l1',
      'Agent: add sketch “Pin profile”',
      'Agent: add revolve',
      'Agent: add sketch “Dome”',
      'Agent: add sketch “Ring”',
      'Agent: add extrude “Collar”',
      'Agent: edit Collar',
      'Agent: edit Revolve 1',
      'Agent: edit Pin profile',
      'Agent: move rollback bar',
      'Agent: edit Collar',
    ])
  })

  it('refuses while the kernel is loading, and while a panel box holds work', async () => {
    useReverse.setState({ kernelStatus: 'loading' })
    try {
      const busy = await refused('reverse.parameter.add', { name: 'w', expression: '3' })
      expect(busy.code).toBe('busy')
      expect(busy.message).toMatch(/CAD kernel is loading/)
      expect(((await run<{ busy: string }>('session.state')) as { busy: string }).busy).toBe('the CAD kernel is loading')
    } finally {
      useReverse.setState({ kernelStatus: 'ready' })
    }
    useReverse.getState().startSketch({ kind: 'world', axis: 'z', offset: 0 }, { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    useReverse.getState().setSketch({ entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 2 }], constraints: [], nextId: 2 })
    expect((await refused('reverse.parameter.add', { name: 'w', expression: '3' })).code).toBe('invalid_state')
    expect(useReverse.getState().sketchDraft).not.toBeNull()
    useReverse.getState().discardSketch()
    // An empty sketch merely in hand is closed for the command.
    useReverse.getState().startSketch({ kind: 'world', axis: 'z', offset: 0 }, { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    await run('reverse.parameter.add', { name: 'w', expression: '3' })
    expect(useReverse.getState().sketchDraft).toBeNull()
  })

  it('lists its commands under the plugin’s id; the view needs a viewport', async () => {
    const names = listCommands().map((c) => c.name)
    expect(names.filter((n) => n.startsWith('reverse.'))).toEqual([
      'reverse.body.check',
      'reverse.body.clearance',
      'reverse.body.compare',
      'reverse.body.compare_in_deviation',
      'reverse.body.describe',
      'reverse.body.fillet_read',
      'reverse.body.fillet_try',
      'reverse.body.probe',
      'reverse.body.review',
      'reverse.body.section',
      'reverse.body.set',
      'reverse.body.volume_compare',
      'reverse.build',
      'reverse.build.stop',
      'reverse.export.step',
      'reverse.export.stl',
      'reverse.feature.add',
      'reverse.feature.clear',
      'reverse.feature.list',
      'reverse.feature.move',
      'reverse.feature.refit',
      'reverse.feature.remove',
      'reverse.feature.rollback',
      'reverse.feature.schema',
      'reverse.feature.suppress',
      'reverse.feature.update',
      'reverse.import.step',
      'reverse.network.create',
      'reverse.network.edit',
      'reverse.network.read',
      'reverse.network.suggest_creases',
      'reverse.note.add',
      'reverse.note.list',
      'reverse.note.resolve',
      'reverse.parameter.add',
      'reverse.parameter.list',
      'reverse.parameter.remove',
      'reverse.parameter.rename',
      'reverse.parameter.set',
      'reverse.plan.replace',
      'reverse.plan.set',
      'reverse.plan.tick',
      'reverse.plan.update',
      'reverse.plane.describe',
      'reverse.scan.tube_trace',
      'reverse.section.fit',
      'reverse.section.outline',
      'reverse.section.stack',
      'reverse.sketch.candidates',
      'reverse.sketch.edit',
      'reverse.thread.read',
    ])
    // An export runs as a job in an agent's server, its call answered at the limit.
    for (const name of ['reverse.export.step', 'reverse.export.stl']) expect(listCommands().find((c) => c.name === name)).toMatchObject({ readOnly: true, long: true, returnsFile: true })
    await run('reverse.parameter.add', { name: 'l1', expression: '12' })
    await pin()
    expect((await refused('reverse.body.compare')).code).toBe('no_scan')
    expect((await refused('view.render')).code).toBe('unavailable')
    await expect(runCommand('reverse.parameter.rename', { parameter: 'l1', name: 'length' })).resolves.toMatchObject({ parameter: { name: 'length' } })
    const listed = await run<{ features: { kind: string; sketch?: { constraints: { expr?: string }[] } }[] }>('reverse.feature.list', { detail: 'full' })
    expect(listed.features[0].sketch!.constraints.some((c) => c.expr === 'length')).toBe(true)
    expect(useStore.getState().fileName).toBeNull()
  })
})

describe('what a change made', () => {
  type Made = { body: { id: number; name: string }; faces: { index: number; kind: string; normal?: number[]; axis?: number[]; centroid: number[]; radius?: number; area: number }[]; edges: { index: number; kind: string; length: number; mid: number[]; radius?: number; faces: (number | null)[] }[]; of?: { faces: number; edges: number } }[]
  type Described = { bodies: { faceList: { index: number; kind: string; centroid: number[] }[]; edgeList: { index: number; mid: number[] }[] }[] }

  it('names the faces and edges a feature made, by the index describe gives them, so the next pick needs no describe', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Base', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [30, 20], fixed: true }] } } })
    const sketched = await run<{ made?: Made }>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Other', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [5, 5], fixed: true }] } } })
    expect(sketched.made, 'a sketch makes no face').toBeUndefined()
    const block = await run<{ made: Made; bodies: { changed: { id: number }[] } }>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Base', regions: 'all', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
    expect(block.made).toHaveLength(1)
    const made = block.made[0]
    expect(made.body.id).toBe(block.bodies.changed[0].id)
    expect(made.faces).toHaveLength(6)
    expect(made.edges).toHaveLength(12)
    expect(made.of).toBeUndefined()
    // The same indices describe gives.
    const described = await run<Described>('reverse.body.describe', { body: made.body.id })
    const top = made.faces.find((f) => f.normal && f.normal[2] > 0.99)!
    expect(described.bodies[0].faceList[top.index].centroid).toEqual(top.centroid)
    const edge = made.edges[0]
    expect(described.bodies[0].edgeList[edge.index].mid).toEqual(edge.mid)
    expect(edge.faces.every((i) => i !== null && i >= 0)).toBe(true)

    // A round on the top edges: its four rounds and their edges, the
    // block's own faces trimmed but not the round's.
    const rounded = await run<{ made: Made; feature: { status: string } }>('reverse.feature.add', { feature: { kind: 'fillet', body: made.body.id, edges: [{ between: [[0, 0, 1]] }], radius: 2 } })
    expect(rounded.feature.status).toBe('ok')
    const rounds = rounded.made[0].faces.filter((f) => f.kind === 'cylinder')
    expect(rounds).toHaveLength(4)
    expect(rounds.every((f) => Math.abs(f.radius! - 2) < 1e-6 && f.axis)).toBe(true)
    expect(rounded.made[0].faces.every((f) => f.kind !== 'plane' || f.normal![2] < 0.99)).toBe(true)
    // detail none says nothing of it.
    const quiet = await run<{ made?: Made }>('reverse.feature.update', { feature: rounded.feature && 'Fillet 1', set: { radius: 1.5 }, detail: 'none' })
    expect(quiet.made).toBeUndefined()
  })
})

describe('sketching the short way', () => {
  /** A board with its parts drawn as shapes: no coincidence written out. */
  const board = {
    kind: 'sketch',
    name: 'Board',
    plane: { kind: 'world', axis: 'z' },
    sketch: {
      shapes: [
        { kind: 'rectangle', id: 1, center: [0, 0], size: [60, 40] },
        { kind: 'polygon', id: 20, center: [-22, 12], sides: 6, radius: 2.5, fit: 'circumscribed' },
        { kind: 'rectangle', id: 40, from: [-10, -5], to: [-6, -3] },
        { kind: 'polyline', id: 60, points: [[10, 5], [20, 5], [20, 15]], closed: true },
      ],
      patterns: [
        { kind: 'rectangular', pieces: [40, 41, 42, 43], step: [6, 0], count: 4 },
        { kind: 'circular', pieces: [20, 21, 22, 23, 24, 25, 26, 27], center: [0, 0], count: 2, angleDeg: 360 },
      ],
    },
  }

  it('draws rectangles, polygons and chains in one go, joins them, and repeats pieces', async () => {
    const made = await run<Brief>('reverse.feature.add', { feature: board })
    expect(made.solve?.ok).toBe(true)
    expect(made.solve?.redundant).toBe(0)
    expect(made.shapes!.map((x) => x.kind)).toEqual(['rectangle', 'polygon', 'rectangle', 'polyline'])
    expect(made.shapes![0]).toMatchObject({ sides: [1, 2, 3, 4], center: 7 })
    expect(made.shapes![1].sides).toEqual([20, 21, 22, 23, 24, 25])
    expect(made.shapes![3].lines).toEqual([60, 61, 62])
    expect(made.patterns![0].copies).toHaveLength(3)
    expect(made.patterns![1].copies).toHaveLength(1)
    // The board, with eight holes in it: a hex nut either side, four pads,
    // the triangle.
    expect(made.regions).toHaveLength(1 + 2 + 4 + 1)
    // A brief answer is a fraction of the full one.
    const full = await run<Answer>('reverse.feature.list', { feature: 'Board' })
    expect(JSON.stringify(made).length).toBeLessThan(JSON.stringify(full).length / 3)

    // Every region but the board, cut through a plate of it.
    const plate = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Plate', sketchId: 'Board', regions: [{ at: [25, 15] }], extent: { kind: 'distance', from: 0, to: 1.6 }, op: 'new' } })
    expect(plate.result?.status).toBe('ok')
    expect(plate.bodies.count).toBe(1)
    const solid = 60 * 40 * 1.6
    expect(plate.bodies.changed![0].volume).toBeLessThan(solid)
    expect(plate.bodies.changed![0].volume).toBeGreaterThan(solid * 0.9)
  })

  it('edits a sketch piece by piece: adds, repeats what it has, takes out', async () => {
    const drawn = await run<Brief & { freeIds: number }>('reverse.feature.add', { feature: board })
    // Pieces and relations share one run of ids: a new piece on one a
    // relation has is given the first free one, and what the add names it
    // by — its radius, its pattern — follows it.
    const free = drawn.freeIds
    const takenId = (await run<{ sketch: { constraints: { id: number }[] } }>('reverse.feature.list', { feature: 'Board' })).sketch.constraints.at(-1)!.id
    const hole = await run<Brief & { renumbered?: Record<string, number> }>('reverse.sketch.edit', {
      sketch: 'Board',
      add: { entities: [{ id: takenId, kind: 'circle', c: [26, -17], r: 1.6 }], constraints: [{ kind: 'radius', entity: takenId, expr: '3.2 / 2' }], patterns: [{ kind: 'rectangular', pieces: [takenId], step: [-52, 0], count: 2, step2: [0, 34], count2: 2 }] },
    })
    expect(hole.renumbered).toEqual({ [String(takenId)]: free })
    expect(hole.solve?.ok).toBe(true)
    expect(hole.patterns![0].copies).toHaveLength(3)
    expect(hole.regions).toHaveLength(8 + 4)
    // Each copy keeps the radius dimension, reading the same expression.
    const listed = await run<{ sketch: { constraints: { kind: string; entity?: number; expr?: string }[] } }>('reverse.feature.list', { feature: 'Board' })
    expect(listed.sketch.constraints.filter((c) => c.kind === 'radius' && c.expr === '3.2 / 2')).toHaveLength(4)

    // The triangle out, by its three lines.
    const out = await run<Brief>('reverse.sketch.edit', { sketch: 'Board', remove: { pieces: [60, 61, 62] } })
    expect(out.removed).toMatchObject({ pieces: 3 })
    expect(out.regions).toHaveLength(11)
    expect((await refused('reverse.sketch.edit', { sketch: 'Board', remove: { pieces: [60] } })).code).toBe('not_found')
    expect((await refused('reverse.sketch.edit', { sketch: 'Board', add: { entities: [{ id: 1, kind: 'point', p: [0, 0] }] } })).message).toMatch(/share the id 1.*are free/)
    expect(undoLabels()).toEqual(['Agent: add sketch “Board”', 'Agent: edit Board', 'Agent: edit Board'])
  })
})

describe('an extrude’s lean as an expression', () => {
  it('goes in and comes back as draftDeg, its sign the field’s, not the panel’s taper', async () => {
    await run('reverse.parameter.add', { name: 'draft', expression: '2', kind: 'angle' })
    await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Base', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [20, 20] }] } } })
    const made = await run<Answer & { feature: { exprs?: Record<string, string>; draftDeg: number } }>('reverse.feature.add', {
      feature: { kind: 'extrude', name: 'Block', sketchId: 'Base', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new', exprs: { draftDeg: 'draft' } },
      detail: 'full',
    })
    expect(made.feature.draftDeg).toBeCloseTo(2, 9)
    expect(made.feature.exprs).toEqual({ draftDeg: 'draft' })
    // Positive leans in: the top is smaller than the base.
    expect(made.bodies[0].volume).toBeLessThan(20 * 20 * 10)
    const listed = await run<{ exprs: Record<string, string> }>('reverse.feature.list', { feature: 'Block' })
    expect(listed.exprs).toEqual({ draftDeg: 'draft' })
    expect((await refused('reverse.feature.update', { feature: 'Block', set: { exprs: { draftDeg: '1', taper: '1' } } })).message).toMatch(/not both/)
    const out = await run<Answer & { feature: { exprs?: Record<string, string>; draftDeg: number } }>('reverse.feature.update', { feature: 'Block', set: { exprs: { draftDeg: '-(draft)' } }, detail: 'full' })
    expect(out.feature.draftDeg).toBeCloseTo(-2, 9)
    expect(out.feature.exprs).toEqual({ draftDeg: '-(draft)' })
  })
})

describe('a sketch plane at an offset', () => {
  it('follows a parameter along its axis, and stands off a body’s face', async () => {
    await run('reverse.parameter.add', { name: 'h', expression: '5' })
    const lifted = await run<Brief>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Lid', plane: { kind: 'world', axis: 'z' }, exprs: { offset: 'h' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [10, 6] }] } } })
    expect(lifted.solve?.ok).toBe(true)
    const lid = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Lid', extent: { kind: 'distance', from: 0, to: 2 }, op: 'new' } })
    expect(lid.bodies.changed![0].bounds.min[2]).toBeCloseTo(5, 6)
    const raised = await run<{ bodies: Changed; changed: string[] }>('reverse.parameter.set', { parameter: 'h', expression: '8' })
    expect(raised.changed).toContain('Lid')
    expect(raised.bodies.changed![0].bounds.min[2]).toBeCloseTo(8, 6)
    const listed = await run<{ plane: { offset: number }; exprs: { offset: string } }>('reverse.feature.list', { feature: 'Lid' })
    expect(listed).toMatchObject({ plane: { offset: 8 }, exprs: { offset: 'h' } })

    // A boss 3 mm off the lid's top face: a sketch on the face, offset.
    const top = (await describeBody(lid.bodies.changed![0].id)).faceList.find((f) => f.kind === 'plane' && (f as unknown as { normal: Vec3 }).normal[2] > 0.9)!
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Above', plane: { kind: 'bodyFace', body: 'Solid 1', face: top.index, offset: 3 }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 1 }] } } })
    const boss = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Above', extent: { kind: 'distance', from: 0, to: 1 }, op: 'new' } })
    expect(boss.bodies.changed![0].bounds.min[2]).toBeCloseTo(8 + 2 + 3, 6)
    // Moved along by an update; and the lid's parameter takes the boss with it.
    await run('reverse.feature.update', { feature: 'Above', set: { offset: 4 } })
    expect((await run<{ bodies: Body[] }>('reverse.build')).bodies.find((b) => b.name === 'Solid 2')!.bounds.min[2]).toBeCloseTo(14, 6)
    await run('reverse.parameter.set', { parameter: 'h', expression: '6' })
    expect((await run<{ bodies: Body[] }>('reverse.build')).bodies.find((b) => b.name === 'Solid 2')!.bounds.min[2]).toBeCloseTo(12, 6)
    expect((await refused('reverse.feature.update', { feature: 'Lid', set: { exprs: { offset: 'nope' } } })).message).toMatch(/nope/)
  })
})

describe('a body by the name of the feature that made it', () => {
  it('takes the feature’s name for its body, and says so when there are several or none', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Plan', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [20, 10] }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', name: 'Lid raw', sketchId: 'Plan', extent: { kind: 'distance', from: 0, to: 2 }, op: 'new' } })
    const named = await run<{ body: Body }>('reverse.body.set', { body: 'Lid raw', name: 'Lid' })
    expect(named.body.name).toBe('Lid')
    // The body's own name still comes first.
    expect((await run<{ body: Body }>('reverse.body.set', { body: 'Lid', color: 'red' })).body.name).toBe('Lid')
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Pins', plane: { kind: 'world', axis: 'z', offset: 5 }, sketch: { entities: [{ id: 1, kind: 'circle', c: [-5, 0], r: 1 }, { id: 2, kind: 'circle', c: [5, 0], r: 1 }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', name: 'Pin pair', sketchId: 'Pins', regions: 'all', extent: { kind: 'distance', from: 0, to: 2 }, op: 'new' } })
    expect((await refused('reverse.body.set', { body: 'Pin pair', name: 'x' })).message).toMatch(/made 2 bodies/)
    expect((await refused('reverse.body.set', { body: 'Plan', name: 'x' })).code).toBe('not_found')
  })
})

describe('bodies named and coloured', () => {
  it('names and colours a body, carries both into the STEP file and the project, and undoes them', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Board', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [20, 10] }] } } })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Board', extent: { kind: 'distance', from: 0, to: 1.6 }, op: 'new' } })
    const named = await run<{ body: Body & { style: unknown } }>('reverse.body.set', { body: 'Solid 1', name: 'PCB', color: 'pcb blue' })
    expect(named.body).toMatchObject({ name: 'PCB', style: { name: 'PCB', color: '#1d3f7a' } })
    expect(useReverse.getState().bodies[0]).toMatchObject({ name: 'PCB', color: '#1d3f7a' })
    expect((await refused('reverse.body.set', { body: 'PCB', color: 'mauve-ish' })).message).toMatch(/no colour/)
    expect((await refused('reverse.body.set', { body: 'PCB' })).code).toBe('invalid_input')
    const step = await run<{ file: { bytes: Uint8Array } }>('reverse.export.step')
    expect(new TextDecoder().decode(step.file.bytes)).toContain("PRODUCT('PCB'")
    expect(collectReversePart()?.bodyStyles).toEqual({ 2: { name: 'PCB', color: '#1d3f7a' } })

    // A colour taken back keeps the name; the name taken back is Solid 1.
    await run('reverse.body.set', { body: 'PCB', color: null })
    expect(useReverse.getState().bodyStyles).toEqual({ 2: { name: 'PCB' } })
    expect(undoLabels().slice(-2)).toEqual(['Agent: name body “PCB”', 'Agent: colour body PCB'])
    await run('history.undo')
    await run('history.undo')
    await run('reverse.build')
    expect(useReverse.getState().bodies[0].name).toBe('Solid 1')
    expect(useReverse.getState().bodyStyles).toEqual({})
  })
})

describe('a case round a part, through the commands', () => {
  it('grows a keep-out round the part, cuts it from the case, and reads the clearance left', async () => {
    const box = (name: string, center: [number, number], size: [number, number]) => ({ kind: 'sketch', name, plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center, size }] } })
    await run('reverse.feature.add', { feature: box('Case outline', [0, 0], [40, 30]) })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Case outline', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
    await run('reverse.feature.add', { feature: box('Module outline', [0, 0], [20, 12]) })
    await run('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Module outline', extent: { kind: 'distance', from: 4, to: 14 }, op: 'new' } })
    await run('reverse.body.set', { body: 'Solid 1', name: 'Case' })
    await run('reverse.body.set', { body: 'Solid 2', name: 'Module' })
    const before = await run<{ against: { name: string; gap: number; overlap?: number }[] }>('reverse.body.clearance', { body: 'Module' })
    expect(before.against).toEqual([{ id: expect.any(Number), name: 'Case', gap: 0, overlap: expect.closeTo(20 * 12 * 6, 3), touching: true }])

    const keepOut = await run<Brief>('reverse.feature.add', { feature: { kind: 'offsetBody', body: 'Module', distance: 0.4 } })
    expect(keepOut.result?.status).toBe('ok')
    expect(keepOut.bodies.changed).toHaveLength(1)
    const pocket = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', op: 'cut', body: 'Case', tool: keepOut.bodies.changed![0].name } })
    expect(pocket.result?.status).toBe('ok')
    const after = await run<{ against: { name: string; gap: number }[] }>('reverse.body.clearance', { body: 'Module', against: ['Case'] })
    expect(after.against[0].gap).toBeCloseTo(0.4, 3)
  })

  it('drills a hole for a heat-set insert into a standoff’s top', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Standoff', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 3.5 }] } } })
    const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Standoff', extent: { kind: 'distance', from: 0, to: 8 }, op: 'new' } })
    const top = (await describeBody(made.bodies.changed![0].id)).faceList.find((f) => f.kind === 'plane' && (f as unknown as { normal: Vec3 }).normal[2] > 0.9)!
    const hole = await run<Answer & { feature: { insert: string; radius: number; depth: number } }>('reverse.feature.add', { feature: { kind: 'hole', body: 'Solid 1', axis: { kind: 'point', face: top.index }, insert: 'M3' }, detail: 'full' })
    expect(hole.result?.status).toBe('ok')
    expect(hole.feature).toMatchObject({ insert: 'M3', radius: 2, depth: 6.7 })
    expect(hole.bodies[0].volume).toBeCloseTo(Math.PI * (3.5 ** 2 * 8 - 2 ** 2 * 6.7), 2)
    expect((await refused('reverse.feature.add', { feature: { kind: 'hole', body: 'Solid 1', axis: { kind: 'point', face: top.index }, insert: 'M7' } })).code).toBe('invalid_input')
    expect((await refused('reverse.feature.add', { feature: { kind: 'hole', body: 'Solid 1', axis: { kind: 'point', face: top.index } } })).message).toMatch(/radius, or an insert/)
    // A hole drilled beside the body meets nothing of it: a failure that
    // says so, not an ok feature that changed nothing. The body is as it was.
    const beside = await run<Brief>('reverse.feature.add', { feature: { kind: 'hole', body: 'Solid 1', axis: { kind: 'point', face: top.index, at: [30, 30, 8] }, radius: 1, depth: 5 } })
    expect(beside.result?.status).toBe('failed')
    expect(beside.result?.message).toMatch(/meets nothing of Extrude 1/)
    const left = await run<{ bodies: { volume: number }[] }>('reverse.body.describe', { body: 'Solid 1' })
    expect(left.bodies[0].volume).toBeCloseTo(Math.PI * (3.5 ** 2 * 8 - 2 ** 2 * 6.7), 2)
  })
})

describe('a boolean further up re-pointed', () => {
  it('names its tool among the bodies as they stood when it was built — one a later feature takes in — in one undo step', async () => {
    const box = (name: string, center: [number, number], size: [number, number]) => ({ kind: 'sketch', name, plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', center, size }] } })
    const solid = async (name: string, center: [number, number], size: [number, number], to: number) => {
      await run('reverse.feature.add', { feature: box(`${name} plan`, center, size) })
      const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: `${name} plan`, extent: { kind: 'distance', from: 0, to }, op: 'new' } })
      await run('reverse.body.set', { body: made.bodies.changed![0].id, name })
    }
    await solid('Plate', [0, 0], [40, 20], 4)
    await solid('Left', [-10, 0], [4, 4], 10)
    await solid('Right', [10, 0], [6, 6], 10)
    await run('reverse.feature.add', { feature: { kind: 'boolean', name: 'Cut left', op: 'cut', body: 'Plate', tool: 'Left' } })
    await run('reverse.feature.add', { feature: { kind: 'boolean', name: 'Cut right', op: 'cut', body: 'Plate', tool: 'Right' } })
    expect(useReverse.getState().bodies.map((b) => b.name)).toEqual(['Plate'])
    const steps = undoLabels().length
    // Right stands no more at the bar — Cut right took it in — but it stood
    // when Cut left was built.
    const edited = await run<Brief>('reverse.feature.update', { feature: 'Cut left', set: { tool: 'Right' } })
    expect(edited.result?.status).toBe('ok')
    expect(undoLabels().length).toBe(steps + 1)
    expect(useReverse.getState().rolledBack).toEqual([])
    const cutLeft = useReverse.getState().features.find((f) => f.name === 'Cut left') as { tool: number }
    expect(useReverse.getState().bodyStyles[cutLeft.tool]?.name).toBe('Right')
    // Left stands again, and the plate has the right pocket alone.
    const bodies = useReverse.getState().bodies
    expect(bodies.map((b) => b.name).sort()).toEqual(['Left', 'Plate'])
    expect(bodies.find((b) => b.name === 'Plate')!.volume).toBeCloseTo(40 * 20 * 4 - 6 * 6 * 4, 3)
  })
})

/** A schema with its $refs put back in place of their $defs — and of the
 *  parts it names by $ref alone (refs), each asked for on its own as an
 *  agent asks for it ({ def }), and put back the same way. */
async function expand(schema: Record<string, unknown>): Promise<unknown> {
  const { $defs, ...rest } = schema as { $defs?: Record<string, unknown> }
  const asked = new Map<string, unknown>()
  const refs = new Set<string>()
  const find = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    const ref = (v as { $ref?: string }).$ref
    if (ref && !($defs && ref.replace('#/$defs/', '') in $defs)) refs.add(ref.replace('#/$defs/', ''))
    for (const x of Object.values(v)) find(x)
  }
  find(rest)
  find($defs ?? {})
  for (const name of refs) asked.set(name, await expand((await run<{ schema: Record<string, unknown> }>('reverse.feature.schema', { def: name })).schema))
  const put = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    const ref = (v as { $ref?: string }).$ref
    if (ref) {
      const name = ref.replace('#/$defs/', '')
      return $defs && name in $defs ? put($defs[name]) : asked.get(name)
    }
    return Array.isArray(v) ? v.map(put) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]))
  }
  return put(rest)
}

describe('what an agent’s client is shown', () => {
  it('lists every command within the schema budget, feature.add loosely, and gives each kind’s whole shape on asking', async () => {
    // Claude Desktop turned feature.add down when it listed every kind in
    // full: 82 kB nested 20 deep.
    for (const c of listCommands().filter((x) => x.name.startsWith('reverse.'))) {
      const w = schemaWeight(c.input)
      expect(w.bytes, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.bytes)
      expect(w.depth, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.depth)
    }
    const whole = schemaWeight({ type: 'object', oneOf: FEATURE_KINDS.map(featureOf) })
    expect(whole.bytes).toBeGreaterThan(SCHEMA_BUDGET.bytes)

    const kinds = await run<{ kinds: { kind: string; required: string[]; example: boolean }[] }>('reverse.feature.schema')
    expect(kinds.kinds.map((k) => k.kind)).toEqual(FEATURE_KINDS)
    expect(kinds.kinds.find((k) => k.kind === 'thread')).toMatchObject({ required: ['body', 'face'], example: true })
    // A sketch's schema is past what is given whole: its fields, with what
    // each costs, and the example; a field by its dotted path is given whole.
    type Fields = Record<string, { chars: number; required?: true; what: string }>
    const sketch = await run<{ schema?: unknown; chars: number; fields: Fields; note: string; example: unknown; about: string }>('reverse.feature.schema', { kind: 'sketch' })
    expect(sketch.schema).toBeUndefined()
    expect(sketch.chars).toBeGreaterThan(20_000)
    expect(Object.keys(sketch.fields)).toEqual(Object.keys(FEATURE_IN.sketch.properties!))
    expect(sketch.fields.plane.required).toBe(true)
    expect(sketch.note).toMatch(/field: "sketch"/)
    expect(sketch.about).toMatch(/YZ plane/)
    const inner = await run<{ fields: Fields }>('reverse.feature.schema', { kind: 'sketch', field: 'sketch' })
    expect(Object.keys(inner.fields)).toContain('constraints')
    const constraints = await run<{ schema: Record<string, unknown>; field: string; example: unknown }>('reverse.feature.schema', { kind: 'sketch', field: 'sketch.constraints' })
    expect(await expand(constraints.schema)).toEqual(FEATURE_IN.sketch.properties!.sketch.properties!.constraints)
    expect(JSON.stringify(constraints.schema).length).toBe(inner.fields.constraints.chars)
    expect(constraints.example).toEqual((FEATURE_EXAMPLES.sketch.sketch as { constraints: unknown }).constraints)
    const plane = await run<{ schema: Record<string, unknown> }>('reverse.feature.schema', { kind: 'cutPlane', field: 'plane' })
    expect(await expand(plane.schema)).toEqual(FEATURE_IN.cutPlane.properties!.plane)
    // A field of a oneOf's branches, and a branch by its kind.
    expect((await run<{ schema: unknown }>('reverse.feature.schema', { kind: 'cutPlane', field: 'plane.angleDeg' })).schema).toMatchObject({ type: 'number' })
    expect((await run<{ schema: unknown }>('reverse.feature.schema', { kind: 'cutPlane', field: 'plane.radial' })).schema).toMatchObject({ required: ['kind', 'axis', 'angleDeg'] })
    expect((await refused('reverse.feature.schema', { kind: 'sketch', field: 'sketch.rules' })).message).toMatch(/sketch \(sketch\) has no field "rules"; its fields are .*constraints/)
    expect((await refused('reverse.feature.schema', { field: 'plane' })).code).toBe('invalid_input')
    // Each kind as handed out is its whole shape, the parts it holds more
    // than once given once — the extrude's plane and face picks, which
    // spelled out made it 35 kB — or, past 20 k, each of its fields so.
    for (const kind of FEATURE_KINDS) {
      const out = await run<{ schema?: Record<string, unknown>; fields?: Fields }>('reverse.feature.schema', { kind })
      if (out.schema) {
        expect(await expand(out.schema), kind).toEqual(FEATURE_IN[kind])
        continue
      }
      for (const field of Object.keys(out.fields!)) {
        const part = await run<{ schema?: Record<string, unknown> }>('reverse.feature.schema', { kind, field })
        if (part.schema) expect(await expand(part.schema), `${kind}.${field}`).toEqual(FEATURE_IN[kind].properties![field])
      }
    }
    const extrude = await run<{ schema: { $defs: Record<string, unknown> }; refs: Record<string, { chars: number; what: string }>; note: string }>('reverse.feature.schema', { kind: 'extrude' })
    expect(Object.keys(extrude.schema.$defs)).toEqual(expect.arrayContaining(['body']))
    expect(Object.keys(extrude.refs).sort()).toEqual(['face', 'plane'])
    expect(extrude.note).toMatch(/def: "face"/)
    expect(JSON.stringify(extrude.schema).length).toBeLessThan(JSON.stringify(FEATURE_IN.extrude).length / 2)
    // Every example is a feature its kind takes.
    for (const [kind, example] of Object.entries(FEATURE_EXAMPLES)) expect(validate(featureOf(kind), example, kind), kind).toEqual([])
    expect((await refused('reverse.feature.schema', { kind: 'helix' })).code).toBe('invalid_input')
  })

  it('names the large shared parts below the one asked by $ref, with their size, and answers one by def', async () => {
    // Round 19: a sketch's plane was 12.2 k, the face pick in it and the
    // where query in that spelled out; a cutPlane 13.0 k.
    type Out = { schema: Record<string, unknown>; refs?: Record<string, { chars: number; what: string }> }
    const size = (o: Out) => JSON.stringify(o).length
    const plane = await run<Out>('reverse.feature.schema', { kind: 'sketch', field: 'plane' })
    expect(size(plane)).toBeLessThan(5_000)
    expect(plane.refs!.face.what).toBe('A face of the body')
    const cut = await run<Out>('reverse.feature.schema', { kind: 'cutPlane' })
    expect(size(cut)).toBeLessThan(5_000)
    expect(Object.keys(cut.refs!)).toEqual(['plane'])
    expect(size(await run<Out>('reverse.feature.schema', { kind: 'loft', field: 'sections' }))).toBeLessThan(2_000)
    // Asked for on its own, a part answers the same way, the parts below it
    // named: the face pick, and the where query in it.
    const face = await run<Out & { def: string }>('reverse.feature.schema', { def: 'face' })
    expect(face.def).toBe('face')
    expect(Object.keys(face.refs!)).toEqual(['where'])
    expect(JSON.stringify(face.schema).length).toBe(plane.refs!.face.chars)
    const where = await run<Out>('reverse.feature.schema', { def: 'where' })
    expect(where.refs).toBeUndefined()
    expect(where.schema).toMatchObject({ title: 'where' })
    expect((await refused('reverse.feature.schema', { def: 'face', kind: 'hole' })).message).toMatch(/give def alone/)
    expect((await refused('reverse.feature.schema', { def: 'helix' })).code).toBe('invalid_input')
  })

  it('holds a feature to its kind’s whole shape when the command runs, and says where to look', async () => {
    const e = await refused('reverse.feature.add', { feature: { kind: 'thread', body: 'Solid 1', face: 0, standard: 'acme' } })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toMatch(/input\.feature\.standard: expected one of "metric", "unc", "unf", "print45"/)
    expect(e.message).toMatch(/reverse\.feature\.schema \{ kind: "thread" \}/)
    expect((await refused('reverse.feature.add', { feature: { kind: 'helix' } })).code).toBe('invalid_input')
    expect((await refused('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 1 } })).message).toMatch(/input\.feature\.extent: required/)
    // A measured plane's name given for its id: told where it goes.
    const named = await refused('reverse.feature.add', { feature: { kind: 'cutPlane', body: 'Solid 1', plane: { kind: 'plane', id: 'Key top' } } })
    expect(named.message).toMatch(/input\.feature\.plane\.id: "Key top" is a name, and id takes a number — a name goes in name/)
  })
})
