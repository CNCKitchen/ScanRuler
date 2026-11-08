// SPDX-License-Identifier: AGPL-3.0-only
// A string field of a package.json, which a build or an installer cannot go on without.

import { readFile } from 'node:fs/promises'

/** The string `name` of the package.json at `file`. Throws, naming the file, when it is missing or not a string. */
export async function packageField(file: string, name: 'version' | 'author'): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof parsed === 'object' && parsed !== null && name in parsed) {
    const value: unknown = Reflect.get(parsed, name)
    if (typeof value === 'string') return value
  }
  throw new Error(`${file} has no ${name}`)
}
