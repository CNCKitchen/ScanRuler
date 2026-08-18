// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef } from 'react'
import { MeshWorkerClient } from './core/workerClient'
import { buildSummary } from './core/summary'
import { isMeshFile, isStepFile, REFERENCE_ACCEPT } from './core/formats'
import { elementKindInfo } from './core/elements/kinds'
import { creationMethod } from './core/elements/construct'
import { circleFromPoints } from './core/fit/circle'
import { extensionOf, isExtendable, sideValue, type ExtendSide } from './core/elements/extend'
import { roleOf } from './core/elements/refs'
import { dimensionTypeInfo, evaluateDimension, evaluateDimensions } from './core/dimensions'
import type { ElementKind, FitData, PointFit, Vec3 } from './core/types'
import {
  alignSlotPicks,
  blockedRefs,
  draftColorOf,
  useStore,
  type SelectMode,
} from './state/store'
import type { SceneManager, PickHit } from './viewer/SceneManager'
import { schemeById } from './viewer/navSchemes'
import { themeById } from './viewer/viewThemes'
import { Viewer } from './ui/Viewer'
import { Panel } from './ui/Panel'
import { TopBar } from './ui/TopBar'
import { StatusStrip } from './ui/StatusStrip'
import { BusyOverlay } from './ui/BusyOverlay'
import { ImprintModal } from './ui/Imprint'
import { SupportCard } from './ui/SupportCard'
import { DeviationPanel } from './ui/DeviationPanel'
import { ThicknessPanel } from './ui/ThicknessPanel'
import { MapLegend, type LegendStat } from './ui/MapLegend'
import { StartPane, type StartSlot } from './ui/StartPane'
import { CompareView } from './ui/CompareView'
import { formatSigned } from './ui/format'
import { HoverReadout, type HoverReading } from './ui/HoverReadout'
import { SplitPicker } from './ui/SplitPicker'
import { markChipText } from './ui/MarkTools'
import { useDeviation } from './state/deviationStore'
import { useMark } from './state/markStore'
import { useThickness } from './state/thicknessStore'
import type { FieldScale } from './core/field/colormap'
import { deviationScale } from './core/deviation/deviation'
import { thicknessScale } from './core/thickness/thickness'
import { rigidInvert, rigidToColumnMajor, type Rigid } from './core/deviation/rigid'
import { ALIGN_PICK_COUNT, describeRigid } from './core/alignment'
import { exportElementsStep, exportScanStl } from './app/exports'
import { PICK_MARK_TOOL_STATUS, useDeviationWorkspace } from './app/useDeviationWorkspace'
import { targetFitOf, useElementField } from './app/useElementField'
import { detectMaterialSide } from './core/deviation/elementField'
import { useThicknessWorkspace } from './app/useThicknessWorkspace'
import { useSceneSync } from './app/useSceneSync'
import { useHintChip } from './app/useHints'
import { useGlobalShortcuts } from './app/useGlobalShortcuts'
import { useDragDrop } from './app/useDragDrop'

const LARGE_TRIANGLE_WARNING = 5_000_000

export default function App() {
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)

  // Region of the pending preview fit, kept out of the store because it is a
  // large typed array that only the scene needs.
  const draftRegion = useRef<Uint32Array | null>(null)
  // The deviation field: one float per scan vertex, so hundreds of thousands
  // of them. It stays out of the store for the same reason, and stays on the
  // main thread so that moving the scale or the search distance re-colours the
  // part immediately instead of going back to the worker.
  const deviation = useRef<Float32Array | null>(null)
  const deviationRgb = useRef<Uint8Array | null>(null)
  // The deviation from a fitted element, held beside the one from the reference
  // part rather than sharing it: a few megabytes buys switching between what the
  // scan is measured against without either map losing what it had.
  const elementField = useRef<Float32Array | null>(null)
  const elementRgb = useRef<Uint8Array | null>(null)
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
    // itself is still perfectly good. The elements go with the scan they were
    // measured on, so the map against one of them goes too.
    deviation.current = null
    deviationRgb.current = null
    elementField.current = null
    elementRgb.current = null
    thickness.current = null
    thicknessRgb.current = null
    useDeviation.getState().clearAlign()
    useDeviation.getState().clearElementMap()
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
        .finishLoad(
          mesh.vertexCount,
          mesh.triangleCount,
          sceneRef.current?.modelSize() ?? 1,
          sceneRef.current?.modelCenter() ?? [0, 0, 0],
        )
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

  /** Fit a pick-mode draft that needs several points — a circle. Pure math on
   *  a handful of coordinates, so it runs right here rather than in the
   *  worker, and the preview is ready before the click has been let go of. */
  const runPickFit = (points: Vec3[]) => {
    clearPreviewShapeOnly()
    try {
      const fit = circleFromPoints(points)
      useStore.getState().resolveDraft({ ...fit, region: new Uint32Array(0) })
    } catch (e) {
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** Drop a stale fit preview without touching the draft itself — the picks
   *  are being re-fitted, not abandoned. */
  const clearPreviewShapeOnly = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
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
      .setStatus(
        'Step 1 — pick 3 points on the face the part stands on, or choose a measured element.',
      )
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

  // The exports live in src/app/exports.ts — they read the stores directly,
  // and the STL one needs the scene for the geometry as shown.
  const handleExportStep = exportElementsStep
  const handleExportStl = () => exportScanStl(sceneRef)

  // ---- Deviation workspace -------------------------------------------------

  const {
    openNominal,
    runAlign,
    runDeviation,
    runLocalAlign,
    handleStartMarking,
    handleStopMarking,
    handleClearMarking,
    handleRevertLocal,
    handleCopyReport,
  } = useDeviationWorkspace({ clientRef, sceneRef, deviation, deviationRgb })

  // ---- Deviation from a fitted element -------------------------------------

  useElementField({ sceneRef, elementField, elementRgb })

  /** Measure against this element. The material side is read off the scan as the
   *  element is chosen — see detectMaterialSide for why it is decided here and
   *  then left alone rather than re-derived as the controls move. */
  const handleSelectTarget = (id: number | null) => {
    const dev = useDeviation.getState()
    const target = targetFitOf(useStore.getState().elements, id)
    if (id === null || !target) {
      dev.setTarget(null)
      return
    }
    const geometry = sceneRef.current?.scanGeometry()
    const positions = geometry?.getAttribute('position')?.array as Float32Array | undefined
    const normals = geometry?.getAttribute('normal')?.array as Float32Array | undefined
    dev.setTarget(
      id,
      positions && normals
        ? detectMaterialSide(target, positions, normals, dev.maxDistance)
        : 1,
    )
    const name = useStore.getState().elements.find((e) => e.id === id)?.name ?? 'element'
    useStore.getState().setStatus(`Deviation measured against ${name}.`)
  }

  // ---- Wall thickness workspace --------------------------------------------

  const { runThickness, handleCopyThicknessReport } = useThicknessWorkspace({
    clientRef,
    thickness,
    thicknessRgb,
  })

  /** Whichever map the workspace is showing, at a point on the scan:
   *  interpolated across the triangle the click landed in rather than snapped
   *  to a vertex, and written the way that map is written. Null where there is
   *  no map, or where the vertices around the hit carry no measurement. */
  const readingAt = (hit: PickHit): (HoverReading & { value: number }) | null => {
    const dev = useDeviation.getState()
    const onThickness = dev.workspace === 'thickness'
    const values = onThickness
      ? thickness.current
      : dev.source === 'element'
        ? elementField.current
        : deviation.current
    if (!values) return null
    const [a, b, c] = hit.vertices
    const [wa, wb, wc] = hit.weights
    const value = values[a] * wa + values[b] * wb + values[c] * wc
    if (!Number.isFinite(value)) return null
    const at = { value, x: hit.clientX, y: hit.clientY }
    if (onThickness) return { ...at, text: `${value.toFixed(3)} mm`, muted: false }
    const matched = Math.abs(value) <= dev.maxDistance
    return {
      ...at,
      text: matched
        ? `${formatSigned(value)} mm`
        : dev.source === 'element'
          ? 'too far off the element'
          : 'no reference in range',
      muted: !matched,
    }
  }

  const handleHover = (hit: PickHit | null) => {
    hoverSink.current?.(hit ? readingAt(hit) : null)
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
      store.addAlignmentPick(hit.point, hit.normal)
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
      if (store.draft.kind === 'point') {
        // A picked point is the exact raycast hit — no worker round-trip, and
        // clicking again moves it rather than adding to it.
        store.setDraftPicks([faceVertices], [hit.point])
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
      // A multi-point pick method (a circle): every click adds a point, and
      // the fit follows as soon as there are enough of them.
      const picks: [number, number, number][] = [...store.draft.picks, faceVertices]
      const points = [...store.draft.pickPoints, hit.point]
      store.setDraftPicks(picks, points)
      if (points.length >= (method.minPicks ?? 1)) runPickFit(points)
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
    // Over an element map the elements on offer are drawn on the part precisely
    // so that one can be chosen by clicking it, which is the whole setup here.
    if (useDeviation.getState().workspace === 'deviation') {
      if (useDeviation.getState().source === 'element') handleSelectTarget(id)
      return
    }
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
      // A slot takes the click when the element plays its role — and, for the
      // slots narrowed to specific kinds (the cylinder of an intersection
      // circle), when it is one of those kinds. A circle plays the point role
      // on a click but also provides an axis, so slots of either kind take it.
      const slot = method.slots.findIndex(
        (sl, i) =>
          store.draft!.refs[i] === null &&
          (sl.role === roleOf(el.kind) || (sl.role === 'axis' && el.kind === 'circle')) &&
          (!sl.kinds || sl.kinds.includes(el.kind)),
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
            ? draft.kind === 'point'
              ? `Editing ${el.name} — click the scan to move the point, then save.`
              : `Editing ${el.name} — click the scan to pick a fresh set of points, then save.`
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
      mode === 'paint' ? PICK_MARK_TOOL_STATUS : 'Click a point on the surface you want to measure.',
    )
  }

  const handleUndoPick = () => {
    const store = useStore.getState()
    if (!store.draft || store.draft.picks.length === 0) return
    const kind = store.draft.kind
    const method = creationMethod(kind, store.draft.method)
    const picks = store.draft.picks.slice(0, -1)
    const points = store.draft.pickPoints.slice(0, -1)
    store.setDraftPicks(picks, points)
    clearPreview()
    if (picks.length === 0) return
    if (method.mode === 'pick') {
      if (points.length >= (method.minPicks ?? 1)) runPickFit(points)
    } else {
      void runDraftFit(kind, picks)
    }
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

  // Everything the scene is told after a render lives in useSceneSync; the
  // subscriptions here are the ones the JSX below still reads itself.
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const dimDraft = useStore((s) => s.dimDraft)
  const alignDraft = useStore((s) => s.alignDraft)
  // Whether a fit draft is collecting its surface by hand — it decides which
  // hint rides above the model.
  const painting = useStore(
    (s) =>
      s.selectMode === 'paint' &&
      s.draft !== null &&
      creationMethod(s.draft.kind, s.draft.method).mode === 'fit',
  )
  const marking = useDeviation((s) => s.marking)
  const markGesture = useMark((s) => s.gesture)
  const workspace = useDeviation((s) => s.workspace)
  const range = useDeviation((s) => s.range)
  const maxDistance = useDeviation((s) => s.maxDistance)
  const bands = useDeviation((s) => s.bands)
  const thickLow = useThickness((s) => s.low)
  const thickHigh = useThickness((s) => s.high)
  const thickBands = useThickness((s) => s.bands)
  // Held stable across renders, because it is what tells the repaint in
  // useSceneSync whether anything actually changed.
  const thickScale = useMemo(
    () => thicknessScale(thickLow, thickHigh, thickBands),
    [thickLow, thickHigh, thickBands],
  )
  // How each map writes a number, wherever one is shown — on the scale, in the
  // hover label, on a pin. A deviation is signed against a zero that is the
  // whole point of it; a wall thickness is a plain positive length.
  const mm = formatSigned
  const wall = (v: number): string => v.toFixed(3)
  const align = useDeviation((s) => s.align)
  const nominalName = useDeviation((s) => s.nominalName)
  const picking = useDeviation((s) => s.picking)
  const split = useDeviation((s) => s.split)
  const hasThicknessMap = useThickness((s) => s.status === 'ready')

  useSceneSync({
    sceneRef,
    deviation,
    deviationRgb,
    elementField,
    elementRgb,
    thickness,
    thicknessRgb,
    thickScale,
    cancelDraft: handleCancelDraft,
  })

  // Error toasts clear themselves.
  const errorText = useStore((s) => s.errorText)
  useEffect(() => {
    if (!errorText) return
    const t = setTimeout(() => useStore.getState().setError(null), 6000)
    return () => clearTimeout(t)
  }, [errorText])

  // Enter or a middle-mouse click confirms the pending element, Escape backs
  // out — the whole keymap lives in useGlobalShortcuts.
  useGlobalShortcuts({
    stopMarking: handleStopMarking,
    cancelDraft: handleCancelDraft,
    confirmDraft: handleConfirmDraft,
  })

  // Drag & drop anywhere.
  const dragging = useDragDrop({ openFile, openNominal })

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
            ? 'on the face to set on a plane'
            : alignDraft.pickSlot === 'secondary'
              ? 'along the edge to align with the axis'
              : 'for the zero point'
        return `Click the scan — point ${have + 1} of ${need} ${what} · Esc to stop picking`
      }
      return alignDraft.primary === null && alignDraft.primaryPicks.length === 0
        ? 'The coordinate planes show where the part is going — set a face on one of them via the panel'
        : 'Add an axis (step 2) or a zero point (step 3) if you need them — then press Align part'
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
          ? draftMode === 'pick' && draft.kind === 'point'
            ? 'Click the point on the scan you want to measure to'
            : `Click a point on the ${elementKindInfo(draft.kind).noun} you want to measure`
          : draft.status === 'ready'
            ? `Enter or middle-click to ${editingDraft ? 'save' : 'create'} · Esc to discard · click again to ${
                draftMode === 'pick' && draft.kind === 'point' ? 'move the point' : 'add points'
              }`
            : draftMode === 'pick' && draft.picks.length > 0 && draft.status === 'empty'
              ? `Point ${draft.picks.length} of ${creationMethod(draft.kind, draft.method).minPicks ?? 1} — keep clicking around the ${elementKindInfo(draft.kind).noun}`
              : null

  const markHint = !marking
    ? null
    : markChipText(markGesture, markCount, 'the surface to fit on', {
        idle: 'Esc closes',
        live: 'Esc to navigate, twice to close',
      })

  // The guided hints: which control is ringing is the control's own business
  // (usePulse), but the sentence that goes with it belongs on the stage, and
  // this is also where a workspace is retired once it has been carried through.
  // The other workspaces already say their outstanding step in a chip below, so
  // only the measure workspace's steps come from here.
  const hintText = useHintChip()

  const source = useDeviation((s) => s.source)
  const targetId = useDeviation((s) => s.targetId)
  // Whichever map this workspace is reading — the legend, the hover readout and
  // the pins all follow the source rather than whichever was measured last.
  const mapReady = useDeviation((s) =>
    s.source === 'element' ? s.elementStatus === 'ready' : s.mapStatus === 'ready',
  )
  const showHistogram = useDeviation((s) => s.showHistogram)
  const stats = useDeviation((s) => s.stats)
  const histogram = useDeviation((s) => s.histogram)
  // With the colour plot off the scale goes too, and the histogram and the
  // figures under it with it: it is the key to colours that are not on the part
  // any more, and the whole point of switching them off is to be left looking at
  // the part. Nothing is lost — the map is still measured, the reading under the
  // cursor still reports it, and the scale comes back exactly as it was.
  const showMap = useDeviation((s) => s.showMap)
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
  // Both parts, side by side, in two viewports held in one pose. Only where
  // there is a second part to stand beside the scan: measuring against a fitted
  // element there is no reference model in the question at all, and the point
  // picker has the stage to itself while it is up.
  const splitOpen =
    split && onDeviation && source === 'reference' && !picking && Boolean(nominalGeometry)
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
  const startSlots: StartSlot[] =
    onDeviation && source === 'reference'
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
  // The stage prompt is a front door and nothing else: it says what the
  // workspace is for and takes the first file. The moment there is a part to
  // look at it gets out of the way for good — a card over the model is a card
  // over the thing the user came to see, and whatever else the workspace still
  // needs has its own row in the panel to say so.
  const needsModels = !fileName

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
            onSelectTarget={handleSelectTarget}
            onGoToMeasure={() => useDeviation.getState().setWorkspace('elements')}
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
        <div className={splitOpen ? 'stage split' : 'stage'}>
          {/* The viewport stays mounted behind the picker: unmounting it would
              throw away the mesh and its BVH, and both are expensive. It keeps
              its place in the tree when the split view opens for the same
              reason — it becomes the left half where it stands, rather than
              being moved into one. */}
          <div className={splitOpen ? 'viewslot split' : 'viewslot'} hidden={picking}>
            <Viewer
              onReady={(s) => {
                sceneRef.current = s
                s.setNavScheme(schemeById(useStore.getState().navScheme))
                s.setViewTheme(themeById(useStore.getState().viewTheme))
              }}
              onPick={handlePick}
              onHover={handleHover}
              onElementPick={handleElementPick}
              onPaintChange={handlePaintChange}
              onExtendDrag={handleExtendDrag}
            />
            {splitOpen && (
              <>
                <div className="splitcap">
                  <b>Scan</b>
                  <span>{fileName}</span>
                </div>
                <CompareView
                  scene={sceneRef.current!}
                  geometry={nominalGeometry!}
                  role="Reference"
                  name={nominalName ?? 'reference'}
                />
              </>
            )}
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
          {!picking && onDeviation && mapReady && showMap && (
            <MapLegend
              id="deviation"
              unit="mm"
              scale={deviationLegend.scale}
              stats={deviationLegend.stats}
              format={mm}
              histogram={histogram}
              showHistogram={showHistogram}
              zeroAt={0}
              // The sign is the one thing a deviation map cannot leave implicit.
              // Against a reference part it names a side of that surface; against
              // a fitted element there is no solid to be outside of, only more or
              // less material than the ideal shape accounts for.
              ends={
                source === 'element'
                  ? { high: 'too much material', low: 'too little material' }
                  : { high: 'outside the reference', low: 'inside the reference' }
              }
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
                  ? source === 'element'
                    ? 'Deviation from a fitted element'
                    : 'Deviation from a nominal part'
                  : onThickness
                    ? 'Wall thickness'
                    : 'Fitting elements'
              }
              blurb={
                onDeviation
                  ? source === 'element'
                    ? 'Load a scan, fit a plane, cylinder or sphere on it in the Measure workspace, then map how far the surface strays from that ideal. No reference model, no alignment. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
                    : 'Load both, then best-fit the scan onto the reference and read the difference off the part. Scan as STL, PLY or OBJ in millimetres, reference as any of those or a STEP file straight from CAD — everything stays in this browser.'
                  : onThickness
                    ? 'Load a scan and measure how thick its walls are, everywhere at once. No reference model, no alignment. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
                    : 'Load a scan, then pick features on it to fit spheres, cylinders and planes and measure between them. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
              }
              slots={startSlots}
            />
          )}
          {(onDeviation || onThickness) && !picking && <HoverReadout register={registerHover} />}
          {/* Before the error toast below it: the CSS keeps the toast clear of
              the card with a sibling combinator, which only reaches forwards. */}
          {!picking && <SupportCard />}
          {/* With no card on the stage any more, the step that is still
              outstanding says so here instead — the reference that has yet to be
              loaded, or the element that has yet to be chosen. */}
          {onDeviation && source === 'reference' && !picking && fileName && !nominalName && (
            <div className="hintchip" data-test="need-reference-chip">
              Scan loaded — open the reference model in the panel, or drop it anywhere
            </div>
          )}
          {onDeviation && source === 'reference' && !picking && !align && fileName && nominalName && (
            <div className="hintchip" data-test="ready-chip">
              Both models loaded — align to fit the scan onto the reference
            </div>
          )}
          {onDeviation && source === 'element' && !picking && fileName && targetId === null && (
            <div className="hintchip" data-test="need-element-chip">
              {elements.some((e) => e.fit && e.kind !== 'point' && e.kind !== 'line')
                ? 'Click the element to measure against — or choose it in the panel'
                : 'No plane, cylinder or sphere yet — fit one in the Measure workspace'}
            </div>
          )}
          {onThickness && !picking && !hasThicknessMap && fileName && (
            <div className="hintchip" data-test="thickness-ready-chip">
              Part loaded — measure its wall thickness in the panel
            </div>
          )}
          {stageHint && workspace === 'elements' && <div className="hintchip">{stageHint}</div>}
          {!stageHint && workspace === 'elements' && fileName && hintText && (
            <div className="hintchip" data-test="hint-chip">
              {hintText}
            </div>
          )}
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
