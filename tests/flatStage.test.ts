// SPDX-License-Identifier: AGPL-3.0-only
// The 2D stage tool: one tool in hand at a time, a click routed to it by the
// store, snapping decided per tool — the seam between FlatScene and useFlat.
import { beforeEach, describe, expect, it } from 'vitest'
import { EdgeIndex, snapPick, snapRadiusPx, thinEdgePoints } from '../src/core/flat/snap'
import { toolOf, useFlat } from '../src/state/flatStore'

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
    counts: [],
    nextCountId: 1,
    notes: [],
    nextNoteId: 1,
    datum: null,
    snapToEdge: true,
  })
  // 10 px/mm: a click at 50 mm lands on pixel 500.
  useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
}

/** One horizontal edge along y = 400 px, x from 100 to 900. */
function edges(): EdgeIndex {
  const pts: number[] = []
  for (let x = 100; x <= 900; x++) pts.push(x, 400)
  return new EdgeIndex({ points: new Float32Array(pts), offsets: new Uint32Array([0, pts.length / 2]) })
}

const meta = { alt: false, unitsPerScreenPx: 0.1 }
const altMeta = { alt: true, unitsPerScreenPx: 0.1 }

describe('one stage tool at a time', () => {
  beforeEach(reset)

  it('arming a tool puts the previous one away', () => {
    const s = useFlat.getState()
    s.startCalibration('distance')
    expect(useFlat.getState().tool.kind).toBe('calibrate')
    useFlat.getState().startCount()
    expect(useFlat.getState().tool.kind).toBe('count')
    useFlat.getState().startDatum()
    expect(useFlat.getState().tool.kind).toBe('datum')
    useFlat.getState().startNote()
    expect(useFlat.getState().tool.kind).toBe('note')
    useFlat.getState().startCalibration('diameter')
    expect(toolOf(useFlat.getState(), 'calibrate')?.mode).toBe('diameter')
  })

  it('cancelling a tool that is no longer in hand changes nothing', () => {
    useFlat.getState().startCount()
    useFlat.getState().cancelCalibration()
    expect(useFlat.getState().tool.kind).toBe('count')
    useFlat.getState().cancelCount()
    expect(useFlat.getState().tool.kind).toBe('none')
  })

  it('editing a note while a tally is open closes the tally', () => {
    useFlat.getState().startNote()
    useFlat.getState().stageClick([10, 10], meta, null)
    useFlat.getState().finishNote() // blank — dropped
    expect(useFlat.getState().notes).toHaveLength(0)
    useFlat.getState().startNote()
    useFlat.getState().stageClick([10, 10], meta, null)
    useFlat.getState().setNoteText(2, 'hi')
    useFlat.getState().finishNote()
    useFlat.getState().startCount()
    useFlat.getState().editNote(2)
    expect(useFlat.getState().tool).toEqual({ kind: 'note', editId: 2 })
  })
})

describe('a click on the sheet', () => {
  beforeEach(reset)

  it('goes to the calibration tool and snaps to the edge', () => {
    useFlat.getState().startCalibration('distance')
    useFlat.getState().stageClick([50, 40.3], meta, edges())
    expect(toolOf(useFlat.getState(), 'calibrate')?.picks).toEqual([[500, 400]])
  })

  it('with Alt held lands where the hand put it', () => {
    useFlat.getState().startCalibration('distance')
    useFlat.getState().stageClick([50, 40.3], altMeta, edges())
    const [px] = toolOf(useFlat.getState(), 'calibrate')!.picks
    expect(px[0]).toBeCloseTo(500)
    expect(px[1]).toBeCloseTo(403)
  })

  it('places a note exactly where it landed, never on an edge', () => {
    useFlat.getState().startNote()
    useFlat.getState().stageClick([50, 40.3], meta, edges())
    const s = useFlat.getState()
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0].at[1]).toBeCloseTo(403)
    expect(s.tool).toEqual({ kind: 'note', editId: 1 })
  })

  it('counts and element picks follow the snap setting, Alt inverting it', () => {
    useFlat.getState().setSnapToEdge(false)
    useFlat.getState().startCount()
    useFlat.getState().stageClick([50, 40.3], meta, edges())
    expect(toolOf(useFlat.getState(), 'count')!.picks[0][1]).toBeCloseTo(403)
    useFlat.getState().stageClick([60, 40.3], altMeta, edges())
    expect(toolOf(useFlat.getState(), 'count')!.picks[1]).toEqual([600, 400])
    useFlat.getState().cancelCount()

    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().stageClick([50, 40.3], meta, edges())
    expect(useFlat.getState().draft!.picks[0][1]).toBeCloseTo(403)
    useFlat.getState().stageClick([50, 40.3], altMeta, edges())
    expect(useFlat.getState().draft!.picks[0]).toEqual([500, 400])
  })

  it('with the datum tool commits the frame on the second pick', () => {
    useFlat.getState().startDatum()
    useFlat.getState().stageClick([10, 10], altMeta, null)
    expect(useFlat.getState().tool.kind).toBe('datum')
    useFlat.getState().stageClick([20, 10], altMeta, null)
    expect(useFlat.getState().tool.kind).toBe('none')
    expect(useFlat.getState().datum).toEqual({ originPx: [100, 100], xRefPx: [200, 100] })
  })

  it('with no tool out and no draft does nothing', () => {
    useFlat.getState().stageClick([10, 10], meta, edges())
    expect(useFlat.getState()).toMatchObject({ tool: { kind: 'none' }, draft: null, notes: [] })
  })

  it('drags a draft pin with the same snapping', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().stageClick([10, 10], altMeta, edges())
    useFlat.getState().stageDrag(0, [50, 40.3], meta, edges())
    expect(useFlat.getState().draft!.picks[0]).toEqual([500, 400])
  })

  it('collects a dragged region of edge points for an edge draft', () => {
    useFlat.getState().startDraft('line', 'flat-line-edge')
    useFlat.getState().stageRegion([20, 30], [30, 50], edges())
    expect(useFlat.getState().draft!.picks.length).toBe(101)
  })
})

describe('confirm and retreat', () => {
  beforeEach(reset)

  it('a confirm goes nowhere while the calibration tool is out', () => {
    useFlat.getState().startCalibration('distance')
    expect(useFlat.getState().confirmable()).toBeNull()
  })

  it('a tally confirms once it has a pick', () => {
    useFlat.getState().startCount()
    expect(useFlat.getState().confirmable()).toBeNull()
    useFlat.getState().stageClick([10, 10], altMeta, null)
    useFlat.getState().confirmable()!()
    expect(useFlat.getState().counts).toHaveLength(1)
    expect(useFlat.getState().tool.kind).toBe('none')
  })

  it('retreats outermost first: the stage tool, then the draft, then the dimension', () => {
    useFlat.getState().startDimDraft()
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().startCalibration('distance')
    expect(useFlat.getState().retreat()).toBe(true)
    expect(useFlat.getState().tool.kind).toBe('none')
    expect(useFlat.getState().draft).not.toBeNull()
    expect(useFlat.getState().retreat()).toBe(true)
    expect(useFlat.getState().draft).toBeNull()
    expect(useFlat.getState().dimDraft).not.toBeNull()
    expect(useFlat.getState().retreat()).toBe(true)
    expect(useFlat.getState().dimDraft).toBeNull()
    expect(useFlat.getState().retreat()).toBe(false)
  })

  it('retreating from an open note keeps its text', () => {
    useFlat.getState().startNote()
    useFlat.getState().stageClick([10, 10], altMeta, null)
    useFlat.getState().setNoteText(1, 'keep')
    useFlat.getState().retreat()
    expect(useFlat.getState().notes[0].text).toBe('keep')
    expect(useFlat.getState().tool.kind).toBe('none')
  })
})

describe('the snap policy', () => {
  it('scales the radius with the zoom and the image resolution', () => {
    // 10 screen px, at 0.05 mm per screen px, at 20 px/mm → 10 image px.
    expect(snapRadiusPx({ unitsPerScreenPx: 0.05 }, 20)).toBeCloseTo(10)
  })

  it('treats Alt as the inverse of the setting', () => {
    const index = edges()
    expect(snapPick([500, 403], index, 10, true, false)).toEqual([500, 400])
    expect(snapPick([500, 403], index, 10, true, true)).toEqual([500, 403])
    expect(snapPick([500, 403], index, 10, false, false)).toEqual([500, 403])
    expect(snapPick([500, 403], index, 10, false, true)).toEqual([500, 400])
    expect(snapPick([500, 403], null, 10, true, false)).toEqual([500, 403])
  })

  it('thins a long edge to the cap, keeping a short one whole', () => {
    const pts = Array.from({ length: 10000 }, (_, i) => [i, 0] as [number, number])
    expect(thinEdgePoints(pts).length).toBeLessThanOrEqual(4000)
    expect(thinEdgePoints(pts.slice(0, 10))).toHaveLength(10)
  })
})
