// SPDX-License-Identifier: AGPL-3.0-only
// The desktop shell's behaviour, with Electron's API handed in so it runs in a test: one instance per user, a tray with Open, Quit and Quit and stop the background server, one window on the app served by the background server, and closing the window leaves everything running (only the tray's Quit entries end the shell, and the background server outlives a plain Quit so the agents relaying through it keep working).

/** The window's name, and the tray's. */
export const TITLE = 'ScanRuler'

/** The tray entry that ends the background server as well as the shell, which a plain Quit leaves running. */
export const QUIT_AND_STOP_LABEL = 'Quit and stop background server'

/** The tray icon's height in pixels: the macOS menu bar's icon height in points, which also sits within Ubuntu's panel. */
export const TRAY_ICON_PX = 16

/** The window's size on first open, a common laptop screen's usable area. */
export const WINDOW_WIDTH = 1440
export const WINDOW_HEIGHT = 900

/** How long --smoke waits for the page to load before it fails: the page is served from this machine into a hidden window, so it is up within seconds and a minute is a hang. */
export const SMOKE_TIMEOUT_MS = 60_000

/** The events of Electron's `app` the shell listens to. */
export type AppEvent = 'window-all-closed' | 'second-instance' | 'activate'

export interface ShellApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  exit(code: number): void
  whenReady(): Promise<void>
  on(event: AppEvent, listener: () => void): void
}

export interface NavigationEvent {
  preventDefault(): void
}

export interface ShellContents {
  on(event: 'will-navigate', listener: (event: NavigationEvent, url: string) => void): void
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void
  executeJavaScript(code: string): Promise<unknown>
}

export interface ShellWindow {
  readonly webContents: ShellContents
  isDestroyed(): boolean
  show(): void
  focus(): void
  loadURL(url: string): Promise<void>
}

export interface WindowOptions {
  readonly width: number
  readonly height: number
  readonly title: string
  readonly show: boolean
  readonly webPreferences: { readonly contextIsolation: true; readonly sandbox: true; readonly nodeIntegration: false }
}

/** A tray menu entry. */
export interface TrayItem {
  readonly label: string
  readonly click: () => void
}

export interface ShellTray<Menu> {
  setToolTip(tip: string): void
  setContextMenu(menu: Menu): void
}

/** The parts of Electron's API the shell uses; `Image` and `Menu` are Electron's own types, which the shell only passes between its calls. */
export interface ShellElectron<Image, Menu> {
  readonly app: ShellApp
  readonly BrowserWindow: new (options: WindowOptions) => ShellWindow
  readonly Tray: new (image: Image) => ShellTray<Menu>
  readonly Menu: { buildFromTemplate(template: TrayItem[]): Menu }
  readonly nativeImage: { createFromPath(path: string): { resize(size: { readonly height: number }): Image } }
  openExternal(url: string): Promise<void> | void
  showError(heading: string, text: string): void
}

/** What the shell is given: how to reach the background server and how to end it, the tray icon's path, and whether this is a smoke run. `server` resolves the address of the app (already paired) and its origin; `stopServer` resolves once the server no longer holds its port and rejects when it still does. */
export interface ShellDeps {
  readonly server: () => Promise<{ readonly url: string; readonly origin: string }>
  readonly stopServer: () => Promise<unknown>
  readonly trayIcon: string
  readonly smoke: boolean
}

/** The window's options. A smoke run keeps it hidden. */
export function windowOptions(smoke: boolean): WindowOptions {
  return {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: TITLE,
    show: !smoke,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  }
}

/** Keeps the window on the app: a navigation or a window.open to another origin goes to the user's browser instead. */
export function guardNavigation(webContents: ShellContents, origin: string, openExternal: (url: string) => Promise<void> | void): void {
  const toBrowser = (url: string): void => {
    // Only web links leave the app; anything else (file:, a custom scheme) is dropped.
    if (/^https?:\/\//u.test(url)) void openExternal(url)
  }
  webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault()
      toBrowser(url)
    }
  })
  webContents.setWindowOpenHandler(({ url }) => {
    toBrowser(url)
    return { action: 'deny' }
  })
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Runs the shell. A second instance asks the first to show its window and quits. With `deps.smoke` it loads the page, checks its title and exits 0 (1 on any failure) instead of staying.
 */
export function runShell<Image, Menu>(electron: ShellElectron<Image, Menu>, deps: ShellDeps): void {
  const { app } = electron
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  // Closing the last window would otherwise quit the shell; only the tray's Quit does.
  app.on('window-all-closed', () => undefined)
  let window: ShellWindow | undefined
  const ready = app.whenReady()
  const server = ready.then(() => deps.server())

  const open = async (): Promise<ShellWindow> => {
    const { url, origin } = await server
    if (window !== undefined && !window.isDestroyed()) {
      window.show()
      window.focus()
      return window
    }
    const opened = new electron.BrowserWindow(windowOptions(deps.smoke))
    window = opened
    guardNavigation(opened.webContents, origin, electron.openExternal)
    await opened.loadURL(url)
    return opened
  }
  const reopen = (): void => {
    open().catch((error: unknown) => {
      electron.showError(TITLE, message(error))
    })
  }

  // Held for the shell's life: a tray that is collected disappears from the menu bar.
  const trays: ShellTray<Menu>[] = []
  const trayMade = ready.then(() => {
    const tray = new electron.Tray(electron.nativeImage.createFromPath(deps.trayIcon).resize({ height: TRAY_ICON_PX }))
    trays.push(tray)
    tray.setToolTip(TITLE)
    tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: 'Open', click: reopen },
        { label: 'Quit', click: () => { app.quit() } },
        {
          label: QUIT_AND_STOP_LABEL,
          click: () => {
            // The shell stays up when the server will not stop, so the error is shown against a tray that still works.
            deps.stopServer().then(
              () => { app.quit() },
              (error: unknown) => { electron.showError(TITLE, message(error)) },
            )
          },
        },
      ]),
    )
    return tray
  })
  app.on('second-instance', reopen)
  app.on('activate', reopen)

  const opening = open()
  if (!deps.smoke) {
    opening.catch((error: unknown) => {
      electron.showError(TITLE, message(error))
      app.quit()
    })
    return
  }
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => { reject(new Error(`the page did not load within ${SMOKE_TIMEOUT_MS / 1000} seconds`)) }, SMOKE_TIMEOUT_MS).unref()
  })
  const title = Promise.all([opening, trayMade]).then(([opened]) => opened.webContents.executeJavaScript('document.title'))
  Promise.race([title, deadline]).then(
    (found) => {
      if (typeof found === 'string' && found.includes(TITLE)) {
        app.exit(0)
        return
      }
      process.stderr.write(`smoke: the page title was ${JSON.stringify(found)}\n`)
      app.exit(1)
    },
    (error: unknown) => {
      process.stderr.write(`smoke: ${message(error)}\n`)
      app.exit(1)
    },
  )
}
