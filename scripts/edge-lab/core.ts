// SPDX-License-Identifier: AGPL-3.0-only
// Shared building blocks for the edge lab: the production Canny pipeline
// taken apart so the candidate detectors can reuse its blur, gradients, NMS,
// hysteresis, chain walk and subpixel refinement while swapping one stage.
// The defaults reproduce src/core/flat/edges.ts exactly.
import type { EdgeChains } from '../../src/core/flat/edges'

export interface Gradients { gx: Float32Array; gy: Float32Array; mag: Float32Array; width: number; height: number }

export function gaussianBlur(gray: ArrayLike<number>, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma))
  const kernel = new Float32Array(2 * radius + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = v; sum += v }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * gray[row + Math.min(width - 1, Math.max(0, x + k))]
      tmp[row + x] = acc
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x]
      out[y * width + x] = acc
    }
  }
  return out
}

export function sobel(img: Float32Array, width: number, height: number): Gradients {
  const n = width * height
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n)
  for (let y = 1; y < height - 1; y++) {
    const r0 = (y - 1) * width, r1 = y * width, r2 = (y + 1) * width
    for (let x = 1; x < width - 1; x++) {
      const a = img[r0 + x - 1], b = img[r0 + x], c = img[r0 + x + 1]
      const d = img[r1 + x - 1], f = img[r1 + x + 1]
      const g = img[r2 + x - 1], h = img[r2 + x], i = img[r2 + x + 1]
      const sx = c + 2 * f + i - (a + 2 * d + g)
      const sy = g + 2 * h + i - (a + 2 * b + c)
      gx[r1 + x] = sx; gy[r1 + x] = sy; mag[r1 + x] = Math.hypot(sx, sy)
    }
  }
  return { gx, gy, mag, width, height }
}

/** Sampled magnitude quantile function, as the production thresholds use. */
export function magQuantiles(mag: Float32Array): (t: number) => number {
  const n = mag.length
  const sample: number[] = []
  const stride = Math.max(1, Math.floor(n / 400_000))
  for (let i = 0; i < n; i += stride) if (mag[i] > 0) sample.push(mag[i])
  sample.sort((a, b) => a - b)
  return (t: number) => sample.length ? sample[Math.min(sample.length - 1, Math.floor(t * sample.length))] : 0
}

export function autoThresholds(mag: Float32Array, sensitivity: number): { low: number; high: number } {
  const q = magQuantiles(mag)
  const base = q(0.6), strong = q(0.995)
  const high = base + (strong - base) * (0.5 - 0.42 * sensitivity)
  return { low: 0.4 * high, high }
}

export const NONE = 0, WEAK = 1, STRONG = 2

export function nms(g: Gradients, low: number, high: number): Uint8Array {
  const { gx, gy, mag, width, height } = g
  const mark = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const m = mag[i]
      if (m < low) continue
      const ax = Math.abs(gx[i]), ay = Math.abs(gy[i])
      let m1: number, m2: number
      if (ax >= 2.4142 * ay) { m1 = mag[i - 1]; m2 = mag[i + 1] }
      else if (ay >= 2.4142 * ax) { m1 = mag[i - width]; m2 = mag[i + width] }
      else if (gx[i] * gy[i] > 0) { m1 = mag[i - width - 1]; m2 = mag[i + width + 1] }
      else { m1 = mag[i - width + 1]; m2 = mag[i + width - 1] }
      if (m >= m1 && m >= m2) mark[i] = m >= high ? STRONG : WEAK
    }
  }
  return mark
}

export function hysteresis(mark: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height
  const kept = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (mark[i] === STRONG && !kept[i]) {
      kept[i] = 1; stack.push(i)
      while (stack.length) {
        const p = stack.pop()!
        const px = p % width
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (px + dx < 0 || px + dx >= width) continue
          const q2 = p + dy * width + dx
          if (q2 < 0 || q2 >= n) continue
          if (mark[q2] !== NONE && !kept[q2]) { kept[q2] = 1; stack.push(q2) }
        }
      }
    }
  }
  return kept
}

/** The production chain walk over a binary edge-pixel map: pixel-index chains. */
export function traceChains(kept: Uint8Array, width: number, height: number): number[][] {
  const n = width * height
  const neighborOf = (p: number, k: number): number => {
    const dx = (k % 3) - 1, dy = Math.floor(k / 3) - 1
    const px = p % width
    if (px + dx < 0 || px + dx >= width) return -1
    const q = p + dy * width + dx
    return q >= 0 && q < n ? q : -1
  }
  const degree = (p: number): number => {
    let d = 0
    for (let k = 0; k < 9; k++) { if (k === 4) continue; const q = neighborOf(p, k); if (q >= 0 && kept[q]) d++ }
    return d
  }
  const visited = new Uint8Array(n)
  const chains: number[][] = []
  const walk = (start: number) => {
    const chain = [start]
    visited[start] = 1
    let cur = start, dx = 0, dy = 0
    for (;;) {
      const cx = cur % width
      let best = -1, bestScore = -Infinity
      for (let k = 0; k < 9; k++) {
        if (k === 4) continue
        const q = neighborOf(cur, k)
        if (q < 0 || !kept[q] || visited[q]) continue
        const ox = (k % 3) - 1, oy = Math.floor(k / 3) - 1
        const len = Math.hypot(ox, oy)
        const score = dx === 0 && dy === 0 ? -len : (dx * ox + dy * oy) / len
        if (score > bestScore) { bestScore = score; best = q }
      }
      if (best < 0 || (bestScore < -0.5 && (dx !== 0 || dy !== 0))) break
      const bx = best % width
      const ox = bx - cx, oy = (best - bx) / width - (cur - cx) / width
      const len = Math.hypot(ox, oy)
      dx = ox / len; dy = oy / len
      chain.push(best); visited[best] = 1; cur = best
    }
    chains.push(chain)
  }
  for (let p = 0; p < n; p++) if (kept[p] && !visited[p] && degree(p) === 1) walk(p)
  for (let p = 0; p < n; p++) if (kept[p] && !visited[p]) walk(p)
  return chains
}

function sampleMag(mag: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) return 0
  const fx = x - x0, fy = y - y0
  const i = y0 * width + x0
  return mag[i] * (1 - fx) * (1 - fy) + mag[i + 1] * fx * (1 - fy) + mag[i + width] * (1 - fx) * fy + mag[i + width + 1] * fx * fy
}

/** Parabola-across-the-gradient subpixel refinement of one pixel. */
export function refinePixel(p: number, g: Gradients): [number, number] {
  const { gx, gy, mag, width, height } = g
  const x = p % width, y = (p - x) / width
  const m0 = mag[p]
  let px = x + 0.5, py = y + 0.5
  if (m0 > 0) {
    const nx = gx[p] / m0, ny = gy[p] / m0
    const m1 = sampleMag(mag, width, height, x - nx, y - ny)
    const m2 = sampleMag(mag, width, height, x + nx, y + ny)
    const denom = m1 + m2 - 2 * m0
    if (denom < 0) {
      const t = Math.max(-0.5, Math.min(0.5, (m1 - m2) / (2 * denom)))
      px += t * nx; py += t * ny
    }
  }
  return [px, py]
}

export function pixelChainsToEdges(chains: number[][], g: Gradients): EdgeChains {
  let total = 0
  for (const c of chains) total += c.length
  const points = new Float32Array(total * 2)
  const offsets = new Uint32Array(chains.length + 1)
  let at = 0
  chains.forEach((chain, ci) => {
    offsets[ci] = at
    for (const p of chain) { const [px, py] = refinePixel(p, g); points[at * 2] = px; points[at * 2 + 1] = py; at++ }
  })
  offsets[chains.length] = at
  return { points, offsets }
}

export type Pt = [number, number]

export function pointChainsToEdges(chains: Pt[][]): EdgeChains {
  let total = 0
  for (const c of chains) total += c.length
  const points = new Float32Array(total * 2)
  const offsets = new Uint32Array(chains.length + 1)
  let at = 0
  chains.forEach((chain, ci) => {
    offsets[ci] = at
    for (const [x, y] of chain) { points[at * 2] = x; points[at * 2 + 1] = y; at++ }
  })
  offsets[chains.length] = at
  return { points, offsets }
}

export function edgesToPointChains(e: EdgeChains): Pt[][] {
  const out: Pt[][] = []
  for (let c = 0; c + 1 < e.offsets.length; c++) {
    const chain: Pt[] = []
    for (let i = e.offsets[c]; i < e.offsets[c + 1]; i++) chain.push([e.points[i * 2], e.points[i * 2 + 1]])
    out.push(chain)
  }
  return out
}

/** Polyline length of a point chain, px. */
export function chainLength(c: Pt[]): number {
  let l = 0
  for (let i = 1; i < c.length; i++) l += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])
  return l
}

/** Otsu threshold on an 8-bit-range image. */
export function otsu(img: ArrayLike<number>): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < img.length; i++) hist[Math.max(0, Math.min(255, Math.round(img[i])))]++
  const total = img.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = 0, bestT = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = t }
  }
  return bestT
}
