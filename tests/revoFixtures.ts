// SPDX-License-Identifier: AGPL-3.0-only
// The Revo scanner project the point-cloud acceptance tests run against. It
// lives outside the repository (it is hundreds of megabytes) and is only ever
// read: SCANRULER_REVO_DIR points at the project folder, which holds its scans
// under data/<guid>/. Tests skip, loudly, where it is absent — the same way
// tests/fixtures.ts skips the real-scan STLs.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_DIR = 'C:/Users/Jozkah/AppData/Roaming/RevoMetro/Projects/Project09052026214810'

export type RevoPass = '0905_01' | '0905_02' | '0905_03' | '0905_04' | '0905_05'

/** The data folder of each pass (a fuse.ply, binary LE x y z nx ny nz). */
const GUID: Record<RevoPass, string> = {
  '0905_01': '06b8538c-0ccb-4484-818c-cd3c6ac92d25',
  '0905_02': '4cdcefdb-6e3e-4287-af8a-0abde177f147',
  '0905_03': '74488e9a-ef7a-4d7f-a4eb-9b3dd85ec8fd',
  '0905_04': '14285a11-1771-497a-bf3a-1f55e9afe003',
  '0905_05': '3bc046eb-5d53-460c-b3f1-2516df2ada9b',
}

/** Revo's own merge of the passes (Merge_02). */
const MERGE = '920a4e47-c165-45e6-80d6-2b5c7f46e81f'

export interface Revo {
  exists: boolean
  dir: string
  pass(n: RevoPass): string
  mergeCloud(): string
  mergeMesh(): string
  /** Revo's pose for the pass in its own merge: 16 numbers, row-major 4x4,
   *  translation at [3, 7, 11]; the identity for 0905_02. */
  oracle(n: RevoPass): number[]
}

export function revo(): Revo {
  const dir = process.env.SCANRULER_REVO_DIR || DEFAULT_DIR
  const exists = existsSync(join(dir, 'data', MERGE, 'property.rvproj'))
  if (!exists) {
    console.warn(
      `\n⚠ Revo project not found at "${dir}" — its point-cloud acceptance tests are SKIPPED.\n` +
        `  These run the real scanner passes through the cloud pipeline.\n` +
        `  Set SCANRULER_REVO_DIR to the project folder to run them.\n`,
    )
  }
  const file = (guid: string, name: string) => join(dir, 'data', guid, name)
  return {
    exists,
    dir,
    pass: (n) => file(GUID[n], 'fuse.ply'),
    mergeCloud: () => file(MERGE, 'model_pointcloud.ply'),
    mergeMesh: () => file(MERGE, 'model_mesh.ply'),
    oracle(n) {
      const project = JSON.parse(readFileSync(file(MERGE, 'property.rvproj'), 'utf8')) as {
        merge_depends: { node: string; pose: number[] }[]
      }
      const entry = project.merge_depends.find((d) => d.node === GUID[n])
      if (!entry || entry.pose.length !== 16) throw new Error(`property.rvproj has no pose for ${n}`)
      return entry.pose
    },
  }
}
