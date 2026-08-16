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
import {
  ballCandidates,
  canvasRect,
  check,
  click,
  finish,
  launchApp,
  loadScan,
  pixelDiff,
  previewReady,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const BALL_DIAMETER = 15.92 // GOM reference, both balls of the bar

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

const markedCount = () =>
  page
    .$eval('[data-test="paint-count"]', (e) => parseInt(e.textContent.replace(/[^\d]/g, ''), 10))
    .catch(() => 0)
// No draft-status watching here: while marking, an empty status only means
// nothing is marked yet, not that the fit gave up.
const paintPreviewReady = () => previewReady(page, { tries: 80, watchStatus: false })

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

await click(page, '[data-test="fit-sphere"]')
await page.waitForSelector('[data-test="draft-select-mode"]')
await page.select('[data-test="draft-select-mode"]', 'paint')

// The same scheme as the local fine fit: the tools come out in Navigate, so a
// plain drag is still the camera's until a gesture is picked.
await page.waitForSelector('[data-test="mark-gestures"]')
check(
  await page.$eval('[data-test="mark-navigate"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'the marking tools open in Navigate',
)
await click(page, '[data-test="mark-brush"]')
await page.waitForSelector('[data-test="mark-brush-diameter"]')
// A brush a little smaller than the ball marks a cap in one stroke.
await page.$eval('[data-test="mark-brush-diameter"]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '10')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(150)

// Same sweep as the smoke test, minus the far end: one marked ball is enough.
let hit = null
for (const [x, y] of ballCandidates(rect, { nears: [0.1, 0.14, 0.18, 0.06, 0.23] })) {
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
check(await paintPreviewReady(), 'the fit follows the marked surface')

const shot = () => page.screenshot({ encoding: 'base64' })

// Control first: two frames with nothing happening bound the repaint noise, so
// "the picture changed" below means the ring or the camera, not screenshot
// noise. Without this, comparing frames for plain inequality passes on any
// stray pixel.
await page.mouse.move(rect.x + 30, rect.y + rect.h - 30) // park off the part
await sleep(250)
const idleShot = await shot()
await sleep(250)
const idleNoise = await pixelDiff(page, idleShot, await shot())
check(idleNoise < 0.05, `an untouched viewport repaints identically (${idleNoise.toFixed(3)}% differ)`)
// Anything the ring checks call a change must clear the measured idle noise.
const RING_THRESHOLD = idleNoise + 0.01

// The brush footprint is drawn on the part under the cursor: moving the
// cursor over the scan has to change the picture even though nothing else
// about the scene did, and taking the cursor off the part has to take it away.
//
// Both comparisons are against the same on-part frame on purpose. The ring is
// flat where the ball is not, so away from the silhouette it sinks inside the
// surface and is hidden — two frames with the cursor at different places on the
// ball can therefore both be ringless, and comparing them would prove nothing.
await page.mouse.move(hit[0], hit[1])
await sleep(250)
const ringHere = await shot()
await page.mouse.move(hit[0] + 10, hit[1] + 6)
await sleep(250)
const ringMoved = await pixelDiff(page, ringHere, await shot())
await page.mouse.move(rect.x + 30, rect.y + rect.h - 30) // off the part
await sleep(250)
const ringOff = await pixelDiff(page, ringHere, await shot())
check(
  ringMoved > RING_THRESHOLD,
  `the brush footprint follows the cursor over the part (${ringMoved.toFixed(3)}% > ${RING_THRESHOLD.toFixed(3)}% idle)`,
)
check(
  ringOff > RING_THRESHOLD,
  `the brush footprint goes away off the part (${ringOff.toFixed(3)}% > ${RING_THRESHOLD.toFixed(3)}% idle)`,
)

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

check(await paintPreviewReady(), 'the fit is still ready after editing the marking')

// The camera is still reachable while the brush has the plain left-drag: in a
// scheme that orbits with the left button, Shift+left-drag orbits instead —
// and orbiting must not mark anything. An orbit repaints a large share of the
// viewport, far above the idle-noise threshold.
const beforeOrbit = await shot()
const markedBeforeOrbit = await markedCount()
await page.keyboard.down('Shift')
await page.mouse.move(hit[0], hit[1] + 120)
await page.mouse.down()
for (let i = 1; i <= 8; i++) await page.mouse.move(hit[0] + i * 14, hit[1] + 120)
await page.mouse.up()
await page.keyboard.up('Shift')
await sleep(400)
const orbitDiff = await pixelDiff(page, beforeOrbit, await shot())
check(
  orbitDiff > Math.max(RING_THRESHOLD, 0.5),
  `Shift-drag still orbits while the brush is armed (${orbitDiff.toFixed(2)}% repainted)`,
)
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
const beforeIdle = await shot()
await stroke(hit[0], hit[1] + 120)
check((await markedCount()) === markedBeforeOrbit, 'a plain drag marks nothing once it stands down')
const idleDragDiff = await pixelDiff(page, beforeIdle, await shot())
check(
  idleDragDiff > Math.max(RING_THRESHOLD, 0.5),
  `and drives the camera instead (${idleDragDiff.toFixed(2)}% repainted)`,
)

const markedAtCreate = await markedCount()
await click(page, '[data-test="create-element"]')
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

// Re-opening a hand-marked element puts its surface back on the part, under
// the same tools it was laid down with — so changing it is more marking, not a
// fresh start.
await click(page, '[data-test="edit-element"]')
await page.waitForSelector('[data-test="mark-gestures"]', { timeout: 10_000 })
check(
  (await page.$eval('[data-test="draft-select-mode"]', (e) => e.value)) === 'paint',
  're-opening a marked element comes back in "Marked by hand"',
)
const reopened = await markedCount()
check(
  reopened === markedAtCreate,
  `the marking comes back with it (${markedAtCreate} → ${reopened} points)`,
)
check(await paintPreviewReady(), 'and the fit stands on it without another stroke')
// In Navigate, like every other way the tools come out: the marking is back on
// the part, but the mouse is still the camera's until a tool is picked up.
check(
  await page.$eval('[data-test="mark-navigate"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'the restored tools open in Navigate',
)
await click(page, '[data-test="mark-brush"]')
await stroke(hit[0] + 14, hit[1] + 10)
check((await markedCount()) > reopened, 'a stroke adds to the restored marking')
check(await paintPreviewReady(), 'and the fit follows it')
await click(page, '[data-test="create-element"]')
await sleep(400)
const editedRows = await page.$$eval('[data-test="element-row"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
)
check(editedRows.length === 1, `saving the edit replaced the element (${editedRows.length} rows)`)
const edited = parseFloat((editedRows[0].match(/(\d+\.\d+)/) ?? [])[1] ?? 'NaN')
check(
  Math.abs(edited - BALL_DIAMETER) < 0.4,
  `the re-fitted element still reads the ball: ${edited} mm`,
)
check(
  (await page.$('[data-test="mark-gestures"]')) === null,
  'the marking tools are put away again once it is saved',
)

await click(page, '[data-test="toggle-backfaces"]')
await sleep(400)
await page.screenshot({ path: shotPath('e2e-paint.png') })
check(
  await page.$eval('[data-test="toggle-backfaces"]', (e) => e.getAttribute('aria-pressed') === 'true'),
  'back-face tint switches on',
)
await click(page, '[data-test="toggle-backfaces"]')
await sleep(300)

await finish(browser, consoleErrors)
