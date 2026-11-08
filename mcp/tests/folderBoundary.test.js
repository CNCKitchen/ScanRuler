// SPDX-License-Identifier: AGPL-3.0-only
// scanruler_read, _write and _files stay in the folders a scan or project
// came from with links followed: a link in the scan's folder that points
// elsewhere is refused. A name that merely starts with two dots is a name
// in the folder, not a climb out of it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PageLink } from '../src/link.js'
import { createMcpServer } from '../src/mcp.js'

test('a link out of the scan folder is refused; "..notes.md" is read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-boundary-'))
  const scans = join(dir, 'scans')
  const outside = join(dir, 'outside')
  await mkdir(scans, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'not yours')
  await writeFile(join(scans, '..notes.md'), 'mine')
  // A junction needs no rights on Windows; elsewhere it is a plain link.
  await symlink(outside, join(scans, 'link'), 'junction')

  const link = new PageLink({ token: 'a-token-for-the-boundary-tests' })
  const server = createMcpServer({
    link,
    version: '0.0.0',
    cwd: dir,
    outDir: dir,
    connectHelp: () => 'Pair it.',
    serverInfo: () => ({}),
    pageTimeoutMs: 50,
    folderStore: { load: () => [scans], save: () => {} },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args })
    return { error: r.isError === true, text: r.content[0].text }
  }
  try {
    for (const [name, args] of [
      ['scanruler_read', { path: 'link/secret.txt' }],
      ['scanruler_write', { path: 'link/planted.md', text: 'x' }],
      ['scanruler_files', { path: 'link' }],
    ]) {
      const refused = await call(name, args)
      assert.equal(refused.error, true, name)
      assert.match(refused.text, /outside/, name)
    }
    const read = await call('scanruler_read', { path: '..notes.md' })
    assert.equal(read.error, false, read.text)
    assert.match(read.text, /mine/)
  } finally {
    await client.close()
    link.close()
  }
})
