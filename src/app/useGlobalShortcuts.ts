// SPDX-License-Identifier: AGPL-3.0-only
// Enter or a middle-mouse click confirms the pending element — or, with no
// element draft open, the pending dimension — and Escape discards it; the 2D
// workspace's drafts, counts and stage tools answer to the same keys. The
// middle click only counts when it isn't a drag — the middle button also
// drives the camera zoom.
import { useEffect } from 'react'
import { creationMethod } from '../core/elements/construct'
import { evaluateDimension } from '../core/dimensions'
import type { FitData } from '../core/types'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useMark } from '../state/markStore'
import { useFlat } from '../state/flatStore'
import { useShell } from '../state/shellStore'
import { evaluateFlatDimension } from '../core/flat/dimensions'
import type { FlatFit } from '../core/flat/types'

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
    // The 2D workspace's own pending things, in the order they take the keys:
    // the stage tools (calibration, datum), then the element, count and
    // dimension drafts. Mirrors the buttons: a confirm lands only where the
    // button would be enabled.
    const flatConfirmable = (): (() => void) | null => {
      const f = useFlat.getState()
      if (f.calibrating || f.datumPicking) return null
      if (f.draft) return f.draft.fit ? () => useFlat.getState().commitDraft() : null
      if (f.counting) return f.counting.picks.length > 0 ? () => useFlat.getState().finishCount() : null
      const dd = f.dimDraft
      if (!dd || dd.refs.some((r) => r === null)) return null
      const fits = dd.refs.map((id) => f.elements.find((e) => e.id === id)?.fit)
      if (!fits.every((x): x is FlatFit => x !== undefined && x !== null)) return null
      return evaluateFlatDimension(dd.type, fits).invalid ? null : () => useFlat.getState().commitDim()
    }
    const flatCancel = (): (() => void) | null => {
      const f = useFlat.getState()
      if (f.calibrating) return f.cancelCalibration
      if (f.datumPicking) return f.cancelDatum
      if (f.draft) return f.cancelDraft
      if (f.counting) return f.cancelCount
      if (f.dimDraft) return f.cancelDimDraft
      return null
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      // Enter on a focused button belongs to the button — the browser clicks
      // it right after this handler, and confirming the draft as well would
      // fire two different actions from one key press.
      if (e.key === 'Enter' && target?.closest('button')) return
      if (useShell.getState().workspace === 'flat') {
        if (e.key === 'Escape') flatCancel()?.()
        else if (e.key === 'Enter') flatConfirmable()?.()
        return
      }
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
    const confirmable = (): 'draft' | 'dimension' | 'flat' | null => {
      if (useShell.getState().workspace === 'flat') return flatConfirmable() ? 'flat' : null
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
      else if (what === 'flat') flatConfirmable()?.()
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
