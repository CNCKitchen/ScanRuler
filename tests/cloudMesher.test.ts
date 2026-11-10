// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { cloudMesher, registerCloudMesher, type CloudMesher } from '../src/app/cloudMesher'

describe('cloud-mesher registry', () => {
  it('holds the last mesher registered, none before', () => {
    expect(cloudMesher()).toBeNull()
    const a: CloudMesher = { label: 'A', command: 'a.mesh', mesh: async () => true }
    const b: CloudMesher = { label: 'B', command: 'b.mesh', mesh: async () => false }
    registerCloudMesher(a)
    expect(cloudMesher()).toBe(a)
    registerCloudMesher(b)
    expect(cloudMesher()).toBe(b)
  })
})
