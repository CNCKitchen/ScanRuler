// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localOutputHandler } from '../scripts/localOutput'

let server: Server | null = null
let directory: string | null = null
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  if (directory) await rm(directory, { recursive: true })
  server = null
  directory = null
  vi.restoreAllMocks()
})

async function setup(options: Parameters<typeof localOutputHandler>[1] = {}) {
  directory = await mkdtemp(join(tmpdir(), 'scanruler-output-'))
  const handler = localOutputHandler(directory, options)
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local server address.')
  const url = `http://127.0.0.1:${address.port}`
  return { url, headers: { Origin: url, 'X-ScanRuler-Output': '1' } }
}

describe('configured local output', () => {
  it('follows project saves until the first successful export establishes its own folder', async () => {
    const choose = vi.fn(async (_directory: string, name: string) => join(directory!, 'Moved', name))
    const { url, headers } = await setup({ choose })
    await mkdir(join(directory!, 'Moved'))
    const { token } = await (await fetch(`${url}?choose=Roof.scanruler`, { method: 'POST', headers })).json()
    expect((await fetch(`${url}?selection=${token}`, { method: 'POST', headers, body: 'project' })).status).toBe(201)
    expect((await fetch(`${url}?choose=Roof.step&kind=export`, { method: 'POST', headers })).status).toBe(200)
    expect(choose).toHaveBeenLastCalledWith(join(directory!, 'Moved'), 'Roof.step')
  })

  it('starts exports in the project folder, shares the chosen export folder across formats, and keeps project saves independent', async () => {
    const remember = vi.fn(async (_directory: string, _exportDirectory?: string) => {})
    const choose = vi.fn(async (_directory: string, name: string) => join(directory!, name.endsWith('.scanruler') ? 'Projects' : 'Exports', name))
    const { url, headers } = await setup({ choose, remember })
    await mkdir(join(directory!, 'Exports'))
    await mkdir(join(directory!, 'Projects'))
    for (const [i, name] of ['Roof.step', 'Cloud.ply', 'Report.csv', 'Roof.scanruler', 'Outline.dxf'].entries()) {
      const isProject = name.endsWith('.scanruler')
      const selection = await (await fetch(`${url}?choose=${name}${isProject ? '' : '&kind=export'}`, { method: 'POST', headers })).json()
      expect(choose).toHaveBeenLastCalledWith(i === 0 || isProject ? directory : join(directory!, 'Exports'), name)
      expect((await fetch(`${url}?selection=${selection.token}`, { method: 'POST', headers, body: name })).status).toBe(201)
      const projectFolder = i >= 3 ? join(directory!, 'Projects') : directory!
      expect((await (await fetch(url, { headers })).json()).name).toBe(projectFolder)
      expect(remember).toHaveBeenLastCalledWith(projectFolder, join(directory!, 'Exports'))
    }
    expect(await readFile(join(directory!, 'Exports', 'Outline.dxf'), 'utf8')).toBe('Outline.dxf')
  })

  it.each(['step', 'stp', 'stl', '3mf', 'ply', 'xyz', 'csv', 'svg', 'dxf'])('offers native Save As for .%s exports', async (extension) => {
    const choose = vi.fn(async (_root: string, name: string) => join(directory!, name))
    const { url, headers } = await setup({ choose })
    const selected = await fetch(`${url}?choose=Output.${extension}&kind=export`, { method: 'POST', headers })
    expect(selected.status).toBe(200)
    const { token } = await selected.json()
    expect((await fetch(`${url}?selection=${token}`, { method: 'POST', headers, body: extension })).status).toBe(201)
    expect(await readFile(join(directory!, `Output.${extension}`), 'utf8')).toBe(extension)
  })

  it('restores a separately remembered export folder and leaves both folders unchanged on cancellation or failed upload', async () => {
    const remembered = await mkdtemp(join(tmpdir(), 'scanruler-export-'))
    try {
      const remember = vi.fn()
      const choose = vi.fn(async (_directory: string, _name: string): Promise<string | null> => null)
      choose.mockResolvedValueOnce(null).mockResolvedValueOnce(join(remembered, 'Empty.svg'))
      const { url, headers } = await setup({ choose, remember, exportDirectory: remembered })
      expect((await fetch(`${url}?choose=Cancelled.stl&kind=export`, { method: 'POST', headers })).status).toBe(204)
      expect(choose).toHaveBeenLastCalledWith(remembered, 'Cancelled.stl')
      const { token } = await (await fetch(`${url}?choose=Empty.svg&kind=export`, { method: 'POST', headers })).json()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect((await fetch(`${url}?selection=${token}`, { method: 'POST', headers, body: '' })).status).toBe(500)
      expect(remember).not.toHaveBeenCalled()
      expect((await (await fetch(url, { headers })).json()).name).toBe(directory)
      expect(await readdir(remembered)).toEqual([])
    } finally { await rm(remembered, { recursive: true }) }
  })

  it('refuses unsupported native export extensions and a renamed selection with the wrong extension', async () => {
    const { url, headers } = await setup({ choose: async () => join(directory!, 'Changed.exe') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const name of ['file.exe', 'CON.step', '..\\escape.csv', 'project.scanruler']) {
      expect((await fetch(`${url}?choose=${encodeURIComponent(name)}&kind=export`, { method: 'POST', headers })).status).toBe(400)
    }
    expect((await fetch(`${url}?choose=Roof.step&kind=export`, { method: 'POST', headers })).status).toBe(500)
    expect(await readdir(directory!)).toEqual([])
  })

  it('uses the native selection for renamed files, retains its folder, and limits writes to that selection', async () => {
    const choose = vi.fn(async (_directory: string, _name: string) => join(directory!, 'Other', 'Renamed.scanruler'))
    const remember = vi.fn(async (_directory: string) => {})
    const { url, headers } = await setup({ choose, remember })
    await mkdir(join(directory!, 'Other'))
    const picked = await fetch(`${url}?choose=Roof-8.scanruler`, { method: 'POST', headers })
    const selection = await picked.json() as { token: string; name: string; directory: string }
    expect(choose).toHaveBeenCalledWith(directory, 'Roof-8.scanruler')
    expect(selection.name).toBe('Renamed.scanruler')
    expect(await readdir(join(directory!, 'Other'))).toEqual([])
    expect((await fetch(`${url}?selection=${selection.token}`, { method: 'POST', headers, body: 'archive' })).status).toBe(201)
    expect(await readFile(join(directory!, 'Other', 'Renamed.scanruler'), 'utf8')).toBe('archive')
    expect(remember).toHaveBeenCalledWith(join(directory!, 'Other'), undefined)
    expect((await (await fetch(url, { headers })).json()).name).toBe(join(directory!, 'Other'))
    expect((await fetch(`${url}?selection=${selection.token}`, { method: 'POST', headers, body: 'replay' })).status).toBe(403)
  })

  it('replaces an existing file only via a native-approved selection, not direct output', async () => {
    const { url, headers } = await setup({ choose: async () => join(directory!, 'Roof.scanruler') })
    await fetch(`${url}?name=Roof.scanruler`, { method: 'POST', headers, body: 'old' })
    const { token } = await (await fetch(`${url}?choose=Roof-2.scanruler`, { method: 'POST', headers })).json()
    expect((await fetch(`${url}?selection=${token}`, { method: 'POST', headers, body: 'new' })).status).toBe(201)
    expect(await readFile(join(directory!, 'Roof.scanruler'), 'utf8')).toBe('new')
    expect(await readdir(directory!)).toEqual(['Roof.scanruler'])
  })

  it('cancels without writing or changing the remembered folder', async () => {
    const remember = vi.fn()
    const { url, headers } = await setup({ choose: async () => null, remember })
    expect((await fetch(`${url}?choose=Roof-8.scanruler`, { method: 'POST', headers })).status).toBe(204)
    expect(await readdir(directory!)).toEqual([])
    expect(remember).not.toHaveBeenCalled()
    expect((await fetch(`${url}?selection=unapproved`, { method: 'POST', headers, body: 'archive' })).status).toBe(403)
  })

  it('preserves the prior file and folder and cleans up when a selected upload fails', async () => {
    const remember = vi.fn()
    const { url, headers } = await setup({ choose: async () => join(directory!, 'Roof.scanruler'), remember })
    await fetch(`${url}?name=Roof.scanruler`, { method: 'POST', headers, body: 'original' })
    const { token } = await (await fetch(`${url}?choose=Roof-2.scanruler`, { method: 'POST', headers })).json()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await fetch(`${url}?selection=${token}`, { method: 'POST', headers, body: '' })).status).toBe(500)
    expect(await readFile(join(directory!, 'Roof.scanruler'), 'utf8')).toBe('original')
    expect(await readdir(directory!)).toEqual(['Roof.scanruler'])
    expect(remember).not.toHaveBeenCalled()
  })

  it('lists the folder, writes new files, and refuses overwrites', async () => {
    const { url, headers } = await setup()
    const listing = await fetch(url, { headers })
    expect(await listing.json()).toEqual({ name: directory, names: [] })
    const write = await fetch(`${url}?name=Roof-1.scanruler`, { method: 'POST', headers, body: 'archive' })
    expect(write.status).toBe(201)
    expect(await readFile(join(directory!, 'Roof-1.scanruler'), 'utf8')).toBe('archive')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const duplicate = await fetch(`${url}?name=Roof-1.scanruler`, { method: 'POST', headers, body: 'replacement' })
    expect(duplicate.status).toBe(500)
    expect(await readFile(join(directory!, 'Roof-1.scanruler'), 'utf8')).toBe('archive')
    expect(log).toHaveBeenCalled()
  })

  it('rejects other origins, missing request markers and unsafe filenames', async () => {
    const { url, headers } = await setup()
    expect((await fetch(url, { headers: { ...headers, Origin: 'https://other.invalid' } })).status).toBe(403)
    expect((await fetch(url, { headers: { Origin: url } })).status).toBe(403)
    for (const name of ['../escape.stl', '..\\escape.stl', 'CON.stl', 'file.exe', 'bad:stream.stl']) {
      expect((await fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body: 'data' })).status).toBe(400)
    }
    expect(await readdir(directory!)).toEqual([])
  })

  it('cleans up an empty failed output and supports same-origin browser GETs', async () => {
    const { url, headers } = await setup()
    expect((await fetch(url, { headers: { 'X-ScanRuler-Output': '1', 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const empty = await fetch(`${url}?name=Empty.stl`, { method: 'POST', headers, body: '' })
    expect(empty.status).toBe(500)
    expect(await readdir(directory!)).toEqual([])
  })
})
