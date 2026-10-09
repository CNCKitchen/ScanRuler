// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef } from 'react'
import { useProjectHistory } from './app/useProjectHistory'
import { clearHistory, historyAction } from './state/historyStore'
import { MeshWorkerClient } from './core/workerClient'
import { creaseSetting, type CreaseSetting } from './core/geometry/crease'
import { buildSummary } from './core/summary'
import { IMAGE_ACCEPT, REFERENCE_ACCEPT } from './core/formats'
import { EdgeClient } from './core/flat/edgeClient'
import { EDGE_MIN_FEATURE_MM } from './core/flat/edges'
import { chainCount, type EdgeChains } from './core/flat/edges'
import { EdgeIndex } from './core/flat/snap'
import { buildFlatReport, scaleLine, titleLine } from './core/flat/report'
import type { FlatDrawingInput } from './core/flat/drawing'
import type { Vec2 } from './core/flat/types'
import {
  canCutAlong,
  turnAxis,
  type CutAxis,
  type WorldAxis,
} from './core/section/frame'
import { chainBounds, projectCut } from './core/section/slice'
import { elementKindInfo } from './core/elements/kinds'
import { creationMethod, takesSurface } from './core/elements/construct'
import { extensionOf, fitWindow, isExtendable, sideValue } from './core/elements/extend'
import { roleOf } from './core/elements/refs'
import { dimensionTypeInfo, evaluateDimension, evaluateDimensions } from './core/dimensions'
import { attachSurfaceScene, forgetSurface, surfaceSource } from './app/surfaces'
import type { FitData, PointFit, SigmaPreset, Vec3 } from './core/types'
import {
  alignSlotPicks,
  blockedRefs,
  draftColorOf,
  picksItsPoints,
  sectionDraftReady,
  useStore,
  type SelectMode,
} from './state/store'
import type { GripSide, SceneManager, PickHit } from './viewer/SceneManager'
import { isCoreSide } from './viewer/extendGrips'
import { schemeById } from './viewer/navSchemes'
import { sceneTheme } from './viewer/viewThemes'
import { Viewer } from './ui/Viewer'
import { Panel } from './ui/Panel'
import { TopBar } from './ui/TopBar'
import { RecoveryBar } from './ui/RecoveryBar'
import { StatusStrip } from './ui/StatusStrip'
import { BusyOverlay } from './ui/BusyOverlay'
import { ImprintModal } from './ui/Imprint'
import { SettingsModal } from './ui/SettingsModal'
import { UnitsModal } from './ui/UnitsModal'
import { SupportCard } from './ui/SupportCard'
import { ViewBar } from './ui/ViewBar'
import { DeviationPanel } from './ui/DeviationPanel'
import { ThicknessPanel } from './ui/ThicknessPanel'
import { FlatPanel } from './ui/FlatPanel'
import { FlatViewer } from './ui/FlatViewer'
import type { FlatScene } from './viewer/FlatScene'
import { MapLegend, type LegendStat } from './ui/MapLegend'
import { StartPane, type StartSlot } from './ui/StartPane'
import { CompareView } from './ui/CompareView'
import { formatSigned } from './ui/format'
import { HoverReadout, type HoverReading } from './ui/HoverReadout'
import { SplitPicker } from './ui/SplitPicker'
import { markChipText } from './ui/MarkTools'
import { MARK_COLOR, useDeviation } from './state/deviationStore'
import { usePrefs } from './state/prefsStore'
import { useShell } from './state/shellStore'
import { useMark } from './state/markStore'
import { useThickness } from './state/thicknessStore'
import { imageScaleX, useFlat } from './state/flatStore'
import type { FieldScale } from './core/field/colormap'
import { deviationScale } from './core/deviation/deviation'
import { thicknessScale } from './core/thickness/thickness'
import { rigidToColumnMajor } from './core/deviation/rigid'
import { ALIGN_PICK_COUNT } from './core/alignment'
import { exportElementsStep, exportScanPointCloud, exportScanStl, runExport, saveBuilt, textBytes, type BuiltFile } from './app/exports'
import { PICK_MARK_TOOL_STATUS } from './app/deviationWorkspace'
import { useElementField } from './app/useElementField'
import { useSceneSync } from './app/useSceneSync'
import { createSession, type AppSession } from './app/session'
import { installCommandHost, type FlatHost, type ProjectHost } from './commands/host'
import { commandRunning } from './commands/activity'
import { takePairingLink } from './commands/agentLink'
import { creaseNote } from './app/scanImport'
import { useFlatSceneSync, type SheetView } from './app/useFlatSceneSync'
import { buildFlatCsvFile, flatExportStem, flatReportInput } from './app/flatReport'
import { sheetAlignment, sheetElements, sheetFrame, sheetLoupeActive, sheetPoseOf, sheetScale } from './app/flatSheet'
import { useHintChip } from './app/useHints'
import { useGlobalShortcuts } from './app/useGlobalShortcuts'
import { useDragDrop } from './app/useDragDrop'
import { useProject } from './app/useProject'
import { prepareImage, runImport, type PreparedImage } from './app/imports'
import { plugins } from './plugins/registry'
import type { PluginHost, PluginRuntime } from './plugins/api'

/** What a plugin without a hook adds: nothing. */
const NO_RUNTIME: PluginRuntime = {}

/** How long the sharp-edge setting has to stand still before the scan is
 *  split for it again, ms: a slider dragged across splits it once. */
const CREASE_SETTLE_MS = 250

export default function App() {
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)
  // The worker, the viewport, the models' files, the maps and the
  // workspaces' verbs, wired once — see app/session. The commands an agent
  // runs are handed the same session, so they run the panel's code.
  const sessionRef = useRef<AppSession | null>(null)
  if (!sessionRef.current) sessionRef.current = createSession({ clientRef, sceneRef })
  const session = sessionRef.current
  const { imports, sources, maps, fieldDirections } = session
  const { deviation, deviationRgb, elementField, elementRgb, elementScope, thickness, thicknessRgb } = maps
  const {
    draftRegion,
    draftSeq,
    clearPreview,
    clearPaint,
    runFit,
    runDraftFit,
    runPickFit,
    runDraftPaintFit,
    refitDraftInWindow,
    startDraft: handleStartDraft,
    confirmDraft: handleConfirmDraft,
    cancelDraft: handleCancelDraft,
    findSymmetry: handleFindSymmetry,
  } = session.measure
  const { commitScan, openScan: openFile } = session.scan
  // In development the viewport, the worker and the Measure store are
  // reachable from the console and the browser checks — nothing in a
  // production build.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __scanruler?: unknown }).__scanruler = {
      scene: () => sceneRef.current,
      client: () => clientRef.current,
      measure: useStore,
    }
  }
  // The 2D Measure viewport and its decoded scan image. The bitmap stays out
  // of the store like every other big buffer; the scene ref is separate from
  // sceneRef because this viewport, unlike the 3D one, mounts and unmounts
  // with its workspace.
  const flatSceneRef = useRef<FlatScene | null>(null)
  const flatBitmapRef = useRef<ImageBitmap | null>(null)
  // Edge detection: its own worker, the grayscale cached for sensitivity
  // re-runs, and the resulting chains — all big buffers, all in refs.
  const edgeClientRef = useRef<EdgeClient | null>(null)
  if (!edgeClientRef.current) edgeClientRef.current = new EdgeClient()
  const flatGrayRef = useRef<{ gray: Uint8Array; width: number; height: number } | null>(null)
  // The edges detected on the image, and the index over them for snapping.
  const imageChainsRef = useRef<EdgeChains | null>(null)
  const imageIndexRef = useRef<EdgeIndex | null>(null)
  // The section on the 2D stage laid flat — its chains, their index and the
  // bounds of the sheet to draw them on — kept until the cut it came from
  // changes. Only ever one: the sheet holds one subject at a time.
  const sectionSheetRef = useRef<{
    id: number
    key: string
    chains: EdgeChains
    index: EdgeIndex
    bounds: { min: Vec2; max: Vec2 }
  } | null>(null)

  // The hover label subscribes to this instead of taking a prop, so a reading
  // that changes every frame does not re-render the workspace around it.
  const hoverSink = useRef<((reading: HoverReading | null) => void) | null>(null)

  useEffect(() => {
    clientRef.current!.restoreState = () => ({
      scan: sources.current.scan ? {
        ...sources.current.scan,
        crease: creaseSetting(useStore.getState()),
        transform: useStore.getState().appliedAlignment,
      } : null,
      nominal: sources.current.reference,
    })
    clientRef.current!.onProgress = (text) => useStore.getState().setStatus(text)
    // Each refinement pose, straight onto the scan's group. The reference is
    // the datum and stays put, so watching the fit means watching the scan
    // walk onto it — and it costs one matrix write per pass.
    clientRef.current!.onAlignProgress = (transform) => {
      sceneRef.current?.setAlignment(rigidToColumnMajor(transform))
    }
  }, [])

  // The sharp-edge setting changed under a loaded scan: the worker lays the
  // render geometry out again as it now says, and the scene swaps it in
  // under everything measured on it — once the angle has stopped moving, so
  // a slider dragged across does not split the scan at every step. A scan
  // still loading takes the setting as it stands when the load began, and
  // is left to it.
  const creaseMode = useStore((s) => s.creaseMode)
  const creaseAngle = useStore((s) => s.creaseAngle)
  const creaseSettled = useRef(false)
  useEffect(() => {
    if (!creaseSettled.current) {
      creaseSettled.current = true
      return
    }
    const crease: CreaseSetting = { mode: creaseMode, angleDeg: creaseAngle }
    let stale = false
    const timer = setTimeout(async () => {
      const store = useStore.getState()
      if (!store.fileName || store.busy || !sceneRef.current?.scanGeometry()) return
      const scanVersion = clientRef.current!.scanVersion
      try {
        const mesh = await clientRef.current!.recrease(crease)
        if (stale || scanVersion !== clientRef.current!.scanVersion) return
        sceneRef.current?.resplitScan(
          mesh.positions,
          mesh.indices,
          mesh.normals,
          mesh.wireSlots,
          mesh.copyOf,
        )
        useStore.getState().setStatus(creaseNote(mesh.crease, crease) ?? 'Sharp edges drawn sharp.')
      } catch (e) {
        useStore.getState().setStatus(e instanceof Error ? e.message : String(e))
      }
    }, CREASE_SETTLE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [creaseMode, creaseAngle])

  /** Open a flatbed scan image in the 2D Measure workspace: decode it, read
   *  the resolution it declares about itself, and hand it to the flat scene.
   *  Decoded with a vertical flip because the document frame is y-up and an
   *  ImageBitmap bypasses the GPU-side flip — see FlatScene.setImage. */
  const commitImage = (image: PreparedImage | null) => {
    flatBitmapRef.current?.close()
    flatBitmapRef.current = image?.bitmap ?? null
    flatGrayRef.current = image?.gray ?? null
    imageChainsRef.current = null
    imageIndexRef.current = null
    sources.current.image = image?.source ?? null
    if (image) {
      useFlat.getState().finishImageLoad(image.source.name, image.bitmap.width, image.bitmap.height, image.meta)
    } else {
      useFlat.getState().imageFailed()
      useFlat.getState().failEdges()
      flatSceneRef.current?.setBlankSheet([-10, -10], [10, 10])
    }
    clearHistory()
  }

  const openImage = (file: File) => runImport(imports, 'Reading image…', async () => {
    const image = await prepareImage(file)
    commitImage(image)
    useShell.getState().setWorkspace('flat')
    void runEdgeDetect()
    useStore.getState().setStatus(`Image loaded — ${file.name}.`)
  })

  /** A section laid flat for the 2D sheet: its cut projected into its own
   *  plane, indexed for snapping, and the bounds of a sheet with room round
   *  it. Computed once per cut and kept — null while the section has no cut
   *  yet (it is being taken again after a project load). */
  const sectionSheetOf = (id: number) => {
    const sec = useStore.getState().sections.find((x) => x.id === id)
    if (!sec?.cut || !sec.cutKey) return null
    const cached = sectionSheetRef.current
    if (cached && cached.id === id && cached.key === sec.cutKey) return cached
    const chains = projectCut(sec.cut, sec.frame)
    const raw = chainBounds(chains) ?? { min: [-10, -10] as Vec2, max: [10, 10] as Vec2 }
    // The sheet is what a click lands on, so it reaches past the last edge —
    // by a hand's width on a small cut, by a share of a large one.
    const pad = Math.max(5, 0.08 * Math.hypot(raw.max[0] - raw.min[0], raw.max[1] - raw.min[1]))
    const entry = {
      id,
      key: sec.cutKey,
      chains,
      index: new EdgeIndex(chains),
      bounds: {
        min: [raw.min[0] - pad, raw.min[1] - pad] as Vec2,
        max: [raw.max[0] + pad, raw.max[1] + pad] as Vec2,
      },
    }
    sectionSheetRef.current = entry
    return entry
  }
  /** What is on the 2D stage right now, as the viewport wants it. */
  const activeSheet = (): SheetView | null => {
    const subject = useFlat.getState().subject
    if (subject.kind === 'section') {
      const sheet = sectionSheetOf(subject.id)
      return sheet ? { kind: 'section', bounds: sheet.bounds, chains: sheet.chains } : null
    }
    const bitmap = flatBitmapRef.current
    return bitmap ? { kind: 'image', bitmap, chains: imageChainsRef.current } : null
  }
  /** The edges a pick on the 2D stage snaps to — the subject's own. */
  const activeEdgeIndex = (): EdgeIndex | null => {
    const subject = useFlat.getState().subject
    return subject.kind === 'section' ? (sectionSheetOf(subject.id)?.index ?? null) : imageIndexRef.current
  }

  // The flat store holds the truth; useFlatSceneSync repeats it to the 2D
  // viewport, and app/flatSheet says what each layer draws.
  const flatSync = useFlatSceneSync({ sceneRef: flatSceneRef, sheetOf: activeSheet })

  // What the plugins add, for this render: each plugin's hook, called in the
  // same order every time — see plugins/api.ts. The verbs they are handed
  // are defined further down and bound there; a plugin calls them only from
  // handlers and effects, after this render has run.
  const hostVerbs = useRef<Pick<PluginHost, 'openScan' | 'openReference' | 'runFit' | 'runDeviation' | 'runThickness' | 'clearPreview' | 'swapScan' | 'remapScan' | 'remeasureScan'> | null>(null)
  const host = useRef<PluginHost>({
    clientRef,
    sceneRef,
    sources,
    imports,
    maps,
    openScan: (file, units) => hostVerbs.current!.openScan(file, units),
    openReference: (file, units) => hostVerbs.current!.openReference(file, units),
    runFit: (...args) => hostVerbs.current!.runFit(...args),
    runDeviation: () => hostVerbs.current!.runDeviation(),
    runThickness: () => hostVerbs.current!.runThickness(),
    clearPreview: () => hostVerbs.current!.clearPreview(),
    swapScan: (source, transform) => hostVerbs.current!.swapScan(source, transform),
    remapScan: (vertexMap) => hostVerbs.current!.remapScan(vertexMap),
    remeasureScan: (refit) => hostVerbs.current!.remeasureScan(refit),
  }).current
  const runtimes: PluginRuntime[] = plugins().map((p) => p.usePlugin?.(host) ?? NO_RUNTIME)
  const shellWorkspace = useShell((s) => s.workspace)
  const activeIndex = plugins().findIndex((p) => p.workspace?.id === shellWorkspace)
  /** The runtime of the plugin whose workspace is on screen, if one is. */
  const active: PluginRuntime | null = activeIndex >= 0 ? runtimes[activeIndex] : null
  // The same, for handlers that run after this render.
  const activeRef = useRef(active)
  activeRef.current = active
  const runtimesRef = useRef(runtimes)
  runtimesRef.current = runtimes
  const flatLoupeActive = useFlat(sheetLoupeActive)
  const flatSubject = useFlat((s) => s.subject)

  /** Run (or re-run) edge detection on the cached grayscale. Superseded
   *  requests come back null and change nothing. The detector only ever
   *  runs on the image; while a section is on the stage the result is kept
   *  for the image's return and the stage's edge status is left alone. */
  const runEdgeDetect = async () => {
    const source = flatGrayRef.current
    if (!source) return
    const flat = useFlat.getState()
    const scale = imageScaleX(flat)
    if (flat.subject.kind === 'image') flat.beginEdges()
    const chains = await edgeClientRef.current!.detect(
      // The worker takes the buffer by transfer; the cache keeps its own.
      source.gray.slice(),
      source.width,
      source.height,
      {
        sensitivity: flat.edgeSensitivity,
        // A chain has to be a feature's worth of millimetres to count —
        // 1 mm at the scale in force, or its 600 dpi equivalent before any.
        minLength: scale ? EDGE_MIN_FEATURE_MM * scale : undefined,
      },
    ).catch((error) => {
      if (flatGrayRef.current === source) {
        useFlat.getState().failEdges()
        useStore.getState().setError(error instanceof Error ? error.message : String(error))
      }
      return null
    })
    if (!chains || flatGrayRef.current !== source) return
    imageChainsRef.current = chains
    imageIndexRef.current = new EdgeIndex(chains)
    if (useFlat.getState().subject.kind === 'image') useFlat.getState().resolveEdges(chainCount(chains))
  }

  // The sensitivity slider re-detects, and so does a change of the image's
  // scale (the minimum feature length is in millimetres); the overlay redraws
  // when chains land or the toggle moves.
  const edgeSensitivity = useFlat((s) => s.edgeSensitivity)
  const edgeScaleX = useFlat(imageScaleX)
  useEffect(() => {
    // On mount there is nothing loaded yet and the detect returns untouched.
    void runEdgeDetect()
  }, [edgeSensitivity, edgeScaleX])

  // The subject changed, or the section on the stage got its cut: the edge
  // status says what there is to snap to now — the image's detected chains,
  // the section's cut, or nothing yet.
  const activeCutKey = useStore((s) =>
    flatSubject.kind === 'section'
      ? (s.sections.find((x) => x.id === flatSubject.id)?.cutKey ?? null)
      : null,
  )
  useEffect(() => {
    const flat = useFlat.getState()
    if (flatSubject.kind === 'section') {
      const sheet = sectionSheetOf(flatSubject.id)
      if (sheet) flat.resolveEdges(chainCount(sheet.chains))
      else flat.beginEdges()
      return
    }
    const chains = imageChainsRef.current
    if (chains) flat.resolveEdges(chainCount(chains))
    else if (flat.edgeStatus !== 'running') flat.failEdges()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatSubject, activeCutKey])

  // A section deleted in the 3D workspace — or every one, with a new scan —
  // takes its sheet with it; one that was on the stage gives way to the image.
  const sectionIds = useStore((s) => s.sections.map((sec) => sec.id).join(','))
  useEffect(() => {
    useFlat.getState().dropSections(sectionIds === '' ? [] : sectionIds.split(',').map(Number))
  }, [sectionIds])

  // Cuts are taken in the mesh worker, for the draft and for sections that
  // arrive from a project with their planes only; a centroid draft measures
  // itself — see app/sectionCuts and app/measureWorkspace.
  useEffect(() => session.watch(), [session])

  const handleFlatCopyReport = () => {
    void navigator.clipboard.writeText(buildFlatReport(flatReportInput()))
    useStore.getState().setStatus('2D measurement report copied to the clipboard.')
  }

  const handleFlatExportCsv = () => saveBuilt(buildFlatCsvFile())

  /** The sheet gathered for a drawing export — see core/flat/drawing. What
   *  is on the sheet is what is exported: the edges while they are shown,
   *  the visible elements (one open for editing is not yet an element), the
   *  whole of it aligned and turned as shown. Null with nothing on the stage. */
  const flatDrawingInput = (): FlatDrawingInput | null => {
    const s = useFlat.getState()
    const sheet = activeSheet()
    if (!sheet) return null
    // Document units per chain unit: millimetres per pixel on the image. A
    // section's chains are millimetres already, and its sheet scale is 1.
    const scale = sheetScale(s)
    const report = flatReportInput()
    return {
      bounds:
        sheet.kind === 'image'
          ? { min: [0, 0], max: [sheet.bitmap.width * scale.x, sheet.bitmap.height * scale.y] }
          : sheet.bounds,
      chains: s.showEdges ? sheet.chains : null,
      chainUnit: scale,
      elements: sheetElements(s),
      alignDir: sheetAlignment(s),
      turns: s.turns,
      mirror: s.mirror,
      unit: s.pxPerMm ? 'mm' : 'px',
      title: titleLine(report),
      scaleNote: scaleLine(report),
    }
  }

  /** "1,234 edge chains and 3 elements" — with a word on the edges when a
   *  format did something to them, and a reason when there are none. */
  const drawnSummary = (input: FlatDrawingInput, edgeNote = '', showEdges = useFlat.getState().showEdges): string => {
    const chains = input.chains ? chainCount(input.chains) : 0
    const edges = chains
      ? `${chains.toLocaleString('en-US')} edge chain${chains === 1 ? '' : 's'}${edgeNote ? ` ${edgeNote}` : ''}`
      : showEdges
        ? 'no edges'
        : 'the edges hidden'
    const n = input.elements.length
    return `${edges} and ${n} element${n === 1 ? '' : 's'}`
  }

  /** The sheet as an SVG at true scale — for a vector editor, a laser or a
   *  print at 1:1. Null with nothing on the stage. */
  const buildFlatSvgFile = async (): Promise<BuiltFile | null> => {
    const input = flatDrawingInput()
    if (!input) return null
    const name = `${flatExportStem()}-sheet.svg`
    const summary = drawnSummary(input)
    const { buildFlatSvg } = await import('./core/flat/svg')
    return { name, mimeType: 'image/svg+xml', bytes: textBytes(buildFlatSvg(input)), status: `Sheet exported to ${name} — ${summary}.` }
  }
  const handleFlatExportSvg = () => runExport(async () => saveBuilt(await buildFlatSvgFile()))

  /** The sheet as a DXF — for CAD: millimetres by declaration, y up, the
   *  origin on the alignment, the edges thinned to a sketch's worth. Null
   *  with nothing on the stage. */
  const buildFlatDxfFile = async (): Promise<BuiltFile | null> => {
    const input = flatDrawingInput()
    if (!input) return null
    const s = useFlat.getState()
    const origin = sheetFrame(s)?.origin ?? null
    const name = `${flatExportStem()}-sheet.dxf`
    const { buildFlatDxf, DXF_EDGE_TOLERANCE } = await import('./core/flat/dxf')
    const tolerance = DXF_EDGE_TOLERANCE[input.unit]
    const dxf = buildFlatDxf({
      ...input,
      origin,
      edgeTolerance: tolerance,
    })
    return {
      name,
      mimeType: 'application/dxf',
      bytes: textBytes(dxf),
      status: `Drawing exported to ${name} — ${drawnSummary(input, `thinned to ${tolerance} ${input.unit}`, s.showEdges)}.`,
    }
  }
  const handleFlatExportDxf = () => runExport(async () => saveBuilt(await buildFlatDxfFile()))


  /** A marking gesture ended: re-fit on what is marked now, or fall back to an
   *  empty draft once the last of the marking has been rubbed out. */
  const handlePaintChange = (count: number) => {
    // The same marking layer and the same tools serve both workspaces; only who
    // is listening differs — an element re-fits on every stroke, a local best
    // fit waits to be asked, and the measured region of an element map follows
    // the brush stroke by stroke.
    useMark.getState().setCount(count)
    // A plugin's workspace may take the marking for its own.
    if (activeRef.current?.paintChange?.()) return
    const dev = useDeviation.getState()
    if (dev.marking) {
      if (useShell.getState().workspace === 'deviation' && dev.source === 'element' && dev.targetScope === 'marked') {
        const marked = sceneRef.current?.paintedVertices() ?? new Uint32Array(0)
        historyAction('Deviation: mark region', () => {
          elementScope.current = marked
          dev.markScope(marked.length)
        })
      }
      return
    }
    const store = useStore.getState()
    const draft = store.draft
    if (!draft) return
    const method = creationMethod(draft.kind, draft.method)
    if (!takesSurface(method)) return
    const selection = sceneRef.current?.paintedVertices() ?? new Uint32Array(0)
    if (selection.length === 0) {
      draftSeq.current++
      draftRegion.current = null
      store.setDraftSelection(null)
      return
    }
    // A construction that searches the scan keeps the marking as the surface
    // to search: the centroid measures itself again on it, the symmetry
    // plane waits to be asked.
    if (method.mode !== 'fit') {
      store.setDraftSelection(selection)
      return
    }
    void runDraftPaintFit(draft.kind, selection)
  }

  const { applyAlignment: handleApplyAlignment, applyManual: handleApplyManual, resetAlignment: handleResetAlignment } = session.alignment

  const handleStartAlignment = () => {
    clearPreview()
    useStore.getState().startAlignment()
    useStore
      .getState()
      .setStatus(
        'Step 1 — pick 3 points on the face the part stands on, or choose a measured element.',
      )
  }

  // The exports live in src/app/exports.ts — they read the stores directly,
  // and the STL one needs the scene for the geometry as shown.
  const handleExportStep = exportElementsStep
  const handleExportStl = () => exportScanStl(sceneRef)
  const handleExportCloud = () => exportScanPointCloud(sceneRef, useStore.getState().cloudFormat)


  // ---- Deviation workspace -------------------------------------------------

  const {
    openNominal,
    commitNominal,
    runAlign,
    abortAlign,
    startPicking,
    stopPicking,
    runDeviation,
    setMapFacing,
    runLocalAlign,
    handleStartMarking,
    handleStopMarking,
    handleClearMarking,
    handleRevertLocal,
    handleCopyReport,
    selectTarget: handleSelectTarget,
  } = session.deviation

  // ---- Deviation from a fitted element -------------------------------------

  useElementField({ sceneRef, elementField, elementRgb, elementScope, fieldDirections })


  /** Switch the element map between measuring the whole scan and measuring a
   *  hand-marked region of it. Choosing the marked scope opens the marking
   *  tools with whatever region was chosen before back on the part. */
  const handleScopeChange = (scope: 'all' | 'marked') => historyAction('Deviation: change region', () => {
    const dev = useDeviation.getState()
    if (scope === 'marked') {
      dev.setTargetScope('marked')
      useMark.getState().reset()
      dev.startMarking()
      const region = elementScope.current
      if (region && region.length > 0) {
        sceneRef.current?.setPaintedVertices(region, MARK_COLOR)
        useMark.getState().setCount(region.length)
      }
      dev.markScope(region?.length ?? 0)
      useStore.getState().setStatus(PICK_MARK_TOOL_STATUS)
      return
    }
    dev.setTargetScope('all')
    dev.stopMarking()
    sceneRef.current?.clearPaint()
    useMark.getState().reset()
    elementScope.current = null
    dev.clearScope()
    useStore.getState().setStatus('')
  })

  /** Put the marking tools away, keeping the region: the map goes on showing
   *  what was chosen, and the pointer goes back to pinning readings. */
  const handleScopeDone = () => {
    useDeviation.getState().stopMarking()
    sceneRef.current?.clearPaint()
    useMark.getState().reset()
    useStore.getState().setStatus('')
  }

  /** Rub the whole region out and start marking it afresh. */
  const handleScopeClear = () => historyAction('Deviation: clear region', () => {
    sceneRef.current?.clearPaint()
    useMark.getState().setCount(0)
    elementScope.current = new Uint32Array(0)
    useDeviation.getState().markScope(0)
  })

  // ---- Wall thickness workspace --------------------------------------------

  const { runThickness, handleCopyThicknessReport } = session.thickness

  // Another version of the scan put in place under the session — see
  // app/scanSwap.
  const { swapScan, remapScan, remeasureScan } = session.swap

  hostVerbs.current = { openScan: openFile, openReference: openNominal, runFit, runDeviation, runThickness, clearPreview, swapScan, remapScan, remeasureScan }

  useProjectHistory({ clientRef, sceneRef, elementScope, deviation, deviationRgb,
    thickness, thicknessRgb, imports, sources, runFit, runDeviation, runThickness, swapScan, remeasureScan })

  /** Whichever map the workspace is showing, at a point on the scan:
   *  interpolated across the triangle the click landed in rather than snapped
   *  to a vertex, and written the way that map is written. Null where there is
   *  no map, or where the vertices around the hit carry no measurement. */
  const readingAt = (hit: PickHit): (HoverReading & { value: number }) | null => {
    const dev = useDeviation.getState()
    const workspace = useShell.getState().workspace
    // A plugin's workspace reads its own map.
    const plugin = activeRef.current
    if (plugin?.readingAt) return plugin.readingAt(hit)
    const onThickness = workspace === 'thickness'
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
    // An agent's command has the panel's box open: a click now would land in
    // it. The person watches until it is done.
    if (commandRunning()) return
    const store = useStore.getState()
    // On either map a click pins the reading under it; alignment points are
    // picked in the split view, which has its own scenes.
    const workspace = useShell.getState().workspace
    const plugin = activeRef.current
    if (plugin?.pick) {
      plugin.pick(hit)
      return
    }
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
    // theirs to consume — unless a point slot has asked for one, in which
    // case the click becomes a picked Point element that fills the slot.
    if (method.mode === 'construct') {
      if (store.draft.pickSlot != null) store.pickDraftPoint(hit.point)
      return
    }
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
    // The exact hit rides along with the seed triangle: the fit itself only
    // wants the triangle, but the spot that was clicked is what gets marked on
    // the part while the element is being made.
    const picks: [number, number, number][] = [...store.draft.picks, faceVertices]
    const points = [...store.draft.pickPoints, hit.point]
    store.setDraftPicks(picks, points)
    void runDraftFit(store.draft.kind, picks)
  }

  /** A viewport click that landed on an existing element: hand it to whichever
   *  editor is collecting references — the dimension draft, or a construction
   *  draft's slots. Clicking an element that is already used takes it out. */
  const handleElementPick = (id: number, clientX = 0, clientY = 0) => {
    if (commandRunning()) return
    const store = useStore.getState()
    const el = store.elements.find((e) => e.id === id)
    if (!el?.fit) return
    // A plugin's workspace takes the click as it will.
    const plugin = activeRef.current
    if (plugin?.elementPick) {
      plugin.elementPick(id, clientX, clientY)
      return
    }
    // Over an element map the elements on offer are drawn on the part precisely
    // so that one can be chosen by clicking it, which is the whole setup here.
    if (useShell.getState().workspace === 'deviation') {
      if (useDeviation.getState().source === 'element') handleSelectTarget(id)
      return
    }
    // A section being made takes the element to cut along; clicking the one
    // already chosen lets it go again.
    if (store.sectionDraft && !store.draft) {
      if (!canCutAlong(el.kind)) {
        store.setStatus(
          `${el.name} has no direction to cut across — choose a plane, cylinder, cone, line or circle.`,
        )
        return
      }
      store.setSectionDraftRef(store.sectionDraft.ref === id ? null : id)
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
    if (takesSurface(method)) {
      if (draft.selection) {
        // Straight back onto the part, in the element's own colour: the brush
        // arms itself around it on the next render.
        sceneRef.current?.setPaintedVertices(draft.selection, el.color)
        useMark.getState().setCount(draft.selection.length)
      } else if (method.mode === 'fit' && draft.picks.length > 0) {
        // Back on the part go the spots the element was measured from. Only the
        // seed triangles are kept — an element outlives the session it was made
        // in — so each marker sits in the middle of its triangle rather than on
        // the pixel that was clicked, which is well inside the click itself.
        store.setDraftPickPoints(sceneRef.current?.pickPointsOf(draft.picks) ?? [])
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

  /** The box emptied and the kind kept in hand — Escape's first step on a
   *  new draft with picks in it. */
  const handleRestartDraft = () => {
    const store = useStore.getState()
    const draft = store.draft
    if (!draft || draft.editId !== undefined) return
    clearPreview()
    clearPaint()
    store.restartDraft()
    const method = creationMethod(draft.kind, draft.method)
    store.setStatus(method.mode === 'construct' ? 'Select the source elements in the panel.' : method.hint)
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

  /** The draft put aside with its marking, back where it was: the marking
   *  goes back onto the part in the draft's colour and the draft is measured
   *  on it again — a fit re-fits, a search of the scan starts over on it. */
  const handleRestoreDraft = () => {
    const store = useStore.getState()
    const selection = store.discarded?.selection
    if (!selection || store.draft) return
    clearPreview()
    clearPaint()
    store.restoreDraft()
    const draft = useStore.getState().draft
    if (!draft) return
    // Straight back onto the part; the brush arms itself around it on the
    // next render, the way a re-opened element's marking does.
    sceneRef.current?.setPaintedVertices(selection, draftColorOf(useStore.getState()))
    useMark.getState().setCount(selection.length)
    const method = creationMethod(draft.kind, draft.method)
    if (method.mode === 'fit') void runDraftPaintFit(draft.kind, selection)
    else useStore.getState().setDraftSelection(selection)
    const editing = draft.editId !== undefined
    useStore
      .getState()
      .setStatus(
        `${editing ? 'The edit is' : `The ${elementKindInfo(draft.kind).noun} is`} back with its ${selection.length.toLocaleString('en-US')} marked points — add to or rub out the marking, then ${editing ? 'save' : 'create'}.`,
      )
  }

  // ---- Sections ------------------------------------------------------------

  const handleStartSection = () => {
    // The store first, as in handleCancelDraft: an element draft this closes
    // is put aside with its marking, if it has one.
    useStore.getState().startSection()
    clearPreview()
    clearPaint()
    useStore
      .getState()
      .setStatus(
        'Click the element or coordinate plane to cut along in the viewport, or choose it in the panel.',
      )
  }

  const handleEditSection = (id: number) => {
    useStore.getState().editSection(id)
    clearPreview()
    clearPaint()
    const sec = useStore.getState().sections.find((x) => x.id === id)
    if (sec)
      useStore
        .getState()
        .setStatus(`Editing ${sec.name} — slide or tilt the plane, or choose another element, then save.`)
  }

  const handleDeleteSection = (id: number) => useStore.getState().removeSection(id)

  const handleCancelSection = () => {
    useStore.getState().cancelSection()
    useStore.getState().setStatus('')
  }

  /** Create the section — and put it on the 2D sheet, so switching to that
   *  workspace finds it there rather than the image it was measuring before.
   *  An edit leaves the sheet where it is. */
  const handleConfirmSection = () => {
    const store = useStore.getState()
    if (!sectionDraftReady(store.sectionDraft)) return
    const editing = store.sectionDraft?.editId !== undefined
    const id = store.commitSection()
    if (id === null) return
    if (!editing) useFlat.getState().setSubject({ kind: 'section', id })
    const sec = useStore.getState().sections.find((x) => x.id === id)
    useStore
      .getState()
      .setStatus(
        `${sec?.name ?? 'Section'} ${editing ? 'updated' : 'created'} — measure it in the 2D Measure workspace.`,
      )
  }

  /** A click on one of the coordinate planes offered while the section has
   *  nothing to cut across: the plane is taken there. */
  const handleWorldPlanePick = (axis: WorldAxis) => {
    const store = useStore.getState()
    if (!store.sectionDraft || store.draft) return
    store.setSectionDraftRef(axis)
  }

  // Changing "Used points" is a change to the open draft alone: it re-fits on
  // the surface it already has, and every other element keeps the cut-off it
  // was measured with. The choice is also remembered for the next new element.
  const handleDraftSigma = (k: SigmaPreset) => {
    useStore.getState().setDraftSigma(k)
    const store = useStore.getState()
    const draft = store.draft
    if (!draft || creationMethod(draft.kind, draft.method).mode !== 'fit') return
    if (draft.selection) void runDraftPaintFit(draft.kind, draft.selection)
    else if (draft.picks.length > 0) {
      // The picks are unchanged and so are the marks on them — only the
      // outlier cut-off moved.
      store.setDraftPicks(draft.picks, draft.pickPoints)
      void runDraftFit(draft.kind, draft.picks)
    }
  }

  // Where the side being dragged stood when the drag began. The viewport
  // reports how far the grip has come rather than where it is, so every move
  // is start + delta — which is what lets a drag run into the clamp and come
  // back out again without losing anything on the way.
  const extendStart = useRef(0)
  /** A grip is held: the span moves every frame, and a fit confined to it
   *  waits for the hand to let go rather than running under it. */
  const extendDragging = useRef(false)
  const refitAfterDrag = useRef(false)
  /** The line a section plane slid along when a ring was taken hold of, and
   *  the axis the ring turns it about: every move turns that line by the
   *  whole angle so far, so the plane never drifts under a hand that goes
   *  back and forth. */
  const turnStart = useRef<{ axis: CutAxis; about: Vec3; offset: number } | null>(null)
  const handleExtendDrag =(side: GripSide, delta: number, phase: 'start' | 'move' | 'end') => {
    // A plugin's manipulator — see PluginRuntime.gripDrag.
    for (const r of runtimesRef.current) if (r.gripDrag?.(side, delta, phase)) return
    // A plugin's grip no plugin took has nowhere to go.
    if (!isCoreSide(side)) return
    const store = useStore.getState()
    // The arrow on a section plane: the drag slides it along its normal, and
    // the worker cuts again behind it — see useSections.
    if (side === 'offset') {
      const d = store.sectionDraft
      if (!d) return
      if (phase === 'start') extendStart.current = d.offset
      else if (phase === 'move') store.setSectionDraftOffset(extendStart.current + delta)
      return
    }
    // A ring on it: the drag tilts the plane about one of its own axes,
    // through the point the gizmo sits on. `delta` is degrees.
    if (side === 'tiltU' || side === 'tiltV') {
      const d = store.sectionDraft
      if (!d?.axis || !d.frame) return
      if (phase === 'start') {
        turnStart.current = {
          axis: d.axis,
          about: side === 'tiltU' ? d.frame.basisU : d.frame.basisV,
          offset: d.offset,
        }
      } else if (phase === 'move' && turnStart.current) {
        const t = turnStart.current
        store.setSectionDraftAxis(turnAxis(t.axis, t.offset, t.about, delta))
      } else if (phase === 'end') {
        turnStart.current = null
      }
      return
    }
    const fit = store.draft?.fit
    if (!isExtendable(fit)) return
    if (phase === 'start') {
      extendStart.current = sideValue(extensionOf(fit, store.draft?.extend), side)
      extendDragging.current = true
      refitAfterDrag.current = false
    } else if (phase === 'move') {
      store.setDraftExtend(side, extendStart.current + delta)
    } else {
      extendDragging.current = false
      if (refitAfterDrag.current) {
        refitAfterDrag.current = false
        void refitDraftInWindow()
      }
    }
  }

  // With the fit confined to the drawn span, the two extend numbers are part
  // of the recipe: whenever they change with the option on, or the option is
  // switched either way, the draft measures again. Keyed on the span itself
  // rather than the extension, so a plane's edges and a cylinder's ends with
  // the option off never trigger it. What a draft opens with is what its fit
  // was made with — the first key of a draft's life is recorded, not acted
  // on. A field commits once and re-fits at once; a grip changes the span on
  // every move and re-fits once, when it is let go.
  const draftOpen = useStore((s) => s.draft !== null)
  const windowKey = useStore((s) => {
    const w = fitWindow(s.draft?.extend)
    return w ? `${w.start}:${w.end}` : ''
  })
  const seenWindow = useRef<string | null>(null)
  useEffect(() => {
    if (!draftOpen) {
      seenWindow.current = null
      return
    }
    if (seenWindow.current === null || seenWindow.current === windowKey) {
      seenWindow.current = windowKey
      return
    }
    seenWindow.current = windowKey
    if (extendDragging.current) refitAfterDrag.current = true
    else void refitDraftInWindow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftOpen, windowKey])

  // Everything the scene is told after a render lives in useSceneSync; the
  // subscriptions here are the ones the JSX below still reads itself.
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const dimDraft = useStore((s) => s.dimDraft)
  const alignDraft = useStore((s) => s.alignDraft)
  const sectionDraft = useStore((s) => s.sectionDraft)
  // Whether a fit draft is collecting its surface by hand — it decides which
  // hint rides above the model.
  const painting = useStore(
    (s) =>
      s.selectMode === 'paint' &&
      s.draft !== null &&
      takesSurface(creationMethod(s.draft.kind, s.draft.method)),
  )
  const marking = useDeviation((s) => s.marking)
  const markGesture = useMark((s) => s.gesture)
  const workspace = useShell((s) => s.workspace)
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
    fieldDirections,
    thickness,
    thicknessRgb,
    thickScale,
    plugin: active,
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
    abortAlign,
    stopPicking,
    cancelDraft: handleCancelDraft,
    restartDraft: handleRestartDraft,
    confirmDraft: handleConfirmDraft,
    cancelSection: handleCancelSection,
    confirmSection: handleConfirmSection,
    viewFrom: (view) => sceneRef.current?.viewFrom(view),
    cycleUnderCursor: (step) => sceneRef.current?.cycleUnderCursor(step) ?? false,
  })

  // Drag & drop anywhere.
  const { saveProject, packProject, openProject, recovery } = useProject({
    sources,
    clientRef,
    sceneRef,
    elementScope,
    imports,
    commitScan,
    commitNominal,
    commitImage,
    runEdgeDetect,
    runFit,
    runDeviation,
    runThickness,
  })

  const dragging = useDragDrop({ openFile, openNominal, openImage, openProject })

  // The commands an agent runs (src/commands) work through the session, and
  // through the same handlers as the buttons for what only the browser has:
  // project files and the 2D sheet's image. Bound through a ref, as the
  // plugins' verbs are, since the handlers are this render's.
  const commandVerbs = useRef<{ project: ProjectHost; flat: FlatHost } | null>(null)
  commandVerbs.current = {
    project: {
      save: packProject,
      open: (file, discard) => openProject(file, false, discard),
    },
    flat: {
      openImage,
      closeImage: () => commitImage(null),
      detectEdges: async (sensitivity) => {
        const flat = useFlat.getState()
        if (flat.subject.kind !== 'image' || !flatGrayRef.current) return flat.edgeCount
        const before = flat.edgeVersion
        // A new sensitivity detects again by itself (the effect above).
        if (sensitivity !== flat.edgeSensitivity) flat.setEdgeSensitivity(sensitivity)
        else void runEdgeDetect()
        await new Promise<void>((resolve) => {
          const stop = useFlat.subscribe((s) => {
            if (s.edgeVersion === before) return
            stop()
            resolve()
          })
        })
        return useFlat.getState().edgeCount
      },
      edgeIndex: () => activeEdgeIndex(),
      buildSvg: buildFlatSvgFile,
      buildDxf: buildFlatDxfFile,
    },
  }
  useEffect(() => {
    const verbs = () => commandVerbs.current!
    return installCommandHost({
      session,
      project: { save: () => verbs().project.save(), open: (file, discard) => verbs().project.open(file, discard) },
      flat: {
        openImage: (file) => verbs().flat.openImage(file),
        closeImage: () => verbs().flat.closeImage(),
        detectEdges: (sensitivity) => verbs().flat.detectEdges(sensitivity),
        edgeIndex: () => verbs().flat.edgeIndex(),
        buildSvg: () => verbs().flat.buildSvg(),
        buildDxf: () => verbs().flat.buildDxf(),
      },
    })
  }, [session])

  // The agent connection, while it is switched on — see commands/bridge. A
  // pairing link in the address switches it on first.
  const agentLink = usePrefs((s) => s.agentLink)
  const agentPort = usePrefs((s) => s.agentPort)
  const agentToken = usePrefs((s) => s.agentToken)
  useEffect(() => {
    takePairingLink()
  }, [])
  useEffect(() => {
    if (!agentLink) return
    // The link's code comes with the link — see commands/agentLink.
    let stop: (() => void) | null = null
    let dropped = false
    void import('./commands/bridge').then(({ startBridge }) => {
      if (!dropped) stop = startBridge({ port: agentPort, token: agentToken })
    })
    return () => {
      dropped = true
      stop?.()
    }
  }, [agentLink, agentPort, agentToken])

  const handleCopy = () => {
    const store = useStore.getState()
    const text = buildSummary(
      store.fileName ?? '',
      store.elements,
      evaluateDimensions(store.dimensions, store.elements, surfaceSource),
    )
    void navigator.clipboard?.writeText(text)
  }

  const handleDelete = (id: number) => {
    forgetSurface(id)
    sceneRef.current?.clearElement(id)
    useStore.getState().removeElement(id)
  }

  // The instruction of the moment rides above the model; everything else the
  // tool has to say goes to the status strip.
  const fileName = useStore((s) => s.fileName)
  const vertexCountLoaded = useStore((s) => s.vertexCount > 0)
  const draftMode = draft ? creationMethod(draft.kind, draft.method).mode : null
  // While a dimension is collecting references, say which slot a viewport
  // click would fill; a construction slot invites clicks the same way.
  const openSlotHint = (() => {
    if (!draft && sectionDraft) {
      if (!sectionDraft.axis)
        return 'Click the element to cut along — a plane, cylinder, cone, line or circle — or one of the XY, YZ, XZ planes, or choose in the panel'
      const verb = sectionDraft.editId !== undefined ? 'save' : 'create'
      return sectionDraftReady(sectionDraft)
        ? `Drag the arrow to slide the plane, a ring to tilt it · Enter or middle-click to ${verb} · Esc to discard`
        : 'Drag the arrow to slide the plane along its direction, a ring to tilt it, or type the offset in the panel'
    }
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
      if (alignDraft.proposal)
        return 'This is the pose the scan suggests — change a side or a direction in the panel if it is not yours, then press Confirm alignment'
      return alignDraft.primary === null && alignDraft.primaryPicks.length === 0
        ? 'The coordinate planes show where the part is going — set a face on one of them via the panel'
        : 'Add an axis (step 2) or a zero point (step 3) if you need them — then press Confirm alignment'
    }
    if (draft && draftMode === 'construct') {
      const method = creationMethod(draft.kind, draft.method)
      if (draft.pickSlot != null)
        return picksItsPoints(draft)
          ? `Click the scan or a point element for “${method.slots[draft.pickSlot].label}”`
          : `Click the scan to pick “${method.slots[draft.pickSlot].label}” · Esc to stop picking`
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
        !evaluateDimension(dimDraft.type, fits, { anchor: dimDraft.anchor, basic: dimDraft.basic })
          .invalid
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

  // The same tools mark two different things in this workspace: the surface a
  // local fine fit runs on, and the region an element map is restricted to.
  const markHint = !marking
    ? null
    : markChipText(
        markGesture,
        markCount,
        useDeviation.getState().source === 'element' ? 'the surface to measure' : 'the surface to fit on',
        {
          idle: 'Esc closes',
          live: 'Esc to navigate, twice to close',
        },
      )

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
  const onFlat = workspace === 'flat'
  const flatImageName = useFlat((s) => s.imageName)
  const flatCalSource = useFlat((s) => s.calSource)

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
      <TopBar
        recovery={recovery}
        onSaveProject={saveProject}
        onOpenProject={openProject}
        onOpenScan={openFile}
        onOpenImage={openImage}
        canSave={(fileName !== null && vertexCountLoaded) || flatImageName !== null || runtimes.some((r) => r.canSave)}
      />
      <RecoveryBar recovery={recovery} />
      <div className="mid">
        {onDeviation ? (
          <DeviationPanel
            onOpenScan={(f) => void openFile(f)}
            onOpenNominal={(f) => void openNominal(f)}
            onAlign={() => void runAlign(false)}
            onStopAlign={abortAlign}
            onPickPoints={startPicking}
            onMeasure={() => void runDeviation()}
            onMapFacing={setMapFacing}
            onStartMarking={handleStartMarking}
            onStopMarking={handleStopMarking}
            onClearMarking={handleClearMarking}
            onLocalFit={() => void runLocalAlign()}
            onRevertLocal={handleRevertLocal}
            onSelectTarget={handleSelectTarget}
            onScopeChange={handleScopeChange}
            onScopeDone={handleScopeDone}
            onScopeClear={handleScopeClear}
            onGoToMeasure={() => useShell.getState().setWorkspace('elements')}
            onCopy={handleCopyReport}
            onExportStl={handleExportStl}
          />
        ) : onThickness ? (
          <ThicknessPanel
            onOpenScan={(f) => void openFile(f)}
            onMeasure={() => void runThickness()}
            onCopy={handleCopyThicknessReport}
          />
        ) : active?.panel ? (
          active.panel
        ) : onFlat ? (
          <FlatPanel
            onOpenImage={(f) => void openImage(f)}
            onCopy={handleFlatCopyReport}
            onExportCsv={handleFlatExportCsv}
            onExportSvg={handleFlatExportSvg}
            onExportDxf={handleFlatExportDxf}
          />
        ) : (
          <Panel
            onOpenScan={(f) => void openFile(f)}
            onStartDraft={handleStartDraft}
            onSelectMode={handleSelectMode}
            onDraftSigma={handleDraftSigma}
            onClearPaint={clearPaint}
            onUndoPick={handleUndoPick}
            onCancelDraft={handleCancelDraft}
            onRestoreDraft={handleRestoreDraft}
            onConfirmDraft={handleConfirmDraft}
            onPickPoint={handleDimensionPick}
            onDelete={handleDelete}
            onEditElement={handleEditElement}
            onStartSection={handleStartSection}
            onEditSection={handleEditSection}
            onDeleteSection={handleDeleteSection}
            onCancelSection={handleCancelSection}
            onConfirmSection={handleConfirmSection}
            onCopy={handleCopy}
            onAutoAlign={() => void session.alignment.proposeAutoAlign()}
            onAlignSymmetry={() => void session.alignment.proposeSymmetry()}
            onStartAlignment={handleStartAlignment}
            onApplyAlignment={(m) => void handleApplyAlignment(m)}
            onApplyManual={(m) => void handleApplyManual(m)}
            onResetAlignment={() => void handleResetAlignment()}
            onExportStep={handleExportStep}
            onExportStl={handleExportStl}
            onExportCloud={handleExportCloud}
            onFindSymmetry={() => void handleFindSymmetry()}
          />
        )}
        <div className={splitOpen ? 'stage split' : 'stage'}>
          {/* The viewport stays mounted behind the picker: unmounting it would
              throw away the mesh and its BVH, and both are expensive. It keeps
              its place in the tree when the split view opens for the same
              reason — it becomes the left half where it stands, rather than
              being moved into one. */}
          <div className={splitOpen ? 'viewslot split' : 'viewslot'} hidden={picking || onFlat || Boolean(active?.hideViewport)}>
            <Viewer
              onReady={(s) => {
                sceneRef.current = s
                attachSurfaceScene(() => sceneRef.current)
                s.setNavScheme(schemeById(useStore.getState().navScheme))
                s.setViewTheme(sceneTheme(useStore.getState().viewTheme, usePrefs.getState().dark))
                s.setSectionLineWidth(usePrefs.getState().sectionLines)
              }}
              onPick={handlePick}
              onHover={handleHover}
              onElementPick={handleElementPick}
              onWorldPlanePick={handleWorldPlanePick}
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
          {/* The flat viewport mounts with its workspace — there is no BVH to
              protect here, and a hidden second WebGL canvas would still hold
              its context. The 3D viewport above merely hides. */}
          {onFlat && (
            <div className="viewslot">
              <FlatViewer
                onReady={flatSync.onReady}
                onPick={(p, meta) => useFlat.getState().stageClick(p, meta, activeEdgeIndex())}
                onPickDrag={(i, p, meta) =>
                  useFlat.getState().stageDrag(i, p, meta, activeEdgeIndex())
                }
                onPinClick={(i) => useFlat.getState().clickDraftPin(i)}
                onHandleDrag={(i, end, p, meta) => useFlat.getState().stageHandleDrag(i, end, p, meta)}
                onHandleReset={(i) => useFlat.getState().setDraftTangent(i, null)}
                onNoteDrag={(id, p) => useFlat.getState().stageNoteDrag(id, p)}
                onNoteSelect={(id) => useFlat.getState().editNote(id)}
                onRegion={(min, max) => useFlat.getState().stageRegion(min, max, activeEdgeIndex())}
                onHover={flatSync.onHover}
                loupe={{
                  bitmap: () => flatBitmapRef.current,
                  docPxPerUnit: () => useFlat.getState().pxPerMm ?? { x: 1, y: 1 },
                  pose: () => sheetPoseOf(useFlat.getState()),
                  active: flatLoupeActive,
                }}
              />
            </div>
          )}
          {active?.stage}
          {picking && sceneRef.current && scanGeometry && nominalGeometry && (
            <SplitPicker
              scene={sceneRef.current}
              scanGeometry={scanGeometry}
              nominalGeometry={nominalGeometry}
              scanName={fileName ?? 'scan'}
              nominalName={nominalName ?? 'reference'}
              onAlign={() => void runAlign(true)}
              onStop={abortAlign}
              onClearSelection={clearPaint}
              onCancel={stopPicking}
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
          {!picking && active?.overlay}
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
          {onFlat && !flatImageName && flatSubject.kind === 'image' && (
            <StartPane
              title="Measuring a flatbed scan"
              blurb="Scan the part face-down on a flatbed scanner and open the image — then fit points, lines and circles to its edges and measure between them, the way a measuring microscope does. PNG or JPEG, at the highest optical resolution you have. Everything stays in this browser."
              slots={[
                {
                  role: 'Image',
                  what: 'The flatbed scan of the part',
                  name: flatImageName,
                  accept: IMAGE_ACCEPT,
                  onOpen: (f) => void openImage(f),
                },
              ]}
            />
          )}
          {needsModels && !picking && !onFlat && active?.startPane !== null && (
            <StartPane
              skip={active?.startPane?.skip}
              title={
                active?.startPane
                  ? active.startPane.title
                  : onDeviation
                  ? source === 'element'
                    ? 'Deviation from a fitted element'
                    : 'Deviation from a nominal part'
                  : onThickness
                    ? 'Wall thickness'
                    : 'Fitting elements'
              }
              blurb={
                active?.startPane
                  ? active.startPane.blurb
                  : onDeviation
                  ? source === 'element'
                    ? 'Load a scan, fit a plane, cylinder or sphere on it in the 3D Measure workspace, then map how far the surface strays from that ideal. No reference model, no alignment. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
                    : 'Load both, then best-fit the scan onto the reference and read the difference off the part. Scan as STL, PLY or OBJ in millimetres, reference as any of those or a STEP file straight from CAD — everything stays in this browser.'
                  : onThickness
                    ? 'Load a scan and measure how thick its walls are, everywhere at once. No reference model, no alignment. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
                      : 'Load a scan, then pick features on it to fit spheres, cylinders and planes and measure between them. STL, PLY or OBJ, in millimetres — everything stays in this browser.'
              }
              slots={startSlots}
            />
          )}
          {(onDeviation || onThickness || Boolean(active?.hoverReadout)) && !picking && <HoverReadout register={registerHover} />}
          {/* The bottom-left corner: the view bar at the very bottom, where a
              hand learns to find it, and the support card stacked above it so
              neither ever covers the other. Before the error toast below it:
              the CSS keeps the toast clear of the card with a sibling
              combinator, which only reaches forwards. The point picker takes
              the stage and both go with it; the 2D sheet has no surface for
              the bar's switches to act on. */}
          <div className="stagecorner">
            {!picking && <SupportCard />}
            {!picking && !onFlat && <ViewBar pluginKeys={active?.viewKeys} hideModelKeys={active?.hideModelKeys} />}
          </div>
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
                : 'No plane, cylinder or sphere yet — fit one in the 3D Measure workspace'}
            </div>
          )}
          {onThickness && !picking && !hasThicknessMap && fileName && (
            <div className="hintchip" data-test="thickness-ready-chip">
              Part loaded — measure its wall thickness in the panel
            </div>
          )}
          {/* Not a hint but an alarm: every number this workspace shows rests
              on the scale, and until one has been measured the scale is only
              what the file claims about itself — or nothing at all. */}
          {onFlat && flatSubject.kind === 'image' && flatImageName && flatCalSource !== 'measured' && (
            <div className="warnchip" data-test="flat-uncalibrated-chip">
              {flatCalSource === 'metadata'
                ? 'UNCALIBRATED — sizes use the file’s nominal dpi. Calibrate against a known length in the panel.'
                : 'UNCALIBRATED — the file declares no scale, so sizes are pixels. Calibrate against a known length in the panel.'}
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
              {onFlat
                ? 'Drop your PNG / JPEG scan here'
                : `Drop your STL / PLY / OBJ${onDeviation ? ' / STEP' : ''} here`}
            </div>
          )}
        </div>
      </div>
      <StatusStrip />
      <SettingsModal />
      <UnitsModal />
      <ImprintModal />
    </div>
  )
}
