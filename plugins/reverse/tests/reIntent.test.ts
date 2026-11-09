// SPDX-License-Identifier: AGPL-3.0-only
// The evidence on fitted pieces (core/intent): residuals and the fits' own
// uncertainties, the round figures beside the measured ones, and the
// relations the pieces nearly have — offered with how far off and in how
// many sigmas, never decided.
import { describe, expect, it } from 'vitest'
import { datumTraces } from '../core/datums'
import { candidatesOf, lineStats, readPieces, roundStats, sketchResidual, type Candidate } from '../core/intent'
import { acceptCandidates } from '../core/accept'
import { addConstraint, addEntity, emptySketch, type Sketch } from '../core/sketch'
import { solveSketch } from '../core/solver'
import { XY } from './reKit'

type Vec2 = [number, number]

/** Deterministic noise in ±half. */
function noise(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296 - 0.5
  }
}

/** `n` points along a → b scattered ±`spread` across it. */
function linePoints(a: Vec2, b: Vec2, n: number, spread: number, seed = 1): Vec2[] {
  const rand = noise(seed)
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const L = Math.hypot(dx, dy)
  const nx = -dy / L, ny = dx / L
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const e = rand() * 2 * spread
    out.push([a[0] + dx * t + nx * e, a[1] + dy * t + ny * e])
  }
  return out
}

/** `n` points round an arc about c of radius r from `start` through
 *  `sweep`, scattered ±`spread` along the radius. */
function arcPoints(c: Vec2, r: number, start: number, sweep: number, n: number, spread: number, seed = 2): Vec2[] {
  const rand = noise(seed)
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const t = start + (sweep * i) / (n - 1)
    const rr = r + rand() * 2 * spread
    out.push([c[0] + rr * Math.cos(t), c[1] + rr * Math.sin(t)])
  }
  return out
}

const line = (sk: Sketch, a: Vec2, b: Vec2, n = 40, spread = 0.02, seed = 1) => addEntity(sk, { kind: 'line', a, b, points: linePoints(a, b, n, spread, seed), scatter: spread })
const arc = (sk: Sketch, c: Vec2, r: number, start: number, sweep: number, n = 30, spread = 0.02, seed = 2) =>
  addEntity(sk, { kind: 'arc', c, r, start, sweep, points: arcPoints(c, r, start, sweep, n, spread, seed), scatter: spread })
const circle = (sk: Sketch, c: Vec2, r: number, n = 60, spread = 0.02, seed = 3) => addEntity(sk, { kind: 'circle', c, r, points: arcPoints(c, r, 0, 2 * Math.PI, n, spread, seed), scatter: spread })

const find = (cs: Candidate[], kind: Candidate['kind'], ...pieces: number[]) => cs.find((c) => c.kind === kind && pieces.every((p) => c.pieces.includes(p)))

describe('the fits’ own statistics', () => {
  it('knows a long side’s direction far better than a stub’s, and says how well each sits', () => {
    const sk = emptySketch()
    const long = line(sk, [0, 0], [40, 0], 40, 0.02)
    const stub = line(sk, [0, 5], [4, 5], 8, 0.02, 4)
    const sLong = lineStats(sk.entities[0] as never)!
    const sStub = lineStats(sk.entities[1] as never)!
    expect(sLong.rms).toBeLessThan(0.03)
    expect(sLong.max).toBeLessThan(0.05)
    expect(sLong.n).toBe(40)
    expect(sLong.sigmaAngle).not.toBeNull()
    expect(sStub.sigmaAngle!).toBeGreaterThan(5 * sLong.sigmaAngle!)
    // A piece without points, or with two, has a residual but no sigma.
    const bare = addEntity(sk, { kind: 'line', a: [0, 9], b: [9, 9] })
    expect(lineStats(sk.entities[2] as never)).toBeNull()
    const two = addEntity(sk, { kind: 'line', a: [0, 12], b: [9, 12], points: [[0, 12.01], [9, 11.99]] })
    expect(lineStats(sk.entities[3] as never)).toMatchObject({ n: 2, sigmaAngle: null })
    void long
    void stub
    void bare
    void two
  })

  it('knows a full circle’s radius well and a short arc’s poorly', () => {
    const sk = emptySketch()
    circle(sk, [0, 0], 5, 60, 0.02)
    arc(sk, [20, 0], 5, 0, (15 * Math.PI) / 180, 12, 0.02)
    const full = roundStats(sk.entities[0] as never)!
    const short = roundStats(sk.entities[1] as never)!
    expect(full.sigmaRadius).not.toBeNull()
    expect(full.sigmaRadius!).toBeLessThan(0.01)
    expect(short.sigmaRadius!).toBeGreaterThan(10 * full.sigmaRadius!)
    expect(short.sigmaCenter!).toBeGreaterThan(full.sigmaCenter!)
  })

  it('reads each piece: residual, sigma and the round figure beside the measured one', () => {
    const sk = emptySketch()
    line(sk, [0, 0], [39.98, 0])
    arc(sk, [50, 0], 4.98, 0, Math.PI / 2, 40, 0.01)
    line(sk, [0, 10], [10 * Math.cos((44.6 * Math.PI) / 180), 10 + 10 * Math.sin((44.6 * Math.PI) / 180)], 40, 0.01, 7)
    const [l, a, d] = readPieces(sk.entities)
    expect(l).toMatchObject({ id: 1, kind: 'line' })
    expect(l.residual!.points).toBe(40)
    expect(l.nominal.length).toMatchObject({ measured: 39.98, nominal: 40 })
    expect(l.nominal.length!.off).toBeCloseTo(-0.02, 6)
    expect(l.nominal.angleDeg).toMatchObject({ measured: 0, nominal: 0, off: 0 })
    expect(a.nominal.radius).toMatchObject({ measured: 4.98, nominal: 5 })
    expect(a.nominal.radius!.sigmas).toBeGreaterThan(0)
    expect(d.nominal.angleDeg).toMatchObject({ measured: 44.6, nominal: 45 })
    expect(d.nominal.angleDeg!.off).toBeCloseTo(-0.4, 6)
    // The sketch's residual as a whole names the worst piece.
    const whole = sketchResidual(sk.entities)!
    expect(whole.pieces).toBe(3)
    expect(whole.rms).toBeGreaterThan(0)
    expect([1, 2, 3]).toContain(whole.worst.piece)
  })
})

describe('the relations the pieces nearly have', () => {
  it('offers level, upright, equal and a round angle, with the evidence, and keeps what is held out', () => {
    const sk = emptySketch()
    const bottom = line(sk, [0, 0], [40, 0])
    const right = line(sk, [40, 0], [40, 20], 30, 0.02, 2)
    const top = line(sk, [40, 20], [0, 20.2], 40, 0.02, 3)
    const left = line(sk, [0, 20.2], [0, 0], 30, 0.02, 4)
    const cs = candidatesOf(sk.entities, [], { angleDeg: 5, mm: 1 })
    const topLevel = find(cs, 'horizontal', top)!
    expect(topLevel.off).toBeCloseTo(0.2865, 3)
    expect(topLevel.unit).toBe('deg')
    expect(topLevel.sigma).toBeGreaterThan(0)
    // A third of a degree on a 40 mm side with 0.02 mm of noise is many
    // sigmas: the top was measured leaning.
    expect(topLevel.sigmas!).toBeGreaterThan(3)
    expect(topLevel.constraints).toEqual([{ kind: 'horizontal', entity: top }])
    expect(find(cs, 'horizontal', bottom)!.sigmas).toBeLessThan(2)
    expect(find(cs, 'vertical', right)).toBeDefined()
    expect(find(cs, 'vertical', left)).toBeDefined()
    // Two lines held level are parallel without being told, so the pair is
    // not offered; nor is the right angle between a level and an upright.
    expect(find(cs, 'parallel', bottom, top)).toBeUndefined()
    expect(find(cs, 'perpendicular', bottom, right)).toBeUndefined()
    // Equal lengths, the sides as well as the ends.
    expect(find(cs, 'equal', bottom, top)).toMatchObject({ what: 'length' })
    expect(find(cs, 'equal', right, left)!.off).toBeCloseTo(0.2, 3)
    // Nearest the mark first.
    for (let i = 1; i < cs.length; i++) expect((cs[i].sigmas ?? Infinity) >= (cs[i - 1].sigmas ?? Infinity)).toBe(true)
    // What the sketch already holds is not offered again.
    const held = candidatesOf(sk.entities, [], { angleDeg: 5, mm: 1 }, [{ id: 90, kind: 'horizontal', entity: top }])
    expect(find(held, 'horizontal', top)).toBeUndefined()
    expect(find(held, 'horizontal', bottom)).toBeDefined()
  })

  it('offers a turned sketch its square relations as well as level and upright (issue 34)', () => {
    // A rectangle drawn 2° turned, within the 5° the axes are offered by:
    // if level and upright are turned down, parallel and perpendicular are
    // what holds it square.
    const sk = emptySketch()
    const t = (2 * Math.PI) / 180
    const turn = ([x, y]: [number, number]): [number, number] => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)]
    const [p0, p1, p2, p3] = ([[0, 0], [40, 0], [40, 20], [0, 20]] as [number, number][]).map(turn)
    const bottom = line(sk, p0, p1)
    const right = line(sk, p1, p2, 30, 0.02, 2)
    const top = line(sk, p2, p3, 40, 0.02, 3)
    const cs = candidatesOf(sk.entities, [], { angleDeg: 5, mm: 1 })
    expect(find(cs, 'horizontal', bottom)).toBeDefined()
    expect(find(cs, 'parallel', bottom, top)).toBeDefined()
    expect(find(cs, 'perpendicular', bottom, right)).toBeDefined()
  })

  it('offers parallel, perpendicular and in line between lines off the axes, and a 45° chamfer', () => {
    const sk = emptySketch()
    const t = (deg: number) => (deg * Math.PI) / 180
    const a = line(sk, [0, 0], [20 * Math.cos(t(30)), 20 * Math.sin(t(30))])
    const b = line(sk, [0, 5], [20 * Math.cos(t(30.3)), 5 + 20 * Math.sin(t(30.3))], 40, 0.02, 5)
    const c = line(sk, [10, 0], [10 + 10 * Math.cos(t(120.4)), 10 * Math.sin(t(120.4))], 40, 0.02, 6)
    const d = line(sk, [30, 30], [30 + 10 * Math.cos(t(30.1)), 30 + 10 * Math.sin(t(30.1))], 20, 0.02, 7)
    const cs = candidatesOf(sk.entities, [], { angleDeg: 5, mm: 1 })
    expect(find(cs, 'parallel', a, b)!.off).toBeCloseTo(0.3, 3)
    expect(find(cs, 'perpendicular', a, c)!.off).toBeCloseTo(0.4, 3)
    expect(find(cs, 'parallel', a, d)!.off).toBeCloseTo(0.1, 3)
    // A chamfer: two lines meeting near 45°, the directed angle offered
    // as the sketch's angle dimension reads it.
    const sk2 = emptySketch()
    const e = line(sk2, [0, 0], [10, 0])
    const f = line(sk2, [10, 0], [10 + 5 * Math.cos(t(45.4)), 5 * Math.sin(t(45.4))], 20, 0.01, 8)
    const chamfer = find(candidatesOf(sk2.entities, []), 'angle', e, f)!
    expect(chamfer.nominal).toBe(45)
    expect(chamfer.off).toBeCloseTo(0.4, 3)
    expect(chamfer.constraints).toEqual([{ kind: 'angle', a: e, b: f, value: 45 }])
    // Two lines in line, 0.05 apart.
    const sk3 = emptySketch()
    const g = line(sk3, [0, 0], [10, 0])
    const h = line(sk3, [15, 0.05], [25, 0.05], 40, 0.02, 9)
    const inline = find(candidatesOf(sk3.entities, []), 'collinear', g, h)!
    expect(inline.off).toBeCloseTo(0.05, 3)
    expect(inline.constraints).toEqual([{ kind: 'collinear', line: h, on: { line: g } }])
    expect(find(candidatesOf(sk3.entities, []), 'parallel', g, h)).toBeUndefined()
  })

  it('offers tangent, concentric and equal radii between round pieces and lines', () => {
    const sk = emptySketch()
    const l = line(sk, [0, 0], [12, 0])
    const fillet = arc(sk, [12, 2.03], 2, Math.PI, Math.PI / 2, 30, 0.005)
    const bore = circle(sk, [30, 10], 3)
    const boss = circle(sk, [30.02, 10], 6, 60, 0.02, 4)
    // An arc ending where the fillet starts, and one of its size far off.
    const next = arc(sk, [8, 2.03], 2.01, 0, Math.PI / 2, 30, 0.005, 5)
    const other = arc(sk, [50, 10], 2.01, 0, Math.PI / 2, 30, 0.005, 7)
    const far = arc(sk, [80, 40], 2, 0, Math.PI / 2, 30, 0.005, 6)
    const hole = circle(sk, [60, -20], 3.02, 60, 0.02, 8)
    const cs = candidatesOf(sk.entities, [])
    expect(find(cs, 'tangent', l, fillet)!.off).toBeCloseTo(0.03, 3)
    expect(find(cs, 'tangent', l, fillet)!.constraints).toEqual([{ kind: 'tangent', a: l, b: fillet }])
    expect(find(cs, 'concentric', bore, boss)!.off).toBeCloseTo(0.02, 3)
    expect(find(cs, 'equal', bore, boss)).toBeUndefined()
    expect(find(cs, 'equal', fillet, next)).toMatchObject({ what: 'radius' })
    expect(find(cs, 'equal', fillet, next)!.off).toBeCloseTo(0.01, 3)
    // Arcs of an outline apart from each other are not offered as equal;
    // two holes are, wherever they are.
    expect(find(cs, 'equal', fillet, other)).toBeUndefined()
    expect(find(cs, 'equal', bore, hole)).toMatchObject({ what: 'radius' })
    // A round piece far along the line's carrier is not tangent to it.
    expect(find(cs, 'tangent', l, far)).toBeUndefined()
  })

  it('reads the part’s coordinate planes: on one, and mirror images across one', () => {
    const sk = emptySketch()
    const traces = datumTraces(XY)
    expect(traces.map((t) => t.plane).sort()).toEqual(['yz', 'zx'])
    const hole = circle(sk, [0.03, 7], 2)
    const wallL = line(sk, [-10, 0], [-10, 8])
    const wallR = line(sk, [10.05, 0], [10.05, 8], 40, 0.02, 2)
    const floor = line(sk, [-10, 0.02], [10, 0.02], 40, 0.02, 3)
    const cs = candidatesOf(sk.entities, traces)
    const centred = find(cs, 'onDatum', hole)!
    expect(centred).toMatchObject({ datum: 'yz', unit: 'mm' })
    expect(centred.off).toBeCloseTo(0.03, 3)
    expect(centred.constraints).toEqual([{ kind: 'pointOn', p: { entity: hole, at: 'center' }, on: { datum: 'yz' } }])
    const onFloor = cs.find((c) => c.kind === 'onDatum' && c.pieces[0] === floor)!
    expect(onFloor).toMatchObject({ datum: 'zx' })
    expect(onFloor.off).toBeCloseTo(0.02, 3)
    expect(onFloor.constraints).toEqual([{ kind: 'collinear', line: floor, on: { datum: 'zx' } }])
    const mirror = find(cs, 'symmetric', wallL, wallR)!
    expect(mirror).toMatchObject({ datum: 'yz' })
    expect(mirror.off).toBeCloseTo(0.05, 3)
    expect(mirror.constraints).toHaveLength(2)
    expect(mirror.constraints[0]).toMatchObject({ kind: 'symmetric', about: { datum: 'yz' } })
    // The net decides what is offered at all.
    const tight = candidatesOf(sk.entities, traces, { angleDeg: 5, mm: 0.01 })
    expect(find(tight, 'symmetric', wallL, wallR)).toBeUndefined()
    expect(find(tight, 'onDatum', hole)).toBeUndefined()
    // And the cap.
    expect(candidatesOf(sk.entities, traces, undefined, [], 2)).toHaveLength(2)
  })
})

describe('accept, with the part’s planes in its trials', () => {
  it('leaves a relation to a plane that the sketch’s own relations contradict, and the sketch solves', () => {
    // A wall leaning 2° on a level floor, its angle and the lengths
    // dimensions: on the YZ
    // plane by its middle, but not upright. Tried without the planes, the
    // relation to the plane held nothing, was taken, and the sketch no
    // longer solved once the planes were given.
    const sk = emptySketch()
    const traces = datumTraces(XY)
    const floor = line(sk, [-10, -10], [10, -10], 40, 0.02, 5)
    const lean = Math.tan((2 * Math.PI) / 180) * 5
    const wall = line(sk, [-lean, -5], [lean, 5], 40, 0.02, 6)
    addConstraint(sk, { kind: 'horizontal', entity: floor })
    addConstraint(sk, { kind: 'angle', a: floor, b: wall, value: 88 })
    addConstraint(sk, { kind: 'length', entity: floor, value: 20 })
    addConstraint(sk, { kind: 'length', entity: wall, value: 10 })
    const { accepted, left } = acceptCandidates(sk, traces, { sigmas: 2 })
    expect(accepted.some((a) => a.kind === 'onDatum' && a.pieces[0] === wall)).toBe(false)
    expect(left.find((l) => l.kind === 'onDatum' && l.pieces[0] === wall)?.why).toBe('conflict')
    expect(solveSketch(sk, { datums: traces }).ok).toBe(true)
  })
})
