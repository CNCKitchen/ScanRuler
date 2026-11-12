// SPDX-License-Identifier: AGPL-3.0-only
// The headless backend: ScanRuler itself run in this process, with no
// browser — no scan, no viewport, nobody watching — in place of the page.
// The engine is a build of the app for Node (npm run build:engine in a
// ScanRuler checkout writes dist-engine/engine.mjs), found by its path and
// loaded as it is: this package names nothing in it and imports nothing from
// the app. It offers the commands that run without the page, with the same
// names, inputs and answers as the page's; the rest answer `unavailable`,
// naming the page mode. One engine to a process — its state is the app's
// own — so two servers started headless share nothing.

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { toolName } from './tools.js'

/** Where --headless looks: the engine built in the ScanRuler checkout this
 *  package is part of. */
export const CHECKOUT_ENGINE = fileURLToPath(new URL('../../dist-engine/engine.mjs', import.meta.url))

/** Load and start the engine at `file`. Throws, saying what to do, when
 *  there is none there or it is no engine. */
export async function loadEngine(file) {
  if (!existsSync(file)) throw new Error(`There is no ScanRuler engine at ${file}. Build one with "npm run build:engine" in the ScanRuler checkout, or give --engine the path of one.`)
  const mod = await import(pathToFileURL(file).href)
  if (typeof mod.startEngine !== 'function') throw new Error(`${file} is not a ScanRuler engine: it has no startEngine().`)
  return mod.startEngine()
}

/** The engine, as the page link is to the server (link.js): always
 *  connected, its commands what a page would say it has. */
export class EngineLink extends EventEmitter {
  /** @param {{ app: string, version: string, plugins: string[], listCommands(): object[], pageCommands(): string[], run(name: string, input: unknown, onProgress?: (text: string) => void): Promise<unknown>, stop(): Promise<void> }} engine */
  constructor(engine, file) {
    super()
    this.engine = engine
    this.file = file
    this.backend = 'headless'
    this.role = 'headless'
    this.error = null
    this.page = { app: engine.app, version: engine.version, origin: null, plugins: engine.plugins, viewport: false, commands: engine.listCommands() }
  }

  get connected() {
    return true
  }

  /** A command run in the engine; refused with { code, message } as the
   *  page refuses one. */
  run(name, input, _binaryKey, onProgress) {
    return this.engine.run(name, input, onProgress).catch((e) => Promise.reject({ code: e?.code ?? 'failed', message: e?.message ?? String(e) }))
  }

  /** The command behind a tool that needs the page, by the tool's name —
   *  null for one the engine has not got at all. */
  pageCommand(tool) {
    return this.engine.pageCommands().find((name) => toolName({ name }) === tool) ?? null
  }

  waitForPage() {
    return Promise.resolve(true)
  }

  start() {}

  close() {
    Promise.resolve()
      .then(() => this.engine.stop())
      .catch((e) => process.stderr.write(`[scanruler-mcp] The engine did not stop cleanly: ${e?.message ?? e}
`))
  }
}
