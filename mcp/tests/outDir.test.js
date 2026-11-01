// SPDX-License-Identifier: AGPL-3.0-only
// --out given as a relative path is resolved against the folder the server
// starts in: the status reports a plain absolute folder, not "cwd/../x".
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { startAgent } from './client.js'

const freePort = () =>
  new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

test('--out ../x is reported as a resolved folder', { timeout: 30_000 }, async () => {
  const agent = await startAgent({
    args: ['--port', String(await freePort()), '--out', '../reports'],
    env: { SCANRULER_MCP_TOKEN: 'a-test-token-long-enough', SCANRULER_MCP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'scanruler-mcp-')), SCANRULER_MCP_NO_UPDATE: '1' },
    stderr: 'pipe',
  })
  try {
    const status = (await agent.call('scanruler_status')).json
    assert.equal(status.server.outDir, resolve(process.cwd(), '../reports'))
  } finally {
    await agent.close()
  }
})
