// SPDX-License-Identifier: AGPL-3.0-only
// --allow-origin takes a URL; the browser sends a bare origin, so a
// trailing slash, a path or an uppercase host still admits the page.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originAllowed } from '../src/link.js'

test('an allowed origin given as a URL matches the Origin header', () => {
  assert.equal(originAllowed('https://x.example', ['https://x.example/']), true)
  assert.equal(originAllowed('https://x.example', ['https://X.example/app/']), true)
  assert.equal(originAllowed('https://y.example', ['https://x.example/']), false)
  assert.equal(originAllowed('https://x.example', ['not a url']), false)
})
