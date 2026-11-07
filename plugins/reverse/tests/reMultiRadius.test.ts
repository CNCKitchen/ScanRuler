// SPDX-License-Identifier: AGPL-3.0-only
// A round whose radius changes along a tangent chain: each edge given its
// own radii, all in one call to the kernel — r1 at the edge's first end, a
// jump where two given edges meet refused naming the place, and an edge of
// the chain left out running between the radii about it.

import { describe, expect, it } from 'vitest'
import { Builder } from '../core/build'
import type { Feature, SketchFeature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { addEntity, emptySketch } from '../core/sketch'
import { build, extrudeAll, rectangleSketch, XY } from './reKit'

const kernelPromise = ReKernel.load()

/** Two long sides joined by semicircular ends: the top edges are one
 *  tangent chain. */
function slotSketch(id: number, length: number, r: number): SketchFeature {
  const sketch = emptySketch()
  addEntity(sketch, { kind: 'line', a: [0, -r], b: [length, -r] })
  addEntity(sketch, { kind: 'arc', c: [length, 0], r, start: -Math.PI / 2, sweep: Math.PI })
  addEntity(sketch, { kind: 'line', a: [length, r], b: [0, r] })
  addEntity(sketch, { kind: 'arc', c: [0, 0], r, start: Math.PI / 2, sweep: Math.PI })
  return { id, kind: 'sketch', name: `Sketch ${id}`, plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch, visible: true }
}

const fillet = (body: number, variable: unknown[], edges: unknown[] = [], radius = 1): Feature => ({ id: 9, kind: 'fillet', name: 'Fillet 1', body, edges, variable, radius, chain: true, visible: true }) as Feature

describe('a round at radii of its own along a chain', () => {
  it('runs an edge from r1 at its first end to r2 at its other', async () => {
    const builder = new Builder(await kernelPromise)
    const a = rectangleSketch(1, 20, 10)
    const base = [a, extrudeAll(2, a, 0, 10)]
    const first = await build(builder, base)
    const e = first.bodies[0].topology.edges.find((x) => x.fingerprint.kind === 'line' && x.fingerprint.mid[2] > 9.9 && Math.abs(x.fingerprint.dir[0]) > 0.9 && x.fingerprint.mid[1] < 0.1)!
    expect(e.ends[0][0]).toBeCloseTo(0, 6)
    const out = await build(builder, [...base, fillet(2, [{ edge: e.fingerprint, radius: [1, 4] }])])
    expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok'])
    // The top face loses more at x 20, where the radius is 4: its centre
    // lies towards x 0.
    const top = out.bodies[0].topology.faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[2] > 0.9)!
    expect(top.fingerprint.centroid[0]).toBeLessThan(9.5)
    builder.dispose()
  })

  it('rounds the edges of one chain at radii of their own, the ones left out between', async () => {
    const builder = new Builder(await kernelPromise)
    const s = slotSketch(1, 30, 5)
    const base = [s, extrudeAll(2, s, 0, 10)]
    const first = await build(builder, base)
    const edges = first.bodies[0].topology.edges
    const tops = edges.filter((x) => x.fingerprint.kind === 'line' && x.fingerprint.mid[2] > 9.9)
    const near = tops.find((x) => x.fingerprint.mid[1] < 0)!.fingerprint
    const far = tops.find((x) => x.fingerprint.mid[1] > 0)!.fingerprint
    const arc = edges.find((x) => x.fingerprint.kind === 'circle' && x.fingerprint.mid[2] > 9.9 && x.fingerprint.mid[0] > 30)!.fingerprint
    const at = async (variable: unknown[]) => {
      const out = await build(builder, [...base, fillet(2, variable)])
      return { status: out.results[1].status, message: out.results[1].message, volume: out.bodies[0].volume }
    }
    const r1 = await at([{ edge: near, radius: [1, 1] }, { edge: far, radius: [1, 1] }])
    const r2 = await at([{ edge: near, radius: [2, 2] }, { edge: far, radius: [2, 2] }])
    // R1 on one side, R2 on the other, the ends running from the one to
    // the other: between the two whole rounds.
    const both = await at([{ edge: near, radius: [1, 1] }, { edge: far, radius: [2, 2] }])
    expect([r1.status, r2.status, both.status]).toEqual(['ok', 'ok', 'ok'])
    expect(both.volume).toBeLessThan(r1.volume - 1)
    expect(both.volume).toBeGreaterThan(r2.volume + 1)
    // A jump where two given edges meet: refused, saying where.
    const jump = await at([{ edge: near, radius: [1, 2] }, { edge: arc, radius: [1, 1] }])
    expect(jump.status).toBe('failed')
    expect(jump.message).toMatch(/variable\[0\] and variable\[1\] meet on one tangent chain at \(30, -5, 10\) at R2 and R1/)
    // Meeting at the one radius: built.
    expect((await at([{ edge: near, radius: [1, 2] }, { edge: arc, radius: [2, 3] }])).status).toBe('ok')
    builder.dispose()
  })
})
