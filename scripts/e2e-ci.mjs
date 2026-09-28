// SPDX-License-Identifier: AGPL-3.0-only
// Own the servers so tests never accidentally target an unrelated dev session.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { createServer, preview } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'e2e-out', 'ci')
let child = null
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true
  process.exitCode = 1
  child?.kill('SIGTERM')
})

/** The browser checks the plugins ask for — each plugin's ci.json lists its
 *  scripts, relative to its folder. None in the open-source tree, which has
 *  no plugins/. */
function pluginChecks() {
  const dir = join(root, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'ci.json')))
    .flatMap((d) => JSON.parse(readFileSync(join(dir, d.name, 'ci.json'), 'utf8')).e2e.map((script) => join(dir, d.name, script)))
}

/** A check by name from scripts/, or a plugin's by its path. */
const scriptOf = (name) => (name.endsWith('.mjs') ? name : join(root, 'scripts', `${name}.mjs`))
const nameOf = (name) => basename(name, '.mjs')

async function run(check, url) {
  const name = nameOf(check)
  if (interrupted) throw new Error('Browser checks interrupted.')
  const directory = join(output, name)
  mkdirSync(directory, { recursive: true })
  const log = createWriteStream(join(directory, 'run.log'))
  console.log(`Running ${name} against ${url}`)
  try {
    const code = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [scriptOf(check)], {
        cwd: root,
        env: { ...process.env, APP_URL: url, OUT_DIR: directory, SHOT_DIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
        process.stdout.write(data)
        log.write(data)
      })
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
    if (code !== 0) process.exitCode = 1
  } finally {
    child = null
    log.end()
    await finished(log)
  }
}

try {
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Run npm run build before npm run e2e:ci.')
  const dev = await createServer({
    root,
    server: {
      host: '127.0.0.1', port: 5193, strictPort: false, open: false,
      // Failure HTML is an artifact, not a source edit that should reload tests.
      watch: { ignored: ['**/e2e-out/**'] },
    },
  })
  try {
    await dev.listen()
    for (const check of ['e2e-import', 'e2e-recovery', 'e2e-history', ...pluginChecks()]) await run(check, dev.resolvedUrls.local[0])
  } finally { await dev.close() }

  const production = await preview({ root, preview: { host: '127.0.0.1', port: 5194, strictPort: false, open: false } })
  try { await run('e2e-production', production.resolvedUrls.local[0]) }
  finally {
    await new Promise((resolve, reject) => {
      production.httpServer.close((error) => error ? reject(error) : resolve())
      production.httpServer.closeAllConnections()
    })
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
