// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the mouse navigation: drives the real app in headless
// Chrome and exercises orbit, pan and zoom through actual pointer input, in
// two schemes with different button assignments, then confirms that picking
// still works afterwards (a drag must not be mistaken for a click, and a click
// must not be mistaken for a drag).
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-nav.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import {
  canvasRect,
  check,
  drag as libDrag,
  finish,
  launchApp,
  loadScan,
  pixelDiff,
  previewReady,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)

const rect = await canvasRect(page)
const mid = [rect.x + rect.w / 2, rect.y + rect.h / 2]

// The rendered frame is the only readable witness of the camera. It has to come
// from a puppeteer screenshot rather than drawImage on the canvas: a WebGL
// drawing buffer without preserveDrawingBuffer is cleared once composited, so
// reading it back in-page yields an empty image. Round-trip the PNG through the
// page to measure it.
//
// The sampled region is the middle of the viewport, not all of it: the corner
// orientation gizmo and the support banner are painted on the same canvas area
// and would otherwise dominate every measurement of "where is the part".
const CROP = {
  x: rect.x + rect.w * 0.05,
  y: rect.y + rect.h * 0.04,
  width: rect.w * 0.86,
  height: rect.h * 0.78,
}

async function sample() {
  const png = await page.screenshot({ clip: CROP, encoding: 'base64' })
  const m = await page.evaluate(
    (b64) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          const W = 160
          const H = 110
          const c = document.createElement('canvas')
          c.width = W
          c.height = H
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0, W, H)
          const d = ctx.getImageData(0, 0, W, H).data
          let hash = 0
          let n = 0
          let sx = 0
          let sy = 0
          const hits = []
          for (let i = 0; i < d.length; i += 4) {
            hash = (hash * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0
            // The stage is a flat warm grey (0xd7d5cf); anything else is part.
            const off = Math.abs(d[i] - 215) + Math.abs(d[i + 1] - 213) + Math.abs(d[i + 2] - 207)
            if (off <= 40) continue
            const p = i / 4
            n++
            sx += p % W
            sy += (p / W) | 0
            hits.push([(p % W) / W, ((p / W) | 0) / H])
          }
          // Thin out to a spread of actual part pixels: something to aim a pick
          // at, wherever the navigation left the part.
          const step = Math.max(1, Math.floor(hits.length / 40))
          const spots = hits.filter((_, k) => k % step === 0)
          resolve({ hash, area: n / (W * H), cx: n ? sx / n / W : 0.5, cy: n ? sy / n / H : 0.5, spots })
        }
        img.src = 'data:image/png;base64,' + b64
      }),
    png,
  )
  // Hand the centroid back in client coordinates, so a zoom can be anchored on
  // the part rather than on whatever empty space sits at the frame centre.
  const toClient = ([fx, fy]) => [CROP.x + fx * CROP.width, CROP.y + fy * CROP.height]
  return { ...m, png, at: toClient([m.cx, m.cy]), spots: m.spots.map(toClient) }
}

const canvasHash = async () => (await sample()).hash

const scrollAt = async (at, deltaY, ticks) => {
  for (let i = 0; i < ticks; i++) {
    await page.mouse.move(...at)
    await page.mouse.wheel({ deltaY })
    await sleep(60)
  }
  await sleep(350)
}

const setScheme = async (id) => {
  await page.select('#navscheme', id)
  await sleep(120)
  const hint = await page.$eval('.navhint', (el) => el.textContent)
  console.log(`scheme ${id}: ${hint}`)
}

const drag = (from, to, button) => libDrag(page, from, to, { button })

// ---- zoom, from the freshly framed view ----
// Zoom is checked first and anchored on the part's own centroid: the zoom is
// cursor-centric, so pointing it at the empty middle of a ball bar would push
// the part off screen instead of magnifying it in place. The measure is how
// much of the frame the part covers, which survives the pan and orbit that
// follow only if they come afterwards.
await setScheme('cnckitchen')

const framed = await sample()
check(framed.area > 0.005, `the part is on screen to begin with — area ${framed.area.toFixed(4)}`)

await scrollAt(framed.at, -120, 3)
const zoomedIn = await sample()
check(
  zoomedIn.area > framed.area * 1.15,
  `scroll up zooms in — area ${framed.area.toFixed(4)} → ${zoomedIn.area.toFixed(4)}`,
)

await scrollAt(framed.at, 120, 3)
const zoomedBack = await sample()
check(
  Math.abs(zoomedBack.area - framed.area) < framed.area * 0.1,
  `scroll down undoes it — area ${zoomedIn.area.toFixed(4)} → ${zoomedBack.area.toFixed(4)} (framed ${framed.area.toFixed(4)})`,
)

// SolidWorks and the Autodesk desktop tools scroll the other way round. Rather
// than measure a size again — the part already overflows the sampled crop, so
// area stops tracking zoom once it grows — assert the inversion: a SolidWorks
// scroll DOWN has to land on the frame a default scroll UP did. The frames are
// rendered independently, so they are compared by pixel diff with a small
// tolerance rather than by exact hash — last-bit rasterisation jitter is not
// a different camera.
await setScheme('solidworks')
await scrollAt(framed.at, 120, 3)
const swIn = await sample()
const swInDiff = await pixelDiff(page, swIn.png, zoomedIn.png)
check(swInDiff < 0.5, `solidworks scroll is inverted (${swInDiff.toFixed(3)}% off the zoomed-in frame)`)

await scrollAt(framed.at, -120, 3)
const swOut = await sample()
const swOutDiff = await pixelDiff(page, swOut.png, framed.png)
check(swOutDiff < 0.5, `solidworks scroll up zooms back out (${swOutDiff.toFixed(3)}% off the framed view)`)

// ---- drag gestures ----
await setScheme('cnckitchen')

let before = await canvasHash()
await drag(mid, [mid[0] + 220, mid[1] + 90], 'left')
let after = await canvasHash()
check(before !== after, 'left-drag orbits')

// A right-drag is navigation, so the browser context menu must stay shut: watch
// for a contextmenu event reaching the document with its default still intact.
await page.evaluate(() => {
  window.__ctxUnprevented = false
  document.addEventListener('contextmenu', (e) => {
    if (!e.defaultPrevented) window.__ctxUnprevented = true
  })
})

before = after
await drag(mid, [mid[0] - 140, mid[1] - 60], 'right')
after = await canvasHash()
check(before !== after, 'right-drag pans')

check(
  !(await page.evaluate(() => window.__ctxUnprevented)),
  'right-drag opens no context menu',
)

// SolidWorks binds nothing to a plain left drag: the view must hold still.
await setScheme('solidworks')
before = await canvasHash()
await drag(mid, [mid[0] + 200, mid[1] + 80], 'left')
after = await canvasHash()
check(before === after, 'solidworks left-drag does nothing')

// Onshape puts orbit on the right button, where the default scheme pans.
await setScheme('onshape')
before = await canvasHash()
await drag(mid, [mid[0] + 200, mid[1] + 80], 'right')
after = await canvasHash()
check(before !== after, 'onshape right-drag orbits')

// ---- middle-button and chorded schemes ----
// Orbit and pan both just "change the picture", so pixels alone can't tell them
// apart. The pivot marker can: it is drawn only while an orbit is in progress,
// and it is the one bright red thing on the stage. Sample mid-gesture, with the
// buttons still down.
const redPixels = async () => {
  const png = await page.screenshot({ clip: CROP, encoding: 'base64' })
  return page.evaluate(
    (b64) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = 200
          c.height = 140
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0, 200, 140)
          const d = ctx.getImageData(0, 0, 200, 140).data
          let n = 0
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) n++
          }
          resolve(n)
        }
        img.src = 'data:image/png;base64,' + b64
      }),
    png,
  )
}

const glide = async (from, delta, steps = 6) => {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + (delta[0] * i) / steps, from[1] + (delta[1] * i) / steps)
    await sleep(20)
  }
  await sleep(150)
}

/** Run a gesture and report whether the orbit pivot showed up during it. */
const orbitsUnder = async ({ buttons, modifiers = [], chord = null }) => {
  const from = (await sample()).at
  await page.mouse.move(...from)
  for (const m of modifiers) await page.keyboard.down(m)
  for (const b of buttons) await page.mouse.down({ button: b })
  await glide(from, [120, 50])
  // A chorded scheme adds its second button only once the first is dragging.
  if (chord) {
    await page.mouse.down({ button: chord })
    await glide([from[0] + 120, from[1] + 50], [120, 50])
  }
  const red = await redPixels()
  if (chord) await page.mouse.up({ button: chord })
  for (const b of [...buttons].reverse()) await page.mouse.up({ button: b })
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m)
  await sleep(200)
  return { orbited: red > 0, red, afterRed: await redPixels() }
}

await setScheme('blender')
let g = await orbitsUnder({ buttons: ['middle'] })
check(g.orbited, `blender middle-drag orbits (${g.red} pivot px)`)
check(g.afterRed === 0, `the pivot marker clears on release (${g.afterRed} px left)`)

g = await orbitsUnder({ buttons: ['middle'], modifiers: ['Shift'] })
check(!g.orbited, `blender Shift+middle pans, not orbits (${g.red} pivot px)`)

await setScheme('freecad')
g = await orbitsUnder({ buttons: ['middle'] })
check(!g.orbited, `freecad middle-drag pans, not orbits (${g.red} pivot px)`)

// The chord: middle already held and panning, then left goes down and the rest
// of the same drag has to become an orbit.
g = await orbitsUnder({ buttons: ['middle'], chord: 'left' })
check(g.orbited, `freecad middle+left chord orbits (${g.red} pivot px)`)

// ---- picking still works after all that ----
// A drag must not read as a click, and a click must not read as a drag: sweep
// the frame for a point that starts a sphere draft and previews a fit.
await setScheme('cnckitchen')

// Aim at pixels the part actually occupies: the orbits and pans above left it
// wherever they left it, and this check is about the click, not about aim.
const target = await sample()
check(target.spots.length > 0, `the part is still on screen to click — area ${target.area.toFixed(4)}`)

let picked = false
for (const [x, y] of target.spots) {
  if (picked) break
  await page.click('[data-test="fit-sphere"]')
  await page.mouse.click(x, y)
  await sleep(250)
  picked = await previewReady(page, { tries: 60 })
  if (!picked) await page.click('[data-test="cancel-draft"]').catch(() => {})
}
check(picked, 'a click still picks after navigating')

await page.screenshot({ path: shotPath('e2e-nav.png') })

await finish(browser, consoleErrors)
