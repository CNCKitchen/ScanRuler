// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from 'react'
import { MeshWorkerClient } from './core/workerClient'
import { buildSummary } from './core/summary'
import { isMeshFile, isReferenceFile, isStepFile, REFERENCE_ACCEPT } from './core/formats'
import { elementKindInfo } from './core/elements/kinds'
import { creationMethod } from './core/elements/construct'
import {
  applyExtension,
  extensionOf,
  isExtendable,
  sideValue,
  type ExtendSide,
} from './core/elements/extend'
import { roleOf } from './core/elements/refs'
import { dimensionTypeInfo, evaluateDimension, evaluateDimensions } from './core/dimensions'
import type { ElementKind, FitData, PointFit } from './core/types'
import {
  alignmentPreview,
  alignSlotPicks,
  blockedRefs,
  draftColorOf,
  useStore,
  type SelectMode,
} from './state/store'
import type {
  SceneManager,
  OverlayAngle,
  OverlayElement,
  OverlayPair,
  PickHit,
} from './viewer/SceneManager'
import { schemeById } from './viewer/navSchemes'
import { Viewer } from './ui/Viewer'
import { Panel } from './ui/Panel'
import { TopBar } from './ui/TopBar'
import { StatusStrip } from './ui/StatusStrip'
import { BusyOverlay } from './ui/BusyOverlay'
import { ImprintModal } from './ui/Imprint'
import { SupportBanner } from './ui/SupportBanner'
import { DeviationPanel } from './ui/DeviationPanel'
import { ThicknessPanel } from './ui/ThicknessPanel'
import { MapLegend, type LegendStat } from './ui/MapLegend'
import { StartPane, type StartSlot } from './ui/StartPane'
import { HoverReadout, type HoverReading } from './ui/HoverReadout'
import { SplitPicker } from './ui/SplitPicker'
import { markChipText } from './ui/MarkTools'
import { MARK_COLOR, useDeviation } from './state/deviationStore'
import { useMark } from './state/markStore'
import { useThickness } from './state/thicknessStore'
import { paintField, type FieldScale } from './core/field/colormap'
import { fieldHistogram } from './core/field/stats'
import { deviationScale, deviationStats } from './core/deviation/deviation'
import { thicknessScale, thicknessStats } from './core/thickness/thickness'
import { buildDeviationReport } from './core/deviation/report'
import { buildThicknessReport } from './core/thickness/report'
import { rigidInvert, rigidToColumnMajor, type Rigid } from './core/deviation/rigid'
import { ALIGN_PICK_COUNT, describeRigid } from './core/alignment'
import { buildStepFile } from './core/exportStep'
import { buildBinaryStl } from './core/exportStl'

const LARGE_TRIANGLE_WARNING = 5_000_000

export default function App() {
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)
  const [dragging, setDragging] = useState(false)

  // Region of the pending preview fit, kept out of the store because it is a
  // large typed array that only the scene needs.
  const draftRegion = useRef<Uint32Array | null>(null)
  // The deviation field: one float per scan vertex, so hundreds of thousands
  // of them. It stays out of the store for the same reason, and stays on the
  // main thread so that moving the scale or the search distance re-colours the
  // part immediately instead of going back to the worker.
  const deviation = useRef<Float32Array | null>(null)
  const deviationRgb = useRef<Uint8Array | null>(null)
  // The wall thickness field, kept the same way and for the same reasons: one
  // float per scan vertex, and the two ends of its scale move it immediately
  // rather than going back to the worker.
  const thickness = useRef<Float32Array | null>(null)
  const thicknessRgb = useRef<Uint8Array | null>(null)
  // The hover label subscribes to this instead of taking a prop, so a reading
  // that changes every frame does not re-render the workspace around it.
  const hoverSink = useRef<((reading: HoverReading | null) => void) | null>(null)
  // Bumped whenever the draft changes, so a fit that resolves after the user
  // has already picked again (or cancelled) is discarded.
  const draftSeq = useRef(0)

  useEffect(() => {
    clientRef.current!.onProgress = (text) => useStore.getState().setStatus(text)
    // Each refinement pose, straight onto the scan's group. The reference is
    // the datum and stays put, so watching the fit means watching the scan
    // walk onto it — and it costs one matrix write per pass.
    clientRef.current!.onAlignProgress = (transform) => {
      sceneRef.current?.setAlignment(rigidToColumnMajor(transform))
    }
  }, [])

  const clearPreview = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
    sceneRef.current?.setPreview(null)
  }

  const openFile = async (file: File) => {
    if (!isMeshFile(file.name)) {
      useStore
        .getState()
        .setError(
          isStepFile(file.name)
            ? 'A STEP file is CAD, not a scan — load it as the reference in the Deviation workspace.'
            : 'Unsupported file type — use STL, PLY, or OBJ.',
        )
      return
    }
    const store = useStore.getState()
    clearPreview()
    // A different scan invalidates the alignment and the map measured under
    // it, and its wall thickness along with them; the reference geometry
    // itself is still perfectly good.
    deviation.current = null
    deviationRgb.current = null
    thickness.current = null
    thicknessRgb.current = null
    useDeviation.getState().clearAlign()
    useThickness.getState().clear()
    // Nothing is marked on a part that is being replaced, and no gesture should
    // survive the swap.
    useMark.getState().reset()
    store.beginLoad(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const mesh = await clientRef.current!.load(file.name, buffer)
      useStore.getState().setStatus('Building spatial index…')
      await new Promise((r) => setTimeout(r, 30))
      sceneRef.current?.setMesh(mesh.positions, mesh.indices, mesh.normals)
      useStore
        .getState()
        .finishLoad(mesh.vertexCount, mesh.triangleCount, sceneRef.current?.modelSize() ?? 1)
      // The brush is sized to the part it will be used on, in both workspaces.
      useMark.getState().sizeToModel(sceneRef.current?.modelSize() ?? 1)
      // How thick a wall to look for is a property of the part, so the search
      // is sized to the one just loaded — until the user says otherwise.
      useThickness.getState().suggestMaxThickness(2 * (sceneRef.current?.modelSize() ?? 1))
      useStore
        .getState()
        .setStatus(
          mesh.triangleCount > LARGE_TRIANGLE_WARNING
            ? `Large mesh (${mesh.triangleCount.toLocaleString('en-US')} triangles) — fits may take a moment. Pick an element type to start.`
            : 'Pick an element type in the panel to start measuring.',
        )
    } catch (e) {
      useStore.getState().loadFailed(e instanceof Error ? e.message : String(e))
    }
  }

  /** Re-fit an already measured element (used when the sigma preset changes).
   *  A hand-marked element re-fits on its marked surface, an auto-fitted one
   *  from its seeds — both are the recipe the element was made with. */
  const runFit = async (
    elementId: number,
    kind: ElementKind,
    seeds: number[],
    selection?: Uint32Array,
  ) => {
    const settings = useStore.getState().settings
    try {
      const result = selection
        ? await clientRef.current!.fitSelection(kind, selection, settings)
        : await clientRef.current!.fit(kind, seeds, settings)
      useStore.getState().resolveFit(elementId, result)
      const el = useStore.getState().elements.find((e) => e.id === elementId)
      if (el) sceneRef.current?.applyRegion(elementId, el.color, result.region)
    } catch (e) {
      useStore.getState().failFit(elementId, e instanceof Error ? e.message : String(e))
    }
  }

  /** Fit the draft from every picked point at once and show it as a preview.
   *  Picks may sit on unconnected patches — a partial scan of one feature —
   *  and the region growing seeds from all of them. */
  const runDraftFit = async (kind: ElementKind, picks: [number, number, number][]) => {
    const seq = ++draftSeq.current
    const settings = useStore.getState().settings
    const seeds = picks.flat()
    try {
      const result = await clientRef.current!.fit(kind, seeds, settings)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      sceneRef.current?.setPreviewRegion(result.region, draftColorOf(useStore.getState()))
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      sceneRef.current?.setPreviewRegion(null)
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** Fit the draft to the surface the user has marked by hand. The marked
   *  surface is the region, so there is nothing to preview separately — it is
   *  already tinted on the part, in the colour the element will get. */
  const runDraftPaintFit = async (kind: ElementKind, selection: Uint32Array) => {
    const seq = ++draftSeq.current
    const settings = useStore.getState().settings
    useStore.getState().setDraftSelection(selection)
    try {
      const result = await clientRef.current!.fitSelection(kind, selection, settings)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** A marking gesture ended: re-fit on what is marked now, or fall back to an
   *  empty draft once the last of the marking has been rubbed out. */
  const handlePaintChange = (count: number) => {
    // The same marking layer and the same tools serve both workspaces; only who
    // is listening differs — an element re-fits on every stroke, a local best
    // fit waits to be asked.
    useMark.getState().setCount(count)
    if (useDeviation.getState().marking) return
    const store = useStore.getState()
    const draft = store.draft
    if (!draft || creationMethod(draft.kind, draft.method).mode !== 'fit') return
    const selection = sceneRef.current?.paintedVertices() ?? new Uint32Array(0)
    if (selection.length === 0) {
      draftSeq.current++
      draftRegion.current = null
      store.setDraftSelection(null)
      return
    }
    void runDraftPaintFit(draft.kind, selection)
  }

  /** Rub the marking out. The tools stay as they are — which gesture is in the
   *  user's hand outlives the element it was collecting, the same way it
   *  outlives a local fine fit. */
  const clearPaint = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.clearPaint()
    useMark.getState().setCount(0)
    useStore.getState().setDraftSelection(null)
  }

  /** Bake a datum alignment (or its inverse, on reset) into everything that
   *  carries scan coordinates: the worker's copy of the mesh, the displayed
   *  mesh and its BVH, and every element in the store. Vertex order never
   *  changes, so painted regions and fit seeds stay valid. A scan→reference
   *  best fit was measured in the old frame and is invalidated along with the
   *  deviation map on it. */
  const applyRigidToPart = async (m: Rigid) => {
    clearPreview()
    useStore.getState().setStatus('Aligning part — rebuilding spatial index…')
    // Let the status paint before the synchronous BVH rebuild.
    await new Promise((r) => setTimeout(r, 30))
    await clientRef.current!.transform(m)
    // The real transform goes on and the preview of it comes off in the same
    // breath: the pose is the same either way, so the part never flinches.
    sceneRef.current?.applyTransform(m)
    sceneRef.current?.setAlignPreview(null)
    useStore.getState().applyAlignment(m)
    deviation.current = null
    deviationRgb.current = null
    sceneRef.current?.setFieldColors(null)
    useDeviation.getState().clearAlign()
  }

  const handleStartAlignment = () => {
    clearPreview()
    useStore.getState().startAlignment()
    useStore
      .getState()
      .setStatus('Level the part first — use a measured element or pick points on the scan.')
  }

  const handleApplyAlignment = async (m: Rigid) => {
    const { rotationDeg, translation } = describeRigid(m)
    await applyRigidToPart(m)
    useStore
      .getState()
      .setStatus(
        `Part aligned — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
  }

  const handleApplyManual = async (m: Rigid) => {
    const { rotationDeg, translation } = describeRigid(m)
    await applyRigidToPart(m)
    useStore
      .getState()
      .setStatus(
        `Part moved — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
  }

  const handleResetAlignment = async () => {
    const total = useStore.getState().appliedAlignment
    if (!total) return
    await applyRigidToPart(rigidInvert(total))
    useStore.getState().clearAppliedAlignment()
    useStore.getState().setStatus('Alignment reset — the part is back in scan coordinates.')
  }

  /** Hand a built file to the browser. The object URL outlives the click by
   *  long enough for the download to start, then goes. */
  const saveFile = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  /** The scan's name without its extension — the stem every export is built
   *  on. */
  const exportStem = () => (useStore.getState().fileName ?? 'scan').replace(/\.[^.]+$/, '')

  /** Hand the created elements over as analytic STEP geometry. */
  const handleExportStep = () => {
    const store = useStore.getState()
    const els = store.elements.filter((e) => e.fit)
    if (els.length === 0) return
    const text = buildStepFile(
      // What is exported is what is on screen, extensions and all.
      els.map((e) => ({ name: e.name, fit: applyExtension(e.fit!, e.extend) })),
      store.fileName ?? 'scan',
      new Date().toISOString().slice(0, 19),
      store.stepStyle,
    )
    const name = `${exportStem()}-elements.step`
    saveFile(name, new Blob([text], { type: 'model/step' }))
    store.setStatus(
      `${els.length} element${els.length === 1 ? '' : 's'} exported to ${name} as ${
        store.stepStyle === 'solids' ? 'solids and faces' : 'construction surfaces'
      }.`,
    )
  }

  /** Hand the scan back as an STL in the pose it is being shown in.
   *
   *  A 3-2-1 or typed-in alignment is already baked into the vertices, so it
   *  comes along for free. The deviation workspace's best fit is not: it rides
   *  on the scan's group matrix so the fit can be watched and undone, and it
   *  has to be applied on the way out. Either way what lands on disk is the
   *  part where the user can see it. */
  const handleExportStl = () => {
    const store = useStore.getState()
    const geometry = sceneRef.current?.scanGeometry()
    if (!geometry || !store.fileName) return
    const positions = geometry.getAttribute('position')?.array as Float32Array | undefined
    if (!positions) return
    const index = geometry.getIndex()?.array as Uint32Array | Uint16Array | undefined
    const align = useDeviation.getState().align
    const moved = align !== null || store.appliedAlignment !== null
    const stem = exportStem()
    // Never the name it came in under, however little has happened to it: the
    // export lands in the same folder the scan was picked from, and silently
    // shadowing the original there is not a thing a measuring tool should do.
    const name = `${stem}-${moved ? 'aligned' : 'export'}.stl`
    const buffer = buildBinaryStl(
      positions,
      index ?? null,
      align?.transform ?? null,
      `ScanRuler scan export - ${stem}`,
    )
    saveFile(name, new Blob([buffer], { type: 'model/stl' }))
    const triangles = (index ? index.length : positions.length / 3) / 3
    store.setStatus(
      `Scan exported to ${name} — ${triangles.toLocaleString('en-US')} triangles${
        moved ? ', in its aligned position' : ''
      }.`,
    )
  }

  // ---- Deviation workspace -------------------------------------------------

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
      const mesh = await clientRef.current!.loadNominal(file.name, await file.arrayBuffer())
      sceneRef.current?.setNominal(mesh.positions, mesh.indices, mesh.normals)
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

  /** Run the best fit. With no pairs this is the automatic match; with pairs it
   *  starts from them instead. Either way ICP does the fine work. */
  const runAlign = async (usePairs: boolean) => {
    const dev = useDeviation.getState()
    dev.beginAlign()
    try {
      const result = await clientRef.current!.align(usePairs ? dev.pairs : null)
      useDeviation.getState().resolveAlign(result)
      useDeviation.getState().stopPicking()
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
    useStore
      .getState()
      .setStatus(
        'Pick a marking tool in the panel — Window, Brush or Lasso — then drag on the scan.',
      )
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
      useDeviation.getState().failAlign(e instanceof Error ? e.message : String(e))
      useStore.getState().setStatus('')
    }
  }

  // ---- Wall thickness workspace --------------------------------------------

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

  /** Whichever map the workspace is showing, at a point on the scan:
   *  interpolated across the triangle the click landed in rather than snapped
   *  to a vertex, and written the way that map is written. Null where there is
   *  no map, or where the vertices around the hit carry no measurement. */
  const readingAt = (hit: PickHit): (HoverReading & { value: number }) | null => {
    const onThickness = useDeviation.getState().workspace === 'thickness'
    const values = onThickness ? thickness.current : deviation.current
    if (!values) return null
    const [a, b, c] = hit.vertices
    const [wa, wb, wc] = hit.weights
    const value = values[a] * wa + values[b] * wb + values[c] * wc
    if (!Number.isFinite(value)) return null
    const at = { value, x: hit.clientX, y: hit.clientY }
    if (onThickness) return { ...at, text: `${value.toFixed(3)} mm`, muted: false }
    const matched = Math.abs(value) <= useDeviation.getState().maxDistance
    return {
      ...at,
      text: matched
        ? `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(3)} mm`
        : 'no reference in range',
      muted: !matched,
    }
  }

  const handleHover = (hit: PickHit | null) => {
    hoverSink.current?.(hit ? readingAt(hit) : null)
  }

  const handleCopyReport = () => {
    const dev = useDeviation.getState()
    if (!dev.align || !dev.stats) return
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

  const handlePick = (hit: PickHit) => {
    const store = useStore.getState()
    // On either map a click pins the reading under it; alignment points are
    // picked in the split view, which has its own scenes.
    const workspace = useDeviation.getState().workspace
    if (workspace !== 'elements') {
      const reading = readingAt(hit)
      if (!reading) return
      if (workspace === 'thickness') useThickness.getState().addProbe(hit.point, reading.value)
      else useDeviation.getState().addProbe(hit.point, reading.value)
      return
    }
    const faceVertices = hit.vertices
    if (!store.fileName || store.busy) return
    // A slot of the alignment editor collecting points takes the raw click.
    if (store.alignDraft?.pickSlot) {
      store.addAlignmentPick(hit.point)
      return
    }
    if (!store.draft) {
      store.setStatus(
        store.dimDraft
          ? 'Nothing selectable there — click a fitted element (coloured surface or shape).'
          : 'Pick an element type in the panel to start a new fit.',
      )
      return
    }
    const method = creationMethod(store.draft.kind, store.draft.method)
    // Constructions are assembled in the panel; clicks on the scan are not
    // theirs to consume.
    if (method.mode === 'construct') return
    if (method.mode === 'pick') {
      // A picked point is the exact raycast hit — no worker round-trip, and
      // clicking again moves it rather than adding to it.
      store.setDraftPicks([faceVertices])
      const fit: PointFit = {
        kind: 'point',
        center: hit.point,
        sigma: 0,
        usedPoints: 0,
        regionSize: 0,
      }
      useStore.getState().resolveDraft({ ...fit, region: new Uint32Array(0) })
      return
    }
    const picks: [number, number, number][] = [...store.draft.picks, faceVertices]
    store.setDraftPicks(picks)
    void runDraftFit(store.draft.kind, picks)
  }

  /** A viewport click that landed on an existing element: hand it to whichever
   *  editor is collecting references — the dimension draft, or a construction
   *  draft's slots. Clicking an element that is already used takes it out. */
  const handleElementPick = (id: number) => {
    const store = useStore.getState()
    const el = store.elements.find((e) => e.id === id)
    if (!el?.fit) return
    if (store.draft) {
      const method = creationMethod(store.draft.kind, store.draft.method)
      if (method.mode !== 'construct') return
      if (blockedRefs(store.draft.editId, store.elements).has(id)) {
        store.setStatus(
          id === store.draft.editId
            ? `${el.name} cannot be built on itself.`
            : `${el.name} is built on the element being edited — it cannot be a source of it.`,
        )
        return
      }
      const usedSlot = store.draft.refs.indexOf(id)
      if (usedSlot >= 0) {
        store.setDraftRef(usedSlot, null)
        return
      }
      const role = roleOf(el.kind)
      const slot = method.slots.findIndex(
        (sl, i) => store.draft!.refs[i] === null && sl.role === role,
      )
      if (slot >= 0) store.setDraftRef(slot, id)
      else store.setStatus(`No open slot takes ${el.name} in this construction.`)
      return
    }
    if (store.alignDraft) {
      store.selectAlignmentElement(id)
      return
    }
    if (store.dimDraft) store.selectDimensionElement(id)
  }

  const handleStartDraft = (kind: ElementKind) => {
    const store = useStore.getState()
    clearPreview()
    // A new element starts from bare scan, whichever way the last one was
    // collected — the brush stays armed, but nothing is marked for it yet.
    clearPaint()
    store.startDraft(kind)
    const draft = useStore.getState().draft!
    const method = creationMethod(kind, draft.method)
    store.setStatus(
      method.mode === 'construct' ? 'Select the source elements in the panel.' : method.hint,
    )
  }

  /** Re-open an element in the box it was created in. Everything it was made
   *  from comes back with it — the seeds re-fit into a live preview, a
   *  hand-marked surface goes back onto the part under the marking tools, a
   *  construction's references and numbers into their fields — so changing it
   *  is the same work as making it was. */
  const handleEditElement = (id: number) => {
    const store = useStore.getState()
    const el = store.elements.find((e) => e.id === id)
    if (!el) return
    clearPreview()
    clearPaint()
    store.editElement(id)
    const draft = useStore.getState().draft
    if (!draft) return
    const method = creationMethod(draft.kind, draft.method)
    if (method.mode === 'fit') {
      if (draft.selection) {
        // Straight back onto the part, in the element's own colour: the brush
        // arms itself around it on the next render.
        sceneRef.current?.setPaintedVertices(draft.selection, el.color)
        useMark.getState().setCount(draft.selection.length)
      } else if (draft.picks.length > 0) {
        void runDraftFit(draft.kind, draft.picks)
      }
    }
    store.setStatus(
      method.mode === 'construct'
        ? `Editing ${el.name} — change its sources or numbers, then save.`
        : draft.selection
          ? `Editing ${el.name} — add to or rub out the marked surface, then save.`
          : method.mode === 'pick'
            ? `Editing ${el.name} — click the scan to move the point, then save.`
            : `Editing ${el.name} — click the scan to re-pick the surface, then save.`,
    )
  }

  /** "+ Pick point on scan…" inside the dimension editor: start a point draft
   *  whose committed element drops into the waiting slot. */
  const handleDimensionPick = (slot: number) => {
    clearPreview()
    useStore.getState().beginDimensionPick(slot)
    useStore.getState().setStatus('Click the point on the scan you want to measure to.')
  }

  /** Switch between clicking a point and marking the surface by hand. Both
   *  start the fit over: what one of them collected means nothing to the
   *  other. */
  const handleSelectMode = (mode: SelectMode) => {
    const store = useStore.getState()
    if (mode === store.selectMode) return
    clearPreview()
    clearPaint()
    store.setSelectMode(mode)
    if (store.draft) store.setDraftPicks([])
    store.setStatus(
      mode === 'paint'
        ? 'Pick a marking tool in the panel — Window, Brush or Lasso — then drag on the scan.'
        : 'Click a point on the surface you want to measure.',
    )
  }

  const handleUndoPick = () => {
    const store = useStore.getState()
    if (!store.draft || store.draft.picks.length === 0) return
    const kind = store.draft.kind
    const picks = store.draft.picks.slice(0, -1)
    store.setDraftPicks(picks)
    clearPreview()
    if (picks.length > 0) void runDraftFit(kind, picks)
  }

  const handleCancelDraft = () => {
    clearPreview()
    clearPaint()
    useStore.getState().cancelDraft()
    useStore.getState().setStatus('')
  }

  const handleConfirmDraft = () => {
    const region = draftRegion.current
    const editing = useStore.getState().draft?.editId !== undefined
    const id = useStore.getState().commitDraft()
    if (id === null) return
    clearPreview()
    // The marking hands its surface over to the element that was made from it:
    // clear it first, so the element's own tint is what stays on the part.
    clearPaint()
    const el = useStore.getState().elements.find((e) => e.id === id)
    if (el && region) sceneRef.current?.applyRegion(id, el.color, region)
    // An element that has stopped being fitted — re-made from coordinates or
    // from other elements — leaves the surface it used to own behind.
    else if (el && el.source.type !== 'fitted') sceneRef.current?.clearElement(id)
    useStore.getState().setStatus(`${el?.name ?? 'Element'} ${editing ? 'updated' : 'created'}.`)
  }

  // Changing "Used points" re-fits every element with its stored seeds, and
  // refreshes the pending preview if one is open.
  const sigma = useStore((s) => s.settings.sigma)
  const firstSigma = useRef(true)
  useEffect(() => {
    if (firstSigma.current) {
      firstSigma.current = false
      return
    }
    const store = useStore.getState()
    for (const el of store.elements) {
      if (el.status !== 'done' || el.source.type !== 'fitted') continue
      // The one being edited re-fits as the draft below, not twice over.
      if (store.draft?.editId === el.id) continue
      const selection = el.source.selection
      store.markFitting(el.id, el.source.seeds, selection)
      void runFit(el.id, el.kind, el.source.seeds, selection)
    }
    const draft = store.draft
    if (draft && creationMethod(draft.kind, draft.method).mode === 'fit') {
      if (draft.selection) void runDraftPaintFit(draft.kind, draft.selection)
      else if (draft.picks.length > 0) {
        store.setDraftPicks(draft.picks)
        void runDraftFit(draft.kind, draft.picks)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma])

  // The colour the open draft wears, on its ghost, its grips and whatever
  // surface is marked for it: an edited element keeps its own, a new one takes
  // the next in the palette.
  const draftColor = useStore(draftColorOf)

  // The draft's ghost shape follows whatever the draft currently is — a fit
  // preview, a picked point, or a construction taking shape in the panel.
  const draftFit = useStore((s) => (s.draft?.status === 'ready' ? s.draft.fit : undefined))
  const draftExtend = useStore((s) => s.draft?.extend)
  // What the ghost is: the fit, carrying however far past its measured surface
  // it has been extended. Recomputed rather than stored, so the fit under it
  // stays the measurement.
  const shownDraftFit = useMemo(
    () => (draftFit ? applyExtension(draftFit, draftExtend) : null),
    [draftFit, draftExtend],
  )
  useEffect(() => {
    sceneRef.current?.setPreview(shownDraftFit)
  }, [shownDraftFit])

  // Grips on the ghost, for the two shapes with a size to give: the ends of a
  // cylinder, the edges of a plane. They ride on the drawn shape, so they sit
  // where the element currently reaches and follow every millimetre typed into
  // the panel.
  const gripFit = shownDraftFit && isExtendable(shownDraftFit) ? shownDraftFit : null
  useEffect(() => {
    sceneRef.current?.setExtendHandles(gripFit, draftColor)
  }, [gripFit, draftColor])

  // Where the side being dragged stood when the drag began. The viewport
  // reports how far the grip has come rather than where it is, so every move
  // is start + delta — which is what lets a drag run into the clamp and come
  // back out again without losing anything on the way.
  const extendStart = useRef(0)
  const handleExtendDrag = (side: ExtendSide, delta: number, phase: 'start' | 'move' | 'end') => {
    const store = useStore.getState()
    const fit = store.draft?.fit
    if (!isExtendable(fit)) return
    if (phase === 'start') {
      extendStart.current = sideValue(extensionOf(fit, store.draft?.extend), side)
    } else if (phase === 'move') {
      store.setDraftExtend(side, extendStart.current + delta)
    }
  }

  // The marking layer is armed for exactly one of two sessions: a fit draft
  // collecting its surface by hand, or the deviation workspace's local fine
  // fit. Never for a construction, whose inputs are elements rather than scan
  // surface, and never in the thickness workspace. Both drive the same tools,
  // so the only thing that differs is the colour the marking takes — the tint
  // the pending element will wear, or the fine fit's own. Re-arming on a change
  // of gesture, radius, colour or erase keeps whatever is already marked.
  const painting = useStore(
    (s) =>
      s.selectMode === 'paint' &&
      s.draft !== null &&
      creationMethod(s.draft.kind, s.draft.method).mode === 'fit',
  )
  const paintWorkspace = useDeviation((s) => s.workspace === 'elements')
  const marking = useDeviation((s) => s.marking)
  const markWorkspace = useDeviation((s) => s.workspace === 'deviation')
  const markGesture = useMark((s) => s.gesture)
  const markErase = useMark((s) => s.erase)
  const markBackfaces = useMark((s) => s.backfaces)
  const brushDiameter = useMark((s) => s.diameter)
  const paintSession = painting && paintWorkspace
  const markSession = marking && markWorkspace
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!paintSession && !markSession) {
      scene.setPaintBrush(null)
      if (useMark.getState().count !== 0) useMark.getState().setCount(0)
      return
    }
    scene.setPaintBrush({
      color: paintSession ? draftColor : MARK_COLOR,
      diameter: brushDiameter,
      erase: markErase,
      gesture: markGesture,
      backfaces: markBackfaces,
    })
  }, [
    paintSession,
    markSession,
    draftColor,
    brushDiameter,
    markErase,
    markGesture,
    markBackfaces,
  ])

  // Which way the surface faces, shown on the surface itself.
  const showBackfaces = useStore((s) => s.showBackfaces)
  useEffect(() => {
    sceneRef.current?.setBackfaceTint(showBackfaces)
  }, [showBackfaces])

  // Keep viewport overlays in sync with the elements and the dimensions the
  // user created between them.
  const elements = useStore((s) => s.elements)
  const dimensions = useStore((s) => s.dimensions)
  const showOverlays = useStore((s) => s.showOverlays)
  // Elements and their dimensions are results of the measure workspace and
  // belong to it: a fitted sphere sitting on a deviation map is a second set
  // of colours over a reading, and its label competes with the map's own
  // figures. They stay measured — leaving the workspace only puts them away,
  // and coming back shows them again without re-fitting.
  const elementsWorkspace = useDeviation((s) => s.workspace === 'elements')
  const draft = useStore((s) => s.draft)
  const dimDraft = useStore((s) => s.dimDraft)
  const alignDraft = useStore((s) => s.alignDraft)
  // Elements referenced by the dimension, construction or alignment being
  // built read as selected in the viewport, however they were chosen.
  const highlightIds = [
    ...(dimDraft?.refs ?? []),
    ...(draft?.refs ?? []),
    ...(alignDraft ? [alignDraft.primary, alignDraft.secondary, alignDraft.origin] : []),
  ].filter((r): r is number => r !== null)
  const highlightKey = highlightIds.join(',')
  // What is open in an editor is drawn as the pending preview instead of as
  // itself, so the old geometry does not sit inside the new one.
  const editingElementId = draft?.editId
  const editingDimensionId = dimDraft?.editId
  useEffect(() => {
    const items: OverlayElement[] = elements
      .filter((e) => e.fit && e.visible && e.id !== editingElementId)
      // Drawn at whatever length or size it was extended to — the fit itself
      // stays the measured surface, and everything that reports a number goes
      // on reading that.
      .map((e) => ({
        id: e.id,
        name: e.name,
        color: e.color,
        fit: applyExtension(e.fit!, e.extend),
      }))
    // Distances draw as a line between their two anchor points, angles as an
    // arc at their hinge.
    const rows = evaluateDimensions(
      dimensions.filter((d) => d.visible !== false && d.id !== editingDimensionId),
      elements,
    ).filter((r) => !r.value.invalid)
    const pairs: OverlayPair[] = rows
      .filter((r) => r.value.segment)
      .map((r) => ({
        a: r.value.segment![0],
        b: r.value.segment![1],
        title: r.dim.name,
        value: r.value.value!,
      }))
    const angles: OverlayAngle[] = rows
      .filter((r) => r.value.arc)
      .map((r) => ({
        ...r.value.arc!,
        title: r.dim.name,
        value: r.value.value!,
      }))
    sceneRef.current?.updateOverlays(items, pairs, angles, showOverlays && elementsWorkspace)
    // A hidden element's surface tint goes with its overlay — and outside the
    // measure workspace that is every element, so the scan is bare underneath
    // whichever map is being read. Ownership stays recorded either way, so
    // this is a repaint on the way back, not a re-fit.
    // The element being edited goes with them: its surface is about to be
    // re-chosen, and its old tint underneath the new one would only be read as
    // part of it.
    sceneRef.current?.setHiddenRegions(
      (elementsWorkspace ? elements.filter((e) => !e.visible || e.id === editingElementId) : elements).map(
        (e) => e.id,
      ),
    )
    // Overlays were rebuilt, so the selection glow has to be re-applied.
    sceneRef.current?.setHighlightedElements(highlightIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, dimensions, showOverlays, elementsWorkspace, editingElementId, editingDimensionId])

  useEffect(() => {
    sceneRef.current?.setHighlightedElements(highlightIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Points picked for the alignment stay marked on the part, numbered in the
  // order they were clicked so the count is readable at a glance.
  useEffect(() => {
    sceneRef.current?.setPickMarkers(
      !alignDraft
        ? []
        : [
            ...alignDraft.primaryPicks.map((p, i) => ({
              point: p,
              label: `Point ${i + 1}`,
              color: '#1877c0',
            })),
            ...alignDraft.secondaryPicks.map((p, i) => ({
              point: p,
              label: `Rotate ${i + 1}`,
              color: '#e8590c',
            })),
            ...alignDraft.originPicks.map((p) => ({
              point: p,
              label: 'Zero',
              color: '#2e7d46',
            })),
          ],
    )
  }, [alignDraft])

  // The alignment being set up is shown on the part, not just described in the
  // panel: the moment a slot has what it needs the scan swings onto the axis
  // it would land on, and it swings again on every further pick and every
  // change of the axis it points along. So the choice is judged by looking at
  // the part rather than by reading a number and pressing Apply to find out.
  //
  // Nothing is baked — this is a matrix on the scan's group, so it is free
  // enough to follow the controls, and picking still reports scan coordinates
  // underneath it. Applying (or cancelling) lifts it again.
  const modelSize = useStore((s) => s.modelSize)
  useEffect(() => {
    const rigid = alignDraft ? alignmentPreview(alignDraft, elements, modelSize).preview : null
    sceneRef.current?.setAlignPreview(rigid ? rigidToColumnMajor(rigid.rigid) : null)
  }, [alignDraft, elements, modelSize])

  // A viewport click selects elements whenever a dimension is being assembled
  // or a construction has reference slots — but never while clicks are picking
  // scan points for a fit, and never in the deviation workspace.
  // While an alignment slot is collecting points, clicks must land on the raw
  // surface even where an element's region is painted — so element picking
  // stands down for the duration.
  const wantsElementPicks =
    elementsWorkspace &&
    (((dimDraft !== null || (alignDraft !== null && alignDraft.pickSlot === null)) &&
      draft === null) ||
      (draft !== null && creationMethod(draft.kind, draft.method).mode === 'construct'))
  useEffect(() => {
    sceneRef.current?.setElementPickEnabled(wantsElementPicks)
  }, [wantsElementPicks])

  // Re-colour the scan whenever the map or the way it is read changes. This is
  // ~700k vertices of work, but it is a few milliseconds and it keeps the
  // scale controls immediate — a slider that had to wait on the worker would
  // feel like a different instrument.
  const workspace = useDeviation((s) => s.workspace)
  const mapVersion = useDeviation((s) => s.mapVersion)
  const range = useDeviation((s) => s.range)
  const maxDistance = useDeviation((s) => s.maxDistance)
  const bands = useDeviation((s) => s.bands)
  const tolerance = useDeviation((s) => s.tolerance)
  const thickVersion = useThickness((s) => s.mapVersion)
  const thickLow = useThickness((s) => s.low)
  const thickHigh = useThickness((s) => s.high)
  const thickBands = useThickness((s) => s.bands)
  const thickLimit = useThickness((s) => s.limit)
  // Held stable across renders, because it is what tells the repaint below
  // whether anything actually changed.
  const thickScale = useMemo(
    () => thicknessScale(thickLow, thickHigh, thickBands),
    [thickLow, thickHigh, thickBands],
  )
  // How each map writes a number, wherever one is shown — on the scale, in the
  // hover label, on a pin. A deviation is signed against a zero that is the
  // whole point of it; a wall thickness is a plain positive length.
  const mm = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`
  const wall = (v: number): string => v.toFixed(3)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Whichever map this workspace is showing: colour the scan from it and
    // hand its numbers to the legend. The two differ only in the scale they
    // are read through and in the figures that go under it.
    const showing =
      workspace === 'deviation' && deviation.current
        ? {
            values: deviation.current,
            rgb: deviationRgb,
            scale: deviationScale(range, maxDistance, bands),
          }
        : workspace === 'thickness' && thickness.current
          ? { values: thickness.current, rgb: thicknessRgb, scale: thickScale }
          : null
    if (!showing) {
      scene.setFieldColors(null)
      return
    }

    const { values, rgb: rgbRef, scale } = showing
    let rgb = rgbRef.current
    if (!rgb || rgb.length !== values.length * 3) {
      rgb = new Uint8Array(values.length * 3)
      rgbRef.current = rgb
    }
    paintField(values, scale, rgb)
    scene.setFieldColors(rgb)

    const histogram = fieldHistogram(values, scale.low, scale.high, scale.validMin, scale.validMax)
    if (workspace === 'deviation') {
      useDeviation.getState().setReadout(deviationStats(values, maxDistance, tolerance), histogram)
    } else {
      useThickness.getState().setReadout(thicknessStats(values, thickLimit), histogram)
    }
  }, [
    workspace,
    mapVersion,
    range,
    maxDistance,
    bands,
    tolerance,
    thickVersion,
    thickScale,
    thickLimit,
  ])

  // The alignment moves the reference, never the scan: the scan carries the
  // map and any elements measured in the other workspace.
  const align = useDeviation((s) => s.align)
  const showNominal = useDeviation((s) => s.showNominal)
  const nominalName = useDeviation((s) => s.nominalName)
  // Loaded, not merely named: the store records the name the moment the read
  // starts, and the scene has no reference mesh to show until it finishes.
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const nominalReady = Boolean(nominalName) && !nominalBusy
  useEffect(() => {
    sceneRef.current?.setAlignment(align ? rigidToColumnMajor(align.transform) : null)
  }, [align])
  // Both models are on screen as soon as both are loaded. The reference is a
  // ghost while the scan is there to be seen through it, and turns solid when
  // the scan is switched off — which is how you check it is the right part,
  // since an aligned reference otherwise sits inside a scan of the same shape
  // and loses the depth test everywhere.
  const showScan = useDeviation((s) => s.showScan)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const onDev = workspace === 'deviation'
    scene.setNominalVisible(onDev && nominalReady && showNominal)
    scene.setNominalGhost(!onDev || showScan)
    scene.setScanVisible(!onDev || showScan)
  }, [workspace, showNominal, showScan, nominalReady])

  // Which mouse buttons orbit, pan and zoom. Held in the store rather than the
  // scene so the status strip can show it and remember it.
  const navScheme = useStore((s) => s.navScheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  // Pins belong to the map they were taken off, and only that map: a thickness
  // in millimetres and a deviation in millimetres look identical on the part,
  // so showing both at once would be a way to misread one of them.
  const probes = useDeviation((s) => s.probes)
  const thickProbes = useThickness((s) => s.probes)
  useEffect(() => {
    const shown =
      workspace === 'deviation'
        ? probes.map((p) => ({
            ...p,
            label: `${p.value >= 0 ? '+' : '−'}${Math.abs(p.value).toFixed(3)} mm`,
          }))
        : workspace === 'thickness'
          ? thickProbes.map((p) => ({ ...p, label: `${wall(p.value)} mm` }))
          : []
    sceneRef.current?.setProbes(
      shown.map((p, i) => ({
        id: p.id,
        point: p.point,
        label: p.label,
        color: i % 2 === 0 ? '#26282a' : '#12629f',
      })),
    )
  }, [workspace, probes, thickProbes])

  // A half-finished element fit or alignment has no meaning in the other
  // workspaces.
  useEffect(() => {
    // Leaving the deviation workspace drops the marking with it — the scene
    // clears it when the tools are put away, and a count left standing for a
    // marking that no longer exists would offer a fit of nothing.
    if (workspace !== 'deviation' && useDeviation.getState().marking) {
      useDeviation.getState().stopMarking()
    }
    // Both workspaces mark with the same tools, so a gesture picked in one must
    // not still be holding the mouse when the other opens. Within a workspace
    // the choice sticks: whoever marked the last element with a lasso means to
    // mark the next one with it too.
    useMark.getState().reset()
    if (workspace === 'elements') return
    if (useStore.getState().draft) handleCancelDraft()
    if (useStore.getState().alignDraft) useStore.getState().cancelAlignment()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // While the split picker is up the main viewport is hidden behind it; stop
  // rendering it rather than paying for a 1.4-million-triangle frame nobody
  // can see. The mesh and its BVH stay loaded.
  const picking = useDeviation((s) => s.picking)
  useEffect(() => {
    sceneRef.current?.setPaused(picking)
  }, [picking])

  // Hover testing only earns its frame when there is a map to read.
  const hasDeviationMap = useDeviation((s) => s.mapStatus === 'ready')
  const hasThicknessMap = useThickness((s) => s.status === 'ready')
  const hasMap =
    (workspace === 'deviation' && hasDeviationMap) || (workspace === 'thickness' && hasThicknessMap)
  useEffect(() => {
    sceneRef.current?.setHoverEnabled(hasMap && !picking)
  }, [hasMap, picking])

  // Error toasts clear themselves.
  const errorText = useStore((s) => s.errorText)
  useEffect(() => {
    if (!errorText) return
    const t = setTimeout(() => useStore.getState().setError(null), 6000)
    return () => clearTimeout(t)
  }, [errorText])

  // Enter or a middle-mouse click confirms the pending element — or, with no
  // element draft open, the pending dimension — and Escape discards it. The
  // middle click only counts when it isn't a drag — the middle button also
  // drives the camera zoom.
  useEffect(() => {
    // Mirrors the "Add dimension" button: every slot filled and the preview
    // actually producing a value.
    const dimensionReady = () => {
      const s = useStore.getState()
      const dd = s.dimDraft
      if (!dd || s.draft || dd.refs.some((r) => r === null)) return false
      const fits = dd.refs.map((id) => s.elements.find((el) => el.id === id)?.fit)
      if (!fits.every((f): f is FitData => f !== undefined)) return false
      return !evaluateDimension(dd.type, fits, dd.anchor).invalid
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      const store = useStore.getState()
      if (useDeviation.getState().marking) {
        // Escape backs out one step at a time: the first hands the camera back
        // by standing the gesture down, the second closes the local fine fit
        // and takes the marking with it. Never both at once — the key is
        // reached for to get the mouse working again, and losing a marking to
        // that would be a trap.
        if (e.key !== 'Escape') return
        if (useMark.getState().gesture !== null) useMark.getState().setGesture(null)
        else handleStopMarking()
        return
      }
      if (store.draft) {
        if (e.key === 'Escape') {
          // The same retreat while an element is being marked by hand: the
          // first Escape hands the camera back, the second discards the draft.
          // Never both at once — the key is reached for to get the mouse
          // working again, and losing the marking to that would be a trap.
          const marked =
            store.selectMode === 'paint' &&
            creationMethod(store.draft.kind, store.draft.method).mode === 'fit'
          if (marked && useMark.getState().gesture !== null) useMark.getState().setGesture(null)
          else handleCancelDraft()
        } else if (e.key === 'Enter' && store.draft.status === 'ready') handleConfirmDraft()
        return
      }
      if (store.alignDraft) {
        // First Escape leaves point picking, the second closes the editor.
        if (e.key === 'Escape') {
          if (store.alignDraft.pickSlot !== null) store.cancelAlignmentPick()
          else store.cancelAlignment()
        }
        return
      }
      if (store.dimDraft) {
        if (e.key === 'Escape') store.cancelDimension()
        else if (e.key === 'Enter' && dimensionReady()) store.commitDimension()
      }
    }
    /** What a confirm would land on right now, if anything. */
    const confirmable = (): 'draft' | 'dimension' | null => {
      const store = useStore.getState()
      if (store.draft) return store.draft.status === 'ready' ? 'draft' : null
      return dimensionReady() ? 'dimension' : null
    }
    let middleDown: { x: number; y: number } | null = null
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      middleDown = { x: e.clientX, y: e.clientY }
      // Keep the browser's middle-click autoscroll out of the way while an
      // element or dimension is waiting to be confirmed.
      if (confirmable()) e.preventDefault()
    }
    const onPointerUp = (e: PointerEvent) => {
      const down = middleDown
      middleDown = null
      if (e.button !== 1 || !down) return
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) return
      const what = confirmable()
      if (what === 'draft') handleConfirmDraft()
      else if (what === 'dimension') useStore.getState().commitDimension()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drag & drop anywhere.
  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      // In the deviation workspace a drop fills whichever slot is still empty,
      // so the two files can simply be dropped one after the other; only once
      // both are there does a drop mean "replace the scan". A STEP file is the
      // exception: it can only ever be the reference, so it goes there however
      // full the slots are.
      const dev = useDeviation.getState()
      if (dev.workspace === 'deviation') {
        if (isStepFile(file.name) || (useStore.getState().fileName && !dev.nominalName)) {
          void openNominal(file)
          return
        }
      }
      void openFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopy = () => {
    const store = useStore.getState()
    const text = buildSummary(
      store.fileName ?? '',
      store.settings,
      store.elements,
      evaluateDimensions(store.dimensions, store.elements),
    )
    void navigator.clipboard?.writeText(text)
  }

  const handleDelete = (id: number) => {
    sceneRef.current?.clearElement(id)
    useStore.getState().removeElement(id)
  }

  // The instruction of the moment rides above the model; everything else the
  // tool has to say goes to the status strip.
  const fileName = useStore((s) => s.fileName)
  const draftMode = draft ? creationMethod(draft.kind, draft.method).mode : null
  // While a dimension is collecting references, say which slot a viewport
  // click would fill; a construction slot invites clicks the same way.
  const openSlotHint = (() => {
    if (!draft && alignDraft) {
      if (alignDraft.pickSlot !== null) {
        const need = ALIGN_PICK_COUNT[alignDraft.pickSlot]
        const have = alignSlotPicks(alignDraft, alignDraft.pickSlot).length
        const what =
          alignDraft.pickSlot === 'primary'
            ? 'for levelling'
            : alignDraft.pickSlot === 'secondary'
              ? 'for the rotation'
              : 'as the zero point'
        return `Click the scan — point ${have + 1} of ${need} ${what} · Esc to stop picking`
      }
      return alignDraft.primary === null && alignDraft.primaryPicks.length === 0
        ? 'Click the element that should level the part — or pick points via the panel'
        : 'Add a rotation direction or a zero point — then apply the alignment in the panel'
    }
    if (draft && draftMode === 'construct') {
      const method = creationMethod(draft.kind, draft.method)
      const empty = draft.refs.findIndex((r) => r === null)
      if (empty < 0) return null
      return `Click an element in the viewport for “${method.slots[empty].label}” — or choose it in the panel`
    }
    if (draft || !dimDraft) return null
    const empty = dimDraft.refs.findIndex((r) => r === null)
    if (empty < 0) {
      const fits = dimDraft.refs.map((id) => elements.find((e) => e.id === id)?.fit)
      const ok =
        fits.every((f): f is FitData => f !== undefined) &&
        !evaluateDimension(dimDraft.type, fits, dimDraft.anchor).invalid
      return ok ? 'Enter or middle-click to add the dimension · Esc to cancel' : null
    }
    const label = dimensionTypeInfo(dimDraft.type).slots[empty].label
    return `Click an element in the viewport for “${label}” — the dimension type follows what you pick`
  })()
  const markCount = useMark((s) => s.count)
  // Marking a surface by hand has its own line — the same line the local fine
  // fit gets, since it is the same tool set: which gesture is live, what the
  // buttons do while it is, and the way back to the camera. Only where Escape
  // leads and how the element is finished differ.
  // Editing an element runs the same gestures as making one; only what Enter
  // and Escape land on is different — a change written back, or dropped.
  const editingDraft = draft?.editId !== undefined
  const paintHint = !painting
    ? null
    : markChipText(markGesture, markCount, `the ${elementKindInfo(draft!.kind).noun}`, {
        idle: editingDraft ? 'Esc discards the changes' : 'Esc discards the element',
        live: 'Esc to navigate, twice to discard',
      }) +
      (draft!.status === 'ready'
        ? editingDraft
          ? ' · Enter or middle-click saves it'
          : ' · Enter or middle-click creates it'
        : '')
  const stageHint = !draft
    ? openSlotHint
    : draftMode === 'construct'
      ? openSlotHint
      : painting
        ? paintHint
        : draft.picks.length === 0 && draft.status !== 'ready'
          ? draftMode === 'pick'
            ? 'Click the point on the scan you want to measure to'
            : `Click a point on the ${elementKindInfo(draft.kind).noun} you want to measure`
          : draft.status === 'ready'
            ? `Enter or middle-click to ${editingDraft ? 'save' : 'create'} · Esc to discard · click again to ${
                draftMode === 'pick' ? 'move the point' : 'add points'
              }`
            : null

  const markHint = !marking
    ? null
    : markChipText(markGesture, markCount, 'the surface to fit on', {
        idle: 'Esc closes',
        live: 'Esc to navigate, twice to close',
      })

  const mapReady = useDeviation((s) => s.mapStatus === 'ready')
  const showHistogram = useDeviation((s) => s.showHistogram)
  const stats = useDeviation((s) => s.stats)
  const histogram = useDeviation((s) => s.histogram)
  const onDeviation = workspace === 'deviation'
  const onThickness = workspace === 'thickness'

  // The two legends, built from the same instrument — they differ in the scale
  // they are read through and in which figures belong underneath.
  const deviationLegend: { scale: FieldScale; stats: LegendStat[] | null } = {
    scale: deviationScale(range, maxDistance, bands),
    stats: stats && [
      { label: 'min', value: mm(stats.min) },
      { label: 'max', value: mm(stats.max) },
      { label: 'mean', value: mm(stats.mean) },
      { label: 'RMS', value: stats.rms.toFixed(3) },
      { label: 'sigma', value: stats.sigma.toFixed(3) },
      {
        label: `±${stats.tolerance.toFixed(3)}`,
        value: stats.measured
          ? `${((stats.withinTolerance / stats.measured) * 100).toFixed(1)} %`
          : '—',
      },
      {
        label: 'matched',
        value: `${stats.measured.toLocaleString('en-US')} / ${stats.total.toLocaleString('en-US')}`,
        wide: true,
      },
    ],
  }
  const thickStats = useThickness((s) => s.stats)
  const thickHistogram = useThickness((s) => s.histogram)
  const thickShowHistogram = useThickness((s) => s.showHistogram)
  const thicknessLegend: { stats: LegendStat[] | null } = {
    stats: thickStats && [
      { label: 'min', value: wall(thickStats.min) },
      { label: 'max', value: wall(thickStats.max) },
      { label: 'mean', value: wall(thickStats.mean) },
      { label: 'sigma', value: thickStats.sigma.toFixed(3) },
      {
        label: `under ${thickStats.limit}`,
        value: thickStats.measured
          ? `${((thickStats.belowLimit / thickStats.measured) * 100).toFixed(1)} %`
          : '—',
      },
      {
        label: 'thin pts',
        value: thickStats.belowLimit.toLocaleString('en-US'),
      },
      {
        label: 'measured',
        value: `${thickStats.measured.toLocaleString('en-US')} / ${thickStats.total.toLocaleString('en-US')}`,
        wide: true,
      },
    ],
  }

  const scanGeometry = sceneRef.current?.scanGeometry() ?? null
  const nominalGeometry = sceneRef.current?.nominalGeometry() ?? null
  // Stable, so the readout's subscription is not torn down every render.
  const registerHover = useRef((fn: ((r: HoverReading | null) => void) | null) => {
    hoverSink.current = fn
  }).current
  const scanSlot: StartSlot = {
    role: 'Scan',
    what: 'The part as measured',
    name: fileName,
    onOpen: (f) => void openFile(f),
  }
  const startSlots: StartSlot[] = onDeviation
    ? [
        scanSlot,
        {
          role: 'Reference',
          what: 'The nominal CAD part — mesh or STEP',
          name: nominalName,
          accept: REFERENCE_ACCEPT,
          onOpen: (f) => void openNominal(f),
        },
      ]
    : [scanSlot]
  const needsModels = startSlots.some((slot) => !slot.name)

  return (
    <div className="app">
      <TopBar />
      <div className="mid">
        {onDeviation ? (
          <DeviationPanel
            onOpenScan={(f) => void openFile(f)}
            onOpenNominal={(f) => void openNominal(f)}
            onAlign={() => void runAlign(false)}
            onPickPoints={() => useDeviation.getState().startPicking()}
            onMeasure={() => void runDeviation()}
            onStartMarking={handleStartMarking}
            onStopMarking={handleStopMarking}
            onClearMarking={handleClearMarking}
            onLocalFit={() => void runLocalAlign()}
            onRevertLocal={handleRevertLocal}
            onCopy={handleCopyReport}
            onExportStl={handleExportStl}
          />
        ) : onThickness ? (
          <ThicknessPanel
            onOpenScan={(f) => void openFile(f)}
            onMeasure={() => void runThickness()}
            onCopy={handleCopyThicknessReport}
          />
        ) : (
          <Panel
            onOpenScan={(f) => void openFile(f)}
            onStartDraft={handleStartDraft}
            onSelectMode={handleSelectMode}
            onClearPaint={clearPaint}
            onUndoPick={handleUndoPick}
            onCancelDraft={handleCancelDraft}
            onConfirmDraft={handleConfirmDraft}
            onPickPoint={handleDimensionPick}
            onDelete={handleDelete}
            onEditElement={handleEditElement}
            onCopy={handleCopy}
            onStartAlignment={handleStartAlignment}
            onApplyAlignment={(m) => void handleApplyAlignment(m)}
            onApplyManual={(m) => void handleApplyManual(m)}
            onResetAlignment={() => void handleResetAlignment()}
            onExportStep={handleExportStep}
            onExportStl={handleExportStl}
          />
        )}
        <div className="stage">
          {/* The viewport stays mounted behind the picker: unmounting it would
              throw away the mesh and its BVH, and both are expensive. */}
          <div className="viewslot" hidden={picking}>
            <Viewer
              onReady={(s) => {
                sceneRef.current = s
                s.setNavScheme(schemeById(useStore.getState().navScheme))
              }}
              onPick={handlePick}
              onHover={handleHover}
              onElementPick={handleElementPick}
              onPaintChange={handlePaintChange}
              onExtendDrag={handleExtendDrag}
            />
          </div>
          {picking && scanGeometry && nominalGeometry && (
            <SplitPicker
              scanGeometry={scanGeometry}
              nominalGeometry={nominalGeometry}
              scanName={fileName ?? 'scan'}
              nominalName={nominalName ?? 'reference'}
              onAlign={() => void runAlign(true)}
              onCancel={() => useDeviation.getState().stopPicking()}
            />
          )}
          {!picking && onDeviation && mapReady && (
            <MapLegend
              id="deviation"
              unit="mm"
              scale={deviationLegend.scale}
              stats={deviationLegend.stats}
              format={mm}
              histogram={histogram}
              showHistogram={showHistogram}
              zeroAt={0}
            />
          )}
          {!picking && onThickness && hasThicknessMap && (
            <MapLegend
              id="thickness"
              unit="mm wall"
              scale={thickScale}
              stats={thicknessLegend.stats}
              format={wall}
              histogram={thickHistogram}
              showHistogram={thickShowHistogram}
            />
          )}
          {needsModels && !picking && (
            <StartPane
              title={
                onDeviation
                  ? 'Deviation from a nominal part'
                  : onThickness
                    ? 'Wall thickness'
                    : 'Fitting elements'
              }
              blurb={
                onDeviation
                  ? 'Load both, then best-fit the scan onto the reference and read the difference off the part. Scan as STL, PLY or OBJ in millimetres, reference as any of those or a STEP file straight from CAD — everything stays in this browser.'
                  : onThickness
                    ? 'Load a scan and measure how thick its walls are, everywhere at once. No reference model, no alignment. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
                    : 'Load a scan, then pick features on it to fit spheres, cylinders and planes and measure between them. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
              }
              slots={startSlots}
            />
          )}
          {(onDeviation || onThickness) && !picking && <HoverReadout register={registerHover} />}
          {/* Before the chips below it: the CSS lifts them out of its way with
              sibling combinators, which only reach forwards. */}
          {!picking && <SupportBanner />}
          {onDeviation && !picking && !align && fileName && nominalName && (
            <div className="hintchip" data-test="ready-chip">
              Both models loaded — align to fit the scan onto the reference
            </div>
          )}
          {onThickness && !picking && !hasThicknessMap && fileName && (
            <div className="hintchip" data-test="thickness-ready-chip">
              Part loaded — measure its wall thickness in the panel
            </div>
          )}
          {stageHint && workspace === 'elements' && <div className="hintchip">{stageHint}</div>}
          {markHint && !picking && (
            <div className="hintchip" data-test="mark-chip">
              {markHint}
            </div>
          )}
          <BusyOverlay />
          {errorText && <div className="toast">{errorText}</div>}
          {dragging && (
            <div className="drop-overlay">
              Drop your STL / PLY / OBJ{onDeviation ? ' / STEP' : ''} here
            </div>
          )}
        </div>
      </div>
      <StatusStrip />
      <ImprintModal />
    </div>
  )
}
