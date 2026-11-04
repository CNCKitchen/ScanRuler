// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises'
import { open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { windowsSaveDialog } from './windowsSaveDialog'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export function localOutputHandler(directory: string, options: {
  choose?: (directory: string, name: string) => Promise<string | null>
  remember?: (directory: string, exportDirectory?: string) => Promise<void>
  exportDirectory?: string
} = {}) {
  const selections = new Map<string, { path: string; expires: number; export: boolean }>()
  let exportDirectory = options.exportDirectory
  let choosing = false
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let destination: string | null = null
    let created = false
    try {
      const host = req.headers.host ?? ''
      const sameOrigin = req.headers.origin === `http://${host}` ||
        (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin')
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
        !sameOrigin || req.headers['x-scanruler-output'] !== '1') {
        res.writeHead(403).end('Local same-origin requests only.')
        return
      }
      const root = await realpath(directory)
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (req.method === 'POST' && url.searchParams.has('choose')) {
        const name = url.searchParams.get('choose') ?? ''
        const exporting = url.searchParams.get('kind') === 'export'
        if (name.length > 200 || basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name) ||
          !(exporting ? /\.(step|stp|stl|3mf|ply|xyz|csv|svg|dxf)$/i : /\.scanruler$/i).test(name)) {
          res.writeHead(400).end('Invalid proposed output filename.'); return
        }
        if (choosing) { res.writeHead(409).end('A Save As dialog is already open.'); return }
        choosing = true
        let selected: string | null
        try { selected = await (options.choose ?? windowsSaveDialog)(exporting && exportDirectory ? await realpath(exportDirectory) : root, name) }
        finally { choosing = false }
        if (selected === null) { res.writeHead(204).end(); return }
        if (!isAbsolute(selected) || extname(selected).toLowerCase() !== extname(name).toLowerCase()) {
          throw new Error(`Choose a ${extname(name)} filename.`)
        }
        for (const [key, value] of selections) if (value.expires < Date.now()) selections.delete(key)
        const token = randomUUID()
        selections.set(token, { path: selected, expires: Date.now() + 30 * 60_000, export: exporting })
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, name: basename(selected), directory: dirname(selected) }))
        return
      }
      if (req.method === 'GET') {
        const names = await readdir(root)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ name: root, names }))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405).end('Use GET or POST.'); return }
      const token = url.searchParams.get('selection')
      if (token) {
        const selected = selections.get(token)
        selections.delete(token)
        if (!selected || selected.expires < Date.now()) { res.writeHead(403).end('Save As selection expired. Open Save again.'); return }
        destination = join(dirname(selected.path), `.scanruler-${randomUUID()}.tmp`)
        const file = await open(destination, 'wx')
        created = true
        try {
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 512_000_000) throw new Error('Output exceeds the 512 MB local-save limit.')
            await file.writeFile(chunk)
          }
          if (!size) throw new Error('The output file is empty.')
          await file.sync()
        } finally { await file.close() }
        await rename(destination, selected.path)
        created = false
        if (selected.export) exportDirectory = dirname(selected.path)
        else directory = dirname(selected.path)
        await options.remember?.(directory, exportDirectory)
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: basename(selected.path) }))
        return
      }
      const name = url.searchParams.get('name') ?? ''
      if (name.length > 200 || basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        !/\.(scanruler|stl|3mf)$/i.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) {
        res.writeHead(400).end('Invalid output filename.')
        return
      }
      destination = join(root, name)
      const file = await open(destination, 'wx')
      created = true
      try {
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 512_000_000) throw new Error('Output exceeds the 512 MB local-save limit.')
          await file.writeFile(chunk)
        }
        if (size === 0) throw new Error('The output file is empty.')
        await file.sync()
      } finally {
        await file.close()
      }
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name }))
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      if (created && destination) {
        try { await unlink(destination) }
        catch (cleanupError) { message += `; incomplete file cleanup failed: ${String(cleanupError)}` }
      }
      console.error('ScanRuler local output:', message)
      res.writeHead(500).end(message)
    }
  }
}

export function localOutputPlugin(): Plugin {
  return {
    name: 'scanruler-local-output',
    configureServer(server) {
      let handler: ReturnType<typeof localOutputHandler> | null = null
      server.middlewares.use('/__scanruler/output', async (req, res) => {
        try {
          if (!handler) {
            let config: string
            try { config = await readFile(join(server.config.root, '.scanruler-output.local'), 'utf8') }
            catch (error) {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                res.writeHead(404).end('Local output folder is not configured.')
                return
              }
              throw error
            }
            const value: unknown = JSON.parse(config)
            if (!value || typeof value !== 'object' || !('directory' in value) ||
              typeof value.directory !== 'string' || !isAbsolute(value.directory)) {
              throw new Error('The local output configuration must contain an absolute directory.')
            }
            const exportDirectory = 'exportDirectory' in value ? value.exportDirectory : undefined
            if (exportDirectory !== undefined && (typeof exportDirectory !== 'string' || !isAbsolute(exportDirectory))) {
              throw new Error('The local export configuration must contain an absolute exportDirectory.')
            }
            handler = localOutputHandler(value.directory, {
              exportDirectory,
              remember: async (directory, exportDirectory) => {
                await writeFile(join(server.config.root, '.scanruler-output.local'), JSON.stringify({ directory, ...(exportDirectory ? { exportDirectory } : {}) }))
              },
            })
          }
          await handler(req, res)
        } catch (error) {
          console.error('ScanRuler local output configuration:', error)
          res.writeHead(500).end(String(error))
        }
      })
    },
  }
}
