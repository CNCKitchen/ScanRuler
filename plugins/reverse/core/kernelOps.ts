// SPDX-License-Identifier: AGPL-3.0-only
// The kernel's own helpers, shared by ReKernel (kernel.ts) and the operations
// split out of it: OCCT's errors wrapped, a boolean's face history read, the
// sub-shapes of a shape picked by hash, a face's geometry read for its
// fingerprint.

import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, len, normalize, scale, sub } from '../../../src/core/vec'
import type { ReKernel } from './kernel'
import { composeHistory, faceKindOf, parseHistory, vec } from './kernelMath'
import type { FaceHistory, RawFace, Shape, Tracked } from './kernelTypes'
import type { FaceKind } from './topo'
import type { OcctLike, XYZ } from './occtTypes'
import { canonicalDir } from './topo'

/** Whether a round face's span about its axis, its u, is the whole turn. */
const isFullTurn = (uv: { uMin: number; uMax: number }) => uv.uMax - uv.uMin >= 2 * Math.PI - 1e-6

/** The bound the kernel's hashes are taken under: the largest positive
 *  32-bit integer, so two faces of one session collide about as often as
 *  a hash ever does. Hashes are per session — a rebuild makes new ones,
 *  which is why a pick is a fingerprint (topo.ts), never a hash. */
export const HASH_BOUND = 0x7fffffff

/** What the kernel throws is wrapped in a plain Error with its message, so
 *  the worker and the tests need no knowledge of the package's error class. */
export class KernelError extends Error {}

/** The kernel trapped inside its WebAssembly — an `unreachable`, a memory
 *  access out of bounds, an abort. What it holds may be broken after one:
 *  the kernel is let go and started again (reService.ts), never asked
 *  anything more. */
export class KernelTrap extends KernelError {}

/** Whether an error is a WebAssembly trap, however wrapped: occt-wasm
 *  hands one on as an OcctError carrying the trap's own words — V8's
 *  "null function or function signature mismatch", a call through a
 *  broken table, among them: OCCT's fillet traps so now and then. */
export function isTrap(e: unknown): boolean {
  if (e instanceof KernelTrap) return true
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true
  const message = e instanceof Error ? e.message : String(e)
  return /\b(unreachable|memory access out of bounds|index out of bounds|call stack size exceeded|Aborted\(|RuntimeError|null function|signature mismatch|table index|divide by zero|integer overflow|unrepresentable)/i.test(message)
}

/** Who hears each kernel call's name before it is made — see hearCalls. */
let hearing: ((what: string) => void) | null = null
/** The call being made, by its name, while one is. */
let calling: string | null = null

/** Hear the name of each kernel call ("Splitting") before it is made, and
 *  of the call a nested one returns to: the calls are synchronous, so the
 *  name heard last is the call the kernel is in — what the worker tells
 *  the page, which can then say what a call that never returned was doing
 *  (reService.ts). Null stops it. */
export function hearCalls(listener: ((what: string) => void) | null): void {
  hearing = listener
}

export function run<T>(what: string, fn: () => T): T {
  const outer = calling
  calling = what
  hearing?.(what)
  try {
    return fn()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (isTrap(e)) throw new KernelTrap(`${what}: ${message}`)
    throw new KernelError(`${what}: ${message}`)
  } finally {
    calling = outer
    if (outer !== null && outer !== what) hearing?.(outer)
  }
}

/** Whether asSolid and tracked make the faces an operation left on one
 *  surface one face — see keepingSplits. */
let unifying = true

/**
 * `fn` run with the faces its operations leave on one surface kept as
 * they were cut. The kernel's unifying can break what an operation made
 * whole: where faces lie exactly on one cylinder and one of them goes the
 * whole way round — a block joined flush to a flange, its outer face on
 * the flange's radius — it can leave the shell open, and the join that
 * came out a closed solid fails as one that did not. A step that fails so
 * is played again in here (Builder), its faces cut where they lie on one
 * surface — lines the viewer neither draws nor picks — but its solid
 * whole. The kernel's calls are synchronous and each worker has its own
 * kernel, so the switch holds for exactly the calls `fn` makes.
 */
export function keepingSplits<T>(fn: () => T): T {
  const was = unifying
  unifying = false
  try {
    return fn()
  } finally {
    unifying = was
  }
}

/** The fuzzy value a step played again the second time runs its booleans
 *  with, in mm: far over the nanometres an arc drawn through an end a hair
 *  off its circle comes out off a body's cylinder of the same radius, far
 *  under anything a part means. */
export const FUZZY_MM = 1e-4

/** The coarser fuzzy value tried when FUZZY_MM still leaves the shell open:
 *  a micron, where two prisms stacked on one plane were read from the mesh
 *  each on its own and meet in edges a fraction of a micron apart — still
 *  far under anything a part means. */
export const FUZZY_COARSE_MM = 1e-3

/** The fuzzy value the tracked booleans run with — 0, exact, but inside
 *  fuzzyBooleans. */
let fuzzy = 0

/** What the tracked booleans take for one where two faces lie this close. */
export const booleanFuzz = (): number => fuzzy

/**
 * `fn` run with the tracked booleans fuzzy: two faces within FUZZY_MM of one
 * surface taken for one. Exact, the kernel's boolean can leave the shell
 * open where two faces lie a few nanometres apart — a block joined to a
 * flange, its outer face drawn on the flange's radius through ends typed
 * to six decimals — and the join fails; fuzzy, it closes. Only a step
 * that failed so is played again in here (Builder): every other boolean
 * stays exact.
 */
export function fuzzyBooleans<T>(fn: () => T, mm = FUZZY_MM): T {
  const was = fuzzy
  fuzzy = mm
  try {
    return fn()
  } finally {
    fuzzy = was
  }
}

/** A boolean's result is a compound even when it holds one solid; with
 *  exactly one inside, that solid is what the caller gets — a body, not a
 *  box around one. Faces split by the operation are merged back where
 *  they lie on the same surface, so a later STEP is as lean as the input. */
export function asSolid(occt: OcctLike, shape: number): Shape {
  const solid = loneSolid(occt, shape)
  if (solid === shape || !unifying) return solid
  const unified = occt.unifySameDomain(solid)
  occt.release(solid)
  return unified as Shape
}

/** A solid's faces on one surface made one face, as asSolid makes a
 *  boolean's — unless the faces are being kept as they were cut
 *  (keepingSplits), when the solid comes back as it was. A new solid is
 *  the caller's and the old one released; one that does not come out a
 *  solid leaves the old as it was. */
export function unifiedSolid(occt: OcctLike, solid: Shape): Shape {
  if (!unifying) return solid
  const unified = occt.unifySameDomain(solid) as Shape
  if (occt.isNull(unified) || occt.getShapeType(unified) !== 'solid') {
    occt.release(unified)
    return solid
  }
  occt.release(solid)
  return unified
}

/** The one solid in a boolean's compound, as asSolid takes it out, but
 *  with its faces as the boolean left them. */
export function loneSolid(occt: OcctLike, shape: number): Shape {
  if (occt.getShapeType(shape) !== 'compound') return shape as Shape
  const solids = occt.getSubShapes(shape, 'solid')
  if (solids.length !== 1) {
    for (const s of solids) occt.release(s)
    return shape as Shape
  }
  occt.release(shape)
  return solids[0] as Shape
}

/** An operation's result as asSolid takes it, with the history carried on
 *  through the unifying: a face the unifying merged, or built again round
 *  an edge it merged, has a new hash, and what the operation said became
 *  of an old face is then said of that new one. */
export function tracked(occt: OcctLike, ev: { result: number; modified: number[] }): Tracked {
  const history = parseHistory(ev.modified)
  const solid = loneSolid(occt, ev.result)
  if (solid === ev.result || !unifying) return { shape: solid, history }
  const unified = occt.unifySameDomain(solid)
  try {
    return { shape: unified as Shape, history: composeHistory(history, unifyHistory(occt, solid, unified)) }
  } finally {
    occt.release(solid)
  }
}

/** How near a point must be to a face's surface to be on it, in mm. */
const ON_SURFACE = 1e-4

/** What unifying did to a solid's faces: each face of `before` whose hash
 *  is not on `after`, to the face of `after` it went into. The kernel
 *  keeps no history of the unifying, so a face is followed by a point
 *  inside it — the new face holding that point is the one it became. Only
 *  a face with a new hash can have taken one in: a face that kept its
 *  hash is the face it was. */
export function unifyHistory(occt: OcctLike, before: number, after: number): FaceHistory {
  const history: FaceHistory = new Map()
  const was = occt.getSubShapes(before, 'face')
  const now = occt.getSubShapes(after, 'face')
  try {
    const wasHash = was.map((f) => occt.hashCode(f, HASH_BOUND))
    const nowHash = now.map((f) => occt.hashCode(f, HASH_BOUND))
    const kept = new Set(nowHash)
    const old = new Set(wasHash)
    const fresh = now
      .map((face, i) => ({ face, hash: nowHash[i] }))
      .filter((f) => !old.has(f.hash))
      .map((f) => ({ ...f, box: occt.getBoundingBox(f.face), kind: faceKindOf(occt.surfaceType(f.face)), uv: occt.uvBounds(f.face) }))
    if (fresh.length === 0) return history
    for (let i = 0; i < was.length; i++) {
      if (kept.has(wasHash[i])) continue
      try {
        const p = pointInside(occt, was[i])
        const into = p && fresh.find((f) => inBox(f.box, p) && onFace(occt, f, p))
        if (into) history.set(wasHash[i], [into.hash])
      } catch {
        // A face the kernel cannot place a point on goes untraced, and is
        // taken for the operation's own; the operation stands.
      }
    }
    return history
  } finally {
    for (const f of was) occt.release(f)
    for (const f of now) occt.release(f)
  }
}

/** A history for an operation the kernel tracks none for, which leaves
 *  every face it keeps on the surface it was on — a split, a sheet trimmed
 *  or sewn: each face of `after` whose hash none of `before` has, followed
 *  by a point inside it to the face of `before` holding that point, which
 *  it is a piece of. A face lying on none — where a tool cut — goes
 *  untraced, the operation's own. */
export function tracedHistory(occt: OcctLike, before: readonly number[], after: number): FaceHistory {
  const history: FaceHistory = new Map()
  const was = before.flatMap((s) => occt.getSubShapes(s, 'face'))
  const now = occt.getSubShapes(after, 'face')
  try {
    const wasHash = was.map((f) => occt.hashCode(f, HASH_BOUND))
    const old = new Set(wasHash)
    const faces = was.map((face, i) => ({ face, hash: wasHash[i], box: occt.getBoundingBox(face), kind: faceKindOf(occt.surfaceType(face)), uv: occt.uvBounds(face) }))
    const seen = new Set<number>()
    for (const f of now) {
      const hash = occt.hashCode(f, HASH_BOUND)
      if (old.has(hash) || seen.has(hash)) continue
      seen.add(hash)
      try {
        const p = pointInside(occt, f)
        const from = p && faces.find((x) => inBox(x.box, p) && onFace(occt, x, p))
        if (from) history.set(from.hash, [...(history.get(from.hash) ?? []), hash])
      } catch {
        // A face the kernel cannot place a point on goes untraced, and is
        // taken for the operation's own; the operation stands.
      }
    }
    return history
  } finally {
    for (const f of was) occt.release(f)
    for (const f of now) occt.release(f)
  }
}

/** A point inside a face: the middle of its parameter box when the face
 *  has it, else the first of ever finer grids over the box that it has —
 *  the middle of a ring is its hole. Null for a face too thin for the
 *  finest grid. */
function pointInside(occt: OcctLike, face: number): XYZ | null {
  const { uMin, uMax, vMin, vMax } = occt.uvBounds(face)
  for (const n of [1, 4, 16]) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const u = uMin + ((i + 0.5) / n) * (uMax - uMin)
        const v = vMin + ((j + 0.5) / n) * (vMax - vMin)
        if (occt.classifyPointOnFace(face, u, v) === 'in') return occt.pointOnSurface(face, u, v)
      }
    }
  }
  return null
}

function inBox(b: ReturnType<OcctLike['getBoundingBox']>, p: XYZ): boolean {
  const t = ON_SURFACE
  return p.x >= b.xmin - t && p.x <= b.xmax + t && p.y >= b.ymin - t && p.y <= b.ymax + t && p.z >= b.zmin - t && p.z <= b.zmax + t
}

/** Whether a point lies on a face: on its surface, and inside its edges. */
function onFace(occt: OcctLike, f: { face: number; kind: string; uv: { uMin: number; vMin: number } }, p: XYZ): boolean {
  let { u, v } = occt.uvFromPoint(f.face, p)
  const q = occt.pointOnSurface(f.face, u, v)
  if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) > ON_SURFACE) return false
  // A round surface's angle comes back in the surface's own turn, which
  // need not be the turn the face's span is counted in.
  const turn = 2 * Math.PI
  const into = (t: number, from: number) => from + ((((t - from) % turn) + turn) % turn)
  if (f.kind === 'cylinder' || f.kind === 'cone' || f.kind === 'sphere' || f.kind === 'torus') u = into(u, f.uv.uMin)
  if (f.kind === 'torus') v = into(v, f.uv.vMin)
  return occt.classifyPointOnFace(f.face, u, v) === 'in'
}

export function bothFaceHashes(kernel: ReKernel, a: Shape, b: Shape): number[] {
  return [...kernel.faceHashes(a), ...kernel.faceHashes(b)]
}

/** Run `fn` on the handles of the sub-shapes with the given hashes, every
 *  handle released afterwards. A hash not on the shape is an error: the
 *  caller matched fingerprints to this very shape's faces or edges. */
export function withSubShapes<T>(occt: OcctLike, shape: Shape, type: 'face' | 'edge', hashes: readonly number[], fn: (handles: number[]) => T): T {
  const all = occt.getSubShapes(shape, type)
  try {
    const byHash = new Map<number, number>()
    for (const h of all) byHash.set(occt.hashCode(h, HASH_BOUND), h)
    const picked: number[] = []
    for (const hash of hashes) {
      const h = byHash.get(hash)
      if (h === undefined) throw new KernelError(`the ${type} is not on the body.`)
      picked.push(h)
    }
    if (picked.length === 0) throw new KernelError(`no ${type} given.`)
    return fn(picked)
  } finally {
    for (const h of all) occt.release(h)
  }
}

type UvBounds = ReturnType<OcctLike['uvBounds']>

/** A face read for its fingerprint. `measured`, where given, may give its
 *  area and centroid from an earlier reading (ReKernel.faces): the two
 *  figures a freeform face is integrated for, where the rest is quick. */
export function readFace(occt: OcctLike, f: number, measured?: (hash: number, kind: FaceKind, uv: UvBounds) => { area: number; centroid: Vec3 }): RawFace {
  const o = occt
  const hash = o.hashCode(f, HASH_BOUND)
  const kind = faceKindOf(o.surfaceType(f))
  const uv = o.uvBounds(f)
  const { area, centroid } = measured?.(hash, kind, uv) ?? { area: o.getSurfaceArea(f), centroid: vec(o.getSurfaceCenterOfMass(f)) }
  const um = (uv.uMin + uv.uMax) / 2
  const vm = (uv.vMin + uv.vMax) / 2
  // The kernel's surfaceNormal is the face's outward normal — it reads
  // the face's orientation, so a box's bottom face says −Z.
  const normalAt = (u: number, v: number): Vec3 => normalize(vec(o.surfaceNormal(f, u, v))) ?? [0, 0, 1]
  let dir: Vec3 = normalAt(um, vm)
  let radius: number | undefined
  let center: Vec3 | undefined
  let fullTurn: boolean | undefined
  if (kind === 'cylinder' || kind === 'cone' || kind === 'torus') {
    fullTurn = isFullTurn(uv)
    // Round these, u runs about the axis, so the normals at three places
    // round it all make the same angle with the axis: the axis is what
    // is perpendicular to their differences. Thirds of the span, so a
    // full turn does not bring the first and the last together.
    const span = uv.uMax - uv.uMin
    const n0 = normalAt(uv.uMin, vm)
    const n1 = normalAt(uv.uMin + span / 3, vm)
    const n2 = normalAt(uv.uMin + (2 * span) / 3, vm)
    const axis = normalize(cross(sub(n0, n1), sub(n1, n2))) ?? normalize(cross(n0, n2))
    if (axis) dir = canonicalDir(axis)
    if (kind === 'cylinder') radius = o.getFaceCylinderData(f)?.radius
    // The axis point: the surface — not the face, which may be a sliver
    // of it — sampled a quarter turn apart all the way round at the
    // middle height averages to a point on the axis for a cylinder and
    // a cone alike.
    if (kind === 'cylinder' || kind === 'cone') {
      const quarter = Math.PI / 2
      const pts = [0, 1, 2, 3].map((q) => vec(o.pointOnSurface(f, uv.uMin + q * quarter, vm)))
      center = [0, 1, 2].map((k) => (pts[0][k] + pts[1][k] + pts[2][k] + pts[3][k]) / 4) as Vec3
    }
  } else if (kind === 'sphere') {
    const c = o.surfaceCurvature(f, um, vm)
    if (Math.abs(c.mean) > 1e-12) {
      radius = 1 / Math.abs(c.mean)
      // The centre lies a radius off the surface along its normal: behind
      // a ball's face, in front of a cup's, which looks in towards it. The
      // kernel's curvature keeps one sign either way — it reads the
      // surface, not the face — so the side is the one a second point of
      // the face lies a radius from; the other lies a diameter off.
      const p = vec(o.pointOnSurface(f, um, vm))
      const q = vec(o.pointOnSurface(f, (uv.uMin + um) / 2, (uv.vMin + vm) / 2))
      const behind = addScaled(p, dir, -radius)
      const ahead = addScaled(p, dir, radius)
      center = Math.abs(len(sub(q, ahead)) - radius) < Math.abs(len(sub(q, behind)) - radius) ? ahead : behind
    }
  }
  const face: RawFace = { hash, kind, centroid, dir, area }
  if (radius !== undefined) face.radius = radius
  if (center !== undefined) face.center = center
  if (fullTurn !== undefined) face.fullTurn = fullTurn
  return face
}

/** A round face that goes the whole way round, read for an operation
 *  along its axis: the axis as the face's reading gives it, whether the
 *  face looks away from it — a boss — or towards it — a bore — and how
 *  far it runs along the axis from `center`. `needs` says why a face
 *  short of a full turn will not do. */
export function readRound(occt: OcctLike, handle: number, dir: Vec3, center: Vec3, needs: string): { axis: Vec3; convex: boolean; lo: number; hi: number } {
  const o = occt
  const uv = o.uvBounds(handle)
  if (!isFullTurn(uv)) throw new KernelError(`the round face does not go the whole way round — ${needs}.`)
  const axis = normalize(dir) ?? [0, 0, 1]
  // Outward of a boss points away from the axis, of a hole towards it.
  const um = (uv.uMin + uv.uMax) / 2
  const vm = (uv.vMin + uv.vMax) / 2
  const p = vec(o.pointOnSurface(handle, um, vm))
  const radial = sub(sub(p, center), scale(axis, dot(sub(p, center), axis)))
  const convex = dot(vec(o.surfaceNormal(handle, um, vm)), radial) > 0
  // How far the face runs along its axis: v is a round surface's
  // height up its axis, so the face's ends are read off the surface in
  // doubles. Off its tessellation, in floats, a tilted axis put the
  // tube's ends a few millionths of a millimetre past the end faces, and
  // the join left a ring of nothing there — a circle on the end face,
  // and a sliver of the old wall standing round it.
  const ends = [uv.vMin, uv.vMax].map((v) => dot(sub(vec(o.pointOnSurface(handle, um, v)), center), axis))
  const lo = Math.min(ends[0], ends[1])
  const hi = Math.max(ends[0], ends[1])
  if (!(hi - lo > 1e-9)) throw new KernelError('the round face has no length.')
  return { axis, convex, lo, hi }
}
