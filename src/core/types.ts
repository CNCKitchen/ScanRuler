// SPDX-License-Identifier: AGPL-3.0-only
export type Vec3 = [number, number, number]

/** Output of a file parser. STL produces a triangle soup (9 floats per
 *  triangle); PLY/OBJ are already indexed. */
export interface ParsedMesh {
  kind: 'soup' | 'indexed'
  positions: Float32Array
  indices?: Uint32Array
}

/** Indexed mesh plus everything the fitting pipeline needs: per-vertex
 *  normals and a CSR vertex-adjacency graph for region growing. */
export interface MeshGraph {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  adjOffsets: Uint32Array
  adjList: Uint32Array
  vertexCount: number
  triangleCount: number
  bboxDiag: number
}

/** 0 = use all points, otherwise the k in "discard residuals beyond k·sigma". */
export type SigmaPreset = 0 | 1 | 2 | 3

/** v1 ships Gaussian best-fit; Chebyshev / min-circumscribed / max-inscribed
 *  slot in here later. */
export type FitMethodId = 'gaussian'

export interface FitSettings {
  method: FitMethodId
  sigma: SigmaPreset
}

export type ElementKind = 'point' | 'line' | 'plane' | 'sphere' | 'cylinder'

/** The kinds that are measured by fitting to the scan surface. Points are
 *  picked, lines only constructed; these three run the worker pipeline. */
export type FittedElementKind = 'sphere' | 'cylinder' | 'plane'

export interface Sphere {
  cx: number
  cy: number
  cz: number
  r: number
}

/** Plane as n·p = d with |n| = 1. */
export interface Plane {
  nx: number
  ny: number
  nz: number
  d: number
}

/** Infinite cylinder: a point on the axis, a unit axis direction, a radius. */
export interface Cylinder {
  px: number
  py: number
  pz: number
  ax: number
  ay: number
  az: number
  r: number
}

/** What every fit reports regardless of geometry: the RMS form deviation and
 *  how many points went into it. Picked and constructed elements have no
 *  residuals — they carry zeros here. */
export interface FitBase {
  sigma: number
  usedPoints: number
  regionSize: number
}

/** A reference point: picked on the scan surface or constructed. */
export interface PointFit extends FitBase {
  kind: 'point'
  center: Vec3
}

/** A reference line (an axis). Always constructed — from two points, a
 *  cylinder axis, or a plane–plane intersection. */
export interface LineFit extends FitBase {
  kind: 'line'
  /** Midpoint of the drawn segment. */
  center: Vec3
  dir: Vec3
  /** Extent to draw and to sanity-check measurements against; the line the
   *  math uses is still infinite. */
  length: number
}

export interface SphereFit extends FitBase {
  kind: 'sphere'
  center: Vec3
  radius: number
}

export interface CylinderFit extends FitBase {
  kind: 'cylinder'
  /** Point on the axis at the middle of the fitted surface. */
  center: Vec3
  axis: Vec3
  radius: number
  /** Axial extent of the fitted surface. */
  length: number
  /** Degrees of arc the fitted surface wraps around the axis — under ~90° the
   *  axis position is only weakly determined, which the UI shows. */
  coverage: number
}

export interface PlaneFit extends FitBase {
  kind: 'plane'
  /** Middle of the fitted patch (lies in the plane). */
  center: Vec3
  normal: Vec3
  /** In-plane principal axes and half-extents of the patch, for drawing it. */
  basisU: Vec3
  basisV: Vec3
  extentU: number
  extentV: number
}

/** The geometry of one element — everything except the (large) list of mesh
 *  vertices a fitted one was measured on. */
export type FitData = SphereFit | CylinderFit | PlaneFit | PointFit | LineFit

/** How an element came to be, and what is needed to rebuild it: fitted
 *  elements re-fit from their seeds when the sigma preset changes, picked
 *  points are fixed coordinates, constructions re-evaluate from their source
 *  elements. */
export type ElementSource =
  | { type: 'fitted'; seeds: number[] }
  | { type: 'picked' }
  | { type: 'constructed'; method: string; refs: number[]; params: number[] }

interface WithRegion {
  region: Uint32Array
}

/** Fit result plus the mesh region it was measured on. Picked points carry an
 *  empty region — there is no surface patch to tint for them. */
export type FitOutput = FitData & WithRegion

export type SphereFitOutput = SphereFit & WithRegion
