// SPDX-License-Identifier: AGPL-3.0-only
// Isolated browser test; never pairs with an agent or opens a user's scan.
// Run with the local dev server: node plugins/mesh-tools/scripts/e2e-mesh-bridge.mjs
import { check, finish, launchApp, MOD, shotPath } from '../../../scripts/e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
const command = (name, input = {}) => page.evaluate(async (n, args) => {
  const { runCommand } = await import('/src/commands/registry.ts')
  return runCommand(n, args)
}, name, input)
const pending = () => page.evaluate(async () => (await import('/plugins/mesh-tools/state/meshStore.ts')).useMeshTools.getState().pending)
const settle = () => page.waitForFunction(async () => {
  const { useMeshTools } = await import('/plugins/mesh-tools/state/meshStore.ts')
  const { useStore } = await import('/src/state/store.ts')
  return !useMeshTools.getState().editing && !useStore.getState().busy
})
const screenPoints = (xs) => page.evaluate(async (values) => {
  const { sceneOf } = await import('/src/commands/host.ts')
  const host = sceneOf().layerHost()
  const rect = host.canvas.getBoundingClientRect()
  host.partGroup.updateMatrixWorld(true)
  return values.map((x) => {
    const p = host.camera().position.clone().set(x, 4, 0.01 * x * x).applyMatrix4(host.partGroup.matrixWorld).project(host.camera())
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 }
  })
}, xs)
const markers = () => page.evaluate(async () => {
  const { sceneOf } = await import('/src/commands/host.ts')
  const points = []
  sceneOf().layerHost().partGroup.traverse((object) => {
    if (object.name.startsWith('Bridge point ')) points.push({ name: object.name, point: object.position.toArray() })
  })
  return points
})
const waitForSaveStatus = (dirty) => page.waitForFunction((expected) =>
  document.querySelector('[data-test="project-save-status"]')?.firstChild?.textContent === expected,
{}, dirty ? 'Unsaved changes' : 'No unsaved changes')
const saveStatus = () => page.$eval('[data-test="project-save-status"]', (el) => el.firstChild.textContent)
const startDrag = async (x) => {
  const [from] = await screenPoints([x])
  await page.mouse.move(from.x, from.y)
  await page.waitForFunction(() => document.querySelector('canvas')?.style.cursor === 'grab')
  await page.mouse.down()
}
const drag = async (fromX, toX) => {
  await startDrag(fromX)
  const [to] = await screenPoints([toX])
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
  await settle()
}
const preview = async () => {
  await page.click('[data-test="bridge-preview"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-report"]')
}
const approveSave = async (expected, selectedName) => {
  const writes = await page.evaluate(() => window.revisionTest.writes.length)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => !!window.revisionTest.dialog)
  check(await page.evaluate(() => window.revisionTest.dialog.name) === expected, `Save As offers ${expected}`)
  check(await page.evaluate(() => window.revisionTest.writes.length) === writes, 'no bytes are written before filename approval')
  await page.evaluate((name) => window.revisionTest.answer(true, name), selectedName)
}

try {
  await page.evaluate(async () => {
    const { registerCoreCommands } = await import('/src/commands/core.ts')
    registerCoreCommands()
    const { buildBinaryPly } = await import('/plugins/mesh-tools/core/plyWriter.ts')
    const { runCommand } = await import('/src/commands/registry.ts')
    const { angledBridgeFixture } = await import('/plugins/mesh-tools/tests/bridgeFixture.ts')
    const oblique = angledBridgeFixture()
    await runCommand('scan.open', { bytes: buildBinaryPly(oblique.positions, oblique.indices, 'angled bridge test'), name: 'angled-bridge-test.ply', units: 'mm' })
    await runCommand('workspace.set', { workspace: 'mesh' })
    await runCommand('view.set', { view: 'top', fit: true })
  })
  await page.click('[data-test="mesh-tool-bridge"]')
  check(await page.$$eval('[data-test="bridge-tool"] p', (nodes) => nodes.length) === 1,
    'the idle bridge panel shows only the current picking prompt, not instruction paragraphs')
  await page.click('[data-test="bridge-help"]')
  await page.waitForSelector('[data-test="bridge-help-card"]')
  check(await page.$eval('[data-test="bridge-help-card"]', (el) =>
    ['Fill holes', 'Draw crossing', 'Ctrl+Z', 'not saved'].every((text) => el.textContent.includes(text))),
    'the existing info-card style retains bridge workflow, undo and temporary-preview guidance')
  await page.keyboard.press('Escape')
  check(!await page.$('[data-test="bridge-help-card"]'), 'Escape closes bridge help')
  await page.click('[data-test="bridge-width"]')
  await page.keyboard.down(MOD)
  await page.keyboard.press('a')
  await page.keyboard.up(MOD)
  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  const obliquePicks = await page.evaluate(async () => {
    const { angledBridgeFixture } = await import('/plugins/mesh-tools/tests/bridgeFixture.ts')
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    const rect = host.canvas.getBoundingClientRect()
    host.partGroup.updateMatrixWorld(true)
    return angledBridgeFixture().points.map((point, index) => {
      const p = host.camera().position.clone().set(...point)
      if (index === 2) p.x -= 0.05
      if (index === 3) p.x += 0.05
      p.applyMatrix4(host.partGroup.matrixWorld).project(host.camera())
      return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 }
    })
  })
  for (const p of obliquePicks) await page.mouse.click(p.x, p.y)
  await preview()
  const obliqueGuides = JSON.stringify(await markers())
  check(!await page.$('[data-test="bridge-guidance"]') && !await page.$('[data-test="bridge-bend-result"]'),
    'oblique uneven rim picks preview at full bow without error or automatic bend reduction')
  await page.click('[data-test="bridge-apply"]')
  await settle()
  check((await pending()).length === 1 && ((await pending())[0].bend ?? 1) === 1,
    'angled attachment applies through the regular UI as one full-bow edit')
  await command('history.undo')
  check((await pending()).length === 0 && JSON.parse(obliqueGuides).length === 6,
    'the angled bridge is undoable without changing the original scan')
  await page.click('[data-test="bridge-draw"]')
  await page.mouse.move(obliquePicks[0].x, obliquePicks[0].y)
  await page.mouse.down()
  for (const p of obliquePicks.slice(1)) await page.mouse.move(p.x, p.y, { steps: 10 })
  await page.mouse.up()
  await settle()
  await page.waitForSelector('[data-test="bridge-report"]')
  check((await markers()).length === 6 && !await page.$('[data-test="bridge-bend-result"]'),
    'Draw crossing also previews an oblique uneven-rim crossing without flattening its bow')
  await page.evaluate(async () => {
    const { bridgeFixture } = await import('/plugins/mesh-tools/tests/bridgeFixture.ts')
    const { buildBinaryPly } = await import('/plugins/mesh-tools/core/plyWriter.ts')
    const { runCommand } = await import('/src/commands/registry.ts')
    const g = bridgeFixture(0.01)
    await runCommand('scan.open', { bytes: buildBinaryPly(g.positions, g.indices, 'bridge test'), name: 'bridge-test.ply', units: 'mm' })
    await runCommand('workspace.set', { workspace: 'mesh' })
    await runCommand('view.set', { view: 'top', fit: true })
  })
  if (!await page.$('[data-test="bridge-tool"]')) await page.click('[data-test="mesh-tool-bridge"]')
  await page.waitForSelector('[data-test="bridge-tool"]')
  await page.click('[data-test="bridge-width"]')
  await page.keyboard.down(MOD)
  await page.keyboard.press('a')
  await page.keyboard.up(MOD)
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  const bentPicks = await page.evaluate(async () => {
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    const rect = host.canvas.getBoundingClientRect()
    host.partGroup.updateMatrixWorld(true)
    return [-11, -7, -3.1, 3.1, 7, 11].map((x, i) => {
      const p = host.camera().position.clone().set(x, i === 1 || i === 4 ? -2 : 4, 0.01 * x * x)
        .applyMatrix4(host.partGroup.matrixWorld).project(host.camera())
      return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 }
    })
  })
  for (const p of bentPicks) await page.mouse.click(p.x, p.y)
  await page.click('[data-test="bridge-preview"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-reduce-bend"]')
  check(await page.$eval('[data-test="bridge-guidance"]', (el) => {
    const color = getComputedStyle(el).color.match(/\d+/g).map(Number)
    return color[0] > color[1] && color[0] > color[2] && getComputedStyle(el).borderLeftWidth === '4px'
  }), 'bridge errors are red and bordered rather than ordinary panel text')
  const unchangedGuides = JSON.stringify(await markers())
  await page.waitForSelector('[data-test="bridge-adjust-points"]')
  await page.click('[data-test="bridge-adjust-points"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-points-result"]')
  const adjustedGuides = await markers()
  const oldGuides = JSON.parse(unchangedGuides)
  check(JSON.stringify(adjustedGuides) !== unchangedGuides &&
    JSON.stringify(adjustedGuides[2]) === JSON.stringify(oldGuides[2]) &&
    JSON.stringify(adjustedGuides[3]) === JSON.stringify(oldGuides[3]) &&
    (await pending()).length === 0,
  'guide adjustment moves actual surface markers, keeps both inner picks, and edits no mesh before Apply')
  check(await page.evaluate(async () => {
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    const moved = []
    host.partGroup.traverse((object) => {
      if (object.name.startsWith('Bridge moved point ')) moved.push(object.material.color.getHex() === 0x30e46c && !!object.material.map)
    })
    return moved.length > 0 && moved.every(Boolean)
  }), 'moved guides have green ring indicators')
  check(!await page.$('[data-test="bridge-bend-result"]'), 'guide correction uses full sampled bend instead of hidden bend reduction')
  await preview()
  check(JSON.stringify(await markers()) === JSON.stringify(adjustedGuides) &&
    !!await page.$('[data-test="bridge-restore-points"]'), 'Preview keeps adjusted points and their restore action')
  await page.click('[data-test="bridge-restore-points"]')
  await settle()
  check(JSON.stringify(await markers()) === unchangedGuides &&
    !!await page.$('[data-test="bridge-reduce-bend"]') &&
    !await page.$('[data-test="bridge-points-result"]'),
  'Restore returns exact original points and their original full-bend validation error')
  await page.click('[data-test="bridge-adjust-points"]')
  await settle()
  const adjustedRibbon = await page.evaluate(async () => {
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    let triangles = []
    host.partGroup.traverse((object) => {
      if (object.isMesh && object.material.color?.getHex() === 0x12a594 && object.material.opacity === 0.7) {
        triangles = Array.from(object.geometry.attributes.position.array)
      }
    })
    return triangles
  })
  await page.click('[data-test="bridge-apply"]')
  await settle()
  const adjustedEdit = (await pending())[0]
  check(adjustedEdit?.kind === 'bridge' && (adjustedEdit.bend ?? 1) === 1 && await page.evaluate(async (preview) => {
    const { editedCopy } = await import('/plugins/mesh-tools/state/editedCopy.ts')
    const { parsePLY } = await import('/src/core/parsers/ply.ts')
    const { bridgeFixture } = await import('/plugins/mesh-tools/tests/bridgeFixture.ts')
    const mesh = parsePLY(editedCopy.current.source.bytes.slice().buffer)
    const originalCount = bridgeFixture(0.01).vertexCount
    const patch = []
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ids = Array.from(mesh.indices.subarray(i, i + 3))
      if (ids.some((v) => v >= originalCount)) {
        for (const v of ids) patch.push(...mesh.positions.subarray(v * 3, v * 3 + 3))
      }
    }
    const canonical = (soup) => {
      const triangles = []
      for (let i = 0; i < soup.length; i += 9) {
        triangles.push([0, 3, 6].map((j) => soup.slice(i + j, i + j + 3).join(',')).sort().join(';'))
      }
      return triangles.sort().join('|')
    }
    return preview.length > 0 && canonical(patch) === canonical(preview)
  }, adjustedRibbon), 'Apply writes exactly the adjusted full-bend preview geometry into the editable mesh')
  await command('history.undo')
  await page.waitForSelector('[data-test="bridge-tool"]')
  for (const p of bentPicks) await page.mouse.click(p.x, p.y)
  await page.click('[data-test="bridge-preview"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-reduce-bend"]')
  await page.click('[data-test="bridge-reduce-bend"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-bend-result"]')
  check(JSON.stringify(await markers()) === unchangedGuides && (await pending()).length === 0,
    'explicit bend reduction previews without moving any guide or editing the scan')
  const correctedTriangles = await page.evaluate(async () => {
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    const meshes = []
    host.partGroup.traverse((object) => {
      if (object.isMesh && object.material.color?.getHex() === 0x12a594 && object.material.opacity === 0.7) {
        meshes.push(Array.from(object.geometry.attributes.position.array))
      }
    })
    return meshes
  })
  check(correctedTriangles.length === 1 && correctedTriangles[0].length > 0, 'bend reduction produces a real checked ribbon')
  const retainedBend = await page.$eval('[data-test="bridge-bend-result"]', (el) => el.textContent)
  await page.click('[data-test="bridge-adjust-points"]')
  await settle()
  await page.waitForSelector('[data-test="bridge-points-result"]')
  await page.click('[data-test="bridge-restore-points"]')
  await settle()
  check(JSON.stringify(await markers()) === unchangedGuides &&
    await page.$eval('[data-test="bridge-bend-result"]', (el) => el.textContent) === retainedBend,
  'guide adjustment remains available after bend reduction and Restore recovers the prior points and bend factor')
  await preview()
  check(await page.$eval('[data-test="bridge-bend-result"]', (el) => el.textContent) === retainedBend,
    'explicit Preview preserves the checked reduced-bend setting')
  const reducedWidth = await page.$('[data-test="bridge-width"]')
  await reducedWidth.click()
  await page.keyboard.down(MOD)
  await page.keyboard.press('a')
  await page.keyboard.up(MOD)
  await page.keyboard.type('2.5')
  await page.keyboard.press('Enter')
  await settle()
  check(await page.$eval('[data-test="bridge-bend-result"]', (el) => el.textContent) === retainedBend,
    'width changes recheck without discarding the retained bend setting')
  await page.click('[data-test="bridge-apply"]')
  await settle()
  check((await pending())[0]?.bend > 0 && (await pending())[0]?.bend < 1,
    'Apply retains the selected reduced-bend setting in edit history')
  await command('history.undo')
  await page.click('[data-test="bridge-clear"]')
  await page.click('[data-test="bridge-width"]')
  await page.keyboard.down(MOD)
  await page.keyboard.press('a')
  await page.keyboard.up(MOD)
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  const drawCrossing = async (xs, cancel = false) => {
    await page.click('[data-test="bridge-draw"]')
    const positions = await screenPoints(xs)
    await page.mouse.move(positions[0].x, positions[0].y)
    await page.waitForFunction(() => document.querySelector('canvas')?.style.cursor === 'crosshair')
    await page.mouse.down()
    for (const p of positions.slice(1)) await page.mouse.move(p.x, p.y, { steps: 5 })
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle()
  }
  const cameraBeforeDraw = await page.evaluate(async () => (await import('/src/commands/host.ts')).sceneOf().layerHost().camera().matrixWorld.toArray())
  await drawCrossing([-11, 11])
  await page.waitForSelector('[data-test="bridge-report"]')
  let drawnMarkers = await markers()
  check(drawnMarkers.length === 6 && drawnMarkers[2].point[0] < -2.9 && drawnMarkers[3].point[0] > 2.9 &&
    drawnMarkers.every((m) => Math.abs(m.point[2] - 0.01 * m.point[0] ** 2) < 0.003),
    'one drawn crossing creates 3+3 surface-constrained points and previews the curved bridge')
  check(JSON.stringify(cameraBeforeDraw) === JSON.stringify(await page.evaluate(async () => (await import('/src/commands/host.ts')).sceneOf().layerHost().camera().matrixWorld.toArray())),
    'drawing the crossing does not move the camera')
  await drag(drawnMarkers[1].point[0], -8)
  await page.waitForSelector('[data-test="bridge-report"]')
  drawnMarkers = await markers()
  check(Math.abs(drawnMarkers[1].point[0] + 8) < 0.02,
    'generated reference points remain draggable and refresh the preview')
  const beforeCancelledDraw = JSON.stringify(drawnMarkers)
  await drawCrossing([-10, 10], true)
  check(JSON.stringify(await markers()) === beforeCancelledDraw && await page.$('[data-test="bridge-report"]') !== null &&
    await page.$('[data-test="bridge-tool"]') !== null, 'Escape cancels drawing and preserves the previous points and preview')
  await drawCrossing([-11, -7])
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('visible gap'))
  check(JSON.stringify(await markers()) === beforeCancelledDraw, 'a stroke without a gap reports an error and keeps previous picks')
  await drawCrossing([-3.05, 11])
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('Extend the line'))
  check(JSON.stringify(await markers()) === beforeCancelledDraw, 'too little surface coverage asks for a longer crossing without guessing')
  await drawCrossing([0, 11])
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('Start and finish'))
  check(JSON.stringify(await markers()) === beforeCancelledDraw, 'starting a stroke inside the gap is rejected')
  await page.click('[data-test="bridge-draw"]')
  await page.keyboard.press('Escape')
  check(await page.$eval('[data-test="bridge-draw"]', (el) => el.getAttribute('aria-pressed')) === 'false',
    'Escape also disarms drawing before a gesture starts')
  await page.select('[data-test="bridge-first-count"]', '2')
  await page.select('[data-test="bridge-second-count"]', '8')
  await drawCrossing([11, -11])
  await page.waitForSelector('[data-test="bridge-report"]')
  drawnMarkers = await markers()
  check(drawnMarkers.length === 10 && drawnMarkers[0].point[0] > 10 && drawnMarkers[9].point[0] < -10,
    'a reversed crossing honors unequal 2+8 counts at the ten-point maximum')
  await page.click('[data-test="bridge-apply"]')
  await settle()
  const drawnInspection = await command('mesh.inspect', { holeSize: 10 })
  check((await pending()).length === 1 && drawnInspection.holes.holes === 1 && drawnInspection.bad === 0,
    'the drawn bridge applies as one edit and leaves a valid fillable hole')
  await command('history.undo')
  await page.select('[data-test="bridge-second-count"]', '3')
  await page.select('[data-test="bridge-first-count"]', '3')
  await page.click('[data-test="bridge-clear"]')
  const picks = await screenPoints([-11, -7, -3.1, 3.1, 7, 11])
  for (const p of picks) await page.mouse.click(p.x, p.y)
  await page.waitForFunction(() => document.querySelector('[data-test="bridge-instruction"]')?.textContent.includes('6/6'))
  check(await page.$eval('[data-test="bridge-apply"]', (el) => el.disabled), 'apply requires a checked preview')
  await preview()
  check((await pending()).length === 0, 'preview does not edit the scan')
  check((await markers()).map((p) => p.name).join() === Array.from({ length: 6 }, (_, i) => `Bridge point ${i + 1}`).join(),
    'all six reference points have numbered viewport markers')
  const camera = () => page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    return sceneOf().layerHost().camera().matrixWorld.toArray()
  })
  const originalCamera = await camera()
  await drag(-7, -8)
  await page.waitForSelector('[data-test="bridge-report"]')
  let adjusted = await markers()
  check(Math.abs(adjusted[1].point[0] + 8) < 0.02 && Math.abs(adjusted[1].point[2] - 0.64) < 0.002,
    'dragging moves the chosen point on the curved scan and refreshes the preview')
  check(JSON.stringify(await camera()) === JSON.stringify(originalCamera), 'dragging a marker does not move the camera')
  await drag(-8, 0)
  await page.waitForSelector('[data-test="bridge-report"]')
  adjusted = await markers()
  check(Math.abs(adjusted[1].point[0] + 8) < 0.02, 'moving off the scan does not invent a reference point')
  await startDrag(-8)
  const [cancelTo] = await screenPoints([-9])
  await page.mouse.move(cancelTo.x, cancelTo.y)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await settle()
  await page.waitForSelector('[data-test="bridge-report"]')
  adjusted = await markers()
  check(Math.abs(adjusted[1].point[0] + 8) < 0.02 && await page.$('[data-test="bridge-tool"]') !== null,
    'Escape restores the original point without closing Bridge gap')
  await drag(-11, -6)
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('order'))
  check(await page.$eval('[data-test="bridge-guidance"]', (el) => el.textContent.includes('points 1 and 2')),
    'ordering failure identifies the exact numbered guides beside the controls')
  const guidanceObjects = () => page.evaluate(async () => {
    const names = []
    ;(await import('/src/commands/host.ts')).sceneOf().layerHost().partGroup.traverse((object) => {
      if (/^Bridge (warning|guidance arrow|rim target)/.test(object.name)) names.push(object.name)
    })
    return names
  })
  check((await guidanceObjects()).join() === 'Bridge warning point 1,Bridge warning point 2',
    'ordering guidance highlights only involved points and does not invent an arrow')
  check(await page.$('[data-test="bridge-report"]') === null &&
    await page.$eval('[data-test="bridge-apply"]', (el) => el.disabled), 'invalid point ordering removes the stale preview and blocks Apply')
  await drag(-6, -11)
  await page.waitForSelector('[data-test="bridge-report"]')
  check((await guidanceObjects()).length === 0 && await page.$('[data-test="bridge-guidance"]') === null,
    'a valid adjustment clears warning rings and guidance')
  await drag(-3.1, -7.5)
  await page.waitForSelector('[data-test="bridge-guidance"]')
  check((await guidanceObjects()).includes('Bridge guidance arrow 3') &&
    (await guidanceObjects()).includes('Bridge rim target 3'),
    'a distant inner point receives a rim-target arrow and diamond')
  await drag(-7.5, -3.1)
  await page.waitForSelector('[data-test="bridge-report"]')
  await page.click('[data-test="bridge-width"]')
  await page.keyboard.down(MOD)
  await page.keyboard.press('a')
  await page.keyboard.up(MOD)
  await page.type('[data-test="bridge-width"]', '2.5')
  await page.keyboard.press('Enter')
  await settle()
  await page.waitForSelector('[data-test="bridge-report"]')
  check(await page.$eval('[data-test="bridge-width"]', (el) => Number(el.value)) === 2.5, 'width changes automatically refresh an existing preview')
  await page.screenshot({ path: shotPath('bridge-preview.png') })
  await page.select('[data-test="bridge-first-count"]', '2')
  await page.select('[data-test="bridge-second-count"]', '2')
  const four = await screenPoints([-11, -3.1, 3.1, 11])
  for (const p of four) await page.mouse.click(p.x, p.y)
  await page.waitForFunction(() => document.querySelector('[data-test="bridge-instruction"]')?.textContent.includes('4/4'))
  await preview()
  check((await markers()).length === 4 && (await pending()).length === 0, 'minimum 2+2 samples preview successfully')
  await page.select('[data-test="bridge-second-count"]', '8')
  check((await markers()).length === 0 && await page.$('[data-test="bridge-report"]') === null,
    'changing counts clears only temporary picks and the preview')
  check(await page.$eval('[data-test="bridge-first-count"]', (el) => [...el.options].map((o) => o.value).join()) === '2',
    'count selectors enforce the maximum of ten total without changing the other side')
  const ten = await screenPoints([-11, -3.1, ...Array.from({ length: 8 }, (_, i) => 3.1 + 7.9 * i / 7)])
  for (const p of ten) await page.mouse.click(p.x, p.y)
  await page.waitForFunction(() => document.querySelector('[data-test="bridge-instruction"]')?.textContent.includes('10/10'))
  await preview()
  check((await markers()).length === 10 && (await pending()).length === 0, 'unequal 2+8 samples preview successfully at the ten-point maximum')
  await page.select('[data-test="bridge-second-count"]', '3')
  const unequal = await screenPoints([-11, -3.1, 3.1, 7, 11])
  for (const p of unequal) await page.mouse.click(p.x, p.y)
  await page.waitForFunction(() => document.querySelector('[data-test="bridge-instruction"]')?.textContent.includes('5/5'))
  await preview()
  await page.click('[data-test="bridge-apply"]')
  await settle()
  check((await pending()).map((e) => e.kind).join() === 'bridge', 'unequal 2+3 real viewport picks create one undoable bridge')
  const holes = await command('mesh.inspect', { holeSize: 10 })
  check(holes.holes.holes === 1 && holes.bad === 0, 'the bridge leaves one enclosed hole and no non-manifold edges')
  check(await page.evaluate(async () => {
    const { commandHost, sceneOf } = await import('/src/commands/host.ts')
    const { meshToolsOf } = await import('/plugins/mesh-tools/core/meshClient.ts')
    const before = sceneOf().scanMesh(), triangles = []
    const signature = (mesh, skip = new Set()) => {
      const out = []
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (skip.has(t)) continue
        out.push(Array.from(mesh.indices.subarray(t * 3, t * 3 + 3), (v) => Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)).join(',')).join(';'))
      }
      return out.sort()
    }
    for (let t = 0; t < before.indices.length / 3; t += 3) triangles.push(t)
    const expected = signature(before, new Set(triangles))
    const result = await meshToolsOf(commandHost().session.clientRef.current).editScan({
      type: 'delete-triangles', triangles: Uint32Array.from(triangles),
      preview: { positions: before.positions, indices: before.indices },
    })
    return JSON.stringify(signature(result)) === JSON.stringify(expected)
  }), 'deletion maps the bridged copy exactly and preserves every unselected bridge/scan face')

  const saved = await page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const packed = await commandHost().project.save()
    if ('error' in packed) throw new Error(packed.error)
    window.bridgeTestProject = packed
    return { name: packed.name, size: packed.bytes.length }
  })
  check(saved.size > 0, 'the original scan and edited copy save as an editable project')
  await command('mesh.fill_holes', { size: 10, at: [0, 1, 0] })
  check((await pending()).map((e) => e.kind).join() === 'bridge,fill', 'Fill holes closes the newly enclosed opening')
  await command('history.undo')
  await command('history.undo')
  check((await pending()).length === 0, 'undo restores the original open bay')
  await command('history.redo')
  check((await pending()).map((e) => e.kind).join() === 'bridge', 'redo restores the stitched bridge')
  await page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const p = window.bridgeTestProject
    await commandHost().project.open(new File([p.bytes], p.name), true)
    delete window.bridgeTestProject
  })
  await settle()
  check((await pending()).map((e) => e.kind).join() === 'bridge', 'the edited bridge and its history entry survive project save/load')
  const reopened = await command('mesh.inspect', { holeSize: 10 })
  check(reopened.holes.holes === 1 && reopened.bad === 0, 'the reopened project retains a fillable hole')
  // Supply a folder permission result without opening a native dialog in CI.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0' })
    window.revisionTest = { picks: 0, files: ['bridge-test-1.scanruler', 'bridge-test-4.scanruler'], writes: [], fail: false }
    window.showDirectoryPicker = async () => {
      window.revisionTest.picks++
      const directory = {
        name: 'Mods',
        async *keys() { yield* window.revisionTest.files },
        async getFileHandle(name) {
          return {
            async createWritable() {
              return {
                async write(blob) {
                  if (window.revisionTest.fail) throw new Error('Test disk full')
                  window.revisionTest.writes.push({ name, size: blob.size })
                },
                async close() { window.revisionTest.files.push(name) },
                async abort() {},
              }
            },
          }
        },
      }
      window.showSaveFilePicker = ({ suggestedName }) => new Promise((resolve, reject) => {
        window.revisionTest.dialog = { name: suggestedName }
        window.revisionTest.answer = async (approved, name = suggestedName) => {
          window.revisionTest.dialog = null
          if (!approved) { reject(new DOMException('Cancelled', 'AbortError')); return }
          resolve({ name, ...await directory.getFileHandle(name) })
        }
      })
      return directory
    }
  })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => !!window.revisionTest.dialog)
  await page.evaluate(() => window.revisionTest.answer(false))
  await page.waitForFunction(() => !window.revisionTest.dialog)
  await settle()
  check(await page.evaluate(() => window.revisionTest.writes.length) === 0, 'cancelling filename approval creates no file')
  await approveSave('bridge-test-5.scanruler')
  await page.waitForFunction(() => document.querySelector('.strip')?.textContent.includes('bridge-test-5.scanruler'))
  await approveSave('bridge-test-6.scanruler')
  await page.waitForFunction(() => document.querySelector('.strip')?.textContent.includes('bridge-test-6.scanruler'))
  const revisions = await page.evaluate(() => window.revisionTest)
  check(revisions.picks === 1 && revisions.writes.map((w) => w.name).join() === 'bridge-test-5.scanruler,bridge-test-6.scanruler' && revisions.writes.every((w) => w.size > 0),
    'Save reuses the selected folder and increments above existing revisions')
  await waitForSaveStatus(false)
  check(await saveStatus() === 'No unsaved changes', 'a completed disk write marks the project saved')
  await approveSave('bridge-test-7.scanruler', 'bridge-test_A-9.scanruler')
  await page.waitForFunction(() => document.querySelector('.strip')?.textContent.includes('bridge-test_A-9.scanruler'))
  await approveSave('bridge-test_A-10.scanruler')
  await page.waitForFunction(() => document.querySelector('.strip')?.textContent.includes('bridge-test_A-10.scanruler'))
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => !!window.revisionTest.dialog)
  await page.evaluate(() => window.revisionTest.answer(false, 'Cancelled-99.scanruler'))
  await settle()
  await page.evaluate(() => { window.revisionTest.fail = true })
  await approveSave('bridge-test_A-11.scanruler', 'Failed-99.scanruler')
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('Test disk full'))
  await page.evaluate(() => { window.revisionTest.fail = false })
  await approveSave('bridge-test_A-11.scanruler')
  await page.waitForFunction(() => document.querySelector('.strip')?.textContent.includes('bridge-test_A-11.scanruler'))
  check(await page.evaluate(() => window.revisionTest.writes.slice(-3).map((w) => w.name).join()) ===
    'bridge-test_A-9.scanruler,bridge-test_A-10.scanruler,bridge-test_A-11.scanruler',
    'renamed Save As stems persist, while cancelled and failed renames do not replace them')
  for (let i = 0; i < 2; i++) {
    await page.click('[data-test="export-edited"]')
    await page.click('[data-test="export-edited-stl"]')
    const expected = i === 0 ? 'bridge-test-edited.stl' : 'bridge-test-edited-2.stl'
    await page.waitForFunction((name) => document.querySelector('.strip')?.textContent.includes(`Mods\\${name}`), {}, expected)
  }
  const exports = await page.evaluate(() => window.revisionTest)
  check(exports.picks === 1 && exports.writes.slice(-2).every((w) => w.size > 84) &&
    exports.writes.slice(-2).map((w) => w.name).join() === 'bridge-test-edited.stl,bridge-test-edited-2.stl',
    'edited-mesh export buttons reuse the project folder and preserve existing STL exports')
  await page.evaluate(async () => {
    window.revisionTest.fail = true
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().setProjectName('Unsaved changes')
  })
  await waitForSaveStatus(true)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => !!window.revisionTest.dialog)
  const beforeCancel = await page.evaluate(() => window.revisionTest.writes.length)
  await page.evaluate(() => window.revisionTest.answer(false))
  await settle()
  check(await saveStatus() === 'Unsaved changes' &&
    await page.evaluate(() => window.revisionTest.writes.length) === beforeCancel,
    'cancelling approval preserves dirty state and does not write a file')
  await approveSave('Unsaved changes-1.scanruler')
  await settle()
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).useStore.getState().errorText?.includes('Test disk full'))
  check(await saveStatus() === 'Unsaved changes', 'a failed disk write leaves work unsaved')
  await page.evaluate(() => { window.revisionTest.fail = false })
  await approveSave('Unsaved changes-1.scanruler')
  await settle()
  await waitForSaveStatus(false)
  check(await page.evaluate(() => window.revisionTest.picks) === 1, 'a failed write does not forget the output folder or ask again on retry')
  const editedTriangles = await page.evaluate(async () => (await import('/plugins/mesh-tools/state/meshStore.ts')).useMeshTools.getState().copyTriangles)
  await command('workspace.set', { workspace: 'measure' })
  await page.waitForSelector('[data-test="edited-analysis-notice"]')
  check((await pending()).length === 1, 'switching to Measurement never silently consumes the edited copy')
  await page.click('[data-test="measure-edited-notice"]')
  await settle()
  check(await page.$('[data-test="edited-analysis-notice"]') === null &&
    await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().triangleCount) === editedTriangles &&
    (await pending()).length === 0, 'Measurement reminder takes the repaired mesh into analysis only on request')
  const [bridgeCentre] = await screenPoints([0])
  check(await page.evaluate(async ({ x, y }) => {
    const host = (await import('/src/commands/host.ts')).sceneOf().layerHost()
    return host.pickScan(x, y) !== null
  }, bridgeCentre), 'the bridge is visible and pickable by measurement tools after adoption')
  await command('history.undo')
  await page.waitForSelector('[data-test="edited-analysis-notice"]')
  check((await pending()).length === 1, 'undo restores the original analysis scan and keeps the repair copy')
  await command('workspace.set', { workspace: 'mesh' })
  await page.click('[data-test="measure-edited"]')
  await settle()
  check(await page.evaluate(async () => (await import('/src/state/shellStore.ts')).useShell.getState().workspace) === 'elements' &&
    await page.$('[data-test="edited-analysis-notice"]') === null, 'Mesh Tools Measure edited mesh opens Measurement with the repairs in use')
  await page.screenshot({ path: shotPath('bridge-reopened.png') })
} catch (error) {
  consoleErrors.push(error.stack ?? error.message)
} finally {
  await finish(browser, consoleErrors)
}
