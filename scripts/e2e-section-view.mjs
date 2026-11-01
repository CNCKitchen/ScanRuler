// SPDX-License-Identifier: AGPL-3.0-only
import { dismissSupportCard } from './e2e-lib.mjs'
// End-to-end test of the section view: the Section key cuts the part open
// at a plane through its middle, square to the view, the half toward the
// camera taken away. A closed part is closed where it is cut — a cap in the
// cut colour fills the cut face, and a click on the face meets nothing, not
// the inside wall behind it — while an open one stays a shell looked into,
// its inside there to be clicked. Flip takes the other half away; the key
// again puts the part back together. What is drawn on the part is cut too:
// an element's label on the half cut away goes with it. In the deviation
// workspace the reference is cut with the scan, and in the split view its
// half is cut at the same plane and closed in the scan's cut colour.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-section-view.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { check, click, fail, finish, launchApp, loadScan, shotPath, sleep } from './e2e-lib.mjs'

// A 20 mm cube, closed; and the same cube with a hole in it, open.
const cube = importStep(cubeStep(20), { surfaceDeviation: 0.02, maxEdge: 2 }).mesh
const dir = mkdtempSync(join(tmpdir(), 'scanruler-section-view-'))
const CLOSED = join(dir, 'closed-cube.stl')
const OPEN = join(dir, 'open-cube.stl')
const REFERENCE = join(dir, 'cube.step')
writeFileSync(CLOSED, Buffer.from(writeBinarySTL(cube)))
writeFileSync(OPEN, Buffer.from(writeBinarySTL({ ...cube, indices: cube.indices.slice(6) })))
writeFileSync(REFERENCE, cubeStep(20))

let { browser, page, consoleErrors } = await launchApp()

/** How much of a picture of the view is in the cut colour's warm hue — the
 *  clay a closed part's cut face is filled with. The surfaces are grey. */
const capShare = () =>
  page.evaluate(async () => {
    const bytes = await window.__scanruler.scene().capture(480, 320)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d')
    g.drawImage(bitmap, 0, 0)
    const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data
    let warm = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 25 && d[i + 1] > d[i + 2] + 15 && d[i] > 80) warm++
    return warm / (bitmap.width * bitmap.height)
  })

/** What a click at the middle of the viewport meets on the scan — the
 *  part's middle, on the cut face while the section view is on. */
const pickAtMiddle = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.viewport canvas')
    const r = canvas.getBoundingClientRect()
    const hit = window.__scanruler.scene().pick(r.left + r.width / 2, r.top + r.height / 2)
    return hit ? hit.point : null
  })

const sectionOn = () => page.$eval('[data-test="toggle-section-view"]', (e) => e.getAttribute('aria-pressed') === 'true')

// ---- a closed part ------------------------------------------------------------
await loadScan(page, CLOSED)
await sleep(300)
const bare = await capShare()
const bareHit = await pickAtMiddle()
check(bare < 0.002, `no cut colour before the cut (${(bare * 100).toFixed(2)}%)`)
check(bareHit !== null, 'the middle of the uncut cube is its surface')

// A point on the top face — the face the cut will take away, the view being
// mostly square to it — with its label on it.
const rect = await page.$eval('.viewport canvas', (e) => {
  const r = e.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
let fitted = false
for (const [fx, fy] of [[0.62, 0.3], [0.55, 0.25], [0.7, 0.35], [0.6, 0.4]]) {
  await click(page, '[data-test="fit-point"]')
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  fitted = await page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (fitted) break
  await click(page, '[data-test="cancel-draft"]').catch(() => {})
}
check(fitted, 'a point is picked on the top face')
await click(page, '[data-test="create-element"]')
await page.waitForSelector('.element-label')
await sleep(300)
const labelCut = () => page.$eval('.element-label', (e) => e.classList.contains('cut-away'))
check(!(await labelCut()), 'the point’s label is on the uncut part')

await click(page, '[data-test="toggle-section-view"]')
await page.waitForSelector('[data-test="section-view-keys"]')
await sleep(400)
check(await sectionOn(), 'the Section key is down')
const across = await page.$eval('[data-test="section-view-ref"]', (e) => e.value)
const offset = Number(await page.$eval('[data-test="section-view-offset"]', (e) => e.value))
console.log('section across', across, 'at', offset)
check(['x', 'y', 'z'].includes(across), 'laid across a coordinate plane')
check(Math.abs(offset - 10) < 0.01, `through the cube's middle (${offset})`)
const capped = await capShare()
await page.screenshot({ path: shotPath('section-view-closed.png') })
check(capped > 0.02, `a closed part's cut face is filled (${(capped * 100).toFixed(2)}%)`)
check((await pickAtMiddle()) === null, 'a click on the cut face meets nothing behind it')
check(await labelCut(), 'the label of the face cut away goes with it')

// Flipped, the half toward the camera stays and hides the cut face; seen
// from the other side, the face is there, filled.
await click(page, '[data-test="section-view-flip"]')
await sleep(400)
check((await capShare()) < 0.002, 'flipped, the half toward the camera stands in front of the cut')
await page.evaluate(() => {
  const scene = window.__scanruler.scene()
  const v = scene.viewDirection()
  const a = [0, 1, 2].reduce((best, k) => (Math.abs(v[k]) > Math.abs(v[best]) ? k : best), 0)
  const views = [['left', 'right'], ['front', 'rear'], ['bottom', 'top']]
  scene.viewFrom(views[a][v[a] > 0 ? 1 : 0])
})
await sleep(900)
const flipped = await capShare()
await page.screenshot({ path: shotPath('section-view-flipped.png') })
check(flipped > 0.02, `seen from the other side, the other half's cut face is filled (${(flipped * 100).toFixed(2)}%)`)

// Slid off the part, the plane cuts nothing: the part is whole again.
await page.$eval('[data-test="section-view-offset"]', (e) => {
  e.focus()
  e.value = '40'
})
await page.keyboard.press('Enter')
await sleep(400)
check((await capShare()) < 0.002, 'a plane beside the part cuts nothing')
check((await pickAtMiddle()) !== null, 'and the part is there to click again')

await click(page, '[data-test="toggle-section-view"]')
await sleep(400)
check(!(await sectionOn()), 'the Section key is up again')
check((await page.$('[data-test="section-view-keys"]')) === null, 'its row has gone')
check((await capShare()) < 0.002, 'the part is whole again')
check(!(await labelCut()), 'and the label is back')

// ---- an open part ---------------------------------------------------------------
await loadScan(page, OPEN, { settle: 0 })
await page.waitForFunction(() => /open-cube/.test(document.querySelector('.file-info')?.textContent ?? ''), { timeout: 60_000 })
await sleep(800)
check(!(await sectionOn()), 'another scan puts the section view away')
await click(page, '[data-test="toggle-section-view"]')
await sleep(400)
const open = await capShare()
await page.screenshot({ path: shotPath('section-view-open.png') })
check(open < 0.002, `an open part is left open (${(open * 100).toFixed(2)}%)`)
const inside = await pickAtMiddle()
check(inside !== null, 'its inside is there to be clicked')
if (inside) {
  // Inside, on the kept half: past the middle, away from the camera.
  console.log('picked inside at', inside.map((v) => v.toFixed(2)).join(', '))
}

if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(' | ')}`)
await browser.close()

// ---- the reference, and the split view ------------------------------------------
;({ browser, page, consoleErrors } = await launchApp())
await dismissSupportCard(page)
await page.click('[data-test=workspace-deviation]')
await loadScan(page, CLOSED, { inputSelector: '[data-test=start-scan] input[type=file]', settle: 0 })
await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(REFERENCE)
await page.waitForFunction(() => document.querySelector('[data-test=align-auto]')?.disabled === false, { timeout: 120_000 })
await sleep(600)

/** How warm a viewport looks — the clay of a cut face — read off the screen,
 *  for the half the scene's own picture does not cover. */
const warmIn = async (selector) => {
  const clip = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) - 170, height: Math.round(r.height) - 100 }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let warm = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 25 && d[i + 1] > d[i + 2] + 15 && d[i] > 80) warm++
    return warm / (c.width * c.height)
  }, shot)
}

await click(page, '[data-test="toggle-section-view"]')
await sleep(500)
check(await sectionOn(), 'the section view opens in the deviation workspace')
const referenceCut = await page.evaluate(() => window.__scanruler.scene().sectionClip() !== null)
check(referenceCut, 'the scan and the reference are cut')
check((await capShare()) > 0.02, `the closed scan is filled where it is cut (${((await capShare()) * 100).toFixed(2)}%)`)
await page.screenshot({ path: shotPath('section-view-deviation.png') })

await page.click('[data-test=toggle-split]')
await page.waitForSelector('[data-test=compare-half]')
await sleep(900)
const right = await warmIn('.compareview')
await page.screenshot({ path: shotPath('section-view-split.png') })
check(right > 0.02, `the reference half is cut at the same plane and filled (${(right * 100).toFixed(2)}%)`)
await click(page, '[data-test="toggle-section-view"]')
await sleep(600)
check((await warmIn('.compareview')) < 0.002, 'and put back together with the scan')

if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(' | ')}`)
await finish(browser, consoleErrors)
