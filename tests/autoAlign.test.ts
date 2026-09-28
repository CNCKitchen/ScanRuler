// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { computeDatumAlignment, fitFromAlignPicks } from '../src/core/alignment'
import { autoAlign, autoAlignPicks, autoAlignRigid } from '../src/core/autoAlign'
import { rigidApply, rigidApplyToPoints, rigidFromAxisAngle, type Rigid } from '../src/core/deviation/rigid'
import { mulberry32 } from '../src/core/fit/ransac'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import type { MeshGraph, Vec3 } from '../src/core/types'
import { alignmentPreview, useStore } from '../src/state/store'
import { cylinderMesh, gaussian, icosphere } from './helpers'

type P3 = [number, number, number]

const lerp = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Triangle soup of a six-sided block through eight corners — `c[i]` with bit
 *  0 the x side, bit 1 the y side, bit 2 the z side — each face a grid with
 *  noise along its normal, the borders exact so the faces weld. `skip` leaves
 *  faces out: 0/1 the low/high x face, 2/3 y, 4/5 z. */
function blockMesh(c: P3[], grid: number, noise: number, seed: number, skip: number[] = []): Float32Array {
  const rand = mulberry32(seed)
  // Corner order per face, wound so the normal points out of the block.
  const faces = [
    [0, 4, 6, 2], [1, 3, 7, 5],
    [0, 1, 5, 4], [2, 6, 7, 3],
    [0, 2, 3, 1], [4, 5, 7, 6],
  ]
  const tris: number[] = []
  faces.forEach((f, fi) => {
    if (skip.includes(fi)) return
    const [a, b, d, e] = [c[f[0]], c[f[1]], c[f[2]], c[f[3]]]
    const u: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v: P3 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]]
    const n: P3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const l = Math.hypot(...n)
    const rows: P3[][] = []
    for (let i = 0; i <= grid; i++) {
      const row: P3[] = []
      for (let j = 0; j <= grid; j++) {
        const q = lerp(lerp(a, b, i / grid), lerp(e, d, i / grid), j / grid)
        const border = i === 0 || j === 0 || i === grid || j === grid
        const k = noise > 0 && !border ? (gaussian(rand) * noise) / l : 0
        row.push([q[0] + n[0] * k, q[1] + n[1] * k, q[2] + n[2] * k])
      }
      rows.push(row)
    }
    for (let i = 0; i < grid; i++)
      for (let j = 0; j < grid; j++) {
        tris.push(...rows[i][j], ...rows[i + 1][j], ...rows[i + 1][j + 1])
        tris.push(...rows[i][j], ...rows[i + 1][j + 1], ...rows[i][j + 1])
      }
  })
  return Float32Array.from(tris)
}

function cuboid(sx: number, sy: number, sz: number, at: P3 = [0, 0, 0]): P3[] {
  const out: P3[] = []
  for (let i = 0; i < 8; i++)
    out.push([at[0] + (i & 1 ? sx : -sx) / 2, at[1] + (i & 2 ? sy : -sy) / 2, at[2] + (i & 4 ? sz : -sz) / 2])
  return out
}

/** A pose no axis of which is anywhere near a global one. */
const POSE: Rigid = (() => {
  const m = rigidFromAxisAngle([0.3, -0.5, 0.81], 0.9)
  m.t.set([12, -7, 30])
  return m
})()

function posed(soup: Float32Array, pose: Rigid = POSE): MeshGraph {
  const moved = soup.slice()
  rigidApplyToPoints(pose, moved)
  return buildMeshGraph({ kind: 'soup', positions: moved })
}

/** Where a direction of the part as modelled points once posed. */
function posedDir(d: Vec3, pose: Rigid = POSE): Vec3 {
  const a = new Float64Array(3), o = new Float64Array(3)
  rigidApply(pose, d[0], d[1], d[2], a)
  rigidApply(pose, 0, 0, 0, o)
  return [a[0] - o[0], a[1] - o[1], a[2] - o[2]]
}

function posedPoint(q: Vec3, pose: Rigid = POSE): Vec3 {
  const a = new Float64Array(3)
  rigidApply(pose, q[0], q[1], q[2], a)
  return [a[0], a[1], a[2]]
}

const offDeg = (a: Vec3, b: Vec3) =>
  (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('auto alignment', () => {
  it('finds the frame of a noisy block and lays it on its largest face, long side along X', () => {
    const g = posed(blockMesh(cuboid(60, 40, 10), 40, 0.02, 3))
    const r = autoAlign(g)
    expect(r.method).toBe('planes')
    expect(r.base).toBe('face')
    expect(offDeg(r.axes[0], posedDir([1, 0, 0]))).toBeLessThan(0.05)
    expect(offDeg(r.axes[1], posedDir([0, 1, 0]))).toBeLessThan(0.05)
    expect(offDeg(r.axes[2], posedDir([0, 0, 1]))).toBeLessThan(0.05)
    expect(r.planeShare).toBeGreaterThan(0.7)
    // Zero lies on the face the part stands on, under the middle of the box.
    const onFace = [posedPoint([0, 0, -5]), posedPoint([0, 0, 5])]
    expect(Math.min(dist(r.origin, onFace[0]), dist(r.origin, onFace[1]))).toBeLessThan(0.05)
  })

  it('is a right-handed frame', () => {
    const r = autoAlign(posed(blockMesh(cuboid(60, 40, 10), 30, 0.02, 4)))
    const [x, y, z] = r.axes
    const c: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
    expect(dist(c, z)).toBeLessThan(1e-9)
  })

  it('stands an open scan on the side it is open on', () => {
    // A tall block with one small end missing: the largest face would lay it
    // on its side, the open end says it stood upright.
    const g = posed(blockMesh(cuboid(30, 20, 50), 30, 0.02, 5, [4]))
    const r = autoAlign(g)
    expect(r.base).toBe('open-side')
    const up = posedDir([0, 0, 1])
    expect(r.axes[2][0] * up[0] + r.axes[2][1] * up[1] + r.axes[2][2] * up[2]).toBeGreaterThan(0.9999)
    expect(dist(r.origin, posedPoint([0, 0, -25]))).toBeLessThan(0.05)
  })

  it('takes the flat rim of an open housing for the face it stands in for', () => {
    // A roof-shaped housing, open underneath: two 45° slopes, square to each
    // other and larger than anything else on it. With the base never scanned
    // the slopes and the ends make the best frame the surface knows of — and
    // the part would be laid on a slope. The rim it is open on says otherwise.
    const c = cuboid(40, 60, 20)
    for (const i of [4, 5, 6, 7]) c[i][1] += i & 2 ? -20 : 20
    const r = autoAlign(posed(blockMesh(c, 30, 0.01, 11, [4])))
    expect(r.base).toBe('open-side')
    const up = posedDir([0, 0, 1])
    expect(r.axes[2][0] * up[0] + r.axes[2][1] * up[1] + r.axes[2][2] * up[2]).toBeGreaterThan(0.99999)
    expect(offDeg(r.axes[0], posedDir([0, 1, 0]))).toBeLessThan(0.05)
    // Zero lies in the plane of the rim, which no scanned face lies in.
    expect(Math.abs(r.origin.reduce((sum, v, i) => sum + (v - posedPoint([0, 0, -10])[i]) * up[i], 0))).toBeLessThan(0.05)
  })

  it('weighs a ragged opening in by the way it faces, not by where its edge lies', () => {
    // The tall block again, its walls ending unevenly well short of the
    // bottom: the open edge is no plane and nowhere near flat, but the scan
    // is still open downwards and as wide open as the block is.
    const whole = blockMesh(cuboid(30, 20, 50), 40, 0.02, 12, [4])
    const kept: number[] = []
    for (let t = 0; t < whole.length; t += 9) {
      const x = (whole[t] + whole[t + 3] + whole[t + 6]) / 3
      const y = (whole[t + 1] + whole[t + 4] + whole[t + 7]) / 3
      const z = (whole[t + 2] + whole[t + 5] + whole[t + 8]) / 3
      if (z > -25 + 6 + 4 * Math.sin(x / 3) * Math.cos(y / 2)) kept.push(...whole.subarray(t, t + 9))
    }
    const r = autoAlign(posed(Float32Array.from(kept)))
    expect(r.base).toBe('open-side')
    const up = posedDir([0, 0, 1])
    expect(r.axes[2][0] * up[0] + r.axes[2][1] * up[1] + r.axes[2][2] * up[2]).toBeGreaterThan(0.9999)
  })

  it('does not take a closed part for an open one', () => {
    const r = autoAlign(posed(blockMesh(cuboid(30, 20, 50), 20, 0.02, 13)))
    expect(r.base).toBe('face')
  })

  it('stands a shaft on its axis, with zero on it', () => {
    const shaft = cylinderMesh(8, 50, 96, 40, 0.02).positions
    // Off-centre, so the middle of the box is not where the axis is by luck.
    const g = posed(shaft.map((v, i) => v + [3, -4, 0][i % 3]))
    const r = autoAlign(g)
    expect(r.method).toBe('axis')
    expect(offDeg(r.axes[2], posedDir([0, 0, 1]))).toBeLessThan(0.05)
    expect(r.onAxis).toBe(true)
    const ends = [posedPoint([3, -4, -25]), posedPoint([3, -4, 25])]
    expect(Math.min(dist(r.origin, ends[0]), dist(r.origin, ends[1]))).toBeLessThan(0.05)
  })

  it('is not turned by a lug the way the principal axes are', () => {
    const body = blockMesh(cuboid(80, 20, 20), 30, 0.02, 6)
    const lug = blockMesh(cuboid(14, 14, 14, [30, 17, 3]), 12, 0.02, 7)
    const soup = new Float32Array(body.length + lug.length)
    soup.set(body)
    soup.set(lug, body.length)
    const r = autoAlign(posed(soup))
    expect(offDeg(r.axes[0], posedDir([1, 0, 0]))).toBeLessThan(0.05)
    const others = [posedDir([0, 1, 0]), posedDir([0, 0, 1])]
    expect(Math.min(offDeg(r.axes[2], others[0]), offDeg(r.axes[2], others[1]))).toBeLessThan(0.05)
  })

  it('reads a twelve-triangle block, whose vertex normals point along no face', () => {
    const r = autoAlign(posed(blockMesh(cuboid(60, 40, 10), 1, 0, 1)))
    expect(r.method).toBe('planes')
    expect(offDeg(r.axes[0], posedDir([1, 0, 0]))).toBeLessThan(0.01)
    expect(offDeg(r.axes[2], posedDir([0, 0, 1]))).toBeLessThan(0.01)
  })

  it('reads a twelve-triangle plate, whose corner normals lean only a little off its large faces', () => {
    // Area-weighted, a corner's normal lies within ten degrees of the plate's
    // face — near enough to pass for it, and wrong.
    const r = autoAlign(posed(blockMesh(cuboid(100, 100, 10), 1, 0, 1)))
    expect(r.method).toBe('planes')
    expect(offDeg(r.axes[2], posedDir([0, 0, 1]))).toBeLessThan(0.01)
    expect(r.planeShare).toBeGreaterThan(0.99)
  })

  it('averages drafted walls onto the direction they lean about', () => {
    // The two x walls lean 2° inward towards the top; neither is square to
    // the floor, their mean is.
    const lean = 10 * Math.tan((2 * Math.PI) / 180)
    const c = cuboid(40, 30, 10)
    for (const i of [4, 5, 6, 7]) c[i][0] += i & 1 ? -lean : lean
    const r = autoAlign(posed(blockMesh(c, 30, 0.01, 8)))
    expect(offDeg(r.axes[0], posedDir([1, 0, 0]))).toBeLessThan(0.05)
    expect(offDeg(r.axes[2], posedDir([0, 0, 1]))).toBeLessThan(0.05)
  })

  it('falls back on the principal axes when the surface names no direction', () => {
    const ball = icosphere(4, 20)
    const r = autoAlign(buildMeshGraph({ kind: 'indexed', positions: ball.positions, indices: ball.indices }))
    expect(r.method).toBe('principal')
  })

  it('opens as a 3-2-1 alignment that reproduces it', () => {
    const r = autoAlign(posed(blockMesh(cuboid(60, 40, 10), 20, 0.02, 9)))
    const picks = autoAlignPicks(r, 15)
    const primary = fitFromAlignPicks('primary', picks.primary, 100, picks.primaryNormals)!
    const secondary = fitFromAlignPicks('secondary', picks.secondary, 100)!
    const origin = fitFromAlignPicks('origin', [picks.origin], 100)!
    const viaDatums = computeDatumAlignment(
      { fit: primary, axis: 'z-' },
      { fit: secondary, axis: 'x+' },
      origin,
    )
    const direct = autoAlignRigid(r)
    for (let i = 0; i < 9; i++) expect(viaDatums.r[i]).toBeCloseTo(direct.r[i], 9)
    for (let i = 0; i < 3; i++) expect(viaDatums.t[i]).toBeCloseTo(direct.t[i], 6)
  })

  it('opens the alignment editor filled in, and drops its note once a slot is filled by hand', () => {
    const r = autoAlign(posed(blockMesh(cuboid(60, 40, 10), 20, 0.02, 10)))
    useStore.getState().proposeAlignment(autoAlignPicks(r, 15), 'Read off the scan.')
    const draft = useStore.getState().alignDraft!
    expect(draft.proposal).toBe('Read off the scan.')
    expect([draft.primaryPicks.length, draft.secondaryPicks.length, draft.originPicks.length]).toEqual([3, 2, 1])
    expect([draft.primaryAxis, draft.secondaryAxis, draft.pickSlot]).toEqual(['z-', 'x+', null])
    // The editor previews exactly the proposal.
    const shown = alignmentPreview(draft, [], 100)
    const direct = autoAlignRigid(r)
    expect(shown.error).toBeNull()
    for (let i = 0; i < 9; i++) expect(shown.preview!.rigid.r[i]).toBeCloseTo(direct.r[i], 9)
    // Choosing another side keeps the note — it is still the proposal's face —
    // picking a slot again by hand does not.
    useStore.getState().setAlignmentAxis('primary', 'z+')
    expect(useStore.getState().alignDraft!.proposal).toBe('Read off the scan.')
    useStore.getState().beginAlignmentPick('secondary')
    expect(useStore.getState().alignDraft!.proposal).toBeUndefined()
    useStore.getState().cancelAlignment()
  })
})
