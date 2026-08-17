// SPDX-License-Identifier: AGPL-3.0-only
// Drag & drop anywhere. Owns the "drop it here" flag so the overlay can be
// shown without the rest of the app caring about drag state.
import { useEffect, useState } from 'react'
import { isStepFile } from '../core/formats'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'

export function useDragDrop({
  openFile,
  openNominal,
}: {
  openFile: (file: File) => Promise<void>
  openNominal: (file: File) => Promise<void>
}): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      // While the deviation workspace is measuring against a reference part a
      // drop fills whichever slot is still empty, so the two files can simply be
      // dropped one after the other; only once both are there does a drop mean
      // "replace the scan". A STEP file is the exception: it can only ever be
      // the reference, so it goes there however full the slots are.
      //
      // Measuring against an element wants no second model at all, so there a
      // drop is always the scan.
      const dev = useDeviation.getState()
      if (dev.workspace === 'deviation' && dev.source === 'reference') {
        if (isStepFile(file.name) || (useStore.getState().fileName && !dev.nominalName)) {
          void openNominal(file)
          return
        }
      }
      void openFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return dragging
}
