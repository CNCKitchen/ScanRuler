// SPDX-License-Identifier: AGPL-3.0-only
// ScanRuler Desktop: serves the built ScanRuler and the agent link from this
// process and shows the app in its own window, paired with the link — no
// browser, no hosted site. The ScanRuler code is not touched.
import { app, BrowserWindow, Menu, dialog, ipcMain, session } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cpus } from 'node:os'
import { BACKENDS, gpuSwitches, loadSettings, saveSettings } from './settings.js'
import { LANGUAGES, injectScript, loadDict } from './i18n.js'
import { meshOfProject, watchMeshes } from './creality.js'

// Native menu text; the page's own text goes through i18n.js.
const MENU = {
  'pt-BR': { file: 'Arquivo', open: 'Abrir scan…', quit: 'Sair', view: 'Exibir', help: 'Ajuda', hardware: 'Hardware…', language: 'Idioma', watch: 'Observar pasta do Creality Scan…', unwatch: 'Parar de observar o Creality Scan', fresh: 'Novo Mesh.ply do projeto', openIt: 'Abrir no ScanRuler', ignore: 'Ignorar' },
  en: { file: 'File', open: 'Open scan…', quit: 'Quit', view: 'View', help: 'Help', hardware: 'Hardware…', language: 'Language', watch: 'Watch Creality Scan folder…', unwatch: 'Stop watching Creality Scan', fresh: 'New Mesh.ply from project', openIt: 'Open in ScanRuler', ignore: 'Ignore' },
}

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 7317
const OPENABLE = /\.(scanruler|stl|ply|obj|3mf|step|stp|obp)$/i
const CHUNK = 12 * 1024 * 1024 // bytes of file per script, ~16 MB of base64

// Packaged: resources/app-dist and resources/mcp; from a checkout: ../src.
const distDir = app.isPackaged ? join(process.resourcesPath, 'app-dist') : resolve(here, '../dist')
const mcpDir = app.isPackaged ? join(process.resourcesPath, 'mcp') : resolve(here, '../mcp')

// Graphics switches have to be set before Electron is ready.
const settings = loadSettings(app.getPath('userData'))
const backendRunning = settings.backend
for (const [name, value] of gpuSwitches(settings.backend)) app.commandLine.appendSwitch(name, value)

// Nothing here talks to the network on its own.
process.env.SCANRULER_MCP_NO_UPDATE = '1'

// A second copy hands its file to the first and leaves before starting anything.
const first = app.requestSingleInstanceLock()
if (!first) app.exit(0)

let main = null
let link = null
let http = null
let pairingUrl = null
let angleActive = null
const pendingFiles = []
let stopWatching = null
let asking = false

const fileArg = (argv) => argv.slice(1).find((a) => OPENABLE.test(a) && existsSync(a))

/** Hand a file to the page as if it were dropped on it, which is the app's own way in. */
async function openFile(path) {
  if (/\.obp$/i.test(path)) path = meshOfProject(path)
  if (!main || main.webContents.isLoading()) {
    pendingFiles.push(path)
    return
  }
  // Sent in pieces: a scan can be hundreds of MB, too much for one script string.
  const bytes = readFileSync(path)
  const wc = main.webContents
  await wc.executeJavaScript('window.__srOpen = []')
  for (let at = 0; at < bytes.length; at += CHUNK) {
    await wc.executeJavaScript(`window.__srOpen.push("${bytes.subarray(at, at + CHUNK).toString('base64')}")`)
  }
  await wc.executeJavaScript(`(() => {
    const parts = window.__srOpen.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    window.__srOpen = null
    const dt = new DataTransfer()
    dt.items.add(new File(parts, ${JSON.stringify(basename(path))}))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)
}

/** Watch a Creality Scan projects folder; a finished Mesh.ply is offered to the page, never opened unasked. */
function watchCreality(dir) {
  stopWatching?.()
  stopWatching = null
  settings.crealityDir = dir
  saveSettings(app.getPath('userData'), settings)
  if (dir) {
    try {
      stopWatching = watchMeshes(dir, async (path, project) => {
        if (asking) return
        asking = true
        try {
          const m = MENU[settings.language]
          const r = await dialog.showMessageBox(main ?? undefined, { type: 'question', message: `${m.fresh} “${project}”`, detail: path, buttons: [m.openIt, m.ignore], defaultId: 0, cancelId: 1 })
          if (r.response === 0) await openFile(path)
        } catch (e) {
          dialog.showErrorBox('ScanRuler', String(e))
        } finally {
          asking = false
        }
      })
    } catch (e) {
      dialog.showErrorBox('ScanRuler', String(e))
      settings.crealityDir = ''
      saveSettings(app.getPath('userData'), settings)
    }
  }
  buildMenu()
}

// The page rejects a project.obp; a drop or a file pick of one goes to the main process instead,
// which opens the project's mesh (the page cannot see the folder around the file).
const PROJECT_HOOK = `(() => {
  if (window.__srProjectHook) return
  window.__srProjectHook = true
  const isObp = (f) => f && /\\.obp$/i.test(f.name)
  const take = (e, file) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    window.srProject.open(file)
  }
  window.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (isObp(f)) take(e, f) }, true)
  document.addEventListener('change', (e) => {
    const f = e.target?.type === 'file' && e.target.files?.[0]
    if (isObp(f)) { take(e, f); e.target.value = '' }
  }, true)
})()`

async function startServer() {
  const { httpServer } = await import(pathToFileURL(join(mcpDir, 'src/serve.js')).href)
  const { SharedLink } = await import(pathToFileURL(join(mcpDir, 'src/relay.js')).href)
  const { originAllowed } = await import(pathToFileURL(join(mcpDir, 'src/link.js')).href)
  const { loadConfig } = await import(pathToFileURL(join(mcpDir, 'src/config.js')).href)
  const version = JSON.parse(readFileSync(join(mcpDir, 'package.json'), 'utf8')).version
  const port = Number(process.env.SCANRULER_MCP_PORT ?? DEFAULT_PORT)
  const token = process.env.SCANRULER_MCP_TOKEN || loadConfig().token
  http = httpServer({ serve: distDir, allowOrigin: (o) => originAllowed(o, []), version })
  link = new SharedLink({ http, port, token, version, log: (l) => console.log(`[mcp] ${l}`) })
  const role = new Promise((ok) => link.on('role', ok))
  link.start()
  if ((await Promise.race([role, new Promise((r) => setTimeout(() => r('timeout'), 4000))])) !== 'holder') {
    throw new Error(
      `A porta ${port} já está em uso por outro scanruler-mcp ou programa. Feche-o ou defina SCANRULER_MCP_PORT.`,
    )
  }
  pairingUrl = `http://127.0.0.1:${port}/#agent=${port}:${token}`
  // The agent entry (scanruler-mcp.cmd) reads this to join the app that is open.
  writeFileSync(agentFile(), JSON.stringify({ port, token }), { mode: 0o600 })
}

const agentFile = () => join(app.getPath('userData'), 'agent.json')

// Cross-origin isolation (SharedArrayBuffer, multithreaded WASM) for the local app only.
function isolate() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1/*'] }, (d, cb) => {
    cb({
      responseHeaders: {
        ...d.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    })
  })
}

/** Put the page in the chosen language (English leaves it as it is). */
function translate() {
  main?.webContents.executeJavaScript(injectScript(loadDict(settings.language))).catch((e) => console.error('i18n', e))
}

function setLanguage(language) {
  settings.language = language
  saveSettings(app.getPath('userData'), settings)
  translate()
  buildMenu()
}

function buildMenu() {
  const m = MENU[settings.language]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: m.file,
        submenu: [
          {
            label: m.open,
            accelerator: 'CmdOrCtrl+O',
            click: async () => {
              const r = await dialog.showOpenDialog(main, { filters: [{ name: 'Scan', extensions: ['stl', 'ply', 'obj', '3mf', 'step', 'stp', 'scanruler', 'obp'] }] })
              if (!r.canceled) openFile(r.filePaths[0]).catch((e) => dialog.showErrorBox('ScanRuler', String(e)))
            },
          },
          { type: 'separator' },
          settings.crealityDir
            ? { label: `${m.unwatch} (${basename(settings.crealityDir)})`, click: () => watchCreality('') }
            : {
                label: m.watch,
                click: async () => {
                  const r = await dialog.showOpenDialog(main, { properties: ['openDirectory'] })
                  if (!r.canceled) watchCreality(r.filePaths[0])
                },
              },
          { type: 'separator' },
          { role: 'quit', label: m.quit },
        ],
      },
      { label: m.view, submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
      {
        label: m.language,
        submenu: Object.entries(LANGUAGES).map(([id, label]) => ({ label, type: 'radio', checked: settings.language === id, click: () => setLanguage(id) })),
      },
      { label: m.help, submenu: [{ label: m.hardware, click: showHardware }] },
    ]),
  )
}

function createWindow() {
  main = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: '#15171a',
    title: 'ScanRuler',
    webPreferences: { preload: join(here, 'preload-main.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:')) e.preventDefault()
  })
  main.webContents.on('did-finish-load', async () => {
    translate()
    main.webContents.executeJavaScript(PROJECT_HOOK).catch((e) => console.error('project hook', e))
    // The page's drop handler exists only once React has drawn; a file handed over earlier is lost.
    for (let i = 0; i < 100 && main; i++) {
      if (await main.webContents.executeJavaScript(`!!document.querySelector('#root *')`)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    for (const f of pendingFiles.splice(0)) openFile(f).catch((e) => dialog.showErrorBox('ScanRuler', String(e.message ?? e)))
  })
  main.on('closed', () => (main = null))
  main.loadURL(pairingUrl)
}

async function pageProbe() {
  if (!main) return {}
  return main.webContents.executeJavaScript(`(async () => {
    const out = { threads: navigator.hardwareConcurrency, isolated: crossOriginIsolated, webnn: !!navigator.ml, webgpu: 'indisponível' }
    try {
      const a = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))
      if (a) { const i = a.info ?? {}; out.webgpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'disponível' }
    } catch {}
    try {
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
      const x = gl && gl.getExtension('WEBGL_debug_renderer_info')
      out.renderer = gl ? (x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'WebGL2') : 'sem WebGL2'
    } catch {}
    return out
  })()`)
}

function showHardware() {
  const w = new BrowserWindow({
    width: 760,
    height: 520,
    title: 'ScanRuler — Hardware',
    parent: main ?? undefined,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  w.removeMenu()
  w.loadFile(join(here, 'hardware.html'))
}

ipcMain.handle('project:open', (e, path) => {
  if (e.sender !== main?.webContents || !/\.obp$/i.test(String(path))) return
  openFile(path).catch((err) => dialog.showErrorBox('ScanRuler', String(err.message ?? err)))
})
ipcMain.handle('hw:info', async () => {
  const gpu = await app.getGPUInfo('complete').catch(() => ({}))
  const gpus = (gpu.gpuDevice ?? []).map((d) => `${d.deviceString ?? '?'} (vendor 0x${(d.vendorId ?? 0).toString(16)})`)
  angleActive = gpu.auxAttributes?.glImplementationParts ?? gpu.auxAttributes?.glRenderer ?? angleActive
  return {
    gpus,
    backend: settings.backend,
    backendRunning,
    backendLabel: BACKENDS[backendRunning].label,
    backends: Object.fromEntries(Object.entries(BACKENDS).map(([k, v]) => [k, v.label])),
    angleActive,
    cpu: cpus()[0]?.model.trim() ?? '?',
    page: await pageProbe(),
    versions: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
  }
})
ipcMain.handle('hw:set-backend', (_e, backend) => {
  if (backend in BACKENDS) saveSettings(app.getPath('userData'), { ...settings, backend: (settings.backend = backend) })
})
ipcMain.handle('hw:restart', () => {
  app.relaunch()
  app.quit()
})

app.on('second-instance', (_e, argv) => {
  if (main) {
    if (main.isMinimized()) main.restore()
    main.focus()
  }
  const f = fileArg(argv)
  if (f) openFile(f).catch((e) => console.error(e))
})

app.whenReady().then(async () => {
  if (!first) return
  try {
    await startServer()
  } catch (e) {
    dialog.showErrorBox('ScanRuler', String(e.message ?? e))
    app.quit()
    return
  }
  isolate()
  buildMenu()
  createWindow()
  if (settings.crealityDir && existsSync(settings.crealityDir)) watchCreality(settings.crealityDir)
  const f = fileArg(process.argv)
  if (f) pendingFiles.push(f)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  link?.close()
  try {
    unlinkSync(agentFile())
  } catch {}
})
