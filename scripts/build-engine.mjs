// SPDX-License-Identifier: AGPL-3.0-only
// Build the app's headless engine (src/headless/engine.ts) for Node: one module, dist-engine/engine.mjs, exporting startEngine(), with the packages it uses left to Node to find in this checkout's node_modules, which is why it is built here and run from here. scanruler-mcp runs it with --engine <path>, or --headless for this checkout's dist-engine; the plugins the build finds are in it, as they are in the page.
//
// With --standalone every package is inlined instead and the CAD kernel's WebAssembly is copied to assets/ beside the module, which is where the kernel looks for it, so dist-engine-standalone/ runs from any directory with no node_modules (scripts/bundle-agent.mjs ships it beside the agent executable).
//
//   npm run build:engine
//   npm run build:engine -- --standalone

import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const standalone = process.argv.includes('--standalone')
const outDir = standalone ? 'dist-engine-standalone' : 'dist-engine'
const root = fileURLToPath(new URL('..', import.meta.url))

await build({
  root,
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  logLevel: 'warn',
  // The page's static files are the page's.
  publicDir: false,
  build: {
    ssr: 'src/headless/engine.ts',
    outDir,
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'engine.mjs', format: 'es' } },
  },
  ssr: { target: 'node', noExternal: standalone ? true : undefined },
})

if (standalone) {
  await mkdir(new URL(`../${outDir}/assets/`, import.meta.url), { recursive: true })
  await cp(new URL('../node_modules/occt-wasm/dist/occt-wasm.wasm', import.meta.url), new URL(`../${outDir}/assets/occt-wasm.wasm`, import.meta.url))
}
console.log(`Built ${outDir}/engine.mjs`)
