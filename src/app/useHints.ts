// SPDX-License-Identifier: AGPL-3.0-only
// The guided hints, bound to the stores: reads the state of the work, asks the
// ladder in core/hints what is still missing, and hands the answer to whichever
// control is that step.

import { useEffect } from 'react'
import { isDeviationTarget } from '../core/deviation/elementField'
import { nextHint, type HintInput, type HintResult, type HintTrack } from '../core/hints'
import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { hasLearned, useHintPrefs } from '../state/hintStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { useFlat } from '../state/flatStore'
import { plugins } from '../plugins/registry'
import type { WorkspaceTab } from '../plugins/api'
import { useCommandActivity } from '../commands/activity'

/** The ladder's answer for the workspace on screen, already silenced where it
 *  has no business speaking. Every field is a primitive or a boolean, so the
 *  components that call this only re-render when the answer can actually
 *  change. */
function useLadder(): HintResult {
  const workspace: HintTrack = useShell((s) => s.workspace)
  // Every plugin's hint is asked for, in the same order on every render, so
  // the hooks behind them stay put; only the workspace on screen's is read.
  const tabs = plugins().flatMap((p) => (p.workspace ? [p.workspace] : []))
  const pluginHints = tabs.map((tab: WorkspaceTab) => tab.useHintStep?.() ?? null)
  const tab = tabs.findIndex((t) => t.id === workspace)
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
  const sectionDraftOpen = useStore((s) => s.sectionDraft !== null)

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

  const imageLoaded = useFlat((s) => s.imageName !== null)
  const imageBusy = useFlat((s) => s.imageBusy)
  // An agent's command is steps the person watches rather than takes.
  const commandRunning = useCommandActivity((s) => s.running !== null)

  const input: HintInput = {
    workspace,
    busy: scanBusy || nominalBusy || deviationRunning || thicknessRunning || imageBusy || commandRunning || pluginHints.some((h) => h?.busy),
    scanLoaded,
    fittedElements,
    dimensions,
    draftOpen,
    dimDraftOpen,
    alignDraftOpen,
    sectionDraftOpen,
    onElement,
    referenceLoaded,
    aligned,
    mapReady,
    hasTargetElement,
    targetChosen,
    thicknessReady,
    pluginStep: tab >= 0 ? (pluginHints[tab]?.step ?? null) : undefined,
    imageLoaded,
  }
  const result = nextHint(input)
  // A plugin's workspace without hints of its own: nothing to ring, nothing
  // to retire.
  if (tab >= 0 && !tabs[tab].useHintStep) return null
  // 'done' still has to reach the caller that retires the track — it is only
  // the ring and the chip that go quiet here.
  if (inSubFlow) return result === 'done' ? 'done' : null
  if (!on || learned) return result === 'done' ? 'done' : null
  return result
}

/** The ladder's answer for the workspace on screen right now, read off the
 *  stores outside React — the same reading useLadder takes, for the
 *  session's readout (commands/state.ts). Neither the switch in Settings nor
 *  what has been learned silences it: whoever asks wants the step. A
 *  plugin's workspace has its step in a hook, so here it has none. */
export function hintNow(): HintResult {
  const workspace: HintTrack = useShell.getState().workspace
  const s = useStore.getState()
  const d = useDeviation.getState()
  const t = useThickness.getState()
  const f = useFlat.getState()
  return nextHint({
    workspace,
    busy: s.busy || d.nominalBusy || d.alignStatus === 'running' || d.mapStatus === 'running' || t.status === 'running' || f.imageBusy,
    scanLoaded: s.fileName !== null,
    fittedElements: s.elements.filter((e) => e.fit).length,
    dimensions: s.dimensions.length,
    draftOpen: s.draft !== null,
    dimDraftOpen: s.dimDraft !== null,
    alignDraftOpen: s.alignDraft !== null,
    sectionDraftOpen: s.sectionDraft !== null,
    onElement: d.source === 'element',
    referenceLoaded: d.nominalName !== null,
    aligned: d.alignStatus === 'done' && d.align !== null,
    mapReady: d.mapStatus === 'ready',
    hasTargetElement: s.elements.some((e) => isDeviationTarget(e.fit)),
    targetChosen: d.targetId !== null,
    thicknessReady: t.status === 'ready',
    pluginStep: plugins().some((p) => p.workspace?.id === workspace) ? null : undefined,
    imageLoaded: f.imageName !== null,
  })
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
