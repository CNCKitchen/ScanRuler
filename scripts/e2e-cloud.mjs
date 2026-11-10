// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud, end to end: a generated plane-and-cylinder PLY (binary, with
// normals, no triangles) is opened through the real file input, a plane is
// picked on it and fitted, the fit is read back, and a tool that needs
// triangles says why it is off in its tooltip.
//
// The cloud is built here, not committed: a 40 x 40 mm plane in z = 0 with a
// cylinder (radius 5, 15 tall) standing on it at one side.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-cloud.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasRect, check, click, fail, finish, launchApp, previewReady, shotPath, sleep } from './e2e-lib.mjs'

const CLOUD_REFUSAL = 'Needs a mesh — this scan is a point cloud. Use Mesh this cloud (on the scan’s card, or mesh.mesh_cloud), or mesh it in your scanner software and open the mesh.'

function cloudPly() {
  const rows = []
  const STEP = 0.5
  for (let i = 0; i <= 80; i++) for (let j = 0; j <= 80; j++) rows.push([-20 + i * STEP, -20 + j * STEP, 0, 0, 0, 1])
  const R = 5
  const CX = 10
  const CY = 0
  for (let k = 0; k <= 30; k++) {
    const z = k * STEP
    const around = Math.round((2 * Math.PI * R) / STEP)
    for (let a = 0; a < around; a++) {
      const t = (2 * Math.PI * a) / around
      rows.push([CX + R * Math.cos(t), CY + R * Math.sin(t), z, Math.cos(t), Math.sin(t), 0])
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
  return Buffer.concat([head, body])
}

const dir = mkdtempSync(join(tmpdir(), 'scanruler-cloud-'))
const file = join(dir, 'plane-cylinder.ply')
writeFileSync(file, cloudPly())

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000 })
try {
  await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(file)
  await page.waitForFunction(
    async () => (await import('/src/state/store.ts')).useStore.getState().scanIsCloud === true,
    { timeout: 60_000 },
  )
  await sleep(800)
  const info = await page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ').trim())
  console.log('loaded:', info)
  check(/plane-cylinder\.ply/.test(info), `the cloud is open: ${info}`)

  // ---- a triangle-only tool says why it is off ---------------------------------
  const section = await page.$eval('[data-test=fit-section]', (el) => ({ disabled: el.disabled, title: el.title }))
  check(section.disabled && section.title === CLOUD_REFUSAL, `Section is off with the refusal as its tooltip: "${section.title}"`)

  // ---- pick the plane, fit, read the value --------------------------------------
  const rect = await canvasRect(page)
  await click(page, '[data-test=fit-plane]')
  // The plane fills most of the stage; the cylinder stands to one side of it.
  let fitted = false
  for (const [fx, fy] of [[0.4, 0.62], [0.35, 0.7], [0.45, 0.55], [0.3, 0.6], [0.5, 0.75], [0.5, 0.5]]) {
    await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
    if (await previewReady(page, { tries: 40 })) {
      fitted = true
      break
    }
  }
  if (!fitted) fail('no plane could be fitted by clicking on the cloud')
  else {
    await click(page, '[data-test=create-element]')
    await sleep(500)
    const fit = await page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.ts')
      const e = useStore.getState().elements.at(-1)
      return e ? { kind: e.fit.kind, normal: e.fit.normal, center: e.fit.center, used: e.fit.usedPoints } : null
    })
    console.log('fit:', JSON.stringify(fit))
    check(fit?.kind === 'plane', 'a plane element was created')
    check(fit && Math.abs(fit.normal[2]) > 0.999, `its normal is the cloud's z axis: ${fit?.normal.map((v) => v.toFixed(4))}`)
    check(fit && Math.abs(fit.center[2]) < 0.01, `it lies in z = 0: centre z ${fit?.center[2].toFixed(4)}`)
    check(fit && fit.used > 1000, `on the plane's points: ${fit?.used}`)
  }
  await page.screenshot({ path: shotPath('cloud-plane.png') })
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
  rmSync(dir, { recursive: true, force: true })
}
