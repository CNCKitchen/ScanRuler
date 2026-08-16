// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of extending an element past the surface it was measured on:
// fits a plane on the block, types millimetres into the four side fields,
// squares the patch, resets it, then finds a grip in the viewport by the
// cursor it puts up and drags it — checking all the way through that the
// measurement underneath never moves.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-extend.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { importStep, writeBinarySTL } from 'meshstep'
import { cylinderStep } from '../tests/stepFixtures.ts'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../block-marius.stl', import.meta.url))

/** The second half of the test needs a cylinder big enough to aim at, so it
 *  builds its own: a Ø40 × 40 mm bar, tessellated finely out of the same
 *  B-rep the export writes, and saved as the scan. Its size is known before
 *  the app starts, which is what makes the numbers below assertions rather
 *  than observations. */
const ROD_R = 20
const ROD_H = 40
const dir = mkdtempSync(join(tmpdir(), 'scanruler-extend-'))
const ROD = join(dir, 'rod.stl')
writeFileSync(
  ROD,
  Buffer.from(
    writeBinarySTL(importStep(cylinderStep(ROD_R, ROD_H), { surfaceDeviation: 0.02, maxEdge: 2 }).mesh),
  ),
)
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
const saveEnabled = (timeout = 30_000) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
/** The drawn size beside the Extend legend, as [width, height] in mm. */
const drawnSize = async () => {
  const t = await page.$eval('[data-test="extend-size"]', (e) => e.textContent)
  return [...t.matchAll(/[\d.]+/g)].map((m) => parseFloat(m[0]))
}
/** The measured patch, off the note under the preview — the measurement, which
 *  nothing here may change. */
const measuredPatch = async (sel = '.draftbox .dro-note') => {
  const t = await page.$eval(sel, (e) => e.textContent)
  return [...t.matchAll(/([\d.]+) × ([\d.]+) mm/g)].flatMap((m) => [
    parseFloat(m[1]),
    parseFloat(m[2]),
  ])
}
const setField = async (side, value) => {
  const sel = `[data-test="extend-${side}"]`
  await page.$eval(sel, (e) => {
    e.value = ''
  })
  await page.type(sel, String(value))
  await page.$eval(sel, (e) => e.blur())
  await sleep(150)
}
const fieldValues = () =>
  page.$$eval('[data-test^="extend-"] input, input[data-test^="extend-"]', (els) =>
    els.map((e) => parseFloat(e.value)),
  )

// ---- fit a plane on the block ---------------------------------------------

async function fitPlane() {
  const spots = [
    [0.5, 0.5],
    [0.42, 0.42],
    [0.58, 0.58],
    [0.5, 0.35],
    [0.35, 0.5],
    [0.62, 0.42],
  ]
  for (const [fx, fy] of spots) {
    await click('[data-test="fit-plane"]')
    await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
    await sleep(350)
    if (await saveEnabled(4_000)) return [rect.x + rect.w * fx, rect.y + rect.h * fy]
    await click('[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

const at = await fitPlane()
if (!at) {
  fail('no plane could be fitted on the scan')
  await browser.close()
  process.exit(1)
}
const measured = await measuredPatch()
const drawn0 = await drawnSize()
console.log('measured patch:', measured, 'drawn:', drawn0)
check(
  Math.abs(measured[0] - drawn0[0]) < 0.02 && Math.abs(measured[1] - drawn0[1]) < 0.02,
  'an untouched element is drawn at exactly its measured size',
)
const fields = await fieldValues()
check(fields.length === 4, `a plane offers one field per edge (${fields.length})`)
check(
  fields.every((v) => v === 0),
  'every side starts at nothing',
)

// ---- type millimetres into a side ------------------------------------------

await setField('uMax', 10)
const drawn1 = await drawnSize()
check(
  Math.abs(drawn1[0] - (drawn0[0] + 10)) < 0.02 && Math.abs(drawn1[1] - drawn0[1]) < 0.02,
  `+U 10 mm grows the patch along U alone (${drawn0} → ${drawn1})`,
)
const stillMeasured = await measuredPatch()
check(
  Math.abs(stillMeasured[0] - measured[0]) < 1e-9,
  'the measured patch under it is untouched',
)

// ---- square it, then put it back -------------------------------------------

await click('[data-test="extend-square"]')
await sleep(150)
const squared = await drawnSize()
check(Math.abs(squared[0] - squared[1]) < 0.02, `Make square squares the patch (${squared})`)
check(
  squared[0] >= drawn1[0] - 0.02 && squared[1] >= drawn1[1] - 0.02,
  'squaring only ever grows the patch',
)

await click('[data-test="extend-reset"]')
await sleep(150)
const reset = await drawnSize()
check(
  Math.abs(reset[0] - drawn0[0]) < 0.02 && Math.abs(reset[1] - drawn0[1]) < 0.02,
  'Reset puts it back on the measured surface',
)

// ---- find a grip in the viewport and drag it -------------------------------

const cursor = () => page.$eval('.viewport canvas', (e) => e.style.cursor)

/** Hunt for a grip by the cursor it puts up, in a box around the fitted spot. */
async function findGrip() {
  for (let r = 30; r <= 430; r += 25) {
    for (let a = 0; a < 360; a += 10) {
      const x = at[0] + r * Math.cos((a * Math.PI) / 180)
      const y = at[1] + r * Math.sin((a * Math.PI) / 180)
      if (x < rect.x + 4 || x > rect.x + rect.w - 4) continue
      if (y < rect.y + 4 || y > rect.y + rect.h - 4) continue
      await page.mouse.move(x, y)
      await sleep(28)
      if ((await cursor()) === 'grab') return [x, y]
    }
  }
  return null
}

const grip = await findGrip()
check(grip !== null, grip ? `a grip lights up under the cursor at ${grip.map(Math.round)}` : 'no grip was found in the viewport')

if (grip) {
  let moved = null
  for (const [dx, dy] of [
    [70, 0],
    [0, 70],
  ]) {
    await page.mouse.move(grip[0], grip[1])
    await sleep(60)
    await page.mouse.down()
    await sleep(40)
    for (let i = 1; i <= 7; i++) {
      await page.mouse.move(grip[0] + (dx * i) / 7, grip[1] + (dy * i) / 7)
      await sleep(30)
    }
    await page.mouse.up()
    await sleep(150)
    const after = await fieldValues()
    if (after.some((v) => Math.abs(v) > 0.05)) {
      moved = after
      break
    }
  }
  check(moved !== null, moved ? `dragging the grip typed itself into the fields: ${moved}` : 'dragging the grip changed nothing')
  const dragged = await drawnSize()
  check(
    Math.abs(dragged[0] - drawn0[0]) > 0.05 || Math.abs(dragged[1] - drawn0[1]) > 0.05,
    `the patch on screen followed the grip (${drawn0} → ${dragged})`,
  )
  const measuredAfterDrag = await measuredPatch()
  check(
    Math.abs(measuredAfterDrag[0] - measured[0]) < 1e-9 &&
      Math.abs(measuredAfterDrag[1] - measured[1]) < 1e-9,
    'and the measurement still says what it always said',
  )
}

// ---- keep it, and get it back ----------------------------------------------

const beforeSave = await fieldValues()
await page.screenshot({ path: `${SHOT_DIR}/e2e-extend-grips.png` })
await click('[data-test="create-element"]')
await sleep(400)
await page.screenshot({ path: `${SHOT_DIR}/e2e-extend.png` })

await click('[data-test="edit-element"]')
await sleep(500)
await page.waitForSelector('[data-test="extend-uMin"]', { timeout: 10_000 })
const reopened = await fieldValues()
check(
  reopened.every((v, i) => Math.abs(v - beforeSave[i]) < 1e-6),
  `re-opening brings the extension back: ${reopened}`,
)
// The saved element re-fits from its seeds on the way back in, and says the
// same thing about the surface it was measured on as it did the first time.
const measuredAgain = await measuredPatch()
check(
  Math.abs(measuredAgain[0] - measured[0]) < 1e-9 && Math.abs(measuredAgain[1] - measured[1]) < 1e-9,
  `the saved element goes on reporting the patch it was measured on (${measuredAgain})`,
)
await click('[data-test="cancel-draft"]')

// ---- the other shape: a cylinder, which grows out of its two ends ----------
//
// Its grips are arrows on the axis rather than bars along an edge — a
// different shape to hit and a different line to drag along.

await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')
await (await page.$('input[type=file]')).uploadFile(ROD)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 120_000 },
)
await sleep(800)

async function fitCylinder() {
  for (const fy of [0.5, 0.46, 0.54, 0.42, 0.58]) {
    for (const fx of [0.5, 0.42, 0.58, 0.35, 0.65]) {
      await click('[data-test="fit-cylinder"]')
      await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
      await sleep(350)
      if (await saveEnabled(5_000)) return [rect.x + rect.w * fx, rect.y + rect.h * fy]
      await click('[data-test="cancel-draft"]').catch(() => {})
    }
  }
  return null
}

const onRod = await fitCylinder()
check(onRod !== null, onRod ? 'a cylinder was fitted on the rod' : 'no cylinder could be fitted')

if (onRod) {
  const lengthOf = async () => (await drawnSize())[0]
  const rodFields = await fieldValues()
  check(rodFields.length === 2, `a cylinder offers one field per end (${rodFields.length})`)
  const length0 = await lengthOf()
  check(
    Math.abs(length0 - ROD_H) < 1.5,
    `it is drawn at the length it was measured on (${length0} of ${ROD_H} mm)`,
  )

  await setField('start', 12)
  const length1 = await lengthOf()
  check(
    Math.abs(length1 - (length0 + 12)) < 0.02,
    `12 mm off the start makes it 12 mm longer (${length0} → ${length1})`,
  )
  await setField('start', -1e6)
  const clamped = await lengthOf()
  check(clamped > 0 && clamped < 0.01, `shrinking past the end stops at nothing (${clamped} mm)`)
  await click('[data-test="extend-reset"]')
  await sleep(150)
  check(Math.abs((await lengthOf()) - length0) < 0.02, 'Reset gives the measured length back')

  at[0] = onRod[0]
  at[1] = onRod[1]
  const endGrip = await findGrip()
  check(endGrip !== null, endGrip ? `an end grip lights up at ${endGrip.map(Math.round)}` : 'no grip on the cylinder')
  if (endGrip) {
    let pulled = null
    for (const [dx, dy] of [
      [80, 0],
      [0, 80],
    ]) {
      await page.mouse.move(endGrip[0], endGrip[1])
      await sleep(60)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(endGrip[0] + (dx * i) / 8, endGrip[1] + (dy * i) / 8)
        await sleep(30)
      }
      await page.mouse.up()
      await sleep(150)
      const after = await fieldValues()
      if (after.some((v) => Math.abs(v) > 0.05)) {
        pulled = after
        break
      }
    }
    check(pulled !== null, pulled ? `dragging an end typed itself into the fields: ${pulled}` : 'dragging the end grip changed nothing')
    check(Math.abs((await lengthOf()) - length0) > 0.05, 'and the rod on screen grew with it')
    await page.screenshot({ path: `${SHOT_DIR}/e2e-extend-cylinder.png` })
  }
}

check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`)
await browser.close()
console.log(process.exitCode ? 'FAILED' : 'ALL PASS')
