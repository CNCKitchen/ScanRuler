// SPDX-License-Identifier: AGPL-3.0-only
// Shared plumbing for the e2e scripts. Every script drives the same app in the
// same headless Chrome, loads a scan through the same file input, and reports
// PASS/FAIL the same way — this module holds that machinery once, so each
// script is only its own scenario. Anything a single script does its own way
// (nav's frame sampling, extend's grip hunt, …) stays in that script.
//
// Env, honoured by every script: APP_URL, CHROME (chrome.exe path),
// SHOT_DIR / OUT_DIR (screenshots, default <repo>/e2e-out).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/'
export const CHROME = process.env.CHROME ?? (
  process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' :
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' :
      '/usr/bin/google-chrome'
)

/** The modifier that adds to a selection and carries the editor's shortcuts,
 *  named the way this platform's Chrome wants it pressed: Command on a Mac,
 *  where Ctrl+click is the system's right-click and never reaches a pick. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A file at the repo root, e.g. the default STL fixtures. */
export const repoFile = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url))

// Screenshots land in one gitignored directory instead of scattering over the
// repo root. Created up front so the first page.screenshot cannot fail on it.
export const OUT_DIR = process.env.SHOT_DIR ?? process.env.OUT_DIR ?? repoFile('e2e-out')
mkdirSync(OUT_DIR, { recursive: true })
export const shotPath = (name) => join(OUT_DIR, name)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- pass/fail bookkeeping --------------------------------------------------
// One flag for the whole run; finish() turns it into the exit code. A check
// never throws — the run carries on so one miss does not hide the rest.
let failed = false
export const fail = (what) => {
  console.log(`FAIL: ${what}`)
  failed = true
}
export const check = (ok, what) => (ok ? console.log(`PASS: ${what}`) : fail(what))

// Console noise that is not the app's fault: the missing favicon and the React
// DevTools advert. (Union of the three filters the scripts used to carry.)
const CONSOLE_WHITELIST = /favicon|Download the React DevTools/i

/** Print the console-error summary, close the browser, and set the exit code.
 *  Any console error outside the whitelist fails the run on its own. */
export async function finish(browser, consoleErrors) {
  const real = consoleErrors.filter((e) => !CONSOLE_WHITELIST.test(e))
  console.log('console errors:', real.length ? JSON.stringify(real) : 'none')
  if (real.length) failed = true
  if (failed) {
    try {
      writeFileSync(shotPath('console-errors.json'), JSON.stringify(real, null, 2))
      for (const [index, page] of (await browser.pages()).entries()) {
        if (page.url() === 'about:blank') continue
        await page.screenshot({ path: shotPath(`failure-${index}.png`) })
        writeFileSync(shotPath(`failure-${index}.html`), await page.content())
      }
    } catch (error) { console.error('Could not capture failure diagnostics:', error.message) }
  }
  await browser.close()
  if (failed) process.exitCode = 1
  console.log(failed ? 'FAILED' : 'ALL PASS')
}

// ---- browser and app --------------------------------------------------------

/** Launch Chrome, open the app, and collect console/page errors as they come.
 *  `url` opens it at another address than APP_URL — with a fragment, say;
 *  `headless: false` opens a window on the screen (a real tab, which a
 *  minimised window hides as a person's would); `agentDataOk: false` leaves the
 *  agent connection's warning unanswered.
 *  Returns { browser, page, consoleErrors }. */
export async function launchApp({ width = 1500, height = 950, protocolTimeout, url = APP_URL, headless = 'new', agentDataOk = true } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    args: [`--window-size=${width},${height}`, '--no-sandbox', ...(process.env.CI ? ['--enable-unsafe-swiftshader'] : [])],
    defaultViewport: { width, height },
    ...(protocolTimeout ? { protocolTimeout } : {}),
  })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  // The fixtures are in millimetres, and the units question an STL import
  // puts up would stall every upload waiting on an answer: switched off
  // before the app's first script runs, the way an operator's "Don't ask
  // again" leaves it. A script that wants the question sets the preference
  // back on itself (e2e-import does).
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scanruler.askstlunits', '0') } catch { /* private mode: the question is answered by hand */ }
    // Every workspace still in beta switched on, as Settings would: the
    // checks cover them too.
    try { localStorage.setItem('scanruler.beta', 'all') } catch { /* as above */ }
    // The big support card would take the next click after any export.
    // e2e-support-ask switches it back on in Settings.
    try { localStorage.setItem('scanruler.supportask', '0') } catch { /* as above */ }
  })
  // The agent connection's warning, accepted the way a person would have:
  // every pairing link would stall on it. e2e-agent-warning asks to see it.
  if (agentDataOk) {
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('scanruler.agentdataok', '1') } catch { /* as above */ }
    })
  }
  try {
    await page.goto(url, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.panel')
  } catch (error) {
    fail(`App did not start: ${error.message}`)
    await finish(browser, consoleErrors)
    throw error
  }
  return { browser, page, consoleErrors }
}

/** Die with one clear line if a fixture is missing, instead of letting the
 *  upload time out on a file that was never there. */
export function requireFixture(path) {
  if (!existsSync(path)) {
    console.error(
      `FATAL: fixture not found: ${path}\n` +
        'The test scans are not committed — point STL/SCAN/NOMINAL at a local mesh file.',
    )
    process.exit(1)
  }
}

/** Load a mesh through a file input and wait for a non-zero triangle count. */
export async function loadScan(
  page,
  path,
  { inputSelector = 'input[type=file]', timeout = 120_000, settle = 800 } = {},
) {
  requireFixture(path)
  const input = await page.$(inputSelector)
  await input.uploadFile(path)
  await page.waitForFunction(
    () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
    { timeout },
  )
  console.log('loaded:', await page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ').trim()))
  if (settle) await sleep(settle)
}

/** Client-rect of the main viewport canvas, as { x, y, w, h }. */
export const canvasRect = (page, sel = '.viewport canvas') =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })

/** The middle of the viewport, where the part is to be found: the corner
 *  gizmo and the banner are painted on the same canvas and would otherwise
 *  dominate any reading of where the part is. */
export const stageCrop = (rect) => ({
  x: rect.x + rect.w * 0.05,
  y: rect.y + rect.h * 0.04,
  width: rect.w * 0.86,
  height: rect.h * 0.78,
})

/** Where a point of a sheet `w` × `h` (document units, y up) lands on the
 *  screen while the 2D viewport frames the sheet as it does on opening —
 *  `rect` the viewport canvas's. */
export function sheetToScreen(rect, w, h) {
  const aspect = rect.w / rect.h
  const frustH = Math.max((h / 2) * 1.08, ((w / 2) * 1.08) / aspect)
  return (mx, my) => [
    rect.x + (rect.w * ((mx - w / 2) / (frustH * aspect) + 1)) / 2,
    rect.y + (rect.h * (1 - (my - h / 2) / frustH)) / 2,
  ]
}

// ---- DOM helpers ------------------------------------------------------------

/** Click a selector, waiting for it to exist first. */
export async function click(page, sel, { timeout = 10_000 } = {}) {
  await page.waitForSelector(sel, { timeout })
  await page.click(sel)
}

/** A switch in the menu over a part's key on the view bar (ui/PartKey), by
 *  the key's and the switch's data-test names: the menu opened from the
 *  key's caret, the switch pressed, and the menu let close with the pointer
 *  moved off it — so a picture taken next has no menu in it. The menu stays
 *  in the page while closed, so whether a switch is on can be read without
 *  it: `aria-checked`. */
export async function viewOption(page, key, option) {
  await click(page, `[data-test="${key}-menu"]`)
  await page.waitForSelector(`[data-test="${key}-options"]:not([hidden])`, { timeout: 3000 })
  await click(page, `[data-test="${option}"]`)
  await page.mouse.move(1, 1)
  await page.waitForSelector(`[data-test="${key}-options"][hidden]`, { timeout: 3000 })
}

/** Choose a <select> option by its visible label rather than its value. */
/** A RefPicker (ui/RefPicker.tsx): open it, hover the option with this label
 *  — which is when the viewport shows what it stands for — then take it. */
export async function pickOption(page, sel, label) {
  // The list is the face's test id with "-list": [data-test=x] → [data-test=x-list].
  const listSel = sel.replace(/\]$/, '-list]')
  await click(page, sel)
  await page.waitForSelector(listSel)
  // A string is matched whole, a RegExp (passed as its source) tested.
  const want = typeof label === 'string' ? { exact: label } : { pattern: label.source }
  const handle = await page.evaluateHandle(
    (s, w) =>
      [...document.querySelectorAll(`${s} [data-test=pick-option]`)].find((o) =>
        w.exact !== undefined ? o.textContent.trim() === w.exact : new RegExp(w.pattern).test(o.textContent),
      ) ?? null,
    listSel,
    want,
  )
  const el = handle.asElement()
  if (!el) throw new Error(`option "${label}" not found in ${sel}`)
  await el.hover()
  await sleep(200)
  await el.click()
  await sleep(100)
}

export async function selectByLabel(page, sel, label) {
  const value = await page.$eval(
    sel,
    (el, want) => {
      const opt = [...el.options].find((o) => o.textContent.trim() === want)
      return opt ? opt.value : ''
    },
    label,
  )
  if (!value) throw new Error(`option "${label}" not found in ${sel}`)
  await page.select(sel, value)
}

/** The settings dialog: open it, do something in it, close it again — so the
 *  stage underneath is free for whatever the script does next. */
export async function withSettings(page, fn) {
  await click(page, '[data-test=open-settings]')
  await page.waitForSelector('[data-test=settings-modal]')
  const out = await fn()
  await click(page, '[data-test=settings-close]')
  await page.waitForSelector('[data-test=settings-modal]', { hidden: true })
  return out
}

/** Pick the viewport colour scheme (Settings → Colour mode) by id. */
export const setViewTheme = (page, id) =>
  withSettings(page, () => page.select('[data-test=view-theme]', id))

/** The ids of every colour scheme on offer, in the dialog's order. */
export const viewThemeIds = (page) =>
  withSettings(page, () =>
    page.$$eval('[data-test=view-theme] option', (els) => els.map((e) => e.value)),
  )

/** The element list, one whitespace-collapsed string per row. */
export const rowTexts = (page) =>
  page.$$eval('[data-test="element-row"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  )

/** Drag between two client positions in several steps, so the gesture passes
 *  the click/drag threshold and the per-move maths runs the way it does under
 *  a real hand. */
export async function drag(page, from, to, { button = 'left', steps = 8, stepDelay = 16, settle = 200 } = {}) {
  await page.mouse.move(...from)
  await page.mouse.down({ button })
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    )
    await sleep(stepDelay)
  }
  await page.mouse.up({ button })
  await sleep(settle)
}

// ---- draft / fitting helpers ------------------------------------------------

/** Poll until the draft previews (Create enabled). With watchStatus the wait
 *  gives up early when the draft reports "failed" or "empty" — a click that
 *  missed the mesh entirely, so no fit is coming. */
export async function previewReady(page, { tries = 120, watchStatus = true } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await page.$('[data-test="create-element"]:not([disabled])')) return true
    if (watchStatus) {
      const status = await page.$eval('[data-test="draft-status"]', (e) => e.className)
      if (status.includes('failed') || status.includes('empty')) return false
    }
    await sleep(250)
  }
  return false
}

/** Screen positions to try for a ball of the bar. The part is framed broadside
 *  with world-up on screen, so the ball bar runs along whichever screen axis
 *  its long axis projects onto — sweep inward from the near (or far) end of the
 *  vertical axis first, then the horizontal one. */
export function ballCandidates(rect, { farEnd = false, nears = [0.06, 0.1, 0.14, 0.18, 0.23] } = {}) {
  const out = []
  for (const near of nears) {
    const f = farEnd ? 1 - near : near
    for (const off of [0.5, 0.44, 0.56, 0.38, 0.62]) {
      out.push([rect.x + rect.w * off, rect.y + rect.h * f]) // bar vertical
      out.push([rect.x + rect.w * f, rect.y + rect.h * off]) // bar horizontal
    }
  }
  return out
}

/** One ball of the bar: start a sphere draft, sweep for a point that previews,
 *  create it. `want` is the sphere count that proves this one landed. Returns
 *  the screen position that hit the ball (for later viewport picks), or null.
 *  `ready` lets a script wait its own way for the preview. */
export async function fitBall(page, rect, farEnd, want, { ready } = {}) {
  const isReady = ready ?? (() => previewReady(page))
  for (const [x, y] of ballCandidates(rect, { farEnd })) {
    await click(page, '[data-test="fit-sphere"]')
    await page.mouse.click(x, y)
    await sleep(300)
    if (await isReady()) {
      await click(page, '[data-test="create-element"]')
      await sleep(200)
      if ((await rowTexts(page)).filter((t) => t.includes('Ø')).length >= want) {
        // The kind stays in hand after Create; put it down, as a dimension is
        // not opened over it.
        await click(page, '[data-test="cancel-draft"]').catch(() => {})
        return [x, y]
      }
    }
    await click(page, '[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

/** A number field set the way a person sets one: clicked, cleared, typed and
 *  left; then `settle` ms for the app to take it. Cleared through the input's
 *  own value setter and an input event, as React hears a keystroke: a number
 *  input ignores select() and triple-click, and MOD+A selected nothing under
 *  headless Chrome on macOS, so the figure was typed after what was there
 *  (9.999 then 5 gave 9.995, issue 76). */
export const fieldSetter = (page, { settle = 300 } = {}) => async (sel, value) => {
  await page.click(sel)
  await page.$eval(sel, (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.type(sel, String(value))
  await page.$eval(sel, (el) => el.blur())
  await sleep(settle)
}

/** A field typed into from empty and committed with Enter, as a box's or a
 *  grip's number takes it. */
export const enterTyper = (page) => async (sel, value) => {
  await page.focus(sel)
  await page.$eval(sel, (el) => (el.value = ''))
  await page.type(sel, String(value))
  await page.keyboard.press('Enter')
  await sleep(150)
}

// ---- downloads --------------------------------------------------------------

/** Let the page download into `dir`. The CDP session, for whatever else the
 *  script asks of it. */
export async function downloadsTo(page, dir) {
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
  return cdp
}

/** The name of the first file in `dir` ending in `ext`, looked for every
 *  200 ms for up to 20 s; null when none came. A download still being written
 *  ends in .crdownload, so it is not taken half done. */
export async function awaitDownload(dir, ext) {
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    const f = readdirSync(dir).find((n) => n.endsWith(ext))
    if (f) return f
  }
  return null
}

// ---- the agent server -------------------------------------------------------

/** A port nothing listens on. */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

/** scanruler-mcp started the way an agent's client starts it — `startAgent`
 *  is mcp/tests/client.js's, imported by the script once it has checked the
 *  server's dependencies are there — on a free port, with a token and a
 *  config folder of its own, writing files to OUT_DIR and pairing with the
 *  app at APP_URL. The options, for a second copy on the same port. */
export async function launchAgent(startAgent) {
  const port = await freePort()
  const token = `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  const options = {
    args: ['--port', String(port), '--out', OUT_DIR, '--app', APP_URL],
    env: { SCANRULER_MCP_TOKEN: token, SCANRULER_MCP_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'scanruler-mcp-')) },
  }
  const agent = await startAgent(options)
  return { agent, port, token, options }
}

// ---- pixel measurements -----------------------------------------------------

/** Percentage of pixels that differ between two base64 PNG shots, decoded back
 *  in the page. A channel or three apart is compression / last-bit rounding,
 *  not a repaint, and does not count. */
export const pixelDiff = (page, a, b) =>
  page.evaluate(
    async (x, y) => {
      const load = async (b64) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        return createImageBitmap(new Blob([bin], { type: 'image/png' }))
      }
      const [ia, ib] = await Promise.all([load(x), load(y)])
      const pixels = (img) => {
        const c = new OffscreenCanvas(img.width, img.height)
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height).data
      }
      const pa = pixels(ia)
      const pb = pixels(ib)
      let n = 0
      for (let i = 0; i < pa.length; i += 4) {
        if (
          Math.abs(pa[i] - pb[i]) > 3 ||
          Math.abs(pa[i + 1] - pb[i + 1]) > 3 ||
          Math.abs(pa[i + 2] - pb[i + 2]) > 3
        )
          n++
      }
      return (100 * n) / (pa.length / 4)
    },
    a,
    b,
  )

/** Share of the stage that carries a saturated colour. Read back from a
 *  screenshot rather than from the WebGL canvas directly: without
 *  preserveDrawingBuffer the drawing buffer is already gone by the time script
 *  can copy it, and reads back blank. */
export async function colouredFraction(page) {
  const clip = await page.$eval('.stage', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width - 190, height: r.height }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let painted = 0
    let total = 0
    for (let i = 0; i < data.length; i += 4 * 17) {
      const max = Math.max(data[i], data[i + 1], data[i + 2])
      const min = Math.min(data[i], data[i + 1], data[i + 2])
      total++
      // The stage and both greys are near-neutral; a deviation colour is not.
      if (max - min > 45) painted++
    }
    return painted / total
  }, shot)
}
