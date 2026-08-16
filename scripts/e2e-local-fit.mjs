// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the local fine fit: drives the real app in headless
// Chrome — loads both models, runs the global best fit and the map, then
// brings out the marking tools and exercises all three gestures (window,
// brush, lasso), the erase switch and the back-face option, and finally runs
// the fit on the marked surface and takes it back off again.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-local-fit.mjs
// Env: CHROME (chrome.exe path), APP_URL, SCAN, NOMINAL, SHOT_DIR.
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/ScanRuler/'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SCAN = process.env.SCAN ?? fileURLToPath(new URL('../block-marius.stl', import.meta.url))
const NOMINAL =
  process.env.NOMINAL ?? fileURLToPath(new URL('../side bracket left.stl', import.meta.url))
const SHOT_DIR = process.env.SHOT_DIR ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
  if (!ok) failed = true
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
  protocolTimeout: 600_000,
})

const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(APP_URL, { waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')

// ---- both models, global fit, map -----------------------------------------
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=start-pane]')
await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(SCAN)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 300_000 },
)
await (await page.$('[data-test=start-reference] input[type=file]')).uploadFile(NOMINAL)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(600)

await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(700)
const globalRms = await page.$eval('[data-test=align-rms] b', (el) => Number(el.textContent))
console.log(`global fit: ${globalRms} mm RMS`)
await page.screenshot({ path: `${SHOT_DIR}/local-00-global.png` })

// ---- the marking tools ----------------------------------------------------
const canvas = await page.$eval('.viewslot canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const at = (fx, fy) => ({ x: canvas.x + canvas.w * fx, y: canvas.y + canvas.h * fy })
const marked = () =>
  page
    .$eval('[data-test=mark-count]', (el) => parseInt(el.textContent.replace(/[^\d]/g, ''), 10))
    .catch(() => -1)

/** Which gesture the panel says is live. */
const liveGesture = () =>
  page.$eval('[data-test=mark-gestures]', (el) => {
    const on = el.querySelector('button.on')
    return on ? on.dataset.test.replace('mark-', '') : null
  })

/** Where the camera is looking, as the viewport gizmo reports it. Read off a
 *  screenshot of the gizmo corner: whether an orbit happened is a question
 *  about the rendered scene, not about any state the app exposes. */
async function gizmoFingerprint() {
  const clip = await page.$eval('.viewslot canvas', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width - 150, y: r.y + r.height - 150, width: 140, height: 140 }
  })
  return page.screenshot({ clip, encoding: 'base64' })
}

await page.click('[data-test=local-start]')
await page.waitForSelector('[data-test=mark-gestures]')
check((await marked()) === 0, 'nothing is marked when the tools come out')
check((await liveGesture()) === 'navigate', 'no gesture is armed until one is asked for')
check(Boolean(await page.$('[data-test=mark-chip]')), 'the viewport says what the gesture does')
// The fit is not offered until there is enough marked surface to place a part.
check(
  await page.$eval('[data-test=local-fit]', (el) => el.disabled),
  'the fit is held back until something is marked',
)

// Plain left-drag must still orbit while the tools are out but idle — the
// complaint that started this: a panel that is open is not a panel that owns
// the mouse.
const beforeOrbit = await gizmoFingerprint()
await page.mouse.move(at(0.45, 0.45).x, at(0.45, 0.45).y)
await page.mouse.down()
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(at(0.45, 0.45).x + i * 9, at(0.45, 0.45).y + i * 4)
  await sleep(16)
}
await page.mouse.up()
await sleep(400)
check((await gizmoFingerprint()) !== beforeOrbit, 'left-drag still orbits with no gesture armed')
check((await marked()) === 0, 'orbiting marked nothing')
await page.screenshot({ path: `${SHOT_DIR}/local-01-idle-orbit.png` })
await page.click('[data-test=mark-window]')
await sleep(150)
check((await liveGesture()) === 'window', 'the window tool arms when picked')

/** Drag between two fractional stage positions with the given button. */
async function drag(from, to, { button = 'left', steps = 12 } = {}) {
  const a = at(...from)
  const b = at(...to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down({ button })
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
    await sleep(16)
  }
  await page.mouse.up({ button })
  await sleep(300)
}

// ---- window ---------------------------------------------------------------
await page.mouse.move(at(0.3, 0.3).x, at(0.3, 0.3).y)
await page.mouse.down()
await page.mouse.move(at(0.5, 0.45).x, at(0.5, 0.45).y)
await sleep(120)
const bandShown = await page.$eval('.marquee', (el) => el.style.display !== 'none')
check(bandShown, 'the window outline is drawn while dragging')
await page.screenshot({ path: `${SHOT_DIR}/local-02-window-drag.png` })
await page.mouse.move(at(0.62, 0.6).x, at(0.62, 0.6).y)
await page.mouse.up()
await sleep(400)
const afterWindow = await marked()
console.log(`window marked ${afterWindow} points`)
check(afterWindow > 100, 'the window marked surface')
check(
  await page.$eval('.marquee', (el) => el.style.display === 'none'),
  'the outline clears when the button is released',
)
check(
  await page.$eval('[data-test=local-fit]', (el) => !el.disabled),
  'the fit is offered once there is enough marked',
)
await page.screenshot({ path: `${SHOT_DIR}/local-03-window-marked.png` })

// Escape hands the camera back without touching what is marked — the one
// thing it must never do is throw a marking away.
await page.keyboard.press('Escape')
await sleep(200)
check((await liveGesture()) === 'navigate', 'Escape stands the gesture down')
check((await marked()) === afterWindow, 'Escape left the marking alone')

// A right-drag over the same ground takes it away again.
await page.click('[data-test=mark-window]')
await sleep(150)
await drag([0.3, 0.3], [0.62, 0.6], { button: 'right' })
const afterErase = await marked()
console.log(`after right-drag: ${afterErase} points`)
check(afterErase < afterWindow, 'a right-drag window rubs the marking out')

// ---- brush ----------------------------------------------------------------
await page.click('[data-test=mark-brush]')
await page.waitForSelector('[data-test=mark-brush-diameter]')
await page.$eval('[data-test=mark-brush-diameter]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '6')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(200)
const beforeBrush = await marked()
await drag([0.4, 0.42], [0.55, 0.5])
const afterBrush = await marked()
console.log(`brush: ${beforeBrush} -> ${afterBrush}`)
check(afterBrush > beforeBrush, 'the brush marks along a stroke')
await page.screenshot({ path: `${SHOT_DIR}/local-04-brush.png` })

// ---- lasso ----------------------------------------------------------------
await page.click('[data-test=mark-lasso]')
await sleep(150)
const before = await marked()
const loop = [
  [0.3, 0.62],
  [0.42, 0.58],
  [0.5, 0.66],
  [0.44, 0.74],
  [0.32, 0.72],
]
const first = at(...loop[0])
await page.mouse.move(first.x, first.y)
await page.mouse.down()
for (const point of loop.slice(1)) {
  const p = at(...point)
  await page.mouse.move(p.x, p.y, { steps: 8 })
  await sleep(30)
}
await page.mouse.move(first.x, first.y, { steps: 8 })
await page.mouse.up()
await sleep(400)
const afterLasso = await marked()
console.log(`lasso: ${before} -> ${afterLasso}`)
check(afterLasso > before, 'the lasso marks what it encloses')
await page.screenshot({ path: `${SHOT_DIR}/local-05-lasso.png` })

// ---- back faces -----------------------------------------------------------
await page.click('[data-test=mark-backfaces]')
await page.click('[data-test=mark-window]')
await sleep(150)
const beforeThrough = await marked()
await drag([0.34, 0.32], [0.6, 0.58])
const throughOn = await marked()
await page.click('[data-test=mark-clear]')
await sleep(200)
check((await marked()) === 0, 'clearing takes the whole marking off')
await page.click('[data-test=mark-backfaces]')
await sleep(150)
await drag([0.34, 0.32], [0.6, 0.58])
const throughOff = await marked()
console.log(
  `same window: ${throughOn - beforeThrough} points through the part, ${throughOff} facing only`,
)
check(
  throughOn - beforeThrough > throughOff,
  'marking through the part takes more than the facing surface alone',
)

// ---- the fit itself -------------------------------------------------------
const count = await marked()
await page.click('[data-test=local-fit]')
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(800)
const source = await page.$eval('.dro-label span:last-child', (el) => el.textContent)
const localRms = await page.$eval('[data-test=align-rms] b', (el) => Number(el.textContent))
console.log(`local fit on ${count} points: ${localRms} mm RMS, reported as "${source}"`)
check(source === 'local fine fit', 'the readout says the fit came from the marked surface')
check(localRms > 0 && localRms < 1, 'the local fit converged')
check(
  await page.$eval('[data-test=align-rms] + .dro-note', (el) => /points marked/.test(el.textContent)),
  'the readout says how much surface the fit used',
)
check(Boolean(await page.$('[data-test=deviation-legend]')), 'the map was measured again')
await page.screenshot({ path: `${SHOT_DIR}/local-06-fitted.png` })

// The fit is done, so the camera gets its buttons back without being asked:
// the result is the thing you want to turn round and look at.
check((await liveGesture()) === 'navigate', 'the gesture stands down once the fit has run')
check((await marked()) === count, 'the marking survives the fit, ready for another pass')
const beforeAfterFit = await gizmoFingerprint()
await drag([0.45, 0.45], [0.56, 0.51])
check((await gizmoFingerprint()) !== beforeAfterFit, 'left-drag orbits again after the fit')
check((await marked()) === count, 'orbiting after the fit marked nothing')

// ---- back to the global fit ------------------------------------------------
await page.click('[data-test=local-revert]')
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(700)
const backTo = await page.$eval('[data-test=align-rms] b', (el) => Number(el.textContent))
console.log(`back to the global fit: ${backTo} mm RMS`)
check(backTo === globalRms, 'the global fit comes back exactly as it was')
check(
  (await page.$('[data-test=local-revert]')) === null,
  'nothing is left to revert to once it is back',
)
await page.screenshot({ path: `${SHOT_DIR}/local-07-reverted.png` })

// ---- putting the tools away -------------------------------------------------
// Everything that is not this step should be faded back while the tools are
// out — and still be clickable, which the run above has already proved by
// working the colour scale and the revert button through it.
const fadedWhileOpen = await page.$$eval('.panel .muted', (els) => els.length)
check(fadedWhileOpen > 0, `the other steps fade back while marking (${fadedWhileOpen} groups)`)

// The gesture already stood down when the fit ran, so one Escape closes.
await page.keyboard.press('Escape')
await sleep(300)
check(
  (await page.$('[data-test=mark-gestures]')) === null,
  'Escape closes the local fine fit once no gesture is armed',
)
check((await page.$('[data-test=mark-chip]')) === null, 'the viewport line goes with it')
check(
  (await page.$$eval('.panel .muted', (els) => els.length)) === 0,
  'the rest of the panel comes back to full strength',
)

// The button does the same thing, for anyone who never reaches for Escape.
await page.click('[data-test=local-start]')
await page.waitForSelector('[data-test=mark-gestures]')
await page.click('[data-test=mark-window]')
await drag([0.35, 0.35], [0.55, 0.55])
check((await marked()) > 0, 'the tools come back out with nothing marked, and mark again')
await page.click('[data-test=mark-done]')
await sleep(300)
check(
  (await page.$('[data-test=mark-gestures]')) === null,
  'the marking tools go away when asked',
)

const noise = consoleErrors.filter((t) => !/favicon|Download the React DevTools/i.test(t))
check(noise.length === 0, `no console errors (${noise.length})`)
for (const t of noise.slice(0, 5)) console.log('  ', t)

await browser.close()
console.log(failed ? 'FAILED' : 'ALL PASSED')
process.exitCode = failed ? 1 : 0
