// SPDX-License-Identifier: AGPL-3.0-only
// The page's end of the link to an AI agent, loaded once the link is
// switched on (see agentLink.ts). With "Local agent connection" on
// (Settings → Agents), the page connects to the agent's local server —
// scanruler-mcp, started by the agent — at ws://127.0.0.1:<port>/, presents
// the pairing token, says which commands it has, and runs what the agent
// sends, one command at a time, in front of the person, who can undo each
// step. The connection is to this computer and nowhere else.
//
// Before it opens the socket the page fetches the server's hello,
// http://127.0.0.1:<port>/scanruler-mcp, marked as a request to this
// computer (`targetAddressSpace: 'loopback'`). From the hosted site that is
// what has Chrome and Edge ask the person, once, whether the site may reach
// apps on this computer — their Local Network Access, which turns a
// WebSocket to 127.0.0.1 away unasked but never asks for one itself. Firefox
// asks on the socket. Safari allows neither from an https page; the server's
// --serve is the way there. A page on this computer asks nothing and skips
// the fetch — which Chrome, besides, never reports finished to DevTools,
// so a check that waits for the network to go quiet would wait forever.
//
// Messages: the page's `{ hello }` — with `pageId`, new each time the page
// loads, and `since`, when it did, by which the server tells a page that
// came back empty (reloaded) from one that only reconnected; the server's
// `{ welcome }` (with its `version` from 0.4.0 on) or
// `{ refused }`; then the server's `{ id, method: 'run', name, input, job }`
// — `job` the server's name for the change or batch the run is part of,
// which keeps the run among the recent outcomes (session.recent), and
// `deferred: true` on a run more changes follow straight after (see
// CommandContext.deferred) — and
// `{ id, method: 'list' }`, answered `{ id, result }` or `{ id, error }`, and
// the page's `{ event: 'progress', id, text }` while a command runs, and
// `{ event: 'visibility', hidden }` when the tab is hidden or shown again.
// Files travel as binary frames — see framing.ts.

import { plugins } from '../plugins/registry'
import { useStore } from '../state/store'
import { APP_VERSION } from '../version'
import { useAgentLink } from './agentLink'
import { decoder, encode, type Message } from './framing'
import { sceneOf } from './host'
import { listCommands, runCommand } from './registry'
import { CommandError } from './types'

/** The close codes the server turns a page away with (mcp/src/link.js). */
const REFUSED = new Set([4001, 4003, 4008, 4009])

/** How long the page waits before trying again, doubling to ten seconds. */
const retryDelay = (attempt: number) => Math.min(10_000, 1000 * 2 ** attempt)

export interface BridgeOptions {
  port: number
  token: string
  /** Makes the socket — a test's own, or the browser's. */
  socket?: (url: string) => WebSocket
  /** Whether the server's hello answers — a test's own, or a fetch. */
  reach?: (url: string) => Promise<boolean>
}

/** Fetch the server's hello as a request to this computer, which is what
 *  has the browser ask for the permission a hosted page needs. */
const fetchHello = (url: string): Promise<boolean> =>
  fetch(url, { cache: 'no-store', targetAddressSpace: 'loopback' } as RequestInit & { targetAddressSpace: string }).then(
    (r) => r.ok,
    () => false,
  )

/** Whether this page is itself on this computer — a dev server, the
 *  server's --serve — and needs nobody's leave to reach it. */
const onThisComputer = () =>
  typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

/** Whether the browser has been told to keep this site off this computer:
 *  the permission behind Local Network Access, where it can be read. */
async function loopbackDenied(): Promise<boolean> {
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName })
      if (status.state === 'denied') return true
    } catch {
      // A name this browser does not know.
    }
  }
  return false
}

/** This page's name for itself, new each time it loads, and when it
 *  loaded: what the server tells a reloaded page by (see the messages). */
const PAGE_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const PAGE_SINCE = new Date(typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : Date.now()).toISOString()

/** Whether the tab is hidden — in the background, its window covered or
 *  minimised, the screen locked — where the browser stops drawing it. */
const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

/** Connect to the agent's server, and keep connecting while switched on.
 *  The returned function switches it off. */
export function startBridge({ port, token, socket = (url) => new WebSocket(url), reach = fetchHello }: BridgeOptions): () => void {
  let stopped = false
  let ws: WebSocket | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refusal: string | null = null

  /** Send on the open connection — or, given `on`, only while `on` is still
   *  that connection: an answer belongs to the server that asked, and a
   *  server started again since counts its ids from 1 again. */
  const send = (message: Message, binaryPath?: string, on: WebSocket | null = ws) => {
    if (!ws || ws !== on || ws.readyState !== 1) return
    for (const frame of encode(message, binaryPath)) ws.send(frame as string | ArrayBufferView<ArrayBuffer>)
  }

  const run = async (message: Message, from: WebSocket) => {
    const id = message.id
    const reply = (answer: Message, binaryPath?: string) => send(answer, binaryPath, from)
    const progress = (text: string) => reply({ event: 'progress', id, text })
    // What the status line says while the command runs, the agent hears too.
    const quiet = useStore.subscribe((s, prev) => {
      if (s.statusText && s.statusText !== prev.statusText) progress(s.statusText)
    })
    try {
      const job = typeof message.job === 'string' && message.job ? message.job : undefined
      const result = await runCommand(String(message.name), message.input ?? {}, progress, job, message.deferred === true)
      const file = (result as { file?: { bytes?: unknown } } | null)?.file
      reply({ id, result: result as unknown }, file?.bytes instanceof Uint8Array ? 'result.file.bytes' : undefined)
    } catch (e) {
      reply({
        id,
        error: e instanceof CommandError ? e.toJSON() : { code: 'internal', message: e instanceof Error ? e.message : String(e) },
      })
    } finally {
      quiet()
    }
  }

  const receive = (message: Message, from: WebSocket) => {
    if (message.welcome) {
      attempt = 0
      refusal = null
      // The server's version, for the page to tell an out of date one: a
      // scanruler-mcp before 0.4.0 says what it is, but not its version.
      const welcome = message.welcome as { server?: unknown; version?: unknown }
      const server = typeof welcome.version === 'string' ? { version: welcome.version } : welcome.server === 'scanruler-mcp' ? { version: null } : null
      useAgentLink.setState({ status: 'connected', detail: null, server })
    } else if (typeof message.refused === 'string') {
      refusal = message.refused
    } else if (message.method === 'run') {
      void run(message, from)
    } else if (message.method === 'list') {
      send({ id: message.id, result: listCommands() }, undefined, from)
    }
  }

  const connect = async () => {
    // The app's commands come with the connection: a page no agent drives
    // carries none of them.
    const { registerCoreCommands } = await import('./core')
    registerCoreCommands()
    if (stopped) return
    if (useAgentLink.getState().status !== 'refused') useAgentLink.setState({ status: 'waiting', detail: null })
    const answered = onThisComputer() || (await reach(`http://127.0.0.1:${port}/scanruler-mcp`))
    if (stopped) return
    if (!answered) {
      if (typeof navigator !== 'undefined' && navigator.permissions && (await loopbackDenied())) {
        useAgentLink.setState({
          status: 'refused',
          detail: 'The browser keeps this site from reaching apps on this computer — allow local network access for it in the site settings (the icon left of the address), then reload.',
        })
      }
      timer = setTimeout(() => void connect(), retryDelay(attempt++))
      return
    }
    const here = socket(`ws://127.0.0.1:${port}/`)
    ws = here
    here.binaryType = 'arraybuffer'
    const read = decoder((message) => receive(message, here))
    here.onopen = () =>
      send({
        hello: {
          app: 'ScanRuler',
          version: APP_VERSION,
          token,
          commands: listCommands(),
          plugins: plugins().map((p) => p.id),
          viewport: sceneOf() !== null,
          hidden: tabHidden(),
          pageId: PAGE_ID,
          since: PAGE_SINCE,
        },
      })
    here.onmessage = (event: MessageEvent) => {
      try {
        read(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      } catch {
        here.close(1003, 'Broken message')
      }
    }
    here.onclose = (event: CloseEvent) => {
      if (ws === here) ws = null
      if (stopped) return
      if (REFUSED.has(event.code) || refusal) {
        useAgentLink.setState({ status: 'refused', detail: refusal ?? 'The agent turned this page away.' })
      } else if (useAgentLink.getState().status === 'connected') {
        useAgentLink.setState({ status: 'waiting', detail: 'The agent went away.' })
      }
      refusal = null
      timer = setTimeout(() => void connect(), retryDelay(attempt++))
    }
  }

  const visibility = () => send({ event: 'visibility', hidden: tabHidden() })
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
  void connect()
  return () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
    stopped = true
    clearTimeout(timer)
    ws?.close(1000, 'Switched off')
    ws = null
    useAgentLink.setState({ status: 'off', detail: null, server: null })
  }
}
