// SPDX-License-Identifier: AGPL-3.0-only
// The entry of the single-executable build (scripts/bundle-agent.mjs): the server with ScanRuler running headless in it, using the engine shipped in engine/ beside the executable. It skips the launcher (bin/scanruler-mcp.js), because a release of this build is replaced by downloading the next one, never by the npm updater.
import { dirname, join } from 'node:path'
import { main } from '../src/main.js'
import { NO_UPDATE_ENV } from '../src/update.js'

process.env[NO_UPDATE_ENV] = '1'
const args = process.argv.slice(2)
if (!args.some((arg) => arg === '--engine' || arg.startsWith('--engine=') || arg === '--headless')) {
  args.unshift('--engine', join(dirname(process.execPath), 'engine', 'engine.mjs'))
}

main(args).catch((error) => {
  process.stderr.write(`[scanruler-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
