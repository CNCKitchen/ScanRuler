// SPDX-License-Identifier: AGPL-3.0-only
import { dismissSupportCard } from '../../../scripts/e2e-lib.mjs'
// End-to-end test for Shrink / expand and Shell: drives the real app in
// headless Chrome on a generated scan — a closed noisy box standing on the XY
// plane — shrinks it and reads off the Deviation view that the surface moved
// the distance and no more (a shrink, not a scale), expands a patch marked
// with a window and checks the part is still closed, hollows it and looks at
// it cut open in the Cut tool's preview, steps the hollow back, deletes a
// small patch and checks Shell asks for the hole to be filled first, cuts
// the part open and thickens what is left into a closed solid, and steps
// back through all of it to the scan as it was opened.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-shell.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canvasRect, check, drag, fieldSetter, finish, launchApp, loadScan, OUT_DIR, setViewTheme, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { noisyBoxScan } from '../../../scripts/e2e-fixtures.mjs'

// ---- the scan: a closed box 30 × 30 × 20 on the XY plane, noisy -------------------

mkdirSync(OUT_DIR, { recursive: true })
const fixture = noisyBoxScan({ seed: 7, noise: 0.02 })
const SCAN = join(OUT_DIR, 'mesh-shell-box.stl')
writeFileSync(SCAN, fixture.bytes)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const count = (text) => Number(String(text).replace(/[^\d]/g, ''))
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const scanCount = async () => count((await page.$eval('.file-info span', (el) => el.textContent)).split('·')[0])
const edits = async () => (await page.$$('[data-test=pending-edit]')).length
const editTexts = async () => (await page.$$eval('[data-test=pending-edit]', (els) => els.map((el) => el.textContent))).join(' | ')
const copyCount = async () => count((await text('[data-test=edited-triangles] b')).split('·')[0])
const setField = fieldSetter(page)
const editsReach = async (n) => {
  await page.waitForFunction((k) => document.querySelectorAll('[data-test=pending-edit]').length === k, { timeout: 300_000 }, n)
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(500)
}
const step = async (key, word) => {
  const before = await page.$eval('.strip .msg', (el) => el.textContent).catch(() => '')
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
  await page.waitForFunction(
    (w, b) => {
      const now = document.querySelector('.strip .msg')?.textContent ?? ''
      return now !== b && new RegExp(w).test(now)
    },
    { timeout: 300_000 },
    word,
    before,
  )
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(400)
}
/** Mark a window `half` px either way of the middle of the view. */
const markMiddle = async (half) => {
  await page.click('[data-test=mark-window]')
  const r = await canvasRect(page, '.viewslot canvas')
  const cx = r.x + (r.w - 190) / 2
  const cy = r.y + r.h / 2
  await drag(page, [cx - half, cy - half], [cx + half, cy + half], { steps: 8 })
  await sleep(400)
  return count(await text('[data-test=mark-count]'))
}
/** Whether the mesh is closed, as Fill holes says. */
const closedNow = async () => {
  await page.click('[data-test=mesh-tool-holes]')
  await page.waitForSelector('[data-test=holes-closed], [data-test=holes-rims]', { timeout: 60_000 })
  await sleep(300)
  return Boolean(await page.$('[data-test=holes-closed]'))
}

await setViewTheme(page, 'studio')
await dismissSupportCard(page)
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=start-pane]')
await loadScan(page, SCAN, { inputSelector: '[data-test=start-scan] input[type=file]', timeout: 120_000, settle: 600 })
const opened = await scanCount()
check(opened === fixture.triangles, `the scan opens with its ${fixture.triangles} triangles`)
for (const id of ['offset', 'shell']) check(Boolean(await page.$(`[data-test=mesh-tool-${id}]`)), `the ${id} tool has a key`)

// ---- Shrink the whole part: the surface 0.2 mm in, every triangle kept ------------
await page.click('[data-test=mesh-tool-offset]')
await page.waitForSelector('[data-test=offset-tool]')
await page.click('[data-test=offset-shrink]')
await setField('[data-test=offset-distance]', 0.2)
check(/Shrink by 0\.2 mm/.test(await text('[data-test=offset-run]')), 'the button says what it will do')
await page.click('[data-test=offset-run]')
await editsReach(1)
const shrunk = await text('.strip .msg')
console.log('shrunk:', shrunk)
check(/Shrank the part by 0\.2 mm/.test(shrunk), 'the status line says the part was shrunk')
check((await copyCount()) === opened, 'every triangle is kept')
check((await scanCount()) === opened, 'and the scan in use is left as it was')
check(/Shrank by 0\.2 mm/.test(await editTexts()), 'the edit is listed on the copy')
// Shrunk, not scaled: every point of it the distance from the scan, a
// corner's no further than a face's.
await page.click('[data-test=toggle-copy-deviation]')
await page.waitForSelector('[data-test=copy-legend]', { timeout: 120_000 })
const legend = await text('[data-test=copy-legend]')
console.log('deviation:', legend)
const furthest = Number(legend.match(/max\s*([\d.]+)/)?.[1])
check(furthest > 0.18 && furthest < 0.26, `the copy is 0.2 mm inside the scan all over (furthest ${furthest} mm)`)
await page.screenshot({ path: shotPath('mesh-shell-shrunk.png') })
await page.click('[data-test=toggle-copy-deviation]')
await sleep(300)

// ---- Expand a marked patch: a step, the part still closed ---------------------------
await page.click('[data-test=offset-scope-marked]')
await page.click('[data-test=offset-expand]')
await setField('[data-test=offset-distance]', 0.5)
const marked = await markMiddle(40)
console.log(`marked: ${marked} points`)
check(marked > 0, 'a window marks the surface to move')
await page.keyboard.press('Escape')
await sleep(200)
check(Boolean(await page.$('[data-test=offset-tool]')), 'Escape gives the camera back and keeps the tool')
const beforeStep = await copyCount()
await page.click('[data-test=offset-run]')
await editsReach(2)
const expanded = await text('.strip .msg')
console.log('expanded:', expanded)
check(/Expanded the marked region by 0\.5 mm/.test(expanded), 'the status line says the marked region was expanded')
check((await copyCount()) >= beforeStep, 'no triangle is lost')
check(/Expanded a marked region by 0\.5 mm/.test(await editTexts()), 'the list says it was a marked region')
await page.screenshot({ path: shotPath('mesh-shell-expanded.png') })
check(await closedNow(), 'the part is still closed')

// ---- Hollow: a sealed cavity, seen in the Cut tool's preview ------------------------
await page.click('[data-test=mesh-tool-shell]')
await page.waitForSelector('[data-test=shell-closed]', { timeout: 60_000 })
check(true, 'Shell sees the part is closed, and offers to hollow it')
await setField('[data-test=shell-thickness]', 2)
check(/Hollow with a 2 mm wall/.test(await text('[data-test=shell-run]')), 'the button says the wall it leaves')
const beforeHollow = await copyCount()
await page.click('[data-test=shell-run]')
await editsReach(3)
const hollowed = await text('.strip .msg')
console.log('hollowed:', hollowed)
check(/Hollowed with a 2 mm wall — 1 cavity/.test(hollowed), 'the status line says one cavity was made')
const out = Number(hollowed.match(/([\d.]+) mm³ of material out/)?.[1])
// The box shrunk 0.2 mm all round is 29.6 × 29.6 × 19.6; its cavity 2 mm in
// from that.
const cavity = 25.6 * 25.6 * 15.6
check(Math.abs(out / cavity - 1) < 0.03, `the cavity is the box 2 mm in all round (${out} of ${cavity.toFixed(0)} mm³)`)
check((await copyCount()) > beforeHollow, 'the inner wall brings triangles of its own')
check(await closedNow(), 'the hollow part is closed')
await page.click('[data-test=mesh-tool-cut]')
await page.waitForSelector('[data-test=cut-closes]', { timeout: 60_000 })
check(true, 'cut across the middle it closes flat — a ring round the cavity')
await page.screenshot({ path: shotPath('mesh-shell-hollow-cut.png') })
await step('KeyZ', 'Undone')
check((await copyCount()) === beforeHollow && (await edits()) === 2, 'a step back fills the part again')

// ---- A small hole: Shell asks for it to be filled first ---------------------------------
await page.click('[data-test=mesh-tool-delete]')
await page.waitForSelector('[data-test=delete-tool]')
check((await markMiddle(10)) > 0, 'a small patch is marked to delete')
await page.keyboard.press('Escape')
await page.click('[data-test=delete-marked]')
await page.waitForSelector('[data-test=delete-confirm]')
await page.click('[data-test=delete-marked-confirm]')
await editsReach(3)
await page.click('[data-test=mesh-tool-shell]')
await page.waitForSelector('[data-test=shell-holes]', { timeout: 60_000 })
console.log('shell:', await text('[data-test=shell-holes]'))
check(/closed but for 1 hole/.test(await text('[data-test=shell-holes]')), 'Shell says the part is closed but for a hole')
check(Boolean(await page.$('[data-test=shell-thicken-anyway]')), 'and offers to thicken it as it is')
await page.screenshot({ path: shotPath('mesh-shell-holes.png') })
await page.click('[data-test=shell-fill-first]')
await page.waitForSelector('[data-test=holes-tool]')
check(true, 'Fill holes first takes the tool there')

// ---- Cut open and thickened into a solid --------------------------------------------------
await page.click('[data-test=mesh-tool-cut]')
await page.waitForSelector('[data-test=cut-tool]')
await page.click('[data-test=cut-cap]')
await page.waitForSelector('[data-test=cut-scan]:not([disabled])')
await page.click('[data-test=cut-scan]')
await editsReach(4)
await page.click('[data-test=mesh-tool-shell]')
await page.waitForSelector('[data-test=shell-open]', { timeout: 60_000 })
console.log('shell:', await text('[data-test=shell-open]'))
check(true, 'Shell sees an open surface, and offers to thicken it')
check(Boolean(await page.$('[data-test=shell-side-in][aria-checked=true]')), 'inward to start')
await setField('[data-test=shell-thickness]', 1)
check(/Thicken 1 mm inward/.test(await text('[data-test=shell-run]')), 'the button says how thick and which way')
await page.click('[data-test=shell-run]')
await editsReach(5)
const thickened = await text('.strip .msg')
console.log('thickened:', thickened)
check(/Thickened 1 mm inward/.test(thickened), 'the status line says it was thickened')
check(await closedNow(), 'the thickened part is closed')
await page.screenshot({ path: shotPath('mesh-shell-thickened.png') })

// ---- back to the scan as it was opened -----------------------------------------------------
for (let i = 0; i < 20 && (await page.$('[data-test=edited-copy]')); i++) await step('KeyZ', 'Undone')
check(!(await page.$('[data-test=edited-copy]')), 'stepping back through it all leaves no copy')
check((await scanCount()) === opened, 'and the scan as it was opened')

await finish(browser, consoleErrors)
