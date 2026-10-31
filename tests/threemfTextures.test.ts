// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { has3MFTextures, unpack3MFTextures } from '../src/core/parsers/threemfTextures'

describe('3MF texture archive', () => {
  it('extracts only texture images, preserving names, bytes and the input archive', () => {
    const entries = {
      '3D/Textures/a.PNG': Uint8Array.of(1, 2, 3),
      '/3d/textures/b.JpEg': Uint8Array.of(4, 5, 6),
      'Metadata/thumbnail.png': Uint8Array.of(7),
      '/METADATA/large.jpg': Uint8Array.of(8),
      '3D/3dmodel.model': strToU8('<model/>'),
    }
    for (const level of [0, 6] as const) {
      const bytes = zipSync(entries, { level })
      const before = bytes.slice()
      expect(has3MFTextures(bytes)).toBe(true)
      expect(unpack3MFTextures(bytes)).toEqual({
        '3D/Textures/a.PNG': entries['3D/Textures/a.PNG'],
        '/3d/textures/b.JpEg': entries['/3d/textures/b.JpEg'],
      })
      expect(bytes).toEqual(before)
    }
  })
  it('does not start texture work for plain models or metadata thumbnails', () => {
    const bytes = zipSync({ '3D/3dmodel.model': strToU8('<model/>'), 'Metadata/thumbnail.png': Uint8Array.of(1) })
    expect(has3MFTextures(bytes)).toBe(false)
    expect(unpack3MFTextures(bytes)).toEqual({})
  })
  it('leaves a damaged archive for the model parser to explain', () => {
    const bytes = Uint8Array.of(1, 2, 3)
    expect(has3MFTextures(bytes)).toBe(false)
    expect(unpack3MFTextures(bytes)).toBeNull()
  })
})
