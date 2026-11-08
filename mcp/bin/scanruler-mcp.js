#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The launcher: a newer copy of the server, fetched in the background by an
// earlier start, runs in this one's place (src/update.js); otherwise this
// one does. Nothing here waits on the network.
import { launch, USAGE_EXIT } from '../src/update.js'

const code = await launch(process.argv.slice(2))
if (code !== null) process.exit(code)

const { main } = await import('../src/main.js')
main().catch((error) => {
  process.stderr.write(`[scanruler-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
  // What main refuses is its arguments or settings; a launcher that handed
  // off to this copy reads the code as such, not as a copy that is broken.
  process.exit(USAGE_EXIT)
})
