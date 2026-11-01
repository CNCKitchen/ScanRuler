// SPDX-License-Identifier: AGPL-3.0-only
// A file named in the page's address, to be opened as if it had been dropped:
// `?open=<url>` fetches any file a server lets this site read, and `/s/<name>`
// is the short form for a file in the deployment's own store — the base URL
// the build was given as VITE_FILES_URL, the name under it, `.scanruler`
// appended unless the name ends in a format the app opens. `workspace=<name>`
// says which workspace to land in, by the names the command layer uses,
// after the file is open — or on its own.

import { PROJECT_EXTENSION } from '../core/project/manifest'
import { extensionOf, isImageFile, isReferenceFile } from '../core/formats'

export interface AddressOpen {
  /** Where the file is fetched from — absolute. */
  url: string
  /** What the file is opened as: the last segment of the URL's path. */
  name: string
}

/** A name that is a path of plain segments: letters, digits, `.`, `_`, `-`,
 *  with `/` between, no empty segment and no `..`. */
const SHORT_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** What the address says to open: a request, a reason it cannot be met, or
 *  null when it says nothing. `base` is the page's own address, which a
 *  relative `?open=` resolves against; `filesBase` the store short names
 *  point into, if the build has one. */
export function openFromAddress(
  { pathname, search }: { pathname: string; search: string },
  base: string,
  filesBase: string | undefined,
): AddressOpen | { error: string } | null {
  const open = new URLSearchParams(search).get('open')
  if (open) {
    let url: URL
    try {
      url = new URL(open, base)
    } catch {
      return { error: `The address does not name a file to open: ${open}` }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { error: `Only an http or https address can be opened, not ${url.protocol.slice(0, -1)}.` }
    }
    return { url: url.href, name: nameOf(url) }
  }
  const short = /^\/s\/(.+)$/.exec(pathname)
  if (!short) return null
  let name: string
  try {
    name = decodeURIComponent(short[1]).replace(/\/+$/, '')
  } catch {
    return { error: `The address is not a file name: ${short[1]}` }
  }
  if (!SHORT_NAME.test(name) || name.split('/').includes('..')) {
    return { error: `The address is not a file name: ${name}` }
  }
  if (!filesBase) return { error: 'This build has no file store, so a short link cannot be opened here.' }
  const known = isReferenceFile(name) || isImageFile(name) || extensionOf(name) === PROJECT_EXTENSION
  const key = known ? name : `${name}.${PROJECT_EXTENSION}`
  const url = new URL(key.split('/').map(encodeURIComponent).join('/'), filesBase.replace(/\/*$/, '/'))
  return { url: url.href, name: nameOf(url) }
}

/** The workspace the address asks for, by its public name, or null. Whether
 *  the build has one of that name is the caller's to check. */
export function workspaceFromAddress({ search }: { search: string }): string | null {
  const name = new URLSearchParams(search).get('workspace')?.trim().toLowerCase()
  return name || null
}

/** The file's name: the URL's last path segment, decoded. */
function nameOf(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last) || 'file'
  } catch {
    return last || 'file'
  }
}

/** The most a file named in the address may hold: a link anyone can send
 *  must not be able to fill the tab's memory, and no project is larger. */
export const MAX_ADDRESS_BYTES = 1024 * 1024 * 1024

/** Fetch the file. The errors say what to do: the status for a refusal,
 *  and for a failed request — most often a server that does not let this
 *  site read it — the server to ask. */
export async function fetchAddressFile({ url, name }: AddressOpen, maxBytes = MAX_ADDRESS_BYTES): Promise<File> {
  let res: Response
  try {
    res = await fetch(url, { mode: 'cors' })
  } catch {
    const host = new URL(url).host
    throw new Error(`${name} could not be fetched from ${host}. The server has to be reachable, and to let this site read the file (CORS).`)
  }
  if (!res.ok) throw new Error(`${name} could not be fetched: ${res.status} ${res.statusText}`.trimEnd() + '.')
  const tooLarge = () => new Error(`${name} is too large to open from a link: the limit is ${Math.round(maxBytes / 1024 / 1024)} MB. Download it and open it from disk instead.`)
  const length = Number(res.headers.get('content-length'))
  if (length > maxBytes) throw tooLarge()
  // The length a server states can be missing or wrong, so the body is read
  // a piece at a time and given up on once it runs past the limit.
  const chunks: Uint8Array[] = []
  let total = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  }
  return new File(chunks as BlobPart[], name, { type: res.headers.get('content-type') ?? '' })
}
