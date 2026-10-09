// SPDX-License-Identifier: AGPL-3.0-only
// Sections: the scan cut with a plane, for measuring in 2D.

import { canCutAlong, type SectionRef, type WorldAxis } from '../../core/section/frame'
import { useFlat } from '../../state/flatStore'
import { sectionDraftReady, useStore } from '../../state/store'
import { commandHost } from '../host'
import { elementRefSchema, findElement, requireScan, type ElementRef } from '../refs'
import { num, obj, str } from '../schema'
import { describeSection } from '../state'
import { CommandError, type Command } from '../types'
import { requireMeasureFree, showWorkspace } from './common'

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

export const sectionCommands = [cut]
