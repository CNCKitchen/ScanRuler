// SPDX-License-Identifier: AGPL-3.0-only
// Rounds and chamfers that take the whole face between their edges: made a
// hair under the size, the sliver left taken off — the part of ReKernel's
// fillet and chamfer (kernel.ts) that is more than one call to the kernel.

import { addScaled, dot, scale, sub } from '../../../src/core/vec'
import type { ReKernel } from './kernel'
import { composeHistory, sameSurface } from './kernelMath'
import { HASH_BOUND, isTrap, readFace, unifiedSolid, unifyHistory } from './kernelOps'
import type { FaceHistory, RawFace, Shape, Tracked } from './kernelTypes'
import type { OcctLike } from './occtTypes'

/** How far under the asked size a round or a chamfer that takes the whole
 *  face between its edges is made — see ReKernel.fullWidth — tried in turn,
 *  the least first. Relative: at the least a face 5 mm wide is left
 *  0.05 µm of itself; a chamfer wants the most, 50 µm in a metre. */
const FULL_WIDTH_SLACK = [1e-8, 1e-6, 1e-5]

/** A round or a chamfer whose edges take the whole face between them — a
 *  wall 5 mm thick rounded 2.5 mm on both edges into a half round, a bar's
 *  ends into a pill's — which the kernel refuses at the exact size: the
 *  face between would close up to nothing. It is made a hair under the
 *  size instead (FULL_WIDTH_SLACK), which leaves that face as a sliver far
 *  thinner than any tolerance, and the sliver is then taken off, its
 *  neighbours closing over it — the two rounds one half round, as the
 *  size asked. Anything the operation does at the exact size stands. */
export function fullWidth(occt: OcctLike, kernel: ReKernel, solid: Shape, size: number, make: (size: number) => Tracked): Tracked {
  let exact: Tracked | null = null
  let failure: unknown = null
  // A trap goes on at once: the kernel is broken from it on, and every
  // size tried after it would ask a dead kernel — nothing is released.
  try {
    exact = make(size)
    if (kernel.isClosedSolid(exact.shape)) return exact
  } catch (e) {
    if (isTrap(e)) throw e
    failure = e
  }
  let near: Tracked | null = null
  let slack = 0
  for (const s of FULL_WIDTH_SLACK) {
    try {
      near = make(size * (1 - s))
    } catch (e) {
      if (isTrap(e)) throw e
      near = null
    }
    if (near && kernel.isClosedSolid(near.shape)) {
      slack = s
      break
    }
    if (near) kernel.release(near.shape)
    near = null
  }
  if (!near) {
    if (exact) return exact
    throw failure
  }
  if (exact) kernel.release(exact.shape)
  const width = 8 * size * slack
  if (!hasSlivers(occt, near.shape, width)) return near
  // The sliver left out and the faces either side sewn shut across it;
  // or, where that does not close, each pair of rounds on one axis
  // filled out to the one round of the asked radius they stand for; or
  // the sliver taken off by the kernel's defeaturing, its neighbours
  // closed over it — the slowest by far, a minute on a slab's outline.
  // Failing all, the sliver stays: a face far thinner than any
  // tolerance, the body right.
  const closers = [() => sewOverSlivers(occt, near.shape, width), () => fillFullRounds(occt, kernel, near.shape, solid, size, width), () => defeatureSlivers(occt, near.shape, width)]
  for (const close of closers) {
    let closed: Shape | null = null
    try {
      closed = close()
    } catch (e) {
      if (isTrap(e)) throw e
      closed = null
    }
    if (!closed) continue
    if (kernel.isClosedSolid(closed) && !hasSlivers(occt, closed, width)) {
      const history = composeHistory(near.history, closingHistory(occt, kernel, near.shape, closed))
      kernel.release(near.shape)
      return { shape: closed, history }
    }
    kernel.release(closed)
  }
  return near
}

/** The handles of the faces of a shape narrower than `width` — the area
 *  over the span. The caller releases them. */
function slivers(occt: OcctLike, shape: Shape, width: number): number[] {
  const o = occt
  const thin: number[] = []
  for (const h of o.getSubShapes(shape, 'face')) {
    const b = o.getBoundingBox(h)
    const span = Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin)
    if (span > 0 && o.getSurfaceArea(h) / span < width) thin.push(h)
    else o.release(h)
  }
  return thin
}

function hasSlivers(occt: OcctLike, shape: Shape, width: number): boolean {
  const thin = slivers(occt, shape, width)
  for (const h of thin) occt.release(h)
  return thin.length > 0
}

/** The shape's faces less its slivers, sewn into a solid: each sliver's
 *  two long sides lie a hair apart — far closer than `width` — so the
 *  faces either side of it are sewn edge to edge across where it was.
 *  Whatever those faces are — the two halves of a round on a line, a
 *  torus at an arc of the outline, the kernel's swept surface along a
 *  spline, a round and the face it runs into at a single round of the
 *  whole wall — they already meet as the round does, tangent, on the
 *  asked radius but for the hair: nothing is made, only closed. The
 *  halves on one surface are then made one face. Null when the faces do
 *  not close into one solid. */
function sewOverSlivers(occt: OcctLike, shape: Shape, width: number): Shape | null {
  const o = occt
  const thin = new Set<number>()
  for (const h of slivers(occt, shape, width)) {
    thin.add(o.hashCode(h, HASH_BOUND))
    o.release(h)
  }
  if (thin.size === 0) return null
  const all = o.getSubShapes(shape, 'face')
  let sewn: Shape | null = null
  try {
    const kept = all.filter((h) => !thin.has(o.hashCode(h, HASH_BOUND)))
    sewn = o.sewAndSolidify(kept, width) as Shape
  } finally {
    for (const h of all) o.release(h)
  }
  if (o.isNull(sewn) || o.getShapeType(sewn) !== 'solid') {
    if (!o.isNull(sewn)) o.release(sewn)
    return null
  }
  return unifiedSolid(occt, sewn)
}

/** The slivers of a shape taken off by the kernel's defeaturing, their
 *  neighbours extended to close over them; null when it makes nothing. */
function defeatureSlivers(occt: OcctLike, shape: Shape, width: number): Shape | null {
  const thin = slivers(occt, shape, width)
  try {
    const closed = occt.defeature(shape, thin, 0) as Shape
    return occt.isNull(closed) ? null : closed
  } finally {
    for (const h of thin) occt.release(h)
  }
}

/** The rounds of a shape that come in pairs on one axis — the two halves
 *  of a full round made a hair under its radius, a sliver between — each
 *  pair filled out by a cylinder of the full `radius` on their common
 *  axis, kept within the body before the round (`solid`), so what is
 *  added is the hair the slack left and nothing past the round's ends. */
function fillFullRounds(occt: OcctLike, kernel: ReKernel, shape: Shape, solid: Shape, radius: number, width: number): Shape | null {
  const o = occt
  const rounds: { face: RawFace; lo: number; hi: number }[] = []
  for (const h of o.getSubShapes(shape, 'face')) {
    const face = readFace(occt, h)
    if (face.kind === 'cylinder' && face.center && face.radius !== undefined && Math.abs(face.radius - radius) < width) {
      const b = o.getBoundingBox(h)
      const along = [b.xmin, b.xmax].flatMap((x) => [b.ymin, b.ymax].flatMap((y) => [b.zmin, b.zmax].map((z) => dot(sub([x, y, z], face.center!), face.dir))))
      rounds.push({ face, lo: Math.min(...along), hi: Math.max(...along) })
    }
    o.release(h)
  }
  const fills: Shape[] = []
  const used = new Set<number>()
  try {
    for (let i = 0; i < rounds.length; i++) {
      if (used.has(i)) continue
      const a = rounds[i]
      const pair = rounds.findIndex((b, j) => {
        if (j <= i || used.has(j) || Math.abs(dot(a.face.dir, b.face.dir)) < 1 - 1e-9) return false
        const off = sub(b.face.center!, a.face.center!)
        const across = sub(off, scale(a.face.dir, dot(off, a.face.dir)))
        return Math.hypot(across[0], across[1], across[2]) < width
      })
      if (pair < 0) continue
      used.add(i).add(pair)
      const b = rounds[pair]
      const shift = dot(sub(b.face.center!, a.face.center!), a.face.dir)
      const margin = radius * 1e-3
      const lo = Math.min(a.lo, b.lo + shift) - margin
      const hi = Math.max(a.hi, b.hi + shift) + margin
      const center = scale(addScaled(a.face.center!, b.face.center!, 1), 0.5)
      const axisPoint = addScaled(center, a.face.dir, -shift / 2)
      const disc = kernel.face({ outer: [{ kind: 'circle', center: axisPoint, normal: a.face.dir, radius }], holes: [] })
      fills.push(kernel.extrude(disc, a.face.dir, lo, hi))
      kernel.release(disc)
    }
    if (fills.length === 0) return null
    let filler = fills[0]
    for (const f of fills.slice(1)) filler = kernel.fuse(filler, f)
    const kept = kernel.common(filler, solid)
    const filled = kernel.fuse(shape, kept)
    kernel.release(kept)
    return filled
  } finally {
    for (const f of fills) kernel.release(f)
  }
}

/** What became of each face of `before` that is not on `after` under the
 *  same hash: the face of `after` a point inside it lies on (kernelOps
 *  unifyHistory) — a round's two halves the one round, a wall sewn to its
 *  neighbours the wall it was — and, for a face no point was found on,
 *  the face of `after` on the same surface. */
function closingHistory(occt: OcctLike, kernel: ReKernel, before: Shape, after: Shape): FaceHistory {
  const history = unifyHistory(occt, before, after)
  for (const [was, now] of surfaceHistory(kernel, before, after)) if (!history.has(was)) history.set(was, now)
  return history
}

/** The same by surface alone: the face of `after` on the same surface as
 *  the face of `before` that is gone. */
function surfaceHistory(kernel: ReKernel, before: Shape, after: Shape): FaceHistory {
  const was = kernel.faces(before)
  const now = kernel.faces(after)
  const still = new Set(now.map((f) => f.hash))
  const fresh = now.filter((f) => !was.some((w) => w.hash === f.hash))
  const history: FaceHistory = new Map()
  for (const w of was) {
    if (still.has(w.hash)) continue
    const f = sameSurface(w, fresh)
    if (f) history.set(w.hash, [f.hash])
  }
  return history
}
