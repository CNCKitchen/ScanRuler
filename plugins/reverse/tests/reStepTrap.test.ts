// SPDX-License-Identifier: AGPL-3.0-only
// A trap in the STEP document reader: the reader is an object of its own,
// which the kernel's trap watch did not see, so the trap went unrecorded and
// the file was read again, whole, on the broken kernel (issue 34).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ReKernel } from '../core/kernel'

vi.setConfig({ testTimeout: 120_000 })

let kernel: ReKernel
beforeAll(async () => {
  kernel = await ReKernel.load()
})

describe('a trap in the STEP document reader', () => {
  it('is recorded, and the file is not read again on the broken kernel', () => {
    const occt = (kernel as unknown as { occt: Record<string, unknown> }).occt
    const importStep = vi.fn()
    const realImport = occt.importStep
    const realXcaf = occt.importXCAFFromSTEP
    occt.importStep = importStep
    occt.importXCAFFromSTEP = () => ({
      getRoots: () => {
        throw new WebAssembly.RuntimeError('null function or function signature mismatch')
      },
      close: () => {},
    })
    try {
      expect(() => kernel.readStepParts('ISO-10303-21;')).toThrow()
      expect(kernel.trapped).toMatch(/signature mismatch/)
      expect(importStep).not.toHaveBeenCalled()
    } finally {
      occt.importStep = realImport
      occt.importXCAFFromSTEP = realXcaf
    }
  })
})
