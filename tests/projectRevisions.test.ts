// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseProjectSave, projectRevisionName, revisionBase, writeProjectRevision, writeMeshExport, projectOutputDirectory, rememberOutputDirectory, saveLocalExport, type RevisionDirectory } from '../src/app/projectRevisions'

afterEach(() => {
  rememberOutputDirectory(null)
  vi.unstubAllGlobals()
})

describe('numbered project revisions', () => {
  it('uses the export Save As selection without changing the remembered project directory', async () => {
    const directory: RevisionDirectory = { name: 'Projects', async *keys() {}, getFileHandle: vi.fn() }
    rememberOutputDirectory(directory)
    const fetch = vi.fn(async (url: string) => url.includes('?choose=')
      ? Response.json({ token: 'export-token', name: 'Renamed.step', directory: 'F:\\Exports' })
      : new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const blob = new Blob(['STEP'], { type: 'model/step' })
    expect(await saveLocalExport('Roof.step', blob)).toBe('F:\\Exports\\Renamed.step')
    expect(fetch).toHaveBeenNthCalledWith(1, '/__scanruler/output?choose=Roof.step&kind=export', {
      method: 'POST', headers: { 'X-ScanRuler-Output': '1' },
    })
    expect(fetch).toHaveBeenNthCalledWith(2, '/__scanruler/output?selection=export-token', {
      method: 'POST', headers: { 'X-ScanRuler-Output': '1' }, body: blob,
    })
    expect(await projectOutputDirectory()).toBe(directory)
  })

  it('propagates export cancellation and write errors without falling back to Downloads', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await expect(saveLocalExport('Roof.step', new Blob(['STEP']))).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockResolvedValueOnce(Response.json({ token: 'export-token', name: 'Roof.step', directory: 'F:\\Exports' }))
      .mockResolvedValueOnce(new Response('Disk full', { status: 500 }))
    await expect(saveLocalExport('Roof.step', new Blob(['STEP']))).rejects.toThrow('Disk full')
  })

  it.each([
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0', '127.0.0.1'],
    ['Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36', 'localhost'],
    ['VS Code', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Code/1.144.0 Electron/43.8.3', '127.0.0.1'],
  ])('uses Windows Save As in local %s without asking for a directory', async (_browser, userAgent, hostname) => {
    const picker = vi.fn(() => { throw new Error('The folder picker must not open.') })
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('window', { location: { hostname }, showDirectoryPicker: picker })
    const fetch = vi.fn(async (url: string) => url.includes('?choose=')
      ? Response.json({ token: 'selection', name: 'Roof-5.scanruler', directory: 'F:\\Mods' })
      : Response.json({ name: 'F:\\Mods', names: ['Roof-4.scanruler'] }))
    vi.stubGlobal('fetch', fetch)
    const directory = await projectOutputDirectory()
    const target = await chooseProjectSave(directory, 'Roof')
    expect(target.path).toBe('F:\\Mods\\Roof-5.scanruler')
    expect(fetch).toHaveBeenLastCalledWith('/__scanruler/output?choose=Roof-5.scanruler', {
      method: 'POST', headers: { 'X-ScanRuler-Output': '1' },
    })
    expect(picker).not.toHaveBeenCalled()
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
    expect(projectRevisionName('Spark Roof Back', [])).toBe('Spark Roof Back-1.scanruler')
    expect(projectRevisionName('Spark Roof Back', [], 'Spark Roof Back-1.scanruler')).toBe('Spark Roof Back-2.scanruler')
    expect(projectRevisionName('Spark Roof Back', ['Spark Roof Back-1.scanruler', 'Spark Roof Back-4.scanruler', 'Other-99.scanruler'])).toBe('Spark Roof Back-5.scanruler')
    expect(projectRevisionName('Spark Roof Back', ['spark roof back-8.scanruler'])).toBe('Spark Roof Back-9.scanruler')
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
    expect(projectRevisionName(base, ['Spark Roof Back-9.scanruler', saved], saved)).toBe('Spark Roof Back_A-10.scanruler')
    expect(projectRevisionName(base, [], saved)).toBe('Spark Roof Back_A-10.scanruler')
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
    expect(await writeProjectRevision(directory, 'Spark Roof Back', new Uint8Array([1, 2]))).toBe('Spark Roof Back-3.scanruler')
    expect(directory.getFileHandle).toHaveBeenCalledWith('Spark Roof Back-3.scanruler', { create: true })
    expect(stream.write).toHaveBeenCalledOnce()
    expect(stream.close).toHaveBeenCalledOnce()
    expect(stream.abort).not.toHaveBeenCalled()
    stream.write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(writeProjectRevision(directory, 'Spark Roof Back', new Uint8Array([1]))).rejects.toThrow('Disk full')
    expect(stream.abort).toHaveBeenCalledOnce()
  })

  it('exports to the shared project folder, numbers collisions and propagates write failures', async () => {
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
    const write = vi.fn()
    const chooseSave = vi.fn(async (_name: string) => ({ name: 'Custom.scanruler', path: 'D:\\Other\\Custom.scanruler', write }))
    const directory: RevisionDirectory = {
      name: 'Mods',
      async *keys() { yield 'Roof-4.scanruler' },
      getFileHandle: vi.fn(),
      chooseSave,
    }
    const target = await chooseProjectSave(directory, 'Roof')
    expect(chooseSave).toHaveBeenCalledWith('Roof-5.scanruler')
    expect(target.path).toBe('D:\\Other\\Custom.scanruler')
    expect(target.name).toBe('Custom.scanruler')
    expect(write).not.toHaveBeenCalled()
    await target.write(new Uint8Array([1]))
    expect(write).toHaveBeenCalledOnce()
    expect(directory.getFileHandle).not.toHaveBeenCalled()
  })
})
