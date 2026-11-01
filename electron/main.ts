// SPDX-License-Identifier: AGPL-3.0-only
// The desktop app's main process (bundled by scripts/package-electron.ts): wires Electron's real API into the shell, with the background server attached to or started detached from the resources shipped beside the app.
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { DEFAULT_PORT, pairingLink, start, stop } from '../mcp/src/daemon.js'
import { runShell, type AppEvent, type ShellElectron, type ShellWindow } from './shell'

const resources = process.resourcesPath
const port = Number(process.env.SCANRULER_MCP_PORT ?? DEFAULT_PORT)

/** Attaches to the background server if one answers, otherwise starts it detached, so it outlives this app. The Electron binary runs the bundled server as Node. */
async function server(): Promise<{ url: string; origin: string }> {
  await start({
    executable: process.execPath,
    leading: [join(resources, 'server.cjs')],
    args: ['--serve', join(resources, 'app')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    port,
  })
  return { url: pairingLink(port), origin: `http://127.0.0.1:${port}` }
}

/** Electron's `app` overloads `on` per event; the shell listens to three, none of which it reads arguments from. */
function listen(event: AppEvent, listener: () => void): void {
  if (event === 'window-all-closed') app.on(event, listener)
  else if (event === 'second-instance') app.on(event, listener)
  else app.on(event, listener)
}

const electron: ShellElectron<Electron.NativeImage, Electron.Menu> = {
  app: {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => { app.quit() },
    exit: (code) => { app.exit(code) },
    whenReady: () => app.whenReady(),
    on: listen,
  },
  BrowserWindow: class implements ShellWindow {
    private readonly window: BrowserWindow
    readonly webContents: ShellWindow['webContents']
    constructor(options: ConstructorParameters<typeof BrowserWindow>[0]) {
      this.window = new BrowserWindow(options)
      const contents = this.window.webContents
      this.webContents = {
        on: (event, listener) => { contents.on(event, listener) },
        setWindowOpenHandler: (handler) => { contents.setWindowOpenHandler(handler) },
        executeJavaScript: (code) => contents.executeJavaScript(code),
      }
    }
    isDestroyed() { return this.window.isDestroyed() }
    show() { this.window.show() }
    focus() { this.window.focus() }
    loadURL(url: string) { return this.window.loadURL(url) }
  },
  Tray,
  Menu,
  nativeImage,
  openExternal: (url) => shell.openExternal(url),
  showError: (heading, text) => { dialog.showErrorBox(heading, text) },
}

runShell(electron, { server, stopServer: () => stop(), trayIcon: join(resources, 'tray.png'), smoke: process.argv.includes('--smoke') })
