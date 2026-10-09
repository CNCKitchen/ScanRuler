// SPDX-License-Identifier: AGPL-3.0-only
// One port, any number of copies of this server. An agent may start several —
// Claude Desktop starts one for its chats and one for its other sessions,
// and two agents may run side by side — while the ScanRuler tab connects to
// one port. The copy that gets the port holds the page link (link.js); a
// copy that finds it taken connects to that one as a peer, with the same
// token, and sends its calls through it. When the holder stops, a peer takes
// the port over, and the tab, which keeps trying, connects to it.

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { decoder } from './framing.js'
import { Asker, frameOf, MAX_PAYLOAD, PageLink, waitForPage } from './link.js'

/** How long a copy waits before trying a port it could not use again. */
const RETRY_MS = 5_000

/** This copy's link through another copy that holds the port. */
export class PeerLink extends Asker {
  /** @param {{ port: number, token: string, version?: string, log?: (line: string) => void }} options */
  constructor({ port, token, version = '', log = () => {} }) {
    super()
    this.port = port
    this.token = token
    this.version = version
    this.log = log
  }

  /** Connect to the copy on the port. Resolves `{ ok: true }` once it took
   *  this one in, `{ refused }` when it turned it away, `{ error }` when
   *  what holds the port is not a scanruler-mcp. */
  connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`, { maxPayload: MAX_PAYLOAD, handshakeTimeout: 3_000 })
      let greeted = false
      let accepted = false
      const read = decoder((message) => {
        if (!greeted) {
          greeted = true
          if (message.welcome) {
            accepted = true
            this.socket = ws
            this.#setPage(message.welcome.page ?? null)
            resolve({ ok: true })
          } else resolve({ refused: String(message.refused ?? 'It said no.') })
          return
        }
        if (message.event === 'page') this.#setPage(message.page ?? null)
        else this.answer(message)
      })
      ws.on('open', () => ws.send(JSON.stringify({ peer: { token: this.token, version: this.version } })))
      ws.on('message', (data, isBinary) => {
        try {
          read(frameOf(data, isBinary))
        } catch (e) {
          this.log(`A broken message from the scanruler-mcp on port ${this.port}: ${e.message}`)
          ws.close(1003, 'Broken message')
        }
      })
      ws.on('unexpected-response', (_req, res) => {
        resolve({ error: `HTTP ${res.statusCode}` })
        ws.terminate()
      })
      ws.on('error', (e) => resolve({ error: e.message }))
      ws.on('close', () => {
        resolve({ error: 'It closed the connection.' })
        if (!accepted) return
        const had = this.page !== null
        this.socket = null
        this.page = null
        this.dropPending('The scanruler-mcp this one sent its calls through has stopped.')
        if (had) this.emit('disconnected')
        this.emit('closed')
      })
    })
  }

  #setPage(page) {
    const was = this.page
    this.page = page
    if (page && !was) this.emit('connected', page)
    else if (!page && was) this.emit('disconnected')
    else if (page) this.emit('commands', page.commands)
  }

  close() {
    this.socket?.close()
  }
}

/**
 * The link a copy of the server uses: the page link while it holds the port,
 * the relay through the copy that does otherwise — the same `connected`,
 * `page`, `run`, `waitForPage` and events either way. `role` says which:
 * 'holder', 'relay', or 'none' while it has neither, with `error` saying why.
 */
export class SharedLink extends EventEmitter {
  /**
   * @param {{ http: import('node:http').Server, port: number, token: string,
   *   version?: string, origins?: string[], log?: (line: string) => void,
   *   retryMs?: number }} options
   */
  constructor({ http, port, token, version = '', origins = [], log = () => {}, retryMs = RETRY_MS }) {
    super()
    this.http = http
    this.port = port
    this.token = token
    this.version = version
    this.log = log
    this.retryMs = retryMs
    this.role = 'none'
    this.error = null
    this.holder = new PageLink({ token, origins, log })
    this.holder.attach(http)
    this.peer = null
    this.timer = null
    this.closed = false
    this.#forward(this.holder, () => this.role === 'holder')
    http.on('listening', () => {
      this.role = 'holder'
      this.error = null
      this.emit('role', 'holder')
    })
    http.on('error', (e) => {
      if (e.code === 'EADDRINUSE') this.#relay()
      else this.#fail(e.message)
    })
  }

  /** The link in use, or null. */
  get current() {
    return this.role === 'holder' ? this.holder : this.role === 'relay' ? this.peer : null
  }

  get connected() {
    return this.current?.connected ?? false
  }

  get page() {
    return this.current?.page ?? null
  }

  run(name, input, binaryKey, onProgress) {
    const link = this.current
    if (!link) return Promise.reject({ code: 'unavailable', message: 'No ScanRuler page is connected.' })
    return link.run(name, input, binaryKey, onProgress)
  }

  waitForPage(timeoutMs) {
    return waitForPage(this, timeoutMs)
  }

  /** Take the port, or the relay through the copy that has it. */
  start() {
    if (this.closed) return
    clearTimeout(this.timer)
    this.http.listen(this.port, '127.0.0.1')
  }

  /** Pass on a link's page events while `active()` says it is the one in use. */
  #forward(link, active) {
    for (const event of ['connected', 'disconnected', 'commands']) {
      link.on(event, (...args) => {
        if (active()) this.emit(event, ...args)
      })
    }
  }

  async #relay() {
    if (this.closed) return
    const peer = new PeerLink({ port: this.port, token: this.token, version: this.version, log: this.log })
    const outcome = await peer.connect()
    if (this.closed) {
      peer.close()
      return
    }
    if (!outcome.ok) {
      this.#fail(
        outcome.refused
          ? `Port ${this.port} is held by another scanruler-mcp, which turned this one away: ${outcome.refused} Give both the same pairing token (SCANRULER_MCP_TOKEN), or start this one with --port and enter that port in ScanRuler.`
          : `Port ${this.port} is taken by another program. Stop it, or start this one with --port and enter that port in ScanRuler.`,
      )
      return
    }
    this.peer = peer
    this.role = 'relay'
    this.error = null
    this.#forward(peer, () => this.peer === peer)
    peer.once('closed', () => {
      if (this.peer !== peer) return
      this.peer = null
      this.role = 'none'
      this.log(`The scanruler-mcp holding port ${this.port} has stopped; taking the port over.`)
      this.start()
    })
    this.emit('role', 'relay')
    if (peer.connected) this.emit('connected', peer.page)
  }

  /** Say why there is no link, once, and try again later. */
  #fail(message) {
    if (message !== this.error) this.log(message)
    this.role = 'none'
    this.error = message
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.start(), this.retryMs)
    this.timer.unref()
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.peer?.close()
    this.holder.close()
    this.http.close()
  }
}
