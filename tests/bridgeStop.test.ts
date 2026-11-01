// SPDX-License-Identifier: AGPL-3.0-only
// Switching the agent link off while the browser's local-network permission
// query is still pending must leave the link off, not "refused".
import { afterEach, expect, it, vi } from 'vitest'
import { startBridge } from '../src/commands/bridge'
import { useAgentLink } from '../src/commands/agentLink'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => vi.unstubAllGlobals())

it('a link stopped during the permission query stays off', async () => {
  let answer: ((v: { state: string }) => void) | undefined
  vi.stubGlobal('navigator', { permissions: { query: () => new Promise((r) => { answer = r }) } })
  let sockets = 0
  const stop = startBridge({ port: 1, token: 'tokentoken', socket: () => { sockets++; return {} as WebSocket }, reach: async () => false })
  for (let i = 0; i < 300 && !answer; i++) await wait(10)
  expect(answer).toBeDefined()
  stop()
  const after = useAgentLink.getState().status
  answer!({ state: 'denied' })
  await wait(20)
  expect(useAgentLink.getState().status).toBe(after)
  expect(useAgentLink.getState().status).not.toBe('refused')
  expect(sockets).toBe(0)
})
