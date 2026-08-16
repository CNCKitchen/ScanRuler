// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the wall thickness workspace: drives the real app
// in headless Chrome — switches workspace, loads a scan from the stage,
// measures the thickness, and exercises the scale, the histogram, the hover
// reading and pinning.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-thickness.mjs
// Env: CHROME (chrome.exe path), APP_URL, SCAN, SHOT_DIR.
import {
  colouredFraction,
  fail,
  finish,
  launchApp,
  loadScan,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SCAN = process.env.SCAN ?? repoFile('block-marius.stl')

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})

// ---- workspace first, then the one model it needs --------------------------
await page.click('[data-test=workspace-thickness]')
await page.waitForSelector('[data-test=start-pane]')
await page.screenshot({ path: shotPath('thickness-empty.png') })

await loadScan(page, SCAN, {
  inputSelector: '[data-test=start-scan] input[type=file]',
  timeout: 300_000,
  settle: 600,
})

// One model is all this workspace asks for, so the prompt clears entirely.
const cleared = await page.evaluate(() => !document.querySelector('[data-test=start-pane]'))
if (!cleared) fail('the stage prompt did not clear once the scan was loaded')
await page.waitForSelector('[data-test=thickness-ready-chip]')
await page.screenshot({ path: shotPath('thickness-loaded.png') })

// ---- measure ---------------------------------------------------------------
// The search is sized to the part that was just loaded.
const readNumber = (sel) => page.$eval(sel, (el) => Number(el.value))
const suggestedMax = await readNumber('[data-test=thickness-max]')
console.log(`max thickness suggested for this part: ${suggestedMax} mm`)
if (!(suggestedMax > 0)) fail('no search limit was suggested for the loaded part')

const started = Date.now()
await page.click('[data-test=measure-thickness]')
await page.waitForSelector('[data-test=thickness-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(700)
console.log(`measured in ${((Date.now() - started) / 1000).toFixed(1)} s`)

const stats = await page.$eval('[data-test=thickness-stats]', (el) =>
  el.textContent.replace(/([a-z%\d])([A-Z])/g, '$1 | $2'),
)
console.log('stats:', stats)
const low = await readNumber('[data-test=thickness-low]')
const high = await readNumber('[data-test=thickness-high]')
console.log(`scale: ${low} … ${high} mm`)
if (!(high > low && high > 0)) fail(`the suggested scale ${low}…${high} is not a usable range`)
await page.screenshot({ path: shotPath('thickness-map.png') })

const coloured = await colouredFraction(page)
console.log(`coloured stage: ${(coloured * 100).toFixed(1)} %`)
if (coloured < 0.05) fail('the thickness map does not appear to be painted on the scan')

// ---- scale controls --------------------------------------------------------
await page.click('[data-test=toggle-thickness-histogram]')
await page.waitForSelector('[data-test=thickness-histogram]')
const bars = await page.$$eval('[data-test=thickness-histogram] span', (els) =>
  els.filter((e) => parseFloat(e.style.width) > 0).length,
)
console.log(`histogram bins with counts: ${bars}`)
if (bars < 3) fail('histogram is empty')

// The field commits on blur, and blur only fires on an element that had the
// focus — so this types the way a person does rather than poking the value in.
const setField = async (sel, value) => {
  await page.click(sel)
  // A number input ignores select() and triple-click, so clear it the way a
  // person would.
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.type(sel, String(value))
  await page.$eval(sel, (el) => el.blur())
  await sleep(400)
}
await setField('[data-test=thickness-high]', (high * 0.6).toFixed(2))
const tightened = await readNumber('[data-test=thickness-high]')
console.log(`thick end: ${high} -> ${tightened}`)
if (!(tightened < high)) fail('the thick end of the scale did not take a new value')
// A committed scale is the user's, and survives the next measurement.
await page.click('[data-test=measure-thickness]')
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(500)
if ((await readNumber('[data-test=thickness-high]')) !== tightened) {
  fail('re-measuring threw away the scale the user had dialled in')
}
await page.screenshot({ path: shotPath('thickness-tight-scale.png') })

// ---- hover reading and pinning --------------------------------------------
const stage = await page.$eval('.viewslot canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
let reading = null
let pinAt = null
// A map may legitimately have unmeasured patches, and a ray can always miss
// the part entirely, so this walks a grid until a reading turns up.
const SPOTS = []
for (const fx of [0.35, 0.45, 0.55, 0.65, 0.3, 0.7]) {
  for (const fy of [0.35, 0.5, 0.25, 0.65]) SPOTS.push([fx, fy])
}
for (const [fx, fy] of SPOTS) {
  const at = { x: stage.x + stage.w * fx, y: stage.y + stage.h * fy }
  await page.mouse.move(at.x, at.y)
  await sleep(250)
  reading = await page
    .$eval('[data-test=hover-readout]', (el) => el.textContent)
    .catch(() => null)
  if (reading) {
    pinAt = at
    break
  }
}
console.log('hover reading:', reading)
if (!reading || !/mm/.test(reading)) fail('no thickness reading appeared on hover')

await page.mouse.click(pinAt.x, pinAt.y)
await sleep(350)
const pinned = await page.$$eval('[data-test=thickness-probe-row]', (els) =>
  els.map((e) => e.textContent),
)
console.log('pinned:', pinned)
if (pinned.length !== 1) fail(`expected one pinned reading, got ${pinned.length}`)
await page.screenshot({ path: shotPath('thickness-pin.png') })

// ---- the cone, the sphere, and back to the other workspaces ----------------
const summarise = () =>
  page.$eval('[data-test=thickness-stats]', (el) =>
    el.textContent.replace(/([a-z%\d])([A-Z])/g, '$1 | $2').slice(0, 70),
  )
await page.select('[data-test=thickness-rays]', '6')
await page.click('[data-test=measure-thickness]')
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(600)
console.log('after the cone: ', await summarise())
await page.screenshot({ path: shotPath('thickness-cone.png') })

const sphereStarted = Date.now()
await page.select('[data-test=thickness-method]', 'sphere')
// The cone controls belong to the ray method and stand down with it.
if (await page.$('[data-test=thickness-rays]')) {
  fail('the ray settings are still offered after switching to the sphere method')
}
await page.click('[data-test=measure-thickness]')
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 600_000,
})
await sleep(600)
console.log(`sphere measured in ${((Date.now() - sphereStarted) / 1000).toFixed(1)} s`)
console.log('by sphere:    ', await summarise())
await page.screenshot({ path: shotPath('thickness-sphere.png') })

await page.click('[data-test=workspace-elements]')
await page.waitForSelector('[data-test=fit-sphere]')
await sleep(400)
await page.screenshot({ path: shotPath('thickness-back-to-elements.png') })

await finish(browser, consoleErrors)
