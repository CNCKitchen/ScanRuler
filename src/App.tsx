// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from 'react'
import { MeshWorkerClient } from './core/workerClient'
import { buildSummary } from './core/summary'
import { elementKindInfo } from './core/elements/kinds'
import { creationMethod } from './core/elements/construct'
import { roleOf } from './core/elements/refs'
import { dimensionTypeInfo, evaluateDimension, evaluateDimensions } from './core/dimensions'
import type { ElementKind, FitData, PointFit } from './core/types'
import { alignSlotPicks, elementColor, useStore } from './state/store'
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
import { ImprintModal } from './ui/Imprint'
import { SupportBanner } from './ui/SupportBanner'
import { DeviationPanel } from './ui/DeviationPanel'
import { ThicknessPanel } from './ui/ThicknessPanel'
import { MapLegend, type LegendStat } from './ui/MapLegend'
import { StartPane, type StartSlot } from './ui/StartPane'
import { HoverReadout, type HoverReading } from './ui/HoverReadout'
import { SplitPicker } from './ui/SplitPicker'
import { useDeviation } from './state/deviationStore'
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
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['stl', 'ply', 'obj'].includes(ext)) {
      useStore.getState().setError('Unsupported file type — use STL, PLY, or OBJ.')
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

  /** Re-fit an already measured element (used when the sigma preset changes). */
  const runFit = async (elementId: number, kind: ElementKind, seeds: number[]) => {
    const settings = useStore.getState().settings
    try {
      const result = await clientRef.current!.fit(kind, seeds, settings)
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
      sceneRef.current?.setPreviewRegion(
        result.region,
        elementColor(useStore.getState().nextNumber),
      )
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      sceneRef.current?.setPreviewRegion(null)
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
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
    sceneRef.current?.applyTransform(m)
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

  /** Hand the created elements over as analytic STEP geometry. */
  const handleExportStep = () => {
    const store = useStore.getState()
    const els = store.elements.filter((e) => e.fit)
    if (els.length === 0) return
    const text = buildStepFile(
      els.map((e) => ({ name: e.name, fit: e.fit! })),
      store.fileName ?? 'scan',
      new Date().toISOString().slice(0, 19),
    )
    const name = `${(store.fileName ?? 'scan').replace(/\.[^.]+$/, '')}-elements.step`
    const url = URL.createObjectURL(new Blob([text], { type: 'model/step' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    store.setStatus(`${els.length} element${els.length === 1 ? '' : 's'} exported to ${name}.`)
  }

  // ---- Deviation workspace -------------------------------------------------

  const openNominal = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['stl', 'ply', 'obj'].includes(ext)) {
      useStore.getState().setError('Unsupported file type — use STL, PLY, or OBJ.')
      return
    }
    const dev = useDeviation.getState()
    deviation.current = null
    deviationRgb.current = null
    sceneRef.current?.setFieldColors(null)
    dev.beginNominalLoad(file.name)
    useStore.getState().setStatus('Reading reference geometry…')
    try {
      const mesh = await clientRef.current!.loadNominal(file.name, await file.arrayBuffer())
      sceneRef.current?.setNominal(mesh.positions, mesh.indices, mesh.normals)
      sceneRef.current?.setAlignment(null)
      useDeviation.getState().finishNominalLoad(file.name, mesh.vertexCount, mesh.triangleCount)
      // Both models on screen from here, wherever the reference happens to sit
      // — otherwise a reference exported in another frame would be aligned
      // entirely off-camera.
      sceneRef.current?.frameAll()
      useStore
        .getState()
        .setStatus(
          `Reference loaded — ${mesh.triangleCount.toLocaleString('en-US')} triangles. Check it is the right part, then align the scan to it.`,
        )
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
      const fit: PointFit = { kind: 'point', center: hit.point, sigma: 0, usedPoints: 0, regionSize: 0 }
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
    store.startDraft(kind)
    const draft = useStore.getState().draft!
    const method = creationMethod(kind, draft.method)
    store.setStatus(
      method.mode === 'construct' ? 'Select the source elements in the panel.' : method.hint,
    )
  }

  /** "+ Pick point on scan…" inside the dimension editor: start a point draft
   *  whose committed element drops into the waiting slot. */
  const handleDimensionPick = (slot: number) => {
    clearPreview()
    useStore.getState().beginDimensionPick(slot)
    useStore.getState().setStatus('Click the point on the scan you want to measure to.')
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
    useStore.getState().cancelDraft()
    useStore.getState().setStatus('')
  }

  const handleConfirmDraft = () => {
    const region = draftRegion.current
    const id = useStore.getState().commitDraft()
    if (id === null) return
    clearPreview()
    const el = useStore.getState().elements.find((e) => e.id === id)
    if (el && region) sceneRef.current?.applyRegion(id, el.color, region)
    useStore.getState().setStatus(`${el?.name ?? 'Element'} created.`)
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
      store.markFitting(el.id, el.source.seeds)
      void runFit(el.id, el.kind, el.source.seeds)
    }
    const draft = store.draft
    if (
      draft &&
      draft.picks.length > 0 &&
      creationMethod(draft.kind, draft.method).mode === 'fit'
    ) {
      store.setDraftPicks(draft.picks)
      void runDraftFit(draft.kind, draft.picks)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigma])

  // The draft's ghost shape follows whatever the draft currently is — a fit
  // preview, a picked point, or a construction taking shape in the panel.
  const draftFit = useStore((s) => (s.draft?.status === 'ready' ? s.draft.fit : undefined))
  useEffect(() => {
    sceneRef.current?.setPreview(draftFit ?? null)
  }, [draftFit])

  // Keep viewport overlays in sync with the elements and the dimensions the
  // user created between them.
  const elements = useStore((s) => s.elements)
  const dimensions = useStore((s) => s.dimensions)
  const showOverlays = useStore((s) => s.showOverlays)
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
  useEffect(() => {
    const items: OverlayElement[] = elements
      .filter((e) => e.fit && e.visible)
      .map((e) => ({ id: e.id, name: e.name, color: e.color, fit: e.fit! }))
    // Distances draw as a line between their two anchor points, angles as an
    // arc at their hinge.
    const rows = evaluateDimensions(
      dimensions.filter((d) => d.visible !== false),
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
      .map((r) => ({ ...r.value.arc!, title: r.dim.name, value: r.value.value! }))
    sceneRef.current?.updateOverlays(items, pairs, angles, showOverlays)
    // A hidden element's surface tint goes with its overlay.
    sceneRef.current?.setHiddenRegions(elements.filter((e) => !e.visible).map((e) => e.id))
    // Overlays were rebuilt, so the selection glow has to be re-applied.
    sceneRef.current?.setHighlightedElements(highlightIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, dimensions, showOverlays])

  useEffect(() => {
    sceneRef.current?.setHighlightedElements(highlightIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Points picked for the alignment stay marked on the part, labelled with
  // the job they do.
  useEffect(() => {
    sceneRef.current?.setPickMarkers(
      !alignDraft
        ? []
        : [
            ...alignDraft.primaryPicks.map((p, i) => ({
              point: p,
              label: `Level ${i + 1}`,
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

  // A viewport click selects elements whenever a dimension is being assembled
  // or a construction has reference slots — but never while clicks are picking
  // scan points for a fit, and never in the deviation workspace.
  const elementsWorkspace = useDeviation((s) => s.workspace === 'elements')
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

    const histogram = fieldHistogram(
      values,
      scale.low,
      scale.high,
      scale.validMin,
      scale.validMax,
    )
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
    (workspace === 'deviation' && hasDeviationMap) ||
    (workspace === 'thickness' && hasThicknessMap)
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
      if (store.draft) {
        if (e.key === 'Escape') handleCancelDraft()
        else if (e.key === 'Enter' && store.draft.status === 'ready') handleConfirmDraft()
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
      // both are there does a drop mean "replace the scan".
      const dev = useDeviation.getState()
      if (dev.workspace === 'deviation' && useStore.getState().fileName && !dev.nominalName) {
        void openNominal(file)
        return
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

  const handleClearAll = () => {
    clearPreview()
    sceneRef.current?.clearAllRegions()
    useStore.getState().clearElements()
  }

  // Fits run in a worker and can take seconds on a big scan — say so on the
  // canvas, where the user is looking after a pick.
  const fitting = useStore(
    (s) => s.draft?.status === 'fitting' || s.elements.some((e) => e.status === 'fitting'),
  )
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
  const stageHint = !draft
    ? openSlotHint
    : draftMode === 'construct'
      ? openSlotHint
      : draft.picks.length === 0
        ? draftMode === 'pick'
          ? 'Click the point on the scan you want to measure to'
          : `Click a point on the ${elementKindInfo(draft.kind).noun} you want to measure`
        : draft.status === 'ready'
          ? draftMode === 'pick'
            ? 'Enter or middle-click to create · Esc to discard · click again to move the point'
            : 'Enter or middle-click to create · Esc to discard · click again to add points'
          : null

  const measuring = useThickness((s) => s.status === 'running')
  const deviating =
    useDeviation((s) => s.alignStatus === 'running' || s.mapStatus === 'running') || measuring
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
      { label: 'thin pts', value: thickStats.belowLimit.toLocaleString('en-US') },
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
          what: 'The nominal CAD part',
          name: nominalName,
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
            onCopy={handleCopyReport}
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
            onUndoPick={handleUndoPick}
            onCancelDraft={handleCancelDraft}
            onConfirmDraft={handleConfirmDraft}
            onPickPoint={handleDimensionPick}
            onDelete={handleDelete}
            onClearAll={handleClearAll}
            onCopy={handleCopy}
            onStartAlignment={handleStartAlignment}
            onApplyAlignment={(m) => void handleApplyAlignment(m)}
            onApplyManual={(m) => void handleApplyManual(m)}
            onResetAlignment={() => void handleResetAlignment()}
            onExportStep={handleExportStep}
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
                  ? 'Load both, then best-fit the scan onto the reference and read the difference off the part. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
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
          {(fitting || deviating) && !picking && (
            <div className="busychip" data-test="fitting-chip">
              <span className="spinner" />
              {deviating ? 'WORKING…' : 'FITTING…'}
            </div>
          )}
          {errorText && <div className="toast">{errorText}</div>}
          {dragging && <div className="drop-overlay">Drop your STL / PLY / OBJ here</div>}
        </div>
      </div>
      <StatusStrip />
      <ImprintModal />
    </div>
  )
}
