// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud Tools workspace's verbs, outside React — what the panel runs.
//
// Every tool marks: Floating pieces marks the pieces smaller than a share of
// the main body, Plane the points past a plane, By hand whatever the brush,
// window or lasso takes — all in the app's one marking, so what one found
// can be touched up by hand before it goes. Delete takes the marked points
// out of the cloud in the worker, writes what is left as a PLY in the
// scan's file frame, and swaps it in under the session with the scan's
// alignment, carrying everything measured across (remapScan,
// remeasureScan) — one step of the undo history, which puts the scan before
// back.
//
// Without a viewport (the tests) the marking is the last one a tool laid
// down; every scene call is optional.

import type { RefObject } from 'react'
import type { MeshWorkerClient } from '../../../src/core/workerClient'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { ImportQueue } from '../../../src/app/importQueue'
import type { ScanSource } from '../../../src/app/scanSwap'
import type { Vec3 } from '../../../src/core/types'
import { runImport } from '../../../src/app/imports'
import { onScan } from '../../../src/app/scanEvents'
import { identityRigid, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'
import { historyAsync, useHistory } from '../../../src/state/historyStore'
import { useMark } from '../../../src/state/markStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { CLOUD_TOOLS, type CloudToolsOps } from '../core/protocol'
import { useCloudTools } from '../state/cloudStore'
import { MemoryFile } from '../../../src/core/sourceFile'

/** The workspace's id. */
export const CLOUD_WORKSPACE = 'cloud'

/** Marked to go: the red every delete marking in the app is drawn in. */
export const CLOUD_MARK_COLOR = '#e8503a'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const count = (n: number) => n.toLocaleString('en-US')
const points = (n: number) => `${count(n)} point${n === 1 ? '' : 's'}`

/** Point → vertex of the cloud made of what was kept → the vertex the
 *  loaded scan made of it (a point without a usable normal goes, exact
 *  duplicates are one). -1 for gone. */
export function composeMaps(kept: Int32Array, loaded: Int32Array): Int32Array {
  const out = new Int32Array(kept.length)
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i]
    out[i] = k >= 0 && k < loaded.length ? loaded[k] : -1
  }
  return out
}

export interface CloudSessionDeps {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  imports: ImportQueue
  swapScanBuffers: (source: ScanSource, buffers: { positions: Float32Array; normals: Float32Array }, transform: Rigid | null) => Promise<Int32Array>
  remapScan: (vertexMap: Int32Array) => void
  remeasureScan: (refit: boolean) => Promise<void>
}

export type CloudSession = ReturnType<typeof createCloudSession>

export function createCloudSession({ clientRef, sceneRef, imports, swapScanBuffers, remapScan, remeasureScan }: CloudSessionDeps) {
  const call = <K extends keyof CloudToolsOps>(op: K, payload: CloudToolsOps[K]['payload']) =>
    clientRef.current!.pluginCall<CloudToolsOps[K]['result']>(CLOUD_TOOLS, op, payload)

  /** The marking without a viewport: the last a tool laid down. */
  let held: Uint32Array = new Uint32Array(0)
  /** Bumped by every marking asked for: an answer for an older one is dropped. */
  let asked = 0

  const setMarked = (vertices: Uint32Array) => {
    held = vertices
    const scene = sceneRef.current
    if (scene) {
      if (vertices.length === 0) scene.clearPaint()
      else scene.setPaintedVertices(vertices, CLOUD_MARK_COLOR)
    }
    useMark.getState().setCount(vertices.length)
  }

  /** What is marked to go now. */
  const marked = (): Uint32Array => sceneRef.current?.paintedVertices() ?? held

  const clearMarked = () => setMarked(new Uint32Array(0))

  /** Why nothing may start now, or null. `queue`: the import queue's work
   *  counts too. */
  const refusal = (queue = true): string | null => {
    const s = useStore.getState()
    if (!s.fileName) return 'Open a point cloud first.'
    if (!s.scanIsCloud) return 'Needs a point cloud — this scan is a mesh.'
    if (useCloudTools.getState().running) return 'Wait for the step in progress to finish.'
    if (s.busy || (queue && imports.busy) || useHistory.getState().restoring) return 'Wait for the work in progress to finish.'
    return null
  }

  /** Resolves once the import queue has let every job go. */
  const importsIdle = () =>
    new Promise<void>((resolve) => {
      if (!imports.busy) return resolve()
      const stop = imports.subscribe(() => {
        if (imports.busy) return
        stop()
        resolve()
      })
    })

  /** A marking may start now. `quiet`: the panel marking again on its own
   *  as a setting or the scan changes — a refusal then is no one's error,
   *  and it marks again once the work in the way is done. */
  const mayMark = (quiet: boolean): boolean => {
    const why = refusal()
    if (why && !quiet) useStore.getState().setError(why)
    return why === null
  }

  /** Start a marking: its number, or null when it was refused or overtaken
   *  while it waited. The panel marks again as the store stops being busy,
   *  but a read clears that flag just before the import queue lets it go,
   *  and nothing the panel watches changes after: a quiet marking that only
   *  the queue stands in the way of waits for it rather than being refused,
   *  or it would never be made. */
  const begin = async (quiet: boolean): Promise<number | null> => {
    if (quiet && imports.busy && refusal(false) === null) {
      const mine = ++asked
      await importsIdle()
      if (mine !== asked) return null
    }
    if (!mayMark(quiet)) return null
    return ++asked
  }

  /** Mark the pieces smaller than the panel's share of the main body.
   *  Resolves what was found, or null when it was refused, failed or
   *  overtaken by a newer marking. */
  const markFloating = async (percent = useCloudTools.getState().percent, { quiet = false } = {}) => {
    const mine = await begin(quiet)
    if (mine === null) return null
    try {
      const survey = await call('floating', { percent })
      if (mine !== asked) return null
      setMarked(survey.vertices)
      const { vertices, ...rest } = survey
      const found = { ...rest, percent, points: vertices.length }
      useCloudTools.getState().setFloating(found)
      return found
    } catch (e) {
      if (mine === asked) useStore.getState().setError(message(e))
      return null
    }
  }

  /** The plane the panel describes, in the frame shown. */
  const planeOf = (): { origin: Vec3; normal: Vec3 } => {
    const { axis, offset, side } = useCloudTools.getState()
    const origin = [...useStore.getState().modelCenter] as Vec3
    if (offset !== null) origin[axis] = offset
    const normal: Vec3 = [0, 0, 0]
    normal[axis] = side
    return { origin, normal }
  }

  /** Mark the points past the panel's plane. Resolves how many, or null. */
  const markPastPlane = async (plane = planeOf(), { quiet = false } = {}): Promise<number | null> => {
    const mine = await begin(quiet)
    if (mine === null) return null
    try {
      const { vertices } = await call('past-plane', plane)
      if (mine !== asked) return null
      setMarked(vertices)
      return vertices.length
    } catch (e) {
      if (mine === asked) useStore.getState().setError(message(e))
      return null
    }
  }

  /**
   * Take `vertices` (the marking, by default) out of the cloud — one step of
   * the history. Resolves true when the scan was changed; false when it was
   * refused or failed, which the status line says.
   */
  const deleteMarked = async (vertices: Uint32Array = marked()): Promise<boolean> => {
    useCloudTools.getState().setConfirming(false)
    const why = refusal()
    if (why) {
      useStore.getState().setError(why)
      return false
    }
    if (vertices.length === 0) {
      useStore.getState().setError('Nothing is marked to delete.')
      return false
    }
    asked++
    let done: { dropped: number; left: number } | null = null
    useCloudTools.getState().setRunning('Deleting the marked points…')
    try {
      await runImport(imports, 'Deleting the marked points…', async () => {
        // Loaded here, not with the workspace: the writer is an export
        // writer, fetched only when one is asked for.
        const { buildPointCloudPly } = await import('../../../src/core/exportPointCloud')
        await historyAsync('Cloud Tools: delete points', async () => {
          const s = useStore.getState()
          const alignment = s.appliedAlignment
          const out = await call('remove', { vertices, toFile: alignment ? rigidInvert(alignment) : identityRigid() })
          const fileName = s.fileName ?? 'scan'
          const name = `${fileName.replace(/\.[^.]+$/, '')}-cleaned.ply`
          // Written before the swap: the buffers are handed over to it.
          const file = new MemoryFile(new Uint8Array(buildPointCloudPly(out.positions, out.normals, null, `${fileName} cleaned up in ScanRuler`)), name)
          // units-ok: the file's own unit, an id — the cloud is written in mm.
          const loaded = await swapScanBuffers({ name, file, units: 'mm', scale: 1 }, { positions: out.positions, normals: out.normals }, alignment)
          remapScan(composeMaps(out.map, loaded))
          await remeasureScan(true)
          done = { dropped: out.dropped, left: useStore.getState().vertexCount }
        })
      })
    } catch (e) {
      useStore.getState().setError(message(e))
    } finally {
      useCloudTools.getState().setRunning(null)
    }
    if (!done) return false
    const d = done as { dropped: number; left: number }
    held = new Uint32Array(0)
    useCloudTools.getState().setFloating(null)
    useStore.getState().setStatus(`Deleted ${points(d.dropped)} — ${points(d.left)} left. Ctrl+Z puts them back.`)
    return true
  }

  /** Start what keeps the workspace in step with the session. The returned
   *  function stops it. */
  const watch = () => {
    const stops = [
      // A new scan, or another version of this one: what was found and
      // marked was of the points that went.
      onScan({
        loaded: () => {
          held = new Uint32Array(0)
          useCloudTools.getState().setFloating(null)
          useCloudTools.getState().setOffset(null)
        },
        swapped: () => {
          held = new Uint32Array(0)
          useCloudTools.getState().setFloating(null)
        },
      }),
      // Leaving the workspace leaves nothing marked behind it.
      useShell.subscribe((s, prev) => {
        if (prev.workspace === CLOUD_WORKSPACE && s.workspace !== CLOUD_WORKSPACE) {
          useCloudTools.getState().setConfirming(false)
          held = new Uint32Array(0)
          // A marking still waiting or out with the worker lands nowhere.
          asked++
        }
      }),
    ]
    return () => stops.forEach((s) => s())
  }

  return { markFloating, markPastPlane, planeOf, deleteMarked, marked, clearMarked, watch }
}

let installed: CloudSession | null = null

/** Make `session` the one the workspace's keys and busy check reach. */
export function installCloudSession(session: CloudSession): () => void {
  installed = session
  return () => {
    if (installed === session) installed = null
  }
}

export const cloudSession = (): CloudSession | null => installed

/** What the workspace's machinery is busy with, for registerBusy. */
export function cloudBusy(): string | null {
  const running = useCloudTools.getState().running
  return running ? running.replace(/…$/, '').toLowerCase() : null
}
