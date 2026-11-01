// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIANGLE_LIMIT,
  reduceSettingsOf,
  reductionStale,
  scanEditFigure,
  scanEditText,
  shellModeOf,
  trimStale,
  useMeshTools,
} from '../state/meshStore'
import type { ReduceReport } from '../core/reduce'
import { cutPlaneOf } from '../core/cutPlane'

function report(settings: ReduceReport['settings']): ReduceReport {
  return {
    settings,
    inputTriangles: 1000,
    triangles: 100,
    vertices: 52,
    measured: 500,
    within: 500,
    p999: 0.01,
    max: 0.02,
    rms: 0.005,
    backP999: 0.01,
    backMax: 0.02,
    held: true,
    capped: false,
    passes: 1,
    pinned: 0,
  }
}

beforeEach(() => {
  useMeshTools.getState().clear()
  useMeshTools.setState({
    tool: 'reduce',
    tolerance: 0.05,
    toleranceAuto: true,
    maxTriangles: DEFAULT_TRIANGLE_LIMIT,
    pieceSize: 2,
    pieceSizeAuto: true,
    view: 'reduced',
  })
})

describe('the Mesh Tools settings', () => {
  it('size themselves to a part until the user sets them', () => {
    useMeshTools.getState().suggestForPart(231.7)
    expect(useMeshTools.getState().tolerance).toBe(0.1)
    expect(useMeshTools.getState().pieceSize).toBe(5)
    useMeshTools.getState().setTolerance(0.02)
    useMeshTools.getState().suggestForPart(1000)
    expect(useMeshTools.getState().tolerance).toBe(0.02)
    expect(useMeshTools.getState().pieceSize).toBe(10)
    useMeshTools.getState().setPieceSize(3)
    useMeshTools.getState().suggestForPart(50)
    expect(useMeshTools.getState().pieceSize).toBe(3)
  })

  it('start the triangle limit at 50,000, and take a whole number of at least four', () => {
    expect(useMeshTools.getInitialState().maxTriangles).toBe(50_000)
    const m = useMeshTools.getState()
    m.setMaxTriangles(12_345.6)
    expect(useMeshTools.getState().maxTriangles).toBe(12_346)
    m.setMaxTriangles(1)
    expect(useMeshTools.getState().maxTriangles).toBe(4)
    expect(reduceSettingsOf(useMeshTools.getState())).toEqual({ tolerance: 0.05, maxTriangles: 4 })
  })

  it('say when the result on hand was made with other settings than the panel shows', () => {
    const m = useMeshTools.getState()
    expect(reductionStale(useMeshTools.getState())).toBe(false)
    m.resolve(report(reduceSettingsOf(useMeshTools.getState())))
    expect(reductionStale(useMeshTools.getState())).toBe(false)
    m.setTolerance(0.1)
    expect(reductionStale(useMeshTools.getState())).toBe(true)
    m.setTolerance(0.05)
    expect(reductionStale(useMeshTools.getState())).toBe(false)
    m.setMaxTriangles(10_000)
    expect(reductionStale(useMeshTools.getState())).toBe(true)
  })

  it('keep the result it had when a reduction fails, and let it go with its scan', () => {
    const m = useMeshTools.getState()
    m.resolve(report(reduceSettingsOf(useMeshTools.getState())))
    m.begin()
    m.fail('out of memory')
    expect(useMeshTools.getState()).toMatchObject({ status: 'ready', message: 'out of memory' })
    expect(useMeshTools.getState().report).not.toBeNull()
    const version = useMeshTools.getState().resultVersion
    m.dropResult()
    expect(useMeshTools.getState()).toMatchObject({ status: 'idle', report: null, resultVersion: version + 1 })
    m.begin()
    m.fail('out of memory')
    expect(useMeshTools.getState().status).toBe('idle')
  })

  it('list the edits made to the scan, until another scan comes in — the tool in hand stays', () => {
    const m = useMeshTools.getState()
    m.setTool('islands')
    m.addEdit({ kind: 'pieces', minSize: 2, pieces: 3, triangles: 40 })
    m.addEdit({ kind: 'pieces', minSize: 5, pieces: 1, triangles: 12 })
    expect(useMeshTools.getState().edits.map((e) => (e.kind === 'pieces' ? e.minSize : null))).toEqual([2, 5])
    m.setSurvey({ pieces: 4, islands: 1, islandTriangles: 12, largestIsland: 1, smallestKept: 50, minSize: 2 })
    m.clear()
    expect(useMeshTools.getState()).toMatchObject({ edits: [], survey: null, tool: 'islands' })
  })

  it('asks before the islands go, and takes the question back when what is marked changes', () => {
    const m = useMeshTools.getState()
    const survey = { pieces: 4, islands: 1, islandTriangles: 12, largestIsland: 1, smallestKept: 50, minSize: 2 }
    m.setTool('islands')
    m.setSurvey(survey)
    m.setConfirming(true)
    expect(useMeshTools.getState().confirming).toBe(true)
    // Another size marks other islands; the yes was not for them.
    m.setPieceSize(3)
    expect(useMeshTools.getState().confirming).toBe(false)
    m.setConfirming(true)
    // Nor for a new count — another scan, another alignment.
    m.setSurvey(null)
    expect(useMeshTools.getState().confirming).toBe(false)
    m.setSurvey(survey)
    m.setConfirming(true)
    m.setTool('reduce')
    expect(useMeshTools.getState().confirming).toBe(false)
    m.setTool('islands')
    m.setConfirming(true)
    m.clear()
    expect(useMeshTools.getState().confirming).toBe(false)
  })

  it('opens the Boolean with nothing in hand — the last one used its solids up', () => {
    const m = useMeshTools.getState()
    m.setTool('boolean')
    m.toggleBoolSolid('body:1')
    m.toggleBoolSolid('element:7')
    expect(useMeshTools.getState().boolSolids).toEqual(['body:1', 'element:7'])
    // Choosing the operation keeps the hand; putting the tool away and
    // taking it up again empties it.
    m.setTool('boolean')
    expect(useMeshTools.getState().boolSolids).toEqual(['body:1', 'element:7'])
    m.setTool(null)
    m.setTool('boolean')
    expect(useMeshTools.getState().boolSolids).toEqual([])
    m.setBoolSolids(['body:1', 'element:7'])
    expect(useMeshTools.getState().boolSolids).toEqual(['body:1', 'element:7'])
  })

  it('holds one body for Trim to scan, keeps the offset at zero or more, and says when the piece is stale', () => {
    const m = useMeshTools.getState()
    m.setTool('trim')
    m.toggleTrimSolid('body:1')
    m.toggleTrimSolid('body:2')
    expect(useMeshTools.getState().trimSolid).toBe('body:2')
    m.toggleTrimSolid('body:2')
    expect(useMeshTools.getState().trimSolid).toBeNull()
    // The tool keeps its body when it is put away and taken up again.
    m.setTrimSolid('body:1')
    m.setTool(null)
    m.setTool('trim')
    expect(useMeshTools.getState().trimSolid).toBe('body:1')
    expect(useMeshTools.getState()).toMatchObject({ trimOffset: 0, trimDepth: 0.3, trimFlip: false })
    m.setTrimOffset(-0.2)
    expect(useMeshTools.getState().trimOffset).toBe(0)
    m.setTrimOffset(0.15)
    m.setTrimDepth(0)
    expect(useMeshTools.getState().trimDepth).toBeGreaterThan(0)
    m.setTrimDepth(0.3)

    // A piece lands and is shown; a failure after leaves it standing.
    const made = { report: { offset: 0.15 } as never, solid: 'body:1', name: 'Solid 1', depth: 0.3, flip: false, gapRange: 0.02 }
    m.trimBegin()
    m.trimResolve(made)
    expect(useMeshTools.getState()).toMatchObject({ trimStatus: 'ready', trimView: 'piece' })
    expect(trimStale(useMeshTools.getState())).toBe(false)
    for (const change of [() => m.setTrimOffset(0.2), () => m.setTrimDepth(0.5), () => m.setTrimFlip(true), () => m.setTrimSolid('body:2')]) {
      change()
      expect(trimStale(useMeshTools.getState())).toBe(true)
      useMeshTools.setState({ trimOffset: 0.15, trimDepth: 0.3, trimFlip: false, trimSolid: 'body:1' })
    }
    m.trimBegin()
    m.trimFail('No break')
    expect(useMeshTools.getState()).toMatchObject({ trimStatus: 'ready', trimMessage: 'No break', trimMade: made })
    // It goes with the mesh it was cut to, and with the scan.
    m.dropTrim()
    expect(useMeshTools.getState()).toMatchObject({ trimStatus: 'idle', trimMade: null, trimView: 'break' })
    m.trimResolve(made)
    m.clear()
    expect(useMeshTools.getState()).toMatchObject({ trimMade: null, trimBreak: null, trimView: 'break' })
  })

  it('shows the scan or the reduced mesh in the parts list, one at a time, and a fresh piece', () => {
    const m = useMeshTools.getState()
    expect(useMeshTools.getState()).toMatchObject({ shownScan: true, shownReduced: false, shownPiece: true, shownBodies: [] })
    m.resolve(report({ tolerance: 0.05, maxTriangles: DEFAULT_TRIANGLE_LIMIT }))
    m.setPartShown('reduced', true)
    expect(useMeshTools.getState()).toMatchObject({ shownScan: false, shownReduced: true })
    m.setPartShown('scan', true)
    expect(useMeshTools.getState()).toMatchObject({ shownScan: true, shownReduced: false })
    // Both may be hidden; and with the reduced mesh gone, the scan it stood
    // in for comes back.
    m.setPartShown('scan', false)
    expect(useMeshTools.getState()).toMatchObject({ shownScan: false, shownReduced: false })
    m.setPartShown('reduced', true)
    m.dropResult()
    expect(useMeshTools.getState()).toMatchObject({ shownScan: true, shownReduced: false })

    // A piece hidden in the list is shown again when another lands.
    m.setPartShown('piece', false)
    m.trimResolve({ report: { offset: 0 } as never, solid: 'body:1', name: 'Solid 1', depth: 0.3, flip: false, gapRange: 0.02 })
    expect(useMeshTools.getState().shownPiece).toBe(true)

    m.toggleBodyShown('body:1')
    m.toggleBodyShown('body:2')
    m.toggleBodyShown('body:1')
    expect(useMeshTools.getState().shownBodies).toEqual(['body:2'])
    m.clear()
    expect(useMeshTools.getState()).toMatchObject({ shownScan: true, shownReduced: false, shownPiece: true, shownBodies: [] })
  })

  it('sizes the edit tools to the part until they are set by hand', () => {
    const m = useMeshTools.getState()
    useMeshTools.setState({ holeSizeAuto: true, smoothSizeAuto: true, smoothLimitAuto: true, shellThicknessAuto: true })
    m.suggestForPart(170)
    expect(useMeshTools.getState()).toMatchObject({ holeSize: 10, smoothSize: 2, smoothLimit: 0.2, shellThickness: 2 })
    m.setHoleSize(3)
    m.setSmoothSize(0.5)
    m.setSmoothLimit(0.01)
    m.setShellThickness(1.2)
    m.suggestForPart(1000)
    expect(useMeshTools.getState()).toMatchObject({
      holeSize: 3,
      holeSizeAuto: false,
      smoothSize: 0.5,
      smoothSizeAuto: false,
      smoothLimit: 0.01,
      smoothLimitAuto: false,
      shellThickness: 1.2,
      shellThicknessAuto: false,
    })
    m.setSmoothSize(0)
    expect(useMeshTools.getState().smoothSize).toBeGreaterThan(0)
  })

  it('puts a cut back through the middle for another plane, and forgets an element of the last scan', () => {
    const m = useMeshTools.getState()
    m.setCutOffset(1.5)
    expect(useMeshTools.getState()).toMatchObject({ cutOffset: 1.5, cutOffsetAuto: false })
    m.setCutRef(7)
    expect(useMeshTools.getState()).toMatchObject({ cutRef: 7, cutOffsetAuto: true })
    m.setCutOffset(-3)
    m.clear()
    expect(useMeshTools.getState()).toMatchObject({ cutRef: 'z', cutOffsetAuto: true })
    m.setCutRef('x')
    m.clear()
    expect(useMeshTools.getState().cutRef).toBe('x')
  })

  it('writes each kind of edit as a line of the list', () => {
    expect(scanEditText({ kind: 'delete', triangles: 5 })).toBe('Deleted marked surface')
    expect(scanEditFigure({ kind: 'delete', triangles: 1200 })).toBe('−1,200 △')
    expect(scanEditText({ kind: 'flip', triangles: 5_000_403 })).toBe('Flipped the normals')
    expect(scanEditFigure({ kind: 'flip', triangles: 5_000_403 })).toBe('⇅ 5,000,403 △')
    expect(scanEditText({ kind: 'flip', triangles: 32, region: 25 })).toBe('Flipped the normals of a marked region')
    expect(scanEditText({ kind: 'cut', plane: 'XY plane, Z 0.5 mm', removed: 10, capped: 1, open: 0 })).toBe(
      'Cut at XY plane, Z 0.5 mm, closed flat',
    )
    // An offset String() writes in exponent form is named again whole.
    expect(scanEditText({ kind: 'cut', plane: 'XY plane, Z 1e-7 mm', removed: 1, capped: 0, open: 0 }, 'in')).toBe('Cut at XY plane, Z 0 in')
    expect(scanEditText({ kind: 'cut', plane: 'XY plane, Z 2.54e+1 mm', removed: 1, capped: 0, open: 0 }, 'in')).toBe('Cut at XY plane, Z 1 in')
    expect(scanEditText({ kind: 'fill', maxSize: 5, mode: 'curved', holes: 1, triangles: 40 })).toBe('Filled 1 hole under 5 mm')
    expect(scanEditFigure({ kind: 'fill', maxSize: 5, mode: 'flat', holes: 3, triangles: 40 })).toBe('+40 △')
    expect(scanEditText({ kind: 'smooth', size: 1, limit: 0.2, maxMove: 0.031 })).toBe('Smoothed bumps under 1 mm, within 0.2 mm')
    expect(scanEditFigure({ kind: 'smooth', size: 1, limit: 0.2, maxMove: 0.031 })).toBe('≤ 0.031 mm')
    expect(scanEditText({ kind: 'smooth', size: 2, limit: 0.5, maxMove: 0.1, region: 900 })).toBe(
      'Smoothed bumps under 2 mm in a marked region, within 0.5 mm',
    )
    const bore = { kind: 'boolean' as const, op: 'subtract' as const, solid: 'Solid 2', removed: 40, added: 260, volume: -42.41 }
    expect(scanEditText(bore)).toBe('Took Solid 2 out')
    expect(scanEditFigure(bore)).toBe('−42.4 mm³')
    expect(scanEditText({ ...bore, op: 'add', volume: 3 })).toBe('Added Solid 2')
    expect(scanEditFigure({ ...bore, op: 'add', volume: 3 })).toBe('+3.0 mm³')
    expect(scanEditText({ ...bore, op: 'intersect' })).toBe('Kept what Solid 2 shares')
    expect(scanEditText({ kind: 'offset', distance: 0.1, maxMove: 0.17 })).toBe('Expanded by 0.1 mm')
    expect(scanEditFigure({ kind: 'offset', distance: 0.1, maxMove: 0.17 })).toBe('+0.100 mm')
    expect(scanEditText({ kind: 'offset', distance: -0.25, maxMove: 0.3, region: 400 })).toBe('Shrank a marked region by 0.25 mm')
    expect(scanEditFigure({ kind: 'offset', distance: -0.25, maxMove: 0.3, region: 400 })).toBe('−0.250 mm')
    const hollow = { kind: 'shell' as const, mode: 'hollow' as const, thickness: 2, triangles: 1800, cavities: 1, volume: 2118.44 }
    expect(scanEditText(hollow)).toBe('Hollowed with a 2 mm wall')
    expect(scanEditFigure(hollow)).toBe('−2118.4 mm³')
    const thick = { kind: 'shell' as const, mode: 'thicken' as const, thickness: 1.5, side: 'both' as const, triangles: 4000 }
    expect(scanEditText(thick)).toBe('Thickened 1.5 mm to both sides')
    expect(scanEditText({ ...thick, side: 'in' })).toBe('Thickened 1.5 mm inward')
    expect(scanEditText({ ...thick, side: 'out' })).toBe('Thickened 1.5 mm outward')
    expect(scanEditFigure(thick)).toBe('+4,000 △')
  })

  it('reads off the mesh what Shell will do with it', () => {
    expect(shellModeOf({ open: 0, rims: 0, holes: 0 })).toBe('hollow')
    // Closed but for holes Fill holes would fill: fill them first.
    expect(shellModeOf({ open: 40, rims: 2, holes: 2 })).toBe('holes')
    // An opening larger than that: a surface to thicken.
    expect(shellModeOf({ open: 400, rims: 3, holes: 2 })).toBe('thicken')
    expect(shellModeOf({ open: 400, rims: 1, holes: 0 })).toBe('thicken')
  })

  it('keeps the distance to shrink or expand by positive, the direction saying which way', () => {
    const m = useMeshTools.getState()
    m.setOffsetDistance(-0.3)
    expect(useMeshTools.getState().offsetDistance).toBe(0.3)
    m.setOffsetDistance(0)
    expect(useMeshTools.getState().offsetDistance).toBe(1e-4)
    m.setOffsetDistance(0.1)
  })
})

describe('the cut plane', () => {
  const plane = { id: 3, name: 'Plane 1', fit: { kind: 'plane', center: [0, 0, 2], normal: [0, 0, 1], basisU: [1, 0, 0] } as never }

  it('lies across a coordinate axis at its coordinate, through the middle until one is typed', () => {
    const middle = cutPlaneOf('z', 0, true, 'plus', [], [4, 5, 6])!
    expect(middle.offset).toBe(6)
    expect(middle.frame.origin[2]).toBeCloseTo(6)
    // Keeping the + side takes away the − side: the normal points there.
    expect(middle.frame.normal).toEqual([-0, -0, -1])
    expect(middle.label).toBe('XY plane, Z 6 mm')
    const typed = cutPlaneOf('x', 0.5, false, 'minus', [], [4, 5, 6])!
    expect(typed.frame.origin[0]).toBeCloseTo(0.5)
    expect(typed.frame.normal).toEqual([1, 0, 0])
    expect(typed.label).toBe('YZ plane, X 0.5 mm')
  })

  it('lies across an element along its direction, and there is none for an element that has gone', () => {
    const on = cutPlaneOf(3, -1, false, 'plus', [plane], [0, 0, 0])!
    expect(on.frame.origin).toEqual([0, 0, 1])
    expect(on.label).toBe('Plane 1 −1 mm')
    expect(cutPlaneOf(3, 0, false, 'plus', [plane], [0, 0, 0])!.label).toBe('Plane 1')
    expect(cutPlaneOf(9, 0, false, 'plus', [plane], [0, 0, 0])).toBeNull()
  })

  it('keeps the edits made on the copy apart until the copy is taken into use', () => {
    const m = useMeshTools.getState()
    m.addEdit({ kind: 'delete', triangles: 3 })
    m.setCopy(1200)
    m.addPending({ kind: 'smooth', size: 2, limit: 0.5, maxMove: 0.1 })
    m.addPending({ kind: 'delete', triangles: 9 })
    expect(useMeshTools.getState()).toMatchObject({ copyTriangles: 1200, edits: [{ kind: 'delete', triangles: 3 }] })
    expect(useMeshTools.getState().pending).toHaveLength(2)
    const version = useMeshTools.getState().copyVersion
    m.takePending()
    expect(useMeshTools.getState().edits).toHaveLength(3)
    expect(useMeshTools.getState().pending).toHaveLength(0)
    m.addPending({ kind: 'delete', triangles: 1 })
    m.clearPending()
    m.setCopy(null)
    expect(useMeshTools.getState()).toMatchObject({ pending: [], copyTriangles: null, copyDeviationStats: null })
    expect(useMeshTools.getState().copyVersion).toBe(version + 1)
    // A new scan has no copy of the last one.
    m.setCopy(10)
    m.addPending({ kind: 'delete', triangles: 1 })
    m.clear()
    expect(useMeshTools.getState()).toMatchObject({ pending: [], copyTriangles: null })
  })
})
