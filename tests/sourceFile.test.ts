// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { prepareNominal, prepareScan } from '../src/app/imports'
import { readMembers } from '../src/core/project/archive'
import { KEEP_COPY_BYTES, keptSource, readSourceFile, unreadableSource } from '../src/core/sourceFile'
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
    const scanFile = new ReexportedFile([new Uint8Array([1, 2, 3])], 'big.ply', KEEP_COPY_BYTES + 1)
    const scan = await prepareScan(client, null, scanFile, { mode: 'off', angleDeg: 30 })
    const message = unreadableSource('big.ply')
    expect(message).toMatch(/^big\.ply can no longer be read — the file was changed, moved or deleted after it was opened.*Open it again\.$/)
    await expect(readSourceFile(scan.source.file, 'big.ply')).rejects.toThrow(message)
    // Saving a project reads it the same way, and says the same — under the
    // name it was opened as, not the member it goes into.
    await expect(readMembers([{ name: 'scan.ply', bytes: scan.source.file }])).rejects.toThrow(unreadableSource('big.ply'))
    const gone = new GoneFile([new Uint8Array([1])], 'part.stl')
    await expect(readSourceFile(gone, 'part.stl')).rejects.toThrow(unreadableSource('part.stl'))
  })

  it('reads the file when the bytes are needed', async () => {
    const file = new File([new Uint8Array([7, 8, 9])], 'part.stl')
    const [member] = await readMembers([{ name: 'scan.stl', bytes: file }])
    expect(Array.from(member.bytes)).toEqual([7, 8, 9])
  })
})
