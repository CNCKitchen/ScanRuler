// SPDX-License-Identifier: AGPL-3.0-only
// The flat store holds the truth; these effects repeat it to the 2D viewport,
// one layer per effect so a draft pick redraws the draft and not the sheet.
// What each layer draws is computed by app/flatSheet — this hook only
// decides when to push. The 3D twin is useSceneSync.

import { useEffect, useRef, type MutableRefObject } from 'react'
import type { EdgeChains } from '../core/flat/edges'
import type { Vec2 } from '../core/flat/types'
import { useFlat } from '../state/flatStore'
import { usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'
import type { FlatScene } from '../viewer/FlatScene'
import {
  sheetAlignment,
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

/** What lies on the sheet, as the viewport wants it: the decoded scan image
 *  with the edges detected on it, or a section's laid-flat cut and the bounds
 *  of a bare sheet to lay it on. Owned by App, out of the store like every
 *  big buffer, and asked for rather than passed so that whichever effect
 *  runs first sees what is there now. */
export type SheetView =
  | { kind: 'image'; bitmap: ImageBitmap; chains: EdgeChains | null }
  | { kind: 'section'; bounds: { min: Vec2; max: Vec2 }; chains: EdgeChains }

export function useFlatSceneSync({
  sceneRef,
  sheetOf,
}: {
  sceneRef: MutableRefObject<FlatScene | null>
  /** The subject on the stage, or null while there is nothing to lay out —
   *  no image decoded yet, a section still being cut. */
  sheetOf: () => SheetView | null
}) {
  const scene = () => sceneRef.current
  // The values on the stage are written in the units shown.
  const units = usePrefs((s) => s.units)

  const pushCalibration = () => scene()?.setCalibrationPicks(sheetCalibrationPicks(useFlat.getState()))
  const pushEdges = () => {
    const s = useFlat.getState()
    scene()?.setEdgeChains(s.showEdges ? (sheetOf()?.chains ?? null) : null)
  }
  const pushNotes = () => scene()?.setNotes(sheetNotes(useFlat.getState()))
  const pushCounts = () => scene()?.setCounts(sheetCounts(useFlat.getState()))
  const pushDimensions = () => scene()?.setFlatDimensions(sheetDimensions(useFlat.getState(), units))
  const pushGrid = () => {
    const grid = sheetGrid(useFlat.getState())
    if (grid !== undefined) scene()?.setGrid(grid)
  }
  const pushElements = () => {
    const s = useFlat.getState()
    const view = scene()
    if (!view) return
    view.setFlatElements(sheetElements(s, units))
    const draft = sheetDraft(s)
    view.setDraftMarks(draft.pins, draft.fit, draft.cloud, draft.color, draft.handles)
    view.setRegionMode(draft.regionMode)
  }

  /** What lays the sheet afresh, read off the stores as the effect below keys
   *  on it: a new image, a new subject, or a section's cut landing. */
  const sheetKey = () => {
    const { subject, imageVersion, subjectVersion } = useFlat.getState()
    const cut =
      subject.kind === 'section'
        ? (useStore.getState().sections.find((x) => x.id === subject.id)?.cutKey ?? null)
        : null
    return `${imageVersion}|${subjectVersion}|${cut}`
  }
  /** The viewport the sheet was last laid on, and under which key — so that
   *  a kept viewport shown again, whose sheet nothing has changed, is not laid
   *  again: that would upload the image once more and take the user's pan and
   *  zoom away. */
  const laid = useRef<{ view: FlatScene; key: string } | null>(null)

  /** Lay the subject on the sheet and every layer over it — once both it
   *  and the viewport exist, in whichever order they got there: the image
   *  may be dropped before the workspace has ever been opened, and the
   *  viewport unmounts with it. */
  const pushAll = () => {
    const sheet = sheetOf()
    const view = scene()
    if (!sheet || !view) return
    laid.current = { view, key: sheetKey() }
    // The alignment, the mirror and the turn first, so the sheet is framed
    // the way it is to be looked at rather than framed and then turned.
    view.setAlignment(sheetAlignment(useFlat.getState()))
    view.setMirror(useFlat.getState().mirror)
    view.setTurns(useFlat.getState().turns)
    if (sheet.kind === 'image') void view.setImage(sheet.bitmap, sheetScale(useFlat.getState()))
    else view.setBlankSheet(sheet.bounds.min, sheet.bounds.max)
    pushCalibration()
    pushEdges()
    pushElements()
    pushDimensions()
    pushCounts()
    pushNotes()
    pushGrid()
  }

  // A new image, a new subject, or a section's cut landing (a section from a
  // project is cut again after it is chosen) — each lays the sheet afresh.
  const imageVersion = useFlat((s) => s.imageVersion)
  const subject = useFlat((s) => s.subject)
  const subjectVersion = useFlat((s) => s.subjectVersion)
  const activeCutKey = useStore((s) =>
    subject.kind === 'section' ? (s.sections.find((x) => x.id === subject.id)?.cutKey ?? null) : null,
  )
  useEffect(pushAll, [imageVersion, subjectVersion, activeCutKey])

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
  useEffect(pushDimensions, [dimensions, elements, units])

  const datum = useFlat((s) => s.datum)
  const showGrid = useFlat((s) => s.showGrid)
  useEffect(pushGrid, [datum, tool, showGrid, scale])

  // The readings on the pins follow the alignment, and its handedness
  // follows the mirror.
  const draft = useFlat((s) => s.draft)
  const mirror = useFlat((s) => s.mirror)
  useEffect(pushElements, [elements, draft, scale, datum, mirror, units])

  // The sheet aligned to the part, mirrored, or turned on the stage — the
  // camera moves, nothing is redrawn. The alignment's direction is read at
  // the scale in force: an anisotropic calibration bends it, so a
  // recalibration re-rolls.
  useEffect(() => scene()?.setAlignment(sheetAlignment(useFlat.getState())), [datum, scale])
  useEffect(() => scene()?.setMirror(mirror), [mirror])
  const turns = useFlat((s) => s.turns)
  useEffect(() => scene()?.setTurns(turns), [turns])

  /** Lay the subject and every layer on a viewport afresh, as when it mounts. */
  const resync = (view: FlatScene) => {
    sceneRef.current = view
    pushAll()
  }
  /** A kept viewport is shown again. Every layer was pushed as its store
   *  changed, hidden or not, so unless the sheet itself was laid anew since
   *  (which a change while hidden does as well, on the viewport that is there)
   *  there is nothing to do. */
  const show = (view: FlatScene) => {
    if (laid.current?.view === view && laid.current.key === sheetKey()) return
    resync(view)
  }

  return {
    /** The viewport has mounted — take it and lay the sheet out on it — or
     *  unmounted (null): with the app, or never before then, as it is kept
     *  once its workspace has been opened. */
    onReady: (view: FlatScene | null) => {
      if (view) resync(view)
      else sceneRef.current = null
    },
    /** The kept viewport is shown again — see show. */
    resync: show,
    /** The cursor over the sheet — the alignment tool's live grid preview. */
    onHover: (cursor: Vec2 | null) => {
      const grid = sheetDatumPreview(useFlat.getState(), cursor)
      if (grid) scene()?.setGrid(grid)
    },
  }
}
