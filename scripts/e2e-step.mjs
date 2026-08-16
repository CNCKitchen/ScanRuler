// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the STEP reference: drives the real app in
// headless Chrome with a CAD file as the nominal part, which is the only way
// to exercise the importer where it actually runs — bundled into the mesh
// worker, behind the reference slot's file picker.
//
// The pair is built here rather than committed, and built so the answer is
// known in advance: the reference is a STEP cube, the scan is a dense mesh of
// the SAME cube with its top face raised 0.2 mm and its +X face sunk 0.15 mm.
// A correct import therefore has to produce a map that is flat zero over
// two thirds of the part, +0.200 on one face and −0.150 on another — which
// checks not only that the surfaces came through at the right size, but that
// the converted solid has a reliable inside, since that is what the sign of
// every reading is taken from.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-step.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { fail, finish, launchApp, shotPath, sleep } from './e2e-lib.mjs'

const SIZE = 20
const RAISE = 0.2 // top face, z = SIZE, pushed outward
const SINK = 0.15 // +X face, pulled inward

// ---- the pair --------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-step-'))
const stepText = cubeStep(SIZE)
const stepPath = join(dir, 'cube.step')
writeFileSync(stepPath, stepText)

// The scan is a fine tessellation of the same B-rep, so every scan vertex has
// an exact counterpart on the reference and any deviation is the displacement
// put there on purpose (or a bug).
const dense = importStep(stepText, { surfaceDeviation: 0.001, maxEdge: 0.8 })
const p = dense.mesh.positions
for (let i = 0; i < p.length; i += 3) {
  if (Math.abs(p[i + 2] - SIZE) < 1e-6) p[i + 2] += RAISE
  if (Math.abs(p[i] - SIZE) < 1e-6) p[i] -= SINK
}
const scanPath = join(dir, 'cube-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(dense.mesh)))
console.log(`fixtures in ${dir}: STEP cube + ${dense.mesh.indices.length / 3} triangle scan`)

// ---- drive the app ---------------------------------------------------------
const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=start-pane]')

// A scan is a mesh, always — the reference slot is the only one that offers
// CAD, and the picker has to say so.
const accepts = await page.evaluate(() => ({
  scan: document.querySelector('[data-test=start-scan] input[type=file]').accept,
  reference: document.querySelector('[data-test=start-reference] input[type=file]').accept,
}))
console.log('accept:', JSON.stringify(accepts))
if (/step/i.test(accepts.scan)) fail('the scan slot offers STEP, which no scanner produces')
if (!/\.step/.test(accepts.reference) || !/\.stp/.test(accepts.reference)) {
  fail(`the reference slot does not offer STEP: ${accepts.reference}`)
}

// A STEP file pushed at the scan slot anyway must be turned away by name,
// before anything tries to parse it as a mesh.
await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(stepPath)
await page.waitForSelector('.toast', { timeout: 30_000 })
const refusal = await page.$eval('.toast', (el) => el.textContent)
console.log('scan slot refusal:', refusal)
if (!/reference/i.test(refusal)) fail(`refusal does not say where a STEP file belongs: ${refusal}`)

await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(scanPath)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 300_000 },
)
console.log('scan:', await page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ')))

// ---- the STEP reference ----------------------------------------------------
await (await page.$('[data-test=start-reference] input[type=file]')).uploadFile(stepPath)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(700)

const status = await page.$eval('.strip .msg', (el) => el.textContent)
console.log('status:', status)
if (!/STEP/.test(status)) fail('the status strip does not say the reference was converted')
if (!/chord tolerance/.test(status)) fail('the status strip does not report the chord tolerance')

const slot = await page.$eval('[data-test=open-reference]', (el) =>
  el.closest('.slot').textContent.replace(/\s+/g, ' '),
)
console.log('reference slot:', slot)
if (!/STEP at 0?\.\d+ mm/.test(slot)) {
  fail(`the reference slot does not carry the tessellation tolerance: ${slot}`)
}
// Six flat faces need a handful of triangles, not a quarter of a million: a
// length-capped tessellation would show up here as a five-digit count.
const triangles = Number((slot.match(/([\d,]+) triangles/) ?? [])[1]?.replace(/,/g, ''))
console.log('reference triangles:', triangles)
if (!(triangles > 10 && triangles < 5000)) {
  fail(`${triangles} triangles for a cube is not a chord-driven tessellation`)
}
await page.screenshot({ path: shotPath('step-reference-loaded.png') })

// ---- align and measure -----------------------------------------------------
await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(700)

const stats = await page.$$eval('[data-test=deviation-stats] > div', (els) =>
  Object.fromEntries(
    els.map((el) => [el.querySelector('span').textContent, el.querySelector('b').textContent]),
  ),
)
console.log('stats:', JSON.stringify(stats))
const value = (label) => Number(stats[label]?.replace('−', '-').replace('+', ''))

// The two displaced faces, read back off the map. Slack covers the fraction of
// a micrometre the best fit shifts the part to balance them against each other
// and the float32 the map is stored in.
const max = value('max')
const min = value('min')
if (!(Math.abs(max - RAISE) < 0.03)) fail(`raised face reads ${max} mm, expected +${RAISE}`)
if (!(Math.abs(min + SINK) < 0.03)) fail(`sunk face reads ${min} mm, expected −${SINK}`)

// And everything else is the STEP surface matching a mesh of the same surface:
// the four faces that were left alone should read flat zero, so two thirds of
// the part has to land inside the default ±0.1 mm band while the two displaced
// faces sit outside it.
const within = Object.entries(stats).find(([label]) => label.startsWith('±'))
console.log('within tolerance:', within?.join(' '))
const share = Number((within?.[1] ?? '').replace(/[^\d.]/g, ''))
if (!(share > 50 && share < 85)) {
  fail(
    `${within?.[1]} of the scan is within ±0.1 mm of the STEP reference — expected the four ` +
      `untouched faces (~67 %) and not the two displaced ones`,
  )
}

await page.screenshot({ path: shotPath('step-map.png') })

await finish(browser, consoleErrors)
