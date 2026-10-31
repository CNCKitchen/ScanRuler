// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { inspect3MFArchive } from '../src/core/parsers/threemfArchive'
import { has3MFTextures } from '../src/core/parsers/threemfTextures'
import { parse3MF } from '../src/core/parsers/threemf'

const model = '<model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
const MODEL = '3D/3dmodel.model', TEXTURE = '3D/Textures/skin.png'
const compiled: Record<string, string> = {}
const readers = ['threemf.ts', 'threemfTextures.ts']
beforeAll(async () => {
  for (const file of readers) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`../src/core/parsers/${file}`, import.meta.url))],
      bundle: true, platform: 'browser', format: 'iife', globalName: 'archiveTestModule', write: false, logLevel: 'silent',
    })
    compiled[file] = result.outputFiles[0].text
  }
})

/** Tiny archive, malicious size declarations in both directory and local
 *  headers. Never create the declared output, even on the unfixed reader. */
function declared(sizes: Record<string, number>): Uint8Array {
  const bytes = zipSync({ [MODEL]: strToU8(model), [TEXTURE]: Uint8Array.of(137, 80, 78, 71) })
  const view = new DataView(bytes.buffer)
  let at = view.getUint32(bytes.length - 22 + 16, true)
  const members = view.getUint16(bytes.length - 22 + 10, true)
  for (let i = 0; i < members; i++) {
    const nameLength = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    if (sizes[name] !== undefined) {
      view.setUint32(at + 24, sizes[name], true)
      view.setUint32(view.getUint32(at + 42, true) + 22, sizes[name], true)
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return bytes
}

function readSafely(file: string, bytes: Uint8Array) {
  const blocked: number[] = []
  // The real bundled fflate runs here. Only its allocator is guarded: a
  // regression records the attempted allocation, without reserving gigabytes.
  const Guarded = new Proxy(Uint8Array, {
    construct(target, args) {
      if (typeof args[0] === 'number' && args[0] > 8 * 1024 * 1024) {
        blocked.push(args[0])
        throw new Error('Test allocator prevented a large allocation')
      }
      return Reflect.construct(target, args)
    },
  })
  type Reader = { parse3MF: (bytes: ArrayBuffer) => unknown; unpack3MFTextures: (bytes: Uint8Array) => unknown }
  const context: { Uint8Array: typeof Uint8Array; TextDecoder: typeof TextDecoder; TextEncoder: typeof TextEncoder; archiveTestModule?: Reader } = {
    Uint8Array: Guarded, TextDecoder, TextEncoder,
  }
  runInNewContext(compiled[file], context, { timeout: 1000 })
  let message = ''
  try {
    if (file === 'threemf.ts') context.archiveTestModule!.parse3MF(new Uint8Array(bytes).buffer)
    else context.archiveTestModule!.unpack3MFTextures(bytes)
  } catch (error) { message = (error as Error).message }
  return { blocked, message }
}

describe('3MF archive preflight before allocation', () => {
  it.each(readers)('%s refuses a giant declared member before allocating its output', (file) => {
    const result = readSafely(file, declared({ [file === 'threemf.ts' ? MODEL : TEXTURE]: 0x7fffffff }))
    expect(result.blocked).toEqual([])
    expect(result.message).toMatch(/expanded.*archive.*limit/)
  })
  it.each(readers)('%s checks the combined model and texture budget before the first expansion', (file) => {
    const result = readSafely(file, declared({ [MODEL]: 700 * 1024 * 1024, [TEXTURE]: 700 * 1024 * 1024 }))
    expect(result.blocked).toEqual([])
    expect(result.message).toMatch(/expanded.*archive.*limit/)
  })
})


describe('3MF expanded-data accounting', () => {
  it('accounts for stored payloads even when their declared original size is smaller', () => {
    const bytes = zipSync({ [MODEL]: strToU8(model) }, { level: 0 })
    const view = new DataView(bytes.buffer)
    const directory = view.getUint32(bytes.length - 22 + 16, true)
    view.setUint32(directory + 24, 1, true)
    view.setUint32(22, 1, true)
    // fflate copies the stored size, ignoring the smaller original-size field.
    expect(() => inspect3MFArchive(bytes, 8)).toThrow(/expanded.*archive.*limit/)
  })

  it('counts models and textures together but not unused sidecars or thumbnails', () => {
    const xml = strToU8(model)
    const bytes = zipSync({
      [MODEL]: xml, [TEXTURE]: Uint8Array.of(1, 2, 3, 4),
      'Metadata/thumbnail.png': new Uint8Array(4096),
      'Metadata/plate.gcode': strToU8('G1 X1 Y1 E0.01\n'.repeat(1000)),
    })
    expect(inspect3MFArchive(bytes, xml.length + 4)).toEqual({ hasTextures: true, expandedBytes: xml.length + 4 })
    expect(() => inspect3MFArchive(bytes, xml.length + 3)).toThrow(/expanded.*archive.*limit/)
  })

  it('retains support for packages with many small entries within the byte budget', () => {
    const members: Record<string, Uint8Array> = { [MODEL]: strToU8(model) }
    for (let i = 0; i < 600; i++) members[`3D/part-${i}.rels`] = strToU8('<Relationships/>')
    const bytes = zipSync(members)
    expect(inspect3MFArchive(bytes).hasTextures).toBe(false)
    expect(parse3MF(new Uint8Array(bytes).buffer).indices?.length).toBe(3)
  })

  it('rejects oversized declarations during the page-side directory check too', () => {
    for (const name of [MODEL, TEXTURE]) expect(() => has3MFTextures(declared({ [name]: 0x7fffffff }))).toThrow(/expanded.*archive.*limit/)
  })
})
