// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic point clouds with exact outward normals, and writers that put
// them in the file shapes scanners produce (PLY of three encodings, XYZ and
// its variants). Shared by the cloud reader, graph, fit and merge tests.

import type { Vec3 } from '../src/core/types'
import { type Rigid, rigidCompose, rigidFromAxisAngle, rigidApplyToPoints, rigidRotateVectors } from '../src/core/deviation/rigid'

export interface Cloud {
  positions: Float32Array
  normals: Float32Array
}

/** Small seeded generator, so a noisy fixture is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Builder {
  readonly p: number[] = []
  readonly n: number[] = []
  add(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.p.push(x, y, z)
    this.n.push(nx, ny, nz)
  }
  done(): Cloud {
    return { positions: Float32Array.from(this.p), normals: Float32Array.from(this.n) }
  }
}

/** Points -size/2…size/2 at `step`, both ends included. */
function ticks(size: number, step: number): number[] {
  const n = Math.max(1, Math.round(size / step))
  return Array.from({ length: n + 1 }, (_, i) => -size / 2 + (size * i) / n)
}

/** A flat square in z = 0 facing +z. `denseHalf` doubles the density for x >= 0. */
export function planeCloud(o: { size: number; step: number; noise?: number; seed?: number; denseHalf?: boolean }): Cloud {
  const rand = rng(o.seed ?? 1)
  const b = new Builder()
  const jitter = () => (o.noise ? (rand() - 0.5) * 2 * o.noise : 0)
  if (!o.denseHalf) {
    for (const x of ticks(o.size, o.step)) for (const y of ticks(o.size, o.step)) b.add(x, y, jitter(), 0, 0, 1)
  } else {
    for (const x of ticks(o.size, o.step).filter((v) => v < 0)) for (const y of ticks(o.size, o.step)) b.add(x, y, jitter(), 0, 0, 1)
    const fine = o.step / 2
    const nx = Math.round(o.size / 2 / fine)
    for (let i = 0; i <= nx; i++) for (const y of ticks(o.size, fine)) b.add(i * fine, y, jitter(), 0, 0, 1)
  }
  return b.done()
}

/** Rings of points on a cone about z, normals perpendicular to the surface. */
function ringsCloud(r1: number, r2: number, length: number, step: number, noise: number, seed: number): Cloud {
  const rand = rng(seed)
  const b = new Builder()
  const rings = Math.max(1, Math.round(length / step))
  const nzn = (r1 - r2) / length
  const len = Math.hypot(1, nzn)
  for (let k = 0; k <= rings; k++) {
    const f = k / rings
    const z = -length / 2 + length * f
    const r = r1 + (r2 - r1) * f
    const around = Math.max(8, Math.round((2 * Math.PI * r) / step))
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around
      const c = Math.cos(a)
      const s = Math.sin(a)
      const rr = r + (noise ? (rand() - 0.5) * 2 * noise : 0)
      b.add(rr * c, rr * s, z, c / len, s / len, nzn / len)
    }
  }
  return b.done()
}

/** A cylinder about z, normals pointing out. */
export function cylinderCloud(o: { radius: number; length: number; step: number; noise?: number }): Cloud {
  return ringsCloud(o.radius, o.radius, o.length, o.step, o.noise ?? 0, 2)
}

/** A cone about z, radius r1 at -length/2 and r2 at +length/2. */
export function coneCloud(o: { r1: number; r2: number; length: number; step: number }): Cloud {
  return ringsCloud(o.r1, o.r2, o.length, o.step, 0, 3)
}

/** A sphere on a Fibonacci spiral, normals pointing out. */
export function sphereCloud(o: { radius: number; step: number; noise?: number }): Cloud {
  const rand = rng(4)
  const b = new Builder()
  const count = Math.max(12, Math.round((4 * Math.PI * o.radius * o.radius) / (o.step * o.step)))
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count
    const q = Math.sqrt(1 - z * z)
    const a = golden * i
    const nx = q * Math.cos(a)
    const ny = q * Math.sin(a)
    const r = o.radius + (o.noise ? (rand() - 0.5) * 2 * o.noise : 0)
    b.add(r * nx, r * ny, r * z, nx, ny, z)
  }
  return b.done()
}

/** A box centred on the origin with a bore through it along z; the bore's
 *  normals point at the axis, the faces' away from the block. */
export function blockWithBoreCloud(o: { size: Vec3; boreRadius: number; step: number }): Cloud {
  const [sx, sy, sz] = o.size
  const b = new Builder()
  for (const s of [-1, 1]) {
    for (const y of ticks(sy, o.step)) for (const z of ticks(sz, o.step)) b.add(s * sx / 2, y, z, s, 0, 0)
    for (const x of ticks(sx, o.step)) for (const z of ticks(sz, o.step)) b.add(x, s * sy / 2, z, 0, s, 0)
    for (const x of ticks(sx, o.step)) {
      for (const y of ticks(sy, o.step)) {
        if (Math.hypot(x, y) > o.boreRadius + o.step / 2) b.add(x, y, s * sz / 2, 0, 0, s)
      }
    }
  }
  const bore = ringsCloud(o.boreRadius, o.boreRadius, sz, o.step, 0, 5)
  for (let i = 0; i < bore.positions.length; i += 3) {
    b.add(bore.positions[i], bore.positions[i + 1], bore.positions[i + 2], -bore.normals[i], -bore.normals[i + 1], -bore.normals[i + 2])
  }
  return b.done()
}

/** Two clouds from one, cut at 0 on `axis`, each reaching `overlap/2` past it. */
export function halves(c: Cloud, axis: 0 | 1 | 2, overlap: number): [Cloud, Cloud] {
  const lo = new Builder()
  const hi = new Builder()
  for (let i = 0; i < c.positions.length; i += 3) {
    const v = c.positions[i + axis]
    const args = [c.positions[i], c.positions[i + 1], c.positions[i + 2], c.normals[i], c.normals[i + 1], c.normals[i + 2]] as const
    if (v <= overlap / 2) lo.add(...args)
    if (v >= -overlap / 2) hi.add(...args)
  }
  return [lo.done(), hi.done()]
}

/** Triangles over a cloud laid out as an nu × nv grid, row by row (a
 *  plane or a cylinder's unrolled rings), for comparing cloud and mesh. */
export function triangulateGrid(_c: Cloud, nu: number, nv: number): Uint32Array {
  const out: number[] = []
  for (let j = 0; j + 1 < nv; j++) {
    for (let i = 0; i + 1 < nu; i++) {
      const a = j * nu + i
      out.push(a, a + 1, a + nu, a + 1, a + nu + 1, a + nu)
    }
  }
  return Uint32Array.from(out)
}

export interface PlyCloudOptions {
  /** x y z and the normals as double rather than float. */
  double?: boolean
  /** Extra vertex properties ("float quality") written before x y z. */
  extraBefore?: string[]
  /** Extra vertex properties written after the normals. */
  extraAfter?: string[]
  /** Declare `element face 0`. */
  faceZero?: boolean
  noNormals?: boolean
}

/** A value for an extra property, by its type: something that is not a normal. */
function extraValue(type: string, i: number): number {
  return /^(float|double)/.test(type) ? 0.25 + (i % 7) : 1 + (i % 200)
}

export function writePlyCloud(
  c: Cloud,
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian',
  opts: PlyCloudOptions = {},
): ArrayBuffer {
  const num = opts.double ? 'double' : 'float'
  const before = opts.extraBefore ?? []
  const after = opts.extraAfter ?? []
  const props = [
    ...before,
    `${num} x`, `${num} y`, `${num} z`,
    ...(opts.noNormals ? [] : [`${num} nx`, `${num} ny`, `${num} nz`]),
    ...after,
  ]
  const count = c.positions.length / 3
  const lines = ['ply', `format ${format} 1.0`, `element vertex ${count}`, ...props.map((p) => `property ${p}`)]
  if (opts.faceZero) lines.push('element face 0', 'property list uchar int vertex_indices')
  lines.push('end_header', '')
  const head = new TextEncoder().encode(lines.join('\n'))
  const types = props.map((p) => p.split(' ')[0])
  const rowOf = (i: number): number[] => {
    const p = [c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]]
    const n = opts.noNormals ? [] : [c.normals[i * 3], c.normals[i * 3 + 1], c.normals[i * 3 + 2]]
    return [
      ...before.map((e) => extraValue(e.split(' ')[0], i)),
      ...p, ...n,
      ...after.map((e) => extraValue(e.split(' ')[0], i)),
    ]
  }
  if (format === 'ascii') {
    const body = new TextEncoder().encode(Array.from({ length: count }, (_, i) => rowOf(i).join(' ')).join('\n') + '\n')
    const out = new Uint8Array(head.length + body.length)
    out.set(head)
    out.set(body, head.length)
    return out.buffer
  }
  const little = format === 'binary_little_endian'
  const size: Record<string, number> = { float: 4, double: 8, uchar: 1 }
  const stride = types.reduce((a, t) => a + size[t], 0)
  const out = new Uint8Array(head.length + count * stride)
  out.set(head)
  const dv = new DataView(out.buffer)
  let off = head.length
  for (let i = 0; i < count; i++) {
    rowOf(i).forEach((v, k) => {
      if (types[k] === 'float') dv.setFloat32(off, v, little)
      else if (types[k] === 'double') dv.setFloat64(off, v, little)
      else dv.setUint8(off, v)
      off += size[types[k]]
    })
  }
  return out.buffer
}

export interface XyzOptions {
  delim: ' ' | '\t' | ',' | ';'
  crlf?: boolean
  /** Lines written before the points, as given. */
  header?: string[]
  columns: 'xyzn' | 'xyz' | 'xyzrgb' | 'xyzrgbn' | 'xyzirgbn'
  /** The point count as the first line. */
  ptsCount?: boolean
}

export function writeXyz(c: Cloud, o: XyzOptions): ArrayBuffer {
  const count = c.positions.length / 3
  const lines: string[] = []
  if (o.ptsCount) lines.push(String(count))
  lines.push(...(o.header ?? []))
  for (let i = 0; i < count; i++) {
    const row: number[] = [c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]]
    const normal = [c.normals[i * 3], c.normals[i * 3 + 1], c.normals[i * 3 + 2]]
    const colour = [(i * 7) % 256, (i * 13) % 256, (i * 29) % 256]
    switch (o.columns) {
      case 'xyz': break
      case 'xyzn': row.push(...normal); break
      case 'xyzrgb': row.push(...colour); break
      case 'xyzrgbn': row.push(...colour, ...normal); break
      case 'xyzirgbn': row.push(0.5 + (i % 10) / 20, ...colour, ...normal); break
    }
    lines.push(row.join(o.delim))
  }
  const eol = o.crlf ? '\r\n' : '\n'
  return new TextEncoder().encode(lines.join(eol) + eol).buffer as ArrayBuffer
}

/** The rigid motion turning by `rotDeg` about x, then y, then z (degrees), then moving by `t`. */
export function rigidOf(rotDeg: Vec3, t: Vec3): Rigid {
  const rad = (d: number) => (d * Math.PI) / 180
  const rx = rigidFromAxisAngle([1, 0, 0], rad(rotDeg[0]))
  const ry = rigidFromAxisAngle([0, 1, 0], rad(rotDeg[1]))
  const rz = rigidFromAxisAngle([0, 0, 1], rad(rotDeg[2]))
  const m = rigidCompose(rz, rigidCompose(ry, rx))
  m.t.set(t)
  return m
}

export function applyRigidCloud(c: Cloud, r: Rigid): Cloud {
  const positions = c.positions.slice()
  const normals = c.normals.slice()
  rigidApplyToPoints(r, positions)
  rigidRotateVectors(r, normals)
  return { positions, normals }
}

/** A spur gear about z: `teeth` straight trapezoid teeth between rootRadius
 *  and tipRadius, `width` thick (z -width/2…width/2), a bore through it.
 *  Side walls face out of the material, the faces ±z, the bore the axis. */
export function gearCloud(o: { teeth: number; tipRadius: number; rootRadius: number; width: number; boreRadius: number; step: number }): Cloud {
  const { teeth, tipRadius: rt, rootRadius: rr, width, boreRadius, step } = o
  // The outline's radius at angle a: per tooth period, root, flank up, tip,
  // flank down, root.
  const radiusAt = (a: number): number => {
    const period = (2 * Math.PI) / teeth
    const f = ((a % period) + period) % period / period
    if (f < 0.1 || f >= 0.65) return rr
    if (f < 0.25) return rr + ((f - 0.1) / 0.15) * (rt - rr)
    if (f < 0.5) return rt
    return rt - ((f - 0.5) / 0.15) * (rt - rr)
  }
  // The outline as a fine polygon, walked at about `step`.
  const fine = Math.max(teeth * 40, Math.round((2 * Math.PI * rt) / (step / 4)))
  const poly: [number, number][] = []
  for (let i = 0; i < fine; i++) {
    const a = (2 * Math.PI * i) / fine
    const r = radiusAt(a)
    poly.push([r * Math.cos(a), r * Math.sin(a)])
  }
  const outline: { x: number; y: number; nx: number; ny: number }[] = []
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.round(len / step))
    // Counter-clockwise outline: out is the edge direction turned clockwise.
    const nx = (by - ay) / len
    const ny = -(bx - ax) / len
    for (let k = 0; k < n; k++) outline.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, nx, ny })
  }
  // Thin the outline back to about one point per step of arc.
  const b = new Builder()
  const kept: typeof outline = []
  let lastX = Infinity, lastY = Infinity
  for (const p of outline) {
    if (Math.hypot(p.x - lastX, p.y - lastY) < step * 0.999) continue
    kept.push(p)
    lastX = p.x
    lastY = p.y
  }
  for (const z of ticks(width, step)) for (const p of kept) b.add(p.x, p.y, z, p.nx, p.ny, 0)
  for (const s of [-1, 1]) {
    for (const x of ticks(2 * rt, step)) {
      for (const y of ticks(2 * rt, step)) {
        const r = Math.hypot(x, y)
        if (r > boreRadius + step / 2 && r < radiusAt(Math.atan2(y, x)) - step / 2) b.add(x, y, (s * width) / 2, 0, 0, s)
      }
    }
  }
  const bore = ringsCloud(boreRadius, boreRadius, width, step, 0, 6)
  for (let i = 0; i < bore.positions.length; i += 3) {
    b.add(bore.positions[i], bore.positions[i + 1], bore.positions[i + 2], -bore.normals[i], -bore.normals[i + 1], -bore.normals[i + 2])
  }
  return b.done()
}
