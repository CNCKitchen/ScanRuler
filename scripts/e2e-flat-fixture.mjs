// SPDX-License-Identifier: AGPL-3.0-only
// The synthetic flatbed scan the 2D Measure scripts drive — no binary
// fixtures in this repo. Exact by construction, so the assertions can be
// tight: a grayscale PNG at a declared 600 dpi with soft-shouldered edges, a
// 240 px circle and a 600 px wide rectangle. One module, so e2e-flat and
// e2e-spline measure the same sheet.
import { deflateSync } from 'node:zlib'

export const W = 800
export const H = 600
export const PPM = 23.622 // 600 dpi
export const RECT = { x0: 100.5, x1: 700.5, y0: 400.5, y1: 550.5 } // image px, y down
export const DISC = { cx: 400.5, cy: 200.5, r: 120.25 }

/** Soft edge over ±1 px of a signed "inside" distance, like scanner optics. */
const shade = (d) =>
  d <= -1 ? 25 : d >= 1 ? 230 : 25 + (230 - 25) * (0.5 + 0.5 * Math.sin((d * Math.PI) / 2))

export function buildPng() {
  const gray = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const inRect = Math.min(cx - RECT.x0, RECT.x1 - cx, cy - RECT.y0, RECT.y1 - cy)
      const inDisc = DISC.r - Math.hypot(cx - DISC.cx, cy - DISC.cy)
      gray[y * W + x] = shade(Math.max(inRect, inDisc))
    }
  }
  // PNG by hand: signature, IHDR, pHYs (600 dpi), IDAT, IEND.
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const chunk = (type, data) => {
    const body = [...[...type].map((ch) => ch.charCodeAt(0)), ...data]
    return [...u32(data.length), ...body, ...u32(crc(body))]
  }
  const raw = new Uint8Array(H * (W + 1))
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0 // filter: none
    raw.set(gray.subarray(y * W, (y + 1) * W), y * (W + 1) + 1)
  }
  const idat = deflateSync(raw)
  const ppm = Math.round(PPM * 1000) // pixels per metre
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(W), ...u32(H), 8, 0, 0, 0, 0]),
    ...chunk('pHYs', [...u32(ppm), ...u32(ppm), 1]),
    ...chunk('IDAT', [...idat]),
    ...chunk('IEND', []),
  ])
}
