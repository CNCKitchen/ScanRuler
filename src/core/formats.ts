// SPDX-License-Identifier: AGPL-3.0-only
// What each slot will open. The scan is what is worked on — mostly a mesh a
// scanner or a mesh tool wrote, but a CAD part opens in its place too, cut
// into triangles finely enough to be worked on as one; the reference is the
// nominal part, which legitimately comes straight out of the CAD system.
// A textured scan comes as several files picked or dropped together: the
// OBJ, its material library and the image (see app/scanFiles) — or as one
// 3MF, which packs its images and says its units.
//
// The worker keeps its own dispatch on these extensions: it is the thing that
// can actually parse them, and a file that slipped past the picker (dropped,
// or renamed) has to be refused there too.

/** Mesh formats: what a scanner or a mesh tool writes. */
const MESH_EXTENSIONS = ['stl', 'ply', 'obj', '3mf'] as const

/** Model formats: the mesh ones plus CAD — what the scan and the reference
 *  open. */
const MODEL_EXTENSIONS = [...MESH_EXTENSIONS, 'step', 'stp'] as const

/** Point-cloud text formats: a scan only — a cloud cannot be the reference. */
const CLOUD_EXTENSIONS = ['xyz', 'asc', 'pts'] as const

/** What the scan opens: a model, or a point cloud. */
const SCAN_EXTENSIONS = [...MODEL_EXTENSIONS, ...CLOUD_EXTENSIONS] as const

/** Flat-scan formats: what a flatbed scanner writes and a browser decodes. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const

/** What comes with a textured OBJ: its material library and the images it
 *  names, as far as a browser decodes them. */
const TEXTURE_EXTENSIONS = ['mtl', ...IMAGE_EXTENSIONS, 'bmp', 'webp'] as const

const accept = (exts: readonly string[]) => exts.map((e) => `.${e}`).join(',')

/** What the scan's picker offers: a model, and a texture's files with it. */
export const SCAN_ACCEPT = accept([...SCAN_EXTENSIONS, ...TEXTURE_EXTENSIONS])
export const REFERENCE_ACCEPT = accept(MODEL_EXTENSIONS)
export const IMAGE_ACCEPT = accept(IMAGE_EXTENSIONS)

export const SCAN_FORMATS = 'STL, PLY, OBJ, 3MF, STEP or XYZ/ASC/PTS · mm' // units-ok: the unit a scan file is read in, not the display's
export const REFERENCE_FORMATS = 'STL, PLY, OBJ, 3MF or STEP'
export const IMAGE_FORMATS = 'PNG or JPEG'

/** Why a point cloud is refused as the reference, wherever it is caught. */
export const REFERENCE_CLOUD_REFUSAL = 'A point cloud cannot be the reference yet — open a mesh or CAD file.'

/** A second spelling of a format, not named again where the formats are listed. */
const ALIASES: readonly string[] = ['stp', 'jpg']

/** Every format the app opens on its own — a scan, a reference, a flat scan
 *  — named once each, from the lists above: "STL, PLY, … PNG or JPEG". */
export const OPENABLE_FORMATS = (() => {
  const names = [...SCAN_EXTENSIONS, ...IMAGE_EXTENSIONS].filter((e) => !ALIASES.includes(e)).map((e) => e.toUpperCase())
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
})()

export function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/** A file the scan opens: a mesh, CAD, or a point cloud. */
export function isModelFile(fileName: string): boolean {
  return (SCAN_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

/** A file that comes with a textured OBJ: its material library or an image. */
export function isTextureFile(fileName: string): boolean {
  return (TEXTURE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function is3mfFile(fileName: string): boolean {
  return extensionOf(fileName) === '3mf'
}

export function isStepFile(fileName: string): boolean {
  const ext = extensionOf(fileName)
  return ext === 'step' || ext === 'stp'
}

/** A point-cloud text file: XYZ, ASC or PTS. */
export function isCloudTextFile(fileName: string): boolean {
  return (CLOUD_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function isReferenceFile(fileName: string): boolean {
  return (MODEL_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function isImageFile(fileName: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}
