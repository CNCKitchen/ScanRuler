// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Flip normals: drives the real app in headless Chrome on
// a generated scan — a closed noisy box standing on the XY plane — with the
// view bar's Backfaces on, as it starts: flips the whole part and reads off
// the screen that every face it shows is now the far side of its triangles,
// steps it back with Ctrl+Z, then marks a patch with a window — in amber —
// and flips it alone with Enter, the marking gone with it.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-flip.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { clickTool } from '../../../scripts/e2e-lib.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canvasRect, check, drag, finish, launchApp, loadScan, OUT_DIR, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { noisyBoxScan } from '../../../scripts/e2e-fixtures.mjs'

mkdirSync(OUT_DIR, { recursive: true })
const fixture = noisyBoxScan({ seed: 11, noise: 0.03, header: 'ScanRuler e2e box to flip' })
const SCAN = join(OUT_DIR, 'mesh-flip-box.stl')
writeFileSync(SCAN, fixture.bytes)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const count = (t) => Number(String(t).replace(/[^\d]/g, ''))
const editsReach = async (n) => {
  await page.waitForFunction((k) => document.querySelectorAll('[data-test=pending-edit]').length === k, { timeout: 300_000 }, n)
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(800)
}
const stage = async (name) => {
  const r = await canvasRect(page, '.viewslot canvas')
  const clip = { x: r.x, y: r.y, width: r.w - 190, height: r.h }
  await page.screenshot({ clip, path: shotPath(`mesh-flip-${name}`) })
  return page.screenshot({ clip, encoding: 'base64' })
}
/** Pixels the far side of a triangle is tinted in (mauve), and amber
 *  marking. */
const tally = async (name) =>
  page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let mauve = 0, amber = 0
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
      if (r > g * 1.35 && b > g * 1.08 && r > 60) mauve++
      if (r > 170 && g > 100 && g < 200 && b < 80 && r > g * 1.2) amber++
    }
    return { mauve, amber }
  }, await stage(name))
const ctrl = async (key) => {
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
}

await loadScan(page, SCAN)
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=mesh-tool-flip]')
await clickTool(page, '[data-test=mesh-tool-flip]')
await page.waitForSelector('[data-test=flip-tool]')
check(!(await page.$('[data-test=flip-backfaces-hint]')), 'Backfaces is on to start, so no hint asks for it')
check(await page.$eval('[data-test=flip-marked]', (el) => el.disabled), 'Flip marked waits on a marking')
check(!(await page.$eval('[data-test=flip-all]', (el) => el.disabled)), 'Flip all is ready')
const before = await tally('1-before.png')
console.log('before', before)

await page.click('[data-test=flip-all]')
await editsReach(1)
const flipped = await tally('2-flipped-all.png')
console.log('flipped all', flipped)
check((await text('[data-test=pending-edit]')).includes('Flipped the normals'), `the list says so: ${await text('[data-test=pending-edit]')}`)
check(flipped.mauve > before.mauve + 20000, 'the whole part shows its back faces')

await ctrl('z')
await page.waitForFunction(() => document.querySelectorAll('[data-test=pending-edit]').length === 0, { timeout: 60_000 })
await sleep(800)
const undone = await tally('3-undone.png')
console.log('undone', undone)
check(undone.mauve < flipped.mauve / 4, 'Ctrl+Z turns it back')

// A patch marked with a window, flipped alone.
await page.click('[data-test=mark-window]')
const r = await canvasRect(page, '.viewslot canvas')
const cx = r.x + (r.w - 190) / 2
const cy = r.y + r.h / 2
await drag(page, [cx - 60, cy - 60], [cx + 60, cy + 60], { steps: 10 })
await sleep(400)
const marked = count(await text('[data-test=mark-count]'))
const markedTally = await tally('4-marked.png')
console.log('marked', marked, markedTally)
check(marked > 0 && markedTally.amber > 2000, 'the window marks surface, in amber')
check(!(await page.$eval('[data-test=flip-marked]', (el) => el.disabled)), 'Flip marked is ready')
await page.keyboard.press('Escape')
await sleep(200)
await page.keyboard.press('Enter')
await editsReach(1)
const patch = await tally('5-flipped-marked.png')
console.log('flipped marked', patch)
check((await text('[data-test=pending-edit]')).includes('marked region'), `the list says so: ${await text('[data-test=pending-edit]')}`)
check(count(await text('[data-test=mark-count]')) === 0, 'the marking goes with it')
check(patch.mauve > 2000 && patch.mauve < flipped.mauve * 0.8, 'the patch alone shows its back faces')
await finish(browser, consoleErrors)
