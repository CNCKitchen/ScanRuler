// SPDX-License-Identifier: AGPL-3.0-only
// Bundle the agent server (mcp/) with ScanRuler running headless in it, for the platform this runs on: dist-agent/<platform>-<arch>/ holds the executable, engine/ (the standalone engine and the CAD kernel's WebAssembly) and app/ (the built web app), which the executable finds beside itself. The runtime inside the executable is the Node that runs this script, so each platform is bundled on its own runner.
//
// The server is bundled to one CommonJS script because a single executable runs only that (Node 24); import.meta.url, used by the updater and the checkout engine path that this build never takes, is pointed at the executable. On macOS the executable is signed ad hoc, which Apple silicon requires of any binary; it is not notarised, so a downloaded copy still needs its quarantine attribute cleared (xattr -d com.apple.quarantine).
//
//   npm run bundle:agent
//   dist-agent/<platform>-<arch>/scanruler-agent   (speaks MCP on stdio, as scanruler-mcp does)

import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { inject } from 'postject'
import { build as buildApp } from 'vite'

/** The sentinel Node looks for to know a blob is injected; fixed by Node (doc/api/single-executable-applications.md). */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = `${process.platform}-${process.arch}`
const outDir = join(root, 'dist-agent', target)
const exeName = process.platform === 'win32' ? 'scanruler-agent.exe' : 'scanruler-agent'
const work = join(tmpdir(), `scanruler-agent-${process.pid}`)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await mkdir(work, { recursive: true })

execFileSync(process.execPath, [join(root, 'scripts', 'build-engine.mjs'), '--standalone'], { stdio: 'inherit' })
await buildApp({ root, logLevel: 'warn' })

const script = join(work, 'server.cjs')
await build({
  entryPoints: [join(root, 'mcp', 'bin', 'standalone.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: script,
  logLevel: 'warning',
  define: { 'import.meta.url': '__executableUrl' },
  banner: { js: "const __executableUrl = require('node:url').pathToFileURL(process.execPath).href;" },
})

const config = join(work, 'sea-config.json')
const blob = join(work, 'server.blob')
await writeFile(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true }))
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })

const exe = join(outDir, exeName)
await copyFile(process.execPath, exe)
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe])
await inject(exe, 'NODE_SEA_BLOB', await readFile(blob), {
  sentinelFuse: SEA_FUSE,
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
  overwrite: true,
})
if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--sign', '-', exe])
if (process.platform !== 'win32') await chmod(exe, 0o755)

await cp(join(root, 'dist-engine-standalone'), join(outDir, 'engine'), { recursive: true })
await cp(join(root, 'dist'), join(outDir, 'app'), { recursive: true })
await copyFile(join(root, 'mcp', 'LICENSE'), join(outDir, 'LICENSE'))
await rm(work, { recursive: true, force: true })
console.log(`Bundled ${join('dist-agent', target, exeName)}`)
