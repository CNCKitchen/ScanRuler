// SPDX-License-Identifier: AGPL-3.0-only
// Package the desktop app for the platform this runs on: dist-electron/<platform>-<arch>/ScanRuler-<platform>-<arch>/ holds Electron with the shell (electron/main.ts, bundled), and beside it in the resources the built web app (app/), the agent server (server.cjs, which Electron runs as Node as the detached background server) and the tray's icon. On macOS the app is signed ad hoc, which Apple silicon requires of any binary, and without the hardened runtime, whose library validation refuses to load the app's own frameworks when no signature carries a Team ID; it is not notarised, so a downloaded copy needs its quarantine attribute cleared (xattr -d com.apple.quarantine ScanRuler.app).
//
//   npm run package:electron

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { Resvg } from '@resvg/resvg-js'
import { build } from 'esbuild'
import { build as buildApp } from 'vite'
import { bundleServer } from './lib/bundle-server'
import { packageField } from './lib/package'
import { thisTarget } from './lib/target'

/** The app's name: its bundle (ScanRuler.app), its executable and its window. */
const APP_NAME = 'ScanRuler'

/** The bundle identifier on macOS. */
const APP_BUNDLE_ID = 'com.cnckitchen.scanruler'

/** The tray icon is drawn at this width and shrunk to the tray's height by the shell, so it stays sharp on a high-density display. */
const TRAY_SOURCE_PX = 64

/** The sizes (in points, each also at twice the pixels) an .icns holds. */
const ICON_POINTS = [16, 32, 128, 256, 512]

const root = fileURLToPath(new URL('..', import.meta.url))
const { platform, arch, name: target } = thisTarget()
const outDir = join(root, 'dist-electron', target)
const stage = join(outDir, 'stage')
const resources = join(outDir, 'resources')
const markSvg = await readFile(join(root, 'public', 'scanruler-mark.svg'))
const version = await packageField(join(root, 'package.json'), 'version')
const electronVersion = await packageField(join(root, 'node_modules', 'electron', 'package.json'), 'version')

const render = (width: number): Buffer => new Resvg(markSvg, { fitTo: { mode: 'width', value: width } }).render().asPng()

await rm(outDir, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await mkdir(resources, { recursive: true })

await build({
  entryPoints: [join(root, 'electron', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: join(stage, 'main.cjs'),
  logLevel: 'warning',
})
await writeFile(join(stage, 'package.json'), `${JSON.stringify({ name: 'scanruler', productName: APP_NAME, version, main: 'main.cjs' }, null, 2)}\n`)

await bundleServer({ entry: join(root, 'mcp', 'bin', 'standalone.js'), outfile: join(resources, 'server.cjs') })
await buildApp({ root, logLevel: 'warn' })
await cp(join(root, 'dist'), join(resources, 'app'), { recursive: true })
await writeFile(join(resources, 'tray.png'), render(TRAY_SOURCE_PX))

/** The icon file for this platform, without its extension when the packager picks it: Windows reads the favicon's .ico; macOS needs an .icns, which iconutil makes from an iconset; Linux packages take none. */
async function icon(): Promise<string | undefined> {
  if (platform === 'win32') return join(root, 'public', 'favicon.ico')
  if (platform !== 'darwin') return undefined
  const iconset = join(outDir, `${APP_NAME}.iconset`)
  await mkdir(iconset, { recursive: true })
  for (const points of ICON_POINTS) {
    await writeFile(join(iconset, `icon_${points}x${points}.png`), render(points))
    await writeFile(join(iconset, `icon_${points}x${points}@2x.png`), render(points * 2))
  }
  const icns = join(outDir, `${APP_NAME}.icns`)
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns])
  return icns
}

const [built] = await packager({
  dir: stage,
  out: outDir,
  name: APP_NAME,
  platform,
  arch,
  electronVersion,
  appVersion: version,
  appBundleId: APP_BUNDLE_ID,
  icon: await icon(),
  asar: true,
  prune: false,
  overwrite: true,
  quiet: true,
  extraResource: [join(resources, 'server.cjs'), join(resources, 'app'), join(resources, 'tray.png')],
  ...(platform === 'darwin' ? { osxSign: { identity: '-', identityValidation: false, optionsForFile: () => ({ hardenedRuntime: false }) } } : {}),
})
if (built === undefined) throw new Error(`the packager made no app for ${target}`)
if (platform === 'darwin') execFileSync('codesign', ['--verify', '--deep', '--strict', join(built, `${APP_NAME}.app`)])
console.log(`Packaged ${built}`)
