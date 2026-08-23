// SPDX-License-Identifier: AGPL-3.0-only
// The flat store holds the truth; these effects repeat it to the 2D viewport,
// one layer per effect so a draft pick redraws the draft and not the sheet.
// What each layer draws is computed by app/flatSheet — this hook only
// decides when to push. The 3D twin is useSceneSync.

import { useEffect, type MutableRefObject } from 'react'
import type { EdgeChains } from '../core/flat/edges'
import type { Vec2 } from '../core/flat/types'
import { useFlat } from '../state/flatStore'
import type { FlatScene } from '../viewer/FlatScene'
import {
  sheetCalibrationPicks,
  sheetCounts,
  sheetDatumPreview,
  sheetDimensions,
  sheetDraft,
  sheetElements,
  sheetGrid,
  sheetNotes,
  sheetScale,
} from './flatSheet'

export function useFlatSceneSync({
  sceneRef,
  bitmapRef,
  edgesRef,
}: {
  sceneRef: MutableRefObject<FlatScene | null>
  /** The decoded scan image — out of the store like every big buffer. */
  bitmapRef: MutableRefObject<ImageBitmap | null>
  /** The detected edge chains, landing whenever `edgeVersion` bumps. */
  edgesRef: MutableRefObject<EdgeChains | null>
}) {
  const scene = () => sceneRef.current

  const pushCalibration = () => scene()?.setCalibrationPicks(sheetCalibrationPicks(useFlat.getState()))
  const pushEdges = () => {
    const s = useFlat.getState()
    scene()?.setEdgeChains(s.showEdges ? edgesRef.current : null)
  }
  const pushNotes = () => scene()?.setNotes(sheetNotes(useFlat.getState()))
  const pushCounts = () => scene()?.setCounts(sheetCounts(useFlat.getState()))
  const pushDimensions = () => scene()?.setFlatDimensions(sheetDimensions(useFlat.getState()))
  const pushGrid = () => {
    const grid = sheetGrid(useFlat.getState())
    if (grid !== undefined) scene()?.setGrid(grid)
  }
  const pushElements = () => {
    const s = useFlat.getState()
    const view = scene()
    if (!view) return
    view.setFlatElements(sheetElements(s))
    const draft = sheetDraft(s)
    view.setDraftMarks(draft.pins, draft.fit, draft.cloud, draft.color)
    view.setRegionMode(draft.regionMode)
  }

  /** Put the decoded image on the sheet and every layer over it — once both
   *  it and the viewport exist, in whichever order they got there: the image
   *  may be dropped before the workspace has ever been opened, and the
   *  viewport unmounts with it. */
  const pushAll = () => {
    const bitmap = bitmapRef.current
    const view = scene()
    if (!bitmap || !view) return
    void view.setImage(bitmap, sheetScale(useFlat.getState()))
    pushCalibration()
    pushEdges()
    pushElements()
    pushDimensions()
    pushCounts()
    pushNotes()
    pushGrid()
  }

  const imageVersion = useFlat((s) => s.imageVersion)
  useEffect(pushAll, [imageVersion])

  // A new calibration re-lays the sheet in its millimetres and moves
  // whatever is pinned on it along.
  const scale = useFlat((s) => s.pxPerMm)
  useEffect(() => {
    scene()?.setScale(sheetScale(useFlat.getState()))
    pushCalibration()
  }, [scale])

  const tool = useFlat((s) => s.tool)
  useEffect(pushCalibration, [tool])

  const edgeVersion = useFlat((s) => s.edgeVersion)
  const showEdges = useFlat((s) => s.showEdges)
  useEffect(pushEdges, [edgeVersion, showEdges])

  const notes = useFlat((s) => s.notes)
  useEffect(pushNotes, [notes, tool, scale])

  const counts = useFlat((s) => s.counts)
  useEffect(pushCounts, [counts, tool, scale])

  const dimensions = useFlat((s) => s.dimensions)
  const elements = useFlat((s) => s.elements)
  useEffect(pushDimensions, [dimensions, elements])

  const datum = useFlat((s) => s.datum)
  const showGrid = useFlat((s) => s.showGrid)
  useEffect(pushGrid, [datum, tool, showGrid, scale])

  const draft = useFlat((s) => s.draft)
  useEffect(pushElements, [elements, draft, scale, datum])

  return {
    /** The viewport has mounted — take it and lay the sheet out on it — or
     *  unmounted with its workspace (null). */
    onReady: (view: FlatScene | null) => {
      sceneRef.current = view
      if (view) pushAll()
    },
    /** The cursor over the sheet — the datum tool's live grid preview. */
    onHover: (cursor: Vec2 | null) => {
      const grid = sheetDatumPreview(useFlat.getState(), cursor)
      if (grid) scene()?.setGrid(grid)
    },
  }
}
