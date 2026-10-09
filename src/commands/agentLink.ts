// SPDX-License-Identifier: AGPL-3.0-only
// What the page shows of its link to an AI agent — where the link stands, for
// the chip and Settings — and the pairing link that switches it on. The link
// itself, bridge.ts, is loaded only once it is switched on: a page no agent
// drives carries none of it.

import { create } from 'zustand'
import { usePrefs } from '../state/prefsStore'

/** Where the link stands, for the chip in the top bar: switched off;
 *  waiting for the agent's server to answer; connected to it; or turned
 *  away by it — a wrong token, another tab connected already. */
export type AgentLinkStatus = 'off' | 'waiting' | 'connected' | 'refused'

export const useAgentLink = create<{ status: AgentLinkStatus; detail: string | null }>(() => ({ status: 'off', detail: null }))

/** How the link stands, in a few words — Settings and the chip say it. */
export const AGENT_STATUS: Record<AgentLinkStatus, string> = {
  off: 'Off',
  waiting: 'Listening for the agent',
  connected: 'Connected to the agent',
  refused: 'Turned away by the agent',
}

/** `#agent=<port>:<token>` in the address — the pairing link scanruler-mcp
 *  hands out — switches the connection on with that port and token, and is
 *  taken out of the address again. True when there was one. */
export function takePairingLink(): boolean {
  if (typeof location === 'undefined') return false
  const m = /(?:^#|&)agent=(\d{1,5}):([A-Za-z0-9_-]{8,})/.exec(location.hash)
  if (!m) return false
  const prefs = usePrefs.getState()
  prefs.setAgentPort(Number(m[1]))
  prefs.setAgentToken(m[2])
  prefs.setAgentLink(true)
  history.replaceState(null, '', location.pathname + location.search)
  return true
}
