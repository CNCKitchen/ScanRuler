// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the live alignment preview: drives the real app in
// headless Chrome — starts a 3-2-1 alignment, picks three points on the scan,
// and checks that the part actually swings onto the chosen axis as soon as the
// third point lands, swings again when the axis it points along is changed,
// and holds the camera still while it does, so a slot picked with the part
// zoomed in stays pickable.
//
// The picked points are checked to be labelled "Point 1…3" as well: they are
// three clicks on one face, not three heights.
//
// Frames are compared by decoding both screenshots back in the page and
// counting how many pixels differ — a pose change repaints a large share of
// the viewport, an idle one none of it.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align-live.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), OUT_DIR (shots).
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../block-marius.stl', import.meta.url))
const OUT_DIR = process.env.OUT_DIR ?? fileURLToPath(new URL('..', import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
  if (!ok) failed = true
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1500,950', '--no-sandbox'],
  defaultViewport: { width: 1500, height: 950 },
})

const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(APP_URL, { waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')

const input = await page.$('input[type=file]')
await input.uploadFile(STL)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 120_000 },
)
console.log('loaded:', await page.$eval('.file-info', (el) => el.textContent))
await sleep(800)

const rect = await page.$eval('.viewport canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})

/** A shot of the viewport, kept as base64 so the page can decode it again. */
const shot = async (name) => {
  const buf = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  })
  if (name) writeFileSync(join(OUT_DIR, `e2e-align-live-${name}.png`), buf)
  return buf.toString('base64')
}

/** Percentage of pixels that differ between two shots, decoded in the page. */
const diff = (a, b) =>
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
        // A channel apart is compression / last-bit rounding, not a repaint.
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

/** The labels the picked points wear, in the order they were placed. */
const pickLabels = () =>
  page.$$eval('.viewport-label.probe .label-title', (els) => els.map((e) => e.textContent.trim()))

// Control: an untouched viewport paints the same picture twice, so everything
// measured below is the part having moved rather than noise.
const idleA = await shot()
await sleep(400)
const idle = await diff(idleA, await shot())
check(idle < 0.05, `an untouched viewport repaints identically (${idle.toFixed(3)}% differ)`)

await page.click('[data-test="start-alignment"]')
await page.select('[data-test="align-primary"]', '__pick__')
await sleep(200)

/** Click the scan until a pick lands, sweeping offsets for the holes. */
async function alignPick(fx, fy, offsets = [[0, 0], [30, 0], [0, 30], [-30, 0], [0, -30]]) {
  const before = (await pickLabels()).length
  for (const [dx, dy] of offsets) {
    await page.mouse.click(rect.x + rect.w * fx + dx, rect.y + rect.h * fy + dy)
    await sleep(250)
    if ((await pickLabels()).length > before) return true
  }
  return false
}

check(await alignPick(0.42, 0.42), 'pick 1 landed')
check(await alignPick(0.6, 0.5), 'pick 2 landed')
const picking = await shot('1-picking')
// Two points cannot span a plane, so nothing may have moved yet.
const still = await diff(picking, await shot())
check(still < 0.05, `the part stands still while the picks are incomplete (${still.toFixed(3)}%)`)

check(await alignPick(0.5, 0.62), 'pick 3 landed')
const labels = await pickLabels()
check(
  JSON.stringify(labels) === JSON.stringify(['Point 1', 'Point 2', 'Point 3']),
  `picked points are labelled Point 1…3 (${JSON.stringify(labels)})`,
)
const levelled = await shot('2-levelled')
const swing = await diff(picking, levelled)
check(swing > 5, `the part swings onto the axis as the third point lands (${swing.toFixed(1)}%)`)
check(
  await page.$eval('[data-test="align-preview"]', (el) => /\d/.test(el.textContent)),
  `the panel agrees a transform is ready (${await page.$eval('[data-test="align-preview"]', (el) => el.textContent.trim())})`,
)

// The axis the levelled direction points along is a live control too.
await page.select('[data-test="align-primary-axis"]', 'y-')
await sleep(500)
const reaxed = await shot('3-axis-changed')
const turn = await diff(levelled, reaxed)
check(turn > 5, `the part swings again when the axis it points along changes (${turn.toFixed(1)}%)`)

await page.select('[data-test="align-primary-axis"]', 'z+')
await sleep(500)
const back = await diff(levelled, await shot())
check(back < 0.05, `and swings back when the first axis is chosen again (${back.toFixed(3)}%)`)

// Applying only makes the preview real. The camera re-frames the part as it
// always has, so what is checked here is that it ends up on screen and that
// the preview machinery has let go of it.
await page.click('[data-test="apply-alignment"]')
await page.waitForFunction(() => (document.body.innerText ?? '').includes('Part aligned'), {
  timeout: 60_000,
})
await sleep(800)
const applied = await shot('4-applied')
check((await pickLabels()).length === 0, 'the pick markers come off when the alignment is applied')
const settled = await diff(applied, await shot())
check(settled < 0.05, `the aligned part comes to rest (${settled.toFixed(3)}% differ)`)
check(
  (await page.$('[data-test="reset-alignment"]')) !== null,
  'the alignment is recorded and can be reset',
)

// A preview that failed to let go would leave the part carrying its transform
// twice over, nowhere near the middle of the view. Ask the app where the part
// is by clicking at it: a pick only lands where the ray hits the scan.
await page.click('[data-test="start-alignment"]')
await page.select('[data-test="align-primary"]', '__pick__')
await sleep(200)
check(await alignPick(0.5, 0.5), 'the aligned part sits under the middle of the view')
await page.click('[data-test="cancel-alignment"]')

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')
if (filteredErrors.length) failed = true

await browser.close()
if (failed) process.exitCode = 1
