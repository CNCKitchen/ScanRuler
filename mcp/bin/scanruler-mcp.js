#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { main } from '../src/main.js'

main().catch((error) => {
  process.stderr.write(`[scanruler-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
