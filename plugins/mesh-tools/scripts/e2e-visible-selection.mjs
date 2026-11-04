// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canvasRect, check, drag, finish, launchApp, loadScan, MOD, OUT_DIR, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

const fixture = join(OUT_DIR, 'visible-selection-two-sheets.ply')
const irregularFixture = join(OUT_DIR, 'visible-selection-irregular.ply')
const n = 24, verticesPerSide = (n + 1) ** 2
const vertices = [], faces = []
for (let side = 0; side < 2; side++) {
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    vertices.push(`${-20 + x * 40 / n} ${-20 + y * 40 / n} ${(side ? -2 : 2) + 0.4 * Math.sin(x * 1.7) * Math.cos(y * 1.3)}`)
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = side * verticesPerSide + y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1
    faces.push(`3 ${a} ${b} ${c}`, `3 ${a} ${c} ${d}`)
  }
}
writeFileSync(irregularFixture, `ply
format ascii 1.0
element vertex ${vertices.length}
property float x
property float y
property float z
element face ${faces.length}
property list uchar int vertex_indices
end_header
${vertices.join('\n')}
${faces.map((_, i) => faces[i * 37 % faces.length]).join('\n')}
`)
writeFileSync(fixture, `ply
format ascii 1.0
element vertex 8
property float x
property float y
property float z
element face 4
property list uchar int vertex_indices
end_header
-20 -20 1
20 -20 1
20 20 1
-20 20 1
-20 -20 -1
20 -20 -1
20 20 -1
-20 20 -1
3 0 1 2
3 0 2 3
3 4 5 6
3 4 6 7
`)
const { browser, page, consoleErrors } = await launchApp({ width: 1400, height: 1000 })
const selected = () => page.evaluate(async () => {
  const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
  const { sceneOf } = await import('/src/commands/host.ts')
  const s = useDeleteSelection.getState(), mesh = sceneOf().scanMesh()
  return { count: s.count, stage: s.stage, z: Array.from(s.selection ?? []).flatMap((v, t) => v ? [mesh.positions[mesh.indices[t * 3] * 3 + 2]] : []) }
})
const orient = async (view) => {
  await page.evaluate(async (v) => {
    const { sceneOf } = await import('/src/commands/host.ts')
    sceneOf().viewFrom(v)
  }, view)
  await sleep(500)
}
const brushAt = async () => {
  const p = await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const THREE = await import('/node_modules/three/build/three.module.js')
    const host = sceneOf().layerHost()
    const p = new THREE.Vector3(10, -10, 0).applyMatrix4(host.partGroup.matrixWorld).project(host.camera())
    const r = host.canvas.getBoundingClientRect()
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 }
  })
  await drag(page, [p.x - 3, p.y], [p.x + 3, p.y], { steps: 3 })
  await sleep(250)
}
try {
  await page.click('[data-test=workspace-mesh]')
  await loadScan(page, fixture, { inputSelector: '[data-test=start-scan] input[type=file]' })
  await page.click('[data-test=mesh-tool-delete]')
  await orient('top')
  check(await page.$eval('[data-test=delete-selection-mode]', (el) => el.value === 'visible'), 'visible-only is the default')
  await page.click('[data-test=delete-select-view]')
  check(JSON.stringify((await selected()).z) === '[1,1]', 'current view selects only the front sheet, not the hidden sheet')
  await orient('bottom')
  await page.click('[data-test=delete-select-view]')
  check((await selected()).count === 4, 'Select current view in Add mode preserves the previously selected opposite sheet')
  await page.click('[data-test=delete-remove]')
  await page.click('[data-test=delete-select-view]')
  check(JSON.stringify((await selected()).z) === '[1,1]', 'Select current view in Remove mode subtracts only the visible sheet')
  await page.click('[data-test=delete-add]')
  await orient('top')
  await page.screenshot({ path: shotPath('visible-selection-top.png') })
  await page.click('[data-test=delete-invert]')
  check(JSON.stringify((await selected()).z) === '[-1,-1]', 'invert selects the hidden sheet across the entire mesh')
  await page.click('[data-test=delete-brush]')
  await page.click('[data-test=delete-remove]')
  await brushAt()
  check((await selected()).count === 2, 'Remove from top cannot erase the selected sheet hidden underneath')
  await orient('bottom')
  check((await selected()).count === 2, 'rotating preserves the selection')
  await brushAt()
  check((await selected()).count === 1, 'Remove from underneath deselects a visible back-facing triangle')
  await page.click('[data-test=delete-add]')
  await brushAt()
  check((await selected()).count === 2, 'Add restores the visible triangle without marking the hidden good sheet')
  await page.click('[data-test=delete-clear]')
  await page.click('[data-test=delete-select-view]')
  check(JSON.stringify((await selected()).z) === '[-1,-1]', 'whole current view includes back-facing triangles')
  await page.screenshot({ path: shotPath('visible-selection-underneath.png') })
  // The ID pass and worker must agree on triangle order, not just counts.
  const exact = await page.evaluate(async () => {
    const { commandHost, sceneOf } = await import('/src/commands/host.ts')
    const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
    const { meshToolsOf } = await import('/plugins/mesh-tools/core/meshClient.ts')
    const { selectedTriangles } = await import('/plugins/mesh-tools/core/triangleSelection.ts')
    const before = sceneOf().scanMesh(), mask = useDeleteSelection.getState().selection
    const expected = []
    for (let t = 0; t < mask.length; t++) if (!mask[t]) {
      for (let k = 0; k < 3; k++) expected.push(...before.positions.subarray(before.indices[t * 3 + k] * 3, before.indices[t * 3 + k] * 3 + 3))
    }
    const r = await meshToolsOf(commandHost().session.clientRef.current).editScan({
      type: 'delete-triangles', triangles: selectedTriangles(mask),
      preview: { positions: before.positions, indices: before.indices },
    })
    const actual = Array.from(r.indices).flatMap((v) => Array.from(r.positions.subarray(v * 3, v * 3 + 3)))
    return JSON.stringify(actual) === JSON.stringify(expected)
  })
  check(exact, 'worker removes exactly the previewed triangles and preserves every kept coordinate')
  await page.click('[data-test=delete-marked]')
  check((await selected()).stage === 1, 'preview does not edit the mesh')
  await page.click('[data-test=delete-keep]')
  check((await selected()).stage === 0 && !(await page.$('[data-test=pending-edit]')), 'cancel first confirmation deletes nothing')
  await page.click('[data-test=delete-marked]')
  await page.click('[data-test=delete-request]')
  check((await selected()).stage === 2 && !(await page.$('[data-test=pending-edit]')), 'first confirmation alone cannot remove triangles')
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })))
  check((await selected()).stage === 2 && !(await page.$('[data-test=pending-edit]')), 'held Enter cannot skip the separate removal confirmation')
  await page.click('[data-test=delete-keep]')
  check((await selected()).count === 2 && !(await page.$('[data-test=pending-edit]')), 'cancel second confirmation deletes nothing and keeps selection')
  await page.click('[data-test=delete-marked]')
  await page.click('[data-test=delete-request]')
  await page.click('[data-test=delete-marked-confirm]')
  await page.waitForSelector('[data-test=pending-edit]')
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'))
  check(await page.$eval('[data-test=edited-triangles] b', (el) => el.textContent.trim().startsWith('2')), 'both confirmations remove only the two selected triangles')
  check((await selected()).count === 0, 'applying clears temporary selection')
  await orient('top')
  await page.click('[data-test=delete-select-view]')
  check(JSON.stringify((await selected()).z) === '[1,1]', 'selection operates on the edited copy, not the original scan')
  check(await page.$eval('[data-test=delete-marked]', (el) => el.disabled), 'deletion refuses to remove the entire remaining mesh')
  await page.keyboard.down(MOD)
  await page.keyboard.press('KeyZ')
  await page.keyboard.up(MOD)
  await page.waitForFunction(() => !document.querySelector('[data-test=pending-edit]'))
  check(await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    return sceneOf().scanMesh().indices.length === 12
  }), 'undo restores all original triangles')
  // Window and lasso select only visible pixels as well.
  await orient('top')
  const r = await canvasRect(page, '.viewslot canvas')
  await page.click('[data-test=delete-window]')
  await drag(page, [r.x + 1, r.y + 1], [r.x + r.w - 1, r.y + r.h - 1], { steps: 4 })
  check(JSON.stringify((await selected()).z) === '[1,1]', 'window uses frontmost triangles only')
  await page.click('[data-test=delete-clear]')
  await page.click('[data-test=delete-lasso]')
  await page.mouse.move(r.x + 1, r.y + 1)
  await page.mouse.down()
  for (const p of [[r.x + r.w - 1, r.y + 1], [r.x + r.w - 1, r.y + r.h - 1], [r.x + 1, r.y + r.h - 1], [r.x + 1, r.y + 1]]) await page.mouse.move(...p, { steps: 3 })
  await page.mouse.up()
  check(JSON.stringify((await selected()).z) === '[1,1]', 'lasso uses frontmost triangles only')
  await page.click('[data-test=delete-brush]')
  await page.click('[data-test=delete-remove]')
  const before = (await selected()).count
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
  await page.mouse.down()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  check((await selected()).count === before, 'Escape cancels a stroke without changing selection')
  await page.keyboard.press('Escape')
  await page.click('[data-test=delete-add]')
  await page.click('[data-test=delete-clear]')
  await page.click('[data-test=delete-select-view]')
  // Clipped-away triangles must not hide the remaining visible sheet.
  await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const THREE = await import('/node_modules/three/build/three.module.js')
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    // A bounded test layer host, not a change to the user's viewport.
    const { DeleteSelectionScene } = await import('/plugins/mesh-tools/viewer/deleteSelection.ts')
    const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
    useDeleteSelection.getState().reset()
    const original = sceneOf().layerHost.bind(sceneOf())
    sceneOf().layerHost = () => ({ ...original(), clipPlanes: () => [plane] })
    try {
      const layer = new DeleteSelectionScene(sceneOf(), (mask) => {
        window.__clippedMask = Array.from(mask)
      }, (error) => { throw new Error(error) }, () => false)
      layer.selectView()
      layer.dispose()
    } finally {
      sceneOf().layerHost = original
    }
  })
  check(await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const mesh = sceneOf().scanMesh()
    const z = window.__clippedMask.flatMap((v, t) => v ? [mesh.positions[mesh.indices[t * 3] * 3 + 2]] : [])
    return JSON.stringify(z) === '[-1,-1]'
  }), 'clipped-away front sheet does not occlude selectable surface')
  await orient('bottom')
  const dense = await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const { DeleteSelectionScene } = await import('/plugins/mesh-tools/viewer/deleteSelection.ts')
    const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
    useDeleteSelection.getState().reset()
    const real = sceneOf(), n = 700, sideVertices = (n + 1) ** 2, trianglesPerSide = n * n * 2
    const positions = new Float32Array(sideVertices * 6), indices = new Uint32Array(n * n * 12)
    let at = 0
    for (let side = 0; side < 2; side++) {
      for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
        const v = (side * sideVertices + y * (n + 1) + x) * 3
        positions.set([-20 + x * 40 / n, -20 + y * 40 / n, side === 0 ? 1 : -1], v)
      }
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const a = side * sideVertices + y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1
        indices.set([a, b, c, a, c, d], at)
        at += 6
      }
    }
    const adapter = { layerHost: () => real.layerHost(), addLayer: (layer) => real.addLayer(layer), scanMesh: () => ({ positions, indices }) }
    let result
    const layer = new DeleteSelectionScene(adapter, (mask) => {
      result = { front: mask.subarray(0, trianglesPerSide).reduce((a, b) => a + b, 0), back: mask.subarray(trianglesPerSide).reduce((a, b) => a + b, 0) }
    }, (message) => { throw new Error(message) }, () => false)
    const start = performance.now()
    const cam = real.layerHost().camera(), originalZoom = cam.zoom
    const tests = []
    let rasterCount = 0
    try {
      for (const scale of [0.02, 1]) {
        cam.zoom = originalZoom * scale
        cam.updateProjectionMatrix()
        if (scale === 0.02) {
          real.layerHost().partGroup.updateMatrixWorld(true)
          cam.updateMatrixWorld(true)
          const image = layer.renderIds()
          const { visibleTriangles } = await import('/plugins/mesh-tools/core/triangleSelection.ts')
          rasterCount = visibleTriangles(image.pixels, image.triangles).reduce((n, v) => n + v, 0)
        }
        layer.selectView()
        tests.push({ ...result, scale })
      }
      // Exercise the same window pointer path on triangles far below pixel size.
      cam.zoom = originalZoom * 0.02
      cam.updateProjectionMatrix()
      useDeleteSelection.getState().setGesture('window')
      const canvas = real.layerHost().canvas, r = canvas.getBoundingClientRect()
      layer.enabled = true
      const capture = canvas.setPointerCapture
      canvas.setPointerCapture = () => {}
      result = { front: -1, back: -1 }
      try {
        layer.start(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: r.left + 1, clientY: r.top + 1 }))
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: r.right - 1, clientY: r.bottom - 1 }))
      } finally { canvas.setPointerCapture = capture }
      tests.push({ ...result, scale: 'window-subpixel' })
    } finally {
      cam.zoom = originalZoom
      cam.updateProjectionMatrix()
      layer.dispose()
    }
    const selectionMilliseconds = performance.now() - start
    const { deletionMask } = await import('/plugins/mesh-tools/core/deleteSelection.ts')
    const { withoutTriangles } = await import('/plugins/mesh-tools/core/pieces.ts')
    const reversed = new Uint32Array(indices.length), selectedIds = []
    for (let t = 0; t < indices.length / 3; t++) {
      const from = indices.length / 3 - 1 - t
      reversed.set(indices.subarray(from * 3, from * 3 + 3), t * 3)
      if (from < trianglesPerSide && from % 7 === 0) selectedIds.push(t)
    }
    const editStart = performance.now()
    const mask = deletionMask(positions, indices, { positions, indices: reversed }, Uint32Array.from(selectedIds))
    const kept = withoutTriangles(positions, indices, positions.length / 3, mask)
    let exact = true, corner = 0
    for (let t = 0; t < indices.length / 3; t++) {
      const remove = t < trianglesPerSide && t % 7 === 0
      if (Boolean(mask[t]) !== remove) exact = false
      if (remove) continue
      for (let k = 0; k < 3; k++) {
        const old = indices[t * 3 + k], v = kept.indices[corner++]
        for (let axis = 0; axis < 3; axis++) if (positions[old * 3 + axis] !== kept.positions[v * 3 + axis]) exact = false
      }
    }
    return { tests, rasterCount, trianglesPerSide, milliseconds: selectionMilliseconds, deletionMilliseconds: performance.now() - editStart, exact }
  })
  check(dense.rasterCount < dense.trianglesPerSide / 100, 'regression reproduces pixel-only coverage missing over 99% of the visible dense sheet')
  for (const result of dense.tests) check(result.front === 0 && result.back === dense.trianglesPerSide,
    `1,960,000-triangle overlap selects every near triangle and no rear triangle: ${result.scale}`)
  console.log(`Dense visible selection: ${Math.round(dense.milliseconds)} ms`)
  check(dense.exact, '1,960,000-triangle reordered deletion retains every unselected triangle and exact vertex coordinates')
  console.log(`Dense exact deletion mapping and compaction: ${Math.round(dense.deletionMilliseconds)} ms`)
  // Real scan loading, render BVH, preview, worker edit, PLY reload and project persistence.
  await loadScan(page, irregularFixture, { inputSelector: '[data-test=slot-scan] input[type=file]' })
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('visible-selection-irregular.ply'))
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.ts')
    return !useStore.getState().busy
  })
  if (!await page.$('[data-test=delete-selection-mode]')) await page.click('[data-test=mesh-tool-delete]')
  await page.waitForSelector('[data-test=delete-select-view]')
  await page.click('[data-test=delete-clear]')
  await page.click('[data-test=delete-add]')
  await orient('top')
  await page.click('[data-test=delete-select-view]')
  check((await selected()).count === faces.length / 2, 'irregular scan selects only the near sheet')
  const initial = await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const signature = (mesh, mask) => {
      const out = []
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (mask?.[t]) continue
        const corners = Array.from(mesh.indices.subarray(t * 3, t * 3 + 3), (v) => Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)).join(','))
        out.push(corners.map((_, k) => [...corners.slice(k), ...corners.slice(0, k)].join(';')).sort()[0])
      }
      return out.sort()
    }
    window.deletionSignature = signature
    return signature(sceneOf().scanMesh())
  })
  await page.click('[data-test=delete-remove]')
  await page.click('[data-test=delete-window]')
  const rect = await canvasRect(page, '.viewslot canvas')
  await drag(page, [rect.x + rect.w / 2, rect.y + 1], [rect.x + rect.w - 1, rect.y + rect.h - 1], { steps: 4 })
  const refined = (await selected()).count
  check(refined > 0 && refined < faces.length / 2, 'localized Remove keeps a noncontiguous triangle selection')
  const expected = await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
    return window.deletionSignature(sceneOf().scanMesh(), useDeleteSelection.getState().selection)
  })
  const confirm = async () => {
    await page.click('[data-test=delete-marked]')
    await page.click('[data-test=delete-request]')
    await page.click('[data-test=delete-marked-confirm]')
    await page.waitForSelector('[data-test=pending-edit]')
    await page.waitForFunction(() => !document.querySelector('.busyoverlay'))
    await sleep(300)
  }
  const actual = () => page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    return window.deletionSignature(sceneOf().scanMesh())
  })
  await confirm()
  check(JSON.stringify(await actual()) === JSON.stringify(expected), 'confirmed deletion preserves every unselected face on the irregular scan, not just the count')
  await page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const packed = await commandHost().project.save()
    if ('error' in packed) throw new Error(packed.error)
    window.deletionProject = packed
  })
  await page.keyboard.down(MOD)
  await page.keyboard.press('KeyZ')
  await page.keyboard.up(MOD)
  await page.waitForFunction(() => !document.querySelector('[data-test=pending-edit]'))
  check(JSON.stringify(await actual()) === JSON.stringify(initial), 'undo restores all original irregular faces')
  await page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const p = window.deletionProject
    await commandHost().project.open(new File([p.bytes], p.name), true)
    delete window.deletionProject
  })
  await page.waitForFunction(() => !document.querySelector('.busyoverlay'))
  await sleep(300)
  check(JSON.stringify(await actual()) === JSON.stringify(expected), 'saved project reload retains precisely the kept surface')
  await page.click('[data-test=delete-clear]')
  await page.click('[data-test=delete-add]')
  await orient('top')
  await page.click('[data-test=delete-select-view]')
  const secondExpected = await page.evaluate(async () => {
    const { sceneOf } = await import('/src/commands/host.ts')
    const { useDeleteSelection } = await import('/plugins/mesh-tools/state/deleteStore.ts')
    return window.deletionSignature(sceneOf().scanMesh(), useDeleteSelection.getState().selection)
  })
  await confirm()
  check(JSON.stringify(await actual()) === JSON.stringify(secondExpected), 'second deletion maps the edited copy faces exactly')
} finally {
  unlinkSync(fixture)
  unlinkSync(irregularFixture)
  await finish(browser, consoleErrors)
}
