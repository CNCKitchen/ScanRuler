// SPDX-License-Identifier: AGPL-3.0-only
// Where a file goes when it arrives without a slot being named — dropped
// anywhere, or fetched from a link: a project, a flatbed image, the reference
// while the deviation workspace is comparing against one, else the scan.

import { isImageFile, isModelFile, isStepFile } from '../core/formats'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { holdsProject, isProjectFile } from './useProject'

export interface OpenHandlers {
  openFile: (file: File) => Promise<void>
  openNominal: (file: File) => Promise<void>
  openImage: (file: File) => Promise<void>
  openProject: (file: File) => Promise<void>
}

/** Open `file` in the slot its kind and the session's state say it is for. */
export async function openAnyFile(file: File, { openFile, openNominal, openImage, openProject }: OpenHandlers): Promise<void> {
  // A project says for itself what it holds and where it goes.
  if (isProjectFile(file.name)) return openProject(file)
  // An image can only ever be a flatbed scan, so it opens the 2D Measure
  // workspace with itself — dropped from anywhere.
  if (isImageFile(file.name)) return openImage(file)
  // A name no format knows may still be a project's, saved under a name
  // the browser made up.
  if (!isModelFile(file.name) && (await holdsProject(file))) return openProject(file)
  // While the deviation workspace is measuring against a reference part a
  // file fills whichever slot is still empty, so the two files can simply be
  // dropped one after the other; only once both are there does a drop mean
  // "replace the scan". A STEP file is the exception: compared against, it
  // is the nominal part, so it goes there however full the slots are.
  //
  // Measuring against an element wants no second model at all, so there a
  // drop is always the scan.
  const dev = useDeviation.getState()
  if (useShell.getState().workspace === 'deviation' && dev.source === 'reference') {
    if (isStepFile(file.name) || (useStore.getState().fileName && !dev.nominalName)) {
      return openNominal(file)
    }
  }
  return openFile(file)
}
