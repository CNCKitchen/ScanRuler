// SPDX-License-Identifier: AGPL-3.0-only
// The desktop shell's behaviour (electron/shell.ts) against a fake Electron: one instance, the tray's entries, a window that survives being closed, navigation kept on the app, and the smoke run's exit codes.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  guardNavigation,
  QUIT_AND_STOP_LABEL,
  runShell,
  TITLE,
  TRAY_ICON_PX,
  windowOptions,
  type AppEvent,
  type NavigationEvent,
  type ShellContents,
  type ShellDeps,
  type ShellElectron,
  type ShellWindow,
  type TrayItem,
  type WindowOptions,
} from '../electron/shell'

const ORIGIN = 'http://127.0.0.1:7317'
const URL_PAIRED = `${ORIGIN}/#agent=7317:token`
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

interface Image {
  readonly path: string
  readonly size: { readonly height: number }
}

class FakeWindow implements ShellWindow {
  shown = 0
  focused = 0
  destroyed = false
  readonly loaded: string[] = []
  readonly webContents: ShellContents
  constructor(
    readonly options: WindowOptions,
    private readonly fails: boolean,
    title: string,
  ) {
    const events = new EventEmitter()
    this.webContents = {
      on: (event, listener) => { events.on(event, listener) },
      setWindowOpenHandler: () => undefined,
      executeJavaScript: () => Promise.resolve(title),
    }
  }
  isDestroyed(): boolean { return this.destroyed }
  show(): void { this.shown++ }
  focus(): void { this.focused++ }
  loadURL(url: string): Promise<void> {
    if (this.fails) return Promise.reject(new Error('did not load'))
    this.loaded.push(url)
    return Promise.resolve()
  }
}

function fakeElectron(options: { lock?: boolean; title?: string; loadFails?: boolean } = {}) {
  const { lock = true, title = 'ScanRuler by CNC Kitchen', loadFails = false } = options
  const events = new EventEmitter()
  const log = {
    windows: [] as FakeWindow[],
    trayImages: [] as Image[],
    trayTips: [] as string[],
    menus: [] as TrayItem[][],
    images: [] as Image[],
    quits: 0,
    exits: [] as number[],
    errors: [] as string[][],
    external: [] as string[],
  }
  const electron: ShellElectron<Image, TrayItem[]> = {
    app: {
      requestSingleInstanceLock: () => lock,
      quit: () => { log.quits++ },
      exit: (code) => { log.exits.push(code) },
      whenReady: () => Promise.resolve(),
      on: (event: AppEvent, listener) => { events.on(event, listener) },
    },
    BrowserWindow: class extends FakeWindow {
      constructor(windowOptionsGiven: WindowOptions) {
        super(windowOptionsGiven, loadFails, title)
        log.windows.push(this)
      }
    },
    Tray: class {
      constructor(image: Image) { log.trayImages.push(image) }
      setToolTip(tip: string): void { log.trayTips.push(tip) }
      setContextMenu(): void {}
    },
    Menu: { buildFromTemplate: (template) => { log.menus.push(template); return template } },
    nativeImage: { createFromPath: (path) => ({ resize: (size) => { const image = { path, size }; log.images.push(image); return image } }) },
    openExternal: (url) => { log.external.push(url) },
    showError: (heading, text) => { log.errors.push([heading, text]) },
  }
  return { electron, log, emit: (event: AppEvent) => events.emit(event) }
}

const deps = (extra: Partial<ShellDeps> = {}): ShellDeps => ({ server: () => Promise.resolve({ url: URL_PAIRED, origin: ORIGIN }), stopServer: () => Promise.resolve(true), trayIcon: '/res/tray.png', smoke: false, ...extra })

describe('the desktop shell', () => {
  it('quits a second instance at once and builds nothing', async () => {
    const { electron, log } = fakeElectron({ lock: false })
    runShell(electron, deps())
    await settle()
    expect(log.quits).toBe(1)
    expect(log.windows).toHaveLength(0)
    expect(log.trayImages).toHaveLength(0)
  })

  it('opens one window on the paired app and a tray with Open, Quit and Quit and stop', async () => {
    const { electron, log } = fakeElectron()
    runShell(electron, deps())
    await settle()
    expect(log.windows).toHaveLength(1)
    expect(log.windows[0]?.loaded).toEqual([URL_PAIRED])
    expect(log.windows[0]?.options.show).toBe(true)
    expect(log.trayImages).toHaveLength(1)
    expect(log.trayTips).toEqual([TITLE])
    expect(log.images).toEqual([{ path: '/res/tray.png', size: { height: TRAY_ICON_PX } }])
    expect(log.menus[0]?.map((entry) => entry.label)).toEqual(['Open', 'Quit', QUIT_AND_STOP_LABEL])
  })

  it('stays when the last window closes; Quit quits; Open and a second launch reuse the window', async () => {
    const { electron, log, emit } = fakeElectron()
    runShell(electron, deps())
    await settle()
    emit('window-all-closed')
    expect(log.quits).toBe(0)
    const [open, quit] = log.menus[0] ?? []
    if (open === undefined || quit === undefined) throw new Error('the tray menu has no entries')
    open.click()
    await settle()
    expect(log.windows).toHaveLength(1)
    expect(log.windows[0]?.shown).toBe(1)
    emit('second-instance')
    emit('activate')
    await settle()
    expect(log.windows[0]?.shown).toBe(3)
    const first = log.windows[0]
    if (first === undefined) throw new Error('no window was made')
    first.destroyed = true
    open.click()
    await settle()
    expect(log.windows).toHaveLength(2)
    quit.click()
    expect(log.quits).toBe(1)
  })

  it('stops the background server before quitting on Quit and stop, and stays up with the error when it will not stop', async () => {
    const stopped = fakeElectron()
    let stops = 0
    runShell(stopped.electron, deps({ stopServer: () => { stops++; return Promise.resolve(true) } }))
    await settle()
    const stopEntry = stopped.log.menus[0]?.find((entry) => entry.label === QUIT_AND_STOP_LABEL)
    if (stopEntry === undefined) throw new Error('the tray menu has no stop entry')
    stopEntry.click()
    expect(stopped.log.quits).toBe(0)
    await settle()
    expect(stops).toBe(1)
    expect(stopped.log.quits).toBe(1)
    const stuck = fakeElectron()
    runShell(stuck.electron, deps({ stopServer: () => Promise.reject(new Error('still answering')) }))
    await settle()
    stuck.log.menus[0]?.find((entry) => entry.label === QUIT_AND_STOP_LABEL)?.click()
    await settle()
    expect(stuck.log.quits).toBe(0)
    expect(stuck.log.errors).toEqual([[TITLE, 'still answering']])
  })

  it('keeps navigation on the app: another origin and window.open go to the browser, other schemes are dropped', () => {
    const events = new EventEmitter()
    let openHandler: Parameters<ShellContents['setWindowOpenHandler']>[0] | undefined
    const contents: ShellContents = {
      on: (event, listener) => { events.on(event, listener) },
      setWindowOpenHandler: (handler) => { openHandler = handler },
      executeJavaScript: () => Promise.resolve(undefined),
    }
    const external: string[] = []
    guardNavigation(contents, ORIGIN, (url) => { external.push(url) })
    const navigate = (url: string): boolean => {
      let prevented = false
      const event: NavigationEvent = { preventDefault: () => { prevented = true } }
      events.emit('will-navigate', event, url)
      return prevented
    }
    expect(navigate(`${ORIGIN}/other`)).toBe(false)
    expect(navigate('https://example.com/docs')).toBe(true)
    expect(openHandler?.({ url: 'https://example.com/x' })).toEqual({ action: 'deny' })
    navigate('file:///etc/passwd')
    expect(external).toEqual(['https://example.com/docs', 'https://example.com/x'])
  })

  it('hides the window for a smoke run and keeps the page isolated', () => {
    expect(windowOptions(true).show).toBe(false)
    expect(windowOptions(false).webPreferences).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false })
  })

  it('exits a smoke run 0 when the page title says ScanRuler and 1 when it does not', async () => {
    const good = fakeElectron()
    runShell(good.electron, deps({ smoke: true }))
    await settle()
    await settle()
    expect(good.log.exits).toEqual([0])
    const bad = fakeElectron({ title: 'Error' })
    runShell(bad.electron, deps({ smoke: true }))
    await settle()
    await settle()
    expect(bad.log.exits).toEqual([1])
  })

  it('exits a smoke run 1 when the page does not load, and shows the error and quits in a normal run', async () => {
    const smoke = fakeElectron({ loadFails: true })
    runShell(smoke.electron, deps({ smoke: true }))
    await settle()
    await settle()
    expect(smoke.log.exits).toEqual([1])
    const normal = fakeElectron({ loadFails: true })
    runShell(normal.electron, deps())
    await settle()
    await settle()
    expect(normal.log.errors).toHaveLength(1)
    expect(normal.log.quits).toBe(1)
  })
})
