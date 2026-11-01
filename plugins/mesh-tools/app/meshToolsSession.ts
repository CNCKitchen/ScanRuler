// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace's verbs, outside React — what the panel's buttons
// and the workspace's commands (meshCommands.ts) both run.
//
// Reduce mesh makes something beside the scan: the scan reduced for CAD, which
// lives in the scene where it moves with the scan through every alignment,
// its deviation field in refs kept here because the hover reading reads it
// too. So does Trim to scan: a body cut to fit the scan's break, the break
// found and marked on the part to be put right by hand first. Remove islands,
// Delete marked, Flip normals, Cut, Fill holes, Smooth, Shrink / expand,
// Boolean and Shell edit a copy of the scan: the first edit makes it, the worker hands back the
// copy as it is to be, it is kept as a file and loaded beside the scan — the
// worker's and the viewport's, which shows it in the scan's place while Mesh
// Tools is open. Every other workspace goes on measuring the scan as it was.
// Use for analysis takes the copy into use: it is loaded in place of the scan
// under everything measured on it. Each edit, and taking the copy into use, is
// one step of the undo history; a step back loads the file from before it the
// same way, which is why the swaps are here for the history to call as well.
//
// useMeshPlugin makes one session and draws from it; under a test it stands
// without a viewport — every scene call in it is optional.

import type { RefObject } from 'react'
import { meshSceneOf } from '../viewer/meshScene'
import type { MeshWorkerClient } from '../../../src/core/workerClient'
import type { Vec3 } from '../../../src/core/types'
import { meshToolsOf } from '../core/meshClient'
import { MESH_TOOLS, type ScanEditRequest, type ScanEdited, type TrimBody } from '../core/protocol'
import { rigidApplyToPoints, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'
import { composeVertexMaps, summarizeCopyDeviation } from '../core/edit'
import type { BooleanTool } from '../core/boolean'
import type { TrimReport } from '../core/trimToScan'
import { buildBinaryPly } from '../core/plyWriter'
import { cutPlaneOf } from '../core/cutPlane'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { useStore } from '../../../src/state/store'
import { useShell } from '../../../src/state/shellStore'
import { useMark } from '../../../src/state/markStore'
import { historyAsync, historyBlocked, registerHistory } from '../../../src/state/historyStore'
import { reduceSettingsOf, useMeshTools, type ScanEdit } from '../state/meshStore'
import type { ImportQueue } from '../../../src/app/importQueue'
import { runImport } from '../../../src/app/imports'
import type { SourceFiles } from '../../../src/app/project'
import { editedCopy, editedCopyBytes, type EditedCopy } from '../state/editedCopy'
import type { ScanSource } from '../../../src/app/scanSwap'
import { onScan } from '../../../src/app/scanEvents'
import { meanEdgeLength } from '../core/smooth'
import type { OfferedSolid, SolidMesh } from '../../../src/app/solids'
import { booleanSolids, namesOf } from './booleanSolids'
import { creaseSetting } from '../../../src/core/geometry/crease'
import type { ReduceReport } from '../core/reduce'
import { boundLength } from '../../../src/app/useUnits'
import type { DisplayUnits } from '../../../src/core/units'
import { typedLen } from '../ui/meshFormat'

const count = (n: number) => n.toLocaleString('en-US')
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What mending a moved surface did, for the status line: the points
 *  merged where it closed up on itself — a strip beside an edge, a fold —
 *  and those eased where it would have folded. */
function mended(merged: number, eased: number, what: string): string {
  const parts = [
    merged > 0 ? `${count(merged)} point${merged === 1 ? '' : 's'} merged where ${what} closed up on itself` : '',
    eased > 0 ? `${count(eased)} eased where it would have folded` : '',
  ].filter(Boolean)
  return parts.length ? ` ${parts.join(', ')}.` : ''
}

/** The chord a solid is meshed to for a boolean, mm: the one Compare in
 *  Deviation meshes bodies to, a bore's wall within a hundredth of its
 *  round. */
const BOOLEAN_CHORD_MM = 0.01

/** How an edit is run: by the panel — a step of the undo history of its
 *  own, refused while anything is open that the copy would change under —
 *  or inside a step a command opened, which checked that before it did. */
export interface EditRun {
  inStep?: boolean
  /** The units the status line gives its lengths in: the panel passes the
   *  ones on screen; a command leaves them, and its answer is in mm. What is
   *  kept of the edit is in mm either way. */
  units?: DisplayUnits
}

/** The lengths of a status line, in the units a run asked for: mm unless
 *  asked. */
const lengthsOf = (units: DisplayUnits = 'mm') => boundLength(units)

/** What an edit that landed did: the line in the list of edits, the status
 *  line, and the worker's report. */
export interface EditLanded {
  edit: ScanEdit
  status: string
  report: ScanEdited['report'] | { kind: 'pieces'; survey: { pieces: number; islands: number; islandTriangles: number } }
}

/** A piece Trim to scan made: its report, and the body it was cut of. */
export interface TrimLanded {
  report: TrimReport
  name: string
  status: string
}

export type MeshToolsSession = ReturnType<typeof createMeshToolsSession>

export function createMeshToolsSession({
  clientRef,
  sceneRef,
  sources,
  imports,
  swapScan,
  remapScan,
  remeasureScan,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  sources: RefObject<SourceFiles>
  imports: ImportQueue
  swapScan: (source: ScanSource, transform: Rigid | null) => Promise<void>
  remapScan: (vertexMap: Int32Array) => void
  remeasureScan: (refit: boolean) => Promise<void>
}) {
  // How far the reduced mesh strays from each scan vertex, and how far the
  // edited copy is from the scan in use at each of the copy's vertices, with
  // their paint. The reduced mesh itself lives in the scene, where it moves
  // with the scan.
  const reduceField: { current: Float32Array | null } = { current: null }
  const reduceRgb: { current: Uint8Array | null } = { current: null }
  const copyField: { current: Float32Array | null } = { current: null }
  const copyRgb: { current: Uint8Array | null } = { current: null }

  const tools = () => meshToolsOf(clientRef.current!)

  // ---- Reduce mesh ------------------------------------------------------------

  /** Reduce the scan as the panel says. The report when a result landed;
   *  null when it failed — the store says why — or the mesh changed under
   *  it. */
  const reduce = async (units: DisplayUnits = 'mm'): Promise<ReduceReport | null> => {
    const client = tools()
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    const m = useMeshTools.getState()
    m.begin()
    useStore.getState().setStatus('Reducing the scan…')
    try {
      // The worker reduces the mesh Mesh Tools works on — the edited copy, or
      // the scan — as it stands, every alignment baked in.
      // One applied while this runs waits behind it there, and reaches the
      // reduced mesh through the scene like it reaches the scan.
      const result = await client.reduce(reduceSettingsOf(m))
      if (scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return null
      meshSceneOf(sceneRef.current)?.setReducedMesh(result)
      reduceField.current = result.deviation
      reduceRgb.current = null
      useMeshTools.getState().resolve(result.report)
      const r = result.report
      const tol = typedLen(r.settings.tolerance, units)
      useStore.getState().setStatus(
        `Reduced to ${count(r.triangles)} triangles from ${count(r.inputTriangles)} — ` +
          (r.held
            ? `99.9 % of the scan within ±${tol} of it.`
            : `99.9 % of the scan within ±${boundLength(units).fmt(r.p999, 3)} of it, past the ±${tol} asked for.`),
      )
      return r
    } catch (e) {
      if (scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return null
      useMeshTools.getState().fail(message(e))
      useStore.getState().setStatus('')
      return null
    }
  }

  /** Reduce the scan as the panel says. True when a result landed. */
  const runReduce = async (units: DisplayUnits = 'mm'): Promise<boolean> => (await reduce(units)) !== null

  // ---- The edited copy --------------------------------------------------------

  /**
   * Put a version of the edited copy in place beside the scan — in the
   * worker and in the viewport — or none. It is read in the pose the scan
   * stands in; a reduction made of the mesh before it goes.
   */
  const setEditedCopy = async (copy: EditedCopy | null): Promise<void> => {
    const client = tools()
    const scene = sceneRef.current
    if (copy) {
      const s = useStore.getState()
      const mesh = await client.setEdited(
        copy.source.name,
        copy.source.bytes.slice().buffer,
        creaseSetting(s),
        s.appliedAlignment ?? undefined,
        copy.source.units ?? 'mm', // units-ok: the file's own unit, an id
      )
      scene?.setEditedMesh(mesh)
      // On screen at once in Mesh Tools — the effect that shows it runs after
      // the next render, and a marking laid down before then must land on it.
      if (useShell.getState().workspace === 'mesh') scene?.showEdited(true)
      useMeshTools.getState().setCopy(mesh.triangleCount)
    } else {
      await client.clearEdited()
      scene?.setEditedMesh(null)
      useMeshTools.getState().setCopy(null)
    }
    editedCopy.current = copy
    copyField.current = null
    copyRgb.current = null
    // A marking was on the mesh that has gone.
    useMark.getState().reset()
    if (useMeshTools.getState().report) {
      meshSceneOf(scene)?.setReducedMesh(null)
      reduceField.current = null
      reduceRgb.current = null
      useMeshTools.getState().dropResult()
    }
    // So was the break a piece was cut to.
    if (useMeshTools.getState().trimMade) {
      meshSceneOf(scene)?.setTrimmedPiece(null)
      useMeshTools.getState().dropTrim()
    }
  }

  /** Refused while something is open that the scan would change under —
   *  unless the edit runs inside a step a command opened, which asked. */
  const refused = (run: EditRun | undefined, text: string): boolean => {
    if (run?.inStep || !historyBlocked()) return false
    useStore.getState().setError(text)
    return true
  }

  /**
   * Edit the copy of the scan Mesh Tools works on — the first edit makes it
   * — as one step of the undo history. `produce` asks the worker for the
   * copy as it is to be, in the frame it now stands in, with every old
   * vertex's new number, and says what was done. The scan every other
   * workspace measures is not touched. Refused while anything is open that
   * the copy would change under. What it did when it landed; null when it
   * did not — the error is the store's.
   */
  const editCopy = async (
    label: string,
    busyText: string,
    produce: () => Promise<{
      positions: Float32Array
      indices: Uint32Array
      vertexMap: Int32Array
      edit: ScanEdit
      status: string
      report: EditLanded['report']
    }>,
    run?: EditRun,
  ): Promise<EditLanded | null> => {
    if (refused(run, 'Finish or cancel what is open first — the scan cannot change under it.')) return null
    // What the edit did, once it landed: a failure is said by runImport, and
    // the copy stays as it was.
    let landed: EditLanded | null = null
    useMeshTools.getState().setEditing(true)
    try {
      await runImport(imports, busyText, async () => {
        const result = await produce()
        const s = useStore.getState()
        // Kept in the frame the scan was opened in, so the alignment goes on
        // it as it goes on the scan: when it is read, from a project or by a
        // restarted worker.
        const alignment = s.appliedAlignment
        if (alignment) rigidApplyToPoints(rigidInvert(alignment), result.positions)
        const name = s.fileName ?? 'scan'
        const source: ScanSource = {
          name: `${name.replace(/\.[^.]+$/, '')}.ply`,
          bytes: buildBinaryPly(result.positions, result.indices, `${name}, edited in ScanRuler`),
          // units-ok: the file's own unit, an id — the copy is written in mm.
          units: 'mm',
        }
        const before = editedCopy.current
        const map = before ? composeVertexMaps(before.map, result.vertexMap) : result.vertexMap
        await historyAsync(label, async () => {
          await setEditedCopy({ source, map })
          useMeshTools.getState().addPending(result.edit)
        })
        useStore.getState().setStatus(result.status)
        landed = { edit: result.edit, status: result.status, report: result.report }
      })
    } finally {
      useMeshTools.getState().setEditing(false)
    }
    return landed
  }

  /**
   * Take the edited copy into use: it becomes the scan every workspace
   * measures, loaded in place of it under everything measured on it — the
   * elements fitted again on it, the maps measured again — as one step of
   * the undo history. True when it was.
   */
  const adoptEditedCopy = async (run?: EditRun): Promise<boolean> => {
    const copy = editedCopy.current
    if (!copy) return false
    if (refused(run, 'Finish or cancel what is open first — the scan cannot change under it.')) return false
    const n = useMeshTools.getState().pending.length
    let taken = false
    useMeshTools.getState().setEditing(true)
    try {
      await runImport(imports, 'Taking the edited mesh into use…', async () => {
        await historyAsync('Mesh Tools: use the edited mesh for analysis', async () => {
          await swapScan(copy.source, useStore.getState().appliedAlignment)
          remapScan(copy.map)
          useMeshTools.getState().takePending()
          await remeasureScan(true)
        })
        useStore
          .getState()
          .setStatus(
            `Every workspace measures the edited mesh now — ${count(n)} edit${n === 1 ? '' : 's'} taken into use, the elements fitted again on it. Ctrl+Z goes back to the scan before.`,
          )
        taken = true
      })
    } finally {
      useMeshTools.getState().setEditing(false)
    }
    return taken
  }

  /** Throw the edited copy away, as one step of the undo history: Mesh Tools
   *  works on the scan in use again. True when it was. */
  const discardEditedCopy = async (run?: EditRun): Promise<boolean> => {
    if (!editedCopy.current) return false
    if (refused(run, 'Finish or cancel what is open first.')) return false
    const n = useMeshTools.getState().pending.length
    let gone = false
    await runImport(imports, 'Discarding the edits…', async () => {
      await historyAsync('Mesh Tools: discard edits', async () => {
        await setEditedCopy(null)
        useMeshTools.getState().clearPending()
      })
      useStore
        .getState()
        .setStatus(`Discarded ${count(n)} edit${n === 1 ? '' : 's'} — Mesh Tools works on the scan in use again. Ctrl+Z brings them back.`)
      gone = true
    })
    return gone
  }

  // ---- Remove islands ---------------------------------------------------------------

  /** Delete the islands smaller than the panel's size — called once the
   *  panel has had its yes. */
  const removeIslands = (run?: EditRun) => {
    const minSize = useMeshTools.getState().pieceSize
    useMeshTools.getState().setConfirming(false)
    return editCopy(
      'Mesh Tools: remove islands',
      'Removing islands…',
      async () => {
        const { survey, positions, indices, vertexMap } = await tools().removeIslands(minSize)
        const n = survey.islands
        return {
          positions,
          indices,
          vertexMap,
          edit: { kind: 'pieces', minSize, pieces: n, triangles: survey.islandTriangles },
          status: `Removed ${count(n)} island${n === 1 ? '' : 's'} — ${count(survey.islandTriangles)} triangles. Ctrl+Z puts them back.`,
          report: { kind: 'pieces', survey: { pieces: survey.pieces, islands: n, islandTriangles: survey.islandTriangles } },
        }
      },
      run,
    )
  }

  // ---- The other edits --------------------------------------------------------------

  /** One edit the worker makes, as one step of the history: `describe`
   *  turns what it did into the line in the list and the status. */
  const workerEdit = (
    label: string,
    busyText: string,
    request: () => ScanEditRequest,
    describe: (report: ScanEdited['report']) => { edit: ScanEdit; status: string },
    run?: EditRun,
  ) =>
    editCopy(
      label,
      busyText,
      async () => {
        const { positions, indices, vertexMap, report } = await tools().editScan(request())
        return { positions, indices, vertexMap, report, ...describe(report) }
      },
      run,
    )

  /** The surface marked on the part, by the mesh's own vertices — none
   *  without a viewport. */
  const marked = (): Uint32Array => sceneRef.current?.paintedVertices() ?? new Uint32Array(0)

  /** Delete `vertices` — the surface marked on the part, unless given —
   *  called once the panel has had its yes. */
  const deleteMarked = (vertices: Uint32Array = marked(), run?: EditRun) => {
    useMeshTools.getState().setConfirming(false)
    return workerEdit(
      'Mesh Tools: delete marked surface',
      'Deleting the marked surface…',
      () => ({ type: 'delete-marked', vertices }),
      (r) => {
        const n = r.kind === 'delete' ? r.triangles : 0
        return {
          edit: { kind: 'delete', triangles: n },
          status: `Deleted ${count(n)} triangles of marked surface. Ctrl+Z puts them back.`,
        }
      },
      run,
    )
  }

  /** Turn the copy's triangles over — every one, or those of the surface
   *  marked on the part (or `region`, given) — so they face the other way.
   *  The marking goes with the mesh it was on, so the surface turned is in
   *  plain view. */
  const flipScan = async (region: Uint32Array | 'marked' | null = null, run?: EditRun): Promise<EditLanded | null> => {
    const r = region === 'marked' ? marked() : region
    if (r && r.length === 0) {
      useStore.getState().setError('Mark the surface to flip on the part first — with a window, the brush or a lasso.')
      return null
    }
    return workerEdit(
      r ? 'Mesh Tools: flip the normals of a marked region' : 'Mesh Tools: flip the normals',
      'Flipping the normals…',
      () => ({ type: 'flip', ...(r ? { vertices: r } : {}) }),
      (rep) => {
        const n = rep.kind === 'flip' ? rep.triangles : 0
        return {
          edit: { kind: 'flip', triangles: n, ...(r ? { region: r.length } : {}) },
          status: r
            ? `Flipped the ${count(n)} triangles of the marked region — they face the other way. Ctrl+Z turns them back.`
            : `Flipped every triangle — ${count(n)} — the part faces the other way. Ctrl+Z turns it back.`,
        }
      },
      run,
    )
  }

  /** Cut the scan at the plane the panel shows. */
  const cutScan = async (run?: EditRun): Promise<EditLanded | null> => {
    const m = useMeshTools.getState()
    const s = useStore.getState()
    const plane = cutPlaneOf(m.cutRef, m.cutOffset, m.cutOffsetAuto, m.cutKeep, s.elements, s.modelCenter)
    // The list keeps the plane as it was named in mm; the status names it in
    // the units the run asked for.
    const shown = run?.units ? cutPlaneOf(m.cutRef, m.cutOffset, m.cutOffsetAuto, m.cutKeep, s.elements, s.modelCenter, run.units) : plane
    if (!plane || !shown) {
      s.setError('Choose what to cut across — a coordinate plane, or an element with a direction.')
      return null
    }
    const cap = m.cutCap
    return workerEdit(
      'Mesh Tools: cut',
      'Cutting the scan…',
      () => ({ type: 'cut', origin: plane.frame.origin, normal: plane.frame.normal, cap }),
      (r) => {
        const c = r.kind === 'cut' ? r.report : { removed: 0, split: 0, capped: 0, capTriangles: 0, open: 0, bridged: 0 }
        const closed = cap && c.capped > 0 ? `, closed flat` : ''
        const bridged =
          c.bridged > 0
            ? ` — the cap bridges ${count(c.bridged)} hole${c.bridged === 1 ? '' : 's'} in the scan at the cut; Fill holes closes what is left of ${c.bridged === 1 ? 'it' : 'them'}`
            : ''
        const open =
          c.open > 0
            ? ` — ${count(c.open)} stretch${c.open === 1 ? '' : 'es'} of the cut left open, where the scan is open across the plane`
            : ''
        return {
          edit: { kind: 'cut', plane: plane.label, removed: c.removed, capped: c.capped, open: c.open },
          status: `Cut at ${shown.label} — ${count(c.removed)} triangles off${closed}${bridged}${open}. Ctrl+Z puts them back.`,
        }
      },
      run,
    )
  }

  /** Close every hole under the size in the panel — or, given a point, the
   *  one of them nearest it alone. */
  const fillScanHoles = (at?: Vec3, run?: EditRun) => {
    const { holeSize, fillMode } = useMeshTools.getState()
    return workerEdit(
      at ? 'Mesh Tools: fill a hole' : 'Mesh Tools: fill holes',
      at ? 'Filling the hole…' : 'Filling holes…',
      () => ({ type: 'fill-holes', maxSize: holeSize, mode: fillMode, ...(at ? { at } : {}) }),
      (r) => {
        const f = r.kind === 'fill' ? r.report : { filled: 0, triangles: 0, vertices: 0, failed: 0, left: 0 }
        const failed = f.failed > 0 ? ` — ${count(f.failed)} could not be closed, the rim crossing itself too much` : ''
        const what = at ? 'the hole' : `${count(f.filled)} hole${f.filled === 1 ? '' : 's'}`
        return {
          edit: { kind: 'fill', maxSize: holeSize, mode: fillMode, holes: f.filled, triangles: f.triangles },
          status: `Filled ${what} with ${count(f.triangles)} triangles${failed}. Ctrl+Z opens ${at ? 'it' : 'them'} again.`,
        }
      },
      run,
    )
  }

  /** The region a tool works on alone: `region` when given — null for the
   *  whole mesh — else, while the panel says Marked region, the surface
   *  marked on the part. Null too when that is empty, with the error said. */
  const regionOf = (scope: 'all' | 'marked', region: Uint32Array | null | undefined, ask: string): Uint32Array | null | false => {
    const r = region !== undefined ? region : scope === 'marked' ? marked() : null
    if (r && r.length === 0) {
      useStore.getState().setError(ask)
      return false
    }
    return r
  }

  /** Smooth the copy as the panel says — all of it, or the region marked on
   *  it (or `region`, given). The marking goes with the mesh it was on, so
   *  what smoothing did is in plain view — and its deviation, which the
   *  marking would cover. */
  const smoothScan = async (region?: Uint32Array | null, run?: EditRun): Promise<EditLanded | null> => {
    const { smoothScope, smoothSize: size, smoothLimit: limit, smoothEdges: keepEdges } = useMeshTools.getState()
    const len = lengthsOf(run?.units)
    const r = regionOf(smoothScope, region, 'Mark the surface to smooth on the part first — with a window, the brush or a lasso.')
    if (r === false) return null
    return workerEdit(
      r ? 'Mesh Tools: smooth a marked region' : 'Mesh Tools: smooth',
      'Smoothing…',
      () => ({ type: 'smooth', settings: { size, limit, keepEdges, ...(r ? { region: r } : {}) } }),
      (rep) => {
        const s = rep.kind === 'smooth' ? rep.report : null
        const maxMove = s?.maxMove ?? 0
        const held =
          s && s.held > 0
            ? ` ${count(s.held)} left as they were${keepEdges ? ', on sharp edges or' : ''} with too little scan around them to fit.`
            : ''
        const limited = s && s.atLimit > 0 ? ` ${count(s.atLimit)} stopped at the ${typedLen(limit, len.units)} limit.` : ''
        const what = r ? `the marked region — ${count(s?.moved ?? 0)} points` : `${count(s?.moved ?? 0)} points`
        return {
          edit: { kind: 'smooth', size, limit, maxMove, ...(r ? { region: r.length } : {}) },
          status:
            `Smoothed ${what} — moved at most ${len.fmt(maxMove, 3)}, RMS ${len.fmt(s?.rmsMove ?? 0, 3)}.` +
            `${held}${limited} Ctrl+Z puts it back.`,
        }
      },
      run,
    )
  }

  // ---- Shrink / expand -----------------------------------------------------------------

  /** Move the copy's surface along its normal as the panel says — all of it,
   *  or the region marked on it (or `region`, given), as a step. The marking
   *  goes with the mesh it was on, so what moved is in plain view, and its
   *  deviation. */
  const offsetScan = async (region?: Uint32Array | null, run?: EditRun): Promise<EditLanded | null> => {
    const { offsetScope, offsetDirection, offsetDistance } = useMeshTools.getState()
    const len = lengthsOf(run?.units)
    const r = regionOf(offsetScope, region, 'Mark the surface to move on the part first — with a window, the brush or a lasso.')
    if (r === false) return null
    const distance = offsetDirection === 'expand' ? offsetDistance : -offsetDistance
    const verb = distance > 0 ? 'Expanded' : 'Shrank'
    return workerEdit(
      `Mesh Tools: ${distance > 0 ? 'expand' : 'shrink'}${r ? ' a marked region' : ''}`,
      distance > 0 ? 'Expanding…' : 'Shrinking…',
      () => ({ type: 'offset', settings: { distance, ...(r ? { region: r } : {}) } }),
      (rep) => {
        const o = rep.kind === 'offset' ? rep.report : null
        const maxMove = o?.maxMove ?? Math.abs(distance)
        const further = maxMove > Math.abs(distance) * 1.001 ? `, the furthest ${len.fmt(maxMove, 3)} at an edge or a corner` : ''
        const rim =
          o && r
            ? o.stepped > 0
              ? ` Its rim stepped off the surface at ${count(o.stepped)} points, joined to it by a wall of ${count(o.wall)} triangles${o.slid > 0 ? `, and slid along the face beside it at ${count(o.slid)}` : ''}.`
              : o.slid > 0
                ? ` Its rim slid along the face beside it, which is ${distance > 0 ? 'stretched' : 'shortened'} with it.`
                : ''
            : ''
        const eased = o ? mended(o.merged, o.relaxed, 'the surface') : ''
        return {
          edit: { kind: 'offset', distance, maxMove, ...(r ? { region: r.length } : {}) },
          status:
            `${verb} ${r ? 'the marked region' : 'the part'} by ${typedLen(Math.abs(distance), len.units)} — ${count(o?.moved ?? 0)} points moved${further}.` +
            `${rim}${eased} Ctrl+Z puts it back.`,
        }
      },
      run,
    )
  }

  // ---- Shell ---------------------------------------------------------------------------

  /** Hollow the copy, closed, or thicken it into a solid, open — as the
   *  panel says, `mode` being what the panel offers for the mesh as it is. */
  const shellScan = (mode: 'hollow' | 'thicken', run?: EditRun) => {
    const { shellThickness: thickness, shellSide: side } = useMeshTools.getState()
    const len = lengthsOf(run?.units)
    const wall = typedLen(thickness, len.units)
    if (mode === 'hollow') {
      return workerEdit(
        'Mesh Tools: hollow',
        'Hollowing…',
        () => ({ type: 'hollow', thickness }),
        (r) => {
          const h = r.kind === 'hollow' ? r.report : null
          const cavities = h?.cavities ?? 0
          const removed = h?.removed ?? 0
          return {
            edit: { kind: 'shell', mode, thickness, triangles: h?.triangles ?? 0, cavities, volume: removed },
            status:
              `Hollowed with a ${wall} wall — ${count(cavities)} ${cavities === 1 ? 'cavity' : 'cavities'}, ${len.vol(removed, 1)} of material out` +
              `${h ? ` (${((100 * removed) / h.volumeBefore).toFixed(0)} %)` : ''}, an inner wall of ${count(h?.triangles ?? 0)} triangles. ` +
              `Where the part is thinner than ${typedLen(2 * thickness, len.units)} it stays solid. Cut shows the inside without cutting. Ctrl+Z fills it again.`,
          }
        },
        run,
      )
    }
    return workerEdit(
      'Mesh Tools: thicken',
      'Thickening…',
      () => ({ type: 'thicken', thickness, side }),
      (r) => {
        const t = r.kind === 'thicken' ? r.report : null
        const way = side === 'out' ? 'outward' : side === 'both' ? 'to both sides' : 'inward'
        const eased = t ? mended(t.merged, t.relaxed, 'the second skin') : ''
        return {
          edit: { kind: 'shell', mode, thickness, side, triangles: t?.triangles ?? 0 },
          status:
            `Thickened ${wall} ${way} — a second skin and a wall round ${count(t?.rimEdges ?? 0)} open edges, ${count(t?.triangles ?? 0)} triangles.` +
            `${eased} Ctrl+Z puts it back.`,
        }
      },
      run,
    )
  }

  // ---- Boolean ------------------------------------------------------------------------

  // Each solid on offer, meshed once for each shape it has: what is drawn on
  // the part while the tool is in hand, and what the boolean is made with.
  const solidMeshes = new Map<string, { version: number; mesh: SolidMesh }>()
  const meshOfSolid = async (solid: OfferedSolid): Promise<SolidMesh> => {
    const have = solidMeshes.get(solid.key)
    if (have && have.version === solid.version) return have.mesh
    const mesh = await solid.mesh(BOOLEAN_CHORD_MM)
    solidMeshes.set(solid.key, { version: solid.version, mesh })
    return mesh
  }

  /** Make the mesh and the solids in hand one, as the panel says — several
   *  as their union, in one edit — and put the tool away once it is done. */
  const booleanScan = async (run?: EditRun): Promise<EditLanded | null> => {
    const { boolOp: op, boolSolids: keys } = useMeshTools.getState()
    const len = lengthsOf(run?.units)
    const onOffer = booleanSolids()
    const solids = keys.flatMap((key) => onOffer.filter((s) => s.key === key))
    if (solids.length === 0) {
      useStore.getState().setError('Click the solids to make one with the mesh on the part.')
      return null
    }
    const tools: BooleanTool[] = []
    for (const solid of solids) {
      try {
        const mesh = await meshOfSolid(solid)
        tools.push({ name: solid.name, positions: mesh.positions, indices: mesh.indices })
      } catch (e) {
        useStore.getState().setError(`${solid.name} could not be meshed: ${message(e)}`)
        return null
      }
    }
    const names = namesOf(solids.map((s) => s.name))
    const one = solids.length === 1
    const did = op === 'subtract' ? `Took ${names} out of the mesh` : op === 'add' ? `Added ${names} to the mesh` : `Kept what the mesh and ${names} share`
    const landed = await workerEdit(
      `Mesh Tools: ${op} ${names}`,
      op === 'subtract' ? `Taking ${names} out…` : op === 'add' ? `Adding ${names}…` : `Keeping what ${names} ${one ? 'shares' : 'share'}…`,
      () => ({ type: 'boolean', op, tools }),
      (r) => {
        const b = r.kind === 'boolean' ? r.report : { removed: 0, added: 0, volumeBefore: 0, volumeAfter: 0 }
        const change = b.volumeAfter - b.volumeBefore
        return {
          edit: { kind: 'boolean', op, solid: names, removed: b.removed, added: b.added, volume: change },
          status: `${did} — ${change >= 0 ? '+' : '−'}${len.vol(Math.abs(change), 1)}, ${count(b.added)} triangles of surface ${one ? 'it' : 'they'} made, grey in the Deviation view. Ctrl+Z puts it back.`,
        }
      },
      run,
    )
    if (landed && useMeshTools.getState().tool === 'boolean') useMeshTools.getState().setTool(null)
    return landed
  }

  // ---- Trim to scan ---------------------------------------------------------------

  /** The body as the worker is sent it: its triangles, and a key that
   *  changes with its shape, under which the worker keeps it prepared. */
  const trimBodyOf = async (solid: OfferedSolid): Promise<TrimBody> => {
    const mesh = await meshOfSolid(solid)
    return { key: `${solid.key}@${solid.version}`, name: solid.name, positions: mesh.positions, indices: mesh.indices }
  }

  /** Cut the body in hand to the break as it is marked on the part — or to
   *  `break_`, given: those vertices, or null for the break as the worker
   *  finds it — as the panel says: a piece beside the scan, shown over it
   *  ghosted — not an edit of the scan, and not a step of the undo
   *  history. What came of it; null when it failed — the store says why. */
  const trimScan = async (break_?: Uint32Array | null, units: DisplayUnits = 'mm'): Promise<TrimLanded | null> => {
    const m = useMeshTools.getState()
    const solid = m.trimSolid === null ? undefined : booleanSolids().find((s) => s.key === m.trimSolid)
    if (!solid) {
      useStore.getState().setError('Click the body to trim on the part.')
      return null
    }
    const marking = break_ !== undefined ? break_ : marked()
    if (marking && marking.length === 0) {
      useStore.getState().setError('Mark the break on the part first — Find again marks it where the body reaches into the part.')
      return null
    }
    const { trimOffset: offset, trimDepth: depth, trimFlip: flip } = m
    const client = tools()
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    m.trimBegin()
    useStore.getState().setStatus(`Trimming ${solid.name} to the break…`)
    try {
      const body = await trimBodyOf(solid)
      const piece = await client.trimToScan(body, { depth, offset, flip, ...(marking ? { marked: marking } : {}) })
      if (scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return null
      meshSceneOf(sceneRef.current)?.setTrimmedPiece(piece)
      const gapRange = summarizeCopyDeviation(piece.gap).range
      useMeshTools.getState().trimResolve({ report: piece.report, solid: solid.key, name: solid.name, depth, flip, gapRange })
      const r = piece.report
      const dropped = r.dropped > 0 ? `, ${count(r.dropped)} piece${r.dropped === 1 ? '' : 's'} on the other side of the break dropped` : ''
      const len = boundLength(units)
      const status =
        `Trimmed ${solid.name} to the break — ${len.vol(r.volume, 1)}, its mating face ${len.area(r.matingArea, 1)}` +
        `${offset > 0 ? `, ${typedLen(offset, units)} off the break` : ', on the break'}${dropped}.`
      useStore.getState().setStatus(status)
      return { report: r, name: solid.name, status }
    } catch (e) {
      if (scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return null
      useMeshTools.getState().trimFail(message(e))
      useStore.getState().setStatus('')
      return null
    }
  }

  // ---- Keeping in step ---------------------------------------------------------------

  /**
   * Start what keeps the workspace in step with the session — what it read
   * off the scan going with it, the copy back beside the scan after a
   * restart of the worker, the copy as a step of the undo history. The
   * returned function stops it.
   */
  const watch = (): (() => void) => {
    const stops = [
      // What Mesh Tools read off the scan goes with it: a new part clears the
      // workspace and sizes its settings to the part; another version of the
      // same scan — an edit taken into use, or undone — takes the copy and the
      // reduction made of the one before, and a remeasure makes the reduction
      // again, or lets it go when it cannot be.
      onScan({
        loaded: (scan) => {
          reduceField.current = null
          reduceRgb.current = null
          useMeshTools.getState().clear()
          // The worker and the viewport let a copy of the last scan go with it.
          editedCopy.current = null
          if (scan) useMeshTools.getState().suggestForPart(2 * scan.modelSize, meanEdgeLength(scan.positions, scan.indices))
        },
        swapped: () => {
          // A copy of the scan that went is not a copy of this one: the worker
          // and the viewport have both let it go with the scan.
          editedCopy.current = null
          copyField.current = null
          copyRgb.current = null
          useMeshTools.getState().setCopy(null)
          reduceField.current = null
          reduceRgb.current = null
          useMeshTools.getState().setSurvey(null)
          // The scene let a piece cut to it go with it.
          if (useMeshTools.getState().trimMade) useMeshTools.getState().dropTrim()
        },
        remeasure: async () => {
          // A reduction that cannot be made again goes: the mesh it described
          // went with the old scan.
          if (useMeshTools.getState().report && !(await runReduce())) useMeshTools.getState().dropResult()
        },
      }),
      // After a restart of the worker the copy goes back beside the scan, the
      // way it came in: read in the pose the scan stands in.
      clientRef.current!.onRestore(async (channel) => {
        const copy = editedCopy.current
        if (!copy || !sources.current.scan) return
        const s = useStore.getState()
        const id = await channel.loadStaged(copy.source.name, copy.source.bytes, creaseSetting(s), s.appliedAlignment, copy.source.units)
        await channel.call(MESH_TOOLS, 'set-edited', { staged: id })
      }),
      // The copy is a step of the undo history by identity, with the vertex
      // numbering that carries the scan's onto it: a step across an edit puts
      // the copy from the other side of it in place — after the app has put
      // the scan from that side in place, which takes the copy away.
      registerHistory({
        // Weighed, so the history keeps no more versions of a large copy
        // than fit its byte budget.
        sections: [{ key: 'edited', compare: 'identity', capture: () => editedCopy.current ?? null, apply: () => {}, bytes: (copy) => editedCopyBytes(copy as EditedCopy) }],
        beforeRestore: async (patch) => {
          if ('edited' in patch && (patch.edited ?? null) !== (editedCopy.current ?? null)) {
            await setEditedCopy((patch.edited as EditedCopy | null) ?? null)
          }
        },
      }),
    ]
    return () => stops.forEach((stop) => stop())
  }

  return {
    clientRef,
    sceneRef,
    reduceField,
    reduceRgb,
    copyField,
    copyRgb,
    reduce,
    runReduce,
    setEditedCopy,
    adoptEditedCopy,
    discardEditedCopy,
    removeIslands,
    deleteMarked,
    flipScan,
    cutScan,
    fillScanHoles,
    smoothScan,
    offsetScan,
    shellScan,
    meshOfSolid,
    booleanScan,
    trimBodyOf,
    trimScan,
    watch,
  }
}

let installed: MeshToolsSession | null = null

/** Make `session` the one the workspace's commands and its part of a
 *  project work through. The returned function takes it away again. */
export function installMeshToolsSession(session: MeshToolsSession): () => void {
  installed = session
  return () => {
    if (installed === session) installed = null
  }
}

/** The session installed, or null with none — the workspace not set up. */
export const meshToolsSession = (): MeshToolsSession | null => installed
