// End-to-end smoke test: drives the real app in headless Chrome — loads
// ballbar.stl through the file input, clicks both spheres in the 3D
// viewport, and checks the measured center distance in the sidebar.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-smoke.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/3DScanEvaluator/'
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
await page.waitForSelector('.sidebar h1')

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

const state = () =>
  page.evaluate(() => ({
    rows: [...document.querySelectorAll('.element-row')].map((e) =>
      e.textContent.replace(/\s+/g, ' ').trim(),
    ),
  }))
const doneCount = async () => (await state()).rows.filter((t) => t.includes('Ø')).length

// The model is auto-framed with its long axis horizontal, so the ball-bar
// spheres sit at the two ends: sweep inward from each end until one fits.
async function sweepEnd(fromLeft, want) {
  for (const fx of [0.05, 0.09, 0.13, 0.17, 0.22]) {
    for (const fy of [0.5, 0.42, 0.58, 0.34, 0.66]) {
      const x = rect.x + rect.w * (fromLeft ? fx : 1 - fx)
      const y = rect.y + rect.h * fy
      await page.mouse.click(x, y)
      await sleep(400)
      for (let i = 0; i < 100; i++) {
        if (!(await state()).rows.some((t) => t.includes('Fitting'))) break
        await sleep(250)
      }
      if ((await doneCount()) >= want) return true
    }
  }
  return false
}

if (!(await sweepEnd(true, 1))) console.log('WARN: left sphere not fitted')
if (!(await sweepEnd(false, 2))) console.log('WARN: right sphere not fitted')

const rows = (await state()).rows
console.log('spheres:', JSON.stringify(rows))
const distances = await page.$$eval('.distance-row .value', (els) =>
  els.map((e) => e.textContent.trim()),
)
console.log('distances:', JSON.stringify(distances))

await page.screenshot({ path: `${SHOT_DIR}/e2e-final.png` })

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')

const m = (distances[0] ?? '').match(/(\d+\.\d+)\s*mm/)
if (!m) {
  console.log('FAIL: no center distance measured')
  process.exitCode = 1
} else {
  const d = parseFloat(m[1])
  const ok = Math.abs(d - 148.64) < 0.05
  console.log(ok ? `PASS: distance ${d} mm` : `FAIL: distance ${d} mm (expected ~148.64)`)
  if (!ok) process.exitCode = 1
}

await browser.close()
