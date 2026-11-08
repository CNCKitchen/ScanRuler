// SPDX-License-Identifier: AGPL-3.0-only
// The instruction of the moment above the model, as pure functions of what
// the 3D Measure workspace holds: which slot a click would fill, what the
// marking gesture does, what to do next with an element being made, and the
// marking line of the deviation map's tools. App reads the state and shows
// the sentence; everything else the tool has to say goes to the status
// strip.

import { ALIGN_PICK_COUNT } from '../core/alignment'
import { dimensionTypeInfo, evaluateDimension } from '../core/dimensions'
import { creationMethod, type CreationMethod } from '../core/elements/construct'
import { elementKindInfo } from '../core/elements/kinds'
import type { FitData } from '../core/types'
import type { MarkGesture } from '../state/markStore'
import { alignSlotPicks, picksItsPoints, sectionDraftReady, type AlignDraft, type DimensionDraft, type Draft, type Element, type Section, type SectionDraft } from '../state/store'
import { dimensionRefsOf, isShadow } from '../state/sectionModel'
import { markChipText } from '../ui/MarkTools'
import type { ScaleDraft } from '../state/scaleModel'

type DraftMode = CreationMethod['mode'] | null

/** While a dimension is collecting references, which slot a viewport click
 *  would fill; a construction slot, a section or an alignment being set up
 *  invites clicks the same way. Null when nothing is waiting for one. */
export function openSlotHintOf(s: {
  draft: Draft | null
  draftMode: DraftMode
  sectionDraft: SectionDraft | null
  alignDraft: AlignDraft | null
  dimDraft: DimensionDraft | null
  elements: readonly Element[]
  /** The sections, which a dimension takes as planes. */
  sections?: readonly Section[]
  /** The Scale part box, while one of its rows collects two points. */
  scaleDraft?: ScaleDraft | null
}): string | null {
  const { draft, draftMode, sectionDraft, alignDraft, dimDraft, elements } = s
  const scaling = s.scaleDraft
  if (!draft && scaling && scaling.pickRow !== null) {
    const row = scaling.refs[scaling.pickRow]
    const have = row?.kind === 'points' ? row.points.length : 0
    return `Click the scan — ${have === 0 ? 'one end of the length' : 'its other end'} (point ${have + 1} of 2) · Esc to stop picking`
  }
  if (!draft && sectionDraft) {
    if (!sectionDraft.axis)
      return 'Click the element to cut along — a plane, cylinder, cone, line or circle — or one of the XY, YZ, XZ planes, or choose in the panel'
    const verb = sectionDraft.editId !== undefined ? 'save' : 'create'
    // A shadow's plane has no arrow: it is drawn in the middle of the part.
    if (isShadow(sectionDraft))
      return sectionDraftReady(sectionDraft)
        ? `Drag a ring to tilt the plane · Enter or middle-click to ${verb} · Esc to discard`
        : 'Drag a ring to tilt the plane and look along another direction'
    return sectionDraftReady(sectionDraft)
      ? `Drag the arrow to slide the plane, a ring to tilt it · Enter or middle-click to ${verb} · Esc to discard`
      : 'Drag the arrow to slide the plane along its direction, a ring to tilt it, or type the offset in the panel'
  }
  if (!draft && alignDraft) {
    if (alignDraft.pickSlot !== null) {
      const need = ALIGN_PICK_COUNT[alignDraft.pickSlot]
      const have = alignSlotPicks(alignDraft, alignDraft.pickSlot).length
      const what =
        alignDraft.pickSlot === 'primary'
          ? 'on the face to set on a plane'
          : alignDraft.pickSlot === 'secondary'
            ? 'along the edge to align with the axis'
            : 'for the zero point'
      return `Click the scan — point ${have + 1} of ${need} ${what} · Esc to stop picking`
    }
    if (alignDraft.proposal)
      return 'This is the pose the scan suggests — change a side or a direction in the panel if it is not yours, then press Confirm alignment'
    return alignDraft.primary === null && alignDraft.primaryPicks.length === 0
      ? 'The coordinate planes show where the part is going — set a face on one of them via the panel'
      : 'Add an axis (step 2) or a zero point (step 3) if you need them — then press Confirm alignment'
  }
  if (draft && draftMode === 'construct') {
    const method = creationMethod(draft.kind, draft.method)
    if (draft.pickSlot != null)
      return picksItsPoints(draft)
        ? `Click the scan or a point element for “${method.slots[draft.pickSlot].label}”`
        : `Click the scan to pick “${method.slots[draft.pickSlot].label}” · Esc to stop picking`
    const empty = draft.refs.findIndex((r) => r === null)
    if (empty < 0) return null
    return `Click an element in the viewport for “${method.slots[empty].label}” — or choose it in the panel`
  }
  if (draft || !dimDraft) return null
  const empty = dimDraft.refs.findIndex((r) => r === null)
  if (empty < 0) {
    const refs = dimensionRefsOf(elements, s.sections ?? [])
    const fits = dimDraft.refs.map((id) => refs.find((e) => e.id === id)?.fit)
    const ok =
      fits.every((f): f is FitData => f !== undefined) &&
      !evaluateDimension(dimDraft.type, fits, { anchor: dimDraft.anchor, basic: dimDraft.basic })
        .invalid
    return ok ? 'Enter or middle-click to add the dimension · Esc to cancel' : null
  }
  const label = dimensionTypeInfo(dimDraft.type).slots[empty].label
  return `Click an element in the viewport for “${label}” — the dimension type follows what you pick`
}

/** Marking a surface by hand has its own line — the same line the local fine
 *  fit gets, since it is the same tool set: which gesture is live, what the
 *  buttons do while it is, and the way back to the camera. Only where Escape
 *  leads and how the element is finished differ. Editing an element runs the
 *  same gestures as making one; only what Enter and Escape land on is
 *  different — a change written back, or dropped. */
export function paintHintOf(s: {
  draft: Draft | null
  painting: boolean
  markGesture: MarkGesture | null
  markStraight: boolean
  markCount: number
  editingDraft: boolean
}): string | null {
  const { draft, painting, markGesture, markStraight, markCount, editingDraft } = s
  return !painting
    ? null
    : markChipText(markGesture, markCount, `the ${elementKindInfo(draft!.kind).noun}`, {
        idle: editingDraft ? 'Esc discards the changes' : 'Esc discards the element',
        live: 'Esc to navigate, twice to discard',
      }, markStraight) +
      (draft!.status === 'ready'
        ? editingDraft
          ? ' · Enter or middle-click saves it'
          : ' · Enter or middle-click creates it'
        : '')
}

/** The sentence above the model while an element is being made. */
export function stageHintOf(s: {
  draft: Draft | null
  draftMode: DraftMode
  openSlotHint: string | null
  painting: boolean
  paintHint: string | null
  editingDraft: boolean
}): string | null {
  const { draft, draftMode, openSlotHint, painting, paintHint, editingDraft } = s
  return !draft
    ? openSlotHint
    : draftMode === 'construct'
      ? openSlotHint
      : painting
        ? paintHint
        : draft.picks.length === 0 && draft.status !== 'ready'
          ? draftMode === 'pick' && draft.kind === 'point'
            ? 'Click the point on the scan you want to measure to'
            : `Click a point on the ${elementKindInfo(draft.kind).noun} you want to measure`
          : draft.status === 'ready'
            ? `Enter or middle-click to ${editingDraft ? 'save' : 'create'} · Esc to discard · click again to ${
                draftMode === 'pick' && draft.kind === 'point' ? 'move the point' : 'add points'
              }`
            : draftMode === 'pick' && draft.picks.length > 0 && draft.status === 'empty'
              ? `Point ${draft.picks.length} of ${creationMethod(draft.kind, draft.method).minPicks ?? 1} — keep clicking around the ${elementKindInfo(draft.kind).noun}`
              : null
}

/** The same tools mark two different things in the deviation workspace: the
 *  surface a local fine fit runs on, and the region an element map is
 *  restricted to. */
export function markHintOf(s: { marking: boolean; markGesture: MarkGesture | null; markStraight: boolean; markCount: number; source: string }): string | null {
  const { marking, markGesture, markStraight, markCount, source } = s
  return !marking
    ? null
    : markChipText(
        markGesture,
        markCount,
        source === 'element' ? 'the surface to measure' : 'the surface to fit on',
        {
          idle: 'Esc closes',
          live: 'Esc to navigate, twice to close',
        },
        markStraight,
      )
}
