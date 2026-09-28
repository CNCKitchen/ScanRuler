// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The version the app reports is the one package.json carries, read here and
// substituted at build time — so bumping that one field is the whole of a
// release, and no source file has a number to forget.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  // The workers are module workers already (`type: 'module'` everywhere they
  // are made), and a worker may load a large package with a dynamic import
  // so that it is fetched only when it is needed — which needs a worker
  // bundle that can split.
  worker: {
    format: 'es',
  },
  // The dev server's dependency scan starts from index.html and does not
  // follow `new Worker(new URL(…))`, so a package only a worker imports was
  // found the first time that worker ran — pre-bundled then, and the page
  // reloaded under the user. Every worker module is named *Worker.ts; the
  // scan starts from those too.
  optimizeDeps: {
    entries: ['index.html', '**/*Worker.ts'],
  },
  test: {
    environment: 'node',
    // Each plugin keeps its tests beside it; the open-source tree has none.
    include: ['tests/**/*.test.ts', 'plugins/*/tests/**/*.test.ts'],
    testTimeout: 180_000,
  },
})
