// SPDX-License-Identifier: AGPL-3.0-only
import { dismissSupportCard } from './e2e-lib.mjs'
// End-to-end test of a section's shadow: on a generated block notched top,
// front and bottom — the label printer of issue 13 — a shadow across the XY
// plane is the block's whole 40 × 30 mm outline, where every cut through a
// notch is less. The box reads its loops and area and the band it lies in
// outside the part, the play widens it, the row says it is a shadow, the 2D
// sheet takes it as a source, and the DXF writes the outline as lines and
// arcs rather than a polyline. Extruded, it stands through the part as a
// block, and the STEP export writes that block as a solid: four planes and
// four cylinders round it, a face at each end.
//
// Prereqs: dev server running (npm run dev -- --port 5187), Chrome installed.
//   APP_URL=http://localhost:5187/ node scripts/e2e-section-shadow.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitDownload, check, click, downloadsTo, finish, launchApp, loadScan, selectByLabel, shotPath, sleep } from './e2e-lib.mjs'
import { notchedBlockScan } from './e2e-fixtures.mjs'

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, notchedBlockScan())

const readout = () => page.$eval('[data-test="section-status"]', (e) => e.textContent.replace(/\s+/g, ' ').trim())
const band = () => page.$eval('[data-test="section-band"]', (e) => e.textContent.trim()).catch(() => '')
/** The area the readout gives, mm². */
const areaOf = (text) => Number((text.match(/([\d,]+) mm²/) ?? [])[1]?.replace(/,/g, '') ?? NaN)
const settled = (want) =>
  page.waitForFunction(
    (w) => new RegExp(w).test(document.querySelector('[data-test="section-status"]')?.textContent ?? ''),
    { timeout: 30_000 },
    want,
  )

// ---- a cut first, for the area a cut through the notches has -----------------
await click(page, '[data-test="fit-section"]')
await selectByLabel(page, '[data-test="section-ref"]', 'XY plane')
await settled('edge chain')
const cutPoints = await page.$eval('[data-test="section-points"]', (e) => e.textContent)
console.log(`cut through the middle: ${await readout()} (${cutPoints})`)

// ---- the shadow --------------------------------------------------------------
await click(page, '[data-test="section-kind-shadow"]')
check(
  (await page.$eval('[data-test="section-ref"]', (el) => el.previousElementSibling?.textContent)) === 'Project onto',
  'a shadow is projected onto the plane rather than cut along it',
)
// What a shadow starts with: a millimetre of play, read to a tenth, corners
// under 30° rounded, stood up as a block.
const value = (sel) => page.$eval(sel, (el) => el.value).catch(() => '')
check((await value('[data-test="section-play"]')) === '1', 'a shadow starts with a millimetre of play')
check(Number((await value('[data-test="section-tolerance"]')).replace(',', '.')) === 0.1, 'read to a tolerance of 0.1 mm')
check((await value('[data-test="section-smooth"]')) === '30', 'rounding the corners turning under 30°')
check(await page.$eval('[data-test="section-extrude"]', (el) => el.checked), 'and extruded')
await settled('loop')
check(/^1\.\d\d to 1\.\d\d mm outside the part/.test(await band()), `the default play puts it a millimetre out (${await band()})`)

/** Type a play and wait for the band to start at it. */
const setPlay = async (mm, band) => {
  await page.focus('[data-test="section-play"]')
  await page.$eval('[data-test="section-play"]', (el) => (el.value = ''))
  await page.type('[data-test="section-play"]', mm)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (b) => new RegExp(b).test(document.querySelector('[data-test="section-band"]')?.textContent ?? ''),
    { timeout: 30_000 },
    band,
  )
}
await setPlay('0', '^0\\.\\d\\d to ')
const first = await readout()
console.log(`shadow: ${first} — ${await band()}`)
check(/^1 loop/.test(first), 'the notched block casts one loop')
const area0 = areaOf(first)
check(area0 >= 1200 && area0 < 40.4 * 30.4, `its area is the block’s whole 40 × 30 mm and the band (${area0} mm²)`)
check(/0\.\d\d to 0\.\d\d mm outside the part/.test(await band()), `the band it lies in is said (${await band()})`)
await page.screenshot({ path: shotPath('e2e-shadow-box.png') })

// A play of half a millimetre: the outline moves out, rounded at the corners.
await setPlay('0.5', '^0\\.5\\d to ')
const played = await readout()
console.log(`with play 0.5: ${played} — ${await band()}`)
check(areaOf(played) > area0 + 60, `the play widens the outline (${areaOf(played)} mm²)`)

// A shadow has no offset: it is drawn in the middle of the part, the
// block's 0 to 20 mm.
check((await page.$('[data-test="section-offset"]')) === null, 'a shadow has no offset to type')
const planeZ = await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().sectionDraft?.frame?.origin[2])
check(Math.abs(planeZ - 10) < 1e-6, `the outline lies in the middle of the part (z ${planeZ})`)

// Extruded, as it starts: a block from the part's lowest point to its
// highest.
await page.waitForSelector('[data-test="section-extrude-height"]', { timeout: 5_000 })
const height = await page.$eval('[data-test="section-extrude-height"]', (e) => e.textContent)
check(/20\.00 mm high/.test(height), `the block stands through the part’s 20 mm (${height.trim()})`)
await page.screenshot({ path: shotPath('e2e-shadow-block.png') })

await click(page, '[data-test="create-section"]')
await sleep(300)
const rows = await page.$$eval('[data-test="section-row"]', (els) =>
  els.map((e) => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), title: e.querySelector('b[title]')?.getAttribute('title') ?? '' })),
)
console.log('sections:', JSON.stringify(rows))
check(rows.length === 1 && /1 loop · [\d,]+ mm²/.test(rows[0].text), 'the row reads the loops and the area')
check(/^shadow onto XY plane$/.test(rows[0].title), `and says it is a shadow (${rows[0].title})`)
await page.screenshot({ path: shotPath('e2e-shadow-3d.png') })

// ---- the 2D sheet and the DXF ------------------------------------------------
await click(page, '[data-test="workspace-flat"]')
await dismissSupportCard(page)
await page.waitForSelector('[data-test="flat-source"]', { timeout: 5_000 })
const source = await page.$eval('[data-test="flat-source"]', (el) => el.options[el.selectedIndex].text)
check(/shadow onto XY plane/.test(source), `the shadow is the sheet’s source (${source})`)
await page.waitForFunction(
  () => /1 edge chain|edge chains from the cut/.test(document.querySelector('[data-test="flat-edge-status"]')?.textContent ?? ''),
  { timeout: 10_000 },
)
await page.screenshot({ path: shotPath('e2e-shadow-sheet.png') })

const dir = mkdtempSync(join(tmpdir(), 'scanruler-shadow-dxf-'))
await downloadsTo(page, dir)
await click(page, '[data-test="flat-export-dxf"]')
const file = await awaitDownload(dir, '.dxf')
const dxf = file ? readFileSync(join(dir, file), 'utf8') : ''
check(Boolean(dxf), 'the DXF downloaded')
const lines = dxf.split(/\r?\n/)
const count = (type) => lines.filter((v, k) => k % 2 === 1 && v === type && lines[k - 1].trim() === '0').length
console.log(`DXF: ${count('LINE')} LINE, ${count('ARC')} ARC, ${count('CIRCLE')} CIRCLE, ${count('LWPOLYLINE')} LWPOLYLINE`)
check(count('LWPOLYLINE') === 0, 'the outline is no polyline')
check(count('LINE') === 4 && count('ARC') === 4, 'but four lines and the four rounds the play gives the corners')

// ---- the block in the STEP file ------------------------------------------------
await click(page, '[data-test="workspace-elements"]')
await sleep(300)
const stepDir = mkdtempSync(join(tmpdir(), 'scanruler-shadow-step-'))
await downloadsTo(page, stepDir)
await click(page, '[data-test="export-step"]')
const stepFile = await awaitDownload(stepDir, '.step')
const step = stepFile ? readFileSync(join(stepDir, stepFile), 'utf8') : ''
check(Boolean(step), 'the STEP file downloaded')
check(/MANIFOLD_SOLID_BREP\('Section 1'/.test(step), 'the extruded shadow is a solid named after the section')
const faces = (step.match(/ADVANCED_FACE\(/g) ?? []).length
const cylinders = (step.match(/CYLINDRICAL_SURFACE\(/g) ?? []).length
console.log(`STEP: ${faces} faces, ${cylinders} cylindrical`)
check(faces === 10 && cylinders === 4, 'four planes and four rounds round it, and a face at each end')
await page.screenshot({ path: shotPath('e2e-shadow-block-3d.png') })

await finish(browser, consoleErrors)
