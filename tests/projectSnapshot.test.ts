// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { collectProject, emptySources } from '../src/app/project'
import { ProjectSnapshotCache, snapshotKey } from '../src/app/projectSnapshot'

const project = () => collectProject(emptySources(), null, 'test')

describe('cached project snapshots', () => {
  it('shares serialization across dirty checks, checkpoint writes and unload checks', () => {
    const capture = vi.fn(project)
    const cache = new ProjectSnapshotCache(capture)
    const serialize = vi.spyOn(cache, 'key')
    const baseline = cache.inspect().signature
    const snapshot = cache.forWrite()
    cache.release(snapshot)
    for (let i = 0; i < 100; i++) expect(cache.inspect().signature).toBe(baseline)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('sees an edit immediately, including one made after a save snapshot was taken', () => {
    let current = project()
    const cache = new ProjectSnapshotCache(() => current)
    const savedSnapshot = cache.forWrite()
    const savedKey = cache.key(savedSnapshot)
    current = { ...current, manifest: { ...current.manifest, workspace: 'flat' } }
    cache.invalidate()
    expect(cache.inspect().signature).not.toBe(savedKey)
    expect(cache.forWrite().manifest.workspace).toBe('flat')
    expect(savedSnapshot.manifest.workspace).not.toBe('flat')
  })

  it('does not let an older completed write evict a newer pending snapshot', () => {
    const capture = vi.fn(project)
    const cache = new ProjectSnapshotCache(capture)
    const older = cache.forWrite()
    cache.invalidate()
    const newer = cache.forWrite()
    cache.release(older)
    expect(cache.forWrite()).toBe(newer)
    expect(capture).toHaveBeenCalledTimes(2)
    cache.release(newer)
    cache.forWrite()
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('does not cache a failed projection', () => {
    const capture = vi.fn(project).mockImplementationOnce(() => { throw new Error('transient failure') })
    const cache = new ProjectSnapshotCache(capture)
    expect(() => cache.inspect()).toThrow('transient failure')
    expect(cache.inspect().hasContent).toBe(false)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('recognizes undo back to saved state without treating new arrays as new content', () => {
    let current = project()
    const original = structuredClone(current)
    const cache = new ProjectSnapshotCache(() => current)
    const saved = cache.inspect().signature
    current = { ...current, manifest: { ...current.manifest, workspace: 'flat' } }
    cache.invalidate()
    expect(cache.inspect().signature).not.toBe(saved)
    current = original
    cache.invalidate()
    expect(cache.inspect().signature).toBe(saved)
  })

  it('distinguishes replacement source bytes with the same name', () => {
    const key = snapshotKey()
    const snapshot = project()
    const bytes = new Uint8Array([1, 2, 3])
    snapshot.members = [{ name: 'scan.obj', bytes }]
    const saved = key(snapshot)
    expect(key({ ...snapshot, members: [{ name: 'scan.obj', bytes }] })).toBe(saved)
    expect(key({ ...snapshot, members: [{ name: 'scan.obj', bytes: new Uint8Array([4, 5, 6]) }] })).not.toBe(saved)
  })
})
