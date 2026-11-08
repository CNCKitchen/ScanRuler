// SPDX-License-Identifier: AGPL-3.0-only
// guide.read: the guides (../guides.ts) as an agent reads them — the index,
// one guide or several whole (as many as one answer carries, the rest named
// to read next; a guide too long by itself cut to the sections that fit),
// or one section of one. A section marked to be read when its moment comes
// (`<!-- read when: … -->` under its heading) is left out of a whole read
// and named in `later`, for a read by section then. The description lists
// the guides there are, so an agent that sees the tool sees what to read for
// its task; it is read when the tools are listed, after the plugins have
// registered theirs. Every read is recorded (markGuideRead) per guide and
// section, for a command to check that the section its moment needs was
// read.

import { bareHeading, guideById, listGuides, markGuideRead, type Guide } from '../guides'
import { arr, obj, oneOf, str } from '../schema'
import { CommandError, type Command } from '../types'

/** About what a text costs an agent: four characters a token. */
const tokens = (text: string) => Math.max(10, Math.round(text.length / 40) * 10)

/** The most characters, as JSON, of guides one read answers whole when
 *  several are asked for: those that fit, in order — the first always —
 *  and the rest named in `next`, to read in the next call. An agent's
 *  client may take no more than 25 000 tokens of an answer, and a guide's
 *  marks and escapes run nearer three characters a token than four: an
 *  80 k read of two guides was cut off (the server's cap for a guide is
 *  70 k); a read past that is written to a file, which an agent starting a
 *  task may not open. */
export const GUIDES_READ_MOST = 60_000

/** The marker under a `##` heading of a section read when its moment
 *  comes, not with the guide: `<!-- read when: before the first fit -->`. */
const READ_WHEN = /^<!--\s*read when:\s*(.+?)\s*-->$/

interface Section {
  heading: string
  level: number
  text: string
  /** The moment to read it, when it is marked to be read then. */
  when?: string
}

/** A section a whole read leaves out, and when to read it. */
export interface Later {
  section: string
  when: string
}

/** A guide's text as served: the licence comment before it left out. */
const served = (text: string) =>
  text
    .split('\r\n')
    .join('\n')
    .replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '')
    .trim()

/** The marker's text when `lines` (a section, its heading first) carry
 *  one as their first line after the heading. */
function whenOf(lines: string[]): string | undefined {
  const first = lines.slice(1).find((l) => l.trim() !== '')
  return first === undefined ? undefined : READ_WHEN.exec(first.trim())?.[1]
}

/** The section's lines without its marker, and the blank lines after it. */
function unmarked(lines: string[]): string[] {
  const at = lines.findIndex((l, i) => i > 0 && l.trim() !== '')
  if (at < 0 || !READ_WHEN.test(lines[at].trim())) return lines
  let next = at + 1
  while (next < lines.length && lines[next].trim() === '') next++
  return [...lines.slice(0, at), ...lines.slice(next)]
}

/** Its `##` and `###` sections, each running to the next heading of its
 *  level or above — the text of each without its marker, the marker's
 *  moment as `when`. */
function sections(text: string): Section[] {
  const lines = text.split('\n')
  const heads = lines.flatMap((line, i) => {
    const m = /^(#{2,3}) (.+)$/.exec(line)
    return m ? [{ i, level: m[1].length, heading: m[2].trim() }] : []
  })
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.i ?? lines.length
    const own = lines.slice(h.i, end)
    const when = whenOf(own)
    return { heading: h.heading, level: h.level, text: unmarked(own).join('\n').trim(), ...(when === undefined ? {} : { when }) }
  })
}

/** The text with its marked `##` sections taken out, and those sections
 *  named with their moments. */
function deferred(text: string): { text: string; later: Later[] } {
  const lines = text.split('\n')
  const starts = lines.flatMap((line, i) => (/^## /.test(line) ? [i] : []))
  const later: Later[] = []
  const kept: string[] = lines.slice(0, starts[0] ?? lines.length)
  starts.forEach((s, k) => {
    const own = lines.slice(s, starts[k + 1] ?? lines.length)
    const when = whenOf(own)
    if (when === undefined) kept.push(...own)
    else later.push({ section: lines[s].slice(3).trim(), when })
  })
  return { text: kept.join('\n').trim(), later }
}

interface Served {
  topic: string
  title: string
  text: string
  later?: Later[]
  sectionsLeft?: string[]
}

/** A guide too long for one answer by itself: its opening and its `##`
 *  sections in order while they fit — the first whatever its size — and the
 *  headings of the rest, to be read a section at a time. A `##` section too
 *  long by itself (a reference's command shapes) goes by its `###` parts. */
function headOf(g: Served): Served {
  const lines = g.text.split('\n')
  const starts = lines.flatMap((line, i) => (/^## /.test(line) ? [i] : []))
  if (starts.length < 2) return g
  const blocks = starts.flatMap((s, k) => {
    const end = starts[k + 1] ?? lines.length
    const whole = { heading: lines[s].slice(3).trim(), text: lines.slice(s, end).join('\n') }
    if (JSON.stringify(whole.text).length <= GUIDES_READ_MOST) return [whole]
    const parts = lines.slice(s + 1, end).flatMap((line, i) => (/^### /.test(line) ? [s + 1 + i] : []))
    if (parts.length === 0) return [whole]
    return [
      { heading: whole.heading, text: lines.slice(s, parts[0]).join('\n') },
      ...parts.map((p, j) => ({ heading: lines[p].slice(4).trim(), text: lines.slice(p, parts[j + 1] ?? end).join('\n') })),
    ]
  })
  let text = lines.slice(0, starts[0]).join('\n')
  let taken = 0
  while (taken < blocks.length && (taken === 0 || JSON.stringify({ ...g, text: `${text}\n${blocks[taken].text}` }).length <= GUIDES_READ_MOST)) text += `\n${blocks[taken++].text}`
  return { ...g, text: text.trim(), sectionsLeft: blocks.slice(taken).map((b) => b.heading) }
}

const loaded = new Map<string, Promise<string>>()
const textOf = (g: Guide) => {
  let t = loaded.get(g.id)
  if (!t) {
    t = g.text().then(served)
    loaded.set(g.id, t)
    t.catch(() => loaded.delete(g.id))
  }
  return t
}

const known = () => listGuides().map((g) => g.id).join(', ')

function guideNamed(id: string): Guide {
  const g = guideById(id)
  if (!g) throw new CommandError('not_found', `There is no guide "${id}" — the guides are ${known()}.`)
  return g
}

/** The section a name means: the heading itself, or the one heading it is
 *  part of, either without its number ("Datums" for "2. Datums"). */
function sectionNamed(g: Guide, all: Section[], name: string): Section {
  const want = bareHeading(name)
  const exact = all.filter((s) => bareHeading(s.heading) === want || s.heading.toLowerCase() === name.toLowerCase())
  if (exact.length === 1) return exact[0]
  const part = exact.length ? exact : all.filter((s) => bareHeading(s.heading).includes(want))
  if (part.length === 1) return part[0]
  const list = (part.length ? part : all).map((s) => `"${s.heading}"`).join(', ')
  throw new CommandError(part.length ? 'invalid_input' : 'not_found', `${part.length ? `"${name}" is more than one section` : `The guide "${g.id}" has no section "${name}"`} — ${part.length ? 'which of' : 'its sections are'} ${list}?`)
}

/** The headings a served text carries, `##` and `###`, for the record. */
const headingsOf = (text: string) => sections(text).map((s) => s.heading)

function describe(): string {
  const index = listGuides()
    .map((g) => `${g.id} — ${g.when}${g.with?.length ? ` (read with ${g.with.join(' and ')}, first)` : ''}`)
    .join('; ')
  return [
    'How to do a task with ScanRuler: the workflow, the judgement and the traps the tools’ own descriptions do not carry, written for this build — read the guide for your task, whole, before its first step, and a section again when you need it.',
    index ? `The guides: ${index}.` : 'This build has no guides.',
    `topic: a guide, or several read in order (a guide and the ones it is read with, in one call) — as many as fit in about ${Math.round(GUIDES_READ_MOST / 1000)} k characters, the rest named in next, to read in the next call. A guide longer than that by itself answers its sections in order while they fit, and names the rest in sectionsLeft, each to read by section.`,
    'A guide’s sections for one moment of the task — measuring, building — are not in the whole read: later names each with when to read it, and the note says how; read it by section when that moment comes, before the step it is for.',
    'section: one section of one guide, by its heading — the index lists them, with when to read those a whole read leaves for later. A long section with ### parts under it — a reference’s list of command shapes — is best read by those parts: section takes a ### heading too, the one part you need. With no topic, the index: each guide with its sections and what each costs in tokens. Changes nothing.',
  ].join(' ')
}

const read: Command<{ topic?: string | string[]; section?: string }> = {
  name: 'read',
  title: 'Read a guide',
  get description() {
    return describe()
  },
  input: obj({
    topic: oneOf([str(), arr(str(), undefined, { minItems: 1, maxItems: 8 })], 'A guide by its id, or several to read in order — as many as fit in one answer, the rest named in next. Leave it out for the index.'),
    section: str('One section of the guide, by its heading — a ## section or a ### part of one (without its number, or a part of it that names one section), whole: a section the whole read named in later, when its moment comes, or one to read again. Only with one topic.', { minLength: 1 }),
  }),
  readOnly: true,
  headless: true,
  run: async ({ topic, section }) => {
    if (topic === undefined) {
      if (section !== undefined) throw new CommandError('invalid_input', 'section needs the topic it is in.')
      const guides = await Promise.all(
        listGuides().map(async (g) => {
          const text = await textOf(g)
          return {
            topic: g.id,
            title: g.title,
            when: g.when,
            ...(g.with?.length ? { with: g.with } : {}),
            tokens: tokens(text),
            sections: sections(text).map((s) => ({ heading: s.heading, ...(s.level === 3 ? { level: 3 } : {}), tokens: tokens(s.text), ...(s.when === undefined ? {} : { when: s.when }) })),
          }
        }),
      )
      return { guides }
    }
    const ids = typeof topic === 'string' ? [topic] : topic
    const named = ids.map(guideNamed)
    if (section !== undefined) {
      if (named.length !== 1) throw new CommandError('invalid_input', 'section is one section of one guide: give one topic with it.')
      const g = named[0]
      const s = sectionNamed(g, sections(await textOf(g)), section)
      markGuideRead(g.id, headingsOf(s.text))
      return { topic: g.id, section: s.heading, tokens: tokens(s.text), text: s.text }
    }
    // Each guide without the sections read when their moment comes.
    const all: Served[] = await Promise.all(
      named.map(async (g) => {
        const { text, later } = deferred(await textOf(g))
        return { topic: g.id, title: g.title, text, ...(later.length ? { later } : {}) }
      }),
    )
    // In order while they fit, the first whatever its size — cut to the
    // sections that fit when it alone is too long; the rest for the next
    // call — never past what an answer carries.
    if (JSON.stringify(all[0]).length > GUIDES_READ_MOST) all[0] = headOf(all[0])
    let size = 0
    let fit = 0
    while (fit < all.length && (fit === 0 || (!all[0].sectionsLeft?.length && size + JSON.stringify(all[fit]).length <= GUIDES_READ_MOST))) size += JSON.stringify(all[fit++]).length
    const guides = all.slice(0, fit)
    const next = all.slice(fit).map((g) => g.topic)
    const left = guides[0].sectionsLeft ?? []
    for (const g of guides) markGuideRead(g.topic, headingsOf(g.text))
    // What the guides read build on and this call did not take: named, for
    // the agent to read too unless it has.
    const missing = [...new Set(named.flatMap((g) => g.with ?? []))].filter((id) => !ids.includes(id))
    const nextNote = next.length
      ? `${next.join(' and ')} did not fit in this answer with ${guides.map((g) => g.topic).join(' and ')} (${Math.round(size / 1000)} k characters): read ${next.length > 1 ? 'them' : 'it'} next — guide_read { topic: ${next.length > 1 ? JSON.stringify(next).split(',').join(', ') : `"${next[0]}"`} }.`
      : ''
    const withNote = missing.length ? `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} read with ${named.length > 1 ? 'these' : 'this one'}: read ${missing.length > 1 ? 'them' : 'it'} too, unless you have in this task.` : ''
    const leftNote = left.length
      ? `${guides[0].topic} is longer than one answer carries: its ${left.map((h) => `"${h}"`).join(', ')} ${left.length > 1 ? 'sections are' : 'section is'} left out — read each when you need it, guide_read { topic: "${guides[0].topic}", section: "${left[0]}" }.`
      : ''
    // The sections each guide keeps for a moment of the task: when, and how
    // to read each then.
    const laterNote = guides
      .filter((g) => g.later?.length)
      .map((g) => {
        const l = g.later!
        return `${g.topic} keeps ${l.map((x) => `"${x.section}" (${x.when})`).join(', ')} for later: read ${l.length > 1 ? 'each' : 'it'} when that moment comes, before the step it is for — guide_read { topic: "${g.topic}", section: "${l[0].section}" }.`
      })
      .join(' ')
    const note = [laterNote, leftNote, nextNote, withNote].filter(Boolean).join(' ')
    return {
      guides,
      ...(next.length ? { next } : {}),
      ...(missing.length ? { with: missing } : {}),
      ...(note ? { note } : {}),
    }
  },
}

export const guideCommands = [read]
