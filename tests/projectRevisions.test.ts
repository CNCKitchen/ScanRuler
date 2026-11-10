// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseProjectSave, projectRevisionName, revisionBase, writeProjectRevision, writeMeshExport, projectOutputDirectory, rememberOutputDirectory, type RevisionDirectory } from '../src/app/projectRevisions'

afterEach(() => {
  rememberOutputDirectory(null)
  vi.unstubAllGlobals()
})

describe('numbered project revisions', () => {
  it('selects separate browser export and project folders without using a server', async () => {
    vi.resetModules()
    const folders = await import('../src/app/projectRevisions')
    const directory: RevisionDirectory = { name: 'Projects', async *keys() {}, getFileHandle: vi.fn() }
    const exports: RevisionDirectory = { name: 'Exports', async *keys() {}, getFileHandle: vi.fn() }
    folders.rememberOutputDirectory(directory)
    const picker = vi.fn(async () => exports)
    vi.stubGlobal('window', { showDirectoryPicker: picker })
    vi.stubGlobal('indexedDB', undefined)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await folders.exportOutputDirectory()).toBe(exports)
    expect(await folders.projectOutputDirectory()).toBe(directory)
    expect(picker).toHaveBeenCalledWith({ id: 'scanruler-exports', mode: 'readwrite' })
    expect(await folders.exportOutputDirectory()).toBe(exports)
    expect(picker).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves both folders when changing a folder is cancelled', async () => {
    vi.resetModules()
    const folders = await import('../src/app/projectRevisions')
    const directory: RevisionDirectory = { name: 'Projects', async *keys() {}, getFileHandle: vi.fn() }
    folders.rememberOutputDirectory(directory)
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')) })
    vi.stubGlobal('indexedDB', undefined)
    await expect(folders.chooseOutputDirectory('project')).rejects.toMatchObject({ name: 'AbortError' })
    expect(await folders.projectOutputDirectory()).toBe(directory)
  })

  it('renews a saved folder permission and explicitly rejects denial', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const directory: RevisionDirectory = {
      name: 'Projects', async *keys() {}, getFileHandle: vi.fn(),
      queryPermission: vi.fn().mockResolvedValue('prompt'), requestPermission,
    }
    rememberOutputDirectory(directory)
    expect(await projectOutputDirectory()).toBe(directory)
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    requestPermission.mockResolvedValue('denied')
    await expect(projectOutputDirectory()).rejects.toThrow('Write permission for the saved project folder was not granted')
  })

  it.each([
    ['hosted Windows app', 'Windows NT 10.0', 'scanruler.com'],
    ['local non-Windows app', 'X11; Linux x86_64', 'localhost'],
  ])('retains the browser directory flow for the %s', async (_app, userAgent, hostname) => {
    const directory: RevisionDirectory = { name: 'Browser output', async *keys() {}, getFileHandle: vi.fn() }
    const picker = vi.fn(async () => directory)
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('window', { location: { hostname }, showDirectoryPicker: picker })
    vi.stubGlobal('indexedDB', undefined)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await projectOutputDirectory()).toBe(directory)
    expect(picker).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts at one, continues the opened revision and skips every existing revision', () => {
    expect(projectRevisionName('Spark Roof Back', [])).toBe('Spark Roof Back-001.scanruler')
    expect(projectRevisionName('Spark Roof Back', [], 'Spark Roof Back-1.scanruler')).toBe('Spark Roof Back-002.scanruler')
    expect(projectRevisionName('Spark Roof Back', ['Spark Roof Back-1.scanruler', 'Spark Roof Back-4.scanruler', 'Other-99.scanruler'])).toBe('Spark Roof Back-005.scanruler')
    expect(projectRevisionName('Spark Roof Back', ['spark roof back-8.scanruler'])).toBe('Spark Roof Back-009.scanruler')
  })

  it.each([
    ['009', '010'],
    ['099', '100'],
    ['999', '1000'],
  ])('continues padded revision %s as %s without limiting the sequence', (opened, next) => {
    expect(projectRevisionName('Part', [], `Part-${opened}.scanruler`)).toBe(`Part-${next}.scanruler`)
    expect(projectRevisionName('Part', [`Part-${opened}.scanruler`])).toBe(`Part-${next}.scanruler`)
  })

  it('finds the highest revision across padded and legacy filenames', () => {
    expect(projectRevisionName('Part', ['Part-9.scanruler', 'PART-010.SCANRULER', 'Part-2.scanruler'], 'Part-008.scanruler')).toBe('Part-011.scanruler')
    expect(revisionBase('Part.scanruler', 'Part-011.scanruler')).toBe('Part')
  })

  it('does not append revision numbers repeatedly or strip numeric project names', () => {
    expect(revisionBase('Spark Roof Back-2.scanruler', 'Spark Roof Back-2.scanruler')).toBe('Spark Roof Back')
    expect(revisionBase('Spark Roof Back.scanruler', 'Spark Roof Back-2.scanruler')).toBe('Spark Roof Back')
    expect(revisionBase('Part-2026.scanruler')).toBe('Part-2026')
  })

  it('continues the last selected filename independently of the project title', () => {
    const title = 'Spark Roof Back.scanruler'
    const saved = 'Spark Roof Back_A-9.scanruler'
    const base = revisionBase(title, saved, title)
    expect(base).toBe('Spark Roof Back_A')
    expect(projectRevisionName(base, ['Spark Roof Back-9.scanruler', saved], saved)).toBe('Spark Roof Back_A-010.scanruler')
    expect(projectRevisionName(base, [], saved)).toBe('Spark Roof Back_A-010.scanruler')
    expect(revisionBase(title, 'Custom.scanruler', title)).toBe('Custom')
    expect(revisionBase(title, saved)).toBe('Spark Roof Back_A')
    expect(revisionBase('New title.scanruler', saved, title)).toBe('New title')
    expect(revisionBase('Part-2026.scanruler', saved, title)).toBe('Part-2026')
  })

  it('writes and closes only a new revision in the selected directory', async () => {
    const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn() }
    const directory: RevisionDirectory = {
      name: 'Mods',
      async *keys() { yield 'Spark Roof Back-1.scanruler'; yield 'Spark Roof Back-2.scanruler' },
      getFileHandle: vi.fn().mockResolvedValue({ createWritable: async () => stream }),
    }
    expect(await writeProjectRevision(directory, 'Spark Roof Back', new Uint8Array([1, 2]))).toBe('Spark Roof Back-003.scanruler')
    expect(directory.getFileHandle).toHaveBeenCalledWith('Spark Roof Back-003.scanruler', { create: true })
    expect(stream.write).toHaveBeenCalledOnce()
    expect(stream.close).toHaveBeenCalledOnce()
    expect(stream.abort).not.toHaveBeenCalled()
    stream.write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(writeProjectRevision(directory, 'Spark Roof Back', new Uint8Array([1]))).rejects.toThrow('Disk full')
    expect(stream.abort).toHaveBeenCalledOnce()
  })

  it('numbers export collisions and propagates write failures', async () => {
    const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn() }
    const directory: RevisionDirectory = {
      name: 'Mods',
      async *keys() { yield 'Roof-edited.stl'; yield 'ROOF-EDITED-2.STL' },
      getFileHandle: vi.fn().mockResolvedValue({ createWritable: async () => stream }),
    }
    rememberOutputDirectory(directory)
    try {
      expect(await projectOutputDirectory()).toBe(directory)
      expect(await writeMeshExport(directory, 'Roof-edited.stl', new Uint8Array([1]), 'model/stl')).toBe('Roof-edited-3.stl')
      expect(directory.getFileHandle).toHaveBeenCalledWith('Roof-edited-3.stl', { create: true })
      expect(await writeMeshExport(directory, 'Roof-edited.3mf', new Uint8Array([1]), 'model/3mf')).toBe('Roof-edited.3mf')
      stream.write.mockRejectedValueOnce(new Error('Disk full'))
      await expect(writeMeshExport(directory, 'Roof-edited.stl', new Uint8Array([1]), 'model/stl')).rejects.toThrow('Disk full')
      expect(stream.abort).toHaveBeenCalledOnce()
    } finally {
      rememberOutputDirectory(null)
    }
  })

  it('offers the next revision in Save As and honors a changed filename and destination', async () => {
    const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
    const picker = vi.fn(async () => ({ name: 'Custom.scanruler', createWritable: async () => stream }))
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    const directory: RevisionDirectory = {
      name: 'Mods',
      async *keys() { yield 'Roof-4.scanruler' },
      getFileHandle: vi.fn(),
    }
    const target = await chooseProjectSave(directory, 'Roof')
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Roof-005.scanruler', startIn: directory }))
    expect(target.path).toBe('Custom.scanruler')
    expect(target.name).toBe('Custom.scanruler')
    expect(stream.write).not.toHaveBeenCalled()
    await target.write(new Uint8Array([1]))
    expect(stream.write).toHaveBeenCalledOnce()
    expect(directory.getFileHandle).not.toHaveBeenCalled()
  })
})
