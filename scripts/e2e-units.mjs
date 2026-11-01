// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the display units: with Settings on inches, a Ø40 mm
// cylinder it builds itself reads its diameter in inches — in the element
// row, the dimension's preview and the pin on the part — a nominal typed in
// inches is held in millimetres, and the scan exported as an STL in inches
// has its vertices divided by 25.4. Then back on millimetres the same
// dimension reads 40 mm again: nothing held moved.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-units.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBinarySTL } from 'meshstep'
import {
  awaitDownload,
  canvasRect,
  check,
  click,
  downloadsTo,
  fail,
  finish,
  launchApp,
  loadScan,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
  withSettings,
} from './e2e-lib.mjs'

const R = 20
const IN = 25.4

/** A cylinder of radius `R` standing 40 mm on z = 0, closed at both ends:
 *  rings every 2 mm so the fit rests on a surface. */
function cylinder(segments = 240) {
  const pos = []
  const idx = []
  const rings = []
  for (let z = 0; z <= 40 + 1e-9; z += 2) {
    rings.push(pos.length / 3)
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments
      pos.push(R * Math.cos(a), R * Math.sin(a), z)
    }
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      const a = rings[k]
      const b = rings[k + 1]
      idx.push(a + i, a + j, b + i, b + i, a + j, b + j)
    }
  }
  const cap = (ring, z, up) => {
    pos.push(0, 0, z)
    const c = pos.length / 3 - 1
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      if (up) idx.push(c, ring + i, ring + j)
      else idx.push(c, ring + j, ring + i)
    }
  }
  cap(rings[0], 0, false)
  cap(rings[rings.length - 1], 40, true)
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}

const dir = mkdtempSync(join(tmpdir(), 'scanruler-units-'))
const STL = join(dir, 'cylinder.stl')
writeFileSync(STL, Buffer.from(writeBinarySTL(cylinder())))

const { browser, page, consoleErrors } = await launchApp()

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null)
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
/** The first figure in a text, and whether its lengths are in inches. A
 *  readout sets its unit in an element of its own, upper-cased by the
 *  stylesheet, so the text runs "1.5748IN" — no space, any case. */
const figure = (t) => parseFloat((t ?? '').match(/(-?\d+\.\d+)/)?.[1] ?? 'NaN')
const saysIn = (t) => /\d\s*in\b/i.test(t ?? '')
const saysMm = (t) => /(\d\s*|\b)mm\b/i.test(t ?? '')
const inInches = (t) => saysIn(t) && !saysMm(t)

const setText = async (sel, value) => {
  const el = await page.$(sel)
  if (!el) throw new Error(`no ${sel}`)
  await el.focus()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await el.type(String(value))
  await page.keyboard.press('Enter')
  await sleep(200)
}

// ---- inches, chosen in Settings -----------------------------------------------
await withSettings(page, () => click(page, '[data-test="units-in"]'))
check(
  await page.evaluate(() => localStorage.getItem('scanruler.units') === 'in'),
  'the choice is remembered in this browser',
)

await loadScan(page, STL, { settle: 600 })
const rect = await canvasRect(page)

// ---- a cylinder fitted: its row reads in inches ---------------------------------
let fitted = null
for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.62], [0.5, 0.38], [0.62, 0.5], [0.38, 0.5]]) {
  await click(page, '[data-test="fit-cylinder"]')
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  await sleep(350)
  const ready = await page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 4_000 })
    .then(() => true)
    .catch(() => false)
  if (ready) {
    await click(page, '[data-test="create-element"]')
    await sleep(250)
    await click(page, '[data-test="cancel-draft"]').catch(() => {})
    const rows = await rowTexts(page)
    fitted = rows[rows.length - 1]
    break
  }
  await click(page, '[data-test="cancel-draft"]').catch(() => {})
}
if (!fitted) {
  fail('no cylinder was fitted')
  await finish(browser, consoleErrors)
  process.exit(1)
}
const name = fitted.match(/^(Cylinder \d+)/)?.[1]
const rowDia = figure(fitted.match(/Ø\s*([\d.]+)/)?.[0])
console.log('row:', fitted)
check(Math.abs(rowDia - (2 * R) / IN) < 0.002, `the row reads the diameter in inches (${rowDia} for ${((2 * R) / IN).toFixed(4)})`)
check(!saysMm(fitted), 'and says mm nowhere')

// ---- a diameter dimension: preview and pin in inches, a nominal held in mm --------
await click(page, '[data-test="new-dimension"]')
await page.select('[data-test="dim-type"]', 'size-diameter')
await sleep(150)
await selectByLabel(page, '[data-test="dim-ref-0"]', name)
await sleep(300)
const preview = await text('[data-test="dim-preview"]')
check(inInches(preview), `the preview reads in inches: "${preview}"`)
check(Math.abs(figure(preview) - (2 * R) / IN) < 0.002, `at 40 mm ÷ 25.4 (${figure(preview)})`)
const nominalUnit = await page.$eval('[data-test="dim-nominal"]', (el) => el.parentElement?.querySelector('i')?.textContent ?? '')
check(nominalUnit === 'in', `the nominal field says in (${nominalUnit})`)

await setText('[data-test="dim-nominal"]', 1.575)
await setText('[data-test="dim-plus"]', 0.002)
const verdict = await text('.draftbox [data-test="verdict"]')
check(/nominal 1\.5750 in \+0\.0020 in/.test(verdict ?? ''), `the band reads back in inches: "${verdict}"`)
await click(page, '[data-test="add-dimension"]')
await sleep(300)

const held = await page.evaluate(async () => {
  const { useStore } = await import('/src/state/store.ts')
  const d = useStore.getState().dimensions.at(-1)
  return d?.limit?.kind === 'band' ? { nominal: d.limit.nominal, plus: d.limit.plus } : null
})
check(
  held !== null && Math.abs(held.nominal - 1.575 * IN) < 1e-9 && Math.abs(held.plus - 0.002 * IN) < 1e-9,
  `the store holds millimetres: nominal ${held?.nominal} (1.575 in = ${1.575 * IN}), plus ${held?.plus}`,
)
const pins = await texts('.viewport-label.distance-label')
console.log('pins:', JSON.stringify(pins))
check(pins.length > 0 && pins.every(inInches), 'the pin on the part reads in inches')
await page.screenshot({ path: shotPath('e2e-units-inches.png') })

// ---- the scan as an STL in inches ------------------------------------------------
const downloads = mkdtempSync(join(tmpdir(), 'scanruler-units-stl-'))
await downloadsTo(page, downloads)
await click(page, '[data-test=measure-export]')
await click(page, '[data-test="export-mesh"]')
await click(page, '[data-test="export-mesh-stl-in"]')
const file = await awaitDownload(downloads, '.stl')
if (!file) fail('the STL in inches did not download')
else {
  const buf = readFileSync(join(downloads, file))
  const triangles = buf.readUInt32LE(80)
  let rMax = 0
  let zMax = -Infinity
  for (let t = 0; t < triangles; t++) {
    for (let v = 0; v < 3; v++) {
      const at = 84 + t * 50 + 12 + v * 12
      const x = buf.readFloatLE(at)
      const y = buf.readFloatLE(at + 4)
      rMax = Math.max(rMax, Math.hypot(x, y))
      zMax = Math.max(zMax, buf.readFloatLE(at + 8))
    }
  }
  check(Math.abs(rMax - R / IN) < 1e-4, `its vertices are in inches: radius ${rMax.toFixed(5)} for ${(R / IN).toFixed(5)}`)
  check(Math.abs(zMax - 40 / IN) < 1e-4, `and its height too: ${zMax.toFixed(5)} for ${(40 / IN).toFixed(5)}`)
}

// ---- back on millimetres: the same dimension, as it was ------------------------
await withSettings(page, () => click(page, '[data-test="units-mm"]'))
await sleep(300)
const row = (await texts('[data-test="dimension-row"]'))[0] ?? ''
console.log('dimension row in mm:', row)
check(/40\.0\d\d\s*mm/i.test(row) && !saysIn(row), 'in millimetres the row reads 40 mm again')
const after = await page.evaluate(async () => {
  const { useStore } = await import('/src/state/store.ts')
  const d = useStore.getState().dimensions.at(-1)
  return d?.limit?.kind === 'band' ? d.limit.nominal : null
})
check(after === held?.nominal, `switching the units moved nothing held (nominal ${after} mm)`)

await finish(browser, consoleErrors)
