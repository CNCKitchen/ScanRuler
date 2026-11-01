// SPDX-License-Identifier: AGPL-3.0-only
// Every dictionary in i18n/ holds the same English keys, each with a non-empty
// value, and names itself; the menu and panel strings it carries are known ones.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { LANGUAGES, defaultLanguage, hwOf, loadDict, menuOf } from '../i18n.js'

const dir = new URL('../i18n/', import.meta.url)
const langs = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.slice(0, -5))
// The source list translators work from is the pt-BR key set.
assert.deepEqual(JSON.parse(readFileSync(new URL('_english-keys.json', dir), 'utf8')), Object.keys(loadDict('pt-BR')), '_english-keys.json up to date')
assert(langs.includes('pt-BR'), 'pt-BR present')
const keys = Object.keys(loadDict('pt-BR'))
const menuKeys = Object.keys(menuOf('en'))
const hwKeys = Object.keys(hwOf('en'))
for (const lang of langs) {
  const raw = JSON.parse(readFileSync(new URL(`${lang}.json`, dir), 'utf8'))
  const dict = loadDict(lang)
  assert.equal(typeof raw._name, 'string', `${lang}: _name`)
  assert.equal(LANGUAGES[lang], raw._name, `${lang}: listed by its own name`)
  assert.deepEqual(Object.keys(dict).sort(), [...keys].sort(), `${lang}: same keys as pt-BR`)
  for (const [k, v] of Object.entries(dict)) assert(typeof v === 'string' && v.trim(), `${lang}: empty value for "${k}"`)
  for (const k of Object.keys(raw._menu ?? {})) assert(menuKeys.includes(k), `${lang}: unknown _menu key ${k}`)
  for (const k of Object.keys(raw._hw ?? {})) assert(hwKeys.includes(k), `${lang}: unknown _hw key ${k}`)
  // A fragment keeps its shape: what ends in ":" or " ·" in English does so translated.
  // Chinese and Japanese write a full-width colon.
  const ends = { ':': /[:：]$/, ' ·': /·$/, '…': /…$/ }
  for (const [k, v] of Object.entries(dict)) for (const [end, re] of Object.entries(ends)) if (k.endsWith(end)) assert(re.test(v.trimEnd()), `${lang}: "${k}" lost its "${end}"`)
}
assert.equal(loadDict('en'), null)
assert.equal(defaultLanguage('pt-BR'), 'pt-BR')
assert.equal(defaultLanguage('pt-PT'), 'pt-BR')
assert.equal(defaultLanguage('xx'), 'en')
console.log(`dicts ok: ${langs.join(', ')}`)
