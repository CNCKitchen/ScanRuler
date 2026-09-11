// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of editing what has already been created: fits both balls of
// ballbar.stl, measures between them, then re-opens the sphere (checking that
// it comes back with its seeds and re-fits to the same geometry), renames it,
// and re-opens the dimension to switch it from centre-to-centre to outer span.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-edit.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
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

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

const clickNth = async (sel, n) => {
  const els = await page.$$(sel)
  if (!els[n]) throw new Error(`no ${sel}[${n}]`)
  await els[n].click()
}
const texts = (sel) =>
  page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
const saveEnabled = (timeout = 30_000) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
/** The measured value of dimension n, digits and unit rejoined. */
const dimValue = async (n) => {
  const all = await texts('[data-test="dimension-value"]')
  const m = (all[n] ?? '').match(/(\d+\.\d+)\s*mm/i)
  return m ? parseFloat(m[1]) : NaN
}

// ---- set the scene: two spheres and a centre distance between them ---------
// This script waits for the preview its own way — a short flat timeout on the
// save button — rather than watching the draft status.
const fitOpts = { ready: () => saveEnabled(3_000) }
if (!(await fitBall(page, rect, false, 1, fitOpts))) fail('first sphere not fitted')
if (!(await fitBall(page, rect, true, 2, fitOpts))) fail('second sphere not fitted')
console.log('spheres:', JSON.stringify(await rowTexts(page)))

await click(page, '[data-test="new-dimension"]')
await selectByLabel(page, '[data-test="dim-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="dim-ref-1"]', 'Sphere 2')
await click(page, '[data-test="add-dimension"]')
await sleep(200)
const before = await dimValue(0)
console.log('centre distance:', before)
check(Math.abs(before - 148.64) < 0.05, `centre distance ${before} mm`)

// ---- re-open the sphere ----------------------------------------------------

const diameterOf = async (n) => {
  const m = (await rowTexts(page))[n].match(/([\d.]+)\s*mm/)
  return m ? parseFloat(m[1]) : NaN
}
const diameterBefore = await diameterOf(0)

await clickNth('[data-test="edit-element"]', 0)
const heading = await page.$eval('.draftbox .sec-head', (e) => e.textContent.trim())
check(heading === 'Edit Sphere 1', `editor opened on the element: "${heading}"`)
const nameValue = await page.$eval('[data-test="draft-name"]', (e) => e.value)
check(nameValue === 'Sphere 1', `name field carries the element's name: "${nameValue}"`)
// The seeds came back with it and re-fitted on their own — nothing was clicked.
check(await saveEnabled(), 'the re-opened fit previews from its stored seeds')
const editedCount = (await rowTexts(page)).length
check(editedCount === 2, `no element was added while editing (${editedCount} rows)`)

await page.$eval('[data-test="draft-name"]', (e) => {
  e.value = ''
})
await page.type('[data-test="draft-name"]', 'Ball A')
await click(page, '[data-test="create-element"]')
await sleep(400)

const rowsAfter = await rowTexts(page)
console.log('after save:', JSON.stringify(rowsAfter))
check(rowsAfter.length === 2, `still two elements after saving (${rowsAfter.length})`)
check(rowsAfter[0].includes('Ball A'), 'the element was renamed in place')
const diameterAfter = await diameterOf(0)
check(
  Math.abs(diameterAfter - diameterBefore) < 1e-6,
  `re-fitting the same seeds gives the same sphere (Ø ${diameterBefore} → ${diameterAfter} mm)`,
)
const title = (await texts('[data-test="dimension-row"]'))[0]
check(title.includes('Ball A'), 'the dimension follows the new name')
const afterRename = await dimValue(0)
check(
  Math.abs(afterRename - before) < 1e-6,
  `the dimension still measures the same (${afterRename} mm)`,
)

// ---- re-open the dimension -------------------------------------------------

await clickNth('[data-test="edit-dimension"]', 0)
const dimHeading = await page.$eval('.dimbox .sec-head', (e) => e.textContent.trim())
check(dimHeading === 'Edit Distance 1', `dimension editor opened on the row: "${dimHeading}"`)
const refs = await page.$$eval('[data-test^="dim-ref-"]', (els) =>
  els.map((e) => e.selectedOptions[0]?.textContent.trim()),
)
check(
  refs.join(' → ') === 'Ball A → Sphere 2',
  `it re-opens with its references: ${refs.join(' → ')}`,
)
await selectByLabel(page, '[data-test="dim-anchor"]', 'Outer span (+ radii)')
await click(page, '[data-test="add-dimension"]')
await sleep(300)

const rows = await texts('[data-test="dimension-row"]')
check(rows.length === 1, `the dimension was replaced, not added (${rows.length} rows)`)
const span = await dimValue(0)
// Outer span = centre distance + both radii; the balls are Ø ~15.92 mm.
const expected = before + diameterAfter
check(Math.abs(span - expected) < 0.02, `outer span ${span} mm (centre distance + Ø = ${expected})`)
check(rows[0].includes('Distance 1'), 'the name survives a change that stays a distance')

// ---- the outlier cut-off is the element's own -------------------------------
// Re-open Ball A, take the cut-off off, save: it re-fits on every point of its
// surface, while Sphere 2 keeps the 3 sigma it was measured with — and Ball A
// re-opens on the choice that was saved with it.
const usedPoints = () => page.$eval('[data-test="used-points"]', (e) => e.value)
/** "used of region" from the preview's detail line. */
const pointsNote = async () => {
  const note = await page.$eval('.draftbox .dro-note', (e) => e.textContent)
  const m = note.match(/([\d,]+) of ([\d,]+) points/)
  return m ? { used: m[1], region: m[2], text: m[0] } : { used: '', region: '', text: note }
}

await clickNth('[data-test="edit-element"]', 0)
check(await saveEnabled(), 'Ball A re-opened for its cut-off')
const presetBefore = await usedPoints()
check(presetBefore === '3', `it opens on the cut-off it was measured with (${presetBefore})`)
const clipped = await pointsNote()
check(clipped.used !== clipped.region, `at 3 sigma some points are dropped: ${clipped.text}`)
await selectByLabel(page, '[data-test="used-points"]', 'All points')
await sleep(300)
check(await saveEnabled(), 'the draft re-fitted after the change')
const whole = await pointsNote()
check(whole.used === whole.region, `on all points every point of the surface is used: ${whole.text}`)
check(whole.region === clipped.region, `on the same surface (${clipped.region} → ${whole.region})`)
await click(page, '[data-test="create-element"]')
await sleep(400)
check((await rowTexts(page)).length === 2, 'saving the cut-off adds no element')

await clickNth('[data-test="edit-element"]', 1)
check(await saveEnabled(), 'Sphere 2 re-opened')
const other = await usedPoints()
check(other === '3', `the other sphere kept its own cut-off (${other})`)
const otherNote = await pointsNote()
check(otherNote.used !== otherNote.region, `and still drops its outliers: ${otherNote.text}`)
await click(page, '[data-test="cancel-draft"]')
await sleep(200)

await clickNth('[data-test="edit-element"]', 0)
check(await saveEnabled(), 'Ball A re-opened again')
const kept = await usedPoints()
check(kept === '0', `Ball A re-opens on all points (${kept})`)
await click(page, '[data-test="cancel-draft"]')
await sleep(200)

// A new element starts on the choice last made.
await click(page, '[data-test="fit-sphere"]')
const fresh = await usedPoints()
check(fresh === '0', `a new element starts on the last choice (${fresh})`)
await click(page, '[data-test="cancel-draft"]')
await sleep(200)

await page.screenshot({ path: shotPath('e2e-edit.png') })

await finish(browser, consoleErrors)
