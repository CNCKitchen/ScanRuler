// SPDX-License-Identifier: AGPL-3.0-only
// SceneSync is drawn again only when something it reads has moved. A plugin's
// runtime is a new object on every render of the Workbench, so it is compared
// by what the scene's follower reads of it, not by identity.
import { describe, expect, it } from 'vitest'
import { sameSceneSyncProps, type SceneSyncProps } from '../src/app/SceneSync'
import type { PluginRuntime } from '../src/plugins/api'

const refs = { current: null }
const base = { sceneRef: refs, clientRef: refs, cancelDraft: () => {} } as unknown as SceneSyncProps
const withPlugin = (plugin: PluginRuntime | null): SceneSyncProps => ({ ...base, plugin })

describe('SceneSync props', () => {
  it('are the same for a plugin runtime built again with the same reads', () => {
    const make = (): PluginRuntime => ({ marking: { color: '#f00', gestures: true }, hideScan: false, fieldVersion: 'a:1' })
    expect(sameSceneSyncProps(withPlugin(make()), withPlugin(make()))).toBe(true)
  })

  it('differ when what is read of the plugin moves', () => {
    const a = withPlugin({ marking: { color: '#f00', gestures: true }, fieldVersion: 'a:1' })
    expect(sameSceneSyncProps(a, withPlugin({ marking: { color: '#0f0', gestures: true }, fieldVersion: 'a:1' }))).toBe(false)
    expect(sameSceneSyncProps(a, withPlugin({ marking: { color: '#f00', gestures: true }, fieldVersion: 'a:2' }))).toBe(false)
    expect(sameSceneSyncProps(a, withPlugin(null))).toBe(false)
  })

  it('differ always for a plugin with a map and no version of it', () => {
    const field = { values: new Float32Array(3), rgb: { current: null }, scale: {} } as unknown as PluginRuntime['field']
    expect(sameSceneSyncProps(withPlugin({ field }), withPlugin({ field }))).toBe(false)
  })

  it('differ when any other prop is another object', () => {
    expect(sameSceneSyncProps(withPlugin(null), { ...withPlugin(null), cancelDraft: () => {} })).toBe(false)
  })
})
