// SPDX-License-Identifier: AGPL-3.0-only
// The deviation workspace's verbs: load the reference, best-fit the scan onto
// it — globally or on a marked surface — measure the map, and choose the
// element a map against an element is measured from. The field itself lives
// in the session's refs (see session.ts), because other workspaces read it
// too. The panel and the deviation.* commands both work through these.
import type { RefObject } from 'react'
import { isStepFile } from '../core/formats'
import { unitsLabel, type MeshUnits } from '../core/meshUnits'
import { meshUnitsFor } from '../state/unitsPromptStore'
import type { ImportQueue } from './importQueue'
import { prepareNominal, runImport, type PreparedNominal } from './imports'
import type { MeshWorkerClient, ReferenceDeviationResult } from '../core/workerClient'
import type { SceneManager } from '../viewer/SceneManager'
import { useStore } from '../state/store'
import { clearHistory } from '../state/historyStore'
import { useDeviation, type MapSide } from '../state/deviationStore'
import { rigidToColumnMajor } from '../core/deviation/rigid'
import { useMark } from '../state/markStore'
import { buildDeviationReport, buildElementReport } from '../core/deviation/report'
import type { DeviationStats } from '../core/deviation/deviation'
import { DEFAULT_REFERENCE_FACING_DEG, wantedSpacing } from '../core/deviation/onReference'
import { detectMaterialSide } from '../core/deviation/elementField'
import { targetFitOf } from './useElementField'
import type { SourceFiles } from './project'
import type { Vec3 } from '../core/types'
import { usePrefs } from '../state/prefsStore'
import { lengthInputText, type DisplayUnits } from '../core/units'
import { boundLength } from './useUnits'

/** What the status strip says the moment the marking tools come out — the
 *  same tools, and so the same instruction, whichever workspace offered them. */
export const PICK_MARK_TOOL_STATUS =
  'Pick a marking tool in the panel — Window, Brush or Lasso — then drag on the scan.'

/** How a reference comes in. `fromSession`: the app made it from the
 *  session's own work rather than the person choosing a file — another
 *  comparison of the same work, most likely, read best under the settings
 *  the last one was read under — so the search distance stands as it is,
 *  and the reference goes with the scan it was made on when another scan is
 *  opened. A file the person opens starts the search distance over. */
export interface ReferenceOptions {
  fromSession?: boolean
}

export function deviationWorkspace({
  clientRef,
  sceneRef,
  deviation,
  deviationRgb,
  referenceMap,
  referenceRgb,
  fieldDirections,
  sources,
  imports,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  referenceMap: RefObject<ReferenceDeviationResult | null>
  referenceRgb: RefObject<Uint8Array | null>
  /** The direction each map's readings were taken along, keyed by the map. */
  fieldDirections: WeakMap<Float32Array, Int8Array>
  imports: ImportQueue
  sources: RefObject<SourceFiles>
}) {
  /** The map on the reference is let go of with the scan's: measured under
   *  an alignment, it is gone with it. */
  const dropReferenceMap = () => {
    referenceMap.current = null
    referenceRgb.current = null
    useDeviation.getState().clearReferenceMap()
  }

  const commitNominal = (prepared: PreparedNominal | null, options: ReferenceOptions = {}) => {
    deviation.current = null
    dropReferenceMap()
    deviationRgb.current = null
    sources.current.reference = prepared?.source ?? null
    sceneRef.current?.setFieldColors(null)
    useDeviation.getState().clearAlign(!!prepared && !!options.fromSession)
    sceneRef.current?.setAlignment(null)
    if (prepared) {
      prepared.view.commit()
      const { mesh, source } = prepared
      useDeviation.getState().finishNominalLoad(source.name, mesh.vertexCount, mesh.triangleCount, mesh.step ?? null, !!options.fromSession)
    } else {
      sceneRef.current?.clearNominal()
      useDeviation.getState().nominalFailed()
    }
    clearHistory()
  }

  /** An STL is asked about first — what units it is in — unless `units` is
   *  given: a file the instrument wrote itself, in millimetres like
   *  everything it holds. A question dismissed leaves the file unopened.
   *  The UI can supply a replacement decision at the queue head; commands
   *  and references derived from the current session need no browser prompt. */
  const openNominal = async (file: File, units?: MeshUnits, options: ReferenceOptions = {}, shouldStart?: () => boolean): Promise<void> => {
    const read = units ?? (await meshUnitsFor(file.name))
    if (!read) return
    await runImport(imports,
    isStepFile(file.name) ? 'Reading STEP file — tessellating the CAD surfaces…' : 'Reading reference geometry…',
    async () => {
      const client = clientRef.current!
      const prepared = await prepareNominal(client, sceneRef.current, file, read)
      try {
        await client.commitImport({ nominal: prepared.id })
        commitNominal(prepared, options)
        sceneRef.current?.frameAll()
        const mesh = prepared.mesh
        // A STEP reference is a conversion, and how good a conversion decides
        // how much of the map is the part. A file that came apart in the
        // conversion breaks the sign of every reading, so it gets the toast; a
        // clean one just says what it cost.
        const step = mesh.step
        const len = boundLength(usePrefs.getState().units)
        const converted = step
          ? ` Tessellated from STEP at ${lengthInputText(step.surfaceDeviation, len.units)} ${len.word()} chord tolerance${
              step.units && step.units !== 'mm' ? `, converted from ${step.units}` : ''
            }.`
          : read !== 'mm'
            ? ` Read in ${unitsLabel(read).toLowerCase()} and converted to millimetres.`
            : ''
        useStore
          .getState()
          .setStatus(
            `Reference loaded — ${mesh.triangleCount.toLocaleString('en-US')} triangles.${converted} Check it is the right part, then align the scan to it.`,
          )
        if (step?.warning) {
          if (step.unsound) useStore.getState().setError(step.warning)
          else useStore.getState().setStatus(step.warning)
        }
      } finally {
        prepared.view.dispose()
        await client.discardImport([prepared.id])
      }
    }, shouldStart)
  }

  const runDeviation = async () => {
    const { scanVersion, nominalVersion } = clientRef.current!
    const current = () => scanVersion === clientRef.current!.scanVersion && nominalVersion === clientRef.current!.nominalVersion
    const dev = useDeviation.getState()
    if (!dev.align) return
    dev.beginMap()
    try {
      const result = await clientRef.current!.deviate(dev.align.transform, dev.mapFacingDeg)
      if (!current()) return
      deviation.current = result.values
      deviationRgb.current = null
      fieldDirections.set(result.values, result.directions)
      useDeviation.getState().resolveMap(result.suggestedRange, result.suggestedMaxDistance)
      useStore.getState().setStatus('Deviation measured.')
      // Read on the reference, the reference's map is measured with it.
      if (useDeviation.getState().mapOn === 'reference') await runReferenceMap()
    } catch (e) {
      if (!current()) return
      // The alignment the map was measured under is still good — only the
      // measurement refused.
      useDeviation.getState().failMap(e instanceof Error ? e.message : String(e))
      useStore.getState().setStatus('')
    }
  }

  /** The map the other way round: the reference cut finer and read against
   *  the scan under the alignment in hand — see core/deviation/onReference.
   *  The readings lie about twice the tolerance apart, at least a quarter
   *  and at most two millimetres, and a large reference opens it. Asked
   *  while a run is going, it returns that run, so whoever asked waits for
   *  the map rather than finding none. */
  const runReferenceMap = (): Promise<void> => {
    if (useDeviation.getState().referenceStatus === 'running') return running ?? Promise.resolve()
    const run = measureReferenceMap().finally(() => {
      if (running === run) running = null
    })
    running = run
    return run
  }

  /** The run of the map on the reference going now. */
  let running: Promise<void> | null = null

  const measureReferenceMap = async () => {
    const client = clientRef.current
    const dev = useDeviation.getState()
    if (!client || !dev.align || dev.source !== 'reference') return
    triedUnder = dev.align
    const { scanVersion, nominalVersion } = client
    const align = dev.align
    const current = () => scanVersion === client.scanVersion && nominalVersion === client.nominalVersion && useDeviation.getState().align === align
    dev.beginReferenceMap()
    try {
      const spacing = wantedSpacing(dev.tolerance)
      const result = await client.deviateReference(align.transform, DEFAULT_REFERENCE_FACING_DEG, spacing)
      if (!current()) return
      referenceMap.current = result
      referenceRgb.current = null
      useDeviation.getState().resolveReferenceMap()
      useStore.getState().setStatus('Deviation measured on the reference.')
    } catch (e) {
      if (!current()) return
      useDeviation.getState().failReferenceMap(e instanceof Error ? e.message : String(e))
      useStore.getState().setStatus('')
    }
  }

  /** The deviation as volumes under the alignment in hand — material the
   *  reference has and the part has not, and the other way round, each
   *  region with its volume and depth (core/deviation/volume). Measured on
   *  asking only: it takes seconds, not the map's moment. */
  const runVolume = async (options: { tolerance?: number; cell?: number; within?: { min: Vec3; max: Vec3 } } = {}) => {
    const client = clientRef.current
    const dev = useDeviation.getState()
    if (!client || !dev.align || dev.source !== 'reference' || dev.volumeStatus === 'running') return
    const { scanVersion, nominalVersion } = client
    const align = dev.align
    const tolerance = options.tolerance ?? dev.tolerance
    const current = () => scanVersion === client.scanVersion && nominalVersion === client.nominalVersion && useDeviation.getState().align === align
    dev.beginVolume()
    try {
      const volume = await client.deviateVolume(align.transform, tolerance, { cell: options.cell, within: options.within })
      if (!current()) return
      useDeviation.getState().resolveVolume({ ...volume, tolerance })
      useStore.getState().setStatus(`Volume error measured in ${(volume.timings.total / 1000).toFixed(1)} s.`)
    } catch (e) {
      if (!current()) return
      useDeviation.getState().failVolume(e instanceof Error ? e.message : String(e))
      useStore.getState().setStatus('')
    }
  }

  /** The alignment the map on the reference was last measured under, or
   *  tried under: a map that refused is not asked for again under it. */
  let triedUnder: unknown = null

  /** The map on the reference measured whenever it is asked for and not
   *  there — the view bar's key sets the store alone. The returned function
   *  stops watching. */
  const watch = () =>
    useDeviation.subscribe((d) => {
      if (d.mapOn !== 'reference' || d.source !== 'reference' || d.mapStatus !== 'ready' || d.referenceStatus !== 'idle' || !d.align || d.align === triedUnder) return
      void runReferenceMap()
    })

  /** Paint the map on the scan or on the reference, the reference's
   *  measured the first time it is asked for. */
  const setMapOn = async (side: MapSide) => {
    useDeviation.getState().setMapOn(side)
    const dev = useDeviation.getState()
    if (side === 'reference' && dev.align && dev.referenceStatus !== 'ready') await runReferenceMap()
  }

  /** The facing limit decides which surface each point is measured against,
   *  so a map already on the part is measured again under the new one. */
  const setMapFacing = (deg: number | null) => {
    const before = useDeviation.getState().mapFacingDeg
    useDeviation.getState().setMapFacing(deg)
    const dev = useDeviation.getState()
    if (dev.mapFacingDeg === before || dev.mapStatus !== 'ready') return
    useStore.getState().setStatus('Re-measuring the deviation under the new facing limit…')
    void runDeviation()
  }

  /**
   * Put the scan back where the alignment in hand says it goes.
   *
   * A fit streams its intermediate poses straight onto the part, so that it can
   * be watched settling. One that was stopped leaves the last of those on
   * screen — a pose nobody chose and nothing was measured under — so the fit
   * that was already in hand (or none at all) has to be put back by hand.
   */
  const restoreAlignment = () => {
    const align = useDeviation.getState().align
    sceneRef.current?.setAlignment(align ? rigidToColumnMajor(align.transform) : null)
  }

  /** Stop the fit that is running, wherever it has got to. */
  const abortAlign = () => {
    const dev = useDeviation.getState()
    if (dev.alignStatus !== 'running' || dev.alignStopping) return
    dev.stoppingAlign()
    clientRef.current?.abortAlign()
    useStore.getState().setStatus('Stopping the alignment…')
  }

  /** What a stopped fit leaves behind: the part back where it was, the message,
   *  and the picker still open if that is where it was started from. */
  const alignStopped = () => {
    restoreAlignment()
    useDeviation.getState().alignStopped()
    useStore.getState().setStatus('Alignment stopped — nothing was changed.')
  }

  /**
   * Open the split-screen point picker, with a clean sheet.
   *
   * The surface selected inside it is the scan's one marking — there is only
   * one, held on the mesh both viewports share — so the session opens with
   * nothing marked and takes what it marked away with it. A selection left over
   * from another workflow is not a statement about this fit, and a marking that
   * outlived its session would leave the running tally disagreeing with what is
   * actually on the part.
   */
  const startPicking = () => {
    sceneRef.current?.clearPaint()
    useMark.getState().reset()
    useDeviation.getState().startPicking()
  }

  /** Close it again, selection and all. A no-op when it was not open, so the
   *  automatic fit can call it without touching a fine fit's marking. */
  const stopPicking = () => {
    if (!useDeviation.getState().picking) return
    sceneRef.current?.clearPaint()
    useMark.getState().reset()
    useDeviation.getState().stopPicking()
  }

  /** Run the best fit. With no pairs this is the automatic match; with pairs it
   *  starts from them instead, and only the surface selected in the picker (if
   *  any) is refined on. Either way ICP does the fine work. */
  const runAlign = async (usePairs: boolean) => {
    const { scanVersion, nominalVersion } = clientRef.current!
    const current = () => scanVersion === clientRef.current!.scanVersion && nominalVersion === clientRef.current!.nominalVersion
    const dev = useDeviation.getState()
    const selection = usePairs ? sceneRef.current?.paintedVertices() : null
    dev.beginAlign()
    try {
      const result = await clientRef.current!.align(usePairs ? dev.pairs : null, selection)
      if (!current()) return
      if (!result) {
        alignStopped()
        return
      }
      useDeviation.getState().resolveAlign(result)
      stopPicking()
      deviation.current = null
      dropReferenceMap()
      sceneRef.current?.setFieldColors(null)
      useStore
        .getState()
        .setStatus(
          `Aligned — ${boundLength(usePrefs.getState().units).fmt(result.rms, 4)} RMS over ${result.matched.toLocaleString('en-US')} points. Measure the deviation next.`,
        )
      await runDeviation()
    } catch (e) {
      if (!current()) return
      const message = e instanceof Error ? e.message : String(e)
      restoreAlignment()
      useDeviation.getState().failAlign(message)
      useStore.getState().setStatus('')
    }
  }

  // ---- local fine fit ------------------------------------------------------

  const handleStartMarking = () => {
    // The tools open in Navigate with nothing marked: a gesture takes both
    // plain drags away from the camera, so one is only ever live because the
    // user just picked it.
    useMark.getState().reset()
    useDeviation.getState().startMarking()
    useStore.getState().setStatus(PICK_MARK_TOOL_STATUS)
  }

  const handleStopMarking = () => {
    sceneRef.current?.clearPaint()
    useDeviation.getState().stopMarking()
    useMark.getState().reset()
    useStore.getState().setStatus('')
  }

  const handleClearMarking = () => {
    sceneRef.current?.clearPaint()
    useMark.getState().setCount(0)
  }

  /** Refine the alignment on the marked surface only — the one on the part,
   *  or `marked` — starting from the fit already in hand. */
  const runLocalAlign = async (marked?: Uint32Array) => {
    const { scanVersion, nominalVersion } = clientRef.current!
    const current = () => scanVersion === clientRef.current!.scanVersion && nominalVersion === clientRef.current!.nominalVersion
    const dev = useDeviation.getState()
    const start = dev.align
    if (!start) return
    const vertices = marked ?? sceneRef.current?.paintedVertices() ?? new Uint32Array(0)
    dev.beginAlign()
    try {
      const result = await clientRef.current!.alignLocal(
        vertices,
        start.transform,
        dev.localMaxDistance,
      )
      if (!current()) return
      if (!result) {
        alignStopped()
        return
      }
      useDeviation.getState().resolveAlign(result)
      // The fit is what the marking was for, so the gesture stands down and
      // the camera has its buttons back for looking at the result. What was
      // marked stays marked, ready for another pass.
      useMark.getState().setGesture(null)
      deviation.current = null
      dropReferenceMap()
      sceneRef.current?.setFieldColors(null)
      useStore
        .getState()
        .setStatus(
          `Fine fitted — ${boundLength(usePrefs.getState().units).fmt(result.rms, 4)} RMS over ${result.matched.toLocaleString('en-US')} marked points. Re-measuring the deviation.`,
        )
      await runDeviation()
    } catch (e) {
      if (!current()) return
      const message = e instanceof Error ? e.message : String(e)
      // The fit that was in hand is still the fit that is in hand: a refusal
      // here must not throw away a good global alignment, or the map measured
      // under it.
      useDeviation.getState().failLocal(message)
      useStore.getState().setStatus('')
    }
  }

  const handleRevertLocal = () => {
    useDeviation.getState().revertToGlobal()
    deviation.current = null
    dropReferenceMap()
    sceneRef.current?.setFieldColors(null)
    useStore.getState().setStatus('Back to the global best fit — re-measuring the deviation.')
    void runDeviation()
  }

  /** Measure against this element. The material side is read off the scan as the
   *  element is chosen — see detectMaterialSide for why it is decided here and
   *  then left alone rather than re-derived as the controls move. */
  const selectTarget = (id: number | null) => {
    const dev = useDeviation.getState()
    const target = targetFitOf(useStore.getState().elements, id)
    if (id === null || !target) {
      dev.setTarget(null)
      return
    }
    // The scan's own vertices, without the shading copies past them.
    const scene = sceneRef.current
    const own = (scene?.scanVertexCount() ?? 0) * 3
    const geometry = scene?.scanGeometry()
    const positions = (geometry?.getAttribute('position')?.array as Float32Array | undefined)?.subarray(0, own)
    const normals = (geometry?.getAttribute('normal')?.array as Float32Array | undefined)?.subarray(0, own)
    dev.setTarget(
      id,
      positions && normals
        ? detectMaterialSide(target, positions, normals, dev.maxDistance)
        : 1,
    )
    const name = useStore.getState().elements.find((e) => e.id === id)?.name ?? 'element'
    useStore.getState().setStatus(`Deviation measured against ${name}.`)
  }

  /** The report the panel copies, on the figures given — the legend's, by
   *  default — its lengths in `units`: the screen's for the copy, millimetres
   *  for the agent. Null with no map to report on. */
  const reportText = (stats: DeviationStats | null = useDeviation.getState().stats, units: DisplayUnits = 'mm'): string | null => {
    const dev = useDeviation.getState()
    if (!stats) return null
    if (dev.source === 'element') {
      const elements = useStore.getState().elements
      const target = targetFitOf(elements, dev.targetId)
      if (!target) return null
      return buildElementReport(
        useStore.getState().fileName ?? '',
        elements.find((e) => e.id === dev.targetId)?.name ?? 'element',
        target,
        dev.targetSide,
        stats,
        dev.range,
        dev.maxDistance,
        dev.targetFacingDeg,
        dev.targetScope === 'marked' ? dev.scopeCount : null,
        units,
      )
    }
    if (!dev.align) return null
    return buildDeviationReport(
      useStore.getState().fileName ?? '',
      dev.nominalName ?? '',
      dev.align,
      stats,
      dev.range,
      dev.maxDistance,
      dev.mapFacingDeg,
      units,
    )
  }

  const handleCopyReport = () => {
    const text = reportText(undefined, usePrefs.getState().units)
    if (text) void navigator.clipboard?.writeText(text)
  }

  return {
    openNominal,
    commitNominal,
    runAlign,
    abortAlign,
    startPicking,
    stopPicking,
    runDeviation,
    runReferenceMap,
    runVolume,
    setMapOn,
    watch,
    setMapFacing,
    runLocalAlign,
    selectTarget,
    handleStartMarking,
    handleStopMarking,
    handleClearMarking,
    handleRevertLocal,
    reportText,
    handleCopyReport,
  }
}
