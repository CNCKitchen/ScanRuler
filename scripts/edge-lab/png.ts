// SPDX-License-Identifier: AGPL-3.0-only
// Minimal PNG reader/writer for the edge lab — 8-bit grey/RGB/RGBA,
// non-interlaced, via node's zlib. Enough to load a scanner PNG and write
// overlay renders; not a general decoder.
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

export interface Gray { gray: Uint8Array; width: number; height: number }

export function readPngGray(path: string): Gray {
  const b = readFileSync(path)
  let at = 8
  let width = 0, height = 0, depth = 0, ctype = 0
  const idat: Buffer[] = []
  while (at < b.length) {
    const len = b.readUInt32BE(at)
    const type = b.toString('latin1', at + 4, at + 8)
    const data = b.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; ctype = data[9]
      if (depth !== 8 || data[12] !== 0) throw new Error(`unsupported PNG: depth ${depth} interlace ${data[12]}`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  const ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 6 ? 4 : 0
  if (!ch) throw new Error(`unsupported colour type ${ctype}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = new Uint8Array(stride * height)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const up = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = row[i]
      if (f === 1) v += a
      else if (f === 2) v += up
      else if (f === 3) v += (a + up) >> 1
      else if (f === 4) {
        const p = a + up - c
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      }
      cur[i] = v & 255
    }
    prev = cur
  }
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i++) {
    const j = i * ch
    gray[i] = ch >= 3 ? (out[j] * 77 + out[j + 1] * 150 + out[j + 2] * 29) >> 8 : out[j]
  }
  return { gray, width, height }
}

const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
function crc32(buf: Uint8Array): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Write an RGB buffer (width*height*3) as PNG. */
export function writePngRgb(path: string, rgb: Uint8Array, width: number, height: number): void {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0)),
  ]))
}
