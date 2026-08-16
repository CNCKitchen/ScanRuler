// SPDX-License-Identifier: AGPL-3.0-only
// Enter or a middle-mouse click confirms the pending element — or, with no
// element draft open, the pending dimension — and Escape discards it. The
// middle click only counts when it isn't a drag — the middle button also
// drives the camera zoom.
import { useEffect } from 'react'
import { creationMethod } from '../core/elements/construct'
import { evaluateDimension } from '../core/dimensions'
import type { FitData } from '../core/types'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useMark } from '../state/markStore'

export function useGlobalShortcuts({
  stopMarking,
  cancelDraft,
  confirmDraft,
}: {
  /** Close the deviation workspace's local fine fit marking session. */
  stopMarking: () => void
  cancelDraft: () => void
  confirmDraft: () => void
}) {
  useEffect(() => {
    // Mirrors the "Add dimension" button: every slot filled and the preview
    // actually producing a value.
    const dimensionReady = () => {
      const s = useStore.getState()
      const dd = s.dimDraft
      if (!dd || s.draft || dd.refs.some((r) => r === null)) return false
      const fits = dd.refs.map((id) => s.elements.find((el) => el.id === id)?.fit)
      if (!fits.every((f): f is FitData => f !== undefined)) return false
      return !evaluateDimension(dd.type, fits, dd.anchor).invalid
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      // Enter on a focused button belongs to the button — the browser clicks
      // it right after this handler, and confirming the draft as well would
      // fire two different actions from one key press.
      if (e.key === 'Enter' && target?.closest('button')) return
      const store = useStore.getState()
      if (useDeviation.getState().marking) {
        // Escape backs out one step at a time: the first hands the camera back
        // by standing the gesture down, the second closes the local fine fit
        // and takes the marking with it. Never both at once — the key is
        // reached for to get the mouse working again, and losing a marking to
        // that would be a trap.
        if (e.key !== 'Escape') return
        if (useMark.getState().gesture !== null) useMark.getState().setGesture(null)
        else stopMarking()
        return
      }
      if (store.draft) {
        if (e.key === 'Escape') {
          // The same retreat while an element is being marked by hand: the
          // first Escape hands the camera back, the second discards the draft.
          // Never both at once — the key is reached for to get the mouse
          // working again, and losing the marking to that would be a trap.
          const marked =
            store.selectMode === 'paint' &&
            creationMethod(store.draft.kind, store.draft.method).mode === 'fit'
          if (marked && useMark.getState().gesture !== null) useMark.getState().setGesture(null)
          else cancelDraft()
        } else if (e.key === 'Enter' && store.draft.status === 'ready') confirmDraft()
        return
      }
      if (store.alignDraft) {
        // First Escape leaves point picking, the second closes the editor.
        if (e.key === 'Escape') {
          if (store.alignDraft.pickSlot !== null) store.cancelAlignmentPick()
          else store.cancelAlignment()
        }
        return
      }
      if (store.dimDraft) {
        if (e.key === 'Escape') store.cancelDimension()
        else if (e.key === 'Enter' && dimensionReady()) store.commitDimension()
      }
    }
    /** What a confirm would land on right now, if anything. */
    const confirmable = (): 'draft' | 'dimension' | null => {
      const store = useStore.getState()
      if (store.draft) return store.draft.status === 'ready' ? 'draft' : null
      return dimensionReady() ? 'dimension' : null
    }
    let middleDown: { x: number; y: number } | null = null
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      middleDown = { x: e.clientX, y: e.clientY }
      // Keep the browser's middle-click autoscroll out of the way while an
      // element or dimension is waiting to be confirmed.
      if (confirmable()) e.preventDefault()
    }
    const onPointerUp = (e: PointerEvent) => {
      const down = middleDown
      middleDown = null
      if (e.button !== 1 || !down) return
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) return
      const what = confirmable()
      if (what === 'draft') confirmDraft()
      else if (what === 'dimension') useStore.getState().commitDimension()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
