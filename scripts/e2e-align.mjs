// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for datum alignment + STEP export: drives the real app in
// headless Chrome — loads ballbar.stl, fits both spheres, constructs the line
// through their centers, aligns that line onto +Z with Sphere 1 as the
// origin, then exports the elements as STEP and checks the file: Sphere 1's
// center must land on the origin and Sphere 2's on the Z axis at the known
// ball-bar length, which proves the alignment moved the elements and the
// export writes them faithfully. Finishes by resetting the alignment.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), OUT_DIR (downloads).
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canvasRect,
  check,
  click,
  finish,
  fitBall,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')
// Where the exported STEP file lands — a scratch dir, not the screenshot dir.
const DOWNLOAD_DIR = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), 'scanruler-step-'))

const BAR_LENGTH = 148.64 // GOM reference center distance of the ball bar

const { browser, page, consoleErrors } = await launchApp()

const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR })

await loadScan(page, STL)
const rect = await canvasRect(page)

/** Wait for a status line to appear, as a check instead of an uncaught throw:
 *  a timeout is a finding of this test, not a crash of it. */
const awaitStatus = (text, what) =>
  page
    .waitForFunction((t) => (document.body.innerText ?? '').includes(t), { timeout: 60_000 }, text)
    .then(() => true)
    .catch(() => false)
    .then((ok) => check(ok, what))

const posA = await fitBall(page, rect, false, 1)
const posB = await fitBall(page, rect, true, 2)
check(Boolean(posA), 'Sphere 1 fitted')
check(Boolean(posB), 'Sphere 2 fitted')

// Line through the two sphere centers — the datum the bar is aligned by.
await click(page, '[data-test="fit-line"]')
await selectByLabel(page, '[data-test="draft-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="draft-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="create-element"]')
await sleep(200)
console.log('elements:', JSON.stringify(await rowTexts(page)))

// Align: Line 1 → +Z, origin at Sphere 1's center.
await click(page, '[data-test="start-alignment"]')
await selectByLabel(page, '[data-test="align-primary"]', 'Line 1')
await selectByLabel(page, '[data-test="align-origin"]', 'Sphere 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="apply-alignment"]')
await awaitStatus('Part aligned', 'datum alignment applied')
await sleep(300)

// Export the elements and read the STEP file back.
await click(page, '[data-test="export-step"]')
let stepFile = null
for (let i = 0; i < 100 && !stepFile; i++) {
  await sleep(200)
  stepFile = readdirSync(DOWNLOAD_DIR).find((f) => f.endsWith('.step'))
}
check(Boolean(stepFile), `STEP file downloaded (${stepFile ?? 'missing'})`)

if (stepFile) {
  const text = readFileSync(join(DOWNLOAD_DIR, stepFile), 'utf8')
  const entity = (id) => text.match(new RegExp(`^#${id}=(.*);$`, 'm'))?.[1]
  /** Placement origin of the spherical surface a named element is written on —
   *  under one of the hemisphere faces of a solid ball in the default form,
   *  under a trimmed surface in the construction-surface one. */
  const centerOf = (name) => {
    const face = text.match(new RegExp(`ADVANCED_FACE\\('${name}',\\([^)]*\\),#(\\d+)`))?.[1]
    const surfId =
      face ?? text.match(new RegExp(`RECTANGULAR_TRIMMED_SURFACE\\('${name}',#(\\d+)`))?.[1]
    const plId = entity(surfId)?.match(/#(\d+)/)?.[1]
    const ptId = entity(plId)?.match(/#(\d+)/)?.[1]
    const coords = entity(ptId)?.match(/\(([^()]*)\)/)?.[1]
    return coords?.split(',').map(Number)
  }
  const s1 = centerOf('Sphere 1')
  const s2 = centerOf('Sphere 2')
  console.log('sphere centers in STEP:', JSON.stringify({ s1, s2 }))
  check(s1 && Math.hypot(...s1) < 0.001, 'Sphere 1 center at the origin after alignment')
  check(
    s2 && Math.hypot(s2[0], s2[1]) < 0.001,
    'Sphere 2 center on the Z axis after alignment',
  )
  check(
    s2 && Math.abs(Math.abs(s2[2]) - BAR_LENGTH) < 0.05,
    `Sphere 2 at the bar length along Z (${s2 ? s2[2].toFixed(4) : '—'} mm)`,
  )
  check(text.includes('SI_UNIT(.MILLI.,.METRE.)'), 'STEP declares millimetres')
  check(
    (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length === 2,
    'both spheres came over as solid bodies, the default form',
  )
}

// Reset puts the part back where the scanner delivered it.
await click(page, '[data-test="reset-alignment"]')
await awaitStatus('Alignment reset', 'alignment reset')
await sleep(300)

// Second pass, mix and match: level with 3 points picked straight on the
// scan, zero on the existing Sphere 1 element.
const primaryState = () =>
  page.$eval('[data-test="align-primary"]', (el) => el.selectedOptions[0]?.textContent ?? '')
/** Click the scan for an alignment pick, sweeping offsets until it lands. */
async function alignPick([x, y], offsets = [[0, 0]]) {
  const before = await primaryState()
  for (const [dx, dy] of offsets) {
    await page.mouse.click(x + dx, y + dy)
    await sleep(250)
    if ((await primaryState()) !== before) return true
  }
  return false
}
await click(page, '[data-test="start-alignment"]')
await page.select('[data-test="align-primary"]', '__pick__')
await sleep(150)
check(await alignPick(posA), 'pick 1 of 3 landed')
check(await alignPick(posB), 'pick 2 of 3 landed')
// The third point elsewhere on ball A's surface — millimetres off the first
// pick is plenty against the 148 mm baseline, and the ball is scanned solid
// where the thin rod may have holes.
check(
  await alignPick(posA, [[28, 0], [0, 28], [-28, 0], [0, -28], [20, 20], [-20, 20]]),
  'pick 3 of 3 landed',
)
check((await primaryState()).includes('3 picked points'), `level slot filled (${await primaryState()})`)
await selectByLabel(page, '[data-test="align-origin"]', 'Sphere 1')
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="apply-alignment"]')
await awaitStatus('Part aligned', 'picked-point alignment applied')
await sleep(300)

// Manual move / rotate: nudge the part 5 mm in X and 90° about Z.
await click(page, '[data-test="start-manual"]')
await page.type('[data-test="manual-mx"]', '5')
await page.type('[data-test="manual-rz"]', '90')
await page.waitForSelector('[data-test="apply-manual"]:not([disabled])', { timeout: 5_000 })
await click(page, '[data-test="apply-manual"]')
await awaitStatus('Part moved', 'manual move / rotate applied')

await finish(browser, consoleErrors)
