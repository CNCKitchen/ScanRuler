// SPDX-License-Identifier: AGPL-3.0-only
// Overlay renders for the edge lab: a grey crop, upscaled, with chains drawn
// in per-chain colours so broken chains show as colour changes.
import type { Gray } from './png'
import { writePngRgb } from './png'
import type { EdgeChains } from '../../src/core/flat/edges'

export interface Roi { name: string; x0: number; y0: number; x1: number; y1: number }

const PALETTE = [
  [255, 80, 80], [80, 220, 80], [90, 150, 255], [255, 200, 40], [255, 90, 255], [40, 230, 230],
  [255, 140, 40], [160, 255, 120], [200, 120, 255], [255, 255, 120],
]

export function renderCrop(img: Gray, roi: Roi, chains: EdgeChains | null, scale: number, path: string, dim = 0.45): void {
  const w = Math.floor((roi.x1 - roi.x0) * scale)
  const h = Math.floor((roi.y1 - roi.y0) * scale)
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const sy = roi.y0 + Math.floor(y / scale)
    for (let x = 0; x < w; x++) {
      const sx = roi.x0 + Math.floor(x / scale)
      const v = sy >= 0 && sy < img.height && sx >= 0 && sx < img.width ? img.gray[sy * img.width + sx] * dim : 0
      const i = (y * w + x) * 3
      rgb[i] = rgb[i + 1] = rgb[i + 2] = v
    }
  }
  const put = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 3
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]
  }
  const thick = scale >= 3 ? 1 : 0
  const line = (ax: number, ay: number, bx: number, by: number, c: number[]) => {
    let x0 = Math.round((ax - roi.x0) * scale), y0 = Math.round((ay - roi.y0) * scale)
    const x1 = Math.round((bx - roi.x0) * scale), y1 = Math.round((by - roi.y0) * scale)
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let guard = 0; guard < 4096; guard++) {
      for (let oy = -thick; oy <= thick; oy++) for (let ox = -thick; ox <= thick; ox++) put(x0 + ox, y0 + oy, c)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  if (chains) {
    for (let c = 0; c + 1 < chains.offsets.length; c++) {
      const col = PALETTE[c % PALETTE.length]
      const n = chains.offsets[c + 1] - chains.offsets[c]
      for (let i = chains.offsets[c]; i < chains.offsets[c + 1]; i++) {
        const px = chains.points[i * 2], py = chains.points[i * 2 + 1]
        if (px < roi.x0 || px >= roi.x1 || py < roi.y0 || py >= roi.y1) continue
        if (n === 1 || i + 1 >= chains.offsets[c + 1]) line(px, py, px, py, col)
        else {
          const qx = chains.points[i * 2 + 2], qy = chains.points[i * 2 + 3]
          if (Math.hypot(qx - px, qy - py) < 8) line(px, py, qx, qy, col)
        }
      }
    }
  }
  writePngRgb(path, rgb, w, h)
}
