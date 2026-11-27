// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Stretch: drives the real app in headless Chrome on a
// generated scan — the notched block, 40 long in X — opens Stretch, finds
// the arrows on the cut by the cursor they put up and drags one, which moves
// the cut and nothing else, puts 10 in at the cut and checks the part is
// drawn as the stretch will leave it,
// moves the cut with a click on the part, makes the stretch, reads the list
// of edits, steps it back with Ctrl+Z, takes a slab out instead, and checks
// Only the piece clicked is offered only where the part past the cut falls
// into more than one piece.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-stretch.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdirSync } from 'node:fs'
import { canvasRect, check, finish, launchApp, loadScan, OUT_DIR, pixelDiff, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { notchedBlockScan } from '../../../scripts/e2e-fixtures.mjs'

mkdirSync(OUT_DIR, { recursive: true })
const SCAN = notchedBlockScan()

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const field = (id) => page.$eval(`input[data-test=${id}]`, (el) => Number(el.value))
/** Where the cut is, as the panel says it: "Cut at X 20.00 mm". */
const cutAt = () => page.$eval('[data-test=stretch-cut] b', (el) => Number(el.textContent.replace(/[^0-9.-]/g, '')))
const pendingTexts = () => page.$$eval('[data-test=pending-edit]', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()))
const reachIs = (re) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-test=stretch-reach]')?.textContent ?? ''), { timeout: 60_000 }, re.source)
const editsReach = async (n) => {
  await page.waitForFunction((k) => document.querySelectorAll('[data-test=pending-edit]').length === k, { timeout: 300_000 }, n)
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(800)
}
/** Type `v` into a number field and commit it, as Enter does. */
const type = async (id, v) => {
  const sel = `input[data-test=${id}]`
  // A number field's text is not selected by a triple click: typed after
  // it, "-5" would make "0-5".
  await page.focus(sel)
  await page.$eval(sel, (el) => el.select())
  await page.type(sel, String(v))
  await page.keyboard.press('Enter')
}
const undo = async () => {
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
}
/** The stage, saved as `name` and handed back as base64 to compare. */
const stage = async (name) => {
  const r = await canvasRect(page, '.viewslot canvas')
  const clip = { x: r.x, y: r.y, width: r.w - 190, height: r.h }
  await page.screenshot({ clip, path: shotPath(`mesh-stretch-${name}`) })
  return page.screenshot({ clip, encoding: 'base64' })
}
const cursor = () => page.$eval('.viewslot canvas', (e) => e.style.cursor)

await loadScan(page, SCAN)
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=mesh-tool-stretch]')
// Seen from the front, square on: the length along X across the screen.
await page.keyboard.press('1')
await sleep(800)
const bare = await stage('0-bare.png')

await page.click('[data-test=mesh-tool-stretch]')
await page.waitForSelector('[data-test=stretch-tool]')
await page.waitForSelector('[data-test=stretch-reach]', { timeout: 60_000 })
const reach0 = await text('[data-test=stretch-reach]')
console.log(`reach before: ${reach0}`)
check(/40\.00 mm → 40\.00 mm/.test(reach0), 'the part reaches 40 along X, and nothing is stretched yet')
check((await cutAt()) === 20, 'the cut starts through the middle of the part')
check(!(await page.$('input[data-test=stretch-at]')), 'the cut is not typed: it is clicked or dragged')
check(await page.$eval('[data-test=stretch-scan]', (b) => b.disabled), 'nothing to stretch until the amount is set')

// The arrows on the cut, found by the cursor they put up about the middle
// of the stage, and one dragged along X.
const r = await canvasRect(page, '.viewslot canvas')
const mid = [r.x + (r.w - 190) / 2, r.y + r.h / 2]
let grip = null
for (let rad = 0; rad <= 200 && !grip; rad += 6) {
  for (let a = 0; a < 360; a += rad === 0 ? 360 : 15) {
    const x = mid[0] + rad * Math.cos((a * Math.PI) / 180)
    const y = mid[1] + rad * Math.sin((a * Math.PI) / 180)
    await page.mouse.move(x, y)
    await sleep(25)
    if ((await cursor()) === 'grab') {
      grip = [x, y]
      break
    }
  }
}
check(grip !== null, grip ? `an arrow on the cut lights up at ${grip.map(Math.round)}` : 'no arrow on the cut')
if (grip) {
  const before = [await cutAt(), await field('stretch-amount')]
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(grip[0] + i * 10, grip[1])
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(600)
  const after = [await cutAt(), await field('stretch-amount')]
  console.log(`dragged: cut ${before[0]} → ${after[0]}, amount ${before[1]} → ${after[1]}`)
  check(after[0] !== before[0] && after[1] === before[1], 'dragging an arrow moves the cut, and only the cut')
  await undo()
  const back = await page
    .waitForFunction(
      (b) => Number(document.querySelector('[data-test=stretch-cut] b')?.textContent.replace(/[^0-9.-]/g, '')) === b[0],
      { timeout: 30_000 },
      before,
    )
    .then(() => true, () => false)
  check(back, 'the drag is one step of the history, and Ctrl+Z puts it back')
}

await type('stretch-amount', 10)
await reachIs(/→ 50\.00/)
await sleep(600)
const preview = await stage('1-preview.png')
const shows = await pixelDiff(page, preview, bare)
console.log(`the preview changes ${shows.toFixed(1)} % of the stage`)
check(shows > 3, 'the part is drawn as the stretch will leave it, the section put in tinted')

// A click a little left of the stage's middle moves the cut there.
await page.mouse.click(mid[0] - 60, mid[1] + 40)
await page.waitForFunction(() => Number(document.querySelector('[data-test=stretch-cut] b')?.textContent.replace(/[^0-9.-]/g, '')) !== 20, { timeout: 30_000 })
const at1 = await cutAt()
console.log(`a click moved the cut to ${at1}`)
check(at1 > 0 && at1 < 20, 'the cut moves to where the part was clicked')
await reachIs(/→ 50\.00/)

await page.click('[data-test=stretch-scan]')
await editsReach(1)
const listed = (await pendingTexts())[0] ?? ''
check(listed.startsWith(`Put 10 mm in at X ${at1} mm`), `the list says so: ${listed}`)
check((await field('stretch-amount')) === 0, 'Extend by goes back to nothing once the stretch is made')
await reachIs(/50\.00 mm → 50\.00 mm/)
await stage('2-done.png')

await undo()
await editsReach(0)
await reachIs(/→ 50\.00/)
check((await field('stretch-amount')) === 10, 'Ctrl+Z brings the stretch back to the panel with the mesh')

// A slab taken out instead.
await type('stretch-amount', -5)
await reachIs(/40\.00 mm → 35\.00 mm/)
await page.click('[data-test=stretch-scan]')
await editsReach(1)
check(((await pendingTexts())[0] ?? '').startsWith('Took 5 mm out at X'), `the list says so: ${(await pendingTexts())[0]}`)
await stage('3-shortened.png')

// One piece past the cut — the block cut across X — leaves nothing to pick.
check(!(await page.$('[data-test=stretch-piece]')), 'Only the piece clicked is not offered with one piece past the cut')
// Cut across Z near the top, through the slot along it: two ridges past
// the cut, and the choice is offered — and, taken, waits for the click.
await page.select('[data-test=stretch-ref]', 'z')
await page.waitForFunction(() => /Cut at Z/.test(document.querySelector('[data-test=stretch-cut]')?.textContent ?? ''), { timeout: 30_000 })
await sleep(800)
// Seen from the front, a click a little down from the block's top edge —
// stepped down from the top of the stage until it lands — cuts through the
// slot.
await page.keyboard.press('3')
await sleep(800)
let offered = false
for (let f = 0.1; f < 0.5 && !offered; f += 0.02) {
  await page.mouse.click(mid[0], r.y + r.h * f)
  offered = await page.waitForSelector('[data-test=stretch-piece]', { timeout: 1500 }).then(() => true, () => false)
}
check(offered, 'a cut through the slot leaves two pieces past it')
console.log(`cut at Z ${await cutAt()}: two pieces past it`)
await page.click('[data-test=stretch-piece] input')
check(await page.$eval('[data-test=stretch-piece] input', (el) => el.checked), 'Only the piece clicked is offered with two pieces past the cut')
check(!(await page.$('[data-test=stretch-pick-hint]')), 'the click that placed the cut picked the piece too')

await finish(browser, consoleErrors)
