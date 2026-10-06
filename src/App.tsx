// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef } from 'react'
import { useProjectHistory } from './app/useProjectHistory'
import { clearHistory, historyAction, historyAsync } from './state/historyStore'
import { MeshWorkerClient } from './core/workerClient'
import { creaseSetting, type CreaseReport, type CreaseSetting } from './core/geometry/crease'
import { buildSummary } from './core/summary'
import { baseSeedPlane } from './core/symmetry'
import { IMAGE_ACCEPT, REFERENCE_ACCEPT } from './core/formats'
import { EdgeClient } from './core/flat/edgeClient'
import { EDGE_MIN_FEATURE_MM } from './core/flat/edges'
import { chainCount, type EdgeChains } from './core/flat/edges'
import { EdgeIndex } from './core/flat/snap'
import { evaluateFlatDimensions } from './core/flat/dimensions'
import { buildFlatCsv, buildFlatReport, scaleLine, titleLine, type FlatReportInput } from './core/flat/report'
import type { FlatDrawingInput } from './core/flat/drawing'
import type { Vec2 } from './core/flat/types'
import {
  canCutAlong,
  describeCut,
  sectionRefName,
  tiltOf,
  turnAxis,
  type CutAxis,
  type WorldAxis,
} from './core/section/frame'
import { chainBounds, projectCut } from './core/section/slice'
import { elementKindInfo } from './core/elements/kinds'
import { creationMethod, takesSurface } from './core/elements/construct'
import { circleFromPoints } from './core/fit/circle'
import { extensionOf, fitWindow, isExtendable, sideValue } from './core/elements/extend'
import { roleOf } from './core/elements/refs'
import { dimensionTypeInfo, evaluateDimension, evaluateDimensions } from './core/dimensions'
import {
  attachSurfaceScene,
  forgetAllSurfaces,
  forgetSurface,
  rememberSurface,
  surfaceSource,
  surfacesMoved,
} from './app/surfaces'
import type { ElementKind, FitData, PointFit, SigmaPreset, Vec3 } from './core/types'
import {
  alignCenterOf,
  alignmentPreview,
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
import { rigidApply, rigidInvert, rigidToColumnMajor, type Rigid } from './core/deviation/rigid'
import { ALIGN_PICK_COUNT, describeRigid } from './core/alignment'
import { autoAlignPicks } from './core/autoAlign'
import { ALIGN_SYMMETRY_MAX_RMS_MM, poseOfRigid, poseOnSymmetry } from './core/alignSymmetry'
import { SYMMETRY_MAX_RMS_MM, SYMMETRY_MIN_MATCHED } from './core/symmetry'
import { exportElementsStep, exportScanPointCloud, exportScanStl, saveFile, runExport } from './app/exports'
import { PICK_MARK_TOOL_STATUS, useDeviationWorkspace } from './app/useDeviationWorkspace'
import { targetFitOf, useElementField } from './app/useElementField'
import { detectMaterialSide } from './core/deviation/elementField'
import { useThicknessWorkspace } from './app/useThicknessWorkspace'
import { useSceneSync } from './app/useSceneSync'
import { useScanSwap } from './app/useScanSwap'
import { scanLoaded } from './app/scanEvents'
import { useSections } from './app/useSections'
import { useFlatSceneSync, type SheetView } from './app/useFlatSceneSync'
import { sheetAlignment, sheetElements, sheetFrame, sheetLoupeActive, sheetPoseOf, sheetScale } from './app/flatSheet'
import { useHintChip } from './app/useHints'
import { useGlobalShortcuts } from './app/useGlobalShortcuts'
import { useDragDrop } from './app/useDragDrop'
import { useProject } from './app/useProject'
import { emptySources, type SourceFiles } from './app/project'
import { ImportQueue } from './app/importQueue'
import { prepareScan, prepareImage, runImport, type PreparedScan, type PreparedImage } from './app/imports'
import { unitsLabel, type MeshUnits } from './core/meshUnits'
import { meshUnitsFor } from './state/unitsPromptStore'
import { plugins } from './plugins/registry'
import type { PluginHost, PluginRuntime } from './plugins/api'

const LARGE_TRIANGLE_WARNING = 5_000_000

/** What a plugin without a hook adds: nothing. */
const NO_RUNTIME: PluginRuntime = {}

/** How long the sharp-edge setting has to stand still before the scan is
 *  split for it again, ms: a slider dragged across splits it once. */
const CREASE_SETTLE_MS = 250

/** What became of the sharp-edge split, for the status line. Null when it
 *  went as asked and there is nothing to add. */
function creaseNote(report: CreaseReport, crease: CreaseSetting): string | null {
  if (report.skipped === 'budget') {
    return `Sharp edges are shaded smooth: drawing every edge from ${crease.angleDeg}° on sharp would add more vertices than the scan has — try a larger angle.`
  }
  if (report.skipped === 'scan') {
    return 'This mesh reads as a scan, so its edges are shaded smooth — set Sharp edges to Always to split them regardless, from an angle the noise does not reach.'
  }
  if (report.skipped === 'off') return 'Sharp edges shaded smooth.'
  if (report.added === 0) {
    return crease.mode === 'on' ? `No edges of ${crease.angleDeg}° or more to split on this mesh.` : 'Sharp edges drawn sharp.'
  }
  return `Edges from ${crease.angleDeg}° on drawn sharp — ${report.added.toLocaleString('en-US')} vertices split.`
}

export default function App() {
  const imports = useRef(new ImportQueue()).current
  const clientRef = useRef<MeshWorkerClient | null>(null)
  if (!clientRef.current) clientRef.current = new MeshWorkerClient()
  const sceneRef = useRef<SceneManager | null>(null)
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
  // The bytes of every model as it came in, for saving the session as a
  // project — see app/project. The worker takes its copy by transfer, so this
  // is the only one left.
  const sources = useRef<SourceFiles>(emptySources())
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
  // The direction each reading of a deviation map was taken along, for playing
  // the map as motion (core/deviation/deflection.ts) — keyed by the map's own
  // array, so a direction can never be read against a map it was not measured
  // with, and goes when the map does.
  const fieldDirections = useMemo(() => new WeakMap<Float32Array, Int8Array>(), [])
  // The hand-marked scan region an element map can be restricted to. A snapshot
  // rather than the live paint mask, so the region survives the paint layer
  // being cleared by other workflows — the map keeps showing what was chosen.
  const elementScope = useRef<Uint32Array | null>(null)
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

  const clearPreview = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
    sceneRef.current?.setPreview(null)
  }

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
    maps: { deviation, deviationRgb, elementField, elementRgb, elementScope, thickness, thicknessRgb },
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
  // arrive from a project with their planes only.
  useSections({ clientRef })

  /** The section on the 2D stage, described for the report: its name, the
   *  scan it cuts, and where. Undefined with the image on the stage. */
  const activeSectionInfo = () => {
    const subject = useFlat.getState().subject
    if (subject.kind !== 'section') return undefined
    const store = useStore.getState()
    const sec = store.sections.find((x) => x.id === subject.id)
    if (!sec) return undefined
    const where = describeCut(
      sectionRefName(sec.ref, store.elements),
      sec.offset,
      tiltOf(sec.refDir, sec.frame.normal),
    )
    return { name: sec.name, scanName: store.fileName ?? 'scan', cut: where }
  }

  /** Everything the 2D report and CSV need, gathered once. */
  const flatReportInput = (): FlatReportInput => {
    const s = useFlat.getState()
    return {
      imageName: s.imageName ?? 'image',
      imageWidth: s.imageWidth,
      imageHeight: s.imageHeight,
      calSource: s.calSource,
      section: activeSectionInfo(),
      pxPerMm: s.pxPerMm,
      datum: s.datum,
      frame: sheetFrame(s),
      unit: s.pxPerMm ? 'mm' : 'px',
      elements: s.elements,
      dimensions: evaluateFlatDimensions(s.dimensions, s.elements),
      counts: s.counts,
    }
  }

  const handleFlatCopyReport = () => {
    void navigator.clipboard.writeText(buildFlatReport(flatReportInput()))
    useStore.getState().setStatus('2D measurement report copied to the clipboard.')
  }

  /** The stem every 2D export is named on: the section, or the image. */
  const flatExportStem = () =>
    (activeSectionInfo()?.name ?? useFlat.getState().imageName ?? 'scan').replace(/\.[^.]+$/, '')

  const handleFlatExportCsv = () => {
    const name = `${flatExportStem()}-measurements.csv`
    saveFile(name, new Blob([buildFlatCsv(flatReportInput())], { type: 'text/csv' }))
    useStore.getState().setStatus(`Measurements exported to ${name}.`)
  }

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
   *  print at 1:1. */
  const handleFlatExportSvg = () => runExport(async () => {
    const input = flatDrawingInput()
    if (!input) return
    const name = `${flatExportStem()}-sheet.svg`
    const summary = drawnSummary(input)
    const { buildFlatSvg } = await import('./core/flat/svg')
    saveFile(name, new Blob([buildFlatSvg(input)], { type: 'image/svg+xml' }))
    useStore.getState().setStatus(`Sheet exported to ${name} — ${summary}.`)
  })

  /** The sheet as a DXF — for CAD: millimetres by declaration, y up, the
   *  origin on the alignment, the edges thinned to a sketch's worth. */
  const handleFlatExportDxf = () => runExport(async () => {
    const input = flatDrawingInput()
    if (!input) return
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
    saveFile(name, new Blob([dxf], { type: 'application/dxf' }))
    useStore
      .getState()
      .setStatus(`Drawing exported to ${name} — ${drawnSummary(input, `thinned to ${tolerance} ${input.unit}`, s.showEdges)}.`)
  })



  const commitScan = (prepared: PreparedScan | null) => {
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
    // The marked region is vertex indices into the scan being replaced — and
    // so is every surface an element rested on.
    elementScope.current = null
    forgetAllSurfaces()
    thickness.current = null
    thicknessRgb.current = null
    useDeviation.getState().clearAlign()
    useDeviation.getState().clearElementMap()
    useDeviation.getState().clearScope()
    useThickness.getState().clear()
    // Nothing is marked on a part that is being replaced, and no gesture should
    // survive the swap.
    useMark.getState().reset()
    sources.current.scan = prepared?.source ?? null
    store.beginLoad(prepared?.source.name ?? '')
    if (prepared) {
      prepared.view.commit()
      const { mesh } = prepared
      store.finishLoad(mesh.vertexCount, mesh.triangleCount,
        sceneRef.current?.modelSize() ?? 1, sceneRef.current?.modelCenter() ?? [0, 0, 0])
      useMark.getState().sizeToModel(sceneRef.current?.modelSize() ?? 1)
      useThickness.getState().suggestMaxThickness(2 * (sceneRef.current?.modelSize() ?? 1))
      scanLoaded({ positions: mesh.positions, indices: mesh.indices, modelSize: sceneRef.current?.modelSize() ?? 1 })
    } else {
      sceneRef.current?.clearScan()
      useStore.setState({ fileName: null, modelSize: 1, modelCenter: [0, 0, 0] })
      scanLoaded(null)
    }
    // Project restoration still has work to do; the import owns this flag.
    useStore.setState({ busy: true })
    clearHistory()
  }

  /** An STL is asked about first — what units it is in — unless `units` is
   *  given: a file the instrument wrote itself, in millimetres like
   *  everything it holds. A question dismissed leaves the file unopened. */
  const openFile = async (file: File, units?: MeshUnits): Promise<void> => {
    const read = units ?? (await meshUnitsFor(file.name))
    if (!read) return
    await runImport(imports, 'Reading file…', async () => {
      const client = clientRef.current!
      const crease = creaseSetting(useStore.getState())
      const prepared = await prepareScan(client, sceneRef.current!, file, crease, undefined, read)
      try {
        await client.commitImport({ scan: prepared.id })
        commitScan(prepared)
        const mesh = prepared.mesh
        const creaseWord = mesh.crease.skipped === 'budget' ? ` ${creaseNote(mesh.crease, crease)}` : ''
        const unitsWord = read !== 'mm' ? `Read in ${unitsLabel(read).toLowerCase()} and converted to millimetres. ` : ''
        useStore.getState().setStatus(
          unitsWord +
          (mesh.triangleCount > LARGE_TRIANGLE_WARNING
            ? `Large mesh (${mesh.triangleCount.toLocaleString('en-US')} triangles) — fits may take a moment. Pick an element type to start.`
            : 'Pick an element type in the panel to start measuring.') + creaseWord)
      } finally {
        prepared.view.dispose()
        await client.discardImport([prepared.id])
      }
    })
  }

  /** Re-fit an already measured element (on project load, where the fits are
   *  saved without their surfaces). A hand-marked element re-fits on its
   *  marked surface, an auto-fitted one from its seeds, each with the fit
   *  settings it was measured with — all of it the recipe the element was
   *  made with. */
  const runFit = async (
    elementId: number,
    kind: ElementKind,
    seeds: number[],
    selection?: Uint32Array,
    regionsOnly = false,
  ) => {
    const scanVersion = clientRef.current!.scanVersion
    const el = useStore.getState().elements.find((e) => e.id === elementId)
    const alignment = useStore.getState().appliedAlignment
    const stillCurrent = () => scanVersion === clientRef.current!.scanVersion &&
      alignment === useStore.getState().appliedAlignment &&
      el?.source === useStore.getState().elements.find((e) => e.id === elementId)?.source
    const settings = el?.source.type === 'fitted' ? el.source.settings : useStore.getState().settings
    // A fit confined to the drawn span is confined to it every time it runs.
    const window = fitWindow(el?.extend)
    try {
      const result = selection
        ? await clientRef.current!.fitSelection(kind, selection, settings, window)
        : await clientRef.current!.fit(kind, seeds, settings, window)
      if (!stillCurrent()) return
      // The surface goes on record before the fit does, so whatever re-reads
      // the elements on the fit landing finds the points already there.
      rememberSurface(elementId, result.region)
      if (!regionsOnly || !el?.fit) useStore.getState().resolveFit(elementId, result)
      const fitted = useStore.getState().elements.find((e) => e.id === elementId)
      if (fitted) sceneRef.current?.applyRegion(elementId, fitted.color, result.region)
    } catch (e) {
      if (!stillCurrent()) return
      useStore.getState().failFit(elementId, e instanceof Error ? e.message : String(e))
    }
  }

  /** The fit settings the open draft runs with — its own. The session default
   *  only stands in when no draft is open, which no fit below runs without. */
  const draftSettings = () => {
    const s = useStore.getState()
    return s.draft?.settings ?? s.settings
  }

  /** Fit the draft from every picked point at once and show it as a preview.
   *  Picks may sit on unconnected patches — a partial scan of one feature —
   *  and the region growing seeds from all of them. */
  const runDraftFit = async (kind: ElementKind, picks: [number, number, number][]) => {
    const seq = ++draftSeq.current
    const settings = draftSettings()
    const seeds = picks.flat()
    const window = fitWindow(useStore.getState().draft?.extend)
    try {
      const result = await clientRef.current!.fit(kind, seeds, settings, window)
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
    const settings = draftSettings()
    const window = fitWindow(useStore.getState().draft?.extend)
    useStore.getState().setDraftSelection(selection)
    try {
      const result = await clientRef.current!.fitSelection(kind, selection, settings, window)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** The open draft measured again on the same surface, with the span its fit
   *  is confined to as it stands now. In place: the fit standing is replaced
   *  when the new one lands, and nothing goes blank in between — this runs at
   *  the end of a grip drag, and a ghost that vanished under the hand would
   *  make the drag look like a mistake. A failure keeps the fit too, so the
   *  fields stay to be put right. */
  const refitDraftInWindow = async () => {
    const d = useStore.getState().draft
    if (!d || d.kind !== 'cylinder' || creationMethod(d.kind, d.method).mode !== 'fit') return
    if (!d.selection && d.picks.length === 0) return
    const seq = ++draftSeq.current
    const settings = d.settings
    const window = fitWindow(d.extend)
    try {
      const result = d.selection
        ? await clientRef.current!.fitSelection(d.kind, d.selection, settings, window)
        : await clientRef.current!.fit(d.kind, d.picks.flat(), settings, window)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      // A hand-marked surface is already tinted by the marking itself, which
      // sits above any preview; a grown one shows what the fit now rests on.
      if (!d.selection)
        sceneRef.current?.setPreviewRegion(result.region, draftColorOf(useStore.getState()))
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

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
  const applyRigidToPart = (m: Rigid, reset = false) => imports.run(() => historyAsync('Align part', async () => {
    useStore.setState({ busy: true })
    try {
      clearPreview()
      useStore.getState().setStatus('Aligning part — rebuilding spatial index…')
      // Let the status paint before the synchronous BVH rebuild.
      await new Promise((r) => setTimeout(r, 30))
      await clientRef.current!.transform(m)
      // The real transform goes on and the preview of it comes off together.
      sceneRef.current?.applyTransform(m)
      sceneRef.current?.setAlignPreview(null)
      useStore.getState().applyAlignment(m)
      if (reset) useStore.getState().clearAppliedAlignment()
      // Thickness is invariant under a rigid move; its pins move with the scan.
      const moved = new Float64Array(3)
      useThickness.setState((s) => ({ probes: s.probes.map((probe) => {
        rigidApply(m, ...probe.point, moved)
        return { ...probe, point: [moved[0], moved[1], moved[2]] as Vec3 }
      }) }))
      surfacesMoved()
      deviation.current = null
      deviationRgb.current = null
      sceneRef.current?.setFieldColors(null)
      useDeviation.getState().clearAlign()
    } finally { useStore.setState({ busy: false }) }
  })).then(() => true).catch((error) => {
    useStore.getState().setError(error instanceof Error ? error.message : String(error))
    return false
  })

  const handleStartAlignment = () => {
    clearPreview()
    useStore.getState().startAlignment()
    useStore
      .getState()
      .setStatus(
        'Step 1 — pick 3 points on the face the part stands on, or choose a measured element.',
      )
  }

  /** Ask the worker what coordinate system the scan suggests and open the
   *  alignment editor on it: the slots filled, the pose previewed on the part,
   *  nothing applied. What the proposal rests on is said in the editor, so a
   *  guess reads as a guess. */
  const handleAutoAlign = async () => {
    clearPreview()
    const s = useStore.getState()
    s.setError(null)
    s.setStatus('Auto-align — reading the part’s directions off the scan…')
    s.setWorking('READING…')
    try {
      const r = await clientRef.current!.autoAlign()
      const pct = (share: number) => `${Math.round(share * 100)} %`
      const stands = {
        'open-side': 'the side the scan is open on',
        face: 'its largest flat face',
        'axis-end': 'an end of its main axis',
        extent: 'its flattest side',
      }[r.base]
      const read =
        r.method === 'principal'
          ? 'The scan shows no face directions and no round walls, so this is the principal axes of its points — a guess.'
          : r.method === 'axis'
            ? `Read off the scan: the main axis from the round walls (${pct(r.wallShare)} of the surface)${
                r.onAxis ? ', zero on that axis' : ''
              }; ${pct(r.planeShare)} of the surface is faces square to the axes.`
            : `Read off the scan: ${pct(r.planeShare)} of the surface is faces square to these axes${
                r.wallShare >= 0.05 ? `, ${pct(r.wallShare)} more is wall running along them` : ''
              }.`
      const note = `${read} The part stands on ${stands}, its long side along X. Change a side or a direction below if it reads the part differently than you do.`
      useStore.getState().proposeAlignment(autoAlignPicks(r, 0.2 * useStore.getState().modelSize), note)
      useStore.getState().setStatus('Auto-align — check the previewed pose, then press Confirm alignment.')
    } catch (e) {
      useStore.getState().setStatus('')
      useStore.getState().setError(e instanceof Error ? e.message : 'Auto-align failed.')
    } finally {
      useStore.getState().setWorking(null)
    }
  }

  /** The pose being set up, settled on the part's symmetry plane: the plane
   *  a Measure symmetry plane gives, or the scan searched for its own; the
   *  pose the editor previews, or Auto-align's when it has none yet. It
   *  comes back as a proposal — picks, like Auto-align's — so every choice
   *  in it can still be changed and nothing moves until it is applied. */
  const handleAlignSymmetry = async () => {
    clearPreview()
    const s = useStore.getState()
    const client = clientRef.current
    if (!client || !s.fileName) return
    s.setError(null)
    // Seconds of searching on a big scan, with nothing to show on the part
    // until the pose lands: the viewport says so meanwhile, as the symmetry
    // plane's own box does.
    s.setWorking('SEARCHING…')
    try {
      const ad = s.alignDraft
      const standing = ad ? alignmentPreview(ad, s.elements, s.modelSize, alignCenterOf(s)).preview : null
      let pose: { axes: [Vec3, Vec3, Vec3]; origin: Vec3 }
      if (standing) pose = poseOfRigid(standing.rigid)
      else {
        s.setStatus('Use symmetry — no pose set up yet, reading one off the scan first…')
        pose = await client.autoAlign()
      }
      const measured = [...s.elements].reverse().find((e) => e.fit?.kind === 'plane' && e.source.type === 'constructed' && e.source.method === 'plane-symmetry')
      let plane: { normal: Vec3; point: Vec3 }
      let from: string
      if (measured?.fit?.kind === 'plane') {
        plane = { normal: measured.fit.normal, point: measured.fit.center }
        from = measured.name
      } else {
        s.setStatus('Use symmetry — searching the scan for its mirror plane…')
        const r = await client.symmetry(null)
        if (!Number.isFinite(r.rms) || r.rms > ALIGN_SYMMETRY_MAX_RMS_MM || r.sampled === 0 || r.matched / r.sampled < SYMMETRY_MIN_MATCHED) {
          useStore.getState().setStatus('')
          useStore.getState().setError(`No symmetry plane found on the scan — the best mirror image stands ${Number.isFinite(r.rms) ? `${r.rms.toFixed(2)} mm` : 'far'} off it. The pose is left as it is.`)
          return
        }
        plane = { normal: r.normal, point: r.point }
        from = `the scan’s mirror plane (σ ${r.rms.toFixed(3)} mm${r.rms > SYMMETRY_MAX_RMS_MM ? ', a loose match' : ''})`
      }
      const settled = poseOnSymmetry(pose.axes, pose.origin, plane)
      if (!settled) {
        useStore.getState().setError('The symmetry plane has no direction to settle the pose on.')
        return
      }
      const names = ['YZ', 'XZ', 'XY']
      const note = `Settled on ${from}: it is the ${names[settled.axis]} plane now — ${'XYZ'[settled.axis]} turned ${settled.tiltDeg.toFixed(2)}° onto its normal, the zero point moved ${settled.shiftMm.toFixed(2)} mm onto it. The steps below are this pose as points; change a side or a direction if it reads the part differently than you do.`
      useStore.getState().proposeAlignment(autoAlignPicks(settled, 0.2 * useStore.getState().modelSize), note)
      useStore.getState().setStatus('Use symmetry — check the previewed pose, then press Confirm alignment.')
    } catch (e) {
      useStore.getState().setStatus('')
      useStore.getState().setError(e instanceof Error ? e.message : 'The symmetry search failed.')
    } finally {
      useStore.getState().setWorking(null)
    }
  }

  const handleApplyAlignment = async (m: Rigid) => {
    const { rotationDeg, translation } = describeRigid(m)
    if (!await applyRigidToPart(m)) return
    useStore
      .getState()
      .setStatus(
        `Part aligned — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
  }

  const handleApplyManual = async (m: Rigid) => {
    const { rotationDeg, translation } = describeRigid(m)
    if (!await applyRigidToPart(m)) return
    useStore
      .getState()
      .setStatus(
        `Part moved — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
  }

  const handleResetAlignment = async () => {
    const total = useStore.getState().appliedAlignment
    if (!total) return
    if (!await applyRigidToPart(rigidInvert(total), true)) return
    useStore.getState().setStatus('Alignment reset — the part is back in scan coordinates.')
  }

  // The exports live in src/app/exports.ts — they read the stores directly,
  // and the STL one needs the scene for the geometry as shown.
  const handleExportStep = exportElementsStep
  const handleExportStl = () => exportScanStl(sceneRef)
  const handleExportCloud = () => exportScanPointCloud(sceneRef, useStore.getState().cloudFormat)

  /** The open symmetry-plane draft asks the worker for the mirror plane —
   *  refined from the seed plane it names, or from the scan's principal
   *  planes — and takes the numbers into its params the way typed ones go. */
  const handleFindSymmetry = async () => {
    const s = useStore.getState()
    const d = s.draft
    if (!d || d.method !== 'plane-symmetry' || d.status === 'fitting') return
    const seedEl = d.seed != null && d.seed >= 0 ? s.elements.find((e) => e.id === d.seed) : undefined
    const seedFit = seedEl?.fit?.kind === 'plane' ? seedEl.fit : null
    const seedBase = d.seed != null && d.seed < 0 ? baseSeedPlane(d.seed, s.modelCenter, s.modelSize) : null
    const seedName = seedFit ? seedEl!.name : seedBase ? `the ${seedBase.name}` : null
    s.setDraftWorking('Searching the scan for its mirror plane…')
    try {
      const marked = d.selection ?? null
      const r = await clientRef.current!.symmetry(
        seedFit ? { normal: seedFit.normal, point: seedFit.center } : seedBase ? { normal: seedBase.normal, point: seedBase.point } : null,
        marked,
      )
      const now = useStore.getState().draft
      if (!now || now.method !== 'plane-symmetry') return
      const loose = r.rms > 0.1
      useStore.getState().setDraftParams(
        [...r.normal, ...r.point, r.rms, r.matched, r.sampled],
        `The mirror image fits the ${marked ? 'marked surface' : 'scan'} to σ ${r.rms.toFixed(
          4,
        )} mm over ${r.matched.toLocaleString('en-US')} of ${r.sampled.toLocaleString(
          'en-US',
        )} samples, ${
          seedName
            ? `refined from ${seedName}`
            : r.candidate < 3
              ? `from principal plane ${r.candidate + 1}`
              : 'from one of the part’s face directions'
        }.${
          loose
            ? ' A loose match: the part may not be symmetric about any plane, or the seed was far off — try another seed.'
            : ''
        }`,
      )
    } catch (e) {
      const now = useStore.getState().draft
      if (now && now.method === 'plane-symmetry')
        useStore.getState().failDraft(e instanceof Error ? e.message : 'The symmetry search failed.')
    }
  }

  // A centroid draft measures itself the moment it is opened: its numbers
  // come off the scan, not the keyboard. Keyed on the draft being an
  // unmeasured centroid, so choosing the method again measures again and a
  // failed measurement stays failed rather than looping.
  const centroidPending = useStore(
    (s) =>
      s.draft?.method === 'point-centroid' &&
      s.draft.status === 'empty' &&
      s.draft.params.some((p) => !Number.isFinite(p)),
  )
  useEffect(() => {
    if (!centroidPending) return
    const marked = useStore.getState().draft?.selection ?? null
    useStore.getState().setDraftWorking('Measuring the centroid…')
    void clientRef.current!.centroid(marked).then(
      (c) => {
        const now = useStore.getState().draft
        if (!now || now.method !== 'point-centroid' || now.status !== 'fitting') return
        const at = c.volume ?? c.area
        useStore.getState().setDraftParams(
          [at[0], at[1], at[2]],
          marked
            ? `The centroid of the ${marked.length.toLocaleString('en-US')} marked points' surface — of its area, not of a volume.`
            : c.closed
              ? `The centroid of the enclosed volume, ${(c.volumeMm3 / 1000).toFixed(2)} cm³.`
              : 'The scan is open — this is the centroid of its surface, not of a volume.',
        )
      },
      (e: unknown) => {
        const now = useStore.getState().draft
        if (now && now.method === 'point-centroid')
          useStore.getState().failDraft(e instanceof Error ? e.message : 'The centroid could not be measured.')
      },
    )
  }, [centroidPending])

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
  } = useDeviationWorkspace({ clientRef, sceneRef, deviation, deviationRgb, fieldDirections, sources, imports })

  // ---- Deviation from a fitted element -------------------------------------

  useElementField({ sceneRef, elementField, elementRgb, elementScope, fieldDirections })

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

  const { runThickness, handleCopyThicknessReport } = useThicknessWorkspace({
    clientRef,
    thickness,
    thicknessRgb,
  })

  // Another version of the scan put in place under the session — see
  // useScanSwap.
  const { swapScan, remapScan, remeasureScan } = useScanSwap({
    clientRef, sceneRef, sources, maps: host.maps, clearPreview, runFit, runDeviation, runThickness,
  })

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

  const handleStartDraft = (kind: ElementKind) => {
    const store = useStore.getState()
    clearPreview()
    // A new element starts from bare scan, whichever way the last one was
    // collected — the brush stays armed, but nothing is marked for it yet.
    clearPaint()
    // The kind already in hand, pressed again, starts its box over — it is
    // not put down.
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

  const handleCancelDraft = () => {
    const closing = useStore.getState().draft
    // The store first: a draft closed with a marking on it is put aside with
    // that marking (store.discarded), and clearing the part would take the
    // marking off the draft before it is.
    useStore.getState().cancelDraft()
    clearPreview()
    clearPaint()
    const kept = useStore.getState().discarded
    useStore.getState().setStatus(
      kept?.selection && closing
        ? `${closing.editId !== undefined ? 'The edit was' : `The ${elementKindInfo(closing.kind).noun} was`} discarded with ${kept.selection.length.toLocaleString('en-US')} marked points on it — Restore in the panel brings it back.`
        : '',
    )
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
    if (el && region) {
      rememberSurface(id, region)
      sceneRef.current?.applyRegion(id, el.color, region)
    }
    // An element that has stopped being fitted — re-made from coordinates or
    // from other elements — leaves the surface it used to own behind.
    else if (el && el.source.type !== 'fitted') {
      forgetSurface(id)
      sceneRef.current?.clearElement(id)
    }
    // The kind is still in hand after a creation — say so the first times,
    // and where the way out is.
    const next = useStore.getState().draft
    useStore.getState().setStatus(
      next
        ? `${el?.name ?? 'Element'} created — the ${elementKindInfo(next.kind).noun} stays in hand for the next one; Esc or Cancel puts it down.`
        : `${el?.name ?? 'Element'} ${editing ? 'updated' : 'created'}.`,
    )
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
  const { saveProject, openProject, recovery } = useProject({
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
            onAutoAlign={() => void handleAutoAlign()}
            onAlignSymmetry={() => void handleAlignSymmetry()}
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
