// SPDX-License-Identifier: AGPL-3.0-only
// What the builder takes and hands back, and the small pure parts of it:
// the steps it plays, a feature's result, the bodies with their faces and
// edges, a body's check, the keys a step's work is remembered under, and
// the sampling the split and the diagnosis read.

import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import type { FoundRelation } from './autoConstrain'
import type { StepReads } from './buildReads'
import type { BuildStep, TrimPrimitive } from './features'
import type { KernelMesh, ReadBackEdge, ReKernel, Shape, StepCheck, StepMend } from './kernel'
import type { MeshFault } from './kernelMesh'
import type { SmallConic } from './kernelStep'
import type { NetworkReport } from './networkBody'
import type { OddEdge, OddKind, ShortEdge } from './kernelEdges'
import type { CopyMark } from './patternCopies'
import type { Region } from './regions'
import type { Sketch } from './sketch'
import type { StepBetween } from './stepsBetween'
import type { Stray, SurfaceFitResult } from './surfaceFit'
import { type EdgeFingerprint, type FaceFingerprint, matchTolerance } from './topo'

/** A feature step that makes a solid of its own from profiles. */
export type SolidStep = Extract<BuildStep, { kind: 'extrude' | 'revolve' }>

/** A feature step that works on a body already there. */
export type BodyStep = Extract<BuildStep, { kind: 'shell' | 'fillet' | 'chamfer' | 'hole' | 'thread' | 'cutPlane' | 'mirror' | 'boolean' | 'split' | 'pattern' | 'draft' | 'moveFace' | 'deleteFace' | 'offsetBody' }>

/** Any step that can be previewed: everything but a failure and the
 *  placing of a sketch, which makes nothing to see. */
export type PreviewStep = Exclude<BuildStep, { kind: 'failed' | 'sketch' }>

/** A step that places a sketch on the part. */
export type SketchStep = Extract<BuildStep, { kind: 'sketch' }>

/** What a feature being set up looks like before it is committed: the
 *  solid it would make on its own, before any join or cut — the way a CAD
 *  extrude shows its tool body while the distance is dragged. */
export interface PreviewResult {
  mesh: KernelMesh
  /** Set for a feature on a body: the preview is the body as the feature
   *  would leave it and stands in for it, edges and all — drawn as the
   *  outlines of the mesh's faces (edgeLines.ts). */
  edges?: boolean
  volume: number
  closed: boolean
  surface?: SurfaceReport
  trim?: TrimReport
  network?: NetworkReport
  /** A round, a chamfer or a shell whose preview left no closed solid:
   *  where it went wrong, for the box and the part. */
  failure?: Diagnosis
  /** Set when what is previewed is a sheet — a patterned cutter: how many
   *  faces it has. */
  sheetFaces?: number
}

export interface FeatureResult {
  id: number
  status: 'ok' | 'failed'
  message?: string
  /** Where a round, a chamfer or a shell failed: the edges or the face
   *  outlines the kernel cannot do at the size asked, as polylines to draw
   *  red on the part — see Builder.diagnose. */
  where?: Float32Array[]
  /** Something a feature that built did its own way — a shell whose inner
   *  corners were left sharp where a round was no larger than the wall. */
  note?: string
  /** Something about a feature that built to look at: a boolean whose
   *  first result failed its volume check and was taken on a second try,
   *  a pick found again by where it lies rather than by the feature that
   *  made it. */
  warning?: string
  /** The edges a round or a chamfer took — the ones picked and, with
   *  chain, the ones tangent to them — as they were before it: where each
   *  ran, how long, a circle's radius. */
  edges?: EdgeBrief[]
  /** What a surface fit reports: how the surface sits on its region. */
  surface?: SurfaceReport
  /** A surface fit refused for running away: the points that are not its
   *  surface's, named with a box to leave each out by (surfaceFit.ts
   *  Stray). A fit that builds gives them in `surface`. */
  strays?: Stray[]
  /** What a trim reports: what closed and what did not. */
  trim?: TrimReport
  /** A split by fitted sheets: how much of its cut face lies off the scan
   *  past each sheet's region. */
  offScan?: OffScanReport[]
  /** What a patch network reports: its cells, patches and curves. */
  network?: NetworkReport
  /** A sketch lying on a body's face: the frame the face was found in
   *  this build, for the sketch to be kept at. */
  sketchFrame?: { sketchId: number; frame: SectionFrame }
  /** A sketch whose projected pieces were taken again where what they
   *  were projected from has moved, or given the edges they lie on: the
   *  sketch as it was solved on them, for the sketch to be kept so. */
  sketch?: Sketch
  /** A solid feature's bodies: the ones it joined, cut or made, as they
   *  came out of it — for its row to say which. */
  bodies?: number[]
  /** A combine's tools as the bodies it took: each one named and every
   *  piece of it (familyOf) — a pattern's original and its copies. */
  took?: number
  /** A join's: the steps it left between the faces it brought and those
   *  it found — two walls a hair apart, a round drawn twice — the
   *  thinnest first (stepsBetween.ts). The page words them into `warning`
   *  for the agent, and lists them shorter in the feature's box. */
  stepsBetween?: StepBetween[]
  /** The page's: what the build itself warned of, before the steps were
   *  worded into `warning` (stepWords.ts withStepsSaid) — for the box,
   *  which lists the steps its own way. */
  ownWarning?: string
}

/** Where a feature failed, read by trying its picks one at a time: a
 *  sentence for the feature's row, and the edges or face outlines to draw
 *  red on the part. */
export interface Diagnosis {
  message: string
  where: Float32Array[]
}

/** An edge in a few numbers, for a result to list. */
export interface EdgeBrief {
  kind: EdgeFingerprint['kind']
  mid: Vec3
  length: number
  radius?: number
}

/** One size a round or a chamfer was tried at — see Builder.filletTry. Not
 *  tried: the time ran out, or the kernel crashed on a size before it. */
export interface FilletTry {
  size: number
  tried: boolean
  /** By the build's own test: what a build at this size would keep. */
  builds?: boolean
  closed?: boolean
  valid?: boolean
  faces?: number
  ms?: number
  /** What the kernel said, where it refused. */
  message?: string
  /** What a feature that skips what fails left out at this size. */
  note?: string
}

/** The sizes tried, and what the kernel said if it crashed on the last. */
export interface FilletTries {
  tries: FilletTry[]
  crashed?: string
}

/** What a body check reports — see Builder.check. */
export interface BodyCheck {
  /** The kernel's own check passed. */
  valid: boolean
  /** One closed solid with volume. */
  closed: boolean
  solids: number
  volume: number
  area: number
  faces: number
  /** Faces under the area asked about — slivers a boolean left, a face
   *  the next round or shell will stumble on — and faces with no area at
   *  all, by hash with their area and centroid. */
  tiny: { hash: number; area: number; centroid: Vec3 }[]
  /** Faces the mesher drew no triangle for — a face a STEP reader or a
   *  slicer will miss, by hash. */
  untessellated: number[]
  /** Those it did not draw whole with the others, whether or not a retry
   *  on their own did (kernelMesh.ts); absent where it drew them all. */
  meshFaults?: MeshFault[]
  /** How many shells each solid has, solid by solid. */
  shells: number[]
  /** The hollows sealed inside the solids: every shell but a solid's
   *  outer one, with the solid it is in, its volume and its box. */
  voids: { solid: number; volume: number; bounds: { min: Vec3; max: Vec3 } }[]
  /** Faces narrower than a sliver's width (twice the area over the
   *  perimeter), whatever their area — a strip 0.005 × 20 mm a boolean
   *  left — by hash, the narrowest first. */
  narrow: { hash: number; area: number; width: number; centroid: Vec3 }[]
  /** The edges that do not join two faces as a closed solid's do, and
   *  those whose two faces face opposite ways (kernelEdges.ts) — the
   *  first ODD_EDGES_KEPT — and how many of each kind. */
  odd: { edges: OddEdge[]; counts: Record<OddKind, number> }
  /** Edges between two faces under SHORT_EDGE_MM the kernel does not take
   *  for degenerate — a hair a round left, which a STEP reader may drop
   *  from one face (kernelEdges.ts shortEdges) — the first ODD_EDGES_KEPT,
   *  and how many. */
  short: { edges: ShortEdge[]; count: number }
  /** Edges on a conic too small for a part — a plane a hair off a cone's
   *  apex, a wedge's side meant to pass through a revolve's axis — as the
   *  STEP writer writes them; `straight` ones the export writes as lines
   *  (kernelStep.ts smallConics). */
  conics: SmallConic[]
  /** Without roundTrip, on a solid of up to READ_BACK_FACES faces: the
   *  body written as STEP and read back, and the edges of the part read
   *  back that do not join two faces as a closed solid's do — the hole a
   *  reader makes where a curve ends a hair off its corner, which the body
   *  in memory does not show. */
  readBack?: ReadBackEdge[]
  /** With readBack: whether the part read back is a closed solid, and one
   *  the kernel's check passes — a face a reader lost whole (an off-centre
   *  dome turned base to pole) leaves no edge to list. */
  readBackSolid?: { closed: boolean; valid: boolean }
  /** With roundTrip: the body written as STEP and read back in memory. */
  roundTrip?: RoundTrip
  /** For a body with faces a smooth loft made: where they cross
   *  themselves, loft by loft — none when they do not (loftFold.ts). */
  folds?: { loft: number; name: string; words: string; at: Vec3 }[]
  /** With roundTrip "find": the first step whose body does not come
   *  back whole. */
  find?: RoundTripFind
}

/** A body written as STEP and read back, in memory (ReKernel.verifyStep,
 *  the faces' makers filled in): whether it holds, what failed, and the
 *  part read back. */
export interface RoundTrip {
  ok: boolean
  problems: string[]
  notes: string[]
  parts: number
  body: StepCheck['bodies'][number] | null
  /** Where it does not hold by hairs only: what the export's mending makes
   *  of it (ReKernel.exportStepMended) — absent where it mends nothing. */
  mended?: StepMend[]
}

/** The build's stages of a body walked from the first — its input to
 *  each step that worked on it, then the body as it stands — each written
 *  and read back until one does not hold: `step`, the step that made the
 *  first body that does not (null where every one holds, or the time ran
 *  out first), `before`, the step whose input that body is (null for the
 *  body as it stands), its round trip, how many were read and of how
 *  many, and whether the walk got to the end or to a failure in time. */
export interface RoundTripFind {
  step: { id: number; name: string | null } | null
  before: number | null
  trip: RoundTrip | null
  checked: number
  of: number
  done: boolean
}

/** An automatic trim's reading of itself: how many faces the tools cut
 *  space into, how many lay on the scan and were kept, whether they closed
 *  into a solid, and the open edges where they did not — as polylines,
 *  for drawing on the part. */
export interface TrimReport {
  faces: number
  kept: number
  closed: boolean
  openEdges: Float32Array[]
}

/** A Fit Surface's reading of itself: the residuals along the normal and
 *  the net that was used, Auto's choice included. */
export interface SurfaceReport {
  rms: number
  max: number
  net: { u: number; v: number }
  points: number
  /** A plane or a cylinder rather than the freeform surface: what it was
   *  held to, what the free fit's RMS was before it was held, and a
   *  cylinder's radius. */
  shape?: 'plane' | 'cylinder'
  rmsFree?: number
  relations?: FoundRelation[]
  radius?: number
  /** A freeform fit's worst points — where on the scan and how far off,
   *  signed along the fit's normal (mm) — and with a robust fit, how many
   *  points it left out as standing too far off. */
  worst?: { at: [number, number, number]; off: number }[]
  dropped?: number
  /** A robust fit's strays: a second sheet along its height direction,
   *  and the points it left out far off, in groups (surfaceFit.ts Stray). */
  strays?: Stray[]
  /** A freeform fit's margin against the scan: how far the surface stands
   *  off the scan under it past its region, the most, and where
   *  (surfaceRegion.ts pastRegion) — absent with no scan under it. */
  pastRegion?: { off: number; at: Vec3 }
}

/** How much of a split's cut face lies off the scan past a fitted tool's
 *  region (surfaceRegion.ts offPastRegion): the tool, the most, mm, the
 *  area further off than the split's tolerance, mm², and where the most
 *  is. */
export interface OffScanReport {
  tool: string
  max: number
  area: number
  at: Vec3
}

/** A face of a built body: its fingerprint — what a pick stores and what a
 *  rebuild re-finds it by — and its hash, what the body's mesh names it by
 *  for the length of this build. */
export interface FaceInfo {
  hash: number
  fingerprint: FaceFingerprint
  /** For a round face read off a build, whether it goes the whole way
   *  round its axis (partialRound) — not part of the name a pick stores, so
   *  a pick taken back from a feature does not say. */
  fullTurn?: boolean
  /** A face a pattern copied: the pattern and which copy it is on (see
   *  patternCopies.ts) — its maker is that of the face it copies. */
  copy?: CopyMark
}

export interface EdgeInfo {
  hash: number
  fingerprint: EdgeFingerprint
  /** The faces on either side, by hash — what says which edges bound a
   *  face, for a sketch that starts from the face's outline. */
  faces: number[]
  /** The two ends and the unit tangent at each — what a tangent chain is
   *  walked by (topo.ts tangentChain), here so the viewport can light the
   *  chain a fillet will run along before the kernel is asked. */
  ends: [Vec3, Vec3]
  endTangents: [Vec3, Vec3]
  /** The edge sampled for drawing, XYZ interleaved. */
  polyline: Float32Array
}

export interface BuiltBody {
  /** The id of the feature that made the body. */
  id: number
  /** The body as this kernel meshed it: a new key every time the builder
   *  meshes a body anew — another shape, another label — and the same one
   *  for as long as the body comes through the builds unchanged. What the
   *  page holds a body under, and tells the kernel it holds, so a build
   *  hands over only the bodies it made, changed or took away. Begins with
   *  the builder's own mark: a kernel started again never hands out a key
   *  the page held from the one before. */
  key: string
  name: string
  mesh: KernelMesh
  volume: number
  faces: number
  closed: boolean
  /** A sheet: a surface, a cutter, never exported on its own. */
  surface: boolean
  /** Every face and edge with its fingerprint, for the viewport's picks. */
  topology: { faces: FaceInfo[]; edges: EdgeInfo[] }
  /** The name a body came with from a STEP file, where the file gave it
   *  one — see Look. */
  label?: string
  /** The mesh's triangles and the box round it — what the body list and
   *  the readout give, without the mesh at hand. */
  triangles: number
  box: { min: Vec3; max: Vec3 } | null
}

/** A body handed over to be drawn as soon as it can be: its topology there
 *  where its faces had been read in the build, and otherwise read after it
 *  (Builder.topologiesOf) — a freeform body's faces can take seconds. */
export type DrawnBody = Omit<BuiltBody, 'topology'> & { topology?: BuiltBody['topology'] }

/** A body of a build without its mesh and topology: what a build tells of
 *  every body standing, the ones the page already holds included. */
export type BodyBrief = Omit<BuiltBody, 'mesh' | 'topology'>

/** A built body in brief. */
export function bodyBrief(b: DrawnBody): BodyBrief {
  const { mesh: _mesh, topology: _topology, ...brief } = b
  return brief
}

/** Two solid bodies of a build that run into each other — see
 *  Builder.overlaps. */
export interface Overlap {
  /** The two bodies, by id. */
  a: number
  b: number
  /** The volume they share, mm³. */
  volume: number
  /** What they share, meshed — on the two bodies' own facets. */
  mesh: KernelMesh
}

/** What a body brought with it from a file: its part's name, kept by the
 *  body's id through the features after — and given to a copy of it. */
export interface Look {
  label: string
}

/** A body in the builder: its shape, and which feature first made each of
 *  its faces (by the face's hash for this session) — carried across every
 *  step through the kernel's history, so a fingerprint can say who made
 *  the face it names. */
export interface Body {
  name: string
  shape: Shape
  origins: Map<number, number>
  /** A sheet rather than a solid. */
  surface?: boolean
  /** A freeform surface's fit, which made the sheet: what a split carries
   *  it on from, past its edge, when it stops short of the body it cuts. */
  fit?: SurfaceFitResult
  /** A patch network's body: which patch each face is, by face hash. */
  patches?: Map<number, number>
  /** A sheet a Split or a Combine has changed since it was made: trimmed
   *  (still on the surface it was fitted as, less of it), or joined to
   *  another — no longer the patch of the plane or cylinder it was fitted
   *  as (Builder.fittedFor). */
  reshaped?: 'trimmed' | 'joined'
}

/** Where a sketch with a step was placed in a build — see Builder.placed. */
export interface PlacedSketch {
  name: string
  frame: SectionFrame
  sketch: Sketch
  changed: boolean
  regions?: Region[]
}

/** All the builder holds after a step of a build — its bodies and what is
 *  kept with them for editing — and what the build had said of each
 *  feature by then: what a later build that starts with the same steps
 *  takes up from (Builder.build). The maps are the snapshot's own; the
 *  bodies in them, shapes and all, are shared with the builder and with the
 *  snapshots after it, never changed — a step puts a new body in place of
 *  the one it works on. */
export interface Snapshot {
  results: FeatureResult[]
  bodies: Map<number, Body>
  aliases: Map<number, number>
  issued: Set<number>
  pieces: Map<number, number[]>
  stages: Map<number, Map<number, Body>>
  fitted: Map<number, TrimPrimitive>
  placed: Map<number, PlacedSketch>
  looks: Map<number, Look>
}

/** A node of the builder's tree of steps (Builder.build): a step by its
 *  key, below the steps before it — the builder's state after it and what
 *  it read of the state before, while they are held. */
export interface PrefixNode {
  key: string
  parent: PrefixNode | null
  children: Map<string, PrefixNode>
  state: Snapshot | null
  reads: StepReads | null
  /** When it was last built, looked up or taken over from. */
  used: number
}

/** What a build did with its steps: played them (recomputed), or took
 *  them up from a state the builder held or over from another build
 *  (restored), of how many. */
export interface BuildSteps {
  recomputed: number
  restored: number
  of: number
  /** The steps played, by their feature's id, with how long each took. */
  played: { id: number; ms: number }[]
}

/** A build kept: what each of its steps was built from (stepKeys), the
 *  builder's state after each, and what each read of the state before it
 *  (buildReads.ts). No keys: a build nothing can take up from — one asked
 *  for without them, or built against another scan. */
export interface KeptBuild {
  keys: string[]
  states: Snapshot[]
  reads: StepReads[]
}

/** A value as one string, telling apart what JSON alone would not. */
function keyOf(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    // What JSON would lose or confuse: ±Infinity and NaN all write as
    // null, a typed array as an object of its indices, a map as {}.
    if (typeof v === 'number') return Number.isFinite(v) ? v : `#${v}`
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
    if (v instanceof Map) return ['#map', ...v]
    if (v instanceof Set) return ['#set', ...v]
    return v
  })
}

/** The sketches a step reads beside its own fields, by id: a placed
 *  sketch's own and those its pieces were projected from, the sketch an
 *  extrusion measures its reach on. */
function sketchesRead(step: BuildStep): number[] {
  switch (step.kind) {
    case 'sketch':
      return [step.id, ...step.sources.map((s) => s.id)]
    case 'extrude':
    case 'revolve':
    case 'sheet':
      return [step.sketchId]
    case 'loft':
    case 'sweep':
      return step.sketches
    default:
      return []
  }
}

/**
 * What each step of a build is built from, as one string a step: the step
 * and the sketches it reads, a scan region's vertices spelled out. Two
 * builds whose first steps have the same keys stand the same after them,
 * so the builder takes up from the state it kept there rather than play
 * those steps again (Builder.build) — an appended feature costs its own
 * step, the rollback bar moved up is a state looked up.
 */
export function stepKeys(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined): string[] {
  return steps.map((step) => keyOf([step, sketchesRead(step).map((id) => [id, sketchOf(id) ?? null])]))
}

/** Whether two boxes meet, with a margin for a face shared. */
export function boxesMeet(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  const margin = 1e-4
  for (let i = 0; i < 3; i++) if (a.max[i] < b.min[i] - margin || b.max[i] < a.min[i] - margin) return false
  return true
}

/** How a split fragment or a trim's face is sampled against the scan: about
 *  this many points, spread over its surface by area. */
export const SPLIT_SAMPLES = 1500

/** The i-th point of the van der Corput sequence in a base — evenly spread
 *  over 0…1 for any number of them, and the same every time. */
export function halton(i: number, base: number): number {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

export interface BuildResult {
  results: FeatureResult[]
  /** The bodies standing that the caller does not hold yet — all of them
   *  unless it said which it holds (Builder.build's `have`). */
  bodies: BuiltBody[]
  /** Every body standing, in brief, in order. */
  all: BodyBrief[]
  /** What the build did with its steps. */
  steps: BuildSteps
}

/** A build as the page takes it (Builder.buildDrawn): bodies to draw. */
export type DrawnBuild = Omit<BuildResult, 'bodies'> & { bodies: DrawnBody[] }

/** The box round a mesh, or null for one with no points. */
export function meshBox(mesh: { positions: Float32Array }): { min: Vec3; max: Vec3 } | null {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k]
      if (p[i + k] > max[k]) max[k] = p[i + k]
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null
}

/** The length of a shape's bounding box's diagonal: its size, which the
 *  tolerances it is matched, meshed and measured under follow. */
export function diagonalOf(kernel: ReKernel, shape: Shape): number {
  const bounds = kernel.extent(shape)
  return Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
}

/** The chord tolerance a body is meshed to, off its size — capped at
 *  0.05 mm, so a large part zoomed in on is not drawn in facets. */
export function meshDeflection(diagonal: number): number {
  return Math.min(0.05, Math.max(0.005, diagonal * 5e-4))
}

/** The chord tolerance a fitted freeform surface is drawn to: meshDeflection
 *  without its cap. A fitted surface is a tool or a skin, not a part to
 *  zoom in on, and drawn to 0.05 mm one 375 mm across came to 856 k
 *  triangles. */
export function surfaceMeshDeflection(diagonal: number): number {
  return Math.max(0.005, diagonal * 5e-4)
}

/** The most triangles a fitted freeform surface may mesh to at
 *  meshDeflection's chord, the finest it is meshed to — read off the fit
 *  before the kernel meshes it (surfaceFit meshTriangles). The kernel
 *  meshes about 80 k triangles a second. */
export const SURFACE_TRIANGLES = 300_000

/** Match every wanted fingerprint to a different candidate, in order. */
export function pickEach<F>(
  wanted: readonly F[],
  candidates: readonly { hash: number; fingerprint: F }[],
  tol: ReturnType<typeof matchTolerance>,
  match: (w: F, c: readonly F[], t: ReturnType<typeof matchTolerance>) => number | null,
  describe: (f: F) => string,
): { hashes: number[] } | { lost: string } {
  const taken = new Set<number>()
  const hashes: number[] = []
  for (const w of wanted) {
    const open = candidates.map((_, i) => i).filter((i) => !taken.has(i))
    const j = match(w, open.map((i) => candidates[i].fingerprint), tol)
    if (j === null) return { lost: describe(w) }
    taken.add(open[j])
    hashes.push(candidates[open[j]].hash)
  }
  return { hashes }
}
