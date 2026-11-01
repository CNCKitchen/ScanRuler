// SPDX-License-Identifier: AGPL-3.0-only
// The SDK does not check a call's arguments against the tool's schema, so
// the server checks its own tools': a scanruler_wait with a timeoutSeconds
// that is no number, or not above zero, is refused rather than waiting no
// time at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PageLink } from '../src/link.js'
import { createMcpServer } from '../src/mcp.js'

test('scanruler_wait refuses a timeoutSeconds its schema does not take', async () => {
  const link = new PageLink({ token: 'a-token-for-the-input-tests' })
  const server = createMcpServer({ link, version: '0.0.0', cwd: '.', outDir: '.', connectHelp: () => 'Pair it.', serverInfo: () => ({}), pageTimeoutMs: 50 })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    for (const timeoutSeconds of ['abc', -5, 0, 601]) {
      const reply = await client.callTool({ name: 'scanruler_wait', arguments: { timeoutSeconds } })
      assert.equal(reply.isError, true, String(timeoutSeconds))
      assert.match(reply.content[0].text, /^invalid_input: timeoutSeconds/)
    }
    const bad = await client.callTool({ name: 'scanruler_wait', arguments: { for: 'nothing' } })
    assert.match(bad.content[0].text, /^invalid_input: for/)
  } finally {
    await client.close()
    link.close()
  }
})
