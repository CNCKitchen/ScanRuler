// SPDX-License-Identifier: AGPL-3.0-only
// Package the shell for Windows x64 into release/win-unpacked: Electron with the
// shell's files in an asar, and in resources/ the built web app (app-dist), the
// agent server (mcp, with its node_modules) and agent-bridge.mjs; the
// scanruler-mcp.cmd agents are pointed at sits beside the exe.
// @electron/packager, not electron-builder: the latter bundles 7-Zip, LGPL,
// which the repository's licence policy does not allow.
//
//   npm run dist

import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const here = fileURLToPath(new URL('..', import.meta.url))
const repo = join(here, '..')
const out = join(here, 'release')
const stage = join(out, 'stage')
const resources = join(out, 'resources')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(readFileSync(join(here, 'node_modules', 'electron', 'package.json'), 'utf8')).version

rmSync(out, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
mkdirSync(resources, { recursive: true })

// The shell itself: what package.json names, plus a package.json of its own.
for (const f of ['main.js', 'preload.cjs', 'preload-main.cjs', 'settings.js', 'creality.js', 'i18n.js', 'i18n', 'hardware.html']) cpSync(join(here, f), join(stage, f), { recursive: true })
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'ScanRuler', version: pkg.version, main: 'main.js', type: 'module' }, null, 2))

// Beside it: the web app, the agent server (tests left out) and the bridge.
cpSync(join(repo, 'dist'), join(resources, 'app-dist'), { recursive: true })
cpSync(join(repo, 'mcp'), join(resources, 'mcp'), { recursive: true, filter: (src) => !/[\\/]mcp[\\/]tests([\\/]|$)/.test(src) })
cpSync(join(here, 'agent-bridge.mjs'), join(resources, 'agent-bridge.mjs'))

const [built] = await packager({
  dir: stage,
  out,
  name: 'ScanRuler',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  appVersion: pkg.version,
  icon: join(repo, 'public', 'favicon.ico'),
  asar: true,
  prune: false,
  overwrite: true,
  quiet: true,
  extraResource: [join(resources, 'app-dist'), join(resources, 'mcp'), join(resources, 'agent-bridge.mjs')],
})
if (!built) throw new Error('the packager made no app')
const target = join(out, 'win-unpacked')
renameSync(built, target)
cpSync(join(here, 'scanruler-mcp.cmd'), join(target, 'scanruler-mcp.cmd'))
rmSync(stage, { recursive: true, force: true })
rmSync(resources, { recursive: true, force: true })
console.log(`Packaged ${target}`)
