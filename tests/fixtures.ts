// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A real-scan fixture at the repository root. The scans are too large for the
 * repository (gitignored via /*.stl), so the acceptance tests against them run
 * only where the files exist — but never silently: a missing fixture announces
 * exactly what is not being tested and where the file has to go.
 */
export function fixture(name: string): { path: string; exists: boolean } {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url))
  const exists = existsSync(path)
  if (!exists) {
    console.warn(
      `\n⚠ Fixture "${name}" not found — its acceptance tests are SKIPPED.\n` +
        `  These are the real-scan measurements, the strongest tests in the suite.\n` +
        `  Place the file at ${path} to run them.\n`,
    )
  }
  return { path, exists }
}
