// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the touch navigation: drives the real app in headless
// Chrome with touch emulation on and exercises the tablet gestures through
// actual touch input — one finger orbits, two fingers pan, a pinch zooms —
// then confirms that a tap still picks and that a pinch never does.
//
// Orbit and pan both just "change the picture", so the pivot marker is what
// tells them apart: it is drawn only while an orbit is in progress and is the
// one bright red thing on the stage, so it is sampled mid-gesture with the
// fingers still down. Same trick as e2e-nav.mjs, for the same reason.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-touch.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import {
  canvasRect,
  check,
  finish,
  launchApp,
  loadScan,
  previewReady,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

// A tablet-shaped window, because that is the machine this exists for.
const { browser, page, consoleErrors } = await launchApp({ width: 1180, height: 820 })
await page.setViewport({ width: 1180, height: 820, hasTouch: true, deviceScaleFactor: 1 })
await loadScan(page, STL)

const rect = await canvasRect(page)
const mid = [rect.x + rect.w / 2, rect.y + rect.h / 2]

// ---- touch input ----------------------------------------------------------
// Puppeteer's own touchscreen is single-finger, so the fingers are dispatched
// straight over CDP. touchPoints is the set of points still ACTIVE after the
// event, which is what makes lifting one finger of two expressible: send a
// touchEnd carrying the finger that stayed.
const cdp = await page.createCDPSession()
const send = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 12, radiusY: 12, force: 1 })),
  })

/** Move every finger from its start to its end position in one smooth sweep. */
async function sweep(from, to, { steps = 10, stepDelay = 22 } = {}) {
  await send('touchStart', from)
  await sleep(40)
  for (let s = 1; s <= steps; s++) {
    await send(
      'touchMove',
      from.map(([x, y], i) => [x + ((to[i][0] - x) * s) / steps, y + ((to[i][1] - y) * s) / steps]),
    )
    await sleep(stepDelay)
  }
  return {
    /** Sample while the fingers are still down — the pivot marker only exists
     *  for as long as the gesture does. */
    async lift() {
      await send('touchEnd', [])
      await sleep(220)
    },
  }
}

const tap = async (at) => {
  await send('touchStart', [at])
  await sleep(60)
  await send('touchEnd', [])
  await sleep(250)
}

// ---- reading the frame ----------------------------------------------------
// The rendered frame is the only readable witness of the camera: a WebGL buffer
// without preserveDrawingBuffer is cleared once composited, so it has to be
// round-tripped through a puppeteer screenshot. The crop skips the corner gizmo
// and the banner, which would otherwise dominate "where is the part".
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
          const W = 200
          const H = 140
          const c = document.createElement('canvas')
          c.width = W
          c.height = H
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0, W, H)
          const d = ctx.getImageData(0, 0, W, H).data
          let n = 0
          let sx = 0
          let sy = 0
          let red = 0
          const hits = []
          for (let i = 0; i < d.length; i += 4) {
            // The pivot marker is the only saturated red on the stage.
            if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110) red++
            // The stage is a flat warm grey (0xd7d5cf); anything else is part.
            const off = Math.abs(d[i] - 215) + Math.abs(d[i + 1] - 213) + Math.abs(d[i + 2] - 207)
            if (off <= 40) continue
            const p = i / 4
            n++
            sx += p % W
            sy += (p / W) | 0
            hits.push([(p % W) / W, ((p / W) | 0) / H])
          }
          const step = Math.max(1, Math.floor(hits.length / 40))
          resolve({
            red,
            area: n / (W * H),
            cx: n ? sx / n / W : 0.5,
            cy: n ? sy / n / H : 0.5,
            spots: hits.filter((_, k) => k % step === 0),
          })
        }
        img.src = 'data:image/png;base64,' + b64
      }),
    png,
  )
  const toClient = ([fx, fy]) => [CROP.x + fx * CROP.width, CROP.y + fy * CROP.height]
  return { ...m, at: toClient([m.cx, m.cy]), spots: m.spots.map(toClient) }
}

// ---- one finger orbits ----------------------------------------------------
const framed = await sample()
check(framed.area > 0.005, `the part is on screen to begin with — area ${framed.area.toFixed(4)}`)

let g = await sweep([framed.at], [[framed.at[0] + 190, framed.at[1] + 80]])
const orbiting = await sample()
await g.lift()
const afterOrbit = await sample()
check(orbiting.red > 0, `one finger orbits — pivot marker up (${orbiting.red} px)`)
check(afterOrbit.red === 0, `the pivot clears when the finger lifts (${afterOrbit.red} px left)`)
check(
  Math.abs(afterOrbit.area - framed.area) < framed.area * 0.35,
  `the orbit turned the part rather than moving it away — area ${framed.area.toFixed(4)} → ${afterOrbit.area.toFixed(4)}`,
)

// ---- pinch zooms ----------------------------------------------------------
// Spread about the part's own centroid: the zoom is anchored on the midpoint of
// the fingers, so pinching over empty space would push the part off screen
// instead of magnifying it in place.
const pinchAbout = (at, from, to) => ({
  from: [
    [at[0] - from, at[1]],
    [at[0] + from, at[1]],
  ],
  to: [
    [at[0] - to, at[1]],
    [at[0] + to, at[1]],
  ],
})

const zoomFrom = await sample()
let s = pinchAbout(zoomFrom.at, 55, 190)
g = await sweep(s.from, s.to)
await g.lift()
const zoomedIn = await sample()
check(
  zoomedIn.area > zoomFrom.area * 1.3,
  `spreading two fingers zooms in — area ${zoomFrom.area.toFixed(4)} → ${zoomedIn.area.toFixed(4)}`,
)

s = pinchAbout(zoomFrom.at, 190, 55)
g = await sweep(s.from, s.to)
await g.lift()
const zoomedOut = await sample()
check(
  zoomedOut.area < zoomedIn.area * 0.8,
  `pinching back zooms out — area ${zoomedIn.area.toFixed(4)} → ${zoomedOut.area.toFixed(4)}`,
)

// ---- two fingers pan ------------------------------------------------------
// Both fingers travel the same vector, so the spacing never changes and the
// gesture is a pure pan: the part has to follow the hand 1:1 and the pivot must
// stay away.
//
// Pinched small first, and deliberately so. The measure is the centroid of the
// part's pixels inside a fixed crop, so a part big enough to reach the edge of
// that crop loses pixels on the leading side as it travels and its centroid
// lags the hand — an artefact of the ruler, not of the pan. Small enough to
// stay wholly inside the crop, the two agree to a pixel or two.
s = pinchAbout((await sample()).at, 190, 70)
g = await sweep(s.from, s.to)
await g.lift()

const before = await sample()
check(before.area < 0.09, `the part is clear of the crop edges to pan — area ${before.area.toFixed(4)}`)
const PAN = [150, -60]
const pair = [
  [before.at[0] - 60, before.at[1]],
  [before.at[0] + 60, before.at[1]],
]
g = await sweep(pair, pair.map(([x, y]) => [x + PAN[0], y + PAN[1]]))
const panning = await sample()
await g.lift()
const panned = await sample()
const moved = [panned.at[0] - before.at[0], panned.at[1] - before.at[1]]
check(panning.red === 0, `two fingers pan, not orbit — no pivot marker (${panning.red} px)`)
check(
  Math.hypot(moved[0] - PAN[0], moved[1] - PAN[1]) < 12,
  `the part follows the fingers 1:1 — asked [${PAN}], moved [${moved.map((v) => v.toFixed(0))}]`,
)

// ---- a pinch is not a pick ------------------------------------------------
// Both fingers land and lift inside the click threshold, which is exactly the
// shape of a tap: without the multi-touch latch this would seed a sphere.
await page.click('[data-test="fit-sphere"]')
const onPart = (await sample()).spots[0] ?? mid
await send('touchStart', [onPart])
await sleep(50)
await send('touchStart', [onPart, [onPart[0] + 90, onPart[1]]])
await sleep(80)
await send('touchEnd', [onPart])
await sleep(50)
await send('touchEnd', [])
await sleep(400)
check(
  !(await previewReady(page, { tries: 4, watchStatus: false })),
  'a two-finger gesture picks nothing',
)

// ---- a tap still picks ----------------------------------------------------
// Sweep the frame for a point that seeds a sphere: the gestures above left the
// part wherever they left it, and this check is about the tap, not about aim.
const target = await sample()
check(target.spots.length > 0, `the part is still on screen to tap — area ${target.area.toFixed(4)}`)

let picked = false
for (const at of target.spots) {
  if (picked) break
  if (!(await page.$('[data-test="cancel-draft"]'))) await page.click('[data-test="fit-sphere"]')
  await tap(at)
  picked = await previewReady(page, { tries: 60 })
  if (!picked) await page.click('[data-test="cancel-draft"]').catch(() => {})
}
check(picked, 'a tap still picks after navigating')

// ---- the brush takes the single finger, never the pair --------------------
// With a marking gesture live the plain drag belongs to the brush, exactly as
// it does for a mouse. The finger has to follow it there — and two fingers have
// to stay with the camera, because otherwise a marking session on a tablet
// would have no way to move the part at all.
if (picked) {
  await page.select('[data-test="draft-select-mode"]', 'paint')
  await page.waitForSelector('[data-test="mark-gestures"]')
  await page.click('[data-test="mark-brush"]')
  await page.waitForSelector('[data-test="mark-brush-diameter"]')
  await page.$eval('[data-test="mark-brush-diameter"]', (el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '10')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(200)

  const marked = () =>
    page
      .$eval('[data-test="paint-count"]', (e) => parseInt(e.textContent.replace(/[^\d]/g, ''), 10))
      .catch(() => 0)

  const armed = await sample()
  const on = armed.spots[Math.floor(armed.spots.length / 2)] ?? mid
  g = await sweep([[on[0] - 14, on[1] - 8]], [[on[0] + 14, on[1] + 8]])
  const brushing = await sample()
  await g.lift()
  const strokeCount = await marked()
  check(strokeCount > 0, `one finger paints when the brush is armed (${strokeCount} marked)`)
  check(brushing.red === 0, `and does not orbit underneath it (${brushing.red} pivot px)`)

  const afterStroke = await sample()
  const twoPair = [
    [on[0] - 60, on[1]],
    [on[0] + 60, on[1]],
  ]
  g = await sweep(twoPair, twoPair.map(([x, y]) => [x + 120, y - 50]))
  await g.lift()
  const afterPan = await sample()
  check((await marked()) === strokeCount, 'two fingers still pan while the brush is armed')
  check(
    Math.hypot(afterPan.at[0] - afterStroke.at[0], afterPan.at[1] - afterStroke.at[1]) > 60,
    'and the part actually moves under them',
  )
}

await page.screenshot({ path: shotPath('e2e-touch.png') })

await finish(browser, consoleErrors)
