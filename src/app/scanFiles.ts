// SPDX-License-Identifier: AGPL-3.0-only
// A scan that comes as several files. A scanner that captures colour writes
// the OBJ, a material library (MTL) naming its image, and the image; a
// browser cannot reach the files beside one it was given, so all of them
// are picked or dropped together — or their folder dropped — and the OBJ
// carries the rest from there to the worker (see core/parsers/objTexture).
//
// The OBJ is what every open path passes on, as before; the files that came
// with it ride on it here, out of the way of the paths that have no use for
// them, and are read where the scan is prepared.

import { unzipSync } from 'fflate'
import { is3mfFile, isModelFile, isTextureFile } from '../core/formats'
import { assertImageDecodable } from '../core/flat/image'
import type { ObjCompanions, TextureImage } from '../core/parsers/objTexture'

/** What came with a model file, by the file. */
const companions = new WeakMap<File, readonly File[]>()

/** The file to open of several given together: the model among them, the
 *  texture files riding on it — or, with no model among them, the first.
 *  Null for none. */
export function bundleFiles(files: readonly File[]): File | null {
  const model = files.find((f) => isModelFile(f.name))
  if (!model) return files[0] ?? null
  const rest = files.filter((f) => f !== model && isTextureFile(f.name))
  if (rest.length > 0) companions.set(model, rest)
  return model
}

/** The texture files that came with `file`, if any. */
export function companionsOf(file: File): readonly File[] {
  return companions.get(file) ?? []
}

/** Every file a drop carries, a dropped folder's opened one level down —
 *  a scanner's export folder holds the OBJ, the MTL and the image side by
 *  side. The browser's own list where it cannot say what is a folder. */
export async function droppedFiles(data: DataTransfer | null): Promise<File[]> {
  if (!data) return []
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file')
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null)
  if (!entries.some((e) => e?.isDirectory)) return Array.from(data.files ?? [])
  const out: File[] = []
  for (const entry of entries) {
    if (!entry) continue
    if (entry.isFile) out.push(await fileOf(entry as FileSystemFileEntry))
    else if (entry.isDirectory) {
      for (const child of await childrenOf(entry as FileSystemDirectoryEntry)) {
        if (child.isFile) out.push(await fileOf(child as FileSystemFileEntry))
      }
    }
  }
  return out
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject))

/** A folder's entries — read in batches until one comes back empty. */
async function childrenOf(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

/** The files that came with a textured OBJ, kept as they came — the bytes
 *  a project saves, and the scan is read from again. */
export async function companionBytes(files: readonly File[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
}

/** The same files as the worker reads them: the libraries as text, the
 *  images decoded to RGBA. An image the browser cannot decode is left out,
 *  and the scan reads as if it had not come — its name is then reported
 *  missing by whatever named it. */
export async function readCompanions(files: readonly { name: string; bytes: Uint8Array }[]): Promise<ObjCompanions | undefined> {
  if (files.length === 0) return undefined
  const materials: ObjCompanions['materials'] = []
  const images: TextureImage[] = []
  for (const f of files) {
    if (/\.mtl$/i.test(f.name)) materials.push({ name: f.name, text: new TextDecoder().decode(f.bytes) })
    else {
      const img = await decodeImage(f.name, f.bytes).catch(() => null)
      if (img) images.push(img)
    }
  }
  return { materials, images }
}

/** What the worker reads a scan with besides its own bytes: the files that
 *  came with a textured OBJ (readCompanions), or the images a 3MF packs —
 *  decoded here, as the worker has no way to — named by their path in the
 *  package. The package's thumbnails, under Metadata/, are not the part's. */
export async function scanCompanions(name: string, bytes: Uint8Array, extras: readonly { name: string; bytes: Uint8Array }[]): Promise<ObjCompanions | undefined> {
  if (!is3mfFile(name)) return readCompanions(extras)
  let packed: Record<string, Uint8Array>
  try {
    packed = unzipSync(bytes, { filter: (f) => /\.(png|jpe?g)$/i.test(f.name) && !/^\/?metadata\//i.test(f.name) })
  } catch {
    return undefined // the worker says what is wrong with the file
  }
  const images: TextureImage[] = []
  for (const [path, data] of Object.entries(packed)) {
    const img = await decodeImage(path, data).catch(() => null)
    if (img) images.push(img)
  }
  return images.length > 0 ? { materials: [], images } : undefined
}

async function decodeImage(name: string, bytes: Uint8Array): Promise<TextureImage> {
  // Colours as the file has them: no colour management, and no
  // premultiplying, which would darken whatever the alpha channel holds.
  assertImageDecodable(name, bytes)
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  try {
    const { width, height } = bitmap
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!ctx) throw new Error('No 2D canvas to read the texture with.')
    ctx.drawImage(bitmap, 0, 0)
    return { name, width, height, rgba: ctx.getImageData(0, 0, width, height).data }
  } finally {
    bitmap.close()
  }
}
