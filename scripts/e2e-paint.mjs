// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the hand-marked surface flow and the back-face tint:
// drives the real app in headless Chrome — loads ballbar.stl, switches the
// sphere draft to "Marked by hand", checks that the marking tools open in
// Navigate with the camera still holding both drags, arms the brush, drags it
// across a ball, checks that the marking grows, that the fit follows it and
// lands on the known ball diameter, and that erasing takes the marking away
// again. Finishes on the back-face toggle, which must survive a repaint without
// a WebGL error.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-paint.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const STL = process.env.STL ?? fileURLToPath(new URL('../ballbar.stl', import.meta.url))
const SHOT_DIR = process.env.SHOT_DIR ?? '.'

const BALL_DIAMETER = 15.92 // GOM reference, both balls of the bar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
  if (!ok) failed = true
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1500,950', '--no-sandbox'],
  defaultViewport: { width: 1500, height: 950 },
})

const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(APP_URL, { waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')

const input = await page.$('input[type=file]')
await input.uploadFile(STL)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 120_000 },
)
console.log('loaded:', await page.$eval('.file-info', (el) => el.textContent))
await sleep(800)

const rect = await page.$eval('.viewport canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})

const click = async (sel) => {
  await page.waitForSelector(sel, { timeout: 10_000 })
  await page.click(sel)
}
const markedCount = () =>
  page
    .$eval('[data-test="paint-count"]', (e) => parseInt(e.textContent.replace(/[^\d]/g, ''), 10))
    .catch(() => 0)
const previewReady = async () => {
  for (let i = 0; i < 80; i++) {
    if (await page.$('[data-test="create-element"]:not([disabled])')) return true
    await sleep(250)
  }
  return false
}

/** A short stroke centred on (x, y): press, wiggle, release. The right button
 *  rubs out, the left lays down. */
async function stroke(x, y, { button = 'left' } = {}) {
  await page.mouse.move(x - 10, y - 6)
  await page.mouse.down({ button })
  for (const [dx, dy] of [[-4, -2], [2, 2], [8, 4], [12, -2], [6, -6]]) {
    await page.mouse.move(x + dx, y + dy)
    await sleep(16)
  }
  await page.mouse.up({ button })
  await sleep(250)
}

// Same sweep as the smoke test: the bar is framed broadside, so try both
// screen axes inward from one end until a stroke actually lands on a ball.
function candidates() {
  const out = []
  for (const near of [0.1, 0.14, 0.18, 0.06, 0.23]) {
    for (const off of [0.5, 0.44, 0.56, 0.38, 0.62]) {
      out.push([rect.x + rect.w * off, rect.y + rect.h * near])
      out.push([rect.x + rect.w * near, rect.y + rect.h * off])
    }
  }
  return out
}

await click('[data-test="fit-sphere"]')
await page.waitForSelector('[data-test="draft-select-mode"]')
await page.select('[data-test="draft-select-mode"]', 'paint')

// The same scheme as the local fine fit: the tools come out in Navigate, so a
// plain drag is still the camera's until a gesture is picked.
await page.waitForSelector('[data-test="mark-gestures"]')
check(
  await page.$eval('[data-test="mark-navigate"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'the marking tools open in Navigate',
)
await click('[data-test="mark-brush"]')
await page.waitForSelector('[data-test="mark-brush-diameter"]')
// A brush a little smaller than the ball marks a cap in one stroke.
await page.$eval('[data-test="mark-brush-diameter"]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '10')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(150)

let hit = null
for (const [x, y] of candidates()) {
  await stroke(x, y)
  if ((await markedCount()) > 0) {
    hit = [x, y]
    break
  }
}
check(hit !== null, 'a stroke on the scan marks surface')
if (!hit) {
  await browser.close()
  process.exit(1)
}

const afterFirst = await markedCount()
console.log('marked after one stroke:', afterFirst)
check(await previewReady(), 'the fit follows the marked surface')

// The brush footprint is drawn on the part under the cursor: moving the
// cursor over the scan has to change the picture even though nothing else
// about the scene did, and taking the cursor off the part has to take it away.
//
// Both comparisons are against the same on-part frame on purpose. The ring is
// flat where the ball is not, so away from the silhouette it sinks inside the
// surface and is hidden — two frames with the cursor at different places on the
// ball can therefore both be ringless, and comparing them would prove nothing.
const shot = () => page.screenshot({ encoding: 'base64' })
await page.mouse.move(hit[0], hit[1])
await sleep(250)
const ringHere = await shot()
await page.mouse.move(hit[0] + 10, hit[1] + 6)
await sleep(250)
const ringMoved = await shot()
await page.mouse.move(rect.x + 30, rect.y + rect.h - 30) // off the part
await sleep(250)
const ringOff = await shot()
check(ringHere !== ringMoved, 'the brush footprint follows the cursor over the part')
check(ringHere !== ringOff, 'the brush footprint goes away off the part')

const value = await page.$eval('[data-test="draft-status"]', (e) =>
  e.textContent.replace(/\s+/g, ' ').trim(),
)
console.log('preview:', value)
const measured = parseFloat((value.match(/(\d+\.\d+)/) ?? [])[1] ?? 'NaN')
check(
  Math.abs(measured - BALL_DIAMETER) < 0.4,
  `marked-surface fit reads ${measured} mm (ball is ${BALL_DIAMETER} mm)`,
)

// A second stroke beside the first adds to the marking rather than replacing
// it, and the right button takes it away again.
await stroke(hit[0] + 14, hit[1] + 10)
const afterSecond = await markedCount()
check(afterSecond > afterFirst, `a second stroke adds to the marking (${afterFirst} → ${afterSecond})`)
await stroke(hit[0] + 14, hit[1] + 10, { button: 'right' })
const afterErase = await markedCount()
check(afterErase < afterSecond, `right-drag rubs the marking out (${afterSecond} → ${afterErase})`)

check(await previewReady(), 'the fit is still ready after editing the marking')

// The camera is still reachable while the brush has the plain left-drag: in a
// scheme that orbits with the left button, Shift+left-drag orbits instead —
// and orbiting must not mark anything.
const view = () => page.screenshot({ encoding: 'base64' })
const beforeOrbit = await view()
const markedBeforeOrbit = await markedCount()
await page.keyboard.down('Shift')
await page.mouse.move(hit[0], hit[1] + 120)
await page.mouse.down()
for (let i = 1; i <= 8; i++) await page.mouse.move(hit[0] + i * 14, hit[1] + 120)
await page.mouse.up()
await page.keyboard.up('Shift')
await sleep(400)
check((await view()) !== beforeOrbit, 'Shift-drag still orbits while the brush is armed')
check((await markedCount()) === markedBeforeOrbit, 'orbiting marks nothing')

// Escape backs out one step at a time, the same way it does in the local fine
// fit: the first hands the camera back and leaves both the draft and its
// marking standing.
await page.keyboard.press('Escape')
await sleep(250)
check(
  await page.$eval('[data-test="mark-navigate"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'Escape stands the gesture down instead of discarding the element',
)
check((await markedCount()) === markedBeforeOrbit, 'and leaves the marking alone')

// …and with no gesture live, a plain drag is the camera's again — the whole
// point of porting Navigate over from the local fine fit.
const beforeIdle = await view()
await stroke(hit[0], hit[1] + 120)
check((await markedCount()) === markedBeforeOrbit, 'a plain drag marks nothing once it stands down')
check((await view()) !== beforeIdle, 'and drives the camera instead')

await click('[data-test="create-element"]')
await page.waitForSelector('[data-test="element-row"]', { timeout: 10_000 })
const row = await page.$eval('[data-test="element-row"]', (e) =>
  e.textContent.replace(/\s+/g, ' ').trim(),
)
console.log('element:', row)
const created = parseFloat((row.match(/(\d+\.\d+)/) ?? [])[1] ?? 'NaN')
check(Math.abs(created - BALL_DIAMETER) < 0.4, `element created from the marked surface: ${created} mm`)

// The tools are put away with the draft, so a plain drag orbits again.
check(
  (await page.$('[data-test="mark-gestures"]')) === null,
  'the marking tools are put away once the element is created',
)

await click('[data-test="toggle-backfaces"]')
await sleep(400)
await page.screenshot({ path: `${SHOT_DIR}/e2e-paint.png` })
check(
  await page.$eval('[data-test="toggle-backfaces"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'back-face tint switches on',
)
await click('[data-test="toggle-backfaces"]')
await sleep(300)

const filteredErrors = consoleErrors.filter((e) => !e.includes('favicon'))
console.log('console errors:', filteredErrors.length ? JSON.stringify(filteredErrors) : 'none')
check(filteredErrors.length === 0, 'no console errors')

await browser.close()
if (failed) process.exitCode = 1
