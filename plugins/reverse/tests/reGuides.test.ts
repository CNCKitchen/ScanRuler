// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer's guides (plugins/reverse/guides) and the skill that
// points at them name only tools that exist: every tool name in backticks —
// the workspace's, the app's, another plugin's where a guide says it is
// installed, the server's own — is a command the app registers with every
// plugin installed, as the server lists it, or one of the server's own
// tools. The app's test (tests/skillNames.test.ts) checks the app's names in
// its own guides; this one checks them all in these. And guide.read serves
// each file registered, with the guides each is read with, and every read
// they prescribe within what the server carries.

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { registerCoreCommands } from '../../../src/commands/core'
import { GUIDES_READ_MOST } from '../../../src/commands/core/guide'
import { listGuides } from '../../../src/commands/guides'
import { listCommands, runCommand } from '../../../src/commands/registry'
import { installPlugins } from '../../../src/plugins/registry'
import { GUIDE_ANSWER_CAP, quotedReads } from '../../../tests/guideReads'

const GUIDES = new URL('../guides/', import.meta.url)
const SKILL = new URL('../skills/scan-reverse-engineering/SKILL.md', import.meta.url)
const MCP = readFileSync(new URL('../../../mcp/src/mcp.js', import.meta.url), 'utf8')

const textOf = (u: URL) => readFileSync(u, 'utf8').split('\r\n').join('\n')
const guideFiles = () => readdirSync(GUIDES).filter((f) => f.endsWith('.md')).map((f) => ({ name: f, text: textOf(new URL(f, GUIDES)) }))

function installed() {
  installPlugins()
  registerCoreCommands()
}

describe('the Reverse engineer’s guides', () => {
  it('name only tools that exist', () => {
    installed()
    const known = new Set([...listCommands().map((c) => c.name.split('.').join('_')), ...[...MCP.matchAll(/name: '(scanruler_[a-z_]+)'/g)].map((m) => m[1])])
    const spaces = new Set([...known].map((n) => n.split('_')[0]))
    const files = [...guideFiles(), { name: 'SKILL.md', text: textOf(SKILL) }]
    expect(files.length).toBeGreaterThan(3)
    const unknown = files.flatMap(({ name, text }) =>
      [...new Set([...text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)].map((m) => m[1]))].filter((n) => spaces.has(n.split('_')[0]) && !known.has(n)).map((n) => `${name}: ${n}`),
    )
    expect(unknown).toEqual([])
    // They teach the workspace's own, and the skill sends an agent to them.
    expect(files.some((f) => /`reverse_feature_add`/.test(f.text))).toBe(true)
    expect(textOf(SKILL)).toMatch(/`guide_read \{ topic: \["model", "scan-to-cad"\] \}`/)
  })

  it('are each served, and each guide they are read with is one', async () => {
    installed()
    const ids = listGuides().map((g) => g.id)
    expect(ids).toEqual(expect.arrayContaining(['model', 'scan-to-cad', 'model-reference', 'measure']))
    for (const g of listGuides()) for (const w of g.with ?? []) expect(ids, `${g.id} is read with ${w}`).toContain(w)
    // Every file here is a guide, served as it is written but for the
    // sections kept for a moment of the task — as many as fit in one
    // answer, then the next ones it names.
    type Read = { guides: { topic: string; text: string; later?: { section: string; when: string }[]; sectionsLeft?: string[] }[]; next?: string[]; note?: string }
    const served: Read['guides'] = []
    let topics: string[] | undefined = ['model', 'scan-to-cad', 'model-reference']
    for (let call = 0; topics && call < 3; call++) {
      const answer = (await runCommand('guide.read', { topic: topics })) as Read
      served.push(...answer.guides)
      topics = answer.next
    }
    expect(served.map((g) => g.topic)).toEqual(['model', 'scan-to-cad', 'model-reference'])
    const files = guideFiles()
    expect(files.map((f) => f.name).sort()).toEqual(['model-reference.md', 'model.md', 'scan-to-cad.md'])
    for (const g of served) {
      const file = files.find((f) => f.name === `${g.topic}.md`)!
      // A guide longer than one answer ends with the last section it left
      // out, read by section as its note says.
      const left = g.sectionsLeft ?? []
      const last = left.length ? ((await runCommand('guide.read', { topic: g.topic, section: left[left.length - 1] })) as { text: string }).text : g.text
      expect(file.text.trim().endsWith(last.slice(-200).trim()), g.topic).toBe(true)
      // No marker is served, and each section kept for later is in the
      // file, marked, and whole when read by name.
      expect(g.text, g.topic).not.toContain('read when:')
      for (const l of g.later ?? []) {
        expect(g.text, `${g.topic} / ${l.section}`).not.toContain(`\n## ${l.section}\n`)
        expect(file.text).toContain(`\n## ${l.section}\n\n<!-- read when: ${l.when} -->\n`)
        const s = (await runCommand('guide.read', { topic: g.topic, section: l.section })) as { section: string; text: string }
        expect(s.section).toBe(l.section)
        expect(s.text.startsWith(`## ${l.section}\n`)).toBe(true)
        expect(s.text).not.toContain('read when:')
        expect(file.text).toContain(s.text.slice(-200))
      }
    }
    // The scan-to-CAD task's first read: the two guides one answer each —
    // together some 78 k characters, which a client cut off — their
    // measuring and building sections kept for their moments.
    const first = (await runCommand('guide.read', { topic: ['model', 'scan-to-cad'] })) as Read
    expect(first.guides.map((g) => g.topic)).toEqual(['model'])
    expect(first.next).toEqual(['scan-to-cad'])
    expect(first.guides[0].later?.map((l) => l.section)).toEqual(['2. Building'])
    expect(first.note).toMatch(/model keeps "2\. Building" \(before the first feature is added[^)]*\) for later: read it when that moment comes, before the step it is for — guide_read \{ topic: "model", section: "2\. Building" \}\. .*read it next — guide_read \{ topic: "scan-to-cad" \}/)
    const then = (await runCommand('guide.read', { topic: first.next })) as Read
    expect(then.guides.map((g) => g.topic)).toEqual(['scan-to-cad'])
    expect(then.guides[0].later?.map((l) => l.section)).toEqual(['3. Measuring'])
    expect(then.guides[0].text).toContain('\n### 4a. By archetype\n')
    for (const a of [first, then]) expect(JSON.stringify(a).length).toBeLessThanOrEqual(GUIDES_READ_MOST)
  })

  it('send an agent to sections that exist', async () => {
    installed()
    // Every `guide_read { topic: "…", section: "…" }` they write is one
    // guide.read answers.
    const asks = guideFiles().flatMap((f) => [...f.text.matchAll(/`guide_read \{ topic: "([a-z-]+)", section: "([^"]+)" \}`/g)].map((m) => ({ topic: m[1], section: m[2] })))
    expect(asks.length).toBeGreaterThan(1)
    for (const ask of asks) await expect(runCommand('guide.read', ask), `${ask.topic} / ${ask.section}`).resolves.toMatchObject({ topic: ask.topic })
  })

  it('prescribe only reads that answer within what the server carries', async () => {
    installed()
    // Every `guide_read { … }` and `topic: …` they and the skill write, and
    // each guide whole: none is written to a file instead.
    const files = [...guideFiles(), { name: 'SKILL.md', text: textOf(SKILL) }]
    const asks = files.flatMap(({ name, text }) => quotedReads(text).map((a) => ({ ...a, name })))
    expect(asks.some((a) => Array.isArray(a.input.topic))).toBe(true)
    for (const id of ['model', 'scan-to-cad', 'model-reference']) asks.push({ quoted: id, input: { topic: id }, name: 'whole' })
    for (const { quoted, input, name } of asks) {
      const answer = await runCommand('guide.read', input)
      expect(JSON.stringify(answer).length, `${name}: ${quoted}`).toBeLessThanOrEqual(GUIDE_ANSWER_CAP)
    }
  })

  it('name Python only among the scan guide’s fallbacks', () => {
    for (const { name, text } of guideFiles()) {
      const at = text.indexOf('\n## Fallbacks')
      const end = at < 0 ? -1 : text.indexOf('\n## ', at + 1)
      const outside = at < 0 ? text : text.slice(0, at) + (end > 0 ? text.slice(end) : '')
      expect(outside, name).not.toMatch(/python|numpy|scipy|trimesh/i)
    }
    expect(textOf(new URL('scan-to-cad.md', GUIDES))).toMatch(/\n## Fallbacks/)
  })
})
