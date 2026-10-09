// SPDX-License-Identifier: AGPL-3.0-only
// The HTTP side of the server's port. Its WebSocket upgrades are the page
// link (link.js). GET /scanruler-mcp is what the page asks first: a hosted
// page reaching for this computer needs the browser's leave to — Chrome's
// and Edge's Local Network Access asks for it on a fetch, never on a
// WebSocket — so the page fetches this, with the CORS answer an allowed
// origin needs, and connects once that went through. With --serve the port
// also serves a built ScanRuler — the open-source build, a build for
// working offline, or for Safari, which will not let an https page reach
// 127.0.0.1 at all — at http://127.0.0.1:<port>/, a page this server always
// lets in.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

/** The file a URL path names under `root`, or null for one outside it. */
export function fileFor(root, urlPath) {
  const path = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const file = resolve(root, normalize('.' + (path.endsWith('/') ? `${path}index.html` : path)))
  return file === root || file.startsWith(root + sep) ? file : null
}

/** The path the page fetches before it connects. */
export const HELLO_PATH = '/scanruler-mcp'

/** An HTTP server for the port: the hello the page fetches, answered to the
 *  origins `allowOrigin` lets in; the built app under `serve`, if given — any
 *  path that is not a file is the app, as the hosted site answers — and a
 *  line saying what this is, otherwise. */
export function httpServer({ serve, allowOrigin = () => false, version = '' }) {
  const root = serve ? resolve(serve) : null
  return createServer(async (req, res) => {
    const origin = req.headers.origin
    if ((req.url ?? '').split('?')[0] === HELLO_PATH) {
      const cors = origin && allowOrigin(origin)
        ? { 'access-control-allow-origin': origin, 'access-control-allow-private-network': 'true', vary: 'Origin' }
        : { vary: 'Origin' }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-max-age': '600' }).end()
        return
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ server: 'scanruler-mcp', version }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (!root) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('scanruler-mcp: waiting for the ScanRuler page. Switch on "Local agent connection" in ScanRuler’s Settings.\n')
      return
    }
    let file = fileFor(root, req.url ?? '/')
    if (!file) {
      res.writeHead(404).end()
      return
    }
    let info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      file = join(root, 'index.html')
      info = await stat(file).catch(() => null)
    }
    if (!info?.isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  })
}
