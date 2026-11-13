// SPDX-License-Identifier: AGPL-3.0-only
// A checkpoint is let go of only once the project restored from it has
// opened: an open that fails, is declined or is refused keeps it.
import { describe, expect, it } from 'vitest'
import { restoreCheckpoint } from '../src/app/useRecovery'
import { runImportDone } from '../src/app/imports'
import { ImportQueue } from '../src/app/importQueue'
import { PackedFile } from '../src/core/project/projectClient'
import { blankManifest } from '../src/app/project'
import { useStore } from '../src/state/store'

function storage() {
  const removed: string[] = []
  return {
    removed,
    read: async () => ({ manifest: blankManifest('0.11.2'), members: [] }),
    remove: async (id: string) => { removed.push(id) },
  }
}
const pack = async () => [new Uint8Array(4)]

describe('restoring a checkpoint', () => {
  it('lets it go once the project has opened', async () => {
    const db = storage()
    const opened: File[] = []
    const status = await restoreCheckpoint('a', db, pack, async (file) => { opened.push(file); return true })
    expect(status).toBeNull()
    expect(opened[0]).toBeInstanceOf(PackedFile)
    expect(db.removed).toEqual(['a'])
  })

  it('keeps it when the open fails, saying why', async () => {
    const db = storage()
    const status = await restoreCheckpoint('a', db, pack, async () => false, () => 'Malformed project: scan alignment.')
    expect(status).toBe('Recovery failed: Malformed project: scan alignment. The checkpoint is kept.')
    expect(db.removed).toEqual([])
  })

  it('keeps it when the open is declined', async () => {
    const db = storage()
    expect(await restoreCheckpoint('a', db, pack, async () => false, () => null)).toBe('The checkpoint was not opened; it is kept.')
    expect(db.removed).toEqual([])
  })

  it('keeps it when packing fails', async () => {
    const db = storage()
    const status = await restoreCheckpoint('a', db, async () => { throw new Error('Project worker failed.') }, async () => true)
    expect(status).toBe('Recovery failed: Project worker failed. The checkpoint is kept.')
    expect(db.removed).toEqual([])
  })

  it('learns from the import whether the open ran and finished', async () => {
    const queue = new ImportQueue()
    expect(await runImportDone(queue, 'Reading project…', async () => {})).toBe(true)
    expect(await runImportDone(queue, 'Reading project…', async () => {}, () => false)).toBe(false)
    expect(await runImportDone(queue, 'Reading project…', async () => { throw new Error('Not a ScanRuler project file.') })).toBe(false)
    expect(useStore.getState().errorText).toBe('Not a ScanRuler project file.')
    // Wired together: the failed open's error is what the recovery says.
    const db = storage()
    const status = await restoreCheckpoint('a', db, pack, () => runImportDone(queue, 'Reading project…', async () => { throw new Error('Project is missing scan.ply.') }))
    expect(status).toBe('Recovery failed: Project is missing scan.ply. The checkpoint is kept.')
    expect(db.removed).toEqual([])
  })
})
