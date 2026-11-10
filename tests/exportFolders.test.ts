// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest'
import { runExport, saveBuilt } from '../src/app/exports'
import { projectOutputDirectory, rememberOutputDirectory, type RevisionDirectory } from '../src/app/projectRevisions'
import { useStore } from '../src/state/store'

afterEach(() => {
  rememberOutputDirectory(null)
  vi.unstubAllGlobals()
  useStore.setState({ errorText: null, statusText: '' })
})

it('writes all supported formats to the export folder, not the project folder', async () => {
  const project: RevisionDirectory = { name: 'Projects', async *keys() {}, getFileHandle: vi.fn() }
  rememberOutputDirectory(project)
  const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
  const exports: RevisionDirectory = {
    name: 'Exports', async *keys() {},
    getFileHandle: vi.fn(async () => ({ createWritable: async () => stream })),
  }
  vi.stubGlobal('indexedDB', undefined)
  vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => exports) })
  for (const extension of ['step', 'stp', 'stl', '3mf', 'ply', 'xyz', 'csv', 'svg', 'dxf']) {
    await runExport(() => saveBuilt({
      name: `Sample.${extension}`, bytes: new Uint8Array([1, 2]), mimeType: 'application/octet-stream',
      status: 'Export complete.',
    }))
    expect(exports.getFileHandle).toHaveBeenLastCalledWith(`Sample.${extension}`, { create: true })
    expect(useStore.getState().statusText).toContain(`Saved to Exports\\Sample.${extension}`)
  }
  expect(stream.close).toHaveBeenCalledTimes(9)
  expect(project.getFileHandle).not.toHaveBeenCalled()
  expect(await projectOutputDirectory()).toBe(project)
})
