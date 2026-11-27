// SPDX-License-Identifier: AGPL-3.0-only
// What each slot will open. The scan is what is worked on — mostly a mesh a
// scanner or a mesh tool wrote, but a CAD part opens in its place too, cut
// into triangles finely enough to be worked on as one; the reference is the
// nominal part, which legitimately comes straight out of the CAD system.
// A textured scan comes as several files picked or dropped together: the
// OBJ, its material library and the image (see app/scanFiles) — or as one
// 3MF or GLB, which pack their images and say their units.
//
// The worker keeps its own dispatch on these extensions: it is the thing that
// can actually parse them, and a file that slipped past the picker (dropped,
// or renamed) has to be refused there too.

/** Mesh formats: what a scanner or a mesh tool writes. */
const MESH_EXTENSIONS = ['stl', 'ply', 'obj', '3mf', 'glb'] as const

/** Model formats: the mesh ones plus CAD — what the scan and the reference
 *  open. */
const MODEL_EXTENSIONS = [...MESH_EXTENSIONS, 'step', 'stp'] as const

/** Flat-scan formats: what a flatbed scanner writes and a browser decodes. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const

/** What comes with a textured OBJ: its material library and the images it
 *  names, as far as a browser decodes them. */
const TEXTURE_EXTENSIONS = ['mtl', ...IMAGE_EXTENSIONS, 'bmp', 'webp'] as const

const accept = (exts: readonly string[]) => exts.map((e) => `.${e}`).join(',')

/** What the scan's picker offers: a model, and a texture's files with it. */
export const SCAN_ACCEPT = accept([...MODEL_EXTENSIONS, ...TEXTURE_EXTENSIONS])
export const REFERENCE_ACCEPT = accept(MODEL_EXTENSIONS)
export const IMAGE_ACCEPT = accept(IMAGE_EXTENSIONS)

export const SCAN_FORMATS = 'STL, PLY, OBJ, 3MF, GLB or STEP · mm' // units-ok: the unit a scan file is read in, not the display's
export const REFERENCE_FORMATS = 'STL, PLY, OBJ, 3MF, GLB or STEP'
export const IMAGE_FORMATS = 'PNG or JPEG'

export function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/** A file the scan or the reference opens: a mesh, or CAD. */
export function isModelFile(fileName: string): boolean {
  return (MODEL_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

/** A file that comes with a textured OBJ: its material library or an image. */
export function isTextureFile(fileName: string): boolean {
  return (TEXTURE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function is3mfFile(fileName: string): boolean {
  return extensionOf(fileName) === '3mf'
}

export function isGlbFile(fileName: string): boolean {
  return extensionOf(fileName) === 'glb'
}

/** A mesh file that says its own units — a 3MF names them, a GLB is in
 *  metres by definition — and is read in millimetres whatever units it is
 *  opened with. */
export function saysOwnUnits(fileName: string): boolean {
  return is3mfFile(fileName) || isGlbFile(fileName)
}

export function isStepFile(fileName: string): boolean {
  const ext = extensionOf(fileName)
  return ext === 'step' || ext === 'stp'
}

export function isReferenceFile(fileName: string): boolean {
  return isModelFile(fileName)
}

export function isImageFile(fileName: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}
