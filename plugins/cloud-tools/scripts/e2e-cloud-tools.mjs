// SPDX-License-Identifier: AGPL-3.0-only
// The Cloud Tools workspace end to end: a point cloud opened through the
// start screen, the Cloud Tools tab taken, Floating pieces marking the specks
// off the main body (none at 0 %), Delete taking them as one step, Ctrl+Z
// putting them back and Ctrl+Y taking them again; then Plane marking the
// points below the middle of the part, deleted too.
//
// The cloud is built here — a ball of radius 20 at 0.5 mm with a scrap and a
// speck of dust floating off it — unless CLOUD_PLY names a scanner's cloud
// to run on instead (read only, never written).
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/cloud-tools/scripts/e2e-cloud-tools.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR, CLOUD_PLY.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { check, click, fail, finish, launchApp, MOD, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

/** The ball, the scrap and the dust, as rows of x y z nx ny nz. */
function ballRows() {
  const rows = []
  const R = 20, step = 0.5
  const rings = Math.round((Math.PI * R) / step)
  for (let i = 0; i <= rings; i++) {
    const phi = (Math.PI * i) / rings
    const around = Math.max(1, Math.round((2 * Math.PI * R * Math.sin(phi)) / step))
    for (let j = 0; j < around; j++) {
      const t = (2 * Math.PI * j) / around
      const n = [Math.sin(phi) * Math.cos(t), Math.sin(phi) * Math.sin(t), Math.cos(phi)]
      rows.push([R * n[0], R * n[1], R * n[2], ...n])
    }
  }
  for (let i = 0; i < 40; i++) rows.push([30 + (i % 8) * 0.4, Math.floor(i / 8) * 0.4, 0, 0, 0, 1])
  rows.push([-40, 0, 0, 1, 0, 0])
  return rows
}

function ply(rows) {
  const head = Buffer.from(
    `ply\nformat binary_little_endian 1.0\ncomment ScanRuler e2e ball\nelement vertex ${rows.length}\n` +
      ['x', 'y', 'z', 'nx', 'ny', 'nz'].map((p) => `property float ${p}\n`).join('') +
      'end_header\n',
    'latin1',
  )
  const body = Buffer.alloc(rows.length * 24)
  rows.forEach((row, i) => row.forEach((v, c) => body.writeFloatLE(v, i * 24 + c * 4)))
  return Buffer.concat([head, body])
}

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 300_000 })
const dir = mkdtempSync(join(tmpdir(), 'scanruler-cloud-'))
let file = process.env.CLOUD_PLY
if (!file) {
  file = join(dir, 'ball.ply')
  writeFileSync(file, ply(ballRows()))
}

/** The scan's store, the workspace's, the marking and the undo steps, read in the page. */
const state = () =>
  page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { useMark } = await import('/src/state/markStore.ts')
    const { useHistory } = await import('/src/state/historyStore.ts')
    const { useCloudTools } = await import('/plugins/cloud-tools/state/cloudStore.ts')
    const s = useStore.getState()
    const c = useCloudTools.getState()
    return {
      fileName: s.fileName,
      status: s.statusText,
      error: s.errorText,
      busy: s.busy,
      steps: useHistory.getState().past.map((e) => e.label),
      points: s.vertexCount,
      cloud: s.scanIsCloud,
      marked: useMark.getState().count,
      floating: c.floating,
      running: c.running,
    }
  })

const until = async (what, test, timeout = 180_000) => {
  const end = Date.now() + timeout
  for (;;) {
    const s = await state()
    if (test(s)) return s
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`)
    await sleep(100)
  }
}

/** The slider dragged to `percent`, as an input event on it. */
const slide = (percent) =>
  page.evaluate((v) => {
    const input = document.querySelector('[data-test=cloud-percent-slider]')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, percent)

try {
  await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(file)
  const opened = await until('the cloud to open', (s) => s.cloud && s.fileName === basename(file) && !s.busy)
  const total = opened.points
  check(total > 1000, `${opened.fileName} is the scan, a cloud of ${total} points`)
  await click(page, '[data-test=workspace-cloud]')
  await page.waitForSelector('.cloud-panel', { timeout: 30_000 })

  // ---- Floating pieces --------------------------------------------------------------
  await click(page, '[data-test=cloud-tool-floating]')
  const found = await until('the floating pieces', (s) => s.floating !== null && s.floating.percent === 1)
  console.log('floating at 1 %:', JSON.stringify(found.floating))
  check(found.marked === found.floating.points, `the ${found.floating.floating} floating pieces are marked: ${found.marked} points`)
  if (!process.env.CLOUD_PLY) check(found.floating.floating === 2 && found.marked === 41, 'the scrap and the dust, and nothing of the ball')
  await slide(0)
  await until('nothing marked at 0 %', (s) => s.floating?.percent === 0 && s.marked === 0)
  check(true, 'at 0 % nothing is marked')
  await slide(1)
  const again = await until('the pieces marked again', (s) => s.floating?.percent === 1 && s.marked === found.marked)
  await page.screenshot({ path: shotPath('cloud-floating.png') })

  if (again.marked > 0) {
    await click(page, '[data-test=cloud-delete]')
    await click(page, '[data-test=cloud-delete-confirm]')
    const cleaned = await until('the delete', (s) => s.running === null && s.steps.at(-1) === 'Cloud Tools: delete points')
    console.log('deleted:', cleaned.status)
    check(cleaned.points === total - again.marked, `the floating points are gone: ${cleaned.points} left of ${total}`)
    await page.screenshot({ path: shotPath('cloud-cleaned.png') })

    await page.keyboard.down(MOD)
    await page.keyboard.press('z')
    await page.keyboard.up(MOD)
    await until('the undo', (s) => s.points === total && !s.busy)
    check(true, 'Ctrl+Z puts them back')
    await page.keyboard.down(MOD)
    await page.keyboard.press('y')
    await page.keyboard.up(MOD)
    await until('the redo', (s) => s.points === cleaned.points && !s.busy)
    check(true, 'Ctrl+Y takes them again')
  }

  // ---- Plane ------------------------------------------------------------------------
  const before = (await state()).points
  await click(page, '[data-test=cloud-tool-plane]')
  const planed = await until('the plane marking', (s) => s.marked > 0 && s.running === null)
  check(planed.marked > before * 0.2 && planed.marked < before * 0.8, `the points below the middle are marked: ${planed.marked} of ${before}`)
  await page.screenshot({ path: shotPath('cloud-plane.png') })
  await click(page, '[data-test=cloud-delete]')
  await click(page, '[data-test=cloud-delete-confirm]')
  const cut = await until('the cut', (s) => s.running === null && s.points === before - planed.marked)
  check(cut.points === before - planed.marked, `cut at the plane: ${cut.points} points left`)
  if (cut.error) fail(`error line: ${cut.error}`)
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
await finish(browser, consoleErrors)
