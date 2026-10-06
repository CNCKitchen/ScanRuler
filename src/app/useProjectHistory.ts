// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type RefObject } from 'react'
import { beginHistoryGroup, configureHistory, endHistoryGroup, installHistory, useHistory } from '../state/historyStore'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { identityRigid, rigidCompose, rigidInvert, type Rigid } from '../core/deviation/rigid'
import type { SourceFiles } from './project'
import type { ScanSource } from './useScanSwap'
import type { MeshWorkerClient } from '../core/workerClient'
import type { SceneManager } from '../viewer/SceneManager'
import type { ImportQueue } from './importQueue'
import type { ElementKind } from '../core/types'
import { forgetSurface, surfacesMoved } from './surfaces'

export function useProjectHistory(options: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  elementScope: RefObject<Uint32Array | null>
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
  imports: ImportQueue
  sources: RefObject<SourceFiles>
  runFit: (id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array, regionsOnly?: boolean) => Promise<void>
  runDeviation: () => Promise<void>
  runThickness: () => Promise<void>
  /** A step across an edit of the scan loads the file from the other side
   *  of it — see useScanSwap. */
  swapScan: (source: ScanSource, transform: Rigid | null) => Promise<void>
  remeasureScan: (refit: boolean) => Promise<void>
}) {
  const current = useRef(options)
  current.current = options
  useEffect(() => {
    const queue = current.current.imports
    const availability = () => useHistory.setState({ importing: queue.busy })
    const unsubscribe = queue.subscribe(availability)
    availability()
    const unconfigure = configureHistory({
      blocked: () => current.current.imports.busy,
      runRestore: (job) => current.current.imports.run(job),
      getScope: () => current.current.elementScope.current,
      setScope: (scope) => { current.current.elementScope.current = scope },
      getScan: () => current.current.sources.current.scan,
      beforeRestore: async (patch) => {
        const { clientRef, sceneRef, sources } = current.current
        useStore.setState({ busy: true })
        try {
          if ('scan' in patch && patch.scan && patch.scan !== sources.current.scan) {
            // The scan from the other side of an edit, read in the pose the
            // step puts it in — no alignment to move it by afterwards.
            const pose = patch.measure ? patch.measure.appliedAlignment : useStore.getState().appliedAlignment
            await current.current.swapScan(patch.scan as ScanSource, pose)
          } else if (patch.measure && patch.measure.appliedAlignment !== useStore.getState().appliedAlignment) {
            const from = useStore.getState().appliedAlignment ?? identityRigid()
            const to = patch.measure.appliedAlignment ?? identityRigid()
            const delta = rigidCompose(to, rigidInvert(from))
            await clientRef.current!.transform(delta)
            sceneRef.current?.applyTransform(delta)
            surfacesMoved()
          }
        } catch (error) { useStore.setState({ busy: false }); throw error }
      },
      afterRestore: async (patch, previous) => {
        const o = current.current
        try {
          if ('scan' in patch && patch.scan !== previous.scan) {
            // Everything was read off the scan that has gone: the elements
            // go back onto theirs as the step left them, and the maps and the
            // reduction are measured again.
            await o.remeasureScan(false)
            if (patch.deviation) useDeviation.setState({ probes: patch.deviation.probes })
            if (patch.thickness) useThickness.setState({ probes: patch.thickness.probes })
            return
          }
          if (patch.measure && patch.measure.elements !== previous.measure.elements) {
            const elements = useStore.getState().elements
            for (const old of previous.measure.elements) {
              if (elements.find((el) => el.id === old.id)?.source !== old.source) {
                forgetSurface(old.id)
                o.sceneRef.current?.clearElement(old.id)
              }
            }
            await Promise.all(elements.map((el) => el.source.type === 'fitted' &&
              previous.measure.elements.find((old) => old.id === el.id)?.source !== el.source
              ? o.runFit(el.id, el.kind, el.source.seeds, el.source.selection, true) : Promise.resolve()))
          }
          const moved = patch.measure && patch.measure.appliedAlignment !== previous.measure.appliedAlignment
          // The facing limit decides which surface each reading is taken off,
          // so the map under it is measured again just as for a new pose.
          const refaced = patch.deviation && patch.deviation.mapFacingDeg !== previous.deviation.mapFacingDeg
          if (moved || refaced || (patch.deviation && patch.deviation.align !== previous.deviation.align)) {
            o.deviation.current = null
            o.deviationRgb.current = null
            const d = useDeviation.getState()
            useDeviation.setState({ alignStatus: d.align ? 'done' : 'idle', mapStatus: 'idle', stats: null, histogram: null, mapVersion: d.mapVersion + 1 })
            if (d.align) await o.runDeviation()
            if (patch.deviation) useDeviation.setState({ probes: patch.deviation.probes })
          }
          const t = patch.thickness
          const searchChanged = t && (['method', 'maxThickness', 'coneRays', 'coneAngleDeg', 'normalDeviationDeg'] as const)
            .some((key) => t[key] !== previous.thickness[key])
          if (searchChanged && o.thickness.current) {
            o.thickness.current = null
            o.thicknessRgb.current = null
            await o.runThickness()
            useThickness.setState({ probes: t.probes })
          }
        } finally { useStore.setState({ busy: false }) }
      },
    })
    const uninstall = installHistory()
    let inputFocused = false
    let pointerHeld = false
    const pointerDown = () => { pointerHeld = true; if (!inputFocused) beginHistoryGroup() }
    const pointerUp = () => {
      pointerHeld = false
      // Include the target's final pointer-up update in the same gesture.
      queueMicrotask(() => { if (!inputFocused && !pointerHeld) endHistoryGroup() })
    }
    const focusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null
      inputFocused = !!target && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)
      if (inputFocused) beginHistoryGroup()
    }
    const focusOut = () => {
      inputFocused = false
      endHistoryGroup()
      if (pointerHeld) beginHistoryGroup()
    }
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointerup', pointerUp, true)
    document.addEventListener('pointercancel', pointerUp, true)
    document.addEventListener('focusin', focusIn, true)
    document.addEventListener('focusout', focusOut, true)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointerup', pointerUp, true)
      document.removeEventListener('pointercancel', pointerUp, true)
      document.removeEventListener('focusin', focusIn, true)
      document.removeEventListener('focusout', focusOut, true)
      uninstall()
      unconfigure()
      unsubscribe()
    }
  }, [])
}
