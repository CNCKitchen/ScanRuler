// SPDX-License-Identifier: AGPL-3.0-only
// What Mesh Tools asks of the mesh worker, and what comes back — the
// operations its part of the worker answers (see ../worker.ts), each on the
// mesh the workspace works on: the edited copy, or the scan while there is
// none.

import type { Vec3 } from '../../../src/core/types'
import type { CreaseSetting, ScanRender } from '../../../src/core/geometry/crease'
import type { BooleanOp, BooleanReport, BooleanTool, Closedness } from './boolean'
import type { BreakReport } from './breakSurface'
import type { CutPreview, CutReport } from './cut'
import type { FillMode, FillReport, HoleSurvey } from './fillHoles'
import type { HollowReport } from './hollow'
import type { MirrorMode, MirrorReport } from './mirror'
import type { OffsetReport, OffsetSettings, ThickenReport, ThickenSide } from './offset'
import type { PieceSurvey } from './pieces'
import type { ReduceReport, ReduceSettings } from './reduce'
import type { SmoothReport, SmoothSettings } from './smooth'
import type { TrimReport, TrimSettings } from './trimToScan'

/** The plugin's id, which its worker part answers to. */
export const MESH_TOOLS = 'mesh-tools'

/** A piece survey's figures — see core/pieces. */
export type PieceCount = Omit<PieceSurvey, 'islandMask' | 'islandCentres'>

/** An edit, as the worker is asked for it: Delete marked takes every
 *  triangle with all three corners in `vertices` (core/edit); Flip normals
 *  turns every triangle over, or with `vertices` those with all three
 *  corners in them (core/flip); Cut takes off
 *  everything on the side `normal` points to (core/cut); Mirror reflects
 *  the mesh across the plane, or with `symmetric` the side `normal` points
 *  away from onto the side it points to (core/mirror); Fill holes closes
 *  every hole smaller across than `maxSize`, or with `at` only the one
 *  ringed there (core/fillHoles); Smooth, core/smooth; Boolean makes the
 *  mesh and the union of the solids — their triangles, in the scan's frame,
 *  and their names — one by `op` (core/boolean); Shrink / expand moves the
 *  surface along its normal (core/offset); Shell hollows a closed mesh
 *  (core/hollow) or thickens an open one into a solid (core/offset). */
export type ScanEditRequest =
  | { type: 'delete-marked'; vertices: Uint32Array }
  | { type: 'flip'; vertices?: Uint32Array }
  | { type: 'cut'; origin: Vec3; normal: Vec3; cap: boolean }
  | { type: 'mirror'; origin: Vec3; normal: Vec3; mode: MirrorMode }
  | { type: 'fill-holes'; maxSize: number; mode: FillMode; at?: Vec3 }
  | { type: 'smooth'; settings: SmoothSettings }
  | { type: 'boolean'; op: BooleanOp; tools: BooleanTool[] }
  | { type: 'offset'; settings: OffsetSettings }
  | { type: 'hollow'; thickness: number }
  | { type: 'thicken'; thickness: number; side: ThickenSide }

/** What an edit did, tool by tool. */
export type MeshEditReport =
  | { kind: 'delete'; triangles: number }
  | { kind: 'flip'; triangles: number }
  | { kind: 'cut'; report: CutReport }
  | { kind: 'mirror'; report: MirrorReport }
  | { kind: 'fill'; report: FillReport }
  | { kind: 'smooth'; report: SmoothReport }
  | { kind: 'boolean'; report: BooleanReport }
  | { kind: 'offset'; report: OffsetReport }
  | { kind: 'hollow'; report: HollowReport }
  | { kind: 'thicken'; report: ThickenReport }

/** The mesh as an edit leaves it, in scan coordinates, and every old
 *  vertex's new number — −1 for one that went. The worker's own mesh is left
 *  alone: the session keeps the result as a file and loads it back as the
 *  copy. */
export interface ScanEdited {
  positions: Float32Array
  indices: Uint32Array
  vertexMap: Int32Array
  report: MeshEditReport
}

export interface ReduceResult {
  /** The reduced mesh, compact, in scan coordinates. */
  positions: Float32Array
  indices: Uint32Array
  /** Its corner slots, for drawing its edges — see geometry/wireSlots. */
  wireSlots: Uint8Array
  /** Every vertex of the mesh reduced's number on it, −1 for one that was
   *  collapsed away. */
  vertexMap: Int32Array
  /** Signed distance from every scan vertex to the reduced surface, mm; NaN
   *  where a vertex is not part of it. */
  deviation: Float32Array
  report: ReduceReport
}

/** The body Trim to scan cuts: a solid on offer, its triangles in the scan's
 *  frame, and a key that changes whenever they do — the worker keeps the
 *  body prepared under it. */
export interface TrimBody extends BooleanTool {
  key: string
}

export interface TrimResult {
  /** The piece, welded and closed, in scan coordinates. */
  positions: Float32Array
  indices: Uint32Array
  /** Its corner slots, for drawing its edges — see geometry/wireSlots. */
  wireSlots: Uint8Array
  /** 1 for each triangle of its mating face. */
  mating: Uint8Array
  /** How far the mating face is from the break less the offset, at each of
   *  its vertices over the break; NaN at every other (core/trimToScan). */
  gap: Float32Array
  report: TrimReport
}

/** Surface named without a mouse, as a marking would mark it: the
 *  vertices inside an axis-aligned box or a ball, or a list of them by
 *  number — of those, only the ones whose normal is within `angleDeg` of
 *  `facing`, when that is given (core/select). */
export interface MeshRegion {
  box?: { min: Vec3; max: Vec3 }
  sphere?: { center: Vec3; radius: number }
  vertices?: Uint32Array
  facing?: Vec3
  angleDeg?: number
}

/** A mesh in figures: its vertices and triangles, its bounding box in the
 *  scan's frame, how far from closed it is, and the volume it encloses, mm³
 *  — null while it is open. */
export interface MeshFigures extends Closedness {
  vertices: number
  triangles: number
  bounds: { min: Vec3; max: Vec3 }
  volume: number | null
}

/** Each operation's request and its answer. */
export interface MeshToolsOps {
  /** The mesh reduced to a light one for CAD, held within a tolerance of it
   *  and measured against it — see core/reduce. Nothing changes. */
  reduce: { payload: { settings: ReduceSettings }; result: ReduceResult }
  /** The mesh's connected pieces, and which of them are islands, smaller
   *  across than `minSize` — by their triangles, nine floats each, and their
   *  middles, three each. Nothing changes. */
  islands: { payload: { minSize: number }; result: { survey: PieceCount; triangles: Float32Array; centres: Float32Array } }
  /** The mesh without its islands smaller than `minSize`, like an edit. */
  'remove-islands': { payload: { minSize: number }; result: { survey: PieceCount; positions: Float32Array; indices: Uint32Array; vertexMap: Int32Array } }
  /** The mesh's rims, sorted into holes smaller across than `maxSize` and
   *  the rest: the holes as segments, six floats an edge, the middle of
   *  each, and the rims left open. Nothing changes. */
  holes: { payload: { maxSize: number }; result: { survey: HoleSurvey; holes: Float32Array; centres: Float32Array; open: Float32Array } }
  /** The cap a cut at this plane would close the part with, and what of the
   *  cut it would leave open. Nothing changes. */
  'cut-preview': { payload: { origin: Vec3; normal: Vec3 }; result: CutPreview }
  /** How far the mesh is from closed, which a boolean needs it to be.
   *  Nothing changes. */
  closedness: { payload: Record<string, never>; result: Closedness }
  /** The edited copy's signed distance from the scan in use, at each of its
   *  vertices; NaN at those an edit made, which `fromScan` — every scan
   *  vertex's number on the copy, −1 for one that went — does not reach. */
  'edited-deviation': { payload: { fromScan: Int32Array }; result: Float32Array }
  edit: { payload: { edit: ScanEditRequest }; result: ScanEdited }
  /** The mesh's size, bounds and closedness, and the volume it encloses
   *  when closed. Nothing changes. */
  describe: { payload: Record<string, never>; result: MeshFigures }
  /** A copy of the mesh's triangles, in the frame it stands in — what Wrap
   *  is worked out on, in a worker of its own. Nothing changes. */
  triangles: { payload: Record<string, never>; result: { positions: Float32Array; indices: Uint32Array } }
  /** The vertices of the mesh a region holds, and how many it has. Nothing
   *  changes. */
  select: { payload: { region: MeshRegion }; result: { vertices: Uint32Array; vertexCount: number } }
  /** A staged load becomes the edited copy, beside the scan — or, with null,
   *  the copy goes and the workspace works on the scan again. */
  'set-edited': { payload: { staged: number | null }; result: null }
  /** The edited copy's render arrays again, its sharp edges split as
   *  `crease` now says — null with no copy. */
  'recrease-edited': { payload: { crease: CreaseSetting }; result: ScanRender | null }
  /** The break where the body reaches into the mesh deeper than `depth` —
   *  its vertices, the marking it is shown as (core/breakSurface). Nothing
   *  changes. */
  'find-break': { payload: { body: TrimBody; depth: number }; result: { vertices: Uint32Array; report: BreakReport } }
  /** The body cut to fit the mesh's break (core/trimToScan) — a piece beside
   *  the mesh, not an edit of it. Nothing changes. */
  'trim-to-scan': { payload: { body: TrimBody; settings: TrimSettings }; result: TrimResult }
}
