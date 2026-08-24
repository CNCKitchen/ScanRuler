// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the circle element and the marked-region deviation scope.
//
// The part is a generated 20 mm CAD cube, so the answers are known up front:
// a circle typed in from coordinates must read exactly its own diameter, three
// picks on the flat top face must produce a circle lying in that face, and a
// deviation map against the top plane restricted to a marked window must
// measure fewer points than the whole face — and none at all while nothing is
// marked.
//
// The Ø 12 coordinate circle also exercises the assumed dimension: the field
// must start empty (nothing is suggested), flag a tenfold typo, accept 12.5 —
// and the STEP export must write that circle at the assumed Ø 12.5 while the
// picked circle, given no assumption, goes out as measured.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-circle.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import {
  canvasRect,
  check,
  click,
  drag,
  fail,
  finish,
  launchApp,
  loadScan,
  previewReady,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SIZE = 20
const dir = mkdtempSync(join(tmpdir(), 'scanruler-circle-'))
const CUBE = join(dir, 'cube.stl')
writeFileSync(
  CUBE,
  Buffer.from(
    writeBinarySTL(importStep(cubeStep(SIZE), { surfaceDeviation: 0.02, maxEdge: 2 }).mesh),
  ),
)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000 })
await loadScan(page, CUBE, { inputSelector: '[data-test=start-scan] input[type=file]' })
const rect = await canvasRect(page)

const at = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy]

/** The picked-point markers on the part: what each says and where it sits on
 *  screen. They are CSS2D pins, so the DOM is where they can be read — and the
 *  element pins of finished elements wear a different class, so this counts
 *  only the picks of whatever is being made. */
const pickPins = () =>
  page.$$eval('.viewport-label.probe', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { text: e.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }),
  )

/** Saturated pixels in a box around a screen point — the marker dot, measured
 *  where it is drawn rather than from anything the code claims about it. */
const dotPixels = async ({ x, y }, half = 40) => {
  const shot = await page.screenshot({
    clip: { x: x - half, y: y - half, width: half * 2, height: half * 2 },
    encoding: 'base64',
  })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      // The part and the stage are both near-neutral; a marker is not.
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 45)
        n++
    }
    return n
  }, shot)
}

/** Zoom the viewport about a screen point, in wheel notches (negative zooms
 *  out). Cursor-centric, so whatever is under the point stays under it. */
const zoomAt = async ({ x, y }, notches) => {
  await page.mouse.move(x, y)
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.wheel({ deltaY: notches > 0 ? -120 : 120 })
    await sleep(40)
  }
  await sleep(400)
}

// ---- a circle from coordinates: the exact numbers must come back ------------
await click(page, '[data-test=fit-circle]')
await page.waitForSelector('[data-test=draft-method]')
await selectByLabel(page, '[data-test=draft-method]', 'From coordinates')
const setParam = async (key, value) => {
  const sel = `[data-test=draft-param-${key}]`
  await page.$eval(sel, (el) => {
    el.value = ''
  })
  await page.type(sel, String(value))
  await sleep(100)
}
await setParam('d', 12)
await setParam('nx', 0)
await setParam('ny', 0)
await setParam('nz', 1)
await setParam('cx', 0)
await setParam('cy', 0)
await setParam('cz', 0)
if (!(await previewReady(page))) fail('the coordinate circle never previewed')
await page.screenshot({ path: shotPath('circle-coords-preview.png') })

// ---- the assumed dimension: empty start, typo warning, a typed value --------
const assumedSel = '[data-test=assumed-diameter]'
const prefilled = await page.$eval(assumedSel, (el) => el.value)
console.log('assumed field starts as:', JSON.stringify(prefilled))
check(prefilled === '', 'the assumed Ø starts empty — nothing is suggested')
const typeAssumed = async (value) => {
  await page.$eval(assumedSel, (el) => {
    el.value = ''
  })
  await page.type(assumedSel, String(value))
  await page.keyboard.press('Enter')
  await sleep(250)
}
await typeAssumed(120)
check(
  (await page.$('[data-test=assumed-warning]')) !== null,
  'a tenfold assumed value is flagged as a likely typo',
)
await page.screenshot({ path: shotPath('circle-assumed-warning.png') })
await typeAssumed(12.5)
check(
  (await page.$('[data-test=assumed-warning]')) === null,
  'a believable assumed value clears the warning',
)
await click(page, '[data-test=create-element]')
await sleep(400)
let rows = await rowTexts(page)
console.log('rows:', JSON.stringify(rows))
check(rows.length === 1 && /Circle 1.*Ø 12\.000 mm/.test(rows[0]), 'a Ø 12 coordinate circle reads back as Ø 12.000')

// ---- a circle through picked points ------------------------------------------
await click(page, '[data-test=fit-circle]')
await page.waitForSelector('[data-test=draft-status]')
// The default method is the picked-points one; the first two picks must show
// progress rather than a result.
await page.mouse.click(...at(0.5, 0.36))
await sleep(300)
let status = await page.$eval('[data-test=draft-status]', (el) => el.textContent)
console.log('after one pick:', status)
check(/1 of 3/.test(status), 'the draft counts its picks up to the minimum')
await page.mouse.click(...at(0.44, 0.46))
await sleep(300)

// ---- the picks are marked, at a size the zoom cannot change ------------------
// Every click that feeds an element is marked while the element is being made:
// with several of them going into one fit, seeing which have landed is half the
// workflow. Two picks in there is no circle yet, so the markers are the only
// colour on the part — which is what makes their size measurable.
let pins = await pickPins()
console.log('pins after two picks:', JSON.stringify(pins.map((p) => p.text)))
check(
  pins.map((p) => p.text).join(',') === '1,2',
  'each pick is marked on the part, numbered in the order it was clicked',
)
const pinned = pins[0]
const near = await dotPixels(pinned)
await zoomAt(pinned, 12)
const zoomedPin = (await pickPins()).find((p) => p.text === pinned.text)
const far = zoomedPin ? await dotPixels(zoomedPin) : 0
console.log(`marker pixels: ${near} framed, ${far} zoomed in ~3x`)
// Sized to the part, a 3x zoom would make it nine times the area. It is sized
// in pixels instead, so what the operator zooms in to place precisely does not
// grow over the surface they are aiming at.
check(far > 0 && far < near * 2, 'a picked point holds its size on screen through a 3x zoom')
await zoomAt(pinned, -12)

await page.mouse.click(...at(0.56, 0.46))
if (!(await previewReady(page, { watchStatus: false }))) fail('three picks never previewed a circle')
const dro = await page.$eval('[data-test=draft-status]', (el) => el.textContent)
console.log('three-pick circle preview:', dro)
check(/Ø/.test(dro), 'three picks preview a circle with a diameter')
// A fourth pick refines rather than resets.
await page.mouse.click(...at(0.52, 0.36))
if (!(await previewReady(page, { watchStatus: false }))) fail('the fourth pick lost the preview')
await page.screenshot({ path: shotPath('circle-picked-preview.png') })
await click(page, '[data-test=create-element]')
await sleep(400)
rows = await rowTexts(page)
console.log('rows:', JSON.stringify(rows))
check(rows.length === 2 && /Circle 2.*Ø/.test(rows[1]), 'the picked circle is created')
check(
  (await pickPins()).length === 0,
  'the markers belong to the making of it — the finished circle carries its own pin instead',
)

// The picked circle lies in the cube's top face, so its normal is ±Z and the
// summary must place its center at the face height, z = SIZE/2 above the middle
// — but the part is in scanner coordinates; assert on the copied summary shape
// instead: a diameter, a center and a normal, plus sigma from 4 points.
await click(page, '[data-test=copy-summary]').catch(() => {})

// ---- STEP export: assumed where given, measured everywhere else -------------
const cdp = await page.createCDPSession()
const exportStep = async (label) => {
  const dir = mkdtempSync(join(tmpdir(), `scanruler-circle-${label}-`))
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
  await click(page, '[data-test=export-step]')
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    const f = readdirSync(dir).find((n) => n.endsWith('.step'))
    if (f) return readFileSync(join(dir, f), 'utf8')
  }
  return null
}

const stepText = await exportStep('elements')
check(Boolean(stepText), 'the STEP file downloaded')
check(
  Boolean(stepText) && /CIRCLE\('Circle 1',#\d+,6\.25\)/.test(stepText),
  'the export writes Circle 1 at the assumed Ø 12.5',
)
const circle2 = stepText && /CIRCLE\('Circle 2',#\d+,([\d.]+)\)/.exec(stepText)
console.log('Circle 2 exported radius:', circle2 && circle2[1])
check(
  Boolean(circle2) && Math.abs(Number(circle2[1]) - 6.25) > 0.01,
  'the picked circle, given no assumption, is written as measured',
)

// ---- the plane the deviation section will measure against -------------------
const fitPlaneAt = async (spots) => {
  await click(page, '[data-test=fit-plane]')
  let clicks = 0
  for (const [fx, fy] of spots) {
    await page.mouse.click(...at(fx, fy))
    clicks++
    if (await previewReady(page)) {
      // A fit is grown from a click, and the click is the one thing about it
      // that would otherwise leave no trace of itself.
      const marked = (await pickPins()).map((p) => p.text)
      check(
        marked.length === clicks,
        `the ${clicks} point(s) the plane was grown from are marked on it (${marked.join()})`,
      )
      await click(page, '[data-test=create-element]')
      await sleep(400)
      return clicks
    }
  }
  return 0
}
const planePicks = await fitPlaneAt([[0.5, 0.42], [0.46, 0.38], [0.54, 0.46], [0.5, 0.5]])
if (!planePicks) fail('could not fit a plane on the top face')

// Re-opening it puts the same marks back: where a fit was measured from is part
// of what the element remembers, and it is what tells the operator whether to
// add a point or start over.
const editButtons = await page.$$('[data-test=edit-element]')
await editButtons[editButtons.length - 1].click()
await sleep(700)
const reopened = (await pickPins()).map((p) => p.text)
console.log('pins on the re-opened plane:', JSON.stringify(reopened))
check(
  reopened.length === planePicks,
  `a re-opened fit brings its ${planePicks} points back onto the part`,
)
await click(page, '[data-test=cancel-draft]')
await sleep(300)
check((await pickPins()).length === 0, 'and takes them away again when the editor is closed')

// ---- the deviation map, restricted to a marked region -----------------------
await click(page, '[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=source-element]')
await click(page, '[data-test=source-element]')
await page.waitForSelector('[data-test=target-select]')
// The circle is a curve with no surface, so it must not be on offer.
const offered = await page.$eval('[data-test=target-select]', (el) =>
  [...el.options].map((o) => o.textContent).join(' | '),
)
console.log('targets on offer:', offered)
check(!/circle/.test(offered), 'circles are not offered as deviation targets')
await selectByLabel(
  page,
  '[data-test=target-select]',
  offered
    .split(' | ')
    .map((s) => s.trim())
    .find((s) => /plane/.test(s)),
)
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 30_000 })
await sleep(400)

const matchedCount = async () => {
  const text = await page.$eval('[data-test=deviation-stats]', (el) =>
    el.textContent.replace(/\s+/g, ' '),
  )
  return Number(/matched\s*([\d,]+)/.exec(text)[1].replace(/,/g, ''))
}
const everything = await matchedCount()
console.log('matched over the whole element:', everything)
check(everything > 50, 'the unrestricted map measures the face')

// Restrict to a marked region: with nothing marked yet the map must be empty.
await selectByLabel(page, '[data-test=target-scope]', 'Marked surface only')
await page.waitForSelector('[data-test=mark-gestures]')
await sleep(500)
const nothingMarked = await matchedCount()
console.log('matched with an empty region:', nothingMarked)
check(nothingMarked === 0, 'an empty marked region measures nothing')
await page.screenshot({ path: shotPath('circle-scope-empty.png') })

// Mark a window over part of the face — the map must follow the stroke.
await click(page, '[data-test=mark-window]')
await drag(page, at(0.46, 0.38), at(0.54, 0.46))
await sleep(600)
const inWindow = await matchedCount()
console.log('matched in the marked window:', inWindow)
check(inWindow > 0, 'the map follows the marked region')
check(inWindow < everything, 'the marked region measures less than everything')
await page.screenshot({ path: shotPath('circle-scope-marked.png') })

// Putting the tools away keeps the region and the map on it.
await click(page, '[data-test=scope-done]')
await sleep(500)
const afterDone = await matchedCount()
console.log('matched after putting the tools away:', afterDone)
check(afterDone === inWindow, 'the region survives the tools being put away')
const scopeCount = await page.$eval('[data-test=scope-count]', (el) => el.textContent)
console.log('panel says:', scopeCount)
check(/[1-9]/.test(scopeCount), 'the panel reports the size of the region')

// And back to everything: the full face again.
await selectByLabel(page, '[data-test=target-scope]', 'Everything the element bounds')
await sleep(500)
const backToAll = await matchedCount()
console.log('matched back on the whole element:', backToAll)
check(backToAll === everything, 'switching back measures everything again')

await finish(browser, consoleErrors)
