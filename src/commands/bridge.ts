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
// Messages: the page's `{ hello }`; the server's `{ welcome }` or
// `{ refused }`; then the server's `{ id, method: 'run', name, input }` and
// `{ id, method: 'list' }`, answered `{ id, result }` or `{ id, error }`, and
// the page's `{ event: 'progress', id, text }` while a command runs. Files
// travel as binary frames — see framing.ts.

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

/** Connect to the agent's server, and keep connecting while switched on.
 *  The returned function switches it off. */
export function startBridge({ port, token, socket = (url) => new WebSocket(url), reach = fetchHello }: BridgeOptions): () => void {
  let stopped = false
  let ws: WebSocket | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refusal: string | null = null

  const send = (message: Message, binaryPath?: string) => {
    if (!ws || ws.readyState !== 1) return
    for (const frame of encode(message, binaryPath)) ws.send(frame as string | ArrayBufferView<ArrayBuffer>)
  }

  const run = async (message: Message) => {
    const id = message.id
    const progress = (text: string) => send({ event: 'progress', id, text })
    // What the status line says while the command runs, the agent hears too.
    const quiet = useStore.subscribe((s, prev) => {
      if (s.statusText && s.statusText !== prev.statusText) progress(s.statusText)
    })
    try {
      const result = await runCommand(String(message.name), message.input ?? {}, progress)
      const file = (result as { file?: { bytes?: unknown } } | null)?.file
      send({ id, result: result as unknown }, file?.bytes instanceof Uint8Array ? 'result.file.bytes' : undefined)
    } catch (e) {
      send({
        id,
        error: e instanceof CommandError ? e.toJSON() : { code: 'internal', message: e instanceof Error ? e.message : String(e) },
      })
    } finally {
      quiet()
    }
  }

  const receive = (message: Message) => {
    if (message.welcome) {
      attempt = 0
      refusal = null
      useAgentLink.setState({ status: 'connected', detail: null })
    } else if (typeof message.refused === 'string') {
      refusal = message.refused
    } else if (message.method === 'run') {
      void run(message)
    } else if (message.method === 'list') {
      send({ id: message.id, result: listCommands() })
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
    const read = decoder(receive)
    here.onopen = () =>
      send({
        hello: {
          app: 'ScanRuler',
          version: APP_VERSION,
          token,
          commands: listCommands(),
          plugins: plugins().map((p) => p.id),
          viewport: sceneOf() !== null,
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

  void connect()
  return () => {
    stopped = true
    clearTimeout(timer)
    ws?.close(1000, 'Switched off')
    ws = null
    useAgentLink.setState({ status: 'off', detail: null })
  }
}
