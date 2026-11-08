// SPDX-License-Identifier: AGPL-3.0-only
// A join on one body (target) that meets nothing of it is refused, as a cut
// that takes nothing is; one some of whose pieces stand apart says so on its
// row. And a sketch edit's answer names each radius it changed.

import { describe, expect, it, vi } from 'vitest'
// The plugin first, so the app's modules load in their own order.
import '../plugin'
import { Builder } from '../core/build'
import type { ExtrudeFeature, Feature, SketchFeature } from '../core/features'
import { resolveFeatures } from '../core/resolve'
import { ReKernel } from '../core/kernel'
import { findRegions } from '../core/regions'
import { addEntity, addRectangle, emptySketch, type Sketch } from '../core/sketch'
import { movedPieces } from '../app/reSketchInput'
import { XY } from './reKit'

vi.setConfig({ testTimeout: 180_000 })

const kernelPromise = ReKernel.load()

function rectangles(id: number, ...spans: [number, number][]): SketchFeature {
  const sketch = emptySketch()
  for (const [x0, x1] of spans) addRectangle(sketch, [x0, 0], [x1, 10])
  return { id, kind: 'sketch', name: `Sketch ${id}`, plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch, visible: true }
}

const extrude = (id: number, name: string, s: SketchFeature, op: ExtrudeFeature['op'], target?: number): ExtrudeFeature => ({
  id,
  kind: 'extrude',
  name,
  sketchId: s.id,
  regions: findRegions(s.sketch).map((r) => r.key),
  extent: { kind: 'distance', from: 0, to: 10 },
  op,
  target,
  visible: true,
})

async function build(features: Feature[]) {
  const builder = new Builder(await kernelPromise)
  const steps = resolveFeatures(features, { sections: [], elements: [], modelCenter: [0, 0, 0] }, (f) => findRegions(f.sketch))
  const sketches = new Map<number, Sketch>(features.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
  const result = builder.build(steps, (id) => sketches.get(id))
  builder.dispose()
  return result
}

describe('a join on one body', () => {
  it('is refused where it meets nothing of the body', async () => {
    const block = rectangles(1, [0, 10])
    const apart = rectangles(3, [20, 30])
    const result = await build([block, extrude(2, 'Block', block, 'new'), apart, extrude(4, 'Lug', apart, 'join', 2)])
    const lug = result.results.find((r) => r.id === 4)!
    expect(lug.status).toBe('failed')
    expect(lug.message).toMatch(/Lug meets nothing of Block/)
    expect(result.bodies.length).toBe(1)
  })

  it('joins what meets the body and says which pieces stand apart', async () => {
    const block = rectangles(1, [0, 10])
    const both = rectangles(3, [5, 15], [20, 30])
    const result = await build([block, extrude(2, 'Block', block, 'new'), both, extrude(4, 'Lugs', both, 'join', 2)])
    const lugs = result.results.find((r) => r.id === 4)!
    expect(lugs.status).toBe('ok')
    expect(lugs.warning).toMatch(/The join left Block as two bodies/)
    expect(result.bodies.map((b) => Math.round(b.volume)).sort((a, b) => a - b)).toEqual([1000, 1500])
  })

  it('still joins a solid that only touches the body face to face', async () => {
    const block = rectangles(1, [0, 10])
    const next = rectangles(3, [10, 20])
    const result = await build([block, extrude(2, 'Block', block, 'new'), next, extrude(4, 'Next', next, 'join', 2)])
    expect(result.results.find((r) => r.id === 4)!.status).toBe('ok')
    expect(result.bodies.length).toBe(1)
    expect(result.bodies[0].volume).toBeCloseTo(2000, 3)
  })
})

describe("a sketch edit's moved", () => {
  it('names each arc or circle whose radius changed, and not one that kept it', () => {
    const was = emptySketch()
    addEntity(was, { kind: 'arc', c: [0, 0], r: 1, start: 0, sweep: Math.PI / 2 })
    addEntity(was, { kind: 'circle', c: [10, 0], r: 3 })
    const now: Sketch = structuredClone(was)
    const arc = now.entities[0] as Extract<Sketch['entities'][number], { kind: 'arc' }>
    arc.r = 0.989
    ;(now.entities[1] as Extract<Sketch['entities'][number], { kind: 'circle' }>).c = [10.2, 0]
    const moved = movedPieces(was, now)
    expect(moved.count).toBe(2)
    expect(moved.radii).toEqual([{ id: arc.id, was: 1, now: 0.989 }])
  })
})
