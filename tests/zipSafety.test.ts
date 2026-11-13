// SPDX-License-Identifier: AGPL-3.0-only
// The project zip against a file made to hurt it — a member that expands far
// past what it declares, a size no deflate stream can reach, a CRC that does
// not match — and the writer's own economy: pieces sized to what they hold,
// a save past its cap given up early, members read one at a time. Its
// archives are also read by Python's zipfile, zip64 records and all.
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync } from 'fflate'
import { blankManifest } from '../src/app/project'
import { joinParts, packProjectParts, PROJECT_LIMITS, readMembers, unpackProject } from '../src/core/project/archive'
import { crc32, readZipMember, zipDirectory, zipParts, ZipFormatError, ZipTooLargeError } from '../src/core/project/zip'
import { packedParts, PackedFile, postableMembers } from '../src/core/project/projectClient'
import { partsSource, type ByteSource } from '../src/core/parsers/byteSource'
import { MemoryFile, unreadableSource } from '../src/core/sourceFile'

/** The largest piece fflate's inflater handed over at once, in this file. */
const inflated = vi.hoisted(() => ({ largest: 0 }))
vi.mock('fflate', async (importOriginal) => {
  const fflate = await importOriginal<typeof import('fflate')>()
  class WatchedInflate extends fflate.Inflate {
    constructor(...args: ConstructorParameters<typeof fflate.Inflate>) {
      super(...args)
      const ondata = this.ondata
      this.ondata = (chunk, final) => {
        inflated.largest = Math.max(inflated.largest, chunk.length)
        ondata(chunk, final)
      }
    }
  }
  return { ...fflate, Inflate: WatchedInflate }
})

const MB = 1024 * 1024
const CENTRAL = 0x02014b50

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    out[i] = s >>> 24
  }
  return out
}

/** `zip` (no zip64 records) with a field of its first central header, `at`
 *  bytes in, set to `value`. */
function patched(zip: Uint8Array, at: number, value: number): Uint8Array {
  const copy = zip.slice()
  const dv = new DataView(copy.buffer)
  const first = dv.getUint32(copy.length - 22 + 16, true)
  if (dv.getUint32(first, true) !== CENTRAL) throw new Error('No central header.')
  dv.setUint32(first + at, value, true)
  return copy
}

/** A source that counts the bytes read from it. */
function counted(bytes: Uint8Array): ByteSource & { read_: number } {
  const inner = partsSource([bytes])
  const source = {
    size: inner.size,
    read_: 0,
    read(start: number, end: number) {
      const out = inner.read(start, end)
      source.read_ += out.length
      return out
    },
  }
  return source
}

describe('reading a zip made to hurt the reader', () => {
  it('stops a member that expands past its declared size within one small step', () => {
    // 64 MB of zeros deflate to some 64 KB; declared as 1000 bytes.
    const bomb = joinParts(zipParts([{ name: 'scan.ply', bytes: new Uint8Array(64 * MB), level: 6 }]))
    const zip = patched(bomb, 24, 1000)
    const source = partsSource([zip])
    const [member] = zipDirectory(source, 16)
    expect(member.size).toBe(1000)
    inflated.largest = 0
    const began = performance.now()
    expect(() => readZipMember(source, member)).toThrow(ZipFormatError)
    expect(performance.now() - began).toBeLessThan(2000)
    // One 16 KiB step expands to at most 16.5 MB; the whole stream, pushed
    // at once, would have been 64 MB.
    expect(inflated.largest).toBeGreaterThan(1000)
    expect(inflated.largest).toBeLessThanOrEqual(16 * 1024 * 1032 + 32 * 1024)
  })

  it('refuses a declared size deflate cannot reach before allocating or reading it', () => {
    const zip = joinParts(zipParts([{ name: 'scan.ply', bytes: new Uint8Array(100_000), level: 6 }]))
    const [listed] = zipDirectory(partsSource([zip]), 16)
    const lying = patched(zip, 24, listed.compressedSize * 1032 + 4096)
    const source = counted(lying)
    const [member] = zipDirectory(source, 16)
    source.read_ = 0
    expect(() => readZipMember(source, member)).toThrow(/expands past what deflate can/)
    // The local header only: none of the member's data.
    expect(source.read_).toBe(30)
    // At the most deflate can do, it is read and held to what comes out.
    const fair = patched(zip, 24, listed.compressedSize * 1032)
    expect(() => readZipMember(partsSource([fair]), zipDirectory(partsSource([fair]), 16)[0])).toThrow(/smaller than it says/)
  })

  it('checks every member against its CRC-32', () => {
    const scan = noise(20_000, 3)
    const text = strToU8('facet normal 0 0 1\n'.repeat(2000))
    for (const [bytes, level] of [[scan, 0], [text, 6]] as const) {
      const zip = joinParts(zipParts([{ name: 'scan.ply', bytes, level }]))
      const [member] = zipDirectory(partsSource([zip]), 16)
      expect(member.crc).toBe(crc32(bytes))
      expect(readZipMember(partsSource([zip]), member)).toEqual(bytes)
      const wrong = patched(zip, 16, (member.crc ^ 1) >>> 0)
      expect(() => readZipMember(partsSource([wrong]), zipDirectory(partsSource([wrong]), 16)[0])).toThrow(/CRC-32/)
    }
    // And a project whose member fails it is not opened.
    const m = blankManifest('0.11.2')
    const project = joinParts(packProjectParts(m, []))
    const [manifestMember] = zipDirectory(partsSource([project]), 16)
    expect(() => unpackProject(patched(project, 16, (manifestMember.crc ^ 0x80) >>> 0))).toThrow('Not a ScanRuler project file.')
  })

  it('takes the CRC-32 eight bytes at a time as it would one at a time, and in pieces', () => {
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
    const plain = (bytes: Uint8Array) => {
      let c = 0xffffffff
      for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const bytes = noise(10_007, 9)
    for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 1000, 10_007]) expect(crc32(bytes.subarray(0, n))).toBe(plain(bytes.subarray(0, n)))
    expect(crc32(bytes.subarray(5003), crc32(bytes.subarray(0, 5003)))).toBe(crc32(bytes))
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926)
  })
})

describe('writing a zip', () => {
  it('holds a small member in a buffer its own size, not a 32 MiB piece', () => {
    const parts = zipParts([
      { name: 'project.json', bytes: strToU8('{"a": 1}\n'.repeat(100)), level: 6 },
      { name: 'scan.ply', bytes: strToU8('vertex 1 2 3\n'.repeat(1000)), level: 6 },
    ])
    for (const part of parts) expect(part.buffer.byteLength).toBeLessThan(MB)
    const files = unzipSync(joinParts(parts))
    expect(files['scan.ply']).toEqual(strToU8('vertex 1 2 3\n'.repeat(1000)))
  })

  it('gives up an archive past its cap as soon as it is, before reading the next member', () => {
    let read = 0
    const member = (seed: number) => () => { read++; return noise(3 * MB, seed) }
    let error: unknown
    try {
      zipParts([{ name: 'a.ply', bytes: member(1), level: 6 }, { name: 'b.ply', bytes: member(2), level: 6 }], 0, new Date(), MB)
    } catch (e) { error = e }
    expect(error).toBeInstanceOf(ZipTooLargeError)
    expect((error as ZipTooLargeError).size).toBeGreaterThan(MB)
    // Stopped within the first member's deflate, and b.ply never read.
    expect((error as ZipTooLargeError).size).toBeLessThan(3.2 * MB)
    expect(read).toBe(1)
    // A stored member and the directory count too.
    expect(() => zipParts([{ name: 'a.bin', bytes: new Uint8Array(1000), level: 0 }], 0, new Date(), 1000)).toThrow(ZipTooLargeError)
    const exact = joinParts(zipParts([{ name: 'a.bin', bytes: new Uint8Array(1000), level: 0 }]))
    expect(zipParts([{ name: 'a.bin', bytes: new Uint8Array(1000), level: 0 }], 0, new Date(), exact.length)).toHaveLength(4)
    expect(() => zipParts([{ name: 'a.bin', bytes: new Uint8Array(1000), level: 0 }], 0, new Date(), exact.length - 1)).toThrow(ZipTooLargeError)
  })

  it('packs a project with its cap, and members kept as files read only as they are reached', () => {
    const m = blankManifest('0.11.2')
    expect(() => packProjectParts(m, [{ name: 'scan.ply', bytes: noise(2 * MB, 4) }], PROJECT_LIMITS, MB)).toThrow(ZipTooLargeError)
    const scan = noise(50_000, 5)
    const parts = packProjectParts(m, [{ name: 'scan.ply', bytes: new MemoryFile(scan, 'part.ply') }])
    expect(unpackProject(partsSource(parts)).members.get('scan.ply')).toEqual(scan)
  })

  it('reads a file on disk synchronously in the worker, and says which file could not be read', () => {
    const scan = noise(1000, 6)
    const disk = new File([scan as BlobPart], 'part.ply')
    const gone = new File([scan as BlobPart], 'moved.ply')
    const g = globalThis as { FileReaderSync?: unknown }
    g.FileReaderSync = class {
      readAsArrayBuffer(blob: Blob) {
        if (blob === gone) throw new Error('NotReadableError')
        return scan.slice().buffer
      }
    }
    try {
      const m = blankManifest('0.11.2')
      expect(unpackProject(partsSource(packProjectParts(m, [{ name: 'scan.ply', bytes: disk }]))).members.get('scan.ply')).toEqual(scan)
      expect(() => packProjectParts(m, [{ name: 'scan.ply', bytes: gone }])).toThrow(unreadableSource('moved.ply'))
    } finally {
      delete g.FileReaderSync
    }
  })

  it('reads the files of a project one after another', async () => {
    let inFlight = 0, most = 0
    class SlowBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return new ArrayBuffer(4)
      }
    }
    const files = await readMembers(['a', 'b', 'c'].map((name) => ({ name, bytes: new SlowBlob([]) })))
    expect(files.map((f) => f.bytes.length)).toEqual([4, 4, 4])
    expect(most).toBe(1)
  })

  it('posts a member held in memory as its bytes, a file on disk as the file', () => {
    const bytes = noise(10, 1)
    const disk = new File([bytes as BlobPart], 'disk.ply')
    const [memory, file, raw] = postableMembers([
      { name: 'a', bytes: new MemoryFile(bytes, 'a.ply') },
      { name: 'b', bytes: disk },
      { name: 'c', bytes },
    ])
    expect(memory.bytes).toBe(bytes)
    expect(file.bytes).toBe(disk)
    expect(raw.bytes).toBe(bytes)
  })

  it('opens a packed project once: its parts are transferred, and a second open says so', () => {
    const parts = zipParts([{ name: 'project.json', bytes: strToU8('{}'), level: 6 }])
    const file = new PackedFile(parts, 'recovered.scanruler')
    expect(packedParts(file)).toBe(parts)
    structuredClone(parts, { transfer: [...new Set(parts.map((p) => p.buffer as ArrayBuffer))] })
    expect(() => packedParts(file)).toThrow(/opened already/)
  })
})

/** Python's zipfile, where there is a Python. */
const python = (() => {
  for (const exe of ['python', 'python3']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) return exe
  }
  return null
})()

/** What Python's zipfile makes of `zip`: each member's name and size, after
 *  testzip has read every one against its CRC. */
function pythonReads(zip: Uint8Array): { bad: string | null; members: [string, number][] } {
  const script = [
    'import io, json, sys, zipfile',
    'z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'print(json.dumps({"bad": z.testzip(), "members": [[i.filename, len(z.read(i))] for i in z.infolist()]}))',
  ].join('\n')
  const r = spawnSync(python!, ['-I', '-c', script], { input: zip, encoding: 'utf8', maxBuffer: 16 * MB })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

describe.skipIf(!python)('a project zip read by Python zipfile', () => {
  const scan = noise(200_000, 2)
  const reference = strToU8('facet normal 0 0 1\n'.repeat(20_000))
  const entries = [{ name: 'scan.ply', bytes: scan, level: 6 as const }, { name: 'reference.stl', bytes: reference, level: 6 as const }]

  it('reads one without zip64 records, as fflate does', () => {
    const zip = joinParts(zipParts(entries))
    expect(pythonReads(zip)).toEqual({ bad: null, members: [['scan.ply', scan.length], ['reference.stl', reference.length]] })
    const files = unzipSync(zip)
    expect(files['scan.ply']).toEqual(scan)
    expect(files['reference.stl']).toEqual(reference)
  })

  it('reads one whose offsets and directory are in zip64 records', () => {
    // Begun 5 GiB in, every offset needs zip64; written without the 5 GiB in
    // front, which a reader takes as bytes prepended to the archive (as in a
    // self-extractor) and allows for.
    const parts = zipParts(entries, 5 * 1024 ** 3)
    const zip = joinParts(parts)
    expect(new DataView(zip.buffer).getUint32(zip.length - 22 - 20 - 56, true)).toBe(0x06064b50)
    expect(pythonReads(zip)).toEqual({ bad: null, members: [['scan.ply', scan.length], ['reference.stl', reference.length]] })
  })
})
