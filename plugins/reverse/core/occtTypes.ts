// SPDX-License-Identifier: AGPL-3.0-only
// The OpenCASCADE package's interface, as much of it as the kernel calls:
// the one place the package's own shape is written down, so the kernel
// loads it on demand and type-checks against this.

/** A round's radius on an edge: one, or running evenly from `start` at the
 *  edge's curve's start to `end`. */
export type FilletRadius = number | { readonly start: number; readonly end: number }

/** The slice of the occt-wasm kernel this adapter calls, as a structural
 *  type: the package's own class type is not imported here so a version
 *  bump that reshapes something unused cannot break the build. */
export interface OcctLike {
  makeLineEdge(a: XYZ, b: XYZ): number
  makeArcEdge(a: XYZ, m: XYZ, b: XYZ): number
  makeCircleEdge(center: XYZ, normal: XYZ, radius: number): number
  /** `poles` flat x, y, z; `weights` one a pole; `knots` distinct, with
   *  their `multiplicities`. */
  makeBSplineEdge(poles: number[], weights: number[], knots: number[], multiplicities: number[], degree: number, periodic?: boolean): number
  makeWire(edges: number[]): number
  makeFace(wire: number): number
  addHolesInFace(face: number, holes: number[]): number
  extrude(shape: number, dx: number, dy: number, dz: number): number
  draftPrism(shape: number, dx: number, dy: number, dz: number, angleDeg: number): number
  revolve(shape: number, axis: { point: XYZ; direction: XYZ }, angleRad: number): number
  makeHelixWireHanded(origin: XYZ, axis: XYZ, pitch: number, height: number, radius: number, leftHanded?: boolean): number
  sweepOriented(profile: number, spine: number, mode?: number, up?: XYZ): number
  transform(shape: number, matrix: number[]): number
  translate(shape: number, dx: number, dy: number, dz: number): number
  copy(shape: number): number
  halfSpace(origin: XYZ, normal: XYZ): number
  sectionPlane(shape: number, origin: XYZ, normal: XYZ): number
  /** Where two shapes' surfaces cross: a compound of edges and vertices. */
  section(a: number, b: number): number
  fuse(a: number, b: number): number
  fuseAll(shapes: number[]): number
  toBREPBinary(shape: number): Uint8Array
  fromBREPBinary(data: Uint8Array): number
  cut(a: number, b: number): number
  common(a: number, b: number): number
  distanceBetween(a: number, b: number): number
  makeVertex(x: number, y: number, z: number): number
  makeCompound(shapes: number[]): number
  unifySameDomain(shape: number): number
  getSubShapes(shape: number, type: 'solid' | 'shell' | 'face' | 'edge' | 'vertex'): number[]
  vertexPosition(vertex: number): XYZ
  /** The point of the face's surface nearest `point` — its foot, which may
   *  lie past the face's edges. */
  projectPointOnFace(face: number, point: XYZ): XYZ
  /** The point of an edge nearest `point`. */
  projectPointOnEdge(edge: number, point: XYZ): { point: XYZ; tangent: XYZ; parameter: number }
  /** A solid closed by a shell. */
  makeSolid(shell: number): number
  subShapeCount(shape: number, type: 'solid' | 'shell' | 'face' | 'edge'): number
  subShapeHashes(shape: number, type: 'face' | 'edge', upper: number): number[]
  hashCode(shape: number, upper: number): number
  surfaceType(face: number): string
  surfaceNormal(face: number, u: number, v: number): XYZ
  uvBounds(face: number): { uMin: number; uMax: number; vMin: number; vMax: number }
  getSurfaceCenterOfMass(face: number): XYZ
  pointOnSurface(face: number, u: number, v: number): XYZ
  uvFromPoint(face: number, point: XYZ): { u: number; v: number }
  /** 'in', 'on' or 'out' of the face's edges. */
  classifyPointOnFace(face: number, u: number, v: number): string
  getSurfaceArea(shape: number): number
  getFaceCylinderData(face: number): { radius: number } | null
  surfaceCurvature(face: number, u: number, v: number): { min: number; max: number; mean: number }
  curveType(edge: number): string
  curveParameters(edge: number): { first: number; last: number }
  curvePointAtParam(edge: number, t: number): XYZ
  curveTangent(edge: number, t: number): XYZ
  curveLength(edge: number): number
  edgeToFaceMap(shape: number, upper: number): number[]
  wireframe(shape: number, deflection: number): { points: Float32Array; edgeGroups: Int32Array }
  fillet(solid: number, edges: number[], radius: number): number
  filletVariable(solid: number, edge: number, startRadius: number, endRadius: number): number
  loft(wires: number[], isSolid: boolean, ruled: boolean): number
  linearPattern(shape: number, direction: XYZ, spacing: number, count: number): number
  circularPattern(shape: number, center: XYZ, axis: XYZ, angle: number, count: number): number
  split(shape: number, tools: number[]): number
  bsplineSurface(controlPoints: XYZ[], rows: number, cols: number): number
  sew(shapes: number[], tolerance?: number): number
  sewAndSolidify(faces: number[], tolerance?: number): number
  healSolid(shape: number, tolerance?: number): number
  chamfer(solid: number, edges: number[], distance: number): number
  /** `distance` on each edge's first face in the solid's face order, at
   *  `angleDeg` to that face. */
  chamferDistAngle(solid: number, edges: number[], distance: number, angleDeg: number): number
  shell(solid: number, faces: number[], thickness: number, tolerance: number): number
  offset(solid: number, distance: number, tolerance: number): number
  thicken(shape: number, thickness: number, tolerance: number): number
  thickenWithHistory(shape: number, thickness: number, tolerance: number, faces: number[], upper: number): { result: number; modified: number[] }
  defeature(shape: number, faces: number[], tolerance: number): number
  draft(shape: number, face: number, angleRad: number, direction: XYZ): number
  rotate(shape: number, axis: { point: XYZ; direction: XYZ }, angleRad: number): number
  mirror(shape: number, point: XYZ, normal: XYZ): number
  fuseWithHistory(a: number, b: number, faces: number[], upper: number): { result: number; modified: number[] }
  cutWithHistory(a: number, b: number, faces: number[], upper: number): { result: number; modified: number[] }
  intersectWithHistory(a: number, b: number, faces: number[], upper: number): { result: number; modified: number[] }
  /** op 0 fuse, 1 cut, 2 common. */
  booleanOp(op: 0 | 1 | 2, args: number[], tools: number[], options: { fuzzyValue?: number; inputFaceHashes?: number[]; hashUpperBound?: number }): { result: number; modified: number[] }
  /** `radius` one for every edge, or one per edge: a number or a radius
   *  running from `start` at the edge's curve's start to `end`. */
  filletWithHistory(solid: number, edges: number[], radius: FilletRadius | readonly FilletRadius[], faces: number[], upper: number): { result: number; modified: number[] }
  chamferWithHistory(solid: number, edges: number[], distance: number, faces: number[], upper: number): { result: number; modified: number[] }
  shellWithHistory(solid: number, removed: number[], thickness: number, tolerance: number, faces: number[], upper: number): { result: number; modified: number[] }
  mirrorWithHistory(shape: number, point: XYZ, normal: XYZ, faces: number[], upper: number): { result: number; modified: number[] }
  getShapeType(shape: number): string
  containsPoint(shape: number, point: XYZ, tolerance?: number): boolean
  isValid(shape: number): boolean
  isNull(shape: number): boolean
  getVolume(shape: number): number
  getCenterOfMass(shape: number): XYZ
  /** `precise: false` bounds a curved face by its control net, not its
   *  true extremes: larger, and far quicker on freeform faces. */
  getBoundingBox(shape: number, options?: { precise?: boolean; useTriangulation?: boolean }): {
    xmin: number
    ymin: number
    zmin: number
    xmax: number
    ymax: number
    zmax: number
  }
  meshShape(
    shape: number,
    options?: { linearDeflection?: number; angularDeflection?: number },
  ): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; faceGroups?: Int32Array }
  exportStep(shape: number): string
  importStep(data: string | ArrayBuffer): number
  createXCAFDocument(): XcafLike
  release(shape: number): void
}

/** An OCCT document of named, coloured shapes — what a STEP file keeps a
 *  body's name and colour in. */
interface XcafLike {
  addShape(shape: number, options?: { name?: string; color?: [number, number, number] }): number
  exportSTEP(): string
  close(): void
}

/** What reading a STEP file's document takes: its free shapes, an
 *  assembly's components, and each one's name and shape. */
export interface XcafReader {
  getRoots(): number[]
  getChildren(label: number): number[]
  getLabelInfo(label: number): { name: string; isAssembly: boolean; shapeHandle: number | null }
  close(): void
}

export interface XYZ { x: number; y: number; z: number }
