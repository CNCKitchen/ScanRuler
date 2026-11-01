// SPDX-License-Identifier: AGPL-3.0-only
// The platform and architecture a script runs on, narrowed from Node's wider types to the ones Electron publishes builds for, and the folder name the build outputs use.

import type { Arch, Platform } from './installer'

export function platformOf(platform: NodeJS.Platform): Platform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform
  throw new Error(`there is no desktop app for ${platform}`)
}

export function archOf(arch: NodeJS.Architecture): Arch {
  if (arch === 'x64' || arch === 'arm64') return arch
  throw new Error(`there is no desktop app for ${arch}`)
}

/** The platform, architecture and `<platform>-<arch>` name of the machine running the script. */
export function thisTarget(): { readonly platform: Platform; readonly arch: Arch; readonly name: string } {
  const platform = platformOf(process.platform)
  const arch = archOf(process.arch)
  return { platform, arch, name: `${platform}-${arch}` }
}
