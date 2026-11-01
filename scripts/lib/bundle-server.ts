// SPDX-License-Identifier: AGPL-3.0-only
// Bundle an entry of the agent server (mcp/) to the one CommonJS script a Node single executable, or an Electron app running as Node, runs. import.meta.url, used by the updater and the checkout engine path that these builds never take, is pointed at the running executable.

import { build } from 'esbuild'

/** Bundles `entry` to `outfile`. Resolves once written. */
export async function bundleServer({ entry, outfile }: Readonly<{ entry: string; outfile: string }>): Promise<void> {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    logLevel: 'warning',
    define: { 'import.meta.url': '__executableUrl' },
    banner: { js: "const __executableUrl = require('node:url').pathToFileURL(process.execPath).href;" },
  })
}
