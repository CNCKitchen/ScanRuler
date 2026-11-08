// SPDX-License-Identifier: AGPL-3.0-only
// The features resolved for the build: each a BuildStep with its sketches
// lifted into the part and its planes and axes found, and what resolving
// reads beside the feature list (ResolveContext).

import type { Extension } from '../../../src/core/elements/extend'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { FitData, Vec3 } from '../../../src/core/types'
import type { ConstrainMode, ConstrainRef } from './autoConstrain'
import type { BodyOp, BooleanOp, ChamferMode, RegionPick, EdgeRef, ExtrudeUntil, FaceProfile, FaceRef, NetworkFeature, Primitive, SplitKeep, SurfaceFitParams, SurfaceShape, ThickenSide, TrimPrimitive, VariableEdge } from './features'
import type { LoopPiece, Profile } from './kernel'
import type { ShadowSource } from './shadowPieces'
import type { SweepRoute } from './sweepRoute'
import type { ThreadStandard } from './thread'
import type { StoredPick } from './where'

/** Where a sketch on a body's face is found again at build time: the face
 *  on the body as it stands before the feature, and the frame the sketch
 *  was lifted in, to move the profiles from. */
export interface SketchOnFace {
  body: number
  face: FaceRef
  frame: SectionFrame
  /** Millimetres the sketch stands out of the face. */
  offset?: number
}

/** A plane in the part: a point on it and its unit normal. */
export interface PlaneGeometry {
  origin: Vec3
  normal: Vec3
}

/** What the worker builds from: every feature resolved to geometry. A
 *  sketch resolves to nothing of its own — its regions travel with the
 *  extrude or revolve that picked them, as profiles in the part. */
export type BuildStep =
  | {
      kind: 'extrude'
      id: number
      name: string
      sketchId: number
      profiles: Profile[]
      /** The sketch plane's normal — what offsets count along. */
      dir: Vec3
      /** A point on the sketch plane, to tell which side of a limiting
       *  plane the sketch is on. */
      origin: Vec3
      from: number | PlaneGeometry
      to: number | PlaneGeometry
      /** Set when the end is found on the bodies; `to` is then unused. */
      until?: ExtrudeUntil
      draftDeg: number
      /** The way the profile is swept when it is not `dir` — see
       *  ExtrudeFeature.direction; it stays put when the sketch moves. */
      along?: Vec3
      op: BodyOp
      target?: number
      /** The sketch lies on a body's face: re-found when the step runs,
       *  the profiles, origin and dir moved with it. */
      onFace?: SketchOnFace
      /** The regions picked, by their keys: what the profiles are lifted
       *  from again where the build placed the sketch anew. */
      regions: string[]
      /** Picked regions an edit of the sketch found again by where they
       *  lie (ExtrudeFeature.regionsByPlace), for the row to say. */
      regionsByPlace?: string[]
      /** How the regions were asked for, while that stands: what they are
       *  taken again by where the build places the sketch anew. */
      regionPick?: RegionPick['given']
      /** The profile is a face of a body, re-found when the step runs and
       *  pulled as it stands; `profiles` is then empty, and `origin` and
       *  `dir` are the face's as last seen, replaced by the face found. */
      faceProfile?: FaceProfile
    }
  | {
      kind: 'revolve'
      id: number
      name: string
      sketchId: number
      profiles: Profile[]
      origin: Vec3
      dir: Vec3
      angleRad: number
      /** Millimetres climbed along `dir` each turn — 0 for a plain revolve;
       *  see RevolveFeature. */
      pitch: number
      leftHanded: boolean
      op: BodyOp
      target?: number
      onFace?: SketchOnFace
      regions: string[]
      regionsByPlace?: string[]
      regionPick?: RegionPick['given']
      /** The axis is a line of the sketch itself, so it moves with the
       *  sketch's face; an element's or a coordinate axis stays. */
      axisInSketch?: boolean
      /** That line, for the axis to be read off the sketch where the build
       *  placed it anew. */
      axisLine?: number
    }
  /** `edgesWhere` and `facesWhere`: the queries the picks were given by,
   *  run again on the body as it stands before the step (where.ts). */
  | { kind: 'shell'; id: number; name: string; body: number; faces: FaceRef[]; facesWhere?: StoredPick<FaceRef>[]; thickness: number }
  | { kind: 'fillet'; id: number; name: string; body: number; edges: EdgeRef[]; edgesWhere?: StoredPick<EdgeRef>[]; radius: number; chain: boolean; skipFailing?: boolean; variable?: VariableEdge[] }
  /** `mode` absent: one distance on both faces; else `distance2` or
   *  `angleDeg` with it, and `flip` for the other reference face — see
   *  ChamferFeature. */
  | { kind: 'chamfer'; id: number; name: string; body: number; edges: EdgeRef[]; edgesWhere?: StoredPick<EdgeRef>[]; distance: number; chain: boolean; skipFailing?: boolean; mode?: Exclude<ChamferMode, 'equal'>; distance2?: number; angleDeg?: number; flip?: boolean }
  | { kind: 'hole'; id: number; name: string; body: number; origin: Vec3; dir: Vec3; radius: number; depth: number | null; oneWay?: boolean }
  | { kind: 'thread'; id: number; name: string; body: number; face: FaceRef; standard: ThreadStandard; diameter: number; pitch: number; leftHanded: boolean; length: number | null; start: number; flip: boolean; offset: number; chamfer: boolean }
  | { kind: 'extract'; id: number; name: string; primitive: Primitive; op: BodyOp; target?: number }
  | { kind: 'cutPlane'; id: number; name: string; body: number; plane: PlaneGeometry; keep: 1 | -1 }
  | { kind: 'mirror'; id: number; name: string; body: number; plane: PlaneGeometry | { face: FaceRef }; join: boolean }
  /** `tool` one body or several — see BooleanFeature. */
  | { kind: 'boolean'; id: number; name: string; op: BooleanOp; body: number; tool: number | number[]; keep?: boolean }
  | { kind: 'draft'; id: number; name: string; body: number; neutral: PlaneGeometry | { face: FaceRef }; faces: FaceRef[]; facesWhere?: StoredPick<FaceRef>[]; angleRad: number; groups?: { faces: FaceRef[]; angleRad: number }[] }
  | { kind: 'moveFace'; id: number; name: string; body: number; faces: FaceRef[]; facesWhere?: StoredPick<FaceRef>[]; offset: number }
  | { kind: 'deleteFace'; id: number; name: string; body: number; faces: FaceRef[]; facesWhere?: StoredPick<FaceRef>[] }
  | { kind: 'offsetBody'; id: number; name: string; body: number; distance: number; keep: boolean }
  /** A STEP file's bodies, by the key its text was handed to the builder
   *  under (Builder.addStepFiles). */
  | { kind: 'import'; id: number; name: string; file: string }
  /** Bodies carried by a rigid move, row-major 3 × 4 (move.ts) — or copies
   *  of them. */
  | { kind: 'moveBody'; id: number; name: string; bodies: number[]; matrix: number[]; copy: boolean }
  | { kind: 'sheet'; id: number; name: string; sketchId: number; pieces: LoopPiece[]; dir: Vec3; from: number; to: number }
  | { kind: 'split'; id: number; name: string; body: number; tools: number[]; keep: SplitKeep; tolerance: number; overlap: number; within?: number }
  /** `sketches` are the sketches the profiles were taken from, in order —
   *  taken again from those the build placed anew; `sketchNames` their
   *  names, for a refusal to name them. */
  | { kind: 'loft'; id: number; name: string; profiles: Profile[]; sketches: number[]; sketchNames?: string[]; ruled: boolean; op: BodyOp; target?: number }
  /** `sketches`: the profile's sketch and the path's, if it has one — taken
   *  again from those the build placed anew; `from`, a point of the profile:
   *  the end of the path it starts at is the one nearest it. `route`: what
   *  the path was made from where no sketch gave it. */
  | { kind: 'sweep'; id: number; name: string; profile: Profile; path: LoopPiece[]; from: Vec3; sketches: number[]; route?: SweepRoute; op: BodyOp; target?: number }
  /** A sheet body made a solid — see ThickenFeature. */
  | { kind: 'thicken'; id: number; name: string; sheet: number; thickness: number; side: ThickenSide; op: BodyOp; target?: number }
  | { kind: 'pattern'; id: number; name: string; body: number; mode: 'circular' | 'linear'; origin: Vec3; dir: Vec3; count: number; step: number; grid?: { dir: Vec3; count: number; step: number } }
  /** The surface is fitted where the scan is — in the kernel worker, which
   *  holds the scan's vertices for the live map — so the step carries the
   *  region and the parameters, not points — and, for a region read facing
   *  a way, that way, which a refusal says bounds the region's normals. */
  | { kind: 'surface'; id: number; name: string; region: Uint32Array; fit: SurfaceFitParams; shape: SurfaceShape; constrain: ConstrainMode; refs: ConstrainRef[]; refSurfaces: { id: number; name: string }[]; facing?: { dir: Vec3; withinDeg?: number } }
  /** A patch network is read off the scan where the scan is, as a surface
   *  is fitted: the step carries the network as drawn — its nodes, curves
   *  and cells by position — and the worker traces and fits it there. */
  | ({ kind: 'network'; id: number; name: string } & Pick<NetworkFeature, 'nodes' | 'curves' | 'cells' | 'spans' | 'fit'>)
  | { kind: 'trim'; id: number; name: string; bodies: number[]; primitives: TrimPrimitive[]; tolerance: number; overlap: number }
  /** A sketch placed on the part before the features on it are built: its
   *  face found again and its projected pieces taken again from what they
   *  were projected from, the sketch solved on them — see build.ts
   *  placeSketch. Made only for a sketch that has either; the frame is
   *  where it was last placed, and `sources` the frames of the sketches
   *  its pieces were projected from. */
  | { kind: 'sketch'; id: number; name: string; frame: SectionFrame; onFace?: SketchOnFace; sources: { id: number; frame: SectionFrame }[] }
  /** A feature that could not be resolved — its reason, so the build reports
   *  it in its place and carries on with the rest. */
  | { kind: 'failed'; id: number; name: string; message: string; body?: number }

/** The fewest scan vertices a surface is fitted through: below this a net
 *  of even the smallest count has more knots than data. */
export const SURFACE_MIN_REGION = 16

/** What a resolution needs to know about the workspace's other things. */
export interface ResolveContext {
  /** A shadow section's kind and shape too, for an Extract of it. */
  sections: readonly ({ id: number; frame: SectionFrame } & ShadowSource)[]
  /** `extend` is how far past the measured surface Measure draws the
   *  element — what an extracted body is made at. */
  elements: readonly { id: number; name?: string; fit?: FitData; extend?: Extension; assumed?: number }[]
  /** Where the scan's centre is — what a coordinate plane's axis runs
   *  through, so its offset is the plane's coordinate. */
  modelCenter: Vec3
}
