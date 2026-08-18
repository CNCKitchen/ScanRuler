// SPDX-License-Identifier: AGPL-3.0-only
// Everything the scene is told after a render: the draft's ghost and grips,
// the marking brush, overlays and highlights, the alignment previews, and the
// colouring of whichever map the workspace is showing. The stores hold the
// truth; these effects repeat it to the viewport.
import { useEffect, useMemo } from 'react'
import { creationMethod } from '../core/elements/construct'
import { translationToOrigin } from '../core/alignment'
import { isDeviationTarget } from '../core/deviation/elementField'
import { applyExtension, isExtendable } from '../core/elements/extend'
import { evaluateDimensions } from '../core/dimensions'
import {
  alignCenterOf,
  alignmentPreview,
  draftColorOf,
  useStore,
} from '../state/store'
import type {
  SceneManager,
  OverlayAngle,
  OverlayElement,
  OverlayPair,
} from '../viewer/SceneManager'
import { schemeById } from '../viewer/navSchemes'
import { themeById } from '../viewer/viewThemes'
import { formatSigned } from '../ui/format'
import { MARK_COLOR, useDeviation } from '../state/deviationStore'
import { useMark } from '../state/markStore'
import { useThickness } from '../state/thicknessStore'
import { paintField, type FieldScale } from '../core/field/colormap'
import { fieldHistogram } from '../core/field/stats'
import { deviationScale, deviationStats } from '../core/deviation/deviation'
import { thicknessStats } from '../core/thickness/thickness'
import { rigidToColumnMajor } from '../core/deviation/rigid'
import type { RefObject } from 'react'

export function useSceneSync({
  sceneRef,
  deviation,
  deviationRgb,
  elementField,
  elementRgb,
  thickness,
  thicknessRgb,
  thickScale,
  cancelDraft,
}: {
  sceneRef: RefObject<SceneManager | null>
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  /** The deviation from a fitted element, held beside the one from a reference
   *  part so switching between them loses neither. */
  elementField: RefObject<Float32Array | null>
  elementRgb: RefObject<Uint8Array | null>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
  /** Held stable across renders by App, because it is what tells the repaint
   *  below whether anything actually changed. */
  thickScale: FieldScale
  /** Close a half-finished element draft, preview and marking included. */
  cancelDraft: () => void
}) {
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
  //
  // The exception is measuring the deviation to an element. There an element is
  // the zero of the scale, and a map with no sign of what it was measured from
  // cannot be read at all — so *every* element the map could be measured
  // against is drawn, because choosing between them is the job at hand and it
  // is done by clicking one of them on the part. The one in use is outlined and
  // the rest are faded bodies on offer.
  const elementsWorkspace = useDeviation((s) => s.workspace === 'elements')
  const candidates = useDeviation(
    (s) => s.workspace === 'deviation' && s.source === 'element' && s.showElement,
  )
  const targetId = useDeviation((s) => s.targetId)
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
      .filter((e) =>
        elementsWorkspace
          ? e.fit && e.visible && e.id !== editingElementId
          : // Only the kinds a deviation can be measured against: a point or a
            // line is not on offer here, so drawing it would invite a click
            // that cannot be answered.
            candidates && e.visible && isDeviationTarget(e.fit),
      )
      // Drawn at whatever length or size it was extended to — the fit itself
      // stays the measured surface, and everything that reports a number goes
      // on reading that. For the element a map is measured against, that drawn
      // size is also exactly the region the map covers.
      .map((e) => ({
        id: e.id,
        name: e.name,
        color: e.color,
        fit: applyExtension(e.fit!, e.extend),
        // On bare scan every element is a body. Over a map the one being
        // measured against is reduced to its border, and the others stay bodies
        // so there is something to aim a click at.
        style: elementsWorkspace || e.id !== targetId ? ('shell' as const) : ('outline' as const),
        muted: !elementsWorkspace && e.id !== targetId,
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
    // Dimensions are the measure workspace's alone: a distance between two
    // elements has nothing to say about a map, and its leader lines would cross
    // the reading.
    sceneRef.current?.updateOverlays(
      items,
      elementsWorkspace ? pairs : [],
      elementsWorkspace ? angles : [],
      elementsWorkspace ? showOverlays : items.length > 0,
    )
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
  }, [
    elements,
    dimensions,
    showOverlays,
    elementsWorkspace,
    candidates,
    targetId,
    editingElementId,
    editingDimensionId,
  ])

  useEffect(() => {
    sceneRef.current?.setHighlightedElements(highlightIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Points picked for the alignment stay marked on the part, numbered in the
  // order they were clicked so the count is readable at a glance. A multi-point
  // pick draft (a circle) marks its points the same way — with several clicks
  // going into one element, seeing which have landed is half the workflow.
  const pickDraftPoints =
    draft && creationMethod(draft.kind, draft.method).mode === 'pick' && draft.kind !== 'point'
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      (((dimDraft !== null || (alignDraft !== null && alignDraft.pickSlot === null)) &&
        draft === null) ||
        (draft !== null && creationMethod(draft.kind, draft.method).mode === 'construct')))
  useEffect(() => {
    sceneRef.current?.setElementPickEnabled(wantsElementPicks)
  }, [wantsElementPicks])

  // Re-colour the scan whenever the map or the way it is read changes. This is
  // ~700k vertices of work, but it is a few milliseconds and it keeps the
  // scale controls immediate — a slider that had to wait on the worker would
  // feel like a different instrument.
  const workspace = useDeviation((s) => s.workspace)
  const mapVersion = useDeviation((s) => s.mapVersion)
  const source = useDeviation((s) => s.source)
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
  /** Whichever map this workspace is showing: its values, and the scale they
   *  are read through. The maps differ only in that scale and in the figures
   *  that go under it — the two deviation maps not even in that, since a
   *  deviation from a reference part and a deviation from an element are the
   *  same signed millimetres read the same way. */
  const shownField = () => {
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
    return null
  }
  // The colour plot can be switched off to look at the bare scan surface — its
  // shape, its holes, the marks a finish leaves — with the map still measured
  // underneath. Everything read off it goes on reading it: the figures under the
  // scale, the hover label and the pins are unaffected, which is why this gates
  // the paint below and not shownField itself.
  const showMap = useDeviation((s) => s.showMap)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Colour the scan from whichever map this workspace is showing.
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
    paintField(values, scale, rgb)
    scene.setFieldColors(rgb)
  }, [
    workspace,
    source,
    mapVersion,
    elementVersion,
    range,
    maxDistance,
    bands,
    showMap,
    thickVersion,
    thickScaleShown,
  ])

  // The figures under the legend, separately from the paint: the tolerance and
  // the thin-wall limit only move a tally, so changing them must not repaint
  // 700k vertices that look exactly the same afterwards.
  const toleranceRead = workspace === 'deviation' ? tolerance : null
  const thickLimitRead = workspace === 'thickness' ? thickLimit : null
  useEffect(() => {
    const showing = shownField()
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
    thickVersion,
    thickScaleShown,
    thickLimitRead,
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
  // Measuring against an element is measuring in the scan's own frame — the
  // element was fitted there. So the scan-to-reference pose comes off the scene
  // for the duration, or the element would sit somewhere the part no longer is.
  const shownAlign = source === 'element' ? null : align
  useEffect(() => {
    sceneRef.current?.setAlignment(shownAlign ? rigidToColumnMajor(shownAlign.transform) : null)
  }, [shownAlign])
  // Both models are on screen as soon as both are loaded. The reference is a
  // ghost while the scan is there to be seen through it, and turns solid when
  // the scan is switched off — which is how you check it is the right part,
  // since an aligned reference otherwise sits inside a scan of the same shape
  // and loses the depth test everywhere.
  const showScan = useDeviation((s) => s.showScan)
  // Side by side, the reference has a viewport of its own — so it comes out of
  // this one. Two parts in one frame is exactly what the split view undoes.
  const split = useDeviation((s) => s.split)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    // Measuring against an element there is no reference part in the question at
    // all, so one that happens to be loaded stays off the stage.
    const onDev = workspace === 'deviation' && source === 'reference'
    scene.setNominalVisible(onDev && nominalReady && showNominal && !split)
    scene.setNominalGhost(!onDev || showScan)
    scene.setScanVisible(workspace !== 'deviation' || showScan)
  }, [workspace, source, showNominal, showScan, nominalReady, split])

  // Which mouse buttons orbit, pan and zoom. Held in the store rather than the
  // scene so the status strip can show it and remember it.
  const navScheme = useStore((s) => s.navScheme)
  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  // What the part is made of and how it is lit, held in the store for the same
  // reasons: the status strip shows it and remembers it.
  const viewTheme = useStore((s) => s.viewTheme)
  useEffect(() => {
    sceneRef.current?.setViewTheme(themeById(viewTheme))
  }, [viewTheme])

  // Pins belong to the map they were taken off, and only that map: a thickness
  // in millimetres and a deviation in millimetres look identical on the part,
  // so showing both at once would be a way to misread one of them.
  const probes = useDeviation((s) => s.probes)
  const thickProbes = useThickness((s) => s.probes)
  useEffect(() => {
    const shown =
      workspace === 'deviation'
        ? probes.map((p) => ({ ...p, label: `${formatSigned(p.value)} mm` }))
        : workspace === 'thickness'
          ? thickProbes.map((p) => ({ ...p, label: `${p.value.toFixed(3)} mm` }))
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
    // marking that no longer exists would offer a fit of nothing. Switching to
    // an element counts as leaving: there is no alignment there to fine-fit.
    if ((workspace !== 'deviation' || source === 'element') && useDeviation.getState().marking) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, source])

  // While the split picker is up the main viewport is hidden behind it; stop
  // rendering it rather than paying for a 1.4-million-triangle frame nobody
  // can see. The mesh and its BVH stay loaded.
  const picking = useDeviation((s) => s.picking)
  useEffect(() => {
    sceneRef.current?.setPaused(picking)
  }, [picking])

  // Hover testing only earns its frame when there is a map to read.
  const hasDeviationMap = useDeviation((s) =>
    s.source === 'element' ? s.elementStatus === 'ready' : s.mapStatus === 'ready',
  )
  const hasThicknessMap = useThickness((s) => s.status === 'ready')
  const hasMap =
    (workspace === 'deviation' && hasDeviationMap) || (workspace === 'thickness' && hasThicknessMap)
  useEffect(() => {
    sceneRef.current?.setHoverEnabled(hasMap && !picking)
  }, [hasMap, picking])
}
