// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud, end to end: a generated plane-and-cylinder PLY (binary, with
// normals, no triangles) is opened through the real file input, a plane is
// picked on it and fitted, the fit is read back, and a tool that needs
// triangles says why it is off in its tooltip. Then what the viewer does with
// a cloud: the section view cuts its points away; a project saved with it
// opens again as a cloud, the cloud-only gating with it; the pins' line of
// sight holds on a surface seen at a grazing angle and still hides a pin
// behind the part; and Mesh this cloud, and its undo, swap the scan object
// for the other kind, one object left, shown and see-through as before.
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
import { awaitDownload, check, click, downloadsTo, fail, finish, launchApp, MOD, previewReady, shotPath, sleep } from './e2e-lib.mjs'

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

/** Where points of the scan land on the page, through the camera the view is
 *  drawn with — wherever the framing puts the part. Needs the app's
 *  development hook, window.__scanruler. */
const toClientAll = (page, points) => page.evaluate((qs) => {
  const s = window.__scanruler.scene()
  const c = s.viewport.renderer.domElement.getBoundingClientRect()
  const cam = s.viewport.view
  cam.updateMatrixWorld()
  return qs.map((q) => {
    const v = cam.position.clone().set(q[0], q[1], q[2]).project(cam)
    return [c.left + ((v.x + 1) / 2) * c.width, c.top + ((1 - v.y) / 2) * c.height]
  })
}, points)

/** The colour of the page at each client position, a 3 x 3 average, read off
 *  a screenshot: the WebGL buffer is gone by the time script could read it. */
async function colours(page, at) {
  const shot = await page.screenshot({ encoding: 'base64' })
  return page.evaluate(async (b64, xy) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const { data } = g.getImageData(0, 0, c.width, c.height)
    return xy.map(([x, y]) => {
      const sum = [0, 0, 0]
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = 4 * (Math.round(y + dy) * c.width + Math.round(x + dx))
          for (let k = 0; k < 3; k++) sum[k] += data[i + k]
        }
      return sum.map((v) => v / 9)
    })
  }, shot, at)
}
const apart = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])))

/** The scan as the viewer holds it: the objects in the part's group that are
 *  a scan (laid out with the scan's paint channel), and the one in hand. */
const scanState = (page) => page.evaluate(() => {
  const s = window.__scanruler.scene()
  const scans = s.partGroup.children.filter((o) => (o.isMesh || o.isPoints) && o.geometry?.getAttribute?.('paint'))
  let points = 0
  s.viewport.scene.traverse((o) => { if (o.isPoints) points++ })
  const m = s.mesh
  const mat = m?.material
  return {
    count: scans.length,
    inHand: scans[0] === m,
    pointsInScene: points,
    isPoints: Boolean(m?.isPoints),
    cloud: Boolean(s.cloud),
    vertices: m?.geometry.getAttribute('position').count ?? 0,
    triangles: m?.geometry.index ? m.geometry.index.count / 3 : 0,
    visible: Boolean(m?.visible),
    opacity: m ? (m.isPoints ? mat.uniforms.uOpacity.value : mat.opacity) : null,
    transparent: Boolean(mat?.transparent),
  }
})

const storeState = (page) => page.evaluate(() => {
  const s = window.__scanruler.measure.getState()
  return { cloud: s.scanIsCloud, busy: Boolean(s.busy), elements: s.elements.map((e) => e.kind) }
})

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
  const cloudVertices = (await scanState(page)).vertices
  // A picture of the cloud alone is not an empty frame (view.render's
  // "Nothing is drawn" note reads SceneManager.drawsSurface).
  check(await page.evaluate(() => window.__scanruler.scene().drawsSurface()), 'the cloud counts as a surface drawn')

  // ---- the section view cuts the cloud's points -------------------------------
  // Seen from the top, cut at x = 0 taking away the x > 0 half (the cylinder
  // with it). Points of the plane on each side, clear of the cut and of
  // where the cylinder stands on screen, are read before and after: the
  // ones taken away go to the background, the kept ones stay as they were.
  await page.mouse.move(1, 1)
  await page.evaluate(() => window.__scanruler.scene().viewFrom('top'))
  await sleep(900)
  const samples = []
  for (let x = -18; x <= 18; x += 3) for (let y = -18; y <= 18; y += 3) if (Math.abs(x) >= 3) samples.push([x, y, 0])
  const cylBox = await toClientAll(page, [[5, -5, 0], [15, 5, 0], [5, 5, 15], [15, -5, 15], [5, -5, 15], [15, 5, 15], [5, 5, 0], [15, -5, 0]])
  const xs = cylBox.map((p) => p[0])
  const ys = cylBox.map((p) => p[1])
  const onScreen = await toClientAll(page, samples)
  const clear = samples
    .map((p, i) => ({ p, at: onScreen[i] }))
    .filter(({ at }) => at[0] < Math.min(...xs) - 12 || at[0] > Math.max(...xs) + 12 || at[1] < Math.min(...ys) - 12 || at[1] > Math.max(...ys) + 12)
  const whole = await colours(page, clear.map((c) => c.at))
  await page.evaluate(() => {
    window.__scanruler.scene().setSectionView({ origin: [0, 0, 0], normal: [1, 0, 0], basisU: [0, 1, 0], basisV: [0, 0, 1] })
  })
  await sleep(500)
  const cutState = await page.evaluate(() => {
    const s = window.__scanruler.scene()
    return { planes: s.mesh.material.clippingPlanes?.length ?? 0, clip: s.sectionClip() !== null }
  })
  check(cutState.clip && cutState.planes === 1, `the cloud's material carries the section plane (${cutState.planes})`)
  const cut = await colours(page, clear.map((c) => c.at))
  await page.screenshot({ path: shotPath('cloud-section.png') })
  const read = clear.map((c, i) => ({ ...c, change: apart(whole[i], cut[i]) }))
  const away = read.filter((g) => g.p[0] > 0)
  const kept = read.filter((g) => g.p[0] < 0)
  const awayChanged = away.filter((g) => g.change > 30).length
  const keptSame = kept.filter((g) => g.change < 12).length
  console.log(`section: ${away.length} samples cut away (${awayChanged} changed), ${kept.length} kept (${keptSame} unchanged)`)
  check(away.length >= 10 && awayChanged >= away.length * 0.9, `the points on the cut-away side are gone: ${awayChanged}/${away.length}`)
  check(kept.length >= 10 && keptSame >= kept.length * 0.9, `the points on the kept side are drawn as before: ${keptSame}/${kept.length}`)
  const pickAway = await page.evaluate((xy) => window.__scanruler.scene().pick(xy[0], xy[1])?.point ?? null, away[0]?.at ?? [0, 0])
  check(pickAway === null, `a click on a cut-away point meets nothing (${JSON.stringify(pickAway)})`)
  await page.evaluate(() => window.__scanruler.scene().setSectionView(null))
  await sleep(500)
  const back = await colours(page, clear.map((c) => c.at))
  const restored = clear.filter((_, i) => apart(whole[i], back[i]) < 12).length
  check(restored >= clear.length * 0.9, `the cloud is whole again with the section put away: ${restored}/${clear.length}`)
  await page.evaluate(() => window.__scanruler.scene().viewFrom('iso'))
  await sleep(900)

  // ---- a section is read off the points; a triangle-only tool says why it is off
  const section = await page.$eval('[data-test=fit-section]', (el) => ({ disabled: el.disabled }))
  check(!section.disabled, 'Section is on for a cloud')
  const exportMesh = await page.$eval('[data-test=export-mesh]', (el) => ({ disabled: el.disabled, title: el.title }))
  check(exportMesh.disabled && exportMesh.title === CLOUD_REFUSAL, `Export mesh is off with the refusal as its tooltip: "${exportMesh.title}"`)
  check(Boolean(await page.$('[data-test=mesh-cloud]')), 'the scan card offers Mesh this cloud')

  // ---- pick the plane, fit, read the value --------------------------------------
  await click(page, '[data-test=fit-plane]')
  // Points of the plane well clear of the cylinder (at x = 10), put on the
  // screen through the camera the view is drawn with — wherever the framing
  // puts the part. Needs the app's development hook, window.__scanruler.
  const toClient = (p) => page.evaluate((q) => {
    const s = window.__scanruler.scene()
    const c = s.viewport.renderer.domElement.getBoundingClientRect()
    const cam = s.viewport.view
    cam.updateMatrixWorld()
    const v = cam.position.clone().set(q[0], q[1], q[2]).project(cam)
    return [c.left + ((v.x + 1) / 2) * c.width, c.top + ((1 - v.y) / 2) * c.height]
  }, p)
  let fitted = false
  for (const at of [[-10, -10, 0], [-12, 6, 0], [-5, -14, 0], [-15, 0, 0], [0, 12, 0]]) {
    await page.mouse.click(...(await toClient(at)))
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

  // ---- a project saved with the cloud opens as a cloud -------------------------
  await downloadsTo(page, dir)
  await click(page, '[data-test="save-project"]')
  const saved = await awaitDownload(dir, '.scanruler')
  check(Boolean(saved), `the project was saved: ${saved}`)
  if (saved) {
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.panel')
    check(!(await storeState(page)).cloud, 'a fresh session after the reload')
    await (await page.$('[data-test="project-input"]')).uploadFile(join(dir, saved))
    await page.waitForFunction(() => /Project opened/.test(document.querySelector('.strip')?.textContent ?? ''), { timeout: 120_000 })
    await sleep(800)
    const reopened = await storeState(page)
    console.log('reopened:', JSON.stringify(reopened))
    check(reopened.cloud === true, 'the store says the scan is a cloud after the project opens')
    check(reopened.elements.length === 1 && reopened.elements[0] === 'plane', `the plane came back: ${reopened.elements}`)
    check((await scanState(page)).isPoints, 'the viewer draws it as points')
    const exportAgain = await page.$eval('[data-test=export-mesh]', (el) => ({ disabled: el.disabled, title: el.title }))
    check(exportAgain.disabled && exportAgain.title === CLOUD_REFUSAL, `Export mesh is off again with the refusal: "${exportAgain.title}"`)
    check(Boolean(await page.$('[data-test=mesh-cloud]')), 'the scan card offers Mesh this cloud again')
    check(!(await page.$eval('[data-test=fit-section]', (el) => el.disabled)), 'Section is still on for the cloud')
  }

  // ---- pins on a surface seen at a grazing angle -------------------------------
  // Three readings pinned to the plane: two in the open, one behind the
  // cylinder from a camera low over the plane at the front (about 83 degrees
  // off its normal). The open ones are on the surface in view and stay; the
  // one behind the cylinder goes. From the top all three are in view.
  const pinsSeen = (dir) => page.evaluate(async (d) => {
    const s = window.__scanruler.scene()
    const cam = s.viewport.view
    s.viewport.lookFrom(cam.position.clone().set(d[0], d[1], d[2]), cam.up.clone().set(0, 0, 1))
    for (let i = 0; i < 3; i++) {
      s.pumpFrame()
      await new Promise((r) => requestAnimationFrame(r))
    }
    return s.overlays.probePins.map((p) => p.dot.visible && p.label.visible)
  }, dir)
  await page.evaluate(() => {
    const s = window.__scanruler.scene()
    s.setProbeOcclusion(true)
    s.setProbes([
      { id: 1, point: [-8, 0, 0], title: 'DEV', label: 'a' },
      { id: 2, point: [-14, -10, 0], title: 'DEV', label: 'b' },
      { id: 3, point: [10, 12, 0], title: 'DEV', label: 'c' },
    ])
  })
  const grazing = await pinsSeen([0, -1, 0.12])
  await page.screenshot({ path: shotPath('cloud-pins-grazing.png') })
  const fromTop = await pinsSeen([0, 0, 1])
  console.log('pins seen, grazing:', JSON.stringify(grazing), 'top:', JSON.stringify(fromTop))
  check(grazing[0] && grazing[1], 'pins on the plane seen at a grazing angle are shown')
  check(grazing[2] === false, 'a pin behind the cylinder is hidden')
  check(fromTop.length === 3 && fromTop.every(Boolean), 'from the top every pin is shown')
  await page.evaluate(() => window.__scanruler.scene().setProbes([]))

  // ---- Mesh this cloud swaps the scan object, and undo swaps it back -----------
  // See-through before the swap: the mesh comes in see-through. Hidden before
  // the undo: the cloud comes back hidden. One scan object every time.
  await page.evaluate(() => window.__scanruler.measure.getState().setTranslucent(true))
  await sleep(300)
  check((await scanState(page)).opacity < 1, 'the cloud is see-through')
  await click(page, '[data-test=mesh-cloud]')
  await click(page, '[data-test=mesh-cloud-confirm]')
  await page.waitForFunction(() => {
    const s = window.__scanruler.measure.getState()
    return s.scanIsCloud === false && !s.busy
  }, { timeout: 180_000 })
  await sleep(800)
  const meshed = await scanState(page)
  console.log('meshed:', JSON.stringify(meshed))
  check(meshed.count === 1 && meshed.inHand, `one scan object in the part after meshing (${meshed.count})`)
  check(!meshed.isPoints && !meshed.cloud && meshed.triangles > 0, `it is the mesh: ${meshed.triangles} triangles`)
  check(meshed.pointsInScene === 0, `no points left on the stage (${meshed.pointsInScene})`)
  check(meshed.visible, 'the mesh is shown, as the cloud was')
  check(meshed.opacity < 1 && meshed.transparent, `the mesh is see-through, as the cloud was (${meshed.opacity})`)
  await page.screenshot({ path: shotPath('cloud-meshed.png') })

  await page.evaluate(() => window.__scanruler.measure.getState().setScanHidden(true))
  await sleep(300)
  check(!(await scanState(page)).visible, 'the mesh is hidden')
  await page.mouse.move(1, 1)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.down(MOD)
  await page.keyboard.press('z')
  await page.keyboard.up(MOD)
  await page.waitForFunction(() => {
    const s = window.__scanruler.measure.getState()
    return s.scanIsCloud === true && !s.busy
  }, { timeout: 120_000 })
  await sleep(800)
  const undone = await scanState(page)
  console.log('undone:', JSON.stringify(undone))
  check(undone.count === 1 && undone.inHand, `one scan object in the part after the undo (${undone.count})`)
  check(undone.isPoints && undone.cloud && undone.vertices === cloudVertices, `it is the cloud again: ${undone.vertices} of ${cloudVertices} points`)
  check(undone.pointsInScene === 1, `one points object on the stage (${undone.pointsInScene})`)
  check(!undone.visible, 'the cloud comes back hidden, as the mesh was')
  check(undone.opacity < 1 && undone.transparent, `and see-through (${undone.opacity})`)
  await page.evaluate(() => {
    const m = window.__scanruler.measure.getState()
    m.setScanHidden(false)
    m.setTranslucent(false)
  })
  await sleep(300)
  const shown = await scanState(page)
  check(shown.visible && shown.opacity === 1 && !shown.transparent, 'shown and solid again')
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
  rmSync(dir, { recursive: true, force: true })
}
