// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end regression test for a datum alignment set up after a deviation
// best fit: drives the real app in headless Chrome — loads the scan, loads
// the reference in the deviation workspace and runs the automatic fit, goes
// back to 3D Measure, fits a plane and levels the part on it. The best fit is
// a pose on the scan's group; it used to stay underneath the datum preview,
// which carried the levelled part off the datum stage and made the re-framing
// on apply look where the pose had the part rather than where it landed once
// the fit was cleared — right only on a second attempt, when no pose was left.
// The checks read the stage back as pixels: the part must sit in the middle of
// the viewport both while the alignment is previewed and after it is applied.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align-after-deviation.mjs
// Env: CHROME (chrome.exe path), APP_URL, SCAN, NOMINAL, SHOT_DIR.
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  launchApp,
  loadScan,
  repoFile,
  requireFixture,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SCAN = process.env.SCAN ?? repoFile('block-marius.stl')
const NOMINAL = process.env.NOMINAL ?? repoFile('side bracket left.stl')
requireFixture(NOMINAL)

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})

/** Where the saturated pixels of the stage are — the part is scanner blue on a
 *  neutral ground, and the datum stage's planes are pale tints below the
 *  threshold. Returns the share of the stage they cover and their centroid and
 *  extent as fractions of the stage's width and height. Read back from a
 *  screenshot, like colouredFraction, because the WebGL drawing buffer is not
 *  kept for script to copy. */
async function partOnStage() {
  const clip = await page.$eval('.stage', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width - 190, height: r.height }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let painted = 0
    let total = 0
    let sx = 0
    let sy = 0
    let minX = c.width
    let maxX = 0
    let minY = c.height
    let maxY = 0
    for (let y = 0; y < c.height; y += 3) {
      for (let x = 0; x < c.width; x += 3) {
        const i = (y * c.width + x) * 4
        const max = Math.max(data[i], data[i + 1], data[i + 2])
        const min = Math.min(data[i], data[i + 1], data[i + 2])
        total++
        if (max - min > 60) {
          painted++
          sx += x
          sy += y
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return {
      fraction: painted / total,
      cx: painted ? sx / painted / c.width : NaN,
      cy: painted ? sy / painted / c.height : NaN,
      left: minX / c.width,
      right: maxX / c.width,
      top: minY / c.height,
      bottom: maxY / c.height,
    }
  }, shot)
}

const describe = (p) =>
  `${(p.fraction * 100).toFixed(1)} % of the stage, centred at ${p.cx.toFixed(2)}, ${p.cy.toFixed(2)}, spanning ${p.left.toFixed(2)}–${p.right.toFixed(2)} × ${p.top.toFixed(2)}–${p.bottom.toFixed(2)}`

/** The part is in the middle of the viewport and not cut off by its edges. */
function checkFramed(p, what) {
  console.log(`${what}: ${describe(p)}`)
  check(p.fraction > 0.03, `${what} — the part is on the stage`)
  check(
    p.cx > 0.25 && p.cx < 0.75 && p.cy > 0.2 && p.cy < 0.8,
    `${what} — the part is in the middle of the viewport`,
  )
  check(
    p.left > 0.02 && p.right < 0.98 && p.top > 0.02 && p.bottom < 0.98,
    `${what} — the part is not cut off by the edge of the viewport`,
  )
}

/** The previewed part stands on the datum stage — the first alignment centres
 *  it on the origin, and the stage is framed around the two together, so it
 *  sits small in the middle. The stage's own axes are saturated too, so only
 *  the centroid is read here, not the extent: a part carried off the stage by a
 *  leftover pose pulls it well to one side. */
function checkOnStage(p, what) {
  console.log(`${what}: ${describe(p)}`)
  check(p.fraction > 0.01, `${what} — the part is on the stage`)
  check(
    p.cx > 0.35 && p.cx < 0.65 && p.cy > 0.3 && p.cy < 0.7,
    `${what} — the part is centred on the datum stage`,
  )
}

const awaitStatus = (text, what) =>
  page
    .waitForFunction((t) => (document.body.innerText ?? '').includes(t), { timeout: 60_000 }, text)
    .then(() => true)
    .catch(() => false)
    .then((ok) => check(ok, what))

await loadScan(page, SCAN, { timeout: 300_000 })
// The support card's coloured buttons would count as part.
await page.$('[data-test=support-card] .sc-x').then((b) => b?.click())

// ---- best fit in the deviation workspace ----------------------------------
await page.click('[data-test=workspace-deviation]')
await sleep(400)
await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(NOMINAL)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(800)
await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(600)
const rms = await page.$eval('[data-test=align-rms] b', (el) => Number(el.textContent))
console.log(`best fit: ${rms} mm rms`)
check(rms > 0 && rms < 0.5, 'the automatic best fit converged')

// ---- back to 3D Measure: a plane, then the part levelled on it ------------
await page.click('[data-test=workspace-elements]')
await page.waitForSelector('[data-test=fit-plane]')
await sleep(500)
const rect = await canvasRect(page)

const saveEnabled = (timeout) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
let planeAt = null
for (const [fx, fy] of [[0.5, 0.5], [0.42, 0.42], [0.58, 0.58], [0.5, 0.35], [0.35, 0.6], [0.65, 0.4]]) {
  await click(page, '[data-test="fit-plane"]')
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  await sleep(350)
  if (await saveEnabled(4_000)) {
    planeAt = [fx, fy]
    break
  }
  await click(page, '[data-test="cancel-draft"]').catch(() => {})
}
if (!planeAt) {
  fail('no plane could be fitted on the part')
  await finish(browser, consoleErrors)
}
await click(page, '[data-test="create-element"]')
await sleep(300)

await click(page, '[data-test="start-alignment"]')
await selectByLabel(page, '[data-test="align-primary"]', 'Plane 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await sleep(500)
await page.screenshot({ path: shotPath('align-after-deviation-preview.png') })
checkOnStage(await partOnStage(), 'previewed on the datum stage')

await click(page, '[data-test="apply-alignment"]')
await awaitStatus('Part aligned', 'datum alignment applied')
await sleep(600)
await page.screenshot({ path: shotPath('align-after-deviation-applied.png') })
const status = await page.evaluate(() => document.body.innerText.match(/Part aligned[^\n]*/)?.[0] ?? '')
console.log('status:', status)
check(!/rotated 0\.00°/.test(status), 'the first alignment turned the part')
checkFramed(await partOnStage(), 'applied')

// Levelled once, the same plane asks for no further move.
await click(page, '[data-test="start-alignment"]')
await selectByLabel(page, '[data-test="align-primary"]', 'Plane 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="apply-alignment"]')
await awaitStatus('rotated 0.00°, moved 0.000 mm', 'a second alignment on the same plane changes nothing')
await sleep(300)
checkFramed(await partOnStage(), 'applied again')

await finish(browser, consoleErrors)
