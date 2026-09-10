// SPDX-License-Identifier: AGPL-3.0-only
// The deviation workspace's verbs: load the reference, best-fit the scan onto
// it — globally or on a marked surface — and measure the map. The field
// itself lives in refs owned by App, because other workspaces read it too.
import type { RefObject } from 'react'
import { isReferenceFile, isStepFile } from '../core/formats'
import type { MeshWorkerClient } from '../core/workerClient'
import type { SceneManager } from '../viewer/SceneManager'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { rigidToColumnMajor } from '../core/deviation/rigid'
import { useMark } from '../state/markStore'
import { buildDeviationReport, buildElementReport } from '../core/deviation/report'
import { targetFitOf } from './useElementField'
import type { SourceFiles } from './project'

/** What the status strip says the moment the marking tools come out — the
 *  same tools, and so the same instruction, whichever workspace offered them. */
export const PICK_MARK_TOOL_STATUS =
  'Pick a marking tool in the panel — Window, Brush or Lasso — then drag on the scan.'

export function useDeviationWorkspace({
  clientRef,
  sceneRef,
  deviation,
  deviationRgb,
  sources,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  sources: RefObject<SourceFiles>
}) {
  const openNominal = async (file: File) => {
    if (!isReferenceFile(file.name)) {
      useStore.getState().setError('Unsupported file type — use STL, PLY, OBJ, or STEP.')
      return
    }
    const dev = useDeviation.getState()
    deviation.current = null
    deviationRgb.current = null
    sceneRef.current?.setFieldColors(null)
    dev.beginNominalLoad(file.name)
    useStore
      .getState()
      .setStatus(
        isStepFile(file.name)
          ? 'Reading STEP file — tessellating the CAD surfaces…'
          : 'Reading reference geometry…',
      )
    try {
      const buffer = await file.arrayBuffer()
      sources.current.reference = { name: file.name, bytes: new Uint8Array(buffer.slice(0)) }
      const mesh = await clientRef.current!.loadNominal(file.name, buffer)
      sceneRef.current?.setNominal(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots)
      sceneRef.current?.setAlignment(null)
      useDeviation
        .getState()
        .finishNominalLoad(file.name, mesh.vertexCount, mesh.triangleCount, mesh.step ?? null)
      // Both models on screen from here, wherever the reference happens to sit
      // — otherwise a reference exported in another frame would be aligned
      // entirely off-camera.
      sceneRef.current?.frameAll()

      // A STEP reference is a conversion, and how good a conversion decides
      // how much of the map is the part. A file that came apart in the
      // conversion breaks the sign of every reading, so it gets the toast; a
      // clean one just says what it cost.
      const step = mesh.step
      const converted = step
        ? ` Tessellated from STEP at ${step.surfaceDeviation} mm chord tolerance${
            step.units && step.units !== 'mm' ? `, converted from ${step.units}` : ''
          }.`
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
    } catch (e) {
      useDeviation.getState().nominalFailed()
      useStore.getState().loadFailed(e instanceof Error ? e.message : String(e))
    }
  }

  const runDeviation = async () => {
    const dev = useDeviation.getState()
    if (!dev.align) return
    dev.beginMap()
    try {
      const result = await clientRef.current!.deviate(dev.align.transform)
      deviation.current = result.values
      deviationRgb.current = null
      useDeviation.getState().resolveMap(result.suggestedRange, result.suggestedMaxDistance)
      useStore.getState().setStatus('Deviation measured.')
    } catch (e) {
      // The alignment the map was measured under is still good — only the
      // measurement refused.
      useDeviation.getState().failMap(e instanceof Error ? e.message : String(e))
      useStore.getState().setStatus('')
    }
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
    const dev = useDeviation.getState()
    const selection = usePairs ? sceneRef.current?.paintedVertices() : null
    dev.beginAlign()
    try {
      const result = await clientRef.current!.align(usePairs ? dev.pairs : null, selection)
      if (!result) {
        alignStopped()
        return
      }
      useDeviation.getState().resolveAlign(result)
      stopPicking()
      deviation.current = null
      sceneRef.current?.setFieldColors(null)
      useStore
        .getState()
        .setStatus(
          `Aligned — ${result.rms.toFixed(4)} mm RMS over ${result.matched.toLocaleString('en-US')} points. Measure the deviation next.`,
        )
      void runDeviation()
    } catch (e) {
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

  /** Refine the alignment on the marked surface only, starting from the fit
   *  already in hand. */
  const runLocalAlign = async () => {
    const dev = useDeviation.getState()
    const start = dev.align
    if (!start) return
    const vertices = sceneRef.current?.paintedVertices() ?? new Uint32Array(0)
    dev.beginAlign()
    try {
      const result = await clientRef.current!.alignLocal(
        vertices,
        start.transform,
        dev.localMaxDistance,
      )
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
      sceneRef.current?.setFieldColors(null)
      useStore
        .getState()
        .setStatus(
          `Fine fitted — ${result.rms.toFixed(4)} mm RMS over ${result.matched.toLocaleString('en-US')} marked points. Re-measuring the deviation.`,
        )
      void runDeviation()
    } catch (e) {
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
    sceneRef.current?.setFieldColors(null)
    useStore.getState().setStatus('Back to the global best fit — re-measuring the deviation.')
    void runDeviation()
  }

  const handleCopyReport = () => {
    const dev = useDeviation.getState()
    if (!dev.stats) return
    if (dev.source === 'element') {
      const elements = useStore.getState().elements
      const target = targetFitOf(elements, dev.targetId)
      if (!target) return
      void navigator.clipboard?.writeText(
        buildElementReport(
          useStore.getState().fileName ?? '',
          elements.find((e) => e.id === dev.targetId)?.name ?? 'element',
          target,
          dev.targetSide,
          dev.stats,
          dev.range,
          dev.maxDistance,
          dev.targetFacingDeg,
          dev.targetScope === 'marked' ? dev.scopeCount : null,
        ),
      )
      return
    }
    if (!dev.align) return
    void navigator.clipboard?.writeText(
      buildDeviationReport(
        useStore.getState().fileName ?? '',
        dev.nominalName ?? '',
        dev.align,
        dev.stats,
        dev.range,
        dev.maxDistance,
      ),
    )
  }

  return {
    openNominal,
    runAlign,
    abortAlign,
    startPicking,
    stopPicking,
    runDeviation,
    runLocalAlign,
    handleStartMarking,
    handleStopMarking,
    handleClearMarking,
    handleRevertLocal,
    handleCopyReport,
  }
}
