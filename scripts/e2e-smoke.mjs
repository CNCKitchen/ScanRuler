// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test: drives the real app in headless Chrome — loads
// ballbar.stl through the file input, runs the Sphere pick-preview-create flow
// on both balls, creates a Point–Point dimension between them through the
// dimension editor, and checks the measured center distance in the sidebar.
// (The scan has no cylindrical or flat feature to exercise the other element
// types against; those are covered by the unit tests.)
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-smoke.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../ballbar.stl', import.meta.url))
const SHOT_DIR = process.env.SHOT_DIR ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// Load the scan through the real file input and wait for a non-zero
// triangle count.
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

const rowTexts = () =>
  page.$$eval('[data-test="element-row"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  )
const doneCount = async () => (await rowTexts()).filter((t) => t.includes('Ø')).length

const click = async (sel) => {
  await page.waitForSelector(sel, { timeout: 10_000 })
  await page.click(sel)
}
const draftStatus = () => page.$eval('[data-test="draft-status"]', (e) => e.className)
const previewReady = async () => {
  for (let i = 0; i < 120; i++) {
    if (await page.$('[data-test="create-element"]:not([disabled])')) return true
    const status = await draftStatus()
    // "empty" means the click missed the mesh entirely — no fit is coming.
    if (status.includes('failed') || status.includes('empty')) return false
    await sleep(250)
  }
  return false
}

// The part is framed broadside with world-up on screen, so the ball bar runs
// along whichever screen axis its long axis projects onto. Sweep inward from
// both ends of the vertical axis first, then the horizontal one.
function candidates(farEnd) {
  const out = []
  for (const near of [0.06, 0.1, 0.14, 0.18, 0.23]) {
    const f = farEnd ? 1 - near : near
    for (const off of [0.5, 0.44, 0.56, 0.38, 0.62]) {
      out.push([rect.x + rect.w * off, rect.y + rect.h * f]) // bar vertical
      out.push([rect.x + rect.w * f, rect.y + rect.h * off]) // bar horizontal
    }
  }
  return out
}

// One ball: start a draft, sweep for a point that previews a sphere, create
// it. Returns the screen position that hit the ball, for the viewport-pick
// dimension flow below.
async function fitBall(farEnd, want) {
  for (const [x, y] of candidates(farEnd)) {
    await click('[data-test="fit-sphere"]')
    await page.mouse.click(x, y)
    await sleep(300)
    if (await previewReady()) {
      await click('[data-test="create-element"]')
      await sleep(200)
      if ((await doneCount()) >= want) return [x, y]
    }
    await click('[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

const posA = await fitBall(false, 1)
const posB = await fitBall(true, 2)
if (!posA) console.log('WARN: first sphere not fitted')
if (!posB) console.log('WARN: second sphere not fitted')

const rows = await rowTexts()
console.log('spheres:', JSON.stringify(rows))

// Create the dimension: New dimension → Point–Point → Sphere 1 → Sphere 2.
const selectByLabel = async (sel, label) => {
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
await click('[data-test="new-dimension"]')
await selectByLabel('[data-test="dim-ref-0"]', 'Sphere 1')
await selectByLabel('[data-test="dim-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="add-dimension"]:not([disabled])', { timeout: 10_000 })
await click('[data-test="add-dimension"]')
await sleep(200)

// Second dimension straight from the viewport: with the editor open, clicking
// the two balls should fill both slots (and highlight the picked elements).
let viewportDim = false
if (posA && posB) {
  await click('[data-test="new-dimension"]')
  await page.mouse.click(...posA)
  await sleep(150)
  await page.mouse.click(...posB)
  viewportDim = await page
    .waitForSelector('[data-test="add-dimension"]:not([disabled])', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (viewportDim) {
    // Commit through the keyboard path rather than the button.
    await page.keyboard.press('Enter')
    viewportDim = await page
      .waitForFunction(
        () => document.querySelectorAll('[data-test="dimension-row"]').length >= 2,
        { timeout: 5_000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!viewportDim) console.log('WARN: Enter did not commit the dimension')
  } else {
    console.log('WARN: viewport picks did not fill the dimension slots')
    await click('[data-test="cancel-dimension"]').catch(() => {})
  }
}

// The DRO window splits digits from the unit legend — rejoin them.
const distances = await page.$$eval('[data-test="dimension-value"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
)
console.log('distances:', JSON.stringify(distances))

await page.screenshot({ path: `${SHOT_DIR}/e2e-final.png` })

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')

const expectCount = viewportDim ? 2 : 1
for (let i = 0; i < expectCount; i++) {
  const m = (distances[i] ?? '').match(/(\d+\.\d+)\s*mm/i)
  const via = i === 0 ? 'dropdowns' : 'viewport picks'
  if (!m) {
    console.log(`FAIL: no center distance measured (${via})`)
    process.exitCode = 1
    continue
  }
  const d = parseFloat(m[1])
  const ok = Math.abs(d - 148.64) < 0.05
  console.log(ok ? `PASS: distance ${d} mm (${via})` : `FAIL: distance ${d} mm (${via}, expected ~148.64)`)
  if (!ok) process.exitCode = 1
}
if (!viewportDim) {
  console.log('FAIL: dimension via viewport picks was not created')
  process.exitCode = 1
}

await browser.close()
