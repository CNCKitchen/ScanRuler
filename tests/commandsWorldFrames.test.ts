// SPDX-License-Identifier: AGPL-3.0-only
// Places given in world coordinates where a command reads [u, v]: a
// section picture's frame, on a section across a coordinate plane (its
// sheet counting from the part's centre) and through an element's axis
// (from the element's centre), and a repeat count's height along that
// axis; and a height map's box round a plane element's centre on a tilted
// plane, whose sheet counts from the world origin's foot. Each lands on
// the first call, and a box given in the
// wrong frame says where the scan lies. In the in-process worker
// (commandKit.ts) — the picture itself needs the browser, so its frame is
// read as the command lays it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { frameOnSheet } from '../src/commands/core/section'
import { pointOnSheet, type SectionFrame } from '../src/core/section/frame'
import { projectCut } from '../src/core/section/slice'
import { useStore } from '../src/state/store'
import { cylinderMesh } from './helpers'
import { run, startHeadless, stlBytes, type Headless } from './commandKit'

vi.setConfig({ testTimeout: 120_000 })

type Vec3 = [number, number, number]

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

/** Rotation by `deg` about the unit axis (Rodrigues), then a shift. */
function placer(axis: Vec3, deg: number, shift: Vec3) {
  const [x, y, z] = axis
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const k = 1 - c
  const m = [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ]
  const turn = (p: Vec3): Vec3 => [0, 1, 2].map((r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2]) as Vec3
  return { turn, place: (p: Vec3): Vec3 => turn(p).map((v, i) => v + shift[i]) as Vec3 }
}

/** A closed R10 cylinder 30 long about +Z, its soup placed by `place`. */
function placedCylinder(place: (p: Vec3) => Vec3): Float32Array {
  const soup = cylinderMesh(10, 30, 96, 24).positions
  for (let i = 0; i < soup.length; i += 3) soup.set(place([soup[i], soup[i + 1], soup[i + 2]]), i)
  return soup
}

/** The point of a section's cut on its sheet nearest [u, v], and how far. */
function nearestOnCut(id: number, at: [number, number]): number {
  const sec = useStore.getState().sections.find((s) => s.id === id)!
  const flat = projectCut(sec.cut!, sec.frame).points
  let best = Infinity
  for (let i = 0; i + 1 < flat.length; i += 2) best = Math.min(best, Math.hypot(flat[i] - at[0], flat[i + 1] - at[1]))
  return best
}

const frameOf = (id: number): SectionFrame => useStore.getState().sections.find((s) => s.id === id)!.frame

interface Sec { section: { id: number; plane: { origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3 } } }

describe('a section picture framed by a place in the world', () => {
  // Far from the origin, as a part seldom sits on it.
  const SHIFT: Vec3 = [30, -60, -50]
  const straight = placer([0, 0, 1], 0, SHIFT)

  it('lands on a section across a coordinate plane, whose sheet counts from the part’s centre', async () => {
    await run('scan.open', { bytes: stlBytes(placedCylinder(straight.place)), name: 'boss.stl', discard: true })
    const cut = await run<Sec>('section.cut', { across: 'XY', offset: -45 })
    // The answer carries the sheet: u and v as well as the plane.
    const { plane } = cut.section
    expect(plane.basisU).toEqual([1, 0, 0])
    expect(plane.basisV.map((v) => v + 0)).toEqual([0, 1, 0])
    expect(plane.origin[0]).toBeCloseTo(30, 1)
    // A point on the wall, in the world: the sheet's [u, v] are not X and
    // Y but counted from the part's centre's foot.
    const wall: Vec3 = [40, -60, -45]
    const { frame, framed } = frameOnSheet({ at: wall, size: 6 }, frameOf(cut.section.id))
    expect(frame.at[0]).toBeCloseTo(10, 1)
    expect(frame.at[1]).toBeCloseTo(0, 1)
    expect(frame.size).toBe(6)
    expect(framed).toMatchObject({ offPlane: 0 })
    expect(nearestOnCut(cut.section.id, frame.at)).toBeLessThan(0.05)
    // [u, v] as given is taken as it is.
    expect(frameOnSheet({ at: [1, 2], size: 3 }, frameOf(cut.section.id))).toEqual({ frame: { at: [1, 2], size: 3 } })
    // A box in the world: the square round it, a tenth wider.
    const boxed = frameOnSheet({ world: { min: [35, -65, -50], max: [45, -55, -40] } }, frameOf(cut.section.id))
    expect(boxed.frame.at[0]).toBeCloseTo(10, 6)
    expect(boxed.frame.at[1]).toBeCloseTo(0, 6)
    expect(boxed.frame.size).toBeCloseTo(11, 6)
    // The same box written as view.render's frame takes one.
    expect(frameOnSheet({ min: [35, -65, -50], max: [45, -55, -40] }, frameOf(cut.section.id))).toEqual(boxed)
    expect(() => frameOnSheet({ min: [35, -65, -50] }, frameOf(cut.section.id))).toThrow(/min and max both/)
    expect(() => frameOnSheet({ at: wall }, frameOf(cut.section.id))).toThrow(/give at/)
    expect(() => frameOnSheet({ at: wall, size: 3, world: { min: [0, 0, 0], max: [1, 1, 1] } }, frameOf(cut.section.id))).toThrow(/not both/)
  })

  it('lands on a section through an element’s axis, whose sheet counts from the element’s centre', async () => {
    await run('scan.open', { bytes: stlBytes(placedCylinder(straight.place)), name: 'boss.stl', discard: true })
    const fit = await run<{ element: { id: number; fit: { center: Vec3 } } }>('element.fit', { kind: 'cylinder', at: { point: [40, -60, -50] } })
    const cut = await run<Sec>('section.cut', { across: { axis: fit.element.id, angleDeg: 0 } })
    // A point on the wall 5 above the middle: [radius, 5] — not [radius,
    // its world z].
    const wall: Vec3 = [40, -60, -45]
    const { frame } = frameOnSheet({ at: wall, size: 6 }, frameOf(cut.section.id))
    expect(frame.at[0]).toBeCloseTo(10, 1)
    expect(frame.at[1]).toBeCloseTo(-45 - fit.element.fit.center[2], 1)
    expect(Math.abs(frame.at[1] - -45)).toBeGreaterThan(30)
    expect(nearestOnCut(cut.section.id, frame.at)).toBeLessThan(0.05)
    // A repeat count's heights take the same point: its foot on the axis.
    type Pattern = { axis: { origin: Vec3; dir: Vec3 }; heights: { at: number }[] }
    const p = await run<Pattern>('scan.pattern', { axis: fit.element.id, at: [wall, -40] })
    const { origin, dir } = p.axis
    const h = (wall[0] - origin[0]) * dir[0] + (wall[1] - origin[1]) * dir[1] + (wall[2] - origin[2]) * dir[2]
    expect(p.heights.map((x) => x.at)).toEqual([expect.closeTo(h, 3), -40])
    expect(Math.abs(h - -45)).toBeLessThan(0.05)
  })
})

describe('a height map on a tilted plane element, its box given in the world', () => {
  // The socket's end face: a cylinder leant 35° off Z and turned, far out.
  const tilted = placer([0.6, 0.8, 0], 35, [33, -67, 2])

  interface Map {
    plane: { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3; center?: [number, number] }
    cols: number
    rows: number
    hit: number
    max: number | null
    scanLies?: { hitPct: number; min: Vec3; max: Vec3; note: string }
  }

  it('maps the face round the element’s centre on the first call, and says where the scan lies when the box is in the wrong frame', async () => {
    await run('scan.open', { bytes: stlBytes(placedCylinder(tilted.place)), name: 'socket.stl', discard: true })
    const end = tilted.place([0, 0, 15])
    const fit = await run<{ element: { id: number; fit: { center: Vec3 } } }>('element.fit', { kind: 'plane', at: { point: tilted.place([3, 2, 15]) } })
    const c = fit.element.fit.center
    expect(Math.hypot(c[0] - end[0], c[1] - end[1], c[2] - end[2])).toBeLessThan(1)
    // The box round the centre, in the world.
    const r = 11
    const world = { min: [c[0] - r, c[1] - r, c[2] - r] as Vec3, max: [c[0] + r, c[1] + r, c[2] + r] as Vec3 }
    const m = await run<Map>('scan.heightmap', { plane: fit.element.id, box: { world }, cell: 0.5 })
    expect(m.hit / (m.cols * m.rows)).toBeGreaterThan(0.2)
    expect(m.scanLies).toBeUndefined()
    // The face met square on, at the plane.
    expect(Math.abs(m.max!)).toBeLessThan(0.05)
    // The element's centre in the map's [u, v]: not the frame's zero.
    const sheet = { origin: m.plane.origin, normal: m.plane.normal, basisU: m.plane.u, basisV: m.plane.v }
    const centre = pointOnSheet(sheet, c).at
    expect(m.plane.center![0]).toBeCloseTo(centre[0], 3)
    expect(m.plane.center![1]).toBeCloseTo(centre[1], 3)
    expect(Math.hypot(...m.plane.center!)).toBeGreaterThan(10)
    // The run's mistake: the centre's world coordinates taken as [u, v].
    const wrong = await run<Map>('scan.heightmap', { plane: fit.element.id, box: { min: [c[0] - r, c[1] - r, -r], max: [c[0] + r, c[1] + r, r] }, cell: 0.5 })
    expect(wrong.hit).toBe(0)
    const lies = wrong.scanLies!
    expect(lies.hitPct).toBe(0)
    for (let k = 0; k < 2; k++) {
      expect(lies.min[k]).toBeLessThan(m.plane.center![k])
      expect(lies.max[k]).toBeGreaterThan(m.plane.center![k])
    }
    expect(lies.note).toMatch(/box: \{ world: \{ min, max \} \}/)
    // The outline takes the same world box.
    const o = await run<{ plane: { center?: [number, number] }; loops: { circle?: { radius: number } }[] }>('scan.outline', { plane: fit.element.id, box: { world } })
    expect(o.plane.center).toEqual(m.plane.center)
    expect(o.loops[0].circle?.radius).toBeCloseTo(10, 0)
  })
})
