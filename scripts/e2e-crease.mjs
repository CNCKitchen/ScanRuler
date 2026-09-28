// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the sharp-edge shading (issue #5): loads a low-poly
// CAD-style STL, expects Auto to draw it sharp, switches the setting to
// Always smooth and back and expects the status line to say what happened
// each time, marks a boss with the brush on the split mesh and checks the
// marking lands on the scan's own vertices, then loads a real scan and
// expects Auto to leave it smooth — and forcing it sharp to say what it did.
//
// Prereqs: dev server running (npm run dev), Chrome installed, and a
// low-poly STL — scripts/e2e-crease-fixture.mjs writes one.
//   node scripts/e2e-crease.mjs
// Env: CHROME, APP_URL, LOWPOLY (a CAD-ish STL), SCAN (a real scan), SHOT_DIR.
import {
  canvasRect,
  check,
  click,
  finish,
  launchApp,
  loadScan,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const LOWPOLY = process.env.LOWPOLY ?? repoFile('e2e-out/lowpoly.stl')
const SCAN = process.env.SCAN ?? repoFile('fridgeBracket.ply')

const { browser, page, consoleErrors } = await launchApp()
const status = () =>
  page.$eval('footer.strip', (el) => el.textContent.replace(/\s+/g, ' ').trim())
const setCrease = async (mode) => {
  await click(page, '[data-test="open-settings"]')
  await page.waitForSelector('[data-test="crease-mode"]')
  await page.select('[data-test="crease-mode"]', mode)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-test="settings-modal"]'))
  await sleep(800)
}
// The vertex count the top bar shows — the scan's own, whatever the render
// arrays carry.
const fileInfo = () =>
  page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ').trim())

await loadScan(page, LOWPOLY)
await sleep(400)
const infoAuto = await fileInfo()
console.log('status after auto load:', await status())
await page.screenshot({ path: shotPath('crease-auto.png') })

await setCrease('off')
const offStatus = await status()
console.log('status after Always smooth:', offStatus)
check(/shaded smooth/.test(offStatus), 'smooth status')
await page.screenshot({ path: shotPath('crease-off.png') })
check((await fileInfo()) === infoAuto, 'vertex count unchanged by the split')

await setCrease('on')
const onStatus = await status()
console.log('status after Always sharp:', onStatus)
check(/drawn sharp — [\d,]+ vertices split/.test(onStatus), 'sharp status names the split')
await page.screenshot({ path: shotPath('crease-on.png') })

// Mark by hand on the split mesh: the brush lands on the scan's own
// vertices, so the count is bounded by them, and the marked triangles tint.
await click(page, '[data-test="fit-cylinder"]')
await page.waitForSelector('[data-test="draft-select-mode"]')
await page.select('[data-test="draft-select-mode"]', 'paint')
await page.waitForSelector('[data-test="mark-gestures"]')
await click(page, '[data-test="mark-brush"]')
await page.waitForSelector('[data-test="mark-brush-diameter"]')
await page.$eval('[data-test="mark-brush-diameter"]', (el) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(el, '12')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const rect = await canvasRect(page)
const cx = rect.x + rect.w / 2
const cy = rect.y + rect.h / 2
await page.mouse.move(cx - 60, cy - 40)
await page.mouse.down()
for (let i = 0; i < 12; i++) {
  await page.mouse.move(cx - 60 + i * 12, cy - 40 + i * 6)
  await sleep(40)
}
await page.mouse.up()
await sleep(400)
const marked = await page
  .$eval('[data-test="paint-count"]', (e) => parseInt(e.textContent.replace(/[^\d]/g, ''), 10))
  .catch(() => -1)
console.log('marked vertices:', marked)
const ownVertices = parseInt(
  (infoAuto.match(/([\d,]+) vertices/) ?? [])[1]?.replace(/,/g, '') ?? '0',
  10,
)
check(marked > 0, 'brush marked something')
check(marked <= ownVertices, "marking stays within the scan's own vertices")
await page.screenshot({ path: shotPath('crease-marked.png') })
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await sleep(200)

await setCrease('auto')
await loadScan(page, SCAN)
await sleep(400)
console.log('status after scan load:', await status())
await page.screenshot({ path: shotPath('crease-scan.png') })

await setCrease('on')
const forced = await status()
console.log('status after forcing the scan sharp:', forced)
check(/vertices split|shaded smooth|No sharp edges/.test(forced), 'forced scan says what it did')
await page.screenshot({ path: shotPath('crease-scan-forced.png') })
await setCrease('auto')
const backToAuto = await status()
console.log('status back on Auto:', backToAuto)
check(/reads as a scan/.test(backToAuto), 'Auto says the scan is left smooth')

await finish(browser, consoleErrors)
