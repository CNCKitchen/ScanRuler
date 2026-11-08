// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Mirror: drives the real app in headless Chrome on a
// generated scan — the notched block, its pocket in the front face only —
// mirrors it whole across the XZ plane through its middle, the preview drawn
// first, steps that back with Ctrl+Z, then makes it symmetric keeping the
// front, so the pocket is in both faces, and reads the list of edits.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-mirror.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdirSync } from 'node:fs'
import { canvasRect, check, finish, launchApp, loadScan, OUT_DIR, pixelDiff, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { notchedBlockScan } from '../../../scripts/e2e-fixtures.mjs'

mkdirSync(OUT_DIR, { recursive: true })
const SCAN = notchedBlockScan()

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const pendingTexts = () => page.$$eval('[data-test=pending-edit]', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()))
const editsReach = async (n) => {
  await page.waitForFunction((k) => document.querySelectorAll('[data-test=pending-edit]').length === k, { timeout: 300_000 }, n)
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(800)
}
/** The stage, saved as `name` and handed back as base64 to compare. */
const stage = async (name) => {
  const r = await canvasRect(page, '.viewslot canvas')
  const clip = { x: r.x, y: r.y, width: r.w - 190, height: r.h }
  await page.screenshot({ clip, path: shotPath(`mesh-mirror-${name}`) })
  return page.screenshot({ clip, encoding: 'base64' })
}

await loadScan(page, SCAN)
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=mesh-tool-mirror]')
// The back face as scanned, plain — where a mirror across XZ puts the pocket.
await page.keyboard.press('9')
await sleep(800)
const backBare = await stage('0-back-bare.png')
// Seen from the front left, above: the front face with its pocket in view.
await page.keyboard.press('7')
await sleep(800)

await page.click('[data-test=mesh-tool-mirror]')
await page.waitForSelector('[data-test=mirror-tool]')
check(!(await page.$('[data-test=mirror-keep-plus]')), 'Whole part to start, with no side to keep')
await page.select('[data-test=mirror-ref]', 'y')
await sleep(600)
const wholePreview = await stage('1-whole-preview.png')
await page.keyboard.press('Escape')
await sleep(600)
const bare = await stage('0-bare.png')
const previewShows = await pixelDiff(page, wholePreview, bare)
console.log(`whole-part preview changes ${previewShows.toFixed(1)} % of the stage`)
check(previewShows > 3, 'the mirror image and the plane are drawn while the tool is in hand, and go with it')

await page.click('[data-test=mesh-tool-mirror]')
await page.waitForSelector('[data-test=mirror-tool]')
check((await page.$eval('[data-test=mirror-ref]', (el) => el.value)) === 'y', 'the plane chosen stays chosen')
await page.click('[data-test=mirror-scan]')
await editsReach(1)
check((await pendingTexts())[0]?.startsWith('Mirrored across XZ plane, Y 15'), `the list says so: ${(await pendingTexts())[0]}`)
await page.keyboard.press('Escape')
await page.keyboard.press('9')
await sleep(800)
const backWhole = await stage('2-whole-done-back.png')
check((await pixelDiff(page, backBare, backWhole)) > 1, 'mirrored whole, the pocket is in the back face')
await page.keyboard.press('7')
await sleep(800)
await page.click('[data-test=mesh-tool-mirror]')
await page.waitForSelector('[data-test=mirror-tool]')

await page.keyboard.down('Control')
await page.keyboard.press('z')
await page.keyboard.up('Control')
await editsReach(0)

await page.click('[data-test=mirror-mode-symmetric]')
await page.waitForSelector('[data-test=mirror-keep-minus]')
await page.click('[data-test=mirror-keep-minus]')
await sleep(600)
const symPreview = await stage('3-symmetric-preview.png')
check((await text('[data-test=mirror-scan]')) === 'Make symmetric', 'the button says what it will do')
await page.click('[data-test=mirror-scan]')
await editsReach(1)
check((await pendingTexts())[0]?.startsWith('Made symmetric about XZ plane, Y 15'), `the list says so: ${(await pendingTexts())[0]}`)
await page.keyboard.press('Escape')
await sleep(600)
const symDone = await stage('4-symmetric-done.png')
console.log(`the symmetric preview differs from the result by ${(await pixelDiff(page, symPreview, symDone)).toFixed(1)} % of the stage (tint and plane)`)
check((await pixelDiff(page, bare, symDone)) < 1, 'made symmetric keeping the front, the front is as it was')
await page.keyboard.press('9')
await sleep(800)
const backSym = await stage('5-symmetric-done-back.png')
check((await pixelDiff(page, backBare, backSym)) > 1, 'made symmetric, the pocket is in the back face too')
check((await pixelDiff(page, backWhole, backSym)) < 1, 'and the back looks as the whole mirror left it')

await finish(browser, consoleErrors)
