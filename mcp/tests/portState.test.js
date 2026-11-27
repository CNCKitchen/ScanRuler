// SPDX-License-Identifier: AGPL-3.0-only
// Copies of the server on different ports drive different tabs — one part
// each, side by side. What belongs to a tab's session (the folders and the
// last project, folders.json) is kept per port, so an agent whose tab
// reloaded is pointed at its own part's project, not at the other's. The
// default port keeps the config folder itself, as before; the token stays
// one for every port.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_PORT, loadConfig, loadFolders, loadLastProject, portStateDir, saveFolders, saveLastProject } from '../src/config.js'

test('the default port keeps the config folder itself', () => {
  assert.equal(portStateDir(DEFAULT_PORT, '/cfg'), '/cfg')
})

test('another port keeps a folder of its own in the config folder', () => {
  assert.equal(portStateDir(7318, '/cfg'), join('/cfg', 'port-7318'))
  assert.notEqual(portStateDir(7318, '/cfg'), portStateDir(7319, '/cfg'))
})

test('two ports keep their folders and last project apart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-ports-'))
  const a = portStateDir(DEFAULT_PORT, dir)
  const b = portStateDir(7318, dir)
  saveFolders(['/parts/bracket'], a)
  saveLastProject('/parts/bracket/bracket.scanruler', a)
  saveFolders(['/parts/hinge'], b)
  saveLastProject('/parts/hinge/hinge.scanruler', b)

  assert.deepEqual(loadFolders(a), ['/parts/bracket'])
  assert.equal(loadLastProject(a), '/parts/bracket/bracket.scanruler')
  assert.deepEqual(loadFolders(b), ['/parts/hinge'])
  assert.equal(loadLastProject(b), '/parts/hinge/hinge.scanruler')
})

test('the token stays one for every port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanruler-mcp-ports-'))
  const first = loadConfig(dir)
  saveFolders(['/parts/hinge'], portStateDir(7318, dir))
  assert.equal(loadConfig(dir).token, first.token)
})
