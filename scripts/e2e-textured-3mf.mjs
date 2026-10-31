// SPDX-License-Identifier: AGPL-3.0-only
// Real worker extraction, colour import/save/reopen, and transactional recovery
// when a texture worker fails. Timings live in the review benchmark, not CI.
import { zipSync, strToU8, unzipSync } from 'fflate'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitDownload, check, click, downloadsTo, fail, finish, launchApp } from './e2e-lib.mjs'

const dir = mkdtempSync(join(tmpdir(), 'scanruler-3mf-'))
const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
try {
  await downloadsTo(page, dir)
  const png = Uint8Array.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 })
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgb(230,30,20)'; ctx.fillRect(0, 0, 32, 64)
    ctx.fillStyle = 'rgb(20,30,230)'; ctx.fillRect(32, 0, 32, 64)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }))
  const xml = '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources><m:texture2d id="5" path="/3D/Textures/skin.png" contenttype="image/png"/><m:texture2dgroup id="6" texid="5"><m:tex2coord u="0.25" v="0.5"/><m:tex2coord u="0.75" v="0.5"/></m:texture2dgroup><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="50" y="0" z="0"/><vertex x="0" y="50" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" pid="6" p1="0" p2="1" p3="0"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
  const bytes = zipSync({ '3D/3dmodel.model': strToU8(xml), '3D/Textures/skin.png': png, 'Metadata/thumbnail.png': png })
  const file = join(dir, 'textured.3mf'); writeFileSync(file, bytes)
  // Observe lifecycle without replacing the worker's computation or messages.
  await page.evaluate(() => {
    const Original = window.Worker
    window.__textureWorkers = { started: 0, stopped: 0, failNext: false }
    window.Worker = class extends Original {
      constructor(url, options) {
        super(url, options)
        this.texture = String(url).includes('textureWorker')
        if (this.texture) {
          window.__textureWorkers.started++
          if (window.__textureWorkers.failNext) {
            window.__textureWorkers.failNext = false
            queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'test texture worker failure', cancelable: true })))
          }
        }
      }
      terminate() { if (this.texture) window.__textureWorkers.stopped++; return super.terminate() }
    }
  })
  const companionProof = await page.evaluate(async (data) => {
    const { scanCompanions } = await import('/src/app/scanFiles.ts')
    const { parse3MF } = await import('/src/core/parsers/threemf.ts')
    const bytes = Uint8Array.from(data)
    const decoded = await scanCompanions('texture.3mf', bytes, [])
    const mesh = parse3MF(bytes.buffer, undefined, decoded)
    return { imageNames: decoded.images.map((x) => x.name), colors: Array.from(mesh.colors), unchanged: data.every((v, i) => v === bytes[i]), workers: { ...window.__textureWorkers } }
  }, Array.from(bytes))
  check(JSON.stringify(companionProof.imageNames) === '["3D/Textures/skin.png"]', 'metadata thumbnails stay out of texture decoding')
  check(JSON.stringify(companionProof.colors) === '[230,30,20,20,30,230,230,30,20]', 'texture worker preserves exact red and blue vertex colours')
  check(companionProof.unchanged, 'the source archive remains byte-for-byte intact after extraction')
  check(companionProof.workers.started === 1 && companionProof.workers.stopped === 1, 'extraction runs in a worker and releases it afterward')
  const open = async (path) => {
    const input = await page.$('[data-test=slot-scan] input[type=file], [data-test=start-scan] input[type=file]')
    await input.uploadFile(path)
  }
  await open(file)
  await page.waitForFunction(() => /Coloured from skin.png/.test(document.querySelector('.strip .msg')?.textContent ?? ''))
  const viewState = () => page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const geometry = commandHost().session.sceneRef.current.scanGeometry()
    return { positions: Array.from(geometry.getAttribute('position').array), colors: Array.from(geometry.getAttribute('color').array) }
  })
  const original = await viewState()
  check(original.colors.length === 9 && original.positions.length === 9, 'the live scene receives the textured triangle')
  await click(page, '[data-test=save-project]')
  const saved = await awaitDownload(dir, '.scanruler')
  check(!!saved, 'the textured 3MF saves as a project')
  const archive = unzipSync(readFileSync(join(dir, saved)))
  const manifest = JSON.parse(new TextDecoder().decode(archive['project.json']))
  check(Buffer.from(archive[manifest.scan.member]).equals(Buffer.from(bytes)), 'the saved project contains the unchanged original 3MF')
  await page.reload({ waitUntil: 'networkidle0' })
  await (await page.$('[data-test=project-input]')).uploadFile(join(dir, saved))
  await page.waitForFunction(() => /Project opened/.test(document.querySelector('.strip')?.textContent ?? ''))
  check(JSON.stringify(await viewState()) === JSON.stringify(original), 'reopening restores exactly the same scene positions and colours')
  // Install the failure only after the real reload/reopen path has passed.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().startDraft('plane'); useStore.getState().setDraftPicks([[1, 2, 3]])
    window.__textureDraft = useStore.getState().draft
    const Original = window.Worker
    window.Worker = class extends Original {
      constructor(url, options) {
        super(url, options)
        if (String(url).includes('textureWorker')) queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { message: 'test texture worker failure', cancelable: true })))
      }
    }
  })
  const failed = join(dir, 'failed.3mf'); writeFileSync(failed, bytes)
  await open(failed)
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.ts')
    return !useStore.getState().busy && useStore.getState().errorText?.includes('test texture worker failure')
  })
  check(JSON.stringify(await viewState()) === JSON.stringify(original), 'a failed texture worker leaves the current scene unchanged')
  check(await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { commandHost } = await import('/src/commands/host.ts')
    return useStore.getState().draft === window.__textureDraft && commandHost().session.sources.current.scan.name === 'textured.3mf'
  }), 'a failed texture import preserves the picked draft and source file')
} catch (error) { fail(error.stack ?? String(error)) }
finally { rmSync(dir, { recursive: true, force: true }); await finish(browser, consoleErrors) }
