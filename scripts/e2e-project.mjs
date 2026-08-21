// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end project round trip: load ballbar.stl, fit both balls, dimension
// them, save the session as a .scanruler through the top bar, reload the page
// and open that file again — the rows, the dimension value and the file name
// have to come back exactly, and the archive has to be smaller than the STL.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-project.mjs
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  fitBall,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')
const DL_DIR = repoFile('e2e-out/project-dl')
rmSync(DL_DIR, { recursive: true, force: true })
mkdirSync(DL_DIR, { recursive: true })

const { browser, page, consoleErrors } = await launchApp()
const cdp = await browser.target().createCDPSession()
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DL_DIR,
  eventsEnabled: true,
})

await loadScan(page, STL)
const rect = await canvasRect(page)
const posA = await fitBall(page, rect, false, 1)
const posB = await fitBall(page, rect, true, 2)
if (!posA || !posB) fail('both spheres fitted')

await click(page, '[data-test="new-dimension"]')
await selectByLabel(page, '[data-test="dim-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="dim-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="add-dimension"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="add-dimension"]')
await sleep(200)

const readDims = () =>
  page.$$eval('[data-test="dimension-value"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  )
const before = { rows: await rowTexts(page), dims: await readDims() }
console.log('before:', JSON.stringify(before))
check(before.dims.length === 1, 'one dimension before saving')

// ---- save ----
await click(page, '[data-test="save-project"]')
let file = null
for (let i = 0; i < 100 && !file; i++) {
  await sleep(200)
  const done = readdirSync(DL_DIR).filter((f) => f.endsWith('.scanruler'))
  if (done.length) file = join(DL_DIR, done[0])
}
check(!!file, 'a .scanruler file was downloaded')
if (!file) await finish(browser, consoleErrors)
check(file.endsWith('ballbar.scanruler'), `named after the scan: ${file}`)
const saved = statSync(file).size
const stl = statSync(STL).size
console.log(`sizes: stl ${stl} → project ${saved}`)
check(saved < stl, 'the archive is smaller than the STL alone')
check(/Project saved/.test(await page.$eval('.strip', (el) => el.textContent)), 'status says saved')

// ---- reload and open ----
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')
check(!existsSync('nonexistent') && (await rowTexts(page)).length === 0, 'fresh session after reload')
const input = await page.$('[data-test="project-input"]')
await input.uploadFile(file)
await page.waitForFunction(
  () => /Project opened/.test(document.querySelector('.strip')?.textContent ?? ''),
  { timeout: 120_000 },
)
await sleep(800)
const after = { rows: await rowTexts(page), dims: await readDims() }
console.log('after:', JSON.stringify(after))
check(
  JSON.stringify(after.rows) === JSON.stringify(before.rows),
  'element rows come back identical',
)
check(JSON.stringify(after.dims) === JSON.stringify(before.dims), 'dimension value comes back identical')
check(
  /ballbar\.stl/.test(await page.$eval('.file-info', (el) => el.textContent)),
  'scan file name restored',
)
await page.screenshot({ path: shotPath('project-reopened.png') })

// ---- dirty guard: opening again over work asks first ----
page.once('dialog', (d) => {
  console.log('dialog:', d.message())
  void d.dismiss()
})
await input.uploadFile(file)
await sleep(1000)
check((await rowTexts(page)).length === after.rows.length, 'dismissing the confirm keeps the session')

await finish(browser, consoleErrors)
