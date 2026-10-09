// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { registerCoreCommands } from '../src/commands/core'
import { listCommands } from '../src/commands/registry'

/** The MCP server (mcp/) lists the app's commands as tools before a page
 *  has connected, from its own copy of the list. This keeps the copy the
 *  app's: run with UPDATE_MCP_COMMANDS=1 to write it after a command
 *  changes. */
const FILE = new URL('../mcp/src/commands.json', import.meta.url)

describe('the MCP server’s copy of the command list', () => {
  it('is the app’s own', () => {
    registerCoreCommands()
    const commands = listCommands()
    if (process.env.UPDATE_MCP_COMMANDS) writeFileSync(FILE, JSON.stringify(commands, null, 2) + '\n')
    const kept = JSON.parse(readFileSync(FILE, 'utf8'))
    expect(kept, 'mcp/src/commands.json is out of date — run UPDATE_MCP_COMMANDS=1 npx vitest run tests/mcpCommands.test.ts').toEqual(commands)
  })
})
