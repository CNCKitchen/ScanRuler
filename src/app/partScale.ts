// SPDX-License-Identifier: AGPL-3.0-only
// Scaling the scan to its true size — the Scale part box of the Alignment
// group and scan.scale both work through this. See core/scanScale for what a
// scale is.
//
// The scan is read again from its file at the new factor, as another version
// of it (scanSwap): the factor goes in before the mesh is welded, as a file's
// units do, so everything built on the mesh sees the true size from the
// start, a project and a restarted worker read it the same way, and a step of
// the undo history crosses it as it crosses an edit. The weld matches
// vertices on their exact values, so the scan read at another size has the
// same vertices in the same order: seeds and marked surfaces stay valid.
//
// What does not scale with it is refused rather than left behind: work of a
// plugin's built on the scan at its old size (a model, notes), items measured
// on a section's 2D sheet, anything open in an editor.

import type { RefObject } from 'react'
import { factorProblem, scaleRigid, type ScaleReference } from '../core/scanScale'
import { useDeviation } from '../state/deviationStore'
import { useFlat } from '../state/flatStore'
import { sheetKeyOf } from '../state/flatModel'
import { historyAsync } from '../state/historyStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import type { SceneManager } from '../viewer/SceneManager'
import type { ImportQueue } from './importQueue'
import { runImport } from './imports'
import { holdsWords, type SourceFiles } from './project'
import { projectSections } from './projectSections'
import type { ScanSource } from './scanSwap'
import type { ElementKind } from '../core/types'
import type { Rigid } from '../core/deviation/rigid'

export interface PartScaleDeps {
  sceneRef: RefObject<SceneManager | null>
  sources: RefObject<SourceFiles>
  imports: ImportQueue
  swapScan: (source: ScanSource, transform: Rigid | null) => Promise<void>
  remeasureScan: (refit: boolean) => Promise<void>
  runFit: (id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array, regionsOnly?: boolean) => Promise<void>
}

const listed = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '')

/** How many items the 2D sheets of sections hold — measured on a cut at the
 *  old size, they would not fit the cut taken again. */
function sectionSheetItems(): number {
  const f = useFlat.getState()
  let n = 0
  const count = (sheet: { elements: unknown[]; dimensions: unknown[]; counts: unknown[]; notes: unknown[] }) =>
    sheet.elements.length + sheet.dimensions.length + sheet.counts.length + sheet.notes.length
  for (const [key, sheet] of Object.entries(f.sheets)) if (key.startsWith('section:') && key !== sheetKeyOf(f.subject)) n += count(sheet)
  if (f.subject.kind === 'section') n += count(f)
  return n
}

/** Why the scan cannot be scaled now, in a sentence, or null when it can. */
export function scaleRefusal(sources: SourceFiles): string | null {
  const s = useStore.getState()
  if (!s.fileName || !sources.scan) return 'Open a scan first.'
  if (s.busy) return 'Wait for the work in progress to finish.'
  if (s.draft || s.dimDraft || s.alignDraft || s.sectionDraft) return 'Finish or cancel what is open in the panel first.'
  const open = projectSections().filter((p) => p.hasDraft?.()).map((p) => p.key)
  if (open.length > 0) return 'Finish or cancel what is open in the other workspaces first.'
  const behind: string[] = []
  for (const p of projectSections()) {
    if (p.scaleHolds) behind.push(...p.scaleHolds())
    else {
      const held = p.holds?.()
      if (held) behind.push(...holdsWords(Object.fromEntries(Object.entries(held).filter(([, n]) => n > 0))))
      else if (p.holdsWork?.()) behind.push(p.key)
    }
  }
  const items = sectionSheetItems()
  if (items > 0) behind.push(`${items} item${items === 1 ? '' : 's'} on the 2D sheets of sections`)
  if (behind.length === 0) return null
  return `The session holds ${listed(behind)}, made on the scan at the size it has now; they would not scale with it. Scale the scan first, before building on it — or remove them.`
}

export function partScale({ sceneRef, sources, imports, swapScan, remeasureScan, runFit }: PartScaleDeps) {
  /**
   * Scale the scan by `factor` about the zero point of the frame it stands
   * in, with everything measured on it; `references` are what the factor was
   * read from, kept as the record. One step of the undo history. True when it
   * went through; otherwise the store's error says why.
   */
  const applyScale = async (factor: number, references: ScaleReference[] = []): Promise<boolean> => {
    const problem = factorProblem(factor) ?? scaleRefusal(sources.current)
    if (problem) {
      useStore.getState().setError(problem)
      return false
    }
    let done = false
    await runImport(imports, 'Scaling the scan…', () => historyAsync(`Scale part ×${+factor.toPrecision(6)}`, async () => {
      const source = sources.current.scan!
      const before = useStore.getState()
      const pose = before.appliedAlignment ? scaleRigid(before.appliedAlignment, factor) : null
      const read = (source.scale ?? 1) * factor
      // Read at the new size, in the pose that size puts it in.
      await swapScan({ ...source, scale: read }, pose)
      useStore.getState().applyScale(factor, { factor: (before.scanScale?.factor ?? 1) * factor, references })
      // A wall is `factor` times as thick, and its pins sit `factor` times as
      // far out; the map itself is measured again below.
      useThickness.setState((t) => ({
        probes: t.probes.map((p) => ({ ...p, point: [p.point[0] * factor, p.point[1] * factor, p.point[2] * factor], value: p.value * factor })),
      }))
      // The fit to the reference part was made at the old size and no longer
      // holds: the scan is a different size against the same reference.
      useDeviation.getState().clearAlign()
      await remeasureScan(false)
      // A sphere held at a known diameter is fitted again: scaled, its
      // radius is no longer the one it holds.
      await Promise.all(useStore.getState().elements.map((el) =>
        el.source.type === 'fitted' && el.source.settings.knownDiameter !== undefined
          ? runFit(el.id, el.kind, el.source.seeds, el.source.selection)
          : Promise.resolve()))
      sceneRef.current?.frameAll()
      done = true
    }))
    if (done) useStore.getState().setStatus(`Scan scaled ×${+factor.toPrecision(6)} — elements, dimensions and sections scaled with it. Undo puts it back.`)
    return done
  }

  return { applyScale, refusal: () => scaleRefusal(sources.current) }
}
