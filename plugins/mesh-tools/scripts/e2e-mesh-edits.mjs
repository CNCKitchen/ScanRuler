// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the Mesh Tools edits beyond Remove islands: drives the
// real app in headless Chrome on a generated scan — a noisy box standing on
// the XY plane with two holes in its top — and fills one hole by clicking its
// ring and the other with the button, smooths the scan, cuts it with a plane,
// and deletes a patch of it marked with a window, checking after each that
// the edited copy is what changed and the scan every other workspace measures
// is not. Colours the copy by its deviation from the scan, takes it into use,
// then steps back through all of it with Ctrl+Z to the scan as it was
// opened, forward again with Ctrl+Y, and reads what the cut preview says of
// a plane across the hole left open.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-edits.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canvasRect, check, colouredFraction, drag, fieldSetter, finish, launchApp, loadScan, MOD, OUT_DIR, setViewTheme, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { noisyBoxScan } from '../../../scripts/e2e-fixtures.mjs'

// ---- the scan: a box 30 × 30 × 20 on the XY plane, noisy, with two 3 mm
// holes in its top, at X −7 and X 7 ----------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })
const fixture = noisyBoxScan({ seed: 11, noise: 0.03, holes: true, header: 'ScanRuler e2e box with a hole' })
const SCAN = join(OUT_DIR, 'mesh-edits-box.stl')
writeFileSync(SCAN, fixture.bytes)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const count = (text) => Number(String(text).replace(/[^\d]/g, ''))
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const scanCount = async () => count((await page.$eval('.file-info span', (el) => el.textContent)).split('·')[0])
// The edits waiting on the copy, those in use, and the copy's triangles.
const edits = async () => (await page.$$('[data-test=pending-edit]')).length
const inUse = async () => (await page.$$('[data-test=scan-edit]')).length
const copyCount = async () => count((await text('[data-test=edited-triangles] b')).split('·')[0])
const setField = fieldSetter(page)
/** Until the copy's list of edits holds `n`, and nothing is busy any more. */
const editsReach = async (n) => {
  await page.waitForFunction((k) => document.querySelectorAll('[data-test=pending-edit]').length === k, { timeout: 300_000 }, n)
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(500)
}
const stage = async () => {
  const r = await canvasRect(page, '.viewslot canvas')
  return page.screenshot({ clip: { x: r.x, y: r.y, width: r.w - 190, height: r.h }, encoding: 'base64' })
}
const orangePixels = async () =>
  page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 50 && d[i + 1] < 140 && d[i + 2] < 90) n++
    return n
  }, await stage())
/** The orange marks on the part, gathered into blobs — each hole's rim and
 *  ring — as the page coordinates of their middles, left to right. */
const orangeBlobs = async () => {
  const r = await canvasRect(page, '.viewslot canvas')
  const cells = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // Orange pixels, counted into cells 6 px square.
    const cells = {}
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (d[i] > 200 && d[i + 1] > 50 && d[i + 1] < 140 && d[i + 2] < 90) {
          const key = `${Math.floor(x / 6)},${Math.floor(y / 6)}`
          const cell = (cells[key] ??= [0, 0, 0])
          cell[0]++
          cell[1] += x
          cell[2] += y
        }
      }
    }
    return cells
  }, await stage())
  // Cells that touch are one blob.
  const seen = new Set()
  const blobs = []
  for (const start of Object.keys(cells)) {
    if (seen.has(start)) continue
    seen.add(start)
    const queue = [start]
    let n = 0, sx = 0, sy = 0
    while (queue.length) {
      const key = queue.pop()
      const [cx, cy] = key.split(',').map(Number)
      const [k, x, y] = cells[key]
      n += k
      sx += x
      sy += y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = `${cx + dx},${cy + dy}`
          if (cells[next] && !seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
    }
    if (n > 20) blobs.push({ x: r.x + sx / n, y: r.y + sy / n, n })
  }
  // A hole's rim is a line a pixel wide, antialiased across two rows, and
  // where neither row is orange enough it comes apart — the rendering does
  // that differently from one renderer and one shading of the part to the
  // next. The rim is some 80 px across and the holes some 370 px apart, so
  // marks within 150 px of each other are the same hole.
  const merged = []
  for (const b of blobs) {
    const near = merged.find((m) => Math.hypot(m.x - b.x, m.y - b.y) < 150)
    if (!near) merged.push({ ...b })
    else {
      const n = near.n + b.n
      near.x = (near.x * near.n + b.x * b.n) / n
      near.y = (near.y * near.n + b.y * b.n) / n
      near.n = n
    }
  }
  return merged.sort((a, b) => a.x - b.x)
}
// Each step says so on the status line, naming what it stepped over — a line
// other than the last one's.
const step = async (key, word) => {
  const before = await page.$eval('.strip .msg', (el) => el.textContent).catch(() => '')
  await page.keyboard.down(MOD)
  await page.keyboard.press(key)
  await page.keyboard.up(MOD)
  await page.waitForFunction(
    (w, b) => {
      const now = document.querySelector('.strip .msg')?.textContent ?? ''
      return now !== b && new RegExp(w).test(now)
    },
    { timeout: 300_000 },
    word,
    before,
  )
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
  await sleep(400)
}

await setViewTheme(page, 'studio')
await page.click('[data-test=support-card] .sc-x').catch(() => {})
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=start-pane]')
await loadScan(page, SCAN, { inputSelector: '[data-test=start-scan] input[type=file]', timeout: 120_000, settle: 600 })
const opened = await scanCount()
check(opened === fixture.triangles, `the scan opens with its ${fixture.triangles} triangles`)
for (const id of ['reduce', 'islands', 'delete', 'cut', 'holes', 'smooth']) {
  check(Boolean(await page.$(`[data-test=mesh-tool-${id}]`)), `the ${id} tool has a key`)
}

// ---- Fill holes: the holes in the top are found and ringed; one is closed by
// a click on its ring, the other with the button ---------------------------------
await page.click('[data-test=mesh-tool-holes]')
await page.waitForSelector('[data-test=holes-count]', { timeout: 60_000 })
console.log(`holes: ${await text('[data-test=holes-rims]')} · ${await text('[data-test=holes-count]')}`)
check(count(await text('[data-test=holes-rims] b')) === 2, 'the scan has two open rims')
check(count(await text('[data-test=holes-count] b')) === 2, 'and both are holes under the size suggested for the part')
check((await orangePixels()) > 100, 'the holes are marked on the part')
check(/Fill 2 holes/.test(await text('[data-test=fill-holes]')), 'the button says how many it fills')
await page.screenshot({ path: shotPath('mesh-edits-hole.png') })
const blobs = await orangeBlobs()
console.log('rings on screen:', blobs.map((b) => `${b.x.toFixed(0)},${b.y.toFixed(0)}`).join(' · '))
check(blobs.length === 2, 'each hole is a mark of its own')
await page.mouse.move(blobs[0].x, blobs[0].y)
await sleep(300)
check(
  await page.$eval('.viewslot canvas', (el) => el.style.cursor === 'pointer'),
  'the pointer over a ring says it can be clicked',
)
await page.screenshot({ path: shotPath('mesh-edits-hole-hover.png') })
await page.mouse.click(blobs[0].x, blobs[0].y)
await editsReach(1)
const filledOne = await copyCount()
console.log(`filled one: ${opened} → ${filledOne} triangles; ${await text('.strip .msg')}`)
check(filledOne > opened, 'a click on a ring fills that hole — on the edited copy')
check((await scanCount()) === opened, 'the scan in use is left as it was')
check((await inUse()) === 0, 'and nothing is in use yet')
check(/Filled the hole/.test(await text('.strip .msg')), 'the status line says it filled the one hole')
await page.waitForFunction(() => /^1$/.test(document.querySelector('[data-test=holes-count] b')?.textContent ?? ''), { timeout: 60_000 })
check(true, 'the other hole is still there')
const left = await orangeBlobs()
check(left.length === 1 && Math.abs(left[0].x - blobs[1].x) < 12, 'and still marked where it was')
await page.mouse.move(10, 10)
await page.click('[data-test=fill-holes]')
await editsReach(2)
const filled = await copyCount()
console.log(`filled: ${filledOne} → ${filled} triangles; ${await text('.strip .msg')}`)
check(filled > filledOne, 'the button fills the rest')
check(/Filled 1 hole/.test(await text('.strip .msg')), 'the status line says what was filled')
await page.waitForSelector('[data-test=holes-closed]', { timeout: 60_000 })
check(true, 'the filled scan is closed — no rim is left')
check((await orangePixels()) === 0, 'and nothing is marked on it')
check(/Filled 1 hole under/.test(await text('[data-test=pending-edit]')), 'the fills are listed on the copy')
await page.screenshot({ path: shotPath('mesh-edits-filled.png') })

// ---- Smooth: the scan's scatter taken out, within the limit -------------------
await page.click('[data-test=mesh-tool-smooth]')
await page.waitForSelector('[data-test=smooth-tool]')
const limit = Number(await page.$eval('[data-test=smooth-limit]', (el) => el.value))
check(limit > 0 && limit < 0.2, `a limit is suggested for the part (${limit} mm)`)
const size = Number(await page.$eval('[data-test=smooth-size]', (el) => el.value))
// The box's mesh is 0.5 mm: a patch needs a few of its edges.
check(size >= 1, `a size is suggested for the part and its mesh (${size} mm)`)
await page.click('[data-test=smooth-scan]')
await editsReach(3)
const smoothed = await text('.strip .msg')
console.log('smoothed:', smoothed)
const moved = Number(smoothed.match(/at most ([\d.]+) mm/)?.[1])
const rms = Number(smoothed.match(/RMS ([\d.]+) mm/)?.[1])
check(moved > 0 && moved <= limit + 1e-6, 'smoothing moves the surface, no further than the limit')
check(rms > 0.005, `and moves it by about the scatter it was given (RMS ${rms} mm)`)
check((await copyCount()) === filled, 'and keeps every triangle')

// ---- Cut: shown before it is made, then made ----------------------------------
await page.click('[data-test=mesh-tool-reduce]')
await sleep(400)
const whole = await stage()
await page.click('[data-test=mesh-tool-cut]')
await page.waitForSelector('[data-test=cut-tool]')
await sleep(400)
const middle = Number(await page.$eval('[data-test=cut-offset]', (el) => el.value))
check(Math.abs(middle - 10) < 0.05, `the plane starts through the middle of the part (Z ${middle})`)
const preview = await stage()
const changed = await page.evaluate(
  async (a, b) => {
    const load = async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const px = (img) => {
      const c = new OffscreenCanvas(img.width, img.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height).data
    }
    const pa = px(ia)
    const pb = px(ib)
    let n = 0
    for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 30) n++
    return n / (pa.length / 4)
  },
  whole,
  preview,
)
console.log(`cut preview changes ${(changed * 100).toFixed(1)} % of the stage`)
check(changed > 0.01, 'the part is shown cut while the tool is in hand')
await page.waitForSelector('[data-test=cut-closes]', { timeout: 60_000 })
check(/closed flat\./.test(await text('[data-test=cut-closes]')), 'and the panel says the cut will close flat')
await page.screenshot({ path: shotPath('mesh-edits-cut-preview.png') })
await setField('[data-test=cut-offset]', 5)
await page.click('[data-test=cut-scan]')
await editsReach(4)
const cutStatus = await text('.strip .msg')
console.log('cut:', cutStatus, '·', await copyCount(), 'triangles')
check(/Cut at XY plane, Z 5 mm/.test(cutStatus), 'the status line says where it was cut')
check(/closed flat/.test(cutStatus), 'and that the part was closed flat')
const cut = await copyCount()
check(cut < filled, 'the cut takes triangles off')
await page.click('[data-test=mesh-tool-holes]')
await page.waitForSelector('[data-test=holes-closed]', { timeout: 60_000 })
check(true, 'the cut part is still closed')
await page.screenshot({ path: shotPath('mesh-edits-cut.png') })

// ---- Delete marked: a window over the part, asked, deleted --------------------
await page.click('[data-test=mesh-tool-delete]')
await page.waitForSelector('[data-test=delete-tool]')
check(await page.$eval('[data-test=delete-marked]', (el) => el.disabled), 'nothing to delete before anything is marked')
await page.click('[data-test=mark-window]')
const r = await canvasRect(page, '.viewslot canvas')
const cx = r.x + (r.w - 190) / 2
const cy = r.y + r.h / 2
await drag(page, [cx - 40, cy - 40], [cx + 40, cy + 40], { steps: 10 })
await sleep(400)
const marked = count(await text('[data-test=mark-count]'))
console.log(`marked: ${marked} points`)
check(marked > 0, 'the window marks surface')
check((await orangePixels()) > 500, 'marked surface shows in orange')
await page.keyboard.press('Escape')
await sleep(200)
check(
  await page.$eval('[data-test=mark-navigate]', (el) => el.getAttribute('aria-pressed') === 'true'),
  'Escape gives the camera back, the marking kept',
)
const beforeDelete = await copyCount()
await page.click('[data-test=delete-marked]')
await page.waitForSelector('[data-test=delete-confirm]')
await page.click('[data-test=delete-keep]')
await sleep(200)
check((await copyCount()) === beforeDelete, 'nothing is deleted without a yes')
await page.click('[data-test=delete-marked]')
await page.waitForSelector('[data-test=delete-confirm]')
await page.screenshot({ path: shotPath('mesh-edits-delete-confirm.png') })
await page.click('[data-test=delete-marked-confirm]')
await editsReach(5)
const deleted = await copyCount()
console.log(`deleted: ${beforeDelete} → ${deleted} triangles; ${await text('.strip .msg')}`)
check(deleted < beforeDelete, 'the marked surface is gone from the scan')
check(count(await text('[data-test=mark-count]')) === 0, 'and the marking with it')
await page.screenshot({ path: shotPath('mesh-edits-deleted.png') })

// ---- the copy against the scan, and taken into use -------------------------------
// Coloured by how far it is from the scan in use: the smoothing is a reading,
// the patches and the cap are surface the scan never had.
check(await page.$eval('[data-test=toggle-copy-deviation]', (el) => !el.disabled), 'the view bar offers the deviation of the copy')
await page.click('[data-test=toggle-copy-deviation]')
await page.waitForSelector('[data-test=copy-legend]', { timeout: 120_000 })
const legend = await text('[data-test=copy-legend]')
console.log('deviation:', legend)
check(/max/.test(legend) && /RMS/.test(legend), 'the copy is coloured by its deviation from the scan, with its figures')
check(/added/.test(legend), 'and says how much of it an edit made')
check((await colouredFraction(page)) > 0.05, 'the map is painted on the copy')
await page.screenshot({ path: shotPath('mesh-edits-deviation.png') })
await page.click('[data-test=toggle-copy-deviation]')
await sleep(300)

// Every other workspace still measures the scan as it was opened.
await page.click('[data-test=workspace-elements]')
await sleep(400)
check((await scanCount()) === opened, '3D Measure still measures the scan as opened')
// And says so on its stage, with the way back to the copy.
const note = await text('[data-test=edited-copy-note]')
console.log('note:', note)
check(/edited copy/.test(note) && /5 edits/.test(note), 'the stage says an edited copy with five edits is not in use')
await page.screenshot({ path: shotPath('mesh-edits-note.png') })
await page.click('[data-test=edited-note-show]')
await sleep(300)
check((await copyCount()) === deleted, 'Show goes to Mesh Tools, which still shows the copy')
check(!(await page.$('[data-test=edited-copy-note]')), 'with no note in its own workspace')
// Hidden, it stays hidden for that copy.
await page.click('[data-test=workspace-elements]')
await sleep(300)
await page.click('[data-test=edited-note-dismiss]')
await sleep(200)
check(!(await page.$('[data-test=edited-copy-note]')), 'the note can be put away')
await page.click('[data-test=workspace-mesh]')
await sleep(300)
await page.click('[data-test=workspace-elements]')
await sleep(300)
check(!(await page.$('[data-test=edited-copy-note]')), 'and does not come back for the same copy')
await page.click('[data-test=workspace-mesh]')
await sleep(300)

await page.click('[data-test=use-edited]')
await page.waitForFunction(() => document.querySelectorAll('[data-test=scan-edit]').length === 5, { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('.busyoverlay'), { timeout: 300_000 })
await sleep(500)
console.log('in use:', await text('.strip .msg'))
check((await scanCount()) === deleted, 'Use for analysis makes the copy the scan')
check(!(await page.$('[data-test=edited-copy]')) && (await edits()) === 0, 'with no copy apart from it')
await page.click('[data-test=workspace-elements]')
await sleep(400)
check((await scanCount()) === deleted, '3D Measure measures the edited scan')
await page.click('[data-test=workspace-mesh]')
await sleep(300)

// ---- back through all of it, and forward again ---------------------------------
// Seven steps: taking the copy into use, the five edits, and the offset typed
// for the cut, which is one of its own.
await step('KeyZ', 'Undone')
check((await scanCount()) === opened, 'a step back puts the scan as opened back in use')
check((await copyCount()) === deleted && (await edits()) === 5, 'with the copy and its five edits beside it')
await step('KeyZ', 'Undone')
check((await copyCount()) === beforeDelete, 'the next puts the deleted surface back')
check((await edits()) === 4, 'and takes it off the list')
await step('KeyZ', 'Undone')
check((await copyCount()) === filled, 'the next puts back what the cut took off')
await page.click('[data-test=mesh-tool-cut]')
await page.waitForSelector('[data-test=cut-offset]')
check(Number(await page.$eval('[data-test=cut-offset]', (el) => el.value)) === 5, 'the offset typed for the cut is still set')
await step('KeyZ', 'Undone')
const back = Number(await page.$eval('[data-test=cut-offset]', (el) => el.value))
check(back !== 5 && Math.abs(back - middle) < 0.01, `the next step puts the plane back through the middle (Z ${back})`)
await step('KeyZ', 'Undone')
await step('KeyZ', 'Undone')
await step('KeyZ', 'Undone')
check(!(await page.$('[data-test=edited-copy]')), 'and three more leave no copy')
check((await scanCount()) === opened && (await inUse()) === 0, 'the scan as it was opened, with nothing in use')
await page.click('[data-test=mesh-tool-holes]')
await page.waitForFunction(() => /^2$/.test(document.querySelector('[data-test=holes-count] b')?.textContent ?? ''), { timeout: 60_000 })
check(true, 'both holes are open again')
await step('KeyY', 'Redone')
check((await copyCount()) === filledOne, 'a step forward fills the one clicked again')
check((await edits()) === 1, 'and lists it')

// ---- the cut preview across a hole the plane runs into ---------------------------
// A plane across X through the hole still open is bridged under it; across
// the one filled, it closes as it is.
await page.click('[data-test=mesh-tool-cut]')
await page.waitForSelector('[data-test=cut-ref]')
await page.select('[data-test=cut-ref]', 'x')
await sleep(300)
// Which of the two was clicked depends on how the part is turned: both are
// tried, and exactly one is still open.
const across = async (x) => {
  await setField('[data-test=cut-offset]', x)
  await sleep(1200)
  await page.waitForSelector('[data-test=cut-closes]', { timeout: 60_000 })
  return text('[data-test=cut-closes]')
}
const at = [await across(7), await across(-7)]
console.log('across the holes:', at.join(' | '))
check(at.filter((t) => /bridging 1 hole in the scan at the cut/.test(t)).length === 1, 'a plane across the hole still open says it bridges it')
check(at.filter((t) => /closed flat\.$/.test(t)).length === 1, 'and across the filled one it just closes')
await across(at[0].includes('bridging') ? 7 : -7)
await page.screenshot({ path: shotPath('mesh-edits-cut-bridged.png') })

// ---- Smooth a marked region alone ------------------------------------------------
await page.click('[data-test=mesh-tool-smooth]')
await page.waitForSelector('[data-test=smooth-scope-marked]')
await page.click('[data-test=smooth-scope-marked]')
await page.waitForSelector('[data-test=mark-window]')
check(await page.$eval('[data-test=smooth-scan]', (el) => el.disabled), 'nothing to smooth before a region is marked')
await page.click('[data-test=mark-window]')
{
  const r = await canvasRect(page, '.viewslot canvas')
  const cx = r.x + (r.w - 190) / 2
  const cy = r.y + r.h / 2
  await drag(page, [cx - 120, cy - 80], [cx + 120, cy + 80], { steps: 10 })
}
await sleep(400)
const region = count(await text('[data-test=mark-count]'))
console.log(`region marked: ${region} points`)
check(region > 0, 'a window marks the region to smooth')
const beforeRegion = await copyCount()
await page.keyboard.press('Escape')
await page.click('[data-test=smooth-scan]')
await editsReach(2)
const regional = await text('.strip .msg')
console.log('regional:', regional)
check(/Smoothed the marked region — [\d,]+ points/.test(regional), 'the status line says the marked region was smoothed')
const movedPoints = count(regional.match(/region — ([\d,]+) points/)?.[1] ?? '')
check(movedPoints > 0 && movedPoints <= region, 'no more points moved than were marked')
check((await copyCount()) === beforeRegion, 'and every triangle kept')
check(/in a marked region/.test((await page.$$eval('[data-test=pending-edit]', (els) => els.map((el) => el.textContent))).join(' | ')), 'the list says it was regional')
check(count(await text('[data-test=mark-count]')) === 0, 'and the marking goes, leaving the result in view')
await page.screenshot({ path: shotPath('mesh-edits-regional.png') })
// A region marked to smooth is not a marking to delete.
await page.click('[data-test=mark-window]')
{
  const r = await canvasRect(page, '.viewslot canvas')
  const cx = r.x + (r.w - 190) / 2
  const cy = r.y + r.h / 2
  await drag(page, [cx - 60, cy - 40], [cx + 60, cy + 40], { steps: 8 })
}
await sleep(300)
check(count(await text('[data-test=mark-count]')) > 0, 'a new region can be marked')
await page.keyboard.press('Escape')
await page.click('[data-test=mesh-tool-delete]')
await page.waitForSelector('[data-test=delete-tool]')
await sleep(300)
check(count(await text('[data-test=mark-count]')) === 0, 'Delete marked starts with nothing marked')

await finish(browser, consoleErrors)
