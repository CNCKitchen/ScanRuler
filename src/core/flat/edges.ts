// SPDX-License-Identifier: AGPL-3.0-only
// Edge detection for the flat workspace: grayscale in, subpixel edge chains
// out. Classic Canny — Gaussian blur, Sobel gradients, non-maximum
// suppression, hysteresis — with two additions that matter for measuring:
// the surviving edge pixels are linked into chains (a fit consumes an edge,
// not a pixel soup), and every point is refined to subpixel by a parabola
// through the gradient magnitudes across the edge. On a scanner image the
// optics blur an edge over 2–3 px, which is exactly what makes the parabola
// land on the true crossing to a fraction of a pixel.
//
// Pure typed-array code, no DOM: the worker feeds it a grayscale buffer, the
// tests feed it synthetic ones.

export interface EdgeChains {
  /** Subpixel edge points in image pixels, x0,y0,x1,y1,…, chain by chain.
   *  Pixel centres sit at half-coordinates: the centre of the bottom-left
   *  pixel is (0.5, 0.5). */
  points: Float32Array
  /** Chain c covers point indices [offsets[c], offsets[c+1]). */
  offsets: Uint32Array
}

export interface EdgeOptions {
  /** 0…1. Scales the automatic thresholds: higher finds fainter edges. */
  sensitivity?: number
  /** Gaussian blur sigma, px. */
  sigma?: number
  /** Chains shorter than this many points are dropped as noise. */
  minChain?: number
}

/** The number of chains in a result — a convenience for status lines. */
export function chainCount(chains: EdgeChains): number {
  return Math.max(0, chains.offsets.length - 1)
}

export function detectEdges(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: EdgeOptions = {},
): EdgeChains {
  const sigma = opts.sigma ?? 1.4
  const sensitivity = Math.min(1, Math.max(0, opts.sensitivity ?? 0.5))
  const minChain = opts.minChain ?? 8
  const n = width * height
  if (gray.length !== n) throw new Error('gray buffer does not match width × height')
  if (width < 8 || height < 8) return { points: new Float32Array(0), offsets: new Uint32Array(1) }

  const blurred = gaussianBlur(gray, width, height, sigma)

  // Sobel gradients. The border ring stays zero — an edge there is half
  // outside the image and could not be measured anyway.
  const gx = new Float32Array(n)
  const gy = new Float32Array(n)
  const mag = new Float32Array(n)
  for (let y = 1; y < height - 1; y++) {
    const r0 = (y - 1) * width
    const r1 = y * width
    const r2 = (y + 1) * width
    for (let x = 1; x < width - 1; x++) {
      const a = blurred[r0 + x - 1], b = blurred[r0 + x], c = blurred[r0 + x + 1]
      const d = blurred[r1 + x - 1], f = blurred[r1 + x + 1]
      const g = blurred[r2 + x - 1], h = blurred[r2 + x], i = blurred[r2 + x + 1]
      const sx = c + 2 * f + i - (a + 2 * d + g)
      const sy = g + 2 * h + i - (a + 2 * b + c)
      gx[r1 + x] = sx
      gy[r1 + x] = sy
      mag[r1 + x] = Math.hypot(sx, sy)
    }
  }

  // Automatic thresholds off the magnitude distribution. The bulk of a scan
  // is background noise; the quantile spread between "typical" and "clearly
  // an edge" spans it robustly, and the sensitivity slides the cut between
  // them. Sampled — the exact quantile of 140 M pixels is not worth a sort.
  const sample: number[] = []
  const stride = Math.max(1, Math.floor(n / 400_000))
  for (let i = 0; i < n; i += stride) if (mag[i] > 0) sample.push(mag[i])
  if (sample.length === 0) return { points: new Float32Array(0), offsets: new Uint32Array(1) }
  sample.sort((a, b) => a - b)
  const q = (t: number) => sample[Math.min(sample.length - 1, Math.floor(t * sample.length))]
  const base = q(0.6)
  const strong = q(0.995)
  const high = base + (strong - base) * (0.5 - 0.42 * sensitivity)
  const low = 0.4 * high

  // Non-maximum suppression: keep a pixel only where the magnitude peaks
  // across the edge, comparing against the two neighbours the gradient
  // points through (quantised to 4 directions).
  const NONE = 0, WEAK = 1, STRONG = 2
  const mark = new Uint8Array(n)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const m = mag[i]
      if (m < low) continue
      const ax = Math.abs(gx[i])
      const ay = Math.abs(gy[i])
      let m1: number
      let m2: number
      if (ax >= 2.4142 * ay) {
        m1 = mag[i - 1]; m2 = mag[i + 1] // horizontal gradient, vertical edge
      } else if (ay >= 2.4142 * ax) {
        m1 = mag[i - width]; m2 = mag[i + width]
      } else if (gx[i] * gy[i] > 0) {
        m1 = mag[i - width - 1]; m2 = mag[i + width + 1]
      } else {
        m1 = mag[i - width + 1]; m2 = mag[i + width - 1]
      }
      if (m >= m1 && m >= m2) mark[i] = m >= high ? STRONG : WEAK
    }
  }

  // Hysteresis: weak pixels survive only connected to a strong one.
  const kept = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (mark[i] === STRONG && !kept[i]) {
      kept[i] = 1
      stack.push(i)
      while (stack.length) {
        const p = stack.pop()!
        const px = p % width
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            if (px + dx < 0 || px + dx >= width) continue
            const q2 = p + dy * width + dx
            if (q2 < 0 || q2 >= n) continue
            if (mark[q2] !== NONE && !kept[q2]) {
              kept[q2] = 1
              stack.push(q2)
            }
          }
        }
      }
    }
  }

  return traceChains(kept, gx, gy, mag, width, height, minChain)
}

/** Separable Gaussian blur into floats. */
function gaussianBlur(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma))
  const kernel = new Float32Array(2 * radius + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k))
        acc += kernel[k + radius] * gray[row + xx]
      }
      tmp[row + x] = acc
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k))
        acc += kernel[k + radius] * tmp[yy * width + x]
      }
      out[y * width + x] = acc
    }
  }
  return out
}

/** Link the surviving edge pixels into chains and refine each point to
 *  subpixel along its gradient. Chains break at junctions; what matters is
 *  that a stretch of one physical edge comes out as one run of points. */
function traceChains(
  kept: Uint8Array,
  gx: Float32Array,
  gy: Float32Array,
  mag: Float32Array,
  width: number,
  height: number,
  minChain: number,
): EdgeChains {
  const n = width * height
  const neighborOf = (p: number, k: number): number => {
    const dx = ((k % 3) - 1)
    const dy = (Math.floor(k / 3) - 1)
    const px = p % width
    if (px + dx < 0 || px + dx >= width) return -1
    const q = p + dy * width + dx
    return q >= 0 && q < n ? q : -1
  }
  const degree = (p: number): number => {
    let d = 0
    for (let k = 0; k < 9; k++) {
      if (k === 4) continue
      const q = neighborOf(p, k)
      if (q >= 0 && kept[q]) d++
    }
    return d
  }

  const visited = new Uint8Array(n)
  const chains: number[][] = []

  // Follow the run of edge pixels by direction of travel: at every step take
  // the unvisited neighbour that best continues the way the chain is already
  // going. That carries straight through the staircase junctions a diagonal
  // edge is full of — a degree count would call them branch points and chop
  // one physical edge into confetti.
  const walk = (start: number) => {
    const chain = [start]
    visited[start] = 1
    let cur = start
    let dx = 0
    let dy = 0
    for (;;) {
      const cx = cur % width
      let best = -1
      let bestScore = -Infinity
      for (let k = 0; k < 9; k++) {
        if (k === 4) continue
        const q = neighborOf(cur, k)
        if (q < 0 || !kept[q] || visited[q]) continue
        const ox = (k % 3) - 1
        const oy = Math.floor(k / 3) - 1
        const len = Math.hypot(ox, oy)
        // With no direction yet, prefer 4-connected starts; afterwards, the
        // straightest continuation wins.
        const score = dx === 0 && dy === 0 ? -len : (dx * ox + dy * oy) / len
        if (score > bestScore) {
          bestScore = score
          best = q
        }
      }
      // A hairpin is not a continuation — it is another edge that happens to
      // touch. Stop rather than fold the chain back onto itself.
      if (best < 0 || (bestScore < -0.5 && (dx !== 0 || dy !== 0))) break
      const bx = best % width
      const ox = bx - cx
      const oy = (best - bx) / width - (cur - cx) / width
      const len = Math.hypot(ox, oy)
      dx = ox / len
      dy = oy / len
      chain.push(best)
      visited[best] = 1
      cur = best
    }
    chains.push(chain)
  }

  // Open runs first, from their endpoints, so a whole edge comes out as one
  // walk; whatever remains unvisited is closed loops, started anywhere.
  for (let p = 0; p < n; p++) {
    if (kept[p] && !visited[p] && degree(p) === 1) walk(p)
  }
  for (let p = 0; p < n; p++) {
    if (kept[p] && !visited[p]) walk(p)
  }

  const long = chains.filter((c) => c.length >= minChain)
  let total = 0
  for (const c of long) total += c.length
  const points = new Float32Array(total * 2)
  const offsets = new Uint32Array(long.length + 1)
  let at = 0
  long.forEach((chain, ci) => {
    offsets[ci] = at
    for (const p of chain) {
      const x = p % width
      const y = (p - x) / width
      const m0 = mag[p]
      let px = x + 0.5
      let py = y + 0.5
      if (m0 > 0) {
        const nx = gx[p] / m0
        const ny = gy[p] / m0
        const m1 = sampleMag(mag, width, height, x - nx, y - ny)
        const m2 = sampleMag(mag, width, height, x + nx, y + ny)
        const denom = m1 + m2 - 2 * m0
        if (denom < 0) {
          const t = Math.max(-0.5, Math.min(0.5, (m1 - m2) / (2 * denom)))
          px += t * nx
          py += t * ny
        }
      }
      points[at * 2] = px
      points[at * 2 + 1] = py
      at++
    }
  })
  offsets[long.length] = at
  return { points, offsets }
}

/** Bilinear sample of the magnitude field at a fractional pixel index. */
function sampleMag(mag: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) return 0
  const fx = x - x0
  const fy = y - y0
  const i = y0 * width + x0
  return (
    mag[i] * (1 - fx) * (1 - fy) +
    mag[i + 1] * fx * (1 - fy) +
    mag[i + width] * (1 - fx) * fy +
    mag[i + width + 1] * fx * fy
  )
}
