// SPDX-License-Identifier: AGPL-3.0-only
// A project past the 1 GiB it once could not be: written as parts, read a
// member at a time by offset, its offsets in zip64 records past 4 GiB. Nothing
// here allocates gigabytes — an archive is begun past 4 GiB in a sparse file,
// and sizes past the limits are declared, not written.
import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { joinParts, manifestText, packProject, packProjectParts, PROJECT_LIMITS, sizeProblem, unpackProject } from '../src/core/project/archive'
import { crc32, readZipMember, zipDirectory, zipParts } from '../src/core/project/zip'
import { partsSource, type ByteSource } from '../src/core/parsers/byteSource'
import { blankManifest } from '../src/app/project'
import type { PackedProject } from '../src/commands/host'
import { refused, run, startHeadless } from './commandKit'

const GiB = 1024 ** 3
const MB = 1e6

/** `parts` as they would sit in a file beginning `start` bytes in, the bytes
 *  before them zeros never stored. */
function sparse(parts: Uint8Array[], start: number): ByteSource {
  const archive = partsSource(parts)
  return {
    size: start + archive.size,
    read(from, to) {
      to = Math.min(to, start + archive.size)
      if (from >= start) return archive.read(from - start, to - start)
      const out = new Uint8Array(to - from)
      if (to > start) out.set(archive.read(0, to - start), start - from)
      return out
    },
  }
}

function manifest() {
  // The reference is named, so its member must be there; scan.ply rides
  // along as a member nothing here names, which a project keeps all the same.
  const m = blankManifest('0.11.2')
  m.deviation.reference = { fileName: 'bracket.stl', member: 'reference.stl' }
  return m
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    out[i] = s >>> 24
  }
  return out
}

describe('the zip a project is written as', () => {
  it('takes the zip CRC-32', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926)
  })

  it('reads back with any zip reader, a member that would not shrink stored', () => {
    const random = noise(50_000, 7)
    const text = strToU8('solid a\n'.repeat(5_000))
    const zip = joinParts(zipParts([{ name: 'random.bin', bytes: random, level: 6 }, { name: 'text.stl', bytes: text, level: 6 }]))
    const files = unzipSync(zip)
    expect(files['random.bin']).toEqual(random)
    expect(files['text.stl']).toEqual(text)
    const listed = zipDirectory(partsSource([zip]), 16)
    expect(listed.map((m) => [m.name, m.method])).toEqual([['random.bin', 0], ['text.stl', 8]])
    expect(listed[1].compressedSize).toBeLessThan(text.length / 10)
  })

  it('writes offsets past 4 GiB into zip64 records, and reads them back', () => {
    const scan = noise(300_000, 1)
    const reference = strToU8('facet normal 0 0 1\n'.repeat(20_000))
    const start = 5 * GiB
    const parts = zipParts([{ name: 'scan.ply', bytes: scan, level: 6 }, { name: 'reference.stl', bytes: reference, level: 6 }], start)
    const source = sparse(parts, start)
    const listed = zipDirectory(source, 16)
    expect(listed.every((m) => m.offset >= start)).toBe(true)
    expect(readZipMember(source, listed[0])).toEqual(scan)
    expect(readZipMember(source, listed[1])).toEqual(reference)
    // The record is there: the end record's own offset field says "see zip64".
    const end = parts[parts.length - 1]
    expect(new DataView(end.buffer, end.byteOffset).getUint32(16, true)).toBe(0xffffffff)
  })

  it('reads across parts as one file', () => {
    const bytes = noise(1000, 3)
    const source = partsSource([bytes.subarray(0, 10), bytes.subarray(10, 600), bytes.subarray(600)])
    expect(source.size).toBe(1000)
    expect(source.read(5, 700)).toEqual(bytes.subarray(5, 700))
    expect(source.read(20, 30)).toEqual(bytes.subarray(20, 30))
    expect(source.read(990, 2000)).toEqual(bytes.subarray(990))
  })
})

describe('a project past 1 GiB', () => {
  it('fits: a 673 MB cloud beside a 529 MB reference is within the limits', () => {
    expect(PROJECT_LIMITS.totalBytes).toBe(4 * GiB)
    expect(sizeProblem([{ name: 'project.json', size: 2 * MB }, { name: 'scan.ply', size: 673 * MB }, { name: 'reference.stl', size: 529 * MB }])).toBeNull()
    expect(sizeProblem([{ name: 'scan.ply', size: 1.9 * GiB }, { name: 'reference.stl', size: 1.9 * GiB }])).toBeNull()
  })

  it('says which limit a project is past', () => {
    expect(sizeProblem([{ name: 'scan.ply', size: 1.9 * GiB }, { name: 'reference.stl', size: 1.9 * GiB }, { name: 'image.png', size: 0.5 * GiB }]))
      .toBe('it holds 4.62 GB of files, and a project holds at most 4 GiB')
    expect(sizeProblem([{ name: 'scan.ply', size: 2.5 * GiB }])).toBe('scan.ply in it is 2.68 GB, and one file in a project is at most 2 GiB')
  })

  it('round-trips from the file a member at a time, the manifest as it was, past 4 GiB in', () => {
    const m = manifest()
    const scan = noise(200_000, 11)
    const reference = strToU8('vertex 1 2 3\n'.repeat(10_000))
    const parts = zipParts([
      { name: 'project.json', bytes: strToU8(manifestText(m)), level: 6 },
      { name: 'scan.ply', bytes: scan, level: 6 },
      { name: 'reference.stl', bytes: reference, level: 6 },
    ], 4 * GiB + 123)
    const back = unpackProject(sparse(parts, 4 * GiB + 123))
    expect(back.manifest).toEqual(m)
    expect(back.members.get('scan.ply')).toEqual(scan)
    expect(back.members.get('reference.stl')).toEqual(reference)
  })

  it('round-trips as the parts it is saved as, the manifest member unchanged', () => {
    const m = manifest()
    const members = [{ name: 'scan.ply', bytes: noise(100_000, 5) }, { name: 'reference.stl', bytes: strToU8('x'.repeat(100_000)) }]
    const parts = packProjectParts(m, members)
    expect(parts.length).toBeGreaterThan(3)
    const back = unpackProject(partsSource(parts))
    expect(back.manifest).toEqual(m)
    expect(unzipSync(joinParts(parts))['project.json']).toEqual(strToU8(manifestText(m)))
    for (const { name, bytes } of members) expect(back.members.get(name)).toEqual(bytes)
  })

  it('opens a project an older build wrote', () => {
    const m = manifest()
    const old = zipSync({ 'project.json': strToU8(manifestText(m)), 'scan.ply': new Uint8Array(10), 'reference.stl': new Uint8Array(20) })
    expect(unpackProject(old).manifest).toEqual(m)
  })

  it('refuses one declaring more than 4 GiB before expanding anything', () => {
    const zip = packProject(manifest(), [{ name: 'scan.ply', bytes: new Uint8Array(1000) }, { name: 'reference.stl', bytes: new Uint8Array(1000) }])
    // Declare each model 1.9 GiB: 3.8 GiB with nothing else is within; a
    // third member of that size is not.
    const declare = (archive: Uint8Array, sizes: Record<string, number>) => {
      const copy = archive.slice()
      const dv = new DataView(copy.buffer)
      const decoder = new TextDecoder()
      for (let i = 0; i + 46 <= copy.length; i++) {
        if (dv.getUint32(i, true) !== 0x02014b50) continue
        const name = decoder.decode(copy.subarray(i + 46, i + 46 + dv.getUint16(i + 28, true)))
        if (sizes[name] !== undefined) dv.setUint32(i + 24, sizes[name], true)
      }
      return copy
    }
    const big = Math.floor(1.9 * GiB)
    // Within the limits, the declared sizes are then held to what comes out.
    expect(() => unpackProject(declare(zip, { 'scan.ply': 5000 }))).toThrow('Not a ScanRuler project')
    const three = packProject(manifest(), ['scan.ply', 'reference.stl', 'image.png'].map((name) => ({ name, bytes: new Uint8Array(1000) })))
    expect(() => unpackProject(declare(three, { 'scan.ply': big, 'reference.stl': big, 'image.png': big }))).toThrow(/size limits — it holds 6\.12 GB of files, and a project holds at most 4 GiB/)
    expect(() => unpackProject(declare(zip, { 'scan.ply': 3 * GiB }))).toThrow(/scan\.ply in it is 3\.22 GB, and one file in a project is at most 2 GiB/)
  })

  it('is refused over the agent link past 1 GiB, and handed over joined below it', async () => {
    const asked: (number | undefined)[] = []
    let packed: PackedProject = { tooLarge: 1.35e9 }
    const headless = await startHeadless({
      project: {
        save: async (maxBytes) => { asked.push(maxBytes); return packed },
        open: async () => {},
      },
    })
    try {
      const error = await refused('project.save')
      expect(error.message).toMatch(/^The project is past 1\.35 GB — more than the 1 GiB \(1,073,741,824 bytes\) .* save it in the page with Save Project/)
      expect(asked).toEqual([GiB])
      packed = { name: 'big.scanruler', parts: [strToU8('PK'), strToU8('rest')], size: 6 }
      const { file } = await run<{ file: { name: string; bytes: Uint8Array } }>('project.save')
      expect(new TextDecoder().decode(file.bytes)).toBe('PKrest')
    } finally {
      headless.stop()
    }
  })

  it('refuses to save past the limits, saying so', () => {
    const members = [{ name: 'scan.ply', bytes: new Uint8Array(600) }, { name: 'reference.stl', bytes: new Uint8Array(500) }]
    expect(() => packProjectParts(manifest(), members, { ...PROJECT_LIMITS, totalBytes: 1000 }))
      .toThrow(/size limits — it holds .* of files, and a project holds at most 1 MB\. Make the scan or the reference smaller, and save again\./)
  })
})
