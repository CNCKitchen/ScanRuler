// SPDX-License-Identifier: AGPL-3.0-only
// The wall thickness workspace's verbs: measure the field and copy the report.
// The field itself lives in the session's refs (see session.ts), because the
// hover readout and the pins read it too.
import type { RefObject } from 'react'
import type { MeshWorkerClient } from '../core/workerClient'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { buildThicknessReport } from '../core/thickness/report'
import type { ThicknessStats } from '../core/thickness/thickness'

export type ThicknessWorkspace = ReturnType<typeof thicknessWorkspace>

export function thicknessWorkspace({
  clientRef,
  thickness,
  thicknessRgb,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
}) {
  const runThickness = async () => {
    const scanVersion = clientRef.current!.scanVersion
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
      if (scanVersion !== clientRef.current!.scanVersion) return
      thickness.current = result.values
      thicknessRgb.current = null
      useThickness.getState().resolve(result.suggestedLow, result.suggestedHigh)
      useStore.getState().setStatus('Wall thickness measured.')
    } catch (e) {
      if (scanVersion !== clientRef.current!.scanVersion) return
      const message = e instanceof Error ? e.message : String(e)
      useThickness.getState().fail(message)
      useStore.getState().setStatus('')
    }
  }

  /** The report the panel copies, on the figures given — the legend's, by
   *  default. Null with nothing measured. */
  const reportText = (stats: ThicknessStats | null = useThickness.getState().stats): string | null =>
    stats ? buildThicknessReport(useStore.getState().fileName ?? '', stats, useThickness.getState()) : null

  const handleCopyThicknessReport = () => {
    const text = reportText()
    if (text) void navigator.clipboard?.writeText(text)
  }

  return { runThickness, reportText, handleCopyThicknessReport }
}
