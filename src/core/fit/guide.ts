// SPDX-License-Identifier: AGPL-3.0-only
// What a fit from a click may be told about the surface it is after, so the
// search does not settle on the wrong one nearby: which side of the surface
// the material is on (the inside of a cup, not its underside), the size it
// should come out at, the direction of its axis, and a box it stays in. A
// click on a rim sits between two surfaces; without these the larger one
// wins.

import { rigidApply, rigidRotate, type Rigid } from '../deviation/rigid'
import type { MeshGraph, Vec3 } from '../types'

export interface FitGuide {
  /** inside: a concave surface — a bore, a cup's inside, a countersink; the
   *  scan's normals point toward the axis or centre. outside: a convex one —
   *  a shaft, a ball. Spheres, cylinders and cones. */
  side?: 'inside' | 'outside'
  /** The radius the surface should have, mm; a fit outside is refused. */
  radius?: { min?: number; max?: number }
  /** A guess at the axis direction (cylinder, cone): only vertices whose
   *  normals stand roughly square to it are searched. */
  axis?: Vec3
  /** The surface stays inside this box. */
  within?: { min: Vec3; max: Vec3 }
}

/** How far a normal may lean off square to a given axis and still be on the
 *  round wall — wider than the scan's noise, narrower than a chamfer. */
const AXIS_SQUARE_DEG = 30
const AXIS_SIN = Math.sin((AXIS_SQUARE_DEG * Math.PI) / 180)
/** A final fit's axis may lie this far off the guess. */
const AXIS_FINAL_COS = Math.cos((20 * Math.PI) / 180)
/** An estimate's radius is checked with this much slack: the robust
 *  estimate on a patch is rough, the final fit is held to the range. */
const RADIUS_SLACK = 0.1

export const hasGuide = (g: FitGuide | undefined): g is FitGuide =>
  !!g && (g.side !== undefined || g.radius !== undefined || g.axis !== undefined || g.within !== undefined)

/** The guide carried through a rigid motion of the part, as the element's
 *  fit is: the axis turns with it, and the box becomes the axis-aligned box
 *  round its turned corners — no smaller than the one asked for, so what it
 *  held before it still holds. Side and radius do not move. */
export function moveGuide(g: FitGuide, m: Rigid): FitGuide {
  const out: FitGuide = { ...g }
  const t = new Float64Array(3)
  if (g.axis) {
    rigidRotate(m, g.axis[0], g.axis[1], g.axis[2], t)
    out.axis = [t[0], t[1], t[2]]
  }
  if (g.within) {
    const { min, max } = g.within
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let c = 0; c < 8; c++) {
      rigidApply(m, c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2], t)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], t[k])
        hi[k] = Math.max(hi[k], t[k])
      }
    }
    out.within = { min: lo, max: hi }
  }
  return out
}

/** The guide of a part scaled by `s` about the origin: the radius range and
 *  the box scale with it; side and axis stay. */
export function scaleGuide(g: FitGuide, s: number): FitGuide {
  const out: FitGuide = { ...g }
  if (g.radius) {
    out.radius = {
      ...(g.radius.min !== undefined ? { min: g.radius.min * s } : {}),
      ...(g.radius.max !== undefined ? { max: g.radius.max * s } : {}),
    }
  }
  if (g.within) {
    const at = (p: Vec3): Vec3 => [p[0] * s, p[1] * s, p[2] * s]
    out.within = { min: at(g.within.min), max: at(g.within.max) }
  }
  return out
}

export function unitAxis(g: FitGuide): Vec3 | null {
  if (!g.axis) return null
  const l = Math.hypot(g.axis[0], g.axis[1], g.axis[2])
  return l > 0 ? [g.axis[0] / l, g.axis[1] / l, g.axis[2] / l] : null
}

export function inBox(g: FitGuide, x: number, y: number, z: number): boolean {
  const b = g.within
  if (!b) return true
  return x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]
}

/** Whether a radius lies in the range — with the estimate's slack when
 *  `rough`. */
export function radiusInRange(g: FitGuide, r: number, rough = false): boolean {
  const lo = g.radius?.min
  const hi = g.radius?.max
  if (lo !== undefined && r < lo * (rough ? 1 - RADIUS_SLACK : 1)) return false
  if (hi !== undefined && r > hi * (rough ? 1 + RADIUS_SLACK : 1)) return false
  return true
}

/** An axis close enough to the guess (either way along it). */
export function axisAgrees(g: FitGuide, a: Vec3): boolean {
  const u = unitAxis(g)
  if (!u) return true
  return Math.abs(u[0] * a[0] + u[1] * a[1] + u[2] * a[2]) >= AXIS_FINAL_COS
}

/** The patch round the seed with what the guide rules out taken away: the
 *  vertices outside the box, and — with an axis — those whose normals do not
 *  stand square to it (the floor of a hole, the face round its mouth). */
export function guidePatch(graph: MeshGraph, patch: Uint32Array, g: FitGuide): Uint32Array {
  const u = unitAxis(g)
  const bend = g.side !== undefined || g.radius !== undefined
  if (!u && !g.within && !bend) return patch
  const { positions: p, normals: n } = graph
  const out: number[] = []
  for (let i = 0; i < patch.length; i++) {
    const v = patch[i]
    const j = v * 3
    if (!inBox(g, p[j], p[j + 1], p[j + 2])) continue
    if (u && Math.abs(n[j] * u[0] + n[j + 1] * u[1] + n[j + 2] * u[2]) > AXIS_SIN) continue
    out.push(v)
  }
  return bend ? bentAsAsked(graph, Uint32Array.from(out), g) : Uint32Array.from(out)
}

/**
 * The vertices of a patch that bend the way the guide asks: a flat (a rim, a
 * face round a hole's mouth) goes, and with a side the surface curving the
 * other way goes too. The bend at a vertex is how its neighbours' normals
 * spread, (n_u − n_v)·(u − v)/|u − v|² — 1/R on a sphere, about 1/2R on a
 * cylinder, positive where the surface is convex — averaged once more over
 * the ring so the scan's normal noise mostly cancels. Kept: bends past a
 * floor (a quarter of the largest radius asked for's, or the part's size's
 * when none is), of the sign the side asks for.
 */
function bentAsAsked(graph: MeshGraph, patch: Uint32Array, g: FitGuide): Uint32Array {
  const { positions: p, normals: n, adjOffsets, adjList } = graph
  const bendAt = new Map<number, number>()
  for (let i = 0; i < patch.length; i++) {
    const v = patch[i]
    const j = v * 3
    let sum = 0
    let count = 0
    for (let e = adjOffsets[v]; e < adjOffsets[v + 1]; e++) {
      const k = adjList[e] * 3
      const dx = p[k] - p[j], dy = p[k + 1] - p[j + 1], dz = p[k + 2] - p[j + 2]
      const l2 = dx * dx + dy * dy + dz * dz
      if (!(l2 > 0)) continue
      sum += ((n[k] - n[j]) * dx + (n[k + 1] - n[j + 1]) * dy + (n[k + 2] - n[j + 2]) * dz) / l2
      count++
    }
    bendAt.set(v, count ? sum / count : 0)
  }
  const floor = g.radius?.max !== undefined ? 1 / (4 * g.radius.max) : 0.25 / graph.bboxDiag
  const sign = g.side === 'outside' ? 1 : g.side === 'inside' ? -1 : 0
  return keepWhere(patch, (v) => {
    let sum = bendAt.get(v)!
    let count = 1
    for (let e = adjOffsets[v]; e < adjOffsets[v + 1]; e++) {
      const b = bendAt.get(adjList[e])
      if (b === undefined) continue
      sum += b
      count++
    }
    const bend = sum / count
    return sign ? sign * bend > floor : Math.abs(bend) > floor
  })
}

/** The share of `idx` whose normals face the way `side` asks, against the
 *  outward direction `outward(v)` gives (the unit radial at the vertex). */
export function sideShare(
  graph: MeshGraph,
  idx: ArrayLike<number>,
  side: 'inside' | 'outside',
  outward: (x: number, y: number, z: number) => Vec3 | null,
): number {
  const { positions: p, normals: n } = graph
  const sign = side === 'outside' ? 1 : -1
  let good = 0
  let seen = 0
  const step = Math.max(1, Math.floor(idx.length / 400))
  for (let i = 0; i < idx.length; i += step) {
    const j = idx[i] * 3
    const o = outward(p[j], p[j + 1], p[j + 2])
    if (!o) continue
    seen++
    if (sign * (o[0] * n[j] + o[1] * n[j + 1] + o[2] * n[j + 2]) > 0) good++
  }
  return seen ? good / seen : 0
}

/** Vertices of `idx` that pass `keep`, as a new list. */
export function keepWhere(idx: ArrayLike<number>, keep: (v: number) => boolean): Uint32Array {
  const out: number[] = []
  for (let i = 0; i < idx.length; i++) if (keep(idx[i])) out.push(idx[i])
  return Uint32Array.from(out)
}

/** The candidates an estimate on a patch tries in turn when a guide is
 *  given: each one that the guide turns down takes its inliers out of the
 *  patch, and the next estimate runs on what is left — a cup's outside found
 *  first leaves its inside for the second try. */
export const GUIDED_TRIES = 4

/** Why a guided fit found nothing: the sizes it saw and turned down, said
 *  plainly with what to try — those in the radius range first, so a right
 *  size turned down for its noise is not crowded out by the junk a larger
 *  patch found. */
export function guideRefusal(kind: string, g: FitGuide, seen: GuideSeen[]): string {
  const range = g.radius
    ? `${g.radius.min !== undefined ? `R${g.radius.min}` : ''}–${g.radius.max !== undefined ? `R${g.radius.max}` : ''}`
    : ''
  const found = [...new Map(seen.map((s) => [`${s.radius.toFixed(2)} ${s.why}`, s])).values()]
    .sort((a, b) => Number(!radiusInRange(g, a.radius)) - Number(!radiusInRange(g, b.radius)))
    .slice(0, 3)
  const fixed = (v: readonly number[], d: number) => `[${v.map((x) => +x.toFixed(d)).join(', ')}]`
  const seenAs = (s: GuideSeen) =>
    s.axis && s.center
      ? `R${s.radius.toFixed(2)} (axis off by ${s.offDeg?.toFixed(1)}°: axis ${fixed(s.axis, 3)} through ${fixed(s.center, 2)}, ${s.inliers} points)`
      : `R${s.radius.toFixed(2)} (${s.why})`
  const said = found.length ? ` Found ${found.map(seenAs).join(', ')}.` : ''
  const offAxis = found.some((s) => s.axis) ? ' If that is the surface, give that axis or drop axis.' : ''
  return `No ${kind} there within the guide${range ? ` (radius ${range})` : ''}.${said}${offAxis} Seed on the surface itself, widen radius, or check side${g.within ? ' and within' : ''}.`
}

/** A size the guided search saw and turned down, and why — for a round
 *  whose axis lay off the guide's, that axis, a point on it, how far off it
 *  lay and how many points it held, so it can be asked for after all. */
export interface GuideSeen {
  radius: number
  why: string
  axis?: Vec3
  center?: Vec3
  offDeg?: number
  inliers?: number
}

/** A round turned down for its axis: see GuideSeen. */
export function axisOff(g: FitGuide, radius: number, axis: Vec3, center: Vec3, inliers: number): GuideSeen {
  const u = unitAxis(g)
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const a: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l]
  const cos = u ? Math.min(1, Math.abs(u[0] * a[0] + u[1] * a[1] + u[2] * a[2])) : 1
  return { radius, why: 'axis off', axis: a, center, offDeg: (Math.acos(cos) * 180) / Math.PI, inliers }
}

/**
 * The robust estimate on a patch, steered by the guide: the patch first
 * loses what the guide rules out (see guidePatch), then each estimate the
 * guide turns down — `judge` says why — takes its own surface out of the
 * patch (its inliers, and whatever `on` says lies on it) and the next runs on
 * what is left.
 */
export function guidedEstimate<C extends { inliers: Uint32Array }>(
  graph: MeshGraph,
  patch: Uint32Array,
  guide: FitGuide,
  estimate: (patch: Uint32Array) => C | null,
  judge: (c: C) => GuideSeen | null,
  on: (c: C, v: number) => boolean,
  seen: GuideSeen[],
): C | null {
  // A size without a side: the convex and the concave parts of the patch
  // are tried apart, the larger first — a robust estimate on the two shells
  // of a wall at once settles between them.
  const patches = guide.radius && !guide.side
    ? [guidePatch(graph, patch, { ...guide, side: 'outside' }), guidePatch(graph, patch, { ...guide, side: 'inside' })].sort((a, b) => b.length - a.length)
    : [guidePatch(graph, patch, guide)]
  for (let p of patches) {
    for (let t = 0; t < GUIDED_TRIES && p.length >= 30; t++) {
      const c = estimate(p)
      if (!c) break
      const refusal = judge(c)
      if (!refusal) return c
      seen.push(refusal)
      const gone = new Set(c.inliers)
      p = keepWhere(p, (v) => !gone.has(v) && !on(c, v))
    }
  }
  return null
}

/** The vertices a guided region grows from: the estimate's inliers that face
 *  the side asked for. */
export function guidedSeeds(
  graph: MeshGraph,
  inliers: Uint32Array,
  guide: FitGuide,
  outward: (x: number, y: number, z: number) => Vec3 | null,
): Uint32Array {
  if (!guide.side) return inliers
  const sign = guide.side === 'outside' ? 1 : -1
  const { positions: p, normals: n } = graph
  return keepWhere(inliers, (v) => {
    const j = v * 3
    const o = outward(p[j], p[j + 1], p[j + 2])
    return !!o && sign * (o[0] * n[j] + o[1] * n[j + 1] + o[2] * n[j + 2]) > 0
  })
}

/** Unit radial from a centre point. */
export const radialFrom = (cx: number, cy: number, cz: number) => (x: number, y: number, z: number): Vec3 | null => {
  const dx = x - cx, dy = y - cy, dz = z - cz
  const d = Math.hypot(dx, dy, dz)
  return d > 1e-12 ? [dx / d, dy / d, dz / d] : null
}

/** Unit radial off an axis line through (px, py, pz) along unit (ax, ay, az). */
export const radialOff = (px: number, py: number, pz: number, ax: number, ay: number, az: number) => (x: number, y: number, z: number): Vec3 | null => {
  const qx = x - px, qy = y - py, qz = z - pz
  const t = qx * ax + qy * ay + qz * az
  const wx = qx - t * ax, wy = qy - t * ay, wz = qz - t * az
  const d = Math.hypot(wx, wy, wz)
  return d > 1e-12 ? [wx / d, wy / d, wz / d] : null
}

/** The judge every round kind shares: size against the range (rough, for an
 *  estimate), side against the inliers' normals. */
export function judgeRound(
  graph: MeshGraph,
  guide: FitGuide,
  radius: number,
  inliers: ArrayLike<number>,
  outward: (x: number, y: number, z: number) => Vec3 | null,
  rough: boolean,
): GuideSeen | null {
  if (!radiusInRange(guide, radius, rough)) return { radius, why: 'size' }
  if (guide.side && sideShare(graph, inliers, guide.side, outward) < 0.6) {
    return { radius, why: guide.side === 'inside' ? 'an outside' : 'an inside' }
  }
  return null
}
