// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the pre-deformed model's second viewport: Preview
// pre-deformed opens it beside the scan, in the same pose; Update pre-deform
// works the model out again from the settings in the panel; the Preview key
// a second time puts it away.
//
// The pair is built here, as in e2e-split.mjs: a STEP cube as the reference and
// a fine mesh of the same cube, two faces displaced, as the scan. Moved against
// that deformation the model is the same cube to within a fraction of a
// millimetre, so after the fit both viewports have to show it at the same
// size and in the same place.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-predeform.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { check, finish, launchApp, loadScan, shotPath, sleep } from './e2e-lib.mjs'

const SIZE = 20

const dir = mkdtempSync(join(tmpdir(), 'scanruler-predeform-'))
const stepText = cubeStep(SIZE)
const stepPath = join(dir, 'cube.step')
writeFileSync(stepPath, stepText)
const dense = importStep(stepText, { surfaceDeviation: 0.001, maxEdge: 0.8 })
const p = dense.mesh.positions
for (let i = 0; i < p.length; i += 3) {
  if (Math.abs(p[i + 2] - SIZE) < 1e-6) p[i + 2] += 0.2
  if (Math.abs(p[i] - SIZE) < 1e-6) p[i] -= 0.15
}
const scanPath = join(dir, 'cube-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(dense.mesh)))

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })

/** The scale rides over the inner edge of the scan's half and the view bar in
 *  its corner: both halves are read without them. */
const LEGEND_STRIP = 170
const VIEWBAR_BAND = 100

/** What share of a half the part covers, and where its middle is. */
async function halfStats(selector) {
  const clip = await page.$eval(
    selector,
    (el, { strip, band }) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width) - strip, height: Math.round(r.height) - band }
    },
    { strip: LEGEND_STRIP, band: VIEWBAR_BAND },
  )
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
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    let part = 0
    let sx = 0
    let sy = 0
    let warm = 0
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
      if (Math.abs(r - 0xde) + Math.abs(g - 0xdc) + Math.abs(b - 0xd6) < 26) continue
      part++
      sx += ((i / 4) % width) / width
      sy += Math.floor(i / 4 / width) / height
      if (r - b > 25) warm++
    }
    return {
      share: +(part / (width * height)).toFixed(4),
      cx: +(part ? sx / part : 0).toFixed(4),
      cy: +(part ? sy / part : 0).toFixed(4),
      warm: +(warm / Math.max(1, part)).toFixed(3),
    }
  }, shot)
}

const halfShown = () => page.$('[data-test=compare-half]:not([hidden])')
const infoText = () => page.$eval('[data-test=preview-info]', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null)

await page.click('[data-test=support-card] .sc-x').catch(() => {})
await page.click('[data-test=workspace-deviation]')
await loadScan(page, scanPath, { inputSelector: '[data-test=start-scan] input[type=file]', timeout: 300_000, settle: 0 })
await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(stepPath)
await page.waitForFunction(() => document.querySelector('[data-test=align-auto]')?.disabled === false, { timeout: 300_000 })
check(!(await page.$('[data-test=preview-predeformed]')), 'the preview key is not offered before a map is measured')

await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), { timeout: 300_000 })
await sleep(700)

// ---- the key is there, the second key and the viewport are not ---------------
await page.waitForSelector('[data-test=preview-predeformed]')
check(!(await page.$('[data-test=update-predeformed]')), 'Update pre-deform waits for the preview to be up')
check(!(await halfShown()), 'no second viewport before the preview is asked for')

// ---- Preview pre-deformed opens the viewport ---------------------------------
await page.click('[data-test=preview-predeformed]')
await page.waitForSelector('[data-test=compare-half]:not([hidden])', { timeout: 120_000 })
await page.waitForSelector('[data-test=update-predeformed]', { timeout: 120_000 })
await page.waitForFunction(() => document.querySelector('[data-test=update-predeformed]')?.textContent?.includes('Update'), { timeout: 120_000 })
await sleep(800)
const first = await infoText()
console.log('preview:', first)
check(/triangles/.test(first ?? ''), 'the preview says how many triangles it has')
check(/Pre-deformed/i.test(await page.$eval('[data-test=compare-half] .splitcap', (el) => el.textContent)), 'the second viewport is captioned as the pre-deformed model')

const left = await halfStats('.viewport')
const right = await halfStats('.compareview')
console.log('left', JSON.stringify(left), 'right', JSON.stringify(right))
check(right.share > 0.02, 'the second viewport has the model in view')
check(Math.abs(left.share - right.share) < 0.035, 'both viewports show the part at the same size')
check(Math.hypot(left.cx - right.cx, left.cy - right.cy) < 0.04, 'both viewports are in one pose')
check(right.warm < 0.02, 'the pre-deformed model carries no map colours')
await page.screenshot({ path: shotPath('predeform-preview.png') })

// ---- a changed setting makes the preview stale, and Update brings it up ------
check(!/press Update/.test(first ?? ''), 'a fresh preview does not ask to be updated')
await page.$eval('[data-test=pre-scale]', (el) => {
  el.focus()
  el.select()
})
await page.keyboard.type('3')
await page.keyboard.press('Enter')
await sleep(500)
check(/press Update/.test((await infoText()) ?? ''), 'changing the correction says the preview is out of date')
const kept = await page.$eval('.compareview canvas', (el) => {
  el.setAttribute('data-kept-marker', '1')
  return true
})
await page.click('[data-test=update-predeformed]')
// Up to date when the line no longer asks for it; the model is worked out in
// the worker, so it lands some time after the press.
await page.waitForFunction(
  () => {
    const info = document.querySelector('[data-test=preview-info]')?.textContent ?? ''
    return info !== '' && !/press Update/.test(info)
  },
  { timeout: 120_000 },
)
await sleep(600)
const updated = await infoText()
console.log('updated:', updated)
check(!/press Update/.test(updated ?? ''), 'Update brings the preview up to date')
check(kept && (await page.$eval('.compareview canvas', (el) => el.getAttribute('data-kept-marker') === '1')), 'Update reuses the same viewport')
const moved = (s) => Number(/up to ([0-9.]+)/.exec(s ?? '')?.[1] ?? NaN)
check(moved(updated) > moved(first) * 2, `a larger correction moves the model further (${moved(first)} -> ${moved(updated)})`)
const after = await halfStats('.compareview')
check(Math.abs(after.share - right.share) < 0.035, 'and the part is still in view at the same size')

// ---- smoothing: a larger length averages the field, the peak move falls -------
const smoothBefore = Number(await page.$eval('[data-test=deflect-smoothing]', (el) => el.value.replace(',', '.')))
await page.$eval('[data-test=deflect-smoothing]', (el) => {
  el.focus()
  el.select()
})
await page.keyboard.type('5')
await page.keyboard.press('Enter')
await sleep(500)
check(/press Update/.test((await infoText()) ?? ''), 'changing the smoothing says the preview is out of date')
await page.click('[data-test=update-predeformed]')
await page.waitForFunction(
  () => {
    const info = document.querySelector('[data-test=preview-info]')?.textContent ?? ''
    return info !== '' && !/press Update/.test(info)
  },
  { timeout: 120_000 },
)
await sleep(600)
const smoothed = await infoText()
console.log('smoothed:', smoothed, '(was', smoothBefore, 'mm)')
check(moved(smoothed) < moved(updated), `a longer smoothing averages the peak move down (${moved(updated)} -> ${moved(smoothed)})`)
check(moved(smoothed) > 0, 'and the model still moves')

// ---- the same key again puts it away -----------------------------------------
await page.click('[data-test=preview-predeformed]')
await page.waitForFunction(() => !document.querySelector('[data-test=compare-half]:not([hidden])'), { timeout: 30_000 })
check(!(await page.$('[data-test=update-predeformed]')), 'Update pre-deform goes with the viewport')
await sleep(400)

// ---- and the scan-and-reference split takes the place when it is asked for ---
await page.click('[data-test=preview-predeformed]')
await page.waitForSelector('[data-test=compare-half]:not([hidden])', { timeout: 120_000 })
await page.click('[data-test=toggle-split]')
await sleep(800)
const halves = await page.$$eval('[data-test=compare-half]:not([hidden]) .splitcap b', (els) => els.map((e) => e.textContent))
check(halves.length === 1 && halves[0] === 'Reference', `the split takes the second place from the preview (${halves.join(', ')})`)
await page.click('[data-test=toggle-split]')
await sleep(400)

check(consoleErrors.length === 0, `no console errors (${consoleErrors.slice(0, 3).join(' | ')})`)
await finish(browser, consoleErrors)
