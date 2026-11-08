// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's plumbing: the kernel brought up when the
// workspace is first entered, the slice chains a sketch is drawn over, the
// bodies the rebuild after every change to the feature list makes pushed
// into the 3D viewport, the sketches drawn on the part with their regions
// on offer to the feature being set up, that feature's ghost and grips, and
// the STEP export. The store (state/reStore) holds what the panel reads;
// the kernel, the build and the body meshes are the workspace's session
// (reSession.ts), which the commands work through too; this hook draws them
// and does the rest of the asynchronous work.

import { reSceneOf } from '../viewer/reScene'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { EDGE_MIN_FEATURE_MM, type EdgeChains } from '../../../src/core/flat/edges'
import type { Vec2 } from '../../../src/core/flat/types'
import type { Vec3 } from '../../../src/core/types'
import { rigidApply, rigidCompose, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'
import type { KernelMesh } from '../core/kernel'
import type { EdgeInfo, FaceInfo, PreviewStep } from '../core/build'
import { liveMapScale, paintedSparse, sparseSummary } from '../core/liveMap'
import { curvatureRange } from '../../../src/core/geometry/curvature'
import { cornerUnreadable, readCornerCut } from '../core/filletEstimate'
import { FACE_SLICE_INSET_MM, liftPoint, type Feature, type PlaneRef, type SketchFeature } from '../core/features'
import { resolveAxis, resolveFeatures, resolvePlaneFrame } from '../core/resolve'
import { chainsOfEdges } from '../core/segment'
import { imageCorners } from '../core/sketchImage'
import { edgeGrip, extrudeGrips, extrudeGripsAt, faceGrip, moveGrip, moveGrips, prismStretch, revolveGrip, taperGrip, type FeatureGrip } from '../core/preview'
import { matrix4Of, mergeMeshes, movedFaceMesh, moveMatrix } from '../core/move'
import { bodiesOfPick } from '../core/bodyFolders'
import { projectEdge, projectSketchEntity, type Projectable } from '../core/project'
import { matchEdge, matchFace, matchTolerance, splitEdges, tangentChain, transformEdgeFingerprint, transformFingerprint } from '../core/topo'
import { PreviewFailure } from '../core/reClient'
import { symmetryPlaneRef } from '../core/symmetryPlane'
import type { SymmetryPlane } from '../../../src/core/symmetry'
import { COMPARE_CHORD_MM, COMPARE_REFERENCE_NAME, compareReferenceStl, mergeMeshes as mergeCompared } from '../core/compare'
import { entityPolyline, type EntityInput, type Sketch } from '../core/sketch'
import { threadFaceReading } from '../core/thread'
import { frameKey, transformFrame, WORLD_AXES, type SectionFrame } from '../../../src/core/section/frame'
import { normalize } from '../../../src/core/vec'
import { projectCut } from '../../../src/core/section/slice'
import type { MeshWorkerClient } from '../../../src/core/workerClient'
import { colormapById } from '../../../src/core/field/colormap'
import { usePrefs } from '../../../src/state/prefsStore'
import { fmtLen, toDisplay, unitWord } from '../../../src/core/units'
import { useRePrefs } from '../state/rePrefs'
import { bodyColor, coordinatePlaneShown, featureOfDraft, gripFieldValue, historyEditOf, reEditorOpen, selectionItems, sketchesUsedBy, snapDraftOf, useReverse, type BodyPick } from '../state/reStore'
import type { NetworkData } from '../state/reTypes'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import type { FlatScene } from '../../../src/viewer/FlatScene'
import type { BodyTopology } from '../viewer/bodyPicks'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { SketchOverlayItem } from '../viewer/sketchOverlay'
import type { VaryingEdgeEnds } from '../viewer/varyingEnds'
import { sketchPalette } from '../viewer/sketchPalette'
import { saveFile } from '../../../src/app/exports'
import type { MeshFormat } from '../../../src/core/exportMesh'
import { meshResolution, tinyPartNote } from '../core/meshResolution'
import { drivenBy } from '../core/parameters'
import { onScan } from '../../../src/app/scanEvents'
import { createReverseSession, installReverseSession, meshDiagonal, stepFilesFor } from './reSession'
import { offerSolids } from '../../../src/app/solids'

/** The slice chains on the sketch plane, as points and as the flat edge
 *  chains the sheet draws. */
export interface SketchChains {
  key: string
  chains: Vec2[][]
  edges: EdgeChains
}

/** The colour a sketch is drawn in, on the part and in its row. */
const SKETCH_COLOR = '#3d8fd6'
/** The colour of a cut's ghost — what it is about to take away. */
const CUT_COLOR = '#e0564f'
/** The feature id a preview borrows: never a real one. */
const PREVIEW_ID = -1
/** How long after the last ghost the live map is asked for. A drag asks for
 *  a ghost many times a second and the map costs more than the ghost on a
 *  big scan, so the map waits for the hand to pause rather than queueing
 *  behind every ghost in the worker. */
const MAP_DEBOUNCE_MS = 120
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useReverseWorkspace({
  sceneRef,
  clientRef,
  sheetRef,
}: {
  sceneRef: RefObject<SceneManager | null>
  /** The mesh worker, for cutting the scan on a sketch plane that is not a
   *  section's. */
  clientRef: RefObject<MeshWorkerClient | null>
  /** The sheet a sketch is drawn on, for the development hook alone. */
  sheetRef?: RefObject<FlatScene | null>
}) {
  /** The workspace’s part of the viewport, once there is one. */
  const reScene = () => (sceneRef.current ? reSceneOf(sceneRef.current) : null)
  // The kernel, the build and the bodies it made — the workspace's session,
  // which the commands work through too.
  const [session] = useState(() => createReverseSession({ sceneRef }))
  useEffect(() => installReverseSession(session), [session])
  useEffect(() => session.watch(), [session])
  const meshes = session.meshes
  const topologies = session.topologies
  const chainsRef = useRef<SketchChains | null>(null)
  /** The scan's symmetry plane as last searched for, and a stamp that
   *  moves whenever the scan or its alignment does — the plane of one
   *  pose is not the plane of another. */
  const symmetryCache = useRef<SymmetryPlane | null>(null)
  /** The surface region last handed to the scene's marking layer. */
  const regionShown = useRef<Uint32Array | null>(null)
  const symmetryStamp = useRef(0)

  // ---- the kernel, when the workspace is first entered ----------------------------
  const workspace = useShell((s) => s.workspace)
  const kernelStatus = useReverse((s) => s.kernelStatus)
  useEffect(() => {
    if (workspace !== 'reverse' || kernelStatus !== 'idle') return
    // Why it could not start is on the store, for the panel.
    session.startKernel().catch(() => {})
  }, [workspace, kernelStatus, session])

  // ---- the slice chains under the sketch --------------------------------------------
  const draftPlaneKey = useReverse((s) =>
    s.sketchDraft ? `${JSON.stringify(s.sketchDraft.plane)}|${frameKey(s.sketchDraft.frame)}|${s.sketchDraft.level ?? 0}` : null,
  )
  const sectionCutKey = useReverse((s) => {
    const p = s.sketchDraft?.plane
    if (!p || p.kind !== 'section') return null
    return useStore.getState().sections.find((x) => x.id === p.id)?.cutKey ?? null
  })
  useEffect(() => {
    const draft = useReverse.getState().sketchDraft
    if (!draft) {
      chainsRef.current = null
      return
    }
    const key = draftPlaneKey!
    if (chainsRef.current?.key === key) return
    const land = (edges: EdgeChains) => {
      if (useReverse.getState().sketchDraft === null) return
      chainsRef.current = { key, chains: chainsOfEdges(edges), edges }
      useReverse.getState().setChains(chainsRef.current.chains.length, 'ready')
    }
    const plane = draft.plane
    const level = draft.level
    if (plane.kind === 'section' && level === undefined) {
      const sec = useStore.getState().sections.find((x) => x.id === plane.id)
      if (sec?.cut) land(projectCut(sec.cut, draft.frame))
      else useReverse.getState().setChains(0, sec ? 'cutting' : 'failed')
      return
    }
    // No scan on the stage — the workspace used as plain CAD: there is
    // nothing to cut, and nothing to wait for.
    if (!useStore.getState().fileName) {
      useReverse.getState().setChains(0, 'idle')
      return
    }
    // A plane element or a coordinate plane: the scan is cut there now. A
    // plane fitted on a face is cut a hair inside the face; at a level, the
    // scan is cut that far off the plane.
    useReverse.getState().setChains(0, 'cutting')
    let stale = false
    const n = draft.frame.normal
    const off = level ?? (plane.kind === 'fitted' || plane.kind === 'bodyFace' ? -FACE_SLICE_INSET_MM : 0)
    const origin: Vec3 = [draft.frame.origin[0] + n[0] * off, draft.frame.origin[1] + n[1] * off, draft.frame.origin[2] + n[2] * off]
    clientRef.current
      ?.section(origin, n, EDGE_MIN_FEATURE_MM)
      .then((cut) => {
        if (stale) return
        land(projectCut(cut, draft.frame))
      })
      .catch(() => {
        if (!stale) useReverse.getState().setChains(0, 'failed')
      })
    return () => {
      stale = true
    }
  }, [draftPlaneKey, sectionCutKey])

  // ---- a datum alignment carries the sketches with the part ------------------------
  const appliedAlignment = useStore((s) => s.appliedAlignment)
  // Move document state synchronously with the scan. A deferred effect can
  // run after history captures its after-state, or move already-restored
  // sketch frames a second time during undo.
  useEffect(() => useStore.subscribe((state, previous) => {
    const appliedAlignment = state.appliedAlignment
    const before = previous.appliedAlignment
    if (before === appliedAlignment) return
    symmetryCache.current = null
    symmetryStamp.current++
    // Both are cumulative from the scanner's frame; what moved the part
    // since is the new one after the old one is undone.
    const delta = appliedAlignment
      ? before
        ? rigidCompose(appliedAlignment, rigidInvert(before))
        : appliedAlignment
      : before
        ? rigidInvert(before)
        : null
    if (!delta) return
    const re = useReverse.getState()
    if (re.features.length + re.rolledBack.length === 0 && !re.sketchDraft && re.featureDraft?.kind !== 'network') return
    // A plane fitted on a face belongs to no element and moves with the
    // part here, as the sketch's own frame does; a body's face moves with
    // the bodies, which are rebuilt from the moved sketches, so its
    // fingerprint is carried too or the face would not be found again.
    const movePlane = (p: PlaneRef): PlaneRef =>
      p.kind === 'fitted'
        ? { ...p, frame: transformFrame(p.frame, delta) }
        : p.kind === 'bodyFace'
          ? { ...p, frame: transformFrame(p.frame, delta), face: transformFingerprint(p.face, delta) }
          : p
    // A projected piece's edge moves with the bodies too; its place on the
    // sheet does not — the sheet moves with the part.
    const moveSources = (sketch: Sketch): Sketch =>
      sketch.entities.some((e) => e.source && 'edge' in e.source)
        ? { ...sketch, entities: sketch.entities.map((e) => (e.source && 'edge' in e.source ? { ...e, source: { body: e.source.body, edge: transformEdgeFingerprint(e.source.edge, delta) } } : e)) }
        : sketch
    const moveAt = (p: Vec3): Vec3 => {
      const out = new Float64Array(3)
      rigidApply(delta, p[0], p[1], p[2], out)
      return [out[0], out[1], out[2]]
    }
    // A network's points are on the scan, in its frame: they go with it.
    const movedNetwork = <T extends NetworkData>(n: T): T => ({
      ...n,
      nodes: n.nodes.map((x) => ({ ...x, at: moveAt(x.at) })),
      curves: n.curves.map((c) => ({ ...c, via: c.via.map(moveAt) })),
      cells: n.cells.map((c) => ({ ...c, seed: moveAt(c.seed), ...(c.centre ? { centre: moveAt(c.centre) } : {}) })),
    })
    const moved = (f: Feature): Feature =>
      f.kind === 'network'
        ? movedNetwork(f)
        : f.kind === 'sketch'
        ? { ...f, frame: transformFrame(f.frame, delta), plane: movePlane(f.plane), sketch: moveSources(f.sketch) }
        : f.kind === 'cutPlane'
          ? { ...f, plane: movePlane(f.plane) }
          : f.kind === 'mirror' && f.plane.kind !== 'face'
            ? { ...f, plane: movePlane(f.plane) }
            : f.kind === 'extrude' && f.face
              ? { ...f, face: { ...f.face, face: transformFingerprint(f.face.face, delta) } }
              : f.kind === 'sweep' && f.route
                ? { ...f, route: { ...f.route, points: f.route.points.map(moveAt) } }
                : f
    useReverse.setState((s) => ({
      features: s.features.map(moved),
      // Those below the rollback bar are of the same part.
      rolledBack: s.rolledBack.map(moved),
      sketchDraft: s.sketchDraft ? { ...s.sketchDraft, frame: transformFrame(s.sketchDraft.frame, delta), plane: movePlane(s.sketchDraft.plane), sketch: moveSources(s.sketchDraft.sketch) } : null,
      ...(s.featureDraft?.kind === 'network' ? { featureDraft: { ...movedNetwork(s.featureDraft), placing: null, history: [], future: [], suggested: null } } : {}),
      buildVersion: s.buildVersion + 1,
    }))
    chainsRef.current = null
  }), [])

  // ---- a new scan starts the workspace over ----------------------------------------
  // As the scan is put in place: a project being opened puts its own
  // features in right after, which an effect on the file name would run
  // after, and take away again.
  const fileName = useStore((s) => s.fileName)
  useEffect(() => {
    let hadScan = useStore.getState().fileName !== null
    return onScan({
      loaded: (scan) => {
        const before = hadScan
        hadScan = scan !== null
        // A scan loaded onto a stage that was being modelled on with none
        // joins the model: what was drawn from a blank sheet is not the old
        // scan's to take along. Only the slices and the map read the scan,
        // and they are asked for again.
        const re = useReverse.getState()
        if (!before && scan && re.features.length + re.rolledBack.length > 0) {
          chainsRef.current = null
          useReverse.setState((s) => ({ buildVersion: s.buildVersion + 1 }))
          return
        }
        re.reset()
        symmetryCache.current = null
        symmetryStamp.current++
        session.clearBodies()
      },
    })
  }, [session])

  const resolveContext = session.resolveContext
  const regionsOf = session.regionsOf

  // The feature on a body being set up, read early: the bodies drawn on
  // the part stand in for one of them while it is edited (see below).
  const featureDraft = useReverse((s) => s.featureDraft)
  const editingOnBody = featureDraft?.featureId !== undefined && 'body' in featureDraft && featureDraft.body !== null ? { step: featureDraft.featureId, body: featureDraft.body } : null
  // ---- a feature on a body, being set up -------------------------------------------
  // What it asks the viewport for: a shell its faces, a fillet its edges,
  // a hole a round face, a mirror a flat one — on the body it works on.
  const draftPick: BodyPick | null = (() => {
    const d = featureDraft
    if (!d) return null
    const bodies = 'body' in d && d.body !== null ? [d.body] : null
    switch (d.kind) {
      case 'shell':
      case 'hole':
      case 'mirror':
      case 'draft':
      case 'deleteFace':
        return { mode: 'faces', bodies }
      // A thread's round face may be on any body: clicking one on another
      // moves the thread there.
      case 'thread':
        return { mode: 'faces', bodies: null }
      // Faces to move are clicked on their body — any body for the first;
      // snapping one onto the scan, the clicks are the scan's instead.
      case 'moveFace':
        return d.snap && d.faces.length === 1 ? null : { mode: 'faces', bodies: d.faces.length > 0 ? bodies : null }
      case 'fillet':
      case 'chamfer':
        return { mode: 'edges', bodies }
      // A patch network's curve along a body's edge: any body's edge,
      // while its curves are drawn.
      case 'network':
        return d.tool === 'draw' ? { mode: 'edges', bodies: null } : null
      // A Move takes a body by a click on any face of it, and a copy's
      // lets it go by another. Moved, the bodies picked are out of sight —
      // the ghost stands in for them where they are going — and only the
      // others are there to click and add.
      case 'moveBody':
        return { mode: 'faces', bodies: d.copy ? null : useReverse.getState().bodies.map((b) => b.id).filter((id) => !d.bodies.includes(id)) }
      default:
        return null
    }
  })()
  const draftPickKey = draftPick ? `${draftPick.mode}:${draftPick.bodies?.join(',') ?? '*'}` : null
  const toFaceExtent = useReverse((s) => (s.extrudeDraft?.extent.kind === 'toFace' ? s.extrudeDraft.extent : null))
  const pulledFace = useReverse((s) => s.extrudeDraft?.face ?? null)
  const parameterLit = useReverse((s) => s.parameterLit)
  const toFaceOpen = toFaceExtent !== null
  // An extrude by numbers takes a click on the part for one of them: the
  // end in play is put through the point clicked (reStore.extrudeToPoint).
  const extrudeTakesPoint = useReverse((s) => s.extrudeDraft?.extent.kind === 'distance' || s.extrudeDraft?.extent.kind === 'symmetric')

  // ---- the bodies on the part ----------------------------------------------------------
  const bodiesVersion = useReverse((s) => s.bodiesVersion)
  const bodies = useReverse((s) => s.bodies)
  // The bodies put away as a whole are not drawn; they stay in the model
  // and in the map, which is the point — the map on the scan alone.
  const bodiesHidden = useReverse((s) => s.bodiesHidden)
  const onReverse = workspace === 'reverse'
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    reSceneOf(scene).setBodies(
      onReverse
        ? bodies
            .map((b) => ({ id: b.id, mesh: meshes.get(b.id), visible: b.visible && !bodiesHidden, color: b.color ?? bodyColor(b.id), topology: topologies.get(b.id) }))
            .filter((b): b is { id: number; mesh: KernelMesh; visible: boolean; color: string; topology: BodyTopology | undefined } => b.mesh !== undefined)
        : [],
    )
    // With no scan the bodies are the part, and the size everything else
    // goes by — a pick's reach, a plane's extent — follows them.
    if (onReverse && !useStore.getState().fileName && bodies.length > 0) useStore.setState({ modelSize: scene.modelSize() })
  }, [bodiesVersion, bodies, bodiesHidden, onReverse, sceneRef])

  // A body's row in the list, or a component's, under the pointer — and
  // the rows picked there: the bodies lit in the viewport, through
  // whatever stands in front of them.
  const listHover = useReverse((s) => (s.bodyHover?.from === 'list' ? s.bodyHover.ids : null))
  const listSelection = useReverse((s) => s.listSelection)
  const bodyFolders = useReverse((s) => s.bodyFolders)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const lit = new Set([...(listHover ?? []), ...bodiesOfPick(bodyFolders, listSelection)])
    reSceneOf(scene).setLitBodies(onReverse ? [...lit].sort((a, b) => a - b) : [])
  }, [listHover, listSelection, bodyFolders, onReverse, bodiesVersion, sceneRef])

  // Two solid bodies shown that run into each other: what they share is
  // drawn red over them, where the faces they have in common would fight
  // for the same pixels — worked out by the kernel's worker once each
  // build lands, and kept as it was while one is under way; with the
  // Bodies key's Overlaps switch off, not at all. The scan is not a body:
  // a body modelled on it lies in it, as it should.
  const bodiesBuilding = useReverse((s) => s.building)
  const overlapsShown = useReverse((s) => s.overlapsShown)
  const overlapIds = onReverse && overlapsShown && !bodiesHidden ? bodies.filter((b) => b.visible && b.closed && !b.surface).map((b) => b.id) : []
  const overlapKey = overlapIds.join(',')
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || bodiesBuilding) return
    const ids = overlapKey ? overlapKey.split(',').map(Number) : []
    if (ids.length < 2) {
      reSceneOf(scene).setOverlaps([])
      return
    }
    let stale = false
    session
      .overlaps(ids, () => stale)
      .then((found) => {
        if (found && !stale) reSceneOf(scene).setOverlaps(found)
      })
      // A kernel gone away says so through the build; the red is only
      // missing till it is back.
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [overlapKey, bodiesVersion, bodiesBuilding, session, sceneRef])

  // ---- the bodies lent to the other workspaces ------------------------------------------------
  // Every closed solid is on offer as triangles, meshed when asked for at
  // the chord asked for (src/app/solids): Mesh Tools takes one out of the
  // scan, adds it to it, or keeps what the two share. The offer follows
  // every build, and goes when the workspace does.
  useEffect(() => {
    offerSolids(
      'reverse',
      bodies
        .filter((b) => !b.surface && b.closed)
        .map((b) => ({
          key: `reverse:${b.id}`,
          name: b.name,
          source: 'Reverse engineer',
          version: bodiesVersion,
          mesh: async (chord: number) => {
            const client = session.client()
            if (!client) throw new Error('The CAD kernel is not running — open the Reverse engineer workspace once.')
            const [m] = await client.referenceMeshes([b.id], chord)
            if (!m) throw new Error(`${b.name} is not built any more.`)
            return { positions: m.positions, indices: m.indices }
          },
        })),
    )
  }, [bodies, bodiesVersion])
  useEffect(() => () => offerSolids('reverse', []), [])

  // ---- a blank stage, for modelling with no scan ---------------------------------------------
  // With no scan loaded the workspace is plain CAD from the start.
  const blankStage = onReverse && !fileName
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !blankStage) return
    reSceneOf(scene).startScanless()
    useStore.setState({ modelSize: scene.modelSize() })
  }, [blankStage, sceneRef])

  // The part being designed is what is solid, as in any CAD viewport, and
  // the scan lies over it as a see-through reference once there is a body
  // to see through to — it says where the part still stands proud or shy.
  // The menus of the view bar's Scan and Bodies keys set either part
  // see-through or solid as asked; both solid, each shows where it stands
  // proud of the other.
  const scanHidden = useReverse((s) => s.scanHidden)
  const scanSeeThrough = useReverse((s) => s.scanSeeThrough)
  const bodiesSeeThrough = useReverse((s) => s.bodiesSeeThrough)
  const anyBodyShown = !bodiesHidden && bodies.some((b) => b.visible)
  // A face being snapped has the scan to click next, and the body lies
  // right on it: for that while the bodies are a tint and their edges,
  // and the scan is solid under them.
  const snapping = featureDraft?.kind === 'moveFace' && featureDraft.snap && featureDraft.faces.length === 1
  useEffect(() => {
    if (!onReverse) return
    sceneRef.current?.setScanVisible(!scanHidden)
    reScene()?.setBodiesSolid(!bodiesSeeThrough)
    reScene()?.setBodiesFaint(snapping && !scanHidden)
    sceneRef.current?.setScanGhost((scanSeeThrough ?? anyBodyShown) && !scanHidden && !snapping)
    return () => {
      sceneRef.current?.setScanVisible(true)
      reScene()?.setBodiesSolid(false)
      reScene()?.setBodiesFaint(false)
      sceneRef.current?.setScanGhost(false)
    }
  }, [scanHidden, scanSeeThrough, bodiesSeeThrough, anyBodyShown, snapping, onReverse, sceneRef])

  // The tangent edges drawn, dimmed or left out, as the view bar sets.
  const tangentEdges = useReverse((s) => s.tangentEdges)
  useEffect(() => {
    if (onReverse) reScene()?.setTangentEdges(tangentEdges)
  }, [tangentEdges, onReverse, sceneRef])

  // ---- the part under the sheet ---------------------------------------------------------
  // While a sketch is drawn the sheet lies over the 3D viewport, whose
  // camera follows it (App wires the sheet's view to followSheet): the part
  // faces the sketch plane, swings round to it when the sketch opens and
  // when Align turns the frame, and is cut open at the plane where the
  // plane runs through it, so the face being drawn on is the face in view.
  const sketchFrameKey = useReverse((s) => (s.sketchDraft ? frameKey(s.sketchDraft.frame) : null))
  const sketchName = useReverse((s) => s.sketchDraft?.name ?? null)
  const sketchModelShown = useReverse((s) => s.sketchModelShown)
  const sketchSliced = useReverse((s) => s.sketchSliced)
  const sketchOpen = onReverse && sketchFrameKey !== null
  const dark = usePrefs((s) => s.dark)
  const unitsShown = usePrefs((s) => s.units)
  useEffect(() => {
    const scene = sceneRef.current
    const draft = useReverse.getState().sketchDraft
    if (!scene) return
    if (!sketchOpen || !draft) {
      scene.stopFollowingSheet()
      return
    }
    scene.reframeSheet(draft.frame)
  }, [sketchOpen, sketchFrameKey, sceneRef])
  useEffect(() => {
    const scene = sceneRef.current
    const draft = useReverse.getState().sketchDraft
    // Only while it cuts: the slice is shared with Mesh Tools' cut preview,
    // which a sketch that is not open must leave alone.
    if (!scene || !(sketchOpen && sketchModelShown && sketchSliced && draft)) return
    // The cut face in the sketch's own tone, which its lines read against;
    // the bodies closed where they are cut, in their own cut colours.
    scene.setSliceCapColor(sketchPalette(dark).cap)
    reScene()?.capSketchSlice(true)
    scene.setSlicePlane(draft.frame)
    return () => {
      reScene()?.capSketchSlice(false)
      scene.setSlicePlane(null)
    }
  }, [sketchOpen, sketchModelShown, sketchSliced, sketchFrameKey, sceneRef, dark])

  // ---- the picture under the sketch ---------------------------------------------------
  // Laid on the sketch plane in the 3D view, which the sheet the sketch is
  // drawn on is see-through over: traced on the sheet, it lies where the
  // sketch does.
  const sketchImage = useReverse((s) => (s.sketchDraft?.image ?? null))
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const draft = useReverse.getState().sketchDraft
    const shown = onReverse && sketchImage && draft ? { src: sketchImage.src, corners: imageCorners(sketchImage).map((p) => liftPoint(draft.frame, p)), opacity: sketchImage.opacity } : null
    reSceneOf(scene).setSketchImage(shown)
  }, [onReverse, sketchImage, sketchFrameKey, sceneRef])

  // ---- the coordinate planes ------------------------------------------------------------
  // The XY, YZ and XZ planes at the origin, as their rows in the body list
  // set them — up on a blank stage, put away over a scan, until their eyes
  // say otherwise — at the stage's size, which follows the bodies with no
  // scan. Not under a sketch: its sheet draws where they cross it.
  const planesShown = useReverse((s) => s.planesShown)
  const modelSize = useStore((s) => s.modelSize)
  const staged = onReverse && (fileName !== null || blankStage)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const hasScan = useStore.getState().fileName !== null
    reSceneOf(scene).setCoordinatePlanes(staged && !sketchOpen ? WORLD_AXES.filter((a) => coordinatePlaneShown(planesShown, a, hasScan)) : [])
  }, [staged, sketchOpen, planesShown, fileName, modelSize, sceneRef])

  // ---- what a picker points at ------------------------------------------------------
  // The option under the cursor in a plane or axis list, shown on the part
  // with its name: a plane as a sheet through the scan, an axis as a line
  // across it, an element lit as well. With no list open, the plane of the
  // sketch being drawn, in the sketch's colour, so the model beside the
  // sheet says where the sheet lies on it.
  const hint = useReverse((s) => s.hint)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const clear = () => {
      reSceneOf(scene).setPlaneHint(null, '#ffffff', '')
      scene.setHintedElements([])
    }
    if (!onReverse) {
      clear()
      return
    }
    // A sketch being drawn has no picker open: its plane is the one thing
    // to show, whatever hint a list that has since gone left behind.
    const draft = useReverse.getState().sketchDraft
    if (draft) {
      reSceneOf(scene).setPlaneHint(draft.frame, SKETCH_COLOR, draft.name, 0.06)
      scene.setHintedElements([])
      return clear
    }
    if (!hint) {
      clear()
      return
    }
    const ctx = resolveContext()
    const color = '#ffb020'
    if (hint.kind === 'plane') {
      const frame = resolvePlaneFrame(hint.ref, ctx)
      reSceneOf(scene).setPlaneHint(frame, color, hint.name)
      scene.setHintedElements(hint.ref.kind === 'plane' ? [hint.ref.id] : [])
      return
    }
    const sketch = useReverse.getState().features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === hint.sketchId)
    const axis = resolveAxis(hint.ref, sketch, ctx)
    reSceneOf(scene).setAxisHint(axis, color, hint.name)
    scene.setHintedElements(hint.ref.kind === 'element' ? [hint.ref.id] : [])
    return clear
    // Runs on the listed dependencies only, not on everything it reads.
  }, [hint, onReverse, sketchFrameKey, sketchName, sceneRef])

  // ---- the sketches on the part ----------------------------------------------------------
  // Every visible committed sketch, stood up in its plane, with its closed
  // regions along for the feature editors to offer as profiles — all but
  // the one being edited, which the sheet over the viewport draws. A sketch
  // a feature has used is hidden by the commit; it is drawn all the same
  // while a feature made from it is open, so its profiles can be seen and
  // picked. Only in this workspace: the Measure workspace has its own
  // things on the part. A playback draws the sketch it has come to, hidden
  // or not: the profile shows before the body made of it.
  const features = useReverse((s) => s.features)
  const playedSketch = useReverse((s) => {
    const f = s.playback && s.playback.at > 0 ? s.features[s.playback.at - 1] : undefined
    return f?.kind === 'sketch' ? f.id : null
  })
  const editedSketchId = useReverse((s) => s.sketchDraft?.featureId ?? null)
  const draftSketchKey = useReverse((s) => {
    const d = s.extrudeDraft ?? s.revolveDraft ?? s.featureDraft
    return d ? sketchesUsedBy('kind' in d ? d : { kind: 'extrude', sketchId: d.sketchId }).join(',') : ''
  })
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!onReverse) {
      reSceneOf(scene).setSketches([])
      return
    }
    const strokesOf = (sketch: Sketch, frame: SectionFrame) =>
      sketch.entities.map((e) => ({
        entity: e.id,
        kind: e.kind,
        construction: Boolean(e.construction),
        points: entityPolyline(e, 96).flatMap((p) => liftPoint(frame, p)),
      }))
    const inDraft = new Set(draftSketchKey === '' ? [] : draftSketchKey.split(',').map(Number))
    const items: SketchOverlayItem[] = features
      .filter((f): f is SketchFeature => f.kind === 'sketch' && (f.visible || inDraft.has(f.id) || f.id === playedSketch) && f.id !== editedSketchId)
      .map((f) => ({
        id: f.id,
        color: SKETCH_COLOR,
        frame: f.frame,
        strokes: strokesOf(f.sketch, f.frame),
        regions: regionsOf(f).map((r) => ({ key: r.key, outer: r.outer.polygon, holes: r.holes.map((h) => h.polygon) })),
      }))
    reSceneOf(scene).setSketches(items)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [features, editedSketchId, draftSketchKey, playedSketch, onReverse, sceneRef])

  // ---- the feature being set up: its profiles on offer, its ghost, its grips -------
  const extrudeDraft = useReverse((s) => s.extrudeDraft)
  const revolveDraft = useReverse((s) => s.revolveDraft)
  const nextFeatureId = useReverse((s) => s.nextFeatureId)
  const draft = extrudeDraft ?? revolveDraft
  const featureOpen = onReverse && (draft !== null || featureDraft !== null)
  /** The feature being edited in place, whichever box holds it. */
  const editedId = draft?.featureId ?? featureDraft?.featureId
  const editorOpen = useReverse((s) => reEditorOpen(s))
  const selection = useReverse((s) => s.selection)

  // The regions of the sketches are click targets while an editor is open,
  // the picked ones lit; a revolve also takes a sketch line, or an element
  // with an axis, for its axis. With no editor open they are click targets
  // still — a click selects, and the chips by it say what the thing can
  // become — with the selected one lit, and the elements light under the
  // cursor while they are on offer.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const idle = onReverse && !editorOpen
    const picked = new Set<string>()
    const profileOpen = featureOpen && draft !== null
    if (profileOpen && draft.sketchId !== null) for (const k of draft.regions) picked.add(`${draft.sketchId}:${k}`)
    if (idle && selection?.kind === 'region') picked.add(`${selection.sketchId}:${selection.key}`)
    // A feature picks its profiles through the part; a click with no
    // editor open takes a region only where the scan does not hide it. A
    // hole or an extract takes an element too.
    const wantsElement = (featureOpen && revolveDraft !== null) || (featureDraft?.kind === 'hole' || featureDraft?.kind === 'extract')
    reSceneOf(scene).setSketchProfilePick(profileOpen || idle, picked, profileOpen)
    reSceneOf(scene).setSketchLinePick((featureOpen && revolveDraft !== null) || idle)
    reSceneOf(scene).setCoordinatePlanePick(idle, idle && selection?.kind === 'coordinatePlane' ? selection.axis : null)
    if (onReverse) {
      scene.setElementPickEnabled(wantsElement || idle)
      scene.setElementHoverLights(wantsElement || idle)
    }
    return () => {
      if (onReverse) scene.setElementHoverLights(false)
    }
  }, [featureOpen, draft, revolveDraft, featureDraft, onReverse, editorOpen, selection, sceneRef])

  // The bodies' faces and edges as click targets: what an editor asks for
  // (a fillet its edges, a shell its faces, on the bodies it names), or,
  // with nothing open, the faces of every body — a click selects one and
  // the chips by it say what it can become. Not under a sketch: the sheet
  // lies over the part then.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!onReverse || sketchOpen) {
      reSceneOf(scene).setBodyPickMode(null, null)
      return
    }
    if (draftPick) reSceneOf(scene).setBodyPickMode(draftPick.mode, draftPick.bodies)
    // An extrude reaching to a face takes the face on the part.
    else if (toFaceOpen) reSceneOf(scene).setBodyPickMode('faces', null)
    else reSceneOf(scene).setBodyPickMode(editorOpen ? null : 'all', null)
    return () => reSceneOf(scene).setBodyPickMode(null, null)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [onReverse, sketchOpen, editorOpen, draftPickKey, toFaceOpen, bodiesVersion, sceneRef])
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    reSceneOf(scene).setPartPointPick(onReverse && !sketchOpen && extrudeTakesPoint)
    return () => reSceneOf(scene).setPartPointPick(false)
  }, [onReverse, sketchOpen, extrudeTakesPoint, sceneRef])
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const faces: { bodyId: number; hash: number }[] = []
    const edges: { bodyId: number; hash: number }[] = []
    const corners: { bodyId: number; point: [number, number, number] }[] = []
    if (onReverse && !editorOpen) {
      for (const item of selectionItems(selection)) {
        if (item.type === 'face') faces.push({ bodyId: item.bodyId, hash: item.face.hash })
        else if (item.type === 'edge') edges.push({ bodyId: item.bodyId, hash: item.edge.hash })
        else corners.push({ bodyId: item.bodyId, point: item.point })
      }
    }
    const chain: { bodyId: number; hash: number }[] = []
    const varying: VaryingEdgeEnds[] = []
    // The face an extrude reaches to, and the face it pulls, found on the
    // body by their fingerprints.
    for (const on of [toFaceExtent?.face ? toFaceExtent : null, pulledFace]) {
      if (!onReverse || !on) continue
      const topology = topologies.get(on.body)
      const i = topology ? matchFace(on.face, topology.faces.map((f) => f.fingerprint), matchTolerance(useStore.getState().modelSize)) : null
      if (topology && i !== null) faces.push({ bodyId: on.body, hash: topology.faces[i].hash })
    }
    const d = featureDraft
    if (onReverse && d && 'body' in d && d.body !== null) {
      const body = d.body
      if (d.kind === 'shell' || d.kind === 'draft' || d.kind === 'moveFace' || d.kind === 'deleteFace') for (const f of d.faces) if (f.hash >= 0) faces.push({ bodyId: body, hash: f.hash })
      if (d.kind === 'thread' && d.face && d.face.hash >= 0) faces.push({ bodyId: body, hash: d.face.hash })
      if (d.kind === 'fillet' || d.kind === 'chamfer') {
        for (const e of d.edges) if (e.hash >= 0) edges.push({ bodyId: body, hash: e.hash })
        // The edges the round will run on along, tangent to the picked
        // ones: lit fainter, so what one click takes is seen before the
        // kernel is asked.
        const topology = topologies.get(body)
        if (d.chain && topology) for (const hash of tangentChain(topology.edges, edges.map((e) => e.hash), splitEdges(topology))) chain.push({ bodyId: body, hash })
        // An edge at a varying radius, lit as picked; while the box shows
        // them, a dot on each end and its Start and End named by it with
        // the radius there.
        if (d.kind === 'fillet') {
          for (const [index, v] of (d.variable ?? []).entries()) {
            if (v.edge.hash < 0) continue
            edges.push({ bodyId: body, hash: v.edge.hash })
            if (d.mode !== 'variable') continue
            for (const point of v.edge.ends) corners.push({ bodyId: body, point })
            varying.push({ index, ends: v.edge.ends, endTangents: v.edge.endTangents, radius: v.radius })
          }
        }
      }
    }
    // The faces the parameter pointed at in the list shapes (issue 21): those
    // the features it drives made — while no box is open, whose picks are
    // lit the same way.
    if (onReverse && !editorOpen && parameterLit !== null) {
      const r = useReverse.getState()
      const name = r.parameters.find((x) => x.id === parameterLit)?.name
      const made = new Set(name ? drivenBy(name, r.parameters, r.features) : [])
      for (const [bodyId, topology] of topologies) for (const f of topology.faces) if (made.has(f.fingerprint.origin)) faces.push({ bodyId, hash: f.hash })
    }
    reSceneOf(scene).setBodyPicks(faces, edges, chain, corners)
    reSceneOf(scene).setVaryingEnds(varying, unitsShown)
  }, [onReverse, editorOpen, selection, featureDraft, toFaceExtent, pulledFace, bodiesVersion, sceneRef, unitsShown, parameterLit])

  /** The feature the open editor would make, as a feature, or null while
   *  it is not complete enough to build — nothing picked, no axis yet. A
   *  feature on a body previews under its own id when it is being edited,
   *  so the builder works on the body as it stood before it. */
  const draftFeature = (): Feature | null => {
    if (featureDraft) return featureOfDraft(featureDraft, featureDraft.featureId ?? PREVIEW_ID, 'Preview')
    if (!draft) return null
    if (!extrudeDraft?.face && (draft.sketchId === null || draft.regions.length === 0)) return null
    if (extrudeDraft) {
      const e = extrudeDraft.extent
      if (e.kind === 'toPlane' && !e.plane) return null
      if (e.kind === 'toFace' && !e.face) return null
      if (e.kind === 'toBody' && e.body < 0) return null
      if (e.kind === 'betweenPlanes' && (!e.a || !e.b)) return null
      // An end found on the bodies — the next face, the last — is measured
      // against the body the extrude joins or cuts, as it stood before
      // this extrude when the extrude is being edited: the ghost carries
      // the feature's own id, its operation and its target for that. The
      // ghost is still the tool alone; a preview places nothing.
      const onPart = e.kind === 'toFace' || e.kind === 'toBody' || e.kind === 'toNext' || e.kind === 'toLast'
      // A face pulled is previewed under the feature's own id too: the
      // face is found on the body as it stood before the extrude.
      const own = onPart || extrudeDraft.face !== undefined
      return { id: own ? (extrudeDraft.featureId ?? PREVIEW_ID) : PREVIEW_ID, kind: 'extrude', name: 'Preview', sketchId: extrudeDraft.sketchId ?? 0, regions: extrudeDraft.regions, ...(extrudeDraft.face ? { face: extrudeDraft.face } : {}), extent: e, draftDeg: extrudeDraft.draftDeg, ...(extrudeDraft.direction ? { direction: extrudeDraft.direction } : {}), op: onPart ? extrudeDraft.op : 'new', visible: true }
    }
    if (revolveDraft) {
      if (!revolveDraft.axis || !(revolveDraft.angleDeg > 0)) return null
      return { id: PREVIEW_ID, kind: 'revolve', name: 'Preview', sketchId: revolveDraft.sketchId!, regions: revolveDraft.regions, axis: revolveDraft.axis, angleDeg: revolveDraft.angleDeg, pitch: revolveDraft.pitch, leftHanded: revolveDraft.leftHanded, op: 'new', visible: true }
    }
    return null
  }
  const ghostColor = () => {
    if (featureDraft) {
      if (featureDraft.kind === 'extract' || featureDraft.kind === 'loft' || featureDraft.kind === 'sweep' || featureDraft.kind === 'thicken') return featureDraft.op === 'cut' ? CUT_COLOR : bodyColor(featureDraft.featureId ?? nextFeatureId)
      if (featureDraft.kind === 'sheet' || featureDraft.kind === 'surface' || featureDraft.kind === 'network' || featureDraft.kind === 'trim' || featureDraft.kind === 'import') return bodyColor(featureDraft.featureId ?? nextFeatureId)
      // A Move's ghost is the bodies themselves, in the first one's colour.
      if (featureDraft.kind === 'moveBody') {
        const first = featureDraft.bodies[0]
        return first === undefined ? bodyColor(nextFeatureId) : (bodies.find((b) => b.id === first)?.color ?? bodyColor(first))
      }
      return bodyColor(featureDraft.body ?? nextFeatureId)
    }
    return !draft ? '#ffffff' : draft.op === 'cut' ? CUT_COLOR : bodyColor(draft.featureId ?? nextFeatureId)
  }

  // The ghost: the kernel builds the draft's solid on its own and the
  // viewport draws it see-through. A drag changes the draft many times a
  // second and the kernel answers a few times a second, so one request is
  // out at a time and the newest draft is asked for the moment the answer
  // lands — never a queue, and never a wait for the hand to stop, which is
  // what a debounce made of a steady drag: a ghost that stood still until
  // the hand did. Every answer is drawn, being newer than what is up. A
  // straight extrude does not wait even for that: its ghost is a prism,
  // and a prism under a new From and To is the last one stretched along the
  // normal (prismStretch) — done here, every frame, the kernel's own ghost
  // taking over as it lands.
  const previewBusy = useRef(false)
  const previewNext = useRef<(() => void) | null>(null)
  const previewSession = useRef<string | null>(null)
  /** The network last asked for, as its data — see the preview below. */
  const networkAsked = useRef<string | null>(null)
  /** The prism the ghost on screen was built as, and the one the draft
   *  asks for now. */
  const ghostBase = useRef<{ key: string; origin: Vec3; dir: Vec3; from: number; to: number } | null>(null)
  const ghostWanted = useRef<{ key: string; from: number; to: number } | null>(null)
  /** What the Move ghost on screen was drawn of — the bodies, copied or
   *  not, as built — so a drag only carries it by its matrix. */
  const moveGhost = useRef<string | null>(null)
  useEffect(() => {
    const scene = sceneRef.current
    const client = session.client()
    const re = useReverse.getState()
    const putAway = () => {
      previewSession.current = null
      previewNext.current = null
      ghostBase.current = null
      ghostWanted.current = null
      moveGhost.current = null
    }
    if (!featureOpen || !scene) {
      putAway()
      if (scene) reSceneOf(scene).setBodyPreview(null, '#ffffff')
      if (re.preview.status !== 'idle') re.setPreview({ status: 'idle' })
      return
    }
    // A snapped face that goes into the history — the extrude's distance,
    // the sketch's line — has no one step to preview: the whole list
    // builds again. What is shown is where the face will lie. A move
    // followed by the draft the scan asked for is two features, and is
    // shown the same way, the ghost leaned onto the scan's plane.
    if (featureDraft?.kind === 'moveFace' && featureDraft.faces.length > 0 && featureDraft.body !== null) {
      const plan = historyEditOf(featureDraft, re.features, re.elementRefs)
      const lean = snapDraftOf(featureDraft) ? (featureDraft.reading?.draft ?? null) : null
      if (plan || lean) {
        const body = featureDraft.body
        const mesh = meshes.get(body)
        const ghost = mesh ? movedFaceMesh(mesh, featureDraft.faces, featureDraft.offset, lean) : null
        putAway()
        reSceneOf(scene).setBodyPreview(ghost, ghostColor())
        if (re.preview.status !== 'idle') re.setPreview({ status: 'idle' })
        return
      }
    }
    // A Move's ghost is the bodies themselves: their meshes as built, drawn
    // once in their place and carried by the move's matrix at every change
    // of a number — a drag of the gizmo moves it frame by frame, with
    // nothing to wait for. The worker is asked all the same, one request
    // out at a time, for the bodies where they are going: what the live map
    // reads the scan against.
    let moveStep: PreviewStep | null = null
    if (featureDraft?.kind === 'moveBody') {
      const ids = featureDraft.bodies.filter((id) => meshes.has(id))
      if (ids.length === 0) {
        putAway()
        reSceneOf(scene).setBodyPreview(null, '#ffffff')
        if (re.preview.status !== 'idle') re.setPreview({ status: 'idle' })
        return
      }
      // Reopened, the part is built again as it stood before the Move: the
      // meshes in hand until it lands are of the bodies already moved.
      if (featureDraft.featureId !== undefined && re.building) return
      const drawn = `${ids.join(',')}|${featureDraft.copy}|${bodiesVersion}`
      if (moveGhost.current !== drawn) {
        moveGhost.current = drawn
        reSceneOf(scene).setBodyPreview(mergeMeshes(ids.map((id) => meshes.get(id)!)), ghostColor(), { replaces: featureDraft.copy ? [] : ids, edges: true })
      }
      const matrix = moveMatrix(featureDraft)
      reSceneOf(scene).setBodyPreviewStretch(matrix4Of(matrix))
      if (!client || re.kernelStatus !== 'ready') return
      moveStep = { kind: 'moveBody', id: featureDraft.featureId ?? PREVIEW_ID, name: 'Preview', bodies: ids, matrix, copy: featureDraft.copy }
    }
    const feature = moveStep ? null : draftFeature()
    if (!moveStep && (!feature || !client || re.kernelStatus !== 'ready')) {
      putAway()
      reSceneOf(scene).setBodyPreview(null, '#ffffff')
      if (re.preview.status !== 'idle') re.setPreview({ status: 'idle' })
      return
    }
    // Resolved after the committed features, so a feature being edited in
    // place sees the sketches made before it.
    const others = re.features.filter((f) => f.id !== editedId)
    const step = moveStep ?? resolveFeatures([...others, feature!], resolveContext(), regionsOf).at(-1)
    if (!step || step.id !== (moveStep ?? feature!).id || step.kind === 'sketch') return
    if (step.kind === 'failed') {
      putAway()
      reSceneOf(scene).setBodyPreview(null, '#ffffff')
      re.setPreview({ status: 'failed', message: step.message })
      return
    }
    // A network asks again only when the network changed — not for each
    // point of a curve still being drawn, nor for a patch picked.
    if (step.kind === 'network') {
      const key = JSON.stringify([step.nodes, step.curves, step.cells, step.spans, step.fit])
      if (key === networkAsked.current && re.preview.status !== 'idle') return
      networkAsked.current = key
    } else networkAsked.current = null
    if (re.preview.status !== 'building') re.setPreview({ status: 'building' })
    // A straight extrude between two numbers: the ghost that is up, built
    // for the same profiles, is stretched to the new numbers at once. A
    // tapered one is not: stretched, its sides would lean the wrong amount;
    // nor one swept askew, whose stretch would be a shear.
    const prism =
      step.kind === 'extrude' && typeof step.from === 'number' && typeof step.to === 'number' && !step.until && step.draftDeg === 0 && !step.along
        ? { key: `${step.sketchId}|${extrudeDraft?.regions.join(',')}|${step.faceProfile ? `face:${step.faceProfile.body}:${step.faceProfile.face.centroid.join(',')}` : ''}|${step.draftDeg}`, origin: step.origin, dir: step.dir, from: step.from, to: step.to }
        : null
    ghostWanted.current = prism
    if (prism && ghostBase.current?.key === prism.key) {
      const m = prismStretch(prism.origin, prism.dir, ghostBase.current.from, ghostBase.current.to, prism.from, prism.to)
      if (m) reSceneOf(scene).setBodyPreviewStretch(m)
    } else if (!prism) ghostBase.current = null
    const asked = `${step.kind}:${step.id}`
    previewSession.current = asked
    const ask = () => {
      const sketchId = step.kind === 'extrude' || step.kind === 'revolve' ? step.sketchId : null
      const sketch = re.features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === sketchId)?.sketch
      previewBusy.current = true
      client!
        .preview(step, sketch, stepFilesFor([step]))
        .then((answer) => {
          // Another editor since, or none: the answer is for a box that is
          // shut. A newer draft of the same box: drawn all the same — it is
          // nearer the hand than what is up — but not reported, the numbers
          // and the map being the last answer's to give.
          if (previewSession.current !== asked || !answer) return
          const latest = previewNext.current === null
          // A feature on a body hands back the body as it would leave it:
          // drawn solid in the body's place. A cut's tool is inside the
          // body it cuts, and is drawn through it.
          const fd = useReverse.getState().featureDraft
          // A face being moved keeps its ghost see-through: the scan under
          // it is what is being clicked.
          const replaces = !fd || !('body' in fd) || fd.body === null || fd.kind === 'moveFace' || (fd.kind === 'mirror' && !fd.join) || (fd.kind === 'offsetBody' && fd.keep) ? [] : fd.kind === 'boolean' && fd.tool !== null && !fd.keep ? [fd.body, fd.tool] : [fd.body]
          const cutting = (draft?.op ?? (fd && 'op' in fd ? fd.op : null)) === 'cut'
          // A Move draws its own ghost; the answer is the map's.
          if (fd?.kind !== 'moveBody') reScene()?.setBodyPreview(answer.mesh, ghostColor(), { replaces, through: replaces.length === 0 && cutting, edges: answer.edges })
          // The prism this ghost is, and the hand's newer one on top of it.
          ghostBase.current = prism
          const wanted = ghostWanted.current
          if (prism && wanted && wanted.key === prism.key && (wanted.from !== prism.from || wanted.to !== prism.to)) {
            const m = prismStretch(prism.origin, prism.dir, prism.from, prism.to, wanted.from, wanted.to)
            if (m) reScene()?.setBodyPreviewStretch(m)
          }
          if (!latest) return
          useReverse.getState().setPreview({ status: 'ok', volume: answer.volume, closed: answer.closed, ...(answer.surface ? { surface: answer.surface } : {}), ...(answer.trim ? { trim: answer.trim } : {}), ...(answer.network ? { network: answer.network } : {}), ...(answer.sheetFaces !== undefined ? { sheetFaces: answer.sheetFaces } : {}), ...(answer.failure ? { failure: answer.failure } : {}) })
          setGhostTick((t) => t + 1)
        })
        .catch((e) => {
          if (previewSession.current !== asked || previewNext.current !== null) return
          ghostBase.current = null
          if (useReverse.getState().featureDraft?.kind !== 'moveBody') reScene()?.setBodyPreview(null, '#ffffff')
          useReverse.getState().setPreview({ status: 'failed', message: message(e), ...(e instanceof PreviewFailure && e.where.length > 0 ? { where: e.where } : {}) })
        })
        .finally(() => {
          previewBusy.current = false
          const next = previewNext.current
          previewNext.current = null
          next?.()
        })
    }
    if (previewBusy.current) previewNext.current = ask
    else ask()
    // Runs on the listed dependencies only, not on everything it reads.
  }, [featureOpen, extrudeDraft, revolveDraft, featureDraft, features, kernelStatus, bodiesVersion, sceneRef])

  // A feature reopened for editing is set up on the part as it stood
  // before it: the build ran the features before it alone
  // (featuresToBuild), and its picks are found again on that body by
  // their fingerprints, so they light where they were made. Not while a
  // build is under way — the bodies drawn until it answers are the old
  // ones, whose hashes would name the wrong faces.
  useEffect(() => {
    if (!editingOnBody || kernelStatus !== 'ready') return
    const re = useReverse.getState()
    if (re.building) return
    const { step, body } = editingOnBody
    const topology = topologies.get(body)
    const mesh = meshes.get(body)
    const d = re.featureDraft
    if (!topology || !mesh || !d || d.featureId !== step) return
    const tol = matchTolerance(meshDiagonal(mesh))
    const faceOf = (f: FaceInfo): FaceInfo => {
      if (f.hash >= 0) return f
      const i = matchFace(f.fingerprint, topology.faces.map((x) => x.fingerprint), tol)
      return i === null ? f : topology.faces[i]
    }
    if (d.kind === 'shell' || d.kind === 'draft' || d.kind === 'moveFace' || d.kind === 'deleteFace') {
      if (d.faces.some((f) => f.hash < 0)) re.setFeatureDraft({ faces: d.faces.map(faceOf) })
    } else if (d.kind === 'thread') {
      if (d.face && d.face.hash < 0) re.setFeatureDraft({ face: faceOf(d.face) })
    } else if (d.kind === 'fillet' || d.kind === 'chamfer') {
      const edgeOf = (e: EdgeInfo): EdgeInfo => {
        if (e.hash >= 0) return e
        const i = matchEdge(e.fingerprint, topology.edges.map((x) => x.fingerprint), tol)
        return i === null ? e : topology.edges[i]
      }
      if (d.edges.some((e) => e.hash < 0)) re.setFeatureDraft({ edges: d.edges.map(edgeOf) })
      if (d.kind === 'fillet' && d.variable?.some((v) => v.edge.hash < 0)) re.setFeatureDraft({ variable: d.variable.map((v) => ({ ...v, edge: edgeOf(v.edge) })) })
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [editingOnBody?.step, editingOnBody?.body, kernelStatus, bodiesVersion])

  // A thread's round face, once it names a face of the mesh: a boss or a
  // bore, read off the face's triangles — and, while no size has been
  // chosen or typed, the standard's size for it, as the face is drawn: a
  // boss's major diameter, a bore's minor.
  const threadFaceKey = featureDraft?.kind === 'thread' && featureDraft.face && featureDraft.body !== null && featureDraft.internal === null ? `${featureDraft.body}:${featureDraft.face.hash}` : null
  useEffect(() => {
    const re = useReverse.getState()
    const d = re.featureDraft
    if (!threadFaceKey || !d || d.kind !== 'thread' || !d.face || d.face.hash < 0 || d.body === null) return
    const mesh = meshes.get(d.body)
    const reading = mesh ? threadFaceReading(mesh, d.face, d.standard, d.sized) : null
    if (reading) re.setFeatureDraft(reading)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [threadFaceKey, bodiesVersion])

  // The fillet's radius, read off the scan across the first picked edge:
  // a section by the plane square to the edge at its middle, the two
  // faces as lines through the edge, the round between them fitted. Only
  // a straight edge between two flats is read; anything else keeps the
  // default until typed. A typed number is left alone.
  const filletKey = featureDraft?.kind === 'fillet' ? `${featureDraft.body}:${featureDraft.edges.map((e) => e.hash).join(',')}:${featureDraft.radiusTyped}` : null
  useEffect(() => {
    const d = useReverse.getState().featureDraft
    const client = clientRef.current
    if (!d || d.kind !== 'fillet' || d.radiusTyped || !client) return
    const edge = d.edges[0]
    if (!edge || cornerUnreadable(edge.fingerprint)) {
      if (d.edges.length > 0 && d.estimate.status !== 'none') useReverse.getState().setFeatureDraft({ estimate: { status: 'none' } })
      return
    }
    const fp = edge.fingerprint
    const n = normalize(fp.dir)
    if (!n) return
    useReverse.getState().setFeatureDraft({ estimate: { status: 'working' } })
    let stale = false
    const reach = Math.max(3, useStore.getState().modelSize * 0.05)
    client
      .section(fp.mid, n, 0)
      .then((cut) => {
        if (stale) return
        const reading = readCornerCut(fp, fp.mid, cut, reach)
        const now = useReverse.getState().featureDraft
        if (!now || now.kind !== 'fillet' || now.radiusTyped) return
        if (reading) useReverse.getState().setFeatureDraft({ radius: Math.round(reading.radius * 100) / 100, estimate: { status: 'found', radius: reading.radius, points: reading.points } })
        else useReverse.getState().setFeatureDraft({ estimate: { status: 'none' } })
      })
      .catch(() => {
        if (!stale) useReverse.getState().setFeatureDraft({ estimate: { status: 'none' } })
      })
    return () => {
      stale = true
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [filletKey])

  // The open edges of a trim that did not close, drawn on the part: the
  // preview's while a trim box is open, else those of every visible trim
  // body — where the next surface has to go. In the same red, where a
  // round, a chamfer or a shell fails: the edges or the face outlines the
  // kernel cannot do at the size asked — the preview's while its box is
  // open, else those of every built feature that failed so.
  const previewOpen = useReverse((s) => (s.featureDraft?.kind === 'trim' && s.preview.status === 'ok' ? s.preview.trim?.openEdges : undefined))
  const previewWhere = useReverse((s) => (s.featureDraft ? (s.preview.status === 'failed' ? s.preview.where : s.preview.status === 'ok' ? s.preview.failure?.where : undefined) : undefined))
  const results = useReverse((s) => s.results)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!onReverse) {
      reSceneOf(scene).setOpenEdges([])
      return
    }
    if (featureDraft?.kind === 'trim') {
      reSceneOf(scene).setOpenEdges(previewOpen ?? [])
      return
    }
    if (previewWhere && previewWhere.length > 0) {
      reSceneOf(scene).setOpenEdges(previewWhere)
      return
    }
    const open: Float32Array[] = []
    for (const b of bodies) {
      const r = results[b.id]
      if (b.visible && r?.trim && !r.trim.closed) open.push(...r.trim.openEdges)
    }
    for (const r of Object.values(results)) if (r.status === 'failed' && r.where) open.push(...r.where)
    reSceneOf(scene).setOpenEdges(open)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [onReverse, featureDraft?.kind, previewOpen, previewWhere, results, bodies, sceneRef])

  // A surface's region is shown on the scan as a marking while its box is
  // open — the same layer the tools paint into, so a flood and a brush
  // stroke land in one place. The region goes to the scene when the store
  // changed it (a flood, Clear, a reopened feature) and comes back from
  // the scene when the tools did (App's paint change); `regionShown`
  // tells the two apart so neither echoes the other.
  const surfaceRegion = featureDraft?.kind === 'surface' ? featureDraft.region : null
  const surfaceOpen = featureDraft?.kind === 'surface'
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!surfaceOpen) {
      if (regionShown.current) {
        regionShown.current = null
        scene.clearPaint()
      }
      return
    }
    if (!surfaceRegion || regionShown.current === surfaceRegion) return
    regionShown.current = surfaceRegion
    if (surfaceRegion.length === 0) scene.clearPaint()
    else scene.setPaintedVertices(surfaceRegion, ghostColor())
    // Runs on the listed dependencies only, not on everything it reads.
  }, [surfaceOpen, surfaceRegion, sceneRef])

  // A new mirror opens on the scan's own symmetry plane: a symmetry plane
  // already measured in Measure when there is one, else the mesh worker's
  // mirror registration from the scan's principal planes — a few seconds on
  // a big scan, once per scan and alignment. A plane the operator chooses
  // in the meantime stands; a part with no symmetry says so in the box.
  const mirrorKey = featureDraft?.kind === 'mirror' && featureDraft.featureId === undefined ? 'new' : null
  useEffect(() => {
    const d = useReverse.getState().featureDraft
    if (!mirrorKey || !d || d.kind !== 'mirror' || d.plane !== null || d.symmetry.status !== 'idle') return
    const measured = [...useStore.getState().elements].reverse().find((e) => e.fit?.kind === 'plane' && e.source.type === 'constructed' && e.source.method === 'plane-symmetry')
    if (measured) {
      useReverse.getState().setFeatureDraft({ plane: { kind: 'plane', id: measured.id }, symmetry: { status: 'element', name: measured.name } })
      return
    }
    const land = (r: SymmetryPlane) => {
      const now = useReverse.getState().featureDraft
      if (!now || now.kind !== 'mirror' || now.featureId !== undefined) return
      const plane = symmetryPlaneRef(r)
      if (!plane) useReverse.getState().setFeatureDraft({ symmetry: { status: 'none', rms: Number.isFinite(r.rms) ? r.rms : null } })
      else useReverse.getState().setFeatureDraft({ symmetry: { status: 'found', plane: r }, ...(now.plane === null ? { plane } : {}) })
    }
    if (symmetryCache.current) {
      land(symmetryCache.current)
      return
    }
    const client = clientRef.current
    if (!client) return
    useReverse.getState().setFeatureDraft({ symmetry: { status: 'working' } })
    const cacheAt = symmetryCache
    const stamp = symmetryStamp.current
    client
      .symmetry(null)
      .then((r) => {
        // A scan or an alignment since then: the plane is of another part.
        if (stamp !== symmetryStamp.current) return
        cacheAt.current = r
        land(r)
      })
      .catch(() => {
        const now = useReverse.getState().featureDraft
        if (now && now.kind === 'mirror' && now.symmetry.status === 'working') useReverse.getState().setFeatureDraft({ symmetry: { status: 'none', rms: null } })
      })
    // Runs on the listed dependencies only, not on everything it reads.
  }, [mirrorKey])

  // ---- the live map -------------------------------------------------------------------
  // The scan coloured by its signed distance to the ghost while a feature
  // is set up, or to the committed bodies on the view bar's say-so: the
  // Deviation workspace's nearest-point machinery on the ghost's own
  // tessellation and the scan's vertices near it (core/re/liveMap), run in
  // the kernel worker, which holds the last ghost and the bodies already.
  // The scan goes over once per file and once more per datum alignment —
  // the viewport's vertices, alignment baked in, the frame the bodies are
  // built in.
  const [ghostTick, setGhostTick] = useState(0)
  const [scanTick, setScanTick] = useState(0)
  const mapTick = useRef(0)
  const triangleCount = useStore((s) => s.triangleCount)
  useEffect(() => {
    let stale = false
    session
      .syncScan()
      .then((sent) => {
        if (!stale && sent === 'sent') setScanTick((t) => t + 1)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [kernelStatus, fileName, triangleCount, appliedAlignment, session])

  const liveMapOn = useRePrefs((s) => s.liveMap)
  const liveMapRange = useRePrefs((s) => s.liveMapRange)
  const colormap = usePrefs((s) => s.colormap)
  const bodyMap = useReverse((s) => s.bodyMap)
  const building = useReverse((s) => s.building)
  const previewStatus = useReverse((s) => s.preview.status)
  const visibleBodyIds = bodies.filter((b) => b.visible).map((b) => b.id).join(',')
  useEffect(() => {
    const scene = sceneRef.current
    const client = session.client()
    const lift = () => {
      scene?.setSparseField(null, null)
      if (useReverse.getState().mapReport) useReverse.getState().setMapReport(null)
    }
    if (!onReverse || !scene || !client || kernelStatus !== 'ready') {
      lift()
      return
    }
    // The ghost's map while an editor has a ghost up and the preference is
    // on; otherwise the bodies' map on the key. Neither: nothing painted.
    // A ghost being rebuilt — every step of a drag — leaves the last map
    // on the scan until the new ghost lands, rather than lifting it and
    // laying it again, which would flicker under the hand.
    if (featureOpen && previewStatus === 'building' && liveMapOn) return
    const ghostShown = featureOpen && previewStatus === 'ok'
    const source: 'preview' | 'bodies' | null = ghostShown ? (liveMapOn ? 'preview' : null) : bodyMap && visibleBodyIds !== '' && !building ? 'bodies' : null
    if (!source) {
      lift()
      return
    }
    let stale = false
    const timer = window.setTimeout(
      () => {
        client
          .map(source, visibleBodyIds.split(',').map(Number), liveMapRange)
          .then((field) => {
            if (stale || !field) return
            const painted = paintedSparse(field, liveMapScale(liveMapRange), colormapById(colormap))
            sceneRef.current?.setSparseField(painted.subset, painted.rgb)
            const re = useReverse.getState()
            re.setMapReport({ source: source === 'preview' ? 'ghost' : 'bodies', ...sparseSummary(field, liveMapRange), range: liveMapRange, tick: ++mapTick.current })
          })
          .catch(() => {})
      },
      source === 'preview' ? MAP_DEBOUNCE_MS : 0,
    )
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [onReverse, kernelStatus, featureOpen, previewStatus, ghostTick, scanTick, liveMapOn, liveMapRange, colormap, bodyMap, visibleBodyIds, bodiesVersion, building, sceneRef])

  // Measure's elements, where the Reverse store can read them.
  const measured = useStore((s) => s.elements)
  useEffect(() => {
    useReverse.getState().setElementRefs(measured.map((e) => ({ id: e.id, name: e.name, fit: e.fit })))
  }, [measured])
  // An extracted body follows its element or its shadow: extended, refitted
  // or taken again in Measure, it is built again — on the way back in, not
  // at every move of a grip.
  const sectionsNow = useStore((s) => s.sections)
  useEffect(() => {
    if (!onReverse || useReverse.getState().features.length === 0) return
    if (session.extractsChanged()) useReverse.setState((s) => ({ buildVersion: s.buildVersion + 1 }))
    // Runs on the listed dependencies only, not on everything it reads.
  }, [measured, sectionsNow, onReverse])

  // ---- the curvature map ---------------------------------------------------------------
  // The scan coloured by its mean curvature on the view bar's key — read
  // once per scan by the mesh worker, which holds the graph (an alignment
  // turns the part and leaves its curvature alone), painted by the scene
  // sync as the full map it is. A ghost with its live map takes the surface
  // over while it is up: the sparse layer waits under a full map, and a
  // feature being fitted to the scan is the reading wanted then.
  const curvatureMap = useReverse((s) => s.curvatureMap)
  const curvatureRead = useReverse((s) => s.curvature !== null)
  useEffect(() => {
    useReverse.getState().setCurvature(null)
  }, [fileName, triangleCount])
  useEffect(() => {
    if (!onReverse || !curvatureMap || curvatureRead || !fileName) return
    const client = clientRef.current
    if (!client) return
    let stale = false
    client
      .curvature()
      .then((values) => {
        if (stale) return
        useReverse.getState().setCurvature({ values, range: curvatureRange(values, useStore.getState().modelSize) })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [onReverse, curvatureMap, curvatureRead, fileName, triangleCount, clientRef])
  const ghostMapUp = featureOpen && liveMapOn && (previewStatus === 'ok' || previewStatus === 'building')
  useEffect(() => {
    useReverse.getState().setCurvatureShown(onReverse && curvatureMap && curvatureRead && !ghostMapUp)
  }, [onReverse, curvatureMap, curvatureRead, ghostMapUp])

  // The grips: arrows on an extrude's faces and its far edge, a ring about
  // a revolve's axis, in the colour the ghost wears. The arrows and the Move
  // gizmo are held at a size on the screen (core/preview ARROW_PX), the
  // revolve's ring runs through the body it turns.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    let grips: FeatureGrip[] = []
    if (featureOpen && featureDraft) {
      if ((featureDraft.kind === 'fillet' || featureDraft.kind === 'chamfer') && featureDraft.edges[0]) {
        const g = edgeGrip(featureDraft.edges[0].fingerprint)
        if (g) grips = [g]
      } else if (featureDraft.kind === 'shell' && featureDraft.faces[0]) grips = [faceGrip(featureDraft.faces[0].fingerprint)]
      else if (featureDraft.kind === 'moveFace' && featureDraft.faces[0]) grips = [moveGrip(featureDraft.faces[0].fingerprint, featureDraft.offset)]
      else if (featureDraft.kind === 'moveBody' && featureDraft.bodies.length > 0) grips = moveGrips(featureDraft)
    } else if (featureOpen && extrudeDraft?.face) {
      // A pulled face: the arrows through the face's centre along its
      // normal.
      const fp = extrudeDraft.face.face
      grips = extrudeGripsAt(fp.centroid, extrudeDraft.direction ?? normalize(fp.dir) ?? [0, 0, 1], extrudeDraft.extent)
    } else if (featureOpen && draft && draft.sketchId !== null) {
      const sketch = features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === draft.sketchId)
      if (sketch) {
        const regions = regionsOf(sketch).filter((r) => draft.regions.includes(r.key))
        if (extrudeDraft) {
          // Swept askew, the arrows go the way it is swept; the taper's grip
          // stands on a side square to the plane, so it stays away.
          const taper = extrudeDraft.direction ? null : taperGrip(sketch.frame, regions, extrudeDraft.extent, -extrudeDraft.draftDeg)
          grips = [...extrudeGrips(sketch.frame, regions, extrudeDraft.extent, extrudeDraft.direction), ...(taper ? [taper] : [])]
        }
        else if (revolveDraft?.axis) {
          const axis = resolveAxis(revolveDraft.axis, sketch, resolveContext())
          const ring = axis ? revolveGrip(sketch.frame, regions, axis) : null
          if (ring) grips = [ring]
        }
      }
    }
    scene.setFeatureGrips(grips, ghostColor())
    // Runs on the listed dependencies only, not on everything it reads.
  }, [featureOpen, extrudeDraft, revolveDraft, featureDraft, features, sceneRef])

  // The number field on the grip last dragged: the number it drags, on the
  // grip, readable while the hand is on it and typed into once it lets go.
  // A length is shown in the units shown, and typed in them (the commit in
  // useReversePlugin); an expression as it is written.
  const gripField = useReverse((s) => s.gripField)
  const units = usePrefs((s) => s.units)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const re = useReverse.getState()
    const shown = featureOpen && gripField ? gripFieldValue(re) : null
    const length = shown?.unit === 'mm'
    scene.setGripField(
      shown && gripField
        ? { side: gripField, value: length ? toDisplay(shown.value, units) : shown.value, unit: length ? unitWord(units) : shown.unit, ...(shown.expr !== undefined ? { text: shown.expr } : {}) }
        : null,
    )
    // Runs on the listed dependencies only, not on everything it reads.
  }, [featureOpen, gripField, extrudeDraft, revolveDraft, featureDraft, sceneRef, units])

  const exportStep = async () => {
    const re = useReverse.getState()
    const ids = re.bodies.filter((b) => b.visible).map((b) => b.id)
    if (ids.length === 0 || !session.client()) {
      useStore.getState().setError('No visible body to export — build one first.')
      return
    }
    try {
      const { name, text } = await session.stepFile(ids)
      saveFile(name, new Blob([text], { type: 'model/step' }))
      useStore.getState().setStatus(`${ids.length} bod${ids.length === 1 ? 'y' : 'ies'} exported to ${name} as a STEP solid.`)
    } catch (e) {
      useStore.getState().setError(`STEP export failed: ${message(e)}`)
    }
  }

  /** The visible solid bodies as an STL or a 3MF, meshed as the panel's
   *  resolution says (core/meshResolution) — for a printer, which meshes a
   *  STEP to its own tolerance (issue 89). */
  const exportMesh = async (format: MeshFormat) => {
    const re = useReverse.getState()
    const picked = re.bodies.filter((b) => b.visible && !b.surface)
    if (picked.length === 0 || !session.client()) {
      useStore.getState().setError('No visible solid body to export — build one first.')
      return
    }
    const res = meshResolution(useRePrefs.getState().meshResolution)
    const units = usePrefs.getState().units
    try {
      useStore.getState().setStatus(`Meshing the bodies, ${res.label.toLowerCase()} — ${fmtLen(res.chord, units)} and ${Math.round(res.angleDeg * 10) / 10}° at most…`)
      const f = await session.meshFile(picked, res.chord, format, res.angleDeg)
      if (!f) {
        useStore.getState().setError('The bodies meshed to no triangle.')
        return
      }
      saveFile(f.name, new Blob([f.bytes as BlobPart], { type: f.mimeType }))
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (const b of picked) {
        if (!b.box) continue
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], b.box.min[k])
          hi[k] = Math.max(hi[k], b.box.max[k])
        }
      }
      const tiny = tinyPartNote(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), (mm) => fmtLen(mm, units, 4))
      const said = `${picked.length} bod${picked.length === 1 ? 'y' : 'ies'} exported to ${f.name}, ${f.triangles.toLocaleString('en-US')} triangles (${res.label}).`
      if (tiny) useStore.getState().setError(`${said} ${tiny}`)
      else useStore.getState().setStatus(said)
    } catch (e) {
      useStore.getState().setError(`Mesh export failed: ${message(e)}`)
    }
  }

  /** The visible solid bodies as a reference part for the Deviation
   *  workspace — or the bodies named, a sheet among them meshed too (it is
   *  read on its front under the map's facing limit) — see core/re/compare. Null, with the reason on the status
   *  line, when there is nothing to compare. With the file, `mapMesh`: the
   *  bodies' viewport meshes merged — the map on the bodies reads them in
   *  place of the comparison's far finer mesh, at the spacings they serve
   *  (VIEW_MESH_MAP_SPACING) — or null. */
  const compareReference = async (bodyIds?: number[]): Promise<{ file: File; mapMesh: { positions: Float32Array; indices: Uint32Array } | null } | null> => {
    const re = useReverse.getState()
    const ids = bodyIds ?? re.bodies.filter((b) => b.visible && !b.surface).map((b) => b.id)
    const client = session.client()
    if (ids.length === 0 || !client) {
      useStore.getState().setError('No visible solid body to compare — build one first.')
      return null
    }
    try {
      useStore.getState().setStatus(`Meshing the bodies to a ${fmtLen(COMPARE_CHORD_MM, usePrefs.getState().units)} chord for the comparison…`)
      const stl = compareReferenceStl(await client.referenceMeshes(ids, COMPARE_CHORD_MM, true))
      if (!stl) {
        useStore.getState().setError('The bodies gave no triangles to compare against.')
        return null
      }
      const shown = ids.flatMap((id) => session.meshes.get(id) ?? [])
      const mapMesh = shown.length === ids.length ? mergeCompared(shown) : null
      return { file: new File([stl], COMPARE_REFERENCE_NAME, { type: 'model/stl' }), mapMesh: mapMesh && mapMesh.indices.length >= 3 ? mapMesh : null }
    } catch (e) {
      useStore.getState().setError(`The bodies could not be meshed for the comparison: ${message(e)}`)
      return null
    }
  }

  // In development the workspace's state and the slice under the sketch are
  // reachable from the console and the e2e scripts, for looking at a real
  // scan's sketch offline — nothing in a production build.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __re?: unknown }).__re = {
      store: useReverse,
      /** The kernel, the build and what it made — see reSession. */
      session,
      /** The Measure store beside it, for a script reading an element. */
      measure: useStore,
      chains: () => chainsRef.current,
      scene: () => sceneRef.current,
      /** The workspace's part of the viewport: its bodies, their picks, the
       *  sketches drawn on the part. */
      reScene: () => reScene(),
      sheet: () => sheetRef?.current ?? null,
      /** A body's faces and edges with their fingerprints, as last built. */
      topology: (id: number) => topologies.get(id) ?? null,
      /** A datum alignment applied the way a project's is on load — the
       *  scan's vertices, the viewport and the store together — for a
       *  script that has no faces to click for a 3-2-1. */
      alignTo: async (m: Rigid) => {
        const rigid: Rigid = { r: Float64Array.from(m.r), t: Float64Array.from(m.t) }
        await clientRef.current?.transform(rigid)
        sceneRef.current?.applyTransform(rigid)
        useStore.getState().applyAlignment(rigid)
      },
      /** The colour the scan wears at its vertex nearest a point, in the
       *  viewport's frame — what the live map painted there. */
      colorNear: (p: Vec3) => {
        const scene = sceneRef.current
        const pos = scene?.scanPositions()
        if (!scene || !pos) return null
        let best = -1, bestD = Infinity
        for (let v = 0; v < pos.length / 3; v++) {
          const d = (pos[v * 3] - p[0]) ** 2 + (pos[v * 3 + 1] - p[1]) ** 2 + (pos[v * 3 + 2] - p[2]) ** 2
          if (d < bestD) {
            bestD = d
            best = v
          }
        }
        return best < 0 ? null : scene.scanColorAt(best)
      },
    }
  }

  /** What the sketch being drawn can project: the edges of every body on
   *  show and the pieces of every other sketch on show, each as the piece
   *  it would become on the draft's plane — those that project at all —
   *  with what it is taken from, so it follows that (project.ts). */
  const projectablesOf = (): Projectable[] => {
    const re = useReverse.getState()
    const d = re.sketchDraft
    if (!d) return []
    const out: Projectable[] = []
    const take = (entity: EntityInput | null, source: string) => {
      if (!entity) return
      const polyline = entity.kind === 'point' ? [entity.p] : entityPolyline({ ...entity, id: 0 } as Parameters<typeof entityPolyline>[0], 64)
      out.push({ entity, polyline, source })
    }
    for (const b of re.bodies) {
      if (!b.visible) continue
      for (const edge of topologies.get(b.id)?.edges ?? []) {
        const e = projectEdge(edge, d.frame)
        take(e && { ...e, source: { body: b.id, edge: edge.fingerprint } }, `an edge of ${b.name}`)
      }
    }
    // A sketch further down the list than the one being edited is not
    // there yet where this one is built: its pieces are taken as they lie,
    // and stay so.
    const at = d.featureId === undefined ? re.features.length : re.features.findIndex((f) => f.id === d.featureId)
    re.features.forEach((f, i) => {
      if (f.kind !== 'sketch' || !f.visible || f.id === d.featureId) return
      for (const e of f.sketch.entities) {
        const p = projectSketchEntity(e, f.frame, d.frame)
        take(p && (i < at || at < 0 ? { ...p, source: { sketch: f.id, entity: e.id } } : p), `a piece of ${f.name}`)
      }
    })
    return out
  }

  /** The marking tools changed the marking while a surface's box is open:
   *  the marking is the region. */
  const regionPainted = (region: Uint32Array) => {
    regionShown.current = region
    useReverse.getState().setRegion(region)
  }

  return {
    /** The slice chains under the open sketch, or null while none are cut. */
    chainsOf: () => chainsRef.current,
    projectablesOf,
    regionPainted,
    exportStep,
    exportMesh,
    compareReference,
  }
}
