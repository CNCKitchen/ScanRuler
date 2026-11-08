// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's keys — see KeyboardContribution in
// src/plugins/api.ts. Enter or a middle click finishes the sketch or makes
// the extrude, the revolve or the feature once it is ready — a Patch
// network's patch being placed is closed first; Escape backs out
// one step at a time — the Note key too; the sketch's tools sit on the
// letters CAD has them on; Space and the arrows run the feature list's
// playback.

import type { KeyboardContribution } from '../../../src/plugins/api'
import { extrudeDraftReady, featureDraftReady, revolveDraftReady, useReverse, type SketchTool } from '../state/reStore'
import { pausePlayback, resumePlayback, stepPlayback, stopPlayback } from './playback'
import { NO_PICK } from '../core/bodyFolders'
import { useNotes } from '../state/noteStore'
import { networkFinishPlacing, networkKey } from './useNetworkLayer'

/** The sketch's tools by the letters CAD has them on: D is the one asked for
 *  most — a dimension, on whatever is clicked next. */
const SKETCH_TOOL_KEYS: Record<string, SketchTool> = {
  d: 'dimension',
  l: 'line',
  r: 'rectangle',
  c: 'circle',
  s: 'spline',
  f: 'fillet',
  t: 'trim',
}

/** What the open editor would create on Enter or a middle click — the
 *  sketch, the extrude, the revolve, the feature — or null while it is not
 *  ready to. One answer for the key and the click, so the two never
 *  disagree. */
function confirmable(): (() => void) | null {
  const re = useReverse.getState()
  // Finish is always on: a sketch with nothing drawn closes and makes
  // nothing, which is how one opened by mistake goes away. With a chain of
  // lines in hand the confirm ends the chain first — the key and the middle
  // click alike — and with a dimension following the cursor it puts the
  // dimension down where the layout has it; the next one finishes.
  if (re.sketchDraft) {
    if (re.sketchDraft.dimMade != null) return () => re.putDownDimension()
    // A spline's points in hand are made the curve.
    if (re.sketchDraft.tool === 'spline' && re.sketchDraft.pending.length > 0) return () => re.finishSpline()
    return re.sketchDraft.pending.length > 0 ? () => re.clearSelection() : () => re.commitSketch()
  }
  if (re.extrudeDraft) return extrudeDraftReady(re.extrudeDraft) ? () => re.commitExtrude() : null
  if (re.revolveDraft) return revolveDraftReady(re.revolveDraft) ? () => re.commitRevolve() : null
  // A patch being placed is closed first, as a spline's points are made
  // the curve — never the network made under it; the next one makes it.
  if (re.featureDraft?.kind === 'network' && re.featureDraft.placing) return networkFinishPlacing
  if (re.featureDraft) return featureDraftReady(re.featureDraft) ? () => re.commitFeature() : null
  return null
}

export const reverseKeyboard: KeyboardContribution = {
  // The workspace takes every key while it is open. In a sketch, Escape
  // backs out one step at a time — a drawing tool's half-placed points or the
  // selection first, then the tool — and stops there: the sketch's one exit
  // is Finish (Enter, the key, a middle click), and an unwanted sketch is
  // undone from the feature list, so no key can throw a drawing away.
  keydown(e, { confirmButton }) {
    const re = useReverse.getState()
    if (re.sketchDraft) {
      const d = re.sketchDraft
      const tool = !e.ctrlKey && !e.altKey && !e.metaKey ? SKETCH_TOOL_KEYS[e.key.toLowerCase()] : undefined
      if (e.key === 'Escape') {
        // A dimension following the cursor is taken back, never made; a
        // spline's points are made the curve, as a chain of lines is ended
        // with the lines it has.
        if (d.tool === 'spline' && d.pending.length > 0) re.finishSpline()
        else if (d.pending.length > 0 || d.dimPick || d.dimMade != null || d.selection.length > 0 || d.selectedConstraint !== null) re.clearSelection()
        else if (d.tool !== 'select') re.setSketchTool('select')
      } else if (e.key === 'Enter') confirmable()?.()
      else if (tool === 'dimension' && d.tool === 'select' && d.selection.length > 0) re.dimensionSelection()
      else if (tool) re.setSketchTool(d.tool === tool ? 'select' : tool)
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (re.sketchDraft.selectedConstraint !== null) re.removeSelectedConstraint()
        else re.deleteSelected()
      }
      return true
    }
    if (re.extrudeDraft) {
      if (e.key === 'Escape') re.cancelExtrude()
      else if (e.key === 'Enter') confirmable()?.()
      return true
    }
    if (re.revolveDraft) {
      if (e.key === 'Escape') re.cancelRevolve()
      else if (e.key === 'Enter') confirmable()?.()
      return true
    }
    // A Patch network's box: its curve being drawn ended or let go, and the
    // keys on what is under the cursor, before the box's own.
    if (re.featureDraft?.kind === 'network' && networkKey(e)) return true
    if (re.featureDraft) {
      if (e.key === 'Escape') re.cancelFeature()
      else if (e.key === 'Enter') confirmable()?.()
      return true
    }
    // A playback: Space holds it or carries it on, the arrows step it,
    // Escape ends it. Space on a focused key is the key's — the browser
    // presses it.
    if (re.playback) {
      const onButton = (e.target as HTMLElement | null)?.closest?.('button')
      if (e.key === ' ' && !onButton) {
        e.preventDefault()
        if (re.playback.playing) pausePlayback()
        else resumePlayback()
        return true
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        stepPlayback(e.key === 'ArrowLeft' ? -1 : 1)
        return true
      }
      if (e.key === 'Escape') {
        stopPlayback()
        return true
      }
    }
    if (e.key === 'Escape') {
      // The Note key put down first, then the selection.
      if (useNotes.getState().placing) {
        useNotes.getState().setPlacing(false)
        return true
      }
      re.setSelection(null)
      re.setListSelection(NO_PICK)
    } else if (e.key === 'Enter') confirmButton()?.click()
    return true
  },
  // A sketch's sheet is posed by its own view; the camera's standard views
  // would turn the part out from under it — in any workspace.
  holdsViewKeys: () => useReverse.getState().sketchDraft !== null,
  confirmable,
}
