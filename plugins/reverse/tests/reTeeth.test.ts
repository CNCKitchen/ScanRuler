// SPDX-License-Identifier: AGPL-3.0-only
// A chain of regular teeth read for its design (core/teeth.ts): the
// lamp's Fresnel as its section through the axis gave it — crests on an
// R92.21 envelope, troughs on an R92.70 one, from r0 15.92 at a 2.47
// radial pitch with a 0.85 riser, 21 teeth — clean, with scan noise and
// with its tips rounded as a scan rounds them; and the same teeth cut out
// of a prism by a section and read by reverse.section.fit { periodic }.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mulberry32 } from '../../../src/core/fit/ransac'
import { refused, run, soupOf, startHeadless, stlBytes, type Headless } from '../../../tests/commandKit'
import { gaussian } from '../../../tests/helpers'
import { densify, prism } from '../../../tests/shellMesh'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { ReClient } from '../core/reClient'
import { readTeeth } from '../core/teeth'
import { localKernel } from './reLocal'
import plugin from '../plugin'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 60_000 })

type Vec2 = [number, number]
type Vec3 = [number, number, number]

/** The lamp's Fresnel: u the radius, v along the axis. */
const FR = { crestR: 92.21, troughR: 92.7, r0: 15.92, pitch: 2.47, riser: 0.85, teeth: 21 } as const
// The envelopes' centres on the axis, as the run's profile has them: a
// crest at u 10.98, v −45.3139 and a trough at u 11.83, v −45.8421.
const CREST_V0 = -45.3139 + Math.sqrt(FR.crestR ** 2 - 10.98 ** 2)
const TROUGH_V0 = -45.8421 + Math.sqrt(FR.troughR ** 2 - 11.83 ** 2)
const crestAt = (u: number): Vec2 => [u, CREST_V0 - Math.sqrt(FR.crestR ** 2 - u * u)]
const troughAt = (u: number): Vec2 => [u, TROUGH_V0 - Math.sqrt(FR.troughR ** 2 - u * u)]

/** The teeth's corners from the trough before the first crest to the crest
 *  after the last trough, in order out along u. */
function corners(): Vec2[] {
  const out: Vec2[] = [troughAt(FR.r0 - FR.pitch + FR.riser)]
  for (let k = 0; k < FR.teeth; k++) {
    const u = FR.r0 + k * FR.pitch
    out.push(crestAt(u), troughAt(u + FR.riser))
  }
  out.push(crestAt(FR.r0 + FR.teeth * FR.pitch))
  return out
}

/** The profile as a section gives it: from the middle of the facet before
 *  the first crest to the middle of the facet after the last trough, a
 *  point every `step` mm, each moved by noise; with `round`, each corner
 *  cut by a chord `round` mm back along both sides, as a scan blunts a
 *  tip. */
function sawtooth(step: number, noise = 0, round = 0): Vec2[] {
  let c = corners()
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  c = [mid(c[0], c[1]), ...c.slice(1, -1), mid(c[c.length - 2], c[c.length - 1])]
  if (round > 0) {
    const cut: Vec2[] = [c[0]]
    for (let i = 1; i + 1 < c.length; i++) {
      const back = (p: Vec2, q: Vec2): Vec2 => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1])
        return [p[0] + ((q[0] - p[0]) * round) / d, p[1] + ((q[1] - p[1]) * round) / d]
      }
      cut.push(back(c[i], c[i - 1]), back(c[i], c[i + 1]))
    }
    cut.push(c[c.length - 1])
    c = cut
  }
  const rand = mulberry32(5)
  return along(c, step).map((p) => [p[0] + gaussian(rand) * noise, p[1] + gaussian(rand) * noise])
}

/** An open polyline with its sides cut into steps no longer than `step`,
 *  its last point kept. */
function along(poly: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1]
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let t = 0; t < k; t++) out.push([a[0] + ((b[0] - a[0]) * t) / k, a[1] + ((b[1] - a[1]) * t) / k])
  }
  out.push(poly[poly.length - 1])
  return out
}

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b), `${a} against ${b}`).toBeLessThanOrEqual(tol)

describe('a chain of regular teeth read for its design', () => {
  it('reads the Fresnel’s envelopes, its radial pitch, riser and first crest, and lays the profile on them', () => {
    const chain = sawtooth(0.05)
    // The material lies below the teeth: out of it is +v.
    const t = readTeeth(chain, { outward: chain.map((): Vec2 => [0, 1]) })
    expect(t.crestsBy).toBe('material')
    expect(t.along).toBe('u')
    expect(t.crests.kind).toBe('arc')
    expect(t.troughs.kind).toBe('arc')
    if (t.crests.kind !== 'arc' || t.troughs.kind !== 'arc') return
    near(t.crests.radius, FR.crestR, 0.01)
    near(t.troughs.radius, FR.troughR, 0.01)
    near(t.crests.center[0], 0, 0.01)
    near(t.pitch, FR.pitch, 1e-3)
    near(t.riser, FR.riser, 1e-3)
    near(t.facet, FR.pitch - FR.riser, 1e-3)
    near(t.crestToTrough, FR.riser, 1e-3)
    near(t.start, FR.r0, 2e-3)
    expect(t.profile).toHaveLength(42)
    expect(t.kinds[0]).toBe('crest')
    expect(t.kinds[41]).toBe('trough')
    // Each corner of the profile on the design's.
    const want = corners().slice(1, -1)
    t.profile.forEach((p, i) => expect(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]), `corner ${i}`).toBeLessThan(2e-3))
    expect(t.fit.rms).toBeLessThan(1e-3)
    near(t.depth.mean, 0.6, 0.1)
  })

  it('reads them through the scan’s noise and its rounded tips', () => {
    const chain = sawtooth(0.08, 0.02, 0.12)
    const t = readTeeth(chain, { outward: chain.map((): Vec2 => [0, 1]) })
    expect(t.along).toBe('u')
    if (t.crests.kind !== 'arc' || t.troughs.kind !== 'arc') throw new Error('envelopes are arcs')
    // The circle fit run to its least reads the crests 92.49 ± 0.18 here:
    // 1.6 sigma off, as noise on 21 corners leaves it.
    near(t.crests.radius, FR.crestR, 0.3)
    near(t.troughs.radius, FR.troughR, 0.3)
    // The radius is the least sure of it: its sigma says by how much.
    expect(Math.abs(t.crests.radius - FR.crestR)).toBeLessThan(3 * t.crests.radiusSigma)
    expect(t.crests.radiusSigma).toBeLessThan(0.3)
    near(t.pitch, FR.pitch, 0.005)
    near(t.riser, FR.riser, 0.02)
    near(t.start, FR.r0, 0.03)
    expect(t.profile).toHaveLength(42)
    expect(t.fit.rms).toBeLessThan(0.05)
  })

  it('tells crests by the material, else by side, and refuses a chain with no teeth', () => {
    const chain = sawtooth(0.05)
    // The material above the teeth instead: the tips are the other way.
    const down = readTeeth(chain, { outward: chain.map((): Vec2 => [0, -1]) })
    expect(down.crestsBy).toBe('material')
    if (down.crests.kind !== 'arc') throw new Error('arc')
    near(down.crests.radius, FR.troughR, 0.01)
    for (const c of down.crests.corners) near(c[1], troughAt(c[0])[1], 1e-3)
    // Told nothing: the crests are those away from the trend's centre —
    // below it here — and the profile is the same.
    const side = readTeeth(chain)
    expect(side.crestsBy).toBe('side')
    if (side.crests.kind !== 'arc') throw new Error('arc')
    near(side.crests.radius, FR.troughR, 0.01)
    expect(side.profile).toHaveLength(42)
    expect(() => readTeeth(along([[0, 0], [10, 0], [10, 5]], 0.1))).toThrow(/teeth take 3 of each/)
  })

  it('reads a straight rack along its trend', () => {
    // Teeth 2 apart on a line at 30°, 0.8 deep, their steep side 0.5 long.
    const a = Math.PI / 6
    const d: Vec2 = [Math.cos(a), Math.sin(a)]
    const n: Vec2 = [-d[1], d[0]]
    const at = (s: number, h: number): Vec2 => [5 + s * d[0] + h * n[0], 3 + s * d[1] + h * n[1]]
    const c: Vec2[] = [at(-0.7, 0.4)]
    for (let k = 0; k < 8; k++) c.push(at(2 * k, 0.8), at(2 * k + 0.5, 0))
    c.push(at(16 - 0.7, 0.4))
    const t = readTeeth(along(c, 0.05))
    expect(t.along).toBe('trend')
    expect(t.crests.kind).toBe('line')
    near(t.pitch, 2, 1e-3)
    near(t.riser, 0.5, 1e-3)
    near(t.depth.mean, 0.8, 1e-3)
    expect(t.profile).toHaveLength(16)
  })
})

describe('reverse.section.fit { periodic } on a section through teeth', () => {
  let headless: Headless
  let session: ReverseSession
  const stops: (() => void)[] = []
  // The teeth on top of a plate 4 thick, the material below them; traced
  // counter-clockwise round it, as a scan's outward normals have it.
  const teeth = sawtooth(0.15)
  const base = Math.min(...teeth.map((p) => p[1])) - 4
  const outline: Vec2[] = [[teeth[0][0], base], [teeth[teeth.length - 1][0], base], ...[...teeth].reverse()]

  beforeAll(async () => {
    plugin.install?.()
    headless = await startHeadless()
    session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
    stops.push(installReverseSession(session), session.watch())
    await run('scan.open', { bytes: stlBytes(soupOf(prism(densify(outline, 0.15), 20, 0.02))), name: 'fresnel.stl', discard: true })
  }, 60_000)
  afterAll(() => {
    for (const stop of stops) stop()
    headless.stop()
  })
  beforeEach(resetReverse)

  interface Periodic {
    teeth: number
    pitch: number
    along: string
    riser: number
    crestsBy: string
    crests: { kind: string; radius?: number; radiusSigma?: number; center?: Vec2; world?: { center: Vec3 } }
    troughs: { kind: string; radius?: number }
    first: { kind: string; at: Vec2; s: number }
    profile: { count: number; sheet: Vec2[]; world?: Vec3[] }
    shape: { kind: string; closed: boolean; world?: boolean; points: number[][] }
    fit: { rms: number }
  }
  type Fit = { chains: { index: number; run?: number; periodic?: Periodic; error?: string }[] }

  it('reads the teeth in the band asked for, the profile ready for a sketch in its own [u, v] and in the world', async () => {
    const sec = await run<{ section: { id: number } }>('section.cut', { across: 'XY', offset: 7, name: 'Teeth' })
    // The teeth alone: the plate's sides and underside left out.
    const band = { world: { min: [teeth[0][0] + 0.1, base + 2, 0] as Vec3, max: [teeth[teeth.length - 1][0] - 0.1, 0, 20] as Vec3 } }
    // On a sketch on the XY plane at z 7, [u, v] are X and Y.
    const fit = await run<Fit>('reverse.section.fit', { section: sec.section.id, periodic: true, within: band, plane: { kind: 'world', axis: 'z', offset: 7 } })
    expect(fit.chains).toHaveLength(1)
    const p = fit.chains[0].periodic!
    expect(p.crestsBy).toBe('material')
    expect(p.along).toBe('u')
    near(p.crests.radius!, FR.crestR, 0.3)
    expect(p.crests.radiusSigma).toBeGreaterThan(0)
    near(p.troughs.radius!, FR.troughR, 0.3)
    near(p.pitch, FR.pitch, 0.005)
    near(p.riser, FR.riser, 0.03)
    expect(p.teeth).toBe(21)
    expect(p.profile.count).toBe(42)
    expect(p.first.kind).toBe('crest')
    expect(p.shape).toMatchObject({ kind: 'polyline', closed: false })
    expect(p.shape.world).toBeUndefined()
    expect(p.shape.points).toHaveLength(42)
    near(p.shape.points[0][0], FR.r0, 0.03)
    near(p.shape.points[0][1], crestAt(FR.r0)[1], 0.03)
    for (const q of p.profile.world!) near(q[2], 7, 1e-6)
    expect(p.fit.rms).toBeLessThan(0.05)
    // Without a plane, the shape comes in the world, for any sketch on it.
    const bare = await run<Fit>('reverse.section.fit', { section: sec.section.id, periodic: true, within: band })
    const w = bare.chains[0].periodic!.shape
    expect(w.world).toBe(true)
    near(w.points[0][0], FR.r0, 0.03)
    near(w.points[0][2], 7, 1e-6)
    expect((await refused('reverse.section.fit', { section: sec.section.id, periodic: true, arcs: 2 })).code).toBe('invalid_input')
    expect((await refused('reverse.section.fit', { section: sec.section.id, plane: { kind: 'world', axis: 'z' } })).code).toBe('invalid_input')
  })
})
