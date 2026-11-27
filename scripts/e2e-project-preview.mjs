// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync, strFromU8 } from 'fflate'
import { writeFileSync } from 'node:fs'
import { launchApp, check, fail, finish, shotPath } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
try {
  const mesh = [
    'v -30 -4 -2', 'v 30 -4 -2', 'v 30 4 -2', 'v -30 4 -2',
    'v -30 -4 2', 'v 30 -4 2', 'v 30 4 2', 'v -30 4 2',
    'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8',
    'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6',
    'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
  ].join('\n')
  await page.evaluate((contents) => {
    const data = new DataTransfer()
    data.items.add(new File([contents], 'preview-box.obj'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    const createURL = URL.createObjectURL
    URL.createObjectURL = (blob) => { window.savedProject = blob; return createURL(blob) }
    HTMLAnchorElement.prototype.click = function () {}
  }, mesh)
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('12 triangles'))
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.savedProject instanceof Blob)
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.savedProject.arrayBuffer())))
  const files = unzipSync(Uint8Array.from(bytes))
  writeFileSync(shotPath('project-preview.scanruler'), Uint8Array.from(bytes))
  writeFileSync(shotPath('project-preview.png'), files['preview.png'])
  const manifest = JSON.parse(strFromU8(files['project.json']))
  check(strFromU8(files[manifest.scan.member]) === mesh, 'saving a preview retains original model bytes')
  check(files['preview.png']?.[0] === 137, 'Save Project embeds a PNG preview')

  const image = await page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4
      if (Math.abs(pixels[i] - pixels[0]) + Math.abs(pixels[i + 1] - pixels[1]) + Math.abs(pixels[i + 2] - pixels[2]) > 50) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
    bitmap.close()
    return { width: canvas.width, height: canvas.height, minX, minY, maxX, maxY }
  }, Array.from(files['preview.png']))
  console.log('Preview pixel bounds:', JSON.stringify(image))
  check(image.width === 1024 && image.height === 1024, 'preview has the required 1024-square resolution')
  check(image.maxX > image.minX && image.maxY > image.minY, 'preview contains actual model pixels')
  check(image.minX > 10 && image.minY > 10 && image.maxX < 1014 && image.maxY < 1014, 'the entire model fits with a border')
  check(Math.max(image.maxX - image.minX, image.maxY - image.minY) > 920, 'model fills over 90% of at least one image dimension')
  await page.screenshot({ path: shotPath('project-preview-save.png') })

  // Measure the real viewport camera before/after offscreen capture, independent
  // of screenshots whose contents can legitimately change during rendering.
  const probe = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js')
    const { OrthoViewport } = await import('/src/viewer/orthoViewport.ts')
    const { captureProjectPreview, visiblePreviewBounds } = await import('/src/viewer/projectPreview.ts')
    const { DEFAULT_THEME } = await import('/src/viewer/viewThemes.ts')
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px'
    document.body.append(container)
    const viewport = new OrthoViewport(container, { theme: DEFAULT_THEME, navTargets: () => [], onClick: () => {} })
    const geometry = new THREE.BoxGeometry(40, 4, 2)
    const material = new THREE.MeshBasicMaterial({ color: '#ff0033' })
    const part = new THREE.Mesh(geometry, material)
    viewport.scene.add(part)
    viewport.fitCamera(new THREE.Box3().setFromObject(part))
    viewport.camera.zoom = 20
    viewport.camera.position.add(new THREE.Vector3(50, -20, 0))
    viewport.camera.updateProjectionMatrix()
    viewport.controls.update()
    viewport.camera.updateMatrixWorld(true)
    viewport.paused = true
    const before = JSON.stringify({ camera: viewport.camera.toJSON(), target: viewport.controls.target.toArray(), size: viewport.renderer.getSize(new THREE.Vector2()).toArray() })
    try {
      const png = await captureProjectPreview(viewport, visiblePreviewBounds([part]))
      const after = JSON.stringify({ camera: viewport.camera.toJSON(), target: viewport.controls.target.toArray(), size: viewport.renderer.getSize(new THREE.Vector2()).toArray() })
      part.visible = false
      const empty = await captureProjectPreview(viewport, visiblePreviewBounds([part]))
      return { unchanged: before === after, png: png.length, empty: empty.length, hidden: !part.visible }
    } finally {
      viewport.dispose(); geometry.dispose(); material.dispose(); container.remove()
    }
  })
  check(probe.unchanged, 'capturing a tightly fitted preview preserves live zoom, pan, camera and canvas size')
  check(probe.png > 100 && probe.empty > 100 && probe.hidden, 'all-hidden content produces an explicit placeholder without unhiding anything')

  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 600; canvas.height = 200
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 600, 200)
    context.fillStyle = '#ff0000'; context.fillRect(20, 20, 560, 160)
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([png], 'preview-sheet.png', { type: 'image/png' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    window.savedProject = null
  })
  await page.waitForFunction(() => document.querySelector('[data-test="workspace-flat"]')?.getAttribute('aria-selected') === 'true')
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.savedProject instanceof Blob)
  const sheetBytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.savedProject.arrayBuffer())))
  const sheetArchive = unzipSync(Uint8Array.from(sheetBytes))
  check(sheetArchive['preview.png']?.length > 100, '2D Measure saves an image preview too')
  const sheetPixels = await page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const p = context.getImageData(512, 512, 1, 1).data
    bitmap.close()
    return Array.from(p)
  }, Array.from(sheetArchive['preview.png']))
  check(sheetPixels[0] > 200 && sheetPixels[1] < 80 && sheetPixels[2] < 80, 'the saved 2D preview depicts the sheet rather than the hidden 3D scan')
} catch (error) {
  fail(error.stack ?? String(error))
} finally {
  await finish(browser, consoleErrors)
}
