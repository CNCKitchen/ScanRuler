// SPDX-License-Identifier: AGPL-3.0-only
// Mesh this cloud in the browser: a point cloud opened, the scan card's
// offer clicked and confirmed, the scan a mesh with triangles; Ctrl+Z, and
// it is the cloud again with every point.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, fail, finish, launchApp, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

/** A tube 20 mm across and 20 long, its normals out, as a binary PLY. */
function tubePly() {
  const rows = []
  const STEP = 0.5
  const R = 10
  for (let k = 0; k <= 40; k++) {
    const z = -10 + k * STEP
    const around = Math.round((2 * Math.PI * R) / STEP)
    for (let a = 0; a < around; a++) {
      const t = (2 * Math.PI * a) / around
      rows.push([R * Math.cos(t), R * Math.sin(t), z, Math.cos(t), Math.sin(t), 0])
    }
  }
  const head = Buffer.from(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n` +
      ['x', 'y', 'z', 'nx', 'ny', 'nz'].map((p) => `property float ${p}\n`).join('') +
      'end_header\n',
    'latin1',
  )
  const body = Buffer.alloc(rows.length * 24)
  rows.forEach((row, i) => row.forEach((v, c) => body.writeFloatLE(v, i * 24 + c * 4)))
  return { bytes: Buffer.concat([head, body]), points: rows.length }
}

const dir = mkdtempSync(join(tmpdir(), 'scanruler-mesh-cloud-'))
const file = join(dir, 'tube.ply')
const tube = tubePly()
writeFileSync(file, tube.bytes)

const state = (page) =>
  page.evaluate(async () => {
    const s = (await import('/src/state/store.ts')).useStore.getState()
    return { cloud: s.scanIsCloud, vertices: s.vertexCount, triangles: s.triangleCount, busy: s.busy, status: s.statusText }
  })

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000 })
try {
  await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(file)
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().scanIsCloud === true, { timeout: 60_000 })
  await sleep(800)
  check((await state(page)).vertices === tube.points, 'the tube opened as a cloud with every point')

  await click(page, '[data-test=mesh-cloud]')
  const ask = await page.$eval('[data-test=mesh-cloud-ask]', (el) => el.textContent)
  check(/Ctrl\+Z returns the cloud/.test(ask ?? ''), `it asks first: "${ask}"`)
  await click(page, '[data-test=mesh-cloud-confirm]')
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().scanIsCloud === false, { timeout: 120_000 })
  await page.waitForFunction(async () => !(await import('/src/state/store.ts')).useStore.getState().busy, { timeout: 120_000 })
  const meshed = await state(page)
  console.log('meshed:', JSON.stringify(meshed))
  check(meshed.triangles > 1000, `the scan is a mesh: ${meshed.triangles} triangles`)
  check(/Ctrl\+Z returns the cloud/.test(meshed.status ?? ''), `the status says how to go back: "${meshed.status}"`)
  const info = await page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ').trim())
  check(/triangles/.test(info), `the top bar counts triangles: ${info}`)
  await page.screenshot({ path: shotPath('mesh-cloud.png') })

  await page.mouse.click(800, 500)
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().scanIsCloud === true, { timeout: 120_000 })
  const back = await state(page)
  check(back.vertices === tube.points, `Ctrl+Z brought the cloud back: ${back.vertices} points`)
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
  rmSync(dir, { recursive: true, force: true })
}
