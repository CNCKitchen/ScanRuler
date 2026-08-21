// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the 2D Measure workspace: drives the real app in
// headless Chrome — generates a synthetic flatbed scan (no binary fixtures in
// this repo), loads it through the panel, waits for edge detection, fits a
// circle and a line by region drag, picks a point and drags its pin, edits,
// hides and deletes through the element list, calibrates on a known
// distance, sets a datum, measures a dimension, and reads the report off the
// clipboard.
//
// The fixture is exact by construction: a grayscale PNG at a declared 600 dpi
// with soft-shouldered edges, a 240 px circle and a 600 px wide rectangle —
// so the assertions can be tight.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_URL,
  OUT_DIR,
  launchApp,
  click,
  check,
  drag,
  finish,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

// ---- the synthetic scan -----------------------------------------------------

const W = 800
const H = 600
const PPM = 23.622 // 600 dpi
const RECT = { x0: 100.5, x1: 700.5, y0: 400.5, y1: 550.5 } // image px, y down
const DISC = { cx: 400.5, cy: 200.5, r: 120.25 }

/** Soft edge over ±1 px of a signed "inside" distance, like scanner optics. */
const shade = (d) =>
  d <= -1 ? 25 : d >= 1 ? 230 : 25 + (230 - 25) * (0.5 + 0.5 * Math.sin((d * Math.PI) / 2))

function buildPng() {
  const gray = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const inRect = Math.min(cx - RECT.x0, RECT.x1 - cx, cy - RECT.y0, RECT.y1 - cy)
      const inDisc = DISC.r - Math.hypot(cx - DISC.cx, cy - DISC.cy)
      gray[y * W + x] = shade(Math.max(inRect, inDisc))
    }
  }
  // PNG by hand: signature, IHDR, pHYs (600 dpi), IDAT, IEND.
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const chunk = (type, data) => {
    const body = [...[...type].map((ch) => ch.charCodeAt(0)), ...data]
    return [...u32(data.length), ...body, ...u32(crc(body))]
  }
  const raw = new Uint8Array(H * (W + 1))
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0 // filter: none
    raw.set(gray.subarray(y * W, (y + 1) * W), y * (W + 1) + 1)
  }
  const idat = deflateSync(raw)
  const ppm = Math.round(PPM * 1000) // pixels per metre
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(W), ...u32(H), 8, 0, 0, 0, 0]),
    ...chunk('pHYs', [...u32(ppm), ...u32(ppm), 1]),
    ...chunk('IDAT', [...idat]),
    ...chunk('IEND', []),
  ])
}

const fixture = join(OUT_DIR, 'flat-fixture.png')
writeFileSync(fixture, buildPng())

// Ground truth in document units (mm, y up) at the declared scale.
const mm = (px) => px / PPM
const SHEET_W = mm(W)
const SHEET_H = mm(H)
const DISC_C = [mm(DISC.cx), mm(H - DISC.cy)]
const DISC_DIA = mm(2 * DISC.r)
const RECT_TOP_Y = mm(H - RECT.y0) // the rectangle's upper edge, in doc y
const RECT_WIDTH = mm(RECT.x1 - RECT.x0)

// ---- the session ------------------------------------------------------------

const { browser, page, consoleErrors } = await launchApp()
await browser
  .defaultBrowserContext()
  .overridePermissions(APP_URL.replace(/\/$/, ''), [
    'clipboard-read',
    'clipboard-write',
    'clipboard-sanitized-write',
  ])

await click(page, '[data-test=workspace-flat]')
// The support card overlays the lower stage, exactly where picks on the
// fixture's rectangle land — close it before measuring through it.
await click(page, '[data-test=support-card] .sc-x').catch(() => {})
const input = await page.$('input[type=file][accept*=".png"]')
await input.uploadFile(fixture)
await page.waitForFunction(
  () => /chains found/.test(document.querySelector('[data-test=flat-edge-status]')?.textContent ?? ''),
  { timeout: 60_000 },
)

// ---- metadata and the uncalibrated alarm -----------------------------------
const calStatus = await page.$eval('[data-test=flat-cal-status]', (el) => el.textContent)
check(/600 dpi/.test(calStatus), 'the declared 600 dpi is read from pHYs')
check((await page.$('[data-test=flat-uncalibrated-chip]')) !== null, 'the uncalibrated alarm is up')

// Screen mapping for the framed sheet.
const rect = await page.$eval('.viewslot:not([hidden]) .viewport canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const aspect = rect.w / rect.h
const frustH = Math.max((SHEET_H / 2) * 1.08, ((SHEET_W / 2) * 1.08) / aspect)
const toScreen = (mx, my) => [
  rect.x + (rect.w * ((mx - SHEET_W / 2) / (frustH * aspect) + 1)) / 2,
  rect.y + (rect.h * (1 - (my - SHEET_H / 2) / frustH)) / 2,
]

const rowTexts = () =>
  page.$$eval('[data-test=element-row]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  )

// ---- a circle by one region drag -------------------------------------------
// Picking is the default; the region fit is the other method in the box.
await click(page, '[data-test=flat-fit-circle]')
check(
  /Click three or more points/.test(await page.$eval('[data-test=flat-draft-hint]', (el) => el.textContent)),
  'a kind button opens with point picking',
)
await page.select('[data-test=flat-draft-method]', 'flat-circle-edge')
const rr = DISC_DIA / 2 + 1
await drag(page, toScreen(DISC_C[0] - rr, DISC_C[1] + rr), toScreen(DISC_C[0] + rr, DISC_C[1] - rr))
await sleep(400)
await click(page, '[data-test=flat-create-element]')
await sleep(200)
let rows = await rowTexts()
const dia = Number((rows[0]?.match(/Ø ([\d.]+)/) ?? [])[1])
check(
  Math.abs(dia - DISC_DIA) < 0.08,
  `the region-fitted circle reads Ø ${DISC_DIA.toFixed(3)} mm (got ${dia})`,
)

// ---- the same circle by one click on its edge --------------------------------
// An edge tool reads a click as the whole detected edge under it.
await click(page, '[data-test=flat-fit-circle]')
await page.select('[data-test=flat-draft-method]', 'flat-circle-edge')
await page.mouse.click(...toScreen(DISC_C[0] + DISC_DIA / 2, DISC_C[1]))
await sleep(400)
const clickedPicks = await page.$eval('[data-test=flat-draft-picks]', (el) => el.textContent)
const clickedDia = Number(
  ((await page.$eval('[data-test=flat-draft-status]', (el) => el.textContent)).match(/([\d.]+)/) ?? [])[1],
)
check(
  Number(clickedPicks.replace(/[^\d]/g, '')) > 100,
  `one click on the edge takes the whole chain (${clickedPicks})`,
)
check(
  Math.abs(clickedDia - DISC_DIA) < 0.08,
  `and the clicked circle reads Ø ${DISC_DIA.toFixed(3)} mm (got ${clickedDia})`,
)
await click(page, '[data-test=flat-draft-cancel]')

// ---- snap to edge off, and a right-drag pan ----------------------------------
// With the snap off a click is the measurement; a right-drag moves the sheet
// under the cursor by exactly the drag, whatever the navigation scheme. A
// fresh point draft per check — a press on the placed pin would drag it.
const mmPerScreenPx = (2 * frustH) / rect.h
const nearEdge = [DISC_C[0] + DISC_DIA / 2 + 0.3, DISC_C[1]]
const readX = async () =>
  Number(((await page.$eval('[data-test=flat-draft-status]', (el) => el.textContent)).match(/X (-?[\d.]+)/) ?? [])[1])
await click(page, '[data-test=flat-fit-point]')
await page.mouse.click(...toScreen(...nearEdge))
await sleep(200)
check(Math.abs((await readX()) - (DISC_C[0] + DISC_DIA / 2)) < 0.08, 'snap on: the click lands on the edge')
await click(page, '[data-test=flat-draft-cancel]')
await click(page, '[data-test=flat-fit-point]')
await click(page, '[data-test=flat-draft-snap]')
await page.mouse.click(...toScreen(...nearEdge))
await sleep(200)
check(Math.abs((await readX()) - nearEdge[0]) < 0.08, 'snap off: the click is the measurement')
await click(page, '[data-test=flat-draft-cancel]')
await click(page, '[data-test=flat-fit-point]')
const [px0, py0] = toScreen(...nearEdge)
await drag(page, [px0, py0], [px0 + 120, py0], { button: 'right' })
await page.mouse.click(px0, py0)
await sleep(200)
const panned = await readX()
check(
  Math.abs(panned - (nearEdge[0] - 120 * mmPerScreenPx)) < 0.1,
  `right-drag pans the sheet (x ${panned.toFixed(2)} after a 120 px pan)`,
)
await drag(page, [px0 + 120, py0], [px0, py0], { button: 'right' })
await click(page, '[data-test=flat-draft-snap]')
check(
  await page.$eval('[data-test=flat-draft-snap]', (el) => el.checked),
  'and the snap goes back on for the rest of the run',
)
await click(page, '[data-test=flat-draft-cancel]')

// ---- a line along the rectangle's top edge ---------------------------------
await click(page, '[data-test=flat-fit-line]')
await page.select('[data-test=flat-draft-method]', 'flat-line-edge')
await drag(
  page,
  toScreen(mm(RECT.x0) + 2, RECT_TOP_Y + 0.5),
  toScreen(mm(RECT.x1) - 2, RECT_TOP_Y - 0.5),
)
await sleep(400)
await click(page, '[data-test=flat-create-element]')
await sleep(200)
rows = await rowTexts()
check(rows.length === 2, 'two elements measured')
const angle = Number((rows[1]?.match(/· (-?[\d.]+)°/) ?? [])[1])
check(Math.abs(angle) < 0.15, `the edge line is horizontal (${angle}°)`)

// ---- a picked point, and its pin dragged somewhere else ---------------------
// Alt places the raw click; the pin then drags (snapping) onto the disc's
// edge, and the fit follows the drag.
await click(page, '[data-test=flat-fit-point]')
const loose = [DISC_C[0] + DISC_DIA / 2 + 6, DISC_C[1] + 4]
await page.keyboard.down('Alt')
await page.mouse.click(...toScreen(...loose))
await page.keyboard.up('Alt')
await sleep(200)
const readPreview = () => page.$eval('[data-test=flat-draft-status]', (el) => el.textContent)
const before = await readPreview()
await drag(page, toScreen(...loose), toScreen(DISC_C[0] + DISC_DIA / 2 + 0.15, DISC_C[1]), { steps: 12 })
const after = await readPreview()
const dragX = Number((after.match(/X (-?[\d.]+)/) ?? [])[1])
check(before !== after, 'dragging the pin moves the pick')
check(
  Math.abs(dragX - (DISC_C[0] + DISC_DIA / 2)) < 0.08,
  `the dragged pin snapped onto the disc edge (x ${dragX.toFixed(3)})`,
)
await click(page, '[data-test=flat-create-element]')
await sleep(200)
rows = await rowTexts()
check(rows.length === 3 && /^Point 1/.test(rows[2]), 'the point joins the list')

// ---- the list: edit, hide, delete ------------------------------------------
const editKeys = await page.$$('[data-test=edit-element]')
await editKeys[2].click()
await sleep(200)
check(
  /Edit Point 1/.test(await page.$eval('.draftbox .sec-head', (el) => el.textContent)),
  'the pencil re-opens the element in its box',
)
await page.$eval('[data-test=flat-draft-name]', (el) => (el.value = ''))
await page.type('[data-test=flat-draft-name]', 'Rim')
await click(page, '[data-test=flat-create-element]')
await sleep(200)
rows = await rowTexts()
check(rows.length === 3 && /^Rim/.test(rows[2]), 'saving writes the element back under its new name')
const eyes = await page.$$('[data-test=element-row] .eye')
await eyes[2].click()
await sleep(150)
check(
  (await page.$$eval('[data-test=element-row].ghost', (els) => els.length)) === 1,
  'the eye hides the element',
)
const xs = await page.$$('[data-test=element-row] .x:not(.edit):not(.eye)')
await xs[2].click()
await sleep(150)
rows = await rowTexts()
check(rows.length === 2, 'the cross deletes it')

// ---- a dimension: circle center to that line -------------------------------
await click(page, '[data-test=flat-new-dimension]')
await page.select('[data-test=flat-dim-type]', 'flat-dist-point-line')
await page.select('[data-test=flat-dim-slot-0]', '1')
await page.select('[data-test=flat-dim-slot-1]', '2')
await sleep(200)
await click(page, '[data-test=flat-add-dimension]')
await sleep(300)
const readDim = () =>
  page.$eval('[data-test=dimension-row] [data-test=dimension-value]', (el) =>
    el.textContent.replace(/\s+/g, ' ').trim(),
  )
const dimRow = await readDim()
const wantDist = DISC_C[1] - RECT_TOP_Y
const gotDist = Number((dimRow?.match(/(-?[\d.]+) ?MM/i) ?? [])[1])
check(
  Math.abs(gotDist - wantDist) < 0.08,
  `center-to-edge distance reads ${wantDist.toFixed(3)} mm (got ${gotDist})`,
)

// ---- calibrate on the rectangle's known width ------------------------------
await click(page, '[data-test=flat-cal-distance]')
const midY = mm(H - (RECT.y0 + RECT.y1) / 2)
await page.mouse.click(...toScreen(mm(RECT.x0) + 0.1, midY))
await sleep(150)
await page.mouse.click(...toScreen(mm(RECT.x1) - 0.1, midY))
await sleep(250)
await page.focus('[data-test=flat-cal-true]')
await page.$eval('[data-test=flat-cal-true]', (el) => (el.value = ''))
await page.type('[data-test=flat-cal-true]', RECT_WIDTH.toFixed(3))
await page.keyboard.press('Enter')
await sleep(150)
await click(page, '[data-test=flat-cal-apply]')
await sleep(400)
check((await page.$('[data-test=flat-uncalibrated-chip]')) === null, 'calibrating clears the alarm')
rows = await rowTexts()
const diaAfter = Number((rows[0]?.match(/Ø ([\d.]+)/) ?? [])[1])
check(
  Math.abs(diaAfter - DISC_DIA) < 0.1,
  `the snapped two-point calibration lands on nominal (Ø now ${diaAfter})`,
)

// ---- datum on the rectangle edge -------------------------------------------
await click(page, '[data-test=flat-datum-set]')
await page.mouse.click(...toScreen(mm(RECT.x0) + 1, RECT_TOP_Y))
await sleep(200)
await page.mouse.click(...toScreen(mm(RECT.x1) - 1, RECT_TOP_Y))
await sleep(400)
check(
  /part frame/.test(await page.$eval('[data-test=flat-datum-status]', (el) => el.textContent)),
  'the datum commits',
)
// The dimension is frame-invariant; the datum leaves it untouched.
const dimAfter = await readDim()
check(dimAfter === dimRow, 'the datum never moves a distance')

// ---- counting ---------------------------------------------------------------
await click(page, '[data-test=flat-fit-count]')
for (let i = 0; i < 4; i++) {
  await page.mouse.click(...toScreen(mm(RECT.x0) + 2 + i * 3, RECT_TOP_Y))
  await sleep(120)
}
check(
  /^4 counted/.test(await page.$eval('[data-test=flat-count-status]', (el) => el.textContent)),
  'four clicks tally four',
)
await click(page, '[data-test=flat-count-undo]')
check(
  /^3 counted/.test(await page.$eval('[data-test=flat-count-status]', (el) => el.textContent)),
  'undo takes one back',
)
check((await page.$$('.pick-pin')).length >= 3, 'the tally wears its numbers on the sheet')
// Back on the sheet for a fourth; Enter then creates it, the way it does in
// the 3D workspace.
await page.mouse.click(...toScreen(mm(RECT.x0) + 11, RECT_TOP_Y))
await sleep(120)
await page.keyboard.press('Enter')
await sleep(200)
check(
  (await page.$eval('[data-test=flat-count-value-1]', (el) => el.textContent)) === '4',
  'Enter creates the count, listed under the elements',
)
check((await page.$('[data-test=flat-count-status]')) === null, 'and the tool is put away')

// ---- the report ------------------------------------------------------------
const buttons = await page.$$('button')
for (const b of buttons) {
  if (/Copy report/.test(await b.evaluate((el) => el.textContent))) {
    await b.click()
    break
  }
}
await sleep(400)
const report = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')
check(/Scale: CALIBRATED/.test(report), 'the report says the scale is calibrated')
check(/part datum frame/.test(report), 'and that coordinates are in the datum frame')
check(/Ø/.test(report) && /Distance to line/.test(report), 'and carries elements and dimensions')
check(/Count 1: 4/.test(report), 'and the tally')

await page.screenshot({ path: shotPath('flat-final.png') })
await finish(browser, consoleErrors)
