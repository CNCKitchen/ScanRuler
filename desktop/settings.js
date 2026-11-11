// SPDX-License-Identifier: AGPL-3.0-only
// Hardware choices kept in hardware.json under userData, read before Electron
// is ready because the graphics switches must be set before then.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LANGUAGES, defaultLanguage } from './i18n.js'

/** The graphics backend ANGLE translates WebGL to: the API's name, and whether it is the default or experimental. */
export const BACKENDS = {
  d3d11: { name: 'DirectX 11', tag: 'default', angle: 'd3d11' },
  d3d12: { name: 'DirectX 12', tag: 'experimental', angle: 'd3d11on12' },
  vulkan: { name: 'Vulkan', tag: 'experimental', angle: 'vulkan' },
  gl: { name: 'OpenGL', tag: 'experimental', angle: 'gl' },
}

// The OS language picks the first language; the menu changes it.
const DEFAULTS = { backend: 'd3d11', language: defaultLanguage(Intl.DateTimeFormat().resolvedOptions().locale), crealityDir: '' }

export function loadSettings(dir) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'hardware.json'), 'utf8'))
    return {
      ...DEFAULTS,
      ...(saved.backend in BACKENDS ? { backend: saved.backend } : {}),
      ...(saved.language in LANGUAGES ? { language: saved.language } : {}),
      ...(typeof saved.crealityDir === 'string' ? { crealityDir: saved.crealityDir } : {}),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(dir, settings) {
  const file = join(dir, 'hardware.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2))
}

/** The Chromium switches for a backend: [name, value?] pairs. */
export function gpuSwitches(backend) {
  const features = ['WebGPU']
  if (backend === 'vulkan') features.push('Vulkan')
  return [
    ['use-angle', BACKENDS[backend].angle],
    ['enable-features', features.join(',')],
    ['enable-unsafe-webgpu'],
    ['ignore-gpu-blocklist'],
    ['enable-gpu-rasterization'],
    ['enable-zero-copy'],
  ]
}
