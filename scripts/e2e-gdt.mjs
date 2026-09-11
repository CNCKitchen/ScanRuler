// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of GD&T tolerances and limits. On a stepped shaft it builds
// itself — a Ø40 shaft with a Ø20 pin on top, the pin set 0.1 mm off the
// shaft's axis, so the answers are known before the app starts — a
// cylindricity held to a limit it meets, a parallelism of pin to shaft that
// reads zero, a coaxiality that reads Ø 0.200 mm and fails the limit it is
// given, and a diameter with a nominal and a tolerance: judged in the row,
// on the pin and in the copied summary. On the block: a flatness whose tight
// limit fails red and passes once loosened, a parallelism between two faces
// read off the scanned surface, and the datum renamed under it with the pin
// following.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-gdt.mjs
// Env: CHROME (chrome.exe path), APP_URL, BLOCK (block scan), SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBinarySTL } from 'meshstep'
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const BLOCK = process.env.BLOCK ?? repoFile('block-marius.stl')

// ---- the stepped shaft ------------------------------------------------------

const SHAFT_R = 20
const PIN_R = 10
const PIN_OFFSET = 0.1

/** A shaft of `SHAFT_R` standing 40 mm on z = 0, with a pin of `PIN_R` on
 *  top of it reaching to z = 80, the pin's axis `PIN_OFFSET` off in X.
 *  Rings of vertices every 2 mm so the cylinder fits rest on a surface, and
 *  fans for the end faces. */
function steppedShaft(segments = 240) {
  const pos = []
  const idx = []
  const ring = (r, z, dx) => {
    const start = pos.length / 3
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments
      pos.push(dx + r * Math.cos(a), r * Math.sin(a), z)
    }
    return start
  }
  const tube = (r, z0, z1, dx) => {
    const rings = []
    for (let z = z0; z <= z1 + 1e-9; z += 2) rings.push(ring(r, z, dx))
    for (let k = 0; k + 1 < rings.length; k++) {
      const a = rings[k]
      const b = rings[k + 1]
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments
        idx.push(a + i, a + j, b + i, b + i, a + j, b + j)
      }
    }
    return [rings[0], rings[rings.length - 1]]
  }
  const cap = (ringStart, z, dx, up) => {
    pos.push(dx, 0, z)
    const c = pos.length / 3 - 1
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      if (up) idx.push(c, ringStart + i, ringStart + j)
      else idx.push(c, ringStart + j, ringStart + i)
    }
  }
  const [a0, a1] = tube(SHAFT_R, 0, 40, 0)
  cap(a0, 0, 0, false)
  cap(a1, 40, 0, true)
  const [b0, b1] = tube(PIN_R, 40, 80, PIN_OFFSET)
  cap(b0, 40, PIN_OFFSET, false)
  cap(b1, 80, PIN_OFFSET, true)
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) }
}

const dir = mkdtempSync(join(tmpdir(), 'scanruler-gdt-'))
const SHAFT = join(dir, 'shaft.stl')
writeFileSync(SHAFT, Buffer.from(writeBinarySTL(steppedShaft())))

const { browser, page, consoleErrors } = await launchApp()

const saveEnabled = (timeout = 30_000) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
const text = (sel) =>
  page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null)
const texts = (sel) =>
  page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
const count = (sel) => page.$$eval(sel, (els) => els.length)
const hasClass = (sel, cls) => page.$eval(sel, (e, c) => e.classList.contains(c), cls)
const mmOf = (t) => parseFloat((t ?? '').match(/(\d+\.\d+)/)?.[1] ?? 'NaN')

/** Replace a field's text: select everything with the keyboard (a triple
 *  click does not select a number input), type, and commit with Enter. */
const setText = async (sel, value) => {
  const el = await page.$(sel)
  if (!el) throw new Error(`no ${sel}`)
  await el.focus()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await el.type(String(value))
  await page.keyboard.press('Enter')
  await sleep(150)
}

/** The summary goes to the clipboard, which the page cannot read back here:
 *  keep what was written on the window instead. */
const armClipboard = () =>
  page.evaluate(() => {
    window.__copied = null
    navigator.clipboard.writeText = (t) => {
      window.__copied = t
      return Promise.resolve()
    }
  })
const copySummary = async () => {
  const handle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Copy summary'),
  )
  await handle.click()
  await sleep(200)
  return page.evaluate(() => window.__copied)
}

/** Fit an element at one viewport spot and create it; null if nothing previews. */
async function fitAt(kind, rect, [fx, fy]) {
  await click(page, `[data-test="fit-${kind}"]`)
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  await sleep(350)
  if (await saveEnabled(4_000)) {
    await click(page, '[data-test="create-element"]')
    await sleep(250)
    return true
  }
  await click(page, '[data-test="cancel-draft"]').catch(() => {})
  return false
}

/** Fit an element by clicking the first of the given spots that yields one. */
async function fitElement(kind, rect, spots) {
  for (const spot of spots) if (await fitAt(kind, rect, spot)) return spot
  return null
}

// ============================================================================
// Part 1 — the stepped shaft: known answers
// ============================================================================

await loadScan(page, SHAFT, { settle: 600 })
await armClipboard()
let rect = await canvasRect(page)

// The part is framed broadside, its long axis up the screen or across it:
// sweep both, and tell the shaft from the pin by the diameter each fit
// reports, until one of each has been created.
const named = { shaft: null, pin: null }
const spots = [
  [0.5, 0.72], [0.5, 0.28], [0.72, 0.5], [0.28, 0.5],
  [0.5, 0.8], [0.5, 0.2], [0.8, 0.5], [0.2, 0.5],
  [0.5, 0.64], [0.5, 0.36], [0.64, 0.5], [0.36, 0.5],
]
for (const spot of spots) {
  if (named.shaft && named.pin) break
  if (!(await fitAt('cylinder', rect, spot))) continue
  const rows = await rowTexts(page)
  const last = rows[rows.length - 1]
  const name = last.match(/^(Cylinder \d+)/)?.[1]
  const d = mmOf(last.match(/Ø ([\d.]+)/)?.[1])
  if (Math.abs(d - 2 * SHAFT_R) < 0.5 && !named.shaft) named.shaft = name
  else if (Math.abs(d - 2 * PIN_R) < 0.5 && !named.pin) named.pin = name
}
console.log('elements:', JSON.stringify(await rowTexts(page)), JSON.stringify(named))
if (!named.shaft || !named.pin) {
  fail('the shaft and the pin were not both fitted')
  await finish(browser, consoleErrors)
  process.exit(1)
}

check(
  await page.$eval('[data-test="new-tolerance"]', (b) => !b.disabled),
  'New tolerance is offered once an element exists',
)

// ---- cylindricity of the shaft, held to a limit it meets --------------------
await click(page, '[data-test="new-tolerance"]')
await page.select('[data-test="tol-type"]', 'form-cylindricity')
await sleep(150)
await selectByLabel(page, '[data-test="tol-ref-0"]', named.shaft)
await sleep(250)
const cyl = mmOf(await text('[data-test="tol-preview"]'))
check(cyl < 0.005, `a tessellated cylinder is cylindrical to within a few microns (${cyl} mm)`)
check(!(await page.$('.draftbox [data-test="verdict"]')), 'no verdict before a limit is typed')
await setText('[data-test="tol-limit"]', 0.01)
await sleep(200)
check(!(await hasClass('[data-test="tol-preview"]', 'over')), 'within its limit the preview stays plain')
const cylVerdict = await text('.draftbox [data-test="verdict"]')
check(/^limit 0\.010 mm · Δ -0\.0\d\d mm$/.test(cylVerdict ?? ''), `the verdict reads the margin: "${cylVerdict}"`)
await click(page, '[data-test="add-tolerance"]')
await sleep(300)
check((await count('[data-test="tolerance-row"]')) === 1, 'the tolerance is listed in its own group')
check((await count('[data-test="dimension-row"]')) === 0, 'and not among the dimensions')
const cylRow = (await texts('[data-test="tolerance-row"]'))[0]
check(/^Cylindricity 1 · Cylindricity/.test(cylRow), `named by its characteristic: "${cylRow.slice(0, 44)}"`)
check((await count('.viewport-label.distance-label')) === 1, 'it has a pin on the part')
check((await count('.viewport-label.distance-label.over')) === 0, 'which is not red')

// ---- parallelism of the pin to the shaft: zero ------------------------------
await click(page, '[data-test="new-tolerance"]')
await page.select('[data-test="tol-type"]', 'orient-parallelism')
await sleep(150)
await selectByLabel(page, '[data-test="tol-ref-0"]', named.pin)
await selectByLabel(page, '[data-test="tol-ref-1"]', named.shaft)
await sleep(250)
const par = mmOf(await text('[data-test="tol-preview"]'))
check(par < 0.003, `the pin runs parallel to the shaft (${par} mm)`)
const parNote = await text('.draftbox .dro-note')
check(/off parallel/.test(parNote ?? ''), `and the preview says by what angle: "${parNote}"`)
await click(page, '[data-test="add-tolerance"]')
await sleep(300)

// ---- coaxiality: Ø 0.200 mm, over a limit of 0.1 ------------------------------
await click(page, '[data-test="new-tolerance"]')
await page.select('[data-test="tol-type"]', 'loc-coaxiality')
await sleep(150)
await selectByLabel(page, '[data-test="tol-ref-0"]', named.pin)
await selectByLabel(page, '[data-test="tol-ref-1"]', named.shaft)
await sleep(250)
const coaxText = await text('[data-test="tol-preview"]')
const coax = mmOf(coaxText)
check(/^Ø/.test(coaxText ?? ''), `coaxiality reads as a diameter (${coaxText})`)
check(Math.abs(coax - 2 * PIN_OFFSET) < 0.005, `twice the pin's offset (${coax} mm for ${2 * PIN_OFFSET})`)
await setText('[data-test="tol-limit"]', 0.1)
await sleep(200)
check(await hasClass('[data-test="tol-preview"]', 'over'), 'the preview goes red over a limit of 0.1')
const coaxFail = await text('.draftbox [data-test="fail"]')
check(/0\.100 mm over the limit/.test(coaxFail ?? ''), `the preview says by how much: "${coaxFail}"`)
await click(page, '[data-test="add-tolerance"]')
await sleep(300)
check((await count('[data-test="tolerance-row"]')) === 3, 'three tolerances are listed')
check((await count('.viewport-label.distance-label.over')) === 1, 'one pin on the part reads red')
const coaxPin = (await texts('.viewport-label.distance-label.over'))[0]
check(
  coaxPin.startsWith('Coaxiality 1') && coaxPin.includes(`${named.pin} → ${named.shaft}`) && coaxPin.includes('over the limit'),
  `the red pin names the pin and the shaft and the excess: "${coaxPin}"`,
)
check(!coaxPin.includes('Δ'), 'and does not repeat the excess as a deviation')

// ---- a diameter with a nominal and a tolerance -------------------------------
await click(page, '[data-test="new-dimension"]')
await page.select('[data-test="dim-type"]', 'size-diameter')
await sleep(150)
await selectByLabel(page, '[data-test="dim-ref-0"]', named.shaft)
await sleep(250)
const dia = mmOf(await text('[data-test="dim-preview"]'))
check(Math.abs(dia - 2 * SHAFT_R) < 0.01, `the diameter previews (${dia} mm)`)
await setText('[data-test="dim-nominal"]', (2 * SHAFT_R + 0.05).toFixed(3))
await sleep(200)
check(!!(await page.$('[data-test="dim-plus"]')), 'a nominal brings up the tolerance fields')
await setText('[data-test="dim-plus"]', 0.01)
await sleep(200)
const diaVerdict = await text('.draftbox [data-test="verdict"]')
check(
  /nominal 40\.050 mm \+0\.010 mm \/ −0\.010 mm · Δ -0\.050 mm/.test(diaVerdict ?? ''),
  `the band is symmetric and the deviation signed: "${diaVerdict}"`,
)
check(await hasClass('[data-test="dim-preview"]', 'over'), 'the diameter is red below the band')
await click(page, '[data-test="add-dimension"]')
await sleep(300)
check((await count('[data-test="dimension-row"]')) === 1, 'the diameter is listed among the dimensions')
check((await count('.viewport-label.distance-label.over')) === 2, 'two pins read red now')

// loosen the band: the diameter passes, the coaxiality still fails
await click(page, '[data-test="edit-dimension"]')
await sleep(200)
await setText('[data-test="dim-plus"]', 0.1)
await sleep(200)
check(!(await hasClass('[data-test="dim-preview"]', 'over')), 'a wider band takes the red off the preview')
await click(page, '[data-test="add-dimension"]')
await sleep(300)
check((await count('.viewport-label.distance-label.over')) === 1, 'one pin reads red once the band is wide enough')
await page.screenshot({ path: shotPath('e2e-gdt-1-shaft.png') })

// ---- the summary -----------------------------------------------------------
const summary = await copySummary()
check(typeof summary === 'string' && summary.length > 0, 'the summary was copied')
check(
  new RegExp(`Cylindricity 1 \\(${named.shaft}\\) — Cylindricity: 0\\.00\\d mm\\n  limit 0\\.010 mm · Δ -0\\.0\\d\\d mm · PASS`).test(summary),
  'the summary judges the cylindricity as passing',
)
check(
  new RegExp(`Parallelism 1 \\(${named.pin} → ${named.shaft}\\) — Parallelism: 0\\.00\\d mm`).test(summary),
  'reports the parallelism with its datum',
)
check(
  new RegExp(`Coaxiality 1 \\(${named.pin} → ${named.shaft}\\) — Coaxiality: Ø 0\\.\\d{3} mm\\n  limit 0\\.100 mm · 0\\.\\d{3} mm over the limit · FAIL`).test(summary),
  'judges the coaxiality as failing, saying the excess once',
)
check(
  new RegExp(`Diameter 1 \\(${named.shaft}\\) — Diameter: 40\\.000 mm\\n  nominal 40\\.050 mm \\+0\\.100 mm / −0\\.100 mm · Δ -0\\.050 mm · PASS`).test(summary),
  'and the diameter as passing',
)
check(/Checked against limits: 3 — 2 pass, 1 fail$/.test(summary.trimEnd()), 'and tallies them at the end')

// ============================================================================
// Part 2 — the block: flatness off a real surface, parallelism, a renamed datum
// ============================================================================

await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')
await loadScan(page, BLOCK, { settle: 800 })
rect = await canvasRect(page)
const p1 = await fitElement('plane', rect, [[0.5, 0.5], [0.42, 0.42], [0.58, 0.58], [0.5, 0.35]])
if (!p1) fail('no first plane could be fitted on the block')
const p2 = await fitElement('plane', rect, [[0.25, 0.7], [0.75, 0.3], [0.2, 0.3], [0.8, 0.7], [0.3, 0.5], [0.7, 0.5]])
if (!p2) fail('no second plane could be fitted on the block')

// ---- flatness: a tight limit fails, a loose one passes -----------------------
await click(page, '[data-test="new-tolerance"]')
await selectByLabel(page, '[data-test="tol-ref-0"]', 'Plane 1')
await sleep(250)
const flat = mmOf(await text('[data-test="tol-preview"]'))
check(flat > 0 && flat < 1, `flatness previews (${flat} mm)`)
await setText('[data-test="tol-limit"]', (flat / 2).toFixed(4))
await sleep(200)
await click(page, '[data-test="add-tolerance"]')
await sleep(300)
check((await count('.viewport-label.distance-label.over')) === 1, 'the flatness pin reads red under a tight limit')
await click(page, '[data-test="edit-tolerance"]')
await sleep(200)
await setText('[data-test="tol-limit"]', (flat * 2).toFixed(4))
await sleep(200)
await click(page, '[data-test="add-tolerance"]')
await sleep(300)
check((await count('.viewport-label.distance-label.over')) === 0, 'and loses the red once the limit is loosened')
const flatRow = (await texts('[data-test="tolerance-row"]'))[0]
check(
  /limit [\d.]+ mm · Δ -[\d.]+ mm/.test(flatRow) && !/over the limit/.test(flatRow),
  `the row reads the margin: "${flatRow.slice(0, 80)}"`,
)

// ---- parallelism off the scanned surface ------------------------------------
await click(page, '[data-test="new-tolerance"]')
await page.select('[data-test="tol-type"]', 'orient-parallelism')
await sleep(150)
await selectByLabel(page, '[data-test="tol-ref-0"]', 'Plane 2')
await selectByLabel(page, '[data-test="tol-ref-1"]', 'Plane 1')
await sleep(300)
const par2 = mmOf(await text('[data-test="tol-preview"]'))
check(Number.isFinite(par2), `parallelism previews (${par2} mm)`)
check(!(await page.$('.draftbox .warnnote')), 'read off the measured surface, with no patch warning')
await click(page, '[data-test="add-tolerance"]')
await sleep(300)
let pins = await texts('.viewport-label.distance-label')
check(
  pins.some((t) => t.startsWith('Parallelism 1') && t.includes('Plane 2 → Plane 1')),
  `the parallelism pin names both planes: ${JSON.stringify(pins)}`,
)

// ---- rename the datum: the pin and the row follow ---------------------------
await click(page, '[data-test="edit-element"]')
await sleep(200)
await setText('[data-test="draft-name"]', 'Base')
await click(page, '[data-test="create-element"]')
await sleep(500)
pins = await texts('.viewport-label.distance-label')
check(
  pins.some((t) => t.startsWith('Parallelism 1') && t.includes('Plane 2 → Base')),
  `the pin follows the rename: ${JSON.stringify(pins)}`,
)
const rows = await texts('[data-test="tolerance-row"]')
check(rows.some((t) => t.includes('Plane 2 → Base')), 'and so does the row')
await page.screenshot({ path: shotPath('e2e-gdt-2-block.png') })

await finish(browser, consoleErrors)
