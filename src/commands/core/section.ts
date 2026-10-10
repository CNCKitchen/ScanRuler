// SPDX-License-Identifier: AGPL-3.0-only
// Sections: the scan cut with a plane, for measuring in 2D.

import { canCutAlong, type SectionRef, type WorldAxis } from '../../core/section/frame'
import { projectCut } from '../../core/section/slice'
import { useFlat } from '../../state/flatStore'
import { sectionDraftReady, useStore, type Section } from '../../state/store'
import { commandHost } from '../host'
import { elementRefSchema, findElement, requireScan, type ElementRef } from '../refs'
import { arr, enumOf, int, num, obj, oneOf, str } from '../schema'
import { describeSection } from '../state'
import { CommandError, type Command } from '../types'
import { requireMeasureFree, showWorkspace, waitFor } from './common'

/** A coordinate plane by name, as the axis it is square to. */
function worldAxisOf(name: string): WorldAxis | null {
  const key = name.trim().toUpperCase().replace(/\s*PLANE$/, '')
  return key === 'XY' ? 'z' : key === 'YZ' ? 'x' : key === 'ZX' || key === 'XZ' ? 'y' : null
}

const cut: Command<{ across: ElementRef; offset?: number; name?: string }> = {
  name: 'cut',
  title: 'Cut a section',
  description:
    'Cut the scan with a plane and keep the cut as a section, measured in the 2D workspace (flat) — where it is put on the sheet. across is what the plane is taken across: an element with a direction (a plane, cylinder, cone, line or circle) by id or name, or a coordinate plane "XY", "YZ" or "ZX", which is laid through the part’s centre. offset slides the plane along its normal, mm — from the element, or for a coordinate plane the coordinate itself. Returns the section: its plane and how many chains the cut has. One undo step.',
  input: obj(
    {
      across: elementRefSchema('An element with a direction, or a coordinate plane "XY", "YZ", "ZX".'),
      offset: num('Where along the normal the plane lies, mm.'),
      name: str('A name for it; otherwise it is numbered — "Section 2".', { minLength: 1 }),
    },
    ['across'],
  ),
  label: () => 'cut section',
  run: async ({ across, offset, name }) => {
    requireScan()
    requireMeasureFree()
    let ref: SectionRef
    const world = typeof across === 'string' ? worldAxisOf(across) : null
    if (world) ref = world
    else {
      const el = findElement(across)
      if (!el.fit || !canCutAlong(el.kind)) {
        throw new CommandError('invalid_input', `${el.name} has no direction to cut across — choose a plane, cylinder, cone, line or circle.`)
      }
      ref = el.id
    }
    showWorkspace('elements')
    const sections = commandHost().session.sections
    try {
      useStore.getState().startSection()
      useStore.getState().setSectionDraftRef(ref)
      if (!useStore.getState().sectionDraft?.axis) throw new CommandError('invalid_input', 'That cannot be cut across.')
      if (offset !== undefined) useStore.getState().setSectionDraftOffset(offset)
      await sections.pumpDraft()
      const d = useStore.getState().sectionDraft
      if (!sectionDraftReady(d)) {
        throw new CommandError('failed', d?.message ?? 'The plane misses the scan — there is nothing to cut there.')
      }
      const id = useStore.getState().commitSection()
      if (id === null) throw new CommandError('failed', 'The section could not be made.')
      // What Create does: the new section goes on the 2D sheet.
      useFlat.getState().setSubject({ kind: 'section', id })
      if (name) {
        // Renamed as its row's edit box does it: re-opened on its own plane,
        // which may want its cut taken again before it saves.
        useStore.getState().editSection(id)
        useStore.getState().setSectionDraftName(name)
        await sections.pumpDraft()
        if (useStore.getState().commitSection() === null) throw new CommandError('failed', 'The section could not be renamed.')
      }
      return { section: describeSection(useStore.getState().sections.find((x) => x.id === id)!) }
    } finally {
      if (useStore.getState().sectionDraft) useStore.getState().cancelSection()
    }
  },
}

/** The section an id or a name stands for — whole names, case aside; a
 *  name two sections share is refused rather than guessed. */
export function findSection(ref: number | string): Section {
  const { sections } = useStore.getState()
  if (typeof ref === 'number') {
    const sec = sections.find((x) => x.id === ref)
    if (!sec) throw new CommandError('not_found', `There is no section ${ref} — there are ${sections.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}.`)
    return sec
  }
  const want = ref.trim().toLowerCase()
  const hits = sections.filter((x) => x.name.trim().toLowerCase() === want)
  if (hits.length === 0) throw new CommandError('not_found', `There is no section named "${ref}" — there are ${sections.map((x) => `"${x.name}"`).join(', ') || 'none'}.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} sections are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** How many points a section's answer holds unless told otherwise, and at
 *  most — past it every k-th point of each chain is kept. */
const GET_LIMIT = 4000
const GET_MAX = 50_000

const round4 = (v: number) => Math.round(v * 10_000) / 10_000

const get: Command<{ section: number | string; chains?: number[]; space?: 'sheet' | 'world' | 'both'; limit?: number }> = {
  name: 'get',
  title: 'Read a section’s polylines',
  description:
    'A section’s cut as the polylines it is: each chain’s points in order, as the 2D sheet lays them flat — [u, v] millimetres in the section’s plane, what flat.fit and a sketch on the section take — and, with space "world" or "both", as [x, y, z] in the frame the part is measured in now. With them the plane (origin, normal, basisU, basisV: a sheet point is origin + u·basisU + v·basisV), and for each chain whether it is closed (a loop; its first point is repeated at the end), its length along the path, how many points it has and the box round it on the sheet. At most limit points come back over all the chains (4000 by default, 50000 at most): past it every k-th point of a chain is kept, its ends always, and step says which k. chains picks chains by their index. Changes nothing.',
  input: obj(
    {
      section: oneOf([int('The section’s id.', { minimum: 1 }), str('The section’s name, as the list shows it — "Section 1".', { minLength: 1 })], 'The section, by id or name.'),
      chains: arr(int('A chain’s index.', { minimum: 0 }), 'Which chains; every one when left out.', { minItems: 1 }),
      space: enumOf(['sheet', 'world', 'both'], 'sheet (the default): [u, v] on the section’s plane; world: [x, y, z]; both.'),
      limit: int(`How many points at most, over every chain asked for; ${GET_LIMIT} by default, ${GET_MAX} at most.`, { minimum: 2, maximum: GET_MAX }),
    },
    ['section'],
  ),
  readOnly: true,
  run: async ({ section, chains: which, space = 'sheet', limit = GET_LIMIT }) => {
    requireScan()
    const id = findSection(section).id
    // A section loaded from a project, or whose plane was just moved, is cut
    // again by the worker a moment later: wait for the cut.
    const sec = await waitFor(() => {
      const s = useStore.getState().sections.find((x) => x.id === id)
      return s?.cut || s?.message ? s : null
    }, 'the section to be cut', 60_000)
    if (!sec.cut) throw new CommandError('failed', sec.message ?? 'The section has no cut.')
    const cut = sec.cut
    const flat = projectCut(cut, sec.frame)
    const count = cut.offsets.length - 1
    const picked = which ?? Array.from({ length: count }, (_, i) => i)
    for (const c of picked) if (c >= count) throw new CommandError('not_found', `${sec.name} has no chain ${c} — it has ${count}${count > 0 ? ` (0 to ${count - 1})` : ''}.`)
    const total = picked.reduce((n, c) => n + (cut.offsets[c + 1] - cut.offsets[c]), 0)
    const step = total > limit ? Math.ceil(total / limit) : 1
    const chains = picked.map((c) => {
      const from = cut.offsets[c]
      const to = cut.offsets[c + 1]
      const n = to - from
      let length = 0
      let lo: [number, number] = [Infinity, Infinity]
      let hi: [number, number] = [-Infinity, -Infinity]
      for (let i = from; i < to; i++) {
        const u = flat.points[i * 2]
        const v = flat.points[i * 2 + 1]
        lo = [Math.min(lo[0], u), Math.min(lo[1], v)]
        hi = [Math.max(hi[0], u), Math.max(hi[1], v)]
        if (i > from) length += Math.hypot(cut.points[i * 3] - cut.points[i * 3 - 3], cut.points[i * 3 + 1] - cut.points[i * 3 - 2], cut.points[i * 3 + 2] - cut.points[i * 3 - 1])
      }
      const closed = n > 2 && cut.points[from * 3] === cut.points[(to - 1) * 3] && cut.points[from * 3 + 1] === cut.points[(to - 1) * 3 + 1] && cut.points[from * 3 + 2] === cut.points[(to - 1) * 3 + 2]
      const kept: number[] = []
      for (let i = from; i < to; i += step) kept.push(i)
      if (kept[kept.length - 1] !== to - 1) kept.push(to - 1)
      return {
        index: c,
        closed,
        points: n,
        kept: kept.length,
        length: round4(length),
        bounds: { min: [round4(lo[0]), round4(lo[1])], max: [round4(hi[0]), round4(hi[1])] },
        ...(space !== 'world' ? { sheet: kept.map((i) => [round4(flat.points[i * 2]), round4(flat.points[i * 2 + 1])]) } : {}),
        ...(space !== 'sheet' ? { world: kept.map((i) => [round4(cut.points[i * 3]), round4(cut.points[i * 3 + 1]), round4(cut.points[i * 3 + 2])]) } : {}),
      }
    })
    return {
      section: describeSection(sec),
      plane: { origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV },
      step,
      chains,
    }
  },
}

export const sectionCommands = [cut, get]
