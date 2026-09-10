// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { evalSpline, splineHandles } from '../src/core/flat/spline'
import type { FlatSplineFit } from '../src/core/flat/types'
import { useFlat } from '../src/state/flatStore'

// The store is a module-level singleton; each test starts from a fresh image.
function reset() {
  useFlat.setState({
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
  })
  useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
}

describe('the flat draft flow', () => {
  beforeEach(reset)

  it('fits a circle from picks in image pixels, reported in millimetres', () => {
    const s = useFlat.getState()
    s.startDraft('circle', 'flat-circle-pick')
    // A circle of 100 px radius at (500, 400), with 10 px/mm → Ø 20 mm.
    useFlat.getState().addDraftPick([600, 400])
    useFlat.getState().addDraftPick([500, 500])
    useFlat.getState().addDraftPick([400, 400])
    const draft = useFlat.getState().draft!
    expect(draft.fit?.kind).toBe('circle')
    if (draft.fit?.kind !== 'circle') return
    expect(draft.fit.radius).toBeCloseTo(10, 6)
    expect(draft.fit.center[0]).toBeCloseTo(50, 6)

    const id = useFlat.getState().commitDraft()!
    expect(id).toBe(1)
    const el = useFlat.getState().elements[0]
    expect(el.name).toBe('Circle 1')
    expect(el.fit?.kind).toBe('circle')
    expect(useFlat.getState().draft).toBeNull()
  })

  it('moves a picked point instead of accumulating', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().addDraftPick([100, 100])
    useFlat.getState().addDraftPick([200, 300])
    const draft = useFlat.getState().draft!
    expect(draft.picks).toEqual([[200, 300]])
    expect(draft.fit?.kind).toBe('point')
  })

  it('re-derives every fit when the calibration changes', () => {
    useFlat.getState().startDraft('line', 'flat-line-pick')
    useFlat.getState().addDraftPick([0, 0])
    useFlat.getState().addDraftPick([1000, 0])
    useFlat.getState().commitDraft()
    let fit = useFlat.getState().elements[0].fit
    if (fit?.kind !== 'line') throw new Error('not a line')
    expect(fit.length).toBeCloseTo(100, 6)

    // Calibrate: 1000 px across 50 mm → 20 px/mm, so the same edge halves.
    useFlat.getState().startCalibration('distance')
    useFlat.getState().addCalPick([0, 700])
    useFlat.getState().addCalPick([1000, 700])
    expect(useFlat.getState().applyCalibration(50)).toBeNull()
    fit = useFlat.getState().elements[0].fit
    if (fit?.kind !== 'line') throw new Error('not a line')
    expect(fit.length).toBeCloseTo(50, 6)
  })

  it('constructs a line intersection and mourns a deleted reference', () => {
    const make = (a: [number, number], b: [number, number]) => {
      useFlat.getState().startDraft('line', 'flat-line-pick')
      useFlat.getState().addDraftPick(a)
      useFlat.getState().addDraftPick(b)
      return useFlat.getState().commitDraft()!
    }
    const l1 = make([0, 100], [900, 100])
    const l2 = make([300, 0], [300, 700])
    useFlat.getState().startDraft('point', 'flat-point-intersect')
    useFlat.getState().setDraftRef(0, l1)
    useFlat.getState().setDraftRef(1, l2)
    const draft = useFlat.getState().draft!
    if (draft.fit?.kind !== 'point') throw new Error('no intersection')
    expect(draft.fit.at[0]).toBeCloseTo(30, 6)
    expect(draft.fit.at[1]).toBeCloseTo(10, 6)
    const pid = useFlat.getState().commitDraft()!

    useFlat.getState().deleteElement(l2)
    const orphan = useFlat.getState().elements.find((e) => e.id === pid)!
    expect(orphan.fit).toBeNull()
    expect(orphan.error).toMatch(/unavailable/)
  })

  it('names later elements past deleted ones', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().addDraftPick([1, 1])
    const first = useFlat.getState().commitDraft()!
    useFlat.getState().deleteElement(first)
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().addDraftPick([2, 2])
    useFlat.getState().commitDraft()
    // "Point 1" is gone but not forgotten — the next one is not its double.
    expect(useFlat.getState().elements[0].name).toBe('Point 2')
  })

  it('clears elements with a new image but keeps a measured calibration', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().addDraftPick([5, 5])
    useFlat.getState().commitDraft()
    useFlat.getState().startCalibration('distance')
    useFlat.getState().addCalPick([0, 0])
    useFlat.getState().addCalPick([1000, 0])
    useFlat.getState().applyCalibration(100)
    useFlat.getState().finishImageLoad('next.png', 500, 500, null)
    expect(useFlat.getState().elements).toEqual([])
    expect(useFlat.getState().calSource).toBe('measured')
    expect(useFlat.getState().pxPerMm?.x).toBeCloseTo(10, 6)
  })
})

describe('editing, dragging and the dimension rows', () => {
  beforeEach(reset)

  const makeLine = (a: [number, number], b: [number, number]) => {
    useFlat.getState().startDraft('line', 'flat-line-pick')
    useFlat.getState().addDraftPick(a)
    useFlat.getState().addDraftPick(b)
    return useFlat.getState().commitDraft()!
  }

  it('drags a pick and the fit follows', () => {
    useFlat.getState().startDraft('line', 'flat-line-pick')
    useFlat.getState().addDraftPick([0, 0])
    useFlat.getState().addDraftPick([100, 0])
    useFlat.getState().moveDraftPick(1, [100, 100])
    const fit = useFlat.getState().draft!.fit
    if (fit?.kind !== 'line') throw new Error('not a line')
    expect(Math.abs(fit.dir[0])).toBeCloseTo(Math.SQRT1_2, 6)
    // Out-of-range indices are ignored, not thrown.
    useFlat.getState().moveDraftPick(5, [1, 1])
    expect(useFlat.getState().draft!.picks).toHaveLength(2)
  })

  it('re-opens an element with its picks, writes it back in place, and re-reads dependents', () => {
    const l1 = makeLine([0, 100], [900, 100])
    const l2 = makeLine([300, 0], [300, 700])
    useFlat.getState().startDraft('point', 'flat-point-intersect')
    useFlat.getState().setDraftRef(0, l1)
    useFlat.getState().setDraftRef(1, l2)
    const pid = useFlat.getState().commitDraft()!

    useFlat.getState().editElement(l2)
    const draft = useFlat.getState().draft!
    expect(draft.editId).toBe(l2)
    expect(draft.picks).toEqual([
      [300, 0],
      [300, 700],
    ])
    expect(draft.fit?.kind).toBe('line')
    // The vertical line moves to x = 500 px → the intersection follows.
    useFlat.getState().moveDraftPick(0, [500, 0])
    useFlat.getState().moveDraftPick(1, [500, 700])
    useFlat.getState().setDraftName('Right edge')
    expect(useFlat.getState().commitDraft()).toBe(l2)
    const s = useFlat.getState()
    expect(s.draft).toBeNull()
    expect(s.elements.map((e) => e.id)).toEqual([l1, l2, pid])
    expect(s.elements[1].name).toBe('Right edge')
    const p = s.elements[2].fit
    if (p?.kind !== 'point') throw new Error('no intersection')
    expect(p.at[0]).toBeCloseTo(50, 6)
  })

  it('will not let an edited element be built on its own dependents', () => {
    const l1 = makeLine([0, 100], [900, 100])
    const l2 = makeLine([300, 0], [300, 700])
    useFlat.getState().startDraft('point', 'flat-point-intersect')
    useFlat.getState().setDraftRef(0, l1)
    useFlat.getState().setDraftRef(1, l2)
    const pid = useFlat.getState().commitDraft()!
    useFlat.getState().startDraft('point', 'flat-point-midpoint')
    useFlat.getState().setDraftRef(0, pid)
    useFlat.getState().setDraftRef(1, l1)
    const mid = useFlat.getState().commitDraft()!

    useFlat.getState().editElement(pid)
    useFlat.getState().setDraftMethod('flat-point-midpoint')
    useFlat.getState().setDraftRef(0, mid)
    expect(useFlat.getState().draft!.refs[0]).toBeNull()
    useFlat.getState().setDraftRef(0, l1)
    expect(useFlat.getState().draft!.refs[0]).toBe(l1)
  })

  it('names dimensions per group, hides them, and re-opens them', () => {
    const l1 = makeLine([0, 100], [900, 100])
    const l2 = makeLine([0, 300], [900, 300])
    useFlat.getState().startDimDraft()
    useFlat.getState().setDimType('flat-dist-line-line')
    useFlat.getState().setDimRef(0, l1)
    useFlat.getState().setDimRef(1, l2)
    useFlat.getState().commitDim()
    let d = useFlat.getState().dimensions[0]
    expect(d.name).toBe('Distance 1')
    expect(d.visible).toBe(true)

    useFlat.getState().toggleDimensionVisible(d.id)
    expect(useFlat.getState().dimensions[0].visible).toBe(false)

    useFlat.getState().editDimension(d.id)
    expect(useFlat.getState().dimDraft?.editId).toBe(d.id)
    useFlat.getState().setDimName('Slot width')
    useFlat.getState().setDimRef(0, l1)
    useFlat.getState().setDimRef(1, l2)
    useFlat.getState().commitDim()
    d = useFlat.getState().dimensions[0]
    expect(d.name).toBe('Slot width')
    expect(useFlat.getState().dimensions).toHaveLength(1)

    // Turning it into an angle renames it into the angle series.
    useFlat.getState().editDimension(d.id)
    useFlat.getState().setDimType('flat-angle-line-line')
    useFlat.getState().setDimRef(0, l1)
    useFlat.getState().setDimRef(1, l2)
    useFlat.getState().commitDim()
    expect(useFlat.getState().dimensions[0].name).toBe('Angle 1')
  })

  it('closes an editor open on a deleted element and drops its references elsewhere', () => {
    const l1 = makeLine([0, 100], [900, 100])
    const l2 = makeLine([300, 0], [300, 700])
    useFlat.getState().startDimDraft()
    useFlat.getState().setDimType('flat-angle-line-line')
    useFlat.getState().setDimRef(0, l1)
    useFlat.getState().setDimRef(1, l2)
    useFlat.getState().deleteElement(l2)
    expect(useFlat.getState().dimDraft?.refs).toEqual([l1, null])
    useFlat.getState().cancelDimDraft()

    useFlat.getState().editElement(l1)
    useFlat.getState().deleteElement(l1)
    expect(useFlat.getState().draft).toBeNull()
    expect(useFlat.getState().elements).toEqual([])
  })
})

describe('the spline draft', () => {
  beforeEach(reset)
  // Raw picks (Alt), no edge index: the click is the pick. Half a document
  // unit per screen pixel says how near "on the curve" is.
  const meta = { alt: true, unitsPerScreenPx: 0.05 }
  const splineFit = () => useFlat.getState().draft!.fit as FlatSplineFit

  it('collects fit points in order, inserts on a click near the curve, and appends otherwise', () => {
    useFlat.getState().startDraft('spline', 'flat-spline-pick')
    useFlat.getState().stageClick([10, 10], meta, null)
    let draft = useFlat.getState().draft!
    expect(draft.picks).toEqual([[100, 100]])
    expect(draft.tangents).toEqual([null])
    expect(draft.fit).toBeNull()
    expect(draft.error).toBeNull()
    useFlat.getState().stageClick([30, 20], meta, null)
    useFlat.getState().stageClick([50, 10], meta, null)
    draft = useFlat.getState().draft!
    expect(draft.picks).toEqual([
      [100, 100],
      [300, 200],
      [500, 100],
    ])
    expect(draft.tangents).toEqual([null, null, null])
    expect(draft.fit?.kind).toBe('spline')
    // A click a hair off the curve, between the first two points, goes in
    // between them — as the second point, in image pixels.
    const on = evalSpline(splineFit(), 0, 0.5)
    useFlat.getState().stageClick([on[0], on[1] + 0.2], meta, null)
    draft = useFlat.getState().draft!
    expect(draft.picks).toHaveLength(4)
    expect(draft.picks[1][0]).toBeCloseTo(on[0] * 10, 6)
    expect(draft.picks[1][1]).toBeCloseTo((on[1] + 0.2) * 10, 6)
    expect(draft.tangents).toEqual([null, null, null, null])
    // Away from the curve, the click is the next point.
    useFlat.getState().stageClick([70, 30], meta, null)
    draft = useFlat.getState().draft!
    expect(draft.picks).toHaveLength(5)
    expect(draft.picks[4]).toEqual([700, 300])
    // Undo and a pin click keep the handles in step with the picks.
    useFlat.getState().undoDraftPick()
    expect(useFlat.getState().draft!.tangents).toHaveLength(4)
    useFlat.getState().removeDraftPick(1)
    expect(useFlat.getState().draft!.picks).toHaveLength(3)
    expect(useFlat.getState().draft!.tangents).toHaveLength(3)
  })

  it('fixes a tangent by a handle drag, frees it by a click or all at once, and closes the curve', () => {
    useFlat.getState().startDraft('spline', 'flat-spline-pick')
    useFlat.getState().addDraftPick([100, 100])
    useFlat.getState().addDraftPick([300, 200])
    useFlat.getState().addDraftPick([500, 100])
    const open = splineFit().length
    // The leaving end of the middle handle dragged to (32, 24) mm: the
    // handle is the offset from the pick, in image pixels.
    useFlat.getState().stageHandleDrag(1, 'a', [32, 24], meta)
    let draft = useFlat.getState().draft!
    expect(draft.tangents).toEqual([null, [20, 40], null])
    expect(splineFit().fixed).toEqual([false, true, false])
    let handles = splineHandles(splineFit())
    expect(handles[1].a[0]).toBeCloseTo(32, 9)
    expect(handles[1].a[1]).toBeCloseTo(24, 9)
    expect(handles[1].b[0]).toBeCloseTo(28, 9)
    expect(handles[1].b[1]).toBeCloseTo(16, 9)
    // The arriving end sets the opposite offset.
    useFlat.getState().stageHandleDrag(1, 'b', [32, 24], meta)
    expect(useFlat.getState().draft!.tangents[1]).toEqual([-20, -40])
    // A drag onto the pick itself is ignored — it would leave nothing to hold.
    useFlat.getState().stageHandleDrag(1, 'a', [30.01, 20.01], meta)
    expect(useFlat.getState().draft!.tangents[1]).toEqual([-20, -40])
    // A click on the handle lets it go automatic; the curve is as it was.
    useFlat.getState().setDraftTangent(1, null)
    expect(splineFit().fixed).toEqual([false, false, false])
    expect(splineFit().length).toBeCloseTo(open, 9)
    // Free tangents frees the lot.
    useFlat.getState().stageHandleDrag(0, 'a', [12, 14], meta)
    useFlat.getState().stageHandleDrag(2, 'b', [45, 12], meta)
    expect(useFlat.getState().draft!.tangents.filter((t) => t !== null)).toHaveLength(2)
    useFlat.getState().freeDraftTangents()
    expect(useFlat.getState().draft!.tangents).toEqual([null, null, null])
    // Closing adds the return leg and is recorded with the element.
    useFlat.getState().stageHandleDrag(1, 'a', [32, 24], meta)
    useFlat.getState().setDraftClosed(true)
    expect(splineFit().closed).toBe(true)
    expect(splineFit().length).toBeGreaterThan(open)
    handles = splineHandles(splineFit())
    expect(handles).toHaveLength(3)
    const id = useFlat.getState().commitDraft()!
    const el = useFlat.getState().elements[0]
    expect(el.name).toBe('Spline 1')
    expect(el.kind).toBe('spline')
    expect(el.source).toEqual({
      type: 'picks',
      method: 'flat-spline-pick',
      picks: [
        [100, 100],
        [300, 200],
        [500, 100],
      ],
      tangents: [null, [20, 40], null],
      closed: true,
    })
    // Re-opened, the handles and the closure come back with the picks.
    useFlat.getState().editElement(id)
    draft = useFlat.getState().draft!
    expect(draft.editId).toBe(id)
    expect(draft.tangents).toEqual([null, [20, 40], null])
    expect(draft.closed).toBe(true)
    expect(splineFit().fixed).toEqual([false, true, false])
    useFlat.getState().cancelDraft()
  })

  it('waits for a third point once closed rather than failing on two', () => {
    useFlat.getState().startDraft('spline', 'flat-spline-pick')
    useFlat.getState().addDraftPick([100, 100])
    useFlat.getState().addDraftPick([300, 200])
    expect(splineFit().kind).toBe('spline')
    useFlat.getState().setDraftClosed(true)
    expect(useFlat.getState().draft!.fit).toBeNull()
    expect(useFlat.getState().draft!.error).toBeNull()
    useFlat.getState().addDraftPick([500, 100])
    expect(splineFit().closed).toBe(true)
    // Two consecutive picks on one spot cannot carry a curve, and say so.
    useFlat.getState().addDraftPick([500, 100])
    expect(useFlat.getState().draft!.fit).toBeNull()
    expect(useFlat.getState().draft!.error).toMatch(/coincide/)
  })

  it('re-derives a spline and its handles under a new calibration', () => {
    useFlat.getState().startDraft('spline', 'flat-spline-pick')
    useFlat.getState().addDraftPick([100, 100])
    useFlat.getState().addDraftPick([300, 200])
    useFlat.getState().addDraftPick([500, 100])
    useFlat.getState().setDraftTangent(1, [20, 40])
    useFlat.getState().commitDraft()
    const before = useFlat.getState().elements[0].fit as FlatSplineFit
    expect(before.points[1]).toEqual([30, 20])
    // Twice the pixels per millimetre: everything reads half as big, the
    // handle offset included, and the fixed tangent stays fixed.
    useFlat.getState().startCalibration('distance')
    useFlat.getState().addCalPick([0, 0])
    useFlat.getState().addCalPick([200, 0])
    expect(useFlat.getState().applyCalibration(10)).toBeNull()
    const after = useFlat.getState().elements[0].fit as FlatSplineFit
    expect(after.points[1]).toEqual([15, 10])
    expect(after.length).toBeCloseTo(before.length / 2, 9)
    expect(after.fixed).toEqual([false, true, false])
    const h = splineHandles(after)[1]
    expect(h.a[0]).toBeCloseTo(16, 9)
    expect(h.a[1]).toBeCloseTo(12, 9)
  })
})
