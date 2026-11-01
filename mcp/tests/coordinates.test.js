// SPDX-License-Identifier: AGPL-3.0-only
// A coordinate far from the origin keeps four decimals: six significant
// digits alone would move a point the agent feeds back by a tenth of a
// millimetre or more.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentJson } from '../src/tools.js'

test('large coordinates keep at least four decimals', () => {
  assert.equal(agentJson({ x: 12345.678, y: 123456.789, z: -98765.43219, d: 2.3456789 }), '{"x":12345.678,"y":123456.789,"z":-98765.4322,"d":2.34568}')
})
