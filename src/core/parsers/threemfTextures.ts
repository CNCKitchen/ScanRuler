// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync } from 'fflate'

const isTexture = (name: string) => /\.(png|jpe?g)$/i.test(name) && !/^\/?metadata\//i.test(name)

/** Inspect the directory without expanding entries. Untextured 3MF files
 *  need no extra worker; the mesh parser reports an invalid package. */
export function has3MFTextures(bytes: Uint8Array): boolean {
  let found = false
  try {
    unzipSync(bytes, { filter: ({ name }) => { found ||= isTexture(name); return false } })
  } catch { return false }
  return found
}

/** Run in a worker: even fflate's async unzip inflates barely compressed
 *  entries synchronously, which includes many already-compressed images. */
export function unpack3MFTextures(bytes: Uint8Array): Record<string, Uint8Array> | null {
  try { return unzipSync(bytes, { filter: ({ name }) => isTexture(name) }) }
  catch { return null } // the mesh parser reports the damaged package
}
