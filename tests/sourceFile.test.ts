// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { prepareNominal, prepareScan } from '../src/app/imports'
import { readMembers } from '../src/core/project/archive'
import { KEEP_COPY_BYTES, keptSource, MAX_READ_BYTES, MemoryFile, NATIVE_BLOB_BYTES, nativeBlob, readInPieces, readOpenedFile, readSourceFile, storedBytes, tooLargeToOpen, unreadableSource } from '../src/core/sourceFile'
import { clearHistory, configureHistory, HISTORY_BYTE_BUDGET, historyAction, scanBytes, useHistory } from '../src/state/historyStore'
import type { MeshWorkerClient } from '../src/core/workerClient'

/** A worker that takes whatever it is given and hands back an empty mesh. */
const client = {
  prepareScan: async () => ({ id: 1, mesh: {} }),
  prepareNominal: async () => ({ id: 2, mesh: {} }),
  discardImport: async () => {},
} as unknown as MeshWorkerClient

/** A file as the browser reports one changed or deleted on disk since it
 *  was opened. */
class GoneFile extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new DOMException('The file could not be read.', 'NotReadableError'))
  }
}

/** A file re-exported in place after it was opened: the first read works,
 *  every later one fails as the browser fails it. `reported` stands in for
 *  its size, so a large one needs no memory. */
class ReexportedFile extends File {
  reads = 0
  constructor(parts: BlobPart[], name: string, private readonly reported?: number) { super(parts, name) }
  override get size(): number { return this.reported ?? super.size }
  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.reads++ === 0 ? super.arrayBuffer() : Promise.reject(new DOMException('The file could not be read.', 'NotReadableError'))
  }
}

describe('a scan or reference the session keeps', () => {
  it('keeps a copy of a file up to the limit, which reads after the file on disk changed', async () => {
    const scanFile = new ReexportedFile([new Uint8Array([1, 2, 3])], 'part.stl')
    const scan = await prepareScan(client, null, scanFile, { mode: 'off', angleDeg: 30 })
    expect(scan.source.file).not.toBe(scanFile)
    expect(scan.source).not.toHaveProperty('bytes')
    // Held in the page, not handed to the browser's blob storage.
    expect(scan.source.file).toBeInstanceOf(MemoryFile)
    // The file has been re-exported since; the copy does not care.
    await expect(scanFile.arrayBuffer()).rejects.toThrow()
    expect(Array.from(new Uint8Array(await readSourceFile(scan.source.file, 'part.stl')))).toEqual([1, 2, 3])
    const [member] = await readMembers([{ name: 'scan.stl', bytes: scan.source.file }])
    expect(Array.from(member.bytes)).toEqual([1, 2, 3])
    const refFile = new ReexportedFile([new Uint8Array([4, 5])], 'part.step')
    const nominal = await prepareNominal(client, null, refFile)
    expect(nominal.source.file).not.toBe(refFile)
    expect(Array.from(new Uint8Array(await nominal.source.file.arrayBuffer()))).toEqual([4, 5])
  })

  it('keeps only the file past the limit, not a copy of its bytes', async () => {
    const scanFile = new ReexportedFile([new Uint8Array([1, 2, 3])], 'big.ply', KEEP_COPY_BYTES + 1)
    const scan = await prepareScan(client, null, scanFile, { mode: 'off', angleDeg: 30 })
    expect(scan.source.file).toBe(scanFile)
    const refFile = new ReexportedFile([new Uint8Array([4, 5])], 'big.step', KEEP_COPY_BYTES + 1)
    expect((await prepareNominal(client, null, refFile)).source.file).toBe(refFile)
    // At the limit itself it is still a copy.
    const atLimit = new ReexportedFile([new Uint8Array([1])], 'edge.stl', KEEP_COPY_BYTES)
    expect(keptSource(atLimit, new ArrayBuffer(1))).not.toBe(atLimit)
  })

  it('says why a large file re-exported in place can no longer be read, and to open it again', async () => {
    const scanFile = new ReexportedFile([new Uint8Array([1, 2, 3])], 'big.stl', KEEP_COPY_BYTES + 1)
    const scan = await prepareScan(client, null, scanFile, { mode: 'off', angleDeg: 30 })
    const message = unreadableSource('big.stl')
    expect(message).toMatch(/^big\.stl can no longer be read — the file was changed, moved or deleted after it was opened.*Open it again\.$/)
    await expect(readSourceFile(scan.source.file, 'big.stl')).rejects.toThrow(message)
    // Saving a project reads it the same way, and says the same — under the
    // name it was opened as, not the member it goes into.
    await expect(readMembers([{ name: 'scan.stl', bytes: scan.source.file }])).rejects.toThrow(unreadableSource('big.stl'))
    const gone = new GoneFile([new Uint8Array([1])], 'part.stl')
    await expect(readSourceFile(gone, 'part.stl')).rejects.toThrow(unreadableSource('part.stl'))
  })

  it('names every scan format, the point clouds too, when it refuses a scan', async () => {
    await expect(prepareScan(client, null, new File([new Uint8Array([1])], 'part.dat'), { mode: 'off', angleDeg: 30 })).rejects.toThrow(
      'Unsupported file type — use STL, PLY, OBJ, 3MF, STEP, XYZ, ASC or PTS.',
    )
  })

  it('reads the file when the bytes are needed', async () => {
    const file = new File([new Uint8Array([7, 8, 9])], 'part.stl')
    const [member] = await readMembers([{ name: 'scan.stl', bytes: file }])
    expect(Array.from(member.bytes)).toEqual([7, 8, 9])
  })
})

describe('a file made of bytes the page holds', () => {
  it('reads back from memory, whole and in slices, and is kept as it is', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50])
    const file = new MemoryFile(bytes, 'agent.ply')
    expect(file.name).toBe('agent.ply')
    expect(file.size).toBe(5)
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([10, 20, 30, 40, 50])
    expect(Array.from(new Uint8Array(await file.slice(1, -1).arrayBuffer()))).toEqual([20, 30, 40])
    expect(Array.from(new Uint8Array(await file.slice(0, 2).arrayBuffer()))).toEqual([10, 20])
    expect(await new MemoryFile(new TextEncoder().encode('ply'), 'a.ply').text()).toBe('ply')
    // A read is a copy: the worker the buffer goes to cannot take the bytes away.
    const read = await file.arrayBuffer()
    new Uint8Array(read)[0] = 99
    expect(bytes[0]).toBe(10)
    // The session keeps the file itself, at any size, and stores its bytes.
    const scan = await prepareScan(client, null, file, { mode: 'off', angleDeg: 30 })
    expect(scan.source.file).toBe(file)
    expect(storedBytes(scan.source.file)).toBe(bytes)
    const disk = new File([new Uint8Array([1])], 'disk.stl')
    expect(storedBytes(disk)).toBe(disk)
    const [member] = await readMembers([{ name: 'scan.ply', bytes: storedBytes(scan.source.file) }])
    expect(Array.from(member.bytes)).toEqual([10, 20, 30, 40, 50])
  })
})

describe('a file too large to read', () => {
  /** A file that says it is 2.69 GB and fails any read the way Chrome does. */
  class HugeFile extends File {
    reads = 0
    override get size(): number { return 2_690_000_000 }
    override arrayBuffer(): Promise<ArrayBuffer> {
      this.reads++
      return Promise.reject(new DOMException('The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.', 'NotReadableError'))
    }
  }

  it('is refused by its size before anything is read, naming the limit', async () => {
    const huge = new HugeFile([], 'lucy8x.stl')
    const message = tooLargeToOpen('lucy8x.stl', huge.size)!
    expect(message).toBe('lucy8x.stl is 2.69 GB — too large to open: a browser reads a file of at most 2 GiB (2,147,483,647 bytes) in one piece. Decimate or split it in the software that wrote it, and open that.')
    await expect(prepareScan(client, null, huge, { mode: 'off', angleDeg: 30 })).rejects.toThrow(message)
    await expect(prepareNominal(client, null, new HugeFile([], 'lucy8x.stl'))).rejects.toThrow(/too large to open/)
    expect(huge.reads).toBe(0)
    expect(tooLargeToOpen('a.ply', MAX_READ_BYTES)).toBeNull()
    expect(tooLargeToOpen('a.ply', MAX_READ_BYTES + 1)).toMatch(/^a\.ply is 2\.15 GB — too large/)
  })

  it('opens a point cloud past 2 GiB: the worker reads the file a piece at a time, thinned as asked', async () => {
    const huge = new HugeFile([], 'lucy8x-cloud.ply')
    const sent: unknown[][] = []
    const watching = { ...client, prepareScan: async (...args: unknown[]) => { sent.push(args); return { id: 1, mesh: {} } } } as unknown as MeshWorkerClient
    const scan = await prepareScan(watching, null, huge, { mode: 'off', angleDeg: 30 }, undefined, 'mm', 1, 30_000_000)
    expect(huge.reads).toBe(0)
    expect(sent[0][1]).toBe(huge)
    expect(sent[0][7]).toBe(30_000_000)
    // The session keeps the file and how it was thinned, to read it the same way again.
    expect(scan.source.file).toBe(huge)
    expect(scan.source).toMatchObject({ maxPoints: 30_000_000 })
    expect(readInPieces(huge, huge.name)).toBe(true)
    expect(readInPieces(huge, 'lucy8x.stl')).toBe(false)
    expect(readInPieces(new MemoryFile(new Uint8Array(1), 'a.ply'), 'a.ply')).toBe(false)
  })

  it('says a refused read in words, not in the browser’s permission text', async () => {
    const gone = new GoneFile([new Uint8Array([1])], 'part.stl')
    await expect(readOpenedFile(gone, 'part.stl')).rejects.toThrow('part.stl could not be read: the browser could not read it from disk — it may have been moved, changed or deleted, or be locked by another program.')
  })
})

describe('a MemoryFile handed to the browser', () => {
  it('is a Blob of its bytes for the browser, a file on disk itself, and one too large is refused', async () => {
    const disk = new File([new Uint8Array([1])], 'disk.png')
    expect(nativeBlob(disk, 'disk.png')).toBe(disk)
    const mem = new MemoryFile(new Uint8Array([1, 2, 3]), 'agent.png')
    const blob = nativeBlob(mem, 'agent.png', 'image/png')
    expect(blob).not.toBeInstanceOf(MemoryFile)
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3])
    class Big extends MemoryFile { override get size() { return NATIVE_BLOB_BYTES + 1 } }
    expect(() => nativeBlob(new Big(new Uint8Array(1), 'big.png'), 'big.png')).toThrow(/^big\.png is 268 MB — too large for the browser to read from memory/)
  })
})

describe('the undo history weighs the scans it holds', () => {
  it('counts a scan held in memory, not one on disk', () => {
    expect(scanBytes({ name: 'a.ply', file: new MemoryFile(new Uint8Array(5), 'a.ply') })).toBe(5)
    expect(scanBytes({ name: 'a.ply', file: new File([new Uint8Array(5)], 'a.ply') })).toBe(0)
    expect(scanBytes(null)).toBe(0)
  })

  it('keeps no more steps across edits of a large cloud than fit the byte budget', () => {
    // An edit of a 300 MB cloud, each a scan of its own held in the page.
    class Edit extends MemoryFile { override get size() { return 300e6 } }
    let scan: object = { name: 'c.ply', file: new Edit(new Uint8Array(1), 'c.ply') }
    clearHistory()
    const stop = configureHistory({ getScan: () => scan })
    try {
      for (let i = 0; i < 20; i++) historyAction(`clean ${i}`, () => { scan = { name: 'c.ply', file: new Edit(new Uint8Array(1), 'c.ply') } })
      const past = useHistory.getState().past
      const held = new Set<unknown>()
      for (const e of past) for (const side of [e.before, e.after]) if (side.scan) held.add(side.scan)
      expect([...held].reduce((sum: number, s) => sum + scanBytes(s), 0)).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET)
      expect(past.at(-1)!.label).toBe('clean 19')
      expect(past.length).toBeGreaterThan(0)
    } finally {
      stop()
      clearHistory()
    }
  })
})
