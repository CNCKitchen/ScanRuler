// SPDX-License-Identifier: AGPL-3.0-only
// Which plugins installPlugins puts in use: only the enabled ones are checked
// for a shared id, and one whose install() throws is left out of the list.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScanRulerPlugin } from '../src/plugins/api'
import { installEnabled } from '../src/plugins/registry'

const plugin = (id: string, install?: () => void) => ({ id, name: id, install }) as unknown as ScanRulerPlugin

afterEach(() => vi.unstubAllGlobals())

describe('installing plugins', () => {
  it('lets ?plugins=none open a build whose plugins share an id', () => {
    vi.stubGlobal('location', { search: '?plugins=none' })
    expect(installEnabled([plugin('twin'), plugin('twin')])).toEqual([])
  })

  it('leaves a plugin whose install throws out of the list', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = plugin('good', () => {})
    const bad = plugin('bad', () => { throw new Error('broken') })
    expect(installEnabled([good, bad])).toEqual([good])
  })
})
