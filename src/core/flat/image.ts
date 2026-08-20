// SPDX-License-Identifier: AGPL-3.0-only
// What the image file says about its own scale. A flatbed scan carries the
// resolution it was scanned at — PNG in a pHYs chunk, JPEG in the JFIF
// header — and pixels per millimetre derived from it is the natural seed for
// the calibration: honest enough to measure with immediately, and labelled as
// nominal until it has been verified against a reference on the glass.
//
// Parsing by hand rather than through an image library because this is all we
// ask of the container — the pixels themselves come from createImageBitmap.

export interface PixelsPerMm {
  x: number
  y: number
}

/** Pixels per millimetre as declared by the file's metadata, or null when the
 *  file carries no physical resolution (or none that names a real unit). */
export function imagePixelsPerMm(bytes: Uint8Array): PixelsPerMm | null {
  if (isPng(bytes)) return pngPixelsPerMm(bytes)
  if (isJpeg(bytes)) return jpegPixelsPerMm(bytes)
  return null
}

function isPng(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 2 && b[0] === 0xff && b[1] === 0xd8
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1]
}

/** Walk the PNG chunks for pHYs: X and Y pixels per unit, and a unit flag
 *  that is either "metre" or "no unit at all" (a bare aspect ratio). */
function pngPixelsPerMm(b: Uint8Array): PixelsPerMm | null {
  let at = 8
  while (at + 12 <= b.length) {
    const length = u32(b, at)
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    if (type === 'pHYs' && length >= 9) {
      const unit = b[at + 16]
      if (unit !== 1) return null
      const x = u32(b, at + 8) / 1000
      const y = u32(b, at + 12) / 1000
      return x > 0 && y > 0 ? { x, y } : null
    }
    // Pixel data begins after the metadata; pHYs is required to come first.
    if (type === 'IDAT' || type === 'IEND') return null
    at += 12 + length
  }
  return null
}

/** Walk the JPEG segments for the JFIF APP0 header: a density unit (dpi or
 *  dots per cm) and an X and Y density. Unit 0 is a bare aspect ratio. */
function jpegPixelsPerMm(b: Uint8Array): PixelsPerMm | null {
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]
    // Standalone markers carry no length; the scan itself ends the metadata.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null
    const length = u16(b, at + 2)
    if (length < 2) return null
    if (marker === 0xe0 && length >= 16) {
      const id = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7], b[at + 8])
      if (id === 'JFIF\0') {
        const unit = b[at + 11]
        const xd = u16(b, at + 12)
        const yd = u16(b, at + 14)
        if (unit === 1) return xd > 0 && yd > 0 ? { x: xd / 25.4, y: yd / 25.4 } : null
        if (unit === 2) return xd > 0 && yd > 0 ? { x: xd / 10, y: yd / 10 } : null
        return null
      }
    }
    at += 2 + length
  }
  return null
}
