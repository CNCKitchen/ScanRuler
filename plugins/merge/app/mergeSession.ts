// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's verbs, outside React — what the panel's buttons run.
//
// A layer is a file opened beside the scan: staged as any import is
// (prepareScan), taken by the worker's Merge part under an id (add-layer),
// and drawn by the viewport's MergeScene in a colour of its own. Its pose —
// layer frame to the base as shown — lives in the store; a move or an
// alignment is one step of the undo history, which keeps the poses (and what
// is shown) and nothing else. An alignment runs in the worker, stoppable,
// with the panel busy meanwhile: nothing queues behind it, so the panel and
// the commands refuse what would swap the scan under it (registerBusy).
//
// Merge writes the base and the layers shown as one cloud in the base's
// file frame, swaps it in under the session with the base's alignment, and
// carries everything measured on the base across (remapScan, remeasureScan)
// — one step of the history. The worker drops its layers on any scan
// replaced but the workspace's own: merge-begin / undo-begin arm that for
// the next replacement, and *-end disarms it whatever happened. The main
// side keeps the same one-shot flag for the swapped event. A new scan, or
// leaving the workspace, drops the layers.
//
// useMergePlugin makes one session and draws from it; under a test it stands
// without a viewport — every scene call in it is optional.

import type { RefObject } from 'react'
import type { MeshWorkerClient } from '../../../src/core/workerClient'
import type { ElementKind, FitOutput, Vec3 } from '../../../src/core/types'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { ImportQueue } from '../../../src/app/importQueue'
import type { ScanSource } from '../../../src/app/scanSwap'
import { prepareScan, runImport } from '../../../src/app/imports'
import { onScan } from '../../../src/app/scanEvents'
import { boundLength } from '../../../src/app/useUnits'
import { buildPointCloudPly } from '../../../src/core/exportPointCloud'
import { creaseSetting } from '../../../src/core/geometry/crease'
import { cloneRigid, identityRigid, rigidCompose, rigidInvert, rigidRotate, type Rigid } from '../../../src/core/deviation/rigid'
import { is3mfFile } from '../../../src/core/formats'
import { fileScale, unitsLabel } from '../../../src/core/meshUnits'
import { historyAction, historyAsync, registerHistory, useHistory } from '../../../src/state/historyStore'
import { usePrefs } from '../../../src/state/prefsStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { MergeScene } from '../viewer/mergeScene'
import { BASE, MERGE, type AlignReply, type DatumIds, type MergeOps } from '../core/protocol'
import type { LayerAlignResult } from '../core/layerAlign'
import { LAYER_COLORS, layerRow, mergeDedupe, useMerge, type LayerRow, type LayerUnits } from '../state/mergeStore'

/** The question a merge onto a mesh asks first — exact, see the spec. */
export const MESH_BASE_CONFIRM = 'The result is a point cloud — triangle-only tools and their results go.'

/** The workspace's id. */
export const MERGE_WORKSPACE = 'merge'

const count = (n: number) => n.toLocaleString('en-US')
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const shown = () => boundLength(usePrefs.getState().units)

/** The factor a layer's file is multiplied by to millimetres: the units it
 *  is read in — a 3MF or a STEP says its own, and arrives in millimetres. */
export function layerScale(name: string, units: LayerUnits): number {
  return is3mfFile(name) ? 1 : fileScale(name, units)
}

export interface MergeSessionDeps {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  imports: ImportQueue
  /** Open a file as the scan — the first file with none open. */
  openScan: (file: File, units?: LayerUnits) => Promise<void>
  swapScanBuffers: (source: ScanSource, buffers: { positions: Float32Array; normals: Float32Array }, transform: Rigid | null) => Promise<void>
  remapScan: (vertexMap: Int32Array) => void
  remeasureScan: (refit: boolean) => Promise<void>
}

export type MergeSession = ReturnType<typeof createMergeSession>

export function createMergeSession({ clientRef, sceneRef, imports, openScan, swapScanBuffers, remapScan, remeasureScan }: MergeSessionDeps) {
  /** Each layer's file, read again when its units change. */
  const files = new Map<string, File>()
  /** Each layer's centre in its own frame, mm — what a change of units
   *  scales it about. */
  const centres = new Map<string, Vec3>()
  /** The layers the user has placed — moved, or aligned by pairs or datums
   *  — since they were opened: a refine from any other pose starts from no
   *  one's guess, and is never called confident. */
  const seeded = new Set<string>()
  let nextLayer = 1
  /** The next scan replacement is the workspace's own: its layers stay. */
  let ownSwap = false

  const call = <K extends keyof MergeOps>(op: K, payload: MergeOps[K]['payload']) =>
    clientRef.current!.pluginCall<MergeOps[K]['result']>(MERGE, op, payload)

  // ---- The viewport ---------------------------------------------------------------

  let scene: MergeScene | null = null
  let sceneFor: SceneManager | null = null
  let removeScene: (() => void) | null = null
  /** The layers' part of the viewport — made on first use; none without one. */
  const sceneOf = (): MergeScene | null => {
    const manager = sceneRef.current
    if (!manager) return null
    if (sceneFor !== manager) {
      removeScene?.()
      scene = new MergeScene(manager.layerHost())
      removeScene = manager.addLayer(scene)
      sceneFor = manager
    }
    return scene
  }

  // ---- Refusals ---------------------------------------------------------------------

  /** Why nothing may start now, or null. */
  const refusal = (): string | null => {
    if (useMerge.getState().running) return 'Wait for the alignment or the merge in progress to finish — or stop it.'
    if (useStore.getState().busy || imports.busy || useHistory.getState().restoring) return 'Wait for the work in progress to finish.'
    return null
  }
  const refused = (): boolean => {
    const why = refusal()
    if (why) useStore.getState().setError(why)
    return why !== null
  }

  const rowOf = (id: string): LayerRow => {
    const row = useMerge.getState().layers.find((l) => l.id === id)
    if (!row) throw new Error(`There is no layer "${id}".`)
    return row
  }

  // ---- Layers -----------------------------------------------------------------------

  /** Stage a file and hand it to the worker as layer `id`, `scale` to mm.
   *  Answers what the worker holds and a copy of its geometry. */
  const stageLayer = async (file: File, id: string, scale: number) => {
    const client = clientRef.current!
    const prepared = await prepareScan(client, null, file, creaseSetting(useStore.getState()), undefined, 'mm') // units-ok: read as is, add-layer scales it
    try {
      const added = await call('add-layer', { stagedId: prepared.id, id, scale })
      const geometry = await call('layer-geometry', { id })
      return { added, geometry }
    } finally {
      // Taken by add-layer when it went through; dropped here when it did not.
      await client.discardImport([prepared.id])
    }
  }

  /** The middle of a layer's bounding box. */
  const centreOf = (p: Float32Array): Vec3 => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        if (p[i + c] < lo[c]) lo[c] = p[i + c]
        if (p[i + c] > hi[c]) hi[c] = p[i + c]
      }
    }
    return p.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0]
  }

  /**
   * Open a file beside the scan, as a layer in `units` — or, with no scan
   * open, as the scan. Answers the layer's id (BASE for the scan); rejects
   * with the reason it could not be opened, which the status line says too.
   */
  const openLayer = async (file: File, units: LayerUnits): Promise<string> => {
    if (!useStore.getState().fileName) {
      await openScan(file, units)
      if (!useStore.getState().fileName) throw new Error(useStore.getState().errorText ?? `${file.name} could not be opened.`)
      return BASE
    }
    const why = refusal()
    if (why) {
      useStore.getState().setError(why)
      throw new Error(why)
    }
    const id = `L${nextLayer++}`
    let opened = false
    await runImport(imports, `Reading ${file.name} as a layer…`, async () => {
      const { added, geometry } = await stageLayer(file, id, layerScale(file.name, units))
      const used = new Set(useMerge.getState().layers.map((l) => l.color))
      const color = LAYER_COLORS.find((c) => !used.has(c)) ?? LAYER_COLORS[(nextLayer - 2) % LAYER_COLORS.length]
      files.set(id, file)
      centres.set(id, centreOf(geometry.positions))
      seeded.delete(id)
      sceneOf()?.add(id, { ...geometry, spacing: added.spacing }, color)
      useMerge.getState().addLayer(layerRow(id, file.name, color, units, added))
      useStore
        .getState()
        .setStatus(
          `Opened ${file.name} as a layer — ${count(added.vertexCount)} ${added.isCloud ? 'points' : 'vertices'}. Move it near its place, or align it by pairs or datums, then refine.`,
        )
      opened = true
    })
    if (!opened) throw new Error(useStore.getState().errorText ?? `${file.name} could not be opened as a layer.`)
    return id
  }

  /** The layer gone from here, the viewport and — unless it is gone there
   *  already — the worker. */
  const forget = (id: string) => {
    sceneOf()?.remove(id)
    useMerge.getState().removeLayer(id)
    files.delete(id)
    centres.delete(id)
    seeded.delete(id)
  }

  const removeLayer = async (id: string): Promise<void> => {
    rowOf(id)
    if (refused()) return
    await call('remove-layer', { id })
    forget(id)
  }

  /** Every layer dropped: `inWorker` when the worker still holds them. */
  const dropLayers = (inWorker: boolean) => {
    const ids = useMerge.getState().layers.map((l) => l.id)
    if (ids.length === 0) return
    if (inWorker && clientRef.current) for (const id of ids) void call('remove-layer', { id }).catch(() => {})
    sceneOf()?.clear()
    useMerge.getState().clearLayers()
    files.clear()
    centres.clear()
    seeded.clear()
  }

  /** A layer read again in other units: removed and added again, scaled
   *  about its centre so it stays where it was laid. */
  const changeUnits = async (id: string, units: LayerUnits): Promise<void> => {
    const row = rowOf(id)
    const file = files.get(id)
    if (!file || row.units === units) return
    if (refused()) return
    const k = layerScale(file.name, units) / layerScale(file.name, row.units)
    await runImport(imports, `Reading ${row.name} again in ${unitsLabel(units).toLowerCase()}…`, async () => {
      await call('remove-layer', { id })
      let staged
      try {
        staged = await stageLayer(file, id, layerScale(file.name, units))
      } catch (e) {
        // The worker has let it go: so does everything else.
        forget(id)
        throw e
      }
      // The centre c stays where the pose put it: R(k c) + t' = R c + t.
      const c = centres.get(id) ?? [0, 0, 0]
      const rc = new Float64Array(3)
      rigidRotate(row.pose, c[0], c[1], c[2], rc)
      const pose = cloneRigid(row.pose)
      for (let i = 0; i < 3; i++) pose.t[i] += (1 - k) * rc[i]
      centres.set(id, [c[0] * k, c[1] * k, c[2] * k])
      const view = sceneOf()
      view?.add(id, { ...staged.geometry, spacing: staged.added.spacing }, row.color)
      view?.setPose(id, pose)
      view?.setVisible(id, row.visible)
      useMerge.getState().patchLayer(id, { units, pose, vertexCount: staged.added.vertexCount, spacing: staged.added.spacing, isCloud: staged.added.isCloud, last: undefined })
      // Its fits went with it in the worker.
      useMerge.getState().clearDatums(id)
      useStore.getState().setStatus(`${row.name} is read in ${unitsLabel(units).toLowerCase()} now, scaled about its centre.`)
    })
  }

  /** A layer's colour, visibility, lock or units. */
  const setLayer = async (id: string, patch: Partial<Pick<LayerRow, 'color' | 'visible' | 'units' | 'locked'>>): Promise<void> => {
    rowOf(id)
    const { units, ...rest } = patch
    if (Object.keys(rest).length > 0) useMerge.getState().patchLayer(id, rest)
    if (units !== undefined) await changeUnits(id, units)
  }

  // ---- Moving and aligning ----------------------------------------------------------

  const lockedNote = (row: LayerRow) => useStore.getState().setStatus(`${row.name} is locked — unlock it to move it.`)

  /** Put a layer at `pose`, as one step of the history. False for a locked
   *  layer, which stays. */
  const moveLayer = (id: string, pose: Rigid): boolean => {
    const row = rowOf(id)
    if (row.locked) {
      lockedNote(row)
      return false
    }
    historyAction('Merge: move layer', () => useMerge.getState().setPose(id, pose))
    useMerge.getState().patchLayer(id, { last: undefined })
    seeded.add(id)
    return true
  }

  /** The pose of `target` — the base, or a layer — in the base as shown. */
  const targetPose = (target: string): Rigid => (target === BASE ? identityRigid() : rowOf(target).pose)

  /** An alignment run in the worker and, when it lands, the layer put
   *  there as one step of the history. The worker answers the pose into the
   *  target's frame; a layer target's pose carries it on to the base. */
  const align = async (id: string, target: string, label: string, run: () => Promise<AlignReply>, seeds: boolean): Promise<LayerAlignResult | null> => {
    const row = rowOf(id)
    if (target !== BASE) rowOf(target)
    if (row.locked) {
      lockedNote(row)
      return null
    }
    if (refused()) return null
    useMerge.getState().setRunning('Aligning the layer…')
    useStore.getState().setStatus(`Aligning ${row.name}…`)
    let reply: AlignReply
    try {
      reply = await run()
    } catch (e) {
      useStore.getState().setError(message(e))
      return null
    } finally {
      useMerge.getState().setRunning(null)
    }
    if ('stopped' in reply) {
      useStore.getState().setStatus(`Stopped — ${row.name} stays where it was.`)
      return null
    }
    if ('refused' in reply) {
      useStore.getState().setError(reply.refused)
      return null
    }
    // The layers went meanwhile — a new scan, the workspace left.
    const gone = (l: string) => l !== BASE && !useMerge.getState().layers.some((r) => r.id === l)
    if (gone(id) || gone(target)) return null
    const pose = rigidCompose(targetPose(target), reply.pose)
    historyAction(`Merge: ${label}`, () => useMerge.getState().setPose(id, pose))
    const result: LayerAlignResult = { ...reply, pose }
    useMerge.getState().patchLayer(id, { last: result })
    if (seeds) seeded.add(id)
    const len = shown()
    const pct = `${(reply.matched * 100).toFixed(1)} %`
    useStore
      .getState()
      .setStatus(
        reply.lowOverlap
          ? `Low overlap — only ${pct} of ${row.name} found its target (RMS ${len.fmt(reply.rms, 3)}). Check the result before merging.`
          : reply.confident
            ? `${row.name} aligned — RMS ${len.fmt(reply.rms, 3)}, ${pct} of it on its target. Ctrl+Z puts it back.`
            : `${row.name} aligned from a start nobody chose — RMS ${len.fmt(reply.rms, 3)}, ${pct} on its target. It may have settled in a wrong pose: check it, or place it first and refine again.`,
      )
    return result
  }

  /** Lay a layer on its target from picked pairs: points on the layer, in
   *  its frame, and the same points on the target, in the target's. */
  const alignPairs = (id: string, target: string, pairs: { layer: Vec3; target: Vec3 }[]) =>
    align(id, target, 'align layer by pairs', () => call('align-pairs', { id, target, pairs }), true)

  /** Lay a layer on its target by datums fitted on both (fitDatum). */
  const alignDatums = (id: string, target: string, layer: DatumIds, targetDatums: DatumIds) =>
    align(id, target, 'align layer by datums', () => call('align-datums', { id, target, layer, targetDatums }), true)

  /** Refine a layer onto its target from where it stands. */
  const refine = (id: string, target: string) => {
    const start = rigidCompose(rigidInvert(targetPose(target)), rowOf(id).pose)
    return align(id, target, 'refine layer', () => call('refine', { id, target, start, fromUserGuess: seeded.has(id) }), false)
  }

  /** A datum fitted on a layer or on the base (BASE) from picked vertices of
   *  it — kept by the worker for alignDatums, never a session element.
   *  Null when it could not be fitted, which the status line says. */
  const fitDatum = async (side: string, elementType: ElementKind, seeds: number[]): Promise<{ fitId: number; fit: FitOutput } | null> => {
    if (side !== BASE) rowOf(side)
    if (refused()) return null
    useMerge.getState().setRunning('Fitting the datum…')
    try {
      const r = await call('fit', { id: side, elementType, seeds, settings: useStore.getState().settings })
      if (side === BASE || useMerge.getState().layers.some((l) => l.id === side)) useMerge.getState().addDatum(side, { fitId: r.fitId, kind: elementType })
      return r
    } catch (e) {
      useStore.getState().setError(message(e))
      return null
    } finally {
      useMerge.getState().setRunning(null)
    }
  }

  /** Stop the alignment running. */
  const stop = () => clientRef.current?.abortAlign()

  // ---- The question a mesh base asks ---------------------------------------------------

  let answer: ((yes: boolean) => void) | null = null
  const ask = (text: string) =>
    new Promise<boolean>((resolve) => {
      answer?.(false)
      answer = resolve
      useMerge.getState().setConfirming(text)
    })
  /** The panel's yes or no to the question on screen. */
  const answerConfirm = (yes: boolean) => {
    const a = answer
    answer = null
    useMerge.getState().setConfirming(null)
    a?.(yes)
  }

  // ---- Merge ------------------------------------------------------------------------

  /**
   * The base and the layers shown, as one cloud put in place of the scan
   * under everything measured on it — one step of the history. A mesh base
   * asks first. `dedupe`: a layer point within this of one kept before it
   * goes, mm; null keeps every point. True when it went through.
   */
  const merge = async ({ dedupe }: { dedupe: number | null }): Promise<boolean> => {
    if (refused()) return false
    const visible = useMerge.getState().layers.filter((l) => l.visible)
    if (visible.length === 0) {
      useStore.getState().setError('Show at least one layer to merge — the hidden ones are left out.')
      return false
    }
    if (!useStore.getState().scanIsCloud && !(await ask(MESH_BASE_CONFIRM))) return false
    if (refused()) return false
    let merged: { points: number; dropped: number } | null = null
    useMerge.getState().setRunning('Merging the layers…')
    try {
      await runImport(imports, 'Merging the layers…', async () => {
        await historyAsync('Merge: merge layers', async () => {
          await call('merge-begin', null)
          ownSwap = true
          try {
            const s = useStore.getState()
            const alignment = s.appliedAlignment
            const out = await call('merge', {
              poses: Object.fromEntries(visible.map((l) => [l.id, l.pose])),
              visible: visible.map((l) => l.id),
              // Into the base's file frame, at the size it is read at: the
              // swap puts the alignment back on, and the app has scaled it
              // on load already.
              toFile: alignment ? rigidInvert(alignment) : identityRigid(),
              scale: 1,
              dedupe,
            })
            const base = (s.fileName ?? 'scan').replace(/\.[^.]+$/, '')
            const name = `${base}-merged.ply`
            // Written before the swap: the buffers are handed over to it.
            const file = new File([buildPointCloudPly(out.positions, out.normals, null, `${s.fileName ?? 'scan'} merged with ${visible.length} layer${visible.length === 1 ? '' : 's'} in ScanRuler`)], name)
            const dropped = out.dropped
            // units-ok: the file's own unit, an id — the cloud is written in mm.
            await swapScanBuffers({ name, file, units: 'mm', scale: 1 }, { positions: out.positions, normals: out.normals }, alignment)
            // Points laid exactly on one another are one point of the scan.
            const points = useStore.getState().vertexCount
            remapScan(out.baseMap)
            useMerge.setState((m) => ({ merges: m.merges + 1, layers: m.layers.map((l) => ({ ...l, visible: false })) }))
            await remeasureScan(true)
            merged = { points, dropped }
          } finally {
            ownSwap = false
            await call('merge-end', null)
          }
        })
      })
    } finally {
      useMerge.getState().setRunning(null)
    }
    if (!merged) return false
    const m = merged as { points: number; dropped: number }
    useStore
      .getState()
      .setStatus(
        `Merged ${visible.length} layer${visible.length === 1 ? '' : 's'} into the scan — ${count(m.points)} points${m.dropped > 0 ? `, ${count(m.dropped)} dropped as doubles` : ''}. The layers are hidden; Ctrl+Z goes back to the scan before.`,
      )
    return true
  }

  /** What the panel's Merge runs: the dedupe the panel shows. */
  const mergeShown = () => merge({ dedupe: mergeDedupe(useMerge.getState()) })

  // ---- Keeping in step ----------------------------------------------------------------

  /** Start what keeps the workspace in step with the session: the
   *  viewport with the store, the poses with a baked move of the base, the
   *  layers with the scan, and the history's steps across a merge with the
   *  worker. The returned function stops it. */
  const watch = () => {
    const stops = [
      // The viewport draws what the store says — a step of the history
      // included.
      useMerge.subscribe((s, prev) => {
        const view = sceneOf()
        if (!view || s.layers === prev.layers) return
        for (const l of s.layers) {
          const was = prev.layers.find((p) => p.id === l.id)
          if (!was) continue
          if (was.pose !== l.pose) view.setPose(l.id, l.pose)
          if (was.visible !== l.visible) view.setVisible(l.id, l.visible)
          if (was.color !== l.color) view.setColor(l.id, l.color)
        }
      }),
      // An alignment baked into the base moves what was laid on it: the
      // poses are relative to the base as shown. The viewport's layer does
      // the same of itself (MergeScene.partMoved).
      useStore.subscribe((s, prev) => {
        if (s.appliedAlignment === prev.appliedAlignment) return
        const layers = useMerge.getState().layers
        if (layers.length === 0) return
        const delta = rigidCompose(s.appliedAlignment ?? identityRigid(), rigidInvert(prev.appliedAlignment ?? identityRigid()))
        useMerge.setState({ layers: layers.map((l) => ({ ...l, pose: rigidCompose(delta, l.pose) })) })
      }),
      onScan({
        // Another part: its layers go — the worker has dropped them.
        loaded: () => dropLayers(false),
        swapped: () => {
          // The worker's fits on the base were of the vertices that went.
          useMerge.getState().clearDatums(BASE)
          if (ownSwap) ownSwap = false
          else dropLayers(false)
        },
      }),
      // Leaving the workspace puts the layers away for good.
      useShell.subscribe((s, prev) => {
        if (prev.workspace === MERGE_WORKSPACE && s.workspace !== MERGE_WORKSPACE) dropLayers(true)
      }),
      registerHistory({
        blocked: () => useMerge.getState().running !== null,
        // A step across a merge re-swaps the scan: the layers stay for it.
        aroundRestore: async (patch, restore) => {
          const value = patch[MERGE] as { merges?: number } | undefined
          const crosses = value !== undefined && value.merges !== useMerge.getState().merges && 'scan' in patch && clientRef.current !== null
          if (!crosses) return restore()
          await call('undo-begin', null)
          ownSwap = true
          try {
            await restore()
          } finally {
            ownSwap = false
            await call('undo-end', null)
          }
        },
      }),
    ]
    return () => {
      stops.forEach((s) => s())
      removeScene?.()
      removeScene = null
      scene = null
      sceneFor = null
    }
  }

  return {
    clientRef,
    sceneRef,
    sceneOf,
    openLayer,
    removeLayer,
    setLayer,
    moveLayer,
    alignPairs,
    fitDatum,
    alignDatums,
    refine,
    merge,
    mergeShown,
    stop,
    answerConfirm,
    dropLayers,
    layers: (): LayerRow[] => useMerge.getState().layers,
    watch,
  }
}

let installed: MergeSession | null = null

/** Make `session` the one the workspace's busy check stops through. The
 *  returned function takes it away again. */
export function installMergeSession(session: MergeSession): () => void {
  installed = session
  return () => {
    if (installed === session) installed = null
  }
}

/** The session installed, or null with none. */
export const mergeSession = (): MergeSession | null => installed

/** What the workspace's machinery is busy with, for registerBusy. */
export function mergeBusy(): string | null {
  const running = useMerge.getState().running
  return running ? running.replace(/…$/, '').toLowerCase() : null
}
