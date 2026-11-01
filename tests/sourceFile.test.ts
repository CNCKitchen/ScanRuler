// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { prepareNominal, prepareScan } from '../src/app/imports'
import { readMembers } from '../src/core/project/archive'
import { readSourceFile, unreadableSource } from '../src/core/sourceFile'
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

describe('a scan or reference kept as its file', () => {
  it('holds the file it was opened from, not a copy of its bytes', async () => {
    const scanFile = new File([new Uint8Array([1, 2, 3])], 'part.stl')
    const scan = await prepareScan(client, null, scanFile, { mode: 'off', angleDeg: 30 })
    expect(scan.source.file).toBe(scanFile)
    expect(scan.source).not.toHaveProperty('bytes')
    const refFile = new File([new Uint8Array([4, 5])], 'part.step')
    const nominal = await prepareNominal(client, null, refFile)
    expect(nominal.source.file).toBe(refFile)
  })

  it('says to open the scan again when the file can no longer be read', async () => {
    const gone = new GoneFile([new Uint8Array([1])], 'part.stl')
    const message = unreadableSource('part.stl')
    expect(message).toMatch(/^part\.stl can no longer be read.*Open the scan again\.$/)
    await expect(readSourceFile(gone, 'part.stl')).rejects.toThrow(message)
    // Saving a project reads it the same way, and says the same.
    await expect(readMembers([{ name: 'scan.stl', bytes: gone }])).rejects.toThrow(unreadableSource('scan.stl'))
  })

  it('reads the file when the bytes are needed', async () => {
    const file = new File([new Uint8Array([7, 8, 9])], 'part.stl')
    const [member] = await readMembers([{ name: 'scan.stl', bytes: file }])
    expect(Array.from(member.bytes)).toEqual([7, 8, 9])
  })
})
