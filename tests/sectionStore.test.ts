// SPDX-License-Identifier: AGPL-3.0-only
// The section draft and the sections in the measure store: the plane follows
// the reference and the offset, the cut is only ready once it matches the
// plane, a created section is frozen against its reference, and an alignment
// carries it with the part.
import { beforeEach, describe, expect, it } from 'vitest'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'
import { frameKey } from '../src/core/section/frame'
import type { SectionCut } from '../src/core/section/slice'
import { sectionDraftReady, useStore, type Element } from '../src/state/store'
import type { CylinderFit, PlaneFit } from '../src/core/types'

const plane: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 10],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 5,
  extentV: 5,
  sigma: 0,
  usedPoints: 0,
  regionSize: 0,
}
const cylinder: CylinderFit = {
  kind: 'cylinder',
  center: [0, 0, 0],
  axis: [1, 0, 0],
  radius: 4,
  length: 30,
  coverage: 360,
  sigma: 0,
  usedPoints: 0,
  regionSize: 0,
}

function element(id: number, name: string, fit: PlaneFit | CylinderFit): Element {
  return {
    id,
    kind: fit.kind,
    name,
    color: '#123',
    source: { type: 'fitted', seeds: [1] },
    status: 'done',
    visible: true,
    fit,
  }
}

/** A cut of one closed square loop 2 mm across, on the given plane height. */
function squareCut(z: number): SectionCut {
  return {
    points: Float32Array.from([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z, -1, -1, z]),
    offsets: Uint32Array.from([0, 5]),
  }
}

function fresh() {
  useStore.getState().beginLoad('part.stl')
  useStore.getState().finishLoad(100, 50, 20, [0, 0, 0])
  useStore.setState({
    elements: [element(1, 'Plane 1', plane), element(2, 'Cylinder 1', cylinder)],
    nextId: 3,
    nextNumber: 3,
  })
}

describe('the section draft', () => {
  beforeEach(fresh)

  it('opens empty, takes a reference and an offset, and is ready once cut', () => {
    const s = useStore.getState()
    s.startSection()
    let d = useStore.getState().sectionDraft!
    expect(d.status).toBe('empty')
    expect(d.frame).toBeNull()

    useStore.getState().setSectionDraftRef(1)
    d = useStore.getState().sectionDraft!
    expect(d.status).toBe('slicing')
    expect(d.frame?.origin).toEqual([0, 0, 10])

    useStore.getState().setSectionDraftOffset(-2.5)
    d = useStore.getState().sectionDraft!
    expect(d.frame?.origin).toEqual([0, 0, 7.5])
    expect(sectionDraftReady(d)).toBe(false)

    // A cut for a plane the draft has moved on from is kept as the preview
    // but does not make it ready; one for the current plane does.
    useStore.getState().resolveSectionDraft('stale', squareCut(9))
    d = useStore.getState().sectionDraft!
    expect(d.status).toBe('slicing')
    expect(d.cut).toBeDefined()
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(7.5))
    d = useStore.getState().sectionDraft!
    expect(d.status).toBe('ready')
    expect(sectionDraftReady(d)).toBe(true)
  })

  it('refuses a sphere as a reference and a plane that misses the scan', () => {
    useStore.setState({
      elements: [
        ...useStore.getState().elements,
        {
          ...element(3, 'Sphere 1', plane),
          kind: 'sphere',
          fit: { kind: 'sphere', center: [0, 0, 0], radius: 1, sigma: 0, usedPoints: 0, regionSize: 0 },
        },
      ],
    })
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef(3)
    expect(useStore.getState().sectionDraft!.ref).toBeNull()

    useStore.getState().setSectionDraftRef(1)
    const d = useStore.getState().sectionDraft!
    useStore
      .getState()
      .resolveSectionDraft(frameKey(d.frame!), { points: new Float32Array(0), offsets: new Uint32Array(1) })
    expect(useStore.getState().sectionDraft!.status).toBe('ready')
    expect(sectionDraftReady(useStore.getState().sectionDraft)).toBe(false)
    expect(useStore.getState().commitSection()).toBeNull()
  })

  it('creates a section that keeps its plane whatever happens to the reference', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef(2)
    useStore.getState().setSectionDraftOffset(5)
    let d = useStore.getState().sectionDraft!
    expect(d.frame?.normal).toEqual([1, 0, 0])
    expect(d.frame?.origin).toEqual([5, 0, 0])
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    const id = useStore.getState().commitSection()!
    expect(id).toBe(3)
    const s = useStore.getState()
    expect(s.sectionDraft).toBeNull()
    expect(s.sections).toHaveLength(1)
    expect(s.sections[0].name).toBe('Section 1')
    expect(s.sections[0].ref).toBe(2)
    expect(s.sections[0].offset).toBe(5)
    expect(s.sections[0].cut).toBeDefined()
    expect(s.nextSectionNumber).toBe(2)

    // The cylinder moves: the section does not.
    useStore.getState().resolveFit(2, { ...cylinder, center: [0, 0, 50], region: new Uint32Array(0) })
    expect(useStore.getState().sections[0].frame.origin).toEqual([5, 0, 0])
    // The cylinder goes: the section stays, only the name in its record is gone.
    useStore.getState().removeElement(2)
    expect(useStore.getState().sections).toHaveLength(1)
    expect(useStore.getState().sections[0].ref).toBeNull()
    expect(useStore.getState().sections[0].frame.origin).toEqual([5, 0, 0])

    // Re-opened, it slides along its own frozen plane even with no reference.
    useStore.getState().editSection(3)
    d = useStore.getState().sectionDraft!
    expect(d.status).toBe('ready')
    expect(d.ref).toBeNull()
    expect(d.frame?.origin).toEqual([5, 0, 0])
    useStore.getState().setSectionDraftOffset(6)
    d = useStore.getState().sectionDraft!
    expect(d.frame?.origin).toEqual([6, 0, 0])
    expect(d.status).toBe('slicing')
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    useStore.getState().setSectionDraftName('Mid cut')
    expect(useStore.getState().commitSection()).toBe(3)
    expect(useStore.getState().sections[0].name).toBe('Mid cut')
    expect(useStore.getState().sections[0].offset).toBe(6)
    expect(useStore.getState().sections).toHaveLength(1)
  })

  it('moves with the part under an alignment, cut and all', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef(1)
    const d = useStore.getState().sectionDraft!
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(10))
    useStore.getState().commitSection()

    // A quarter turn about X: +Z becomes -Y.
    const m = rigidFromAxisAngle([1, 0, 0], Math.PI / 2)
    useStore.getState().applyAlignment(m)
    const sec = useStore.getState().sections[0]
    expect(sec.frame.origin[1]).toBeCloseTo(-10, 6)
    expect(sec.frame.normal[1]).toBeCloseTo(-1, 6)
    expect(sec.cutKey).toBe(frameKey(sec.frame))
    // The first point of the loop, (-1, -1, 10), turns to (-1, -10, -1).
    expect(sec.cut!.points[1]).toBeCloseTo(-10, 5)
    expect(sec.cut!.points[2]).toBeCloseTo(-1, 5)
  })

  it('closes the other editors, and is closed by them', () => {
    useStore.getState().startDraft('plane')
    useStore.getState().startSection()
    expect(useStore.getState().draft).toBeNull()
    expect(useStore.getState().sectionDraft).not.toBeNull()
    useStore.getState().startDimension('dist-point-point')
    expect(useStore.getState().sectionDraft).toBeNull()
    useStore.getState().cancelDimension()
    useStore.getState().startSection()
    useStore.getState().startAlignment()
    expect(useStore.getState().sectionDraft).toBeNull()
  })

  it('goes with the scan it was cut through', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef(1)
    const d = useStore.getState().sectionDraft!
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(10))
    useStore.getState().commitSection()
    expect(useStore.getState().sections).toHaveLength(1)
    useStore.getState().beginLoad('other.stl')
    expect(useStore.getState().sections).toHaveLength(0)
    expect(useStore.getState().nextSectionNumber).toBe(1)
  })
})
