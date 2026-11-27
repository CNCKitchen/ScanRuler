// SPDX-License-Identifier: AGPL-3.0-only
// Several tabs, each paired with a scanruler-mcp of its own on its own port —
// one part each, side by side. The browser-wide settings are shared by every
// tab, so a tab that kept its pairing there alone came back, reloaded, to the
// server the last tab was paired with, and its agent found the other part.
// Each tab keeps its own pairing in sessionStorage; localStorage is what a
// new tab starts from.

import { afterEach, describe, expect, it, vi } from 'vitest'

/** A Storage held in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

/** A tab loading the app: the browser's localStorage, its own
 *  sessionStorage, and the prefs store made afresh as a page load makes it. */
async function loadTab(local: Storage, session: Storage) {
  vi.resetModules()
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
  const { usePrefs } = await import('../src/state/prefsStore')
  return usePrefs
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the agent pairing, per tab', () => {
  it('brings a reloaded tab back to its own server, not to the one paired last', async () => {
    const local = memoryStorage()
    const sessionA = memoryStorage()
    const sessionB = memoryStorage()

    const tabA = await loadTab(local, sessionA)
    tabA.getState().setAgentPort(7317)
    tabA.getState().setAgentToken('tokenA_12345678')

    const tabB = await loadTab(local, sessionB)
    tabB.getState().setAgentPort(7318)
    tabB.getState().setAgentToken('tokenB_12345678')

    // Tab A reloaded: its own pairing, though B was paired after it.
    const reloadedA = await loadTab(local, sessionA)
    expect(reloadedA.getState()).toMatchObject({ agentPort: 7317, agentToken: 'tokenA_12345678' })
    const reloadedB = await loadTab(local, sessionB)
    expect(reloadedB.getState()).toMatchObject({ agentPort: 7318, agentToken: 'tokenB_12345678' })
  })

  it('starts a new tab from the pairing made last in this browser', async () => {
    const local = memoryStorage()
    const tab = await loadTab(local, memoryStorage())
    tab.getState().setAgentPort(7320)
    tab.getState().setAgentToken('tokenC_12345678')

    const fresh = await loadTab(local, memoryStorage())
    expect(fresh.getState()).toMatchObject({ agentPort: 7320, agentToken: 'tokenC_12345678' })
  })

  it('reads the browser’s pairing kept before tabs kept their own', async () => {
    const local = memoryStorage()
    local.setItem('scanruler.agentport', '7400')
    local.setItem('scanruler.agenttoken', 'olderToken_1234')
    const tab = await loadTab(local, memoryStorage())
    expect(tab.getState()).toMatchObject({ agentPort: 7400, agentToken: 'olderToken_1234' })
  })

  it('keeps working where sessionStorage is blocked', async () => {
    const local = memoryStorage()
    const blocked = memoryStorage()
    blocked.getItem = () => {
      throw new Error('blocked')
    }
    blocked.setItem = () => {
      throw new Error('blocked')
    }
    const tab = await loadTab(local, blocked)
    tab.getState().setAgentPort(7321)
    expect(tab.getState().agentPort).toBe(7321)
    expect(local.getItem('scanruler.agentport')).toBe('7321')
  })
})
