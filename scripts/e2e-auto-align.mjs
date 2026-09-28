// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Auto-align: drives the real app in headless Chrome —
// loads a 60 × 40 × 10 block lying at an odd angle well off the origin,
// presses Auto-align, checks the editor opens filled in with a sentence on
// what the proposal was read from, applies it, and then asks again: a part
// that is already aligned must be proposed the pose it is in, so the second
// alignment turns it by nothing and moves it by nothing.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-auto-align.mjs
// Env: CHROME (chrome.exe path), APP_URL.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, finish, launchApp, loadScan, sleep } from './e2e-lib.mjs'

// ---- the scan: a gridded block, turned and moved -----------------------------
const SIZE = [60, 40, 10]
const GRID = 24
const tris = []
for (let axis = 0; axis < 3; axis++) {
  for (const side of [-1, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3
    const at = (i, j) => {
      const q = [0, 0, 0]
      q[axis] = (side * SIZE[axis]) / 2
      q[u] = (i / GRID - 0.5) * SIZE[u]
      q[v] = (j / GRID - 0.5) * SIZE[v]
      return q
    }
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++) {
        const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
        // Wound so the normal points out of the block on either side.
        if (side > 0) tris.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3])
        else tris.push(quad[0], quad[2], quad[1], quad[0], quad[3], quad[2])
      }
  }
}
// Rotation about (0.3, −0.5, 0.81) by 0.9 rad, then a move.
const k = [0.3, -0.5, 0.81].map((c) => c / Math.hypot(0.3, 0.5, 0.81))
const [c, s] = [Math.cos(0.9), Math.sin(0.9)]
const pose = (q) => {
  const d = k[0] * q[0] + k[1] * q[1] + k[2] * q[2]
  const x = [k[1] * q[2] - k[2] * q[1], k[2] * q[0] - k[0] * q[2], k[0] * q[1] - k[1] * q[0]]
  return [0, 1, 2].map((i) => q[i] * c + x[i] * s + k[i] * d * (1 - c) + [12, -7, 30][i])
}
const stl = Buffer.alloc(84 + (tris.length / 3) * 50)
stl.writeUInt32LE(tris.length / 3, 80)
for (let t = 0; t < tris.length / 3; t++)
  for (let corner = 0; corner < 3; corner++) {
    const q = pose(tris[t * 3 + corner])
    for (let i = 0; i < 3; i++) stl.writeFloatLE(q[i], 84 + t * 50 + 12 + corner * 12 + i * 4)
  }
const scanPath = join(mkdtempSync(join(tmpdir(), 'scanruler-auto-align-')), 'block.stl')
writeFileSync(scanPath, stl)

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, scanPath)

/** Auto-align, apply, and what the status line says the part was moved by. */
async function autoAlignOnce(label) {
  await click(page, '[data-test="auto-align"]')
  const opened = await page
    .waitForSelector('[data-test="align-proposal"]', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false)
  check(opened, `${label}: the editor opens on a proposal`)
  if (!opened) return null
  const note = await page.$eval('[data-test="align-proposal"]', (el) => el.textContent)
  console.log(`${label}:`, note)
  const primary = await page.$eval('[data-test="align-primary"]', (el) => el.value)
  const axis = await page.$eval('[data-test="align-primary-axis"]', (el) => el.value)
  check(primary === '__picked__' && axis === 'z-', `${label}: the standing face is filled in, facing down`)
  await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
  await click(page, '[data-test="apply-alignment"]')
  await page
    .waitForFunction(() => /Part aligned — rotated/.test(document.body.innerText ?? ''), { timeout: 60_000 })
    .catch(() => {})
  const m = /Part aligned — rotated ([\d.]+)°, moved ([\d.]+) mm/.exec(await page.evaluate(() => document.body.innerText))
  check(m !== null, `${label}: the alignment is applied`)
  await sleep(300)
  return m ? { note, rotated: Number(m[1]), moved: Number(m[2]) } : null
}

const first = await autoAlignOnce('first')
if (first) {
  check(/faces square to these axes/.test(first.note), 'the proposal says it was read from the faces')
  check(/largest flat face/.test(first.note), 'and that the block stands on its largest face')
  check(first.rotated > 5 && first.moved > 5, `the block is turned and moved (${first.rotated}°, ${first.moved} mm)`)
}
const second = await autoAlignOnce('second')
if (second)
  check(
    second.rotated < 0.05 && second.moved < 0.05,
    `an aligned part is proposed the pose it is in (${second.rotated}°, ${second.moved} mm)`,
  )

await finish(browser, consoleErrors)
