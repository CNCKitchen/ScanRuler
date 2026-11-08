// SPDX-License-Identifier: AGPL-3.0-only
// Every message between the main thread and the mesh worker, as the two
// unions both sides are typed against: workerClient.ts asks, meshWorker.ts
// answers. A request's id comes back on its answer; progress text and the
// interim poses of an alignment arrive while a request is still open and
// settle nothing, and the abort is the one message never answered. A
// plugin's requests ride inside `plugin`, their payload opaque to the core.

import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
import type { VolumeDeviation } from './deviation/volume'
import type { ElementTarget, MaterialSide } from './deviation/elementField'
import type { StepInfo } from './parsers/step'
import type { ThicknessMethod } from './thickness/thickness'
import type { AxialWindow, ElementKind, FitOutput, FitSettings, TextureNote, Vec3 } from './types'
import type { ObjCompanions } from './parsers/objTexture'
import type { FitGuide } from './fit/guide'
import type { RayGrid, RimCircle, ScanRim, Tessellation } from './geometry/scanQa'
import type { SheetReading } from './geometry/sheet'
import type { MeshCentroid } from './geometry/centroid'
import type { CreaseReport, CreaseSetting } from './geometry/crease'
import type { SeedPlane, SymmetryPlane } from './symmetry'
import type { AutoAlignResult } from './autoAlign'
import type { ScanSpot } from './geometry/nearest'
import type { PlaneRegionReport, Segmentation, SegmentOptions } from './fit/segment'
import type { SectionFrame } from './section/frame'
import type { ShadowShape } from './section/shadow'

export type WorkerRequest =
  /** `crease` says whether the scan's sharp edges are to be drawn sharp —
   *  see geometry/crease.ts. */
  /** `scale` is millimetres per unit of the file — an STL in inches is
   *  25.4 — applied to the coordinates before anything is built on them.
   *  Absent or 1, the file is taken in millimetres. `companions` are the
   *  files that came with a textured OBJ, the images decoded. */
  | { type: 'load'; requestId: number; name: string; buffer: ArrayBuffer; crease: CreaseSetting; staged?: boolean; transform?: Rigid; scale?: number; companions?: ObjCompanions }
  /** Staged imports leave the current scan/reference available until all
   *  members and their render resources have been prepared. Omitted keeps a
   *  slot; null clears it; a number selects a staged load's request id. */
  /** Put prepared models in place: the scan and the reference — a number is
   *  a prepared load, null empties the slot. */
  | { type: 'commit-import'; requestId: number; scan?: number | null; nominal?: number | null }
  | { type: 'discard-import'; requestId: number; ids: number[] }
  /** The loaded scan's render geometry again, split for sharp edges as
   *  `crease` now says — the setting changed under a loaded scan. */
  | { type: 'recrease'; requestId: number; crease: CreaseSetting }
  | {
      type: 'fit'
      requestId: number
      elementType: ElementKind
      seeds: number[]
      settings: FitSettings
      /** Confine the fit to this span of the surface it finds — a cylinder
       *  with an end pulled in. Absent, the whole surface goes in. */
      window?: AxialWindow
      /** What the surface is known to be — see fit/guide. */
      guide?: FitGuide
    }
  /** Fit to a surface the user marked by hand: the vertices are the region,
   *  so nothing is searched for or grown. */
  | {
      type: 'fit-selection'
      requestId: number
      elementType: ElementKind
      vertices: Uint32Array
      settings: FitSettings
      window?: AxialWindow
    }
  | { type: 'load-nominal'; requestId: number; name: string; buffer: ArrayBuffer; staged?: boolean; scale?: number }
  | { type: 'align'; requestId: number; mode: 'auto' }
  /** From hand-picked pairs. `vertices` narrows what the refinement after them
   *  is measured on, exactly as a local fit's marking does; absent means the
   *  whole scan. */
  | {
      type: 'align'
      requestId: number
      mode: 'points'
      pairs: PointPair[]
      vertices?: Uint32Array
    }
  /** Fine tuning on the surface the user marked, from the fit already in
   *  hand. The starting pose travels with the request because the worker
   *  holds no alignment of its own — the scan's vertices never move for a
   *  scan-to-reference fit, only the transform reported back does. */
  | {
      type: 'align'
      requestId: number
      mode: 'local'
      vertices: Uint32Array
      start: Rigid
      maxDistance: number
    }
  /** Stop the best fit that is running, wherever it has got to. Not a request
   *  — it carries no id and is never answered on its own: the alignment it
   *  interrupts settles as `align-stopped` instead of `align-ok`. It is also
   *  the one message that jumps the queue, because everything else waits
   *  behind the very computation it is trying to end. */
  | { type: 'align-abort' }
  | {
      type: 'deviate'
      requestId: number
      transform: Rigid
      /** How far the reference surface a point is measured against may be
       *  from facing the way the scan does there, in degrees; null takes the
       *  nearest surface whatever it faces. */
      facingDeg: number | null
    }
  /** The map the other way round: the reference — or `mesh`, a mesh in the
   *  reference's frame — cut finer and read against the scan (see
   *  deviation/onReference.ts). */
  | {
      type: 'deviate-reference'
      requestId: number
      /** Takes the scan into the reference's frame, as for 'deviate'. */
      transform: Rigid
      facingDeg: number | null
      /** How far apart the readings are cut to lie, mm. */
      spacing: number
      mesh?: { positions: Float32Array; indices: Uint32Array }
    }
  /** The deviation as volumes: material the reference — or `mesh` — has
   *  and the scan has not, and the other way round (deviation/volume.ts). */
  | {
      type: 'deviate-volume'
      requestId: number
      /** Takes the scan into the reference's frame, as for 'deviate'. */
      transform: Rigid
      /** Within this of the scan's surface a disagreement is noise, mm. */
      tolerance: number
      /** The cell's side, mm; by default the tool's. */
      cell?: number
      /** Only this box of the reference's frame is looked at. */
      within?: { min: Vec3; max: Vec3 }
      mesh?: { positions: Float32Array; indices: Uint32Array }
    }
  /** Wall thickness of the scan itself — no reference model involved. The
   *  settings that shape the search travel with the request: all of them
   *  change the measurement, so all of them mean measuring again. */
  | {
      type: 'thickness'
      requestId: number
      method: ThicknessMethod
      coneRays: number
      coneAngleDeg: number
      /** Null accepts whatever a ray hits first, facing or not. */
      normalDeviationDeg: number | null
      maxThickness: number
    }
  /** Bake a datum alignment into the scan's vertices, so later fits measure
   *  in the new frame. */
  | { type: 'transform'; requestId: number; transform: Rigid }
  /** Cut the scan with a plane — see core/section/slice. Chains shorter than
   *  `minLength` millimetres are dropped as specks. */
  | { type: 'section'; requestId: number; origin: Vec3; normal: Vec3; minLength: number }
  /** The scan's shadow on a plane — see core/section/shadow. Answered as a
   *  section is, with the contour's pieces beside the polylines. */
  | { type: 'shadow'; requestId: number; frame: SectionFrame; tolerance: number; play: number; smoothDeg: number }
  /** The centroid of the volume the scan encloses, on the scan as it now
   *  stands — see geometry/centroid. With `vertices`, a surface marked by
   *  hand, the centroid of that surface instead. */
  | { type: 'centroid'; requestId: number; vertices?: Uint32Array }
  /** The mirror plane the scan matches itself across, refined from a seed
   *  plane or, without one, from the scan's principal planes — see
   *  core/symmetry. With `vertices`, only the marked surface is sampled and
   *  only it is surface the mirror images may land on. */
  | { type: 'symmetry'; requestId: number; seed: SeedPlane | null; vertices?: Uint32Array }
  /** The vertices a flood from `seed` reaches over edges whose normals turn
   *  by less than `maxAngleDeg` — a region for a surface fit, see
   *  fit/regionGrow floodByNormal. Capped at `limit` vertices. */
  | { type: 'flood'; requestId: number; seed: number; maxAngleDeg: number; limit?: number }
  /** What a grown region holds — its area and box, and given the plane's
   *  normal its normals' spread and whether it is two surfaces; given a
   *  cylinder, whether it is two cylinders. See fit/segment
   *  planeRegionReport. */
  | { type: 'plane-region'; requestId: number; vertices: Uint32Array; normal?: Vec3; seed?: number; cylinder?: { center: Vec3; axis: Vec3; radius: number } }
  /** The scan's flat regions, the largest first — see fit/segment. */
  | { type: 'segment'; requestId: number; options: SegmentOptions }
  /** The scan's mean curvature at every vertex, 1/mm, convex positive, for
   *  colouring the scan by it. See geometry/curvature. */
  | { type: 'curvature'; requestId: number }
  /** A place on the scan named without a click — a vertex by its number,
   *  or the vertex nearest a point — with a triangle it is a corner of, the
   *  seed a click there would give. See geometry/nearest. */
  | { type: 'nearest'; requestId: number; vertex?: number; point?: Vec3 }
  /** The box around the scan's own vertices, in the frame they are measured
   *  in now — every datum alignment baked in. */
  | { type: 'bounds'; requestId: number }
  /** The scan's vertices inside a box, facing `normal` within its angle if
   *  one is given, at most `limit` of them — see geometry/query. */
  | { type: 'query'; requestId: number; min: Vec3; max: Vec3; normal?: { dir: Vec3; cosLimit: number }; limit: number }
  /** The first scan surface along a world axis over a grid of rays — see
   *  geometry/scanQa (firstHits); with `corners`, the triangle each ray met
   *  and the hit's weights on its corners too (firstHitsAt). */
  | { type: 'heights'; requestId: number; grid: RayGrid; corners?: boolean }
  /** Open rims and surface noise — see geometry/scanQa; with `sheet`,
   *  whether it is a sheet, over so many points — see geometry/sheet. */
  | { type: 'scan-qa'; requestId: number; sample: number; rims: number; sheet?: { sample: number; apartSample: number } }
  /** One open rim by its number among the scan's rims, longest first —
   *  see geometry/scanQa (scanRim). */
  | { type: 'scan-rim'; requestId: number; index: number }
  /** The coordinate system the scan itself suggests — its face directions,
   *  the side it stood on, a zero point. See core/autoAlign. Nothing moves:
   *  the answer is a proposal for the alignment editor. */
  | { type: 'auto-align'; requestId: number }
  /** Which of the scan's or the reference's vertices lie in closed shells
   *  — see geometry/closedShells closedVertices — found here, off the main
   *  thread, for the section view's caps (viewer/sliceCap primeClosedPart).
   *  Answered a vertex at a time, over the render thread's layout of the
   *  part — its vertices, then the copies its sharp edges were split into —
   *  and not a triangle at a time: the render thread's bounds tree puts its
   *  triangles in an order of its own, and so does the reference's here,
   *  but neither moves a vertex. */
  | { type: 'closed-shells'; requestId: number; which: 'scan' | 'nominal' }
  /** A map played as motion: how far each scan vertex moves — see
   *  deviation/deflection.ts deflectionVectors — smoothed over the scan's
   *  vertices as held here, which are the render thread's own bit for bit
   *  (loaded from here, moved by the same datum transforms in the same
   *  order). `positions` is sent only where that may not hold — a worker
   *  restarted and the scan read back in under its alignment in one step —
   *  and is the render thread's copy, smoothed over instead. */
  | {
      type: 'deflection'
      requestId: number
      values: Float32Array
      directions: Int8Array
      limit: number
      maxDistance: number
      smoothing: number
      positions?: Float32Array
    }
  /** The map against a fitted element — see deviation/elementField.ts
   *  computeElementDeviation — measured here, off the main thread, over the
   *  scan's vertices as held here: the render thread's own bit for bit, as
   *  for `deflection`. `normals` are the render thread's and always sent:
   *  its sharp edges were split for shading and the ones held here are the
   *  average of the faces that meet, so a facing limit read off them would
   *  be a different map. `positions` is sent only where the vertices may
   *  not match, as for `deflection`. `subset` is the hand-marked region the
   *  map is restricted to, when it is; `maxDistance` is the search distance
   *  the suggested colour scale is read within. */
  | {
      type: 'element-deviation'
      requestId: number
      target: ElementTarget
      side: MaterialSide
      maxNormalDeviation: number | null
      subset: Uint32Array | null
      maxDistance: number
      normals: Float32Array
      positions?: Float32Array
    }
  /** A bounds tree over a mesh as the render thread lays it out — its
   *  positions and its index as drawn, shading copies and all — built here
   *  so that a million triangles are not sorted on the thread that answers
   *  the user (see viewer/bvh.ts treeOffThread). The arrays are the render
   *  thread's own, copied and sent over: the tree describes them whatever
   *  this worker holds of the scan, or whether it holds it at all. */
  | { type: 'bounds-tree'; requestId: number; positions: Float32Array; indices: Uint32Array }
  /** A request for a plugin's part of the worker — see workerPluginApi.ts.
   *  `op` names the plugin's operation, `payload` is its own. */
  | { type: 'plugin'; requestId: number; plugin: string; op: string; payload: unknown }

export type WorkerResponse =
  | { type: 'import-ok'; requestId: number }
  /** What a request is doing, and — from one that can tell — how far it
   *  has got, 0 to 1. */
  | { type: 'progress'; text: string; fraction?: number }
  | {
      type: 'loaded'
      requestId: number
      positions: Float32Array
      indices: Uint32Array
      normals: Float32Array
      /** One byte per vertex, for the viewport's mesh mode — see
       *  geometry/wireSlots.ts. */
      wireSlots: Uint8Array
      /** The vertex each appended copy stands in for, where the sharp edges
       *  were split for shading — see geometry/crease.ts. The arrays hold
       *  `vertexCount` vertices and then these copies; empty when unsplit. */
      copyOf: Uint32Array
      crease: CreaseReport
      /** The scan's own vertices — what every region and marking indexes. */
      vertexCount: number
      triangleCount: number
      /** The part's own colour per vertex (of `vertexCount`), sRGB bytes —
       *  a textured OBJ's, read off its image. */
      colors?: Uint8Array
      /** What became of the texture the file names, when it names one. */
      texture?: TextureNote
      /** How a STEP file opened as the scan was converted. */
      step?: StepInfo
    }
  | { type: 'fit-ok'; requestId: number; result: FitOutput }
  | {
      type: 'nominal-loaded'
      requestId: number
      positions: Float32Array
      indices: Uint32Array
      normals: Float32Array
      wireSlots: Uint8Array
      vertexCount: number
      triangleCount: number
      bboxDiagonal: number
      /** Present only when the reference was tessellated from a STEP file:
       *  how finely, and whether the conversion can be trusted. */
      step?: StepInfo
    }
  | {
      /** A pose from part-way through the refinement, so the viewport can show
       *  the fit converging instead of a spinner. */
      type: 'align-progress'
      requestId: number
      transform: Rigid
      iteration: number
      meanDistance: number
    }
  | { type: 'align-ok'; requestId: number; result: AlignResult }
  /** The fit was stopped part-way by the user. Not an error: nothing went
   *  wrong, there is simply no answer, and whatever alignment was in hand
   *  before it started is still the one to use. */
  | { type: 'align-stopped'; requestId: number }
  | {
      type: 'deviation-ok'
      requestId: number
      values: Float32Array
      /** The direction each reading was taken along, three bytes per vertex —
       *  see deviation/deflection.ts. */
      directions: Int8Array
      /** Colour range the tool would choose for this map, in mm. */
      suggestedRange: number
      /** Search distance the tool would choose for this part, in mm. */
      suggestedMaxDistance: number
    }
  | {
      type: 'volume-deviation-ok'
      requestId: number
      /** With its regions' surfaces for drawing. */
      volume: VolumeDeviation
    }
  | {
      type: 'reference-deviation-ok'
      requestId: number
      positions: Float32Array
      normals: Float32Array
      indices: Uint32Array
      parent: Uint32Array
      spacing: number
      /** The spacing asked for, before a large reference opened it. */
      wanted: number
      /** Signed mm per vertex, positive where the reference stands outside
       *  the scan; NaN where no scan is behind it. */
      values: Float32Array
    }
  | {
      type: 'thickness-ok'
      requestId: number
      values: Float32Array
      /** Ends of the colour scale the tool would choose for this part, in mm. */
      suggestedLow: number
      suggestedHigh: number
    }
  | { type: 'transform-ok'; requestId: number }
  /** The polylines a plane cuts off the scan, in scan coordinates. */
  | { type: 'section-ok'; requestId: number; points: Float32Array; offsets: Uint32Array; normals?: Float32Array; shadow?: ShadowShape }
  | { type: 'centroid-ok'; requestId: number; result: MeshCentroid }
  | { type: 'symmetry-ok'; requestId: number; result: SymmetryPlane }
  | { type: 'flood-ok'; requestId: number; vertices: Uint32Array }
  | { type: 'plane-region-ok'; requestId: number; result: PlaneRegionReport }
  | { type: 'segment-ok'; requestId: number; result: Segmentation }
  | { type: 'curvature-ok'; requestId: number; values: Float32Array }
  | { type: 'auto-align-ok'; requestId: number; result: AutoAlignResult }
  | { type: 'nearest-ok'; requestId: number; result: ScanSpot }
  | { type: 'bounds-ok'; requestId: number; min: Vec3; max: Vec3 }
  /** The vertices kept, with their positions and normals gathered, how many
   *  matched before the limit, and the stride the limit thinned them by. */
  | { type: 'query-ok'; requestId: number; vertices: Uint32Array; positions: Float32Array; normals: Float32Array; matched: number; step: number }
  /** Per ray, the coordinate of its first hit along the axis, NaN for none;
   *  asked for, the corners and weights of where it landed. */
  | { type: 'heights-ok'; requestId: number; values: Float32Array; corners?: Uint32Array; weights?: Float32Array }
  | { type: 'scan-qa-ok'; requestId: number; rims: { count: number; total: number; largest: ScanRim[]; circles: ScanRim[]; moreCircles: number }; noise: { median: number; p90: number; sampled: number }; tessellation: Tessellation; sheet?: SheetReading }
  /** The rim's loop in order, null past the last rim. */
  | { type: 'scan-rim-ok'; requestId: number; rim: { vertices: Uint32Array; positions: Float32Array; corners: Uint32Array; closed: boolean; length: number; circle?: RimCircle } | null }
  /** 1 for each render vertex of a closed shell. */
  | { type: 'closed-shells-ok'; requestId: number; closed: Uint8Array }
  /** Three floats per scan vertex, the offset to draw it moved by. */
  | { type: 'deflection-ok'; requestId: number; vectors: Float32Array }
  /** The map against an element, the direction each reading was taken
   *  along, and the colour scale the tool would choose for it, in mm. */
  | { type: 'element-deviation-ok'; requestId: number; values: Float32Array; directions: Int8Array; suggestedRange: number }
  /** The tree, serialized — see SerializedTree. */
  | { type: 'bounds-tree-ok'; requestId: number; tree: SerializedTree }
  /** A plugin's answer. */
  | { type: 'plugin-ok'; requestId: number; result: unknown }
  | { type: 'error'; requestId: number; message: string }

/** A bounds tree as it crosses between threads: its nodes, and the order it
 *  keeps the triangles in. Indirect — the tree sorts that list of triangle
 *  numbers and never the index it was built over — so it is laid back over
 *  the render thread's geometry as it stands, and the index already drawn
 *  and read by triangle keeps every triangle where it was. See three-mesh-bvh
 *  MeshBVH.serialize; the index it would carry is left out, being the render
 *  thread's own. */
export interface SerializedTree {
  roots: ArrayBuffer[]
  indirectBuffer: Uint32Array | Uint16Array
}
