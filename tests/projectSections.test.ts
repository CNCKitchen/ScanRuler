// SPDX-License-Identifier: AGPL-3.0-only
// A project opened in a build without a plugin whose part it holds: the part
// and the files it names are kept and written back, until another scan.
import { beforeEach, describe, expect, it } from 'vitest'
import { collectProject, emptySources, prepareProjectState, projectHasContent } from '../src/app/project'
import { forgetKeptParts, keepUnownedParts, keptParts, registerProjectSection } from '../src/app/projectSections'
import { scanLoaded } from '../src/app/scanEvents'
import { useStore } from '../src/state/store'
import type { ProjectManifest } from '../src/core/project/manifest'

const sources = () => ({ ...emptySources(), scan: { name: 'part.stl', bytes: new Uint8Array([1, 2, 3]) } })

function saved(extra: Record<string, unknown>): ProjectManifest {
  useStore.getState().beginLoad('part.stl')
  useStore.getState().finishLoad(10, 5, 10, [0, 0, 0])
  const { manifest } = collectProject(sources(), null, 'test')
  return JSON.parse(JSON.stringify({ ...manifest, ...extra }))
}

describe('parts of a project no plugin here owns', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true)
    forgetKeptParts()
  })

  it('are kept with the files they name, and written back', () => {
    const manifest = saved({ future: { widgets: [1, 2], member: 'future/widget.bin' } })
    const members = new Map([
      ['scan.stl', new Uint8Array([1, 2, 3])],
      ['future/widget.bin', new Uint8Array([7, 7])],
    ])
    expect(keepUnownedParts(manifest, members)).toEqual(['future'])
    // The app's own member is not kept: it is written from the session.
    expect(keptParts().members.map((m) => m.name)).toEqual(['future/widget.bin'])
    const back = collectProject(sources(), null, 'test')
    expect(back.manifest.future).toEqual({ widgets: [1, 2], member: 'future/widget.bin' })
    expect(back.members.map((m) => m.name)).toContain('future/widget.bin')
  })

  it('count as something to save, even with nothing else', () => {
    expect(projectHasContent(emptySources())).toBe(false)
    keepUnownedParts(saved({ future: { widgets: [] } }), new Map())
    expect(projectHasContent(emptySources())).toBe(true)
  })

  it('go when another scan is loaded, which they were not made on', () => {
    keepUnownedParts(saved({ future: { widgets: [] } }), new Map())
    scanLoaded({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), modelSize: 1 })
    expect(keptParts().parts).toEqual({})
  })

  it('are not kept when a section in use owns them, and the section reads its own', () => {
    const read: unknown[] = []
    const stop = registerProjectSection<{ n: number }>({
      key: 'future',
      collect: () => ({ n: 2 }),
      prepare: (value) => {
        read.push(value)
        return () => {}
      },
    })
    try {
      const manifest = saved({ future: { n: 1 } })
      expect(keepUnownedParts(manifest, new Map())).toEqual([])
      prepareProjectState(manifest)()
      expect(read).toEqual([{ n: 1 }])
      expect(collectProject(sources(), null, 'test').manifest.future).toEqual({ n: 2 })
    } finally {
      stop()
    }
  })
})
