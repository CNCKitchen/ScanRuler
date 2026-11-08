// SPDX-License-Identifier: AGPL-3.0-only
// Sections through an axis rather than across it: the frame a plane through
// an axis takes at any angle (u out along the radius, v up the axis, never
// seen from behind), the section draft that keeps that definition so its
// angle can be edited, its name in the record, a project round trip, and
// section.cut taking { axis, angleDeg } end to end on a scanned cylinder.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { collectProject, prepareProjectState } from '../src/app/project'
import { packProject, readMembers, unpackProject } from '../src/core/project/archive'
import { frameKey, radialFrame, sectionRefName, type SectionFrame } from '../src/core/section/frame'
import type { SectionCut } from '../src/core/section/slice'
import type { CylinderFit, Vec3 } from '../src/core/types'
import { cross, dot } from '../src/core/vec'
import { useStore, type Element } from '../src/state/store'
import { refused, run, startHeadless, stlBytes, type Headless } from './commandKit'
import { cylinderMesh } from './helpers'
import { fresh, sources } from './projectKit'

const deg = (d: number) => (d * Math.PI) / 180

function expectVec(got: Vec3, want: Vec3, digits = 9) {
  for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], digits)
}

/** Right-handed and square: the normal is U × V, all unit. */
function expectRightHanded(f: SectionFrame) {
  expectVec(cross(f.basisU, f.basisV), f.normal)
  expect(dot(f.basisU, f.basisV)).toBeCloseTo(0, 12)
  for (const v of [f.basisU, f.basisV, f.normal]) expect(Math.hypot(...v)).toBeCloseTo(1, 12)
}

describe('the frame of a plane through an axis', () => {
  it('has u out along the radius and v up the axis at every angle, from +X towards +Y about Z', () => {
    const axis = { origin: [5, -3, 2] as Vec3, dir: [0, 0, 1] as Vec3 }
    for (const a of [0, 30, 52, 90, 179, 232, 300, -45, 412]) {
      const f = radialFrame(axis, a)!
      expectVec(f.basisU, [Math.cos(deg(a)), Math.sin(deg(a)), 0])
      expectVec(f.basisV, [0, 0, 1])
      expectVec(f.origin, [5, -3, 2])
      expectRightHanded(f)
    }
  })

  it('is never mirrored: half a turn on, u is the other way, v the same, the sheet seen from the other side', () => {
    const axis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 }
    const a = radialFrame(axis, 52)!
    const b = radialFrame(axis, 232)!
    expectVec(b.basisU, a.basisU.map((x) => -x) as Vec3)
    expectVec(b.basisV, a.basisV)
    expectVec(b.normal, a.normal.map((x) => -x) as Vec3)
  })

  it('runs v up whichever way the axis was fitted pointing', () => {
    const down = radialFrame({ origin: [0, 0, 0], dir: [0, 0, -3] }, 52)!
    const up = radialFrame({ origin: [0, 0, 0], dir: [0, 0, 1] }, 52)!
    for (const k of ['basisU', 'basisV', 'normal'] as const) expectVec(down[k], up[k])
  })

  it('counts from the coordinate axis next round on the other axes, and on a leaning one', () => {
    // About X: 0° is +Y, 90° +Z.
    const x0 = radialFrame({ origin: [0, 0, 0], dir: [-1, 0, 0] }, 0)!
    expectVec(x0.basisU, [0, 1, 0])
    expectVec(x0.basisV, [1, 0, 0])
    expectVec(radialFrame({ origin: [0, 0, 0], dir: [1, 0, 0] }, 90)!.basisU, [0, 0, 1])
    // About Y: 0° is +Z.
    expectVec(radialFrame({ origin: [0, 0, 0], dir: [0, 1, 0] }, 0)!.basisU, [0, 0, 1])
    // A leaning axis: u square to it, v along it, every angle right-handed.
    const lean: Vec3 = [0.3, -0.2, 0.9]
    for (const a of [0, 52, 232]) {
      const f = radialFrame({ origin: [1, 1, 1], dir: lean }, a)!
      expect(dot(f.basisU, lean)).toBeCloseTo(0, 12)
      expect(dot(f.basisV, lean) / Math.hypot(...lean)).toBeCloseTo(1, 12)
      expectRightHanded(f)
    }
    expect(radialFrame({ origin: [0, 0, 0], dir: [0, 0, 0] }, 10)).toBeNull()
  })
})

const bore: CylinderFit = { kind: 'cylinder', center: [10, 0, 4], axis: [0, 0, -1], radius: 4, length: 30, coverage: 360, sigma: 0, usedPoints: 0, regionSize: 0 }

function element(id: number, name: string, fit: CylinderFit): Element {
  return { id, kind: fit.kind, name, color: '#123', source: { type: 'fitted', seeds: [1], settings: { method: 'gaussian', sigma: 3 } }, status: 'done', visible: true, fit }
}

/** A cut in whatever frame the draft names now, so it is ready to create. */
function cutTheDraft() {
  const f = useStore.getState().sectionDraft!.frame!
  const at = (u: number, v: number): number[] => [0, 1, 2].map((i) => f.origin[i] + u * f.basisU[i] + v * f.basisV[i])
  const cut: SectionCut = { points: Float32Array.from([...at(4, 0), ...at(4, 10), ...at(6, 10)]), offsets: Uint32Array.from([0, 3]) }
  useStore.getState().resolveSectionDraft(frameKey(f), cut)
}

describe('a section through an axis in the store', () => {
  beforeEach(() => {
    fresh()
    useStore.setState({ elements: [element(2, 'Bore', bore)], nextId: 3 })
  })

  function made(angleDeg: number): number {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef({ axis: 2, angleDeg })
    cutTheDraft()
    return useStore.getState().commitSection()!
  }

  it('keeps its axis and angle, and an edit of the angle turns it about the axis without mirroring it', () => {
    const id = made(52)
    const sec = useStore.getState().sections.find((s) => s.id === id)!
    expect(sec.ref).toEqual({ axis: 2, angleDeg: 52 })
    expectVec(sec.frame.origin, [10, 0, 4])
    expectVec(sec.frame.basisU, [Math.cos(deg(52)), Math.sin(deg(52)), 0])
    expectVec(sec.frame.basisV, [0, 0, 1])
    expect(sectionRefName(sec.ref, useStore.getState().elements)).toBe('Bore, radial at 52°')

    // Re-opened, the reference is still there to edit; turned half round,
    // the sheet's X follows the radius, not the X it had.
    useStore.getState().editSection(id)
    expect(useStore.getState().sectionDraft?.ref).toEqual({ axis: 2, angleDeg: 52 })
    useStore.getState().setSectionDraftRef({ axis: 2, angleDeg: 232 })
    cutTheDraft()
    expect(useStore.getState().commitSection()).toBe(id)
    const edited = useStore.getState().sections.find((s) => s.id === id)!
    expect(edited.ref).toEqual({ axis: 2, angleDeg: 232 })
    expectVec(edited.frame.basisU, [Math.cos(deg(232)), Math.sin(deg(232)), 0])
    expectVec(edited.frame.basisV, [0, 0, 1])
    expectRightHanded(edited.frame)
  })

  it('loses its reference, not its plane, when the axis is deleted', () => {
    const id = made(52)
    const before = useStore.getState().sections[0].frame
    useStore.getState().removeElement(2)
    const sec = useStore.getState().sections.find((s) => s.id === id)!
    expect(sec.ref).toBeNull()
    expect(sec.frame).toEqual(before)
  })

  it('comes back from a project file with its axis and angle', async () => {
    const id = made(52)
    const { manifest, members } = collectProject(sources(), null, '0.1.0')
    const back = unpackProject(packProject(manifest, await readMembers(members)))
    useStore.setState({ sections: [] })
    prepareProjectState(back.manifest, back.members)()
    const sec = useStore.getState().sections.find((s) => s.id === id)!
    expect(sec.ref).toEqual({ axis: 2, angleDeg: 52 })
    expectVec(sec.frame.basisU, [Math.cos(deg(52)), Math.sin(deg(52)), 0])
    // Cut again on load, as any section is; and still editable by angle.
    expect(sec.cut).toBeUndefined()
    useStore.getState().editSection(id)
    useStore.getState().setSectionDraftRef({ axis: 2, angleDeg: 100 })
    expectVec(useStore.getState().sectionDraft!.frame!.basisU, [Math.cos(deg(100)), Math.sin(deg(100)), 0])
  })
})

describe('section.cut through an axis', () => {
  let headless: Headless
  beforeAll(async () => {
    headless = await startHeadless()
  })
  afterAll(() => headless.stop())

  it('cuts a half section with u the radius and v the axis, about a coordinate axis or an element by name', async () => {
    // A cylinder of radius 10 along Z, from −15 to 15.
    await run('scan.open', { bytes: stlBytes(cylinderMesh(10, 30).positions), name: 'turned.stl', discard: true })
    type Got = { section: { id: number; across: unknown }; plane: { origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3 }; chains: { sheet: [number, number][]; world: Vec3[] }[] }
    for (const a of [52, 232]) {
      const made = await run<{ section: { id: number; across: unknown } }>('section.cut', { across: { axis: 'Z', angleDeg: a } })
      expect(made.section.across).toEqual({ axis: 'z', angleDeg: a })
      const got = await run<Got>('section.get', { section: made.section.id, space: 'both', limit: 50_000 })
      expectVec(got.plane.basisU, [Math.cos(deg(a)), Math.sin(deg(a)), 0], 6)
      expectVec(got.plane.basisV, [0, 0, 1], 6)
      for (const c of got.chains) {
        c.sheet.forEach(([u, v], i) => {
          const p = c.world[i]
          // v is the height; u the signed distance out along the radius.
          expect(v).toBeCloseTo(p[2] - got.plane.origin[2], 3)
          expect(u).toBeCloseTo(p[0] * Math.cos(deg(a)) + p[1] * Math.sin(deg(a)), 3)
        })
      }
      // The wall on the radius's side is at u = +10.
      const us = got.chains.flatMap((c) => c.sheet.map((q) => q[0]))
      expect(Math.max(...us)).toBeCloseTo(10, 1)
    }
    // An element's axis, by name.
    useStore.setState((s) => ({ elements: [...s.elements, element(s.nextId, 'Bore', { ...bore, center: [0, 0, 15], axis: [0, 0, -1] })], nextId: s.nextId + 1 }))
    const named = await run<{ section: { across: { axis: number; angleDeg: number } } }>('section.cut', { across: { axis: 'Bore', angleDeg: 90 }, name: 'Radial 90' })
    expect(named.section.across.angleDeg).toBe(90)
    const got = await run<Got>('section.get', { section: 'Radial 90' })
    expectVec(got.plane.basisU, [0, 1, 0], 6)
    expectVec(got.plane.basisV, [0, 0, 1], 6)
    expectVec(got.plane.origin, [0, 0, 15], 6)
    expect((await refused('section.cut', { across: { axis: 'Nothing', angleDeg: 0 } })).code).toBe('not_found')
  })
})
