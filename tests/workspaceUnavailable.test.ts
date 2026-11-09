// SPDX-License-Identifier: AGPL-3.0-only
// A workspace can say why it is unavailable (WorkspaceTab.unavailable): on a
// point cloud the tools that need triangles are off. Its tab is greyed with
// the reason, a workspace open when the cloud arrives gives way to 3D
// Measure, and a project saved in one opens in 3D Measure.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { workspaceUnavailable, watchWorkspaceAvailability } from '../src/app/workspaceAvailability'
import { CLOUD_REFUSAL } from '../src/core/capabilities'
import { installPlugins } from '../src/plugins/registry'
import { applyWorkspace } from '../src/app/project'
import { useDeviation } from '../src/state/deviationStore'
import { useShell } from '../src/state/shellStore'
import { useStore } from '../src/state/store'
import { runCommand } from '../src/commands/registry'
import { registerCommands } from '../src/commands/registry'
import { registerCoreCommands } from '../src/commands/core'
import { CommandError } from '../src/commands/types'

beforeAll(() => {
  installPlugins()
})

const setCloud = (scanIsCloud: boolean) => useStore.setState({ scanIsCloud })

afterEach(() => {
  setCloud(false)
  useShell.getState().setWorkspace('elements')
  useDeviation.setState({ split: false, picking: false })
})

describe('workspaceUnavailable', () => {
  it('is null on a mesh and the refusal on a cloud, for Mesh Tools, Reverse engineer and Wall Thickness', () => {
    expect(workspaceUnavailable('mesh')).toBeNull()
    expect(workspaceUnavailable('reverse')).toBeNull()
    expect(workspaceUnavailable('thickness')).toBeNull()
    expect(workspaceUnavailable('elements')).toBeNull()
    setCloud(true)
    expect(workspaceUnavailable('mesh')).toBe(CLOUD_REFUSAL)
    expect(workspaceUnavailable('reverse')).toBe(CLOUD_REFUSAL)
    expect(workspaceUnavailable('thickness')).toBe(CLOUD_REFUSAL)
    expect(workspaceUnavailable('elements')).toBeNull()
    expect(workspaceUnavailable('deviation')).toBeNull()
  })
})

describe('an open workspace that becomes unavailable', () => {
  it('gives way to 3D Measure when a cloud loads — plugin and built-in alike', () => {
    const stop = watchWorkspaceAvailability()
    try {
      useShell.getState().setWorkspace('mesh')
      setCloud(true)
      expect(useShell.getState().workspace).toBe('elements')
      setCloud(false)
      useShell.getState().setWorkspace('thickness')
      setCloud(true)
      expect(useShell.getState().workspace).toBe('elements')
      // Chosen while the cloud is up — by a command, say — it gives way too.
      useShell.getState().setWorkspace('mesh')
      expect(useShell.getState().workspace).toBe('elements')
      useShell.getState().setWorkspace('deviation')
      expect(useShell.getState().workspace).toBe('deviation')
    } finally {
      stop()
    }
  })

  it('closes split view and the point picker when a cloud loads', () => {
    const stop = watchWorkspaceAvailability()
    try {
      useDeviation.setState({ split: true, picking: true })
      setCloud(true)
      expect(useDeviation.getState().split).toBe(false)
      expect(useDeviation.getState().picking).toBe(false)
    } finally {
      stop()
    }
  })

  it('opens a project saved in an unavailable workspace in 3D Measure', () => {
    setCloud(true)
    applyWorkspace('mesh')
    expect(useShell.getState().workspace).toBe('elements')
    applyWorkspace('thickness')
    expect(useShell.getState().workspace).toBe('elements')
    setCloud(false)
    applyWorkspace('mesh')
    expect(useShell.getState().workspace).toBe('mesh')
  })
})

describe('commands flagged needsTriangles', () => {
  it('are refused on a cloud with the refusal, and run on a mesh', async () => {
    let ran = 0
    const off = registerCommands('probe', [
      { name: 'cut', title: 'Cut', description: 'd', input: { type: 'object', properties: {} }, needsTriangles: true, run: async () => ++ran },
    ])
    try {
      setCloud(true)
      await expect(runCommand('probe.cut', {})).rejects.toMatchObject({ message: CLOUD_REFUSAL })
      await expect(runCommand('probe.cut', {})).rejects.toBeInstanceOf(CommandError)
      expect(ran).toBe(0)
    } finally {
      off()
    }
  })
})

describe('workspace.set on a cloud', () => {
  it('refuses a workspace that is unavailable and shows one that is not', async () => {
    registerCoreCommands()
    setCloud(true)
    await expect(runCommand('workspace.set', { workspace: 'thickness' })).rejects.toMatchObject({ message: CLOUD_REFUSAL })
    await expect(runCommand('workspace.set', { workspace: 'mesh' })).rejects.toMatchObject({ message: CLOUD_REFUSAL })
    expect(useShell.getState().workspace).toBe('elements')
    await expect(runCommand('workspace.set', { workspace: 'deviation' })).resolves.toMatchObject({ workspace: 'deviation' })
    setCloud(false)
    await expect(runCommand('workspace.set', { workspace: 'mesh' })).resolves.toMatchObject({ workspace: 'mesh' })
  })
})

describe('plugin commands on a cloud', () => {
  it('refuses a mesh.* and a reverse.* command that changes things', async () => {
    setCloud(true)
    await expect(runCommand('mesh.cut', { plane: 'XY', offset: 0, keep: 'plus' })).rejects.toMatchObject({ message: CLOUD_REFUSAL })
    await expect(runCommand('reverse.feature.clear', {})).rejects.toMatchObject({ message: CLOUD_REFUSAL })
  })
})
