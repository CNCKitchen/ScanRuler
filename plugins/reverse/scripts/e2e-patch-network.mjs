// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the Patch network on a real scan: the scooter cover
// of agent round 12, looked at from the top, a 2 × 3 network placed on its
// hump patch by patch, as a person places it — the first patch by its four
// corners, closed by a click on the first; the next by dragging its edge out;
// two on corners already there and new ones, closed with Enter and with a
// double click; the last row by dragging the crest's two edges down, the
// second's copied corner landing on the first's. The crest's edges are bent
// onto the crest by a point put in with Shift-click and dragged, and made
// creases by the C key with the cursor on them. Then: six patches, every
// tangent curve under half a degree, the gaps along the shared curves about
// a micron, the crest folded; the status line and a row per patch, a picked
// patch’s strips; the live map on the ghost. The patches changed after they
// were made: an edge two patches share bent by a drag, one step of the undo;
// a seventh patch closed with the middle button, shaded until its fit lands,
// picked by a click in it and taken out by Delete with the edges only it
// had. The scan’s creases suggested and dismissed; Create builds the sheet,
// and its STEP file reads back as it (verify ok). Last, the app opened with
// ?plugins=none has no trace of the feature.
//
// The scan is 99 MB and not in the repository: SCOOTER_SCAN, or the copy in
// Desktop/reverseengineer/08-scooterHead; without it the check is skipped,
// saying so.
//
// Prereqs: dev server running, Chrome.
//   node plugins/reverse/scripts/e2e-patch-network.mjs
// Env: APP_URL, CHROME, OUT_DIR, SCOOTER_SCAN.
import { clickTool } from '../../../scripts/e2e-lib.mjs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_URL, check, finish, launchApp, loadScan, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

const scanPath = process.env.SCOOTER_SCAN ?? join(homedir(), 'Desktop', 'reverseengineer', '08-scooterHead', 'top_scan_aligned.stl')
if (!existsSync(scanPath)) {
  console.warn(`⚠ SKIPPED: the scooter cover scan is not at ${scanPath} — set SCOOTER_SCAN to run this check.`)
  process.exit(0)
}

// The corners: on the hump at x = −30, 0, 30 and y = −85, −65 and the crest
// (−39.6 / −44.8 / −39.5); the last row comes of dragging the crest's edges
// 13 mm down the front face. The crest half way between its corners.
const N = {
  1: [-30, -85, 89.93], 2: [0, -85, 96.12], 3: [30, -85, 89.9],
  4: [-30, -65, 92.7], 5: [0, -65, 98.93], 6: [30, -65, 92.63],
  7: [-30, -39.6, 95.01], 8: [0, -44.8, 100.98], 9: [30, -39.5, 94.84],
}
const CREST = [[-15, -43.9, 99.55], [15, -43.6, 99.49]]
/** Half way along a straight side in plan: seen from the top, the scan's
 *  path between two corners runs straight between them. */
const half = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
const DOWN = 13

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const { re, clickAt, screen } = reverseHelpers(page)
try {
  await loadScan(page, scanPath, { timeout: 300_000 })
  await openReverse(page)
  await clickTool(page, '[data-test=feature-network]')
  await page.waitForSelector('[data-test=network-editor]')
  await re(() => window.__re.scene().viewFrom('top'))
  await sleep(800)
  // Another workspace closes the box, as its Cancel does — a corner placed
  // goes with it: its layer is in the viewport every workspace shares, and
  // would go on taking clicks there.
  await clickAt(...N[1])
  check(await re(() => window.__re.store.getState().featureDraft?.placing?.corners.length === 1), 'a corner placed')
  await page.click('[data-test=workspace-elements]')
  await sleep(300)
  check(await re(() => window.__re.store.getState().featureDraft === null), 'another workspace closed the box')
  await page.click('[data-test=workspace-reverse]')
  await clickTool(page, '[data-test=feature-network]')
  await page.waitForSelector('[data-test=network-editor]')
  check(await re(() => window.__re.store.getState().featureDraft?.nodes.length === 0 && !window.__re.store.getState().featureDraft.placing), 'the box opened again empty')
  const state = () =>
    re(() => {
      const f = window.__re.store.getState().featureDraft
      return { nodes: f.nodes.length, curves: f.curves.length, cells: f.cells.length, placing: f.placing?.corners.length ?? 0, grips: f.curves.reduce((s, c) => s + c.via.length, 0) }
    })
  /** A corner as the network holds it: the node nearest in plan, or the
   *  point given where there is none yet. */
  const at = (k) =>
    re((q) => {
      let best = null
      let bestD = 3
      for (const n of window.__re.store.getState().featureDraft.nodes) {
        const d = Math.hypot(n.at[0] - q[0], n.at[1] - q[1])
        if (d < bestD) [bestD, best] = [d, n.at]
      }
      return best ?? q
    }, N[k])
  /** A press at one point of the part, dragged to another, let go — by
   *  way of a point 30 px aside where the two are nearer than the click's
   *  slack, as a hand drags a point a millimetre or two. */
  const drag = async (p, q) => {
    const [ax, ay] = await screen(p)
    const [bx, by] = await screen(q)
    await page.mouse.move(ax, ay)
    await sleep(200)
    await page.mouse.down()
    const via = Math.hypot(bx - ax, by - ay) < 20 ? [[ax + 30, ay]] : []
    for (const [vx, vy] of via) {
      await page.mouse.move(vx, vy, { steps: 6 })
      await sleep(40)
    }
    const [sx, sy] = via[0] ?? [ax, ay]
    for (let s = 1; s <= 12; s++) {
      await page.mouse.move(sx + ((bx - sx) * s) / 12, sy + ((by - sy) * s) / 12)
      await sleep(40)
    }
    await sleep(200)
    await page.mouse.up()
    await sleep(500)
  }

  // The first patch: four corners on the scan, shaded as it goes, closed by
  // a click on the first.
  for (const k of [1, 2, 5]) await clickAt(...(await at(k)))
  const [hx, hy] = await screen(N[4])
  await page.mouse.move(hx, hy)
  await sleep(400)
  await page.screenshot({ path: shotPath('patch-network-placing.png') })
  await clickAt(...N[4])
  let s = await state()
  check(s.placing === 4 && s.cells === 0, `four corners placed, the patch still open (${s.placing} placed)`)
  await clickAt(...(await at(1)))
  s = await state()
  check(s.placing === 0 && s.cells === 1 && s.nodes === 4 && s.curves === 4, `a click on the first corner closed it and filled it: ${s.nodes} nodes, ${s.curves} curves, ${s.cells} patch`)
  // Its right edge dragged out 30 mm: the patch beside it.
  await drag(half(N[2], N[5]), half(N[3], N[6]))
  s = await state()
  check(s.cells === 2 && s.nodes === 6 && s.curves === 7, `its edge dragged out made the next patch: ${s.nodes} nodes, ${s.curves} curves, ${s.cells} patches`)
  // The next row's left patch: two corners of the first, two new on the
  // crest, closed with Enter.
  for (const k of [4, 5]) await clickAt(...(await at(k)))
  for (const k of [8, 7]) await clickAt(...N[k])
  await page.keyboard.press('Enter')
  await sleep(400)
  // Its right one: corners of three patches and one new, closed by a double
  // click on the last.
  for (const k of [5, 6]) await clickAt(...(await at(k)))
  await clickAt(...N[9])
  const [dx, dy] = await screen(await at(8))
  await page.mouse.move(dx, dy)
  await sleep(150)
  await page.mouse.click(dx, dy)
  await page.mouse.click(dx, dy)
  await sleep(500)
  s = await state()
  check(s.placing === 0 && s.cells === 4 && s.nodes === 9 && s.curves === 12, `two patches more on corners already there, closed by Enter and a double click: ${s.nodes} nodes, ${s.curves} curves, ${s.cells} patches`)
  // The last row: the crest's two edges dragged down the front face; the
  // second's copied corner lands on the first's.
  const n7 = await at(7)
  const n8 = await at(8)
  const n9 = await at(9)
  for (const [a, b] of [[n7, n8], [n8, n9]]) {
    const m = half(a, b)
    await drag(m, [m[0], m[1] + DOWN, m[2]])
  }
  s = await state()
  check(s.cells === 6 && s.nodes === 12 && s.curves === 17, `the crest's edges dragged down made the last row, sharing its middle corner: ${s.nodes} nodes, ${s.curves} curves, ${s.cells} patches`)
  // The crest's edges bent onto the crest: a point put in half way with
  // Shift-click, dragged to the crest; then each made a crease.
  for (const [[a, b], crest] of [[[n7, n8], CREST[0]], [[n8, n9], CREST[1]]]) {
    const m = half(a, b)
    const [px, py] = await screen(m)
    await page.mouse.move(px, py)
    await sleep(200)
    await page.keyboard.down('Shift')
    await page.mouse.click(px, py)
    await page.keyboard.up('Shift')
    await sleep(300)
    await drag(m, crest)
  }
  s = await state()
  check(s.grips === 2, `a point put in each crest edge and dragged onto the crest (${s.grips} points)`)
  for (const crest of CREST) {
    const [px, py] = await screen(crest)
    await page.mouse.move(px + 1, py)
    await sleep(250)
    await page.keyboard.press('c')
    await sleep(250)
  }
  const creases = await re(() => window.__re.store.getState().featureDraft.curves.filter((c) => c.crease).length)
  check(creases === 2, `the C key made the crest's two edges creases (${creases})`)
  // The patches, filled as they were placed: nothing left for Fill all.
  await page.waitForFunction(() => window.__re.store.getState().preview.network?.patches.length === 6 && window.__re.store.getState().preview.status === 'ok' && window.__re.store.getState().preview.network.curves.filter((c) => c.crease).length === 2, { timeout: 180_000 })
  const report = await re(() => window.__re.store.getState().preview.network)
  console.log('patches:', report.patches.map((p) => `σ ${p.rms.toFixed(4)} misfit ${p.misfit.toFixed(4)} max ${p.max.toFixed(3)} ${p.net.u}×${p.net.v}`).join('; '))
  console.log('curves:', report.curves.map((c) => `${c.curve}${c.crease ? ' crease' : ''}: ${c.angle.toFixed(3)}° ${(c.gap * 1000).toFixed(2)} µm`).join('; '))
  console.log('ms:', JSON.stringify(report.ms))
  check(report.patches.length === 6 && report.cells.every((c) => 'patch' in c) && report.unfilled.length === 0, 'six patches, each filled as it was placed')
  check(report.worstAngle < 0.5, `every tangent curve under 0.5° (worst ${report.worstAngle.toFixed(3)}°)`)
  check(report.worstGap < 0.005, `the shared edges a few microns apart at most (worst ${(report.worstGap * 1000).toFixed(2)} µm)`)
  const folded = report.curves.filter((c) => c.crease)
  check(folded.length === 2 && folded.every((c) => c.angle > 1), `the crest stays folded (${folded.map((c) => `${c.angle.toFixed(1)}°`).join(', ')})`)
  check(report.patches.every((p) => p.rms < 0.05), `every patch within 0.05 mm RMS of the scan (worst ${Math.max(...report.patches.map((p) => p.rms)).toFixed(4)})`)
  // The readout: the status line and a row per patch; a row picks its
  // patch, and its strips' spans come up to set.
  const status = await page.$eval('[data-test=network-status]', (e) => e.textContent)
  check(/6 patches/.test(status) && /worst edge/.test(status) && /worst gap/.test(status), `the status line: "${status}"`)
  const rowsShown = await page.$$eval('[data-test^=network-patch-]', (els) => els.length)
  check(rowsShown === 6, `a row per patch (${rowsShown})`)
  await page.click('[data-test=network-patch-0]')
  await page.waitForSelector('[data-test=network-spans-u]', { timeout: 10_000 })
  check(await re(() => window.__re.store.getState().featureDraft.picked === 0), 'a row picks its patch, its strips shown to set')
  // The live map on the ghost: the scan under the patches read against
  // them, nearly all of it within the map's range.
  // The map is read again a moment after each ghost: taken once it has
  // stood still for three seconds, against the last one.
  let map = null
  let still = 0
  for (let i = 0; i < 90 && still < 3; i++) {
    const now = await re(() => window.__re.store.getState().mapReport)
    still = now?.source === 'ghost' && now.points > 0 && now.tick === map?.tick ? still + 1 : 0
    map = now
    await sleep(1000)
  }
  console.log('live map:', JSON.stringify(map).slice(0, 300))
  check(map.points > 10_000 && map.within / map.points > 0.9, `the live map reads the network on the scan: ${map.points.toLocaleString('en-US')} points, ${((100 * map.within) / map.points).toFixed(1)} % within ±${map.range} mm`)
  // Changed after it was made: the edge the second row's patches share
  // bent by a drag on it — a point put in where it was pressed and dragged
  // 4 mm, one step the undo takes back.
  const n5 = await at(5)
  const before = await state()
  await drag(half(n5, n8), [half(n5, n8)[0] + 4, half(n5, n8)[1], half(n5, n8)[2]])
  s = await state()
  check(s.grips === before.grips + 1 && s.cells === 6, `a drag on the edge two patches share bent it: ${s.grips - before.grips} point put in`)
  await page.click('[data-test=network-undo]')
  s = await state()
  check(s.grips === before.grips && s.curves === 17, 'one undo took the bend back')
  check(await page.$('[data-test=network-editing]') !== null, 'the box says how a patch is changed')
  // A seventh patch beside the first row, on two of its corners, closed by
  // a click of the middle button — the workspace's confirm, which with the
  // network ready to make closes the patch first — shaded until its fit
  // lands.
  await clickAt(...(await at(3)))
  await clickAt(45, -85, 90)
  await clickAt(45, -65, 90)
  await clickAt(...(await at(6)))
  const [ox, oy] = await screen([40, -75, 90])
  await page.mouse.move(ox, oy)
  await sleep(150)
  const closed = Date.now()
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })
  await sleep(100)
  s = await state()
  check(s.placing === 0 && s.cells === 7 && s.curves === 20, `the middle button closed the seventh patch: ${s.cells} patches, ${s.curves} curves`)
  await page.waitForFunction(() => window.__re.store.getState().preview.status === 'ok' && window.__re.store.getState().preview.network?.patches.length === 7, { timeout: 120_000, polling: 50 })
  const ms7 = await re(() => window.__re.store.getState().preview.network.ms)
  console.log(`seventh patch: fitted on screen ${Date.now() - closed} ms after the click; the read`, JSON.stringify(Object.fromEntries(Object.entries(ms7).map(([k, v]) => [k, Math.round(v)]))))
  // Picked by a click in it, and taken out by Delete with its own edges.
  await page.mouse.move(ox, oy)
  await sleep(250)
  await page.mouse.click(ox, oy)
  await sleep(250)
  check(await re(() => window.__re.store.getState().featureDraft.picked === 6), 'a click in the patch picked it')
  await page.waitForSelector('[data-test=network-delete-patch]', { timeout: 10_000 })
  await page.keyboard.press('Delete')
  await sleep(250)
  s = await state()
  check(s.cells === 6 && s.curves === 17 && s.nodes === 12, `Delete took the picked patch out with the edges only it had: ${s.cells} patches, ${s.curves} curves, ${s.nodes} nodes`)
  await page.waitForFunction(() => window.__re.store.getState().preview.status === 'ok' && window.__re.store.getState().preview.network?.patches.length === 6, { timeout: 120_000, polling: 50 })
  // Suggest creases: the scan's sharp edges offered, dashed, and put away
  // again — the network as it was.
  await page.click('[data-test=network-suggest]')
  await page.waitForSelector('[data-test=network-suggested]', { timeout: 60_000 })
  const offered = await re(() => window.__re.store.getState().featureDraft.suggested.map((s) => ({ length: s.length, angle: s.angle })))
  console.log(`creases suggested: ${offered.length}, the longest`, [...offered].sort((a, b) => b.length - a.length).slice(0, 5).map((s) => `${s.length.toFixed(1)} mm at ${s.angle.toFixed(1)}°`).join('; '))
  check(offered.every((s) => s.angle >= 12), `Suggest creases offered ${offered.length}, each folding past 12°`)
  await page.screenshot({ path: shotPath('patch-network-suggested.png') })
  await page.click('[data-test=network-suggest-dismiss]')
  check(await re(() => window.__re.store.getState().featureDraft.suggested === null && window.__re.store.getState().featureDraft.curves.length === 17), 'Dismiss put the suggestions away, the network unchanged')
  await page.screenshot({ path: shotPath('patch-network-editor.png') })
  // Create: the sheet built; its STEP file read back as it.
  await page.click('[data-test=network-create]')
  await page.waitForFunction(() => !window.__re.store.getState().building && window.__re.store.getState().bodies.length > 0, { timeout: 180_000 })
  const body = await re(() => window.__re.store.getState().bodies[0])
  check(body?.surface === true && body.faces === 6, `Create built a sheet of six faces (${body?.faces} faces, ${body?.surface ? 'sheet' : 'solid'})`)
  const step = await re(async (id) => {
    const r = await window.__re.session.stepFile([id], true)
    return { ok: r.check?.ok, problems: r.check?.problems, faces: r.check?.bodies[0]?.faces, gap: r.check?.bodies[0]?.gap.max, bytes: r.text.length }
  }, body.id)
  check(step.ok === true, `the STEP file reads back as the sheet (verify ok; ${step.faces?.join(' / ')} faces, gap ${step.gap?.toExponential(1)} mm${step.problems?.length ? `; ${step.problems.join(' ')}` : ''})`)
  await page.screenshot({ path: shotPath('patch-network-built.png') })
  // Without the plugins: no trace of it.
  const plain = await browser.newPage()
  await plain.goto(`${APP_URL}${APP_URL.includes('?') ? '&' : '?'}plugins=none`, { waitUntil: 'networkidle0' })
  await sleep(1500)
  const trace = await plain.evaluate(() => ({ button: document.querySelector('[data-test=feature-network]') !== null, text: /patch network/i.test(document.body.innerText) }))
  check(!trace.button && !trace.text, '?plugins=none: no Patch network anywhere')
  await plain.close()
} catch (e) {
  check(false, `the run: ${e instanceof Error ? e.stack : e}`)
}
await finish(browser, consoleErrors)
