// SPDX-License-Identifier: AGPL-3.0-only
// The Docker image's nginx sends the same Content-Security-Policy as the hosted
// app (public/_headers): a policy changed in one place only would break the
// self-hosted app, or loosen it, without any check noticing.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** The policies in _headers: the page's, then one per path rule below it. */
function hostedPolicies(): { page: string; workers: Map<string, string> } {
  let path = ''
  let page = ''
  const workers = new Map<string, string>()
  for (const line of read('public/_headers').split(/\r?\n/)) {
    if (/^\S/.test(line) && !line.startsWith('#')) path = line.trim()
    const csp = /^\s+Content-Security-Policy: (.+)$/.exec(line)?.[1].trim()
    if (!csp) continue
    if (path === '/*') page = csp
    else workers.set(path, csp)
  }
  return { page, workers }
}

/** nginx's map: the default and the one regex for the kernel's workers. */
function nginxPolicies(): { page: string; workerPattern: RegExp; worker: string } {
  const conf = read('docker/nginx.conf')
  const page = /^\s+default "(.+)";$/m.exec(conf)?.[1] ?? ''
  const [, pattern = '', worker = ''] = /^\s+~(\S+) "(.+)";$/m.exec(conf) ?? []
  return { page, workerPattern: new RegExp(pattern), worker }
}

describe('Docker nginx headers', () => {
  it('sends the hosted page policy', () => {
    const hosted = hostedPolicies()
    expect(hosted.page).not.toBe('')
    expect(nginxPolicies().page).toBe(hosted.page)
  })

  it('gives the same worker scripts the same looser policy', () => {
    const { workers } = hostedPolicies()
    const nginx = nginxPolicies()
    expect(workers.size).toBeGreaterThan(0)
    for (const [path, csp] of workers) {
      // _headers matches /assets/reWorker-* ; nginx sees /assets/reWorker-abc123.js.
      expect(nginx.workerPattern.test(path.replace('*', 'abc123.js')), path).toBe(true)
      expect(nginx.worker, path).toBe(csp)
    }
    expect(nginx.workerPattern.test('/assets/edgeWorker-abc123.js')).toBe(false)
    expect(nginx.workerPattern.test('/assets/wrapWorker-abc123.js')).toBe(false)
    expect(nginx.workerPattern.test('/assets/index-abc123.js')).toBe(false)
  })

  it('sends a header with the mapped policy in every location', () => {
    const conf = read('docker/nginx.conf')
    // A location with add_header lines of its own drops the server's.
    const blocks = conf.split(/\n\s*location /).slice(1)
    for (const block of blocks.filter((b) => b.includes('add_header'))) {
      expect(block).toContain('add_header Content-Security-Policy $scanruler_csp always;')
    }
  })
})
