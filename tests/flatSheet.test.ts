// SPDX-License-Identifier: AGPL-3.0-only
// What the 2D viewport is told to draw, read straight off the flat store —
// the px→document conversion and the per-layer rules, with no scene.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  sheetAlignment,
  sheetCalibrationPicks,
  sheetCounts,
  sheetDatumPreview,
  sheetRollOf,
  sheetDraft,
  sheetElements,
  sheetGrid,
  sheetLoupeActive,
  sheetNotes,
  sheetScale,
} from '../src/app/flatSheet'
import { useFlat } from '../src/state/flatStore'

const alt = { alt: true, unitsPerScreenPx: 0.1 }

function reset(pxPerMm: { x: number; y: number } | null = { x: 10, y: 10 }) {
  useFlat.setState({
    elements: [],
    draft: null,
    nextId: 1,
    nameCounts: {},
    dimensions: [],
    dimDraft: null,
    pxPerMm: null,
    calSource: 'none',
    tool: { kind: 'none' },
    counts: [],
    nextCountId: 1,
    notes: [],
    nextNoteId: 1,
    datum: null,
    showGrid: true,
    turns: 0,
  })
  useFlat.getState().finishImageLoad('t.png', 1000, 800, pxPerMm)
}

describe('the sheet scale', () => {
  it('is document units per pixel, 1:1 without a calibration', () => {
    reset({ x: 10, y: 20 })
    expect(sheetScale(useFlat.getState())).toEqual({ x: 0.1, y: 0.05 })
    reset(null)
    expect(sheetScale(useFlat.getState())).toEqual({ x: 1, y: 1 })
  })
})

describe('the layers', () => {
  beforeEach(() => reset())

  it('put the calibration picks on the sheet in millimetres', () => {
    useFlat.getState().startCalibration('distance')
    useFlat.getState().stageClick([12, 34], alt, null)
    expect(sheetCalibrationPicks(useFlat.getState())).toEqual([[12, 34]])
    useFlat.getState().cancelCalibration()
    expect(sheetCalibrationPicks(useFlat.getState())).toEqual([])
  })

  it('keep a hidden note off the sheet unless it is open for typing', () => {
    useFlat.getState().startNote()
    useFlat.getState().stageClick([5, 6], alt, null)
    useFlat.getState().setNoteText(1, 'a')
    expect(sheetNotes(useFlat.getState())).toEqual([{ id: 1, text: 'a', at: [5, 6], editing: true }])
    useFlat.getState().finishNote()
    useFlat.getState().toggleNoteVisible(1)
    expect(sheetNotes(useFlat.getState())).toEqual([])
    useFlat.getState().editNote(1)
    expect(sheetNotes(useFlat.getState())[0].editing).toBe(true)
  })

  it('draw a re-opened tally by the live tool only, in its own colour', () => {
    useFlat.getState().startCount()
    useFlat.getState().stageClick([1, 1], alt, null)
    useFlat.getState().finishCount()
    const saved = useFlat.getState().counts[0]
    expect(sheetCounts(useFlat.getState())).toEqual([{ picks: [[1, 1]], color: saved.color, name: saved.name }])
    useFlat.getState().editCount(saved.id)
    useFlat.getState().stageClick([2, 2], alt, null)
    const drawn = sheetCounts(useFlat.getState())
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toEqual({ picks: [[1, 1], [2, 2]], color: saved.color })
  })

  it('leave the grid to the datum tool while it is collecting', () => {
    expect(sheetGrid(useFlat.getState())).toBeNull()
    useFlat.getState().startDatum()
    expect(sheetGrid(useFlat.getState())).toBeUndefined()
    useFlat.getState().stageClick([10, 10], alt, null)
    expect(sheetDatumPreview(useFlat.getState(), [20, 10])).toEqual({ origin: [10, 10], xDir: [1, 0] })
    expect(sheetDatumPreview(useFlat.getState(), [10, 10])).toBeNull()
    useFlat.getState().stageClick([20, 10], alt, null)
    expect(sheetGrid(useFlat.getState())).toEqual({ origin: [10, 10], xDir: [1, 0] })
    useFlat.getState().setShowGrid(false)
    expect(sheetGrid(useFlat.getState())).toBeNull()
  })

  it('roll the sheet square to the alignment once it lands, the turns on top', () => {
    expect(sheetAlignment(useFlat.getState())).toBeNull()
    expect(sheetRollOf(useFlat.getState())).toBe(0)
    useFlat.getState().startDatum()
    useFlat.getState().stageClick([10, 10], alt, null)
    // Still collecting: the stage does not roll under a half-placed pick.
    expect(sheetAlignment(useFlat.getState())).toBeNull()
    // +X picked straight up the sheet: the frame's X is document +Y, and the
    // sheet is shown a quarter turn clockwise so that it runs to the right.
    useFlat.getState().stageClick([10, 20], alt, null)
    const xDir = sheetAlignment(useFlat.getState())!
    expect(xDir[0]).toBeCloseTo(0, 12)
    expect(xDir[1]).toBeCloseTo(1, 12)
    expect(sheetRollOf(useFlat.getState())).toBeCloseTo(-Math.PI / 2, 12)
    useFlat.getState().turnSheet(1)
    expect(sheetRollOf(useFlat.getState())).toBeCloseTo(0, 12)
    useFlat.getState().clearDatum()
    expect(sheetAlignment(useFlat.getState())).toBeNull()
    expect(sheetRollOf(useFlat.getState())).toBeCloseTo(Math.PI / 2, 12)
  })

  it('draw an element being edited by its draft, not its row', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().stageClick([30, 40], alt, null)
    const id = useFlat.getState().commitDraft()!
    const drawn = sheetElements(useFlat.getState())
    expect(drawn).toHaveLength(1)
    expect(drawn[0].name).toBe('Point 1')
    expect(drawn[0].value).toContain('30')
    useFlat.getState().editElement(id)
    expect(sheetElements(useFlat.getState())).toEqual([])
    const draft = sheetDraft(useFlat.getState())
    expect(draft.pins).toEqual([[30, 40]])
    expect(draft.color).toBe(drawn[0].color)
    expect(draft.regionMode).toBe(false)
  })

  it('draw a region-collected draft as a cloud, and arm region drags', () => {
    useFlat.getState().startDraft('line', 'flat-line-edge')
    useFlat.getState().addDraftPoints([[100, 100], [200, 100]])
    const draft = sheetDraft(useFlat.getState())
    expect(draft.pins).toEqual([])
    expect(draft.cloud).toEqual([[10, 10], [20, 10]])
    expect(draft.regionMode).toBe(true)
  })

  it('draw a spline draft with a handle through every pin once the curve exists', () => {
    useFlat.getState().startDraft('spline', 'flat-spline-pick')
    useFlat.getState().stageClick([10, 10], alt, null)
    expect(sheetDraft(useFlat.getState()).handles).toEqual([])
    useFlat.getState().stageClick([30, 10], alt, null)
    const draft = sheetDraft(useFlat.getState())
    expect(draft.pins).toEqual([
      [10, 10],
      [30, 10],
    ])
    expect(draft.fit?.kind).toBe('spline')
    expect(draft.handles).toHaveLength(2)
    expect(draft.handles[0].at).toEqual([10, 10])
    // Two points on a line: the curve leaves the first straight along it, a
    // third of the way to the second.
    expect(draft.handles[0].a[0]).toBeCloseTo(10 + 20 / 3, 9)
    expect(draft.handles[0].a[1]).toBeCloseTo(10, 9)
    expect(draft.handles[0].fixed).toBe(false)
    expect(draft.regionMode).toBe(false)
    // Every other draft carries none.
    useFlat.getState().cancelDraft()
    useFlat.getState().startDraft('line', 'flat-line-pick')
    useFlat.getState().stageClick([10, 10], alt, null)
    useFlat.getState().stageClick([30, 10], alt, null)
    expect(sheetDraft(useFlat.getState()).handles).toEqual([])
  })

  it('run the loupe only while picks are placed by hand', () => {
    expect(sheetLoupeActive(useFlat.getState())).toBe(false)
    useFlat.getState().startCount()
    expect(sheetLoupeActive(useFlat.getState())).toBe(true)
    useFlat.getState().startNote()
    expect(sheetLoupeActive(useFlat.getState())).toBe(false)
    useFlat.getState().cancelNote()
    useFlat.getState().startDraft('line', 'flat-line-edge')
    expect(sheetLoupeActive(useFlat.getState())).toBe(false)
    useFlat.getState().setDraftMethod('flat-line-pick')
    expect(sheetLoupeActive(useFlat.getState())).toBe(true)
  })
})
