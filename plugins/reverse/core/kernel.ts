// SPDX-License-Identifier: AGPL-3.0-only
// The CAD kernel behind the Reverse engineer workspace — Open CASCADE
// Technology, compiled to WebAssembly by the occt-wasm package — behind an
// adapter that names only the dozen operations the workspace uses: a face
// from a profile, extrude, revolve, the three booleans, a half-space to cut
// with, tessellation, STEP in and out, and the checks that say whether what
// came out is a closed solid. Everything else in that package's four hundred
// methods is not spoken for, so a breaking major of the wrapper — they come
// every few weeks — or a switch of kernel is contained in this file and the
// kernel*.ts modules beside it, which hold the longer operations as
// functions of the kernel.
//
// The package is imported dynamically: the 5 MB kernel is fetched only when
// the workspace is entered, and only this module knows the package's name.
// Shapes are handles into the kernel's arena and have to be released; the
// build (see build.ts) owns that bookkeeping.
//
// OCCT is LGPL-2.1 with the Open CASCADE exception; the wrapper is MIT /
// Apache-2.0. Both are loaded as separate, replaceable files — the JS glue
// and the wasm binary — and the product says so in its imprint.

import { computeVertexNormals } from '../../../src/core/geometry/normals'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, len, normalize, scale, sub } from '../../../src/core/vec'
import { canonicalDir } from './topo'
import { patternPitch } from './features'
import type { ThreadCut } from './thread'
import { type FaceHistory, type KernelBounds, type KernelMesh, type LoopPiece, type Profile, type RawEdge, type RawFace, type Shape, type StepLabel, type StepPart, type Tracked, type WasmSource } from './kernelTypes'
import { type OcctLike, type XcafReader, type XYZ } from './occtTypes'
import { circleThrough, edgeKindOf, faceKindOf, parseHistory, partName, stepColor, vec, xyz } from './kernelMath'
import { loopMiddle, rectangleLoop } from './loops'
import { draftFaces, moveFace, offsetFacesTracked } from './kernelFaces'
import { asSolid, booleanFuzz, bothFaceHashes, FUZZY_COARSE_MM, fuzzyBooleans, HASH_BOUND, isTrap, keepingSplits, KernelError, readFace, run, tracked, tracedHistory, withSubShapes } from './kernelOps'
import { fullWidth } from './kernelRounds'
import { collapsesInward, type FaceOffsetLimit, faceOffsetLimits, mostSpecific, offsetFault, onCopy, rawRefusal, shellByOffsetCut, shellPlain, shellSharpInside } from './kernelShell'
import { meshEveryFace, meshVolume } from './kernelMesh'
import { filesOpenEdges, hasLeftHandedTorus, mendTorusLoops, type SmallConic, smallConics, snapCurveEnds, straightConics } from './kernelStep'
import { narrowFaces, nearestEdges, nearestFaces, type OddEdge, oddEdges, type OddKind, type Poles, type ShortEdge, shortEdges, shellSpots, strayEdges } from './kernelEdges'
import { type CutPiece, cutPieces, type PointReading, probePoints, probeRay, type RayHit } from './kernelProbe'
import { faceLoops, type LoopSummary, loopSummary } from './stepLoops'
import { threadTracked } from './kernelThread'
import { type Thickened, thickenSheet, type ThickenWay } from './kernelThicken'
import { type LoftFold, loftFold, type LoftFoldOptions } from './loftFold'
export { arcPiece, loopMiddle, piecePoints, rectangleLoop } from './loops'
export { composeHistory } from './kernelMath'
export { type FaceHistory, type KernelBounds, type KernelMesh, type LoopPiece, type Profile, type RawEdge, type RawFace, type Shape, type StepLabel, type StepPart, type Tracked, type WasmSource } from './kernelTypes'

/** The package's SweepMode.FixedUp: the section's binormal held to one
 *  direction. Held to a helix's axis, every section along the helix is the
 *  first one turned about the axis and carried up it — a screw. */
const SWEEP_FIXED_UP = 2
/** SweepMode.Fixed: the section carried along with the least turn it can
 *  take (a corrected Frenet frame) — what a sweep along a drawn path wants,
 *  a straight stretch included, where Frenet's own frame has no normal. */
const SWEEP_FIXED = 0

/** How far, as a cosine, a surface normal may lean from the facets about
 *  its node and still be taken: 60°, several times what any angular
 *  deflection in use leaves between the two. Past it the surface has no
 *  normal there worth the name — a cone's tip, a sphere's pole. */
const SURFACE_NORMAL_MIN_COS = 0.5

/**
 * The normals of a body's mesh, from its surfaces, turned outward.
 *
 * The kernel evaluates each face's surface at the face's nodes, which is
 * the true normal there — but it does not turn the normals of a face the
 * solid uses reversed, so after a boolean whole faces come out inward. The
 * windings are right everywhere, so each face's normals are turned to agree
 * with its facets, by an area-weighted vote over the face. A node whose
 * normal still leans far from its facets keeps their average.
 *
 * The facets' average alone is what the mesh used to be shaded by, and on
 * a round it ripples: a node takes its strips' normals in proportion to
 * their area, and the kernel lays its triangles along a round unevenly, so
 * the light along one row of nodes zigzags. On a fillet it was off by up
 * to three degrees, which a glossy finish shows as a sawtooth highlight.
 * The surface's normal is the same all along the row.
 */
function surfaceNormals(positions: Float32Array, kernelNormals: Float32Array, indices: Uint32Array, faceGroups?: Int32Array): Float32Array {
  const normals = computeVertexNormals(positions, indices)
  if (kernelNormals.length !== positions.length) return normals
  const n = kernelNormals
  // Runs of the index buffer, one a face — or the whole mesh as one.
  const runs = faceGroups ?? Int32Array.of(0, indices.length, 0)
  const taken = new Uint8Array(positions.length / 3)
  for (let r = 0; r + 2 < runs.length; r += 3) {
    const start = runs[r]
    const end = runs[r] + runs[r + 1]
    let vote = 0
    for (let t = start; t + 2 < end; t += 3) {
      const a = indices[t] * 3
      const b = indices[t + 1] * 3
      const c = indices[t + 2] * 3
      const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2]
      const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2]
      const fx = aby * acz - abz * acy
      const fy = abz * acx - abx * acz
      const fz = abx * acy - aby * acx
      vote += fx * (n[a] + n[b] + n[c]) + fy * (n[a + 1] + n[b + 1] + n[c + 1]) + fz * (n[a + 2] + n[b + 2] + n[c + 2])
    }
    const sign = vote < 0 ? -1 : 1
    for (let t = start; t < end; t++) {
      const v = indices[t]
      if (taken[v]) continue
      taken[v] = 1
      const i = v * 3
      const l = Math.hypot(n[i], n[i + 1], n[i + 2])
      if (!(l > 1e-6)) continue
      const x = (sign * n[i]) / l
      const y = (sign * n[i + 1]) / l
      const z = (sign * n[i + 2]) / l
      if (x * normals[i] + y * normals[i + 1] + z * normals[i + 2] < SURFACE_NORMAL_MIN_COS) continue
      normals[i] = x
      normals[i + 1] = y
      normals[i + 2] = z
    }
  }
  return normals
}

/** The kernel's object with every call watched for a trap inside its
 *  WebAssembly — `onTrap` hears the first, however the caller handles the
 *  error: a helper that tries again another way must not hide that the
 *  kernel is broken. */
function watchTraps(occt: OcctLike, onTrap: (message: string) => void): OcctLike {
  const wrapped = new WeakMap<object, unknown>()
  return new Proxy(occt, {
    get(target, name, receiver) {
      const v = Reflect.get(target, name, receiver) as unknown
      if (typeof v !== 'function') return v
      let w = wrapped.get(v)
      if (!w) {
        const f = v as (...a: unknown[]) => unknown
        w = (...args: unknown[]) => {
          try {
            return f.apply(target, args)
          } catch (e) {
            if (isTrap(e)) onTrap(e instanceof Error ? e.message : String(e))
            throw e
          }
        }
        wrapped.set(v, w)
      }
      return w
    },
  })
}

/** A face of the body written, by hash — with the feature that made it,
 *  where the builder knows it (Builder.verifyStep). */
export interface StepFace {
  hash: number
  origin?: number
}

/** An edge that does not join two faces as a closed solid's do (see
 *  kernelEdges.ts), as verifyStep finds it: where, how long, what is odd
 *  about it and how many faces meet at it; whether it was found in the
 *  file read back or in the body itself (an edge OCCT's reader drops,
 *  which a stricter one may keep); and the faces of the body at the edge
 *  of the body nearest it — where to look in the model. */
export interface StepEdge {
  at: Vec3
  length: number
  kind: Exclude<OddKind, 'knife'>
  faces: number
  in: 'file' | 'body'
  near: StepFace[]
}

/** A shell of a part read back beyond the one with the most faces, where
 *  the body has fewer shells: the middle of its box, how many faces it
 *  has, and the body's face nearest that middle. */
export interface StepShell {
  at: Vec3
  faces: number
  near: StepFace[]
}

/** How many odd edges a part's list names at most; the count counts all. */
export const STEP_EDGES_LISTED = 12

/** The curves a conic too small for a part can be (smallConics). */
const CONICS = new Set(['hyperbola', 'parabola', 'ellipse'])

/** Under this a part's free edge read back is a hair a curve's end left
 *  off its corner (exportStepMended), mm. */
const SHORT_FREE_MM = 0.01
/** How far a curve's end may lie off its corner and be moved onto it, mm
 *  (snapCurveEnds). */
const SNAP_MM = 0.01
/** How far the file mended may read back off the body, mm. */
const MEND_GAP_MM = 1e-3
/** How far an edge may lie off its face before the file's check speaks of
 *  it, mm, and before it fails the file. The flange's rounds lie 1.1e-3 mm
 *  off where they are well, its two that are not 0.25 and 0.57 mm; a clamp's
 *  four that build and read back whole 0.014, which is no reason to redo a
 *  corner. No stricter reader has been tried on either. */
const STRAY_EDGE_MM = 0.01
const STRAY_EDGE_FAILS_MM = 0.1

/** A part whose file exportStepMended mended: where it read back open,
 *  how many curve ends were moved onto their corners and the farthest
 *  moved, and how far the file now reads back off the body. */
export interface StepMend {
  name: string
  at: Vec3[]
  moved: number
  offMax: number
  gap: number
}

/** An edge of a part read back that does not join two faces as a closed
 *  solid's does (readBackEdges). */
export interface ReadBackEdge {
  at: Vec3
  length: number
  kind: Exclude<OddKind, 'knife'>
}

/** A part read back (readBackParts): its odd edges, and whether it is a
 *  closed solid and one the kernel's check passes — a face the reader lost
 *  whole leaves no odd edge, only a part that is no closed solid. */
export interface ReadBackPart {
  edges: ReadBackEdge[]
  closed: boolean
  valid: boolean
}

/** What verifyStep finds: see there. */
export interface StepCheck {
  ok: boolean
  parts: number
  bodies: {
    name?: string
    volume: [number, number]
    faces: [number, number]
    shells: [number[], number[]]
    closed: boolean
    valid: boolean
    /** The body is a sheet — a patch network's skin — and is read back as
     *  one: its faces, its gap, and its open edges its own. */
    sheet?: boolean
    gap: { max: number; rms: number; points: number }
    /** The odd edges, the first STEP_EDGES_LISTED, and how many in all. */
    freeEdges: StepEdge[]
    freeEdgeCount: number
    /** Shells beyond the body's own, where it reads back as more. */
    strayShells: StepShell[]
    /** Read back as no closed solid with no odd edge or stray shell to
     *  explain it: the point of the body farthest off what was read back,
     *  how far, and the body's face there — the face the reader lost. */
    farthest?: { at: Vec3; off: number; near: StepFace[] }
  }[]
  loops: LoopSummary
  problems: string[]
  /** What was found off but within what the kernel's own sums allow —
   *  a volume a hair off where the surfaces agree. */
  notes: string[]
}

/** Which face of a shape, by its place in the list, each vertex of its mesh
 *  is on: -1 for a vertex of no face's triangles. */
function vertexFaces(occt: OcctLike, shape: number, m: ReturnType<OcctLike['meshShape']>): Int32Array {
  const out = new Int32Array(m.positions.length / 3).fill(-1)
  const g = m.faceGroups
  if (!g) return out
  const handles = occt.getSubShapes(shape, 'face')
  const place = new Map<number, number>()
  handles.forEach((f, i) => place.set(occt.hashCode(f, HASH_BOUND), i))
  for (const f of handles) occt.release(f)
  for (let r = 0; r + 2 < g.length; r += 3) {
    const at = place.get(g[r + 2]) ?? -1
    for (let i = g[r]; i < g[r] + g[r + 1]; i++) out[m.indices[i]] = at
  }
  return out
}

/** Whether two volumes part by more than VOLUME_PARTS. */
const partsFrom = (a: number, b: number) => Math.abs(a - b) > VOLUME_PARTS * Math.abs(b)

/** Where the kernel's volume of a freeform body and its mesh's part by more
 *  than this share the mesh is what stands. The kernel integrates B-spline
 *  faces numerically and can go wrong by much more than that, high or low:
 *  a fan's 94046 mm³ read 96096 with a round 0.05 mm larger, a prism of a
 *  closed spline 3 % low. A mesh falls short by about its chord: 0.19 % on a
 *  coil the kernel has right, so nearer than this the kernel's stands, which
 *  leaves the fan's own 94290 as it is, 0.26 % high. Two meshes and their
 *  trend came no closer on the fan, in twice the time. An elementary body's
 *  figure is exact, and never measured this way. */
const VOLUME_PARTS = 5e-3
/** The chord a mesh measuring a volume is drawn to, as a share of the
 *  shape's diagonal, and the angle, radians. */
const MEASURING_CHORD = 1 / 2000
const MEASURING_ANGLE = 0.1
/** A point of the file this near the same face of the body is not asked of
 *  the whole body, mm: well under what verifyStep fails on. */
const SAME_FACE_MM = 1e-4
/** How many faces' areas and centroids the kernel keeps (ReKernel.faces) —
 *  some bodies' worth; the oldest let go. */
const FACE_MEASURES_KEPT = 4096
/** How many shapes' volumes the kernel keeps before it starts over. */
const VOLUMES_KEPT = 4096

/** A body's volume read back against its own, as verifyStep judges it:
 *  OCCT integrates offset and B-spline faces numerically, so the two can
 *  part by a few parts in 10⁵ with the surfaces where they were — where they
 *  part by more the two meshes are what is handed in here. Off by
 *  more than 1e-3, or by more than 1e-5 where the surfaces moved too
 *  (`gapFails`), is a problem; more than 1e-5 alone a note; null within. */
export function volumeOff(label: string, volume: readonly [number, number], gapFails: boolean): { problem: boolean; text: string } | null {
  const d = volume[1] - volume[0]
  const scale = Math.abs(volume[0])
  if (Math.abs(d) <= Math.max(1e-6, 1e-5 * scale)) return null
  const share = scale > 0 ? Math.abs(d) / scale : Infinity
  // units-ok: build message, also the agent's answer.
  const off = `${label} reads back ${d.toPrecision(3)} mm³ off its volume`
  const said = `${(share * 100).toPrecision(2)} %`
  if (gapFails) return { problem: true, text: `${off} (${said}), the surfaces off too.` }
  if (Math.abs(d) > Math.max(1e-6, 1e-3 * scale)) return { problem: true, text: `${off} (${said}, over the 0.1 % the kernel's numeric integration accounts for).` }
  return { problem: false, text: `${off} (${said}) — within the kernel's numeric integration; the surfaces read back in place.` }
}

/** A point as a problem line names it: millimetres to three places. */
const at3 = (p: Vec3) => p.map((v) => Math.round(v * 1000) / 1000 + 0).join(', ')

/** What is odd about an edge, in words, for a problem line. */
function oddEdgeText(e: StepEdge): string {
  const where = e.in === 'body' ? ' (in the body; this reader drops it, a stricter one may not)' : ''
  if (e.kind === 'free') return `an edge with one face, a hole in the skin${where}`
  if (e.kind === 'nonManifold') return `${e.faces} faces meet at one edge, the skin running into itself — a contact, not a join${where}`
  return `an edge inside its one face, where another face only touched it at a tangent${where}`
}

export class ReKernel {
  private readonly occt: OcctLike
  /** What the kernel said when it first trapped inside its WebAssembly, or
   *  null: once set it is broken, and is let go (reService.ts). */
  trapped: string | null = null
  /** Each face's area and centroid by its hash, the face held while kept so
   *  no other can come to have that hash (faces). A step leaves the faces it
   *  does not touch as they were, so each body after it is integrated only
   *  where it changed. */
  private readonly faceMeasures = new Map<number, { face: number; kind: string; uv: string; area: number; centroid: Vec3 }>()
  /** A shape's volume by its handle — a handle never names another shape,
   *  released or not. */
  private readonly volumes = new Map<Shape, number>()

  private constructor(
    occt: OcctLike,
    /** The OCCT version the package reports, for the imprint and the log. */
    readonly version: string,
  ) {
    this.occt = watchTraps(occt, (message) => {
      this.trapped ??= message
    })
  }

  /** Load the kernel. Costs a fetch of the binary and its compilation the
   *  first time; a second call in the same realm is cheap. */
  static async load(wasm?: WasmSource): Promise<ReKernel> {
    // The package's name appears here and nowhere else.
    const mod = (await import('occt-wasm')) as {
      OcctKernel: { init(options?: { wasm?: WasmSource }): Promise<unknown> }
    }
    const kernel = (await mod.OcctKernel.init(wasm === undefined ? undefined : { wasm })) as OcctLike
    return new ReKernel(kernel, 'OCCT 8.0.1 via occt-wasm 5.15.0')
  }

  private wire(loop: readonly LoopPiece[]): Shape {
    if (loop.length === 0) throw new KernelError('A profile loop has no edges.')
    const edges = loop.map((piece) => {
      switch (piece.kind) {
        case 'line':
          return this.occt.makeLineEdge(xyz(piece.a), xyz(piece.b))
        case 'arc':
          return this.occt.makeArcEdge(xyz(piece.a), xyz(piece.m), xyz(piece.b))
        case 'circle':
          return this.occt.makeCircleEdge(xyz(piece.center), xyz(piece.normal), piece.radius)
        case 'spline':
          return this.occt.makeBSplineEdge(
            piece.poles.flatMap((p) => [p[0], p[1], p[2]]),
            piece.poles.map(() => 1),
            piece.knots,
            piece.mults,
            3,
          )
      }
    })
    const wire = this.occt.makeWire(edges)
    for (const e of edges) this.occt.release(e)
    return wire as Shape
  }

  /** A planar face bounded by the profile's outer loop, with its holes cut. */
  face(profile: Profile): Shape {
    return run('Building the sketch face', () => {
      const outer = this.wire(profile.outer)
      let face = this.occt.makeFace(outer)
      this.occt.release(outer)
      if (profile.holes.length > 0) {
        const holes = profile.holes.map((h) => this.wire(h))
        const withHoles = this.occt.addHolesInFace(face, holes)
        this.occt.release(face)
        for (const h of holes) this.occt.release(h)
        face = withHoles
      }
      return face as Shape
    })
  }

  /** The face swept along unit `dir` from `from` to `to` millimetres off its
   *  own plane — a prism between two offsets, either of them negative. With
   *  a draft, the face is put at `from` as it is and the sides lean in by
   *  `draftDeg` degrees as the prism goes on to `to`, whichever way along
   *  `dir` that is (a positive draft narrows a boss towards its top, as a
   *  mould's draft does; negative widens it). */
  extrude(face: Shape, dir: Vec3, from: number, to: number, draftDeg = 0): Shape {
    return run('Extruding', () => {
      const d = normalize(dir)
      if (!d) throw new KernelError('the extrusion has no direction.')
      if (!(Math.abs(to - from) > 1e-9)) throw new KernelError('the extrusion has no length.')
      // Straight, the prism is the same either way round; drafted, it leans
      // from where the face is put. The kernel's positive draft narrows the
      // prism as it goes, against its sweep or with it.
      const drafted = Math.abs(draftDeg) > 1e-9
      const lo = drafted ? from : Math.min(from, to)
      const hi = drafted ? to : Math.max(from, to)
      const start = scale(d, lo)
      const moved = this.occt.translate(face, start[0], start[1], start[2])
      const sweep = scale(d, hi - lo)
      const solid = drafted ? this.occt.draftPrism(moved, sweep[0], sweep[1], sweep[2], draftDeg) : this.occt.extrude(moved, sweep[0], sweep[1], sweep[2])
      this.occt.release(moved)
      return asSolid(this.occt, solid)
    })
  }

  /** The face turned about the axis through `origin` along `dir` by
   *  `angleRad` — a full turn for a whole body of revolution. */
  revolve(face: Shape, origin: Vec3, dir: Vec3, angleRad: number): Shape {
    return run('Revolving', () => {
      const d = normalize(dir)
      if (!d) throw new KernelError('the axis has no direction.')
      if (!(Math.abs(angleRad) > 1e-6)) throw new KernelError('the revolve has no angle.')
      const solid = this.occt.revolve(face, { point: xyz(origin), direction: xyz(d) }, angleRad)
      return asSolid(this.occt, solid)
    })
  }

  /**
   * The profile turned about the axis through `origin` along `dir` by
   * `angleRad` while it climbs `pitch` millimetres along the axis every full
   * turn — a coil, a thread: a screw, of as many turns as the angle holds. A
   * positive pitch climbs along `dir`, a negative one against it; a
   * right-handed screw turns counter-clockwise seen down the way it climbs,
   * as a revolve turns about `dir`, a left-handed one clockwise.
   *
   * The kernel sweeps a wire along a helix with the section's binormal held
   * to the axis, so each section is the first one screwed along. It takes
   * the section to sit where the helix crosses the section's plane nearest
   * the section's middle — so the helix starts there: at the middle of the
   * outer loop, at its distance from the axis. A sweep takes a wire, not a
   * face: a hole is swept the same way and cut out. `turnByTurn` sweeps along
   * a helix of one edge a turn (see helixByTurns) — a face a turn for each
   * side of the section, which booleans on many turns need.
   */
  screw(profile: Profile, origin: Vec3, dir: Vec3, angleRad: number, pitch: number, leftHanded: boolean, turnByTurn = false): Shape {
    return run('Sweeping the coil', () => {
      const d = normalize(dir)
      if (!d) throw new KernelError('the axis has no direction.')
      if (!(angleRad > 1e-6)) throw new KernelError('the coil has no angle.')
      if (!(Math.abs(pitch) > 1e-9)) throw new KernelError('the coil has no pitch.')
      const middle = loopMiddle(profile.outer)
      const foot = addScaled(origin, d, dot(sub(middle, origin), d))
      const radius = len(sub(middle, foot))
      if (!(radius > 1e-6)) throw new KernelError('the middle of the profile lies on the axis.')
      // The helix is made about +Z through the origin, starting on +X, and
      // carried onto the axis: +X out to the profile's middle, +Z the way it
      // climbs. The frame is right-handed, so the hand is kept.
      const x = scale(sub(middle, foot), 1 / radius)
      const z = pitch > 0 ? d : scale(d, -1)
      const y = cross(z, x)
      const turns = angleRad / (2 * Math.PI)
      const made = turnByTurn ? this.helixByTurns(Math.abs(pitch), turns, radius, leftHanded) : this.occt.makeHelixWireHanded(xyz([0, 0, 0]), xyz([0, 0, 1]), Math.abs(pitch), turns * Math.abs(pitch), radius, leftHanded)
      const helix = this.occt.transform(made, [x[0], y[0], z[0], foot[0], x[1], y[1], z[1], foot[1], x[2], y[2], z[2], foot[2]])
      this.occt.release(made)
      const sweep = (loop: readonly LoopPiece[]): number => {
        const wire = this.wire(loop)
        try {
          return this.occt.sweepOriented(wire, helix, SWEEP_FIXED_UP, xyz(z))
        } finally {
          this.occt.release(wire)
        }
      }
      try {
        let solid = sweep(profile.outer)
        for (const hole of profile.holes) {
          const tool = sweep(hole)
          const cut = this.occt.cut(solid, tool)
          this.occt.release(solid)
          this.occt.release(tool)
          solid = cut
        }
        return asSolid(this.occt, solid)
      } finally {
        this.occt.release(helix)
      }
    })
  }

  /**
   * A helix about +Z through the origin, starting on +X, as a wire of one
   * edge a turn — the last edge the part of a turn left over. Swept along
   * it, each side of a section is a face a turn rather than one face all
   * the way. A boolean on a sweep in one face failed, or quietly did
   * nothing, past a dozen turns more often than not, and on a left-handed
   * one at any length for some sections — a thread's tooth among them;
   * a face a turn, every case tried came out.
   */
  private helixByTurns(pitch: number, turns: number, radius: number, leftHanded: boolean): number {
    const o = this.occt
    const whole = Math.floor(turns + 1e-9)
    const rest = turns - whole
    const edges: number[] = []
    const turn = (at: number, height: number): number[] => {
      const wire = o.makeHelixWireHanded(xyz([0, 0, at]), xyz([0, 0, 1]), pitch, height, radius, leftHanded)
      try {
        return o.getSubShapes(wire, 'edge')
      } finally {
        o.release(wire)
      }
    }
    try {
      if (whole > 0) {
        const one = turn(0, pitch)
        for (let i = 0; i < whole; i++) for (const e of one) edges.push(i === 0 ? o.copy(e) : o.translate(e, 0, 0, i * pitch))
        for (const e of one) o.release(e)
      }
      if (rest > 1e-9) edges.push(...turn(whole * pitch, rest * pitch))
      return o.makeWire(edges)
    } finally {
      for (const e of edges) o.release(e)
    }
  }

  /** A sketch's pieces as one wire — open or closed — swept along unit
   *  `dir` from `from` to `to`: a surface, a shell of faces, not a solid.
   *  The cutter a body is split with. */
  sheet(pieces: readonly LoopPiece[], dir: Vec3, from: number, to: number): Shape {
    return run('Making the sheet', () => {
      const d = normalize(dir)
      if (!d) throw new KernelError('the sheet has no direction.')
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      if (!(hi - lo > 1e-9)) throw new KernelError('the sheet has no height.')
      const wire = this.wire(pieces)
      const start = scale(d, lo)
      const moved = this.occt.translate(wire, start[0], start[1], start[2])
      const sweep = scale(d, hi - lo)
      const shell = this.occt.extrude(moved, sweep[0], sweep[1], sweep[2])
      this.occt.release(wire)
      this.occt.release(moved)
      return shell as Shape
    })
  }

  /** A face through a regular grid of points — `rows` × `cols`, row-major
   *  and flat. The kernel's bsplineSurface is OCCT's PointsToBSplineSurface,
   *  a C2 surface through the grid within a thousandth of a millimetre,
   *  not a surface *from* a control net — so a fitted surface is sampled
   *  on a grid and handed over (core/re/surfaceFit gridOf). */
  surfaceThrough(points: Float64Array, rows: number, cols: number): Shape {
    return run('Making the surface', () => {
      if (rows < 2 || cols < 2 || points.length !== rows * cols * 3) throw new KernelError('the surface grid is malformed.')
      const grid: XYZ[] = []
      for (let i = 0; i < rows * cols; i++) grid.push(xyz([points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]))
      const face = this.occt.bsplineSurface(grid, rows, cols)
      if (this.occt.isNull(face)) throw new KernelError('the surface could not be made through the grid.')
      return face as Shape
    })
  }

  /** A profile swept along a path of pieces end to end: the outer loop and
   *  each hole swept as wires, the section held square to the path and
   *  turned as little as it can, the holes cut out — as a coil's are. */
  sweep(profile: Profile, path: readonly LoopPiece[]): Shape {
    return run('Sweeping', () => {
      const spine = this.wire(path)
      const along = (loop: readonly LoopPiece[]): number => {
        const wire = this.wire(loop)
        try {
          return this.occt.sweepOriented(wire, spine, SWEEP_FIXED)
        } finally {
          this.occt.release(wire)
        }
      }
      try {
        let solid = along(profile.outer)
        for (const hole of profile.holes) {
          const tool = along(hole)
          const cut = this.occt.cut(solid, tool)
          this.occt.release(solid)
          this.occt.release(tool)
          solid = cut
        }
        return asSolid(this.occt, solid)
      } finally {
        this.occt.release(spine)
      }
    })
  }

  /** A solid through the outer loops of the profiles, in order — ruled
   *  (straight between them) or smooth. */
  loft(profiles: readonly Profile[], ruled: boolean): Shape {
    return run('Lofting', () => {
      if (profiles.length < 2) throw new KernelError('a loft needs two or more profiles.')
      const wires = profiles.map((p) => this.wire(p.outer))
      try {
        return asSolid(this.occt, this.occt.loft(wires, true, ruled))
      } finally {
        for (const w of wires) this.occt.release(w)
      }
    })
  }

  /** Where a smooth loft's skin crosses itself, cut across at one v at a
   *  time — of its own faces only and inside them when it stands on a
   *  body a later step trimmed — or null (loftFold.ts). */
  loftFold(shape: Shape, options: LoftFoldOptions = {}): LoftFold | null {
    return run('Reading the loft', () => loftFold(this.occt, shape, options))
  }

  /** The shape and its copies, `count` in all, stepped along `dir` by
   *  `step` millimetres or turned about the axis through `origin` along
   *  `dir` through `step` degrees from the first copy to the last — 360
   *  is a full turn, `count` copies round with none on the first. OCCT
   *  spreads its angle as angle/count, so it is handed the pitch × count:
   *  90° in four is 0, 30, 60, 90. The kernel hands the copies back
   *  as a compound whether or not they touch; they are fused here so
   *  overlapping copies are one solid and separate ones a compound of
   *  solids, which is a body either way. A sheet's copies are faces with
   *  nothing to fuse: the compound of them is the patterned sheet — four
   *  cutters round a wheel, standing apart, one body to split with. */
  pattern(shape: Shape, mode: 'circular' | 'linear', origin: Vec3, dir: Vec3, count: number, step: number): Shape {
    return run('Patterning', () => {
      const d = normalize(dir)
      if (!d) throw new KernelError('the pattern has no direction.')
      if (!(count >= 2)) throw new KernelError('a pattern needs a count of two or more.')
      const compound = mode === 'linear' ? this.occt.linearPattern(shape, xyz(d), step, count) : this.occt.circularPattern(shape, xyz(origin), xyz(d), (patternPitch(step, count) * count * Math.PI) / 180, count)
      const copies = this.occt.getSubShapes(compound, 'solid')
      if (copies.length === 0 && this.occt.subShapeCount(compound, 'face') > 0) return compound as Shape
      this.occt.release(compound)
      if (copies.length === 0) throw new KernelError('the pattern made nothing.')
      try {
        return this.fuseSolids(copies)
      } finally {
        for (const c of copies) this.occt.release(c)
      }
    })
  }

  /** Solids fused into one shape, as asSolid hands it back. In one
   *  operation, which finds where each meets the others once: fused one
   *  after another, every step went over the whole of what was fused
   *  before, and the 48 teeth of a knurl took six times as long. Fused
   *  one after another after all where the one operation fails or leaves
   *  an invalid shape. The solids stay the caller's. */
  private fuseSolids(solids: readonly number[]): Shape {
    const o = this.occt
    if (solids.length === 1) return o.copy(solids[0]) as Shape
    let all: number | null = null
    try {
      all = o.fuseAll([...solids])
    } catch {
      // Fused one after another below.
    }
    if (all !== null && (solids.length === 2 || o.isValid(all))) return asSolid(o, all)
    if (all !== null) o.release(all)
    let acc = o.fuse(solids[0], solids[1])
    for (let i = 2; i < solids.length; i++) {
      const next = o.fuse(acc, solids[i])
      o.release(acc)
      acc = next
    }
    return asSolid(o, acc)
  }

  /** The body cut into fragments by the tools — sheets or solids — as
   *  separate solids. */
  split(shape: Shape, tools: readonly Shape[]): Shape[] {
    return run('Splitting', () => {
      const compound = this.occt.split(shape, [...tools])
      const solids = this.occt.getSubShapes(compound, 'solid') as Shape[]
      this.occt.release(compound)
      return solids
    })
  }

  /** How far a point lies from a shape — from the nearest of its faces,
   *  for a sheet; zero inside a solid. */
  distanceToPoint(shape: Shape, point: Vec3): number {
    return run('Measuring the distance', () => {
      const v = this.occt.makeVertex(point[0], point[1], point[2])
      try {
        return this.occt.distanceBetween(v, shape)
      } finally {
        this.occt.release(v)
      }
    })
  }

  /** What became of the faces of `before` (one shape or several) in
   *  `after`, for an operation the kernel tracks no history for that keeps
   *  its faces on their surfaces — a split, a sheet trimmed or sewn: each
   *  new face traced by a point inside it (kernelOps tracedHistory). */
  tracedHistory(before: Shape | readonly Shape[], after: Shape): FaceHistory {
    return run('Tracing the faces', () => tracedHistory(this.occt, Array.isArray(before) ? before : [before as Shape], after))
  }

  /** How far apart two shapes come at their nearest — zero where they
   *  touch or cross; for a solid, zero inside it. */
  distanceBetween(a: Shape, b: Shape): number {
    return run('Measuring the distance', () => this.occt.distanceBetween(a, b))
  }

  /** Where two shapes' surfaces cross — two sheets, a sheet and a body —
   *  as the polylines of the kernel's section of the one by the other,
   *  sampled to `deflection`. Empty where they do not cross; two sheets
   *  that only touch may come back empty too. */
  crossing(a: Shape, b: Shape, deflection: number): Float32Array[] {
    return run('Crossing the shapes', () => {
      const o = this.occt
      const cut = o.section(a, b)
      try {
        if (o.isNull(cut)) return []
        const wire = o.wireframe(cut, deflection)
        const out: Float32Array[] = []
        const g = wire.edgeGroups
        for (let i = 0; i + 2 < g.length; i += 3) out.push(wire.points.slice(g[i], g[i] + g[i + 1]))
        return out
      } finally {
        o.release(cut)
      }
    })
  }

  /** A sheet's unit normals at points on it: the surface's own normal,
   *  which way the face looks, at the point of the face each point lies
   *  nearest — of a sheet of several faces, the face it lies nearest. What
   *  tells the two sides of a sheet apart. */
  sheetNormals(sheet: Shape, points: readonly Vec3[]): Vec3[] {
    return run('Reading the sheet', () => {
      const o = this.occt
      const faces = o.getSubShapes(sheet, 'face')
      try {
        if (faces.length === 0) throw new KernelError('the sheet has no faces.')
        return points.map((p) => {
          let face = faces[0]
          if (faces.length > 1) {
            const v = o.makeVertex(p[0], p[1], p[2])
            try {
              let best = Infinity
              for (const f of faces) {
                const d = o.distanceBetween(v, f)
                if (d < best) {
                  best = d
                  face = f
                }
              }
            } finally {
              o.release(v)
            }
          }
          const { u, v } = o.uvFromPoint(face, xyz(p))
          return normalize(vec(o.surfaceNormal(face, u, v))) ?? ([0, 0, 1] as Vec3)
        })
      } finally {
        for (const f of faces) o.release(f)
      }
    })
  }

  /** Every face the tools cut the shape into — each once, though the
   *  fragments share them — for the trim to test against the scan. The
   *  faces are the compound's, kept alive by their handles after the
   *  compound is released. */
  splitFaces(shape: Shape, tools: readonly Shape[]): Shape[] {
    return run('Splitting', () => {
      const compound = this.occt.split(shape, [...tools])
      const faces = this.occt.getSubShapes(compound, 'face') as Shape[]
      this.occt.release(compound)
      const seen = new Set<number>()
      const unique: Shape[] = []
      for (const f of faces) {
        const h = this.occt.hashCode(f, HASH_BOUND)
        if (seen.has(h)) this.occt.release(f)
        else {
          seen.add(h)
          unique.push(f)
        }
      }
      return unique
    })
  }

  /** The faces sewn into a shell, and the shell made a solid where it
   *  closes; a shell (or a compound of shells) otherwise. Healed to the
   *  tolerance when it came out a solid, and its faces on one surface made
   *  one face: what cut them apart were the cells of the other tools, not
   *  anything of the part's — a boss's wall kept as the two halves either
   *  side of a plane that crossed it is not a cylinder going the whole way
   *  round to a Hole or a Snap face. */
  sewFaces(faces: readonly Shape[], tolerance: number): Shape {
    return run('Sewing the faces', () => {
      if (faces.length === 0) throw new KernelError('no faces to sew.')
      const sewn = this.occt.sewAndSolidify([...faces], tolerance) as Shape
      if (this.occt.getShapeType(sewn) !== 'solid') return sewn
      let solid = sewn
      try {
        const healed = this.occt.healSolid(sewn, tolerance) as Shape
        this.occt.release(sewn)
        solid = healed
      } catch {
        // The sewn solid as it is.
      }
      try {
        const unified = this.occt.unifySameDomain(solid) as Shape
        if (!this.occt.isNull(unified) && this.occt.getShapeType(unified) === 'solid' && this.isClosedSolid(unified)) {
          this.occt.release(solid)
          return unified
        }
        this.occt.release(unified)
      } catch {
        // Not unified: the faces stay as they were cut.
      }
      return solid
    })
  }

  /** A sheet cut by the tools — sheets or solids — into its pieces: the
   *  faces the cut leaves, taken together where they meet across an edge
   *  that lies on no tool's faces (within `tolerance`), each piece a face, or its
   *  faces sewn into a shell. A face the cut did not reach stays as it
   *  was, its hash with it. The pieces are the caller's. */
  sheetPieces(sheet: Shape, tools: readonly Shape[], tolerance: number): Shape[] {
    return run('Splitting the sheet', () => {
      const o = this.occt
      const compound = o.split(sheet, [...tools])
      const faces = o.getSubShapes(compound, 'face')
      const edges = o.getSubShapes(compound, 'edge')
      const facesOf = parseHistory(o.edgeToFaceMap(compound, HASH_BOUND))
      const pieces: Shape[] = []
      const used = new Set<number>()
      // Each tool by its faces: a solid tool is a surface the cut runs
      // along, not a volume — the distance to a solid is nought all through
      // it, and every edge of the sheet's own inside it would read as cut.
      const surfaces = tools.map((t) => {
        const own = o.getSubShapes(t, 'face')
        try {
          return o.makeCompound(own)
        } finally {
          for (const f of own) o.release(f)
        }
      })
      try {
        const byHash = new Map<number, number>()
        for (const f of faces) {
          const h = o.hashCode(f, HASH_BOUND)
          if (!byHash.has(h)) byHash.set(h, f)
        }
        // The faces taken together, one piece a group, across every edge
        // two of them share that no tool cut along.
        const group = new Map([...byHash.keys()].map((h) => [h, h]))
        const root = (h: number): number => {
          let r = h
          while (group.get(r) !== r) r = group.get(r)!
          group.set(h, r)
          return r
        }
        for (const e of edges) {
          const sides = [...new Set(facesOf.get(o.hashCode(e, HASH_BOUND)) ?? [])].filter((h) => byHash.has(h))
          if (sides.length < 2) continue
          const { first, last } = o.curveParameters(e)
          const mid = o.curvePointAtParam(e, (first + last) / 2)
          const v = o.makeVertex(mid.x, mid.y, mid.z)
          let cut = false
          try {
            cut = surfaces.some((t) => o.distanceBetween(v, t) <= tolerance)
          } finally {
            o.release(v)
          }
          if (cut) continue
          for (const h of sides.slice(1)) group.set(root(h), root(sides[0]))
        }
        const groups = new Map<number, number[]>()
        for (const [h, f] of byHash) groups.set(root(h), [...(groups.get(root(h)) ?? []), f])
        for (const members of groups.values()) {
          if (members.length === 1) {
            pieces.push(members[0] as Shape)
            used.add(members[0])
          } else pieces.push(o.sew(members, tolerance) as Shape)
        }
        return pieces
      } catch (e) {
        for (const p of pieces) if (!used.has(p)) o.release(p)
        throw e
      } finally {
        for (const f of faces) if (!used.has(f)) o.release(f)
        for (const e of edges) o.release(e)
        for (const c of surfaces) o.release(c)
        o.release(compound)
      }
    })
  }

  /** Sheets — faces, shells — sewn into one sheet where they meet edge to
   *  edge within `tolerance`, each face kept the face it came as: a face
   *  alone as it is, several a shell; where they fall apart, a compound of
   *  the pieces, and `pieces` says how many. Never made a solid, even where
   *  the faces close. The sheets stay the caller's. */
  sewSheet(sheets: readonly Shape[], tolerance: number): { shape: Shape; pieces: number } {
    return run('Sewing the sheet', () => {
      const o = this.occt
      if (sheets.length === 0) throw new KernelError('no faces to sew.')
      const faceCount = sheets.reduce((n, s) => n + o.subShapeCount(s, 'face'), 0)
      if (sheets.length === 1 && faceCount === 1) {
        const faces = o.getSubShapes(sheets[0], 'face')
        return { shape: faces[0] as Shape, pieces: 1 }
      }
      const shape = o.sew([...sheets], tolerance) as Shape
      const type = o.getShapeType(shape)
      if (type === 'face' || type === 'shell') return { shape, pieces: 1 }
      // A compound: its shells and the faces in none, each a piece — one
      // piece taken out of it, so that what is handed on is never a
      // compound of one (a thickening of that comes back empty).
      const shells = o.getSubShapes(shape, 'shell')
      const inShells = shells.reduce((n, s) => n + o.subShapeCount(s, 'face'), 0)
      const free = o.subShapeCount(shape, 'face') - inShells
      const pieces = shells.length + free
      if (pieces === 1) {
        const one = shells.length === 1 ? shells[0] : o.getSubShapes(shape, 'face')[0]
        o.release(shape)
        return { shape: one as Shape, pieces }
      }
      for (const s of shells) o.release(s)
      return { shape, pieces }
    })
  }

  /** Faces that meet edge to edge sewn into one shell — a solid where
   *  `closed` asks for one and they close, healed to the tolerance — and
   *  never unified: each face stays the face it came as, a patch of a
   *  network traced back to its cell by it. The faces stay the caller's. */
  sewPatches(faces: readonly Shape[], tolerance: number, closed: boolean): Shape {
    return run('Sewing the patches', () => {
      if (faces.length === 0) throw new KernelError('no faces to sew.')
      if (!closed) return this.occt.sew([...faces], tolerance) as Shape
      const sewn = this.occt.sewAndSolidify([...faces], tolerance) as Shape
      if (this.occt.getShapeType(sewn) !== 'solid') return sewn
      try {
        const healed = this.occt.healSolid(sewn, tolerance) as Shape
        if (!this.occt.isNull(healed) && this.occt.getShapeType(healed) === 'solid') {
          this.occt.release(sewn)
          return healed
        }
        this.occt.release(healed)
      } catch {
        // The sewn solid as it is.
      }
      return sewn
    })
  }

  /** A box with these corners. */
  box(min: Vec3, max: Vec3): Shape {
    return run('Making the box', () => {
      const face = this.face({ outer: rectangleLoop([min[0], min[1], min[2]], [1, 0, 0], [0, 1, 0], max[0] - min[0], max[1] - min[1]), holes: [] })
      try {
        return this.extrude(face, [0, 0, 1], 0, max[2] - min[2])
      } finally {
        this.release(face)
      }
    })
  }

  /** The half of space on the side of the plane its normal points to, as a
   *  solid to cut with or keep — what an extrusion "up to a plane" is
   *  trimmed by. */
  halfSpace(origin: Vec3, normal: Vec3): Shape {
    return run('Building a half-space', () => {
      const n = normalize(normal)
      if (!n) throw new KernelError('the plane has no normal.')
      return this.occt.halfSpace(xyz(origin), xyz(n)) as Shape
    })
  }

  fuse(a: Shape, b: Shape): Shape {
    return run('Joining', () => asSolid(this.occt, this.occt.fuse(a, b)))
  }

  /** Shapes fused into one, in one operation — see fuseSolids. The
   *  shapes stay the caller's. */
  fuseAll(shapes: readonly Shape[]): Shape {
    return run('Joining', () => {
      if (shapes.length === 0) throw new KernelError('nothing to join.')
      return this.fuseSolids(shapes)
    })
  }

  /** `fn` with the faces its operations leave on one surface kept as
   *  they were cut — for a step played again after the kernel's unifying
   *  broke what it made whole (kernelOps keepingSplits). */
  keepingSplits<T>(fn: () => T): T {
    return keepingSplits(fn)
  }

  /** The fuzzy value of the last try (kernelOps FUZZY_COARSE_MM). */
  readonly coarseFuzz = FUZZY_COARSE_MM

  /** `fn` with the tracked booleans fuzzy — for a step played again after
   *  an exact boolean left its shell open (kernelOps fuzzyBooleans); `mm`
   *  left out, FUZZY_MM. */
  fuzzyBooleans<T>(fn: () => T, mm?: number): T {
    return fuzzyBooleans(fn, mm)
  }

  // ---- the operations that track their faces --------------------------------------
  // Each hands back the kernel's history of the faces it was given: which
  // old face became which new faces. The faces of both operands are
  // tracked, so a join knows the tool's faces as well as the target's.

  fuseTracked(a: Shape, b: Shape): Tracked {
    return run('Joining', () => tracked(this.occt, this.booleanWithHistory(0, a, b)))
  }

  cutTracked(a: Shape, b: Shape): Tracked {
    return run('Cutting', () => tracked(this.occt, this.booleanWithHistory(1, a, b)))
  }

  commonTracked(a: Shape, b: Shape): Tracked {
    return run('Intersecting', () => tracked(this.occt, this.booleanWithHistory(2, a, b)))
  }

  /** A fuse (0), cut (1) or common (2) with both operands' faces tracked:
   *  exact, or inside fuzzyBooleans fuzzy. */
  private booleanWithHistory(op: 0 | 1 | 2, a: Shape, b: Shape): { result: number; modified: number[] } {
    const o = this.occt
    const hashes = bothFaceHashes(this, a, b)
    const fuzz = booleanFuzz()
    if (fuzz > 0) return o.booleanOp(op, [a], [b], { fuzzyValue: fuzz, inputFaceHashes: hashes, hashUpperBound: HASH_BOUND })
    return op === 0 ? o.fuseWithHistory(a, b, hashes, HASH_BOUND) : op === 1 ? o.cutWithHistory(a, b, hashes, HASH_BOUND) : o.intersectWithHistory(a, b, hashes, HASH_BOUND)
  }

  /** A solid's edges (by hash) named on a copy of it. */
  private edgesOnCopy(solid: Shape, copy: Shape, edgeHashes: readonly number[]): number[] {
    const was = this.occt.subShapeHashes(solid, 'edge', HASH_BOUND)
    const now = this.occt.subShapeHashes(copy, 'edge', HASH_BOUND)
    if (was.length !== now.length) throw new KernelError('the body could not be copied.')
    const toCopy = new Map(was.map((h, i) => [h, now[i]]))
    return edgeHashes.map((h) => toCopy.get(h) ?? h)
  }

  /** A round or a chamfer made on a copy of `solid`, its edges named on
   *  the copy, the history handed back keyed by the solid's faces (onCopy).
   *  The kernel can leave the shape it rounds changed when it gives up
   *  part-way — its edges' tolerances — and the body's check after the
   *  failure would then blame the step before (build.ts inputFault); on a
   *  copy the body stays as it stood, as a shell's does. */
  private roundOnCopy(solid: Shape, edgeHashes: readonly number[], make: (copy: Shape, edgeHashes: number[]) => Tracked): Tracked {
    return onCopy(this.occt, this, solid, [], (copy) => make(copy, this.edgesOnCopy(solid, copy, edgeHashes)))
  }

  /** The same for a round or a chamfer the kernel tracks no history for. */
  private shapeOnCopy(solid: Shape, edgeHashes: readonly number[], make: (copy: Shape, edgeHashes: number[]) => Shape): Shape {
    const copy = this.occt.copy(solid) as Shape
    try {
      return make(copy, this.edgesOnCopy(solid, copy, edgeHashes))
    } finally {
      this.occt.release(copy)
    }
  }

  /** Round the given edges of a solid, named by hash — on a copy of it
   *  (roundOnCopy). */
  filletTracked(solid: Shape, edgeHashes: readonly number[], radius: number): Tracked {
    return run('Filleting', () => {
      if (!(radius > 0)) throw new KernelError('the radius must be positive.')
      return this.roundOnCopy(solid, edgeHashes, (copy, hashes) =>
        fullWidth(this.occt, this, copy, radius, (r) =>
          withSubShapes(this.occt, copy, 'edge', hashes, (edges) => tracked(this.occt, this.occt.filletWithHistory(copy, edges, r, this.faceHashes(copy), HASH_BOUND))),
        ),
      )
    })
  }

  /** Edges of a solid, named by hash, rounded in one call each at a radius
   *  of its own: a number, or `[r1, r2]` running evenly from r1 at the
   *  edge's first end (its curve's start, as `ends` gives it) to r2 at its
   *  other — on a copy of it (roundOnCopy). Edges of one tangent chain
   *  round as one: they must agree where they meet, and an edge of the
   *  chain not given runs between its neighbours' radii. */
  filletRadii(solid: Shape, edges: readonly { hash: number; radius: number | readonly [number, number] }[]): Tracked {
    return run('Filleting', () => {
      const sizes = edges.flatMap((e) => (typeof e.radius === 'number' ? [e.radius] : [...e.radius]))
      if (!sizes.every((r) => r > 0)) throw new KernelError('the radii must be positive.')
      const most = Math.max(...sizes)
      return this.roundOnCopy(solid, edges.map((e) => e.hash), (copy, hashes) =>
        fullWidth(this.occt, this, copy, most, (size) => {
          const k = size / most
          const radii = edges.map((e) => (typeof e.radius === 'number' ? e.radius * k : { start: e.radius[0] * k, end: e.radius[1] * k }))
          return withSubShapes(this.occt, copy, 'edge', hashes, (handles) => tracked(this.occt, this.occt.filletWithHistory(copy, handles, radii, this.faceHashes(copy), HASH_BOUND)))
        }),
      )
    })
  }

  /** One edge rounded at a radius running evenly from `r1` at its start —
   *  the end where the edge's curve begins, the first of `edges`' ends — to
   *  `r2` at its other end, on a copy of the solid. The kernel tracks no
   *  history for it: the caller traces the faces by where they lie. */
  filletVariable(solid: Shape, edgeHash: number, r1: number, r2: number): Shape {
    return run('Filleting', () => {
      if (!(r1 > 0 && r2 > 0)) throw new KernelError('the radii must be positive.')
      return this.shapeOnCopy(solid, [edgeHash], (copy, hashes) => withSubShapes(this.occt, copy, 'edge', hashes, ([edge]) => asSolid(this.occt, this.occt.filletVariable(copy, edge, r1, r2))))
    })
  }

  /** Chamfer the given edges of a solid, named by hash — on a copy of it
   *  (roundOnCopy). */
  chamferTracked(solid: Shape, edgeHashes: readonly number[], distance: number): Tracked {
    return run('Chamfering', () => {
      if (!(distance > 0)) throw new KernelError('the distance must be positive.')
      return this.roundOnCopy(solid, edgeHashes, (copy, hashes) =>
        fullWidth(this.occt, this, copy, distance, (d) =>
          withSubShapes(this.occt, copy, 'edge', hashes, (edges) => tracked(this.occt, this.occt.chamferWithHistory(copy, edges, d, this.faceHashes(copy), HASH_BOUND))),
        ),
      )
    })
  }

  /** The edges chamfered `distance` back on each edge's first face — the
   *  first of the solid's faces in the kernel's order (faceHashes) that the
   *  edge bounds; see edgeSides — the chamfer at `angleDeg` to that face.
   *  On a copy of the solid. The kernel tracks no history for it: the
   *  caller traces the faces by where they lie. */
  chamferAngled(solid: Shape, edgeHashes: readonly number[], distance: number, angleDeg: number): Shape {
    return run('Chamfering', () => {
      if (!(distance > 0)) throw new KernelError('the distance must be positive.')
      if (!(angleDeg > 0 && angleDeg < 90)) throw new KernelError('the angle must lie between 0° and 90°.')
      return this.shapeOnCopy(solid, edgeHashes, (copy, hashes) => withSubShapes(this.occt, copy, 'edge', hashes, (edges) => asSolid(this.occt, this.occt.chamferDistAngle(copy, edges, distance, angleDeg))))
    })
  }

  /** The two faces each edge (by hash) bounds — the one an angled chamfer
   *  measures from first, as the kernel orders the solid's faces — with
   *  their outward normals at the edge's middle; null for an edge with one
   *  face, or a seam with the same face on both sides. */
  edgeSides(solid: Shape, edgeHashes: readonly number[]): ({ faces: [number, number]; normals: [Vec3, Vec3] } | null)[] {
    return run('Reading the faces at the edges', () => {
      const o = this.occt
      const facesOf = parseHistory(o.edgeToFaceMap(solid, HASH_BOUND))
      const faceHandles = o.getSubShapes(solid, 'face')
      const edgeHandles = o.getSubShapes(solid, 'edge')
      try {
        const faceAt = new Map<number, { handle: number; order: number }>()
        faceHandles.forEach((h, order) => {
          const hash = o.hashCode(h, HASH_BOUND)
          if (!faceAt.has(hash)) faceAt.set(hash, { handle: h, order })
        })
        const edgeAt = new Map(edgeHandles.map((h) => [o.hashCode(h, HASH_BOUND), h]))
        return edgeHashes.map((hash) => {
          const edge = edgeAt.get(hash)
          const sides = [...new Set(facesOf.get(hash) ?? [])].map((f) => faceAt.get(f) && { hash: f, ...faceAt.get(f)! }).filter((f): f is { hash: number; handle: number; order: number } => Boolean(f))
          if (edge === undefined || sides.length !== 2) return null
          sides.sort((a, b) => a.order - b.order)
          const { first, last } = o.curveParameters(edge)
          const mid = o.curvePointAtParam(edge, (first + last) / 2)
          const normalAt = (face: number): Vec3 => {
            const { u, v } = o.uvFromPoint(face, mid)
            return normalize(vec(o.surfaceNormal(face, u, v))) ?? [0, 0, 1]
          }
          return { faces: [sides[0].hash, sides[1].hash], normals: [normalAt(sides[0].handle), normalAt(sides[1].handle)] }
        })
      } finally {
        for (const h of faceHandles) o.release(h)
        for (const h of edgeHandles) o.release(h)
      }
    })
  }

  /** The given faces (by hash) taken off a solid, the faces round them run
   *  on to close the gap: the kernel's defeaturing. No history: the caller
   *  finds the faces that ran on by their surfaces. */
  deleteFaces(solid: Shape, faceHashes: readonly number[]): Shape {
    return run('Deleting faces', () =>
      withSubShapes(this.occt, solid, 'face', faceHashes, (faces) => {
        const out = this.occt.defeature(solid, faces, 0)
        if (this.occt.isNull(out)) throw new KernelError('the faces round them cannot be run on to close the gap.')
        return asSolid(this.occt, out)
      }),
    )
  }

  /** Hollow a solid to a wall of `thickness`, the given faces (by hash)
   *  taken away to open it; none leaves a closed hollow body — the solid
   *  less its own inward offset, since the kernel's thick solid with no
   *  face to remove hands back the core alone. */
  shellTracked(solid: Shape, faceHashes: readonly number[], thickness: number): Tracked {
    return run('Shelling', () => {
      if (!(thickness > 0)) throw new KernelError('the thickness must be positive.')
      // Every attempt works on a copy of the body: the kernel's thick
      // solid, failing, leaves the solid it was given no longer valid, and
      // the attempts after it, the diagnosis and every later feature would
      // all fail on that.
      // Each way that fails says why; the failure answers the reason that
      // says most (mostSpecific), not the first way's — which is often the
      // thick solid's own words, "BRep_Tool:: no parameter on edge".
      const reasons: { why: string; raw: boolean }[] = []
      try {
        return onCopy(this.occt, this, solid, faceHashes, (copy, faces) => shellPlain(this.occt, this, copy, faces, thickness))
      } catch (plain) {
        if (isTrap(plain)) throw plain
        reasons.push({ why: plain instanceof Error ? plain.message : String(plain), raw: !(plain instanceof KernelError) })
      }
      // A round no larger than the wall has no inward offset — its inner
      // radius would be nothing or less — and the kernel's thick solid
      // gives up on the whole body over it. The wall is then made on the
      // body with those rounds taken off, and cut back to the body's own
      // outside: rounded outside as modelled, sharp inside where the
      // round ran out.
      // A shell built another way than the thick solid says so, and why
      // the thick solid gave up: the way is booleans, and it can change
      // with any edit upstream — and leave slivers where it did not.
      const gaveUp = ` The kernel's thick solid gave up on it: ${mostSpecific(reasons.slice(0, 1))}.`
      const sharp = onCopy(this.occt, this, solid, faceHashes, (copy, faces) => shellSharpInside(this.occt, this, copy, faces, thickness))
      if (sharp !== null && typeof sharp !== 'string') return { ...sharp, note: `${sharp.note ?? ''}${gaveUp}`.trim() }
      if (sharp !== null) reasons.push({ why: `with the rounds no larger than the wall left sharp inside, ${sharp}`, raw: false })
      // The thick solid also gives up on bodies it has no business
      // giving up on — a bar with a block on its end, two faces opened
      // on opposite sides of the step between them, every face of it
      // flat; a face opened beside a round it runs into tangent. The
      // wall is then made the long way, by offset and cut.
      const cut = onCopy(this.occt, this, solid, faceHashes, (copy, faces) => shellByOffsetCut(this.occt, this, copy, faces, thickness))
      if (cut !== null && typeof cut !== 'string') return { ...cut, note: `Built the long way, by offset and cut, with booleans: the body less its own inward offset and the walls over the opened faces.${gaveUp}` }
      if (cut !== null) reasons.push({ why: `by offset and cut, ${cut}`, raw: false })
      throw new KernelError(mostSpecific(reasons))
    })
  }

  /** The outside rounds of a solid that an inward offset of `distance`
   *  shrinks to nothing, by hash — the faces a shell of that wall fails
   *  on, for a failed shell to point at. */
  collapsingRounds(solid: Shape, distance: number): number[] {
    return run('Reading the rounds', () => {
      const o = this.occt
      const handles = o.getSubShapes(solid, 'face')
      try {
        return handles.filter((h) => collapsesInward(this.occt, h, readFace(this.occt, h), distance)).map((h) => o.hashCode(h, HASH_BOUND))
      } finally {
        for (const h of handles) o.release(h)
      }
    })
  }

  /** How two solids stand to each other: the least distance between them,
   *  or — where they touch or run into each other — none, and the volume
   *  they share. */
  clearance(a: Shape, b: Shape): { gap: number; overlap: number } {
    return run('Measuring the clearance', () => {
      const gap = this.occt.distanceBetween(a, b)
      if (gap > 1e-6) return { gap, overlap: 0 }
      const common = this.occt.common(a, b)
      try {
        return { gap: 0, overlap: this.occt.isNull(common) ? 0 : Math.max(0, this.occt.getVolume(common)) }
      } finally {
        this.occt.release(common)
      }
    })
  }

  /** A solid grown all round by `distance` — its convex edges rounded
   *  over, as an offset rounds them — or shrunk by a negative one. Refused
   *  where the kernel's offset breaks up, which it hands back as a broken
   *  solid without a word (offsetFault says what is found wrong with it),
   *  or refuses in its own words, which are kept. Why is the diagnosis's
   *  to say (diagnose.ts): a part thinner than twice the distance, a face
   *  curving tighter than it, a face narrower than it. */
  offsetSolid(solid: Shape, distance: number): Shape {
    return run('Offsetting', () => {
      if (!(Math.abs(distance) > 1e-9)) throw new KernelError('the offset needs a distance.')
      const o = this.occt
      // units-ok: build message, also the agent's answer
      const what = `the kernel's offset of the body ${distance > 0 ? 'outward' : 'inward'} by ${Math.abs(distance)} mm`
      let made: number
      try {
        made = o.offset(solid, distance, 1e-3)
      } catch (e) {
        if (isTrap(e)) throw e
        throw new KernelError(`${what} failed (${rawRefusal(e)}).`)
      }
      const fault = offsetFault(this.occt, solid, made, distance)
      if (fault !== null) {
        o.release(made)
        throw new KernelError(`${what} came out broken: ${fault}.`)
      }
      return asSolid(this.occt, made)
    })
  }

  /** Each curved face of a solid offset alone by `distance` (negative
   *  inward): the largest distance it takes, where it curves tighter than
   *  that, and what the kernel said if it refused — for a failed offset or
   *  shell to name the faces it fails on. At most `limit` faces, freeform
   *  ones first, none begun past `deadline` (performance.now()); see
   *  faceOffsetLimits (kernelShell.ts) for the cost. */
  faceOffsetLimits(solid: Shape, distance: number, limit?: number, deadline?: number): { faces: FaceOffsetLimit[]; curved: number } {
    return run('Offsetting the faces one at a time', () => faceOffsetLimits(this.occt, solid, distance, limit, deadline))
  }

  /** A sheet made a solid of `thickness`: along its normal (out), against
   *  it (in), or half each way — the sheet's faces kept as the skin it was
   *  thickened from, and the wall the solid came to along the sheet's edge;
   *  see thickenSheet (kernelThicken.ts). A face curving tighter than the
   *  thickness towards the side it grows to folds without a word: look for
   *  that first with faceOffsetLimits. */
  thickenTracked(sheet: Shape, thickness: number, way: ThickenWay): Thickened {
    return run('Thickening', () => thickenSheet(this.occt, this, sheet, thickness, way))
  }

  mirrorTracked(shape: Shape, origin: Vec3, normal: Vec3): Tracked {
    return run('Mirroring', () => {
      const n = normalize(normal)
      if (!n) throw new KernelError('the mirror plane has no normal.')
      return tracked(this.occt, this.occt.mirrorWithHistory(shape, xyz(origin), xyz(n), this.faceHashes(shape), HASH_BOUND))
    })
  }

  /**
   * Lean faces of a solid about a neutral plane: each face named (by hash)
   * is turned by `angleRad` about the line where it meets the plane through
   * `origin` square to `pull`, leaning in as it goes along `pull` for a
   * positive angle — a mould's draft. The kernel's draft takes its neutral
   * plane through the world origin and square to Z, whatever direction it
   * is handed (a pull along Y fails, one along X is refused), so the solid
   * is carried there — the plane's origin to the world's, the pull turned
   * onto +Z — and back; it drafts one face a call and renames the faces
   * round it each time, so the next face is found again by what it is —
   * its kind, its direction, where its middle lay — not by a hash the last
   * call retired. No history comes back: the builder traces the faces by
   * their geometry instead. `angleRad` is one angle for every face or one
   * per face. The kernel leans a face's tangent neighbours with it; a face
   * picked later that leans by its angle already is passed over, its index
   * pushed to `skipped`, and one leaned by another angle is refused.
   */
  draftFaces(solid: Shape, faceHashes: readonly number[], origin: Vec3, pull: Vec3, angleRad: number | readonly number[], skipped?: number[]): Shape {
    return draftFaces(this.occt, this, solid, faceHashes, origin, pull, angleRad, skipped)
  }

  /**
   * Move one face of a solid: a flat face along its outward normal by
   * `offset` millimetres — outward the face's own outline is extruded and
   * joined, inward it is extruded and cut away, so the walls round it run
   * on as they stood — or a round face's radius changed by `offset`, the
   * axis kept: a hole bored out or sleeved, a boss turned down or built up,
   * over the length the face has. Only a cylinder that goes the whole way
   * round can be resized this way. What a face snapped onto the scan is
   * made with.
   */
  offsetFaceTracked(solid: Shape, faceHash: number, offset: number): Tracked {
    return run('Moving the face', () => moveFace(this.occt, this, solid, faceHash, offset))
  }

  /**
   * A screw thread cut on a full round face of a solid — a bolt's on a
   * boss, a nut's in a bore — to its form's basic profile (thread.ts),
   * every face of it moved into the material by the offset. The face may
   * be drawn any size: a bore wider than the thread's crests is filled in to
   * them along the thread first, a boss under them built up (thread.ts
   * fillRadius), and a bore narrower or a boss wider is cut to them.
   *
   * The tooth's outline, drawn in a plane through the axis, is screwed
   * along the axis from a pitch before the thread's span to a pitch past
   * it; a band round the face over the span, less the screwed tooth, is
   * what the solid loses. A bolt's band runs from the thread's root out
   * past the face, a nut's from inside the bore out to the root. Where the
   * span ends at an end of the face with nothing of the solid beyond it —
   * a bolt's free end, a through bore's mouth, a fill's end in a wide bore —
   * the band runs on a little,
   * so the cut does not end on the end face; against a shoulder, a chamfer
   * or a bore's floor it stops at the face's end. Asked for a chamfer, those
   * free ends are chamfered at 45° (thread.ts chamferRadius) before the
   * thread is cut through them.
   */
  threadTracked(solid: Shape, faceHash: number, t: ThreadCut): Tracked {
    return threadTracked(this.occt, this, solid, faceHash, t)
  }

  /**
   * Move several faces of a solid by one offset — each as
   * offsetFaceTracked moves one: a flat face along its outward normal, a
   * full cylinder by its radius. Picked together they are a whole made
   * bigger or smaller: a cylinder's wall and its two ends pushed out by
   * half a millimetre are a cylinder a millimetre longer and wider, its
   * edges as sharp as they were, the way a CAD offset of several faces
   * comes out. The faces are moved one after the other; each move renames
   * the faces round it, so the next face is found again by its surface —
   * the same plane, the same cylinder, which moving another face leaves
   * where it was — not by a hash the last move retired. The history is
   * the composition of the moves'.
   */
  offsetFacesTracked(solid: Shape, faceHashes: readonly number[], offset: number): Tracked {
    return offsetFacesTracked(this.occt, this, solid, faceHashes, offset)
  }

  /** A copy of one face of a shape, by the face's hash — a face of a body
   *  as a profile of its own, to pull straight from the body. A face in a
   *  solid may be oriented against its surface; the copy is what a
   *  profile wants, the face's outward side first. */
  faceCopy(shape: Shape, faceHash: number): Shape {
    return run('Copying the face', () => withSubShapes(this.occt, shape, 'face', [faceHash], ([f]) => this.occt.copy(f) as Shape))
  }

  /** A face's unit normals at the points of it nearest `points`, by the
   *  face's hash — the surface's own normal there, which way the face looks
   *  aside: a patch held tangent to the face reads a line, not a side. */
  faceNormals(shape: Shape, faceHash: number, points: readonly Vec3[]): Vec3[] {
    return run('Reading the face', () =>
      withSubShapes(this.occt, shape, 'face', [faceHash], ([f]) =>
        points.map((p) => {
          const { u, v } = this.occt.uvFromPoint(f, xyz(p))
          return normalize(vec(this.occt.surfaceNormal(f, u, v))) ?? ([0, 0, 1] as Vec3)
        }),
      ),
    )
  }

  /** Each face of a shape by its hash with a point on it: its surface at
   *  the middle of its parameter box — what tells faces apart by where they
   *  lie, without the areas and centroids `faces` integrates. */
  facePoints(shape: Shape): { hash: number; at: Vec3 }[] {
    return run('Reading the faces', () => {
      const handles = this.occt.getSubShapes(shape, 'face')
      try {
        return handles.map((f) => {
          const b = this.occt.uvBounds(f)
          return { hash: this.occt.hashCode(f, HASH_BOUND), at: vec(this.occt.pointOnSurface(f, (b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2)) }
        })
      } finally {
        for (const f of handles) this.occt.release(f)
      }
    })
  }

  // ---- reading the topology --------------------------------------------------------

  /** The hashes of a shape's faces, in the kernel's order. */
  faceHashes(shape: Shape): number[] {
    return run('Listing the faces', () => this.occt.subShapeHashes(shape, 'face', HASH_BOUND))
  }

  /** Every face with the geometry a fingerprint is made of. */
  faces(shape: Shape): RawFace[] {
    return run('Reading the faces', () => {
      const handles = this.occt.getSubShapes(shape, 'face')
      const held = new Set<number>()
      try {
        return handles.map((f) =>
          readFace(this.occt, f, (hash, kind, uvBounds) => {
            const uv = `${uvBounds.uMin} ${uvBounds.uMax} ${uvBounds.vMin} ${uvBounds.vMax}`
            const kept = this.faceMeasures.get(hash)
            if (kept) this.faceMeasures.delete(hash)
            if (kept?.kind === kind && kept.uv === uv) {
              this.faceMeasures.set(hash, kept)
              return kept
            }
            if (kept) this.occt.release(kept.face)
            const read = { face: f, kind, uv, area: this.occt.getSurfaceArea(f), centroid: vec(this.occt.getSurfaceCenterOfMass(f)) }
            this.faceMeasures.set(hash, read)
            held.add(f)
            for (const [h, old] of this.faceMeasures) {
              if (this.faceMeasures.size <= FACE_MEASURES_KEPT) break
              this.faceMeasures.delete(h)
              this.occt.release(old.face)
            }
            return read
          }),
        )
      } finally {
        for (const f of handles) if (!held.has(f)) this.occt.release(f)
      }
    })
  }

  /** Every edge with the geometry a fingerprint is made of, its faces by
   *  hash, and its polyline for drawing at the given chord tolerance. */
  edges(shape: Shape, deflection: number): RawEdge[] {
    return run('Reading the edges', () => {
      const o = this.occt
      // Which faces meet at each edge: flat groups of an edge hash, a
      // count, and that many face hashes.
      const facesOf = parseHistory(o.edgeToFaceMap(shape, HASH_BOUND))
      const wire = o.wireframe(shape, deflection)
      const polylines = new Map<number, Float32Array>()
      const g = wire.edgeGroups
      for (let i = 0; i + 2 < g.length; i += 3) polylines.set(g[i + 2], wire.points.slice(g[i], g[i] + g[i + 1]))
      const handles = o.getSubShapes(shape, 'edge')
      try {
        return handles.map((e) => {
          const hash = o.hashCode(e, HASH_BOUND)
          const kind = edgeKindOf(o.curveType(e))
          const { first, last } = o.curveParameters(e)
          const at = (t: number): Vec3 => vec(o.curvePointAtParam(e, first + (last - first) * t))
          const mid = at(0.5)
          const length = o.curveLength(e)
          let dir: Vec3 = canonicalDir(vec(o.curveTangent(e, (first + last) / 2)))
          let radius: number | undefined
          if (kind === 'circle') {
            const c = circleThrough(at(0.25), at(0.5), at(0.75))
            if (c) {
              dir = canonicalDir(c.axis)
              radius = c.radius
            }
          }
          const tangentAt = (t: number): Vec3 => normalize(vec(o.curveTangent(e, first + (last - first) * t))) ?? [0, 0, 1]
          const base: RawEdge = {
            hash,
            kind,
            mid,
            dir,
            length,
            faceHashes: facesOf.get(hash) ?? [],
            polyline: polylines.get(hash) ?? new Float32Array(0),
            ends: [at(0), at(1)],
            endTangents: [tangentAt(0), tangentAt(1)],
          }
          return radius === undefined ? base : { ...base, radius }
        })
      } finally {
        for (const e of handles) o.release(e)
      }
    })
  }

  cut(a: Shape, b: Shape): Shape {
    return run('Cutting', () => asSolid(this.occt, this.occt.cut(a, b)))
  }

  /** The solids a shape holds, each a handle of its own — one for a solid,
   *  several for what a cut left in pieces. */
  solids(shape: Shape): Shape[] {
    return run('Reading the solids', () => this.occt.getSubShapes(shape, 'solid') as Shape[])
  }

  /** The faces a shape holds, each a handle of its own — what a sheet is
   *  sewn again from, out of the compound a boolean on it answers. */
  facesOf(shape: Shape): Shape[] {
    return run('Reading the faces', () => this.occt.getSubShapes(shape, 'face') as Shape[])
  }

  common(a: Shape, b: Shape): Shape {
    return run('Intersecting', () => asSolid(this.occt, this.occt.common(a, b)))
  }

  /** Whether the shape is one closed solid with volume — what a body has to
   *  be to leave as a STEP a CAD system opens as a solid. */
  isClosedSolid(shape: Shape): boolean {
    return run('Checking the body', () => {
      if (this.occt.isNull(shape)) return false
      const type = this.occt.getShapeType(shape)
      if (type !== 'solid' && type !== 'compound') return false
      if (this.occt.subShapeCount(shape, 'solid') < 1) return false
      return this.occt.isValid(shape) && this.volumeOf(shape) > 1e-9
    })
  }

  /** Whether the kernel's own check passes the shape — its topology and
   *  geometry consistent, every edge on its faces, every face on its
   *  surface. A body that fails it may still mesh and export, and may not
   *  take the next feature. */
  isValid(shape: Shape): boolean {
    return run('Checking the body', () => !this.occt.isNull(shape) && this.occt.isValid(shape))
  }

  /** Whether the shape is a surface — a shell or a face, no solid in it:
   *  a sheet, valid as a cutter, never a body to export. */
  isSurface(shape: Shape): boolean {
    return run('Checking the sheet', () => {
      if (this.occt.isNull(shape)) return false
      const type = this.occt.getShapeType(shape)
      return (type === 'shell' || type === 'face' || type === 'compound') && this.occt.subShapeCount(shape, 'solid') === 0 && this.occt.subShapeCount(shape, 'face') > 0 && this.occt.isValid(shape)
    })
  }

  surfaceArea(shape: Shape): number {
    return run('Measuring the area', () => this.occt.getSurfaceArea(shape))
  }

  /** Whether a point lies inside a solid or on its boundary, within
   *  `tolerance` millimetres. */
  containsPoint(shape: Shape, point: Vec3, tolerance = 1e-6): boolean {
    return run('Locating a point', () => this.occt.containsPoint(shape, xyz(point), tolerance))
  }

  solidCount(shape: Shape): number {
    return run('Counting solids', () => this.occt.subShapeCount(shape, 'solid'))
  }

  faceCount(shape: Shape): number {
    return run('Counting faces', () => this.occt.subShapeCount(shape, 'face'))
  }

  /** How many shells each solid of a shape has, solid by solid: one for a
   *  solid without a void in it, one more for each void. */
  shellsPerSolid(shape: Shape): number[] {
    return run('Counting shells', () => {
      const solids = this.occt.getSubShapes(shape, 'solid')
      try {
        return solids.map((s) => this.occt.subShapeCount(s, 'shell'))
      } finally {
        for (const s of solids) this.occt.release(s)
      }
    })
  }

  /** The voids inside a shape's solids: every shell of a solid but its
   *  outer one — the one holding the most — as a closed hollow, with the
   *  solid it is in (by its place among the shape's solids), its volume
   *  and its box. A body built in bands round a core, or a cut whose tool
   *  stood wholly inside, can leave one, sealed off where no one sees it;
   *  a slicer fills it or prints its walls, a CAD system takes it for part
   *  of the design. */
  voids(shape: Shape): { solid: number; volume: number; bounds: KernelBounds }[] {
    return run('Looking for voids', () => {
      const o = this.occt
      const out: { solid: number; volume: number; bounds: KernelBounds }[] = []
      const solids = o.getSubShapes(shape, 'solid')
      try {
        solids.forEach((solid, i) => {
          if (o.subShapeCount(solid, 'shell') < 2) return
          const shells = o.getSubShapes(solid, 'shell')
          try {
            const read = shells.map((sh) => {
              // A shell's volume is that of the solid it closes; an inner
              // shell faces in, so the sign is dropped.
              const closed = o.makeSolid(sh)
              try {
                return { volume: Math.abs(o.getVolume(closed)), box: o.getBoundingBox(sh) }
              } finally {
                o.release(closed)
              }
            })
            const outer = read.reduce((best, r, j) => (r.volume > read[best].volume ? j : best), 0)
            read.forEach((r, j) => {
              if (j !== outer) out.push({ solid: i, volume: r.volume, bounds: { min: [r.box.xmin, r.box.ymin, r.box.zmin], max: [r.box.xmax, r.box.ymax, r.box.zmax] } })
            })
          } finally {
            for (const sh of shells) o.release(sh)
          }
        })
        return out
      } finally {
        for (const s of solids) o.release(s)
      }
    })
  }

  volume(shape: Shape): number {
    return run('Measuring the volume', () => this.volumeOf(shape))
  }

  /** The kernel's volume of a shape, read once. */
  private volumeOf(shape: Shape): number {
    let v = this.volumes.get(shape)
    if (v === undefined) {
      if (this.volumes.size >= VOLUMES_KEPT) this.volumes.clear()
      this.volumes.set(shape, (v = this.occt.getVolume(shape)))
    }
    return v
  }

  /** A body's volume as an answer gives it. volume() is what the build's own
   *  checks use: quick, and good enough to tell a solid from nothing. A
   *  freeform body's figure can be percents off, so it is held against the
   *  body's mesh, the one `drawn` where there is one to spare a mesh, and the
   *  mesh stands where they part by more than VOLUME_PARTS. */
  measuredVolume(shape: Shape, drawn?: Pick<KernelMesh, 'positions' | 'indices'>): number {
    return run('Measuring the volume', () => {
      const v = this.volumeOf(shape)
      if (!this.hasFreeformFace(shape)) return v
      if (drawn && !partsFrom(meshVolume(drawn), v)) return v
      const meshed = this.volumeByMesh(shape)
      return meshed !== null && partsFrom(meshed, v) ? meshed : v
    })
  }

  /** Whether any face of a shape is other than a plane, cylinder, cone,
   *  sphere or torus. */
  private hasFreeformFace(shape: Shape): boolean {
    const faces = this.occt.getSubShapes(shape, 'face')
    try {
      return faces.some((f) => faceKindOf(this.occt.surfaceType(f)) === 'other')
    } finally {
      for (const f of faces) this.occt.release(f)
    }
  }

  /** A shape's volume off a fine mesh of a copy, which leaves its own
   *  triangles alone (gapBetween says why) — or null where a face would not
   *  draw, the mesh being no measure then. */
  private volumeByMesh(shape: Shape): number | null {
    const o = this.occt
    const box = o.getBoundingBox(shape)
    const size = Math.hypot(box.xmax - box.xmin, box.ymax - box.ymin, box.zmax - box.zmin)
    const copy = o.copy(shape)
    try {
      const m = meshEveryFace(o, copy, Math.max(size * MEASURING_CHORD, 1e-3), MEASURING_ANGLE)
      return m.faults?.some((f) => f.chord === undefined) ? null : meshVolume(m)
    } finally {
      o.release(copy)
    }
  }

  /** A solid's centre of mass. */
  centroid(shape: Shape): Vec3 {
    return run('Measuring the centroid', () => vec(this.occt.getCenterOfMass(shape)))
  }

  bounds(shape: Shape): KernelBounds {
    return run('Measuring the extent', () => {
      const b = this.occt.getBoundingBox(shape)
      return { min: [b.xmin, b.ymin, b.zmin], max: [b.xmax, b.ymax, b.zmax] }
    })
  }

  /** A box the shape lies within: a curved face's control net where bounds
   *  finds its true extremes, so a little larger, and on a freeform body a
   *  hundred times quicker. For a size to scale a tolerance by, or to rule
   *  out two shapes meeting — never a figure to give. */
  extent(shape: Shape): KernelBounds {
    return run('Measuring the extent', () => {
      const b = this.occt.getBoundingBox(shape, { precise: false })
      return { min: [b.xmin, b.ymin, b.zmin], max: [b.xmax, b.ymax, b.zmax] }
    })
  }

  /** Triangles for the viewport, to a chord tolerance in millimetres and
   *  an angle in radians between neighbouring facets. On a small round
   *  the angle is what counts: at 0.15 (about 9°) a 90° fillet is eleven
   *  strips, where 0.35 made it five and drew it faceted close up. The
   *  kernel meshes face by face, so a vertex on an edge is there once per
   *  face and the shading is sharp there, as a CAD body's should be. The
   *  normals are the surfaces' own, turned outward by the windings — see
   *  surfaceNormals. */
  mesh(shape: Shape, linearDeflection: number, angularDeflection = 0.15, opts: { copy?: boolean } = {}): KernelMesh {
    return run('Tessellating the body', () => {
      // `copy`: a mesh to measure by at a chord of its own, made on a copy
      // that leaves the body's own mesh alone. Meshed in place at one chord
      // after another, a body had OCCT at it for minutes (gapBetween says
      // so), and a split's coarse check after the drawing's fine mesh did
      // just that (issue 34). Its faceHash is the copy's, no use for
      // picking: a drawing mesh is made in place.
      const target = opts.copy ? (this.occt.copy(shape) as Shape) : shape
      let m: ReturnType<typeof meshEveryFace>
      try {
        m = meshEveryFace(this.occt, target, linearDeflection, angularDeflection)
      } finally {
        if (opts.copy) this.occt.release(target)
      }
      const mesh: KernelMesh = { positions: m.positions, normals: surfaceNormals(m.positions, m.normals, m.indices, m.faceGroups), indices: m.indices, ...(m.faults ? { faults: m.faults } : {}) }
      // The face each triangle lies on: the kernel meshes face by face and
      // says which triangles are whose — as runs of the index buffer,
      // three entries a triangle.
      if (m.faceGroups) {
        const faceHash = new Int32Array(m.indices.length / 3)
        const g = m.faceGroups
        for (let i = 0; i + 2 < g.length; i += 3) faceHash.fill(g[i + 2], g[i] / 3, (g[i] + g[i + 1]) / 3)
        mesh.faceHash = faceHash
      }
      return mesh
    })
  }

  /** One STEP file holding every shape given. With labels — one per
   *  shape — each is a part of its own under its name and in its colour, as
   *  a CAD system lists them; without, one compound. A body with a round
   *  on a left-handed torus, whose loop the writer can get wrong, has the
   *  file mended after it (mendTorusLoops); an edge on a conic too small
   *  for a part that runs straight is written as a line (straightConics). */
  exportStep(shapes: readonly Shape[], labels?: readonly StepLabel[]): string {
    return run('Writing STEP', () => {
      const text = this.writeStep(shapes, labels)
      return straightConics(shapes.some((shape) => hasLeftHandedTorus(this.occt, shape)) ? mendTorusLoops(text) : text).text
    })
  }

  /**
   * The STEP file as exportStep writes it, read back — and where a part
   * reads back open only by free edges under SHORT_FREE_MM, the curves of
   * the edges there made to end on their corners (snapCurveEnds) and the
   * file checked again: kept when each such part now reads back a closed,
   * valid solid with no odd edge and under MEND_GAP_MM off its body, the
   * file as written otherwise. A part that reads back whole is never
   * touched, and nothing is moved where none read back open. `mended`
   * names what was done, part by part; empty where nothing was. Whether
   * the hairs have gone is read first, a second of reading against half a
   * minute of the check's gap on a body of 480 faces; a file kept is
   * checked once, and `check` is that check, for whoever asks next
   * (reService). `sheets` as verifyStep takes it.
   */
  exportStepMended(shapes: readonly Shape[], labels?: readonly StepLabel[], sheets?: readonly boolean[]): { text: string; mended: StepMend[]; check?: StepCheck } {
    const text = this.exportStep(shapes, labels)
    const open = this.readBackEdges(text, shapes)
    const hairs = open.map((edges) => (edges.length > 0 && edges.every((e) => e.kind === 'free' && e.length < SHORT_FREE_MM) ? edges.map((e) => e.at) : []))
    if (hairs.every((at) => at.length === 0)) return { text, mended: [] }
    const snapped = snapCurveEnds(text, hairs.flat(), { maxMm: SNAP_MM })
    if (snapped.moved === 0) return { text, mended: [] }
    const after = this.readBackEdges(snapped.text, shapes)
    if (hairs.some((at, i) => at.length > 0 && (after[i]?.length ?? 1) > 0)) return { text, mended: [] }
    const check = this.verifyStep(snapped.text, shapes, { sheets })
    const mended: StepMend[] = []
    for (let i = 0; i < shapes.length; i++) {
      if (!hairs[i]?.length) continue
      const body = check.bodies[i]
      if (!body || !body.closed || !body.valid || body.freeEdgeCount > 0 || !(body.gap.max < MEND_GAP_MM)) return { text, mended: [] }
      mended.push({ name: body.name ?? labels?.[i]?.name ?? `Part ${i + 1}`, at: hairs[i], moved: snapped.moved, offMax: snapped.offMax, gap: body.gap.max })
    }
    return { text: snapped.text, mended, check }
  }

  /** A STEP file read back, part by part: the edges of each that do not
   *  join two faces as a closed solid's do (kernelEdges.ts; a knife edge
   *  is a closed solid's still) — what a reader makes of the file, which
   *  the body in memory does not show. A hair the kernel takes for a pole
   *  is one only where the shape it was written from, given, has it too:
   *  the reader marks what it closes a gap with the same way. */
  readBackEdges(text: string, shapes?: readonly Shape[]): ReadBackEdge[][] {
    return this.readBackParts(text, shapes).map((p) => p.edges)
  }

  /** The same, and whether each part read back is a closed, valid solid:
   *  a face lost whole leaves no odd edge (an off-centre dome's, turned
   *  from its base to its pole). */
  readBackParts(text: string, shapes?: readonly Shape[]): ReadBackPart[] {
    return run('Reading STEP back', () => {
      const parts = this.readStepParts(text)
      try {
        return parts.map((p, i) =>
          this.occt.isNull(p.shape)
            ? { edges: [], closed: false, valid: false }
            : {
                edges: oddEdges(this.occt, p.shape, { polesAt: shapes?.[i] !== undefined ? oddEdges(this.occt, shapes[i]).poles.at : [] })
                  .edges.filter((e) => e.kind !== 'knife')
                  .map((e) => ({ at: e.at, length: e.length, kind: e.kind as ReadBackEdge['kind'] })),
                closed: this.isClosedSolid(p.shape),
                valid: this.occt.isValid(p.shape),
              },
        )
      } finally {
        for (const p of parts) this.occt.release(p.shape)
      }
    })
  }

  private writeStep(shapes: readonly Shape[], labels?: readonly StepLabel[]): string {
    if (shapes.length === 0) throw new KernelError('there is no body to write.')
    if (labels) {
      if (labels.length !== shapes.length) throw new KernelError('a name for every body is needed.')
      const doc = this.occt.createXCAFDocument()
      try {
        shapes.forEach((shape, i) => {
          const color = stepColor(labels[i].color)
          doc.addShape(shape, { name: labels[i].name, ...(color ? { color } : {}) })
        })
        return doc.exportSTEP()
      } finally {
        doc.close()
      }
    }
    if (shapes.length === 1) return this.occt.exportStep(shapes[0])
    const compound = this.occt.makeCompound([...shapes])
    const text = this.occt.exportStep(compound)
    this.occt.release(compound)
    return text
  }

  /**
   * A STEP file read back and held against the shapes it was written from,
   * one part each in order (as exportStep writes them with labels): each
   * part's volume, face count and shells per solid beside the shape's — a
   * void is a shell of its own — whether it is a
   * closed, valid solid, and the gap between the two — the largest and the
   * RMS distance of `samples` points of each from the other, both ways, so
   * a face moved or lost shows. Then the file's faces whose loops run the
   * wrong way as a reader that takes them at its word (Parasolid: Onshape,
   * SolidWorks) reads them — what OCCT's own reader mends without a word,
   * so the read-back alone would pass. `problems` says what failed, each
   * in a line; `ok` when none did.
   */
  verifyStep(text: string, shapes: readonly Shape[], { samples = 150, gapMm = 1e-3, sheets = [] }: { samples?: number; gapMm?: number; sheets?: readonly boolean[] | undefined } = {}): StepCheck {
    return run('Checking the STEP file', () => {
      const o = this.occt
      const problems: string[] = []
      const notes: string[] = []
      const parts = this.readStepParts(text)
      try {
        if (parts.length !== shapes.length) problems.push(`The file reads back as ${parts.length} part${parts.length === 1 ? '' : 's'}, not ${shapes.length}.`)
        const bodies: StepCheck['bodies'] = []
        shapes.forEach((shape, i) => {
          const part = parts[i]
          if (!part) return
          const back = part.shape
          const label = part.name ?? `Part ${i + 1}`
          // A sheet meant as one — `sheets` says which — is read back as a
          // sheet: valid, its faces all there, on the body within the gap,
          // and open only where the body is — a patch network's own outer
          // boundary — not where two of its faces met. Any other shape is
          // meant as a solid, and read back as one.
          if (sheets[i] && o.subShapeCount(shape, 'solid') === 0) {
            const valid = !o.isNull(back) && o.isValid(back)
            const faces: [number, number] = [o.subShapeCount(shape, 'face'), o.isNull(back) ? 0 : o.subShapeCount(back, 'face')]
            const gap = this.gapBetween(shape, back, samples)
            const body = oddEdges(o, shape)
            const own = body.edges
            const open = oddEdges(o, back, { polesAt: body.poles.at }).edges.filter((e) => !own.some((f) => len(sub(f.at, e.at)) <= 1e-3))
            if (!valid) problems.push(`${label} reads back as a sheet the kernel's check fails.`)
            if (faces[0] !== faces[1]) problems.push(`${label} reads back with ${faces[1]} faces, not ${faces[0]}.`)
            // units-ok: build message, also the agent's answer
            if (gap.max > gapMm) problems.push(`${label} reads back up to ${gap.max.toPrecision(3)} mm off the body.`)
            if (open.length > 0) problems.push(`${label} reads back open where the sheet is joined: ${open.length} edge${open.length === 1 ? '' : 's'}, the first at (${at3(open[0].at)}).`)
            bodies.push({ ...(part.name ? { name: part.name } : {}), volume: [0, 0], faces, shells: [[], []], closed: false, valid, sheet: true, gap: { max: gap.max, rms: gap.rms, points: gap.points }, freeEdges: open.slice(0, STEP_EDGES_LISTED).map((e) => ({ at: e.at, length: e.length, kind: e.kind as StepEdge['kind'], faces: e.faces.length, in: 'file' as const, near: [] })), freeEdgeCount: open.length, strayShells: [] })
            return
          }
          const closed = this.isClosedSolid(back)
          const valid = !o.isNull(back) && o.isValid(back)
          const volume = this.volumesOf(shape, back)
          const faces: [number, number] = [o.subShapeCount(shape, 'face'), o.isNull(back) ? 0 : o.subShapeCount(back, 'face')]
          const shells: [number[], number[]] = [this.shellsPerSolid(shape), o.isNull(back) ? [] : this.shellsPerSolid(back)]
          const gap = this.gapBetween(shape, back, samples)
          const odd = this.stepEdges(shape, back)
          const strayShells = shells[0].join() !== shells[1].join() ? this.strayShells(shape, back) : []
          const first = odd.list[0]
          // Nothing open to point at: where the body is farthest off what
          // was read back, the face the reader lost.
          const lost = !closed && !first && !strayShells[0] && gap.at ? gap.at : null
          const farthest = lost ? { at: lost, off: gap.max, near: nearestFaces(o, shape, [lost]).flatMap((f) => (f ? [{ hash: f.hash }] : [])) } : undefined
          // units-ok: build message, also the agent's answer
          if (!closed) problems.push(`${label} reads back as no closed solid${first ? ` — ${odd.count === 1 ? 'an edge' : `${odd.count} edges`} not joining two faces, the first at (${at3(first.at)})` : strayShells[0] ? ` — a shell apart about (${at3(strayShells[0].at)})` : farthest ? ` with no edge open — a face lost whole: the body lies ${farthest.off.toPrecision(3)} mm off what was read back about (${at3(farthest.at)})` : ''}.`)
          else if (!valid) problems.push(`${label} reads back as a solid the kernel's check fails.`)
          if (first) problems.push(`${label} has ${odd.count} edge${odd.count === 1 ? '' : 's'} that ${odd.count === 1 ? 'does' : 'do'} not join two faces as a closed solid's do — the first at (${at3(first.at)}): ${oddEdgeText(first)}.`)
          if (faces[0] !== faces[1]) problems.push(`${label} reads back with ${faces[1]} faces, not ${faces[0]}.`)
          if (shells[0].join() !== shells[1].join()) problems.push(`${label} reads back with ${shells[1].join(' + ') || 'no'} shell${shells[1].length === 1 && shells[1][0] === 1 ? '' : 's'}, not ${shells[0].join(' + ')}${strayShells[0] ? ` — the first apart (${strayShells[0].faces} face${strayShells[0].faces === 1 ? '' : 's'}) about (${at3(strayShells[0].at)})` : ''}.`)
          const off = volumeOff(label, volume, gap.max > gapMm)
          if (off?.problem) problems.push(off.text)
          else if (off) notes.push(off.text)
          // units-ok: build message, also the agent's answer
          if (odd.poles.count > 0) notes.push(`${label} has ${odd.poles.count} corner patch${odd.poles.count === 1 ? '' : 'es'} with a side closed to a point, up to ${odd.poles.longest.toPrecision(2)} mm across — the reader's degenerate edges, as a sphere's pole is, and the body's alike: the file holds no such edge, and no hole.`)
          const stray = strayEdges(o, back, STRAY_EDGE_MM)
          // units-ok: as above
          if (stray.count > 0) (stray.off > STRAY_EDGE_FAILS_MM ? problems : notes).push(`${label} has ${stray.count} edge${stray.count === 1 ? '' : 's'} lying off ${stray.count === 1 ? 'its' : 'their'} face${stray.count === 1 ? '' : 's'}, by up to ${stray.off.toPrecision(2)} mm about (${at3(stray.at!)}) — a round's run-out the kernel's check passes on the edge's own tolerance, which the file does not carry: this reader takes it, a stricter one may leave a gap there.${stray.off > STRAY_EDGE_FAILS_MM ? ' Round that corner another way.' : ''}`)
          // units-ok: build message, also the agent's answer
          if (gap.max > gapMm) problems.push(`${label} reads back up to ${gap.max.toPrecision(3)} mm off the body.`)
          bodies.push({ ...(part.name ? { name: part.name } : {}), volume, faces, shells, closed, valid, gap: { max: gap.max, rms: gap.rms, points: gap.points }, freeEdges: odd.list, freeEdgeCount: odd.count, strayShells, ...(farthest ? { farthest } : {}) })
        })
        // Faces whose loops a strict reader takes for the rest of the
        // surface — a fillet's round drawn as a cove.
        const loops = loopSummary(faceLoops(text))
        for (const w of loops.wrong) problems.push(`Face #${w.id} (${w.surface}) has its loop the wrong way round: Onshape or SolidWorks reads it as the rest of the surface.`)
        // The file's own edges, whatever a reader makes of them: a solid's
        // each go round two faces (a seam twice round its one). A sheet's
        // outer rim goes round one.
        const once = sheets.some(Boolean) ? [] : filesOpenEdges(text)
        if (once.length > 0) problems.push(`The file has ${once.length} edge${once.length === 1 ? '' : 's'} going round one face only, the first about (${at3(once[0])}): a hole in the skin, whatever a reader closes it with.`)
        // Edges on a conic too small for a part, which exportStep did not
        // write as lines: a reader that draws the conic draws a spike.
        const conics = smallConics(text)
        // units-ok: build message, also the agent's answer
        if (conics.length > 0) problems.push(`The file has ${conics.length} edge${conics.length === 1 ? '' : 's'} on a ${conics[0].kind} only ${conics[0].size.toPrecision(2)} mm across, the first about (${at3(conics[0].at)}) and centred at (${at3(conics[0].centre)}): a plane a hair off a cone's apex or a revolve's axis makes one, and a reader that draws it (Fusion) can draw a spike out to its centre. Put the plane on the axis.`)
        return { ok: problems.length === 0, parts: parts.length, bodies, loops, problems, notes }
      } finally {
        for (const p of parts) o.release(p.shape)
      }
    })
  }

  /** A body's volume and its read-back's: the kernel's two figures, or
   *  each one's mesh where those two part by more than the numeric
   *  integration should, which on a freeform part says nothing of the file:
   *  a fan's read 0.50 % apart with its meshes 0.003 %. */
  private volumesOf(shape: Shape, back: Shape): [number, number] {
    const o = this.occt
    if (o.isNull(back)) return [o.getVolume(shape), 0]
    const figures: [number, number] = [o.getVolume(shape), o.getVolume(back)]
    if (Math.abs(figures[1] - figures[0]) <= 1e-3 * Math.abs(figures[0])) return figures
    const [a, b] = [this.volumeByMesh(shape), this.volumeByMesh(back)]
    return a !== null && b !== null ? [a, b] : figures
  }

  /** The odd edges of a part read back (kernelEdges.ts; a knife edge is
   *  a closed solid's still), each with the body's faces at the body's
   *  edge nearest it — then the body's own odd edges the reader dropped,
   *  which a stricter reader may keep. The first STEP_EDGES_LISTED, how
   *  many in all, and the poles of the part read back. */
  private stepEdges(shape: Shape, back: Shape): { list: StepEdge[]; count: number; poles: Poles } {
    const o = this.occt
    const isOdd = (e: OddEdge) => e.kind !== 'knife'
    const own = oddEdges(o, shape)
    const read = oddEdges(o, back, { polesAt: own.poles.at })
    const fromFile = read.edges.filter(isOdd)
    const fromBody = own.edges.filter(isOdd).filter((e) => !fromFile.some((f) => len(sub(f.at, e.at)) <= 1e-3))
    const shown = fromFile.slice(0, STEP_EDGES_LISTED)
    const nearest = nearestEdges(o, shape, shown.map((e) => e.at))
    const kind = (e: OddEdge) => e.kind as StepEdge['kind']
    const list: StepEdge[] = shown.map((e, i) => ({ at: e.at, length: e.length, kind: kind(e), faces: e.faces.length, in: 'file', near: (nearest[i]?.faces ?? []).map((hash) => ({ hash })) }))
    for (const e of fromBody.slice(0, STEP_EDGES_LISTED - list.length)) list.push({ at: e.at, length: e.length, kind: kind(e), faces: e.faces.length, in: 'body', near: e.faces.map((hash) => ({ hash })) })
    return { list, count: fromFile.length + fromBody.length, poles: read.poles }
  }

  /** The shells of a part read back beyond the one with the most faces,
   *  each with the body's face nearest the middle of its box — the first
   *  STEP_EDGES_LISTED. */
  private strayShells(shape: Shape, back: Shape): StepShell[] {
    const o = this.occt
    const spots = shellSpots(o, back).slice(1, 1 + STEP_EDGES_LISTED)
    const nearest = nearestFaces(o, shape, spots.map((s) => s.at))
    return spots.map((s, i) => ({ at: s.at, faces: s.faces, near: nearest[i] ? [{ hash: nearest[i]!.hash }] : [] }))
  }

  /** The edges of a shape that do not join two faces as a closed solid's
   *  do — with `knife`, those whose two faces face opposite ways too —
   *  and how many of each kind (kernelEdges.ts). */
  oddEdges(shape: Shape, options: { knife?: boolean; limit?: number } = {}): { edges: OddEdge[]; counts: Record<OddKind, number>; poles: Poles } {
    return run('Reading the edges', () => oddEdges(this.occt, shape, options))
  }

  /** The edges of a shape between two faces a hair long that the kernel
   *  does not take for degenerate (kernelEdges.ts). */
  shortEdges(shape: Shape, options: { underMm?: number; limit?: number } = {}): { edges: ShortEdge[]; count: number } {
    return run('Reading the edges', () => shortEdges(this.occt, shape, options))
  }

  /** The edges of a shape on a conic too small for a part — a plane a hair
   *  off a cone's apex (kernelStep.ts smallConics) — as the STEP writer
   *  writes them, before exportStep writes those that run straight as
   *  lines. Only a shape with an edge on a hyperbola, parabola or ellipse
   *  is written to find out. */
  smallConics(shape: Shape): SmallConic[] {
    return run('Reading the edges', () => {
      const edges = this.occt.getSubShapes(shape, 'edge')
      try {
        if (!edges.some((e) => CONICS.has(this.occt.curveType(e)))) return []
      } finally {
        for (const e of edges) this.occt.release(e)
      }
      return smallConics(this.writeStep([shape]))
    })
  }

  /** The faces of a shape narrower than `widthMm` (twice the area over the
   *  perimeter) not in `own`, the narrowest first (kernelEdges.ts). */
  narrowFaces(shape: Shape, widthMm: number, own?: ReadonlySet<number>): { hash: number; area: number; width: number; centroid: Vec3 }[] {
    return run('Reading the faces', () => narrowFaces(this.occt, shape, widthMm, own))
  }

  /** The largest and RMS distance of points of each shape from the
   *  other: `samples` vertices of each one's coarse mesh, evenly thinned —
   *  and the point of `a` farthest off `b` where it is the largest. A point
   *  is asked first of the face in the other shape's same place in the list,
   *  a file holding its faces in the body's order: a distance to the whole
   *  of a freeform body takes a quarter second a point. A point not close to
   *  that face is asked of the whole, so whatever is off reads as it is. */
  private gapBetween(a: Shape, b: Shape, samples: number): { max: number; rms: number; points: number; at?: Vec3 } {
    const o = this.occt
    if (o.isNull(b)) return { max: Infinity, rms: Infinity, points: 0 }
    let max = 0
    let at: Vec3 | undefined
    let sum = 0
    let n = 0
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const box = o.getBoundingBox(from)
      const size = Math.hypot(box.xmax - box.xmin, box.ymax - box.ymin, box.zmax - box.zmin)
      // On a copy, without the mesh it keeps: meshed coarsely in place straight
      // after a comparison's fine mesh, the flange had OCCT at it over six
      // minutes and still going, and the points would be whatever was
      // meshed last.
      const coarse = o.copy(from)
      const m = o.meshShape(coarse, { linearDeflection: Math.max(size / 100, 1e-3), angularDeflection: 0.5 })
      const onFace = vertexFaces(o, coarse, m)
      o.release(coarse)
      const faces = o.getSubShapes(to, 'face')
      try {
        const count = m.positions.length / 3
        const step = Math.max(1, Math.floor(count / samples))
        for (let i = 0; i < count; i += step) {
          const v = o.makeVertex(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2])
          try {
            const face = faces[onFace[i]]
            const near = face === undefined ? Infinity : o.distanceBetween(v, face)
            const d = near <= SAME_FACE_MM ? near : o.distanceBetween(v, to)
            if (d > max) at = from === a ? [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]] : undefined
            max = Math.max(max, d)
            sum += d * d
            n++
          } finally {
            o.release(v)
          }
        }
      } finally {
        for (const f of faces) o.release(f)
      }
    }
    return { max, rms: n > 0 ? Math.sqrt(sum / n) : 0, points: n, ...(at ? { at } : {}) }
  }

  /** A shape cut by the plane through `origin` square to `normal`: the
   *  section's edges as polylines in the world, sampled to `deflection` —
   *  exact edges, a cylinder's cut a true circle. Empty where the plane
   *  misses the shape. */
  sectionPolylines(shape: Shape, origin: Vec3, normal: Vec3, deflection: number): Float32Array[] {
    return run('Cutting the body', () => {
      const o = this.occt
      const n = normalize(normal)
      if (!n) throw new KernelError('the section needs a normal.')
      const cut = o.sectionPlane(shape, xyz(origin), xyz(n))
      try {
        if (o.isNull(cut)) return []
        const wire = o.wireframe(cut, deflection)
        const out: Float32Array[] = []
        const g = wire.edgeGroups
        for (let i = 0; i + 2 < g.length; i += 3) out.push(wire.points.slice(g[i], g[i] + g[i + 1]))
        return out
      } finally {
        o.release(cut)
      }
    })
  }

  /** A shape cut by the plane through `origin` square to `normal`: the
   *  section's edges as the kernel holds them — lines, circles with their
   *  centre and radius, other curves sampled — each with the face it lies
   *  on (kernelProbe.ts cutPieces). */
  sectionPieces(shape: Shape, origin: Vec3, normal: Vec3, deflection: number): CutPiece[] {
    return run('Cutting the body', () => cutPieces(this.occt, shape, origin, normal, deflection))
  }

  /** Points and rays read against a shape: each point's nearest point of
   *  the skin, distance, side and face; each ray's crossings with the skin
   *  (kernelProbe.ts probePoints, probeRay). `solid`: whether it has an
   *  inside. */
  probe(shape: Shape, points: readonly Vec3[], rays: readonly { from: Vec3; dir: Vec3 }[], solid: boolean): { points: (PointReading | null)[]; rays: { hits: RayHit[]; startsInside: boolean }[] } {
    return run('Probing the body', () => ({ points: probePoints(this.occt, shape, points, solid), rays: rays.map((r) => probeRay(this.occt, shape, r.from, r.dir, solid)) }))
  }

  /** The names a STEP file gives its parts, in its order. */
  readStepNames(text: string): string[] {
    return run('Reading STEP', () => {
      const raw = this.occt as unknown as { importXCAFFromSTEP(text: string): { getRoots(): number[]; getLabelInfo(t: number): { name: string; shapeHandle: number | null }; close(): void } }
      const doc = raw.importXCAFFromSTEP(text)
      try {
        return doc.getRoots().map((t) => {
          const info = doc.getLabelInfo(t)
          if (info.shapeHandle !== null) this.occt.release(info.shapeHandle)
          return info.name
        })
      } catch (e) {
        // As in readStepParts: the reader's own calls are not watched.
        if (isTrap(e)) this.trapped ??= e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        doc.close()
      }
    })
  }

  importStep(text: string): Shape {
    return run('Reading STEP', () => this.occt.importStep(text) as Shape)
  }

  /**
   * The parts a STEP file holds, each a shape of its own under the name the
   * file gives it: every free shape of the file, and an assembly's
   * components one level down — a sub-assembly comes whole, as the shape of
   * its component, placed. A name that is only a number or an instance tag
   * says nothing and is left out. A file the document reader cannot take
   * apart is read whole, nameless. (The reader hands over no colour of a
   * part's faces, which is where a STEP file keeps them.)
   */
  readStepParts(text: string): StepPart[] {
    return run('Reading STEP', () => {
      const raw = this.occt as unknown as { importXCAFFromSTEP(text: string): XcafReader }
      const parts: StepPart[] = []
      let doc: XcafReader | null = null
      try {
        doc = raw.importXCAFFromSTEP(text)
        for (const root of doc.getRoots()) {
          const info = doc.getLabelInfo(root)
          const components = info.isAssembly ? doc.getChildren(root).map((c) => doc!.getLabelInfo(c)) : []
          const placed = components.filter((c) => c.shapeHandle !== null)
          const rootName = partName(info.name)
          if (placed.length > 0) {
            if (info.shapeHandle !== null) this.occt.release(info.shapeHandle)
            for (const c of placed) {
              const name = partName(c.name) ?? rootName
              parts.push({ shape: c.shapeHandle as Shape, ...(name ? { name } : {}) })
            }
          } else if (info.shapeHandle !== null) parts.push({ shape: info.shapeHandle as Shape, ...(rootName ? { name: rootName } : {}) })
        }
      } catch (e) {
        for (const p of parts) this.occt.release(p.shape)
        parts.length = 0
        // The document reader is an object of its own, which the trap watch
        // over the kernel's calls does not see: a trap in it is recorded
        // here, and the file is not read again on the broken kernel
        // (issue 34).
        if (isTrap(e)) {
          this.trapped ??= e instanceof Error ? e.message : String(e)
          throw e
        }
      } finally {
        doc?.close()
      }
      if (parts.length > 0) return parts
      return [{ shape: this.occt.importStep(text) as Shape }]
    })
  }

  /** A shape carried by a rigid move — row-major 3 × 4 (move.ts) — with
   *  the history of its faces: a move keeps every face, in its order, so
   *  the n-th face before it is the n-th after. */
  transformTracked(shape: Shape, matrix: readonly number[]): Tracked {
    return run('Moving', () => {
      const moved = this.occt.transform(shape, [...matrix]) as Shape
      const before = this.faceHashes(shape)
      const after = this.faceHashes(moved)
      const history: FaceHistory = new Map()
      if (before.length === after.length) before.forEach((h, i) => history.set(h, [after[i]]))
      return { shape: moved, history }
    })
  }

  /** A shape as binary BREP, for another kernel to read back (fromBrep):
   *  its faces come back in the same order, on the same surfaces, under
   *  hashes of that kernel's. */
  toBrep(shape: Shape): Uint8Array {
    return run('Writing BREP', () => this.occt.toBREPBinary(shape))
  }

  fromBrep(data: Uint8Array): Shape {
    return run('Reading BREP', () => this.occt.fromBREPBinary(data) as Shape)
  }

  /** A copy of a shape: a handle of its own, released apart from the
   *  original. */
  copy(shape: Shape): Shape {
    return run('Copying', () => this.occt.copy(shape) as Shape)
  }

  release(...shapes: readonly Shape[]): void {
    for (const s of shapes) {
      this.volumes.delete(s)
      try {
        this.occt.release(s)
      } catch {
        // A handle released twice is already gone; nothing to do.
      }
    }
  }
}

