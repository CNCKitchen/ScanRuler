// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of sections: fits the two balls of the ball bar, runs a
// line through their centres, cuts the scan with a plane across that line at
// the far ball's centre, then measures the cut in the 2D workspace — the
// circle the plane makes through the ball has to read the ball's own
// diameter. Also checks the section is the sheet's source when the workspace
// is opened, that switching sources keeps each sheet's measurements, and
// that deleting the section takes its source away.
//
// What was measured on the sheet belongs to the section: back in the 3D
// workspace its row counts the circle, and the STEP export writes it in a
// group named after the section, as a circle in the cutting plane.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-section.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canvasRect,
  check,
  click,
  drag,
  fail,
  finish,
  fitBall,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')
// The ball bar's centre distance — what the smoke test measures it at.
const HALF_SPAN = 148.64 / 2

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

// ---- two balls and the line through them ------------------------------------
const posA = await fitBall(page, rect, false, 1)
const posB = await fitBall(page, rect, true, 2)
if (!posA || !posB) {
  fail('both balls fitted')
  await finish(browser, consoleErrors)
  process.exit()
}
const spheres = await rowTexts(page)
const ballDia = spheres.map((t) => Number((t.match(/Ø ([\d.]+)/) ?? [])[1]))
console.log('balls:', JSON.stringify(spheres))

await click(page, '[data-test="fit-line"]')
await selectByLabel(page, '[data-test="draft-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="draft-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="create-element"]')
await sleep(200)
check((await rowTexts(page)).length === 3, 'a line runs through the two balls')

// ---- the section ------------------------------------------------------------
await click(page, '[data-test="fit-section"]')
check((await page.$('[data-test="section-editor"]')) !== null, 'the Section key opens its box')
check(
  /No element chosen/.test(await page.$eval('[data-test="section-status"]', (e) => e.textContent)),
  'and it opens empty',
)
const readStatus = () => page.$eval('[data-test="section-status"]', (e) => e.textContent)
const cutSettled = () =>
  page.waitForFunction(
    () => /edge chain|misses/.test(document.querySelector('[data-test="section-status"]')?.textContent ?? ''),
    { timeout: 20_000 },
  )

// ---- the coordinate planes on offer -----------------------------------------
// With nothing chosen the XY, YZ and XZ planes stand through the part's
// centre, a fifth of the part's size. Seen from the front the XY plane is
// face-on there; a click a little off the centre — clear of the line that
// runs through it, which would take the click first — is on the plane and
// on nothing else, the bar being empty at its middle.
await sleep(300)
await page.screenshot({ path: shotPath('e2e-section-planes.png') })
await page.mouse.click(rect.x + rect.w * 0.5 + 40, rect.y + rect.h * 0.5 + 40)
await sleep(300)
const clickedRef = await page.$eval('[data-test="section-ref"]', (el) => el.value)
console.log(`a click on a coordinate plane chose: ${JSON.stringify(clickedRef)}`)
check(/^[xyz]$/.test(clickedRef), 'clicking a coordinate plane in the viewport takes it')

// The XY plane by name: through the bar's centre it cuts the bar, and its
// offset reads as a Z coordinate rather than a distance from anything.
await selectByLabel(page, '[data-test="section-ref"]', 'XY plane')
await cutSettled()
console.log('cut on the XY plane through the centre:', await readStatus())
check(/edge chain/.test(await readStatus()), 'the XY plane through the part’s centre cuts the bar')
check(
  (await page.$eval('[data-test="section-offset"]', (el) => el.previousElementSibling?.textContent)) === 'Z (mm)',
  'and its offset field is the plane’s Z coordinate',
)
check(
  (await page.$eval('[data-test="section-hint"]', (e) => e.textContent)).includes('ring'),
  'the box offers the rings that tilt the plane',
)
await page.screenshot({ path: shotPath('e2e-section-gizmo.png') })

// ---- along the line through the balls --------------------------------------
await selectByLabel(page, '[data-test="section-ref"]', 'Line 1')
await cutSettled()
console.log('cut at the middle of the bar:', await readStatus())
const midPoints = Number(
  ((await page.$eval('[data-test="section-points"]', (e) => e.textContent).catch(() => '0')) ?? '0').replace(/[^\d]/g, ''),
)

// Slide the plane to the far ball's centre by typing the offset.
await page.focus('[data-test="section-offset"]')
await page.$eval('[data-test="section-offset"]', (el) => (el.value = ''))
await page.type('[data-test="section-offset"]', String(HALF_SPAN))
await page.keyboard.press('Enter')
await page.waitForFunction(
  () =>
    /edge chain/.test(document.querySelector('[data-test="section-status"]')?.textContent ?? '') &&
    !document.querySelector('[data-test="create-section"]')?.disabled,
  { timeout: 20_000 },
)
const ballPoints = Number(
  (await page.$eval('[data-test="section-points"]', (e) => e.textContent)).replace(/[^\d]/g, ''),
)
console.log(`cut through the ball: ${await readStatus()} (${ballPoints} points, ${midPoints} at the middle)`)
check(ballPoints > 20, 'the plane through the ball cuts a real chain')
check(ballPoints !== midPoints, 'moving the offset moves the cut')
await page.screenshot({ path: shotPath('e2e-section-preview.png') })

// Enter creates it, like every other confirm.
await page.keyboard.press('Enter')
await sleep(300)
const sectionRows = await page.$$eval('[data-test="section-row"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
)
console.log('sections:', JSON.stringify(sectionRows))
check(sectionRows.length === 1 && /^Section 1/.test(sectionRows[0]), 'the section is listed under the elements')
check(/1 edge/.test(sectionRows[0]), 'and it is one closed chain — the ball’s rim')
check((await page.$('[data-test="section-editor"]')) === null, 'the box closes on create')

// ---- measured in the 2D workspace ------------------------------------------
await click(page, '[data-test="workspace-flat"]')
await click(page, '[data-test="support-card"] .sc-x').catch(() => {})
await page.waitForSelector('[data-test="flat-source"]', { timeout: 5_000 })
const source = await page.$eval('[data-test="flat-source"]', (el) => el.options[el.selectedIndex].text)
check(/^Section 1/.test(source), `the new section is the sheet’s source (${source})`)
check(/along Line 1/.test(source), 'named after the line it was cut along')
await page.waitForFunction(
  () => /from the cut/.test(document.querySelector('[data-test="flat-edge-status"]')?.textContent ?? ''),
  { timeout: 10_000 },
)
check((await page.$('[data-test="flat-uncalibrated-chip"]')) === null, 'a section is not uncalibrated')
check((await page.$('[data-test="flat-cal-distance"]')) === null, 'and offers no calibration')

// Screen mapping for the framed sheet: the cut is a circle about the sheet's
// origin, which the sheet is centred on, and the sheet is square — framed by
// the canvas height with the viewport's 8 % margin. The plane runs through
// Sphere 2's centre (the line runs from Sphere 1 to Sphere 2, the offset is
// positive), so the ball's own radius says where its rim lies.
const flatRect = await page.$eval('.viewslot:not([hidden]) .viewport canvas:not(.loupe)', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const r = ballDia[1] / 2
// Bounds are the cut plus a 5 mm hand's width on a cut this small — see App.
const sheetHalf = r + 5
const pxPerMm = (flatRect.h / 1.08 / 2) / sheetHalf
const centre = [flatRect.x + flatRect.w / 2, flatRect.y + flatRect.h / 2]
const toScreen = (mx, my) => [centre[0] + mx * pxPerMm, centre[1] - my * pxPerMm]

// A circle from every edge point on the sheet: one drag over the lot, kept
// on the sheet — a drag that starts off it collects nothing.
await click(page, '[data-test="flat-fit-circle"]')
await page.select('[data-test="flat-draft-method"]', 'flat-circle-edge')
await drag(page, toScreen(-r - 2, r + 2), toScreen(r + 2, -r - 2))
await sleep(400)
const readDia = async () =>
  Number(((await page.$eval('[data-test="flat-draft-status"]', (el) => el.textContent)).match(/([\d.]+)/) ?? [])[1])
const cutDia = await readDia()
console.log(`section circle Ø ${cutDia} — ball Ø ${ballDia[1]}`)
check(Math.abs(cutDia - ballDia[1]) < 0.15, `the cut’s circle reads the ball’s diameter (${cutDia} vs ${ballDia[1]})`)
await click(page, '[data-test="flat-create-element"]')
await sleep(200)
check((await rowTexts(page)).length === 1, 'the circle joins the section’s sheet')
await page.screenshot({ path: shotPath('e2e-section-sheet.png') })

// The same circle by one click on its rim: an edge tool reads a click as the
// whole chain under it, and the cut's loop is one chain. Where the rim is on
// screen is read off the circle just drawn rather than predicted: its label
// floats at 45° up-right of its centre, r/√2 out on each axis, which fixes
// both the centre and the scale.
const label = await page.$eval('.element-label', (el) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
})
const predicted = toScreen(r * Math.SQRT1_2, r * Math.SQRT1_2)
console.log(
  `label at ${label.x.toFixed(0)},${label.y.toFixed(0)} — predicted ${predicted[0].toFixed(0)},${predicted[1].toFixed(0)}`,
)
// Two unknowns (the centre's x and the scale) from the label's x alone would
// be underdetermined, so trust the centre and take the scale off the label.
const ppmDrawn = (label.x - centre[0]) / (r * Math.SQRT1_2)
await click(page, '[data-test="flat-fit-circle"]')
await page.select('[data-test="flat-draft-method"]', 'flat-circle-edge')
await sleep(300)
// The ball sits on a stem, and the cut runs out along its shoulder rather
// than round the rim there — a gap of a few millimetres at one angle. Which
// angle depends on how the section's own axes fell, so the rim is tried at
// several; a click that misses every chain adds nothing, so probing is free.
let clickedDia = NaN
let hitAt = null
for (const deg of [180, 90, 270, 0, 135, 225, 45, 315]) {
  const a = (deg * Math.PI) / 180
  await page.mouse.click(centre[0] + r * Math.cos(a) * ppmDrawn, centre[1] - r * Math.sin(a) * ppmDrawn)
  await sleep(300)
  clickedDia = await readDia()
  if (Number.isFinite(clickedDia)) {
    hitAt = deg
    break
  }
}
console.log(`rim click hit at ${hitAt}° (${await page.$eval('[data-test="flat-draft-picks"]', (e) => e.textContent)})`)
check(
  Math.abs(clickedDia - ballDia[1]) < 0.15,
  `one click on the rim takes the whole loop and reads the ball’s diameter (${clickedDia})`,
)
await click(page, '[data-test="flat-draft-cancel"]')

// ---- each source keeps its own sheet ----------------------------------------
await page.select('[data-test="flat-source"]', 'image')
await sleep(300)
check((await rowTexts(page)).length === 0, 'the image sheet is empty — nothing was measured there')
check((await page.$('[data-test="flat-source"]')) !== null, 'and the source select stays to come back by')
const sectionKey = await page.$eval('[data-test="flat-source"]', (el) =>
  [...el.options].find((o) => /^Section 1/.test(o.textContent)).value,
)
await page.select('[data-test="flat-source"]', sectionKey)
await sleep(300)
check((await rowTexts(page)).length === 1, 'back on the section, its circle is where it was left')

// ---- the circle belongs to the section in 3D and in the STEP file -----------
await click(page, '[data-test="workspace-elements"]')
await sleep(300)
const rowWithCircle = await page.$eval('[data-test="section-row"]', (e) =>
  e.textContent.replace(/\s+/g, ' ').trim(),
)
console.log('section row:', rowWithCircle)
check(/1 edge · 1 element/.test(rowWithCircle), 'the section row counts the circle measured on its sheet')
await page.screenshot({ path: shotPath('e2e-section-3d.png') })

// The circle is exported with the section, in a wireframe group under its
// name, as a CIRCLE at the ball's radius whose axis is the cutting plane's
// normal — the line from ball to ball.
const cdp = await page.createCDPSession()
const stepDir = mkdtempSync(join(tmpdir(), 'scanruler-section-'))
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: stepDir })
await click(page, '[data-test="export-step"]')
let stepText = null
for (let i = 0; i < 100 && !stepText; i++) {
  await sleep(200)
  const f = readdirSync(stepDir).find((n) => n.endsWith('.step'))
  if (f) stepText = readFileSync(join(stepDir, f), 'utf8')
}
check(Boolean(stepText), 'the STEP file downloaded')
if (stepText) {
  check(
    /GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION\('Section 1'/.test(stepText),
    'the section is a named wireframe group in the file',
  )
  check(/GEOMETRIC_CURVE_SET\('Section 1',\(#\d+\)\)/.test(stepText), 'holding the one curve measured on it')
  const exported = /CIRCLE\('Circle 1',#\d+,([\d.]+)\)/.exec(stepText)
  const exportedDia = exported ? 2 * Number(exported[1]) : NaN
  console.log(`exported Circle 1 Ø ${exportedDia} — ball Ø ${ballDia[1]}`)
  check(Math.abs(exportedDia - ballDia[1]) < 0.15, 'as a CIRCLE at the diameter read on the sheet')
}

// ---- deleting the section takes its source away ----------------------------
const sectionX = await page.$('[data-test="section-row"] .x:not(.edit):not(.eye)')
await sectionX.click()
await sleep(200)
check((await page.$$('[data-test="section-row"]')).length === 0, 'the cross deletes the section')
await click(page, '[data-test="workspace-flat"]')
await sleep(300)
check((await page.$('[data-test="flat-source"]')) === null, 'with no section left there is no source to choose')
check((await page.$('[data-test="slot-image"]')) !== null, 'the image slot is back')

await finish(browser, consoleErrors)
