// SPDX-License-Identifier: AGPL-3.0-only
// Another version of the scan put in place under the session, without a
// viewport — what a workspace that edits the scan, and a step of the history
// across such an edit, do through the session (app/scanSwap.ts): the file
// becomes the session's scan, the part's size is read off the mesh as an
// open reads it, and whoever kept something read off the old vertices hears
// of it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { onScan } from '../src/app/scanEvents'
import { useStore } from '../src/state/store'
import { boxMesh } from './helpers'
import { run, startHeadless, stlBytes, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
}, 60_000)
afterAll(() => headless.stop())

describe('swapping the scan without a viewport', () => {
  it('puts the new version in place, sizes the part off it and says so', async () => {
    await run('scan.open', { bytes: stlBytes(boxMesh(20, 4)), name: 'box.stl', discard: true })
    expect(useStore.getState().triangleCount).toBe(6 * 4 * 4 * 2)
    const heard: string[] = []
    const stop = onScan({ swapped: () => heard.push('swapped'), remeasure: async () => void heard.push('remeasure') })
    try {
      const { swap, sources } = headless.session
      const source = { name: 'box.stl', bytes: stlBytes(boxMesh(10, 2)), units: 'mm' as const }
      await swap.swapScan(source, null)
      const s = useStore.getState()
      expect(s.triangleCount).toBe(6 * 2 * 2 * 2)
      expect(s.fileName).toBe('box.stl')
      // Half the box, half its size: the radius of its bounding box.
      expect(s.modelSize).toBeCloseTo(5 * Math.sqrt(3), 3)
      expect(s.modelCenter.map((x) => Math.abs(x))).toEqual([0, 0, 0])
      expect(sources.current.scan).toBe(source)
      await swap.remeasureScan(false)
      expect(heard).toEqual(['swapped', 'remeasure'])
    } finally {
      stop()
    }
  })
})
