// SPDX-License-Identifier: AGPL-3.0-only
// Point APP_URL at an owned dev server. Three runs per generated 2K/4K RGB
// texture, at 4x main-thread CPU slowdown. Workers use normal scheduling:
// compare UI blocking, not equal-CPU throughput. Files stay in e2e-out/.
import { zipSync, strToU8 } from 'fflate'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchApp } from './e2e-lib.mjs'

const output = 'e2e-out/review'
mkdirSync(output, { recursive: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const v of body) crc = crcTable[(crc ^ v) & 255] ^ (crc >>> 8)
  const head = Buffer.alloc(4), tail = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([head, body, tail])
}
/** Deterministic colour gradients with noise, not a pathological ZIP bomb. */
function png(size, level) {
  const row = size * 3 + 1, raw = Buffer.alloc(size * row)
  let seed = 1234
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const at = y * row + 1 + x * 3
    raw[at] = (x / 16 + (seed >>> 28)) & 255
    raw[at + 1] = (y / 16 + (seed >>> 28)) & 255
    raw[at + 2] = ((x + y) / 32 + (seed >>> 28)) & 255
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size); head.writeUInt32BE(size, 4)
  head[8] = 8; head[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0)),
  ])
}
const xml = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources><m:texture2d id="5" path="/3D/Textures/skin.png" contenttype="image/png"/>
  <m:texture2dgroup id="6" texid="5"><m:tex2coord u="0.25" v="0.5"/><m:tex2coord u="0.75" v="0.5"/></m:texture2dgroup>
  <object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="50" y="0" z="0"/><vertex x="0" y="50" z="0"/></vertices>
  <triangles><triangle v1="0" v2="1" v3="2" pid="6" p1="0" p2="1" p3="0"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build></model>`

const { browser, page } = await launchApp()
try {
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  for (const [size, level] of [[2048, 6], [4096, 6], [4096, 0]]) {
    const texture = png(size, level)
    const bytes = zipSync({ '3D/3dmodel.model': strToU8(xml), '3D/Textures/skin.png': texture }, { mtime: new Date('2020-01-01T00:00:00Z') })
    const path = `${output}/texture-${size}-${level}.3mf`
    writeFileSync(path, bytes)
    const results = await page.evaluate(async (path) => {
      const { scanCompanions } = await import('/src/app/scanFiles.ts')
      const bytes = new Uint8Array(await (await fetch('/' + path)).arrayBuffer())
      const runs = []
      for (let run = 0; run < 3; run++) {
        let prev = performance.now(), gap = 0
        const timer = setInterval(() => {
          const now = performance.now()
          gap = Math.max(gap, now - prev); prev = now
        }, 8)
        try {
          await new Promise((resolve) => setTimeout(resolve, 50))
          const start = performance.now()
          const promise = scanCompanions('sample.3mf', bytes, [])
          const syncMs = performance.now() - start
          const out = await promise
          const totalMs = performance.now() - start
          await new Promise((resolve) => setTimeout(resolve, 30))
          const img = out?.images[0]
          if (!img) throw new Error('Benchmark texture did not decode')
          runs.push({ syncMs, totalMs, maxTimerGapMs: gap, images: out.images.length,
            width: img.width, rgbaBytes: img.rgba.byteLength, pixel: Array.from(img.rgba.subarray(0, 4)) })
        } finally { clearInterval(timer) }
      }
      return runs
    }, path)
    console.log(JSON.stringify({ size, pngLevel: level, pngBytes: texture.length, archiveBytes: bytes.length, cpuSlowdown: 4, results }))
  }
} finally { await browser.close() }
