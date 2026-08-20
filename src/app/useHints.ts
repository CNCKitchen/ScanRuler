// SPDX-License-Identifier: AGPL-3.0-only
// The guided hints, bound to the stores: reads the state of the work, asks the
// ladder in core/hints what is still missing, and hands the answer to whichever
// control is that step.

import { useEffect } from 'react'
import { isDeviationTarget } from '../core/deviation/elementField'
import { nextHint, type HintInput, type HintResult } from '../core/hints'
import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { hasLearned, useHintPrefs } from '../state/hintStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'

/** The ladder's answer for the workspace on screen, already silenced where it
 *  has no business speaking. Every field is a primitive or a boolean, so the
 *  components that call this only re-render when the answer can actually
 *  change. */
function useLadder(): HintResult {
  const workspace = useShell((s) => s.workspace)
  const on = useHintPrefs((s) => s.on)
  const learned = useHintPrefs((s) => hasLearned(s, workspace))

  const scanBusy = useStore((s) => s.busy)
  const scanLoaded = useStore((s) => s.fileName !== null)
  const fittedElements = useStore((s) => s.elements.filter((e) => e.fit).length)
  const hasTargetElement = useStore((s) => s.elements.some((e) => isDeviationTarget(e.fit)))
  const dimensions = useStore((s) => s.dimensions.length)
  const draftOpen = useStore((s) => s.draft !== null)
  const dimDraftOpen = useStore((s) => s.dimDraft !== null)
  const alignDraftOpen = useStore((s) => s.alignDraft !== null)

  const onElement = useDeviation((s) => s.source === 'element')
  const referenceLoaded = useDeviation((s) => s.nominalName !== null)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const aligned = useDeviation((s) => s.alignStatus === 'done' && s.align !== null)
  const mapReady = useDeviation((s) => s.mapStatus === 'ready')
  const targetChosen = useDeviation((s) => s.targetId !== null)
  const deviationRunning = useDeviation((s) => s.alignStatus === 'running' || s.mapStatus === 'running')
  // Picking alignment points and marking a surface both take the whole
  // viewport and run their own instructions; a ring in the panel behind them
  // would be pointing past what the user is doing.
  const inSubFlow = useDeviation((s) => s.picking || s.marking)

  const thicknessReady = useThickness((s) => s.status === 'ready')
  const thicknessRunning = useThickness((s) => s.status === 'running')

  const input: HintInput = {
    workspace,
    busy: scanBusy || nominalBusy || deviationRunning || thicknessRunning,
    scanLoaded,
    fittedElements,
    dimensions,
    draftOpen,
    dimDraftOpen,
    alignDraftOpen,
    onElement,
    referenceLoaded,
    aligned,
    mapReady,
    hasTargetElement,
    targetChosen,
    thicknessReady,
  }
  const result = nextHint(input)
  // 'done' still has to reach the caller that retires the track — it is only
  // the ring and the chip that go quiet here.
  if (inSubFlow) return result === 'done' ? 'done' : null
  if (!on || learned) return result === 'done' ? 'done' : null
  return result
}

/** True when this control is the step to press next. Give it the control's own
 *  data-test id and put the returned class on the element — see `.pulse`. */
export function usePulse(target: string): boolean {
  const result = useLadder()
  return typeof result === 'object' && result !== null && result.target === target
}

/** The line for the chip over the model, or null when there is nothing to say
 *  or something on the stage is already saying it.
 *
 *  App's alone, and called exactly once: this is also where a workspace is
 *  recorded as carried through, which is what eventually retires its ring. */
export function useHintChip(): string | null {
  const result = useLadder()
  const workspace = useShell((s) => s.workspace)
  const markRun = useHintPrefs((s) => s.markRun)
  const done = result === 'done'

  useEffect(() => {
    if (done) markRun(workspace)
  }, [done, workspace, markRun])

  return typeof result === 'object' && result !== null ? result.text : null
}
