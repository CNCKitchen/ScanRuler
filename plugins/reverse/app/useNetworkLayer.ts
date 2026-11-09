// SPDX-License-Identifier: AGPL-3.0-only
// The Patch network's box and its layer in the viewport kept together: the
// layer drawn from the draft and the last preview's report while the box is
// open, its edits going to the store, and the curvature colouring on the
// scan meanwhile — the creases and the bends a network's curves are drawn
// along — put back as it was when the box closes.

import { type RefObject, useEffect, useRef } from 'react'
import { sceneOf } from '../../../src/commands/host'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { NetworkReport } from '../core/networkBody'
import { bodyColor, useReverse } from '../state/reStore'
import { networkLayerIf, networkLayerOf } from '../viewer/networkLayer'

/** The open network's last report — kept while the next is built, so the
 *  box's rows and the layer's corners stand still through every edit
 *  rather than going and coming back with each preview. */
export function useNetworkReport(): NetworkReport | null {
  const preview = useReverse((s) => (s.featureDraft?.kind === 'network' ? s.preview : null))
  const last = useRef<NetworkReport | null>(null)
  if (!preview || preview.status === 'idle' || preview.status === 'failed') last.current = null
  else if (preview.status === 'ok') last.current = preview.network ?? null
  return last.current
}

/** Whether the report on hand is of the draft as it stands: false while a
 *  build of a later change runs and the last report is still shown. Its
 *  patch and cell numbers are the last build's then, and an action that
 *  takes them would apply them to a draft they no longer describe
 *  (issue 34). */
export function useNetworkReportCurrent(): boolean {
  return useReverse((s) => s.featureDraft?.kind === 'network' && s.preview?.status === 'ok')
}

export function useNetworkLayer(sceneRef: RefObject<SceneManager | null>): void {
  const draft = useReverse((s) => (s.featureDraft?.kind === 'network' ? s.featureDraft : null))
  const report = useNetworkReport()
  const current = useNetworkReportCurrent()
  const nextId = useReverse((s) => s.nextFeatureId)
  const color = bodyColor(draft?.featureId ?? nextId)
  const bodies = useReverse((s) => s.bodies)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!draft) {
      networkLayerIf(scene)?.setDraft(null, null, color)
      return
    }
    const layer = networkLayerOf(scene)
    layer.onEdit = (change) => useReverse.getState().editNetwork(change)
    layer.bodyColors = new Map(bodies.map((b) => [b.id, b.color ?? bodyColor(b.id)]))
    layer.setDraft(draft, report, color, current)
  }, [draft, report, color, bodies, sceneRef, current])
  const open = draft !== null
  useEffect(() => {
    if (!open) return
    // The curvature on puts the map against the bodies off: both come back.
    const { curvatureMap, bodyMap } = useReverse.getState()
    if (!curvatureMap) useReverse.getState().setCurvatureMap(true)
    return () => {
      if (!curvatureMap) useReverse.getState().setCurvatureMap(false)
      if (bodyMap) useReverse.getState().setBodyMap(true)
    }
  }, [open])
}

/** A key with the network's box open, for the workspace's keys: true when
 *  the network took it. */
export function networkKey(e: KeyboardEvent): boolean {
  return networkLayerIf(sceneOf())?.key(e) ?? false
}

/** The patch being placed finished, for the workspace's confirm — the
 *  middle click: see NetworkLayer.finishPlacing. */
export function networkFinishPlacing(): void {
  networkLayerIf(sceneOf())?.finishPlacing()
}
