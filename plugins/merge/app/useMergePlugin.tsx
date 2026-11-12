// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's part in the app, for one render: the session's verbs
// (mergeSession.ts) on the panel's keys, the handle on the layer being
// moved, and the clicks that pick pairs and fit datums — on the scan through
// the app's pick, on a layer through a viewport layer of the workspace's own
// ahead of the layers' drawing — see src/plugins/api.ts.

import { useEffect, useRef, useState } from 'react'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { meshUnitsFor } from '../../../src/state/unitsPromptStore'
import type { Vec3 } from '../../../src/core/types'
import type { PickHit, SceneManager } from '../../../src/viewer/SceneManager'
import type { SceneLayer } from '../../../src/viewer/sceneLayers'
import { BASE } from '../core/protocol'
import { useMerge, type LayerUnits } from '../state/mergeStore'
import { MergePanel } from '../ui/MergePanel'
import { createMergeSession, installMergeSession, MERGE_WORKSPACE, type MergeSession } from './mergeSession'

/** The vertex of a hit nearest where it landed. */
const vertexOf = (hit: Pick<PickHit, 'vertices' | 'weights'>): number => {
  let best = 0
  for (let i = 1; i < hit.vertices.length; i++) if (hit.weights[i] > hit.weights[best]) best = i
  return hit.vertices[best]
}

/** A click on a side — BASE or a layer — while Pairs or Datums is in hand:
 *  a point of a pair, or a datum fitted there. Hits are in that side's own
 *  frame, as the worker takes them. */
function pickOn(session: MergeSession, side: string, point: Vec3, vertex: number): boolean {
  const m = useMerge.getState()
  const layer = m.selected
  if (!layer || (m.tool !== 'pairs' && m.tool !== 'datums') || m.running || m.confirming) return false
  if (side !== layer && side !== m.target) return false
  if (m.tool === 'pairs') {
    const last = m.pairs.at(-1)
    if (side === layer) {
      // A layer point starts a pair, or puts right the one waiting.
      m.setPairs(last && last.target === null ? [...m.pairs.slice(0, -1), { layer: point, target: null }] : [...m.pairs, { layer: point, target: null }])
    } else if (last && last.target === null) {
      m.setPairs([...m.pairs.slice(0, -1), { ...last, target: point }])
    } else {
      useStore.getState().setStatus('Click the point on the layer first, then the same point on the target.')
    }
    return true
  }
  void session.fitDatum(side, m.datumKind, [vertex])
  return true
}

/** The workspace's clicks on its layers: ahead of the layers' drawing, and
 *  only while a pick is wanted. */
function layerClicks(session: MergeSession): SceneLayer {
  return {
    order: 19,
    click(clientX, clientY) {
      const m = useMerge.getState()
      if (useShell.getState().workspace !== MERGE_WORKSPACE || !m.selected || (m.tool !== 'pairs' && m.tool !== 'datums')) return false
      const scene = session.sceneOf()
      const manager = session.sceneRef.current
      if (!scene || !manager) return false
      const rect = manager.layerHost().canvasRect()
      const x = ((clientX - rect.left) / rect.width) * 2 - 1
      const y = -((clientY - rect.top) / rect.height) * 2 + 1
      const ids = [m.selected, ...(m.target !== BASE ? [m.target] : [])]
      const hit = scene.pick(x, y, ids)
      if (!hit) return false
      return pickOn(session, hit.layerId, hit.point, vertexOf(hit))
    },
    dispose() {},
  }
}

export function useMergePlugin(host: PluginHost): PluginRuntime {
  const [session] = useState(() =>
    createMergeSession({
      clientRef: host.clientRef,
      sceneRef: host.sceneRef,
      imports: host.imports,
      openScan: host.openScan,
      swapScanBuffers: host.swapScanBuffers,
      remapScan: host.remapScan,
      remeasureScan: host.remeasureScan,
    }),
  )
  useEffect(() => installMergeSession(session), [session])
  useEffect(() => session.watch(), [session])

  const onMerge = useShell((s) => s.workspace === MERGE_WORKSPACE)
  const selected = useMerge((s) => s.selected)
  const tool = useMerge((s) => s.tool)
  const gizmoMode = useMerge((s) => s.gizmoMode)
  const locked = useMerge((s) => s.layers.find((l) => l.id === s.selected)?.locked ?? true)
  const running = useMerge((s) => s.running !== null || s.confirming !== null)

  // The clicks on the layers, once there is a viewport — looked for on
  // every render, as the viewport comes after the first.
  const clicks = useRef<{ manager: SceneManager | null; remove: (() => void) | null }>({ manager: null, remove: null })
  useEffect(() => {
    const manager = host.sceneRef.current
    if (!manager || clicks.current.manager === manager) return
    clicks.current.remove?.()
    clicks.current = { manager, remove: manager.addLayer(layerClicks(session)) }
  })
  useEffect(() => () => clicks.current.remove?.(), [])

  // The handle on the layer being moved; a locked layer gets none.
  const handle = onMerge && tool === 'move' && selected !== null && !locked && !running ? selected : null
  useEffect(() => {
    session.setGizmo(handle, gizmoMode)
    return () => session.setGizmo(null)
  }, [handle, gizmoMode, session])

  /** A file the panel was handed, in the units it is read in — an STL asks. */
  const unitsOf = (file: File): Promise<LayerUnits | null> => meshUnitsFor(file.name)

  const openLayer = async (file: File) => {
    // No scan yet: the file is the scan, opened as the app opens one — in
    // any units it reads.
    if (!useStore.getState().fileName) {
      await host.openScan(file)
      return
    }
    const units = await unitsOf(file)
    if (units) await session.openLayer(file, units).catch(() => {})
  }

  const selectedLayer = () => {
    const m = useMerge.getState()
    return m.selected ? { id: m.selected, target: m.target } : null
  }

  return {
    // A click on the scan: a point of a pair or a datum on the base.
    pick: (hit) => void pickOn(session, BASE, hit.point, vertexOf(hit)),
    startPane: {
      title: 'Merging scan passes',
      blurb:
        'Open a scan, then the other passes of the same part beside it — point clouds or meshes. Lay each on the scan by hand, by picked point pairs or by datums, refine it, and merge them all into one point cloud to measure. Everything stays in this browser.',
    },
    panel: (
      <MergePanel
        onOpenScan={(f) => void host.openScan(f)}
        onOpenLayer={(f) => void openLayer(f)}
        onSetLayer={(id, patch) => void session.setLayer(id, patch).catch(() => {})}
        onRemoveLayer={(id) => void session.removeLayer(id).catch((e) => useStore.getState().setError(e instanceof Error ? e.message : String(e)))}
        onMove={(t) => {
          const s = selectedLayer()
          if (!s) return
          const row = useMerge.getState().layers.find((l) => l.id === s.id)!
          session.moveLayer(s.id, { r: row.pose.r.slice(), t: Float64Array.from(t) })
        }}
        onAlignPairs={() => {
          const s = selectedLayer()
          if (!s) return
          const pairs = useMerge.getState().pairs.flatMap((p) => (p.target ? [{ layer: p.layer, target: p.target }] : []))
          void session.alignPairs(s.id, s.target, pairs).then((r) => r && useMerge.getState().setPairs([]))
        }}
        onAlignDatums={() => {
          const s = selectedLayer()
          if (!s) return
          const d = useMerge.getState().datums
          const own = d[s.id] ?? []
          const theirs = d[s.target] ?? []
          const ids = (list: typeof own) => ({ primary: list[0].fitId, secondary: list[1]?.fitId ?? null, origin: list[2]?.fitId ?? null })
          void session.alignDatums(s.id, s.target, ids(own), ids(theirs))
        }}
        onRefine={() => {
          const s = selectedLayer()
          if (s) void session.refine(s.id, s.target)
        }}
        onAutoAlign={() => {
          const s = selectedLayer()
          if (s) void session.autoAlign(s.id, s.target)
        }}
        onStop={session.stop}
        onMerge={() => void session.mergeShown()}
        onConfirm={session.answerConfirm}
      />
    ),
  }
}
