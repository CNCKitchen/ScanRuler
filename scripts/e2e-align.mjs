// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for datum alignment + STEP export: drives the real app in
// headless Chrome — loads ballbar.stl, fits both spheres, constructs the line
// through their centers, aligns that line onto +Z with Sphere 1 as the
// origin, then exports the elements as STEP and checks the file: Sphere 1's
// center must land on the origin and Sphere 2's on the Z axis at the known
// ball-bar length, which proves the alignment moved the elements and the
// export writes them faithfully. Finishes by resetting the alignment.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), OUT_DIR.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../ballbar.stl', import.meta.url))
const OUT_DIR = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), 'scanruler-step-'))

const BAR_LENGTH = 148.64 // GOM reference center distance of the ball bar

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

const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT_DIR })

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

const rowTexts = () =>
  page.$$eval('[data-test="element-row"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  )
const click = async (sel) => {
  await page.waitForSelector(sel, { timeout: 10_000 })
  await page.click(sel)
}
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
const previewReady = async () => {
  for (let i = 0; i < 120; i++) {
    if (await page.$('[data-test="create-element"]:not([disabled])')) return true
    const status = await page.$eval('[data-test="draft-status"]', (e) => e.className)
    if (status.includes('failed') || status.includes('empty')) return false
    await sleep(250)
  }
  return false
}

// Sweep inward from both ends along both screen axes until a click previews a
// sphere (same tactic as e2e-smoke.mjs).
function candidates(farEnd) {
  const out = []
  for (const near of [0.06, 0.1, 0.14, 0.18, 0.23]) {
    const f = farEnd ? 1 - near : near
    for (const off of [0.5, 0.44, 0.56, 0.38, 0.62]) {
      out.push([rect.x + rect.w * off, rect.y + rect.h * f])
      out.push([rect.x + rect.w * f, rect.y + rect.h * off])
    }
  }
  return out
}
async function fitBall(farEnd, want) {
  for (const [x, y] of candidates(farEnd)) {
    await click('[data-test="fit-sphere"]')
    await page.mouse.click(x, y)
    await sleep(300)
    if (await previewReady()) {
      await click('[data-test="create-element"]')
      await sleep(200)
      if ((await rowTexts()).filter((t) => t.includes('Ø')).length >= want) return [x, y]
    }
    await click('[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

const posA = await fitBall(false, 1)
const posB = await fitBall(true, 2)
check(Boolean(posA), 'Sphere 1 fitted')
check(Boolean(posB), 'Sphere 2 fitted')

// Line through the two sphere centers — the datum the bar is aligned by.
await click('[data-test="fit-line"]')
await selectByLabel('[data-test="draft-ref-0"]', 'Sphere 1')
await selectByLabel('[data-test="draft-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 10_000 })
await click('[data-test="create-element"]')
await sleep(200)
console.log('elements:', JSON.stringify(await rowTexts()))

// Align: Line 1 → +Z, origin at Sphere 1's center.
await click('[data-test="start-alignment"]')
await selectByLabel('[data-test="align-primary"]', 'Line 1')
await selectByLabel('[data-test="align-origin"]', 'Sphere 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await click('[data-test="apply-alignment"]')
await page.waitForFunction(
  () => (document.body.innerText ?? '').includes('Part aligned'),
  { timeout: 60_000 },
)
console.log('aligned')
await sleep(300)

// Export the elements and read the STEP file back.
await click('[data-test="export-step"]')
let stepFile = null
for (let i = 0; i < 100 && !stepFile; i++) {
  await sleep(200)
  stepFile = readdirSync(OUT_DIR).find((f) => f.endsWith('.step'))
}
check(Boolean(stepFile), `STEP file downloaded (${stepFile ?? 'missing'})`)

if (stepFile) {
  const text = readFileSync(join(OUT_DIR, stepFile), 'utf8')
  const entity = (id) => text.match(new RegExp(`^#${id}=(.*);$`, 'm'))?.[1]
  /** Placement origin of the surface behind a named trimmed surface. */
  const centerOf = (name) => {
    const surfId = text.match(new RegExp(`RECTANGULAR_TRIMMED_SURFACE\\('${name}',#(\\d+)`))?.[1]
    const plId = entity(surfId)?.match(/#(\d+)/)?.[1]
    const ptId = entity(plId)?.match(/#(\d+)/)?.[1]
    const coords = entity(ptId)?.match(/\(([^()]*)\)/)?.[1]
    return coords?.split(',').map(Number)
  }
  const s1 = centerOf('Sphere 1')
  const s2 = centerOf('Sphere 2')
  console.log('sphere centers in STEP:', JSON.stringify({ s1, s2 }))
  check(s1 && Math.hypot(...s1) < 0.001, 'Sphere 1 center at the origin after alignment')
  check(
    s2 && Math.hypot(s2[0], s2[1]) < 0.001,
    'Sphere 2 center on the Z axis after alignment',
  )
  check(
    s2 && Math.abs(Math.abs(s2[2]) - BAR_LENGTH) < 0.05,
    `Sphere 2 at the bar length along Z (${s2 ? s2[2].toFixed(4) : '—'} mm)`,
  )
  check(text.includes("SI_UNIT(.MILLI.,.METRE.)"), 'STEP declares millimetres')
}

// Reset puts the part back where the scanner delivered it.
await click('[data-test="reset-alignment"]')
await page.waitForFunction(
  () => (document.body.innerText ?? '').includes('Alignment reset'),
  { timeout: 60_000 },
)
check(true, 'alignment reset')
await sleep(300)

// Second pass, mix and match: level with 3 points picked straight on the
// scan, zero on the existing Sphere 1 element.
const primaryState = () =>
  page.$eval('[data-test="align-primary"]', (el) => el.selectedOptions[0]?.textContent ?? '')
/** Click the scan for an alignment pick, sweeping offsets until it lands. */
async function alignPick([x, y], offsets = [[0, 0]]) {
  const before = await primaryState()
  for (const [dx, dy] of offsets) {
    await page.mouse.click(x + dx, y + dy)
    await sleep(250)
    if ((await primaryState()) !== before) return true
  }
  return false
}
await click('[data-test="start-alignment"]')
await page.select('[data-test="align-primary"]', '__pick__')
await sleep(150)
check(await alignPick(posA), 'pick 1 of 3 landed')
check(await alignPick(posB), 'pick 2 of 3 landed')
// The third point elsewhere on ball A's surface — millimetres off the first
// pick is plenty against the 148 mm baseline, and the ball is scanned solid
// where the thin rod may have holes.
check(
  await alignPick(posA, [[28, 0], [0, 28], [-28, 0], [0, -28], [20, 20], [-20, 20]]),
  'pick 3 of 3 landed',
)
check((await primaryState()).includes('3 picked points'), `level slot filled (${await primaryState()})`)
await selectByLabel('[data-test="align-origin"]', 'Sphere 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await click('[data-test="apply-alignment"]')
await page.waitForFunction(
  () => (document.body.innerText ?? '').includes('Part aligned'),
  { timeout: 60_000 },
)
check(true, 'picked-point alignment applied')
await sleep(300)

// Manual move / rotate: nudge the part 5 mm in X and 90° about Z.
await click('[data-test="start-manual"]')
await page.type('[data-test="manual-mx"]', '5')
await page.type('[data-test="manual-rz"]', '90')
await page.waitForSelector('[data-test="apply-manual"]:not([disabled])', { timeout: 5_000 })
await click('[data-test="apply-manual"]')
await page.waitForFunction(
  () => (document.body.innerText ?? '').includes('Part moved'),
  { timeout: 60_000 },
)
check(true, 'manual move / rotate applied')

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')
if (filteredErrors.length) failed = true

await browser.close()
if (failed) process.exitCode = 1
