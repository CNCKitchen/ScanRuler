// SPDX-License-Identifier: AGPL-3.0-only
// A helper kernel whose load fails once: the next request loads it again.
import { describe, expect, it } from 'vitest'
import { createHelperService } from '../core/reHelper'
import type { ReKernel } from '../core/kernel'

describe('a helper kernel', () => {
  it('tries the load again after one that failed', async () => {
    let loads = 0
    const service = createHelperService(async () => {
      if (++loads === 1) throw new Error('the network dropped')
      return {} as ReKernel
    })
    const first = await service.handle({ type: 'init', requestId: 1 })
    expect(first.response).toMatchObject({ type: 'error', message: 'the network dropped' })
    const second = await service.handle({ type: 'init', requestId: 2 })
    expect(second.response).toEqual({ type: 'init-ok', requestId: 2 })
    expect(loads).toBe(2)
  })
})
