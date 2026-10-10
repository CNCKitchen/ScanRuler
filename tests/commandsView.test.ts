// SPDX-License-Identifier: AGPL-3.0-only
// The view commands, a picture as a result, and what a plugin says it is
// busy with: view.set and view.render need the viewport and say so without
// one; view.render is the one command whose result is a picture; a busy
// check registered beside the session's own holds every command that
// changes the session and shows in the readout, while reading goes on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerBusy } from '../src/commands/activity'
import { listCommands, registerCommands } from '../src/commands/registry'
import { obj } from '../src/commands/schema'
import type { Command } from '../src/commands/types'
import { pluginToggleKeys, registerViewToggles, viewToggles, type ViewToggle } from '../src/commands/viewToggles'
import { useStore } from '../src/state/store'
import { refused, run, startHeadless, undoLabels, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

describe('the view', () => {
  it('needs the viewport, and says so', async () => {
    for (const [name, input] of [
      ['view.set', { view: 'top' }],
      ['view.render', { width: 320 }],
    ] as const) {
      const e = await refused(name, input)
      expect(e.code, name).toBe('unavailable')
      expect(e.message).toMatch(/viewport/)
    }
    expect((await refused('view.set', { view: 'sideways' })).code).toBe('invalid_input')
    expect((await refused('view.render', { width: 10 })).code).toBe('invalid_input')
    expect((await refused('view.render', { show: { scan: 'no' } })).code).toBe('invalid_input')
    expect((await refused('view.set', { frame: { min: [0, 0, 0] } })).code).toBe('invalid_input')
    // The session's readout has no view to speak of without a viewport.
    expect((await run<{ view: unknown }>('session.state')).view).toBeNull()
  })

  it('takes a plugin’s toggles under its id, a plugin taking an app key over while its workspace is on', () => {
    let shown = true
    let on = true
    const base: ViewToggle[] = [{ key: 'scan', description: 'the scan', shown: () => shown, show: (v) => (shown = v) }]
    const mine: ViewToggle[] = [
      { key: 'bodies', description: 'the bodies', shown: () => true, show: () => {} },
      { key: 'scan', description: 'the scan, my way', shown: () => false, show: () => {}, applies: () => on },
    ]
    const stop = registerViewToggles('demo', mine)
    try {
      expect(() => registerViewToggles('demo', [])).toThrow(/share the id/)
      expect(pluginToggleKeys().map((t) => t.key)).toEqual(['bodies', 'scan'])
      const now = viewToggles(base)
      expect([...now.keys()]).toEqual(['scan', 'bodies'])
      expect(now.get('scan')!.description).toBe('the scan, my way')
      on = false
      expect(viewToggles(base).get('scan')!.description).toBe('the scan')
    } finally {
      stop()
    }
    expect(viewToggles(base).has('bodies')).toBe(false)
    expect(pluginToggleKeys()).toEqual([])
  })

  it('lists view.render as the command that answers with a picture', () => {
    const pictures = listCommands().filter((c) => c.returnsImage)
    expect(pictures.map((c) => c.name)).toEqual(['view.render'])
    expect(pictures[0]).toMatchObject({ readOnly: true, returnsFile: true })
    expect(listCommands().find((c) => c.name === 'view.set')).toMatchObject({ readOnly: true, returnsImage: false })
  })
})

describe('a plugin’s busy check', () => {
  it('holds the commands that change the session, shows in the readout, and lets reading go on', async () => {
    const mark: Command = {
      name: 'mark',
      title: 'Mark',
      description: 'Changes the session a little.',
      input: obj({}),
      run: async () => {
        useStore.setState((s) => ({ nextNumber: s.nextNumber + 1 }))
        return {}
      },
    }
    const unregister = registerCommands('demo', [mark])
    let working: string | null = 'the demo is thinking'
    const unbusy = registerBusy('demo', () => working)
    try {
      expect(() => registerBusy('demo', () => null)).toThrow(/share the id/)
      const e = await refused('demo.mark')
      expect(e.code).toBe('busy')
      expect(e.message).toMatch(/the demo is thinking/)
      expect((await run<{ busy: string | null }>('session.state')).busy).toBe('the demo is thinking')
      working = null
      await run('demo.mark')
      expect((await run<{ busy: string | null }>('session.state')).busy).toBeNull()
      expect(undoLabels().at(-1)).toBe('Agent: mark')
    } finally {
      unbusy()
      unregister()
    }
  })
})
