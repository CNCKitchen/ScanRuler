// SPDX-License-Identifier: AGPL-3.0-only
// The zip container of a project file, written and read here rather than by
// fflate's zipSync and unzipSync: those hold the whole archive in one
// ArrayBuffer and know nothing of zip64, and a project of a large cloud beside
// a large reference is past what one ArrayBuffer — and a zip without zip64,
// at 4 GiB — can hold. So the archive is written as a list of parts, which a
// Blob joins into the file without one buffer of it all, and read a member at
// a time from the file by offset. fflate still does the deflating. Each member
// is under 4 GiB itself (the project's limits keep it under 2 GiB, one
// ArrayBuffer), so only offsets and the directory ever need zip64.

import { Deflate, Inflate } from 'fflate'
import type { ByteSource } from '../parsers/byteSource'

/** An archive that is not a zip this reads, or is damaged. */
export class ZipFormatError extends Error {}

/** A directory that lists more members than the reader was asked to take. */
export class ZipCountError extends Error {
  constructor(readonly count: number) {
    super(`The zip holds ${count} members.`)
  }
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const END64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const U16 = 0xffff
const U32 = 0xffffffff
/** How much is deflated, inflated or read at once, and the size the
 *  deflated output is gathered into: parts large enough to be few, small
 *  enough that no one of them is a burden. */
const PIECE = 32 * 1024 * 1024
/** How much compressed input goes into the inflater at once. fflate grows
 *  its output to all that one push inflates to before handing any of it
 *  over, and deflate expands at most 1032 to 1, so this bounds what a crafted
 *  member can make the reader hold beyond the size it declares: 16 MiB. */
const INFLATE_STEP = 16 * 1024
/** Deflate's largest expansion: a 258-byte match in under two bits. */
const MAX_RATIO = 1032
/** Bit 11: the name is UTF-8. */
const UTF8_NAME = 0x0800

/** The saved and opened project is checked over gigabytes in a worker, so
 *  the table is sliced eight ways: eight bytes per step instead of one. */
let crcTables: Uint32Array[] | null = null

function crcTablesOf(): Uint32Array[] {
  if (crcTables) return crcTables
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256))
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tables[0][n] = c >>> 0
  }
  for (let n = 0; n < 256; n++) {
    for (let t = 1; t < 8; t++) tables[t][n] = (tables[0][tables[t - 1][n] & 0xff] ^ (tables[t - 1][n] >>> 8)) >>> 0
  }
  return (crcTables = tables)
}

/** The zip's CRC-32 of `bytes`; with `crc`, of what that was the CRC of
 *  followed by `bytes`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTablesOf()
  let c = (crc ^ U32) >>> 0
  let i = 0
  const n = bytes.length
  for (const end = n - 8; i <= end; i += 8) {
    const a = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))
    c = t7[a & 0xff] ^ t6[(a >>> 8) & 0xff] ^ t5[(a >>> 16) & 0xff] ^ t4[a >>> 24]
      ^ t3[bytes[i + 4]] ^ t2[bytes[i + 5]] ^ t1[bytes[i + 6]] ^ t0[bytes[i + 7]]
  }
  for (; i < n; i++) c = t0[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ U32) >>> 0
}

/** The archive would be past the most it was asked to be (zipParts'
 *  `maxBytes`): `size` is how much of it was written when that was seen. */
export class ZipTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`The zip is past ${size} bytes.`)
  }
}

function setU64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 2 ** 32, true)
  view.setUint32(at + 4, Math.floor(value / 2 ** 32), true)
}

function getU64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** MS-DOS time and date, as a zip stamps a member. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** `bytes` deflated at `level`, in parts of at most PIECE; null when that is
 *  no smaller and the member is better stored. Past `budget` bytes of output
 *  it stops (ZipTooLargeError, of `written` plus the output so far). */
function deflated(bytes: Uint8Array, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, budget = Infinity, written = 0): Uint8Array[] | null {
  const parts: Uint8Array[] = []
  let part = new Uint8Array(0), filled = 0, size = 0
  const deflate = new Deflate({ level }, (chunk) => {
    size += chunk.length
    if (size > budget) throw new ZipTooLargeError(written + size)
    let at = 0
    while (at < chunk.length) {
      if (filled === part.length) {
        if (filled > 0) parts.push(part)
        // Grown with the output, so a small member does not hold a
        // PIECE-sized buffer alive behind the view of its few bytes.
        part = new Uint8Array(Math.min(PIECE, Math.max(64 * 1024, chunk.length - at, size)))
        filled = 0
      }
      const n = Math.min(chunk.length - at, part.length - filled)
      part.set(chunk.subarray(at, at + n), filled)
      filled += n
      at += n
    }
  })
  if (bytes.length === 0) deflate.push(bytes, true)
  for (let at = 0; at < bytes.length; at += PIECE) deflate.push(bytes.subarray(at, at + PIECE), at + PIECE >= bytes.length)
  // A copy of exactly what is filled, not a view: the view would keep the
  // whole buffer alive.
  if (filled > 0) parts.push(filled === part.length ? part : part.slice(0, filled))
  return size < bytes.length ? parts : null
}

export interface ZipInput {
  name: string
  /** The bytes, or how to get them once the member is reached — so a caller
   *  reading members from disk holds one at a time, not all of them. */
  bytes: Uint8Array | (() => Uint8Array)
  /** Deflate level; 0 stores the member as it is. */
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

/**
 * The zip of `entries`, as the parts it is made of in order — joined (a Blob
 * of them), they are the file. Small parts are views of an entry's bytes
 * where it is stored, so the entries must outlive them.
 *
 * `start` is where in the file the archive begins: 0 for a file of its own.
 * Past 4 GiB the offsets go into zip64 records; a test begins the archive past
 * that to write them without writing 4 GiB.
 *
 * An archive that would be past `maxBytes` is given up as soon as it is
 * (ZipTooLargeError), not built whole first.
 */
export function zipParts(entries: readonly ZipInput[], start = 0, now = new Date(), maxBytes = Infinity): Uint8Array[] {
  const stamp = dosStamp(now)
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let at = start
  const over = (size: number) => { if (size > maxBytes) throw new ZipTooLargeError(size) }
  for (const entry of entries) {
    const { name, level } = entry
    const bytes = typeof entry.bytes === 'function' ? entry.bytes() : entry.bytes
    if (bytes.length >= U32) throw new Error(`${name} is too large for one member of a zip.`)
    const nameBytes = new TextEncoder().encode(name)
    const crc = crc32(bytes)
    const written = at - start + 30 + nameBytes.length
    over(written)
    const packed = level > 0 ? deflated(bytes, level, maxBytes - written, written) : null
    const data = packed ?? [bytes]
    const method = packed ? 8 : 0
    const size = data.reduce((sum, part) => sum + part.length, 0)
    over(written + size)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = viewOf(local)
    lv.setUint32(0, LOCAL, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, UTF8_NAME, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, bytes.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    parts.push(local, ...data)

    // Sizes always fit; an offset past 4 GiB goes in a zip64 extra field.
    const far = at >= U32
    const central = new Uint8Array(46 + nameBytes.length + (far ? 12 : 0))
    const cv = viewOf(central)
    cv.setUint32(0, CENTRAL, true)
    cv.setUint16(4, 45, true)
    cv.setUint16(6, far ? 45 : 20, true)
    cv.setUint16(8, UTF8_NAME, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, stamp.time, true)
    cv.setUint16(14, stamp.date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, bytes.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, far ? 12 : 0, true)
    cv.setUint32(42, far ? U32 : at, true)
    central.set(nameBytes, 46)
    if (far) {
      const x = 46 + nameBytes.length
      cv.setUint16(x, 1, true)
      cv.setUint16(x + 2, 8, true)
      setU64(cv, x + 4, at)
    }
    directory.push(central)
    at += local.length + size
  }
  const directoryAt = at
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)
  parts.push(...directory)
  at += directorySize
  const count = entries.length
  if (directoryAt >= U32 || directorySize >= U32 || count >= U16) {
    const record = new Uint8Array(56 + 20)
    const rv = viewOf(record)
    rv.setUint32(0, END64, true)
    setU64(rv, 4, 44)
    rv.setUint16(12, 45, true)
    rv.setUint16(14, 45, true)
    setU64(rv, 24, count)
    setU64(rv, 32, count)
    setU64(rv, 40, directorySize)
    setU64(rv, 48, directoryAt)
    rv.setUint32(56, LOCATOR64, true)
    setU64(rv, 64, at)
    rv.setUint32(72, 1, true)
    parts.push(record)
    at += record.length
  }
  const end = new Uint8Array(22)
  const ev = viewOf(end)
  ev.setUint32(0, END, true)
  ev.setUint16(8, Math.min(count, U16), true)
  ev.setUint16(10, Math.min(count, U16), true)
  ev.setUint32(12, Math.min(directorySize, U32), true)
  ev.setUint32(16, Math.min(directoryAt, U32), true)
  parts.push(end)
  over(at - start + 22)
  return parts
}

/** A member as the directory lists it. */
export interface ZipMember {
  name: string
  method: number
  flags: number
  compressedSize: number
  size: number
  /** The CRC-32 of its expanded bytes. */
  crc: number
  /** Where its local header is. */
  offset: number
}

/** The archive's directory, read from its end. One that lists more than
 *  `maxMembers` is refused (ZipCountError) before it is read. */
export function zipDirectory(source: ByteSource, maxMembers: number): ZipMember[] {
  const tailStart = Math.max(0, source.size - (22 + U16))
  const tail = source.read(tailStart, source.size).slice()
  const tv = viewOf(tail)
  let found = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === END) { found = i; break }
  }
  if (found < 0) throw new ZipFormatError('No zip directory.')
  let count = tv.getUint16(found + 10, true)
  let directorySize = tv.getUint32(found + 12, true)
  let directoryAt = tv.getUint32(found + 16, true)
  let directoryEnd = tailStart + found
  if (directoryEnd >= 20) {
    const locator = viewOf(source.read(directoryEnd - 20, directoryEnd).slice())
    if (locator.byteLength === 20 && locator.getUint32(0, true) === LOCATOR64) {
      const recordAt = getU64(locator, 8)
      const record = viewOf(source.read(recordAt, recordAt + 56).slice())
      if (record.byteLength < 56 || record.getUint32(0, true) !== END64) throw new ZipFormatError('Broken zip64 record.')
      count = getU64(record, 32)
      directorySize = getU64(record, 40)
      directoryAt = getU64(record, 48)
      directoryEnd = recordAt
    }
  }
  if (count > maxMembers) throw new ZipCountError(count)
  if (directorySize > count * (46 + 3 * U16) || directoryAt + directorySize > directoryEnd) throw new ZipFormatError('Broken zip directory.')
  const dir = source.read(directoryAt, directoryAt + directorySize).slice()
  const dv = viewOf(dir)
  const decoder = new TextDecoder()
  const members: ZipMember[] = []
  let at = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > dir.length || dv.getUint32(at, true) !== CENTRAL) throw new ZipFormatError('Broken zip directory.')
    const nameLength = dv.getUint16(at + 28, true)
    const extraLength = dv.getUint16(at + 30, true)
    const commentLength = dv.getUint16(at + 32, true)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > dir.length) throw new ZipFormatError('Broken zip directory.')
    const member: ZipMember = {
      name: decoder.decode(dir.subarray(at + 46, at + 46 + nameLength)),
      flags: dv.getUint16(at + 8, true),
      method: dv.getUint16(at + 10, true),
      crc: dv.getUint32(at + 16, true),
      compressedSize: dv.getUint32(at + 20, true),
      size: dv.getUint32(at + 24, true),
      offset: dv.getUint32(at + 42, true),
    }
    // A zip64 extra field holds, in order, those of the three that did not fit.
    for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength;) {
      const id = dv.getUint16(x, true), length = dv.getUint16(x + 2, true)
      if (id === 1) {
        let y = x + 4
        const field = (value: number) => {
          if (value !== U32) return value
          if (y + 8 > x + 4 + length) throw new ZipFormatError('Broken zip64 field.')
          const v = getU64(dv, y)
          y += 8
          return v
        }
        member.size = field(member.size)
        member.compressedSize = field(member.compressedSize)
        member.offset = field(member.offset)
      }
      x += 4 + length
    }
    members.push(member)
    at = next
  }
  return members
}

/** A member's bytes, expanded, read from the archive a piece at a time and
 *  held to the size and CRC-32 the directory lists. Nothing is allocated
 *  past what the file could hold: a stored member is no larger than its
 *  bytes in the file, a deflated one no larger than they can expand to. */
export function readZipMember(source: ByteSource, member: ZipMember): Uint8Array {
  if (member.flags & 1) throw new ZipFormatError('Encrypted zip member.')
  const local = viewOf(source.read(member.offset, member.offset + 30).slice())
  if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL) throw new ZipFormatError('Broken zip member.')
  const start = member.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true)
  const end = start + member.compressedSize
  if (end > source.size) throw new ZipFormatError('Broken zip member.')
  if (member.method === 0) {
    if (member.compressedSize !== member.size) throw new ZipFormatError('Broken zip member.')
  } else if (member.method === 8) {
    if (member.size > member.compressedSize * MAX_RATIO + 1024) throw new ZipFormatError('A zip member says it expands past what deflate can.')
  } else {
    throw new ZipFormatError('Unsupported zip compression.')
  }
  let out: Uint8Array
  try {
    out = new Uint8Array(member.size)
  } catch (e) {
    if (e instanceof RangeError) throw new ZipFormatError('A zip member is too large to hold.')
    throw e
  }
  let filled = 0
  const take = (chunk: Uint8Array) => {
    if (filled + chunk.length > out.length) throw new ZipFormatError('A zip member is larger than it says.')
    out.set(chunk, filled)
    filled += chunk.length
  }
  if (member.method === 0) {
    for (let at = start; at < end; at += PIECE) take(source.read(at, Math.min(end, at + PIECE)))
  } else {
    const inflate = new Inflate(take)
    try {
      if (start === end) inflate.push(new Uint8Array(0), true)
      // Read in large pieces, inflated in small steps: what each step expands
      // to is held to the declared size before the next is inflated.
      for (let at = start; at < end; at += PIECE) {
        const piece = source.read(at, Math.min(end, at + PIECE))
        for (let i = 0; i < piece.length; i += INFLATE_STEP) {
          inflate.push(piece.subarray(i, i + INFLATE_STEP), at + i + INFLATE_STEP >= end)
        }
      }
    } catch (e) {
      if (e instanceof ZipFormatError) throw e
      // The inflater's buffer grown past what the tab can give it.
      if (e instanceof RangeError) throw new ZipFormatError('A zip member expands past what can be held.')
      // fflate's own errors carry a numeric code; a failed read does not.
      if (typeof (e as { code?: unknown })?.code === 'number') throw new ZipFormatError('Broken deflate data.')
      throw e
    }
  }
  if (filled !== out.length) throw new ZipFormatError('A zip member is smaller than it says.')
  if (crc32(out) !== member.crc) throw new ZipFormatError('A zip member does not match its CRC-32.')
  return out
}
