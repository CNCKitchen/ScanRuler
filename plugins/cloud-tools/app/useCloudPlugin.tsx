// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud Tools workspace's part in the app, for one render: the session's
// verbs (cloudSession.ts) on the panel's keys, the marking armed while the
// workspace is open, and a tool's marking laid down again whenever its
// settings change — see src/plugins/api.ts.

import { useEffect, useState } from 'react'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { useCloudTools } from '../state/cloudStore'
import { CloudPanel } from '../ui/CloudPanel'
import { CLOUD_MARK_COLOR, CLOUD_WORKSPACE, createCloudSession, installCloudSession } from './cloudSession'

export function useCloudPlugin(host: PluginHost): PluginRuntime {
  const [session] = useState(() =>
    createCloudSession({
      clientRef: host.clientRef,
      sceneRef: host.sceneRef,
      imports: host.imports,
      swapScanBuffers: host.swapScanBuffers,
      remapScan: host.remapScan,
      remeasureScan: host.remeasureScan,
    }),
  )
  useEffect(() => installCloudSession(session), [session])
  useEffect(() => session.watch(), [session])

  const onCloudTools = useShell((s) => s.workspace === CLOUD_WORKSPACE)
  const ready = useStore((s) => s.fileName !== null && s.scanIsCloud && !s.busy)
  const scanVersion = useStore((s) => s.vertexCount)
  const tool = useCloudTools((s) => s.tool)
  const percent = useCloudTools((s) => s.percent)
  const axis = useCloudTools((s) => s.axis)
  const offset = useCloudTools((s) => s.offset)
  const side = useCloudTools((s) => s.side)
  const running = useCloudTools((s) => s.running !== null)

  // The tool's marking follows its settings, and the scan: a slider dragged
  // marks again as it goes (an answer overtaken by a newer one is dropped).
  const live = onCloudTools && ready && !running
  useEffect(() => {
    if (live && tool === 'floating') void session.markFloating(percent)
  }, [live, tool, percent, scanVersion, session])
  useEffect(() => {
    if (live && tool === 'plane') void session.markPastPlane()
  }, [live, tool, axis, offset, side, scanVersion, session])

  return {
    startPane: {
      title: 'Cleaning up a point cloud',
      blurb:
        'Open a point cloud — a PLY or XYZ from the scanner — and clean it up: clear the pieces floating off the part, cut away what lies past a plane, and delete what you mark by hand. Each delete is one step Ctrl+Z takes back. Everything stays in this browser.',
    },
    // The marking is the workspace's own while it is open: shown always,
    // the gestures live only By hand.
    marking: onCloudTools && ready ? { color: CLOUD_MARK_COLOR, gestures: tool === 'hand' } : null,
    paintChange: () => onCloudTools,
    panel: (
      <CloudPanel
        onOpenScan={(f) => void host.openScan(f)}
        onDelete={() => void session.deleteMarked()}
        onClear={session.clearMarked}
      />
    ),
  }
}
