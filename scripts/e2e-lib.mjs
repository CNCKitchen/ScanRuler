// SPDX-License-Identifier: AGPL-3.0-only
// Shared plumbing for the e2e scripts. Every script drives the same app in the
// same headless Chrome, loads a scan through the same file input, and reports
// PASS/FAIL the same way — this module holds that machinery once, so each
// script is only its own scenario. Anything a single script does its own way
// (nav's frame sampling, extend's grip hunt, …) stays in that script.
//
// Env, honoured by every script: APP_URL, CHROME (chrome.exe path),
// SHOT_DIR / OUT_DIR (screenshots, default <repo>/e2e-out).
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/'
export const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

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
export const hasFailed = () => failed

// Console noise that is not the app's fault: the missing favicon and the React
// DevTools advert. (Union of the three filters the scripts used to carry.)
const CONSOLE_WHITELIST = /favicon|Download the React DevTools/i

/** Print the console-error summary, close the browser, and set the exit code.
 *  Any console error outside the whitelist fails the run on its own. */
export async function finish(browser, consoleErrors) {
  const real = consoleErrors.filter((e) => !CONSOLE_WHITELIST.test(e))
  console.log('console errors:', real.length ? JSON.stringify(real) : 'none')
  if (real.length) failed = true
  await browser.close()
  if (failed) process.exitCode = 1
  console.log(failed ? 'FAILED' : 'ALL PASS')
}

// ---- browser and app --------------------------------------------------------

/** Launch Chrome, open the app, and collect console/page errors as they come.
 *  Returns { browser, page, consoleErrors }. */
export async function launchApp({ width = 1500, height = 950, protocolTimeout } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [`--window-size=${width},${height}`, '--no-sandbox'],
    defaultViewport: { width, height },
    ...(protocolTimeout ? { protocolTimeout } : {}),
  })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  await page.goto(APP_URL, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.panel')
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

// ---- DOM helpers ------------------------------------------------------------

/** Click a selector, waiting for it to exist first. */
export async function click(page, sel, { timeout = 10_000 } = {}) {
  await page.waitForSelector(sel, { timeout })
  await page.click(sel)
}

/** Choose a <select> option by its visible label rather than its value. */
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
      if ((await rowTexts(page)).filter((t) => t.includes('Ø')).length >= want) return [x, y]
    }
    await click(page, '[data-test="cancel-draft"]').catch(() => {})
  }
  return null
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
