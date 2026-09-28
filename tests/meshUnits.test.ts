// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { meshUnitsOf, mmPerUnit, unitsLabel } from '../src/core/meshUnits'
import { usePrefs } from '../src/state/prefsStore'
import { askMeshUnits, meshUnitsFor, useUnitsPrompt } from '../src/state/unitsPromptStore'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('mesh units', () => {
  it('know their millimetres and refuse anything else', () => {
    expect(mmPerUnit('mm')).toBe(1)
    expect(mmPerUnit('cm')).toBe(10)
    expect(mmPerUnit('m')).toBe(1000)
    expect(mmPerUnit('in')).toBe(25.4)
    expect(meshUnitsOf('in')).toBe('in')
    expect(meshUnitsOf('inch')).toBeNull()
    expect(meshUnitsOf(25.4)).toBeNull()
    expect(meshUnitsOf(null)).toBeNull()
    expect(unitsLabel('in')).toBe('Inches')
  })
})

describe('the units question', () => {
  beforeEach(() => {
    usePrefs.getState().setAskStlUnits(true)
    usePrefs.getState().setStlUnits('mm')
    useUnitsPrompt.setState({ request: null })
  })

  it('is only asked of an STL, and only while the preference says to', async () => {
    await expect(meshUnitsFor('scan.ply')).resolves.toBe('mm')
    await expect(meshUnitsFor('scan.obj')).resolves.toBe('mm')
    expect(useUnitsPrompt.getState().request).toBeNull()
    usePrefs.getState().setAskStlUnits(false)
    usePrefs.getState().setStlUnits('in')
    await expect(meshUnitsFor('scan.stl')).resolves.toBe('in')
    expect(useUnitsPrompt.getState().request).toBeNull()
  })

  it('resolves with the answer, remembers it, and with "Don\'t ask again" stops asking', async () => {
    const asked = meshUnitsFor('Part.STL')
    await tick()
    expect(useUnitsPrompt.getState().request).toEqual({ fileName: 'Part.STL' })
    useUnitsPrompt.getState().answer('cm', false)
    await expect(asked).resolves.toBe('cm')
    expect(useUnitsPrompt.getState().request).toBeNull()
    expect(usePrefs.getState().stlUnits).toBe('cm')
    expect(usePrefs.getState().askStlUnits).toBe(true)

    const again = meshUnitsFor('other.stl')
    await tick()
    useUnitsPrompt.getState().answer('in', true)
    await expect(again).resolves.toBe('in')
    expect(usePrefs.getState().askStlUnits).toBe(false)
    await expect(meshUnitsFor('third.stl')).resolves.toBe('in')
  })

  it('resolves null when dismissed, and asks about one file at a time', async () => {
    const first = askMeshUnits('a.stl')
    const second = askMeshUnits('b.stl')
    await tick()
    expect(useUnitsPrompt.getState().request?.fileName).toBe('a.stl')
    useUnitsPrompt.getState().cancel()
    await expect(first).resolves.toBeNull()
    await tick()
    expect(useUnitsPrompt.getState().request?.fileName).toBe('b.stl')
    useUnitsPrompt.getState().answer('m', false)
    await expect(second).resolves.toBe('m')
    expect(useUnitsPrompt.getState().request).toBeNull()
  })
})
