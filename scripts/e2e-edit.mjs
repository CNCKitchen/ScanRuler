// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of editing what has already been created: fits both balls of
// ballbar.stl, measures between them, then re-opens the sphere (checking that
// it comes back with its seeds and re-fits to the same geometry), renames it,
// and re-opens the dimension to switch it from centre-to-centre to outer span.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-edit.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../ballbar.stl', import.meta.url))
const SHOT_DIR = process.env.SHOT_DIR ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (msg) => {
  console.log(`FAIL: ${msg}`)
  process.exitCode = 1
}
const check = (ok, msg) => (ok ? console.log(`PASS: ${msg}`) : fail(msg))

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

const click = async (sel) => {
  await page.waitForSelector(sel, { timeout: 10_000 })
  await page.click(sel)
}
const clickNth = async (sel, n) => {
  const els = await page.$$(sel)
  if (!els[n]) throw new Error(`no ${sel}[${n}]`)
  await els[n].click()
}
const texts = (sel) =>
  page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
const rowTexts = () => texts('[data-test="element-row"]')
const doneCount = async () => (await rowTexts()).filter((t) => t.includes('Ø')).length
const saveEnabled = (timeout = 30_000) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
/** The measured value of dimension n, digits and unit rejoined. */
const dimValue = async (n) => {
  const all = await texts('[data-test="dimension-value"]')
  const m = (all[n] ?? '').match(/(\d+\.\d+)\s*mm/i)
  return m ? parseFloat(m[1]) : NaN
}

// ---- set the scene: two spheres and a centre distance between them ---------

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
    if (await saveEnabled(3_000)) {
      await click('[data-test="create-element"]')
      await sleep(200)
      if ((await doneCount()) >= want) return [x, y]
    }
    await click('[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

if (!(await fitBall(false, 1))) fail('first sphere not fitted')
if (!(await fitBall(true, 2))) fail('second sphere not fitted')
console.log('spheres:', JSON.stringify(await rowTexts()))

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
await click('[data-test="add-dimension"]')
await sleep(200)
const before = await dimValue(0)
console.log('centre distance:', before)
check(Math.abs(before - 148.64) < 0.05, `centre distance ${before} mm`)

// ---- re-open the sphere ----------------------------------------------------

const diameterOf = async (n) => {
  const m = (await rowTexts())[n].match(/([\d.]+)\s*mm/)
  return m ? parseFloat(m[1]) : NaN
}
const diameterBefore = await diameterOf(0)

await clickNth('[data-test="edit-element"]', 0)
const heading = await page.$eval('.draftbox .sec-head', (e) => e.textContent.trim())
check(heading === 'Edit Sphere 1', `editor opened on the element: "${heading}"`)
const nameValue = await page.$eval('[data-test="draft-name"]', (e) => e.value)
check(nameValue === 'Sphere 1', `name field carries the element's name: "${nameValue}"`)
// The seeds came back with it and re-fitted on their own — nothing was clicked.
check(await saveEnabled(), 'the re-opened fit previews from its stored seeds')
const editedCount = (await rowTexts()).length
check(editedCount === 2, `no element was added while editing (${editedCount} rows)`)

await page.$eval('[data-test="draft-name"]', (e) => {
  e.value = ''
})
await page.type('[data-test="draft-name"]', 'Ball A')
await click('[data-test="create-element"]')
await sleep(400)

const rowsAfter = await rowTexts()
console.log('after save:', JSON.stringify(rowsAfter))
check(rowsAfter.length === 2, `still two elements after saving (${rowsAfter.length})`)
check(rowsAfter[0].includes('Ball A'), 'the element was renamed in place')
const diameterAfter = await diameterOf(0)
check(
  Math.abs(diameterAfter - diameterBefore) < 1e-6,
  `re-fitting the same seeds gives the same sphere (Ø ${diameterBefore} → ${diameterAfter} mm)`,
)
const title = (await texts('[data-test="dimension-row"]'))[0]
check(title.includes('Ball A'), 'the dimension follows the new name')
const afterRename = await dimValue(0)
check(
  Math.abs(afterRename - before) < 1e-6,
  `the dimension still measures the same (${afterRename} mm)`,
)

// ---- re-open the dimension -------------------------------------------------

await clickNth('[data-test="edit-dimension"]', 0)
const dimHeading = await page.$eval('.dimbox .sec-head', (e) => e.textContent.trim())
check(dimHeading === 'Edit Distance 1', `dimension editor opened on the row: "${dimHeading}"`)
const refs = await page.$$eval('[data-test^="dim-ref-"]', (els) =>
  els.map((e) => e.selectedOptions[0]?.textContent.trim()),
)
check(
  refs.join(' → ') === 'Ball A → Sphere 2',
  `it re-opens with its references: ${refs.join(' → ')}`,
)
await selectByLabel('[data-test="dim-anchor"]', 'Outer span (+ radii)')
await click('[data-test="add-dimension"]')
await sleep(300)

const rows = await texts('[data-test="dimension-row"]')
check(rows.length === 1, `the dimension was replaced, not added (${rows.length} rows)`)
const span = await dimValue(0)
// Outer span = centre distance + both radii; the balls are Ø ~15.92 mm.
const expected = before + diameterAfter
check(Math.abs(span - expected) < 0.02, `outer span ${span} mm (centre distance + Ø = ${expected})`)
check(rows[0].includes('Distance 1'), 'the name survives a change that stays a distance')

await page.screenshot({ path: `${SHOT_DIR}/e2e-edit.png` })

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')
if (filteredErrors.length) fail('console errors during the run')

await browser.close()
