// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the SpaceMouse: drives the real app in headless Chrome
// with a stand-in puck behind navigator.getGamepads, and confirms the puck
// pans, zooms and turns the main view, holds the wheel off while it moves, and
// passes from the 3D view hidden behind the 2D workspace to the sheet and back.
//
// Prereqs: dev server running (npm run dev), Chrome installed. Reads the
// camera through the development hook, window.__scanruler.
//   node scripts/e2e-spacemouse.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canvasRect,
  check,
  click,
  finish,
  launchApp,
  loadScan,
  OUT_DIR,
  pixelDiff,
  repoFile,
  sleep,
} from './e2e-lib.mjs'
import { buildPng } from './e2e-flat-fixture.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const { browser, page, consoleErrors } = await launchApp()

// The stand-in puck: a Gamepad-shaped object the page only gets to see once it
// has been "touched", as Chrome only shows a real one after the first input.
await page.evaluateOnNewDocument(() => {
  window.__puck = null
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => [window.__puck, null, null, null],
  })
})
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')
const connected = []
page.on('console', (m) => {
  if (/SpaceMouse connected/.test(m.text())) connected.push(m.text())
})
await loadScan(page, STL)

const touch = () =>
  page.evaluate(() => {
    window.__puck = {
      id: 'SpaceMouse Compact (Vendor: 256f Product: c635)',
      index: 0,
      connected: true,
      axes: [0, 0, 0, 0, 0, 0],
    }
    const e = new Event('gamepadconnected')
    e.gamepad = window.__puck
    window.dispatchEvent(e)
  })

/** Hold the puck deflected for `ms`, then let it spring back. */
const hold = async (axes, ms = 300) => {
  await page.evaluate((axes) => {
    window.__puck.axes = axes
  }, axes)
  await sleep(ms)
  await page.evaluate(() => {
    window.__puck.axes = [0, 0, 0, 0, 0, 0]
  })
  await sleep(120)
}

const camera = () =>
  page.evaluate(() => {
    const vp = window.__scanruler.scene().viewport
    const cam = vp.camera
    const dir = cam.getWorldDirection(cam.position.clone())
    return {
      pos: cam.position.toArray(),
      target: vp.controls.target.toArray(),
      dir: dir.toArray(),
      up: cam.up.toArray(),
      zoom: cam.zoom,
      marker: vp.nav.pivotMarker.visible,
    }
  })
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const rect = await canvasRect(page)
const mid = [rect.x + rect.w / 2, rect.y + rect.h / 2]
// Over the main view, so it is the one the puck is aimed at.
await page.mouse.move(...mid)

// ---- nothing is read until the browser reports the puck ---------------------
// Deflected and listed, but never announced: the app must not be polling.
const start = await camera()
await page.evaluate(() => {
  window.__puck = { id: 'SpaceMouse Compact (Vendor: 256f Product: c635)', index: 0, connected: true, axes: [1, 0, 0, 0, 0, 1] }
})
await sleep(250)
check(dist((await camera()).pos, start.pos) < 1e-9, 'a puck the browser has not reported is not read')

await touch()
await sleep(50)
check(connected.length === 1, `the puck connects on its first touch (${connected[0] ?? 'no message'})`)

// ---- pan --------------------------------------------------------------------
let before = await camera()
await hold([1, 0, 0, 0, 0, 0])
let after = await camera()
const moved = after.pos.map((v, i) => v - before.pos[i])
const targetMoved = after.target.map((v, i) => v - before.target[i])
check(dist(moved, [0, 0, 0]) > 1, `slide pans the view (${dist(moved, [0, 0, 0]).toFixed(1)} mm)`)
check(dist(moved, targetMoved) < 1e-6, 'the camera and its target pan together')
check(Math.abs(dot(moved, before.dir)) < 1e-6 * dist(moved, [0, 0, 0]) + 1e-9, 'the pan stays in the screen plane')
check(after.zoom === before.zoom && dist(after.dir, before.dir) < 1e-9, 'a slide neither zooms nor turns')

// ---- zoom -------------------------------------------------------------------
before = after
await hold([0, 1, 0, 0, 0, 0])
after = await camera()
check(after.zoom > before.zoom * 1.3, `pushing forward zooms in (${before.zoom.toFixed(2)} → ${after.zoom.toFixed(2)})`)
before = after
await hold([0, -1, 0, 0, 0, 0])
after = await camera()
check(after.zoom < before.zoom, 'pulling back zooms out')

// ---- the wheel is held off while the puck moves -----------------------------
before = await camera()
await page.evaluate(() => {
  window.__puck.axes = [0.5, 0, 0, 0, 0, 0]
})
await sleep(80)
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel({ deltaY: -120 })
  await sleep(30)
}
await page.evaluate(() => {
  window.__puck.axes = [0, 0, 0, 0, 0, 0]
})
after = await camera()
check(after.zoom === before.zoom, 'wheel events while the puck moves are ignored')
await sleep(250)
before = await camera()
await page.mouse.wheel({ deltaY: -120 })
await sleep(120)
after = await camera()
check(after.zoom !== before.zoom, 'the wheel zooms again once the puck rests')

// ---- turn -------------------------------------------------------------------
before = await camera()
await page.evaluate(() => {
  window.__puck.axes = [0, 0, 0, 0, 0, 1]
})
await sleep(250)
const turning = await camera()
check(turning.marker, 'the pivot marker shows while the puck turns')
await hold([0, 0, 0, 0.6, 0, 0.6], 150)
after = await camera()
const turned = Math.acos(Math.min(1, dot(before.dir, after.dir)))
check(turned > 0.3, `tilt and twist turn the part (${((turned * 180) / Math.PI).toFixed(0)}°)`)
// The free orbit: up turns with the camera, wherever it pointed before.
check(Math.abs(dot(after.up, after.dir) - dot(before.up, before.dir)) < 1e-6, 'up turns with the camera: the free orbit')
await sleep(300)
check(!(await camera()).marker, 'the pivot marker goes once the puck settles')

// ---- the 2D workspace takes the puck, and gives it back ---------------------
await click(page, '[data-test=workspace-flat]')
await sleep(600)
await click(page, '[data-test=support-card] .sc-x').catch(() => {})
// A flatbed scan on the sheet, so a pan shows.
const fixture = join(OUT_DIR, 'spacemouse-sheet.png')
writeFileSync(fixture, buildPng())
await (await page.$('input[type=file][accept*=".png"]')).uploadFile(fixture)
await page.waitForFunction(
  () => /chains found/.test(document.querySelector('[data-test=flat-edge-status]')?.textContent ?? ''),
  { timeout: 60_000 },
)
await sleep(300)
// Keep the mouse off the sheet: the puck has to find it without being aimed.
await page.mouse.move(5, 5)
const flatSel = '.viewslot:not([hidden]) .viewport canvas:not(.loupe)'
const flatRect = await canvasRect(page, flatSel)
const clip = { x: flatRect.x + 20, y: flatRect.y + 20, width: flatRect.w - 40, height: flatRect.h * 0.6 }
const hidden3d = await camera()
const sheetBefore = await page.screenshot({ clip, encoding: 'base64' })
await hold([1, 0, 0, 0, 0, 0.8])
const sheetAfter = await page.screenshot({ clip, encoding: 'base64' })
const sheetDiff = await pixelDiff(page, sheetBefore, sheetAfter)
check(sheetDiff > 1, `the puck pans the 2D sheet (${sheetDiff.toFixed(1)}% of it changed)`)
check(dist((await camera()).pos, hidden3d.pos) < 1e-9, 'the 3D view hidden behind it stays put')

await click(page, '[data-test=workspace-elements]')
await sleep(600)
await page.mouse.move(5, 5)
before = await camera()
await hold([1, 0, 0, 0, 0, 0])
after = await camera()
check(dist(after.pos, before.pos) > 1, 'back in 3D, the puck drives the main view again')

await finish(browser, consoleErrors)
