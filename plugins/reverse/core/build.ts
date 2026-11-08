// SPDX-License-Identifier: AGPL-3.0-only
// Running the feature list through the kernel. A build plays the steps in
// order — an extrude or a revolve makes faces of the profiles it picked, a
// solid of the faces, and joins it to every body it meets, cuts it out of
// them, or keeps it a body of its own — and ends with the bodies as kernel
// shapes, their meshes for the viewport, and a verdict per feature. One
// body is one solid: what a step leaves in pieces is a body a piece (see
// features.ts islandId). A step that fails says why and the build carries
// on: the later features that do not depend on it still stand, and the
// ones that do fail loudly in turn rather than quietly building on nothing.
// The state after every step is kept, and a build whose first steps are
// those of a kept one takes up from there (Builder.build).
//
// Runs wherever the kernel does — the worker in the browser, Node in the
// tests. Owns the kernel handles: a build's shapes are released once no
// kept build holds them.

import type { NominalSurface } from '../../../src/core/deviation/surface'
import { emptyHit } from '../../../src/core/deviation/surface'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, len, normalize, scale, sub } from '../../../src/core/vec'
import { frameKey, sketchFrameOn } from '../../../src/core/section/frame'
import { bodyMaker, farReach, frameMap, ISLAND_IDS, islandId, liftPoint, liftRegions, loftProfile, moveProfiles, profileMiddle, profilesMeetAxis, profileSpan, routeSweepGeometry, sketchPieces, sweepPath, toolsOf, type BuildStep, type VariableEdge, type FaceProfile, type PlaneGeometry, type TrimPrimitive } from './features'
import { grazingJoinsWords, lostPickWords, mendNearTangent, mendPoles, mendWords, type NearTangentJoin, openEndsWords, poleWords, profileAcrossAxis } from './profiles'
import { foldWords, loftFoldRefusal, sectionsNormal } from './loftFold'
import { composeHistory, rectangleLoop, type FaceHistory, type KernelMesh, type LoopPiece, type ReKernel, type Shape, type StepCheck, type StepLabel, type StepMend, type StepPart, type Tracked } from './kernel'
import { mergeMeshes, movedMesh } from './move'
import { cloneSketch, type ProjectionSource, type Sketch } from './sketch'
import { datumTraces } from './datums'
import { projectEdge, projectSketchEntity, retake, retakeMoved } from './project'
import { findRegions, lostPicks, matchRegions, type Region, regionsByPick, samePick } from './regions'
import { solveSketch } from './solver'
import { carriedHeight, fitSurfaceReported, GRID_AREA_SLACK, GRID_RETRIES, gridArea, gridOf, meshTriangles, reachingGridOf, reachOver, StraysRefusal, type SurfaceFitResult } from './surfaceFit'
import { fieldAt, type NearScan, offPastRegion, PAST_REGION_MM, pastRegion, regionOutline } from './surfaceRegion'
import { constrainCylinder, constrainPlane, cylinderPatch, planePatch, type ConstrainRef } from './autoConstrain'
import { surfaceOfMeshes } from './liveMap'
import { describeEdge, describeFace, edgeDistance, faceDistance, matchEdge, matchFace, matchTolerance, type MatchTolerance, splitEdges, tangentChain, type EdgeFingerprint, type FaceFingerprint } from './topo'
import { livePicks, runStoredWhere, sharpBySurfaces, type StoredPick, whereWords } from './where'
import { type Body, bodyBrief, type BodyCheck, type BodyStep, boxesMeet, type BuildResult, type BuildSteps, type BuiltBody, type Diagnosis, diagonalOf, type DrawnBody, type DrawnBuild, type EdgeBrief, type EdgeInfo, type FaceInfo, type FeatureResult, type FilletTries, type FilletTry, halton, type KeptBuild, type Look, meshBox, meshDeflection, type Overlap, pickEach, type PlacedSketch, type PrefixNode, type PreviewResult, type PreviewStep, type RoundTrip, type RoundTripFind, type SketchStep, type Snapshot, type SolidStep, SPLIT_SAMPLES, stepKeys, surfaceMeshDeflection, SURFACE_TRIANGLES, type OffScanReport, type SurfaceReport, type TrimReport } from './buildTypes'
import { cylinderSolid, primitiveSolid } from './primitives'
import { extrudeUpTo, fuseAll, outlineOf, reachAlong, taperedPrism, taperLimitOf, taperRefusal, trimByPlanes } from './buildExtrude'
import { NOTHING, noteRead, ReadMap, readsStand, ReadSet, replay, type StateName, type StepReads } from './buildReads'
import { objectsOf, readPart, type PartExport, type Tokens, writePart } from './buildTransfer'
import { diagnoseDraft, diagnoseOffset, diagnoseRound, diagnoseShell, faceMiddle, NO_AREA_MM2, roundDiagnosisBudget, shellDiagnosisBudget, withoutCallName } from './diagnose'
import { thickenFolds, thickenWay, wallSaid } from './diagnoseThicken'
import type { Thickened } from './kernelThicken'
import type { BodyProbe, CutPiece } from './kernelProbe'
import { angledAsk, referenceFaces, type SidedChamfer } from './chamferSides'
import { sameSurface } from './kernelMath'
import type { RawFace } from './kernelTypes'
import { sharedSolid } from './overlapMesh'
import { volumeRefusal, type GuardAsk } from './booleanGuard'
import { type PieceSaid, planeWords, sideOfBox, SPLIT_TIE, splitWords, takesAllWords } from './splitWords'
import { FUZZY_COARSE_MM, FUZZY_MM, isTrap, KernelError, KernelTrap } from './kernelOps'
import { edgesAsked, type TrapEdges } from './trapEdges'
import { copyMarkOf, copyMotions, markCopy, traceCopies } from './patternCopies'
import type { ManifoldToplevel } from 'manifold-3d'
import { HAIR_MM, JOINING, stepsOfJoin, type StepBetween } from './stepsBetween'
import { cutElsewhereWords, cutsElsewhere } from './cutElsewhere'
import { ScanPaths } from '../../../src/core/geometry/scanPath'
import { type NetworkBodies, type NetworkReading, readNetwork } from './network'
import { emptyReport, networkBody, networkGhost, type NetworkReport } from './networkBody'
export { type BodyBrief, type BodyCheck, type BodyStep, type BuildResult, type BuildSteps, type BuiltBody, type Diagnosis, type DrawnBody, type EdgeBrief, type EdgeInfo, type FaceInfo, type FeatureResult, type FilletTries, type FilletTry, type Overlap, type PreviewResult, type PreviewStep, type SketchStep, type SolidStep, stepKeys, type SurfaceReport, type TrimReport } from './buildTypes'

/** How far out of the face a hole drilled into one starts, mm. */
const HOLE_LEAD_MM = 0.01

/** How many picks found again only loosely a row names. */
const LOOSE_NAMED = 4

/** How far a projected piece taken again has to have moved, millimetres,
 *  for the sketch to be solved again on it: a hair under what the kernel
 *  tells apart, so the same edge taken again is the same piece. */
const RETAKE_MOVED_MM = 1e-7
/** How close a projected piece with no source has to lie to an edge of
 *  its face to be given that edge as its source, millimetres: the edge's
 *  drawing is in 32-bit floats, good to a hundredth of a micron. */
const ADOPT_MM = 1e-5

/** What the states the builder keeps may hold, bytes of the shapes'
 *  BREP — the build standing's are kept whatever they come to. In the
 *  kernel's memory a shape takes several times its BREP, its meshes with
 *  it. */
export const CACHE_BYTES = 96 * 2 ** 20

/** How long a Combine may have taken, ms, for the builder to work out what
 *  its two bodies share on its own for the volume identity — another
 *  boolean as long again; past it the result is held to its bounds alone
 *  (booleanGuard.ts). */
const IDENTITY_CHECK_MS = 1000

/** How many steps' play times are kept, the oldest let go first. */
const PLAY_TIMES = 2000

/** The thinnest two bodies may share, on average, and be said to overlap,
 *  mm: under it what the kernel finds between them is its tolerance at a
 *  face they both lie on, not material of both. */
const OVERLAP_MIN_THICKNESS = 1e-4

/** How narrow a face a Combine made may be, mm, before it is a sliver
 *  (sliversOf): twice its area over its perimeter, a strip's width. The
 *  lamp's were 0.4 µm wide; a face a hundredth of a millimetre wide is
 *  never one the part has. */
const SLIVER_MM = 0.01

/** A face a shell made under this area, mm², is warned of as a sliver too
 *  — reverse.body.check's own `tinyArea` by default. */
const TINY_FACE_MM2 = 0.01

/** How long reverse.body.check { roundTrip: "find" } writes and reads
 *  back the stages of a body, ms, before it answers with as far as it got. */
const ROUND_TRIP_FIND_MS = 30_000

/** A failure's note on what changed since it built names this many features
 *  at most (withChangesSaid). */
const CHANGES_NAMED = 5

/** How long filletTry goes on beginning sizes, ms: under the client's limit
 *  on a heavy request, for one size more may run past it. */
export const FILLET_TRY_MS = 240_000

/** How many odd edges a body check keeps (the counts count all). */
const ODD_EDGES_KEPT = 50

/** Up to how many faces a body check without roundTrip writes the body as
 *  STEP and reads it back for its edges (BodyCheck.readBack): a few tenths
 *  of a second at 170 faces. */
const READ_BACK_FACES = 3000

/** How near two sheets a split keeps the wall between may come, mm, and be
 *  said to meet there: the kernel's own precision, far under any wall. */
const MEET_MM = 1e-3

/** How many points along where two sheets cross are tried for one inside
 *  the body they split. */
const MEET_SAMPLES = 64

/** How far apart the pieces of one sheet may lie and still be sewn into
 *  one, mm: they share the edges the cut left, a hair apart at most. */
const SHEET_SEW_MM = 1e-3

/** How far apart two sheets joined may lie along where they meet, tried
 *  one after another, mm: each was split by the other, one of them carried
 *  on to reach — a surface of its own through its fit's points, 0.9 µm off
 *  the fit on a curved L — so their edges there are worked out twice. Far
 *  under anything a part means. */
const SHEET_JOIN_MM = [SHEET_SEW_MM, 0.01, 0.05]

/** An area in words: whole mm², or in powers of ten past a million — what
 *  a surface swung wild comes to. */
const areaWords = (x: number): string => (x >= 1e6 ? x.toExponential(1).replace('e+', 'e') : String(Math.round(x)))

/** What two bodies share, as Builder.overlaps keeps it: the solid meshed
 *  and its volume — or null for nothing. */
type Shared = { volume: number; mesh: KernelMesh } | null

export class Builder {
  private bodies = new Map<number, Body>()
  /** Bodies gone into another in this build — joined by a feature that
   *  bridged them, combined into it — by the id of the one each went into:
   *  a later feature naming the one gone finds what it became. */
  private aliases = new Map<number, number>()
  /** Every body id given out in this build, so a further body of a step
   *  takes a fresh one. */
  private issued = new Set<number>()
  /** The further bodies a step split off a body, by the body's id — the
   *  copies a pattern made of a plug stood apart, a bar cut at its waist.
   *  A Combine naming the body takes them with it (familyOf). */
  private pieces = new Map<number, number[]>()
  /** The scan as a surface to test split fragments against — set by the
   *  worker once the scan is over; null in a build with no scan, where
   *  a split keeps its largest fragment instead. */
  private scan: NominalSurface | null = null
  /** The scan's vertices, the frame the bodies are built in — what a
   *  surface is fitted through, by the region's indices. */
  private scanPositions: Float32Array | null = null

  /** The builder's state after every step of the builds it made, in a
   *  tree of steps by their keys (stepKeys) from the first: what a build
   *  takes up from — the longest run of its first steps the tree holds a
   *  state for — and what a step is taken over from (takeOver). The build
   *  standing's states are always held; the others are let go, the oldest
   *  used first and a branch from its far end, once the shapes held pass
   *  the budget (cacheBudget). A shape is released with the last state
   *  that holds it. The root stands for no step at all. */
  private tree: PrefixNode = { key: '', parent: null, children: new Map(), state: null, reads: null, used: 0 }
  /** The build standing: a state for every one of its steps. Without keys
   *  — asked for without `reuse`, or built against another scan — it is in
   *  no tree, and nothing takes up from it. */
  private standing: KeptBuild | null = null
  /** The tree's nodes by their step's key, for takeOver. */
  private byKey = new Map<string, Set<PrefixNode>>()
  /** How many hold each state — a node of the tree, the build standing —
   *  and each shape — the states held that hold it — and what the shapes
   *  held come to (shapeBytes). */
  private holders = new Map<Snapshot, number>()
  private shapeHolders = new Map<number, number>()
  private shapeBytes = new Map<number, number>()
  private heldBytes = 0
  /** Counts the tree's uses, for letting the oldest used go first. */
  private clock = 0
  /** What the states kept may hold, bytes of BREP — see CACHE_BYTES. */
  cacheBudget = CACHE_BYTES
  /** What the last build did: the steps it played, and those it took up
   *  from a state held or took over from another build, of how many. */
  lastSteps: BuildSteps = { recomputed: 0, restored: 0, of: 0, played: [] }
  /** A body's faces and edges as read, by the body and the chord they were
   *  sampled to — a body is never changed, so a step that picks on it and
   *  a build that hands it over read it once. */
  private topologies = new WeakMap<Body, Map<number, { faces: FaceInfo[]; edges: EdgeInfo[] }>>()
  /** A body's size — its box's diagonal — by the body, read once. */
  private diagonals = new WeakMap<Body, number>()
  /** What the step playing has read of the state so far — see takeOver. */
  private reading: StepReads | null = null
  /** What the step playing did its own way that its row should say — a
   *  boolean accepted on a second try, a pick found by where it lies —
   *  joined into its result's warning (playFrom). */
  private stepWarnings: string[] = []
  /** The step the kernel trapped on, by its id — the build stops there and
   *  the kernel is not asked anything more (reService.ts). */
  trappedOn: number | null = null
  /** Told each step's id before it is played, and null once the steps
   *  asked for are played — what the worker tells the page, which can then
   *  say which step a build that never finished was on, and stop it
   *  (reService.ts). */
  onStep: ((id: number | null) => void) | null = null
  /** The edges the step the kernel trapped on was rounding or chamfering,
   *  for the step's failure to say where (trapEdgesText); null for any
   *  other step. */
  trapEdges: TrapEdges | null = null
  /** The edges the step playing hands the kernel to round or chamfer,
   *  read before it is asked — after a trap nothing more is. */
  private edgesInPlay: TrapEdges | null = null
  /** The names of the steps of the builds played, by id — what a failure
   *  names a step by (inputFault). */
  private names = new Map<number, string>()
  /** The smooth lofts the builds played, by id — whose faces a body check
   *  and an empty intersect read for a fold (loftFold.ts). */
  private smoothLofts = new Set<number>()
  /** A step's name by its id, as the builds played named it — what a
   *  diagnosis names a feature by. */
  nameOf(id: number): string | undefined {
    return this.names.get(id)
  }
  /** The Combine — a cut or an intersect — that took the body a feature
   *  made in as its tool and went into `body`, played before step
   *  `before`: a face that feature made is then a bounding face of that
   *  helper body, left on the part by the Combine — or null, the face the
   *  feature's own. The tool's makers are the feature that made it and
   *  those that worked on it since, not the tools it was itself cut by:
   *  a block trimmed by a cylinder bounds the cut with its planes, and the
   *  cylinder's face is the wall meant. */
  helperOf(maker: number, body: number, before: number): { tool: number; by: number; op: 'cut' | 'intersect' } | null {
    const steps = this.stepsInPlay
    const end = steps.findIndex((s) => s.id === before)
    const played = end < 0 ? steps : steps.slice(0, end)
    for (const [i, s] of played.entries()) {
      if (s.kind !== 'boolean' || s.op === 'join' || bodyMaker(s.body) !== bodyMaker(body)) continue
      for (const t of toolsOf(s)) {
        const tool = bodyMaker(t)
        const makers = new Set([tool, ...played.slice(0, i).flatMap((o) => (o.kind !== 'boolean' && 'body' in o && o.body === t ? [o.id] : []))])
        if (makers.has(maker)) return { tool, by: s.id, op: s.op }
      }
    }
    return null
  }
  /** Each offered part's steps by key, for takeOver (indexOf). */
  private keyIndex = new WeakMap<KeptBuild, { keys: string[]; at: Map<string, number> }>()
  /** Parts of the next build built beforehand — here or on a helper
   *  kernel — for it to take steps over from (buildPart, offer); let go
   *  of once it has been built. */
  private offered: KeptBuild[] = []
  /** The objects read in from other kernels' parts, by kernel and token:
   *  the same object every time a part names it, for as long as a kept
   *  build holds it. */
  private imported = new Map<string, Map<number, unknown>>()
  /** How long each step took the last time it was played, ms, by key —
   *  what the steps are shared out between kernels by (reParallel.ts). */
  readonly playMs = new Map<string, number>()
  /** What each body was handed to the viewport as, meshed and read, by the
   *  body — the same body in the next build is not meshed again. A copy
   *  goes out: the worker hands the buffers on rather than copy them. */
  private shown = new WeakMap<Body, DrawnBody>()
  /** This builder's mark on the keys it gives the bodies it meshes, and
   *  the count after it — see BuiltBody.key. */
  private readonly keyMark = Math.random().toString(36).slice(2, 8)
  private keysGiven = 0
  /** What two bodies share, worked out once for the two as they stand —
   *  see overlaps — and each body's box. */
  private shares = new WeakMap<Body, WeakMap<Body, Shared>>()
  private boxes = new WeakMap<Body, { min: Vec3; max: Vec3 }>()

  /** The scan prepared for paths along it, for a patch network: made the
   *  first time a network is built on this scan. */
  private paths: ScanPaths | null = null

  setScan(surface: NominalSurface | null, positions: Float32Array | null = null): void {
    this.scan = surface
    this.scanPositions = positions
    this.paths = null
    // A split and a trim test against the scan: built against another one,
    // the same steps may not come out the same. The build standing stays —
    // its bodies are still what an export or a preview works on — but
    // nothing takes up from it, and the next build lets it go; the rest of
    // the tree goes now.
    if (this.standing) this.standing.keys = []
    this.clearTree()
  }

  /** Every state of the tree let go, but for what the build standing
   *  holds. */
  private clearTree(): void {
    const all: PrefixNode[] = []
    const visit = (n: PrefixNode) => {
      for (const c of n.children.values()) {
        all.push(c)
        visit(c)
      }
    }
    visit(this.tree)
    for (const n of all) if (n.state) this.dropState(n)
    this.tree = { key: '', parent: null, children: new Map(), state: null, reads: null, used: 0 }
    this.byKey.clear()
  }

  /** The share of a shape's surface lying within `tolerance` of the scan, by
   *  area: about SPLIT_SAMPLES points spread over a coarse mesh of it, each
   *  triangle given points in proportion to its area and each point that
   *  share of the triangle's. By area and not by triangle: a flat face is
   *  two triangles however large, and the plug of a pocket — four walls on
   *  the scan, a roof and a floor where the scan has nothing — counted
   *  eight triangles on and four off. Null with no scan to test against. */
  private onScanShare(shape: Shape, tolerance: number, leaveOut?: (p: Vec3) => boolean): number | null {
    const scan = this.scan
    if (!scan) return null
    const k = this.kernel
    const hit = emptyHit()
    const mesh = k.mesh(shape, meshDeflection(diagonalOf(this.kernel, shape)) * 4)
    const p = mesh.positions
    const tris = mesh.indices.length / 3
    const every = Math.max(1, Math.floor(tris / SPLIT_SAMPLES))
    const areas = new Float64Array(tris)
    let whole = 0
    for (let t = 0; t < tris; t += every) {
      const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3
      const n = cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]])
      areas[t] = Math.hypot(n[0], n[1], n[2]) / 2
      whole += areas[t]
    }
    if (!(whole > 0)) return 0
    let on = 0
    // What `leaveOut` leaves out counts neither way.
    let read = 0
    for (let t = 0; t < tris; t += every) {
      if (!(areas[t] > 0)) continue
      const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3
      const count = Math.max(1, Math.round((SPLIT_SAMPLES * areas[t]) / whole))
      let hits = 0
      let taken = 0
      for (let i = 0; i < count; i++) {
        // The Halton points of bases 2 and 3, folded into the triangle: the
        // same points every build, spread evenly whatever their number.
        let u = count === 1 ? 1 / 3 : halton(i + 1, 2)
        let v = count === 1 ? 1 / 3 : halton(i + 1, 3)
        if (u + v > 1) {
          u = 1 - u
          v = 1 - v
        }
        const w = 1 - u - v
        const x = w * p[a] + u * p[b] + v * p[c], y = w * p[a + 1] + u * p[b + 1] + v * p[c + 1], z = w * p[a + 2] + u * p[b + 2] + v * p[c + 2]
        if (leaveOut?.([x, y, z])) continue
        taken++
        if (scan.closest(x, y, z, hit, tolerance)) hits++
      }
      on += (areas[t] * hits) / count
      read += (areas[t] * taken) / count
    }
    return read > 0 ? on / read : 0
  }

  /** The box a trim cuts up: round the scan, grown a tenth each way, or
   *  round the tools when there is no scan. */
  private trimBox(tools: readonly Shape[]): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    const take = (p: Vec3) => {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i]
        if (p[i] > max[i]) max[i] = p[i]
      }
    }
    const scan = this.scanPositions
    if (scan && scan.length >= 3) for (let i = 0; i < scan.length; i += 3) take([scan[i], scan[i + 1], scan[i + 2]])
    else
      for (const t of tools) {
        const b = this.kernel.bounds(t)
        take(b.min)
        take(b.max)
      }
    if (!Number.isFinite(min[0])) throw new Error('Nothing to trim round — no scan and no tool has an extent.')
    const grow = Math.max(1, 0.1 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
    return { min: [min[0] - grow, min[1] - grow, min[2] - grow], max: [max[0] + grow, max[1] + grow, max[2] + grow] }
  }

  /** A measured element as a trim tool, reaching past the box: a plane a
   *  face across it, a cylinder or a cone stretched along its axis to the
   *  box's diagonal (a cone no further than its apex), a sphere itself. */
  private trimPrimitive(p: TrimPrimitive, diagonal: number): Shape {
    const k = this.kernel
    const reach = diagonal * 1.5
    switch (p.kind) {
      case 'plane': {
        const u = normalize(p.basisU) ?? [1, 0, 0]
        const v = normalize(p.basisV) ?? [0, 1, 0]
        const corner = addScaled(addScaled(p.origin, u, -reach), v, -reach)
        return k.face({ outer: rectangleLoop(corner, u, v, 2 * reach, 2 * reach), holes: [] })
      }
      case 'cylinder':
        return cylinderSolid(this.kernel, p.origin, p.axis, p.radius, -reach, reach)
      case 'cone': {
        // The radii run linearly along the axis; each end goes out to the
        // reach, or to where the radius would reach zero.
        const slope = (p.radius2 - p.radius1) / Math.max(p.length, 1e-6)
        let from = -reach, to = reach
        const r = (t: number) => p.radius1 + slope * (t + p.length / 2)
        if (r(from) < 1e-3) from = -p.length / 2 - (p.radius1 - 1e-3) / Math.max(-slope, 1e-9)
        if (r(to) < 1e-3) to = p.length / 2 + (p.radius2 - 1e-3) / Math.max(slope, 1e-9)
        from = Math.max(from, -reach)
        to = Math.min(to, reach)
        const n = normalize(p.axis) ?? [0, 0, 1]
        return primitiveSolid(this.kernel, { kind: 'cone', origin: addScaled(p.origin, n, (from + to) / 2), axis: n, radius1: r(from), radius2: r(to), length: to - from })
      }
      case 'sphere':
      case 'torus':
        return primitiveSolid(this.kernel, p)
    }
  }

  /** The automatic trim: a box round the scan split by every tool, the
   *  faces that makes tested against the scan, the ones lying on it sewn
   *  — a solid when they close, a surface body of the kept faces with its
   *  open edges otherwise. See features.ts TrimFeature. */
  private trimOf(step: Extract<BuildStep, { kind: 'trim' }>): { shape: Shape; report: TrimReport; surface: boolean } {
    const k = this.kernel
    if (!this.scan) throw new Error('The scan is not here to trim against.')
    const tools: Shape[] = []
    const made: Shape[] = []
    try {
      // A surface fitted as a plane or a cylinder cuts as the whole plane or
      // cylinder, like a measured element: its drawn patch ends where its
      // region did, grown by a share, and two such patches need not reach
      // each other at a corner the scan rounded off.
      const whole: TrimPrimitive[] = []
      for (const id of step.bodies) {
        const b = this.bodyById(id)
        if (!b) throw new Error('A surface this trim closes is gone, or failed to build.')
        const p = this.fittedFor(id, b, 'trim')
        if (p) whole.push(p)
        else tools.push(b.shape)
      }
      const box = this.trimBox(tools)
      const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])
      for (const p of [...whole, ...step.primitives]) {
        const s = this.trimPrimitive(p, diagonal)
        made.push(s)
        tools.push(s)
      }
      const solidBox = k.box(box.min, box.max)
      made.push(solidBox)
      const faces = k.splitFaces(solidBox, tools)
      const kept: Shape[] = []
      for (const f of faces) {
        const share = this.onScanShare(f, step.tolerance)
        if (share !== null && share >= step.overlap) kept.push(f)
        else k.release(f)
      }
      // units-ok: build message, also the agent's answer
      if (kept.length === 0) throw new Error(`None of the ${faces.length} faces the tools cut lies on the scan within ${step.tolerance} mm — widen the tolerance, or add the surfaces the part still lacks.`)
      const sewn = k.sewFaces(kept, step.tolerance)
      k.release(...kept)
      const closed = k.isClosedSolid(sewn)
      const openEdges = closed ? [] : k.edges(sewn, meshDeflection(diagonalOf(this.kernel, sewn))).filter((e) => e.faceHashes.length < 2).map((e) => e.polyline)
      return { shape: sewn, report: { faces: faces.length, kept: kept.length, closed, openEdges }, surface: !closed }
    } finally {
      k.release(...made)
    }
  }

  /** The plane or cylinder a surface was fitted as, for its sheet `b` to
   *  stand for: in a trim (`trim`) while the sheet is as fitted, and in a
   *  split's carrying on (`reach`) while it is still all on that surface —
   *  as fitted, or trimmed, carried on from the whole of it as a trimmed
   *  freeform is. A sheet joined to another is no longer that surface: it
   *  cuts as it is. */
  private fittedFor(id: number, b: Body, use: 'trim' | 'reach'): TrimPrimitive | undefined {
    if (b.reshaped === 'joined' || (b.reshaped && use === 'trim')) return undefined
    return this.fitted.get(id)
  }

  /** A split's sheets carried on to reach over the body (`shape`, named
   *  `into`): a freeform surface along the slope at its edge (surfaceFit
   *  reachingGridOf), a surface fitted as a plane as that plane, wide
   *  enough — over the body's own points, not its box's corners
   *  (reachOver). A sheet drawn from a sketch, or a cylinder, stays as it
   *  is. A freeform carried on is held to its grid as faceThrough holds a
   *  fitted one — its area within GRID_AREA_SLACK of the grid's — and
   *  refused, named, where the kernel's surface through the grid swings
   *  wild: the split by it would not come back. Null when none was carried
   *  on; the shapes made are the caller's to release. */
  private reachingTools(ids: readonly number[], shape: Shape, into: string): { tools: Shape[]; made: Shape[] } | null {
    const k = this.kernel
    const box = k.extent(shape)
    const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])
    const margin = 0.05 * diagonal + 1
    const points = k.mesh(shape, meshDeflection(diagonal) * 4).positions
    const tools: Shape[] = []
    const made: Shape[] = []
    try {
      for (const id of ids) {
        const b = this.bodyById(id)!
        const p = this.fittedFor(id, b, 'reach')
        let carried: Shape | null = null
        if (b.fit) {
          const reach = reachOver(b.fit, points, margin)
          // A sheet trimmed since it was fitted — split by another, or by
          // a solid — is carried on from the whole of its fit, even where
          // the fit spans the body already.
          const whole = !reach && k.surfaceArea(b.shape) * GRID_AREA_SLACK < gridArea(gridOf(b.fit))
          if (reach || whole) {
            // A denser grid where the kernel's surface through the first
            // swings off it, as faceThrough tries: a band carried a few
            // millimetres on to the outline of a split within its region
            // came back with three times its area at three a span.
            let area = 0
            let want = 0
            for (const perSpan of [undefined, ...GRID_RETRIES]) {
              const grid = reach ? reachingGridOf(b.fit, reach.u, reach.v, perSpan) : gridOf(b.fit, perSpan)
              const through = k.surfaceThrough(grid.points, grid.rows, grid.cols)
              area = k.surfaceArea(through)
              want = gridArea(grid)
              if (!(area / want > GRID_AREA_SLACK)) {
                carried = through
                made.push(carried)
                break
              }
              k.release(through)
            }
            // units-ok: build message, also the agent's answer.
            if (!carried) throw new Error(`${b.name} carried on to ${into} comes out wild at every grid tried (${areaWords(area)} mm² against the ${areaWords(want)} it should have) — fit it with an expandPct that reaches, or trim ${into} to where the sheet is.`)
          }
        } else if (p?.kind === 'plane') {
          // The plane's rectangle over the body's points, in its own axes.
          const reach = reachOver({ origin: p.origin, axisU: p.basisU, axisV: p.basisV, uRange: [0, 0], vRange: [0, 0] }, points, margin)!
          const corner = addScaled(addScaled(p.origin, p.basisU, reach.u[0]), p.basisV, reach.v[0])
          carried = k.face({ outer: rectangleLoop(corner, p.basisU, p.basisV, reach.u[1] - reach.u[0], reach.v[1] - reach.v[0]), holes: [] })
          made.push(carried)
        }
        tools.push(carried ?? b.shape)
      }
    } catch (e) {
      k.release(...made)
      throw e
    }
    if (made.length === 0) return null
    return { tools, made }
  }

  /** A patch network read off the scan and fitted — see network.ts — or,
   *  where no cell could be filled, why, with what the cells came to. */
  private networkReading(step: Extract<BuildStep, { kind: 'network' }>): NetworkReading | { message: string; report: NetworkReport } {
    if (!this.scan || !this.scanPositions) throw new Error('The scan is not here to draw a patch network on.')
    if (!this.paths) this.paths = new ScanPaths(this.scanPositions, this.scan.index)
    // The bodies it rests on, as they stand before it: an edge by its
    // fingerprint as its points; a face's normals by the kernel.
    const topologyOf = (id: number) => {
      const b = this.bodyById(id)
      if (!b) return null
      const diagonal = this.diagonal(b)
      return { body: b, topology: this.topology(b, meshDeflection(diagonal)), tol: matchTolerance(diagonal) }
    }
    const bodies: NetworkBodies = {
      edge: (id, fp) => {
        const t = topologyOf(id)
        if (!t) return null
        const i = matchEdge(fp, t.topology.edges.map((e) => e.fingerprint), t.tol)
        return i === null ? null : t.topology.edges[i].polyline
      },
      normals: (id, fp, points) => {
        const t = topologyOf(id)
        if (!t) return null
        const i = matchFace(fp, t.topology.faces.map((f) => f.fingerprint), t.tol)
        return i === null ? null : this.kernel.faceNormals(t.body.shape, t.topology.faces[i].hash, points)
      },
    }
    const reading = readNetwork(this.paths, step, bodies)
    if (!reading.fit) {
      const refused = reading.outcomes.find((o) => 'refused' in o)
      const message =
        step.cells.length === 0
          ? 'No cell is filled yet — click inside a region the curves close, or Fill all.'
          : `No cell could be filled${refused && 'refused' in refused ? `: ${refused.refused}` : ''}.`
      return { message, report: emptyReport(reading) }
    }
    return reading
  }

  /** A patch network read off the scan and made a body — see network.ts
   *  and networkBody.ts — or, where no cell could be filled, why, with what
   *  the cells came to. */
  private networkOf(step: Extract<BuildStep, { kind: 'network' }>): { shape: Shape; report: NetworkReport; patches: Map<number, number> } | { message: string; report: NetworkReport } {
    const reading = this.networkReading(step)
    if ('message' in reading) return reading
    // A body that cannot be made of the patches says why, with what the
    // cells and the fit came to.
    try {
      const { shape, report, faceOf } = networkBody(this.kernel, reading)
      return { shape, report, patches: faceOf }
    } catch (e) {
      if (isTrap(e)) throw e
      return { message: e instanceof Error ? e.message : String(e), report: emptyReport(reading) }
    }
  }

  /** A surface fitted through the step's region of the scan, as a face,
   *  with the fit's report. */
  private surfaceOf(step: Extract<BuildStep, { kind: 'surface' }>): { face: Shape; report: SurfaceReport; primitive?: TrimPrimitive; fit?: SurfaceFitResult } {
    const scan = this.scanPositions
    if (!scan) throw new Error('The scan is not here to fit a surface through.')
    const region = step.region
    const xyz = new Float32Array(region.length * 3)
    const count = scan.length / 3
    for (let i = 0; i < region.length; i++) {
      const v = region[i]
      if (v >= count) throw new Error('The region names a vertex the scan does not have — it was marked on another scan.')
      xyz[i * 3] = scan[v * 3]
      xyz[i * 3 + 1] = scan[v * 3 + 1]
      xyz[i * 3 + 2] = scan[v * 3 + 2]
    }
    if (step.shape === 'plane' || step.shape === 'cylinder') return this.primitiveSurface(step, xyz)
    const { fit, worst, dropped, strays } = fitSurfaceReported(xyz, step.fit, step.facing)
    const face = this.faceThrough(fit)
    const past = this.pastRegionOf(fit)
    return { face, report: { rms: fit.rms, max: fit.max, net: fit.net, points: region.length, worst, ...(step.fit.robust ? { dropped } : {}), ...(strays ? { strays } : {}), ...(past ? { pastRegion: past } : {}) }, fit }
  }

  /** The scan's nearest point to a point within `reach`, or null — for
   *  reading a surface against the scan under it (surfaceRegion.ts). */
  private nearScan(reach: number): NearScan | null {
    const scan = this.scan
    if (!scan) return null
    const hit = emptyHit()
    return (p) => (scan.closest(p[0], p[1], p[2], hit, reach) ? [hit.px, hit.py, hit.pz] : null)
  }

  /** How far a fitted surface stands off the scan past its region, said
   *  on the row past PAST_REGION_MM: a split by it carries its margin into
   *  the part (surfaceRegion.ts). */
  private pastRegionOf(fit: SurfaceFitResult): { off: number; at: Vec3 } | undefined {
    const extent = Math.max(fit.uRange[1] - fit.uRange[0], fit.vRange[1] - fit.vRange[0])
    const near = this.nearScan(Math.max(1, 0.25 * extent))
    const past = near ? pastRegion(fit, near) : null
    if (!past) return undefined
    const out = { off: Math.round(past.off * 1000) / 1000, at: past.at.map((x) => Math.round(x * 100) / 100) as Vec3 }
    if (past.off > PAST_REGION_MM) {
      // units-ok: build message, also the agent's answer
      this.stepWarnings.push(`Past its region the surface stands up to ${past.off.toFixed(2)} mm off the scan, at (${out.at.join(', ')}) — its margin follows the fit, not the scan, and a split by it carries that into the part. Take less margin (expandPct), mark the region out to where the surface has to go, or split within the region (split within).`)
    }
    return out
  }

  /** The kernel's face through a fitted surface, checked before anything
   *  meshes it: that it follows the fit — its area within GRID_AREA_SLACK
   *  of the grid's, a denser grid tried when not (surfaceFit
   *  GRID_RETRIES) — and that it meshes to no more than SURFACE_TRIANGLES
   *  at the finest chord it is meshed to. */
  private faceThrough(fit: SurfaceFitResult): Shape {
    const k = this.kernel
    let area = 0
    let off = 0
    for (const perSpan of [undefined, ...GRID_RETRIES]) {
      const grid = gridOf(fit, perSpan)
      const face = k.surfaceThrough(grid.points, grid.rows, grid.cols)
      area = gridArea(grid)
      off = k.surfaceArea(face) / area
      if (!(off > GRID_AREA_SLACK)) {
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        grid.points.forEach((x, i) => {
          min[i % 3] = Math.min(min[i % 3], x)
          max[i % 3] = Math.max(max[i % 3], x)
        })
        const chord = meshDeflection(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
        const triangles = meshTriangles(fit, chord)
        if (triangles > SURFACE_TRIANGLES) {
          k.release(face)
          // units-ok: build message, also the agent's answer
          throw new Error(`The surface would mesh to about ${Math.round(triangles / 1000)} k triangles at its ${chord} mm chord, more than ${SURFACE_TRIANGLES / 1000} k — it bends too often for its size. Fit a coarser net, or smooth it more.`)
        }
        return face
      }
      k.release(face)
    }
    // units-ok: build message, also the agent's answer.
    throw new Error(`The kernel's surface through the fit does not follow it: ${off > 100 ? `${Math.round(off)} times` : `${Math.round((off - 1) * 100)} % more than`} the fit's ${Math.round(area)} mm² of area, at every grid it was given. Fit another net, or keep the region to one surface.`)
  }

  /** A plane or a cylinder through the region, held to the references
   *  (core/re/autoConstrain) — the step's own and the planes and cylinders
   *  the surfaces before it came out as — and drawn as an exact face round
   *  where the points are. What was fitted is handed back beside the face:
   *  a later fit is held to it, and a trim cuts with the whole of it. */
  private primitiveSurface(step: Extract<BuildStep, { kind: 'surface' }>, xyz: Float32Array): { face: Shape; report: SurfaceReport; primitive: TrimPrimitive } {
    const k = this.kernel
    const refs: ConstrainRef[] = [...step.refs]
    for (const s of step.refSurfaces) {
      const p = this.fitted.get(s.id)
      if (!p) continue
      if (p.kind === 'plane') refs.push({ key: `surface:${s.id}`, kind: 'plane', name: s.name, origin: p.origin, normal: p.normal })
      else if (p.kind === 'cylinder') refs.push({ key: `surface:${s.id}`, kind: 'axis', name: s.name, origin: p.origin, dir: p.axis })
    }
    const points = xyz.length / 3
    if (step.shape === 'plane') {
      const fit = constrainPlane(xyz, refs, step.constrain)
      if (!fit) throw new Error('The region has no plane through it — its points lie in a line.')
      const patch = planePatch(xyz, fit, step.fit.expandPct)
      const face = k.face({ outer: rectangleLoop(patch.corner, patch.u, patch.v, patch.width, patch.height), holes: [] })
      return {
        face,
        report: { rms: fit.rms, max: fit.max, net: { u: 0, v: 0 }, points, shape: 'plane', rmsFree: fit.rmsFree, relations: fit.relations },
        primitive: { kind: 'plane', origin: fit.origin, normal: fit.normal, basisU: patch.u, basisV: patch.v },
      }
    }
    const fit = constrainCylinder(xyz, refs, step.constrain)
    if (!fit) throw new Error('No cylinder was found through the region — mark more of the round, or fit it as a freeform surface.')
    const patch = cylinderPatch(xyz, fit, step.fit.expandPct)
    const on = (angle: number): Vec3 => addScaled(addScaled(fit.origin, patch.u, fit.radius * Math.cos(angle)), patch.v, fit.radius * Math.sin(angle))
    const pieces: LoopPiece[] = patch.full
      ? [{ kind: 'circle', center: fit.origin, normal: fit.axis, radius: fit.radius }]
      : [{ kind: 'arc', a: on(patch.start), m: on(patch.start + patch.sweep / 2), b: on(patch.start + patch.sweep) }]
    const face = k.sheet(pieces, fit.axis, patch.from, patch.to)
    return {
      face,
      report: { rms: fit.rms, max: fit.max, net: { u: 0, v: 0 }, points, shape: 'cylinder', radius: fit.radius, rmsFree: fit.rmsFree, relations: fit.relations },
      primitive: { kind: 'cylinder', origin: fit.origin, axis: fit.axis, radius: fit.radius, length: patch.to - patch.from },
    }
  }
  /** The bodies each feature found when it ran, by body — kept alive
   *  after the build so a feature reopened for editing is previewed on
   *  the bodies as they stood before it, and its picks are re-found there.
   *  The design's rollback while editing, in the kernel's terms. */
  private stages = new Map<number, Map<number, Body>>()
  /** The planes and cylinders the last build's surface features came out
   *  as, by feature id: what a later fit is held to, and what a trim cuts
   *  with in place of the patch that is drawn. */
  private fitted = new Map<number, TrimPrimitive>()
  /** What the bodies brought with them from a file, by body id. */
  private looks = new Map<number, Look>()
  /** The STEP files the builder has been handed, by the key an Import names
   *  them by — handed once, kept for every build after. */
  private stepFiles = new Map<string, string>()
  /** Each STEP file read into its parts, the first time a step asked for
   *  it: a large file takes seconds to read, and a feature edited above an
   *  Import would read it again at every rebuild. The parts are the cache's
   *  own; a body takes handles of its own on their solids. */
  private stepParts = new Map<string, StepPart[]>()
  /** The file the last preview read — kept read while its box is open,
   *  though no build names it yet. */
  private previewedFile: string | null = null

  constructor(readonly kernel: ReKernel) {}

  /** STEP files for the Imports to read, by key. */
  addStepFiles(files: Iterable<readonly [string, string]>): void {
    for (const [key, text] of files) this.stepFiles.set(key, text)
  }

  /** The parts of a STEP file handed in under a key, read once. */
  private partsOf(key: string): StepPart[] {
    const read = this.stepParts.get(key)
    if (read) return read
    const text = this.stepFiles.get(key)
    if (text === undefined) throw new Error('The STEP file of this import is not here — open it again, or import it again.')
    const parts = this.kernel.readStepParts(text)
    this.stepParts.set(key, parts)
    return parts
  }

  /** The files read that neither the steps given nor the box open name any
   *  more, let go — a file replaced in its Import, an Import deleted. */
  private forgetParts(steps: readonly BuildStep[]): void {
    const named = new Set(steps.flatMap((s) => (s.kind === 'import' ? [s.file] : [])))
    for (const [key, parts] of this.stepParts) {
      if (named.has(key) || key === this.previewedFile) continue
      this.kernel.release(...parts.map((p) => p.shape))
      this.stepParts.delete(key)
    }
  }

  /** The shapes of the bodies from the last build, by id. */
  body(id: number): Shape | undefined {
    return this.bodyById(id)?.shape
  }

  /** The body a feature names: itself, or the one it went into. */
  private bodyById(id: number): Body | undefined {
    return this.bodies.get(this.resolve(id))
  }

  /** The id a body goes by now — its own, or the one it went into. */
  private resolve(id: number): number {
    for (let i = 0; i < 64 && !this.bodies.has(id); i++) {
      const to = this.aliases.get(id)
      if (to === undefined) break
      id = to
    }
    return id
  }

  bodyIds(): number[] {
    return [...this.bodies.keys()]
  }

  /** The bodies from the last build, meshed again — for a map of the scan
   *  against them. The build's own meshes went to the viewport; meshing a
   *  body is a few tens of milliseconds, which is cheaper than holding a
   *  second copy of every body between builds. Bodies not there are
   *  skipped. With a `chord` the solids alone are meshed, to that chord
   *  and a tighter angle: the reference a report is measured against,
   *  where a sheet has no inside and the viewport's chord is too coarse. */
  meshes(ids: readonly number[], chord?: number): KernelMesh[] {
    const k = this.kernel
    const out: KernelMesh[] = []
    for (const id of ids) {
      const b = this.bodyById(id)
      if (!b) continue
      if (chord !== undefined) {
        if (!b.surface) out.push(k.mesh(b.shape, chord, 0.1))
        continue
      }
      const bounds = k.extent(b.shape)
      const diag = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
      out.push(k.mesh(b.shape, meshDeflection(diag)))
    }
    return out
  }

  /** The builder as it stood after a step: its maps copied, the bodies in
   *  them shared. A stage map is never added to after its step, so the
   *  stages are copied one level deep. */
  private snapshot(results: readonly FeatureResult[]): Snapshot {
    return {
      results: [...results],
      bodies: new Map(this.bodies),
      aliases: new Map(this.aliases),
      issued: new Set(this.issued),
      pieces: new Map(this.pieces),
      stages: new Map(this.stages),
      fitted: new Map(this.fitted),
      placed: new Map(this.placed),
      looks: new Map(this.looks),
    }
  }

  /** The builder put back as it stood after a step — or as it is before any
   *  build — in maps of its own, for the next steps to change. Nothing is
   *  released: the shapes belong to the builds kept. */
  private restore(state: Snapshot | null): void {
    // Maps that note what the step playing reads of them.
    const note = (name: StateName) => (key: unknown) => {
      if (this.reading) noteRead(this.reading, name, key)
    }
    this.bodies = new ReadMap(note('bodies'), state?.bodies)
    this.aliases = new ReadMap(note('aliases'), state?.aliases)
    this.issued = new ReadSet(note('issued'), state?.issued)
    this.pieces = new ReadMap(note('pieces'), state?.pieces)
    this.stages = new ReadMap(note('stages'), state?.stages)
    this.fitted = new ReadMap(note('fitted'), state?.fitted)
    this.placed = new ReadMap(note('placed'), state?.placed)
    this.looks = new ReadMap(note('looks'), state?.looks)
  }

  /** The builder's state as it stands, map by map. */
  private state(): Record<StateName, Map<unknown, unknown> | Set<unknown>> {
    return { bodies: this.bodies, aliases: this.aliases, issued: this.issued, pieces: this.pieces, stages: this.stages, fitted: this.fitted, placed: this.placed, looks: this.looks }
  }

  /**
   * A step's outcome taken over from a kept build instead of played: the
   * same step (by its key) that read there nothing that does not stand the
   * same now — the same bodies, sketches placed and ids, the very objects.
   * Played on the same, it would do the same, so what it did there is done
   * here (buildReads.ts replay). What it read, for the build kept next; null
   * where no kept build has the step so.
   */
  private takeOver(key: string, results: FeatureResult[]): StepReads | null {
    const held = [...(this.byKey.get(key) ?? [])].filter((n) => n.state && n.reads).sort((a, b) => b.used - a.used)
    for (const n of held) {
      const before = n.parent === this.tree ? NOTHING : n.parent?.state
      if (!before || !readsStand(n.reads!, this.state(), before)) continue
      replay(before, n.state!, this.state(), results)
      n.used = ++this.clock
      return n.reads!
    }
    for (const b of this.offered) {
      const j = this.indexOf(b).get(key)
      if (j === undefined || !b.reads[j]) continue
      const before = j > 0 ? b.states[j - 1] : NOTHING
      if (!readsStand(b.reads[j], this.state(), before)) continue
      replay(before, b.states[j], this.state(), results)
      return b.reads[j]
    }
    return null
  }

  /** An offered part's steps by key. */
  private indexOf(b: KeptBuild): Map<string, number> {
    let index = this.keyIndex.get(b)
    if (!index || index.keys !== b.keys) this.keyIndex.set(b, (index = { keys: b.keys, at: new Map(b.keys.map((k, i) => [k, i])) }))
    return index.at
  }

  /** Every shape a state holds: its bodies' and the bodies kept with it
   *  for editing. */
  private static shapesOf(state: Snapshot, into: Set<number>): void {
    for (const b of state.bodies.values()) into.add(b.shape)
    for (const staged of state.stages.values()) for (const s of staged.values()) into.add(s.shape)
  }

  /** The build standing made so: its states held, and put in the tree
   *  when it has keys; the one before let go of where nothing else holds
   *  it; the tree brought within its budget. */
  private stand(build: KeptBuild): void {
    const before = this.standing
    this.standing = build
    this.hold(build.states)
    let node = this.tree
    build.keys.forEach((key, i) => {
      let next = node.children.get(key)
      if (!next) {
        next = { key, parent: node, children: new Map(), state: null, reads: null, used: 0 }
        node.children.set(key, next)
        let same = this.byKey.get(key)
        if (!same) this.byKey.set(key, (same = new Set()))
        same.add(next)
      }
      if (next.state !== build.states[i]) {
        if (next.state) this.dropState(next)
        next.state = build.states[i]
        next.reads = build.reads[i]
        this.hold([next.state])
      }
      next.used = ++this.clock
      node = next
    })
    if (before) this.letGo(before.states)
    this.trim()
  }

  /** States held once more — and the shapes in them, each counted once
   *  for the bytes held the first time it is held. */
  private hold(states: readonly Snapshot[]): void {
    for (const s of states) {
      const n = this.holders.get(s) ?? 0
      this.holders.set(s, n + 1)
      if (n > 0) continue
      const shapes = new Set<number>()
      Builder.shapesOf(s, shapes)
      for (const shape of shapes) {
        const m = this.shapeHolders.get(shape) ?? 0
        this.shapeHolders.set(shape, m + 1)
        if (m === 0) this.heldBytes += this.bytesOf(shape as Shape)
      }
    }
  }

  /** States held once less: a state nothing holds any more lets go of its
   *  shapes, and a shape no state holds any more is released — each once. */
  private letGo(states: readonly Snapshot[]): void {
    for (const s of states) {
      const n = (this.holders.get(s) ?? 1) - 1
      if (n > 0) {
        this.holders.set(s, n)
        continue
      }
      this.holders.delete(s)
      const shapes = new Set<number>()
      Builder.shapesOf(s, shapes)
      for (const shape of shapes) {
        const m = (this.shapeHolders.get(shape) ?? 1) - 1
        if (m > 0) {
          this.shapeHolders.set(shape, m)
          continue
        }
        this.shapeHolders.delete(shape)
        this.heldBytes -= this.shapeBytes.get(shape) ?? 0
        this.shapeBytes.delete(shape)
        this.kernel.release(shape as Shape)
      }
    }
  }

  /** What a shape comes to: its BREP's bytes, read once. */
  private bytesOf(shape: Shape): number {
    let bytes = this.shapeBytes.get(shape)
    if (bytes === undefined) this.shapeBytes.set(shape, (bytes = this.kernel.toBrep(shape).byteLength))
    return bytes
  }

  /** A node of the tree without its state. */
  private dropState(node: PrefixNode): void {
    const state = node.state
    node.state = null
    node.reads = null
    if (state) this.letGo([state])
  }

  /** The tree within its budget: the far ends of its branches let go —
   *  a state none of whose node's children holds one, but never one of
   *  the build standing — the oldest used first, until the shapes held
   *  come within it. A node with nothing under it and no state is taken
   *  out of the tree. */
  private trim(): void {
    if (this.heldBytes <= this.cacheBudget) return
    const standing = new Set(this.standing?.states ?? [])
    const isEnd = (n: PrefixNode) => n.state !== null && !standing.has(n.state) && ![...n.children.values()].some((c) => c.state)
    const ends: PrefixNode[] = []
    const visit = (n: PrefixNode) => {
      for (const c of n.children.values()) {
        if (isEnd(c)) ends.push(c)
        visit(c)
      }
    }
    visit(this.tree)
    ends.sort((a, b) => b.used - a.used)
    while (this.heldBytes > this.cacheBudget && ends.length > 0) {
      const n = ends.pop()!
      this.dropState(n)
      let gone: PrefixNode | null = n
      while (gone && gone !== this.tree && !gone.state && gone.children.size === 0) {
        const parent: PrefixNode = gone.parent!
        parent.children.delete(gone.key)
        const same = this.byKey.get(gone.key)
        same?.delete(gone)
        if (same?.size === 0) this.byKey.delete(gone.key)
        gone = parent
      }
      const parent = n.parent
      if (parent && parent !== this.tree && isEnd(parent)) {
        // In among the ends by when it was used, the oldest last.
        let at = ends.length
        while (at > 0 && ends[at - 1].used < parent.used) at--
        ends.splice(at, 0, parent)
      }
    }
  }

  /** How much the states kept hold, and how many — for the tests. */
  cacheHeld(): { bytes: number; shapes: number; states: number } {
    return { bytes: this.heldBytes, shapes: this.shapeHolders.size, states: this.holders.size }
  }

  /** The body a step works on: as it stood before the step, when the step
   *  ran in the last build, else as it stands now. */
  private bodyBefore(stepId: number, bodyId: number): Body | undefined {
    const staged = this.stages.get(stepId)
    return staged?.get(bodyId) ?? staged?.get(this.resolve(bodyId)) ?? this.bodyById(bodyId)
  }

  /** A body as it stood before a step, kept for the step's editing — the
   *  shape handed over, the body moving on with another. */
  private stageBody(stepId: number, bodyId: number, body: Body): void {
    let staged = this.stages.get(stepId)
    if (!staged) this.stages.set(stepId, (staged = new Map()))
    // Staged twice, the body as it first stood is kept: a shape the step
    // made in between is its own to release — but never the one staged,
    // which a kept state may hold.
    const first = staged.get(bodyId)
    if (first) {
      if (first.shape !== body.shape) this.kernel.release(body.shape)
    } else staged.set(bodyId, body)
  }

  /** A body id for a step's next body: the step's own, then its own and a
   *  fraction (features.ts islandId). */
  private freshId(stepId: number): number {
    for (let n = 0; n < ISLAND_IDS; n++) {
      const id = n === 0 ? stepId : islandId(stepId, n)
      if (this.issued.has(id) || this.bodies.has(id)) continue
      this.issued.add(id)
      return id
    }
    throw new Error(`The feature leaves more than ${ISLAND_IDS} separate bodies.`)
  }

  /** A shape as the solids it holds, each a shape of its own and its
   *  volume, largest first — the shape itself when it is one solid or
   *  none. The pieces share the shape's faces, hashes and all; the shape
   *  is released when it was taken apart. */
  private islands(shape: Shape): { shape: Shape; volume: number }[] {
    const k = this.kernel
    if (k.solidCount(shape) <= 1) return [{ shape, volume: 0 }]
    const pieces = k.solids(shape).map((p) => ({ shape: p, volume: k.volume(p) }))
    k.release(shape)
    return pieces.sort((a, b) => b.volume - a.volume)
  }

  /** A shape into the body `id`, as many bodies as it has solids: the
   *  largest keeps the id, each other piece a fresh one of the step's —
   *  or, where it is one of `earlier` again (the bodies gone into the
   *  shape, staged for the step: a Combine's body in pieces), that one's
   *  id, the fresh id aliased to it. So a body in two pieces keeps both
   *  ids through every Combine on it, and a project that named a piece by
   *  the fresh id a Combine gave it before still finds the same piece.
   *  The ids the pieces went to, the first `id`. A cut's or a combine's
   *  pieces the same size go by where the body stood (`byPlace`,
   *  nearestFirst); any other step's by the kernel's order, as before. */
  private settle(id: number, name: string, shape: Shape, origins: Map<number, number>, stepId: number, surface = false, earlier: readonly number[] = [], byPlace = false): number[] {
    if (surface) {
      this.bodies.set(id, { name, shape, origins, surface: true })
      return [id]
    }
    const pieces = this.islands(shape)
    if (byPlace && pieces.length > 1) this.nearestFirst(id, pieces, stepId)
    const held = pieces.length > 1 ? this.piecesHeld(id, pieces.map((p) => p.shape), earlier, stepId) : []
    const ids: number[] = []
    for (let i = 0; i < pieces.length; i++) {
      let at = i === 0 ? id : this.freshId(stepId)
      let own = name
      const was = held[i]
      if (i > 0 && was !== undefined) {
        this.aliases.set(at, was)
        at = was
        own = this.stages.get(stepId)?.get(was)?.name ?? name
      }
      this.bodies.set(at, { name: own, shape: pieces[i].shape, origins: pieces.length === 1 ? origins : this.originsOn(pieces[i].shape, origins) })
      ids.push(at)
    }
    if (ids.length > 1) this.pieces.set(id, [...new Set([...(this.pieces.get(id) ?? []), ...ids.slice(1)])])
    return ids
  }

  /** Pieces that tie for the largest — within SPLIT_TIE of its volume —
   *  with the one whose centroid lies nearest the body's as it stood
   *  before the step (staged) put first, to keep the id: by where the body
   *  was, not by the kernel's order. Pieces as near as each other (a body
   *  cut through its middle), and a body the step staged none of (a new
   *  feature's), stay in the kernel's order. */
  private nearestFirst(id: number, pieces: { shape: Shape; volume: number }[], stepId: number): void {
    const was = this.stages.get(stepId)?.get(id)
    if (!was || was.surface) return
    const tied = pieces.filter((p) => p.volume >= pieces[0].volume * (1 - SPLIT_TIE)).length
    if (tied < 2) return
    const k = this.kernel
    const at = k.centroid(was.shape)
    const far = pieces.slice(0, tied).map((p) => len(sub(k.centroid(p.shape), at)))
    let best = 0
    for (let i = 1; i < tied; i++) if (far[i] < far[best] - 1e-6 * Math.max(1, far[best])) best = i
    if (best > 0) pieces.unshift(...pieces.splice(best, 1))
  }

  /** A body standing, as the words of a split name it. */
  private pieceSaid(id: number): PieceSaid | null {
    const b = this.bodies.get(id)
    return b && !b.surface ? { id, volume: this.volumeOf(b.shape), bounds: this.kernel.bounds(b.shape) } : null
  }

  /** A step that left a body in pieces (`ids`, settle's) says so on its
   *  row: which kept the id and which are new — a piece is new where the
   *  step staged no body of its id — with where each lies (splitWords).
   *  Nothing where every piece is one the body had before. */
  private saySplit(what: string, name: string, ids: readonly number[], stepId: number): void {
    if (ids.length < 2) return
    const staged = this.stages.get(stepId)
    const fresh = (x: number) => !staged?.has(x)
    if (!ids.slice(1).some(fresh)) return
    const kept = this.pieceSaid(ids[0])
    const others = ids.slice(1).flatMap((x) => {
      const p = this.pieceSaid(x)
      return p ? [{ piece: p, fresh: fresh(x) }] : []
    })
    if (kept) this.stepWarnings.push(splitWords(what, name, kept, others))
  }

  /** A cut by a plane that leaves nothing of its body, in words: the body,
   *  the side cut away, and the pieces split off the body (familyOf) with
   *  how each lies to the plane — the one meant is likely among them. */
  private takesAll(step: Extract<BodyStep, { kind: 'cutPlane' }>, bodyId: number, body: Body): string {
    const away = scale(step.plane.normal, -step.keep)
    const family = this.familyOf(step.body).flatMap((id) => {
      const p = id === bodyId ? null : this.pieceSaid(id)
      return p ? [{ piece: p, side: sideOfBox(p.bounds, step.plane.origin, away) }] : []
    })
    const makers = [...new Set(family.map((f) => bodyMaker(f.piece.id)))]
    const since = makers.map((m) => `${this.names.get(m) ?? 'the feature'} (feature ${m})`).join(' and ')
    return takesAllWords(body.name, { id: bodyId, volume: this.volumeOf(body.shape), bounds: this.kernel.bounds(body.shape) }, step.plane.origin, away, step.keep, family, since)
  }

  /** Which of the bodies gone into a shape each of its pieces is again,
   *  by index of the piece: the body it shares the most faces with — a
   *  piece the step left alone keeps its faces — else the one a point on
   *  its surface lies in or on. `id` claims its piece too, so a piece is
   *  not handed the id of a body that went into another; each body is
   *  claimed once. Read off the bodies as staged for the step. */
  private piecesHeld(id: number, pieces: readonly Shape[], earlier: readonly number[], stepId: number): (number | undefined)[] {
    const k = this.kernel
    const staged = this.stages.get(stepId)
    const bodies = [id, ...earlier.filter((e) => e !== id && !this.bodies.has(e))].flatMap((e) => {
      const b = staged?.get(e)
      return b && !b.surface ? [{ id: e, body: b }] : []
    })
    if (bodies.length < 2) return []
    const held: (number | undefined)[] = pieces.map(() => undefined)
    const claimed = new Set<number>()
    // Faces shared, the most first.
    const hashes = pieces.map((p) => new Set(k.faceHashes(p)))
    const pairs: { piece: number; body: number; shared: number }[] = []
    for (const b of bodies) {
      const own = k.faceHashes(b.body.shape)
      hashes.forEach((h, piece) => {
        const shared = own.filter((x) => h.has(x)).length
        if (shared > 0) pairs.push({ piece, body: b.id, shared })
      })
    }
    pairs.sort((a, b) => b.shared - a.shared)
    for (const p of pairs) {
      if (held[p.piece] !== undefined || claimed.has(p.body)) continue
      held[p.piece] = p.body
      claimed.add(p.body)
    }
    // Faces named anew (merged on one surface): a point on the body.
    for (const b of bodies) {
      if (claimed.has(b.id)) continue
      const probe = this.probeOf(b.body.shape)
      const piece = pieces.findIndex((p, i) => held[i] === undefined && k.containsPoint(p, probe.at, probe.tolerance))
      if (piece < 0) continue
      held[piece] = b.id
      claimed.add(b.id)
    }
    return held
  }

  /** A body as a feature named it, in every piece it is in now: itself and
   *  the bodies later steps split off it, and off those — that stand. A
   *  plug patterned into four copies apart is four bodies, and a Combine
   *  naming the plug takes all four, as it did while they were one body. */
  private familyOf(id: number): number[] {
    const out: number[] = []
    const seen = new Set<number>()
    const walk = (at: number) => {
      const own = this.resolve(at)
      if (seen.has(own)) return
      seen.add(own)
      if (this.bodies.has(own)) out.push(own)
      for (const piece of this.pieces.get(own) ?? []) walk(piece)
    }
    walk(id)
    return out
  }

  /** The bodies a Combine takes: its tool in every piece (familyOf), but
   *  the body it goes into. Two profiles apart, extruded together, are a
   *  body and a piece of it — moved to overlap, either is combined into
   *  the other, and the piece is not its own tool. Of several tools, all
   *  of them (toolGroups). */
  private toolFamily(step: Extract<BodyStep, { kind: 'boolean' }>): number[] {
    return this.toolGroups(step).flat()
  }

  /** A Combine's tools one by one, each in every piece — a piece an
   *  earlier tool took, or the body, left out: what an intersect with
   *  several tools keeps the common of, tool after tool. */
  private toolGroups(step: Extract<BodyStep, { kind: 'boolean' }>): number[][] {
    const taken = new Set([this.resolve(step.body)])
    return toolsOf(step)
      .map((t) =>
        this.familyOf(t).filter((id) => {
          if (taken.has(id)) return false
          taken.add(id)
          return true
        }),
      )
      .filter((g) => g.length > 0)
  }

  /** The bodies a Combine goes into: its body in every piece, the one it
   *  names first, none that is the tool. Two studs from one sketch are a
   *  body and a piece of it; intersected with the outline, both are
   *  trimmed, not the larger alone. */
  private bodyFamily(step: Extract<BodyStep, { kind: 'boolean' }>): number[] {
    const into = this.resolve(step.body)
    const tools = new Set(this.toolFamily(step))
    return [into, ...this.familyOf(step.body).filter((id) => id !== into && !tools.has(id))]
  }

  /** A body intersected with several tools in turn — each tool's pieces
   *  held as one for its turn — the history carried through them all, the
   *  faces of every tool among it. */
  private commonEach(body: Shape, tools: readonly (readonly Shape[])[]): Tracked {
    const k = this.kernel
    let current: Tracked = { shape: body, history: new Map() }
    for (const pieces of tools) {
      const held = pieces.length > 1 ? k.fuseAll(pieces) : null
      try {
        const next = k.commonTracked(current.shape, held ?? pieces[0])
        if (current.shape !== body) k.release(current.shape)
        current = { shape: next.shape, history: composeHistory(current.history, next.history) }
      } finally {
        if (held) k.release(held)
      }
    }
    return current
  }

  /** A piece's share of the makers of its shape's faces. */
  private originsOn(piece: Shape, origins: ReadonlyMap<number, number>): Map<number, number> {
    const own = new Map<number, number>()
    for (const h of this.kernel.faceHashes(piece)) {
      const o = origins.get(h)
      if (o !== undefined) own.set(h, o)
      markCopy(own, h, copyMarkOf(origins, h))
    }
    return own
  }

  /** The solid bodies whose box meets a shape's, in the order they were
   *  made. */
  private solidsNear(shape: Shape): [number, Body][] {
    const k = this.kernel
    const box = k.extent(shape)
    return [...this.bodies.entries()].filter(([, b]) => !b.surface && boxesMeet(box, k.extent(b.shape)))
  }

  /** A step on a body that failed keeps the body it was given as its
   *  stage, as one that worked does: what the feature's picks by index
   *  are read on (describe's `before`) while it is put right. The shape
   *  stays the body's own, so it is not handed over (stageBody). */
  private keepInput(step: BuildStep): void {
    if (!('body' in step) || typeof step.body !== 'number') return
    const body = this.bodyBefore(step.id, step.body)
    if (!body) return
    let staged = this.stages.get(step.id)
    if (!staged) this.stages.set(step.id, (staged = new Map()))
    const id = this.resolve(step.body)
    if (!staged.has(id)) staged.set(id, body)
  }

  /** Why a step that failed may have failed through no fault of its own:
   *  the body it works on — or a Combine's tool — already fails the
   *  kernel's check, a sliver a boolean before it left. Null when they
   *  pass, or the step works on no body. Read after the failure on the
   *  body as it stood before the step: a round, a chamfer and a shell are
   *  made on a copy (kernel.ts roundOnCopy, onCopy), so one the kernel
   *  gave up on part-way has not changed it, and a valid input is never
   *  blamed — the check costs nothing on a step that worked. */
  private inputFault(step: BuildStep, results: readonly FeatureResult[]): string | null {
    if (!('body' in step) || typeof step.body !== 'number') return null
    const named = [{ id: step.body, what: 'the body it works on' }, ...(step.kind === 'boolean' ? this.toolFamily(step).map((id) => ({ id, what: `the body it is combined with, ${this.bodies.get(id)?.name ?? id},` })) : [])]
    for (const { id, what } of named) {
      const b = this.bodyBefore(step.id, id)
      if (!b || b.surface) continue
      let valid: boolean
      try {
        valid = this.kernel.isValid(b.shape)
      } catch (e) {
        if (isTrap(e)) throw e
        continue
      }
      if (!valid) return `${what} already fails the kernel check (last changed by ${this.lastChanged(id, step.id, results)}): mend that step — reverse.body.check { ${id === step.body ? '' : `body: ${JSON.stringify(this.bodies.get(id)?.name ?? id)}, `}before: ${JSON.stringify(this.names.get(step.id) ?? step.id)} } says what is wrong with it as it stood`
    }
    return null
  }

  /** The name of the step that last changed a body before `stepId`: the
   *  last that kept it as it stood before it (stages) and worked, or the
   *  step that made it. */
  private lastChanged(bodyId: number, stepId: number, results: readonly FeatureResult[]): string {
    const id = this.resolve(bodyId)
    const failed = new Set(results.filter((r) => r.status === 'failed').map((r) => r.id))
    let last = Math.floor(id)
    for (const [s, staged] of this.stages) {
      if (s === stepId) break
      if (!failed.has(s) && (staged.has(id) || staged.has(bodyId))) last = s
    }
    return this.names.get(last) ?? `feature ${last}`
  }

  /** The body as it stood before a feature: its mesh and its faces and
   *  edges with their fingerprints — what the viewport shows and picks on
   *  while that feature is edited. Null when the feature did not run on
   *  that body in the last build. */
  stage(stepId: number, bodyId: number): { mesh: KernelMesh; topology: { faces: FaceInfo[]; edges: EdgeInfo[] } } | null {
    const stage = this.stages.get(stepId)?.get(bodyId)
    if (!stage) return null
    const deflection = meshDeflection(this.diagonal(stage))
    // The topology kept goes out as a copy: the worker hands its edges'
    // buffers on, which would leave the kept one empty — the next stage
    // of this body unsendable, a build that hands it out uncloneable.
    return { mesh: this.kernel.mesh(stage.shape, deflection), topology: structuredClone(this.topology(stage, deflection)) }
  }

  /** The origins of a shape's faces after a step: a face that kept its
   *  hash keeps its origin, a face the history says came from an old face
   *  inherits that face's origin, and every other face was made by the
   *  step. A face several old faces went into — the top of a block and of
   *  a second one joined flush to it, merged — keeps the maker of the
   *  first the body had before the step, and is the step's own only when
   *  nothing else went into it: the block's top stays the block's whether
   *  or not something is later joined flush with it. A pattern's copy
   *  keeps its mark (patternCopies.ts) as its maker is kept: the face's
   *  own, or that of the old face it inherits its maker from. */
  private propagate(shape: Shape, before: Map<number, number>, history: FaceHistory, stepId: number): Map<number, number> {
    const from = new Map<number, { origin: number; old: number }>()
    for (const [old, made] of history) {
      const origin = before.get(old)
      if (origin === undefined) continue
      for (const h of made) {
        const had = from.get(h)
        if (had === undefined || had.origin === stepId) from.set(h, { origin, old })
      }
    }
    const origins = new Map<number, number>()
    for (const h of this.kernel.faceHashes(shape)) {
      const kept = before.get(h)
      const inherited = kept === undefined ? from.get(h) : undefined
      origins.set(h, kept ?? inherited?.origin ?? stepId)
      const was = kept !== undefined ? h : inherited?.old
      if (was !== undefined) markCopy(origins, h, copyMarkOf(before, was))
    }
    return origins
  }

  /** A history for an operation the kernel tracks none for: each face of
   *  the result that kept no hash is traced to the face before it that it
   *  most resembles — the same kind, near where it was, facing much the
   *  same way — so a wall leaned by a draft is still the extrude's wall.
   *  A face that resembles none (a cylinder drafted into a cone) is the
   *  operation's own. */
  private geometricHistory(before: readonly { hash: number; kind: FaceFingerprint['kind']; centroid: Vec3; dir: Vec3; area: number; radius?: number }[], result: Shape): FaceHistory {
    const tol = matchTolerance(diagonalOf(this.kernel, result))
    const print = (f: (typeof before)[number]): FaceFingerprint => ({ kind: f.kind, centroid: f.centroid, dir: f.dir, area: f.area, origin: 0, ...(f.radius !== undefined ? { radius: f.radius } : {}) })
    const kept = new Set(before.map((f) => f.hash))
    const history: FaceHistory = new Map()
    for (const f of this.kernel.faces(result)) {
      if (kept.has(f.hash)) continue
      let best: number | null = null
      let bestD = Infinity
      for (const b of before) {
        const d = faceDistance(print(b), print(f), tol)
        if (d !== null && d < bestD) {
          bestD = d
          best = b.hash
        }
      }
      if (best !== null) history.set(best, [...(history.get(best) ?? []), f.hash])
    }
    return history
  }

  /** A body's faces and edges with their fingerprints. */
  /** A body's size, read once — see diagonalOf. */
  private diagonal(body: Body): number {
    let d = this.diagonals.get(body)
    if (d === undefined) this.diagonals.set(body, (d = diagonalOf(this.kernel, body.shape)))
    return d
  }

  private topology(body: Body, deflection: number): { faces: FaceInfo[]; edges: EdgeInfo[] } {
    let read = this.topologies.get(body)
    if (!read) this.topologies.set(body, (read = new Map()))
    let topology = read.get(deflection)
    if (!topology) read.set(deflection, (topology = this.readTopology(body, deflection)))
    return topology
  }

  private readTopology(body: Body, deflection: number): { faces: FaceInfo[]; edges: EdgeInfo[] } {
    const k = this.kernel
    const faces: FaceInfo[] = k.faces(body.shape).map((f) => {
      const fingerprint: FaceFingerprint = { kind: f.kind, centroid: f.centroid, dir: f.dir, area: f.area, origin: body.origins.get(f.hash) ?? -1 }
      if (f.radius !== undefined) fingerprint.radius = f.radius
      if (f.center !== undefined) fingerprint.center = f.center
      const copy = copyMarkOf(body.origins, f.hash)
      return { hash: f.hash, fingerprint, ...(f.fullTurn !== undefined ? { fullTurn: f.fullTurn } : {}), ...(copy ? { copy } : {}) }
    })
    const byHash = new Map(faces.map((f) => [f.hash, f.fingerprint]))
    const edges: EdgeInfo[] = k.edges(body.shape, deflection).map((e) => {
      const sides = e.faceHashes.map((h) => byHash.get(h)).filter((f): f is FaceFingerprint => f !== undefined)
      // The edge belongs to the newest of its faces: a fillet's edge on a
      // face the fillet made is the fillet's, not the extrude's.
      const origin = sides.reduce((o, f) => Math.max(o, f.origin), -1)
      const fingerprint: EdgeFingerprint = { kind: e.kind, mid: e.mid, dir: e.dir, length: e.length, faces: sides.map((f) => ({ kind: f.kind, dir: f.dir })), origin }
      if (e.radius !== undefined) fingerprint.radius = e.radius
      return { hash: e.hash, fingerprint, faces: e.faceHashes, ends: e.ends, endTangents: e.endTangents, polyline: e.polyline }
    })
    return { faces, edges }
  }

  /** The faces of a body that fingerprints name, by hash — or the first
   *  fingerprint that names none, described, for the feature to fail with.
   *  Each face is taken once: two picks cannot land on the same face.
   *  `picks`, for a feature's list of picks: the queries it was given by
   *  (`asked`) run again first, on the body as it stands — see findPicks —
   *  and a pick found again away from where it was picked said on the row
   *  — unless `quiet`, for a second look at a step that has failed. */
  findFaces(bodyId: number, wanted: readonly FaceFingerprint[], stepId?: number, picks?: { asked?: readonly StoredPick<FaceFingerprint>[]; quiet?: boolean }): { hashes: number[] } | { lost: string } {
    const body = stepId === undefined ? this.bodyById(bodyId) : this.bodyBefore(stepId, bodyId)
    if (!body) return { lost: 'the body is gone' }
    const { faces } = this.topology(body, 1)
    if (picks) return this.quietly(picks.quiet, () => this.findPicks(body, wanted, picks.asked, 'face', faces, matchFace, faceDistance, describeFace, (f) => f.centroid))
    const found = pickEach(wanted, faces, matchTolerance(this.diagonal(body)), matchFace, describeFace)
    if ('hashes' in found) this.noteFoundByPlace(wanted, faces, found.hashes, describeFace)
    return found
  }

  findEdges(bodyId: number, wanted: readonly EdgeFingerprint[], stepId?: number, picks?: { asked?: readonly StoredPick<EdgeFingerprint>[]; quiet?: boolean }): { hashes: number[] } | { lost: string } {
    const body = stepId === undefined ? this.bodyById(bodyId) : this.bodyBefore(stepId, bodyId)
    if (!body) return { lost: 'the body is gone' }
    const { edges } = this.topology(body, 1)
    if (picks) return this.quietly(picks.quiet, () => this.findPicks(body, wanted, picks.asked, 'edge', edges, matchEdge, edgeDistance, describeEdge, (e) => e.mid))
    const found = pickEach(wanted, edges, matchTolerance(this.diagonal(body)), matchEdge, describeEdge)
    if ('hashes' in found) this.noteFoundByPlace(wanted, edges, found.hashes, describeEdge)
    return found
  }

  /** What `job` gives, the row's warnings it adds let go when `quiet`. */
  private quietly<T>(quiet: boolean | undefined, job: () => T): T {
    const said = this.stepWarnings.length
    const out = job()
    if (quiet) this.stepWarnings.length = said
    return out
  }

  /**
   * A feature's picks found on its body as it stands before it. Each query
   * the picks were given by that still stands (livePicks) is run again
   * there, on the topology the commands read (where.ts): what it names now
   * is picked — the fifth top edge of an outline redrawn with five sides.
   * One that names nothing, or cannot be read on the body as it is, falls
   * back on the fingerprints of what it found when it was given, and the
   * row says so. The picks given otherwise are found by fingerprint, and
   * one found only by the looser second look (topo.ts matchFace) is said
   * on the row.
   */
  private findPicks<F extends { origin: number }>(
    body: Body,
    wanted: readonly F[],
    asked: readonly StoredPick<F>[] | undefined,
    what: 'face' | 'edge',
    candidates: readonly { hash: number; fingerprint: F }[],
    match: (w: F, c: readonly F[], t: MatchTolerance) => number | null,
    strict: (w: F, c: F, t: MatchTolerance) => number | null,
    describe: (f: F) => string,
    place: (f: F) => Vec3,
  ): { hashes: number[] } | { lost: string } {
    const tol = matchTolerance(this.diagonal(body))
    const { live, rest } = livePicks(wanted, asked, (f, p) => strict(f, p, tol) !== null)
    const hashes: number[] = []
    const prints: F[] = [...rest]
    if (live.length > 0) {
      const t = this.topology(body, meshDeflection(this.diagonal(body)))
      const sharp = (deg: number) => this.sharpOn(body, t, deg)
      for (const p of live) {
        const at = runStoredWhere(p.where, t, { name: body.name }, what, sharp, tol)
        if (at && at.length > 0) {
          for (const i of at) {
            const h = (what === 'face' ? t.faces[i] : t.edges[i]).hash
            if (!hashes.includes(h)) hashes.push(h)
          }
          continue
        }
        // An optional query's finds are optional too: those gone are left out.
        const back = p.where.optional ? p.found.filter((f) => match(f, candidates.map((c) => c.fingerprint), tol) !== null) : p.found
        if (back.length === 0) continue
        prints.push(...back)
        this.stepWarnings.push(`${whereWords(p.where)} ${at ? `names no ${what} now` : 'cannot be read now'}: its ${back.length} earlier ${what}${back.length === 1 ? '' : 's'} used — check ${back.length === 1 ? 'it' : 'them'}.`)
      }
    }
    const found = pickEach(prints, candidates, tol, match, describe)
    if ('lost' in found) return found
    this.noteFoundByPlace(prints, candidates, found.hashes, describe, { tol, strict, place })
    for (const h of found.hashes) if (!hashes.includes(h)) hashes.push(h)
    return { hashes }
  }

  /** Whether each edge of a body, by its index in `t`, runs between faces
   *  that meet at an angle — read off the faces' surfaces, for a sharp
   *  query the build runs again (where.ts sharpBySurfaces), at more than
   *  `deg` degrees; each edge read once. */
  private sharpOn(body: Body, t: { edges: readonly EdgeInfo[] }, deg: number): (i: number) => boolean {
    const known = new Map<number, boolean>()
    const normals = (face: number, points: readonly Vec3[]) => this.kernel.faceNormals(body.shape, face, points)
    return (i) => {
      const e = t.edges[i]
      let sharp = known.get(e.hash)
      if (sharp === undefined) known.set(e.hash, (sharp = sharpBySurfaces(e, normals, deg)))
      return sharp
    }
  }

  /** Picks found again where they lie, on a face or an edge another
   *  feature made than the one that made it when it was picked — the
   *  kernel's history no longer leads there, only the place does: said on
   *  the feature's row. With `moved`, for a feature's list of picks, so is
   *  a pick found only by the looser second look, which lets the size go
   *  and reaches four times as far — another edge of the same maker may lie
   *  there. One found by the strict look, however far a dimension moved
   *  it, is the one meant. */
  private noteFoundByPlace<F extends { origin: number }>(
    wanted: readonly F[],
    candidates: readonly { hash: number; fingerprint: F }[],
    hashes: readonly number[],
    describe: (f: F) => string,
    moved?: { tol: MatchTolerance; strict: (w: F, c: F, t: MatchTolerance) => number | null; place: (f: F) => Vec3 },
  ): void {
    const away: string[] = []
    const byPlace: string[] = []
    wanted.forEach((w, i) => {
      const got = candidates.find((c) => c.hash === hashes[i])?.fingerprint
      if (!got) return
      if (w.origin >= 0 && got.origin !== w.origin) {
        byPlace.push(describe(w))
        return
      }
      if (!moved) return
      if (moved.strict(w, got, moved.tol) !== null) return
      // units-ok: build message, also the agent's answer
      away.push(`${describe(w)} ${len(sub(moved.place(got), moved.place(w))).toFixed(1)} mm off`)
    })
    // One line for all of them: a pattern's picks run into dozens.
    if (byPlace.length === 1) this.stepWarnings.push(`${byPlace[0][0].toUpperCase()}${byPlace[0].slice(1)} found again by where it lies, not by its maker — check it.`)
    else if (byPlace.length > 1) this.stepWarnings.push(`${byPlace.length} picks found again by where they lie, not by their maker — check them.`)
    if (away.length === 0) return
    const one = away.length === 1
    this.stepWarnings.push(`${one ? 'A pick' : `${away.length} picks`} found again only loosely, the size let go: ${away.slice(0, LOOSE_NAMED).join('; ')}${away.length > LOOSE_NAMED ? ` and ${away.length - LOOSE_NAMED} more` : ''}. Check ${one ? 'it' : 'them'}.`)
  }

  /** A shape's volume, 0 for one with no solid in it. */
  private volumeOf(shape: Shape): number {
    return this.kernel.solidCount(shape) > 0 ? this.kernel.volume(shape) : 0
  }

  /**
   * A boolean held to its volume (booleanGuard.ts): `attempt` played, and
   * played again the kernel's other ways (playedAgain) when what it made is
   * no closed solid or its volume cannot stand. A result taken on the
   * second try says so on the feature's row; when none stands, it throws
   * saying why.
   */
  private guarded(attempt: () => Tracked, ask: (volume: number) => GuardAsk, what: string, bodies: readonly { name: string; shape: Shape }[] = []): Tracked {
    const k = this.kernel
    const first = attempt()
    const closed = k.isClosedSolid(first.shape)
    const reason = closed ? volumeRefusal(ask(this.volumeOf(first.shape))) : 'left no closed solid'
    if (reason === null) return first
    k.release(first.shape)
    const again = this.playedAgain(attempt)
    if (!again) throw new Error(closed ? `${what} cannot stand: ${reason}.` : `${what} left no closed solid — ${this.triedWords(bodies)}.`)
    const still = volumeRefusal(ask(this.volumeOf(again.shape)))
    if (still !== null) {
      k.release(again.shape)
      throw new Error(`${what} cannot stand: ${still}.`)
    }
    this.stepWarnings.push(`${what} was played again the kernel's other way: the first result ${reason}.`)
    return again
  }

  /** The faces and edges of a body from the last build, fingerprinted. */
  topologyOf(bodyId: number): { faces: FaceInfo[]; edges: EdgeInfo[] } | null {
    const body = this.bodyById(bodyId)
    return body ? this.topology(body, meshDeflection(this.diagonal(body))) : null
  }

  /** The solid one step makes of its profiles, before it is placed into a
   *  body. Throws with the reason when the kernel cannot make it. A step on
   *  a sketch the build placed is first lifted from the sketch as placed —
   *  see onPlacedSketch. */
  private solidOf(step: SolidStep, sketch: Sketch | undefined): Shape {
    const k = this.kernel
    if (step.kind === 'extrude' && step.faceProfile) return this.pullFace(step, step.faceProfile)
    step = this.onPlacedSketch(step)
    sketch = this.placed.get(step.sketchId)?.sketch ?? sketch
    if (step.kind === 'revolve' && step.pitch !== 0) return this.coilOf(step)
    // Drafted, the kernel leans each side face alone and cannot join two
    // that meet a hair off tangent: such joins are made tangent first, and
    // one too far off to mend is named if the kernel then refuses.
    let grazing: NearTangentJoin[] = []
    if (step.kind === 'extrude' && Math.abs(step.draftDeg) > 1e-9) {
      const mended = mendNearTangent(step.profiles)
      if (mended.mends.length > 0) {
        step = { ...step, profiles: mended.profiles }
        this.stepWarnings.push(mendWords(mended.mends))
      }
      grazing = mended.left
    }
    // A revolve's pieces ending on its axis made to end on it as a pole a
    // STEP reader keeps: put on it, an arc centred on it, the rest turned
    // to start there (mendPoles).
    if (step.kind === 'revolve') {
      const axis = normalize(step.dir)
      const poles = axis ? mendPoles(step.profiles, step.origin, axis) : null
      if (poles) step = { ...step, profiles: poles.profiles }
      if (poles && poles.mends.length > 0) this.stepWarnings.push(poleWords(poles.mends))
    }
    const faces = step.profiles.map((p) => k.face(p))
    try {
      if (step.kind === 'extrude' && grazing.length === 0) return this.extrude(step, faces, sketch)
      if (step.kind === 'extrude') {
        let solid: Shape
        try {
          solid = this.extrude(step, faces, sketch)
        } catch (e) {
          if (e instanceof KernelError && !isTrap(e)) throw new Error(grazingJoinsWords(grazing))
          throw e
        }
        if (k.isClosedSolid(solid)) return solid
        k.release(solid)
        throw new Error(grazingJoinsWords(grazing))
      }
      // A profile across its axis: named before the kernel's "construction
      // failed". One ending on the axis (a pole) or along it is turned.
      const axisDir = normalize(step.dir)
      const across = axisDir ? profileAcrossAxis(step.profiles, step.origin, axisDir) : null
      if (across) {
        const at = `(${across.at.map((v) => Math.round(v * 1000) / 1000).join(', ')})`
        throw new Error(
          across.across > 0
            // units-ok: build message, also the agent's answer
            ? `The profile crosses the revolve’s axis — it reaches ${Number(across.across.toPrecision(3))} mm over it at ${at}. A revolve turns what lies on one side of its axis: end the pieces on the axis (a profile may end on it, as a sphere’s arc does, or run along it), or pick only the region on one side.`
            : `The revolve’s axis runs through the profile at ${at} — a revolve turns a profile beside its axis, or one with the axis on its edge.`,
        )
      }
      const parts = faces.map((f) => k.revolve(f, step.origin, step.dir, step.angleRad))
      return fuseAll(this.kernel, parts)
    } finally {
      k.release(...faces)
    }
  }

  /**
   * A revolve with a pitch: each profile screwed about the axis, climbing
   * the pitch every turn, for as many turns as the angle holds — a coil, a
   * thread. Turned a whole turn or more, a profile reaching as far along
   * the axis as the pitch would run into itself a turn on, and a profile on
   * the axis has no helix to follow: both are refused, saying by how much.
   */
  private coilOf(step: Extract<BuildStep, { kind: 'revolve' }>): Shape {
    const k = this.kernel
    const dir = normalize(step.dir)
    if (!dir) throw new Error('The axis this revolve turns about has no direction.')
    if (profilesMeetAxis(step.profiles, step.origin, dir)) throw new Error('The profile touches or crosses the axis — a coil winds round the axis, so its profile has to stand clear of it.')
    const span = profileSpan(step.profiles, step.origin, dir)
    const reach = span.max - span.min
    if (step.angleRad >= 2 * Math.PI - 1e-9 && reach >= Math.abs(step.pitch) - 1e-6) {
      // units-ok: build message, also the agent's answer
      throw new Error(`The profile reaches ${reach.toFixed(3)} mm along the axis — as far as the pitch of ${Math.abs(step.pitch).toFixed(3)} mm or further, so each turn would run into the next. Give a pitch over ${reach.toFixed(3)} mm, or turn less than once.`)
    }
    return fuseAll(this.kernel, step.profiles.map((p) => k.screw(p, step.origin, dir, step.angleRad, step.pitch, step.leftHanded)))
  }

  /**
   * A face of a body pulled as it stands: the face is found again by its
   * fingerprint on the body as it stood before the step, copied out of
   * the body and swept along its own outward normal — so the profile is
   * whatever the face is by the time the step runs, holes and rounds
   * included, and an earlier feature that reshapes the face reshapes the
   * boss pulled from it. A face the fingerprint no longer finds fails the
   * step by name; one that is no longer flat fails it too.
   */
  private pullFace(step: Extract<BuildStep, { kind: 'extrude' }>, on: FaceProfile): Shape {
    const k = this.kernel
    const found = this.findFaces(on.body, [on.face], step.id)
    if ('lost' in found) throw new Error(`The face this extrude pulls is gone (was: ${found.lost}).`)
    const body = this.bodyBefore(step.id, on.body)
    const face = body && k.faces(body.shape).find((x) => x.hash === found.hashes[0])
    if (!body || !face) throw new Error('The body this extrude pulls a face of is gone.')
    if (face.kind !== 'plane') throw new Error('The face this extrude pulls is not flat any more.')
    const n = normalize(face.dir)
    if (!n) throw new Error('The face this extrude pulls has no normal.')
    const profile = k.faceCopy(body.shape, face.hash)
    try {
      return this.extrude({ ...step, origin: face.centroid, dir: n }, [profile], undefined)
    } finally {
      k.release(profile)
    }
  }

  /** Where each sketch with a step was placed in this build: the frame it
   *  lies in now and the sketch as solved on its projected pieces taken
   *  again — `changed` when either differs from what the feature list
   *  lifted the features on it from. */
  private placed = new Map<number, PlacedSketch>()

  /**
   * A sketch placed on the part as it stands where the sketch is in the
   * list, as a CAD sketch is. A sketch on a body's face finds the face
   * again by its fingerprint and takes its frame on it by the sketch rule.
   * A projected piece finds again what it was projected from — the edge by
   * its fingerprint on the body, the piece of the other sketch where that
   * sketch lies now — and is projected anew; where a piece moved, the
   * sketch is solved again, the pieces held to it following through their
   * relations and dimensions. A face or a source no longer found leaves
   * the sketch, or the piece, where it was, and the sketch's row says so:
   * the model still builds.
   */
  private placeSketch(step: SketchStep, stored: Sketch | undefined, sketchOf: (id: number) => Sketch | undefined): FeatureResult {
    if (!stored) return { id: step.id, status: 'ok' }
    const notes: string[] = []
    let frame = step.frame
    /** The face found, by its hash in this build. */
    let faceHash: number | null = null
    const on = step.onFace
    if (on) {
      const found = this.findFaces(on.body, [on.face])
      const body = 'lost' in found ? undefined : this.bodyById(on.body)
      const face = body && this.kernel.faces(body.shape).find((x) => x.hash === ('lost' in found ? -1 : found.hashes[0]))
      const at = face && face.kind === 'plane' ? sketchFrameOn({ origin: addScaled(face.centroid, face.dir, on.offset ?? 0), normal: face.dir }, on.frame.basisU) : null
      if (at && face) {
        frame = at
        faceHash = face.hash
      } else notes.push(`The face the sketch lies on was not found (${'lost' in found ? found.lost : 'the face is not flat any more'}); the sketch stays where it was.`)
    }
    // Each edge is taken for one source at most, the first first, as the
    // picks of a feature are — two edges are not run together into one. An
    // edge projected twice is one source, and found once for both.
    const edgesOf = new Map<number, { edges: EdgeInfo[]; tol: ReturnType<typeof matchTolerance>; taken: Set<number> } | null>()
    const edgesOn = (bodyId: number) => {
      let edges = edgesOf.get(bodyId)
      if (edges === undefined) {
        const body = this.bodyById(bodyId)
        const diagonal = body ? diagonalOf(this.kernel, body.shape) : 0
        edges = body ? { edges: this.topology(body, meshDeflection(diagonal)).edges, tol: matchTolerance(diagonal), taken: new Set() } : null
        edgesOf.set(bodyId, edges)
      }
      return edges
    }
    const matched = new Map<string, EdgeInfo | null>()
    const fresh = (source: ProjectionSource) => {
      if ('sketch' in source) {
        const other = this.placed.get(source.sketch)
        const from = other?.frame ?? step.sources.find((x) => x.id === source.sketch)?.frame
        const piece = (other?.sketch ?? sketchOf(source.sketch))?.entities.find((x) => x.id === source.entity)
        return from && piece ? projectSketchEntity(piece, from, frame) : null
      }
      const edges = edgesOn(source.body)
      if (!edges) return null
      const key = `${source.body}:${JSON.stringify(source.edge)}`
      if (!matched.has(key)) {
        const open = edges.edges.filter((e) => !edges.taken.has(e.hash))
        const j = matchEdge(source.edge, open.map((e) => e.fingerprint), edges.tol)
        if (j !== null) edges.taken.add(open[j].hash)
        matched.set(key, j === null ? null : open[j])
      }
      const edge = matched.get(key)
      return edge ? projectEdge(edge, frame) : null
    }
    const sketch = cloneSketch(stored)
    // The outline of a face projected before projections followed the part
    // has no source: each piece of it is given the edge of the face it lies
    // on exactly, the first time a build finds the face so — from then on
    // it follows the edge.
    let adopted = false
    const outline = on && faceHash !== null ? (edgesOn(on.body)?.edges.filter((x) => x.faces.includes(faceHash!)) ?? []) : []
    if (on && outline.length > 0) {
      sketch.entities = sketch.entities.map((e) => {
        if (!e.projected || e.source) return e
        const edge = outline.find((x) => {
          const there = retake(e, projectEdge(x, frame))
          return there !== null && retakeMoved(e, there) <= ADOPT_MM
        })
        if (!edge) return e
        adopted = true
        return { ...e, source: { body: on.body, edge: edge.fingerprint } }
      })
    }
    let lost = 0
    let moved = false
    sketch.entities = sketch.entities.map((e) => {
      if (!e.projected || !e.source) return e
      const now = retake(e, fresh(e.source))
      if (!now) {
        lost++
        return e
      }
      if (retakeMoved(e, now) > RETAKE_MOVED_MM) moved = true
      return now
    })
    if (lost > 0) notes.push(`${lost === 1 ? 'A projected piece' : `${lost} projected pieces`} no longer found on the part — left where ${lost === 1 ? 'it was' : 'they were'}.`)
    if (moved) {
      const report = solveSketch(sketch, { datums: datumTraces(frame) })
      const n = report.unmet.length
      if (n > 0) notes.push(`The projected pieces moved, and ${n === 1 ? 'a relation or a dimension' : `${n} relations and dimensions`} cannot be met where they are now.`)
    }
    const changed = moved || frameKey(frame) !== frameKey(step.frame)
    this.placed.set(step.id, { name: step.name, frame, sketch: moved || adopted ? sketch : stored, changed })
    return {
      id: step.id,
      status: 'ok',
      ...(on ? { sketchFrame: { sketchId: step.id, frame } } : {}),
      ...(moved || adopted ? { sketch } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    }
  }

  /** A sketch as the build placed it, with its regions found once. */
  private placedRegions(sketchId: number): Region[] {
    const placed = this.placed.get(sketchId)!
    return (placed.regions ??= findRegions(placed.sketch))
  }

  /** The steps of the build in hand, for a step to see the others on its
   *  sketch. */
  private stepsInPlay: readonly BuildStep[] = []

  /** Picks of a step that name no region of its sketch now, or one another
   *  pick names — an edit merged or took away what they picked: said on
   *  the feature's row, while the rest is built. So is a region another
   *  extrude or revolve on the sketch picks too — two regions that ran into
   *  one (samePick). */
  private notePicksLost(step: SolidStep, sketchOf: (id: number) => Sketch | undefined): void {
    const sketch = this.placed.has(step.sketchId) ? null : sketchOf(step.sketchId)
    const regions = sketch ? findRegions(sketch) : this.placed.has(step.sketchId) ? this.placedRegions(step.sketchId) : null
    if (!regions) return
    const others = this.stepsInPlay.flatMap((o) => (o.id !== step.id && (o.kind === 'extrude' || o.kind === 'revolve') && o.sketchId === step.sketchId && !(o.kind === 'extrude' && o.faceProfile) ? [{ name: this.names.get(o.id) ?? `feature ${o.id}`, keys: o.regions, pick: o.regionPick }] : []))
    const taken = (keys: readonly string[], pick: SolidStep['regionPick']) => (pick ? regionsByPick(pick, regions) : null) ?? matchRegions(keys, regions)
    const same = samePick(this.names.get(step.id) ?? `feature ${step.id}`, taken(step.regions, step.regionPick), others.map((o) => ({ name: o.name, regions: taken(o.keys, o.pick) })))
    if (same) this.stepWarnings.push(same)
    const placed = step.regionsByPlace?.length ?? 0
    if (placed > 0) this.stepWarnings.push(`${placed === 1 ? 'A profile' : `${placed} profiles`} found again by where ${placed === 1 ? 'it lies' : 'they lie'} after a sketch edit — check ${placed === 1 ? 'it' : 'them'}.`)
    // A pick taken as it was given names what it names now: no key of it
    // is lost.
    if (step.regions.length < 2 || (step.regionPick && regionsByPick(step.regionPick, regions))) return
    const lost = lostPicks(step.regions, regions).length
    if (lost === 0) return
    this.stepWarnings.push(`${lost} of ${step.regions.length} profiles picked ${lost === 1 ? 'is' : 'are'} gone from the sketch; the rest built. Pick again.`)
  }

  /**
   * A step on a sketch the build placed somewhere other than where the
   * feature list lifted it (placeSketch) is lifted again from the sketch as
   * placed: its picked regions found on it, in the frame it lies in now —
   * and a revolve's axis, when it is a line of the sketch, read off it
   * there. A preview of a sketch on a face that no build has placed is
   * moved with its face found now (onSketchFace).
   */
  private onPlacedSketch(step: SolidStep): SolidStep {
    const placed = this.placed.get(step.sketchId)
    if (!placed) return this.onSketchFace(step)
    if (!placed.changed) return step
    const all = this.placedRegions(step.sketchId)
    const regions = (step.regionPick ? regionsByPick(step.regionPick, all) : null) ?? matchRegions(step.regions, all)
    if (regions.length === 0) throw new Error(all.length > 0 ? lostPickWords(step.regions.length, this.names.get(step.sketchId) ?? `Sketch ${step.sketchId}`, all) : `The picked profiles are no longer closed — the projected pieces moved under them.${openEndsWords(placed.sketch)}`)
    const profiles = liftRegions(placed.frame, placed.sketch, regions, !(step.kind === 'extrude' && step.draftDeg))
    if (step.kind === 'extrude') return { ...step, profiles, origin: placed.frame.origin, dir: placed.frame.normal }
    if (step.axisLine === undefined) return { ...step, profiles }
    const line = placed.sketch.entities.find((e) => e.id === step.axisLine)
    const a = line?.kind === 'line' ? liftPoint(placed.frame, line.a) : null
    const dir = line?.kind === 'line' && a ? normalize(sub(liftPoint(placed.frame, line.b), a)) : null
    if (!a || !dir) throw new Error('The sketch line this revolve turns about is gone.')
    return { ...step, profiles, origin: a, dir }
  }

  /** A sheet's pieces from its sketch as the build placed it. */
  private sheetPlaced(step: Extract<BuildStep, { kind: 'sheet' }>): Extract<BuildStep, { kind: 'sheet' }> {
    const placed = this.placed.get(step.sketchId)
    if (!placed?.changed) return step
    return { ...step, pieces: sketchPieces(placed), dir: placed.frame.normal }
  }

  /** A loft's profiles from its sketches as the build placed them. */
  private loftPlaced(step: Extract<BuildStep, { kind: 'loft' }>): Extract<BuildStep, { kind: 'loft' }> {
    if (!step.sketches.some((id) => this.placed.get(id)?.changed)) return step
    const profiles = step.sketches.map((id, i) => {
      const placed = this.placed.get(id)
      if (!placed?.changed) return step.profiles[i]
      const profile = loftProfile(placed, this.placedRegions(id))
      if (typeof profile === 'string') throw new Error(profile)
      return profile
    })
    return { ...step, profiles }
  }

  /** A sweep's profile and path from its sketches as the build placed them
   *  — whichever moved taken again; the profile still standing square to
   *  the path is the sketches', which moved with the part. A route stays
   *  where it was given, so a profile placed anew on a face that moved is
   *  held to it again, and refused off it. */
  private sweepPlaced(step: Extract<BuildStep, { kind: 'sweep' }>): Extract<BuildStep, { kind: 'sweep' }> {
    const [profileId, pathId] = step.sketches
    const profileAt = this.placed.get(profileId)
    if (step.route) {
      if (!profileAt?.changed) return step
      const made = routeSweepGeometry(profileAt, this.placedRegions(profileId), step.route)
      if (typeof made === 'string') throw new Error(made)
      return { ...step, ...made }
    }
    const pathAt = this.placed.get(pathId)
    if (!profileAt?.changed && !pathAt?.changed) return step
    let { profile, from, path } = step
    if (profileAt?.changed) {
      const made = loftProfile(profileAt, this.placedRegions(profileId), 'the sweep')
      if (typeof made === 'string') throw new Error(made)
      profile = made
      from = profileMiddle(made)
    }
    if (pathAt?.changed) {
      const made = sweepPath(pathAt, from)
      if (typeof made === 'string') throw new Error(made)
      path = made.pieces
    }
    return { ...step, profile, from, path }
  }

  /** A sweep's solid, from its sketches as the build placed them. */
  private sweepOf(step: Extract<BuildStep, { kind: 'sweep' }>): Shape {
    const placed = this.sweepPlaced(step)
    return this.kernel.sweep(placed.profile, placed.path)
  }

  /**
   * A sketch on a body's face follows the face, as a CAD sketch on a face
   * does: the face is found again by its fingerprint on the body as it
   * stands before the step, the sketch's frame is taken on it by the
   * sketch rule, and the profiles — the axis too, when it is a line of the
   * sketch — are carried from the frame they were lifted in to the new
   * one. What a preview does for a sketch no build has placed; a face the
   * fingerprint no longer finds leaves the sketch where it was.
   */
  private onSketchFace(step: SolidStep): SolidStep {
    const on = step.onFace
    if (!on) return step
    const found = this.findFaces(on.body, [on.face], step.id)
    const body = 'lost' in found ? undefined : this.bodyBefore(step.id, on.body)
    const face = body && this.kernel.faces(body.shape).find((x) => x.hash === ('lost' in found ? -1 : found.hashes[0]))
    const frame = face && face.kind === 'plane' ? sketchFrameOn({ origin: addScaled(face.centroid, face.dir, on.offset ?? 0), normal: face.dir }, on.frame.basisU) : null
    if (!frame || frameKey(frame) === frameKey(on.frame)) return step
    const map = frameMap(on.frame, frame)
    const profiles = moveProfiles(step.profiles, map)
    if (step.kind === 'extrude') return { ...step, profiles, origin: map.point(step.origin), dir: map.dir(step.dir) }
    return step.axisInSketch ? { ...step, profiles, origin: map.point(step.origin), dir: map.dir(step.dir) } : { ...step, profiles }
  }

  /**
   * The solid a step would make, meshed, without touching the bodies: what
   * the viewport shows while the feature is being set up — the tool body
   * of an extrude or a revolve before its boolean, the body as a feature
   * working on it would leave it. Released before returning — a preview
   * leaves nothing behind in the kernel.
   */
  preview(step: PreviewStep, sketch: Sketch | undefined): PreviewResult {
    const k = this.kernel
    if (step.kind === 'import') return this.importPreview(step)
    if (step.kind === 'moveBody') return this.movePreview(step)
    if (step.kind === 'network') return this.networkPreview(step)
    const began = performance.now()
    const solid =
      step.kind === 'extrude' || step.kind === 'revolve'
        ? this.solidOf(step, sketch)
        : step.kind === 'extract'
          ? primitiveSolid(this.kernel, step.primitive)
          : step.kind === 'sheet'
            ? this.sheetOf(step)
            : step.kind === 'loft'
              ? this.loftOf(step)
              : step.kind === 'sweep'
                ? this.sweepOf(step)
              : step.kind === 'thicken'
                ? this.thickenPreview(step)
              : step.kind === 'surface'
                ? this.surfaceOf(step)
                : step.kind === 'trim'
                  ? this.trimOf(step)
                  : this.applyToBody(step).shape
    const stepMs = performance.now() - began
    const shape = typeof solid === 'number' ? solid : 'face' in solid ? solid.face : solid.shape
    try {
      const mesh = k.mesh(shape, (typeof solid !== 'number' && 'fit' in solid && solid.fit ? surfaceMeshDeflection : meshDeflection)(diagonalOf(this.kernel, shape)))
      if (typeof solid !== 'number' && 'face' in solid) return { mesh, volume: 0, closed: false, surface: solid.report }
      if (typeof solid !== 'number') return { mesh, volume: solid.surface ? 0 : k.volume(shape), closed: solid.report.closed, trim: solid.report }
      const onBody = step.kind !== 'extrude' && step.kind !== 'revolve' && step.kind !== 'extract' && step.kind !== 'sheet' && step.kind !== 'loft' && step.kind !== 'sweep' && step.kind !== 'thicken'
      // A pattern of a sheet is a sheet: faces to count, no volume to read.
      if (onBody && k.isSurface(shape)) return { mesh, volume: 0, closed: false, sheetFaces: k.faceCount(shape) }
      const closed = k.isClosedSolid(shape)
      // A round or a shell that left no closed solid says where, as a
      // failed one does.
      const failure = !closed && (step.kind === 'fillet' || step.kind === 'chamfer' || step.kind === 'shell') ? this.diagnose(step, stepMs) : null
      return { mesh, volume: k.volume(shape), closed, ...(onBody ? { edges: true } : {}), ...(failure ? { failure } : {}) }
    } finally {
      k.release(shape)
    }
  }

  /** A network's ghost: its patches meshed as fitted, with the fit's
   *  report — no faces made, which Create does (networkGhost) — or, where
   *  no cell could be filled, no mesh and the cells' report, for the box
   *  and the part to say why. */
  private networkPreview(step: Extract<BuildStep, { kind: 'network' }>): PreviewResult {
    const reading = this.networkReading(step)
    if ('message' in reading) return { mesh: { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) }, volume: 0, closed: false, network: reading.report, failure: { message: reading.message, where: [] } }
    const ghost = networkGhost(reading)
    return { mesh: ghost.mesh, volume: ghost.volume, closed: ghost.report.closed, network: ghost.report }
  }

  /** An Import's ghost: the file's parts, read — once — and meshed. */
  private importPreview(step: Extract<BuildStep, { kind: 'import' }>): PreviewResult {
    const k = this.kernel
    this.previewedFile = step.file
    const meshes: KernelMesh[] = []
    let volume = 0
    let closed = true
    for (const p of this.partsOf(step.file)) {
      meshes.push(k.mesh(p.shape, meshDeflection(diagonalOf(this.kernel, p.shape))))
      if (k.solidCount(p.shape) > 0) volume += k.volume(p.shape)
      else closed = false
    }
    return { mesh: mergeMeshes(meshes), volume, closed }
  }

  /** A Move's ghost: the bodies' own tessellation carried by the move — no
   *  kernel work, so the gizmo's drag is answered as fast as it is asked.
   *  What the live map reads the scan against. */
  private movePreview(step: Extract<BuildStep, { kind: 'moveBody' }>): PreviewResult {
    const k = this.kernel
    const meshes: KernelMesh[] = []
    let volume = 0
    let closed = true
    for (const id of new Set(step.bodies.map((b) => this.resolve(b)))) {
      const body = this.bodyBefore(step.id, id)
      if (!body) throw new Error('A body this move takes is gone, or failed to build.')
      const shown = this.shown.get(body)
      meshes.push(movedMesh(shown?.mesh ?? k.mesh(body.shape, meshDeflection(diagonalOf(this.kernel, body.shape))), step.matrix))
      if (body.surface) closed = false
      else volume += shown?.volume ?? k.volume(body.shape)
    }
    return { mesh: mergeMeshes(meshes), volume, closed, edges: true }
  }

  /** The body a step works on — as it stood before the step when the
   *  step is one of the last build's — or a throw naming why there is
   *  none. */
  private bodyFor(step: BodyStep): Body {
    const body = this.bodyBefore(step.id, step.body)
    if (!body) throw new Error('The body this feature works on is gone, or failed to build.')
    return body
  }

  /** A cut's result, checked to have taken something out of the body. A
   *  cut that meets the body nowhere — a hole drilled beside it or short of
   *  it, a tool standing clear — leaves the body as it was, and a CAD cut
   *  with nothing to cut is an error, not a silent success: the feature
   *  fails, saying so, rather than pass as ok with nothing to show. The
   *  result is released on refusal. */
  private tookSomething(body: Body, result: Tracked, what: string): Tracked {
    const k = this.kernel
    const was = k.volume(body.shape)
    const left = k.solidCount(result.shape) > 0 ? k.volume(result.shape) : 0
    if (Math.abs(was - left) <= 1e-7 * Math.max(1, was)) {
      k.release(result.shape)
      throw new Error(`${what} meets nothing of ${body.name} — the cut took nothing out. Check where it stands against the body and how far it reaches.`)
    }
    return result
  }

  /** The reach past a body that a through-cut or a half-space needs. */
  private reachOf(shape: Shape): number {
    return Math.max(diagonalOf(this.kernel, shape) * 2, 10)
  }

  /**
   * A body step applied to its body as it stands: the new shape with its
   * history, the body itself untouched — the build swaps it in after the
   * checks, a preview releases it. Picks are re-found on the body by
   * their fingerprints; one that is not there fails the step by name.
   */
  /**
   * A step whose work left no closed solid, played again: first with the
   * faces it leaves on one surface kept as cut, then with its booleans
   * fuzzy, a tenth of a micron and then a micron (kernelOps keepingSplits,
   * fuzzyBooleans, FUZZY_COARSE_MM). Where two faces lie
   * exactly on one cylinder the kernel's unifying can break the join the
   * boolean made whole, and where they lie a few nanometres apart the
   * exact boolean can leave the shell open — a block joined flush to a
   * flange, its outer face drawn on the flange's radius, does either. The
   * first try that closes, or null. A step that closes the first time is
   * never played again: every other build stays as it was.
   */
  private playedAgain<T extends Tracked>(attempt: () => T): T | null {
    // What a failure says it tried (triedWords) follows these ways.
    const k = this.kernel
    for (const again of [() => k.keepingSplits(attempt), () => k.fuzzyBooleans(attempt), () => k.fuzzyBooleans(attempt, k.coarseFuzz)]) {
      let r: T
      try {
        r = again()
      } catch {
        // Refused this way too: the next way, or the failure as it was.
        continue
      }
      if (k.isClosedSolid(r.shape)) return r
      k.release(r.shape)
    }
    return null
  }

  /** What a combine that left no closed solid says beside it: every way
   *  it was played (playedAgain), and — given the bodies it took — whether
   *  each checks as a valid closed solid alone: the trouble in one of them,
   *  to be mended first, or in where they meet. */
  private triedWords(bodies: readonly { name: string; shape: Shape }[]): string {
    // units-ok: build message, also the agent's answer
    const tried = `tried exact, keeping splits, fuzzy ${FUZZY_MM} mm and fuzzy ${FUZZY_COARSE_MM} mm`
    if (bodies.length === 0) return tried
    const bad = bodies.filter((b) => !this.kernel.isClosedSolid(b.shape))
    if (bad.length > 0) return `${tried}; ${bad.map((b) => b.name).join(' and ')} ${bad.length === 1 ? 'is' : 'are'} no valid closed solid alone — mend ${bad.length === 1 ? 'it' : 'them'} first (reverse.body.check)`
    return `${tried}; ${bodies.length === 2 ? 'both bodies check' : 'every body checks'} valid alone, so the trouble is where they meet — faces flush on one another or touching along a line: make them overlap, or move one a hair`
  }

  /** Where a draft's neutral plane lies and which way it pulls: a face of
   *  the body — the body lying behind it, the faces leaning in as they go
   *  into it — or a plane given. */
  draftNeutral(step: Extract<BodyStep, { kind: 'draft' }>, body: Body): { origin: Vec3; pull: Vec3 } {
    if (!('face' in step.neutral)) return { origin: step.neutral.origin, pull: step.neutral.normal }
    const found = this.findFaces(step.body, [step.neutral.face], step.id)
    if ('lost' in found) throw new Error(`The neutral face of this draft is gone (was: ${found.lost}).`)
    const f = this.kernel.faces(body.shape).find((x) => x.hash === found.hashes[0])
    if (!f || f.kind !== 'plane') throw new Error('The neutral face of this draft is not a plane.')
    return { origin: f.centroid, pull: scale(f.dir, -1) }
  }

  /** A draft's faces found on its body, each with the angle it leans by
   *  — the first group's, then each further group's in order — and the
   *  pick each came from. */
  draftPicks(step: Extract<BodyStep, { kind: 'draft' }>): { hashes: number[]; angles: number[]; refs: FaceFingerprint[] } | { lost: string } {
    const groups = [{ faces: step.faces, angleRad: step.angleRad, asked: step.facesWhere }, ...(step.groups ?? [])]
    const out = { hashes: [] as number[], angles: [] as number[], refs: [] as FaceFingerprint[] }
    // Each face as it is now, for a face its query found.
    const body = this.bodyBefore(step.id, step.body)
    const now = body ? new Map(this.topology(body, 1).faces.map((f) => [f.hash, f.fingerprint])) : new Map<number, FaceFingerprint>()
    for (const g of groups) {
      const found = this.findFaces(step.body, g.faces, step.id, { asked: 'asked' in g ? g.asked : undefined })
      if ('lost' in found) return found
      found.hashes.forEach((h, i) => {
        // A face in two groups leans by the first.
        if (out.hashes.includes(h)) return
        out.hashes.push(h)
        out.angles.push(g.angleRad)
        out.refs.push(now.get(h) ?? g.faces[i])
      })
    }
    return out
  }

  private applyToBody(step: BodyStep): Tracked & { consumed?: number[]; edges?: EdgeBrief[]; copies?: Map<number, number>; patches?: Map<number, number>; fit?: SurfaceFitResult; offScan?: OffScanReport[] } {
    const k = this.kernel
    const body = this.bodyFor(step)
    switch (step.kind) {
      case 'shell': {
        const found = this.findFaces(step.body, step.faces, step.id, { asked: step.facesWhere })
        if ('lost' in found) throw new Error(`The face this shell opens is gone (was: ${found.lost}).`)
        return k.shellTracked(body.shape, found.hashes, step.thickness)
      }
      case 'fillet':
      case 'chamfer': {
        const varying = step.kind === 'fillet' ? (step.variable ?? []) : []
        const found = step.edges.length > 0 || varying.length === 0 ? this.findEdges(step.body, step.edges, step.id, { asked: step.edgesWhere }) : { hashes: [] }
        if ('lost' in found) throw new Error(`The edge this ${step.kind} was on is gone (was: ${found.lost}).`)
        const topology = this.topology(body, 1)
        const all = topology.edges
        const picked = step.chain ? tangentChain(all, found.hashes, splitEdges(topology)) : found.hashes
        // The tangent chain of an edge at a varying radius stays out of the
        // plain edges: the kernel rounds an edge's whole chain with it, and
        // an edge of it not given runs between the radii given about it.
        const at = varying.length > 0 ? this.varyingEdges(step.body, varying, step.id) : []
        const theirs = new Set(at.length > 0 ? tangentChain(all, at, splitEdges(topology)) : [])
        const hashes = picked.filter((h) => !theirs.has(h))
        const merged = found.hashes.filter((h) => theirs.has(h) && !at.includes(h)).length
        if (merged > 0) this.stepWarnings.push(`${merged} of the edges picked at the one radius ${merged === 1 ? 'lies' : 'lie'} on the tangent chain of an edge at a varying radius, and ${merged === 1 ? 'runs' : 'run'} between the radii given on that chain — give ${merged === 1 ? 'it' : 'them'} a radius of ${merged === 1 ? 'its' : 'their'} own in variable to hold ${merged === 1 ? 'it' : 'them'} there.`)
        // The edges as they were, for the result to list: the round takes
        // them away.
        const brief = (h: number): EdgeBrief[] => {
          const e = all.find((x) => x.hash === h)
          if (!e) return []
          const fp = e.fingerprint
          return [{ kind: fp.kind, mid: fp.mid, length: fp.length, ...(fp.radius !== undefined ? { radius: fp.radius } : {}) }]
        }
        const edges = hashes.flatMap(brief)
        this.edgesInPlay = edgesAsked(step.kind === 'fillet' ? 'round' : 'bevel', [...hashes, ...at], all, body.origins, [...found.hashes, ...at])
        if (step.skipFailing && varying.length === 0) return this.roundWhatHolds(step, body, hashes, all, splitEdges(topology), brief)
        if (step.kind === 'chamfer' && step.mode) return { ...this.chamferSided(step, body, hashes), edges }
        if (varying.length === 0) {
          const made = step.kind === 'fillet' ? k.filletTracked(body.shape, hashes, step.radius) : k.chamferTracked(body.shape, hashes, step.distance)
          return { ...made, edges }
        }
        const chainOf = (h: number) => tangentChain(all, [h], splitEdges(topology))
        radiusJump(varying, at, all, chainOf)
        return { ...this.roundVarying(step as Extract<BodyStep, { kind: 'fillet' }>, body, hashes, varying, at), edges: [...edges, ...at.flatMap(brief)] }
      }
      case 'hole': {
        const reach = this.reachOf(body.shape)
        // From a flat face: into the body alone, the tool starting a hair
        // out of the face so the cut does not lie on it.
        const back = step.oneWay ? -HOLE_LEAD_MM : step.depth === null ? -reach : -step.depth
        const tool = cylinderSolid(this.kernel, step.origin, step.dir, step.radius, back, step.depth === null ? reach : step.depth)
        try {
          return this.tookSomething(body, k.cutTracked(body.shape, tool), 'The hole')
        } finally {
          k.release(tool)
        }
      }
      case 'thread': {
        const found = this.findFaces(step.body, [step.face], step.id)
        if ('lost' in found) throw new Error(`The round face this thread is cut on is gone (was: ${found.lost}).`)
        return k.threadTracked(body.shape, found.hashes[0], step)
      }
      case 'cutPlane': {
        const away = scale(step.plane.normal, -step.keep)
        const half = k.halfSpace(step.plane.origin, away)
        try {
          return k.cutTracked(body.shape, half)
        } finally {
          k.release(half)
        }
      }
      case 'mirror': {
        let plane: PlaneGeometry
        if ('face' in step.plane) {
          const found = this.findFaces(step.body, [step.plane.face], step.id)
          if ('lost' in found) throw new Error(`The face this mirror is about is gone (was: ${found.lost}).`)
          const f = k.faces(body.shape).find((x) => 'hashes' in found && x.hash === found.hashes[0])
          if (!f || f.kind !== 'plane') throw new Error('The face this mirror is about is not a plane.')
          plane = { origin: f.centroid, normal: f.dir }
        } else plane = step.plane
        const mirrored = k.mirrorTracked(body.shape, plane.origin, plane.normal)
        if (!step.join) return mirrored
        const joined = k.fuseTracked(body.shape, mirrored.shape)
        k.release(mirrored.shape)
        // The mirrored half's faces are the mirror's own; the history of
        // the fuse speaks of them by the mirrored shape's hashes, which
        // the mirror's history maps back to the source's.
        const history: FaceHistory = new Map(joined.history)
        for (const [old, made] of mirrored.history) {
          const via = made.flatMap((h) => joined.history.get(h) ?? [h])
          history.set(old, [...(history.get(old) ?? []), ...via])
        }
        return { shape: joined.shape, history }
      }
      case 'boolean': {
        const into0 = this.resolve(step.body)
        const gone = toolsOf(step).find((t) => this.resolve(t) === into0)
        if (gone !== undefined) throw new Error(toolsOf(step).length === 1 ? 'The body this one is combined with has gone into it already.' : `${this.bodies.get(into0)?.name ?? 'The body'} has taken in tool ${gone} already — a tool goes into it once.`)
        const groups = this.toolGroups(step)
        const family = groups.flat()
        const tools = family.map((id) => this.bodies.get(id)!)
        if (tools.length === 0) throw new Error('The body this one is combined with is gone, or failed to build.')
        // Of several, each one there: a tool missing would be passed over.
        const missing = toolsOf(step).filter((t) => this.familyOf(t).length === 0)
        if (missing.length > 0) throw new Error(`${missing.length === 1 ? 'A tool' : 'Tools'} this one is combined with (${missing.join(', ')}) ${missing.length === 1 ? 'is' : 'are'} gone, or failed to build.`)
        // A sheet is trimmed by a solid, or sewn to another sheet.
        // A solid tool stays a body as it was, as with keep: a second sheet
        // is trimmed by the same outline prism. A sheet joined is sewn in.
        if (body.surface && step.op === 'intersect' && groups.length > 1) throw new Error(`${body.name} is a sheet, trimmed inside one solid at a time — intersect it with each tool in a Combine of its own, or join the tools first.`)
        if (body.surface) return { ...this.combineSheet(step, body, tools), consumed: step.op === 'join' && !step.keep ? family : [] }
        const sheet = tools.find((t) => t.surface)
        if (sheet) throw new Error(`${sheet.name} is a sheet, and ${body.name} a solid — a solid is combined with solids. Cut a body with a sheet by Split, or close sheets into a solid by Trim; to trim the sheet by the solid, make the sheet the body.`)
        // The pieces as one tool, and the body's pieces as one body, held
        // together for the operation alone. Several tools intersected are
        // taken one after the other — the body inside all of them, not
        // inside any — each in its pieces held as one.
        const each = step.op === 'intersect' && groups.length > 1
        const held = !each && tools.length > 1 ? k.fuseAll(tools.map((t) => t.shape)) : null
        const tool = held ?? tools[0].shape
        const others = this.bodyFamily(step).slice(1).map((id) => this.bodyBefore(step.id, id)).filter((b): b is Body => b !== undefined && !b.surface)
        const heldBody = others.length > 0 ? k.fuseAll([body.shape, ...others.map((b) => b.shape)]) : null
        const into: Body = heldBody ? { ...body, shape: heldBody } : body
        try {
          const result = each
            ? this.commonEach(into.shape, groups.map((g) => g.map((id) => this.bodies.get(id)!.shape)))
            : step.op === 'join'
              ? k.fuseTracked(into.shape, tool)
              : step.op === 'cut'
                ? this.tookSomething(into, k.cutTracked(into.shape, tool), tools.length === 1 ? tools[0].name : 'The tool')
                : k.commonTracked(into.shape, tool)
          // A kept tool stays a body as it was; the result was made of its
          // shape, which is not used up. The body's other pieces are in
          // the result.
          return { ...result, consumed: [...(step.keep ? [] : family), ...this.bodyFamily(step).slice(1)] }
        } finally {
          if (held) k.release(held)
          if (heldBody) k.release(heldBody)
        }
      }
      case 'draft': {
        const all = k.faces(body.shape)
        const { origin, pull } = this.draftNeutral(step, body)
        const picks = this.draftPicks(step)
        if ('lost' in picks) throw new Error(`A face this draft leans is gone (was: ${picks.lost}).`)
        const skipped: number[] = []
        const shape = k.draftFaces(body.shape, picks.hashes, origin, pull, picks.angles, skipped)
        if (skipped.length > 0) {
          const named = skipped.map((i) => describeFace(picks.refs[i]))
          this.stepWarnings.push(`${skipped.length === 1 ? 'A face' : `${skipped.length} faces`} picked already leaned by ${skipped.length === 1 ? 'its' : 'their'} angle — drafted along with a tangent neighbour before ${skipped.length === 1 ? 'it' : 'them'} — and ${skipped.length === 1 ? 'was' : 'were'} passed over: ${named.join('; ')}.`)
        }
        return { shape, history: this.geometricHistory(all, shape) }
      }
      case 'moveFace': {
        const found = this.findFaces(step.body, step.faces, step.id, { asked: step.facesWhere })
        if ('lost' in found) throw new Error(`A face this feature moves is gone (was: ${found.lost}).`)
        return k.offsetFacesTracked(body.shape, found.hashes, step.offset)
      }
      case 'deleteFace': {
        const found = this.findFaces(step.body, step.faces, step.id, { asked: step.facesWhere })
        if ('lost' in found) throw new Error(`A face this feature deletes is gone (was: ${found.lost}).`)
        const before = k.faces(body.shape)
        const shape = k.deleteFaces(body.shape, found.hashes)
        // The faces round the gap ran on over it, each on its own surface:
        // found again there, each stays what it was.
        const after = k.faces(shape)
        const gone = new Set(found.hashes)
        const kept = new Set(after.map((f) => f.hash))
        const history: FaceHistory = new Map()
        for (const f of before) {
          if (gone.has(f.hash) || kept.has(f.hash)) continue
          const now = sameSurface(f, after)
          if (now) history.set(f.hash, [now.hash])
        }
        if (after.some((f) => gone.has(f.hash)) || (!body.surface && !(k.volume(shape) > 0))) {
          k.release(shape)
          throw new Error('The faces could not be taken off — the faces round them do not run on to close the gap. Pick the whole of a round, a hole or a boss: every face it is made of.')
        }
        return { shape, history }
      }
      case 'offsetBody':
        // Every face of an offset is new, and the offset's own.
        return { shape: k.offsetSolid(body.shape, step.distance), history: new Map() }
      case 'pattern': {
        const row = k.pattern(body.shape, step.mode, step.origin, step.dir, step.count, step.step)
        let shape = row
        // A grid: the row, repeated along the second direction.
        if (step.grid) {
          try {
            shape = k.pattern(row, 'linear', step.origin, step.grid.dir, step.grid.count, step.grid.step)
          } finally {
            k.release(row)
          }
        }
        // Each copy's faces traced to the faces they copy, which the
        // kernel tracks no history for: a copy face keeps the maker of its
        // original and is marked with its number (patternCopies.ts).
        return { shape, ...traceCopies(k.faces(body.shape), k.faces(shape), copyMotions(step), diagonalOf(k, shape)) }
      }
      case 'split': {
        if (body.surface) return this.splitSheet(step, body)
        const tools = step.tools.map((id) => this.bodyById(id)?.shape).filter((s): s is Shape => s !== undefined)
        if (tools.length !== step.tools.length) throw new Error('A sheet this split cuts with is gone, or failed to build.')
        const between = step.keep === 'between'
        // Within the sheets' regions: what is cut is the body inside their
        // outlines (withinRegions), the rest put back as it was after.
        const within = step.within !== undefined ? this.withinRegions(step.tools, step.within, body) : null
        const target = within?.inner ?? body.shape
        // Kept between them, two sheets that meet inside the body leave no
        // one wall: refused before the kernel is asked — two skins that
        // cross cut the body slowly, into corners each with a face on both.
        let fragments: Shape[] = []
        try {
          if (between) this.sheetsApart(step.tools, tools, body)
          fragments = k.split(target, tools)
        } catch (e) {
          if (within) k.release(within.inner, ...within.outer)
          throw e
        }
        // What the fragments are told apart against: the sheets as they
        // are, or as they were carried on.
        let against: readonly Shape[] = tools
        let reaching: { tools: Shape[]; made: Shape[] } | null = null
        let kept: Shape[]
        // Skins that cross are refused as soon as the fragments show it,
        // carried on or not.
        const crossedWords = `The sheets cross inside ${body.name}: the corners they cut it into each have a face on every sheet, on different sides of them, so none is the wall between. Thicken one skin instead — fit it past the part's edge, trim it by Split or Combine, then Thicken.`
        try {
          // Kept between the sheets, every sheet has to cut: one that does
          // not reach leaves no fragment with a face on each.
          let wall = between ? this.betweenFragments(fragments, tools) : null
          if (wall?.crossed) throw new Error(crossedWords)
          if (fragments.length < 2 || (wall && wall.kept.length === 0)) {
            // A fitted surface ends where its region did, grown by a share:
            // short of the body's sides, it is carried on to them and the
            // cut tried again with it.
            reaching = this.reachingTools(step.tools, target, body.name)
            if (reaching) {
              if (between) this.sheetsApart(step.tools, reaching.tools, body, true)
              for (const f of fragments.splice(0)) k.release(f)
              fragments = k.split(target, reaching.tools)
              against = reaching.tools
              wall = null
            }
          }
          if (fragments.length < 2) throw new Error('The sheet does not cut the body into parts — it has to cross the body from side to side.')
          if (between) {
            wall ??= this.betweenFragments(fragments, against)
            if (wall.crossed) throw new Error(crossedWords)
            kept = wall.kept
          } else kept = this.keepFragments(fragments, step, false, within?.wall)
        } catch (e) {
          for (const f of fragments) k.release(f)
          if (within) k.release(...within.outer)
          throw e
        } finally {
          if (reaching) k.release(...reaching.made)
          if (within) k.release(within.inner)
        }
        if (kept.length === 0) {
          for (const f of fragments) k.release(f)
          if (within) k.release(...within.outer)
          throw new Error(
            step.keep === 'scan'
              ? 'No fragment lies on the scan within the tolerance — widen it, or keep the largest.'
              : between
                ? 'No fragment lies between the sheets — none has a face on every one of them. Each sheet has to cross the body from side to side, and the body to reach past them all.'
                : 'No fragment to keep.',
          )
        }
        const acc = fuseAll(this.kernel, [...kept, ...(within?.outer ?? [])])
        for (const f of fragments) if (!kept.includes(f)) k.release(f)
        // The kernel tracks no history for a split: each face of the kept
        // fragments that is new is traced by a point inside it to the face
        // of the body it lies on (kernelOps tracedHistory), and keeps that
        // face's maker. Only the faces on the tools are the split's.
        const history = k.tracedHistory(body.shape, acc)
        const offScan = this.offScanOf(step, body.shape, acc, history)
        return { shape: acc, history, ...(offScan.length > 0 ? { offScan } : {}) }
      }
    }
  }

  /** The edges a fillet rounds at a varying radius, by hash on the body as
   *  it stood before the fillet — or a throw naming the one that is gone. */
  private varyingEdges(bodyId: number, varying: readonly VariableEdge[], stepId: number): number[] {
    const found = this.findEdges(bodyId, varying.map((v) => v.edge), stepId, {})
    if ('lost' in found) throw new Error(`The edge this fillet rounds at a varying radius was on is gone (was: ${found.lost}).`)
    return found.hashes
  }

  /** A round or a chamfer of many edges that leaves out what the kernel
   *  cannot do: the whole set first, then - where that fails - each tangent
   *  chain added in turn and kept where the body still comes out a closed
   *  solid. The note says how many chains were left out and where. */
  private roundWhatHolds(
    step: Extract<BodyStep, { kind: 'fillet' | 'chamfer' }>,
    body: Body,
    hashes: readonly number[],
    all: readonly EdgeInfo[],
    splits: ReturnType<typeof splitEdges>,
    brief: (h: number) => EdgeBrief[],
  ): Tracked & { edges: EdgeBrief[]; note?: string } {
    const k = this.kernel
    const op = (hs: readonly number[]): Tracked =>
      step.kind === 'chamfer' && step.mode ? this.chamferSided(step, body, hs) : step.kind === 'fillet' ? k.filletTracked(body.shape, hs, step.radius) : k.chamferTracked(body.shape, hs, step.distance)
    const holds = (hs: readonly number[]): Tracked | null => {
      try {
        const r = op(hs)
        if (k.isClosedSolid(r.shape)) return r
        k.release(r.shape)
      } catch (e) {
        // A trap goes on at once: the kernel is broken from it on.
        if (isTrap(e)) throw e
        // Refused: that chain is the one left out.
      }
      return null
    }
    const whole = holds(hashes)
    if (whole) return { ...whole, edges: hashes.flatMap(brief) }
    const left = new Set(hashes)
    const chains: number[][] = []
    for (const h of hashes) {
      if (!left.has(h)) continue
      const picked = tangentChain(all, [h], splits).filter((x) => left.has(x))
      for (const x of picked) left.delete(x)
      chains.push(picked)
    }
    let kept: number[] = []
    let made: Tracked | null = null
    const skipped: number[][] = []
    for (const c of chains) {
      const r = holds([...kept, ...c])
      if (r) {
        if (made) k.release(made.shape)
        made = r
        kept = [...kept, ...c]
      } else skipped.push(c)
    }
    const verb = step.kind === 'fillet' ? 'round' : 'bevel'
    // units-ok: build message, also the agent's answer
    if (!made) throw new Error(`None of the ${chains.length} chains ${verb}s at ${step.kind === 'fillet' ? step.radius : step.distance} mm.`)
    const at = skipped.slice(0, 12).map((c) => {
      const e = all.find((x) => x.hash === c[0])
      return e ? `(${e.fingerprint.mid.map((v) => v.toFixed(3)).join(', ')})` : '(?)'
    })
    const note = `${skipped.length} of the ${chains.length} chains left out — the kernel cannot ${verb} ${skipped.length === 1 ? 'it' : 'them'} with the rest: at ${at.join(', ')}${skipped.length > at.length ? ' …' : ''}.`
    return { ...made, edges: kept.flatMap(brief), note }
  }

  /**
   * A fillet with edges at radii of their own: every edge in one call to
   * the kernel, the plain edges at the one radius and each varying edge
   * from its first radius to its second — so the edges given on one
   * tangent chain round as one, each at its own radii, and an edge of the
   * chain not given runs between its neighbours'. `at`: the varying
   * edges' hashes on the body as it stood (varyingEdges).
   */
  private roundVarying(step: Extract<BodyStep, { kind: 'fillet' }>, body: Body, hashes: readonly number[], varying: readonly VariableEdge[], at: readonly number[]): Tracked {
    const edges = [...hashes.map((hash) => ({ hash, radius: step.radius })), ...varying.map((v, i) => ({ hash: at[i], radius: v.radius }))]
    return this.kernel.filletRadii(body.shape, edges)
  }

  /**
   * A chamfer by two distances or by a distance and an angle (`step.mode`):
   * the kernel's angled chamfer, which measures from each edge's first face,
   * asked at each edge for what puts the chamfer wanted on the reference
   * face (referenceFaces) — the edges asking alike in one call, so a rim's
   * corners meet as one chamfer, any others after them, each on what the
   * call before left. The kernel chamfers a tangent chain as one, so a
   * chain asks as its first edge does. No history: the faces are traced by
   * where they lie, as a varying round's are. `scale` sizes the distances —
   * a diagnosis tries it smaller.
   */
  chamferSided(step: Extract<BuildStep, { kind: 'chamfer' }>, body: Body, hashes: readonly number[], scale = 1): Tracked {
    const k = this.kernel
    const want: SidedChamfer = step.mode === 'twoDistances' ? { mode: 'twoDistances', distance: step.distance, distance2: step.distance2 ?? step.distance } : { mode: 'distanceAngle', distance: step.distance, angleDeg: step.angleDeg ?? 45 }
    const topology = this.topology(body, 1)
    const all = topology.edges
    const splits = splitEdges(topology)
    const sides = k.edgeSides(body.shape, hashes)
    const lone = sides.findIndex((x) => x === null)
    if (lone >= 0) throw new Error(`A chamfer ${want.mode === 'twoDistances' ? 'by two distances' : 'at an angle'} goes on an edge between two faces — ${describeEdge(all.find((e) => e.hash === hashes[lone])!.fingerprint)} has one.`)
    const firstFaces = k.faces(body.shape)
    const refHashes = referenceFaces(sides.map((x) => x!.faces), step.flip ?? false)
    // The picked edges by tangent chain, each chain once; the reference
    // face of its first edge is the chain's.
    const left = new Set(hashes)
    const chains: { fingerprints: EdgeFingerprint[]; ref: RawFace }[] = []
    hashes.forEach((h, i) => {
      if (!left.has(h)) return
      const picked = tangentChain(all, [h], splits).filter((x) => left.has(x))
      for (const x of picked) left.delete(x)
      chains.push({ fingerprints: picked.map((x) => all.find((e) => e.hash === x)!.fingerprint), ref: firstFaces.find((f) => f.hash === refHashes[i])! })
    })
    let current: Tracked = { shape: body.shape, history: new Map() }
    let origins = body.origins
    let pending = chains
    try {
      while (pending.length > 0) {
        const facesNow = current.shape === body.shape ? firstFaces : k.faces(current.shape)
        const edgesNow = current.shape === body.shape ? all : this.topology({ name: body.name, shape: current.shape, origins }, 1).edges
        const tol = matchTolerance(diagonalOf(this.kernel, current.shape))
        const found = pending.map((c) =>
          c.fingerprints.flatMap((fp, j) => {
            const at = matchEdge(fp, edgesNow.map((e) => e.fingerprint), tol)
            if (at === null && j === 0) throw new Error(`An edge this chamfer cuts is gone once its other edges are chamfered (was: ${describeEdge(fp)}) — chamfer it in a feature of its own.`)
            return at === null ? [] : [edgesNow[at].hash]
          }),
        )
        const at = k.edgeSides(current.shape, found.map((f) => f[0]))
        const asks = pending.map((c, i) => {
          const s = at[i]
          if (!s) throw new Error(`An edge this chamfer cuts no longer lies between two faces (was: ${describeEdge(c.fingerprints[0])}).`)
          const two = s.faces.map((h) => facesNow.find((f) => f.hash === h)).filter((f): f is RawFace => f !== undefined)
          const ref = sameSurface(c.ref, two)
          const ask = angledAsk(want, ref === null || ref.hash === s.faces[0], s.normals, scale)
          if (typeof ask === 'string') throw new Error(`At ${describeEdge(c.fingerprints[0])}: ${ask}`)
          return ask
        })
        const key = (a: { distance: number; angleDeg: number }) => `${a.distance.toFixed(6)}|${a.angleDeg.toFixed(6)}`
        const taken = asks.map((a) => key(a) === key(asks[0]))
        const next = k.chamferAngled(current.shape, found.filter((_, i) => taken[i]).flat(), asks[0].distance, asks[0].angleDeg)
        const history = this.geometricHistory(facesNow, next)
        origins = this.propagate(next, origins, history, step.id)
        if (current.shape !== body.shape) k.release(current.shape)
        current = { shape: next, history: composeHistory(current.history, history) }
        pending = pending.filter((_, i) => !taken[i])
      }
    } catch (e) {
      if (current.shape !== body.shape) k.release(current.shape)
      throw e
    }
    return current
  }

  /** The faces of a shape a step made (not in `own`, by hash) that are
   *  slivers: narrower than SLIVER_MM, twice the area over the perimeter.
   *  Two bodies cut by one freeform sheet meet along it a hair apart, and
   *  a Combine of them leaves strips of their walls there, far thinner
   *  than anything the part has, which block a round on the edges beside
   *  them. A face that stood before the step stays out, however narrow. */
  private sliversOf(shape: Shape, own: ReadonlySet<number>): number[] {
    return this.kernel.narrowFaces(shape, SLIVER_MM, own).map((f) => f.hash)
  }

  /** A combine's or a join's result held to leaving no slivers
   *  (sliversOf) among the faces it made — `own`, the faces of what went
   *  in, stay out. On one it is played again fuzzy (`replay`), finer then
   *  coarser, and the first try that closes, `stands` and leaves none is
   *  taken, which the row says; when none does, the result stays and the
   *  row names the slivers. Two pieces whose walls lie a hair apart — a
   *  root built of overlapping pieces, two bodies cut by one sheet — meet
   *  that way. */
  private withoutSlivers<T extends Tracked>(result: T, own: ReadonlySet<number>, replay: () => T, stands: (shape: Shape) => boolean, what: string): T {
    const k = this.kernel
    const thin = k.narrowFaces(result.shape, SLIVER_MM, own)
    if (thin.length === 0) return result
    const n = thin.length
    const s = n === 1 ? '' : 's'
    for (const mm of [undefined, k.coarseFuzz]) {
      let again: T
      try {
        again = k.fuzzyBooleans(replay, mm)
      } catch (e) {
        if (isTrap(e)) throw e
        continue
      }
      if (k.isClosedSolid(again.shape) && stands(again.shape) && this.sliversOf(again.shape, own).length === 0) {
        k.release(result.shape)
        // units-ok: build message, also the agent's answer
        this.stepWarnings.push(`The ${what} was played again fuzzy: the first result left ${n} sliver face${s}, under ${SLIVER_MM} mm wide.`)
        return again
      }
      k.release(again.shape)
    }
    // units-ok: build message, also the agent's answer
    const named = thin.slice(0, 3).map((f) => `${f.width < 1e-3 ? f.width.toPrecision(2) : Math.round(f.width * 10000) / 10000} mm wide at (${f.centroid.map((v) => v.toFixed(2)).join(', ')})`)
    // units-ok: build message, also the agent's answer
    this.stepWarnings.push(`The ${what} left ${n} sliver face${s}, under ${SLIVER_MM} mm wide: ${named.join('; ')}${n > named.length ? ` and ${n - named.length} more` : ''} — two faces a hair apart, as overlapping pieces leave them; a round on the edges beside ${n === 1 ? 'it' : 'them'} will likely fail. Overlap the pieces clearly or draw them as one profile; reverse.body.check lists ${n === 1 ? 'it' : 'them'} under narrow.`)
    return result
  }

  /** A shell's new faces that are slivers (sliversOf) or under
   *  TINY_FACE_MM2, warned of by index — a round on the edges beside one
   *  fails. The ways of shelling by booleans (shellTracked) leave them
   *  where the wall meets the body's own faces, and which way builds can
   *  change with any edit upstream. */
  private shellSlivers(shape: Shape, body: Body): void {
    const k = this.kernel
    const own = new Set(k.faceHashes(body.shape))
    const narrow = new Set(this.sliversOf(shape, own))
    const faces = k.faces(shape)
    const tiny = faces.map((f, index) => ({ f, index })).filter(({ f }) => !own.has(f.hash) && (narrow.has(f.hash) || f.area < TINY_FACE_MM2))
    if (tiny.length === 0) return
    const n = tiny.length
    const named = tiny
      .sort((a, b) => a.f.area - b.f.area)
      .slice(0, 3)
      // units-ok: build message, also the agent's answer.
      .map(({ f, index }) => `face ${index} (${f.area < 0.01 ? f.area.toPrecision(2) : Math.round(f.area * 100) / 100} mm² at (${f.centroid.map((v) => v.toFixed(1)).join(', ')}))`)
    const more = n > named.length ? ` and ${n - named.length} more` : ''
    // units-ok: build message, also the agent's answer
    this.stepWarnings.push(`The shell left ${n} sliver face${n === 1 ? '' : 's'}, under ${SLIVER_MM} mm wide or ${TINY_FACE_MM2} mm²: ${named.join(', ')}${more} — a round on the edges beside ${n === 1 ? 'it' : 'them'} will likely fail; reverse.body.check lists them.`)
  }

  /** The fragments of a split that lie between its sheets: those with a
   *  face on every one of them — the wall between a part's outer and inner
   *  skin, where the fragments outside have a face on one alone — and all
   *  on the same side of each sheet. A face is on a sheet where a point in
   *  the middle of one of its triangles lies on it within the chord's sag;
   *  the fragment lies on the side of the sheet its face there looks away
   *  from. Two skins that cross inside the body cut it into corners each
   *  with a face on both, on different sides: none is kept, and `crossed`
   *  says why — kept, they were the whole body. */
  private betweenFragments(fragments: readonly Shape[], tools: readonly Shape[]): { kept: Shape[]; crossed: boolean } {
    const k = this.kernel
    if (tools.length < 2) return { kept: [], crossed: false }
    const kept: Shape[] = []
    const sides = new Set<string>()
    for (const f of fragments) {
      const sag = meshDeflection(diagonalOf(k, f))
      const drawn = k.mesh(f, sag)
      const points = new Map<number, Vec3>()
      const p = drawn.positions
      for (let t = 0; t < (drawn.faceHash?.length ?? 0); t++) {
        if (points.has(drawn.faceHash![t])) continue
        const a = drawn.indices[t * 3] * 3, b = drawn.indices[t * 3 + 1] * 3, c = drawn.indices[t * 3 + 2] * 3
        points.set(drawn.faceHash![t], [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3])
      }
      const near = 2 * sag + 1e-3
      const on = tools.map((tool) => [...points].find(([, at]) => k.distanceToPoint(tool, at) <= near))
      if (!on.every((x) => x !== undefined)) continue
      const side = tools
        .map((tool, i) => {
          const [hash, at] = on[i]!
          return dot(k.faceNormals(f, hash, [at])[0], k.sheetNormals(tool, [at])[0]) > 0 ? '-' : '+'
        })
        .join('')
      kept.push(f)
      sides.add(side)
    }
    return sides.size > 1 ? { kept: [], crossed: true } : { kept, crossed: false }
  }

  /** Before a split keeps what lies between its sheets: that no two of
   *  them meet inside the body — come within MEET_MM, and cross at a point
   *  inside it. Where they do, the wall between them closes there, and the
   *  kernel's cut by two skins that cross is slow and keeps every corner;
   *  refused, saying where. `carried`: the sheets as carried on to reach
   *  the body (reachingTools). By id with the shapes, for their names. */
  private sheetsApart(ids: readonly number[], shapes: readonly Shape[], body: Body, carried = false): void {
    const k = this.kernel
    const deflection = meshDeflection(this.diagonal(body))
    const sheet = (id: number) => this.bodyById(id)?.surface === true
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        // A solid among the tools is crossed by a sheet as a matter of course.
        if (!sheet(ids[i]) || !sheet(ids[j])) continue
        if (k.distanceBetween(shapes[i], shapes[j]) > MEET_MM) continue
        // Points spread evenly along where they cross: a straight crossing
        // is drawn by its two ends alone, which may both lie outside.
        const lines = k.crossing(shapes[i], shapes[j], deflection)
        let length = 0
        for (const l of lines) for (let q = 3; q + 2 < l.length; q += 3) length += Math.hypot(l[q] - l[q - 3], l[q + 1] - l[q - 2], l[q + 2] - l[q - 1])
        const step = length / MEET_SAMPLES
        let at: Vec3 | null = null
        for (const l of lines) {
          for (let q = 3; q + 2 < l.length && !at; q += 3) {
            const a: Vec3 = [l[q - 3], l[q - 2], l[q - 1]]
            const d = sub([l[q], l[q + 1], l[q + 2]], a)
            const parts = Math.max(1, Math.ceil(len(d) / Math.max(step, 1e-9)))
            for (let s = 0; s <= parts && !at; s++) {
              const p = addScaled(a, d, s / parts)
              if (k.containsPoint(body.shape, p, 1e-6)) at = p
            }
          }
        }
        if (!at) continue
        const name = (id: number) => this.bodyById(id)?.name ?? `body ${id}`
        throw new Error(`${name(ids[i])} and ${name(ids[j])}${carried ? `, carried on to reach ${body.name},` : ''} meet at (${at.map((v) => v.toFixed(2)).join(', ')}), inside ${body.name} — the wall between them closes there, so no one solid lies between the two. Thicken one skin instead: fit it past the part's edge, trim it to shape by Split or Combine (both take a sheet), then Thicken.`)
      }
    }
  }

  /** The fragments of a split to keep: those on the scan, or the largest
   *  or the smallest by volume. A fragment is on the scan when the share
   *  of its faces' sample points within the tolerance of the scan is at
   *  least the overlap — the fragment of a pocket has the pocket's roof
   *  where the scan has its floor, and falls out. */
  private keepFragments(fragments: readonly Shape[], step: Extract<BuildStep, { kind: 'split' }>, sheet = false, leaveOut?: (p: Vec3) => boolean): Shape[] {
    const k = this.kernel
    const scan = this.scan
    if (step.keep === 'scan' && scan) {
      const kept: Shape[] = []
      for (const f of fragments) {
        const share = this.onScanShare(f, step.tolerance, leaveOut)
        if (share !== null && share >= step.overlap) kept.push(f)
      }
      return kept
    }
    // A sheet's pieces by their area.
    const sizes = fragments.map((f) => (sheet ? k.surfaceArea(f) : k.volume(f)))
    const pick = step.keep === 'smallest' ? sizes.indexOf(Math.min(...sizes)) : sizes.indexOf(Math.max(...sizes))
    return pick >= 0 ? [fragments[pick]] : []
  }

  /**
   * A split within its sheets' regions (SplitFeature within): each fitted
   * sheet's region outline grown by `margin` (surfaceRegion regionOutline)
   * stood up along the sheet's height direction through the body, as a
   * prism — the body inside the prisms is what the sheets cut (`inner`),
   * the body outside them is put back as it was (`outer`, its solids).
   * `wall` tells a point on a prism's side — no face of the part, but where
   * the cut stops — which keep "scan" does not read. The shapes are the
   * caller's to release. Refused for a tool with no region, and where the
   * outlines miss the body.
   */
  private withinRegions(ids: readonly number[], margin: number, body: Body): { inner: Shape; outer: Shape[]; wall: (p: Vec3) => boolean } {
    const k = this.kernel
    const prisms: Shape[] = []
    const walls: ((p: Vec3) => boolean)[] = []
    try {
      for (const id of ids) {
        const b = this.bodyById(id)!
        const fit = b.fit
        if (!fit?.footprint) throw new Error(`${b.name} has no region to keep the cut within — within takes freeform fitted surfaces (Fit Surface). Leave within out to cut with the whole of it.`)
        const outline = regionOutline(fit, margin)
        if (!outline) throw new Error(`${b.name}'s region has no outline to keep the cut within.`)
        const reach = reachAlong(k, [body.shape], fit.origin, fit.normal)
        const lo = reach.min - 1
        const at = (u: number, v: number): Vec3 => addScaled(addScaled(addScaled(fit.origin, fit.axisU, u), fit.axisV, v), fit.normal, lo)
        for (const loop of outline.loops) {
          const points = loop.map(([u, v]) => at(u, v))
          const face = k.face({ outer: points.map((a, i): LoopPiece => ({ kind: 'line', a, b: points[(i + 1) % points.length] })), holes: [] })
          try {
            prisms.push(k.extrude(face, fit.normal, 0, reach.max + 1 - lo))
          } finally {
            k.release(face)
          }
        }
        const { field, level } = outline
        walls.push((p) => {
          const d = sub(p, fit.origin)
          return Math.abs(fieldAt(field, dot(d, fit.axisU), dot(d, fit.axisV)) - level) <= 2 * field.cell
        })
      }
    } catch (e) {
      k.release(...prisms)
      throw e
    }
    const prism = fuseAll(k, prisms)
    try {
      const inner = k.common(body.shape, prism)
      if (!(k.volume(inner) > 1e-9)) {
        k.release(inner)
        // units-ok: build message, also the agent's answer
        throw new Error(`The regions' outlines, grown by ${margin} mm, miss ${body.name} — there is nothing within them to cut.`)
      }
      const rest = k.cut(body.shape, prism)
      const outer = k.solids(rest).filter((s) => {
        if (k.volume(s) > 1e-9) return true
        k.release(s)
        return false
      })
      k.release(rest)
      return { inner, outer, wall: (p) => walls.some((w) => w(p)) }
    } finally {
      k.release(prism)
    }
  }

  /**
   * How much of a split's cut face lies off the scan past the regions of
   * the fitted sheets it was cut by (surfaceRegion offPastRegion): the
   * faces of `shape` the split made — neither the body's (`before`) nor
   * traced to one of its faces (`history`) — sampled as onScanShare
   * samples a fragment, each point given to the fitted sheet it lies on,
   * as fitted or carried on (carriedHeight). Said on the row where a
   * sheet's cut face lies further off than the split's tolerance: a sheet
   * carried on past its region is no surface of the part there.
   */
  private offScanOf(step: Extract<BuildStep, { kind: 'split' }>, before: Shape, shape: Shape, history: FaceHistory): OffScanReport[] {
    const k = this.kernel
    const fitted = step.tools.map((id) => this.bodyById(id)).filter((b): b is Body & { fit: SurfaceFitResult } => b?.fit?.footprint !== undefined)
    if (fitted.length === 0) return []
    const diagonal = diagonalOf(k, shape)
    const near = this.nearScan(Math.max(1, 0.25 * diagonal))
    if (!near) return []
    const traced = new Set([...history.values()].flat())
    const old = new Set(k.faceHashes(before))
    const own = (h: number) => !old.has(h) && !traced.has(h)
    const mesh = k.mesh(shape, meshDeflection(diagonal))
    const p = mesh.positions
    const tris = mesh.indices.length / 3
    const areas = new Float64Array(tris)
    let whole = 0
    for (let t = 0; t < tris; t++) {
      if (!mesh.faceHash || !own(mesh.faceHash[t])) continue
      const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3
      const n = cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]])
      areas[t] = Math.hypot(n[0], n[1], n[2]) / 2
      whole += areas[t]
    }
    if (!(whole > 0)) return []
    // Each sample to the sheet it lies on — the nearest, within a hair.
    const on = Math.max(0.01, 1e-4 * diagonal)
    const byTool = fitted.map(() => ({ points: [] as number[], areas: [] as number[] }))
    for (let t = 0; t < tris; t++) {
      if (!(areas[t] > 0)) continue
      const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3
      const count = Math.max(1, Math.round((SPLIT_SAMPLES * areas[t]) / whole))
      for (let i = 0; i < count; i++) {
        let u = count === 1 ? 1 / 3 : halton(i + 1, 2)
        let v = count === 1 ? 1 / 3 : halton(i + 1, 3)
        if (u + v > 1) {
          u = 1 - u
          v = 1 - v
        }
        const w = 1 - u - v
        const q: Vec3 = [w * p[a] + u * p[b] + v * p[c], w * p[a + 1] + u * p[b + 1] + v * p[c + 1], w * p[a + 2] + u * p[b + 2] + v * p[c + 2]]
        let best = -1
        let gap = on
        fitted.forEach((tool, j) => {
          const d = sub(q, tool.fit.origin)
          const off = Math.abs(dot(d, tool.fit.normal) - carriedHeight(tool.fit, dot(d, tool.fit.axisU), dot(d, tool.fit.axisV)))
          if (off <= gap) [best, gap] = [j, off]
        })
        if (best < 0) continue
        byTool[best].points.push(...q)
        byTool[best].areas.push(areas[t] / count)
      }
    }
    const out: OffScanReport[] = []
    fitted.forEach((tool, j) => {
      const off = offPastRegion(tool.fit, byTool[j].points, byTool[j].areas, near, step.tolerance)
      if (!off) return
      const at = off.at.map((x) => Math.round(x * 100) / 100) as Vec3
      out.push({ tool: tool.name, max: Math.round(off.max * 1000) / 1000, area: Math.round(off.area * 10) / 10, at })
      if (off.max > step.tolerance) {
        // units-ok: build message, also the agent's answer
        this.stepWarnings.push(`The cut face lies up to ${off.max.toFixed(2)} mm off the scan past ${tool.name}'s region, at (${at.join(', ')}) — ${areaWords(off.area)} mm² of it further off than the ${step.tolerance} mm tolerance: the sheet past its region is not the part's surface there. Split within its region (within), or fit it over more of the scan.`)
      }
    })
    return out
  }

  /**
   * A sheet split (features.ts SplitFeature): cut by its tools — sheets or
   * solids — into pieces (kernel sheetPieces), the pieces kept as for a
   * body's fragments but the largest and the smallest by area, and the
   * kept ones sewn into one sheet. What a fitted skin laid past the part's
   * edge is trimmed back by before it is thickened: the overshoot past a
   * lip's tip has no scan behind it and falls out. A fitted tool that
   * stops short of the sheet's edges is carried on to them, as for a body
   * (reachingTools). Between is a solid's: refused. The faces kept are the
   * sheet's own, traced by where they lie (tracedHistory), so the skin a
   * Thicken makes of it is still the surface's.
   */
  private splitSheet(step: Extract<BodyStep, { kind: 'split' }>, body: Body): Tracked & { patches?: Map<number, number>; fit?: SurfaceFitResult } {
    const k = this.kernel
    if (step.keep === 'between') throw new Error(`${body.name} is a sheet: keep "between" takes the wall between two skins out of a solid. A sheet split keeps its pieces on the scan, the largest or the smallest.`)
    if (step.within !== undefined) throw new Error(`${body.name} is a sheet: within keeps a solid's cut to the sheets' regions. Trim the sheet by sheets or solids as they are, or fit it over less.`)
    const tools = step.tools.map((id) => this.bodyById(id)?.shape).filter((s): s is Shape => s !== undefined)
    if (tools.length !== step.tools.length) throw new Error('A sheet or body this split cuts with is gone, or failed to build.')
    let pieces: Shape[] = []
    let reaching: { tools: Shape[]; made: Shape[] } | null = null
    let kept: Shape[]
    try {
      pieces = k.sheetPieces(body.shape, tools, SHEET_SEW_MM)
      if (pieces.length < 2) {
        reaching = this.reachingTools(step.tools, body.shape, body.name)
        if (reaching) {
          for (const p of pieces.splice(0)) k.release(p)
          pieces = k.sheetPieces(body.shape, reaching.tools, SHEET_SEW_MM)
        }
      }
      if (pieces.length < 2) throw new Error(`The tools do not cut ${body.name} into pieces — a tool has to cross the sheet from edge to edge.`)
      kept = this.keepFragments(pieces, step, true)
    } catch (e) {
      for (const p of pieces) k.release(p)
      throw e
    } finally {
      if (reaching) k.release(...reaching.made)
    }
    if (kept.length === 0) {
      for (const p of pieces) k.release(p)
      throw new Error(step.keep === 'scan' ? `No piece of ${body.name} lies on the scan within the tolerance — widen it, or keep the largest.` : 'No piece to keep.')
    }
    let sewn: { shape: Shape; pieces: number }
    try {
      sewn = kept.length === 1 ? { shape: kept[0], pieces: 1 } : k.sewSheet(kept, SHEET_SEW_MM)
    } finally {
      for (const p of pieces) if (kept.length > 1 || p !== kept[0]) k.release(p)
    }
    if (sewn.pieces > 1) this.stepWarnings.push(this.apartWords(body.name, sewn.pieces))
    return { shape: sewn.shape, ...this.sheetHistory([body], sewn.shape), ...(body.fit ? { fit: body.fit } : {}) }
  }

  /**
   * A Combine on a sheet: `intersect` keeps the sheet inside a solid tool
   * and `cut` outside it — the kernel's own boolean, its faces taken out
   * of the compound it answers and sewn, for a compound is no sheet a
   * Thicken takes — and `join` sews the sheet and the tool sheets into one,
   * no face dropped: two sheets trimmed to each other along where they
   * cross meet there edge to edge. Each face keeps the maker of the face of
   * the sheet or the tool it is a piece of (tracedHistory).
   */
  private combineSheet(step: Extract<BodyStep, { kind: 'boolean' }>, body: Body, tools: readonly Body[]): Tracked & { patches?: Map<number, number>; fit?: SurfaceFitResult } {
    const k = this.kernel
    const named = tools.length === 1 ? tools[0].name : 'the tool'
    if (step.op === 'join') {
      const solid = tools.find((t) => !t.surface)
      if (solid) throw new Error(`${body.name} is a sheet, and ${solid.name} a solid — a sheet joins sheets. Thicken the sheet first, then join the two.`)
      let pieces = 0
      for (const tolerance of SHEET_JOIN_MM) {
        const sewn = k.sewSheet([body.shape, ...tools.map((t) => t.shape)], tolerance)
        if (sewn.pieces === 1) return { shape: sewn.shape, ...this.sheetHistory([body, ...tools], sewn.shape) }
        pieces = sewn.pieces
        k.release(sewn.shape)
      }
      // units-ok: build message, also the agent's answer
      throw new Error(`${body.name} and ${named} do not meet edge to edge — sewn within ${SHEET_JOIN_MM[SHEET_JOIN_MM.length - 1]} mm they stay ${pieces} sheets apart. Trim each by the other first (Split, keep scan), so that both end where they cross.`)
    }
    const sheet = tools.find((t) => t.surface)
    if (sheet) throw new Error(`${sheet.name} is a sheet: a Combine trims a sheet by a solid — intersect keeps it inside, cut outside. To trim a sheet by another sheet, Split it.`)
    const held = tools.length > 1 ? k.fuseAll(tools.map((t) => t.shape)) : null
    let raw: Tracked
    try {
      raw = step.op === 'intersect' ? k.commonTracked(body.shape, held ?? tools[0].shape) : k.cutTracked(body.shape, held ?? tools[0].shape)
    } finally {
      if (held) k.release(held)
    }
    const faces = k.facesOf(raw.shape)
    k.release(raw.shape)
    if (faces.length === 0) throw new Error(`Nothing of ${body.name} lies ${step.op === 'intersect' ? 'inside' : 'outside'} ${named} — ${step.op === 'intersect' ? 'the sheet has to run into the solid' : 'the solid takes all of it'}.`)
    let sewn: { shape: Shape; pieces: number }
    try {
      sewn = k.sewSheet(faces, SHEET_SEW_MM)
    } finally {
      k.release(...faces)
    }
    if (sewn.pieces > 1) this.stepWarnings.push(this.apartWords(body.name, sewn.pieces))
    return { shape: sewn.shape, ...this.sheetHistory([body], sewn.shape), ...(body.fit ? { fit: body.fit } : {}) }
  }

  /** A sheet trimmed or sewn: its faces traced to the faces of the sheets
   *  they are pieces of, and a patch network's faces each given the patch
   *  of the face it came from. */
  private sheetHistory(from: readonly Body[], shape: Shape): { history: FaceHistory; patches?: Map<number, number> } {
    const history = this.kernel.tracedHistory(from.map((b) => b.shape), shape)
    const patchOf = new Map(from.flatMap((b) => [...(b.patches ?? [])]))
    if (patchOf.size === 0) return { history }
    const patches = new Map<number, number>()
    for (const h of this.kernel.faceHashes(shape)) {
      const was = patchOf.get(h)
      if (was !== undefined) patches.set(h, was)
    }
    for (const [old, made] of history) {
      const p = patchOf.get(old)
      if (p !== undefined) for (const h of made) patches.set(h, p)
    }
    return { history, patches }
  }

  /** A sheet that came out of a trim in pieces apart, in words. */
  private apartWords(name: string, pieces: number): string {
    return `${name} came out as ${pieces} pieces apart — a cutter as it is, but a Thicken takes one piece: split it again to keep one, or thicken each.`
  }

  /**
   * Where a round, a chamfer, a shell, a draft or an offset failed, for the
   * operator to see on the part: which of its edges or faces the kernel
   * cannot do at the size asked, each tried alone, and the largest size at
   * which it can — a sentence and the polylines to draw red. Null for a
   * step of another kind, or for a failure that is not the kernel's to
   * explain: a pick that is gone, a body that is gone. Costs an operation
   * per pick and a few more per pick that fails, so it is asked only once
   * a step has failed, never on the way. `stepMs`, the failed step's own
   * time, bounds a shell's and a round's diagnosis (diagnoseShell,
   * diagnoseRound); none, no bound.
   */
  diagnose(step: BuildStep, stepMs?: number): Diagnosis | null {
    if (step.kind !== 'fillet' && step.kind !== 'chamfer' && step.kind !== 'shell' && step.kind !== 'draft' && step.kind !== 'offsetBody') return null
    try {
      const body = this.bodyFor(step)
      if (body.surface) return null
      if (step.kind === 'draft') return diagnoseDraft(this.kernel, this, step, body)
      if (step.kind === 'offsetBody') return diagnoseOffset(this.kernel, step, body)
      return step.kind === 'shell'
        ? diagnoseShell(this.kernel, this, step, body, stepMs === undefined ? undefined : shellDiagnosisBudget(stepMs))
        : diagnoseRound(this.kernel, this, step, body, stepMs === undefined ? undefined : roundDiagnosisBudget(stepMs))
    } catch {
      // A diagnosis that fails itself has nothing to add to the failure it was asked about.
      return null
    }
  }

  /** A step the kernel crashed on, diagnosed on the fresh kernel the part
   *  was built again on (reService): on the body as it stood before the
   *  step — kept for it as for any step that failed — within `ms`. An
   *  offset does not offset the whole body again, which is what crashed
   *  it, but reads its faces one at a time. Whether the diagnosis crashed
   *  the kernel too is the kernel's `trapped` to say. */
  diagnoseCrashed(step: BuildStep, ms: number): Diagnosis | null {
    if (step.kind !== 'fillet' && step.kind !== 'chamfer' && step.kind !== 'shell' && step.kind !== 'offsetBody') return null
    try {
      const body = this.bodyFor(step)
      if (body.surface) return null
      if (step.kind === 'offsetBody') return diagnoseOffset(this.kernel, step, body, { deadline: performance.now() + ms })
      if (step.kind === 'shell') return diagnoseShell(this.kernel, this, step, body, { ms, perTry: 0 })
      // The round that crashed is not tried again; a try that traps
      // stops the diagnosis.
      return diagnoseRound(this.kernel, this, step, body, { ms, perTry: 0 }, true)
    } catch {
      return null
    }
  }

  /**
   * A body of the last build looked over: whether the kernel's check
   * passes it and it is one closed solid, its volume, area and face
   * count, the faces under `tinyArea` (and those with no area at all), the
   * faces the mesher drew nothing for, and its shells — a void sealed
   * inside is a shell of its own. With `before`, the body as it stood
   * before that step — the step's input, kept for its editing (stages) —
   * null where the step kept none.
   */
  check(bodyId: number, tinyArea: number, before?: number, roundTrip?: boolean | 'find'): BodyCheck | null {
    const staged = before !== undefined ? this.stages.get(before) : undefined
    const body = before !== undefined ? (staged?.get(bodyId) ?? staged?.get(this.resolve(bodyId))) : this.bodyById(bodyId)
    if (!body) return null
    const trip = roundTrip && !body.surface ? this.roundTripOf(body) : undefined
    const find = roundTrip === 'find' && !body.surface && before === undefined ? this.roundTripFind(bodyId, trip) : undefined
    const k = this.kernel
    const faces = k.faces(body.shape)
    const mesh = this.kernel.mesh(body.shape, meshDeflection(diagonalOf(this.kernel, body.shape)))
    const drawn = new Set<number>()
    if (mesh.faceHash) for (let i = 0; i < mesh.faceHash.length; i++) drawn.add(mesh.faceHash[i])
    const folds = body.surface ? null : this.foldsOf(body)
    // A face of no area has no centroid: its edges say where it is.
    const placing = faces.some((f) => f.area < NO_AREA_MM2) ? k.edges(body.shape, meshDeflection(diagonalOf(this.kernel, body.shape))) : []
    const back = !trip && !body.surface && faces.length <= READ_BACK_FACES ? (k.readBackParts(k.exportStep([body.shape], [{ name: body.name }]), [body.shape])[0] ?? null) : undefined
    return {
      valid: k.isValid(body.shape),
      closed: body.surface ? false : k.isClosedSolid(body.shape),
      solids: k.solidCount(body.shape),
      volume: body.surface ? 0 : k.measuredVolume(body.shape, mesh),
      area: k.surfaceArea(body.shape),
      faces: faces.length,
      tiny: faces.filter((f) => f.area < tinyArea).map((f) => ({ hash: f.hash, area: f.area, centroid: faceMiddle(f, placing) })),
      untessellated: mesh.faceHash ? faces.filter((f) => !drawn.has(f.hash)).map((f) => f.hash) : [],
      ...(mesh.faults ? { meshFaults: mesh.faults } : {}),
      shells: k.shellsPerSolid(body.shape),
      voids: body.surface ? [] : k.voids(body.shape),
      narrow: k.narrowFaces(body.shape, SLIVER_MM).map((f) => ({ ...f, centroid: faceMiddle(f, placing) })),
      odd: k.oddEdges(body.shape, { knife: true, limit: ODD_EDGES_KEPT }),
      short: k.shortEdges(body.shape, { limit: ODD_EDGES_KEPT }),
      ...(back !== undefined ? { readBack: back?.edges ?? [], readBackSolid: { closed: back?.closed ?? false, valid: back?.valid ?? false } } : {}),
      ...(folds ? { folds } : {}),
      ...(trip ? { roundTrip: trip } : {}),
      ...(find ? { find } : {}),
    }
  }

  /** A body written as STEP — as the export writes it, a part under its
   *  name — and read back in memory, no file: verifyStep's reading, the
   *  faces at each odd edge with the feature that made them. */
  private roundTripOf(body: Body): RoundTrip {
    const k = this.kernel
    const text = k.exportStep([body.shape], [{ name: body.name }])
    const check = this.withMakers(k.verifyStep(text, [body.shape]), [body])
    // Open by hairs only: whether the export mends it.
    const hairs = !check.ok && check.bodies[0] && check.bodies[0].freeEdges.length > 0 && check.bodies[0].freeEdges.every((e) => e.kind === 'free' && e.in === 'file' && e.length < 0.01)
    const mended = hairs ? k.exportStepMended([body.shape], [{ name: body.name }]).mended : []
    return { ok: check.ok, problems: check.problems, notes: check.notes, parts: check.parts, body: check.bodies[0] ?? null, ...(mended.length > 0 ? { mended } : {}) }
  }

  /**
   * The first step whose body does not come back whole from a STEP file:
   * the body's input to each step that worked on it (stages), in the
   * order the build played them, then the body as it stands — `end`, its
   * round trip, when the caller has it — each written and read back until
   * one fails. The step before that body made it so; for the first input,
   * the feature that made the body. Stops at the first, and at
   * ROUND_TRIP_FIND_MS with as far as it got.
   */
  private roundTripFind(bodyId: number, end?: RoundTrip, budgetMs = ROUND_TRIP_FIND_MS): RoundTripFind {
    const id = this.resolve(bodyId)
    const line: { stepId: number; body: Body }[] = []
    for (const [stepId, staged] of this.stages) {
      const b = staged.get(id) ?? staged.get(bodyId)
      if (b && !b.surface) line.push({ stepId, body: b })
    }
    const now = this.bodyById(bodyId)
    const of = line.length + (now ? 1 : 0)
    const started = performance.now()
    for (let i = 0; i < of; i++) {
      if (i > 0 && performance.now() - started > budgetMs) return { step: null, before: null, trip: null, checked: i, of, done: false }
      const atEnd = i === line.length
      const trip = atEnd && end ? end : this.roundTripOf(atEnd ? now! : line[i].body)
      if (trip.ok) continue
      const maker = i === 0 ? Math.floor(id) : line[i - 1].stepId
      return { step: { id: maker, name: this.names.get(maker) ?? null }, before: atEnd ? null : line[i].stepId, trip, checked: i + 1, of, done: true }
    }
    return { step: null, before: null, trip: null, checked: of, of, done: true }
  }

  /** A STEP check's faces given the feature that made them, from the
   *  bodies written, in order. */
  private withMakers(check: StepCheck, bodies: readonly Body[]): StepCheck {
    check.bodies.forEach((b, i) => {
      const origins = bodies[i]?.origins
      if (!origins) return
      for (const row of [...b.freeEdges, ...b.strayShells, ...(b.farthest ? [b.farthest] : [])]) for (const f of row.near) {
        const o = origins.get(f.hash)
        if (o !== undefined) f.origin = o
      }
    })
    return check
  }

  /** A body of the last build by id with its mesh — to a chord, if one is
   *  given — or null for a body that is not there. */
  meshById(id: number, chord?: number): { id: number; mesh: KernelMesh } | null {
    const b = this.bodyById(id)
    if (!b) return null
    const mesh = chord !== undefined ? this.kernel.mesh(b.shape, chord, 0.1) : this.meshes([id])[0]
    return mesh ? { id: this.resolve(id), mesh } : null
  }

  /**
   * Build the steps. `sketchOf` hands back a sketch by feature id, for the
   * reach an extrusion to a plane needs. With `reuse`, the build takes up
   * from the longest run of first steps a kept build shares with it
   * (stepKeys) — the state after them restored, only the steps after them
   * played — and is kept in turn, with the one before it: an appended
   * feature costs its own step, an edit at the end the last step, the
   * rollback bar moved up or down a state looked up. Bodies that came
   * through unchanged are not meshed again. Without `reuse` every step is
   * played and nothing kept is taken up from. Without `output` the bodies
   * are not meshed and none are handed back — a helper's build of a group
   * (exportPart). With `have`, the keys of the bodies the caller holds by
   * their ids, only the bodies it does not hold so are handed back whole;
   * every body is in `all`, in brief.
   */
  build(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined, reuse = false, output = true, have?: ReadonlyMap<number, string>): BuildResult {
    const { results, keys, was } = this.playAll(steps, sketchOf, reuse)
    if (!output) return { results, bodies: [], all: [], steps: this.lastSteps }
    const out = this.output()
    return { results: this.withChangesSaid(results, steps, keys, was), bodies: structuredClone(out.filter((b) => have?.get(b.id) !== b.key)), all: out.map(bodyBrief), steps: this.lastSteps }
  }

  /** A build for the page, as build with `reuse`: each body handed over as
   *  soon as it can be drawn — meshed and measured, with its topology where
   *  the build read it already. The rest, topologiesOf reads after. */
  buildDrawn(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined, have?: ReadonlyMap<number, string>): DrawnBuild {
    const { results, keys, was } = this.playAll(steps, sketchOf, true)
    const out = this.drawn()
    return { results: this.withChangesSaid(results, steps, keys, was), bodies: structuredClone(out.filter((b) => have?.get(b.id) !== b.key)), all: out.map(bodyBrief), steps: this.lastSteps }
  }

  /** The steps played, or taken up, for build and buildDrawn. */
  private playAll(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined, reuse: boolean): { results: FeatureResult[]; keys: string[]; was: KeptBuild | null } {
    // The picks the last build found are this build's before; a step not
    // played again keeps what it had.
    this.stepsInPlay = steps
    const was = this.standing
    const keys = reuse ? stepKeys(steps, sketchOf) : []
    // The longest run of first steps the tree holds a state for, walked
    // down by the steps' keys — every node above a state held has one.
    const path: PrefixNode[] = []
    for (let node = this.tree; path.length < keys.length; ) {
      const next = node.children.get(keys[path.length])
      if (!next?.state) break
      path.push((node = next))
    }
    const states = path.map((n) => n.state!)
    const reads = path.map((n) => n.reads!)
    this.restore(states.at(-1) ?? null)
    const results: FeatureResult[] = [...(states.at(-1)?.results ?? [])]
    const played = path.length < steps.length ? this.playFrom(steps, keys, path.length, sketchOf, { states, reads, results }, reuse) : []
    this.lastSteps = { recomputed: played.length, restored: steps.length - played.length, of: steps.length, played }
    this.stand({ keys, states, reads })
    this.settleOffered()
    this.forgetParts(steps)
    return { results, keys, was }
  }

  /** A build's results as they go out: a round or a chamfer that built in the
   *  build before and fails now says which features before it changed since
   *  — by the keys, so what no change reached is not named. A round that
   *  fails names a place on the body as it stands, often far from the change
   *  that made it fail. Copies: the results are kept with the states. */
  private withChangesSaid(results: readonly FeatureResult[], steps: readonly BuildStep[], keys: readonly string[], was: KeptBuild | null): FeatureResult[] {
    const last = was && was.keys.length > 0 && keys.length > 0 ? was.states.at(-1)?.results : undefined
    if (!last) return [...results]
    const known = new Set(was!.keys)
    const built = new Set(last.filter((r) => r.status === 'ok').map((r) => r.id))
    return results.map((r) => {
      const at = r.status === 'failed' && built.has(r.id) ? steps.findIndex((s) => s.id === r.id) : -1
      if (at < 0 || (steps[at].kind !== 'fillet' && steps[at].kind !== 'chamfer')) return r
      const changed = steps.slice(0, at).flatMap((s, i) => (known.has(keys[i]) ? [] : [this.names.get(s.id) ?? `feature ${s.id}`]))
      if (changed.length === 0) return r
      const named = changed.slice(0, CHANGES_NAMED).join(', ')
      const more = changed.length > CHANGES_NAMED ? ` and ${changed.length - CHANGES_NAMED} more` : ''
      return { ...r, message: `${r.message} It built in the last build; changed before it since: ${named}${more}.` }
    })
  }

  /**
   * A round or a chamfer of the last build tried at other sizes, on the body
   * as it stood before it: each made as the build would make it, read and
   * let go. Nothing after it is played and nothing is kept: the bodies, the
   * states and what the next build takes up from stay as they are. At each
   * size: whether it builds, by the build's own test, whether the kernel
   * passes it, its faces and its time; the sizes that would not fit in `ms`,
   * going by the slowest so far, are not begun. A kernel that traps stops
   * the tries there, said, for the caller to start another.
   */
  filletTry(stepId: number, sizes: readonly number[], ms = FILLET_TRY_MS): FilletTries {
    const k = this.kernel
    const step = this.stepsInPlay.find((s) => s.id === stepId)
    if (!step) throw new Error('It did not run in the last build — past the rollback bar, or suppressed. Build up to it first.')
    if (step.kind === 'failed') throw new Error(`It is not tried as it stands: ${step.message}`)
    if (step.kind !== 'fillet' && step.kind !== 'chamfer') throw new Error('Only a fillet or a chamfer is tried at other sizes.')
    if (step.kind === 'fillet' && (step.variable?.length ?? 0) > 0) throw new Error('A round at a varying radius has no one size to try: set its radii, and build.')
    const staged = this.stages.get(stepId)
    const body = staged?.get(step.body) ?? staged?.get(this.resolve(step.body))
    if (!body) throw new Error('The last build kept no body as it stood before it: the body it works on is gone, or failed to build.')
    const at = (size: number): typeof step => {
      if (step.kind === 'fillet') return { ...step, radius: size }
      // A chamfer by two distances keeps their proportion.
      return { ...step, distance: size, ...(step.distance2 !== undefined ? { distance2: (step.distance2 * size) / step.distance } : {}) }
    }
    const tries: FilletTry[] = []
    const began = performance.now()
    let slowest = 0
    let crashed: string | undefined
    for (const size of sizes) {
      if (crashed !== undefined || (tries.length > 0 && performance.now() - began + slowest > ms)) {
        tries.push({ size, tried: false })
        continue
      }
      const started = performance.now()
      try {
        const made = this.applyToBody(at(size))
        const closed = body.surface ? k.isSurface(made.shape) : k.isClosedSolid(made.shape)
        const read = { valid: k.isValid(made.shape), faces: k.faceCount(made.shape) }
        k.release(made.shape)
        tries.push({ size, tried: true, builds: closed, closed, ...read, ms: performance.now() - started, ...(made.note ? { note: made.note } : {}) })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (isTrap(e) || k.trapped !== null) crashed = message
        tries.push({ size, tried: true, builds: false, closed: false, valid: false, faces: 0, ms: performance.now() - started, message: withoutCallName(message) })
      }
      slowest = Math.max(slowest, performance.now() - started)
    }
    // What the tries left for a step's row, no step played them.
    this.stepWarnings = []
    this.edgesInPlay = null
    return { tries, ...(crashed !== undefined ? { crashed } : {}) }
  }

  /** The bodies of the last build with these ids, whole, as the build
   *  handed them out — for a caller that lost track of what it holds. */
  builtBodies(ids: readonly number[]): BuiltBody[] {
    const wanted = new Set(ids)
    return structuredClone(this.drawn().filter((b) => wanted.has(b.id)).map((b) => this.withTopology(b)))
  }

  /** The topology of the last build's bodies with these ids, by the key
   *  each was handed over at — what buildDrawn left to read after. */
  topologiesOf(ids: readonly number[]): { id: number; key: string; topology: BuiltBody['topology'] }[] {
    const wanted = new Set(ids)
    return structuredClone(this.drawn().filter((b) => wanted.has(b.id)).map((b) => ({ id: b.id, key: b.key, topology: this.withTopology(b).topology })))
  }

  /** The steps from `from` on played into `into`, the state after each
   *  kept there with what it read. Past the first step changed, a step
   *  that works on what the change did not reach — a body of its own, a
   *  sketch on a plane — is taken over from a kept build or an offered
   *  one rather than played. */
  private playFrom(steps: readonly BuildStep[], keys: readonly string[], from: number, sketchOf: (id: number) => Sketch | undefined, into: { states: Snapshot[]; reads: StepReads[]; results: FeatureResult[] }, reuse: boolean): { id: number; ms: number }[] {
    const played: { id: number; ms: number }[] = []
    for (const s of steps) if ('name' in s && typeof s.name === 'string') this.names.set(s.id, s.name)
    for (let i = from; i < steps.length; i++) {
      let read = reuse ? this.takeOver(keys[i], into.results) : null
      if (!read) {
        this.onStep?.(steps[i].id)
        const joining = this.joinMakers(steps[i])
        const cutting = this.cutMakers(steps[i])
        // The bodies as they stand before a cut: the ones it changes are
        // the ones its note reads.
        const uncut = cutting ? new Map(this.bodies) : null
        read = this.reading = new Map()
        this.stepWarnings = []
        this.edgesInPlay = null
        const started = performance.now()
        try {
          this.play(steps[i], sketchOf, into.results)
          // A trap a helper caught and tried again past is a trap all the
          // same: the kernel is broken from it on.
          if (this.kernel.trapped !== null) throw new KernelTrap(this.kernel.trapped)
        } catch (e) {
          if (isTrap(e)) {
            this.trappedOn = steps[i].id
            this.trapEdges = this.edgesInPlay
          }
          throw e
        } finally {
          this.reading = null
        }
        if (joining) this.noteStepsBetween(steps[i], joining, into.results)
        if (cutting && uncut) this.noteCutsElsewhere(steps[i], cutting, uncut, into.results)
        const ms = performance.now() - started
        played.push({ id: steps[i].id, ms })
        if (this.stepWarnings.length > 0) {
          const result = [...into.results].reverse().find((r) => r.id === steps[i].id)
          if (result?.status === 'ok') result.warning = [...new Set(this.stepWarnings)].join(' ')
        }
        if (reuse) this.timed(keys[i], ms)
      }
      into.reads.push(read)
      into.states.push(this.snapshot(into.results))
    }
    if (played.length > 0) this.onStep?.(null)
    return played
  }

  /** For a step that joins: which makers' faces it brings in — its own,
   *  or a Combine's tool's — for the steps it leaves against the rest to
   *  be told (noteStepsBetween). Null for any other step. */
  private joinMakers(step: BuildStep): ((origin: number) => boolean) | null {
    if (step.kind === 'boolean') {
      if (step.op !== 'join') return null
      const into = new Set([...this.bodies.get(this.resolve(step.body))?.origins.values() ?? []])
      const tool = new Set(this.toolFamily(step).flatMap((id) => [...this.bodies.get(id)?.origins.values() ?? []]))
      return (o) => tool.has(o) && !into.has(o)
    }
    if (!JOINING.has(step.kind) || !('op' in step) || step.op !== 'join') return null
    return (o) => o === step.id
  }

  /** The steps a join left between the faces it brought and the faces it
   *  found (stepsBetween.ts), kept on its result — the page words them,
   *  the pieces traced, on the row. Read off the bodies' faces and edges,
   *  the very read the output takes of a body that stands to the end. */
  private noteStepsBetween(step: BuildStep, mine: (origin: number) => boolean, results: FeatureResult[]): void {
    const result = [...results].reverse().find((r) => r.id === step.id)
    if (result?.status !== 'ok') return
    const ids = step.kind === 'boolean' ? [this.resolve(step.body)] : (result.bodies ?? [])
    const found: StepBetween[] = []
    for (const id of ids) {
      const b = this.bodies.get(id)
      if (!b || b.surface) continue
      const { faces, edges } = this.topology(b, (b.fit ? surfaceMeshDeflection : meshDeflection)(this.diagonal(b)))
      found.push(...stepsOfJoin(faces, edges, mine))
    }
    if (found.length > 0) result.stepsBetween = found.sort((x, y) => Number(x.off < HAIR_MM) - Number(y.off < HAIR_MM) || x.off - y.off)
  }

  /** For a step that cuts — a solid's op cut (an extrude's, a revolve's),
   *  a hole, a Combine's cut — which makers' faces it leaves: its own, or
   *  the tool's. Null for any other step. Read before it is played, while
   *  the tool still stands. */
  private cutMakers(step: BuildStep): ((origin: number) => boolean) | null {
    if (step.kind === 'hole') return (o) => o === step.id
    if (step.kind === 'boolean') {
      if (step.op !== 'cut') return null
      const into = new Set([...this.bodies.get(this.resolve(step.body))?.origins.values() ?? []])
      const tool = new Set(this.toolFamily(step).flatMap((id) => [...this.bodies.get(id)?.origins.values() ?? []]))
      return (o) => tool.has(o) && !into.has(o)
    }
    if (!('op' in step) || step.op !== 'cut' || !('name' in step)) return null
    return (o) => o === step.id
  }

  /** A cut that also took material where it was likely not meant — an
   *  extent run on past the part into a far corner (cutElsewhere.ts) —
   *  said on its row, with what to change. */
  private noteCutsElsewhere(step: BuildStep, mine: (origin: number) => boolean, uncut: ReadonlyMap<number, Body>, results: FeatureResult[]): void {
    const result = [...results].reverse().find((r) => r.id === step.id)
    if (result?.status !== 'ok' || !('name' in step)) return
    const todo = step.kind === 'extrude' ? 'Shorten the extent' : step.kind === 'revolve' ? 'Narrow the angle, or the profile' : step.kind === 'hole' ? 'Shorten its depth' : step.kind === 'boolean' ? 'Trim the tool' : 'Trim the cutting body'
    // Only the bodies this cut changed, and only the faces it made there:
    // a tool kept and used for another cut before left its faces on the
    // body that cut made, which this one did not touch.
    for (const [id, b] of this.bodies) {
      const was = uncut.get(id)
      if (b === was || b.surface || ![...b.origins.values()].some(mine)) continue
      const { faces, edges } = this.topology(b, (b.fit ? surfaceMeshDeflection : meshDeflection)(this.diagonal(b)))
      const made = (f: FaceInfo) => mine(f.fingerprint.origin) && !was?.origins.has(f.hash)
      const said = cutElsewhereWords(step.name, cutsElsewhere(faces, edges, made), todo)
      if (said) this.stepWarnings.push(said)
    }
  }

  /** A step's time noted by its key, the oldest let go past a bound. */
  private timed(key: string, ms: number): void {
    this.playMs.delete(key)
    this.playMs.set(key, ms)
    if (this.playMs.size > PLAY_TIMES) this.playMs.delete(this.playMs.keys().next().value!)
  }

  // ---- a build in parts, on several kernels --------------------------------------------
  // The kernel that builds the whole list is handed parts of it built
  // beforehand — a group of steps (buildGroups.ts) by itself (buildPart),
  // another by a helper kernel (exportPart there, offer here) — and takes
  // those steps over from them as it builds, by what each step read. A part
  // whose steps it cannot take over costs time, never the result: those
  // steps are played.

  /** Whether a kept build has a step of this key. */
  knows(key: string): boolean {
    return [...(this.byKey.get(key) ?? [])].some((n) => n.state !== null)
  }

  /** Some of the steps of the next build — a group of them — built on a
   *  state of their own, taken over from the kept builds where they can
   *  be, and offered to that build. */
  buildPart(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined): void {
    const keys = stepKeys(steps, sketchOf)
    this.restore(null)
    const part = { keys, states: [] as Snapshot[], reads: [] as StepReads[], results: [] as FeatureResult[] }
    this.playFrom(steps, keys, 0, sketchOf, part, true)
    this.offered.push({ keys, states: part.states, reads: part.reads })
  }

  /** The build standing written out for another kernel to take its steps
   *  over from (buildTransfer.ts) — a helper's group, built without output;
   *  `have`: the tokens that kernel holds already. */
  exportPart(tokens: Tokens, have: ReadonlySet<number>): PartExport | null {
    const b = this.standing
    if (!b) return null
    return writePart(this.kernel, b, tokens, have, b.keys.map((k) => this.playMs.get(k) ?? 0))
  }

  /** A part another kernel built, read in and offered to the next build;
   *  `source` names that kernel, whose tokens are its own. Throws, leaving
   *  nothing behind, on a part it cannot read. */
  offer(part: PartExport, source: string): void {
    let known = this.imported.get(source)
    if (!known) this.imported.set(source, (known = new Map()))
    const made: Shape[] = []
    const before = new Set(known.keys())
    try {
      this.offered.push(readPart(this.kernel, part, known, made))
    } catch (e) {
      for (const t of [...known.keys()]) if (!before.has(t)) known.delete(t)
      this.kernel.release(...made)
      throw e
    }
    part.keys.forEach((key, i) => {
      if (part.times[i] > 0) this.timed(key, part.times[i])
    })
  }

  /** The tokens of another kernel's objects held here — what it need not
   *  send again. */
  heldTokens(source: string): number[] {
    return [...(this.imported.get(source)?.keys() ?? [])]
  }

  /** The text of a STEP file handed in, by its key. */
  stepFile(key: string): string | undefined {
    return this.stepFiles.get(key)
  }

  /** After a build: the parts offered to it let go of, but for what the
   *  builds kept hold — the bodies taken over — and the objects read in
   *  from other kernels forgotten where no kept build holds them. */
  private settleOffered(): void {
    if (this.offered.length === 0 && this.imported.size === 0) return
    const held = new Set<number>(this.shapeHolders.keys())
    const objects = new Set<unknown>()
    for (const s of this.holders.keys()) objectsOf(s, objects)
    const loose = new Set<number>()
    for (const b of this.offered) for (const s of b.states) Builder.shapesOf(s, loose)
    for (const known of this.imported.values()) {
      for (const [token, o] of known) {
        if (objects.has(o)) continue
        known.delete(token)
        const shape = (o as Partial<Body>).shape
        if (typeof shape === 'number' && 'origins' in (o as object)) loose.add(shape)
      }
    }
    for (const shape of loose) if (!held.has(shape)) this.kernel.release(shape as Shape)
    this.offered = []
  }

  /** One step of a build played on the builder as it stands, what it says
   *  of its feature added to the results. */
  private play(step: BuildStep, sketchOf: (id: number) => Sketch | undefined, results: FeatureResult[]): void {
    const k = this.kernel
    // A round, a chamfer or a shell that failed says where, as far as
    // trying its picks one at a time can tell — see diagnose.
    const playing = step
    // The step's own time bounds a shell's diagnosis.
    const began = performance.now()
    const fail = (id: number, message: string, step?: BuildStep) => {
      // A kernel that trapped on the way is asked nothing more: the trap
      // is the step's failure, not what came after it.
      if (k.trapped !== null) throw new KernelTrap(k.trapped)
      const stepMs = performance.now() - began
      this.keepInput(playing)
      // A body the kernel's check fails already is the likely cause, not
      // the step: said so, with the step that last changed it, and not
      // diagnosed — a diagnosis on a broken body points anywhere.
      const input = step ? this.inputFault(step, results) : null
      if (input !== null) {
        results.push({ id, status: 'failed', message: `${message.replace(/\.$/, '')} — ${input}.` })
        return
      }
      const d = step ? this.diagnose(step, stepMs) : null
      // A diagnosis that found nothing on the body quotes what the kernel
      // said already — less the operation's name — and it is not said twice.
      // The kernel's text is quoted without the name of its own call in it
      // ("filletWithHistory"), which names nothing of the part.
      const told = withoutCallName(message)
      const said = told.replace(/^[A-Z][a-z ]+: /, '').replace(/\.$/, '')
      const quoted = d !== null && said.length > 0 && d.message.includes(said)
      results.push({ id, status: 'failed', message: d ? (quoted ? d.message : `${d.message} (${told})`) : told, ...(d && d.where.length > 0 ? { where: d.where } : {}) })
    }
    try {
      if (step.kind === 'failed') {
        fail(step.id, step.message)
        return
      }
      if (step.kind === 'sketch') {
        results.push(this.placeSketch(step, sketchOf(step.id), sketchOf))
        return
      }
      if (step.kind === 'trim') {
        const { shape, report, surface } = this.trimOf(step)
        // The split cuts every tool's face into new faces with no history,
        // so a kept face is traced to its surface by where it lies: its
        // centroid within the tolerance of a surface body's tessellation
        // makes that surface's feature its maker; the faces of the
        // measured elements are the trim's own.
        const sources = step.bodies.map((id) => ({ id, surface: surfaceOfMeshes(this.meshes([id])) })).filter((s): s is { id: number; surface: NominalSurface } => s.surface !== null)
        const hit = emptyHit()
        const own = new Map<number, number>()
        // Where a face lies is a point *on* it — the middle of one of its
        // triangles. Its centroid is not: a cylinder going the whole way
        // round has its on the axis, a radius away from the surface that
        // made it.
        const onFace = new Map<number, Vec3>()
        // A triangle's middle lies inside a round face by the chord's sag,
        // which the search has to allow for beside the tolerance.
        const sag = meshDeflection(diagonalOf(this.kernel, shape))
        const drawn = k.mesh(shape, sag)
        if (drawn.faceHash) {
          for (let t = 0; t < drawn.faceHash.length; t++) {
            if (onFace.has(drawn.faceHash[t])) continue
            const a = drawn.indices[t * 3] * 3, b = drawn.indices[t * 3 + 1] * 3, c = drawn.indices[t * 3 + 2] * 3
            onFace.set(drawn.faceHash[t], [(drawn.positions[a] + drawn.positions[b] + drawn.positions[c]) / 3, (drawn.positions[a + 1] + drawn.positions[b + 1] + drawn.positions[c + 1]) / 3, (drawn.positions[a + 2] + drawn.positions[b + 2] + drawn.positions[c + 2]) / 3])
          }
        }
        for (const f of k.faces(shape)) {
          let maker = step.id
          let best = step.tolerance + sag
          const at = onFace.get(f.hash) ?? f.centroid
          for (const s of sources) {
            if (s.surface.closest(at[0], at[1], at[2], hit, best) && hit.distance < best) {
              best = hit.distance
              maker = s.id
            }
          }
          own.set(f.hash, maker)
        }
        this.bodies.set(step.id, { name: step.name, shape, origins: own, surface })
        results.push({ id: step.id, status: 'ok', trim: report })
        return
      }
      if (step.kind === 'network') {
        const made = this.networkOf(step)
        if ('message' in made) {
          results.push({ id: step.id, status: 'failed', message: made.message, network: made.report })
          return
        }
        this.bodies.set(step.id, { name: step.name, shape: made.shape, origins: new Map(k.faceHashes(made.shape).map((h) => [h, step.id])), surface: !made.report.closed, patches: made.patches })
        const refused = made.report.cells.filter((c) => 'refused' in c)
        results.push({ id: step.id, status: 'ok', network: made.report, ...(refused.length > 0 ? { note: `${refused.length} cell${refused.length === 1 ? '' : 's'} not filled: ${refused.map((c) => ('refused' in c ? c.refused : '')).join('; ')}.` } : {}) })
        return
      }
      if (step.kind === 'surface') {
        const { face, report, primitive, fit } = this.surfaceOf(step)
        if (primitive) this.fitted.set(step.id, primitive)
        this.bodies.set(step.id, { name: step.name, shape: face, origins: new Map(k.faceHashes(face).map((h) => [h, step.id])), surface: true, ...(fit ? { fit } : {}) })
        results.push({ id: step.id, status: 'ok', surface: report })
        return
      }
      if (step.kind === 'sheet') {
        const sheet = this.sheetOf(step)
        if (!k.isSurface(sheet)) {
          k.release(sheet)
          fail(step.id, 'The sheet did not come out as a surface.')
          return
        }
        this.bodies.set(step.id, { name: step.name, shape: sheet, origins: new Map(k.faceHashes(sheet).map((h) => [h, step.id])), surface: true })
        results.push({ id: step.id, status: 'ok' })
        return
      }
      if (step.kind === 'thicken') {
        this.playThicken(step, fail, results)
        return
      }
      if (step.kind === 'extrude' || step.kind === 'revolve' || step.kind === 'extract' || step.kind === 'loft' || step.kind === 'sweep') {
        if ((step.kind === 'extrude' && !step.faceProfile) || step.kind === 'revolve') this.notePicksLost(step, sketchOf)
        const solid = step.kind === 'extract' ? primitiveSolid(this.kernel, step.primitive) : step.kind === 'loft' ? this.loftOf(step) : step.kind === 'sweep' ? this.sweepOf(step) : this.solidOf(step, sketchOf(step.sketchId))
        if (!k.isClosedSolid(solid)) {
          k.release(solid)
          fail(step.id, 'The result is not a closed solid.')
          return
        }
        this.place(step, solid, fail, results)
        return
      }
      // A STEP file's parts: a body for every solid, in the file's order,
      // under its part's name; a part of faces alone a surface body. Each
      // body holds its own handle on its solid, the file's read parts
      // staying the cache's.
      if (step.kind === 'import') {
        const made: number[] = []
        for (const part of this.partsOf(step.file)) {
          const solids = k.solids(part.shape)
          const pieces = solids.length > 0 ? solids : k.faceCount(part.shape) > 0 ? [k.copy(part.shape)] : []
          for (const shape of pieces) {
            const ids = this.settle(this.freshId(step.id), step.name, shape, new Map(k.faceHashes(shape).map((h) => [h, step.id])), step.id, solids.length === 0)
            if (part.name) for (const id of ids) this.looks.set(id, { label: part.name })
            made.push(...ids)
          }
        }
        if (made.length === 0) fail(step.id, 'The STEP file holds no solid and no surface.')
        else results.push({ id: step.id, status: 'ok', bodies: made })
        return
      }
      // Bodies moved: each turned and carried as it stands, its faces
      // keeping their makers — a fillet picked on it after is still on the
      // extrude's wall. Copied: the bodies stay, and the copies are the
      // move's own, bodies of its own beside them, under the name each
      // original brought from its file.
      if (step.kind === 'moveBody') {
        const ids = [...new Set(step.bodies.map((b) => this.resolve(b)))]
        const sources = ids.map((id) => ({ id, body: this.bodyBefore(step.id, id) }))
        if (sources.some((s) => !s.body)) {
          fail(step.id, 'A body this move takes is gone, or failed to build.')
          return
        }
        // Every body moved before any is put back: a move the kernel
        // refuses halfway leaves the bodies as they were.
        const moved: { id: number; body: Body; tracked: Tracked }[] = []
        try {
          for (const s of sources) moved.push({ id: s.id, body: s.body!, tracked: k.transformTracked(s.body!.shape, step.matrix) })
        } catch (e) {
          for (const m of moved) k.release(m.tracked.shape)
          throw e
        }
        const made: number[] = []
        for (const { id, body, tracked } of moved) {
          if (step.copy) {
            const copies = this.settle(this.freshId(step.id), body.name, tracked.shape, new Map(k.faceHashes(tracked.shape).map((h) => [h, step.id])), step.id, body.surface)
            const look = this.looks.get(id)
            if (look) for (const c of copies) this.looks.set(c, look)
            made.push(...copies)
          } else {
            this.stageBody(step.id, id, body)
            this.settle(id, body.name, tracked.shape, this.propagate(tracked.shape, body.origins, tracked.history, step.id), step.id, body.surface)
            made.push(id)
          }
        }
        results.push({ id: step.id, status: 'ok', bodies: made })
        return
      }
      // An offset that keeps its body is a body of its own beside it.
      if (step.kind === 'offsetBody' && step.keep) {
        const source = this.bodyFor(step)
        if (source.surface) {
          fail(step.id, 'A sheet has no inside to offset — offset a solid.')
          return
        }
        const grown = k.offsetSolid(source.shape, step.distance)
        const bodies = this.settle(this.freshId(step.id), step.name, grown, new Map(k.faceHashes(grown).map((h) => [h, step.id])), step.id)
        results.push({ id: step.id, status: 'ok', bodies })
        return
      }
      // A mirror not joined is a body of its own beside its source, as an
      // offset that keeps its body is: the source stands as it was, and a
      // Combine between the two finds both.
      if (step.kind === 'mirror' && !step.join) {
        const source = this.bodyFor(step)
        const mirrored = this.applyToBody(step)
        const bodies = this.settle(this.freshId(step.id), step.name, mirrored.shape, new Map(k.faceHashes(mirrored.shape).map((h) => [h, step.id])), step.id, source.surface)
        results.push({ id: step.id, status: 'ok', bodies })
        return
      }
      // A feature on a body: the body as it stands is worked on, the
      // makers of its faces carried across through the history — the
      // tool body's faces in a boolean are that body's makers, and the
      // tool is gone into the result.
      const body = this.bodyFor(step)
      const bodyId = this.resolve(step.body)
      const before = new Map(body.origins)
      const intoPieces = step.kind === 'boolean' ? this.bodyFamily(step).slice(1) : []
      for (const id of step.kind === 'boolean' ? [...this.toolFamily(step), ...intoPieces] : []) for (const [h, o] of this.bodies.get(id)?.origins ?? []) before.set(h, o)
      // A sheet is a cutter, not a body to fillet or shell — but it can be
      // patterned: the four cutters round a wheel are one sheet and its
      // copies; and trimmed before it is thickened: split by sheets or
      // solids, cut or intersected by a solid, sewn to another sheet. The
      // result stays a sheet.
      if (body.surface && step.kind !== 'pattern' && step.kind !== 'split' && step.kind !== 'boolean') {
        fail(step.id, 'A sheet is not worked on as a solid — split a body with it, or thicken it first. A sheet takes a Pattern, a Split (by sheets or solids) and a Combine (trimmed by a solid, or sewn to a sheet).')
        return
      }
      // A Combine is held to its volume identity: the volumes before it,
      // and — where the combine itself was quick, one tool — what the two
      // bodies share, worked out on its own.
      const tools = step.kind === 'boolean' ? this.toolFamily(step).map((id) => this.bodies.get(id)).filter((t): t is Body => t !== undefined) : []
      const intoBodies = [body, ...intoPieces.map((id) => this.bodies.get(id)).filter((b): b is Body => b !== undefined)]
      const volumes = step.kind === 'boolean' ? { body: intoBodies.reduce((v, b) => v + this.volumeOf(b.shape), 0), tool: tools.reduce((v, t) => v + this.volumeOf(t.shape), 0) } : null
      const started = performance.now()
      const first = this.applyToBody(step)
      let whole = body.surface ? k.isSurface(first.shape) : k.isClosedSolid(first.shape)
      let result: typeof first | null = first
      // A cut by a plane that leaves nothing takes the whole body: said,
      // with the pieces split off it — the one meant is likely among them
      // — and not played again.
      if (step.kind === 'cutPlane' && !whole && this.volumeOf(first.shape) <= 1e-9) {
        k.release(first.shape)
        fail(step.id, this.takesAll(step, bodyId, body))
        return
      }
      const combineAsk = (shape: Shape): GuardAsk | null => {
        // A sheet has no volume to hold a Combine of it to.
        if (step.kind !== 'boolean' || !volumes || body.surface) return null
        // Several tools joined may overlap one another: held to a join's
        // bounds, part by part — their sum is no tool's volume.
        if (step.op === 'join' && toolsOf(step).length > 1) return { kind: 'join', parts: [...intoBodies, ...tools].map((b) => this.volumeOf(b.shape)), result: this.volumeOf(shape) }
        const kind = step.op === 'join' ? 'union' : step.op === 'cut' ? 'subtract' : 'intersect'
        let common: number | undefined
        if (kind !== 'intersect' && tools.length === 1 && intoBodies.length === 1 && performance.now() - started < IDENTITY_CHECK_MS) {
          const shared = k.commonTracked(body.shape, tools[0].shape)
          common = this.volumeOf(shared.shape)
          k.release(shared.shape)
        }
        return { kind, ...volumes, ...(common !== undefined ? { common } : {}), result: this.volumeOf(shape) }
      }
      let refusal = whole ? (() => {
        const ask = combineAsk(first.shape)
        return ask ? volumeRefusal(ask) : null
      })() : null
      // A round or a chamfer that does not close is too big for its faces
      // — the diagnosis says where — with no boolean of its own to play
      // again.
      if ((!whole || refusal !== null) && !body.surface && step.kind !== 'fillet' && step.kind !== 'chamfer') {
        const why = refusal ?? 'left no closed solid'
        k.release(first.shape)
        result = this.playedAgain(() => this.applyToBody(step))
        whole = result !== null
        refusal = result ? (() => {
          const ask = combineAsk(result.shape)
          return ask ? volumeRefusal(ask) : null
        })() : null
        if (result && refusal === null) this.stepWarnings.push(`The ${step.kind === 'boolean' ? 'combine' : step.kind} was played again the kernel's other way: the first result ${why}.`)
      }
      if (result && refusal !== null) {
        k.release(result.shape)
        fail(step.id, `The combine cannot stand: ${refusal}.`)
        return
      }
      if (!whole || result === null) {
        if (result) k.release(result.shape)
        // Played again every way first (above): said, and for a combine
        // whether the bodies it took are sound alone.
        const played = !body.surface && step.kind !== 'fillet' && step.kind !== 'chamfer'
        const tried = !played ? '' : ` — ${this.triedWords(step.kind === 'boolean' ? [...intoBodies, ...tools] : [])}`
        if (body.surface) {
          fail(step.id, `The ${step.kind === 'boolean' ? 'combine' : step.kind} left no sheet the kernel's check passes.`, step)
          return
        }
        fail(step.id, step.kind === 'boolean' && step.op === 'intersect' ? this.emptyIntersectWords(intoBodies, tools, tried) : `The ${step.kind === 'cutPlane' ? 'cut' : step.kind === 'moveFace' ? (step.faces.length === 1 ? 'moved face' : 'moved faces') : step.kind === 'offsetBody' ? 'offset' : step.kind} left no closed solid${tried}.`, step)
        return
      }
      // Two bodies cut by one freeform sheet meet along it a hair apart,
      // and a Combine of them can leave slivers of their walls there
      // (sliversOf): played again fuzzy, the two skins are taken for one
      // and the slivers go. The kernel's defeaturing will not take them
      // off — on the lamp it worked two minutes and left them.
      // Any combine, of faces of any kind: three overlapping pieces of a
      // root leave them as well.
      if (step.kind === 'boolean' && !body.surface) {
        const own = new Set([...intoBodies, ...tools].flatMap((b) => k.faceHashes(b.shape)))
        result = this.withoutSlivers(
          result,
          own,
          () => this.applyToBody(step),
          (shape) => {
            const ask = combineAsk(shape)
            return !ask || volumeRefusal(ask) === null
          },
          'combine',
        )
      }
      if (step.kind === 'shell') this.shellSlivers(result.shape, body)
      // The body as it stood is kept for the feature's editing, not
      // released; the current body moves on — as a body a piece, where
      // the feature left it in pieces: a cut through its waist, copies
      // patterned apart.
      this.stageBody(step.id, bodyId, body)
      const origins = this.propagate(result.shape, before, result.history, step.id)
      for (const [h, instance] of result.copies ?? []) markCopy(origins, h, { pattern: step.id, instance })
      for (const id of result.consumed ?? []) {
        const gone = this.bodies.get(id)
        if (gone) this.stageBody(step.id, id, gone)
        this.bodies.delete(id)
        this.aliases.set(id, bodyId)
      }
      const split = step.kind === 'cutPlane' || step.kind === 'boolean'
      const settled = this.settle(bodyId, body.name, result.shape, origins, step.id, body.surface, result.consumed ?? [], split)
      // A sheet trimmed keeps what it was: a patch network's, each face the
      // patch of the face it is a piece of; a fitted surface's, its fit — a
      // split it cuts as a tool carries it on from the whole of it.
      const trimmed = body.surface ? this.bodies.get(bodyId) : undefined
      if (trimmed && result.patches) trimmed.patches = result.patches
      if (trimmed && result.fit) trimmed.fit = result.fit
      // No longer the whole patch it was fitted as (fittedFor); once
      // joined, never again one surface.
      if (trimmed && (step.kind === 'split' || step.kind === 'boolean')) trimmed.reshaped = body.reshaped === 'joined' || (step.kind === 'boolean' && step.op === 'join') ? 'joined' : 'trimmed'
      if (split) this.saySplit(step.kind === 'cutPlane' ? `The cut ${planeWords(step.plane.origin, step.plane.normal)}` : 'The combine', body.name, settled, step.id)
      results.push({ id: step.id, status: 'ok', ...(result.note ? { note: result.note } : {}), ...(result.edges ? { edges: result.edges } : {}), ...(step.kind === 'boolean' ? { took: tools.length } : {}), ...(result.offScan ? { offScan: result.offScan } : {}) })
    } catch (e) {
      // A trap is no failure of the step's own: the kernel is broken, and
      // the build stops for it to be started again — whatever was thrown
      // after it, and with no diagnosis asking the broken kernel more.
      if (isTrap(e)) throw e
      if (k.trapped !== null) throw new KernelTrap(k.trapped)
      fail(step.id, e instanceof Error ? e.message : String(e), step)
      // A fit refused for points that are not its surface's names them.
      const last = results[results.length - 1]
      if (e instanceof StraysRefusal && last?.id === step.id) last.strays = e.strays
    }
  }

  /** The bodies standing, as the viewport takes them: meshed, measured,
   *  their faces and edges read — a body handed over before as it was. */
  private output(): BuiltBody[] {
    return this.drawn().map((b) => this.withTopology(b))
  }

  /** A body handed over with its topology, read now if the build did not:
   *  kept with it, so it is handed over with it from then on. */
  private withTopology(drawn: DrawnBody): BuiltBody {
    const b = this.bodies.get(drawn.id)!
    return Object.assign(drawn, { topology: drawn.topology ?? this.topology(b, this.chordOf(b)) })
  }

  /** The chord a body is drawn to — a fitted freeform surface's after its
   *  size. */
  private chordOf(b: Body): number {
    return (b.fit ? surfaceMeshDeflection : meshDeflection)(this.diagonal(b))
  }

  /** The bodies standing, meshed and measured, with their topology where
   *  it has been read — a body handed over before as it was. */
  private drawn(): DrawnBody[] {
    const k = this.kernel
    const bodies: DrawnBody[] = []
    for (const [id, b] of this.bodies) {
      const shown = this.shown.get(b)
      const look = this.looks.get(id)
      if (shown && shown.id === id && shown.label === look?.label) {
        bodies.push(shown)
        continue
      }
      const deflection = this.chordOf(b)
      const mesh = k.mesh(b.shape, deflection)
      const topology = this.topologies.get(b)?.get(deflection)
      const built: DrawnBody = {
        id,
        key: `${this.keyMark}.${++this.keysGiven}`,
        name: b.name,
        mesh,
        volume: b.surface ? 0 : k.measuredVolume(b.shape, mesh),
        faces: k.faceCount(b.shape),
        closed: b.surface ? false : k.isClosedSolid(b.shape),
        surface: Boolean(b.surface),
        ...(topology ? { topology } : {}),
        ...(look ? { label: look.label } : {}),
        triangles: mesh.indices.length / 3,
        box: meshBox(mesh),
      }
      this.shown.set(b, built)
      bodies.push(built)
    }
    return bodies
  }

  /** The solid into the bodies: a body of its own (a body a piece), joined
   *  to every solid body it meets or cut out of them — or, for a feature
   *  saved with a target, joined to or cut from that body alone. */
  private place(
    step: SolidStep | Extract<BuildStep, { kind: 'extract' | 'loft' | 'sweep' | 'thicken' }>,
    solid: Shape,
    fail: (id: number, message: string) => void,
    results: FeatureResult[],
  ): void {
    const k = this.kernel
    if (step.op === 'new') {
      const bodies = this.settle(this.freshId(step.id), step.name, solid, new Map(k.faceHashes(solid).map((h) => [h, step.id])), step.id)
      // Apart, the solids are bodies of their own: a Combine naming the
      // feature takes them all, every other feature only the one it names.
      if (bodies.length > 1) this.stepWarnings.push(`The feature made ${bodies.length} separate solids — bodies ${bodies.join(', ')}. A Combine on it takes them all; a shell or draft works on the one it names, and a fillet or chamfer named on this feature with edges by a query goes on each solid it hits.`)
      results.push({ id: step.id, status: 'ok', bodies })
      return
    }
    if (step.target !== undefined) {
      this.placeOnTarget(step, step.target, solid, fail, results)
      return
    }
    try {
      const bodies = step.op === 'join' ? this.joinAll(step.id, step.name, solid) : this.cutAll(step.id, solid)
      results.push({ id: step.id, status: 'ok', bodies })
    } catch (e) {
      fail(step.id, e instanceof Error ? e.message : String(e))
    }
  }

  /** Join a solid to every solid body it meets: the bodies it bridges and
   *  the solid made one, a body of its own where it meets none. Each piece
   *  of what comes out keeps the id of the oldest body in it, or takes a
   *  fresh one of the step's; a body gone into another is aliased to it.
   *  Every body touched is staged as it stood. Nothing changes until the
   *  kernel has done the whole of it. The ids the solid went into.
   *
   *  Which body went into which piece is read off the pieces, not off the
   *  faces: a boolean's faces are merged where they lie on one surface,
   *  which names every face anew. A point on a body's surface is inside or
   *  on the piece the body went into. */
  private joinAll(stepId: number, name: string, solid: Shape): number[] {
    const k = this.kernel
    const own = new Map(k.faceHashes(solid).map((h) => [h, stepId]))
    const near = this.solidsNear(solid)
    if (near.length === 0) return this.settle(this.freshId(stepId), name, solid, own, stepId)
    const probes = near.map(([id, b]) => ({ id, ...this.probeOf(b.shape) }))
    const toolProbes =
      k.solidCount(solid) > 1
        ? k.solids(solid).map((piece) => {
            const probe = this.probeOf(piece)
            k.release(piece)
            return probe
          })
        : [this.probeOf(solid)]
    const origins = new Map(own)
    for (const [, b] of near) for (const [h, o] of b.origins) origins.set(h, o)
    // The solid joined to the bodies near it one by one — a shape of its
    // own, never the solid, as there is at least one.
    const fuseNear = (): Tracked => {
      let at = solid
      let history: FaceHistory = new Map()
      try {
        for (const [, b] of near) {
          const r = k.fuseTracked(at, b.shape)
          if (at !== solid) k.release(at)
          at = r.shape
          history = composeHistory(history, r.history)
        }
      } catch (e) {
        if (at !== solid) k.release(at)
        throw e
      }
      return { shape: at, history }
    }
    // Never less than any part, never more than all of them together.
    const parts = [this.volumeOf(solid), ...near.map(([, b]) => this.volumeOf(b.shape))]
    let joined: Tracked
    try {
      joined = this.guarded(fuseNear, (result) => ({ kind: 'join', parts, result }), 'Joining', [{ name, shape: solid }, ...near.map(([, b]) => b)])
      const ownFaces = new Set([...own.keys(), ...near.flatMap(([, b]) => k.faceHashes(b.shape))])
      joined = this.withoutSlivers(joined, ownFaces, fuseNear, (shape) => volumeRefusal({ kind: 'join', parts, result: this.volumeOf(shape) }) === null, 'join')
    } finally {
      k.release(solid)
    }
    const { shape: acc, history } = joined
    const made = this.propagate(acc, origins, history, stepId)
    // Each piece: the bodies in it, the oldest first, and whether the new
    // solid is in it at all. A body is claimed once.
    const claimed = new Set<number>()
    const pieces = this.islands(acc).map((p) => {
      const of = probes.filter((q) => !claimed.has(q.id) && k.containsPoint(p.shape, q.at, q.tolerance)).map((q) => q.id)
      for (const id of of) claimed.add(id)
      return { ...p, of, tool: toolProbes.some((q) => k.containsPoint(p.shape, q.at, q.tolerance)) }
    })
    const ids: number[] = []
    const kept = new Set<number>()
    for (const p of pieces) {
      // A body the new solid does not reach, standing in a piece of its own:
      // left as it was, its own shape and faces.
      if (!p.tool && p.of.length === 1) {
        k.release(p.shape)
        kept.add(p.of[0])
        continue
      }
      const id = p.of[0] ?? this.freshId(stepId)
      const was = this.bodies.get(id)
      for (const gone of p.of) {
        this.stageBody(stepId, gone, this.bodies.get(gone)!)
        if (gone !== id) {
          this.bodies.delete(gone)
          this.aliases.set(gone, id)
        }
        kept.add(gone)
      }
      this.bodies.set(id, { name: was?.name ?? name, shape: p.shape, origins: this.originsOn(p.shape, made) })
      ids.push(id)
    }
    // A body no piece claimed — its point fell where no piece is, which
    // only a kernel's tolerance can do — went into the first piece.
    for (const [id, b] of near) {
      if (kept.has(id)) continue
      this.stageBody(stepId, id, b)
      this.bodies.delete(id)
      if (ids.length > 0) this.aliases.set(id, ids[0])
    }
    return ids
  }

  /** A point on a solid's surface, in the middle of one of its faces: the
   *  middle of the largest triangle of a coarse mesh of it, and how far
   *  off the surface a chord may leave it. */
  private probeOf(shape: Shape): { at: Vec3; tolerance: number } {
    const sag = meshDeflection(diagonalOf(this.kernel, shape))
    const m = this.kernel.mesh(shape, sag)
    const p = m.positions
    let best = -1
    let at: Vec3 = [p[0], p[1], p[2]]
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3
      const n = cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]])
      const area = Math.hypot(n[0], n[1], n[2])
      if (area > best) {
        best = area
        at = [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3]
      }
    }
    return { at, tolerance: Math.max(sag * 2, 1e-4) }
  }

  /** Cut a solid out of every solid body it meets: a body it takes whole
   *  is gone, one it parts is a body a piece. A cut that meets no body is
   *  an error, as a CAD cut with nothing to cut is. Nothing changes until
   *  the kernel has cut every body. The ids of the bodies it cut. */
  private cutAll(stepId: number, solid: Shape): number[] {
    const k = this.kernel
    const tool = k.faceHashes(solid)
    const cuts: { id: number; body: Body; shape: Shape | null; origins: Map<number, number> }[] = []
    try {
      for (const [id, b] of this.solidsNear(solid)) {
        let r = k.cutTracked(b.shape, solid)
        const was = k.volume(b.shape)
        const left = this.volumeOf(r.shape)
        // A body the solid only touches is not cut.
        if (Math.abs(was - left) <= 1e-7 * Math.max(1, was)) {
          k.release(r.shape)
          continue
        }
        if (left <= 1e-9) {
          k.release(r.shape)
          cuts.push({ id, body: b, shape: null, origins: new Map() })
          continue
        }
        // Never more than the body was: played again the kernel's other
        // ways when it is, or when it is no closed solid.
        const closed = k.isClosedSolid(r.shape)
        const why = closed ? volumeRefusal({ kind: 'cut', body: was, result: left }) : 'left no closed solid'
        if (why !== null) {
          k.release(r.shape)
          const again = this.playedAgain(() => k.cutTracked(b.shape, solid))
          const still = again ? volumeRefusal({ kind: 'cut', body: was, result: this.volumeOf(again.shape) }) : why
          if (!again || still !== null) {
            if (again) k.release(again.shape)
            throw new Error(!again && !closed ? `The cut left no closed solid of ${b.name}.` : `The cut of ${b.name} cannot stand: ${still}.`)
          }
          this.stepWarnings.push(`The cut of ${b.name} was played again the kernel's other way: the first result ${why}.`)
          r = again
        }
        const before = new Map(b.origins)
        for (const h of tool) before.set(h, stepId)
        cuts.push({ id, body: b, shape: r.shape, origins: this.propagate(r.shape, before, r.history, stepId) })
      }
    } catch (e) {
      for (const c of cuts) if (c.shape) k.release(c.shape)
      k.release(solid)
      throw e
    }
    k.release(solid)
    if (cuts.length === 0) throw new Error('The cut meets no body — there is nothing for it to take out.')
    const ids: number[] = []
    for (const c of cuts) {
      this.stageBody(stepId, c.id, c.body)
      if (c.shape) {
        const settled = this.settle(c.id, c.body.name, c.shape, c.origins, stepId, false, [], true)
        this.saySplit('The cut', c.body.name, settled, stepId)
        ids.push(...settled)
      } else this.bodies.delete(c.id)
    }
    return ids
  }

  /** A join or a cut on the one body a feature saved with a target names. */
  private placeOnTarget(
    step: SolidStep | Extract<BuildStep, { kind: 'extract' | 'loft' | 'sweep' | 'thicken' }>,
    targetId: number,
    solid: Shape,
    fail: (id: number, message: string) => void,
    results: FeatureResult[],
  ): void {
    const k = this.kernel
    const id = this.resolve(targetId)
    const target = this.bodies.get(id)
    if (!target) {
      k.release(solid)
      fail(step.id, 'The body to join or cut is gone, or failed to build.')
      return
    }
    // A surface has no inside: a solid is neither joined to it nor cut out
    // of it — surfaces are closed into a solid by a Trim.
    if (target.surface) {
      k.release(solid)
      fail(step.id, `${target.name} is a surface, not a solid — a solid cannot ${step.op === 'join' ? 'join' : 'cut'} it. Set the result to New body.`)
      return
    }
    // The tool's faces are the step's own; the target's keep their
    // makers, and the history says which became which.
    const before = new Map(target.origins)
    for (const h of k.faceHashes(solid)) before.set(h, step.id)
    const combine = (): Tracked => (step.op === 'join' ? k.fuseTracked(target.shape, solid) : k.cutTracked(target.shape, solid))
    const parts = [this.volumeOf(target.shape), this.volumeOf(solid)]
    const pieces = [k.solidCount(target.shape), k.solidCount(solid)]
    let combined: Tracked
    try {
      combined = this.guarded(combine, (result) => (step.op === 'join' ? { kind: 'join', parts, result } : { kind: 'cut', body: parts[0], result }), step.op === 'join' ? 'Joining' : 'The cut', [target, { name: step.name, shape: solid }])
      if (step.op === 'join') combined = this.withoutSlivers(combined, new Set(before.keys()), combine, (shape) => volumeRefusal({ kind: 'join', parts, result: this.volumeOf(shape) }) === null, 'join')
      // A join on one body that meets none of it would stand beside it as a
      // body of its own — refused, as a cut that takes nothing is (31_pleuel
      // made a second body so, unseen).
      if (step.op === 'join' && k.solidCount(combined.shape) >= pieces[0] + pieces[1]) {
        k.release(combined.shape)
        throw new Error(`${step.name} meets nothing of ${target.name} — joined, it would stand beside it as a body of its own. Check where it stands against the body and how far it reaches, or set the result to New body.`)
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      fail(step.id, why.startsWith('The cut left no closed solid —') ? why.replace('The cut left no closed solid', 'The cut left no closed solid (did it take the whole body?)') : why)
      return
    } finally {
      k.release(solid)
    }
    // The body as it stood is kept, as for a feature on a body: an extrude
    // that ends on the body — to its next face, to its last — is measured
    // against the body without the extrude in it when it is edited.
    this.stageBody(step.id, id, target)
    const bodies = this.settle(id, target.name, combined.shape, this.propagate(combined.shape, before, combined.history, step.id), step.id, false, [], step.op === 'cut')
    if (step.op === 'cut') this.saySplit('The cut', target.name, bodies, step.id)
    // Some pieces of the solid meeting the body and some not: those stand
    // apart, said on the row.
    else if (bodies.length > pieces[0]) this.saySplit('The join', target.name, bodies, step.id)
    results.push({ id: step.id, status: 'ok', bodies })
  }

  /** The sheet a thicken works on, as it stands before it: refused where
   *  it is gone or is a solid. */
  private sheetFor(step: Extract<BuildStep, { kind: 'thicken' }>): Body {
    const sheet = this.bodyBefore(step.id, step.sheet)
    if (!sheet) throw new Error('The sheet this thickens is gone, or failed to build.')
    if (!sheet.surface) throw new Error(`${sheet.name} is a solid, not a sheet — a thicken takes a sheet; a solid is grown or shrunk by an offset, or hollowed by a shell.`)
    return sheet
  }

  /** A sheet thickened, or why not: the faces that fold at the thickness
   *  are looked for first — the kernel folds them without a word — and a
   *  diagnosis naming them is handed back in place of a solid. */
  private thickenOf(step: Extract<BuildStep, { kind: 'thicken' }>): { made: Thickened; sheet: Body } | Diagnosis {
    const sheet = this.sheetFor(step)
    // A patch network's sheet both ways: offset back by half the thickness
    // it comes out with a face more than it had — its faces meet within a
    // micron, not on one curve — and the kernel's thickening of that never
    // returns (a 2 × 2 network on a sphere, at 1e-6 and at 1e-4). One way
    // at a time it thickens as one.
    if (step.side === 'both' && sheet.patches && this.kernel.faceHashes(sheet.shape).length > 1) {
      return { message: 'A patch network’s sheet of several patches thickens one way at a time, Out or In: both ways, the kernel’s offset of it to the middle does not come back as the sheet.', where: [] }
    }
    const folds = thickenFolds(this.kernel, sheet, step.thickness, step.side)
    if (folds) return folds
    try {
      return { made: this.kernel.thickenTracked(sheet.shape, step.thickness, step.side), sheet }
    } catch (e) {
      if (isTrap(e)) throw e
      const said = (e instanceof Error ? e.message : String(e)).replace(/^[A-Z][a-z ]+: /, '').replace(/\.$/, '')
      // units-ok: build message, also the agent's answer
      return { message: `The sheet does not thicken ${thickenWay(step.side)} by ${Math.round(step.thickness * 100) / 100} mm: ${said}; every face of it takes the thickness alone, so it fails at its edge or where its faces meet.`, where: [] }
    }
  }

  /** A thicken's solid for its ghost — or the reason it folds, thrown. */
  private thickenPreview(step: Extract<BuildStep, { kind: 'thicken' }>): Shape {
    const got = this.thickenOf(step)
    if ('message' in got) throw new Error(got.message)
    return got.made.shape
  }

  /** A thicken played: the sheet made a solid and placed as a loft's is —
   *  a new body, or joined to or cut from what it meets — the skin keeping
   *  the makers of the sheet's faces, and the wall it came to along the
   *  sheet's edge said in its result. */
  private playThicken(step: Extract<BuildStep, { kind: 'thicken' }>, fail: (id: number, message: string) => void, results: FeatureResult[]): void {
    const got = this.thickenOf(step)
    if ('message' in got) {
      results.push({ id: step.id, status: 'failed', message: got.message, ...(got.where.length > 0 ? { where: got.where } : {}) })
      return
    }
    const { made, sheet } = got
    const from = results.length
    this.place(step, made.shape, fail, results)
    const r = results.slice(from).find((x) => x.id === step.id)
    if (r?.status !== 'ok') return
    for (const id of r.bodies ?? []) {
      const b = this.bodies.get(id)
      if (!b) continue
      for (const [h, was] of made.skin) {
        const maker = sheet.origins.get(was)
        if (maker !== undefined && b.origins.get(h) === step.id) b.origins.set(h, maker)
      }
    }
    const wall = made.wall && wallSaid(made.wall, step.thickness)
    if (wall && 'note' in wall) r.note = wall.note
    else if (wall) this.stepWarnings.push(wall.warning)
  }

  /** A sheet of a sketch's pieces, from the sketch as the build placed it. */
  private sheetOf(step: Extract<BuildStep, { kind: 'sheet' }>): Shape {
    const placed = this.sheetPlaced(step)
    return this.kernel.sheet(placed.pieces, placed.dir, placed.from, placed.to)
  }

  /** A loft through sketches' profiles, from the sketches as the build
   *  placed them. A smooth one whose skin crosses itself between its
   *  sections is refused here: the kernel answers it valid, and the
   *  boolean after it comes out empty or wrong. */
  private loftOf(step: Extract<BuildStep, { kind: 'loft' }>): Shape {
    const placed = this.loftPlaced(step)
    const solid = this.kernel.loft(placed.profiles, placed.ruled)
    if (placed.ruled) {
      this.smoothLofts.delete(step.id)
      return solid
    }
    this.smoothLofts.add(step.id)
    const fold = this.kernel.loftFold(solid, { normal: sectionsNormal(placed.profiles) })
    if (!fold) return solid
    this.kernel.release(solid)
    const names = step.sketches.map((id, i) => step.sketchNames?.[i] ?? this.placed.get(id)?.name ?? `sketch ${id}`)
    throw new Error(loftFoldRefusal(fold, placed.profiles.map((profile, i) => ({ name: names[i], profile }))))
  }

  /** Where the faces a smooth loft made on a body cross themselves, loft by
   *  loft — the body's own faces, inside them, as later steps trimmed
   *  them; none for a body no smooth loft made faces of. */
  private foldsOf(body: Body): { loft: number; name: string; words: string; at: Vec3 }[] | null {
    const lofts = new Map<number, Set<number>>()
    for (const [hash, origin] of body.origins) {
      if (!this.smoothLofts.has(origin)) continue
      const own = lofts.get(origin) ?? new Set<number>()
      own.add(hash)
      lofts.set(origin, own)
    }
    if (lofts.size === 0) return null
    const out: { loft: number; name: string; words: string; at: Vec3 }[] = []
    for (const [loft, faces] of lofts) {
      const fold = this.kernel.loftFold(body.shape, { faces, trimmed: true })
      if (fold) out.push({ loft, name: this.names.get(loft) ?? `feature ${loft}`, words: foldWords(fold), at: fold.at })
    }
    return out
  }

  /** An intersect that left nothing, in words: the bodies' boxes apart —
   *  they do not overlap — or meeting, and the kernel found no common
   *  volume where there may well be one: a body whose skin folds over
   *  itself, which its own check passes. Each input is read for a fold. */
  private emptyIntersectWords(into: readonly Body[], tools: readonly Body[], tried: string): string {
    const k = this.kernel
    if (!into.some((a) => tools.some((t) => boxesMeet(k.extent(a.shape), k.extent(t.shape))))) return 'The bodies do not overlap.'
    const read = [...into, ...tools].map((b) => {
      const folds = b.surface ? null : this.foldsOf(b)
      if (!folds) return `${b.name}: no faces of a smooth loft`
      if (folds.length === 0) return `${b.name}: its smooth-loft faces do not cross`
      return folds.map((f) => `${b.name} ${f.words} (the faces of ${f.name})`).join('; ')
    })
    return `The bounds overlap but the kernel found no common volume — a body may fold over itself${tried}. Fold check: ${read.join('; ')}.`
  }

  private extrude(step: Extract<BuildStep, { kind: 'extrude' }>, faces: Shape[], sketch: Sketch | undefined): Shape {
    const k = this.kernel
    // Swept another way than the plane's normal: everything below goes
    // along it — the offsets, the reach, the taper — the profile staying
    // where the sketch or the face put it.
    if (step.along) step = { ...step, dir: step.along }
    if (step.until?.kind === 'body') {
      const body = this.bodyBefore(step.id, step.until.body)
      if (!body) throw new Error('The body this extrusion reaches to is gone, or failed to build.')
      return this.extrudeToShape(step, faces, body, null, step.until.reverse)
    }
    if (step.until && step.until.kind !== 'face') return this.extrudeUntil(step, step.until, faces)
    const planes: PlaneGeometry[] = []
    if (typeof step.from !== 'number') planes.push(step.from)
    if (typeof step.to !== 'number') planes.push(step.to)
    let toFace: PlaneGeometry | null = null
    if (step.until) {
      // Up to a flat face of a body: the face's plane, as to any plane. A
      // curved one is reached as the face it is (extrudeToShape).
      const found = this.findFaces(step.until.body, [step.until.face], step.id)
      if ('lost' in found) throw new Error(`The face this extrusion reaches to is gone (was: ${found.lost}).`)
      const body = this.bodyBefore(step.id, step.until.body)
      const f = body && k.faces(body.shape).find((x) => x.hash === found.hashes[0])
      if (!body || !f) throw new Error('The face this extrusion reaches to is not on the body.')
      if (f.kind !== 'plane') return this.extrudeToShape(step, faces, body, f, false)
      toFace = { origin: f.centroid, normal: f.dir }
      planes.push(toFace)
    }
    // To a face, the face is the end: `to` is only the start again.
    if (!toFace && typeof step.from === 'number' && typeof step.to === 'number' && Math.abs(step.to - step.from) < 1e-9) {
      throw new Error('The extrusion has no length.')
    }
    if (Math.abs(step.draftDeg) > 1e-9) return trimByPlanes(this.kernel, taperedPrism(this.kernel, step, faces, toFace), planes, step.origin)
    const far = planes.length > 0 ? farReach(step.origin, step.dir, sketch ?? { entities: [], constraints: [], nextId: 1 }, planes) : 0
    const lo = typeof step.from === 'number' ? step.from : -far
    let hi = typeof step.to === 'number' ? step.to : far
    // Towards the face, whichever side of the sketch it lies on.
    if (toFace) hi = dot(sub(toFace.origin, step.origin), step.dir) >= lo ? far : -far
    const parts = faces.map((f) => k.extrude(f, step.dir, Math.min(lo, hi), Math.max(lo, hi)))
    return trimByPlanes(this.kernel, fuseAll(this.kernel, parts), planes, step.origin)
  }

  /** An extrude up to a curved face of a body (`face`), or up to the body
   *  itself — a solid's skin, a sheet (buildExtrude extrudeUpTo): the way
   *  the face or body lies from the start along the extrude, or along it
   *  where it lies both ways — against it with `reverse`. */
  private extrudeToShape(step: Extract<BuildStep, { kind: 'extrude' }>, faces: Shape[], body: Body, face: RawFace | null, reverse: boolean): Shape {
    const k = this.kernel
    const start = typeof step.from === 'number' ? step.from : 0
    const limit = face ? k.faceCopy(body.shape, face.hash) : body.shape
    try {
      const reach = reachAlong(k, [limit], step.origin, step.dir)
      const toward: 1 | -1 = reach.max <= start + 1e-6 ? -1 : reach.min >= start - 1e-6 ? 1 : reverse ? -1 : 1
      const what = face ? `the ${face.kind === 'other' ? 'curved' : face.kind} face of ${body.name}` : body.name
      return extrudeUpTo(k, faces, step.origin, step.dir, start, step.draftDeg, limit, toward, what)
    } finally {
      if (face) k.release(limit)
    }
  }

  /**
   * An extrude whose end is found on the bodies. **To last** runs to the
   * far end of the bodies it is measured against — just past it for a cut,
   * so the cut goes through. **To next** runs the profile right through
   * them and keeps the first piece of it: of what lies outside the bodies
   * for a boss (the piece between the sketch and the first face met), of
   * what lies inside them for a cut (the first wall gone through). A piece
   * that still reaches the far end was never stopped — the body does not
   * cover the whole profile that way — and is refused rather than left
   * sticking out of the part.
   */
  private extrudeUntil(step: Extract<BuildStep, { kind: 'extrude' }>, until: Extract<NonNullable<Extract<BuildStep, { kind: 'extrude' }>['until']>, { kind: 'next' | 'last' }>, faces: Shape[]): Shape {
    const k = this.kernel
    const bodies = (until.against === 'all' ? [...this.bodies.entries()].filter(([id]) => id !== step.id).map(([, b]) => b) : until.against.map((id) => this.bodyBefore(step.id, id)).filter((b): b is Body => b !== undefined)).filter((b) => !b.surface)
    if (bodies.length === 0) throw new Error('There is no body to extrude up to — make one first, or give a distance.')
    const start = typeof step.from === 'number' ? step.from : 0
    const sign = until.reverse ? -1 : 1
    const reach = reachAlong(this.kernel, bodies.map((b) => b.shape), step.origin, step.dir)
    const margin = Math.max(1, 0.01 * (reach.max - reach.min))
    const end = until.reverse ? reach.min : reach.max
    if (!(sign * (end - start) > 1e-6)) throw new Error('No body lies that way from the sketch — reverse the direction.')
    // A taper leans from the start, the profile's own section, on to the
    // end; how far it can lean before it closes the profile is found first.
    const tapered = Math.abs(step.draftDeg) > 1e-9
    const dir = normalize(step.dir) ?? step.dir
    const outlines = tapered ? faces.map((f) => outlineOf(this.kernel, f, step.origin, dir)) : []
    // How far it can run, and which edge breaks where it cannot.
    const canRun = (length: number): ReturnType<typeof taperLimitOf> => (tapered ? taperLimitOf(outlines, step.draftDeg, length) : { reach: length })
    const prism = (to: number, of = faces) => fuseAll(this.kernel, of.map((f) => k.extrude(f, step.dir, start, to, step.draftDeg)))
    if (until.kind === 'last') {
      const to = until.cutting ? end + sign * margin : end
      const { reach: fits, broke } = canRun(Math.abs(to - start))
      if (fits < Math.abs(to - start) - 1e-9) throw taperRefusal(step.draftDeg, fits, Math.abs(to - start), broke)
      return prism(to)
    }

    // To next stops where the profile meets the body: a taper that closes
    // the profile further on does not matter, so the prism runs no further
    // than it can — and if the body is not met by then, the taper says so.
    const wanted = Math.abs(end + sign * margin - start)
    const { reach: fits, broke } = canRun(wanted)
    const closesFirst = fits < wanted - 1e-9
    if (closesFirst && fits < 1e-6) throw taperRefusal(step.draftDeg, fits, wanted, broke)
    const far = closesFirst ? start + sign * fits * (1 - 1e-6) : end + sign * margin
    // Each region of the profile runs to its own next face — three circles
    // under a ceiling are three bosses, not the nearest one alone — and
    // what each keeps is joined.
    const run = { start, sign, far, refusal: closesFirst ? () => taperRefusal(step.draftDeg, fits, wanted, broke) : null }
    if (faces.length > 1) {
      const kept: Shape[] = []
      try {
        faces.forEach((f, i) => {
          try {
            kept.push(this.nextPiece(step, until, bodies, prism(far, [f]), run))
          } catch (e) {
            // Which region, by where it lies: the faces come in no order
            // the sketch shows.
            const at = k.faces(f)[0]?.centroid
            const where = at ? ` about (${at.map((x) => x.toFixed(2)).join(', ')})` : ` ${i + 1} of ${faces.length}`
            throw new Error(`The profile's region${where}: ${e instanceof Error ? e.message : String(e)}`)
          }
        })
      } catch (e) {
        k.release(...kept)
        throw e
      }
      return fuseAll(this.kernel, kept)
    }
    return this.nextPiece(step, until, bodies, prism(far), run)
  }

  /** To next for one prism (`whole`, released here): of the pieces it
   *  leaves outside the bodies (a boss) or inside them (a cut), the first
   *  along the way — see extrudeUntil. `refusal` is the taper's, where it
   *  closes the profile before the far end. */
  private nextPiece(
    step: Extract<BuildStep, { kind: 'extrude' }>,
    until: Extract<NonNullable<Extract<BuildStep, { kind: 'extrude' }>['until']>, { kind: 'next' | 'last' }>,
    bodies: Body[],
    whole: Shape,
    { start, sign, far, refusal }: { start: number; sign: number; far: number; refusal: (() => Error) | null },
  ): Shape {
    const k = this.kernel
    const pieces: Shape[] = []
    try {
      if (until.cutting) {
        for (const b of bodies) {
          const inside = k.common(whole, b.shape)
          pieces.push(...k.solids(inside))
          k.release(inside)
        }
      } else {
        let outside = whole
        for (const b of bodies) {
          const next = k.cut(outside, b.shape)
          if (outside !== whole) k.release(outside)
          outside = next
        }
        pieces.push(...k.solids(outside))
        if (outside !== whole) k.release(outside)
      }
      if (pieces.length === 0) throw refusal ? refusal() : new Error(until.cutting ? 'The profile meets no body that way.' : 'The profile starts inside the body — there is nothing between it and the next face.')
      // The first piece along the way, and how far it runs.
      let first = -1
      let nearest = Infinity
      let runsTo = 0
      pieces.forEach((p, i) => {
        const r = reachAlong(this.kernel, [p], step.origin, step.dir)
        const near = until.reverse ? start - r.max : r.min - start
        if (near < nearest) {
          nearest = near
          first = i
          runsTo = until.reverse ? start - r.min : r.max - start
        }
      })
      if (!until.cutting && runsTo >= sign * (far - start) - 1e-6) throw refusal ? refusal() : new Error('The body does not cover the whole profile that way, so nothing stops it — use To a face, or a distance.')
      const kept = pieces[first]
      pieces.splice(first, 1)
      return kept
    } finally {
      k.release(whole, ...pieces)
    }
  }

  /** How two bodies of the last build stand to each other — see
   *  ReKernel.clearance. */
  clearance(a: number, b: number): { gap: number; overlap: number } {
    const shapeOf = (id: number) => {
      const body = this.bodyById(id)
      if (!body) throw new Error(`There is no body ${id} — it did not build.`)
      if (body.surface) throw new Error(`${body.name} is a surface — a clearance is between solids.`)
      return body.shape
    }
    return this.kernel.clearance(shapeOf(a), shapeOf(b))
  }

  /**
   * Where the solid bodies among `ids` run into each other, pair by pair:
   * the solid each pair shares, meshed, and its volume — worked out by
   * Manifold on the meshes the viewport has (see overlapMesh.ts), not by
   * the kernel, which took seconds a pair on threaded parts. Bodies that
   * only touch share nothing, nor does a pair Manifold cannot read. A pair
   * is worked out once for the two bodies as they stand, so a body a later
   * build left alone keeps its answers. No new pair is begun once `budget`
   * milliseconds have gone: a part of many bodies takes several asks, and
   * what else is asked of the worker meanwhile is not kept waiting behind
   * all of it. Until `done`, the answer is empty.
   */
  overlaps(ids: readonly number[], manifold: ManifoldToplevel, budget = Infinity): { overlaps: Overlap[]; done: boolean } {
    const k = this.kernel
    const bodies: { id: number; body: Body }[] = []
    for (const asked of ids) {
      const id = this.resolve(asked)
      const body = this.bodies.get(id)
      if (body && !body.surface && !bodies.some((b) => b.id === id)) bodies.push({ id, body })
    }
    const boxOf = (body: Body) => {
      let box = this.boxes.get(body)
      if (!box) this.boxes.set(body, (box = k.extent(body.shape)))
      return box
    }
    const started = performance.now()
    const overlaps: Overlap[] = []
    let done = true
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i].body
        const b = bodies[j].body
        let shared = this.sharedKnown(a, b)
        if (shared === undefined) {
          if (performance.now() - started > budget) {
            done = false
            continue
          }
          shared = boxesMeet(boxOf(a), boxOf(b)) ? this.share(a, b, manifold) : null
          let row = this.shares.get(a)
          if (!row) this.shares.set(a, (row = new WeakMap()))
          row.set(b, shared)
        }
        if (shared) overlaps.push({ a: bodies[i].id, b: bodies[j].id, ...shared })
      }
    }
    // The meshes kept go out as copies: the worker hands the buffers on.
    return done ? { overlaps: structuredClone(overlaps), done } : { overlaps: [], done }
  }

  /** What two bodies were found to share, null for nothing; undefined
   *  for a pair not worked out yet. */
  private sharedKnown(a: Body, b: Body): Shared | undefined {
    const ab = this.shares.get(a)
    if (ab?.has(b)) return ab.get(b)
    const ba = this.shares.get(b)
    if (ba?.has(a)) return ba.get(a)
    return undefined
  }

  /** What two solid bodies share — see overlaps. */
  private share(a: Body, b: Body, manifold: ManifoldToplevel): Shared {
    const meshOf = (body: Body) => this.shown.get(body)?.mesh ?? this.kernel.mesh(body.shape, meshDeflection(diagonalOf(this.kernel, body.shape)))
    let shared: ReturnType<typeof sharedSolid> = null
    try {
      shared = sharedSolid(manifold, meshOf(a), meshOf(b))
    } catch {
      // A pair Manifold fails on fails the same way the next time: it is
      // taken as sharing nothing, and not asked again.
      return null
    }
    if (!shared || (2 * shared.volume) / shared.area < OVERLAP_MIN_THICKNESS) return null
    return { volume: shared.volume, mesh: shared.mesh }
  }

  /** One STEP file of the given bodies — the solids, and a patch network's
   *  sheet, a part's skin; any other sheet is a cutter, not a part, and
   *  stays out. With labels, one per id, each body is a part under its name
   *  and in its colour. */
  exportStep(ids: readonly number[], labels?: readonly StepLabel[]): string {
    return this.exportStepMended(ids, labels).text
  }

  /** The same, and what was mended in it: a part that read back open by
   *  hairs, its curves made to end on their corners
   *  (ReKernel.exportStepMended). */
  exportStepMended(ids: readonly number[], labels?: readonly StepLabel[]): { text: string; mended: StepMend[]; check?: StepCheck } {
    const kept = this.stepBodies(ids, labels)
    const bodies = kept.map((x) => x.body)
    const out = this.kernel.exportStepMended(
      bodies.map((b) => b.shape),
      labels ? kept.map((x) => x.label ?? { name: x.body.name }) : undefined,
      bodies.map((b) => b.surface === true && b.patches !== undefined),
    )
    return out.check ? { ...out, check: this.withMakers(out.check, bodies) } : out
  }

  /** The bodies among `ids` cut by a plane, each body's section as
   *  polylines in the world (ReKernel.sectionPolylines) — a sheet's an open
   *  line where a solid's is a loop. */
  sectionCut(ids: readonly number[], origin: Vec3, normal: Vec3, deflection: number): { id: number; polylines: Float32Array[] }[] {
    return ids.flatMap((id) => {
      const body = this.bodyById(id)
      return body ? [{ id, polylines: this.kernel.sectionPolylines(body.shape, origin, normal, deflection) }] : []
    })
  }

  /** The bodies among `ids` cut by a plane, each body's section as the
   *  kernel's own edges (ReKernel.sectionPieces): what
   *  reverse.body.section reads. */
  sectionPieces(ids: readonly number[], origin: Vec3, normal: Vec3, deflection: number): { id: number; pieces: CutPiece[] }[] {
    return ids.map((id) => ({ id, pieces: this.kernel.sectionPieces(this.builtBody(id).shape, origin, normal, deflection) }))
  }

  /** Points and rays read against each of the bodies among `ids`
   *  (ReKernel.probe): what reverse.body.probe reads. */
  probe(ids: readonly number[], points: readonly Vec3[], rays: readonly { from: Vec3; dir: Vec3 }[]): BodyProbe[] {
    return ids.map((id) => {
      const body = this.builtBody(id)
      return { id, solid: !body.surface, ...this.kernel.probe(body.shape, points, rays, !body.surface) }
    })
  }

  /** A body of the last build, or why there is none. */
  private builtBody(id: number) {
    const body = this.bodyById(id)
    if (!body) throw new Error(`There is no body ${id} — it did not build.`)
    return body
  }

  /** The STEP file exportStep wrote of these bodies, read back and held
   *  against them (ReKernel.verifyStep). */
  verifyStep(ids: readonly number[], text: string): StepCheck {
    const bodies = this.stepBodies(ids).map((x) => x.body)
    return this.withMakers(this.kernel.verifyStep(text, bodies.map((b) => b.shape), { sheets: bodies.map((b) => b.surface === true && b.patches !== undefined) }), bodies)
  }

  /** The solids of the given bodies, and a network's sheet, each with its
   *  label: what a STEP file holds of them. */
  private stepBodies(ids: readonly number[], labels?: readonly StepLabel[]) {
    return ids.map((id, i) => ({ body: this.bodyById(id), label: labels?.[i] })).filter((x): x is { body: Body; label: StepLabel | undefined } => x.body !== undefined && (!x.body.surface || x.body.patches !== undefined))
  }

  dispose(): void {
    this.settleOffered()
    this.imported.clear()
    this.clearTree()
    if (this.standing) this.letGo(this.standing.states)
    this.standing = null
    this.restore(null)
    this.previewedFile = null
    this.forgetParts([])
  }
}

/** Where two edges a fillet rounds at radii of their own meet on one
 *  tangent chain, the radius each gives there must be the one: a round's
 *  radius cannot jump along a chain. A throw naming the first place it
 *  would, and the two entries of `variable`. */
function radiusJump(varying: readonly VariableEdge[], at: readonly number[], all: readonly EdgeInfo[], chainOf: (hash: number) => number[]): void {
  const ends = at.map((h) => all.find((e) => e.hash === h)?.ends)
  for (let i = 0; i < varying.length; i++) {
    const chain = new Set(chainOf(at[i]))
    for (let j = i + 1; j < varying.length; j++) {
      const a = ends[i]
      const b = ends[j]
      if (!a || !b || !chain.has(at[j])) continue
      for (const p of [0, 1] as const)
        for (const q of [0, 1] as const) {
          if (len(sub(a[p], b[q])) > 1e-3) continue
          const ra = varying[i].radius[p]
          const rb = varying[j].radius[q]
          if (Math.abs(ra - rb) <= 1e-6) continue
          const where = a[p].map((v) => +v.toFixed(3)).join(', ')
          // units-ok: build message, also the agent's answer
          throw new Error(`variable[${i}] and variable[${j}] meet on one tangent chain at (${where}) at R${+ra.toFixed(4)} and R${+rb.toFixed(4)}: a round's radius cannot jump along a chain — give both the same radius at that end, or leave one out to run between the radii about it.`)
        }
    }
  }
}
