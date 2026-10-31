// SPDX-License-Identifier: AGPL-3.0-only
// Browser imports replace part of the session and reset its shared history.
// Ask at the head of the import queue, before preparing or committing files:
// work may have been added since a file was picked or dropped.
import { draftHolds, useStore } from '../state/store'
import { flatDraftHolds, useFlat } from '../state/flatStore'
import { dimHolds, useHistory } from '../state/historyStore'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { sessionIsDirty } from './project'
import { keptParts, projectSections } from './projectSections'

export function importWouldDiscardWork(): boolean {
  const s = useStore.getState(), f = useFlat.getState()
  const d = useDeviation.getState(), t = useThickness.getState()
  const h = useHistory.getState()
  return sessionIsDirty() || Object.keys(keptParts().parts).length > 0 || h.past.length > 0 || h.future.length > 0 ||
    !!(draftHolds(s.draft) || dimHolds(s.dimDraft) || s.alignDraft || s.sectionDraft ||
      flatDraftHolds(f.draft) || dimHolds(f.dimDraft) || s.appliedAlignment || d.align || d.pendingScan) ||
    d.pairs.length > 0 ||
    d.probes.length > 0 || d.mapStatus === 'ready' || t.probes.length > 0 || t.status === 'ready' ||
    projectSections().some((p) => p.hasDraft?.())
}

const consequence = {
  scan: 'Opening another scan replaces the scan and its measurements, alignment and maps.',
  image: 'Opening another image replaces the image and its sheet measurements.',
  reference: 'Opening another reference replaces the reference, comparison alignment and maps.',
}

/** UI only. Commands retain their own explicit replacement contracts. */
export function confirmImport(kind: keyof typeof consequence): boolean {
  return !importWouldDiscardWork() || window.confirm(
    `${consequence[kind]} It also clears undo and redo for all workspaces. Cancel to keep your work or save the project first. Continue?`,
  )
}
