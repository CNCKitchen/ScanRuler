// SPDX-License-Identifier: AGPL-3.0-only
// A full round along a whole outline: a slab's top and bottom edge loops
// rounded at half its thickness, or one loop at the whole of it, closing
// up to one round round the outline — corners, large arcs and splines
// alike — with no band of the wall left and no sliver of it either. The
// body's volume is held to Steiner's: what is left of a slab of plan area
// A and outline length L rounded so is the outline inset by the radius,
// as a prism, with a half (or a quarter) disc swept round it.

import { describe, expect, it } from 'vitest'
import { Builder } from '../core/build'
import type { EdgeFingerprint } from '../core/topo'
import type { FilletFeature, SketchFeature } from '../core/features'
import { ReKernel } from '../core/kernel'
import { addEntity } from '../core/sketch'
import { build, extrudeAll, sketchOf } from './reKit'

const kernelPromise = ReKernel.load()

/** A rectangle `w` × `h` with corners of radius `R`, its left and right
 *  sides straight or — `bulge` set — arcs of that radius bowed out 2 mm,
 *  the corners tangent to whatever they join: a phone's plan. */
function outline(id: number, w: number, h: number, R: number, bulge: { left?: number; right?: number } = {}): SketchFeature {
  const P = Math.PI
  const side = (Rb: number | undefined) => {
    if (Rb === undefined) return { reach: -R, phi: 0 }
    const dy = h / 2 - R
    const across = Math.sqrt((Rb - R) ** 2 - dy * dy)
    // The corner's centre from the big arc's, which lies Rb − 2 inside the side.
    return { reach: 2 - Rb + across, phi: Math.atan2(dy, across), Rb }
  }
  const right = side(bulge.right)
  const left = side(bulge.left)
  const cxR = w + right.reach
  const cxL = -left.reach
  return sketchOf(id, (s) => {
    addEntity(s, { kind: 'line', a: [cxL, 0], b: [cxR, 0] })
    addEntity(s, { kind: 'arc', c: [cxR, R], r: R, start: -P / 2, sweep: P / 2 - right.phi })
    if (right.Rb) addEntity(s, { kind: 'arc', c: [w + 2 - right.Rb, h / 2], r: right.Rb, start: -right.phi, sweep: 2 * right.phi })
    else addEntity(s, { kind: 'line', a: [w, R], b: [w, h - R] })
    addEntity(s, { kind: 'arc', c: [cxR, h - R], r: R, start: right.phi, sweep: P / 2 - right.phi })
    addEntity(s, { kind: 'line', a: [cxR, h], b: [cxL, h] })
    addEntity(s, { kind: 'arc', c: [cxL, h - R], r: R, start: P / 2, sweep: P / 2 - left.phi })
    if (left.Rb) addEntity(s, { kind: 'arc', c: [left.Rb - 2, h / 2], r: left.Rb, start: P - left.phi, sweep: 2 * left.phi })
    else addEntity(s, { kind: 'line', a: [0, h - R], b: [0, R] })
    addEntity(s, { kind: 'arc', c: [cxL, R], r: R, start: P + left.phi, sweep: P / 2 - left.phi })
  })
}

/** A closed spline through points round an ellipse of half-axes 25 and 15
 *  — its tightest bend 9 mm, well over the round. */
function oval(id: number): SketchFeature {
  const pts: [number, number][] = Array.from({ length: 12 }, (_, i) => [25 * Math.cos((i * Math.PI) / 6), 15 * Math.sin((i * Math.PI) / 6)])
  return sketchOf(id, (s) => void addEntity(s, { kind: 'spline', pts, closed: true }))
}

const fillet = (edges: EdgeFingerprint[], radius: number, id = 3): FilletFeature => ({ id, kind: 'fillet', name: `Fillet ${id}`, body: 2, edges, radius, chain: false, visible: true })

/** The slab's outline loops, read off it unrounded: its edges round the
 *  top (z = t) and the bottom, the plan's area and the outline's length. */
async function slab(builder: Builder, s: SketchFeature, t: number) {
  const first = await build(builder, [s, extrudeAll(2, s, 0, t)])
  expect(first.results.map((r) => r.status)).toEqual(['ok'])
  const edges = first.bodies[0].topology.edges.map((e) => e.fingerprint)
  // A circle's direction is its axis, upright here; any other edge's runs
  // along it, level round a loop.
  const loop = (z: number) => edges.filter((e) => Math.abs(e.mid[2] - z) < 1e-6 && (e.kind === 'circle' || Math.abs(e.dir[2]) < 0.5))
  const top = loop(t)
  const bottom = loop(0)
  const length = bottom.reduce((sum, e) => sum + e.length, 0)
  return { top, bottom, area: first.bodies[0].volume / t, length }
}

/** Steiner: a slab of plan area A, outline length L and thickness t = 2r
 *  rounded in full is the outline inset by r as a prism t high — area
 *  A − rL + πr², length L − 2πr — and a half disc of r swept round that
 *  inset outline, its centroid 4r/3π out: the half disc's area times the
 *  inset length, and a ball of r for the turn the whole way round. */
function fullRoundVolume(area: number, length: number, r: number): number {
  return (area - r * length + Math.PI * r * r) * 2 * r + ((Math.PI * r * r) / 2) * (length - 2 * Math.PI * r) + (4 / 3) * Math.PI * r ** 3
}

/** The same for one loop rounded at the whole thickness t: a quarter disc
 *  swept round the outline inset by t, and half a ball for the turn. */
function wholeWallVolume(area: number, length: number, t: number): number {
  return (area - t * length + Math.PI * t * t) * t + ((Math.PI * t * t) / 4) * (length - 2 * Math.PI * t) + (2 / 3) * Math.PI * t ** 3
}

/** The rounded body held to all a full round is: built without a note,
 *  closed, the kernel's check passing, no edge open, no face narrower than
 *  a sliver, no wall face left, the volume Steiner's. */
async function expectFull(builder: Builder, result: Awaited<ReturnType<typeof build>>, volume: number, wall: (kind: string, dir: readonly number[]) => boolean, within = 1e-6) {
  expect(result.results.every((r) => r.status === 'ok')).toBe(true)
  expect(result.results.map((r) => r.note).filter(Boolean)).toEqual([])
  const body = result.bodies[0]
  expect(body.closed).toBe(true)
  expect(Math.abs(body.volume - volume) / volume).toBeLessThan(within)
  const check = builder.check(body.id, 0.01)!
  expect(check.valid).toBe(true)
  expect(check.narrow).toEqual([])
  expect(check.odd.counts).toMatchObject({ free: 0, inside: 0, nonManifold: 0 })
  // Nothing of the wall the outline was extruded into is left standing.
  expect(body.topology.faces.filter((f) => wall(f.fingerprint.kind, f.fingerprint.dir)).length).toBe(0)
  return body
}

/** A face of the slab's upright wall: a flat side, or a corner's
 *  cylinder standing on the plan. */
const upright = (kind: string, dir: readonly number[]) => (kind === 'plane' && Math.abs(dir[2]) < 1e-6) || (kind === 'cylinder' && Math.abs(Math.abs(dir[2]) - 1) < 1e-6)

describe('a full round along a whole outline', () => {
  it('rounds both loops of a rounded rectangle at half its thickness into one round, its corners tori', async () => {
    const builder = new Builder(await kernelPromise)
    const s = outline(1, 40, 60, 8)
    const { top, bottom, area, length } = await slab(builder, s, 5)
    expect(top).toHaveLength(8)
    expect(bottom).toHaveLength(8)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 5), fillet([...top, ...bottom], 2.5)])
    const body = await expectFull(builder, rounded, fullRoundVolume(area, length, 2.5), upright)
    // The top and the bottom inset by the radius, and one round face for
    // each piece of the outline: a cylinder along a side, a torus at a
    // corner — the two halves of the round made one face.
    expect(body.faces).toBe(10)
    expect(body.topology.faces.filter((f) => f.fingerprint.kind === 'torus')).toHaveLength(4)
    expect(body.topology.faces.filter((f) => f.fingerprint.kind === 'cylinder')).toHaveLength(4)
    builder.dispose()
  })

  it('rounds the loops one fillet after the other just the same', async () => {
    const builder = new Builder(await kernelPromise)
    const s = outline(1, 40, 60, 8)
    const { top, bottom, area, length } = await slab(builder, s, 5)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 5), fillet(top, 2.5), fillet(bottom, 2.5, 4)])
    const body = await expectFull(builder, rounded, fullRoundVolume(area, length, 2.5), upright)
    expect(body.faces).toBe(10)
    builder.dispose()
  })

  it('rounds an outline with a side a large arc — and a phone’s, 5.48 thick at 2.74', async () => {
    const builder = new Builder(await kernelPromise)
    const s = outline(1, 40, 60, 8, { right: 120 })
    const { top, bottom, area, length } = await slab(builder, s, 5)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 5), fillet([...top, ...bottom], 2.5)])
    const body = await expectFull(builder, rounded, fullRoundVolume(area, length, 2.5), upright)
    // The large arc's round a torus too: five of them, three cylinders.
    expect(body.topology.faces.filter((f) => f.fingerprint.kind === 'torus')).toHaveLength(5)
    expect(body.faces).toBe(10)

    const phone = outline(1, 70, 150, 12, { left: 120, right: 120 })
    const p = await slab(builder, phone, 5.48)
    const round = await build(builder, [phone, extrudeAll(2, phone, 0, 5.48), fillet([...p.top, ...p.bottom], 2.74)])
    await expectFull(builder, round, fullRoundVolume(p.area, p.length, 2.74), upright)
    builder.dispose()
  })

  it('rounds a spline outline in full', async () => {
    const builder = new Builder(await kernelPromise)
    const s = oval(1)
    const { top, bottom, area, length } = await slab(builder, s, 5)
    expect(top).toHaveLength(1)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 5), fillet([...top, ...bottom], 2.5)])
    // Held to a few tenths of a percent, not a millionth: the kernel's
    // measures of a freeform face are that far off on their own — this
    // slab rounded at 2.4, where nothing is closed, has its band of wall
    // 0.3 % longer by its area than by its edge.
    const body = await expectFull(builder, rounded, fullRoundVolume(area, length, 2.5), upright, 5e-3)
    // The top, the bottom and the round, its two halves on surfaces of the
    // kernel's own making, met tangent along the middle.
    expect(body.faces).toBe(4)
    builder.dispose()
  })

  it('rounds one loop at the whole thickness: the wall gone, the round running down into the bottom', async () => {
    const builder = new Builder(await kernelPromise)
    const s = outline(1, 40, 60, 8)
    const { top, area, length } = await slab(builder, s, 5)
    const rounded = await build(builder, [s, extrudeAll(2, s, 0, 5), fillet(top, 5)])
    const body = await expectFull(builder, rounded, wholeWallVolume(area, length, 5), upright)
    // The bottom whole, the top inset by the radius, and the round.
    expect(body.faces).toBe(10)
    builder.dispose()
  })
})
