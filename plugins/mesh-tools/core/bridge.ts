// SPDX-License-Identifier: AGPL-3.0-only
import { Box3, Triangle, Vector3 } from 'three'
import { ExtendedTriangle } from 'three-mesh-bvh'
import type { Vec3 } from '../../../src/core/types'
import { boundaryLoops, type BoundaryLoop } from './boundary'
import type { EditedMesh } from './edit'

export interface BridgeSettings {
  /** Surface samples ordered across the gap, 2 or more per side, 10 total at most. */
  points: Vec3[]
  /** Samples on the first side. Defaults to 3 for existing six-point callers. */
  firstSideCount?: number
  /** Approximate width along each attachment rim, mm. */
  width: number
  /** 0 is a straight centreline, 1 preserves the sampled bow. */
  bend?: number
}

export interface BridgeReport {
  triangles: number
  span: number
  width: number
  /** Maximum distance from an inner sample to its attachment vertex. */
  snap: number
}

export interface BridgeResult extends EditedMesh {
  report: BridgeReport
}

export interface BridgeGuidance {
  message: string
  points: number[]
  targets?: { index: number; point: Vec3 }[]
  canReduceBend?: boolean
}

export class BridgeGuidanceError extends Error {
  constructor(message: string, readonly guidance: BridgeGuidance) {
    super(message)
  }
}

const v3 = (p: Vec3) => new Vector3(...p)

function intersects(a: ExtendedTriangle, b: Triangle, tolerance: number): boolean {
  if (!a.intersectsTriangle(b)) return false
  // The library can report disjoint, nearly coplanar triangles as intersecting.
  // Certify positive hits with separating axes, including in-plane edge normals.
  const vertices = [a.a, a.b, a.c, b.a, b.b, b.c].map((p) => p.clone().sub(a.a))
  const edges = (start: number) => [0, 1, 2].map((i) => vertices[start + (i + 1) % 3].clone().sub(vertices[start + i]))
  const ea = edges(0), eb = edges(3)
  const na = ea[0].clone().cross(ea[1]), nb = eb[0].clone().cross(eb[1])
  const axes = [
    na, nb,
    ...ea.flatMap((u) => eb.map((v) => u.clone().cross(v))),
    ...ea.map((u) => na.clone().cross(u)),
    ...eb.map((u) => nb.clone().cross(u)),
  ]
  for (const axis of axes) {
    if (axis.lengthSq() < 1e-24) continue
    axis.normalize()
    const ap = vertices.slice(0, 3).map((p) => p.dot(axis))
    const bp = vertices.slice(3).map((p) => p.dot(axis))
    if (Math.max(...ap) < Math.min(...bp) - tolerance || Math.max(...bp) < Math.min(...ap) - tolerance) return false
  }
  return true
}

/** A ribbon joining two disjoint runs of one boundary, splitting that rim
 *  into two closed loops. Every attachment edge reuses the scan's vertices;
 *  the rest of the scan is unchanged. */
export function bridgeGap(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  settings: BridgeSettings,
): BridgeResult {
  const { points, width, firstSideCount = 3, bend = 1 } = settings
  if (!Number.isFinite(bend) || bend < 0 || bend > 1) throw new Error('Bridge bend must be between zero and one.')
  if (!Number.isInteger(firstSideCount) || firstSideCount < 2 || points.length - firstSideCount < 2 || points.length > 10) {
    throw new Error('Pick at least two points on each side, at most ten total, and specify the first-side count (3 by default).')
  }
  if (points.some((p) => p.length !== 3 || p.some((x) => !Number.isFinite(x)))) {
    throw new Error('All bridge reference points must have three finite coordinates.')
  }
  if (!(width > 0) || !Number.isFinite(width)) throw new Error('The bridge width must be finite and more than zero.')
  const at = (i: number) => new Vector3().fromArray(positions, i * 3)
  const samples = points.map(v3)
  const allPoints = points.map((_, i) => i)
  const fail = (message: string, advice: string, affected = allPoints, targets?: BridgeGuidance['targets'], canReduceBend = false): never => {
    throw new BridgeGuidanceError(message, { message: `${message} ${advice}`, points: affected, targets, canReduceBend })
  }
  const inner = firstSideCount - 1
  const axis = samples[firstSideCount].clone().sub(samples[inner])
  const distance = axis.length()
  if (distance < 1e-6) fail('The two inner points must be on opposite sides of a gap.', `Place points ${inner + 1} and ${firstSideCount + 1} on opposite rims.`, [inner, firstSideCount])
  axis.divideScalar(distance)
  const x = samples.map((p) => p.clone().sub(samples[inner]).dot(axis))
  for (let i = 1; i < x.length; i++) {
    if (x[i] - x[i - 1] < distance * 1e-5) {
      fail('Pick points in order along the crossing: toward the rim on the first side, then away from the opposite rim on the other.',
        `Check points ${i} and ${i + 1}: point ${i} must come before point ${i + 1} along the crossing. No automatic move is suggested.`, [i - 1, i])
    }
  }

  const boundary = boundaryLoops(indices, vertexCount)
  const nearest = (p: Vector3) => {
    let best = { loop: -1, index: -1, distance: Infinity }
    boundary.loops.forEach((loop, li) => {
      loop.vertices.forEach((v, i) => {
        const d = at(v).distanceTo(p)
        if (d < best.distance) best = { loop: li, index: i, distance: d }
      })
    })
    return best
  }
  const left = nearest(samples[inner])
  const right = nearest(samples[firstSideCount])
  if (left.loop < 0 || right.loop < 0) throw new Error('No usable boundary loop was found. Repair inconsistent mesh edges first.')
  if (Math.max(left.distance, right.distance) > width * 2) {
    const targets = [{ index: inner, attachment: left }, { index: firstSideCount, attachment: right }]
      .filter(({ attachment }) => attachment.distance > width * 2)
      .map(({ index, attachment }) => ({ index, point: at(boundary.loops[attachment.loop].vertices[attachment.index]).toArray() as Vec3 }))
    fail('The inner points are too far from an open rim. Pick closer to the gap, or increase the bridge width.',
      `Move highlighted point${targets.length > 1 ? 's' : ''} ${targets.map((t) => t.index + 1).join(', ')} toward the diamond rim targets. Targets mark nearest boundary vertices, not a guaranteed valid bridge.`,
      targets.map((t) => t.index), targets)
  }
  if (left.loop !== right.loop) {
    fail('The two attachments must lie on the same open rim to enclose a hole. Separate pieces are not supported by this bridge tool.',
      `Check attachment points ${inner + 1} and ${firstSideCount + 1}; select opposite sides of one opening, not separate pieces.`, [inner, firstSideCount])
  }
  const loop = boundary.loops[left.loop]
  const arc = (centre: number): number[] => {
    const n = loop.vertices.length
    const step = (sign: number) => {
      const run: number[] = []
      let walked = 0
      let i = centre
      while (walked < width / 2) {
        const next = (i + sign + n) % n
        walked += at(loop.vertices[i]).distanceTo(at(loop.vertices[next]))
        run.push(loop.vertices[next])
        i = next
        if (run.length >= n / 2 || run.length > 128) {
          throw new Error('The bridge is too wide for this rim, or spans too many boundary edges. Choose a narrower bridge.')
        }
      }
      return run
    }
    return [...step(-1).reverse(), loop.vertices[centre], ...step(1)]
  }
  const a = arc(left.index)
  const b = arc(right.index).reverse()
  const used = new Set(a)
  if (b.some((v) => used.has(v))) fail('The attachment runs overlap. Move the points apart or choose a narrower bridge.',
    `Separate attachment points ${inner + 1} and ${firstSideCount + 1}, or reduce Bridge width.`, [inner, firstSideCount])

  const normalOf = (vertices: number[], rim: BoundaryLoop) => {
    const normal = new Vector3()
    const starts = new Set(vertices)
    for (let i = 0; i < rim.vertices.length; i++) {
      const u = rim.vertices[i], v = rim.vertices[(i + 1) % rim.vertices.length]
      if (!starts.has(u) || !starts.has(v)) continue
      normal.add(at(v).sub(at(u)).cross(at(rim.opposite[i]).sub(at(u))))
    }
    if (normal.lengthSq() < 1e-20) throw new Error('The attachment rim has no stable surface normal.')
    return normal.normalize()
  }
  const na = normalOf(a, loop), nb = normalOf(b, loop)
  if (na.dot(nb) < 0.5) throw new Error('The two sides face different ways. This tool is for flat or gently curved surfaces.')
  const normal = na.clone().add(nb).normalize()

  const fractions = (row: number[]) => {
    const s = [0]
    for (let i = 1; i < row.length; i++) s.push(s[i - 1] + at(row[i]).distanceTo(at(row[i - 1])))
    const total = s[s.length - 1]
    if (!(total > 0)) throw new Error('An attachment has zero-length boundary edges.')
    return s.map((t) => t / total)
  }
  const sa = fractions(a), sb = fractions(b)
  const onArc = (row: number[], s: number[], t: number) => {
    let i = 0
    while (i < row.length - 2 && s[i + 1] < t) i++
    if (s[i + 1] - s[i] < 1e-12) throw new Error('An attachment has repeated boundary points.')
    return at(row[i]).lerp(at(row[i + 1]), (t - s[i]) / (s[i + 1] - s[i]))
  }
  const ca = onArc(a, sa, 0.5), cb = onArc(b, sb, 0.5)
  const span = ca.distanceTo(cb)
  if (span < width / 2) throw new Error('The bridge width is too large relative to its span.')
  // Two samples give a secant; more give a least-squares quadratic slope.
  // Normalizing each side avoids high-degree interpolation and scale instability.
  const derivative = (start: number, end: number, atIndex: number) => {
    const d = new Vector3()
    if (end - start === 2) {
      d.copy(samples[start + 1]).sub(samples[start]).divideScalar(x[start + 1] - x[start])
    } else {
      const scale = x[end - 1] - x[start]
      const t = x.slice(start, end).map((value) => (value - x[atIndex]) / scale)
      const mean = t.reduce((sum, value) => sum + value, 0) / t.length
      const mean2 = t.reduce((sum, value) => sum + value * value, 0) / t.length
      let uu = 0, uv = 0, vv = 0
      for (const value of t) {
        const u = value - mean, v = value * value - mean2
        uu += u * u
        uv += u * v
        vv += v * v
      }
      const det = uu * vv - uv * uv
      if (!(det > uu * vv * 1e-12)) fail('The reference points are too clustered for a stable surface slope. Spread them out on each side.',
        `Spread points ${start + 1}–${end} farther apart along existing surface.`, allPoints.slice(start, end))
      t.forEach((value, i) => {
        const weight = ((value - mean) * vv - (value * value - mean2) * uv) / (det * scale)
        d.addScaledVector(samples[start + i].clone().sub(samples[atIndex]), weight)
      })
    }
    const chord = cb.clone().sub(ca)
    const projectedSpan = chord.dot(axis)
    const tangent = chord.clone().lerp(d.multiplyScalar(projectedSpan), bend)
    if (tangent.length() > Math.abs(projectedSpan) * 3) fail('The reference points imply too much bending. Pick a straighter surface profile.',
      `Check points ${start + 1}–${end} on this side; spread them along the intended surface profile. There is no single verified move direction.`, allPoints.slice(start, end), undefined, true)
    return tangent
  }
  const ta = derivative(0, firstSideCount, inner), tb = derivative(firstSideCount, samples.length, firstSideCount)
  const spacing = Math.min(width / 2, span / 4, ca.distanceTo(at(a[0])), cb.distanceTo(at(b[0])))
  if (!(spacing > 1e-6)) throw new Error('The attachment width is too small to triangulate.')
  const rows = Math.max(2, Math.ceil(span / spacing))
  const columns = Math.max(a.length, b.length)
  if (rows * columns * 2 > 20_000) throw new Error('This bridge would need more than 20,000 triangles. Increase its width or reduce the crossing span.')
  const p = Array.from(positions)
  const patch: number[] = []
  let previous = a
  let previousS = sa
  const connect = (u: number[], us: number[], v: number[], vs: number[]) => {
    const start = patch.length
    let i = 0, j = 0
    while (i < u.length - 1 || j < v.length - 1) {
      if (j === v.length - 1 || (i < u.length - 1 && us[i + 1] <= vs[j + 1])) {
        patch.push(u[i], v[j], u[i + 1])
        i++
      } else {
        patch.push(u[i], v[j], v[j + 1])
        j++
      }
    }
    const tri = new Triangle()
    const faceNormal = new Vector3()
    const triangleCost = (a: number, b: number, c: number) => {
      tri.a.fromArray(p, a * 3)
      tri.b.fromArray(p, b * 3)
      tri.c.fromArray(p, c * 3)
      const area = tri.getArea()
      if (area < spacing ** 2 * 1e-8 || tri.getNormal(faceNormal).dot(normal) <= 0.05) return Infinity
      return (tri.a.distanceToSquared(tri.b) + tri.b.distanceToSquared(tri.c) + tri.c.distanceToSquared(tri.a)) / area
    }
    let valid = true
    for (let k = start; k < patch.length; k += 3) {
      if (!Number.isFinite(triangleCost(patch[k], patch[k + 1], patch[k + 2]))) { valid = false; break }
    }
    if (valid) return
    // At an oblique, uneven rim the arc-length zipper can choose an inverted
    // diagonal even when the same rows admit a clean triangulation.
    const count = u.length * v.length
    const cost = new Float64Array(count).fill(Infinity)
    const steps = new Uint8Array(count)
    cost[0] = 0
    const stride = v.length
    for (let a = 0; a < u.length; a++) for (let b = 0; b < v.length; b++) {
      const index = a * stride + b
      if (!Number.isFinite(cost[index])) continue
      if (a + 1 < u.length) {
        const next = index + stride
        const value = cost[index] + triangleCost(u[a], v[b], u[a + 1])
        if (value < cost[next]) { cost[next] = value; steps[next] = 1 }
      }
      if (b + 1 < v.length) {
        const next = index + 1
        const value = cost[index] + triangleCost(u[a], v[b], v[b + 1])
        if (value < cost[next]) { cost[next] = value; steps[next] = 2 }
      }
    }
    if (!Number.isFinite(cost[count - 1])) return
    const replacement: number[] = []
    let a = u.length - 1, b = v.length - 1
    while (a || b) {
      if (steps[a * stride + b] === 1) {
        replacement.push(u[a - 1], v[b], u[a])
        a--
      } else {
        replacement.push(u[a], v[b - 1], v[b])
        b--
      }
    }
    patch.length = start
    for (let k = replacement.length - 3; k >= 0; k -= 3) patch.push(replacement[k], replacement[k + 1], replacement[k + 2])
  }
  for (let r = 1; r <= rows; r++) {
    const t = r / rows
    let row: number[], s: number[]
    if (r === rows) {
      row = b
      s = sb
    } else {
      const centre = ca.clone().multiplyScalar(2 * t ** 3 - 3 * t ** 2 + 1)
        .addScaledVector(ta, t ** 3 - 2 * t ** 2 + t)
        .addScaledVector(cb, -2 * t ** 3 + 3 * t ** 2)
        .addScaledVector(tb, t ** 3 - t ** 2)
      s = Array.from({ length: columns }, (_, i) => i / (columns - 1))
      row = s.map((q) => {
        const sideA = onArc(a, sa, q).sub(ca)
        const sideB = onArc(b, sb, q).sub(cb)
        const point = centre.clone().addScaledVector(sideA, 1 - t).addScaledVector(sideB, t)
        const id = p.length / 3
        p.push(point.x, point.y, point.z)
        return id
      })
    }
    connect(previous, previousS, row, s)
    previous = row
    previousS = s
  }
  const outPositions = Float32Array.from(p)
  const triangles: ExtendedTriangle[] = []
  const interiors: ExtendedTriangle[] = []
  const boxes: Box3[] = []
  const bridgeBounds = new Box3()
  for (let i = 0; i < patch.length; i += 3) {
    const point = (k: number) => new Vector3().fromArray(outPositions, patch[i + k] * 3)
    const tri = new ExtendedTriangle(point(0), point(1), point(2))
    if (tri.getArea() < spacing ** 2 * 1e-8 || tri.getNormal(new Vector3()).dot(normal) <= 0.05) {
      fail('The bridge folds or twists at the rim. Reposition the points or narrow the bridge.',
        'The highlighted guides influence this shape; no individual point or exact move is proven. Reduce width or adjust the profile, then preview again.', allPoints, undefined, true)
    }
    const box = new Box3().setFromPoints([tri.a, tri.b, tri.c])
    bridgeBounds.union(box)
    boxes.push(box)
    // Shared rim contacts are intentional; test interiors for overlap.
    const centre = tri.getMidpoint(new Vector3())
    interiors.push(new ExtendedTriangle(tri.a.clone().lerp(centre, 1e-5), tri.b.clone().lerp(centre, 1e-5), tri.c.clone().lerp(centre, 1e-5)))
    triangles.push(tri)
  }
  const scanTriangle = new Triangle()
  const scanBox = new Box3()
  const sharesVertex = (offset: number, other: ArrayLike<number>, otherOffset: number) => {
    for (let k = 0; k < 3; k++) {
      for (let l = 0; l < 3; l++) if (patch[offset + k] === other[otherOffset + l]) return true
    }
    return false
  }
  for (let i = 0; i < indices.length; i += 3) {
    scanTriangle.a.fromArray(positions, indices[i] * 3)
    scanTriangle.b.fromArray(positions, indices[i + 1] * 3)
    scanTriangle.c.fromArray(positions, indices[i + 2] * 3)
    scanBox.makeEmpty().expandByPoint(scanTriangle.a).expandByPoint(scanTriangle.b).expandByPoint(scanTriangle.c)
    if (!bridgeBounds.intersectsBox(scanBox)) continue
    for (let j = 0; j < triangles.length; j++) {
      if (!boxes[j].intersectsBox(scanBox)) continue
      const shared = sharesVertex(j * 3, indices, i)
      const probe = shared ? interiors[j] : triangles[j]
      if (intersects(probe, scanTriangle, spacing * 1e-9)) {
        fail('The proposed bridge intersects existing surface. Move the reference points or choose a narrower bridge.',
          'Check the highlighted guides and reduce width or adjust the crossing. No single offending point or safe direction is known.')
      }
    }
  }
  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      if (!boxes[i].intersectsBox(boxes[j])) continue
      const shared = sharesVertex(i * 3, patch, j * 3)
      const probe = shared ? interiors[i] : triangles[i]
      if (intersects(probe, shared ? interiors[j] : triangles[j], spacing * 1e-9)) {
        fail('The proposed bridge intersects itself. Reposition the reference points.',
          'Check the highlighted guides for excessive bending. No single offending point or safe direction is known.', allPoints, undefined, true)
      }

    }
  }
  const outIndices = new Uint32Array(indices.length + patch.length)
  outIndices.set(indices)
  outIndices.set(patch, indices.length)
  const after = boundaryLoops(outIndices, p.length / 3)
  if (after.stray !== boundary.stray || after.loops.length !== boundary.loops.length + 1) {
    throw new Error('The bridge could not create two clean boundary loops. Repair the local mesh boundary first.')
  }
  return {
    positions: outPositions,
    indices: outIndices,
    vertexMap: Int32Array.from({ length: vertexCount }, (_, i) => i),
    report: { triangles: patch.length / 3, span, width, snap: Math.max(left.distance, right.distance) },
  }
}

/** Bounded search, not an exact global curvature maximum. Every accepted
 * candidate passes the same complete checks used by Apply. */
export function reduceBridgeBend(
  positions: Float32Array, indices: Uint32Array, vertexCount: number, settings: BridgeSettings,
): { result: BridgeResult; bend: number } {
  const original = settings.bend ?? 1
  try { return { result: bridgeGap(positions, indices, vertexCount, settings), bend: original } }
  catch (error) {
    if (!(error instanceof BridgeGuidanceError) || !error.guidance.canReduceBend) throw error
  }
  const candidate = (bend: number): BridgeResult | null => {
    try { return bridgeGap(positions, indices, vertexCount, { ...settings, bend }) }
    catch (error) {
      if (error instanceof BridgeGuidanceError) return null
      throw error
    }
  }
  for (let step = 1; step <= 8; step++) {
    let low = original * (1 - step / 8), high = original * (1 - (step - 1) / 8)
    let result = candidate(low)
    if (!result) continue
    for (let i = 0; i < 6; i++) {
      const middle = (low + high) / 2
      const checked = candidate(middle)
      if (checked) { low = middle; result = checked }
      else high = middle
    }
    return { result, bend: low }
  }
  throw new Error('Reducing the bend found no valid bridge with these attachments and width. Original settings were kept. Move the attachment points or reduce the width, then preview again.')
}
