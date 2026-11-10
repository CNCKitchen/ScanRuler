// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest'
import { exportExtension, meshCopyExportName, runExport, saveBuilt, scanExportName } from '../src/app/exports'
import { chooseSaveTarget, type SavePickerOptions } from '../src/app/saveTarget'
import { useStore } from '../src/state/store'
import { useTaskActivity } from '../src/state/taskActivity'
import { useDeviation } from '../src/state/deviationStore'

const initial = useStore.getState()
const initialDeviation = useDeviation.getState()
afterEach(() => {
  vi.unstubAllGlobals()
  useStore.setState(initial, true)
  useDeviation.setState(initialDeviation, true)
})

it('keeps inch STL filenames as .stl across scan, mesh copy and CAD suggestions', () => {
  useStore.setState({ projectName: 'Sample', appliedAlignment: null })
  useDeviation.setState({ align: null })
  expect(exportExtension('stl-in')).toBe('stl')
  expect(scanExportName('stl-in')).toBe('Sample-export.stl')
  expect(meshCopyExportName('edited', 'stl-in')).toBe('Sample-edited.stl')
  expect(meshCopyExportName('reduced', '3mf')).toBe('Sample-reduced.3mf')
})

const setup = () => {
  const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
  const picker = vi.fn(async (_options: SavePickerOptions) => ({ name: 'Chosen filename', createWritable: async () => stream }))
  vi.stubGlobal('window', { showSaveFilePicker: picker })
  return { stream, picker }
}

it.each(['step', 'stp', 'stl', '3mf', 'ply', 'xyz', 'csv', 'svg', 'dxf'])(
  'selects the %s export target before generation, without forcing a start directory', async (extension) => {
    const { picker, stream } = setup()
    const name = `Sample.${extension}`
    await runExport(name, async (target) => {
      expect(picker).toHaveBeenCalledOnce()
      expect(target?.name).toBe('Chosen filename')
      await saveBuilt({ name, bytes: new Uint8Array([1, 2]), mimeType: 'application/octet-stream', status: `Exported ${name}.` }, target)
    })
    expect(picker).toHaveBeenCalledWith({
      id: 'scanruler-exports', suggestedName: name,
      types: [{ description: `${extension.toUpperCase()} file`, accept: { 'application/octet-stream': [`.${extension}`] } }],
    })
    expect(stream.write).toHaveBeenCalledOnce()
    expect(stream.close).toHaveBeenCalledOnce()
    expect(useStore.getState().statusText).toBe('Exported Chosen filename. Saved as Chosen filename.')
  },
)

it('uses independent, stable project and export picker IDs with normal filenames', async () => {
  const { picker } = setup()
  await chooseSaveTarget('project', 'Part.scanruler')
  await chooseSaveTarget('export', 'Part.step')
  await chooseSaveTarget('project', 'Other.scanruler')
  expect(picker.mock.calls.map(([options]) => options.id)).toEqual(['scanruler-projects', 'scanruler-exports', 'scanruler-projects'])
  expect(picker.mock.calls[0][0].suggestedName).toBe('Part.scanruler')
  expect(picker.mock.calls.every(([options]) => !('startIn' in options))).toBe(true)
})

it('returns a download target only when the picker is unsupported', async () => {
  vi.stubGlobal('window', {})
  expect(await chooseSaveTarget('project', 'Part.scanruler')).toBeNull()
  expect(await chooseSaveTarget('export', 'Part.stl')).toBeNull()
})

it.each([
  new DOMException('Cancelled', 'AbortError'),
  new DOMException('Not allowed', 'NotAllowedError'),
])('does not build or silently download after picker rejection: %s', async (error) => {
  const { picker } = setup()
  picker.mockRejectedValueOnce(error)
  const build = vi.fn()
  await runExport('Part.step', build)
  expect(build).not.toHaveBeenCalled()
  if (error.name === 'AbortError') expect(useStore.getState().statusText).toContain('Export cancelled')
  else expect(useStore.getState().errorText).toContain('Not allowed')
  expect(useTaskActivity.getState().tasks).toEqual({})
})

it('waits for the write to close before reporting export success', async () => {
  const { stream } = setup()
  let finish!: () => void
  stream.close.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const pending = runExport('Part.step', async (target) =>
    saveBuilt({ name: 'Part.step', bytes: new Uint8Array([1]), mimeType: 'model/step', status: 'Export complete.' }, target))
  await vi.waitFor(() => expect(stream.close).toHaveBeenCalled())
  expect(useStore.getState().statusText).toBe('')
  finish()
  await pending
  expect(useStore.getState().statusText).toContain('Export complete.')
})

it('reports a manually selected filename literally, including dollar signs', async () => {
  const { picker, stream } = setup()
  picker.mockResolvedValueOnce({ name: 'Part-$&.step', createWritable: async () => stream })
  await runExport('Part.step', async (target) =>
    saveBuilt({ name: 'Part.step', bytes: new Uint8Array([1]), mimeType: 'model/step', status: 'Exported Part.step.' }, target))
  expect(useStore.getState().statusText).toBe('Exported Part-$&.step. Saved as Part-$&.step.')
})

it('aborts failed writes and reports failure instead of success', async () => {
  const { stream } = setup()
  stream.write.mockRejectedValueOnce(new Error('Disk full'))
  await runExport('Part.step', async (target) =>
    saveBuilt({ name: 'Part.step', bytes: new Uint8Array([1]), mimeType: 'model/step', status: 'Export complete.' }, target))
  expect(stream.abort).toHaveBeenCalledOnce()
  expect(stream.close).not.toHaveBeenCalled()
  expect(useStore.getState().errorText).toContain('Disk full')
  expect(useStore.getState().statusText).toBe('')
})

it('does not share targets between overlapping exports', async () => {
  const { picker } = setup()
  const firstWrite = vi.fn(), secondWrite = vi.fn()
  picker.mockResolvedValueOnce({ name: 'first.step', createWritable: async () => ({ write: firstWrite, close: vi.fn(), abort: vi.fn() }) })
    .mockResolvedValueOnce({ name: 'second.stl', createWritable: async () => ({ write: secondWrite, close: vi.fn(), abort: vi.fn() }) })
  let resume!: () => void
  const wait = new Promise<void>((resolve) => { resume = resolve })
  const firstBlob = new Blob(['first']), secondBlob = new Blob(['second'])
  const first = runExport('Part.step', async (target) => { await wait; await target!.write(firstBlob) })
  await runExport('Part.stl', async (target) => { await target!.write(secondBlob) })
  resume()
  await first
  expect(firstWrite).toHaveBeenCalledWith(firstBlob)
  expect(secondWrite).toHaveBeenCalledWith(secondBlob)
})
