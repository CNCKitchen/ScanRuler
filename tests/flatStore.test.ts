// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { useFlat } from '../src/state/flatStore'

// The store is a module-level singleton; each test starts from a fresh image.
function reset() {
  useFlat.setState({
    elements: [],
    draft: null,
    nextId: 1,
    nameCounts: {},
    selectedId: null,
    pxPerMm: null,
    calSource: 'none',
    calibrating: null,
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
