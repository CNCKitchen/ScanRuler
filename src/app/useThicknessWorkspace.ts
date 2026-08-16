// SPDX-License-Identifier: AGPL-3.0-only
// The wall thickness workspace's verbs: measure the field and copy the report.
// The field itself lives in refs owned by App, because the hover readout and
// the pins read it too.
import type { RefObject } from 'react'
import type { MeshWorkerClient } from '../core/workerClient'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { buildThicknessReport } from '../core/thickness/report'

export function useThicknessWorkspace({
  clientRef,
  thickness,
  thicknessRgb,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
}) {
  const runThickness = async () => {
    const t = useThickness.getState()
    t.begin()
    useStore.getState().setStatus('Measuring wall thickness…')
    try {
      const result = await clientRef.current!.thickness({
        method: t.method,
        coneRays: t.method === 'ray' ? t.coneRays : 0,
        coneAngleDeg: t.coneAngleDeg,
        normalDeviationDeg: t.normalDeviationDeg,
        maxThickness: t.maxThickness,
      })
      thickness.current = result.values
      thicknessRgb.current = null
      useThickness.getState().resolve(result.suggestedLow, result.suggestedHigh)
      useStore.getState().setStatus('Wall thickness measured.')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      useThickness.getState().fail(message)
      useStore.getState().setStatus('')
    }
  }

  const handleCopyThicknessReport = () => {
    const t = useThickness.getState()
    if (!t.stats) return
    void navigator.clipboard?.writeText(
      buildThicknessReport(useStore.getState().fileName ?? '', t.stats, t),
    )
  }

  return { runThickness, handleCopyThicknessReport }
}
