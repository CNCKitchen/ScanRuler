// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { imagePixelsPerMm } from '../src/core/flat/image'

// Containers built by hand, chunk by chunk — the parser reads metadata only,
// so no pixel data (or valid CRC) is needed.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff]
}

function chunk(type: string, data: number[]): number[] {
  return [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
}

function png(chunks: number[][]): Uint8Array {
  return new Uint8Array([...PNG_SIG, ...chunks.flat()])
}

const IHDR = chunk('IHDR', [...u32(100), ...u32(50), 8, 0, 0, 0, 0])

function jfif(unit: number, xd: number, yd: number): Uint8Array {
  const app0 = [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    1, 2, // version
    unit,
    ...u16(xd),
    ...u16(yd),
    0, 0, // no thumbnail
  ]
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...u16(app0.length + 2), ...app0, 0xff, 0xd9])
}

describe('PNG pHYs', () => {
  it('reads pixels per metre', () => {
    // 600 dpi both ways: 23622 px/m.
    const bytes = png([IHDR, chunk('pHYs', [...u32(23622), ...u32(23622), 1])])
    const r = imagePixelsPerMm(bytes)!
    expect(r.x).toBeCloseTo(23.622, 3)
    expect(r.y).toBeCloseTo(23.622, 3)
  })

  it('keeps X and Y apart', () => {
    const bytes = png([IHDR, chunk('pHYs', [...u32(23622), ...u32(11811), 1])])
    const r = imagePixelsPerMm(bytes)!
    expect(r.x).toBeCloseTo(23.622, 3)
    expect(r.y).toBeCloseTo(11.811, 3)
  })

  it('rejects a unitless aspect ratio', () => {
    expect(png([IHDR, chunk('pHYs', [...u32(4), ...u32(3), 0])])).toSatisfy(
      (b: Uint8Array) => imagePixelsPerMm(b) === null,
    )
  })

  it('gives up at the pixel data and on files without pHYs', () => {
    expect(imagePixelsPerMm(png([IHDR, chunk('IDAT', [1, 2, 3])]))).toBeNull()
    expect(imagePixelsPerMm(png([IHDR]))).toBeNull()
  })
})

describe('JPEG JFIF', () => {
  it('reads dots per inch', () => {
    const r = imagePixelsPerMm(jfif(1, 600, 600))!
    expect(r.x).toBeCloseTo(600 / 25.4, 6)
    expect(r.y).toBeCloseTo(600 / 25.4, 6)
  })

  it('reads dots per centimetre', () => {
    const r = imagePixelsPerMm(jfif(2, 118, 118))!
    expect(r.x).toBeCloseTo(11.8, 6)
  })

  it('rejects the bare aspect ratio JFIF files usually carry', () => {
    expect(imagePixelsPerMm(jfif(0, 1, 1))).toBeNull()
  })
})

describe('anything else', () => {
  it('is not an image with a resolution', () => {
    expect(imagePixelsPerMm(new Uint8Array([0, 1, 2, 3]))).toBeNull()
    expect(imagePixelsPerMm(new Uint8Array(0))).toBeNull()
  })
})
