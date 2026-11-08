// SPDX-License-Identifier: AGPL-3.0-only
// Wrap: a ball rolled round the part from outside, the skin where it stopped
// — on the part where it touched, bridging every opening narrower than the
// gap, nothing of the inside left.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { NominalSurface, emptyHit } from '../../../src/core/deviation/surface'
import { closedness } from '../core/boolean'
import { signedVolume } from '../core/hollow'
import { loadSimplifier } from '../core/reduce'
import { defaultWrapGap, WrapMemo, wrapMesh, type WrapResult, type WrapSettings } from '../core/wrap'
import { runJob, type WrapRunner } from '../core/wrapJobs'
import { boxMesh, icosphere } from '../../../tests/helpers'

vi.setConfig({ testTimeout: 180_000 })

let simplifier: Awaited<ReturnType<typeof loadSimplifier>>
beforeAll(async () => {
  simplifier = await loadSimplifier()
})

type Vec3 = [number, number, number]

/** A box from `min` to `max` as a triangle soup, wound outward. */
function cuboid(min: Vec3, max: Vec3, grid = 4): Float32Array {
  const unit = boxMesh(2, grid)
  const out = new Float32Array(unit.length)
  for (let i = 0; i < unit.length; i++) {
    const k = i % 3
    out[i] = min[k] + ((unit[i] + 1) / 2) * (max[k] - min[k])
  }
  return out
}

/** Every triangle of a soup turned over. */
function flipped(soup: Float32Array): Float32Array {
  const out = soup.slice()
  for (let t = 0; t < out.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      out[t + 3 + k] = soup[t + 6 + k]
      out[t + 6 + k] = soup[t + 3 + k]
    }
  }
  return out
}

const joined = (...soups: Float32Array[]): Float32Array => {
  const out = new Float32Array(soups.reduce((n, s) => n + s.length, 0))
  let at = 0
  for (const s of soups) {
    out.set(s, at)
    at += s.length
  }
  return out
}

/** A soup welded, as the app opens it. */
const mesh = (soup: Float32Array) => buildMeshGraph({ kind: 'soup', positions: soup })

const wrap = (soup: Float32Array, settings: Partial<WrapSettings> & { gap: number }, runner?: WrapRunner): Promise<WrapResult> => {
  const g = mesh(soup)
  return wrapMesh(g.positions, g.indices, { grow: 0, edges: 'smooth', ...settings }, simplifier, undefined, runner)
}

/** Jobs done here but answered in a shuffled order, as a pool of workers
 *  might — the order fixed by `seed`. */
function shuffledRunner(seed: number): WrapRunner {
  let x = seed
  const random = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32)
  return {
    size: 4,
    run: (job) => {
      const result = runJob(job, simplifier)
      return new Promise((resolve) => setTimeout(() => resolve(result), random() * 3))
    },
    dispose: () => {},
  }
}

/** A wrap is always one closed, manifold skin per part, facing out. */
function expectSound(w: WrapResult) {
  const shut = closedness(w.indices, w.positions.length / 3)
  expect(shut.open).toBe(0)
  expect(shut.bad).toBe(0)
  expect(signedVolume(w.positions, w.indices)).toBeGreaterThan(0)
  expect(w.report.volume).toBeGreaterThan(0)
}

/** How far each of the wrap's vertices lies from the part's surface, mm. */
function offPart(w: WrapResult, soup: Float32Array): Float64Array {
  const g = mesh(soup)
  const surface = new NominalSurface(g.positions, g.indices)
  const hit = emptyHit()
  const n = w.positions.length / 3
  const out = new Float64Array(n)
  for (let v = 0; v < n; v++) {
    surface.closest(w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2], hit)
    out[v] = hit.distance
  }
  return out
}

describe('Wrap', () => {
  it('starts with a gap of a two-hundredth of the part on the 1-2-5 steps', async () => {
    expect(defaultWrapGap(200)).toBe(1)
    expect(defaultWrapGap(400)).toBe(2)
    expect(defaultWrapGap(30)).toBe(0.2)
  })

  it('wraps a ball to itself: every vertex on it, one shell', async () => {
    const ball = icosphere(4, 10)
    const soup = new Float32Array(ball.indices.length * 3)
    for (let i = 0; i < ball.indices.length; i++) soup.set(ball.positions.subarray(ball.indices[i] * 3, ball.indices[i] * 3 + 3), i * 3)
    const w = await wrap(soup, { gap: 1 })
    expectSound(w)
    expect(w.report.shells).toBe(1)
    const off = offPart(w, soup)
    // Snapped onto the ball's triangles, to a hundredth of the cell — all
    // but the odd vertex the fold guard held back where the grid put it,
    // which is within a quarter of a cell.
    const h = w.report.cell
    const near = off.filter((d) => d < 0.01 * h).length
    expect(near / off.length).toBeGreaterThan(0.999)
    expect(off.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(0.25 * h)
    expect(w.report.bridgedArea).toBeLessThan(0.001 * w.report.area)
    expect(w.report.dropped).toBe(0)
  })

  it('wraps a box with a box inside to one shell of the outer box, its faces on the part', async () => {
    const outer = cuboid([-10, -10, -10], [10, 10, 10], 6)
    const inner = cuboid([-4, -4, -4], [4, 4, 4], 4)
    const w = await wrap(joined(outer, inner), { gap: 1 })
    expectSound(w)
    expect(w.report.shells).toBe(1)
    // The edges are rounded by the grid's cell until Sharp rebuilds them.
    expect(w.report.volume).toBeGreaterThan(8000 * 0.995)
    expect(w.report.volume).toBeLessThan(8000 * 1.0001)
    // The inner box went: none of its triangles is in the wrap.
    expect(w.report.dropped).toBe(inner.length / 9)
    // No vertex is inside, and the triangles lying along a face lie on it —
    // exactly, but for vertices at its edges, which the grid rounds until
    // Sharp rebuilds them.
    let onFace = 0
    let exact = 0
    const p = w.positions
    for (let v = 0; v < p.length / 3; v++) expect(Math.max(Math.abs(p[v * 3]), Math.abs(p[v * 3 + 1]), Math.abs(p[v * 3 + 2]))).toBeGreaterThan(9.9)
    for (let t = 0; t < w.indices.length; t += 3) {
      const [a, b, c] = [w.indices[t] * 3, w.indices[t + 1] * 3, w.indices[t + 2] * 3]
      const u = [0, 1, 2].map((k) => p[b + k] - p[a + k]), q = [0, 1, 2].map((k) => p[c + k] - p[a + k])
      const n = [u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]]
      const len = Math.hypot(n[0], n[1], n[2])
      const axis = n.findIndex((x) => Math.abs(x) > 0.9999 * len)
      if (axis < 0) continue
      for (const v of [a, b, c]) {
        const off = Math.abs(Math.abs(p[v + axis]) - 10)
        expect(off).toBeLessThan(0.25 * w.report.cell)
        if (off < 1e-4) exact++
        onFace++
      }
    }
    expect(onFace).toBeGreaterThanOrEqual(36)
    expect(exact / onFace).toBeGreaterThan(0.9)
  })

  it('puts the edges and corners back with Edges: Sharp — a box wraps to itself, twelve triangles', async () => {
    const outer = cuboid([-10, -10, -10], [10, 10, 10], 6)
    const inner = cuboid([-4, -4, -4], [4, 4, 4], 4)
    const w = await wrap(joined(outer, inner), { gap: 1, edges: 'sharp' })
    expectSound(w)
    expect(w.report.shells).toBe(1)
    expect(w.report.sharpCorners).toBe(8)
    expect(w.report.volume).toBeCloseTo(8000, 2)
    const p = w.positions
    for (let v = 0; v < p.length / 3; v++) expect(Math.max(Math.abs(p[v * 3]), Math.abs(p[v * 3 + 1]), Math.abs(p[v * 3 + 2]))).toBeCloseTo(10, 4)
    expect(w.indices.length / 3).toBe(12)
  })

  it('leaves round what is round with Edges: Sharp: a ball, and a wrap grown', async () => {
    const ball = icosphere(4, 10)
    const soup = new Float32Array(ball.indices.length * 3)
    for (let i = 0; i < ball.indices.length; i++) soup.set(ball.positions.subarray(ball.indices[i] * 3, ball.indices[i] * 3 + 3), i * 3)
    const round = await wrap(soup, { gap: 1, edges: 'sharp' })
    expectSound(round)
    expect(round.report.sharpEdges).toBe(0)
    const grown = await wrap(cuboid([0, 0, 0], [10, 10, 10], 4), { gap: 2, grow: 0.25, edges: 'sharp' })
    expectSound(grown)
    expect(grown.report.sharpEdges + grown.report.sharpCorners).toBe(0)
  })

  it('bridges a slot narrower than the gap and follows one wider than it down', async () => {
    const gap = 2
    // A base plate with three blocks on it, a slot of 0.8 × the gap between
    // the first two and of 1.5 × the gap between the last two, 8 deep.
    const narrow = 0.8 * gap
    const wide = 1.5 * gap
    const base = cuboid([0, 0, 0], [40, 20, 4])
    const a = cuboid([0, 0, 3], [10, 20, 12])
    const b = cuboid([10 + narrow, 0, 3], [24, 20, 12])
    const c = cuboid([24 + wide, 0, 3], [40, 20, 12])
    const w = await wrap(joined(base, a, b, c), { gap })
    expectSound(w)
    // Sharp as well: closed, and the same but for the edges.
    const sharp = await wrap(joined(base, a, b, c), { gap, edges: 'sharp' })
    expectSound(sharp)
    expect(sharp.report.sharpEdges).toBeGreaterThan(0)
    expect(Math.abs(sharp.report.volume - w.report.volume)).toBeLessThan(5)
    expect(w.report.shells).toBe(1)
    expect(w.report.bridgedArea).toBeGreaterThan(0)
    // Nothing of the wrap goes down the narrow slot — away from its ends,
    // where the wrap bridges across it too.
    for (let v = 0; v < w.positions.length / 3; v++) {
      const x = w.positions[v * 3], y = w.positions[v * 3 + 1], z = w.positions[v * 3 + 2]
      if (z < 10 && y > 2 && y < 18) expect(x > 10.05 && x < 10 + narrow - 0.05).toBe(false)
    }
    // Bridged: about the narrow slot's mouth, 20 long.
    expect(w.report.bridgedArea).toBeGreaterThan(narrow * 20 * 0.5)
    // The part, the narrow slot filled — less the dip of the ball into its
    // mouth, more the rounds it leaves in the wide slot's inner corners, both
    // under 10 mm³ — and the wide slot open.
    const part = 40 * 20 * 4 + 20 * 8 * (10 + (24 - 10 - narrow) + (40 - 24 - wide))
    expect(w.report.volume).toBeGreaterThan(part + narrow * 20 * 8 - 15)
    expect(w.report.volume).toBeLessThan(part + narrow * 20 * 8 + 15)
  })

  it('makes overlapping, doubled and flipped shells one: their union', async () => {
    const a = cuboid([0, 0, 0], [10, 10, 10])
    const b = cuboid([5, 5, 5], [15, 15, 15])
    const w = await wrap(joined(a, b, a, flipped(b)), { gap: 0.5 })
    expectSound(w)
    expect(w.report.shells).toBe(1)
    const union = 1000 + 1000 - 125
    expect(w.report.volume).toBeGreaterThan(union * 0.99)
    expect(w.report.volume).toBeLessThan(union * 1.003)
  })

  it('refuses an open sheet at Grow by 0, and makes it a slab twice the growth thick', async () => {
    // A square sheet, 20 across, in the XY plane.
    const sheet = cuboid([-10, -10, -1], [10, 10, 1])
    const top: number[] = []
    for (let t = 0; t < sheet.length; t += 9) {
      if (sheet[t + 2] === 1 && sheet[t + 5] === 1 && sheet[t + 8] === 1) for (let k = 0; k < 9; k++) top.push(k % 3 === 2 ? 0 : sheet[t + k])
    }
    const soup = Float32Array.from(top)
    await expect(wrap(soup, { gap: 1 })).rejects.toThrow(/Nothing to wrap — the mesh is an open surface/)
    const w = await wrap(soup, { gap: 1, grow: 0.5 })
    expectSound(w)
    expect(w.report.shells).toBe(1)
    let zmin = Infinity, zmax = -Infinity
    for (let v = 2; v < w.positions.length; v += 3) {
      zmin = Math.min(zmin, w.positions[v])
      zmax = Math.max(zmax, w.positions[v])
    }
    expect(zmax).toBeCloseTo(0.5, 1)
    expect(zmin).toBeCloseTo(-0.5, 1)
    // 20 × 20 × 1, and a half-round of radius 0.5 along the 80 mm rim.
    const slab = 400 + 80 * Math.PI * 0.125
    expect(w.report.volume).toBeGreaterThan(slab * 0.97)
    expect(w.report.volume).toBeLessThan(slab * 1.03)
  })

  it('grows the wrap by Grow by all round: on the part grown, a face’s plane moved out', async () => {
    const a = 10, t = 0.25
    const w = await wrap(cuboid([0, 0, 0], [a, a, a], 4), { gap: 2, grow: t })
    expectSound(w)
    // The cube grown by t: its faces moved out, its edges and corners round.
    const exact = a ** 3 + 6 * a * a * t + 3 * Math.PI * a * t * t + (4 / 3) * Math.PI * t ** 3
    expect(w.report.volume).toBeGreaterThan(exact * 0.99)
    expect(w.report.volume).toBeLessThan(exact * 1.001)
    // Its vertices t off the cube — but for some along the edges, which the
    // grid rounds (a cell is more than t) and the snapping leaves where they
    // fold, within a quarter of a cell; the reduction leaves few others.
    const h = w.report.cell
    const off: number[] = []
    for (let v = 0; v < w.positions.length / 3; v++) {
      const d = [0, 1, 2].map((k) => Math.max(0, Math.abs(w.positions[v * 3 + k] - a / 2) - a / 2))
      off.push(Math.abs(Math.hypot(d[0], d[1], d[2]) - t))
    }
    expect(off.filter((x) => x < 0.01 * h).length / off.length).toBeGreaterThan(0.8)
    expect(Math.max(...off)).toBeLessThan(0.25 * h)
  })

  it('gives the same wrap for the same part every time', async () => {
    const soup = joined(cuboid([0, 0, 0], [10, 10, 10]), cuboid([5, 5, 5], [15, 15, 15]))
    const one = await wrap(soup, { gap: 0.8, grow: 0.1 })
    const two = await wrap(soup, { gap: 0.8, grow: 0.1 })
    expect(Array.from(two.indices)).toEqual(Array.from(one.indices))
    expect(Array.from(two.positions)).toEqual(Array.from(one.positions))
    expect(Array.from(two.bridge)).toEqual(Array.from(one.bridge))
    // However the tiles' answers come back.
    const three = await wrap(soup, { gap: 0.8, grow: 0.1 }, shuffledRunner(7))
    expect(Array.from(three.indices)).toEqual(Array.from(one.indices))
    expect(Array.from(three.positions)).toEqual(Array.from(one.positions))
  })

  it('makes another Grow by from the field it kept — the same wrap as made afresh', async () => {
    const g = mesh(joined(cuboid([0, 0, 0], [10, 10, 10]), cuboid([5, 5, 5], [15, 15, 15])))
    const memo = new WrapMemo()
    const at = (grow: number, kept?: WrapMemo) => wrapMesh(g.positions, g.indices, { gap: 0.8, grow, edges: 'smooth' }, simplifier, undefined, undefined, kept)
    const kept = (w: WrapResult) => w.report.stages.some((s) => s.name === 'Kept from the wrap before')
    expect(kept(await at(0.1, memo))).toBe(false)
    const again = await at(0.2, memo)
    expect(kept(again)).toBe(true)
    const fresh = await at(0.2)
    expect(Array.from(again.indices)).toEqual(Array.from(fresh.indices))
    expect(Array.from(again.positions)).toEqual(Array.from(fresh.positions))
    // Grown past what was measured, it measures again.
    expect(kept(await at(0.4, memo))).toBe(false)
    // And another mesh is measured afresh.
    const other = mesh(cuboid([0, 0, 0], [10, 10, 10]))
    const w = await wrapMesh(other.positions, other.indices, { gap: 0.8, grow: 0.4, edges: 'smooth' }, simplifier, undefined, undefined, memo)
    expect(kept(w)).toBe(false)
  })

  it('measures nothing the outside does not reach: a part inside a closed box costs no tile', async () => {
    const outer = cuboid([0, 0, 0], [40, 40, 40], 6)
    const inner = cuboid([16, 16, 16], [24, 24, 24], 4)
    const alone = await wrap(outer, { gap: 1 })
    const both = await wrap(joined(outer, inner), { gap: 1 })
    expect(both.report.tilesWorked).toBe(alone.report.tilesWorked)
    expect(both.report.dropped).toBe(inner.length / 9)
    expect(Array.from(both.positions)).toEqual(Array.from(alone.positions))
  })

  it('refuses a gap too fine for the part’s size, naming the smallest it can close', async () => {
    const soup = cuboid([0, 0, 0], [2000, 2000, 2000], 2)
    await expect(wrap(soup, { gap: 0.01 })).rejects.toThrow(/smallest gap that can be closed is/)
  })
})
