// SPDX-License-Identifier: AGPL-3.0-only
// Fit all chains on a real scan, and its options window. The fridge bracket
// is cut through the middle; one click on Fit all chains has to leave a
// closed profile — every corner joined, the sketch solved, a region found —
// and the Fit options window has to refit it: coarser gives fewer pieces,
// every side near an axis is laid along it, and one undo takes a refit back.
//
//   npm run e2e:fit-chains   (the dev server running, fridgeBracket.ply at the root)

import { check, click, finish, launchApp, loadScan, pickOption, repoFile, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

const SCAN = process.env.SCAN ?? repoFile('fridgeBracket.ply')
const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
await loadScan(page, SCAN, { timeout: 300_000 })

await page.click('[data-test=workspace-reverse]')
await page
  .waitForFunction(() => /ready/.test(document.querySelector('[data-test=kernel-status]')?.textContent ?? ''), { timeout: 180_000 })
  .catch(() => {})
check(/ready/.test(await page.$eval('[data-test=kernel-status]', (el) => el.textContent)), 'the CAD kernel is ready')

await pickOption(page, '[data-test=sketch-plane-select]', 'XY plane through the centre')
await page.waitForSelector('[data-test=sketch-editor]')
await page.waitForFunction(() => /slice chain/.test(document.querySelector('[data-test=sketch-plane]')?.textContent ?? ''), { timeout: 60_000 })

const draft = () =>
  page.evaluate(() => {
    const d = window.__re.store.getState().sketchDraft
    const kinds = {}
    for (const c of d.sketch.constraints) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1
    let pieces = 0
    for (const f of Object.values(d.fitted)) pieces += f.order.length
    return { entities: d.sketch.entities.length, pieces, kinds, regions: d.found.length, ok: d.report?.ok ?? null, error: d.error, history: d.history.length }
  })

// ---- one click: a closed profile -------------------------------------------------
await page.evaluate(() => localStorage.removeItem('scanruler.fitoptions'))
await click(page, '[data-test=sketch-fit-all]')
await sleep(1500)
const fitted = await draft()
console.log('fitted:', JSON.stringify(fitted))
check(fitted.pieces > 4, `the slice is cut into pieces (${fitted.pieces})`)
check((fitted.kinds.coincident ?? 0) >= fitted.pieces - 2, `the fit joined its corners (${fitted.kinds.coincident} of ${fitted.pieces})`)
check(fitted.ok === true, 'the sketch is solved')
check(fitted.regions >= 1, `the profile closes into a region (${fitted.regions})`)
await click(page, '[data-test=sketch-infer]')
await sleep(500)
check((await draft()).error === null, 'Infer corners after a joining fit has nothing to complain of')
await page.screenshot({ path: shotPath('fit-chains-default.png') })

// ---- the options window ----------------------------------------------------------
await click(page, '[data-test=sketch-fit-options]')
await page.waitForSelector('[data-test=fit-options]')
check(/piece/.test(await page.$eval('[data-test=fit-options-status]', (el) => el.textContent)), 'the window says what a change will refit')
check((await page.$('.modalback')) === null, 'the window has no backdrop over the sketch')

/** Set the slider the way a hand does: the value, then the release. */
const setDetail = async (value) => {
  await page.$eval(
    '[data-test=fit-detail]',
    (el, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    },
    value,
  )
  await sleep(1500)
}
await setDetail(1)
const fine = await draft()
console.log('fine:', JSON.stringify(fine))
await setDetail(0)
const coarse = await draft()
console.log('coarse:', JSON.stringify(coarse))
check(fine.pieces > coarse.pieces, `fine gives more pieces than coarse (${fine.pieces} > ${coarse.pieces})`)
check(coarse.regions >= 1 && coarse.ok === true, 'the coarse fit is closed and solved')
check(fine.ok === true, 'the fine fit is solved')
await page.screenshot({ path: shotPath('fit-chains-coarse.png') })

await setDetail(0.5)
await click(page, '[data-test=fit-align]')
await sleep(1500)
const aligned = await draft()
console.log('aligned:', JSON.stringify(aligned))
// The scan lies as the scanner left it, so how many sides run within 3° of
// an axis is the part's business; every one that does has to be held there.
const near = await page.evaluate(() => {
  const d = window.__re.store.getState().sketchDraft
  const limit = Math.sin((3 * Math.PI) / 180)
  let lines = 0
  let exact = 0
  for (const e of d.sketch.entities) {
    if (e.kind !== 'line') continue
    const dx = Math.abs(e.b[0] - e.a[0])
    const dy = Math.abs(e.b[1] - e.a[1])
    const l = Math.hypot(dx, dy)
    if (Math.min(dx, dy) / l > limit) continue
    lines++
    if (Math.min(dx, dy) < 1e-3) exact++
  }
  return { lines, exact }
})
console.log('near an axis:', JSON.stringify(near))
check(near.lines === near.exact && (aligned.kinds.horizontal ?? 0) + (aligned.kinds.vertical ?? 0) === near.exact, `every side near an axis lies along it (${near.exact} of ${near.lines})`)
check(aligned.history > coarse.history + 1, 'switching it on refits')
check(aligned.ok === true, 'the aligned fit is solved')
await page.screenshot({ path: shotPath('fit-chains-aligned.png') })

// One refit, one undo.
const before = aligned.history
await page.keyboard.press('Escape')
await sleep(200)
check((await page.$('[data-test=fit-options]')) === null, 'Escape closes the window')
check((await page.$('[data-test=sketch-editor]')) !== null, 'and the sketch stays open')
await page.evaluate(() => window.__re.store.getState().undoSketch())
await sleep(800)
const undone = await draft()
check(undone.history === before - 1 && (undone.kinds.horizontal ?? 0) + (undone.kinds.vertical ?? 0) === 0, 'undo takes the aligned refit back whole')
check(undone.pieces > 0, 'and the chains stay fitted by the pieces that came back')

// ---- typed figures, a key at a time ----------------------------------------------
// The tolerance took each keystroke alone, and "0.0" on the way to 0.05 is
// not above 0: the field cleared under the hand (issue 81).
await click(page, '[data-test=sketch-fit-options]')
await page.waitForSelector('[data-test=fit-options]')
const typeKeys = async (sel, text) => {
  await page.focus(sel)
  await page.$eval(sel, (el) => (el.value = ''))
  await page.type(sel, text, { delay: 30 })
}
await typeKeys('[data-test=sketch-tolerance]', '0.05')
check((await page.$eval('[data-test=sketch-tolerance]', (el) => el.value)) === '0.05', 'a tolerance of 0.05 can be typed a key at a time')
await page.keyboard.press('Enter')
await sleep(1500)
const tolerance = await page.evaluate(() => window.__re.store.getState().sketchDraft.tolerance)
check(Math.abs(tolerance - 0.05) < 1e-9, `Enter sets it to 0.05 (${tolerance})`)
if (await page.$eval('[data-test=fit-align-degrees]', (el) => el.disabled)) {
  await click(page, '[data-test=fit-align]')
  await sleep(1000)
}
await typeKeys('[data-test=fit-align-degrees]', '0.5')
check((await page.$eval('[data-test=fit-align-degrees]', (el) => el.value)) === '0.5', 'the angle within 0.5° can be typed a key at a time')
await page.keyboard.press('Enter')
await sleep(1500)
check((await page.evaluate(() => JSON.parse(localStorage.getItem('scanruler.fitoptions') ?? '{}').alignDegrees)) === 0.5, 'Enter sets it to 0.5°')
await page.keyboard.press('Escape')
await sleep(200)

await page.evaluate(() => localStorage.removeItem('scanruler.fitoptions'))
await finish(browser, consoleErrors)
