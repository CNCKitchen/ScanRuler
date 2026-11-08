// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's part in the app, for one render: the CAD
// kernel's worker, the feature build and the bodies on the part (useReverseWorkspace),
// the 2D sheet laid over the viewport for a sketch, the clicks on the scan,
// on elements, on sketches and on bodies, the manipulators' drags, and what
// the workspace puts on the stage — see src/plugins/api.ts.

import { reSceneOf } from '../viewer/reScene'
import { useEffect, useRef } from 'react'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { dimensionKind } from '../core/parameters'
import { isDimension } from '../core/sketch'
import { gripSlotPath } from '../state/reStore'
import { useShell } from '../../../src/state/shellStore'
import { useMark } from '../../../src/state/markStore'
import { useDeviation } from '../../../src/state/deviationStore'
import { builtAlignment } from '../../../src/core/deviation/align'
import { curvatureScale } from '../../../src/core/geometry/curvature'
import type { Vec2 } from '../../../src/core/flat/types'
import { MapLegend } from '../../../src/ui/MapLegend'
import { Icon, type IconName } from '../../../src/ui/icons'
import { anyChanged, PartChoice, PartKey, PartOption, type ViewSwitch } from '../../../src/ui/PartKey'
import { KeyIcon } from '../ui/reIcons'
import { formatSigned } from '../../../src/ui/format'
import { usePrefs } from '../../../src/state/prefsStore'
import { useLength } from '../../../src/app/useUnits'
import { fmtLen, lengthDecimals, MM_PER_INCH, type DisplayUnits } from '../../../src/core/units'
import type { FieldScale } from '../../../src/core/field/colormap'
import type { GripSide, PickHit } from '../../../src/viewer/SceneManager'
import { isFeatureSide } from '../core/preview'
import { VIEW_MESH_MAP_SPACING } from '../core/compare'
import { useReverseWorkspace } from './useReverseWorkspace'
import { useSketchSceneSync } from './useSketchSceneSync'
import { bodyColor, chainArcStart, reEditorOpen, snapFaceOf, useReverse } from '../state/reStore'
import { useRePrefs } from '../state/rePrefs'
import type { TangentEdges } from '../core/edgeLines'
import { installCompareInDeviation, reverseSession } from './reSession'
import { NO_PICK } from '../core/bodyFolders'
import { liveMapScale } from '../core/liveMap'
import { snapFitKind, snapReading } from '../core/snapFace'
import { ReversePanel } from '../ui/ReversePanel'
import { PlaybackCaption } from '../ui/Playback'
import { BuildChip } from '../ui/BuildChip'
import { stopPlayback } from './playback'
import { SketchViewer } from '../ui/SketchViewer'
import type { FlatScene } from '../../../src/viewer/FlatScene'
import { useNotes } from '../state/noteStore'
import { pinNoteOnBody, useNotePins, useNotesOn } from './useNotePins'
import { useNetworkLayer } from './useNetworkLayer'
import { readField } from '../ui/reLength'

/** A scale held per millimetre — a deviation in millimetres, a curvature
 *  per millimetre — as the legend shows it, in the units shown: `power` 1
 *  for a length, -1 for a curvature. The legend reads its figures, and
 *  takes a range typed at either end, off the scale it is given. */
function scaleShown(scale: FieldScale, units: DisplayUnits, power: 1 | -1): FieldScale {
  if (units === 'mm') return scale
  const k = power === 1 ? 1 / MM_PER_INCH : MM_PER_INCH
  return { ...scale, low: scale.low * k, high: scale.high * k, validMin: scale.validMin * k, validMax: scale.validMax * k }
}

/** A deviation already in the units shown, signed, to the decimals a
 *  deviation is read to there. */
const signedShown = (units: DisplayUnits) => (units === 'mm' ? formatSigned : (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(lengthDecimals(3, units))}`)

/** The three ways of drawing the tangent edges, in the Bodies key's menu. */
const NEVER_DRAWN = 'A round face\'s seam and the cut a join leaves across one surface are never drawn'
const TANGENT_EDGE_CHOICES: readonly { id: TangentEdges; label: string; title: string }[] = [
  { id: 'visible', label: 'Drawn', title: 'Tangent edges drawn — where a round runs into a flat — as the sharp ones are, the way CAD draws them' },
  { id: 'dimmed', label: 'Dimmed', title: 'Tangent edges dimmed' },
  { id: 'removed', label: 'Off', title: 'Tangent edges left out, and not picked: a round shows by its outline against the background' },
]

/** What of the part lies under a sketch: none of it, the bare sheet; the
 *  part cut open at the plane; or the whole part. */
type SketchPartView = 'none' | 'cut' | 'full'
const SKETCH_PART_VIEWS: readonly { id: SketchPartView; icon: IconName; label: string; title: string }[] = [
  { id: 'none', icon: 'eyeOff', label: 'No part', title: 'The sketch on the bare stage, the 3D view under it put away' },
  { id: 'cut', icon: 'slice', label: 'Section', title: 'The part under the sketch, facing the sketch plane and following the sheet\'s pan and zoom, cut open at the plane where the plane runs through it — the half toward you taken away, so the slice being drawn on is the face in view' },
  { id: 'full', icon: 'model', label: 'Full part', title: 'The whole part under the sketch, facing the sketch plane and following the sheet\'s pan and zoom, nothing cut away' },
]

export function useReversePlugin(host: PluginHost): PluginRuntime {
  const { sceneRef, clientRef } = host

  // The CAD kernel's worker, the feature build, the bodies on the part — and
  // the 2D sheet borrowed for a sketch.
  const sketchSceneRef = useRef<FlatScene | null>(null)
  const reverse = useReverseWorkspace({ sceneRef, clientRef, sheetRef: sketchSceneRef })
  // A drag on the sketch sheet is solved once per frame, at the hand's
  // latest spot: a solve takes tens of milliseconds on a sketch of a real
  // part, and the pointer reports faster than that — solving every report
  // would queue them up and the piece would trail the hand in jerks.
  const sketchDragPending = useRef<{ p: Vec2; meta: { raw: boolean; unitsPerScreenPx: number } } | null>(null)
  const sketchDragFrame = useRef(0)
  /** The Line tool's press on the chain's last end, being dragged into a
   *  tangent arc: where the hand last was, or null when no arc is in it. */
  const sketchArcDrag = useRef<{ p: Vec2; meta: { raw: boolean; unitsPerScreenPx: number } } | 'pressed' | null>(null)
  const flushSketchDrag = () => {
    const d = sketchDragPending.current
    sketchDragPending.current = null
    if (d) useReverse.getState().sketchDrag(d.p, 8 * d.meta.unitsPerScreenPx, sketchSync.snapFor(d.meta.raw))
  }
  const sketchSync = useSketchSceneSync({
    sceneRef: sketchSceneRef,
    chainsOf: reverse.chainsOf,
    projectablesOf: reverse.projectablesOf,
    // The 3D viewport under the sheet follows it: face on to the sketch
    // plane, the same point under the centre, the same millimetres per
    // pixel — with a swing round to the plane when the sheet is first laid.
    onView: (centre, unitsPerScreenPx, animate) => {
      const d = useReverse.getState().sketchDraft
      if (d) sceneRef.current?.followSheet(d.frame, centre, unitsPerScreenPx, animate ? 500 : 0)
    },
  })
  // The notes for an agent pinned on the part, while the connection is on.
  useNotePins(sceneRef)
  useNetworkLayer(sceneRef)
  const sketchOpen = useReverse((s) => s.sketchDraft !== null)
  const sketchModelShown = useReverse((s) => s.sketchModelShown)
  const featureCount = useReverse((s) => s.features.length + s.rolledBack.length)
  const onReverse = useShell((s) => s.workspace === 'reverse')
  const fileName = useStore((s) => s.fileName)
  // A playback is for this workspace's viewport: leaving it ends the
  // playback, the rollback bar back where it stood. A Patch network's box
  // is closed too, as its Cancel does: its layer is drawn in the viewport
  // every workspace shares, and would go on taking clicks there.
  useEffect(() => {
    if (onReverse) return
    const r = useReverse.getState()
    if (r.playback) stopPlayback()
    if (r.featureDraft?.kind === 'network') r.cancelFeature()
  }, [onReverse])

  /** Compare in Deviation: the workspace's visible bodies become the
   *  reference part, under the identity — they were built on this scan, in
   *  its frame, and a best fit would hide the very offset the comparison is
   *  for — and the map is measured at once. */
  const compareInDeviation = async (bodyIds?: number[]) => {
    const made = await reverse.compareReference(bodyIds)
    if (!made) throw new Error(useStore.getState().errorText ?? 'There is nothing to compare.')
    const { file, mapMesh } = made
    const nominalVersion = clientRef.current!.nominalVersion
    // Built here, in millimetres: no units to ask about. Made from the
    // bodies, not opened by the person: the search distance the last
    // comparison was read under stands, and the reference goes with the
    // scan when another is opened.
    // units-ok: the units the reference file is written in, not a word on screen.
    await host.openReference(file, 'mm', { fromSession: true })
    if (clientRef.current!.nominalVersion === nominalVersion || useDeviation.getState().nominalName !== file.name) throw new Error('The bodies could not be opened as the reference part.')
    // The map on the bodies reads their viewport meshes at the spacings
    // those are fine enough for (core/compare VIEW_MESH_MAP_SPACING): the
    // same map, from fewer readings. Set for this reference only.
    clientRef.current!.setReferenceMapMesh(mapMesh, VIEW_MESH_MAP_SPACING)
    useDeviation.getState().setSource('reference')
    useDeviation.getState().resolveAlign(builtAlignment())
    useShell.getState().setWorkspace('deviation')
    await host.runDeviation()
    useStore.getState().setStatus('The scan measured against the bodies from Reverse engineer, in the scan’s own frame — no best fit was run.')
  }
  // The commands run the same action — reverse.body.compare_in_deviation.
  const compareInDeviationRef = useRef(compareInDeviation)
  compareInDeviationRef.current = compareInDeviation
  useEffect(() => installCompareInDeviation((ids) => compareInDeviationRef.current(ids)), [])

  /** A click on the scan with an editor open that asks for one. A bare
   *  click starts nothing: a sketch that opened under a click meant to look
   *  at the part was a mode nobody asked for. A sketch is begun from the
   *  panel, on a plane chosen there, or from a body's face through its
   *  chips. */
  const pickSeq = useRef(0)
  const pick = async (hit: PickHit) => {
    const store = useStore.getState()
    const re = useReverse.getState()
    if (!store.fileName || store.busy || !clientRef.current) return
    // A Fit Surface gathers its region by clicks: the face under the click,
    // flooded by normal angle, into the region — or out of it with Ctrl.
    if (re.featureDraft?.kind === 'surface') {
      if (useMark.getState().gesture !== null) return
      const d = re.featureDraft
      try {
        const vertices = await clientRef.current.flood(hit.vertices[0], d.floodDeg)
        const now = useReverse.getState().featureDraft
        if (!now || now.kind !== 'surface') return
        useReverse.getState().addToRegion(vertices, hit.ctrlKey)
        store.setStatus(`${vertices.length.toLocaleString('en-US')} points ${hit.ctrlKey ? 'taken out of' : 'added to'} the region — ${useReverse.getState().featureDraft?.kind === 'surface' ? (useReverse.getState().featureDraft as { region: Uint32Array }).region.length.toLocaleString('en-US') : ''} in all. Click more of the scan, or Create.`)
      } catch (e) {
        store.setError(`The flood failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    // A face being snapped onto the scan: the click says where it should
    // lie. The element the face is — a plane, a cylinder — is fitted there
    // and the move read off it; the box shows the ghost and the number.
    if (re.featureDraft?.kind === 'moveFace') {
      const d = re.featureDraft
      const one = snapFaceOf(d)
      const kind = one ? snapFitKind(one.fingerprint) : null
      if (!d.snap || !one || !kind) {
        store.setStatus(d.faces.length === 0 ? 'Click the faces of the body to move — flat or round ones.' : d.faces.length > 1 ? 'Type how far the faces move, or drag the arrow. The scan is read for one face at a time.' : 'Type how far the face moves — or take Snap to scan in the box and click the scan where it should lie.')
        return
      }
      const face = one
      const seq = ++pickSeq.current
      re.setFeatureDraft({ fitting: true, error: null })
      try {
        const result = await clientRef.current.fit(kind, [...hit.vertices], store.settings)
        const now = useReverse.getState().featureDraft
        if (seq !== pickSeq.current || !now || snapFaceOf(now) !== face) return
        const reading = snapReading(face.fingerprint, result)
        if (typeof reading === 'string') useReverse.getState().setFeatureDraft({ fitting: false, error: reading })
        else {
          useReverse.getState().setFeatureDraft({ fitting: false, error: null, reading, offset: Math.round(reading.offset * 1000) / 1000 })
          store.setStatus(`The face moves ${reading.offset >= 0 ? 'out' : 'in'} by ${fmtLen(Math.abs(reading.offset), usePrefs.getState().units)} onto the scan${reading.draft ? `, which leans ${reading.draft.angleDeg.toFixed(2)}° to it — tick “Draft it as well” in the box to lean the face too` : ''} — Create, or click the scan again.`)
        }
      } catch (e) {
        if (seq === pickSeq.current) useReverse.getState().setFeatureDraft({ fitting: false, error: `No ${kind} fits where you clicked: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
  }

  /** A click on a measured element: into a hole, an extract or a revolve
   *  being set up — or, with no editor open, a selection, and the chips by
   *  it offer what it can do. */
  const elementPick = (id: number, clientX: number, clientY: number) => {
    const store = useStore.getState()
    const el = store.elements.find((e) => e.id === id)
    if (!el?.fit) return
    const re = useReverse.getState()
    // A hole takes an element with an axis; an extract takes one with a
    // volume.
    if (re.featureDraft?.kind === 'hole') {
      const k = el.fit.kind
      if (k === 'cylinder' || k === 'circle') re.setFeatureDraft({ axis: { kind: 'element', id }, radius: el.fit.radius })
      else if (k === 'line') re.setFeatureDraft({ axis: { kind: 'element', id } })
      else store.setStatus(`${el.name} has no axis to drill along — pick a cylinder, a circle or a line.`)
      return
    }
    if (re.featureDraft?.kind === 'extract') {
      const k = el.fit.kind
      if (k === 'plane' || k === 'cylinder' || k === 'cone' || k === 'sphere' || k === 'torus') re.setFeatureDraft({ element: id, section: null })
      else store.setStatus(`${el.name} has no volume to make a body of — pick a plane, a cylinder, a cone or a sphere.`)
      return
    }
    if (!re.revolveDraft) {
      if (!reEditorOpen(re)) re.setSelection({ kind: 'element', id, name: el.name, at: { x: clientX, y: clientY } })
      return
    }
    const k = el.fit.kind
    if (k === 'line' || k === 'cylinder' || k === 'cone' || k === 'circle') re.setRevolve({ axis: { kind: 'element', id } })
    else store.setStatus(`${el.name} has no axis to revolve about — pick a line, a cylinder, a cone or a circle.`)
  }

  /** A Fit Surface's region, marked with the tools: the marking is the
   *  region, stroke by stroke. */
  const paintChange = (): boolean => {
    if (useReverse.getState().featureDraft?.kind !== 'surface') return false
    reverse.regionPainted(sceneRef.current?.paintedVertices() ?? new Uint32Array(0))
    return true
  }

  // A feature's manipulator — the arrows on an extrude, the ring on a
  // revolve (see state/reStore). A mouse reports several moves a frame and
  // each one is a store change the panel and the ghost follow: only the last
  // of a frame is worth making, and the end of the drag makes it before it
  // ends.
  const gripMove = useRef<{ side: GripSide; delta: number } | null>(null)
  const gripFrame = useRef(0)
  const flushGrip = () => {
    const m = gripMove.current
    gripMove.current = null
    if (m && isFeatureSide(m.side)) useReverse.getState().gripDrag(m.side, m.delta, 'move')
  }
  const gripDrag = (side: GripSide, delta: number, phase: 'start' | 'move' | 'end'): boolean => {
    if (!isFeatureSide(side)) return false
    if (phase === 'move') {
      gripMove.current = { side, delta }
      if (!gripFrame.current) {
        gripFrame.current = requestAnimationFrame(() => {
          gripFrame.current = 0
          flushGrip()
        })
      }
      return true
    }
    if (gripFrame.current) {
      cancelAnimationFrame(gripFrame.current)
      gripFrame.current = 0
    }
    flushGrip()
    useReverse.getState().gripDrag(side, delta, phase)
    return true
  }

  // The viewport's picks of the workspace's own things: the sketches' regions
  // and lines, the bodies' faces, edges and corners, a window over the
  // bodies, a point on the part for an extrude, a coordinate plane, the
  // selection put away, and the number typed on a feature grip.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    reSceneOf(scene).onSketchRegionPick = (hit, x, y) => {
      const re = useReverse.getState()
      if (reEditorOpen(re)) re.toggleDraftRegion(hit.sketchId, hit.key)
      else re.setSelection({ kind: 'region', sketchId: hit.sketchId, key: hit.key, at: { x, y } })
    }
    reSceneOf(scene).onSketchLinePick = (hit, x, y) => {
      const re = useReverse.getState()
      if (re.revolveDraft) re.setRevolve({ sketchId: hit.sketchId, axis: { kind: 'sketchLine', entity: hit.entity } })
      else if (!reEditorOpen(re)) re.setSelection({ kind: 'sketchLine', sketchId: hit.sketchId, entity: hit.entity, at: { x, y } })
    }
    reSceneOf(scene).onBodyFacePick = (hit, x, y, additive) => {
      const re = useReverse.getState()
      if (useNotes.getState().placing) pinNoteOnBody(scene, { type: 'face', ...hit }, x, y)
      else if (re.featureDraft) {
        // A Delete face takes the whole round, hole or boss clicked.
        const d = re.featureDraft
        re.toggleDraftFace(hit.bodyId, hit.face, d.kind === 'deleteFace' ? reverseSession()?.deleteFacesAt(hit.bodyId, hit.face.hash, d.tangent) : undefined)
      }
      else if (re.extrudeDraft?.extent.kind === 'toFace') {
        // The face an extrude reaches to: a flat one as its plane, a curved
        // one as it is.
        re.setExtrude({ extent: { ...re.extrudeDraft.extent, body: hit.bodyId, face: hit.face.fingerprint } })
      } else if (!reEditorOpen(re)) re.pickBodyItem({ type: 'face', bodyId: hit.bodyId, face: hit.face, edges: hit.edges }, { x, y }, additive)
    }
    reSceneOf(scene).onBodyEdgePick = (hit, x, y, additive) => {
      const re = useReverse.getState()
      if (useNotes.getState().placing) pinNoteOnBody(scene, { type: 'edge', ...hit }, x, y)
      else if (re.featureDraft) re.toggleDraftEdge(hit.bodyId, hit.edge)
      else if (!reEditorOpen(re)) re.pickBodyItem({ type: 'edge', bodyId: hit.bodyId, edge: hit.edge }, { x, y }, additive)
    }
    reSceneOf(scene).onBodyVertexPick = (hit, x, y, additive) => {
      const re = useReverse.getState()
      if (useNotes.getState().placing) pinNoteOnBody(scene, { type: 'vertex', ...hit }, x, y)
      else if (!reEditorOpen(re)) re.pickBodyItem({ type: 'vertex', bodyId: hit.bodyId, point: hit.point }, { x, y }, additive)
    }
    reSceneOf(scene).onPartPointPick = (point) => {
      // A click on the part while an extrude is set up: the end in play goes
      // through the point.
      useStore.getState().setStatus(useReverse.getState().extrudeToPoint(point))
    }
    reSceneOf(scene).onBodyWindowPick = (hit, x, y) => {
      // A window over the bodies: into the open fillet, chamfer, shell or
      // draft — the edges or faces of the body it is on, or of the body most
      // of them lie on — or, with no editor open, into the selection.
      const re = useReverse.getState()
      const d = re.featureDraft
      const mostOn = <T extends { bodyId: number }>(items: T[]): number | null => {
        const counts = new Map<number, number>()
        for (const i of items) counts.set(i.bodyId, (counts.get(i.bodyId) ?? 0) + 1)
        let best: number | null = null
        for (const [id, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = id
        return best
      }
      if (d && (d.kind === 'fillet' || d.kind === 'chamfer')) {
        const body = d.body ?? mostOn(hit.edges)
        if (body !== null) re.addDraftEdges(body, hit.edges.filter((e) => e.bodyId === body).map((e) => e.edge))
      } else if (d && (d.kind === 'shell' || d.kind === 'draft' || d.kind === 'moveFace' || d.kind === 'deleteFace')) {
        const body = d.body ?? mostOn(hit.faces)
        if (body !== null) re.addDraftFaces(body, hit.faces.filter((f) => f.bodyId === body).map((f) => f.face))
      } else if (d?.kind === 'moveBody') {
        // Into a Move: every body the window takes anything of.
        re.setMoveBodies([...d.bodies, ...hit.faces.map((f) => f.bodyId), ...hit.edges.map((e) => e.bodyId)])
      } else if (!reEditorOpen(re)) {
        re.addBodyItems(
          [...hit.faces.map((f) => ({ type: 'face' as const, bodyId: f.bodyId, face: f.face, edges: f.edges })), ...hit.edges.map((e) => ({ type: 'edge' as const, bodyId: e.bodyId, edge: e.edge }))],
          { x, y },
        )
      }
    }
    reSceneOf(scene).onCoordinatePlanePick = (axis, x, y) => {
      const re = useReverse.getState()
      if (!reEditorOpen(re)) re.setSelection({ kind: 'coordinatePlane', axis, at: { x, y } })
    }
    reSceneOf(scene).onClickAway = () => {
      // A click on the scan or on nothing puts the selection away; a turn, a
      // pan or a zoom of the camera keeps it, as CAD does.
      if (useReverse.getState().selection) useReverse.getState().setSelection(null)
      useReverse.getState().setListSelection(NO_PICK)
    }
    reSceneOf(scene).onBodyHover = (id) => {
      // The body under the cursor lights its row in the body list; leaving
      // it lets go only of what the viewport lit — a row the pointer is on
      // in the list is the list's own.
      const re = useReverse.getState()
      if (id !== null) re.setBodyHover({ ids: [id], from: 'view' })
      else if (re.bodyHover?.from === 'view') re.setBodyHover(null)
    }
    scene.onGripFieldCommit = (side, text) => {
      if (!isFeatureSide(side)) return
      // A number, or an expression over the parameters — kept beside the
      // number under the grip's slot, as the box keeps it.
      const re = useReverse.getState()
      // An angle on a revolve's ring, a taper's arrow and a Move's rings
      // (turnX, turnY, turnZ); a length on the rest.
      // A length typed is in the units shown, as in the box's fields.
      const r = readField(text, side === 'taper' || side.startsWith('turn') ? 'angle' : 'length', re.parameterTable.scope, usePrefs.getState().units)
      if (!r.ok) {
        useStore.getState().setError(`${text}: ${r.error}`)
        return
      }
      re.setGripValue(side, r.value)
      const path = gripSlotPath(side, re)
      if (path && r.expr !== null) useReverse.getState().setDraftExpr(path, r.expr)
    }
    scene.onGripFieldClose = () => useReverse.getState().setGripField(null)
  }, [sceneRef])

  // The live map's reading and the curvature colouring, for their legends
  // beside the viewport.
  const mapReport = useReverse((s) => s.mapReport)
  const len = useLength()
  const curvature = useReverse((s) => (s.curvatureShown ? s.curvature : null))
  // A sketch takes the stage: the 2D sheet stands where the 3D viewport was.
  const sketchStage = onReverse && sketchOpen

  // The curvature colouring: a reading at every vertex, like the maps, with
  // no figures under it.
  const curvatureRgb = useRef<Uint8Array | null>(null)
  // A Fit Surface's region is marked with the app's marking tools while its
  // box asks for them — and shown in the same layer while it does not, so
  // the tools stay armed, with the gestures stood down, for the region to
  // stay drawn.
  // Two selections, each a plain value: a store's selector that built an
  // object would be a new one every time it is asked.
  const markColor = useReverse((s) =>
    s.featureDraft?.kind === 'surface' ? bodyColor(s.featureDraft.featureId ?? s.nextFeatureId) : null,
  )
  const markGestures = useReverse((s) => s.featureDraft?.kind === 'surface' && Boolean(s.featureDraft.paint))
  // The measured elements and sections, as the datums the model is built
  // against, behind a key of its own.
  const elementsShown = useReverse((s) => s.elementsShown)
  // The view bar: the scan, the bodies and the elements, each shown or put
  // away by a click and drawn as its key's menu says; the two maps at the
  // side; a sketch's model under the sheet and its slice.
  const scanHidden = useReverse((s) => s.scanHidden)
  const bodiesHidden = useReverse((s) => s.bodiesHidden)
  const scanSeeThrough = useReverse((s) => s.scanSeeThrough)
  const bodiesSeeThrough = useReverse((s) => s.bodiesSeeThrough)
  const bodyMap = useReverse((s) => s.bodyMap)
  const curvatureMap = useReverse((s) => s.curvatureMap)
  const hasBodies = useReverse((s) => s.bodies.length > 0)
  const anyBodyShown = useReverse((s) => !s.bodiesHidden && s.bodies.some((b) => b.visible))
  const sketchSliced = useReverse((s) => s.sketchSliced)
  const hasElements = useStore((s) => s.elements.length > 0 || s.sections.length > 0)
  const tangentEdges = useReverse((s) => s.tangentEdges)
  const overlapsShown = useReverse((s) => s.overlapsShown)

  const re = useReverse.getState
  // The scan's key is the app's, its click and its Transparent this
  // workspace's: the scan is put away for the bodies to be looked at on
  // their own, and is a veil over them as the workspace opens. Its menu
  // takes the curvature colouring too, a way of looking at the scan
  // alone; the Deviation key, reading the scan against the bodies, stands
  // at the side. The two put each other out.
  const curvatureSwitch: ViewSwitch = {
    on: curvatureMap,
    set: (on) => re().setCurvatureMap(on),
    disabled: fileName ? undefined : 'Load a scan first — the map reads its surface',
    normal: false,
  }
  const scanKey = {
    shown: {
      on: !scanHidden,
      set: (on: boolean) => re().setScanHidden(!on),
      disabled: !fileName
        ? 'No scan loaded'
        : hasBodies
          ? undefined
          : 'Build a body first — until then there is only the scan to look at',
    },
    seeThrough: {
      on: scanSeeThrough ?? anyBodyShown,
      set: (on: boolean) => re().setScanSeeThrough(on),
      normal: anyBodyShown,
    },
    menu: sketchStage ? undefined : (
      <PartOption
        icon={<Icon name="curvature" size={16} />}
        label="Curvature"
        testId="toggle-curvature"
        value={curvatureSwitch}
        title="Colour the scan by how sharply it bends — flats green, convex rounds towards red, hollows towards blue, sharp edges dark. Where a flat ends and a round or a blend begins is where a surface region should end. While a feature is being set up its ghost takes the map over. Puts the Deviation key's map out"
      />
    ),
    menuChanged: !sketchStage && anyChanged([curvatureSwitch]),
  }
  const notesOn = useNotesOn()
  const hasNotes = useNotes((s) => s.notes.some((n) => n.text.trim() !== ''))
  const pinsShown = useNotes((s) => s.pinsShown)
  const bodiesSolid: ViewSwitch = { on: bodiesSeeThrough, set: (on) => re().setBodiesSeeThrough(on), normal: false }
  const overlapsSwitch: ViewSwitch = { on: overlapsShown, set: (on) => re().setOverlapsShown(on), normal: true }
  const partKeys = sketchStage ? null : (
    <>
      <PartKey
        icon={<Icon name="combine" size={16} />}
        label="Bodies"
        testId="toggle-bodies"
        shown={{
          on: !bodiesHidden,
          set: (on) => re().setBodiesHidden(!on),
          disabled: hasBodies ? undefined : 'Build a body first',
        }}
        title="Show the bodies, or put them away as a whole and leave the scan to stand alone — with the deviation map still on it, read against the bodies as they are. Each body's own eye in the panel takes it out of the model and the map instead"
        changed={anyChanged([bodiesSolid, overlapsSwitch]) || tangentEdges !== 'visible'}
      >
        <PartOption
          icon={<Icon name="transparent" size={16} />}
          label="Transparent"
          testId="toggle-bodies-transparent"
          value={bodiesSolid}
          title="Draw the bodies transparent — the scan, the elements and the bodies inside them show through. With the scan solid as well, each part shows where it stands proud of the other"
        />
        <PartOption
          icon={<Icon name="opIntersect" size={16} />}
          label="Overlaps"
          testId="toggle-body-overlaps"
          value={overlapsSwitch}
          title="Draw where two bodies run into each other in hatched red — what they share, over the faces of both that would otherwise fight for the same pixels. Off for bodies that overlap on purpose, a modifier volume for a slicer; saved with the project"
        />
        <PartChoice
          icon={<KeyIcon name="tangentEdges" size={16} />}
          label="Tangent edges"
          testId="tangent-edges"
          value={tangentEdges}
          options={TANGENT_EDGE_CHOICES}
          onChange={(mode) => re().setTangentEdges(mode)}
          title={`How the edges are drawn where a round runs into a flat. ${NEVER_DRAWN}`}
        />
      </PartKey>
      <PartKey
        icon={<Icon name="elCylinder" size={16} />}
        label="Elements"
        testId="toggle-elements"
        shown={{
          on: elementsShown,
          set: (on) => re().setElementsShown(on),
          disabled: hasElements
            ? undefined
            : 'Nothing measured yet — fit elements or cut sections in the 3D Measure workspace and they show here',
        }}
        title="Show the elements and sections measured in the 3D Measure workspace on the part — the planes, cylinders and cuts the model is built against"
      />
      {notesOn && hasNotes && (
        <PartKey
          icon={<KeyIcon name="note" size={16} />}
          label="Notes"
          testId="toggle-notes"
          shown={{ on: pinsShown, set: (on) => useNotes.getState().setPinsShown(on) }}
          title="Show the notes' pins on the part, or put them away. The notes stay, and the agent still reads them. Pinning or opening a note brings the pins back"
        />
      )}
    </>
  )
  const sketchPartView: SketchPartView = !sketchModelShown ? 'none' : sketchSliced ? 'cut' : 'full'
  const viewKeys = sketchStage ? (
    <div className="keys" role="radiogroup" aria-label="What of the part lies under the sketch">
      {SKETCH_PART_VIEWS.map((v) => (
        <button
          key={v.id}
          role="radio"
          aria-checked={sketchPartView === v.id}
          className={sketchPartView === v.id ? 'on' : undefined}
          data-test={`sketch-part-${v.id}`}
          onClick={() => {
            re().setSketchModelShown(v.id !== 'none')
            if (v.id !== 'none') re().setSketchSliced(v.id === 'cut')
          }}
          title={v.title}
        >
          <Icon name={v.icon} size={16} />
          {v.label}
        </button>
      ))}
    </div>
  ) : (
    // The scan read against the bodies. The curvature colouring is in the
    // Scan key's menu; the two put each other out.
    <div className="keys">
      <button
        className={bodyMap ? 'on' : undefined}
        data-test="toggle-body-map"
        aria-pressed={bodyMap}
        disabled={!hasBodies}
        onClick={() => re().setBodyMap(!bodyMap)}
        title={
          hasBodies
            ? 'Colour the scan by how far it lies from the bodies, on the deviation colour map at the range set in the feature boxes — outside the bodies up the ramp, inside down it — and violet where the scan lies deep inside them: a hole, a pocket or a slot the bodies lack. While a feature is being set up its ghost takes the map over. Puts the curvature colouring out'
            : 'Build a body first — the map reads the scan against it'
        }
      >
        <Icon name="compare" size={16} />
        Deviation
      </button>
    </div>
  )

  return {
    canSave: featureCount > 0,
    field: curvature ? { values: curvature.values, rgb: curvatureRgb, scale: curvatureScale(curvature.range) } : null,
    fieldVersion: curvature,
    marking: markColor !== null ? { color: markColor, gestures: markGestures } : null,
    showsElements: elementsShown,
    hideScan: scanHidden,
    scanKey,
    partKeys,
    viewKeys,
    // Not with the sheet alone on the stage: the models' keys have nothing
    // to act on.
    hideModelKeys: sketchStage && !sketchModelShown,
    gripDrag,
    pick: (hit) => void pick(hit),
    elementPick,
    paintChange,
    hideViewport: sketchStage && !sketchModelShown,
    // No front door: with no scan the workspace opens on a blank stage, as
    // plain CAD, and a scan is loaded from the panel or dropped on the stage.
    startPane: null,
    panel: (
      <ReversePanel
        onOpenScan={(f) => void host.openScan(f)}
        onExportStep={() => void reverse.exportStep()}
        onExportMesh={(format) => void reverse.exportMesh(format)}
        onCompare={() => void compareInDeviation().catch(() => {})}
        chainsOf={reverse.chainsOf}
      />
    ),
    // The sketch editor's sheet, mounted while a sketch is open — the 2D
    // Measure viewport's scene, laid with the slice of the sketch plane, as
    // a see-through layer over the 3D viewport, whose camera follows it: the
    // sketch is drawn on the part, the way CAD draws it. The view bar's Model
    // key puts the part away under it.
    stage: sketchStage && (
      <div className="viewslot sketch">
        <SketchViewer
          onReady={sketchSync.onReady}
          onViewChange={sketchSync.onViewChange}
          onPick={(p, meta) => {
            const re = useReverse.getState()
            // The Project tool's click is on the part under the sheet: the
            // edge or the piece of another sketch nearest it comes into this
            // sketch, fixed where it lands.
            if (re.sketchDraft?.tool === 'project') {
              const found = sketchSync.projectableAt(p, 8 * meta.unitsPerScreenPx)
              if (found) {
                re.projectInto([found.entity])
                useStore.getState().setStatus(`Projected ${found.source} into the sketch — fixed where it lies; hang relations and dimensions on it.`)
              } else useStore.getState().setStatus('Nothing to project there — click an edge of a body, or a piece of another sketch, that lies flat to this plane or square to it.')
              return
            }
            re.sketchClick(p, 8 * meta.unitsPerScreenPx, meta.shift ?? false, sketchSync.snapFor(meta.raw))
          }}
          onHover={(p, unitsPerScreenPx, raw) => sketchSync.onHover(p, 8 * unitsPerScreenPx, raw)}
          onDragStart={(p, meta) => {
            const re = useReverse.getState()
            // The Line tool's press on the end it would carry on from: let go
            // there it is a click, which ends the chain; held and dragged it
            // swings a tangent arc out of the end.
            if (chainArcStart(re.sketchDraft, p, 8 * meta.unitsPerScreenPx)) {
              sketchArcDrag.current = 'pressed'
              return true
            }
            sketchArcDrag.current = null
            return re.sketchDragStart(p, 8 * meta.unitsPerScreenPx)
          }}
          onDrag={(p, meta) => {
            if (sketchArcDrag.current) {
              sketchArcDrag.current = { p, meta }
              sketchSync.onArcDrag(p, 8 * meta.unitsPerScreenPx, meta.raw)
              return
            }
            sketchDragPending.current = { p, meta }
            if (sketchDragFrame.current) return
            sketchDragFrame.current = requestAnimationFrame(() => {
              sketchDragFrame.current = 0
              flushSketchDrag()
            })
          }}
          onDragEnd={() => {
            const swung = sketchArcDrag.current
            if (swung) {
              sketchArcDrag.current = null
              sketchSync.onArcDrag(null, 0, false)
              if (swung !== 'pressed') useReverse.getState().sketchTangentArc(swung.p, 8 * swung.meta.unitsPerScreenPx, sketchSync.snapFor(swung.meta.raw))
              return
            }
            if (sketchDragFrame.current) {
              cancelAnimationFrame(sketchDragFrame.current)
              sketchDragFrame.current = 0
            }
            flushSketchDrag()
            useReverse.getState().sketchDragEnd()
          }}
          onNoteSelect={(id) => useReverse.getState().selectConstraint(id)}
          onDimensionEdit={(id, text) => {
            // The label's text: a number, or an expression kept beside it.
            const re = useReverse.getState()
            const c = re.sketchDraft?.sketch.constraints.find((x) => x.id === id)
            if (!c || !isDimension(c)) return
            // A length typed is in the units shown, as in the box's fields.
            const units = usePrefs.getState().units
            const r = readField(text, dimensionKind(c.kind), re.parameterTable.scope, units)
            // A round piece's number typed with its letter — Ø12 over an R,
            // R6 over a Ø — gives the piece that way; only where the text is
            // no expression as it stands, so a parameter named d1 is still one.
            const lettered = !r.ok && (c.kind === 'radius' || c.kind === 'diameter') ? /^\s*(Ø|⌀|R|D)\s*(.+)$/i.exec(text) : null
            if (lettered) {
              const rest = readField(lettered[2], 'length', re.parameterTable.scope, units)
              if (rest.ok) {
                const form = /^r$/i.test(lettered[1]) ? 'radius' : 'diameter'
                const expr = rest.expr
                if (form === c.kind) re.setDimensionValue(id, rest.value, expr)
                else re.setDimensionForm(id, form, rest.value, expr)
                return
              }
            }
            if (!r.ok) {
              useStore.getState().setError(`${text}: ${r.error}`)
              return
            }
            re.setDimensionValue(id, r.value, r.expr)
          }}
          onDimensionMove={(id, p, begin) => useReverse.getState().moveDimension(id, p, begin)}
        />
      </div>
    ),
    overlay: (
      <>
        {mapReport && (
          <MapLegend
            id="re-map"
            unit={len.word()}
            scale={scaleShown(liveMapScale(mapReport.range), len.units, 1)}
            stats={[
              { label: 'within', value: `${mapReport.within.toLocaleString()} / ${mapReport.points.toLocaleString()}`, wide: true },
              { label: 'against', value: mapReport.source === 'ghost' ? 'the ghost' : 'the bodies' },
              // The scan deep inside the bodies — violet on the map — is a
              // hole or a pocket the bodies lack, which no ramp would show.
              ...(mapReport.farInside > 0 ? [{ label: 'deep inside (violet)', value: mapReport.farInside.toLocaleString(), wide: true }] : []),
            ]}
            format={signedShown(len.units)}
            histogram={null}
            showHistogram={false}
            zeroAt={0}
            ends={{ high: 'scan outside the body', low: 'scan inside the body' }}
            // Either end retyped sets the range: the ramp stays symmetric
            // about zero, so 0.5 at the top or the bottom reads ±0.5.
            // The figure typed is in the units shown.
            onLimit={(_end, v) => useRePrefs.getState().setLiveMapRange(len.fromDisplay(v))}
          />
        )}
        {!mapReport && curvature && (
          <MapLegend
            id="re-curvature"
            unit={`1/${len.word()}`}
            scale={scaleShown(curvatureScale(curvature.range), len.units, -1)}
            // A curvature is hard to picture and a radius is not: the ends of
            // the scale as the cylinder that bends that much.
            stats={[{ label: 'full colour at', value: `R ${len.fmt(1 / (2 * curvature.range), 1)}`, wide: true }]}
            format={(v) => v.toFixed(3)}
            histogram={null}
            showHistogram={false}
            zeroAt={0}
            ends={{ high: 'convex — a round', low: 'concave — a hollow' }}
          />
        )}
        {!sketchStage && <PlaybackCaption />}
        {!sketchStage && <BuildChip />}
        {!sketchStage && fileName && featureCount === 0 && (
          <div className="hintchip" data-test="reverse-ready-chip">
            Part loaded — choose a plane in the panel to sketch on
          </div>
        )}
      </>
    ),
  }
}
