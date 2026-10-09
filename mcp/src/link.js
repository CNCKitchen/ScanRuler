// SPDX-License-Identifier: AGPL-3.0-only
// The link to the ScanRuler page: a WebSocket server on 127.0.0.1 that the
// page connects to when its "Local agent connection" is on. A page is
// accepted from an allowed origin, with the pairing token, one at a time.
// Once in, the page says which commands it has; this side sends it commands
// to run and gets their results back — see framing.js for the frames.
//
// Other copies of this server are let in beside the page, with the same
// token: an agent may start more than one — Claude Desktop starts one for its
// chats and one for its other sessions — and only one can hold the port.
// The others send their calls through this one (relay.js); it passes them to
// the page and the answers back, and tells them when the page comes and goes.

import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { decoder, encode } from './framing.js'

/** The hosted app. Loopback pages — a dev server, `--serve` — are allowed
 *  on any port; anything else takes `--allow-origin`. */
export const HOSTED_ORIGINS = ['https://scanruler.com', 'https://www.scanruler.com']

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether a page from `origin` may connect. A connection without an Origin
 *  is not from a browser page; the token alone decides for it. */
export function originAllowed(origin, extra = []) {
  if (!origin) return true
  if (HOSTED_ORIGINS.includes(origin) || extra.includes(origin)) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname)
  } catch {
    return false
  }
}

/** Close codes the page reads, to say why it was turned away. */
export const CLOSE = { badToken: 4001, origin: 4003, taken: 4009, noHello: 4008 }

/** Scans run to hundreds of megabytes. */
export const MAX_PAYLOAD = 1024 ** 3
const HEARTBEAT_MS = 15_000
const HELLO_MS = 10_000

/** Where a result carries a file's bytes, if it does. */
export const resultBinary = (result) => (result?.file?.bytes instanceof Uint8Array ? 'result.file.bytes' : undefined)

/** A socket's frame, as the decoder takes it. */
export const frameOf = (data, isBinary) => (isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'))

/**
 * Asking the far end of a socket something and hearing the answer, by id —
 * what the page link and a relay to another copy share. `socket` is the
 * socket asked; `page` what the page said about itself, null while there is
 * none.
 */
export class Asker extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.page = null
    this.pending = new Map()
    this.nextId = 1
  }

  get connected() {
    return this.page !== null
  }

  /** Take an answer, or a progress line, for something asked. */
  answer(message) {
    if (message.event === 'progress') {
      this.pending.get(message.id)?.onProgress?.(String(message.text ?? ''))
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.error) entry.reject(message.error)
    else entry.resolve(message.result)
  }

  /** Turn down everything still waiting for an answer. */
  dropPending(message) {
    for (const { reject } of this.pending.values()) reject({ code: 'unavailable', message })
    this.pending.clear()
  }

  /** Ask the page something; resolves with its result, rejects with its
   *  `{ code, message }`. `binaryPath` names bytes in the request that go as
   *  a binary frame; `onProgress` hears the page's progress lines. */
  request(message, binaryPath, onProgress) {
    const ws = this.socket
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject({ code: 'unavailable', message: 'No ScanRuler page is connected.' })
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      try {
        for (const frame of encode({ id, ...message }, binaryPath)) ws.send(frame)
      } catch (e) {
        this.pending.delete(id)
        reject({ code: 'internal', message: e.message })
      }
    })
  }

  /** Run a command on the page. `binaryKey` is the input field holding a
   *  file's bytes, if one does. */
  run(name, input, binaryKey, onProgress) {
    return this.request({ method: 'run', name, input }, binaryKey ? `input.${binaryKey}` : undefined, onProgress)
  }

  /** Resolves true once a page is connected, false after `timeoutMs`. */
  waitForPage(timeoutMs) {
    return waitForPage(this, timeoutMs)
  }
}

/** Resolves true once `link` has a page, false after `timeoutMs`. */
export function waitForPage(link, timeoutMs) {
  if (link.connected) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer)
      link.off('connected', onConnected)
      resolve(value)
    }
    const onConnected = () => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    link.on('connected', onConnected)
  })
}

export class PageLink extends Asker {
  /** @param {{ token: string, origins?: string[], log?: (line: string) => void }} options */
  constructor({ token, origins = [], log = () => {} }) {
    super()
    this.token = token
    this.origins = origins
    this.log = log
    /** The other copies relaying through this one. */
    this.peers = new Set()
    this.wss = null
  }

  /** Take WebSocket upgrades on an HTTP server. */
  attach(server) {
    this.wss = new WebSocketServer({
      server,
      maxPayload: MAX_PAYLOAD,
      verifyClient: ({ origin }, done) => {
        if (originAllowed(origin, this.origins)) done(true)
        else {
          this.log(`Refused a page from ${origin}: not an allowed origin (see --allow-origin).`)
          done(false, 403, 'Origin not allowed')
        }
      },
    })
    // ws hands the HTTP server's errors on to this one too — a port another
    // copy holds among them. The HTTP server's own listener deals with them;
    // unheard here, Node would end the process over it.
    this.wss.on('error', () => {})
    this.wss.on('connection', (ws, req) => this.#greet(ws, req.headers.origin))
    const beat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.alive === false) {
          ws.terminate()
          continue
        }
        ws.alive = false
        ws.ping()
      }
    }, HEARTBEAT_MS)
    beat.unref()
    this.wss.on('close', () => clearInterval(beat))
  }

  #greet(ws, origin) {
    ws.alive = true
    ws.on('pong', () => {
      ws.alive = true
    })
    const timer = setTimeout(() => ws.close(CLOSE.noHello, 'No hello'), HELLO_MS)
    let accepted = false
    const read = decoder((message) => {
      if (!accepted) {
        clearTimeout(timer)
        accepted = this.#hello(ws, message, origin)
        return
      }
      if (this.peers.has(ws)) this.#relay(ws, message)
      else this.#receive(message)
    })
    ws.on('message', (data, isBinary) => {
      try {
        read(frameOf(data, isBinary))
      } catch (e) {
        this.log(`A broken message ${this.peers.has(ws) ? 'from another scanruler-mcp' : 'from the page'}: ${e.message}`)
        ws.close(1003, 'Broken message')
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (this.peers.delete(ws)) return
      if (this.socket !== ws) return
      this.socket = null
      this.page = null
      this.dropPending('The ScanRuler page closed the connection before it answered.')
      this.log('The ScanRuler page disconnected.')
      this.#tellPeers()
      this.emit('disconnected')
    })
  }

  /** The first message: the page's — who it is, its token, its commands — or
   *  another copy's. True when it is taken in. */
  #hello(ws, message, origin) {
    const refuse = (code, reason) => {
      ws.send(JSON.stringify({ refused: reason }))
      ws.close(code, reason.slice(0, 100))
      this.log(`Refused ${message.peer ? 'another scanruler-mcp' : 'a page'}: ${reason}`)
      return false
    }
    if (message.peer && typeof message.peer === 'object') {
      if (message.peer.token !== this.token) return refuse(CLOSE.badToken, 'Its pairing token is not this one’s.')
      this.peers.add(ws)
      ws.send(JSON.stringify({ welcome: { server: 'scanruler-mcp', page: this.page } }))
      this.log(`Another scanruler-mcp${message.peer.version ? ` ${message.peer.version}` : ''} sends its calls through this one.`)
      return true
    }
    const hello = message.hello
    if (!hello || typeof hello !== 'object') return refuse(CLOSE.noHello, 'The page did not say hello.')
    if (hello.token !== this.token) {
      return refuse(CLOSE.badToken, 'The pairing token does not match — copy it again from `npx scanruler-mcp --pair` into ScanRuler’s Settings.')
    }
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      return refuse(CLOSE.taken, 'Another ScanRuler tab is connected to this agent already — close the connection there first.')
    }
    this.socket = ws
    const { token: _token, ...page } = hello
    this.page = { ...page, origin: origin ?? null, commands: Array.isArray(hello.commands) ? hello.commands : [] }
    ws.send(JSON.stringify({ welcome: { server: 'scanruler-mcp' } }))
    this.log(`ScanRuler ${page.version ?? ''} connected${origin ? ` from ${origin}` : ''}, with ${this.page.commands.length} commands.`)
    this.#tellPeers()
    this.emit('connected', this.page)
    return true
  }

  #receive(message) {
    if (message.event === 'commands' && Array.isArray(message.commands)) {
      this.page = { ...this.page, commands: message.commands }
      this.#tellPeers()
      this.emit('commands', message.commands)
      return
    }
    this.answer(message)
  }

  /** Tell the other copies what page there is now. */
  #tellPeers() {
    const frame = JSON.stringify({ event: 'page', page: this.page })
    for (const ws of this.peers) if (ws.readyState === ws.OPEN) ws.send(frame)
  }

  /** Pass another copy's request to the page, and the page's answer back. */
  #relay(ws, { id, ...message }) {
    const send = (reply, binaryPath) => {
      if (ws.readyState !== ws.OPEN) return
      for (const frame of encode({ id, ...reply }, binaryPath)) ws.send(frame)
    }
    if (message.method !== 'run' && message.method !== 'list') {
      send({ error: { code: 'invalid_input', message: `No such request: ${message.method}.` } })
      return
    }
    const key = Object.keys(message.input ?? {}).find((k) => message.input[k] instanceof Uint8Array)
    this.request(message, key ? `input.${key}` : undefined, (text) => send({ event: 'progress', text }))
      .then((result) => send({ result }, resultBinary(result)))
      .catch((e) => send({ error: { code: e?.code ?? 'failed', message: e?.message ?? String(e) } }))
  }

  close() {
    for (const ws of this.wss?.clients ?? []) ws.terminate()
    this.wss?.close()
  }
}
