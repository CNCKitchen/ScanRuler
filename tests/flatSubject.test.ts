// SPDX-License-Identifier: AGPL-3.0-only
// One subject on the 2D sheet at a time — the image or a section — each
// with its own sheet of measurements, stashed on the way out and restored
// on the way back.
import { beforeEach, describe, expect, it } from 'vitest'
import { imageScaleX, sectionElementsOf, sheetKeyOf, subjectFromKey, useFlat } from '../src/state/flatStore'

function reset() {
  useFlat.setState({
    imageName: null,
    imageWidth: 0,
    imageHeight: 0,
    metaPxPerMm: null,
    subject: { kind: 'image' },
    subjectVersion: 0,
    sheets: {},
    elements: [],
    draft: null,
    nextId: 1,
    nameCounts: {},
    dimensions: [],
    dimDraft: null,
    nextDimId: 1,
    dimCounts: {},
    pxPerMm: null,
    calSource: 'none',
    tool: { kind: 'none' },
    splitAxes: false,
    counts: [],
    nextCountId: 1,
    notes: [],
    nextNoteId: 1,
    datum: null,
    edgeStatus: 'idle',
    edgeCount: 0,
  })
}

const pickPoint = (at: [number, number]) => {
  useFlat.getState().startDraft('point', 'flat-point-pick')
  useFlat.getState().addDraftPick(at)
  return useFlat.getState().commitDraft()!
}

describe('the sheet subject', () => {
  beforeEach(reset)

  it('keys subjects and reads them back', () => {
    expect(sheetKeyOf({ kind: 'image' })).toBe('image')
    expect(sheetKeyOf({ kind: 'section', id: 7 })).toBe('section:7')
    expect(subjectFromKey('section:7')).toEqual({ kind: 'section', id: 7 })
    expect(subjectFromKey('image')).toEqual({ kind: 'image' })
  })

  it('stashes the image sheet and opens a section in millimetres', () => {
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    pickPoint([100, 200])
    useFlat.getState().startDatum()
    useFlat.getState().addDatumPick([0, 0])
    useFlat.getState().addDatumPick([100, 0])
    expect(useFlat.getState().datum).not.toBeNull()

    useFlat.getState().setSubject({ kind: 'section', id: 3 })
    let s = useFlat.getState()
    expect(s.subject).toEqual({ kind: 'section', id: 3 })
    expect(s.subjectVersion).toBe(1)
    expect(s.elements).toEqual([])
    expect(s.datum).toBeNull()
    expect(s.pxPerMm).toEqual({ x: 1, y: 1 })
    expect(s.calSource).toBe('section')
    expect(Object.keys(s.sheets)).toEqual(['image'])

    // Measured on the section, in millimetres straight off the pick.
    const id = pickPoint([12.5, -3])
    expect(useFlat.getState().elements[0].fit).toEqual({
      kind: 'point',
      at: [12.5, -3],
      sigma: 0,
      usedPoints: 0,
    })
    expect(id).toBe(1)

    // Back to the image: everything as it was left, the section's kept.
    useFlat.getState().setSubject({ kind: 'image' })
    s = useFlat.getState()
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0].fit?.kind === 'point' && s.elements[0].fit.at).toEqual([10, 20])
    expect(s.datum).not.toBeNull()
    expect(s.pxPerMm).toEqual({ x: 10, y: 10 })
    expect(s.calSource).toBe('metadata')
    expect(Object.keys(s.sheets)).toEqual(['section:3'])
    expect(s.sheets['section:3'].elements).toHaveLength(1)

    // Choosing the subject already on the stage changes nothing.
    useFlat.getState().setSubject({ kind: 'image' })
    expect(useFlat.getState().subjectVersion).toBe(2)
  })

  it('reads the image scale wherever the image sheet is', () => {
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    expect(imageScaleX(useFlat.getState())).toBe(10)
    useFlat.getState().setSubject({ kind: 'section', id: 1 })
    expect(useFlat.getState().pxPerMm).toEqual({ x: 1, y: 1 })
    expect(imageScaleX(useFlat.getState())).toBe(10)
  })

  it('refuses to calibrate a section', () => {
    useFlat.getState().setSubject({ kind: 'section', id: 1 })
    useFlat.getState().startCalibration('distance')
    expect(useFlat.getState().tool.kind).toBe('none')
    useFlat.getState().saveProfile('x')
    useFlat.getState().applyProfile('x')
    expect(useFlat.getState().pxPerMm).toEqual({ x: 1, y: 1 })
    expect(useFlat.getState().calSource).toBe('section')
  })

  it('puts a newly opened image on the stage and keeps the section sheet', () => {
    useFlat.getState().setSubject({ kind: 'section', id: 2 })
    pickPoint([1, 1])
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    const s = useFlat.getState()
    expect(s.subject).toEqual({ kind: 'image' })
    expect(s.elements).toEqual([])
    expect(s.calSource).toBe('metadata')
    expect(s.sheets['section:2'].elements).toHaveLength(1)
  })

  it('keeps a measured calibration across an image swap, from behind a section too', () => {
    useFlat.getState().finishImageLoad('a.png', 1000, 800, { x: 10, y: 10 })
    useFlat.getState().startCalibration('distance')
    useFlat.getState().addCalPick([0, 0])
    useFlat.getState().addCalPick([1000, 0])
    expect(useFlat.getState().applyCalibration(50)).toBeNull()
    useFlat.getState().setSubject({ kind: 'section', id: 2 })
    useFlat.getState().finishImageLoad('b.png', 500, 500, null)
    expect(useFlat.getState().calSource).toBe('measured')
    expect(useFlat.getState().pxPerMm).toEqual({ x: 20, y: 20 })
  })

  it('turns each sheet by its own quarter turns, wrapping round', () => {
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    expect(useFlat.getState().turns).toBe(0)
    useFlat.getState().turnSheet(1)
    expect(useFlat.getState().turns).toBe(1)
    // Clockwise from the start is three quarters counter-clockwise.
    useFlat.getState().turnSheet(-2)
    expect(useFlat.getState().turns).toBe(3)
    useFlat.getState().turnSheet(5)
    expect(useFlat.getState().turns).toBe(0)
    useFlat.getState().turnSheet(1)

    // A section comes up the way it was cut; the image keeps its turn.
    useFlat.getState().setSubject({ kind: 'section', id: 3 })
    expect(useFlat.getState().turns).toBe(0)
    expect(useFlat.getState().sheets.image.turns).toBe(1)
    useFlat.getState().turnSheet(-1)
    useFlat.getState().setSubject({ kind: 'image' })
    expect(useFlat.getState().turns).toBe(1)
    expect(useFlat.getState().sheets['section:3'].turns).toBe(3)

    // A fresh image is laid the way it was scanned.
    useFlat.getState().finishImageLoad('u.png', 500, 500, null)
    expect(useFlat.getState().turns).toBe(0)
  })

  it('mirrors each sheet on its own, as it is shown', () => {
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    expect(useFlat.getState().mirror).toBe(false)
    useFlat.getState().mirrorSheet('left-right')
    expect(useFlat.getState()).toMatchObject({ mirror: true, turns: 2 })

    // A section comes up the way it was cut; the image keeps its mirror.
    useFlat.getState().setSubject({ kind: 'section', id: 3 })
    expect(useFlat.getState()).toMatchObject({ mirror: false, turns: 0 })
    useFlat.getState().mirrorSheet('top-bottom')
    expect(useFlat.getState()).toMatchObject({ mirror: true, turns: 0 })
    useFlat.getState().setSubject({ kind: 'image' })
    expect(useFlat.getState()).toMatchObject({ mirror: true, turns: 2 })
    expect(useFlat.getState().sheets['section:3']).toMatchObject({ mirror: true, turns: 0 })

    // A fresh image is laid the way it was scanned.
    useFlat.getState().finishImageLoad('u.png', 500, 500, null)
    expect(useFlat.getState().mirror).toBe(false)
  })

  it('drops the sheets of sections that are gone, and steps off a gone one', () => {
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
    pickPoint([5, 5])
    useFlat.getState().setSubject({ kind: 'section', id: 1 })
    pickPoint([1, 1])
    useFlat.getState().setSubject({ kind: 'section', id: 2 })
    pickPoint([2, 2])
    expect(Object.keys(useFlat.getState().sheets).sort()).toEqual(['image', 'section:1'])

    // Section 1 deleted while section 2 is on the stage: only its sheet goes.
    useFlat.getState().dropSections([2])
    expect(Object.keys(useFlat.getState().sheets)).toEqual(['image'])
    expect(useFlat.getState().subject).toEqual({ kind: 'section', id: 2 })

    // Section 2 deleted while on the stage: the image comes back as left.
    useFlat.getState().dropSections([])
    const s = useFlat.getState()
    expect(s.subject).toEqual({ kind: 'image' })
    expect(s.elements).toHaveLength(1)
    expect(s.pxPerMm).toEqual({ x: 10, y: 10 })
    expect(s.sheets).toEqual({})
  })

  it("reads a section's elements wherever its sheet is", () => {
    // On the stage: the store's own list.
    useFlat.getState().setSubject({ kind: 'section', id: 1 })
    pickPoint([1, 1])
    let s = useFlat.getState()
    expect(sectionElementsOf(s, 1)).toBe(s.elements)
    expect(sectionElementsOf(s, 1)).toHaveLength(1)
    expect(sectionElementsOf(s, 2)).toEqual([])

    // Stashed behind another subject: the same element, out of the stash.
    useFlat.getState().setSubject({ kind: 'section', id: 2 })
    s = useFlat.getState()
    expect(sectionElementsOf(s, 1)).toHaveLength(1)
    expect(sectionElementsOf(s, 1)[0].kind).toBe('point')
    expect(sectionElementsOf(s, 2)).toEqual([])

    // The one empty list for every section nothing was measured on, so a
    // subscriber comparing by identity sees nothing change.
    expect(sectionElementsOf(s, 3)).toBe(sectionElementsOf(s, 7))
  })
})
