// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the two surface switches in the status strip: TRANSPARENT
// and MESH. Loads ballbar.stl, flips each switch, and reads the part back from
// screenshots — it has to change when a switch goes on, change back when it
// goes off, and the mesh has to show once the part is close enough for its
// triangles to span a few pixels. A shader that fails to compile shows up as
// a console error, which fails the run on its own.
//
// The framed ballbar is a small thing in a large viewport, so every reading
// is taken over the part's own bounding box, found from the screenshot, and
// not over the whole canvas.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-surface.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  launchApp,
  loadScan,
  pixelDiff,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
// The support card sits over the lower-left of the stage, blue buttons and
// all, right where the part is looked for. Closed up front.
await click(page, '[data-test=support-card] .sc-x').catch(() => {})
await sleep(200)
const rect = await canvasRect(page)
const canvasClip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h }

/** Where the part is on the canvas: the bounding box and centre of the pixels
 *  that carry a saturated colour — the scan is scanner blue on a neutral
 *  stage. Null when nothing coloured is on screen. */
async function findPart() {
  const b64 = await page.screenshot({ clip: canvasClip, encoding: 'base64' })
  const box = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const img = await createImageBitmap(new Blob([bin], { type: 'image/png' }))
    const c = new OffscreenCanvas(img.width, img.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, img.width, img.height)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0
    // The axis gizmo is painted into the lower-right corner of the same canvas,
    // and its Z axis is blue; that corner is left out.
    const gizmo = Math.round(img.width * 0.2)
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (x > img.width - gizmo && y > img.height - gizmo) continue
        const i = (y * img.width + x) * 4
        const max = Math.max(data[i], data[i + 1], data[i + 2])
        const min = Math.min(data[i], data[i + 1], data[i + 2])
        // Blue, and clearly so.
        if (max - min > 45 && data[i + 2] > data[i]) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
          n++
        }
      }
    }
    if (n < 50) return null
    return { minX, minY, maxX, maxY, n, scale: img.width }
  }, b64)
  if (!box) return null
  // The screenshot is in device pixels; the clip and the mouse are in CSS ones.
  const s = rect.w / box.scale
  return {
    x: rect.x + box.minX * s,
    y: rect.y + box.minY * s,
    width: (box.maxX - box.minX + 1) * s,
    height: (box.maxY - box.minY + 1) * s,
    cx: rect.x + ((box.minX + box.maxX) / 2) * s,
    cy: rect.y + ((box.minY + box.maxY) / 2) * s,
  }
}

/** A screenshot of the given clip, saved under the name and handed back for
 *  comparison. */
const shoot = async (name, clip) => {
  await sleep(250)
  await page.screenshot({ clip: canvasClip, path: shotPath(`e2e-surface-${name}.png`) })
  return page.screenshot({ clip, encoding: 'base64' })
}
const pressed = (sel) => page.$eval(sel, (el) => el.getAttribute('aria-pressed') === 'true')
/** The part's box, padded a little and kept inside the canvas. */
const padded = (part, pad = 8) => {
  const x0 = Math.max(rect.x, part.x - pad)
  const y0 = Math.max(rect.y, part.y - pad)
  const x1 = Math.min(rect.x + rect.w, part.x + part.width + pad)
  const y1 = Math.min(rect.y + rect.h, part.y + part.height + pad)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// ---- transparent -------------------------------------------------------------
// The bar is framed along the screen's long axis, and it is mostly the empty
// stretch between the two balls; the readings are taken on the ball at the
// near end, which is as wide as the box the whole bar was found in.
const part = await findPart()
if (!part) fail('the scan could not be found on the canvas')
const along = part.height >= part.width
const ballR = (along ? part.width : part.height) / 2
const ball = along
  ? { cx: part.cx, cy: part.y + ballR }
  : { cx: part.x + ballR, cy: part.cy }
const clip = padded({ x: ball.cx - ballR, y: ball.cy - ballR, width: 2 * ballR, height: 2 * ballR })
console.log(`ball on canvas: ${Math.round(clip.width)}×${Math.round(clip.height)} px`)

const plain = await shoot('1-plain', clip)
await click(page, '[data-test="toggle-translucent"]')
check(await pressed('[data-test="toggle-translucent"]'), 'TRANSPARENT reads as on')
const xray = await shoot('2-transparent', clip)
const dOn = await pixelDiff(page, plain, xray)
console.log(`transparent on: ${dOn.toFixed(1)}% of the part's box changed`)
check(dOn > 10, 'the part changes when TRANSPARENT goes on')

await click(page, '[data-test="toggle-translucent"]')
check(!(await pressed('[data-test="toggle-translucent"]')), 'TRANSPARENT reads as off again')
const back = await shoot('3-plain-again', clip)
const dOff = await pixelDiff(page, plain, back)
console.log(`transparent off: ${dOff.toFixed(2)}% differs from the start`)
check(dOff < 1, 'the part is back to solid when TRANSPARENT goes off')

// ---- mesh ---------------------------------------------------------------------
// From the framed distance the ballbar's triangles are a pixel or two across
// and the edges are meant to stay faded out, so zoom in on the part first.
await page.mouse.move(ball.cx, ball.cy)
for (let i = 0; i < 28; i++) {
  await page.mouse.wheel({ deltaY: -120 })
  await sleep(40)
}
await sleep(300)
const near = await findPart()
if (!near) fail('the scan could not be found after zooming in')
const nearClip = padded(near)
console.log(`zoomed part on canvas: ${Math.round(nearClip.width)}×${Math.round(nearClip.height)} px`)

const zoomed = await shoot('4-zoomed', nearClip)
await click(page, '[data-test="toggle-wireframe"]')
check(await pressed('[data-test="toggle-wireframe"]'), 'MESH reads as on')
const mesh = await shoot('5-mesh', nearClip)
const dMesh = await pixelDiff(page, zoomed, mesh)
console.log(`mesh on: ${dMesh.toFixed(1)}% of the part's box changed`)
check(dMesh > 5, 'the edges show when MESH goes on up close')

// Both together: a see-through part with its mesh drawn on.
await click(page, '[data-test="toggle-translucent"]')
const both = await shoot('6-mesh-transparent', nearClip)
const dBoth = await pixelDiff(page, mesh, both)
console.log(`mesh + transparent: ${dBoth.toFixed(1)}% changed against mesh alone`)
check(dBoth > 5, 'TRANSPARENT still changes the part with MESH on')

await click(page, '[data-test="toggle-translucent"]')
await click(page, '[data-test="toggle-wireframe"]')
const restored = await shoot('7-zoomed-again', nearClip)
const dRestored = await pixelDiff(page, zoomed, restored)
console.log(`both off: ${dRestored.toFixed(2)}% differs from the zoomed start`)
check(dRestored < 1, 'the part is plain again with both switches off')

await finish(browser, consoleErrors)
