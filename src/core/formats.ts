// SPDX-License-Identifier: AGPL-3.0-only
// What each slot will open. A scan is always a mesh — no scanner emits a
// B-rep — so CAD is offered on the reference slot only, where the nominal
// part legitimately comes straight out of the CAD system.
//
// The worker keeps its own dispatch on these extensions: it is the thing that
// can actually parse them, and a file that slipped past the picker (dropped,
// or renamed) has to be refused there too.

/** Scan formats: what a scanner or a mesh tool writes. */
export const MESH_EXTENSIONS = ['stl', 'ply', 'obj'] as const

/** Reference formats: the mesh ones plus CAD. */
export const REFERENCE_EXTENSIONS = [...MESH_EXTENSIONS, 'step', 'stp'] as const

/** Flat-scan formats: what a flatbed scanner writes and a browser decodes. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const

const accept = (exts: readonly string[]) => exts.map((e) => `.${e}`).join(',')

export const MESH_ACCEPT = accept(MESH_EXTENSIONS)
export const REFERENCE_ACCEPT = accept(REFERENCE_EXTENSIONS)
export const IMAGE_ACCEPT = accept(IMAGE_EXTENSIONS)

export const MESH_FORMATS = 'STL, PLY or OBJ · mm'
export const REFERENCE_FORMATS = 'STL, PLY, OBJ or STEP'
export const IMAGE_FORMATS = 'PNG or JPEG'

export function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

export function isMeshFile(fileName: string): boolean {
  return (MESH_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function isStepFile(fileName: string): boolean {
  const ext = extensionOf(fileName)
  return ext === 'step' || ext === 'stp'
}

export function isReferenceFile(fileName: string): boolean {
  return (REFERENCE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export function isImageFile(fileName: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}
