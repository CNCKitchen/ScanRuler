// SPDX-License-Identifier: AGPL-3.0-only
// Everything the scene is told after a render: the draft's ghost and grips,
// the marking brush, overlays and highlights, the alignment previews, and the
// colouring of whichever map the workspace is showing. The stores hold the
// truth; these effects repeat it to the viewport.
import { useEffect, useMemo, useRef } from 'react'
import { creationMethod, takesSurface } from '../core/elements/construct'
import { translationToOrigin } from '../core/alignment'
import type { ReferenceDeviationResult } from '../core/workerClient'
import { referenceScale } from '../core/deviation/onReference'
import { isDeviationTarget } from '../core/deviation/elementField'
import { isExtendable } from '../core/elements/extend'
import { drawnFit } from '../core/elements/assumed'
import { dimensionTypeInfo, evaluateDimensions, pinNotes, type EvaluatedDimension } from '../core/dimensions'
import { liftFlatFit } from '../core/section/lift'
import { surfaceSource, useSurfaces } from './surfaces'
import {
  alignCenterOf,
  blockedRefs,
  alignmentPreview,
  draftColorOf,
  sectionDraftColorOf,
  useStore,
  orientedDraft,
} from '../state/store'
import { dimensionRefsOf, isExtruded, isShadow } from '../state/sectionModel'
import type {
  SceneManager,
  OverlayAngle,
  OverlayElement,
  OverlayPair,
  OverlayTag,
} from '../viewer/SceneManager'
import { schemeById } from '../viewer/navSchemes'
import { usePrefs } from '../state/prefsStore'
import { sceneTheme } from '../viewer/viewThemes'
import { formatSigned } from '../ui/format'
import { pinValue } from '../viewer/pinLabel'
import { fmtLen, unitWord } from '../core/units'
import { useUnits } from './useUnits'
import { providersFor } from '../ui/RefSelect'
import { MARK_COLOR, useDeviation } from '../state/deviationStore'
import { sectionElementsOf, useFlat } from '../state/flatStore'
import { useShell } from '../state/shellStore'
import { useMark } from '../state/markStore'
import { useThickness } from '../state/thicknessStore'
import { colormapById, paintField, type FieldScale } from '../core/field/colormap'
import { fieldHistogram } from '../core/field/stats'
import { deviationScale, deviationStats } from '../core/deviation/deviation'
import {
  DEFLECTION_SMOOTHING,
  deflectionVectors,
  suggestDeflectionScale,
} from '../core/deviation/deflection'
import { thicknessStats } from '../core/thickness/thickness'
import { identityRigid, rigidCompose, rigidInvert, rigidToColumnMajor } from '../core/deviation/rigid'
import { sectionViewFrames, useSectionView } from '../state/sectionViewStore'
import type { RefObject } from 'react'
import type { PluginRuntime } from '../plugins/api'

/** How long the inputs to the deformation animation must hold still before
 *  its motion is worked out again — see the effect at the end. */
const DEFLECTION_SETTLE_MS = 150

export function useSceneSync({
  sceneRef,
  deviation,
  deviationRgb,
  referenceMap,
  referenceRgb,
  elementField,
  elementRgb,
  fieldDirections,
  thickness,
  thicknessRgb,
  thickScale,
  plugin,
  cancelDraft,
}: {
  sceneRef: RefObject<SceneManager | null>
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  /** The map the other way round, on the reference cut finer, and its
   *  colours — see core/deviation/onReference.ts. */
  referenceMap: RefObject<ReferenceDeviationResult | null>
  referenceRgb: RefObject<Uint8Array | null>
  /** The deviation from a fitted element, held beside the one from a reference
   *  part so switching between them loses neither. */
  elementField: RefObject<Float32Array | null>
  elementRgb: RefObject<Uint8Array | null>
  /** The direction each deviation map's readings were taken along, keyed by
   *  the map — what playing one as motion moves the scan along. */
  fieldDirections: WeakMap<Float32Array, Int8Array>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
  /** Held stable across renders by App, because it is what tells the repaint
   *  below whether anything actually changed. */
  thickScale: FieldScale
  /** The runtime of the plugin whose workspace is on screen, if one is —
   *  its colouring, its marking, what it shows of the part. */
  plugin: PluginRuntime | null
  /** Close a half-finished element draft, preview and marking included. */
  cancelDraft: () => void
}) {
  // The colour the open draft wears, on its ghost, its grips and whatever
  // surface is marked for it: an edited element keeps its own, a new one takes
  // the next in the palette.
  const draftColor = useStore(draftColorOf)

  // The draft's ghost shape follows whatever the draft currently is — a fit
  // preview, a picked point, or a construction taking shape in the panel.
  const measuredDraftFit = useStore((s) => (s.draft?.status === 'ready' ? s.draft.fit : undefined))
  const draftOrient = useStore((s) => s.draft?.orient)
  const draftExtend = useStore((s) => s.draft?.extend)
  const draftAssumed = useStore((s) => s.draft?.assumed)
  const elementsForOrient = useStore((s) => (s.draft?.orient ? s.elements : null))
  const sectionsForOrient = useStore((s) => (s.draft?.orient ? s.sections : null))
  // An aligned draft is shown turned onto its reference plane — what it will
  // be created as.
  const draftFit = useMemo(
    () =>
      measuredDraftFit && draftOrient && elementsForOrient
        ? orientedDraft(
            { fit: measuredDraftFit, orient: draftOrient },
            dimensionRefsOf(elementsForOrient, sectionsForOrient ?? []),
          ).fit
        : measuredDraftFit,
    [measuredDraftFit, draftOrient, elementsForOrient, sectionsForOrient],
  )
  // What the ghost is: the fit, at the diameter it is assumed to have been
  // designed at and carrying however far past its measured surface it has
  // been extended. Recomputed rather than stored, so the fit under it stays
  // the measurement.
  const shownDraftFit = useMemo(
    () => (draftFit ? drawnFit(draftFit, draftAssumed, draftExtend) : null),
    [draftFit, draftAssumed, draftExtend],
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
      takesSurface(creationMethod(s.draft.kind, s.draft.method)),
  )
  const paintWorkspace = useShell((s) => s.workspace === 'elements')
  const marking = useDeviation((s) => s.marking)
  const markWorkspace = useShell((s) => s.workspace === 'deviation')
  const markGesture = useMark((s) => s.gesture)
  const markErase = useMark((s) => s.erase)
  const markBackfaces = useMark((s) => s.backfaces)
  const brushDiameter = useMark((s) => s.diameter)
  const paintSession = painting && paintWorkspace
  const markSession = marking && markWorkspace
  // A plugin's workspace marks with the same tools, in a colour of its own —
  // and may keep a marking shown with the gestures stood down.
  const pluginMarkColor = plugin?.marking?.color ?? null
  const pluginGestures = plugin?.marking?.gestures ?? false
  // The third session that marks is the split-screen picker's, and it marks the
  // same mask through a viewport of its own. So the main one stands aside
  // entirely while it is open: disarming here would rub the selection out
  // (setPaintBrush(null) clears it), and zeroing the tally would have the panel
  // contradict what is on the part.
  const picking = useDeviation((s) => s.picking)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || picking) return
    if (!paintSession && !markSession && pluginMarkColor === null) {
      scene.setPaintBrush(null)
      if (useMark.getState().count !== 0) useMark.getState().setCount(0)
      return
    }
    scene.setPaintBrush({
      color: paintSession ? draftColor : (pluginMarkColor ?? MARK_COLOR),
      diameter: brushDiameter,
      erase: markErase,
      gesture: pluginMarkColor !== null && !pluginGestures ? null : markGesture,
      backfaces: markBackfaces,
    })
  }, [
    picking,
    paintSession,
    markSession,
    pluginMarkColor,
    pluginGestures,
    draftColor,
    brushDiameter,
    markErase,
    markGesture,
    markBackfaces,
  ])

  // Inverting is asked for in a panel and done here — unless the split-screen
  // picker is open, which turns the same mask through its own viewport. The
  // scene only turns a marking a session has armed, and reports the result
  // like a gesture's, so the panel that asked hears it the usual way.
  useEffect(
    () =>
      useMark.subscribe((s, prev) => {
        if (s.inverts === prev.inverts || useDeviation.getState().picking) return
        sceneRef.current?.invertPaint()
      }),
    [sceneRef],
  )

  // How the scan is drawn, from the menu of its key on the view bar: which
  // way the surface faces, shown on the surface itself; see-through, unless
  // the workspace on screen holds that switch and ghosts the scan its own
  // way; and its mesh.
  const showBackfaces = useStore((s) => s.showBackfaces)
  useEffect(() => {
    sceneRef.current?.setBackfaceTint(showBackfaces)
  }, [showBackfaces])
  const translucent = useStore((s) => s.translucent)
  const ownSeeThrough = Boolean(plugin?.scanKey?.seeThrough)
  useEffect(() => {
    sceneRef.current?.setScanSeeThrough(translucent && !ownSeeThrough)
  }, [translucent, ownSeeThrough])
  const wireframe = useStore((s) => s.wireframe)
  useEffect(() => {
    sceneRef.current?.setScanMesh(wireframe)
  }, [wireframe])
  const showScanColors = useStore((s) => s.showScanColors)
  useEffect(() => {
    sceneRef.current?.setScanColors(showScanColors)
  }, [showScanColors])
  // And the reference, from its own key's.
  const nominalSeeThrough = useDeviation((s) => s.nominalSeeThrough)
  const nominalMesh = useDeviation((s) => s.nominalMesh)
  const nominalBackfaces = useDeviation((s) => s.nominalBackfaces)
  useEffect(() => {
    const scene = sceneRef.current
    scene?.setReferenceSeeThrough(nominalSeeThrough)
    scene?.setReferenceMesh(nominalMesh)
    scene?.setReferenceBackfaceTint(nominalBackfaces)
  }, [nominalSeeThrough, nominalMesh, nominalBackfaces])

  // Keep viewport overlays in sync with the elements and the dimensions the
  // user created between them.
  const elements = useStore((s) => s.elements)
  const dimensions = useStore((s) => s.dimensions)
  const sections = useStore((s) => s.sections)
  // A tolerance on a plane reads the plane's surface: when that arrives or
  // moves, its pin is out of date though nothing in the store has changed.
  const surfaceVersion = useSurfaces((s) => s.version)
  // Elements and their dimensions are results of the measure workspace and
  // belong to it: a fitted sphere sitting on a deviation map is a second set
  // of colours over a reading, and its label competes with the map's own
  // figures. They stay measured — leaving the workspace only puts them away,
  // and coming back shows them again without re-fitting.
  //
  // The exception is measuring the deviation to an element. There an element is
  // the zero of the scale, and a map with no sign of what it was measured from
  // cannot be read at all — so *every* element the map could be measured
  // against is drawn, because choosing between them is the job at hand and it
  // is done by clicking one of them on the part. The one in use is outlined and
  // the rest are faded bodies on offer.
  const elementsWorkspace = useShell((s) => s.workspace === 'elements')
  // A plugin's workspace may show the measured elements and sections too, as
  // the datums it works against — without the readings, which are the
  // measure workspace's.
  const showElements = elementsWorkspace || Boolean(plugin?.showsElements)
  // In the measure workspace the view bar's Elements key puts everything
  // measured away at once — the elements, the dimensions between them, their
  // tints on the scan and the sections — each one's own eye left as it is.
  const elementsKeyHides = useStore((s) => s.elementsHidden) && elementsWorkspace
  const offeredElements = useDeviation((s) => s.source === 'element' && s.showElement)
  const candidates = markWorkspace && offeredElements
  const targetId = useDeviation((s) => s.targetId)
  // The colour plot is off: the part is meant to be bare — its shape, its
  // holes, the marks a finish left. An element body lies exactly on the surface
  // it was fitted to, so a shell there is a tint on the very surface that was
  // asked for, and it reads as one. Every element drops to its outline instead,
  // which says where they are without colouring anything. Their centre pins
  // stay, so one can still be chosen by clicking it on the part.
  const mapOff = useDeviation((s) => !s.showMap)
  const bareSurface = markWorkspace && mapOff
  const draft = useStore((s) => s.draft)
  const dimDraft = useStore((s) => s.dimDraft)
  const alignDraft = useStore((s) => s.alignDraft)
  const sectionDraft = useStore((s) => s.sectionDraft)
  // Elements referenced by the dimension, construction, alignment or section
  // being built read as selected in the viewport, however they were chosen.
  const highlightIds = [
    ...(dimDraft?.refs ?? []),
    ...(draft?.refs ?? []),
    ...(alignDraft ? [alignDraft.primary, alignDraft.secondary, alignDraft.origin] : []),
    sectionDraft?.ref ?? null,
  ].filter((r): r is number => typeof r === 'number')
  const highlightKey = highlightIds.join(',')
  // What is open in an editor is drawn as the pending preview instead of as
  // itself, so the old geometry does not sit inside the new one.
  const editingElementId = draft?.editId
  const editingDimensionId = dimDraft?.editId
  // The pins' figures are written in the units shown.
  const units = useUnits()
  useEffect(() => {
    const items: OverlayElement[] = elements
      .filter((e) =>
        showElements
          ? e.fit && e.visible && e.id !== editingElementId
          : // Only the kinds a deviation can be measured against: a point or a
            // line is not on offer here, so drawing it would invite a click
            // that cannot be answered.
            candidates && e.visible && isDeviationTarget(e.fit),
      )
      // Drawn at whatever length or size it was extended to, and at its
      // assumed diameter — the fit itself stays the measured surface, and
      // everything that reports a number goes on reading that. For the
      // element a map is measured against, that drawn length is also exactly
      // the region the map covers.
      .map((e) => ({ e, fit: drawnFit(e.fit!, e.assumed, e.extend) }))
      .map(({ e, fit }) => ({
        id: e.id,
        name: e.name,
        color: e.color,
        fit,
        // The figure on its pin, in the units shown.
        value: pinValue(fit, units),
        // On bare scan every element is a body. Over a map the one being
        // measured against is reduced to its border, and the others stay bodies
        // so there is something to aim a click at — until the map itself is
        // switched off, when the point is to see the surface and every body
        // gets out of the way.
        style:
          showElements || (e.id !== targetId && !bareSurface)
            ? ('shell' as const)
            : ('outline' as const),
        muted: !showElements && e.id !== targetId,
      }))
    // Distances draw as a line between their two anchor points, angles as an
    // arc at their hinge.
    const rows = evaluateDimensions(
      dimensions.filter((d) => d.visible !== false && d.id !== editingDimensionId),
      dimensionRefsOf(elements, sections),
      surfaceSource,
      units,
    ).filter((r) => !r.value.invalid)
    const verdictOf = (r: EvaluatedDimension) => ({
      notes: pinNotes(r),
      over: r.verdict ? !r.verdict.pass : false,
    })
    const pairs: OverlayPair[] = rows
      .filter((r) => r.value.segment)
      .map((r) => ({
        a: r.value.segment![0],
        b: r.value.segment![1],
        title: r.dim.name,
        value: r.value.value!,
        ...verdictOf(r),
      }))
    const angles: OverlayAngle[] = rows
      .filter((r) => r.value.arc)
      .map((r) => ({
        ...r.value.arc!,
        title: r.dim.name,
        value: r.value.value!,
        ...verdictOf(r),
      }))
    // A reading with neither — a diameter, a tolerance — pins beside the
    // feature it is about, floated off it the way the feature's own tag is.
    const tags: OverlayTag[] = rows.flatMap((r) => {
      if (r.value.segment || r.value.arc || !r.value.anchor) return []
      const feature = elements.find((e) => e.id === r.dim.refs[0])
      if (!feature?.fit) return []
      return [
        {
          at: r.value.anchor,
          fit: drawnFit(feature.fit, feature.assumed, feature.extend),
          title: r.dim.name,
          value: r.value.value!,
          ...verdictOf(r),
        },
      ]
    })
    // Dimensions are the measure workspace's alone: a distance between two
    // elements has nothing to say about a map, and its leader lines would cross
    // the reading.
    sceneRef.current?.updateOverlays(
      items,
      elementsWorkspace ? pairs : [],
      elementsWorkspace ? angles : [],
      elementsWorkspace ? tags : [],
      (showElements || items.length > 0) && !elementsKeyHides,
    )
    // A hidden element's surface tint goes with its overlay — and outside the
    // measure workspace that is every element, so the scan is bare underneath
    // whichever map is being read. Ownership stays recorded either way, so
    // this is a repaint on the way back, not a re-fit.
    // The element being edited goes with them: its surface is about to be
    // re-chosen, and its old tint underneath the new one would only be read as
    // part of it.
    // A plugin's workspace shows the elements as datums, and nothing of the
    // surfaces they were fitted to.
    sceneRef.current?.setHiddenRegions(
      (elementsWorkspace && !elementsKeyHides
        ? elements.filter((e) => !e.visible || e.id === editingElementId)
        : elements
      ).map((e) => e.id),
    )
    // Overlays were rebuilt, so the selection glow has to be re-applied.
    sceneRef.current?.setHighlightedElements(highlightIds)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [
    elements,
    dimensions,
    sections,
    surfaceVersion,
    elementsWorkspace,
    showElements,
    elementsKeyHides,
    candidates,
    targetId,
    bareSurface,
    editingElementId,
    editingDimensionId,
    units,
  ])

  useEffect(() => {
    sceneRef.current?.setHighlightedElements(highlightIds)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [highlightKey])

  // The sections, drawn on the part in the measure workspace like the
  // elements — and put away with them elsewhere. The one open for editing is
  // drawn by its preview instead.
  const editingSectionId = sectionDraft?.editId
  // What was measured on each section's sheet comes with it, stood up in its
  // plane — read off the flat store wherever the sheet is, on the 2D stage or
  // stashed behind another subject. The stage's element list changes on every
  // edit there, the stash only when a sheet is swapped or a project loaded.
  const flatSubject = useFlat((s) => s.subject)
  const flatElements = useFlat((s) => s.elements)
  const flatSheets = useFlat((s) => s.sheets)
  useEffect(() => {
    const flat = { subject: flatSubject, elements: flatElements, sheets: flatSheets }
    sceneRef.current?.setSections(
      sections
        .filter((sec) => sec.visible && sec.cut && sec.id !== editingSectionId)
        .map((sec) => ({
          id: sec.id,
          name: sec.name,
          color: sec.color,
          frame: sec.frame,
          cut: sec.cut!,
          elements: sectionElementsOf(flat, sec.id)
            .filter((el) => el.visible && el.fit)
            .map((el) => liftFlatFit(sec.frame, el.fit!)),
          ...(isExtruded(sec) ? { extrude: true } : {}),
        })),
      showElements && !elementsKeyHides,
    )
  }, [sections, editingSectionId, showElements, elementsKeyHides, flatSubject, flatElements, flatSheets])

  // The name tags and readouts, the measure workspace's own switch: off, the
  // bodies, the cuts and the callout lines stay and only the text goes.
  // Elsewhere every label is left alone — the pinned readings of a map are
  // labels too, and that workspace has no key for them.
  const showLabels = useStore((s) => s.showLabels)
  useEffect(() => {
    sceneRef.current?.setLabelsVisible(!elementsWorkspace || showLabels)
  }, [elementsWorkspace, showLabels])

  // The section being made: its plane through the part, the cut so far, and
  // the grip that slides it. The cut lags the plane by one worker round trip
  // while the grip is dragged, and is shown as it stands until the fresh one
  // lands — see sectionCuts.
  const sectionFrame = sectionDraft?.frame ?? null
  const sectionCut = sectionDraft?.cut ?? null
  const sectionColor = useStore(sectionDraftColorOf)
  const sectionBlock = sectionDraft !== null && isExtruded(sectionDraft)
  // A shadow's plane is not slid: it is drawn in the middle of the part.
  const sectionSlides = !isShadow(sectionDraft)
  useEffect(() => {
    sceneRef.current?.setSectionPreview(sectionFrame, sectionCut, sectionColor, sectionBlock, sectionSlides)
  }, [sectionFrame, sectionCut, sectionColor, sectionBlock, sectionSlides])

  // The section view: every part on the stage cut open at its plane, with
  // the gizmo that slides and tilts it — which a section being made takes
  // while it is open.
  const viewOn = useSectionView((s) => s.on)
  const viewAxis = useSectionView((s) => s.axis)
  const viewOffset = useSectionView((s) => s.offset)
  const viewFlipped = useSectionView((s) => s.flipped)
  useEffect(() => {
    const frames = sectionViewFrames({ on: viewOn, axis: viewAxis, offset: viewOffset, flipped: viewFlipped })
    sceneRef.current?.setSectionView(frames?.cut ?? null, frames?.gizmo ?? null)
  }, [viewOn, viewAxis, viewOffset, viewFlipped])
  // Its plane lies in the scan's frame: a datum alignment baked into the
  // scan — or undone — carries it along, and another scan puts it away.
  const scanName = useStore((s) => s.fileName)
  useEffect(() => {
    useSectionView.getState().close()
  }, [scanName])
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.appliedAlignment === prev.appliedAlignment || s.fileName !== prev.fileName) return
        const from = prev.appliedAlignment ?? identityRigid()
        const to = s.appliedAlignment ?? identityRigid()
        useSectionView.getState().move(rigidCompose(to, rigidInvert(from)))
      }),
    [],
  )

  // The coordinate planes on offer while the section has nothing to cut
  // across yet, through the part's centre — the very point choosing one puts
  // the plane through, so what was clicked is what is cut.
  const modelCenter = useStore((s) => s.modelCenter)
  const offerWorldPlanes = elementsWorkspace && sectionDraft !== null && sectionDraft.axis === null
  useEffect(() => {
    sceneRef.current?.setWorldPlanes(offerWorldPlanes ? modelCenter : null)
  }, [offerWorldPlanes, modelCenter])

  // Points picked for the alignment stay marked on the part, numbered in the
  // order they were clicked so the count is readable at a glance. A multi-point
  // pick draft (a circle) marks its points the same way — with several clicks
  // going into one element, seeing which have landed is half the workflow.
  //
  // So does a fit: the click that grew the region is the one thing about a
  // fitted element that leaves no trace of itself otherwise. Marked, it is
  // clear which spots the surface came from, that a second click landed where
  // it was meant to, and — when the element is re-opened — where the first pass
  // took it from. Only while the draft is open: once the element exists, its
  // own tint and pin are what say where it is.
  //
  // A picked *point* is excluded: its ghost already sits on the spot, and a
  // marker on top of it would only be a second dot on the same place.
  const draftMode = draft ? creationMethod(draft.kind, draft.method).mode : null
  const pickDraftPoints =
    draft && (draftMode === 'fit' || (draftMode === 'pick' && draft.kind !== 'point'))
      ? draft.pickPoints
      : null
  useEffect(() => {
    sceneRef.current?.setPickMarkers(
      alignDraft
        ? [
            ...alignDraft.primaryPicks.map((p, i) => ({
              point: p,
              label: `Plane ${i + 1}`,
              color: '#1877c0',
            })),
            ...alignDraft.secondaryPicks.map((p, i) => ({
              point: p,
              label: `Axis ${i + 1}`,
              color: '#e8590c',
            })),
            ...alignDraft.originPicks.map((p) => ({
              point: p,
              label: 'Zero',
              color: '#2e7d46',
            })),
          ]
        : (pickDraftPoints ?? []).map((p, i) => ({
            point: p,
            label: `${i + 1}`,
            color: draftColor,
          })),
    )
  }, [alignDraft, pickDraftPoints, draftColor])

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
  const centerOf = useStore(alignCenterOf)
  useEffect(() => {
    // Before anything is picked, a first alignment already centres the part on
    // the datum stage — the "here is where your part is going" opening move.
    // The computed preview then takes over and keeps the same centring rule.
    const rigid = alignDraft
      ? (alignmentPreview(alignDraft, elements, modelSize, centerOf).preview?.rigid ??
        (centerOf ? translationToOrigin(centerOf) : null))
      : null
    sceneRef.current?.setAlignPreview(rigid ? rigidToColumnMajor(rigid) : null)
  }, [alignDraft, elements, modelSize, centerOf])

  // The scan-to-reference best fit is a pose on the scan's group: the reference
  // stays put and the scan is carried onto it, taking the map and any elements
  // measured in the other workspace along with it.
  const align = useDeviation((s) => s.align)
  const source = useDeviation((s) => s.source)
  // Measuring against an element is measuring in the scan's own frame — the
  // element was fitted there. So the pose comes off the scene for the
  // duration, or the element would sit somewhere the part no longer is.
  //
  // A datum alignment is set up in that frame too: its preview is a second
  // matrix on the same group, and the datum stage it is aimed at is the world
  // axes. Left underneath, the pose would carry the levelled part off the
  // stage, and the re-framing on apply would look where the pose had it rather
  // than where it lands once the fit is cleared — the part came out "totally
  // off" the first time and right the second, when there was no pose left.
  // This runs ahead of the stage below, so the stage is framed around the
  // part where it stands for the alignment, not where the pose had it.
  const shownAlign = source === 'element' || alignDraft !== null ? null : align
  useEffect(() => {
    sceneRef.current?.setAlignment(shownAlign ? rigidToColumnMajor(shownAlign.transform) : null)
  }, [shownAlign])

  // The datum stage — the coordinate planes and origin axes the part is being
  // aligned onto — stands exactly as long as the alignment editor is open.
  // Opening frames the stage and the part together; closing re-frames the part
  // alone, in the stage's reading pose if an alignment is in effect (the part
  // was just placed) and in the plain broadside pose otherwise.
  const alignOpen = alignDraft !== null
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setDatumStage(alignOpen)
    if (!alignOpen) {
      if (useStore.getState().appliedAlignment) scene.frameAligned()
      else scene.frameAll()
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [alignOpen])

  // A viewport click selects elements whenever a dimension is being assembled
  // or a construction has reference slots — but never while clicks are picking
  // scan points for a fit.
  // While an alignment slot is collecting points, clicks must land on the raw
  // surface even where an element's region is painted — so element picking
  // stands down for the duration.
  //
  // Measuring the deviation to an element it is on the whole time: the elements
  // on offer are drawn on the part and clicking one is how it is chosen. Only
  // they are clickable — the one already in use is an outline, which picking
  // does not resolve through, so a click on the surface it covers still pins a
  // reading off the map. Bare scan does too: the element regions are hidden
  // outside the measure workspace, and a hidden region owns no clicks.
  const wantsElementPicks =
    candidates ||
    (elementsWorkspace &&
      (((dimDraft !== null ||
        sectionDraft !== null ||
        (alignDraft !== null && alignDraft.pickSlot === null)) &&
        draft === null) ||
        (draft !== null && creationMethod(draft.kind, draft.method).mode === 'construct')))
  useEffect(() => {
    sceneRef.current?.setElementPickEnabled(wantsElementPicks)
  }, [wantsElementPicks])
  // A section being made lights the element under the cursor, as it lights
  // the coordinate planes on offer: either is what a click would cut along.
  const sectionLights = elementsWorkspace && sectionDraft !== null && draft === null
  useEffect(() => {
    sceneRef.current?.setElementHoverLights(sectionLights)
  }, [sectionLights])
  // A dimension takes a section as the plane it was cut on, and so does a
  // construction's plane slot, so the cuts on the part are on offer too — a
  // tolerance reads a surface, and keeps to the elements.
  const wantsSectionPicks =
    elementsWorkspace &&
    (draft === null
      ? dimDraft !== null && dimensionTypeInfo(dimDraft.type).family === 'dimension'
      : draft.pickSlot == null &&
        creationMethod(draft.kind, draft.method).slots.some((sl) => sl.role === 'plane'))
  useEffect(() => {
    sceneRef.current?.setSectionPickEnabled(wantsSectionPicks)
  }, [wantsSectionPicks])
  // A point slot waiting for a click on the scan takes a point element too —
  // a sphere's centre, a point measured before. Only those are clickable
  // then; a click on any other element goes through it to the scan, where
  // it picks a new point.
  const pointSlot =
    elementsWorkspace && draft !== null && draft.pickSlot != null
      ? creationMethod(draft.kind, draft.method).slots[draft.pickSlot] ?? null
      : null
  const draftEditId = draft?.editId
  const pointOffers = useMemo(
    () =>
      pointSlot
        ? new Set(
            providersFor([pointSlot.role], elements, blockedRefs(draftEditId, elements), pointSlot.kinds).map(
              (e) => e.id,
            ),
          )
        : null,
    [pointSlot, elements, draftEditId],
  )
  useEffect(() => {
    sceneRef.current?.setElementPickOnly(pointOffers)
  }, [pointOffers])

  // Re-colour the scan whenever the map or the way it is read changes. This is
  // ~700k vertices of work, but it is a few milliseconds and it keeps the
  // scale controls immediate — a slider that had to wait on the worker would
  // feel like a different instrument.
  const workspace = useShell((s) => s.workspace)
  const mapVersion = useDeviation((s) => s.mapVersion)
  const elementVersion = useDeviation((s) => s.elementVersion)
  const range = useDeviation((s) => s.range)
  const maxDistance = useDeviation((s) => s.maxDistance)
  const bands = useDeviation((s) => s.bands)
  const tolerance = useDeviation((s) => s.tolerance)
  const thickVersion = useThickness((s) => s.mapVersion)
  const thickLimit = useThickness((s) => s.limit)
  // The scale of the map that is not on screen must not repaint the one that
  // is: dialling a thickness limit while a deviation map is up (or the other
  // way round) is a change to a reading nobody is looking at. Switching
  // workspaces re-runs both effects anyway, so gating on the workspace loses
  // nothing.
  const thickScaleShown = workspace === 'thickness' ? thickScale : null
  // A plugin's workspace paints its own map, when it has one.
  const pluginFieldVersion = plugin?.fieldVersion
  // The map on the reference: which surface the map is read on, and the
  // finer reference it is painted on, put on the stage as each lands.
  const mapOn = useDeviation((s) => s.mapOn)
  const referenceVersion = useDeviation((s) => s.referenceVersion)
  const referenceReady = useDeviation((s) => s.referenceStatus === 'ready')
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const map = referenceReady ? referenceMap.current : null
    scene.setReferenceMap(map)
  }, [referenceVersion, referenceReady])
  // The deviation as volumes: its regions on the stage while the
  // workspace measures against a reference, one lit from the panel's list.
  const volume = useDeviation((s) => s.volume)
  const showVolume = useDeviation((s) => s.showVolume)
  const volumeHover = useDeviation((s) => s.volumeHover)
  useEffect(() => {
    sceneRef.current?.setVolumeRegions(volume)
  }, [volume])
  useEffect(() => {
    sceneRef.current?.setVolumeVisible(workspace === 'deviation' && source === 'reference' && showVolume && volume !== null)
  }, [workspace, source, showVolume, volume])
  useEffect(() => {
    sceneRef.current?.highlightVolumeRegion(volumeHover)
  }, [volumeHover, volume])
  const pluginRef = useRef(plugin)
  pluginRef.current = plugin
  /** Whichever map this workspace is showing: its values, and the scale they
   *  are read through. The maps differ only in that scale and in the figures
   *  that go under it — the two deviation maps not even in that, since a
   *  deviation from a reference part and a deviation from an element are the
   *  same signed millimetres read the same way. */
  const shownField = () => {
    if (workspace === 'deviation' && source === 'reference' && mapOn === 'reference') {
      const values = referenceMap.current?.values
      if (!values) return null
      return { values, rgb: referenceRgb, scale: referenceScale(range, maxDistance, bands), onReference: true }
    }
    if (workspace === 'deviation') {
      const values = source === 'element' ? elementField.current : deviation.current
      if (!values) return null
      return {
        values,
        rgb: source === 'element' ? elementRgb : deviationRgb,
        scale: deviationScale(range, maxDistance, bands),
      }
    }
    if (workspace === 'thickness' && thickness.current) {
      return { values: thickness.current, rgb: thicknessRgb, scale: thickScale }
    }
    return pluginRef.current?.field ?? null
  }
  // The colour plot can be switched off to look at the bare scan surface — its
  // shape, its holes, the marks a finish leaves — with the map still measured
  // underneath. Everything read off it goes on reading it: the figures under the
  // scale, the hover label and the pins are unaffected, which is why this gates
  // the paint below and not shownField itself.
  const showMap = useDeviation((s) => s.showMap)
  // Whatever the map, it is painted in the ramp chosen in the settings.
  const colormap = usePrefs((s) => s.colormap)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Colour the scan from whichever map this workspace is showing — or the
    // reference, when the map is read on it, the scan left bare.
    const showing = workspace === 'deviation' && !showMap ? null : shownField()
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
    paintField(values, scale, colormapById(colormap), rgb)
    if ('onReference' in showing) {
      scene.setFieldColors(null)
      scene.setReferenceMapColors(rgb)
    } else scene.setFieldColors(rgb)
  }, [
    workspace,
    source,
    mapOn,
    referenceVersion,
    mapVersion,
    elementVersion,
    range,
    maxDistance,
    bands,
    showMap,
    colormap,
    thickVersion,
    thickScaleShown,
    pluginFieldVersion,
  ])

  // The figures under the legend, separately from the paint: the tolerance and
  // the thin-wall limit only move a tally, so changing them must not repaint
  // 700k vertices that look exactly the same afterwards.
  const toleranceRead = workspace === 'deviation' ? tolerance : null
  const thickLimitRead = workspace === 'thickness' ? thickLimit : null
  useEffect(() => {
    // A plugin's map brings its own figures; nothing here adds to them.
    const showing = workspace === 'deviation' || workspace === 'thickness' ? shownField() : null
    if (!showing) return
    const { values, scale } = showing
    const histogram = fieldHistogram(values, scale.low, scale.high, scale.validMin, scale.validMax)
    if (workspace === 'deviation') {
      useDeviation.getState().setReadout(deviationStats(values, maxDistance, tolerance), histogram)
    } else {
      useThickness.getState().setReadout(thicknessStats(values, thickLimit), histogram)
    }
  }, [
    workspace,
    source,
    mapVersion,
    elementVersion,
    range,
    maxDistance,
    bands,
    toleranceRead,
    mapOn,
    referenceVersion,
    thickVersion,
    thickScaleShown,
    thickLimitRead,
  ])

  const showNominal = useDeviation((s) => s.showNominal)
  const nominalName = useDeviation((s) => s.nominalName)
  // Loaded, not merely named: the store records the name the moment the read
  // starts, and the scene has no reference mesh to show until it finishes.
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const nominalReady = Boolean(nominalName) && !nominalBusy
  // Both models are on screen as soon as both are loaded. The reference is a
  // ghost while the scan is there to be seen through it, and turns solid when
  // the scan is switched off — which is how it is checked to be the right part,
  // since an aligned reference otherwise sits inside a scan of the same shape
  // and loses the depth test everywhere.
  const showScan = useDeviation((s) => s.showScan)
  // Side by side, the reference has a viewport of its own — so it comes out of
  // this one. Two parts in one frame is exactly what the split view undoes.
  const split = useDeviation((s) => s.split)
  // A plugin's workspace may put the scan away, for something of its own
  // that stands in its place. Elsewhere the view bar's Scan key does —
  // unless the workspace holds that key itself.
  const pluginHidesScan = Boolean(plugin?.hideScan)
  const scanKeyHides = useStore((s) => s.scanHidden) && !plugin?.scanKey?.shown
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    // Measuring against an element there is no reference part in the question at
    // all, so one that happens to be loaded stays off the stage.
    const onDev = workspace === 'deviation' && source === 'reference'
    // Read on the reference, the map is drawn in the reference's place.
    const mapOnReference = onDev && mapOn === 'reference' && referenceReady && showMap && nominalReady && showNominal && !split
    scene.setReferenceMapVisible(mapOnReference)
    scene.setNominalVisible(onDev && nominalReady && showNominal && !split && !mapOnReference)
    scene.setNominalGhost(!onDev || showScan)
    scene.setScanVisible(workspace === 'deviation' ? showScan : !pluginHidesScan && !scanKeyHides)
  }, [workspace, source, showNominal, showScan, nominalReady, split, pluginHidesScan, scanKeyHides, mapOn, referenceReady, referenceVersion, showMap])

  // Which mouse buttons orbit, pan and zoom. Held in the store rather than the
  // scene so the settings dialog can show it and remember it.
  const navScheme = useStore((s) => s.navScheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  // Parallel or perspective, for the same reason.
  const projection = useStore((s) => s.projection)
  useEffect(() => {
    sceneRef.current?.setProjection(projection)
  }, [projection])

  // What the part is made of and how it is lit, held in the store for the same
  // reasons: the settings dialog shows it and remembers it. The stage behind
  // the part follows the chassis, light or dark.
  const viewTheme = useStore((s) => s.viewTheme)
  const dark = usePrefs((s) => s.dark)
  useEffect(() => {
    sceneRef.current?.setViewTheme(sceneTheme(viewTheme, dark))
  }, [viewTheme, dark])

  // How heavy the section cuts are drawn — the operator's, like the scheme.
  const sectionLines = usePrefs((s) => s.sectionLines)
  useEffect(() => {
    sceneRef.current?.setSectionLineWidth(sectionLines)
  }, [sectionLines])

  // Pins belong to the map they were taken off, and only that map: a thickness
  // in millimetres and a deviation in millimetres look identical on the part,
  // so showing both at once would be a way to misread one of them. Each pin
  // says which it is on top, for the same reason.
  const probes = useDeviation((s) => s.probes)
  const thickProbes = useThickness((s) => s.probes)
  useEffect(() => {
    const shown =
      workspace === 'deviation'
        ? probes.map((p) => ({ ...p, title: 'DEV', label: `${formatSigned(p.value, units)} ${unitWord(units)}` }))
        : workspace === 'thickness'
          ? thickProbes.map((p) => ({ ...p, title: 'WALL', label: fmtLen(p.value, units, 3) }))
          : []
    sceneRef.current?.setProbes(
      shown.map((p) => ({ id: p.id, point: p.point, title: p.title, label: p.label })),
    )
  }, [workspace, probes, thickProbes, units])

  // Whether the pins on the far side of the part are put away or show through
  // it — the operator's, like the line widths, and kept across sessions.
  const hidePinsBehind = usePrefs((s) => s.hidePinsBehind)
  useEffect(() => {
    sceneRef.current?.setProbeOcclusion(hidePinsBehind)
  }, [hidePinsBehind])

  // A half-finished element fit or alignment has no meaning in the other
  // workspaces.
  useEffect(() => {
    // A marking session belongs to the workspace and source it was opened in —
    // the local fine fit's surface in reference mode, the measured region in
    // element mode. Whichever it was, changing either closes the tools and
    // clears the paint layer; the element map's chosen region itself survives
    // in its snapshot and stays measured.
    if (useDeviation.getState().marking) {
      sceneRef.current?.clearPaint()
      useDeviation.getState().stopMarking()
    }
    // Both workspaces mark with the same tools, so a gesture picked in one must
    // not still be holding the mouse when the other opens. Within a workspace
    // the choice sticks: whoever marked the last element with a lasso means to
    // mark the next one with it too.
    useMark.getState().reset()
    if (workspace === 'elements') return
    if (useStore.getState().draft) cancelDraft()
    if (useStore.getState().alignDraft) useStore.getState().cancelAlignment()
    if (useStore.getState().sectionDraft) useStore.getState().cancelSection()
    // Runs on the listed dependencies only, not on everything it reads.
  }, [workspace, source])

  // While the split picker is up the main viewport is hidden behind it; stop
  // rendering it rather than paying for a 1.4-million-triangle frame nobody
  // can see. The mesh and its BVH stay loaded. (`picking` is read further up,
  // where the marking layer also has to stand aside for it.)
  useEffect(() => {
    sceneRef.current?.setPaused(picking)
  }, [picking])

  // Hover testing only earns its frame when there is a map to read.
  const hasDeviationMap = useDeviation((s) =>
    s.source === 'element' ? s.elementStatus === 'ready' : s.mapStatus === 'ready',
  )
  const hasThicknessMap = useThickness((s) => s.status === 'ready')
  const hasMap =
    (workspace === 'deviation' && hasDeviationMap) ||
    (workspace === 'thickness' && hasThicknessMap) ||
    Boolean(plugin?.hoverReadout) ||
    Boolean(plugin?.hovers)
  useEffect(() => {
    sceneRef.current?.setHoverEnabled(hasMap && !picking)
  }, [hasMap, picking])

  // The deviation map played as motion — see core/deviation/deflection.ts.
  // Only while the scan is on screen to be watched, and never under the
  // marking tools or the picker: both work on the scan where it is.
  const animate = useDeviation((s) => s.animate)
  const animScale = useDeviation((s) => s.animScale)
  const playing = workspace === 'deviation' && animate && hasDeviationMap && showScan && !marking && !picking
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const showing = playing ? shownField() : null
    const directions = showing ? fieldDirections.get(showing.values) : undefined
    if (!showing || !directions) {
      scene.setDeflection(null)
      return
    }
    // The motion goes as far as the end of the colour scale, and is averaged
    // over the space around each point — a pass over the whole scan, a moment
    // on a large one. So it is put off until whatever moved has come to rest:
    // a range dragged along its slider is one new motion, not one per step,
    // and the loop plays the last one meanwhile.
    const timer = setTimeout(() => {
      // The scale first, so a loop that is starting starts from the scan as
      // it is on screen rather than wherever the old scale put it.
      const dev = useDeviation.getState()
      if (dev.animScaleAuto) dev.suggestAnimScale(suggestDeflectionScale(range, 2 * modelSize))
      scene.setDeflectionScale(useDeviation.getState().animScale)
      scene.setDeflection(
        deflectionVectors(showing.values, directions, {
          limit: range,
          maxDistance,
          positions: scene.scanPositions(),
          smoothing: DEFLECTION_SMOOTHING * 2 * modelSize,
        }),
      )
    }, DEFLECTION_SETTLE_MS)
    return () => clearTimeout(timer)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [playing, source, mapVersion, elementVersion, range, maxDistance, modelSize])
  useEffect(() => {
    sceneRef.current?.setDeflectionScale(animScale)
  }, [animScale])
}
