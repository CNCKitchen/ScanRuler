// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandRunning, configureCommands, useCommandActivity } from '../src/commands/activity'
import { listCommands, registerCommands, runCommand } from '../src/commands/registry'
import { num, obj, SCHEMA_BUDGET, schemaWeight, type JsonSchema } from '../src/commands/schema'
import { registerCoreCommands } from '../src/commands/core'
import { CommandError, type Command } from '../src/commands/types'
import { clearHistory, useHistory } from '../src/state/historyStore'
import { useStore } from '../src/state/store'

const counter = { value: 0 }
const bump: Command<{ by?: number }> = {
  name: 'bump',
  title: 'Bump the counter',
  description: 'Adds to it.',
  input: obj({ by: num() }),
  // A change the history sees: the element counter.
  run: async ({ by = 1 }) => {
    useStore.setState((s) => ({ nextNumber: s.nextNumber + by }))
    counter.value += by
    return { value: counter.value }
  },
}
const read: Command = {
  name: 'read',
  title: 'Read the counter',
  description: 'Reads it.',
  input: obj({}),
  readOnly: true,
  run: async () => ({ value: counter.value }),
}

let unregister: () => void
beforeEach(() => {
  counter.value = 0
  useStore.setState(useStore.getInitialState(), true)
  clearHistory()
  unregister = registerCommands('test', [bump, read])
})
afterEach(() => unregister())

const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof CommandError ? e.code : `not a CommandError: ${String(e)}`
  }
  return 'resolved'
}

describe('the command registry', () => {
  it('lists commands under namespace.verb with their schemas', () => {
    const listed = listCommands().filter((c) => c.name.startsWith('test.'))
    expect(listed.map((c) => c.name)).toEqual(['test.bump', 'test.read'])
    expect(listed[0]).toMatchObject({ title: 'Bump the counter', readOnly: false, returnsFile: false, input: { type: 'object' } })
    expect(listed[1].readOnly).toBe(true)
  })

  it('refuses a second command of one name, and a name that is not namespace.verb', () => {
    expect(() => registerCommands('test', [bump])).toThrow('Two commands share the name "test.bump"')
    expect(() => registerCommands('Test', [{ ...bump, name: 'other' }])).toThrow('is not a command name')
    expect(() => registerCommands('test', [{ ...bump, name: 'x', input: { type: 'string' } }])).toThrow('must take an object')
  })

  it('refuses a command whose schema an agent’s client would drop, and holds the app’s own within it', () => {
    // Nested past the budget, then wide past it.
    let deep: JsonSchema = num()
    for (let i = 0; i < SCHEMA_BUDGET.depth; i++) deep = obj({ x: deep })
    expect(schemaWeight(deep).depth).toBeGreaterThan(SCHEMA_BUDGET.depth)
    expect(() => registerCommands('test', [{ ...bump, name: 'deep', input: deep }])).toThrow(/nested \d+ deep — past 8000 bytes and 12 deep/)
    const wide = obj(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, num(`The field numbered ${i}.`)])))
    expect(() => registerCommands('test', [{ ...bump, name: 'wide', input: wide }])).toThrow(/an agent's client may drop it/)
    expect(listCommands().some((c) => c.name === 'test.deep' || c.name === 'test.wide')).toBe(false)
    registerCoreCommands()
    for (const c of listCommands()) {
      const w = schemaWeight(c.input)
      expect(w.bytes <= SCHEMA_BUDGET.bytes && w.depth <= SCHEMA_BUDGET.depth, `${c.name}: ${w.bytes} bytes, ${w.depth} deep`).toBe(true)
    }
  })

  it('refuses an unknown command and an input that does not fit, as CommandErrors', async () => {
    expect(await code(runCommand('test.nope'))).toBe('unknown_command')
    expect(await code(runCommand('test.bump', { by: 'two' }))).toBe('invalid_input')
    expect(await code(runCommand('test.bump', { bye: 1 }))).toBe('invalid_input')
    expect(counter.value).toBe(0)
  })

  it('runs a command as one undo step under its title', async () => {
    expect(await runCommand('test.bump', { by: 2 })).toEqual({ value: 2 })
    expect(useHistory.getState().past.map((e) => e.label)).toEqual(['Agent: bump the counter'])
  })

  it('runs read-only commands at once, outside the history', async () => {
    expect(await runCommand('test.read')).toEqual({ value: 0 })
    expect(useHistory.getState().past).toHaveLength(0)
  })

  it('refuses a changing command while the session is busy, and says with what', async () => {
    const restore = configureCommands({ busy: () => 'a file is being read' })
    try {
      const refused = runCommand('test.bump').catch((e: CommandError) => e)
      const e = (await refused) as CommandError
      expect(e.code).toBe('busy')
      expect(e.message).toContain('a file is being read')
      // Reading is never in the way.
      expect(await runCommand('test.read')).toEqual({ value: 0 })
    } finally {
      restore()
    }
  })

  it('runs changing commands one after the other, and says which is running', async () => {
    const seen: (string | null)[] = []
    const slow: Command = {
      name: 'slow',
      title: 'Slow',
      description: '',
      input: obj({}),
      run: async () => {
        seen.push(useCommandActivity.getState().running?.name ?? null)
        await new Promise((r) => setTimeout(r, 20))
        return counter.value
      },
    }
    const off = registerCommands('test', [slow])
    try {
      const first = runCommand('test.slow')
      const second = runCommand('test.bump')
      const third = runCommand('test.slow')
      expect(await first).toBe(0)
      expect(await second).toEqual({ value: 1 })
      expect(await third).toBe(1)
      expect(seen).toEqual(['test.slow', 'test.slow'])
      expect(commandRunning()).toBe(false)
    } finally {
      off()
    }
  })

  it('turns any failure into a CommandError and runs the next command regardless', async () => {
    const broken: Command = { name: 'broken', title: 'Broken', description: '', input: obj({}), run: async () => { throw new Error('it broke') } }
    const off = registerCommands('test', [broken])
    try {
      const e = await runCommand('test.broken').catch((x: CommandError) => x)
      expect(e).toBeInstanceOf(CommandError)
      expect((e as CommandError).code).toBe('failed')
      expect((e as CommandError).message).toBe('it broke')
      expect(await runCommand('test.bump')).toEqual({ value: 1 })
    } finally {
      off()
    }
  })

  it('takes the commands out again', () => {
    unregister()
    expect(listCommands().some((c) => c.name.startsWith('test.'))).toBe(false)
    unregister = registerCommands('test', [bump, read])
  })
})
