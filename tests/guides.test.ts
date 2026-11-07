// SPDX-License-Identifier: AGPL-3.0-only
// guide.read: the index, a guide whole or several in order while they fit
// one answer, one section, and what it says when a name is wrong — and the
// guides it lists are the ones registered, in its description too; every
// read the app's guides prescribe answers within what the server carries.

import { readdirSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerCoreCommands } from '../src/commands/core'
import { GUIDES_READ_MOST } from '../src/commands/core/guide'
import { guideSectionRead, registerGuide, resetGuideReads } from '../src/commands/guides'
import { listCommands, runCommand } from '../src/commands/registry'
import { CommandError } from '../src/commands/types'
import { GUIDE_ANSWER_CAP, quotedReads } from './guideReads'

const TEXT = [
  '<!-- SPDX-License-Identifier: AGPL-3.0-only -->',
  '',
  '# Test guide',
  '',
  'Read the measure guide first.',
  '',
  '## 1. Datums',
  'Fit the mating face.',
  '',
  '### Small angles',
  'Round what moves the far end by less than T.',
  '',
  '## 2. Datum check',
  'Check the frame.',
].join('\r\n')

/** A guide with a section read when its moment comes, not with the guide. */
const LATER = [
  '# Later guide',
  '',
  'Opening.',
  '',
  '## 1. Setup',
  'Open the scan.',
  '',
  '## 2. Measuring',
  '',
  '<!-- read when: before the first fit -->',
  '',
  'Fit the cylinder.',
  '',
  '### 2a. Seeds',
  'Seed in the middle.',
  '',
  '## 3. Handover',
  'Check the frame.',
].join('\n')

/** A guide of about `chars` characters. */
const long = (chars: number) => ['# A long guide', '', '## 1. All of it', 'x'.repeat(chars)].join('\n')

let unregister: (() => void)[] = []
beforeAll(() => {
  registerCoreCommands()
  unregister = [
    registerGuide({ id: 'test-guide', title: 'A test guide', when: 'testing the guides', with: ['measure'], text: async () => TEXT }),
    registerGuide({ id: 'test-long-a', title: 'A long guide', when: 'testing what fits', text: async () => long(50_000) }),
    registerGuide({ id: 'test-long-b', title: 'Another long guide', when: 'testing what fits', text: async () => long(50_000) }),
    registerGuide({ id: 'test-huge', title: 'A huge guide', when: 'testing what fits', text: async () => long(85_000) }),
    registerGuide({ id: 'test-later', title: 'A guide with a later section', when: 'testing what waits', text: async () => LATER }),
    registerGuide({ id: 'test-parts-later', title: 'A long guide with a later section', when: 'testing what waits', text: async () => ['# Parts', '', 'Opening.', '', '## 1. Shapes', 'a'.repeat(40_000), '', '## 2. Frames', '', '<!-- read when: before the first frame -->', 'b'.repeat(40_000), '', '## 3. Errors', 'c'.repeat(40_000)].join('\n') }),
    registerGuide({ id: 'test-parts', title: 'A guide of long parts', when: 'testing what fits', text: async () => ['# Parts', '', 'Opening.', '', '## 1. Shapes', 'a'.repeat(40_000), '', '## 2. Frames', 'b'.repeat(40_000), '', '## 3. Errors', 'c'.repeat(40_000)].join('\n') }),
  ]
})
afterAll(() => unregister.forEach((off) => off()))

const read = (input: unknown) => runCommand('guide.read', input) as Promise<Record<string, any>>
const refusal = (input: unknown) => read(input).then(
  () => {
    throw new Error('not refused')
  },
  (e: CommandError) => e,
)

describe('guide.read', () => {
  it('lists the guides in its description, with what each is read with', () => {
    const d = listCommands().find((c) => c.name === 'guide.read')!.description
    expect(d).toContain('measure — measuring a 3D scan')
    expect(d).toContain('test-guide — testing the guides (read with measure, first)')
  })

  it('answers the index without a topic: each guide, its sections and their cost', async () => {
    const { guides } = await read({})
    const g = guides.find((x: any) => x.topic === 'test-guide')
    expect(g).toMatchObject({ title: 'A test guide', when: 'testing the guides', with: ['measure'] })
    expect(g.sections.map((s: any) => s.heading)).toEqual(['1. Datums', 'Small angles', '2. Datum check'])
    expect(g.sections[1].level).toBe(3)
    expect(guides.map((x: any) => x.topic)).toContain('measure-reference')
    expect(guides.every((x: any) => x.tokens > 0)).toBe(true)
  })

  it('gives a guide whole, without its licence comment, and names what it is read with', async () => {
    const one = await read({ topic: 'test-guide' })
    expect(one.guides).toHaveLength(1)
    expect(one.guides[0].text.startsWith('# Test guide')).toBe(true)
    expect(one.guides[0].text).not.toContain('\r')
    expect(one.with).toEqual(['measure'])
    const both = await read({ topic: ['measure', 'test-guide'] })
    expect(both.guides.map((g: any) => g.topic)).toEqual(['measure', 'test-guide'])
    expect(both.with).toBeUndefined()
    expect(both.guides[0].text).toContain('# Measuring a 3D scan')
  })

  it('gives several in order while they fit in one answer, and names the rest in next', async () => {
    const first = await read({ topic: ['test-long-a', 'test-long-b', 'test-guide'] })
    expect(first.guides.map((g: any) => g.topic)).toEqual(['test-long-a'])
    // In order: the small one after a long one that did not fit waits too.
    expect(first.next).toEqual(['test-long-b', 'test-guide'])
    expect(first.note).toMatch(/^test-long-b and test-guide did not fit in this answer with test-long-a \(50 k characters\): read them next — guide_read \{ topic: \["test-long-b", "test-guide"\] \}\./)
    expect(JSON.stringify(first).length).toBeLessThan(GUIDES_READ_MOST)
    // The next call, as the note gives it: both fit.
    const second = await read({ topic: first.next })
    expect(second.guides.map((g: any) => g.topic)).toEqual(['test-long-b', 'test-guide'])
    expect(second.next).toBeUndefined()
    expect(second.with).toEqual(['measure'])
    // One guide is answered whole, whatever its size; one too many after it waits.
    const huge = await read({ topic: ['test-huge', 'test-guide'] })
    expect(huge.guides.map((g: any) => g.topic)).toEqual(['test-huge'])
    expect(huge.guides[0].text.length).toBeGreaterThan(85_000)
    expect(huge.next).toEqual(['test-guide'])
    expect(huge.note).toMatch(/read it next — guide_read \{ topic: "test-guide" \}/)
    // What the description says.
    expect(listCommands().find((c) => c.name === 'guide.read')!.description).toContain('as many as fit in about 60 k characters, the rest named in next')
  })

  it('cuts a guide too long by itself to the sections that fit, and names the rest', async () => {
    const parts = await read({ topic: ['test-parts', 'test-guide'] })
    expect(parts.guides).toHaveLength(1)
    const [g] = parts.guides
    expect(g.text).toMatch(/^# Parts\n\nOpening\.\n\n## 1\. Shapes\na{40000}$/)
    expect(g.sectionsLeft).toEqual(['2. Frames', '3. Errors'])
    expect(parts.next).toEqual(['test-guide'])
    expect(parts.note).toMatch(/^test-parts is longer than one answer carries: its "2\. Frames", "3\. Errors" sections are left out — read each when you need it, guide_read \{ topic: "test-parts", section: "2\. Frames" \}\./)
    expect(JSON.stringify(parts).length).toBeLessThan(GUIDES_READ_MOST)
    // Each one left, read as the note says.
    expect((await read({ topic: 'test-parts', section: '2. Frames' })).text).toMatch(/^## 2\. Frames\nb{40000}$/)
  })

  it('answers every read the app’s guides prescribe within what the server carries', async () => {
    const dir = new URL('../src/commands/guides/', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(1)
    const asks = files.flatMap((f) => quotedReads(readFileSync(new URL(f, dir), 'utf8')).map((a) => ({ ...a, file: f })))
    expect(asks.length).toBeGreaterThan(0)
    for (const { quoted, input, file } of asks) {
      const answer = await read(input)
      expect(JSON.stringify(answer).length, `${file}: ${quoted}`).toBeLessThanOrEqual(GUIDE_ANSWER_CAP)
    }
    // Each guide whole, too.
    for (const g of ['measure', 'measure-reference']) expect(JSON.stringify(await read({ topic: g })).length, g).toBeLessThanOrEqual(GUIDE_ANSWER_CAP)
    // The budget leaves room under the cap.
    expect(GUIDES_READ_MOST).toBeLessThan(GUIDE_ANSWER_CAP)
  })

  it('gives one section by its heading, with or without its number, or a part that names one', async () => {
    const datums = await read({ topic: 'test-guide', section: 'Datums' })
    expect(datums.section).toBe('1. Datums')
    // A section runs to the next heading of its level: its subsections in it.
    expect(datums.text).toContain('Small angles')
    expect(datums.text).not.toContain('Check the frame')
    expect((await read({ topic: 'test-guide', section: 'small' })).section).toBe('Small angles')
    expect((await read({ topic: 'test-guide', section: '2. Datum check' })).text).toContain('Check the frame')
  })

  it('leaves a section marked to be read when its moment comes out of a whole read, and names it in later', async () => {
    const whole = await read({ topic: 'test-later' })
    const [g] = whole.guides
    expect(g.text).toBe(['# Later guide', '', 'Opening.', '', '## 1. Setup', 'Open the scan.', '', '## 3. Handover', 'Check the frame.'].join('\n'))
    expect(g.text).not.toContain('read when')
    expect(g.later).toEqual([{ section: '2. Measuring', when: 'before the first fit' }])
    expect(whole.note).toBe('test-later keeps "2. Measuring" (before the first fit) for later: read it when that moment comes, before the step it is for — guide_read { topic: "test-later", section: "2. Measuring" }.')
    // The index says when.
    const index = await read({})
    const sections = index.guides.find((x: any) => x.topic === 'test-later').sections
    expect(sections.map((s: any) => s.heading)).toEqual(['1. Setup', '2. Measuring', '2a. Seeds', '3. Handover'])
    expect(sections[1].when).toBe('before the first fit')
    expect(sections[0].when).toBeUndefined()
    // A guide without one has no later.
    expect((await read({ topic: 'test-guide' })).guides[0].later).toBeUndefined()
    // What the description says.
    expect(listCommands().find((c) => c.name === 'guide.read')!.description).toContain('later names each with when to read it')
  })

  it('gives a section marked for later whole when read by name, without the marker', async () => {
    const s = await read({ topic: 'test-later', section: 'Measuring' })
    expect(s.section).toBe('2. Measuring')
    expect(s.text).toBe(['## 2. Measuring', '', 'Fit the cylinder.', '', '### 2a. Seeds', 'Seed in the middle.'].join('\n'))
    expect((await read({ topic: 'test-later', section: '2a. Seeds' })).text).toBe('### 2a. Seeds\nSeed in the middle.')
  })

  it('takes the later sections out before cutting a guide too long by itself', async () => {
    const parts = await read({ topic: 'test-parts-later' })
    const [g] = parts.guides
    expect(g.text).toMatch(/^# Parts\n\nOpening\.\n\n## 1\. Shapes\na{40000}$/)
    expect(g.later).toEqual([{ section: '2. Frames', when: 'before the first frame' }])
    expect(g.sectionsLeft).toEqual(['3. Errors'])
    expect(parts.note).toMatch(/^test-parts-later keeps "2\. Frames" \(before the first frame\) for later: .* test-parts-later is longer than one answer carries: its "3\. Errors" section is left out/)
    expect(JSON.stringify(parts).length).toBeLessThan(GUIDES_READ_MOST)
    expect((await read({ topic: 'test-parts-later', section: 'Frames' })).text).toMatch(/^## 2\. Frames\n\nb{40000}$/)
  })

  it('records what was read, per guide and section', async () => {
    resetGuideReads()
    expect(guideSectionRead('test-later', '1. Setup')).toBe(false)
    expect(guideSectionRead('test-later', '2. Measuring')).toBe(false)
    // A whole read: the sections it carried, not the one kept for later.
    await read({ topic: ['test-later', 'test-guide'] })
    expect(guideSectionRead('test-later', '1. Setup')).toBe(true)
    expect(guideSectionRead('test-later', 'Setup')).toBe(true)
    expect(guideSectionRead('test-later', '3. Handover')).toBe(true)
    expect(guideSectionRead('test-later', '2. Measuring')).toBe(false)
    expect(guideSectionRead('test-later', '2a. Seeds')).toBe(false)
    expect(guideSectionRead('test-guide', 'Small angles')).toBe(true)
    expect(guideSectionRead('nope', '1. Setup')).toBe(false)
    // A section read by name: it and its parts.
    await read({ topic: 'test-later', section: 'Measuring' })
    expect(guideSectionRead('test-later', '2. Measuring')).toBe(true)
    expect(guideSectionRead('test-later', 'measuring')).toBe(true)
    expect(guideSectionRead('test-later', 'Seeds')).toBe(true)
    // A long guide's sections left for the next call are not read yet.
    resetGuideReads()
    await read({ topic: 'test-parts' })
    expect(guideSectionRead('test-parts', '1. Shapes')).toBe(true)
    expect(guideSectionRead('test-parts', '2. Frames')).toBe(false)
  })

  it('says what is wrong with a name, and what there is', async () => {
    const guide = await refusal({ topic: 'nope' })
    expect(guide.code).toBe('not_found')
    expect(guide.message).toContain('measure')
    const section = await refusal({ topic: 'test-guide', section: 'thickness' })
    expect(section.code).toBe('not_found')
    expect(section.message).toContain('"1. Datums"')
    const two = await refusal({ topic: 'test-guide', section: 'datum' })
    expect(two.code).toBe('invalid_input')
    expect(two.message).toContain('more than one section')
    expect((await refusal({ topic: ['measure', 'test-guide'], section: 'Datums' })).code).toBe('invalid_input')
    expect((await refusal({ section: 'Datums' })).code).toBe('invalid_input')
  })
})
