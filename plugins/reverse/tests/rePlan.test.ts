// SPDX-License-Identifier: AGPL-3.0-only
// The session plan (app/rePlan.ts): the first feature added with no plan
// answers a warning, once; reverse.plan.set takes the archetype's target
// by its class, reverse.plan.tick ticks or skips its regions; a feature
// removed after its build failed is kept for the verdict; the verdict says
// "not done" short of the target or with regions open, and the comparison
// in Deviation carries it; the plan goes with the project and is let go
// with the scan. On the 40 mm box scan.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../../../tests/helpers'
import { refused, run, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { useStore } from '../../../src/state/store'
import { planGate, planRegionAt, planSection, planVerdict, usePlan } from '../app/rePlan'
import { createReverseSession, installCompareInDeviation, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import plugin from '../plugin'

vi.setConfig({ testTimeout: 180_000 })

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await run('scan.open', { bytes: stlBytes(boxMesh(40, 40)), name: 'box-plan.stl', discard: true })
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})

const plate = { kind: 'sketch', name: 'Plate', plane: { kind: 'world', axis: 'z', offset: -20 }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [40, 40], fixed: true }] } }
const block = { kind: 'extrude', name: 'Block', sketchId: 'Plate', regions: 'all', extent: { kind: 'distance', from: 0, to: 40 }, op: 'new' }

const collect = () => JSON.parse(JSON.stringify(planSection.collect({ sources: {} as never, scanSaved: true, addMember: () => {} }) ?? null))
const open = (part: unknown) => planSection.prepare(part ?? undefined, { manifest: {} as never, members: new Map() })()

describe('the session plan', () => {
  it('warns at the first feature added with no plan, once a session', async () => {
    const first = await run<{ warning?: string }>('reverse.feature.add', { feature: plate })
    expect(first.warning).toMatch(/^no plan set: reverse\.plan\.set with the archetype, the regions and the target before building/)
    // The building guide unread is the other half of the same warning.
    expect(first.warning).toMatch(/the model guide's §2 Building was not read: guide_read \{ topic: "model", section: "2\. Building" \}/)
    const second = await run<{ warning?: string; planWarning?: string }>('reverse.feature.add', { feature: block })
    expect(second.warning ?? '').not.toMatch(/no plan set|§2 Building/)
    expect(second.planWarning).toBeUndefined()
  })

  it('does not ask for a plan with no scan open: a part drawn from a drawing has none', () => {
    const fileName = useStore.getState().fileName
    useStore.setState({ fileName: '' })
    try {
      expect(planGate(createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) }))).toBeNull()
    } finally {
      useStore.setState({ fileName })
    }
  })

  it('sets the target by the archetype’s class, or as given, and ticks or skips regions', async () => {
    const set = await run<{ plan: { archetype: string; target: { withinT: number; side: string; by: string }; open: number }; targetBy?: string }>('reverse.plan.set', {
      archetype: 'smoothSolidCasting',
      regions: [{ name: 'Body', function: 'the form', route: 'extruded profile', at: { min: [-20, -20, -20], max: [20, 20, 20] } }, { name: 'Tab', at: [20, 0, 0] }, { name: 'Gasket lip' }],
    })
    expect(set.plan.target).toEqual({ withinT: 85, side: 'scan', by: 'archetype' })
    expect(set.targetBy).toMatch(/casting or moulding/)
    expect(set.plan.open).toBe(3)

    const ticked = await run<{ region: { name: string; done: string }; open: string[] }>('reverse.plan.tick', { region: 'body', feature: 'Block' })
    expect(ticked.region).toMatchObject({ name: 'Body', done: 'Block' })
    expect(ticked.open).toEqual(['Tab', 'Gasket lip'])
    const skipped = await run<{ region: { skipped: string }; open: string[] }>('reverse.plan.tick', { region: 'Gasket lip', skip: 'a separate part' })
    expect(skipped.region.skipped).toBe('a separate part')
    expect(skipped.open).toEqual(['Tab'])
    expect((await refused('reverse.plan.tick', { region: 'Boss' })).message).toMatch(/no region “Boss”.*“Body”, “Tab”, “Gasket lip”/)
    expect((await refused('reverse.plan.tick', { region: 'Tab', feature: 'Block', skip: 'no' })).message).toMatch(/feature or skip, not both/)

    // A place names its region: inside the tab's reach before the body box
    // that holds it too — the nearer, then the smaller.
    expect(planRegionAt(session, [21, 0, 0])).toBe('Tab')
    expect(planRegionAt(session, [0, 0, 0])).toBe('Body')
    expect(planRegionAt(session, [60, 60, 60])).toBeUndefined()

    // Set again with a region more: the ticks stay by name; a target given
    // stands in for the class's.
    const again = await run<{ plan: { target: { withinT: number; by: string; tolerance: number } }; kept: string[] }>('reverse.plan.set', {
      archetype: 'machined',
      regions: [{ name: 'Body' }, { name: 'Tab' }, { name: 'Gasket lip' }, { name: 'Bore' }],
      target: { withinT: 92, tolerance: 0.2 },
    })
    expect(again.plan.target).toMatchObject({ withinT: 92, by: 'given', tolerance: 0.2 })
    expect(again.kept).toEqual(['Body', 'Gasket lip'])
    const state = await run<{ plugins: { reverse: { plan?: { archetype: string; open: number } } } }>('session.state')
    expect(state.plugins.reverse.plan).toMatchObject({ archetype: 'machined', open: 2 })
  })

  it('answers the verdict: not done short of the target or with regions open', async () => {
    const short = planVerdict(session, { withinT: 62.14, tolerance: 0.2 })!
    expect(short).toMatchObject({ target: 92, got: 62.1, met: false, regions: { open: ['Tab', 'Bore'], skipped: [{ name: 'Gasket lip', reason: 'a separate part' }] } })
    expect(short.next).toBe('not done: 62.1 % of 92; 2 regions open (Tab, Bore) — say so in the chat; the person signs off on less')
    // Read at a looser T than the plan's, the share does not count.
    expect(planVerdict(session, { withinT: 97, tolerance: 0.3 })).toMatchObject({ met: false, next: expect.stringMatching(/read at ±0\.3, the plan's T is ±0\.2/) })
    await run('reverse.plan.tick', { region: 'Tab' })
    await run('reverse.plan.tick', { region: 'Bore', skip: 'not on this part' })
    const met = planVerdict(session, { withinT: 93, tolerance: 0.2 })!
    expect(met).toMatchObject({ met: true, regions: { open: [] } })
    expect(met.next).toBeUndefined()

    // A feature patch over T on a place no skipped region covers stands
    // against the verdict — the fan's blades at 88.9 % — with its depth,
    // place and maker; one on a skipped region is the skip's. The regions
    // placed again (the second set gave them no at; the ticks stay).
    await run('reverse.plan.set', {
      archetype: 'machined',
      regions: [{ name: 'Body', at: { min: [-20, -20, -20], max: [20, 20, 20] } }, { name: 'Tab', at: [20, 0, 0] }, { name: 'Gasket lip' }, { name: 'Bore' }],
      target: { withinT: 92, tolerance: 0.2 },
    })
    const blades = planVerdict(session, { withinT: 93, tolerance: 0.2, featurePatches: [{ at: [0, 0, 0], depth: 0.52, madeBy: 'Blade' }, { at: [0, 0, 1], depth: 0.31 }] })!
    expect(blades).toMatchObject({ met: false, featurePatches: { overT: 2, worst: [{ at: [0, 0, 0], depth: 0.52, madeBy: 'Blade', region: 'Body' }, { at: [0, 0, 1], depth: 0.31 }] } })
    expect(blades.next).toBe('not done: 2 feature patches over T (0.52 mm at (0, 0, 0) by Blade on Body; 0.31 mm at (0, 0, 1) on Body) — model them, or add the place to the plan as a region skipped with its reason (a warp, lettering) and compare again — say so in the chat; the person signs off on less')
    const onSkipped = planVerdict(session, { withinT: 93, tolerance: 0.2, featurePatches: [{ at: [20.5, 0, 0], depth: 0.4 }] })!
    expect(onSkipped).toMatchObject({ met: false })
    await run('reverse.plan.tick', { region: 'Tab', skip: 'a warp, reported' })
    expect(planVerdict(session, { withinT: 93, tolerance: 0.2, featurePatches: [{ at: [20.5, 0, 0], depth: 0.4 }] })).toMatchObject({ met: true, featurePatches: { overT: 0 } })
    await run('reverse.plan.tick', { region: 'Tab', feature: 'Block' })

    // The comparison in Deviation carries it — here with no map read.
    const stop = installCompareInDeviation(async () => {})
    try {
      const out = await run<{ plan: { target: number; got: number | null; met: boolean }; next: string }>('reverse.body.compare_in_deviation', { ways: 'scan' })
      expect(out.plan).toMatchObject({ target: 92, got: null, met: false })
      expect(out.next).toMatch(/^not done: the scan side's share within T was not read/)
    } finally {
      stop()
    }
  })

  it('keeps a feature removed after its build failed, and the verdict lists it', async () => {
    const round = await run<{ feature: { status: string } }>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Too big', body: 'Block', edges: [0], radius: 60 } })
    expect(round.feature.status).toBe('failed')
    const removed = await run<{ removedAfterFailing: { name: string; kind: string; message: string; say: string } }>('reverse.feature.remove', { feature: 'Too big' })
    expect(removed.removedAfterFailing).toMatchObject({ name: 'Too big', kind: 'fillet', say: 'removed after failing — say so in the chat, with what it leaves' })
    expect(removed.removedAfterFailing.message.length).toBeGreaterThan(0)
    // One that built is no failure removed.
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Small', body: 'Block', edges: [0], radius: 1 } })
    expect((await run<{ removedAfterFailing?: unknown }>('reverse.feature.remove', { feature: 'Small' })).removedAfterFailing).toBeUndefined()
    // One that failed and was suppressed since was failing all the same.
    await run('reverse.feature.add', { feature: { kind: 'fillet', name: 'Put away', body: 'Block', edges: [0], radius: 60 } })
    await run('reverse.feature.suppress', { features: ['Put away'] })
    expect((await run<{ removedAfterFailing?: { name: string } }>('reverse.feature.remove', { feature: 'Put away', detail: 'none' })).removedAfterFailing?.name).toBe('Put away')

    // Removed and not built again, the verdict is not met — the fan's
    // root rounds, removed three times, read "met" without them.
    const v = planVerdict(session, { withinT: 93, tolerance: 0.2 })!
    expect(v.removed).toEqual([expect.objectContaining({ name: 'Too big', kind: 'fillet', message: expect.any(String) }), expect.objectContaining({ name: 'Put away' })])
    expect(v).toMatchObject({ met: false, unbuilt: ['Too big', 'Put away'] })
    expect(v.next).toBe('not done: Too big, Put away removed after failing and not built again — build them another way, never the part around them — say so in the chat; the person signs off on less')
    // Built under its name since, each is no longer owed.
    const tooBig = await run<{ feature: { status: string } }>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Too big', body: 'Block', edges: [0], radius: 1 } })
    expect(tooBig.feature.status).toBe('ok')
    const putAway = await run<{ feature: { status: string; message?: string } }>('reverse.feature.add', { feature: { kind: 'fillet', name: 'Put away', body: 'Block', edges: [4], radius: 1 } })
    expect(putAway.feature.status, putAway.feature.message).toBe('ok')
    const built = planVerdict(session, { withinT: 93, tolerance: 0.2 })!
    expect(built).toMatchObject({ met: true })
    expect(built.unbuilt).toBeUndefined()
    // Built again, there is nothing left to say of them.
    expect(built.removed).toBeUndefined()
    expect(built.next).toBeUndefined()
    // The later one first: removing the earlier replays the later on a
    // body whose edges have moved, and a round that then fails is recorded.
    await run('reverse.feature.remove', { feature: 'Put away' })
    await run('reverse.feature.remove', { feature: 'Too big' })
    expect(usePlan.getState().removed).toHaveLength(2)
  })

  it('goes with the project, and is let go with the scan', async () => {
    const saved = collect()
    expect(saved.plan.archetype).toBe('machined')
    expect(saved.removed).toHaveLength(2)
    open(undefined)
    expect(usePlan.getState().plan).toBeNull()
    expect(planVerdict(session, { withinT: 50 })).toBeUndefined()
    open(saved)
    expect(usePlan.getState().plan?.regions.map((r) => r.name)).toEqual(['Body', 'Tab', 'Gasket lip', 'Bore'])
    expect(usePlan.getState().removed[0].name).toBe('Too big')
    expect(() => planSection.prepare({ plan: { archetype: 'blob' } }, { manifest: {} as never, members: new Map() })).toThrow(/Malformed project: plan.archetype/)

    await run('scan.open', { bytes: stlBytes(boxMesh(30, 30)), name: 'another-part.stl', discard: true })
    expect(usePlan.getState().plan).toBeNull()
    expect(usePlan.getState().removed).toEqual([])
  })
})
