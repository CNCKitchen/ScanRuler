// SPDX-License-Identifier: AGPL-3.0-only
// Scaling the scan to its true size (core/scanScale, app/partScale,
// scan.scale): the arithmetic of a factor and its references, then a 40 mm
// box in the in-process worker scaled from a dimension measured on it — the
// mesh read again at the new size, everything measured on it scaled with it,
// the project keeping the factor, and what refuses.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  combineReferences,
  factorProblem,
  noTrueSize,
  scaleFit,
  scaleRigid,
  scaleSource,
  sizeLooksOff,
} from '../src/core/scanScale'
import { rigidApply, rigidFromAxisAngle } from '../src/core/deviation/rigid'
import type { CylinderFit, PlaneFit } from '../src/core/types'
import { collectProject, prepareProjectState } from '../src/app/project'
import { registerProjectSection } from '../src/app/projectSections'
import { validateManifest } from '../src/core/project/manifest'
import { useStore } from '../src/state/store'
import { boxMesh } from './helpers'
import { refused, run, startHeadless, stlBytes, type Headless } from './commandKit'

describe('the arithmetic of a scale', () => {
  it('takes one reference as it is and averages several by length, in logarithms', () => {
    expect(combineReferences([{ label: 'a', measured: 2, true: 50 }]).factor).toBeCloseTo(25, 12)
    // ×2 and ×½ over the same length come to ×1, not ×1.25.
    expect(combineReferences([{ label: 'a', measured: 10, true: 20 }, { label: 'b', measured: 40, true: 20 }]).factor).toBeCloseTo(1, 12)
    const c = combineReferences([{ label: 'long', measured: 4, true: 100 }, { label: 'short', measured: 0.4, true: 10.2 }])
    // The long one counts ten times as much.
    expect(c.factor).toBeCloseTo(Math.exp((100 * Math.log(25) + 10.2 * Math.log(25.5)) / 110.2), 12)
    expect(c.references[1].off).toBeGreaterThan(0)
    expect(c.spread).toBeCloseTo(Math.max(...c.references.map((r) => Math.abs(r.off))), 12)
    expect(() => combineReferences([{ label: 'Distance 1', measured: 0, true: 5 }])).toThrow('Distance 1')
    expect(() => combineReferences([])).toThrow()
  })

  it('refuses a factor that is no factor', () => {
    expect(factorProblem(25.4)).toBeNull()
    for (const f of [0, -2, NaN, Infinity, 1, 1e9]) expect(factorProblem(f)).not.toBeNull()
  })

  it('scales every length of a fit and leaves its directions', () => {
    const cyl: CylinderFit = { kind: 'cylinder', center: [1, 2, 3], axis: [0, 0, 1], radius: 5, length: 10, coverage: 360, sigma: 0.01, usedPoints: 9, regionSize: 9, formError: 0.04, residualMin: -0.02, residualMax: 0.02 }
    expect(scaleFit(cyl, 2)).toEqual({ ...cyl, center: [2, 4, 6], radius: 10, length: 20, sigma: 0.02, formError: 0.08, residualMin: -0.04, residualMax: 0.04 })
    const plane: PlaneFit = { kind: 'plane', center: [0, 0, 4], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0], extentU: 3, extentV: 2, sigma: 0, usedPoints: 1, regionSize: 1 }
    expect(scaleFit(plane, 0.5)).toEqual({ ...plane, center: [0, 0, 2], extentU: 1.5, extentV: 1 })
    expect(scaleSource({ type: 'constructed', method: 'plane-offset', refs: [3], params: [5] }, 3)).toEqual({ type: 'constructed', method: 'plane-offset', refs: [3], params: [15] })
    expect((scaleSource({ type: 'constructed', method: 'circle-coords', refs: [], params: [10, 0, 0, 1, 1, 2, 3] }, 2) as { params: number[] }).params).toEqual([20, 0, 0, 1, 2, 4, 6])
    expect(scaleSource({ type: 'fitted', seeds: [4], settings: { method: 'lm', sigma: 3 } } as never, 2)).toEqual({ type: 'fitted', seeds: [4], settings: { method: 'lm', sigma: 3 } })
  })

  it('keeps the rotation of an alignment and scales where it moves the part', () => {
    const m = rigidFromAxisAngle([0, 0, 1], 0.7)
    m.t.set([3, -4, 5])
    const s = scaleRigid(m, 4)
    // s·(R·p + t) = R·(s·p) + s·t.
    const a = new Float64Array(3), b = new Float64Array(3)
    rigidApply(m, 1, 2, 3, a)
    rigidApply(s, 4, 8, 12, b)
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(4 * a[i], 12)
  })

  it('says when a scan has no true size, and which unit mix-up would give it one', () => {
    expect(sizeLooksOff(120)).toBeNull()
    expect(sizeLooksOff(2)).toEqual({ small: true, guesses: [{ factor: 10, word: 'centimetres' }, { factor: 25.4, word: 'inches' }, { factor: 1000, word: 'metres' }] })
    expect(sizeLooksOff(0.3)?.guesses.map((g) => g.factor)).toEqual([1000])
    expect(sizeLooksOff(9000)).toEqual({ small: false, guesses: [] })
    expect(noTrueSize('texturedMesh.obj', 60, false)?.why).toBe('meshroom')
    expect(noTrueSize('texturedMesh.obj', 60, true)).toBeNull()
    expect(noTrueSize('bracket.stl', 60, false)).toBeNull()
  })
})

type State = {
  scan: { size: number; bounds: { min: number[]; max: number[] }; scaled?: { factor: number }; noTrueSize?: string; appliedAlignment: unknown }
  dimensions: { name: string; value: number | null }[]
  elements: { name: string; center?: number[] }[]
}

describe('scan.scale on a 40 mm box', () => {
  let headless: Headless
  beforeAll(async () => {
    headless = await startHeadless()
  })
  afterAll(() => headless.stop())
  beforeEach(async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(40, 20)), name: 'box.stl', discard: true })
    await run('element.fit', { kind: 'plane', at: { point: [0, 0, 20] } })
    await run('element.fit', { kind: 'plane', at: { point: [0, 0, -20] } })
    await run('dimension.add', { refs: ['Plane 1', 'Plane 2'] })
  })

  it('scales from a dimension: the mesh read again at the new size, the dimension reading true', async () => {
    const dry = await run<{ factor: number; size: { after: number } }>('scan.scale', { references: [{ dimension: 'Distance 1', true: 50 }], dryRun: true })
    expect(dry.factor).toBeCloseTo(1.25, 6)
    expect((await run<State>('session.state')).dimensions[0].value).toBeCloseTo(40, 3)

    const r = await run<{ factor: number; references: { offPct: number }[]; size: { before: number; after: number } }>('scan.scale', {
      references: [{ dimension: 'Distance 1', true: 50 }],
    })
    expect(r.factor).toBeCloseTo(1.25, 6)
    expect(r.size.after / r.size.before).toBeCloseTo(1.25, 4)
    const s = await run<State>('session.state')
    expect(s.dimensions[0].value).toBeCloseTo(50, 3)
    expect(s.scan.bounds.max[2] - s.scan.bounds.min[2]).toBeCloseTo(50, 3)
    expect(s.scan.scaled?.factor).toBeCloseTo(1.25, 6)
    // The source reads the file at the factor, as a project or a worker
    // restart will read it.
    expect(headless.session.sources.current.scan?.scale).toBeCloseTo(1.25, 12)
    // A fit made afterwards is made on the scan at its true size.
    await run('element.fit', { kind: 'plane', at: { point: [25, 0, 0] } })
    const plane = useStore.getState().elements.find((e) => e.name === 'Plane 3')!.fit as PlaneFit
    expect(plane.center[0]).toBeCloseTo(25, 3)
  })

  it('scales the alignment with the part, about the zero point of its frame', async () => {
    await run('align.datum', { origin: { point: [20, 20, 20] }, keepFree: true })
    await run('scan.scale', { factor: 2 })
    const s = await run<State>('session.state')
    // The corner the zero point was put on is still at the zero point, and
    // the box reaches twice as far the other way.
    expect(s.scan.bounds.max[0]).toBeCloseTo(0, 3)
    expect(s.scan.bounds.min[0]).toBeCloseTo(-80, 3)
    expect(s.dimensions[0].value).toBeCloseTo(80, 3)
  })

  it('keeps the factor in the project, and the record of how it was found', async () => {
    await run('scan.scale', { references: [{ dimension: 'Distance 1', true: 30 }] })
    const { session } = headless
    const { manifest, members } = collectProject(session.sources.current, null, '0.1.0')
    expect(manifest.scan?.scale).toBeCloseTo(0.75, 12)
    expect(manifest.scan?.scaled?.references).toEqual([{ label: 'Distance 1', measured: expect.closeTo(40, 3), true: 30 }])
    expect(() => validateManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow()
    expect(() => validateManifest({ ...manifest, scan: { ...manifest.scan, scale: -1 } })).toThrow('scan.scale')
    useStore.setState({ scanScale: null })
    prepareProjectState(manifest, new Map(members.map((m) => [m.name, m.bytes])))()
    expect(useStore.getState().scanScale?.factor).toBeCloseTo(0.75, 12)
    // Read again from its member at the saved factor, as opening it does.
    const client = session.clientRef.current!
    const member = members.find((m) => m.name === manifest.scan!.member)!
    const { id, mesh } = await client.prepareScan('box.stl', member.bytes.slice().buffer, { mode: 'off' } as never, undefined, 'mm', undefined, manifest.scan!.scale)
    await client.discardImport([id])
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < mesh.positions.length; i += 3) { lo = Math.min(lo, mesh.positions[i]); hi = Math.max(hi, mesh.positions[i]) }
    expect(hi - lo).toBeCloseTo(30, 3)
  })

  it('refuses while work built on the scan would stay behind at the old size', async () => {
    let held = 2
    const stop = registerProjectSection({
      key: 'model',
      collect: () => undefined,
      prepare: () => () => {},
      holds: () => ({ features: held }),
    } as never)
    try {
      const e = await refused('scan.scale', { factor: 2 })
      expect(e.code).toBe('invalid_state')
      expect(e.message).toContain('2 features')
      held = 0
      await run('scan.scale', { factor: 2 })
    } finally {
      stop()
    }
    expect((await refused('scan.scale', { factor: 2, references: [{ dimension: 'Distance 1', true: 9 }] })).code).toBe('invalid_input')
  })

  it('says a Meshroom scan has no true size until it is scaled', async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(2, 6)), name: 'tiny.stl', discard: true })
    expect((await run<State>('session.state')).scan.noTrueSize).toContain('×25.4')
    await run('scan.scale', { factor: 25 })
    expect((await run<State>('session.state')).scan.noTrueSize).toBeUndefined()
  })
})
