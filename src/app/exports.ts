// SPDX-License-Identifier: AGPL-3.0-only
// The two ways measurements leave the tool as geometry: the created elements
// as analytic STEP, and the scan itself as an STL in the pose it is shown in.
import type { RefObject } from 'react'
import { applyAssumed } from '../core/elements/assumed'
import { applyExtension } from '../core/elements/extend'
import { buildStepFile } from '../core/exportStep'
import { buildBinaryStl } from '../core/exportStl'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import type { SceneManager } from '../viewer/SceneManager'

/** Hand a built file to the browser. The link goes into the document for the
 *  length of the click — WebKit ignores `download` on an anchor that was never
 *  in the page — and the object URL outlives it by long enough for the
 *  download to start, then goes. */
export const saveFile = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The scan's name without its extension — the stem every export is built
 *  on. */
export const exportStem = () => (useStore.getState().fileName ?? 'scan').replace(/\.[^.]+$/, '')

/** Hand the created elements over as analytic STEP geometry. */
export const exportElementsStep = () => {
  const store = useStore.getState()
  const els = store.elements.filter((e) => e.fit)
  if (els.length === 0) return
  const assumed = els.filter((e) => e.assumed !== undefined).length
  const text = buildStepFile(
    // What is exported is what is on screen, extensions and all — with the
    // assumed diameter swapped in wherever the user gave one.
    els.map((e) => ({
      name: e.name,
      fit: applyExtension(applyAssumed(e.fit!, e.assumed), e.extend),
    })),
    store.fileName ?? 'scan',
    new Date().toISOString().slice(0, 19),
    store.stepStyle,
  )
  const name = `${exportStem()}-elements.step`
  saveFile(name, new Blob([text], { type: 'model/step' }))
  store.setStatus(
    `${els.length} element${els.length === 1 ? '' : 's'} exported to ${name} as ${
      store.stepStyle === 'solids' ? 'solids and faces' : 'construction surfaces'
    }${assumed ? ` — ${assumed} at ${assumed === 1 ? 'its' : 'their'} assumed Ø` : ''}.`,
  )
}

/** Hand the scan back as an STL in the pose it is being shown in.
 *
 *  A 3-2-1 or typed-in alignment is already baked into the vertices, so it
 *  comes along for free. The deviation workspace's best fit is not: it rides
 *  on the scan's group matrix so the fit can be watched and undone, and it
 *  has to be applied on the way out. Either way what lands on disk is the
 *  part where the user can see it. */
export const exportScanStl = (sceneRef: RefObject<SceneManager | null>) => {
  const store = useStore.getState()
  const geometry = sceneRef.current?.scanGeometry()
  if (!geometry || !store.fileName) return
  const positions = geometry.getAttribute('position')?.array as Float32Array | undefined
  if (!positions) return
  const index = geometry.getIndex()?.array as Uint32Array | Uint16Array | undefined
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  // Never the name it came in under, however little has happened to it: the
  // export lands in the same folder the scan was picked from, and silently
  // shadowing the original there is not a thing a measuring tool should do.
  const name = `${stem}-${moved ? 'aligned' : 'export'}.stl`
  const buffer = buildBinaryStl(
    positions,
    index ?? null,
    align?.transform ?? null,
    `ScanRuler scan export - ${stem}`,
  )
  saveFile(name, new Blob([buffer], { type: 'model/stl' }))
  const triangles = (index ? index.length : positions.length / 3) / 3
  store.setStatus(
    `Scan exported to ${name} — ${triangles.toLocaleString('en-US')} triangles${
      moved ? ', in its aligned position' : ''
    }.`,
  )
}
