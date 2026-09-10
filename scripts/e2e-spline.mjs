// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the spline in 2D Measure: drives the real app in
// headless Chrome on the synthetic flatbed scan — clicks fit points along the
// disc's edge (each snapping onto it), inserts one by clicking on the curve,
// drags a tangent handle and watches the curve follow, frees it again by a
// click and by the key, closes the curve, creates the element, re-opens it
// with its handles, and reads the spline back out of the SVG as a path of
// cubic Béziers.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR, launchApp, click, check, drag, finish, repoFile, shotPath, sleep } from './e2e-lib.mjs'
import { buildPng, DISC, H, PPM, W } from './e2e-flat-fixture.mjs'

const fixture = join(OUT_DIR, 'flat-fixture.png')
writeFileSync(fixture, buildPng())

// Ground truth in document units (mm, y up) at the declared scale.
const mm = (px) => px / PPM
const SHEET_W = mm(W)
const SHEET_H = mm(H)
const DISC_C = [mm(DISC.cx), mm(H - DISC.cy)]
const R = mm(DISC.r)
const rad = (deg) => (deg * Math.PI) / 180
/** A spot on the disc's edge at `deg` counter-clockwise from +X, pushed
 *  `off` mm out along the radius. */
const onDisc = (deg, off = 0) => [DISC_C[0] + (R + off) * Math.cos(rad(deg)), DISC_C[1] + (R + off) * Math.sin(rad(deg))]

// ---- the session ------------------------------------------------------------

const { browser, page, consoleErrors } = await launchApp()
const DL_DIR = repoFile('e2e-out/spline-dl')
rmSync(DL_DIR, { recursive: true, force: true })
mkdirSync(DL_DIR, { recursive: true })
const cdp = await browser.target().createCDPSession()
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DL_DIR,
  eventsEnabled: true,
})

await click(page, '[data-test=workspace-flat]')
await click(page, '[data-test=support-card] .sc-x').catch(() => {})
const input = await page.$('input[type=file][accept*=".png"]')
await input.uploadFile(fixture)
await page.waitForFunction(
  () => /chains found/.test(document.querySelector('[data-test=flat-edge-status]')?.textContent ?? ''),
  { timeout: 60_000 },
)

// Screen mapping for the framed sheet — the same framing e2e-flat aims by.
const rect = await page.$eval('.viewslot:not([hidden]) .viewport canvas:not(.loupe)', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const aspect = rect.w / rect.h
const frustH = Math.max((SHEET_H / 2) * 1.08, ((SHEET_W / 2) * 1.08) / aspect)
const toScreen = (mx, my) => [
  rect.x + (rect.w * ((mx - SHEET_W / 2) / (frustH * aspect) + 1)) / 2,
  rect.y + (rect.h * (1 - (my - SHEET_H / 2) / frustH)) / 2,
]

const hint = () => page.$eval('[data-test=flat-draft-hint]', (el) => el.textContent)
const status = () => page.$eval('[data-test=flat-draft-status]', (el) => el.textContent)
const picks = () => page.$eval('[data-test=flat-draft-picks]', (el) => el.textContent)
const readLength = async () => Number(((await status()).match(/L ([\d.]+)/) ?? [])[1])
/** The handle ends on the sheet, in order — the leaving end then the
 *  arriving end of every pin — with whether each is fixed. */
const handles = () =>
  page.$$eval('[data-test=flat-handle]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, fixed: e.classList.contains('fixed') }
    }),
  )
const pins = () =>
  page.$$eval('.pick-pin', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { n: e.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }),
  )
const rowTexts = () =>
  page.$$eval('[data-test=element-row]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))

// ---- fit points along the disc's edge --------------------------------------
await click(page, '[data-test=flat-fit-spline]')
check(/Click the points the curve runs through/.test(await hint()), 'the Spline key opens with the fit-point hint')
check((await page.$('[data-test=flat-draft-closed]')) !== null, 'and offers the closed-curve checkbox')
check(
  await page.$eval('[data-test=flat-draft-free-tangents]', (el) => el.disabled),
  'Free tangents waits until one is set',
)
// Four points on the left of the disc, 40° apart, each clicked a fifth of a
// millimetre outside the edge so the snap has to pull it on.
const angles = [100, 140, 180, 220]
for (const a of angles) {
  await page.mouse.click(...toScreen(...onDisc(a, 0.2)))
  await sleep(150)
}
check((await picks()) === '4 picks', 'four clicks are four fit points')
const arc = R * rad(120)
const len4 = await readLength()
check(
  len4 < arc && arc - len4 < 0.06,
  `the curve through the snapped points runs a hair inside the 120° arc they lie on: L ${len4} for ${arc.toFixed(3)}`,
)
check(/4 fit points/.test(await page.$eval('.draftbox .dro-note', (el) => el.textContent)), 'the preview counts the points')
let ends = await handles()
check(ends.length === 8, 'a handle with two ends at every point')
check(ends.every((h) => !h.fixed), 'all of them automatic')
check((await pins()).length === 4, 'and a numbered pin on each')

// ---- insert a point by clicking on the curve --------------------------------
// Between the 2nd and 3rd points the curve hugs the disc's edge: a click on
// the edge at 160° is a click on the curve, and goes in as pin 3.
await page.mouse.click(...toScreen(...onDisc(160)))
await sleep(200)
check((await picks()) === '5 picks', 'a click on the curve inserts a point')
const pin3 = (await pins()).find((p) => p.n === '3')
const [ix, iy] = toScreen(...onDisc(160))
check(
  !!pin3 && Math.abs(pin3.x - ix) < 6 && Math.abs(pin3.y - iy) < 6,
  'between the points it ran between — it is pin 3, where the click landed',
)
check((await handles()).length === 10, 'and gets a handle of its own')
const len5 = await readLength()

// ---- a tangent handle dragged, and let go again ------------------------------
ends = await handles()
const h0 = ends[0]
await drag(page, [h0.x, h0.y], [h0.x + 50, h0.y + 30], { steps: 10 })
let after = await handles()
check(after.filter((h) => h.fixed).length === 2, "dragging a handle end fixes that point's tangent — both ends filled")
check(
  Math.abs(after[0].x - (h0.x + 50)) < 3 && Math.abs(after[0].y - (h0.y + 30)) < 3,
  'the handle end follows the hand',
)
const lenBent = await readLength()
check(Math.abs(lenBent - len5) > 0.01, `bending the tangent changes the curve (L ${len5} → ${lenBent})`)
check(/1 tangent set/.test(await page.$eval('.draftbox .dro-note', (el) => el.textContent)), 'the preview notes one tangent set')
check((await picks()) === '5 picks', 'and the drag added no pick')
// A click on the handle end frees it; the curve is as it was.
await page.mouse.click(after[0].x, after[0].y)
await sleep(200)
check((await handles()).every((h) => !h.fixed), 'a click on a handle lets its tangent go automatic again')
check(Math.abs((await readLength()) - len5) < 1e-6, 'and the curve is as it was')
check((await picks()) === '5 picks', 'with no pick added by the click')
// The key frees every one at once.
ends = await handles()
await drag(page, [ends[4].x, ends[4].y], [ends[4].x - 40, ends[4].y + 10], { steps: 10 })
check(
  !(await page.$eval('[data-test=flat-draft-free-tangents]', (el) => el.disabled)),
  'Free tangents is live once a tangent is set',
)
await click(page, '[data-test=flat-draft-free-tangents]')
await sleep(150)
check((await handles()).every((h) => !h.fixed), 'and frees every one')

// ---- a pin dragged, the curve following ------------------------------------
const pin1 = (await pins()).find((p) => p.n === '1')
await drag(page, [pin1.x, pin1.y], toScreen(...onDisc(90, 0.2)), { steps: 10 })
const lenMoved = await readLength()
check(lenMoved > len5 + 0.5, `dragging a pin moves its point and the curve with it (L ${len5} → ${lenMoved})`)
await drag(page, toScreen(...onDisc(90)), toScreen(...onDisc(100, 0.2)), { steps: 10 })
check(Math.abs((await readLength()) - len5) < 0.02, 'and back again')

// ---- closed by a click on the first pin, then created -----------------------
check(/click the first pin to close/.test(await hint()), 'the hint offers the first pin to close on')
const first = (await pins()).find((p) => p.n === '1')
await page.mouse.click(first.x, first.y)
await sleep(200)
const lenClosed = await readLength()
check(
  lenClosed > len5 && /closed/.test(await status()),
  `a click on the first pin closes the curve, adding the return leg (L ${len5} → ${lenClosed})`,
)
check((await picks()) === '5 picks', 'and takes no pick back')
check(await page.$eval('[data-test=flat-draft-closed]', (el) => el.checked), 'the Closed curve box follows')
check((await handles()).length === 10, 'the closed curve keeps a handle at every point')
await click(page, '[data-test=flat-draft-closed]')
await sleep(150)
check(!/closed/.test(await status()), 'the box opens it again')
await page.screenshot({ path: shotPath('spline-draft.png') })
await click(page, '[data-test=flat-create-element]')
await sleep(200)
let rows = await rowTexts()
check(rows.length === 1 && /^Spline 1/.test(rows[0]) && /L [\d.]+ mm/.test(rows[0]), `the spline joins the list: ${rows[0]}`)
check((await page.$$('[data-test=flat-handle]')).length === 0, 'and its handles leave the sheet with the draft')

// ---- re-opened with its handles --------------------------------------------
await click(page, '[data-test=edit-element]')
await sleep(200)
check(/Edit Spline 1/.test(await page.$eval('.draftbox .sec-head', (el) => el.textContent)), 'the pencil re-opens the spline')
check((await picks()) === '5 picks' && (await handles()).length === 10, 'with its five pins and their handles')
await click(page, '[data-test=flat-draft-undo]')
check((await picks()) === '4 picks', 'Undo point takes the last one back')
await click(page, '[data-test=flat-draft-cancel]')
await sleep(150)
rows = await rowTexts()
check(rows.length === 1 && /^Spline 1/.test(rows[0]), 'Cancel leaves the element as it was')

// ---- the SVG: the spline as cubic Béziers ------------------------------------
await click(page, '[data-test=flat-export-svg]')
let svgFile = null
for (let i = 0; i < 50 && !svgFile; i++) {
  await sleep(200)
  const done = readdirSync(DL_DIR).filter((f) => f.endsWith('.svg'))
  if (done.length) svgFile = join(DL_DIR, done[0])
}
check(!!svgFile, 'Export SVG downloads an .svg file')
if (svgFile) {
  const svg = readFileSync(svgFile, 'utf8')
  const path = svg.match(/<g id="element-1" data-name="Spline 1"[^>]*>\s*<title>[^<]*<\/title>\s*<path d="([^"]+)"/)
  check(!!path, 'the spline is a <path> under its name')
  if (path) {
    const d = path[1]
    check(/^M( -?[\d.]+){2}( C( -?[\d.]+){6}){4}$/.test(d), `of four cubic Béziers: ${d.slice(0, 48)}…`)
    const [x0, y0] = d.match(/^M (-?[\d.]+) (-?[\d.]+)/).slice(1).map(Number)
    const p = onDisc(100)
    check(
      Math.abs(x0 - p[0]) < 0.1 && Math.abs(y0 - (SHEET_H - p[1])) < 0.1,
      `starting where the first point was picked, y down (${x0}, ${y0})`,
    )
  }
}

await page.screenshot({ path: shotPath('spline-final.png') })
await finish(browser, consoleErrors)
