// SPDX-License-Identifier: AGPL-3.0-only
// The Merge session for its tests: the app's headless session on the real
// worker (tests/commandKit), the plugin installed, the undo history wired to
// the session as the app wires it (projectHistoryHooks), and a merge session
// on top — what useMergePlugin does in the browser, minus the viewport.

import { buildPointCloudPly } from '../../../src/core/exportPointCloud'
import { configureHistory, installHistory } from '../../../src/state/historyStore'
import { projectHistoryHooks } from '../../../src/app/useProjectHistory'
import { rigidApply, rigidCompose, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import type { Vec3 } from '../../../src/core/types'
import { applyRigidCloud, blockWithBoreCloud, halves, rigidOf, type Cloud } from '../../../tests/cloudFixtures'
import { startHeadless, type Headless } from '../../../tests/commandKit'
import plugin from '../plugin'
import { createMergeSession, installMergeSession, type MergeSession } from '../app/mergeSession'
import type { MergeOps } from '../core/protocol'
import type { SceneManager } from '../../../src/viewer/SceneManager'

let installed = false

export interface MergeKit {
  headless: Headless
  merge: MergeSession
  /** A Merge worker operation, straight. */
  call<K extends keyof MergeOps>(op: K, payload: MergeOps[K]['payload']): Promise<MergeOps[K]['result']>
  stop(): void
}

/** `sceneRef`: a viewport for the merge session alone — the app's session
 *  stands without one. */
export async function startMerge(sceneRef?: { current: SceneManager | null }): Promise<MergeKit> {
  const headless = await startHeadless()
  if (!installed) {
    plugin.install!()
    installed = true
  }
  const s = headless.session
  const unconfigure = configureHistory(
    projectHistoryHooks(() => ({
      clientRef: s.clientRef,
      sceneRef: s.sceneRef,
      elementScope: s.maps.elementScope,
      deviation: s.maps.deviation,
      deviationRgb: s.maps.deviationRgb,
      referenceMap: s.maps.referenceMap,
      referenceRgb: s.maps.referenceRgb,
      thickness: s.maps.thickness,
      thicknessRgb: s.maps.thicknessRgb,
      imports: s.imports,
      sources: s.sources,
      runFit: s.measure.runFit,
      runDeviation: s.deviation.runDeviation,
      runThickness: s.thickness.runThickness,
      swapScan: s.swap.swapScan,
      remeasureScan: s.swap.remeasureScan,
    })),
  )
  const uninstall = installHistory()
  const merge = createMergeSession({
    clientRef: s.clientRef,
    sceneRef: sceneRef ?? s.sceneRef,
    imports: s.imports,
    openScan: (file, units) => s.scan.openScan(file, units),
    swapScanBuffers: s.swap.swapScanBuffers,
    remapScan: s.swap.remapScan,
    remeasureScan: s.swap.remeasureScan,
  })
  const unwatch = merge.watch()
  const uninstallSession = installMergeSession(merge)
  return {
    headless,
    merge,
    call: (op, payload) => s.clientRef.current!.pluginCall('merge', op, payload),
    stop() {
      uninstallSession()
      unwatch()
      uninstall()
      unconfigure()
      headless.stop()
    },
  }
}

/** A cloud as a PLY file. */
export const plyFile = (c: Cloud, name: string) => new File([buildPointCloudPly(c.positions, c.normals, null, name)], name)

/** The part in its own frame: the base is the half at +x, the layer the half
 *  at -x scanned in a frame TRUE off, so the pose that lays it on the base
 *  is POSE = TRUE^-1. The halves overlap by 16 mm. */
export const block = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step: 1 })
export const [lo, hi] = halves(block, 0, 16)
export const TRUE = rigidOf([12, -7, 20], [5, -3, 8])
export const POSE = rigidInvert(TRUE)
export const layerPart = applyRigidCloud(lo, TRUE)

/** A start a few degrees and millimetres off `pose`. */
export const nudged = (pose: Rigid) => rigidCompose(rigidOf([3, -2, 4], [1.5, -1, 2]), pose)

/** Rotation (degrees) and largest displacement over `c` (mm) between two poses. */
export function delta(a: Rigid, b: Rigid, c: Cloud = layerPart): { deg: number; mm: number } {
  const p = new Float64Array(3), q = new Float64Array(3)
  let mm = 0
  for (let i = 0; i < c.positions.length; i += 3) {
    rigidApply(a, c.positions[i], c.positions[i + 1], c.positions[i + 2], p)
    rigidApply(b, c.positions[i], c.positions[i + 1], c.positions[i + 2], q)
    mm = Math.max(mm, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
  }
  return { deg: (rigidRotationAngle(rigidCompose(rigidInvert(b), a)) * 180) / Math.PI, mm }
}

/** `p` moved by `m`. */
export const moved = (m: Rigid, p: Vec3): Vec3 => {
  const out = new Float64Array(3)
  rigidApply(m, p[0], p[1], p[2], out)
  return [out[0], out[1], out[2]]
}

/** The index of the point of `positions` nearest `at`. */
export function nearest(positions: Float32Array, at: Vec3): number {
  let best = -1, d = Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const e = Math.hypot(positions[i] - at[0], positions[i + 1] - at[1], positions[i + 2] - at[2])
    if (e < d) {
      d = e
      best = i / 3
    }
  }
  return best
}
