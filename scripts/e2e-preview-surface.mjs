// SPDX-License-Identifier: AGPL-3.0-only
// Coplanar fit previews must render without alternating depth-conflict bands.
// Runs against both the original UI and the redesigned Measure workspace.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, finish, check, OUT_DIR, canvasRect } from './e2e-lib.mjs'

function inspectionBlock() {
  // units-ok: OBJ source metadata declares the generated coordinates' fixed units.
  const lines = ['# ScanRuler measurement sample: 30 x 20 x 12 mm; ideal geometry']
  const faces = [
    { origin: [0,0,0], u: [0,20,0], v: [30,0,0] },
    { origin: [0,0,12], u: [30,0,0], v: [0,20,0] },
    { origin: [0,0,0], u: [30,0,0], v: [0,0,12] },
    { origin: [0,20,0], u: [0,0,12], v: [30,0,0] },
    { origin: [0,0,0], u: [0,0,12], v: [0,20,0] },
    { origin: [30,0,0], u: [0,20,0], v: [0,0,12] },
  ]
  const cells = 16, stride = cells + 1
  faces.forEach(({origin,u,v}, face) => {
    const base = face * stride * stride + 1
    for (let y = 0; y <= cells; y++) for (let x = 0; x <= cells; x++) {
      lines.push(`v ${origin.map((a,i) => a + u[i] * x / cells + v[i] * y / cells).join(' ')}`)
    }
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      const a = base + y * stride + x
      lines.push(`f ${a} ${a+1} ${a+stride}`, `f ${a+1} ${a+stride+1} ${a+stride}`)
    }
  })
  return lines.join('\n') + '\n'
}

const file = join(OUT_DIR, 'coplanar-preview.obj')
writeFileSync(file, inspectionBlock())
const { browser, page, consoleErrors } = await launchApp({ width: 1440, height: 900 })
try {
  await page.waitForSelector('[data-test=start-scan] input[type=file]')
  await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(file)
  await page.waitForFunction(() => /3,072 triangles/.test(document.querySelector('.file-info')?.textContent ?? ''))
  await page.click('[data-test=fit-plane]')
  const r = await canvasRect(page)
  await page.mouse.click(r.x + r.w * .5, r.y + r.h * .42)
  await page.waitForFunction(() => document.querySelector('[data-test=create-element]')?.disabled === false)
  await page.screenshot({ path: join(OUT_DIR, 'coplanar-preview.png') })
  // Away from labels and handles, this ideal plane has one normal and colour.
  const strip = await page.screenshot({ clip: { x: r.x + r.w * .33, y: r.y + r.h * .45,
    width: 4, height: Math.floor(r.h * .25) }, encoding: 'base64' })
  const variation = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data
    return Math.max(...[0,1,2].map((channel) => {
      const values = []
      for (let i = channel; i < pixels.length; i += 4) values.push(pixels[i])
      return Math.max(...values) - Math.min(...values)
    }))
  }, strip)
  console.log('Coplanar preview colour range:', variation)
  writeFileSync(join(OUT_DIR, 'coplanar-preview.json'), JSON.stringify({ variation, viewport: {width:1440,height:900}, triangles:3072 }, null, 2))
  check(variation <= 3, 'coplanar plane preview has no alternating depth-conflict bands')
} finally { await finish(browser, consoleErrors) }
