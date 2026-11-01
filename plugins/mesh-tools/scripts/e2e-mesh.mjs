// SPDX-License-Identifier: AGPL-3.0-only
import { dismissSupportCard } from '../../../scripts/e2e-lib.mjs'
// End-to-end test for the Mesh Tools workspace: drives the real app in
// headless Chrome — switches workspace, loads a scan from the stage, reduces
// the mesh, orbits about the reduced mesh, looks at the result three ways,
// reads the deviation under the cursor, reduces again looser and under a
// triangle limit, undoes a setting, and exports the reduced mesh, checking the
// file against what the panel says. Then marks the islands on the scan, asks
// before deleting them — a no leaves the scan as it is — deletes them from the
// edited copy while every other workspace goes on measuring the scan, takes
// the copy into use, and undoes and redoes that. Last, saves the session with
// an edit waiting on the copy and opens it again.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh.mjs
// Env: CHROME (chrome.exe path), APP_URL, SCAN, SHOT_DIR.
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  check,
  colouredFraction,
  downloadsTo,
  fieldSetter,
  finish,
  launchApp,
  loadScan,
  OUT_DIR,
  repoFile,
  setViewTheme,
  shotPath,
  sleep,
} from '../../../scripts/e2e-lib.mjs'

const SCAN = process.env.SCAN ?? repoFile('ballbar.stl')
const DOWNLOADS = join(OUT_DIR, 'mesh-downloads')

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})
rmSync(DOWNLOADS, { recursive: true, force: true })
mkdirSync(DOWNLOADS, { recursive: true })
const cdp = await downloadsTo(page, DOWNLOADS)

const count = (text) => Number(String(text).replace(/[^\d]/g, ''))
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const readNumber = (sel) => page.$eval(sel, (el) => Number(el.value))
const reduceAndWait = async () => {
  const before = await page.$eval('[data-test=reduce-mesh]', (el) => el.textContent)
  await page.click('[data-test=reduce-mesh]')
  await page.waitForFunction(() => /Reducing/.test(document.querySelector('[data-test=reduce-mesh]')?.textContent ?? ''), { timeout: 10_000 }).catch(() => {})
  await page.waitForFunction(
    () => {
      const b = document.querySelector('[data-test=reduce-mesh]')
      return b && !/Reducing/.test(b.textContent) && document.querySelector('[data-test=reduce-result]')
    },
    { timeout: 300_000 },
  )
  await sleep(500)
  return before
}
// The field commits on blur, and blur only fires on an element that had the
// focus — so this types the way a person does rather than poking the value in.
const setField = fieldSetter(page)

// The grey scheme, so bare scan and a painted map are told apart by colour,
// and the support card out of the corner of the stage it would be counted in.
await setViewTheme(page, 'studio')
await dismissSupportCard(page)

// ---- workspace first, then the scan -----------------------------------------
await page.click('[data-test=workspace-mesh]')
await page.waitForSelector('[data-test=start-pane]')
check(/Cleaning up and reducing a scan/.test(await text('[data-test=start-pane]')), 'the stage prompt names the workspace')
await loadScan(page, SCAN, {
  inputSelector: '[data-test=start-scan] input[type=file]',
  timeout: 300_000,
  settle: 600,
})
await page.waitForSelector('[data-test=mesh-ready-chip]')
const scanTriangles = count(await page.$eval('.file-info span', (el) => el.textContent.split('·')[0]))
const tolerance = await readNumber('[data-test=reduce-tolerance]')
console.log(`scan: ${scanTriangles} triangles; tolerance suggested: ${tolerance} mm`)
check(tolerance > 0 && tolerance < 1, 'a tolerance is suggested for the part')
check((await readNumber('[data-test=reduce-max-triangles]')) === 50_000, 'the triangle limit starts at 50,000')
check(await page.$eval('[data-test=mesh-view-reduced]', (el) => el.disabled), 'the view keys wait for a result')
await page.screenshot({ path: shotPath('mesh-loaded.png') })

// ---- reduce ------------------------------------------------------------------
let started = Date.now()
await reduceAndWait()
console.log(`reduced in ${((Date.now() - started) / 1000).toFixed(1)} s`)
const first = count(await text('[data-test=reduce-triangles]'))
const within = await text('[data-test=reduce-within]')
const p999 = await text('[data-test=reduce-p999]')
console.log(`reduced: ${first} triangles · ${within} · ${p999}`)
check(first > 0 && first < scanTriangles / 10, `the scan reduces to a fraction of its triangles (${first} of ${scanTriangles})`)
check(Number(p999.match(/([\d.]+) mm/)?.[1]) <= tolerance, '99.9 % of the scan lies within the tolerance')
check(!(await page.$('[data-test=mesh-ready-chip]')), 'the ready chip clears once there is a result')
check(
  await page.$eval('[data-test=mesh-view-reduced]', (el) => el.getAttribute('aria-checked') === 'true'),
  'the reduced mesh is what is shown first',
)
await page.screenshot({ path: shotPath('mesh-reduced.png') })

// ---- an orbit turns about the reduced mesh under the cursor -----------------
// The pivot marker is drawn only while an orbit is under way, at the pivot,
// and is the one bright red thing on the stage. A turn begun on the reduced
// mesh away from the middle of the stage pivots there — not on the hidden
// scan, and not on wherever the last turn pivoted.
const partSpot = async () => {
  // Clear of the view bar and the card stacked in the bottom corner, and of
  // the gizmo on the right: they sit over the stage.
  const clip = await page.$eval('.viewslot canvas', (el) => {
    const r = el.getBoundingClientRect()
    const corner = document.querySelector('.stagecorner')?.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width - 190, height: (corner ? corner.top : r.bottom - 170) - r.y - 10 }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  const at = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    // The part is whatever differs from the stage at the left end of its row.
    const part = []
    for (let y = 0; y < c.height; y += 2) {
      const e = (y * c.width + 2) * 4
      for (let x = 10; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4
        if (Math.abs(data[i] - data[e]) + Math.abs(data[i + 1] - data[e + 1]) + Math.abs(data[i + 2] - data[e + 2]) > 60) part.push([x, y])
      }
    }
    if (part.length < 50) return null
    // Well in from the part's left end, on the middle of it there.
    part.sort((a, b) => a[0] - b[0])
    const x0 = part[Math.floor(part.length * 0.08)][0]
    const column = part.filter((p) => Math.abs(p[0] - x0) <= 2).sort((a, b) => a[1] - b[1])
    return { spot: column[Math.floor(column.length / 2)], centre: [c.width / 2, c.height / 2] }
  }, shot)
  return at && { x: clip.x + at.spot[0], y: clip.y + at.spot[1], far: Math.hypot(at.spot[0] - at.centre[0], at.spot[1] - at.centre[1]) }
}
const redAround = async (p, r = 30) => {
  const shot = await page.screenshot({ clip: { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r }, encoding: 'base64' })
  return page.evaluate(async (b64) => {
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
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) n++
    return n
  }, shot)
}
const turnAt = async (p) => {
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(p.x + 5 * i, p.y + 2 * i)
    await sleep(25)
  }
  await sleep(150)
  // The pivot stays put on screen while the part turns about it.
  const red = await redAround(p)
  await page.mouse.up()
  await sleep(200)
  return red
}
const onReduced = await partSpot()
console.log('orbit spot on the reduced mesh:', onReduced && `${onReduced.far.toFixed(0)} px from the middle`)
check(onReduced && onReduced.far > 80, 'the reduced mesh shows away from the middle of the stage')
if (onReduced) {
  const red = await turnAt(onReduced)
  console.log(`pivot marker at the cursor: ${red} px`)
  check(red > 0, 'a turn begun on the reduced mesh pivots on it, under the cursor')
  await page.screenshot({ path: shotPath('mesh-orbit.png') })
}


// ---- the deviation map and the hover reading --------------------------------
// Where on the stage the map is painted: a saturated pixel near the middle of
// all of them, found in a screenshot — the part may fill the stage or sit
// small in a corner of it, depending on its shape.
const paintedSpot = async () => {
  const clip = await page.$eval('.viewslot canvas', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width - 190, height: r.height }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  const at = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const spots = []
    for (let y = 0; y < c.height; y += 3) {
      for (let x = 0; x < c.width; x += 3) {
        const i = (y * c.width + x) * 4
        const max = Math.max(data[i], data[i + 1], data[i + 2])
        const min = Math.min(data[i], data[i + 1], data[i + 2])
        if (max - min > 90) spots.push([x, y])
      }
    }
    if (!spots.length) return null
    spots.sort((a, b) => a[0] + a[1] * 1e4 - (b[0] + b[1] * 1e4))
    return spots[Math.floor(spots.length / 2)]
  }, shot)
  return at && { x: clip.x + at[0], y: clip.y + at[1] }
}

await page.click('[data-test=mesh-view-deviation]')
await page.waitForSelector('[data-test=reduce-legend]')
await sleep(500)
const coloured = await colouredFraction(page)
const legend = await text('[data-test=reduce-legend]')
check(/mesh inside the scan/.test(legend) && /mesh outside the scan/.test(legend), 'the legend says which way each end points')
await page.screenshot({ path: shotPath('mesh-deviation.png') })

let reading = null
const spot = await paintedSpot()
if (spot) {
  for (const [dx, dy] of [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2], [4, 4]]) {
    await page.mouse.move(spot.x + dx, spot.y + dy)
    await sleep(250)
    reading = await page.$eval('[data-test=hover-readout]', (el) => el.textContent).catch(() => null)
    if (reading) break
  }
}
console.log('hover reading:', reading)
check(reading && /[+−]\d+\.\d{3} mm/.test(reading), 'the deviation reads under the cursor')

// Up close, for the eye: the map, then the reduced mesh on the same spot.
if (spot) {
  await page.mouse.move(spot.x, spot.y)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaY: -400 })
    await sleep(120)
  }
  await sleep(400)
  await page.screenshot({ path: shotPath('mesh-deviation-close.png') })
  await page.click('[data-test=mesh-view-reduced]')
  await sleep(400)
  await page.screenshot({ path: shotPath('mesh-reduced-close.png') })
  await page.click('[data-test=mesh-view-deviation]')
  await sleep(300)
}

await page.click('[data-test=mesh-view-scan]')
await sleep(400)
check(!(await page.$('[data-test=reduce-legend]')), 'the scale goes with the map')
const bare = await colouredFraction(page)
console.log(`coloured stage: ${(coloured * 100).toFixed(1)} % with the map, ${(bare * 100).toFixed(1)} % bare`)
// Relative, because a ball bar framed whole is a small part of the stage.
check(coloured > 0.002 && coloured > 4 * bare, 'the deviation from the reduced mesh is painted on the scan')
await page.screenshot({ path: shotPath('mesh-scan.png') })
await page.click('[data-test=mesh-view-reduced]')

// ---- a looser tolerance, stale until reduced again, and undo -----------------
await setField('[data-test=reduce-tolerance]', tolerance * 4)
check(Boolean(await page.$('[data-test=reduce-stale]')), 'the panel says the result is out of date')
await page.keyboard.down('Control')
await page.keyboard.press('KeyZ')
await page.keyboard.up('Control')
await sleep(400)
check((await readNumber('[data-test=reduce-tolerance]')) === tolerance, 'undo puts the tolerance back')
check(!(await page.$('[data-test=reduce-stale]')), 'and the result is current again')
await page.keyboard.down('Control')
await page.keyboard.press('KeyY')
await page.keyboard.up('Control')
await sleep(400)
check((await readNumber('[data-test=reduce-tolerance]')) === tolerance * 4, 'redo takes it forward again')

started = Date.now()
await reduceAndWait()
const looser = count(await text('[data-test=reduce-triangles]'))
console.log(`at ${tolerance * 4} mm: ${looser} triangles, in ${((Date.now() - started) / 1000).toFixed(1)} s`)
check(looser < first, 'a looser tolerance gives fewer triangles')

// ---- a triangle limit below what the tolerance needs -------------------------
await setField('[data-test=reduce-tolerance]', tolerance)
const limit = Math.max(200, Math.floor(first / 3))
await setField('[data-test=reduce-max-triangles]', limit)
await reduceAndWait()
const capped = count(await text('[data-test=reduce-triangles]'))
console.log(`limited to ${limit}: ${capped} triangles; ${await text('[data-test=reduce-p999]')}`)
check(capped <= limit, 'the limit is kept')
check(Boolean(await page.$('[data-test=reduce-capped]')), 'the panel says the limit decided it')
await page.screenshot({ path: shotPath('mesh-capped.png') })

// ---- the export --------------------------------------------------------------
await page.click('[data-test=export-reduced-mesh]')
await page.waitForSelector('[data-test=export-reduced-mesh-stl]')
await page.click('[data-test=export-reduced-mesh-stl]')
let file = null
for (let i = 0; i < 50 && !file; i++) {
  await sleep(200)
  file = readdirSync(DOWNLOADS).find((f) => f.endsWith('.stl'))
}
check(Boolean(file), 'the reduced mesh downloads as an STL')
if (file) {
  const bytes = readFileSync(join(DOWNLOADS, file))
  const triangles = bytes.readUInt32LE(80)
  console.log(`exported ${file}: ${triangles} triangles, ${bytes.length} bytes`)
  check(/-reduced\.stl$/.test(file), 'the file is named for what it is')
  check(triangles === capped && bytes.length === 84 + 50 * triangles, 'the file holds the mesh on screen')
  const status = await text('.strip .msg')
  console.log('status:', status)
  check(/Reduced mesh exported/.test(status), 'the status line says what was written')
}

// ---- remove islands: marked, asked, deleted — and undo puts them back ---------
const scanCount = async () => count((await page.$eval('.file-info span', (el) => el.textContent)).split('·')[0])
const orangePixels = async () => {
  const clip = await page.$eval('.viewslot canvas', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width - 190, height: r.height }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  return page.evaluate(async (b64) => {
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
  }, shot)
}
const idle = () =>
  page.waitForFunction(
    () => {
      const b = document.querySelector('[data-test=remove-islands]')
      return (!b || !/Removing/.test(b.textContent)) && !document.querySelector('.busyoverlay')
    },
    { timeout: 300_000 },
  )

// Back out of the close-up above, so the whole part is on the stage again.
if (spot) {
  await page.mouse.move(spot.x, spot.y)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaY: 400 })
    await sleep(120)
  }
}
await page.click('[data-test=mesh-tool-islands]')
await page.waitForSelector('[data-test=islands-count]', { timeout: 120_000 })
check(!(await page.$('[data-test=mesh-view-reduced]')), 'the reduction view keys go with the reduce tool')
check(!(await page.$('[data-test=reduce-legend]')), 'and so does its map')
const [islandText, islandTriText] = (await text('[data-test=islands-count] b')).split('·')
const islands = count(islandText)
const islandTriangles = count(islandTriText)
const pieceSize = await readNumber('[data-test=islands-size]')
console.log(`${await text('[data-test=islands-pieces] b')} pieces; ${islands} islands under ${pieceSize} mm, ${islandTriangles} triangles`)
check(islands > 0 && islandTriangles > 0, 'the scan has islands under the suggested size')
await sleep(400)
const orange = await orangePixels()
console.log(`islands marked: ${orange} px`)
// Far more than the specks' own few pixels: every island is ringed.
check(orange > islands * 40, 'the islands are marked on the part, each in a ring')
check(/Remove \d+ islands?…/.test(await text('[data-test=remove-islands]')), 'the button says how many go')
await page.screenshot({ path: shotPath('mesh-islands.png') })

// Remove asks first; no, and Escape, leave the scan as it is.
await page.click('[data-test=remove-islands]')
await page.waitForSelector('[data-test=islands-confirm]')
check(new RegExp(`Delete the ${islands.toLocaleString('en-US')} islands?`).test(await text('[data-test=islands-confirm]')), 'the question says how many go')
await page.screenshot({ path: shotPath('mesh-islands-confirm.png') })
await page.click('[data-test=islands-keep]')
await sleep(300)
check(!(await page.$('[data-test=islands-confirm]')), 'Keep them takes the question back')
await page.click('[data-test=remove-islands]')
await page.waitForSelector('[data-test=islands-confirm]')
await page.keyboard.press('Escape')
await sleep(300)
check(!(await page.$('[data-test=islands-confirm]')), 'and so does Escape')
check((await scanCount()) === scanTriangles, 'nothing is deleted without a yes')
check(!(await page.$('[data-test=scan-edit]')), 'and nothing is listed as done')

started = Date.now()
const copyCount = async () => count((await text('[data-test=edited-triangles] b')).split('·')[0])
await page.click('[data-test=remove-islands]')
await page.waitForSelector('[data-test=islands-confirm]')
await page.click('[data-test=islands-delete]')
await page.waitForSelector('[data-test=pending-edit]', { timeout: 300_000 })
await idle()
await page.waitForSelector('[data-test=islands-none]', { timeout: 120_000 })
const edited = await copyCount()
console.log(`removed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${scanTriangles} → ${edited} triangles on the copy`)
check(edited === scanTriangles - islandTriangles, 'the edited copy loses exactly the island triangles')
check((await scanCount()) === scanTriangles, 'and the scan in use keeps them')
check(!(await page.$('[data-test=scan-edit]')), 'nothing is in use yet')
check(/Removed \d+ islands?/.test(await text('.strip .msg')), 'the status line says what went')
check((await orangePixels()) === 0, 'no island is left to mark')
await page.screenshot({ path: shotPath('mesh-islands-removed.png') })

// The reduction on hand went with the mesh it was made of; made again, it is
// made of the copy.
await page.click('[data-test=mesh-tool-reduce]')
await sleep(300)
check(!(await page.$('[data-test=reduce-result]')), 'the reduction of the mesh before is gone')
await page.click('[data-test=reduce-mesh]')
await page.waitForSelector('[data-test=reduce-result]', { timeout: 300_000 })
check(count((await text('.dro-note')).split('·')[0]) === edited, 'a reduction now is made of the edited copy')

// Every other workspace goes on measuring the scan as it was.
await page.click('[data-test=workspace-elements]')
await sleep(400)
check((await scanCount()) === scanTriangles, '3D Measure still measures the scan in use')
await page.click('[data-test=workspace-mesh]')
await sleep(300)

// Taken into use, it is what every workspace measures.
await page.click('[data-test=use-edited]')
await page.waitForSelector('[data-test=scan-edit]', { timeout: 300_000 })
await idle()
check((await scanCount()) === edited, 'Use for analysis makes the copy the scan')
check(!(await page.$('[data-test=edited-copy]')), 'and there is no copy apart from it any more')
check(/edited/.test(await text('[data-test=slot-scan]')), 'the scan is marked as edited')
await page.click('[data-test=workspace-elements]')
await sleep(400)
check((await scanCount()) === edited, '3D Measure measures the edited scan')
await page.click('[data-test=workspace-mesh]')
await sleep(300)

// A step back puts the copy back beside the scan as it was, another takes
// the copy away; forward again, the other way. A step across the scan loads
// it from the other side and measures everything again; the status line
// says when it is done.
const step = async (key, word) => {
  const before = await page.$eval('.strip .msg', (el) => el.textContent).catch(() => '')
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
  await page.waitForFunction(
    (w, b) => {
      const now = document.querySelector('.strip .msg')?.textContent ?? ''
      return now !== b && new RegExp(w).test(now)
    },
    { timeout: 300_000 },
    word,
    before,
  )
  await idle()
  await sleep(300)
}
await step('KeyZ', 'Undone')
check((await scanCount()) === scanTriangles, 'undo puts the scan as it was back in use')
check((await copyCount()) === edited, 'with the edited copy beside it again')
check(!(await page.$('[data-test=scan-edit]')), 'and nothing in use')
await step('KeyZ', 'Undone')
check(!(await page.$('[data-test=edited-copy]')), 'another step back takes the copy away')
await step('KeyY', 'Redone')
check((await copyCount()) === edited, 'redo makes it again')
await step('KeyY', 'Redone')
check((await scanCount()) === edited, 'and takes it into use again')
check(Boolean(await page.$('[data-test=scan-edit]')), 'with the edit listed as in use')
await page.screenshot({ path: shotPath('mesh-back.png') })

// ---- an edit waiting on the copy, saved and opened again ----------------------
await page.click('[data-test=mesh-tool-smooth]')
await page.waitForSelector('[data-test=smooth-scan]')
await page.click('[data-test=smooth-scan]')
await page.waitForSelector('[data-test=pending-edit]', { timeout: 300_000 })
await idle()
check((await copyCount()) === edited, 'smoothing makes a copy of the scan as it now is')

await page.click('[data-test="save-project"]')
let project = null
for (let i = 0; i < 100 && !project; i++) {
  await sleep(200)
  project = readdirSync(DOWNLOADS).find((f) => f.endsWith('.scanruler'))
}
check(Boolean(project), 'the session saves as a project')
if (project) {
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.panel')
  await (await page.$('[data-test="project-input"]')).uploadFile(join(DOWNLOADS, project))
  await page.waitForFunction(() => /Project opened/.test(document.querySelector('.strip')?.textContent ?? ''), { timeout: 300_000 })
  await sleep(800)
  await page.click('[data-test=workspace-mesh]')
  await sleep(400)
  check((await scanCount()) === edited, 'a reopened project holds the edited scan')
  check(/ballbar\.stl/.test(await page.$eval('.file-info', (el) => el.textContent)), 'under the name it was opened as')
  check(Boolean(await page.$('[data-test=scan-edit]')), 'with its edit listed as in use')
  check((await copyCount()) === edited && Boolean(await page.$('[data-test=pending-edit]')), 'and the copy with the smoothing waiting on it')
  await page.screenshot({ path: shotPath('mesh-reopened.png') })
}

if (existsSync(DOWNLOADS)) rmSync(DOWNLOADS, { recursive: true, force: true })
await finish(browser, consoleErrors)
