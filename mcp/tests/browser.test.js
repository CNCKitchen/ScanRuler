// SPDX-License-Identifier: AGPL-3.0-only
// Opening the pairing link in the default browser: the command each platform
// gets, and links that are not handed to a shell at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCommand, openInBrowser } from '../src/browser.js'

const LINK = 'https://scanruler.com/#agent=7317:abc_DEF-123'

test('each platform opens the link with its own opener, the fragment intact', () => {
  assert.deepEqual(openCommand(LINK, 'win32'), { command: 'cmd', args: ['/d', '/c', 'start', '""', `"${LINK}"`], verbatim: true })
  assert.deepEqual(openCommand(LINK, 'darwin'), { command: 'open', args: [LINK], verbatim: false })
  assert.deepEqual(openCommand(LINK, 'linux'), { command: 'xdg-open', args: [LINK], verbatim: false })
})

test('a link cmd.exe would read anything into is not opened', async () => {
  for (const url of ['https://scanruler.com/#agent=7317:%PATH%', 'https://x.test/" & calc', 'https://x.test/a^b', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(await openInBrowser(url, 'win32'), false, url)
  }
})
