// SPDX-License-Identifier: AGPL-3.0-only
// Three things an agent's 0.3 mm sheet-metal cage asked for: regions
// "largest" said when it took a ring's hole (the hole is larger by area
// than a thin ring round it, and the rule stands); a Combine with several
// tools — joined all, cut or intersected by each in turn — while a part
// with one keeps it as it was; and a shape's sizes driven by parameters
// (exprs), world-placed shapes among them. The kernel in this thread, as
// reCommands.test.ts runs it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { refused, run, startHeadless, type Headless } from '../../../tests/commandKit'
import { applyReversePart, PART_VERSION, type ReversePart } from '../app/projectSection'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import type { BooleanFeature, SketchFeature } from '../core/features'
import { ReClient } from '../core/reClient'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

interface Body { id: number; name: string; volume: number }
interface Brief { feature: { id: number; name: string }; result: { status: string; message?: string } | null; bodies: { changed?: Body[] }; largestInside?: string }

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

const volumeOf = async (body: number) => (await run<{ bodies: Body[] }>('reverse.body.describe', { body, edges: false })).bodies[0].volume

/** A block `size` [w, h] about `at`, from z to z + height, a body of its own. */
async function block(name: string, size: [number, number], at: [number, number], z: number, height: number) {
  await run('reverse.feature.add', { feature: { kind: 'sketch', name: `${name} sketch`, plane: { kind: 'world', axis: 'z', offset: z }, sketch: { shapes: [{ kind: 'rectangle', center: at, size, fixed: true }] } } })
  const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name, sketchId: `${name} sketch`, regions: 'all', extent: { kind: 'distance', from: 0, to: height }, op: 'new' } })
  expect(made.result?.status, made.result?.message).toBe('ok')
  return made.bodies.changed![0]
}

describe('regions "largest" on a ring', () => {
  it('warns once when it takes the hole of a thin ring, and names the ring', async () => {
    // A sleeve's wall, 0.3 mm: the inside is larger by area than the ring.
    await run('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Sleeve', plane: 'XY', sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [20, 10], fixed: true }, { kind: 'rectangle', center: [0, 0], size: [19.4, 9.4], fixed: true }] } },
    })
    const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Wall', sketchId: 'Sleeve', regions: 'largest', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
    expect(made.result?.status, made.result?.message).toBe('ok')
    // The rule stands — the hole was taken, a solid block — and is said.
    expect(made.bodies.changed![0].volume).toBeCloseTo(19.4 * 9.4 * 5, 2)
    expect(made.largestInside).toMatch(/the inside of region .* a ring's hole/)
    expect(made.largestInside).toMatch(/regions: \[\{ at: \[/)
    // Taken by the point it names, the ring is the wall.
    const at = JSON.parse(/\{ at: (\[[^\]]+\]) \}/.exec(made.largestInside!)![1]) as [number, number]
    const ring = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', name: 'Ring', sketchId: 'Sleeve', regions: [{ at }], extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
    expect(ring.bodies.changed![0].volume).toBeCloseTo((200 - 19.4 * 9.4) * 5, 2)
    expect(ring.largestInside).toBeUndefined()
    // An edit that does not pick the regions again says nothing more.
    const edited = await run<Brief>('reverse.feature.update', { feature: 'Wall', set: { extent: { kind: 'distance', from: 0, to: 6 } } })
    expect(edited.largestInside).toBeUndefined()
    // Picked again as "largest" by an edit, it is said again.
    const again = await run<Brief>('reverse.feature.update', { feature: 'Wall', set: { regions: 'largest' }, detail: 'none' })
    expect(again.largestInside).toMatch(/a ring's hole/)
  })

  it('says nothing for a region in no other', async () => {
    await run('reverse.feature.add', { feature: { kind: 'sketch', name: 'Plate', plane: 'XY', sketch: { shapes: [{ kind: 'rectangle', center: [0, 0], size: [20, 10], fixed: true }] } } })
    const made = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Plate', regions: 'largest', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
    expect(made.result?.status).toBe('ok')
    expect(made.largestInside).toBeUndefined()
  })
})

describe('a Combine with several tools', () => {
  it('joins a body with two tools at once', async () => {
    const base = await block('Base', [20, 20], [0, 0], 0, 10)
    const a = await block('Peg A', [4, 4], [-5, -5], 8, 6)
    const b = await block('Peg B', [4, 4], [5, 5], 8, 6)
    const joined = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', name: 'Join pegs', op: 'join', body: base.id, tool: [a.id, 'Peg B'] } })
    expect(joined.result?.status, joined.result?.message).toBe('ok')
    // Each peg stands 4 mm proud: 4 × 4 × 4 apiece.
    expect(await volumeOf(base.id)).toBeCloseTo(4000 + 2 * 64, 2)
    const stored = useReverse.getState().features.find((f) => f.name === 'Join pegs') as BooleanFeature
    expect(stored.tool).toEqual([a.id, b.id])
    // Both went into it.
    expect(useReverse.getState().bodies.map((x) => x.id)).toEqual([base.id])
  })

  it('cuts with two tools, kept, and intersects with each in turn', async () => {
    const base = await block('Base', [20, 20], [0, 0], 0, 10)
    const a = await block('Hole A', [4, 4], [-5, -5], 6, 8)
    const b = await block('Hole B', [4, 4], [5, 5], 6, 8)
    const cut = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', name: 'Pockets', op: 'cut', body: base.id, tool: [a.id, b.id], keep: true } })
    expect(cut.result?.status, cut.result?.message).toBe('ok')
    expect(await volumeOf(base.id)).toBeCloseTo(4000 - 2 * 64, 2)
    // Kept: both tools stand beside it.
    expect(useReverse.getState().bodies.map((x) => x.id).sort()).toEqual([base.id, a.id, b.id].sort())
    // Two overlapping columns through it: what lies inside both, not
    // inside either — a 5 × 5 square through the 10 mm, from 3600.
    const p = await block('Column P', [10, 10], [-2.5, -2.5], -5, 20)
    const q = await block('Column Q', [10, 10], [2.5, 2.5], -5, 20)
    const inBoth = await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', name: 'Core', op: 'intersect', body: base.id, tool: [p.id, q.id] } })
    expect(inBoth.result?.status, inBoth.result?.message).toBe('ok')
    expect(await volumeOf(base.id)).toBeCloseTo(5 * 5 * 10, 2)
  })

  it('keeps one tool a number, and a part saved with one loads and builds as before', async () => {
    const base = await block('Base', [20, 20], [0, 0], 0, 10)
    const a = await block('Peg', [4, 4], [-5, -5], 8, 6)
    await run<Brief>('reverse.feature.add', { feature: { kind: 'boolean', name: 'Join peg', op: 'join', body: base.id, tool: a.id } })
    const was = await volumeOf(base.id)
    const s = useReverse.getState()
    const features = JSON.parse(JSON.stringify(s.features))
    expect((features.find((f: { name: string }) => f.name === 'Join peg') as BooleanFeature).tool).toBe(a.id)
    resetReverse()
    // As an older part was written: the fields since then left out.
    applyReversePart({ version: PART_VERSION, features, nextFeatureId: s.nextFeatureId, nextOfKind: s.nextOfKind } as unknown as ReversePart)
    await run('reverse.build')
    expect(useReverse.getState().results[(features.at(-1) as BooleanFeature).id]?.status).toBe('ok')
    expect(await volumeOf(base.id)).toBeCloseTo(was, 6)
    // Reopened, the box holds it as one tool and commits it as one.
    const updated = await run<Brief>('reverse.feature.update', { feature: 'Join peg', set: { keep: true } })
    expect(updated.result?.status).toBe('ok')
    expect((useReverse.getState().features.find((f) => f.name === 'Join peg') as BooleanFeature).tool).toBe(a.id)
  })
})

describe("a shape's sizes by expressions", () => {
  const circleR = () => {
    const sk = useReverse.getState().features.find((f) => f.kind === 'sketch') as SketchFeature
    const c = sk.sketch.entities.find((e) => e.kind === 'circle')!
    return (c as { r: number }).r
  }

  it('draws a circle at its radius expression, and follows the parameter', async () => {
    await run('reverse.parameter.add', { name: 'r', expression: '3' })
    const made = await run<Brief & { solve?: { ok: boolean } }>('reverse.feature.add', { feature: { kind: 'sketch', name: 'Boss', plane: 'XY', sketch: { shapes: [{ kind: 'circle', center: [4, 2], exprs: { radius: 'r' } }] } } })
    expect(made.solve?.ok).toBe(true)
    expect(circleR()).toBeCloseTo(3, 9)
    const dim = (useReverse.getState().features[0] as SketchFeature).sketch.constraints.find((c) => c.kind === 'radius')
    expect(dim).toMatchObject({ expr: 'r', value: 3 })
    await run('reverse.parameter.set', { parameter: 'r', expression: '5' })
    expect(circleR()).toBeCloseTo(5, 6)
  })

  it('holds a slot placed by world points to its width expression', async () => {
    await run('reverse.parameter.add', { name: 'w', expression: '4' })
    const made = await run<Brief & { shapes?: { ends?: number[] }[] }>('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Slot', plane: { kind: 'world', axis: 'z', offset: 5 }, sketch: { shapes: [{ kind: 'slot', world: true, from: [0, 0, 5], to: [10, 0, 5], exprs: { width: 'w' } }] } },
    })
    const ends = made.shapes![0].ends!
    const radii = () => {
      const sk = useReverse.getState().features[0] as SketchFeature
      return ends.map((id) => (sk.sketch.entities.find((e) => e.id === id) as { r: number }).r)
    }
    expect(radii()[0]).toBeCloseTo(2, 9)
    await run('reverse.parameter.set', { parameter: 'w', expression: '6' })
    expect(radii()[0]).toBeCloseTo(3, 6)
    expect(radii()[1]).toBeCloseTo(3, 6)
    // And extruded, it is the slot at that width: 10 × 6 and two halves of a 3 mm round.
    const ex = await run<Brief>('reverse.feature.add', { feature: { kind: 'extrude', sketchId: 'Slot', extent: { kind: 'distance', from: 0, to: 2 }, op: 'new' } })
    expect(ex.bodies.changed![0].volume).toBeCloseTo((10 * 6 + Math.PI * 9) * 2, 1)
  })

  it('refuses expressions with fixed, on points, and a name in the number', async () => {
    await run('reverse.parameter.add', { name: 'r', expression: '3' })
    const sketch = (shape: Record<string, unknown>) => ({ feature: { kind: 'sketch', plane: 'XY', sketch: { shapes: [shape] } } })
    expect((await refused('reverse.feature.add', sketch({ kind: 'circle', center: [0, 0], fixed: true, exprs: { radius: 'r' } }))).message).toMatch(/fixed locks every piece/)
    expect((await refused('reverse.feature.add', sketch({ kind: 'circle', center: [0, 0, 0], world: true, exprs: { center: 'r' } }))).message).toMatch(/a point takes no expression/)
    expect((await refused('reverse.feature.add', sketch({ kind: 'polygon', center: [0, 0], sides: 6, radius: 'r' }))).message).toMatch(/exprs: \{ radius: "r" \}/)
  })
})
