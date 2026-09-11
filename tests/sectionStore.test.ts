// SPDX-License-Identifier: AGPL-3.0-only
// The section draft and the sections in the measure store: the plane follows
// the reference and the offset, the cut is only ready once it matches the
// plane, a created section is frozen against its reference, and an alignment
// carries it with the part.
import { beforeEach, describe, expect, it } from 'vitest'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'
import { frameKey, tiltOf, turnAxis } from '../src/core/section/frame'
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
    source: { type: 'fitted', seeds: [1], settings: { method: 'gaussian', sigma: 3 } },
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

describe('a section across a coordinate plane', () => {
  beforeEach(fresh)

  it('goes through the part’s centre, and its offset is its coordinate', () => {
    useStore.setState({ modelCenter: [10, 20, 30] })
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef('z')
    let d = useStore.getState().sectionDraft!
    expect(d.ref).toBe('z')
    expect(d.offset).toBe(30)
    // The plane — and the gizmo on it — sits at the part's centre.
    expect(d.frame?.origin).toEqual([10, 20, 30])
    expect(d.frame?.normal).toEqual([0, 0, 1])
    expect(d.frame?.basisU).toEqual([1, 0, 0])
    expect(d.refDir).toEqual([0, 0, 1])
    expect(d.status).toBe('slicing')

    // Another plane: through the centre again, on its own axis.
    useStore.getState().setSectionDraftRef('x')
    d = useStore.getState().sectionDraft!
    expect(d.offset).toBe(10)
    expect(d.frame?.origin).toEqual([10, 20, 30])

    // Typed to a coordinate, it is at that coordinate.
    useStore.getState().setSectionDraftOffset(-4)
    d = useStore.getState().sectionDraft!
    expect(d.frame?.origin).toEqual([-4, 20, 30])
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    const id = useStore.getState().commitSection()!
    const sec = useStore.getState().sections.find((x) => x.id === id)!
    expect(sec.ref).toBe('x')
    expect(sec.refDir).toEqual([1, 0, 0])
    expect(sec.offset).toBe(-4)

    // Re-opened, it is still across the YZ plane — a coordinate plane
    // cannot be deleted — and slides along it.
    useStore.getState().editSection(id)
    d = useStore.getState().sectionDraft!
    expect(d.ref).toBe('x')
    expect(d.status).toBe('ready')
    useStore.getState().setSectionDraftOffset(2)
    expect(useStore.getState().sectionDraft!.frame?.origin).toEqual([2, 20, 30])
  })

  it('is untouched when an element is deleted', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef('y')
    const d = useStore.getState().sectionDraft!
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    useStore.getState().commitSection()
    useStore.getState().removeElement(1)
    expect(useStore.getState().sections[0].ref).toBe('y')
  })
})

describe('a section plane turned by the gizmo', () => {
  beforeEach(fresh)

  /** Turn the draft's plane `degrees` about its sheet's U, the way a ring
   *  drag does: from the line it slid along when the ring was taken. */
  const turnAboutU = (degrees: number) => {
    const d = useStore.getState().sectionDraft!
    useStore.getState().setSectionDraftAxis(turnAxis(d.axis!, d.offset, d.frame!.basisU, degrees))
  }

  it('keeps its reference and its offset, and reads its tilt off the reference', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef(1)
    useStore.getState().setSectionDraftOffset(-2)
    turnAboutU(15)
    let d = useStore.getState().sectionDraft!
    expect(d.ref).toBe(1)
    expect(d.offset).toBe(-2)
    expect(d.status).toBe('slicing')
    // Still through the point the gizmo sat on: 2 mm into the face at z = 10.
    expect(d.frame!.origin[2]).toBeCloseTo(8, 12)
    expect(tiltOf(d.refDir, d.frame!.normal)).toBeCloseTo(15, 9)
    // The offset still slides it along its own, tilted, normal — one more
    // millimetre from the pivot at z = 8, down the tilted direction.
    useStore.getState().setSectionDraftOffset(-3)
    d = useStore.getState().sectionDraft!
    expect(tiltOf(d.refDir, d.frame!.normal)).toBeCloseTo(15, 9)
    expect(d.frame!.origin[2]).toBeCloseTo(8 - Math.cos(Math.PI / 12), 9)

    // Created, the record carries the tilt; re-opened, so does the draft.
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    const id = useStore.getState().commitSection()!
    const sec = useStore.getState().sections.find((x) => x.id === id)!
    expect(tiltOf(sec.refDir, sec.frame.normal)).toBeCloseTo(15, 9)
    useStore.getState().editSection(id)
    d = useStore.getState().sectionDraft!
    expect(tiltOf(d.refDir, d.frame!.normal)).toBeCloseTo(15, 9)

    // Choosing the reference again squares the plane up, offset kept.
    useStore.getState().setSectionDraftRef(1)
    d = useStore.getState().sectionDraft!
    expect(tiltOf(d.refDir, d.frame!.normal)).toBe(0)
    expect(d.offset).toBe(-3)
    expect(d.frame!.normal).toEqual([0, 0, 1])
  })

  it('squares up to a coordinate plane without jumping back to the centre', () => {
    useStore.setState({ modelCenter: [0, 0, 30] })
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef('z')
    useStore.getState().setSectionDraftOffset(12)
    turnAboutU(10)
    expect(tiltOf(useStore.getState().sectionDraft!.refDir, useStore.getState().sectionDraft!.frame!.normal)).toBeCloseTo(10, 9)
    useStore.getState().setSectionDraftRef('z')
    const d = useStore.getState().sectionDraft!
    expect(d.offset).toBe(12)
    expect(d.frame!.origin).toEqual([0, 0, 12])
  })

  it('does nothing without a plane to turn', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftAxis({ origin: [0, 0, 0], dir: [0, 0, 1] })
    expect(useStore.getState().sectionDraft!.axis).toBeNull()
  })

  it('keeps its tilt reading through an alignment', () => {
    useStore.getState().startSection()
    useStore.getState().setSectionDraftRef('z')
    turnAboutU(25)
    const d = useStore.getState().sectionDraft!
    useStore.getState().resolveSectionDraft(frameKey(d.frame!), squareCut(0))
    useStore.getState().commitSection()
    useStore.getState().applyAlignment(rigidFromAxisAngle([1, 1, 0], 1.1))
    const sec = useStore.getState().sections[0]
    expect(tiltOf(sec.refDir, sec.frame.normal)).toBeCloseTo(25, 9)
    // The reference direction went with the part, so it no longer is Z.
    expect(Math.abs(sec.refDir![2])).toBeLessThan(0.999)
  })
})
